import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import type {CallToolResult} from '@modelcontextprotocol/sdk/types.js';
import {z} from 'zod';
import {classify} from './classify.js';
import type {Config} from './config.js';
import {Failure, type Gateway, isReplyError, timedOut} from './db.js';
import {type CommandArg, decodeArgs, encodeReply, pairsToObject} from './reply.js';

export const INSTRUCTIONS = `Access to a Redis server through three tools.
1. read_command runs one command that cannot change anything: GET, HGETALL, LRANGE, SMEMBERS, ZRANGE, SCAN, TTL, TYPE, INFO, CONFIG GET and so on. Which commands qualify is decided by this server from Redis's own command table.
2. write_command runs any other single command: SET, DEL, INCR, LPUSH, HSET, EXPIRE, EVAL, and server-wide commands.
3. scan_keys pages through the keys of a database with each key's type, TTL and size. Prefer it over KEYS.
4. \`command\` holds the command name. A subcommand may go in \`command\` ("CONFIG GET") or first in \`args\`. Pass values through \`args\` instead of assembling a string.
5. Binary values come back as { base64, bytes, preview }; pass { "base64": "…" } in \`args\` to write raw bytes.
6. Commands that affect the whole server or other clients are refused until \`confirm\` is true. Set it only after the user has agreed to that exact command.`;

/** Largest `limit` a caller may ask for. */
export const MAX_ELEMENTS = 2000;
const DEFAULT_LIMIT = 200;
/** Largest result, as JSON, that is handed back; anything bigger is refused with a hint. */
const MAX_RESULT_CHARS = 100_000;
/** SCAN may come back empty-handed on a crowded database; this bounds the paging. */
const MAX_SCAN_ROUNDS = 1000;

/** Replies that are flat field/value pairs, or rows of them, read better as objects. */
const PAIR_OBJECTS = new Set(['acl getuser', 'config get', 'hgetall', 'memory stats', 'xinfo stream']);
const PAIR_ROWS = new Set(['acl log', 'xinfo consumers', 'xinfo groups']);

export interface ToolContext {
  config: Config;
  gateway: Gateway;
}

type Body = () => Promise<CallToolResult>;

