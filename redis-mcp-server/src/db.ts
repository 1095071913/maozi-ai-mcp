import {Redis, type RedisOptions} from 'ioredis';
import type {Config} from './config.js';
import type {CommandArg} from './reply.js';

type RedisClient = InstanceType<typeof Redis>;

/** A command that did not complete, together with what is known about why. */
export class Failure extends Error {
  constructor(
    message: string,
    /** The error the client raised. */
    readonly cause: unknown,
    /** The latest connection-level error of that client: ioredis reports these only as events. */
    readonly connectionError: unknown,
    readonly command: string,
    readonly args: readonly CommandArg[],
    /** True when the connection had been established, i.e. it dropped underneath the command. */
    readonly wasConnected: boolean,
  ) {
    super(message);
    this.name = 'Failure';
  }

  /** True when the connection was lost before the reply arrived, so the command may or may not have run. */
  get dropped(): boolean {
    return this.wasConnected && !isReplyError(this) && !timedOut(this);
  }
}

/** Redis itself answered with an error reply (WRONGTYPE, ERR unknown command, …). */
export function isReplyError(failure: Failure): boolean {
  const name = (failure.cause as object | null)?.constructor?.name;
  return name === 'SimpleError' || name === 'ReplyError';
}

/** The client stopped waiting: whatever the server is still doing for that connection is aborted. */
export function timedOut(failure: Failure): boolean {
  return (failure.cause as { message?: string } | null)?.message === 'Command timed out';
}

interface Managed {
  client: RedisClient;
  wasConnected: boolean;
  /** ioredis reports connection failures only as events, so the latest one is kept for the next failure. */
  lastError: unknown;
}

/** Owns the connections. One is shared per database; blocking commands get one of their own. */
export class Gateway {
  private readonly shared = new Map<number, Managed>();

  constructor(private readonly config: Config) {}

  /** Runs a command on the connection that calls to the same database share. */
  async run(command: string, args: CommandArg[], db: number): Promise<unknown> {
    const managed = this.connection(db);
    try {
      return await managed.client.callBuffer(command, ...args);
    } catch (error) {
      throw this.failed(managed, error, command, args);
    }
  }

  /**
   * Runs a command on a connection of its own and drops that connection afterwards. Blocking
   * commands need this: cut off by the timeout, they would otherwise keep a shared connection
   * busy on the server side, and with it every call that shares it.
   */
  async runAlone(command: string, args: CommandArg[], db: number): Promise<unknown> {
    const managed = this.open(db);
    try {
      return await managed.client.callBuffer(command, ...args);
    } catch (error) {
      throw this.failed(managed, error, command, args);
    } finally {
      managed.client.disconnect();
    }
  }

  /**
   * SHUTDOWN gets no reply: the server just closes the connection, so that closing is the
   * success signal. Anything the server answers instead (Redis 7 refuses when it cannot save)
   * is an error like any other.
   */
  async shutdown(args: CommandArg[], db: number): Promise<void> {
    const managed = this.open(db);
    const { client } = managed;
    const closed = new Promise<undefined>((resolve) => client.once('close', resolve));
    try {
      // Connect first: the "close" of a connection that never existed must not pass for a shutdown.
      await client.connect();
      await Promise.race([
        closed,
        client.callBuffer('SHUTDOWN', ...args).then(
          () => undefined,
          (error: unknown) => {
            throw this.failed(managed, error, 'SHUTDOWN', args);
          },
        ),
      ]);
    } catch (error) {
      throw error instanceof Failure ? error : this.failed(managed, error, 'SHUTDOWN', args);
    } finally {
      client.disconnect();
    }
  }

  close(): void {
    for (const managed of this.shared.values()) managed.client.disconnect();
    this.shared.clear();
  }

  private options(db: number): RedisOptions {
    return {
      host: this.config.host,
      port: this.config.port,
      username: this.config.username,
      password: this.config.password,
      db,
      lazyConnect: true,
      commandTimeout: this.config.timeoutMs > 0 ? this.config.timeoutMs : undefined,
      // Integers arrive as text, so values beyond 2^53 stay exact; the tool layer turns safe ones back into numbers.
      stringNumbers: true,
      // Fail within a second while Redis is unreachable instead of retrying twenty times…
      maxRetriesPerRequest: 1,
      // …and never repeat a command whose reply was lost: for a write, that could apply it twice.
      autoResendUnfulfilledCommands: false,
      connectionName: `redis-mcp-server:${process.pid}`,
    };
  }

  private open(db: number): Managed {
    const managed: Managed = { client: new Redis(this.options(db)), wasConnected: false, lastError: undefined };
    // Besides remembering why a connection failed, having an "error" listener is what keeps ioredis from throwing on it.
    managed.client.on('error', (error: Error) => {
      managed.lastError = error;
    });
    managed.client.on('ready', () => {
      managed.wasConnected = true;
    });
    return managed;
  }

  private connection(db: number): Managed {
    let managed = this.shared.get(db);
    if (!managed) {
      managed = this.open(db);
      this.shared.set(db, managed);
    }
    return managed;
  }

  private failed(managed: Managed, error: unknown, command: string, args: CommandArg[]): Failure {
    const failure = new Failure(messageOf(error), error, managed.lastError, command, args, managed.wasConnected);
    if (!isReplyError(failure)) {
      // Closing the connection aborts whatever the server is still doing for it, and a
      // connection that already failed is replaced rather than reused.
      managed.client.disconnect();
      for (const [db, entry] of this.shared) {
        if (entry === managed) this.shared.delete(db);
      }
    }
    return failure;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
