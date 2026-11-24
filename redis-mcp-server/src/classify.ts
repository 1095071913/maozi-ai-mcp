import {hasFlag} from '@ioredis/commands';

export type Kind = 'read' | 'write' | 'unsupported';

export interface Classification {
  kind: Kind;
  /** `write`: why the command needs `confirm`. */
  danger?: string;
  /** `unsupported`: why the command is refused. */
  reason?: string;
  /** True when the command can sit for a while without replying (BLPOP, XREAD BLOCK, …). */
  blocking: boolean;
}

/**
 * Commands that only report state although Redis does not flag them `readonly`. Everything
 * else is decided by Redis's own command flags (see `hasFlag`), so the list stays short.
 * Written as "name" or "name subcommand", in lower case.
 */
const READ_COMMANDS = new Set(['command', 'echo', 'info', 'lastsave', 'ping', 'role', 'time']);
const READ_SUBCOMMANDS = new Set([
  'acl cat', 'acl dryrun', 'acl genpass', 'acl getuser', 'acl help', 'acl list', 'acl log', 'acl users', 'acl whoami',
  'client getname', 'client id', 'client info', 'client list', 'client no-evict', 'client no-touch',
  'cluster count-failure-reports', 'cluster countkeysinslot', 'cluster getkeysinslot', 'cluster help', 'cluster info',
  'cluster keyslot', 'cluster links', 'cluster myid', 'cluster nodes', 'cluster shards', 'cluster slaves', 'cluster slots',
  'config get',
  'function dump', 'function help', 'function list', 'function stats',
  'latency doctor', 'latency history', 'latency help', 'latency latest',
  'memory doctor', 'memory help', 'memory stats', 'memory usage',
  'module help', 'module list',
  'object encoding', 'object freq', 'object help', 'object idletime', 'object refcount',
  'pubsub channels', 'pubsub help', 'pubsub numpat', 'pubsub numsub', 'pubsub shardchannels', 'pubsub shardnumsub',
  'script exists', 'script help', 'script info',
  'slowlog get', 'slowlog help', 'slowlog len',
  'xinfo consumers', 'xinfo groups', 'xinfo help', 'xinfo stream',
]);

/** `name` → why no call may run it. */
const UNSUPPORTED_COMMANDS: Record<string, string> = {
  select: 'the database is chosen with the `db` argument or REDIS_DB, not per connection',
  auth: 'credentials come from the server configuration, not per connection',
  hello: 'the protocol is negotiated by the client library',
  reset: 'it resets the state of a connection that other calls share',
  quit: 'the server owns its connections',
  multi: 'each call runs exactly one command. Use EVAL or EVALSHA when several changes must apply together',
  exec: 'each call runs exactly one command. Use EVAL or EVALSHA when several changes must apply together',
  discard: 'each call runs exactly one command. Use EVAL or EVALSHA when several changes must apply together',
  watch: 'each call runs exactly one command. Use EVAL or EVALSHA when several changes must apply together',
  unwatch: 'each call runs exactly one command. Use EVAL or EVALSHA when several changes must apply together',
  monitor: 'it streams every command the server handles, which a single call cannot return',
  sync: 'it turns the connection into a replication stream',
  psync: 'it turns the connection into a replication stream',
  replconf: 'it configures a replication connection',
};
/** `name subcommand` → why no call may run it. */
const UNSUPPORTED_SUBCOMMANDS: Record<string, string> = {
  'client reply': 'it changes how a connection that other calls share receives its replies',
  'client tracking': 'it makes the server push invalidation messages on a shared connection',
  'client caching': 'it opts a shared connection into server-assisted client tracking',
};
/** Commands flagged `pubsub` that are not subscriptions. */
const PUBLISHES = new Set(['publish', 'spublish']);

/** `name` or `name subcommand` → why the command needs `confirm`. */
const DANGEROUS: Record<string, string> = {
  flushall: 'deletes every key in every database',
  flushdb: 'deletes every key in the selected database',
  shutdown: 'stops the Redis server',
  swapdb: 'swaps the contents of two databases',
  failover: 'triggers a failover',
  debug: 'changes the internals of the server and can crash or restart it',
  'config set': 'changes the configuration of the server',
  'config resetstat': 'resets the statistics of the server',
  'config rewrite': 'rewrites the configuration file of the server',
  'acl setuser': 'changes the ACL users, which can lock clients out',
  'acl deluser': 'deletes ACL users, which can lock clients out',
  'acl load': 'replaces the ACL users from a file, which can lock clients out',
  'acl save': 'writes the ACL users to a file',
  'acl loadfromfile': 'replaces the ACL users from a file, which can lock clients out',
  'client kill': 'disconnects other clients',
  'client pause': 'pauses every other client',
  'module load': 'loads a module into the server',
  'module loadex': 'loads a module into the server',
  'module unload': 'unloads a module from the server',
  'function flush': 'deletes every server-side function',
  'function delete': 'deletes server-side functions',
  'function restore': 'replaces the server-side functions',
};

function isKnown(name: string): boolean {
  return exists(name, { caseInsensitive: true });
}

function flagged(name: string, flag: string): boolean {
  return isKnown(name) && hasFlag(name, flag, { nameCaseInsensitive: true });
}

function dangerOf(name: string, args: readonly unknown[]): string | undefined {
  // Becoming a replica replaces the local dataset once the server synchronizes; ceasing to be one does not.
  const firstWords = args.slice(0, 2).map((arg) => String(arg).toLowerCase()).join(' ');
  if ((name === 'replicaof' || name === 'slaveof') && firstWords !== 'no one') {
    return 'turns this server into a replica, which replaces its dataset when it synchronizes';
  }
  const sub = typeof args[0] === 'string' ? args[0].toLowerCase() : '';
  const danger = DANGEROUS[name] ?? (sub ? DANGEROUS[`${name} ${sub}`] : undefined);
  if (danger !== undefined) return danger;
  // Every CLUSTER command that is not one of the informational ones above changes the cluster state.
  if (name === 'cluster') return 'changes the state of the cluster';
  return undefined;
}

/**
 * Decides how a command may be run. The command name is a single token of its own here, unlike
 * words inside an SQL string, so nothing can hide behind it: what gets classified is exactly
 * what gets sent.
 */
export function classify(command: string, args: readonly unknown[]): Classification {
  const name = command.toLowerCase();
  /** The subcommand, in lower case so that it matches the tables above. */
  const sub = typeof args[0] === 'string' ? args[0].toLowerCase() : '';
  const withSub = sub ? `${name} ${sub}` : name;

  const reason =
    UNSUPPORTED_COMMANDS[name] ??
    UNSUPPORTED_SUBCOMMANDS[withSub] ??
    (flagged(name, 'pubsub') && !PUBLISHES.has(name) ? 'it subscribes to a stream of messages, which a single call cannot return' : undefined);
  if (reason !== undefined) return { kind: 'unsupported', reason, blocking: false };

  const blocking = flagged(name, 'blocking');
  if (READ_COMMANDS.has(name) || READ_SUBCOMMANDS.has(withSub) || flagged(name, 'readonly')) {
    return { kind: 'read', blocking };
  }
  // Commands missing from the table (modules, newer servers) are an unknown quantity: they may write.
  return { kind: 'write', blocking, danger: dangerOf(name, args) };
}