function text(payload: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

function failure(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

/** Splits "CONFIG GET maxmemory" into the command and the arguments that follow it. */
function parseCommand(command: string, args: unknown[] | undefined): { name: string; args: CommandArg[] } {
  const [name = '', ...inline] = command.trim().split(/\s+/);
  if (!/^[A-Za-z][A-Za-z0-9_.-]*$/.test(name)) throw new Error(`"${command}" is not a command name`);
  return { name, args: decodeArgs([...inline, ...(args ?? [])]) };
}

function showCommand(name: string, args: readonly CommandArg[]): string {
  const shown = [name.toUpperCase(), ...args.map((arg) => (typeof arg === 'string' ? arg : `<${arg.length} bytes>`))].join(' ');
  return shown.length > 200 ? `${shown.slice(0, 200)}…` : shown;
}

/** Turns a failure into a message the model can act on. */
export function describeError(error: unknown, config: Config, writing = false): string {
  if (!(error instanceof Failure)) return error instanceof Error ? error.message : String(error);
  const message = (value: unknown): string => (value instanceof Error ? value.message : String(value));
  const shown = showCommand(error.command, error.args);
  const target = `${config.host}:${config.port}`;
  // A command that never got its reply only rejects with a generic error; the reason was an event on the client.
  const connection = error.connectionError as { code?: string; message?: string } | undefined;
  const text = String(connection?.message ?? message(error.cause));

  // Redis refuses the login with an error reply of its own, both while connecting and on the command.
  if (/^WRONGPASS/.test(message(error.cause))) return `Redis rejected the credentials: ${message(error.cause)} Check REDIS_USER and REDIS_PASSWORD.`;
  if (/^NOAUTH/.test(message(error.cause))) {
    return `Redis requires a password and none was accepted: ${message(error.cause)} Set REDIS_PASSWORD (and REDIS_USER for a non-default user).`;
  }
  if (/^NOPERM/.test(message(error.cause))) {
    return `Redis refused the permission: ${message(error.cause)} The user needs broader ACL rules (see REDIS_USER).`;
  }
  if (isReplyError(error)) return `Redis error: ${message(error.cause)}  (command: ${shown})`;
  if (timedOut(error)) {
    return (
      `Redis did not answer ${shown} within ${config.timeoutMs} ms, so the connection was closed to abort it.` +
      (writing ? ' The command may still have taken effect: check before repeating it.' : '')
    );
  }
  if (connection?.code === 'ECONNREFUSED') return `Cannot connect to Redis at ${target}: connection refused. Is the Redis server running?`;
  if (connection?.code === 'ENOTFOUND' || connection?.code === 'EAI_AGAIN') {
    return `Cannot resolve the Redis host "${config.host}". Check REDIS_HOST.`;
  }
  if (connection?.code === 'ETIMEDOUT' || /ETIMEDOUT/.test(text)) return `Connecting to Redis at ${target} timed out.`;
  return (
    `The connection to Redis was lost while running ${shown}: ${text}` +
    (writing ? ' The command may or may not have been applied: check with a read before repeating it.' : '')
  );
}

export function registerTools(server: McpServer, { config, gateway }: ToolContext): void {
  // A tool callback must not throw into the SDK: every failure becomes a message the model can act on.
  const guard = async (body: Body, writing = false): Promise<CallToolResult> => {
    try {
      return await body();
    } catch (error) {
      return failure(describeError(error, config, writing));
    }
  };

  /** Repeats a read once when an established connection dropped underneath it, the one failure a read can safely retry. */
  async function reading<T>(read: () => Promise<T>): Promise<T> {
    try {
      return await read();
    } catch (error) {
      if (!(error instanceof Failure) || !error.dropped) throw error;
    }
    return read();
  }

  function present(command: string, args: readonly CommandArg[], reply: unknown, limit: number, db: number, started: number): CallToolResult {
    // Which shape a reply has depends on the command, and for some also on its subcommand.
    // A command without subcommands (HGETALL) must not be looked up with its first key instead.
    const name = command.toLowerCase();
    const sub = typeof args[0] === 'string' ? args[0].toLowerCase() : '';
    const withSub = sub ? `${name} ${sub}` : name;
    let result: unknown;
    let truncated: { returned: number; total: number } | undefined;

    if (Array.isArray(reply) && (PAIR_OBJECTS.has(name) || PAIR_OBJECTS.has(withSub))) {
      const object = pairsToObject(reply.map(encodeReply));
      if (Array.isArray(object)) {
        result = object;
      } else {
        const entries = Object.entries(object);
        if (entries.length > limit) truncated = { returned: limit, total: entries.length };
        result = Object.fromEntries(entries.slice(0, limit));
      }
    } else if (Array.isArray(reply) && PAIR_ROWS.has(withSub)) {
      const rows = reply.map((row) => (Array.isArray(row) ? pairsToObject(row.map(encodeReply)) : row));
      if (rows.length > limit) truncated = { returned: limit, total: rows.length };
      result = rows.slice(0, limit);
    } else if (Array.isArray(reply)) {
      if (reply.length > limit) truncated = { returned: limit, total: reply.length };
      result = reply.slice(0, limit).map(encodeReply);
    } else {
      result = encodeReply(reply);
    }

    const size = JSON.stringify(result)?.length ?? 0;
    if (size > MAX_RESULT_CHARS) {
      return failure(
        `The reply of ${command.toUpperCase()} is too large to return (${Math.round(size / 1024)} KB). Ask for less: a range, a pattern, or a smaller limit (currently ${limit}).`,
      );
    }
    return text({ db, result, elapsed_ms: Date.now() - started, ...(truncated ? { truncated } : {}) });
  }

  const databaseParam = z.number().int().min(0).describe('Logical database index. Defaults to REDIS_DB from the server configuration.');
  const limitParam = z.number().int().min(1).max(MAX_ELEMENTS).default(DEFAULT_LIMIT).describe('Maximum number of elements returned from an array reply.');
  const commandParam = z.string().min(1).describe('The command, e.g. "GET" or "CONFIG GET" (a subcommand may also be given as the first element of args).');
  const argsParam = z.array(z.unknown()).optional().describe('Arguments in order. Strings and numbers pass as given; { "base64": "…" } passes raw bytes.');

  server.registerTool(
    'read_command',
    {
      title: 'Run a read-only Redis command',
      description:
        'Run one Redis command that cannot change data or server state: GET, HGETALL, LRANGE, SMEMBERS, ZRANGE, SCAN, TTL, TYPE, DBSIZE, INFO, CONFIG GET and the like. ' +
        'Which commands qualify is decided by this server from Redis’s own command table, so a write is refused here. ' +
        'The reply is returned as JSON: text as strings, binary values as { base64, bytes, preview }, numbers as numbers (integers beyond 2^53 keep their exact text), field/value pairs (HGETALL, CONFIG GET) as objects. ' +
        'At most `limit` elements of an array reply come back, and `truncated` says when there were more.',
      inputSchema: { command: commandParam, args: argsParam, db: databaseParam.optional(), limit: limitParam },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    ({ command, args, db, limit }) =>
      guard(async () => {
        const { name, args: values } = parseCommand(command, args);
        const classification = classify(name, values);
        if (classification.kind === 'unsupported') return failure(`"${name.toUpperCase()}" is not supported here: ${classification.reason}.`);
        if (classification.kind !== 'read') {
          return failure(`"${name.toUpperCase()}" may change data or server state, so read_command does not run it. Use write_command.`);
        }
        const target = db ?? config.db;
        const started = Date.now();
        // A blocking command (XREAD BLOCK …) waits on a connection of its own, for at most the server's wait limit.
        const read = (): Promise<unknown> =>
          classification.blocking ? gateway.runAlone(name, values, target) : reading(() => gateway.run(name, values, target));
        const reply = await read();
        return present(name, values, reply, limit, target, started);
      }),
  );

  if (!config.readonly) {
    server.registerTool(
      'write_command',
      {
        title: 'Run a Redis command that changes data or state',
        description:
          'Run one Redis command: SET, DEL, INCR, LPUSH, HSET, EXPIRE, EVAL, MIGRATE, CONFIG SET and any other. ' +
          'Each call is a single command that takes effect immediately; there are no transactions (use EVAL or EVALSHA when several changes must apply together). ' +
          'Commands that affect the whole server or other clients — FLUSHALL, FLUSHDB, SHUTDOWN, DEBUG, CONFIG SET, REPLICAOF, ACL SETUSER, CLIENT KILL, … — are refused unless `confirm` is true. ' +
          'Blocking commands (BLPOP, …) wait on a connection of their own, for at most the server’s wait limit. The reply is returned as JSON, like read_command.',
        inputSchema: {
          command: commandParam,
          args: argsParam,
          db: databaseParam.optional(),
          limit: limitParam,
          confirm: z.boolean().default(false).describe('Required for commands that affect the whole server or other clients. Set only after the user approved this exact command.'),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      },
      ({ command, args, db, limit, confirm }) =>
        guard(async () => {
          const { name, args: values } = parseCommand(command, args);
          const classification = classify(name, values);
          if (classification.kind === 'unsupported') return failure(`"${name.toUpperCase()}" is not supported here: ${classification.reason}.`);
          if (classification.danger && !confirm) {
            return failure(
              `Refused: "${showCommand(name, values)}" ${classification.danger}. Show the command to the user and call again with confirm: true once they approve it.`,
            );
          }
          const target = db ?? config.db;
          const started = Date.now();
          if (name.toUpperCase() === 'SHUTDOWN') {
            await gateway.shutdown(values, target);
            return text({ db: target, result: 'Redis is shutting down: it closed the connection without a reply.', elapsed_ms: Date.now() - started });
          }
          const reply = classification.blocking
            ? await gateway.runAlone(name, values, target)
            : await gateway.run(name, values, target);
          return present(name, values, reply, limit, target, started);
        }, true),
    );
  }

  server.registerTool(
    'scan_keys',
    {
      title: 'Scan the keys of a database',
      description:
        'Page through the keys of a database with SCAN, which does not block the server the way KEYS does. Each key comes with its type, TTL in seconds (-1 = no expiry) and approximate size in bytes. ' +
        'Up to `limit` keys are returned together with the next `cursor`; pass that cursor to continue where the page stopped. A cursor of "0" means the whole database was walked.',
      inputSchema: {
        pattern: z.string().default('*').describe('glob pattern for key names, e.g. "user:*".'),
        cursor: z.string().min(1).default('0').describe('Cursor returned by the previous call, passed back unchanged; "0" starts from the beginning.'),
        limit: z.number().int().min(1).max(1000).default(100).describe('Maximum number of keys to return.'),
        count: z.number().int().min(1).max(10_000).default(100).describe('How many keys SCAN is told to examine per round (a hint for the server).'),
        type: z.enum(['string', 'list', 'set', 'zset', 'hash', 'stream']).optional().describe('Only return keys of this type (Redis 6.0+).'),
        db: databaseParam.optional(),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    ({ pattern, cursor, limit, count, type, db }) =>
      guard(async () => {
        const target = db ?? config.db;
        const started = Date.now();
        let { position, carry } = decodeCursor(cursor);
        // Keys carried over from the previous page come first; the walk resumes once they are handed out.
        const keys = carry.slice(0, limit);
        carry = carry.slice(limit);
        for (let round = 0; carry.length === 0 && keys.length < limit && round < MAX_SCAN_ROUNDS; round++) {
          const args: CommandArg[] = [position, 'MATCH', pattern, 'COUNT', String(count)];
          if (type) args.push('TYPE', type);
          // A round can come back empty-handed on a crowded database, so keep paging until the page is full or the walk is done.
          const [next, batch] = (await reading(() => gateway.run('SCAN', args, target))) as [Buffer, Buffer[]];
          const room = limit - keys.length;
          keys.push(...batch.slice(0, room));
          // The cursor has moved past the whole round, so matches that do not fit this page travel inside the cursor instead of being lost.
          carry = batch.slice(room);
          position = next.toString();
          if (position === '0') break;
        }
        const done = position === '0' && carry.length === 0;
        // Details of the whole page go out in one round trip: the shared connection pipelines them.
        const details = await Promise.all(
          keys.flatMap((key) => [gateway.run('TYPE', [key], target), gateway.run('TTL', [key], target), gateway.run('MEMORY', ['USAGE', key], target)]),
        );
        const found = keys.flatMap((key, index) => {
          const type = String(details[3 * index]);
          // A key can expire between SCAN and TYPE; "none" is what Redis answers for it then.
          return type === 'none'
            ? []
            : [{ key: encodeReply(key), type, ttl: encodeReply(details[3 * index + 1]), bytes: encodeReply(details[3 * index + 2]) }];
        });
        return text({ db: target, cursor: done ? '0' : encodeCursor(position, carry), count: found.length, keys: found, elapsed_ms: Date.now() - started });
      }),
  );
}

const CARRIED_CURSOR = /^p1\.(\d+)\.([A-Za-z0-9_-]+)$/;

/** A SCAN cursor, wrapped up with the keys that did not fit into the previous page. */
function encodeCursor(position: string, carry: readonly Buffer[]): string {
  if (carry.length === 0) return position;
  const names = JSON.stringify(carry.map((key) => key.toString('base64')));
  return `p1.${position}.${Buffer.from(names).toString('base64url')}`;
}

function decodeCursor(cursor: string): { position: string; carry: Buffer[] } {
  const carried = CARRIED_CURSOR.exec(cursor);
  if (!carried) {
    if (/^\d+$/.test(cursor)) return { position: cursor, carry: [] };
  } else {
    try {
      const names = JSON.parse(Buffer.from(carried[2] ?? '', 'base64url').toString()) as string[];
      return { position: carried[1] ?? '0', carry: names.map((name) => Buffer.from(name, 'base64')) };
    } catch {
      // Fall through to the error below: a cursor nobody can read is not one of ours.
    }
  }
  throw new Error('cursor must be one returned by an earlier scan_keys call');
}
