// Drives the built server the way an MCP client does (stdio) against a real Redis.
// Connection settings come from the usual REDIS_* variables (then <project>/.env). The test only
// touches keys named mcp:e2e:<pid>:* in databases 15 and 14 and removes them afterwards.
// Point REDIS_* at a disposable instance anyway: with E2E_DISPOSABLE_REDIS=yes the last test
// also runs FLUSHDB on database 15 and SHUTDOWN on the whole server.

import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import Redis from 'ioredis';
import {classify} from '../dist/classify.js';
import {loadConfig, parseEnvSource} from '../dist/config.js';
import {Failure} from '../dist/db.js';
import {registerTools} from '../dist/tools.js';

const entry = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
const SCRATCH = 15;
const OTHER = 14;
const DISPOSABLE = process.env.E2E_DISPOSABLE_REDIS === 'yes';
/** Key name inside the test's own namespace. */
const K = (name) => `mcp:e2e:${process.pid}:${name}`;
const serverEnv = { REDIS_MCP_READONLY: '0', REDIS_MCP_TIMEOUT_MS: '2500' };

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

function connectionOptions() {
  // Same resolution as the server itself: environment first, then <project>/.env, then defaults.
  const { host, port, username, password } = loadConfig();
  return { host, port, username, password };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(probe, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await probe();
    if (value) return value;
    await sleep(50);
  }
  return undefined;
}

/**
 * Starts the server over stdio. `env` is layered over the environment the tests normally use;
 * `bareEnv` replaces that environment wholesale, to prove nothing comes from anywhere else.
 */
async function startServer({ args = [], env = {}, bareEnv } = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry, ...args],
    env: bareEnv ?? { ...process.env, ...serverEnv, ...env },
    stderr: 'inherit',
  });
  const client = new Client({ name: 'e2e-test', version: '1.0.0' });
  await client.connect(transport);
  return { client, transport };
}

/** Calls a tool and unpacks its JSON payload; refusals and thrown protocol errors both come back with isError. */
function callerFor(client) {
  return async (name, args = {}) => {
    let result;
    try {
      result = await client.callTool({ name, arguments: args });
    } catch (err) {
      return { isError: true, text: err.message };
    }
    const text = result.content.map((part) => (part.type === 'text' ? part.text : '')).join('\n');
    return result.isError ? { isError: true, text } : { isError: false, text, json: JSON.parse(text) };
  };
}

/** Some tests change REDIS_* variables in this process; these hand them back afterwards. */
function snapshotEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('REDIS_')));
}

function restoreEnv(snapshot) {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('REDIS_')) delete process.env[key];
  }
  for (const [key, value] of Object.entries(snapshot)) process.env[key] = value;
}

const temporaryDirectory = () => mkdtempSync(path.join(tmpdir(), 'redis-mcp-e2e-'));

/** Writes a settings file in .env form. Values are double-quoted, which Node's parser understands. */
function writeEnvFile(file, settings) {
  writeFileSync(file, Object.entries(settings).map(([key, value]) => `${key}=${JSON.stringify(String(value))}`).join('\n') + '\n');
  return file;
}

let main;
let call;
let admin;
let side;
let shutDown = false;
/** Connections of the server under test, as the server sees them. */
let ourConnections;

test('initialize and tools/list', async () => {
  const { tools } = await main.client.listTools();
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ['read_command', 'write_command', 'scan_keys'],
  );
  assert.match(main.client.getInstructions(), /scan_keys/);
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  assert.equal(byName.read_command.annotations.readOnlyHint, true);
  assert.equal(byName.scan_keys.annotations.readOnlyHint, true);
  assert.equal(byName.write_command.annotations.destructiveHint, true);
  assert.equal(byName.read_command.inputSchema.properties.limit.default, 200);
  assert.equal(byName.write_command.inputSchema.properties.confirm.default, false);
  assert.equal(byName.scan_keys.inputSchema.properties.pattern.default, '*');
});

test('the classifier decides read / write / dangerous / blocking / unsupported from Redis’s own command flags', async () => {
  const kindOf = (line) => {
    const [command, ...args] = line.split(/\s+/);
    const { kind, danger, blocking, reason } = classify(command, args);
    return [kind, danger && 'danger', blocking && 'blocking', reason && 'refused'].filter(Boolean).join(' ');
  };
  for (const line of [
    'GET k', 'SINTERCARD 1 s', 'MGET a b', 'HGETALL h', 'HSCAN h 0', 'LRANGE l 0 -1', 'SMEMBERS s', 'ZRANGE z 0 -1 WITHSCORES', 'SCAN 0', 'TTL k',
    'PTTL k', 'TYPE k', 'DBSIZE', 'KEYS *', 'DUMP k', 'INFO', 'INFO memory', 'PING', 'ECHO hi', 'TIME', 'ROLE', 'LASTSAVE',
    'CONFIG GET maxmemory', 'config get maxmemory', 'OBJECT ENCODING k', 'MEMORY USAGE k', 'MEMORY STATS', 'CLIENT LIST',
    'CLIENT GETNAME', 'ACL WHOAMI', 'ACL GETUSER default', 'ACL LOG', 'XINFO STREAM s', 'SLOWLOG GET', 'SCRIPT EXISTS abc',
    'PUBSUB CHANNELS', 'CLUSTER INFO', 'COMMAND COUNT', 'FUNCTION LIST', 'MODULE LIST', 'LATENCY LATEST', 'BITFIELD_RO k GET u8 0',
  ]) {
    assert.equal(kindOf(line), 'read', line);
  }
  for (const line of ['XREAD BLOCK 5 STREAMS s $', 'XREAD STREAMS s 0', 'BLPOP l 1', 'BRPOP l 0', 'BLMOVE a b LEFT 1', 'WAIT 0 0']) {
    assert.equal(kindOf(line), /XREAD/.test(line) ? 'read blocking' : 'write blocking', line);
  }
  for (const line of [
    'SET k v', 'SET k v EX 60', 'DEL k', 'UNLINK k', 'INCR c', 'INCRBY c 5', 'LPUSH l a', 'HSET h f v', 'SADD s m', 'ZADD z 1 m',
    'XADD s * f v', 'EXPIRE k 5', 'GETEX k', 'GETDEL k', 'SORT l', 'BITFIELD k SET u8 0 1', 'EVAL "return 1" 0', 'EVALSHA abc 0',
    'PUBLISH ch m', 'SPUBLISH ch m', 'CLIENT SETNAME x', 'CLIENT UNPAUSE', 'SCRIPT FLUSH', 'SAVE', 'BGSAVE',
    'MIGRATE h 6379 k 0 1000', 'RESTORE k 0 abc', 'REPLICAOF NO ONE', 'SLAVEOF NO ONE', 'json.get k', 'FT.SEARCH i q',
  ]) {
    assert.equal(kindOf(line), 'write', line);
  }
  for (const line of [
    'FLUSHALL', 'FLUSHALL ASYNC', 'FLUSHDB', 'FLUSHDB 15 ASYNC', 'SHUTDOWN', 'SHUTDOWN NOSAVE', 'SWAPDB 1 2', 'FAILOVER', 'DEBUG OBJECT k',
    'DEBUG SLEEP 1', 'DEBUG RELOAD', 'CONFIG SET maxmemory 100mb', 'CONFIG RESETSTAT', 'CONFIG REWRITE', 'ACL SETUSER u on',
    'ACL DELUSER u', 'ACL LOAD', 'ACL SAVE', 'CLIENT KILL ID 1', 'CLIENT KILL ADDR 1.2.3.4:1', 'CLIENT PAUSE 1000',
    'MODULE LOAD x.so', 'MODULE UNLOAD x', 'FUNCTION FLUSH', 'FUNCTION DELETE lib', 'CLUSTER RESET', 'CLUSTER FLUSHSLOTS',
    'REPLICAOF 10.0.0.1 6379', 'SLAVEOF 10.0.0.1 6379',
  ]) {
    assert.equal(kindOf(line), 'write danger', line);
  }
  for (const line of [
    'SELECT 1', 'AUTH pass', 'AUTH user pass', 'HELLO 3', 'RESET', 'QUIT', 'MULTI', 'EXEC', 'DISCARD', 'WATCH k', 'UNWATCH',
    'SUBSCRIBE ch', 'UNSUBSCRIBE', 'PSUBSCRIBE news.*', 'PUNSUBSCRIBE', 'SSUBSCRIBE ch', 'SUNSUBSCRIBE ch', 'MONITOR', 'SYNC',
    'PSYNC ?', 'REPLCONF ack 0', 'CLIENT REPLY OFF', 'CLIENT REPLY SKIP', 'CLIENT TRACKING ON', 'CLIENT CACHING YES',
  ]) {
    assert.equal(kindOf(line), 'unsupported refused', line);
  }
});

test('write_command and read_command: strings, numbers, lists, hashes, sets, sorted sets and streams', async () => {
  const write = (command, args) => call('write_command', { command, args, db: SCRATCH });
  const read = (command, args) => call('read_command', { command, args, db: SCRATCH });
  const value = (result) => {
    assert.equal(result.isError, false, result.text);
    return result.json.result;
  };

  // 增
  assert.deepEqual(value(await write('SET', [K('s'), 'value'])), 'OK');
  assert.equal(value(await write('SET', [K('exp'), '1', 'EX', '60'])), 'OK');
  assert.equal(value(await write('APPEND', [K('s'), '!'])), 6);
  assert.equal(value(await write('MSET', [K('m1'), 'a', K('m2'), 'b'])), 'OK');
  assert.equal(value(await write('HSET', [K('h'), 'f1', 'v1', 'f2', 'v2'])), 2);
  assert.equal(value(await write('RPUSH', [K('l'), 'a', 'b', 'c'])), 3);
  assert.equal(value(await write('SADD', [K('set'), 'x', 'y', 'z'])), 3);
  assert.equal(value(await write('ZADD', [K('z'), '1.5', 'm', '2', 'n'])), 2);
  assert.equal(value(await write('SETBIT', [K('bits'), '7', '1'])), 0);
  const streamId = value(await write('XADD', [K('stream'), '*', 'f', 'v']));
  assert.match(streamId, /^\d+-\d+$/);

  // 查
  assert.equal(value(await read('GET', [K('s')])), 'value!');
  assert.equal(value(await read('GET', [K('missing')])), null);
  assert.deepEqual(value(await read('MGET', [K('m1'), K('missing'), K('m2')])), ['a', null, 'b']);
  const ttl = value(await read('TTL', [K('exp')]));
  assert.ok(ttl > 50 && ttl <= 60, `TTL ${ttl}`);
  assert.equal(value(await read('TYPE', [K('h')])), 'hash');
  assert.equal(value(await read('STRLEN', [K('s')])), 6);
  assert.equal(value(await read('OBJECT', ['ENCODING', K('s')])), 'raw');
  assert.deepEqual(value(await read('HGETALL', [K('h')])), { f1: 'v1', f2: 'v2' });
  assert.equal(value(await read('HGET', [K('h'), 'f1'])), 'v1');
  assert.equal(value(await read('HLEN', [K('h')])), 2);
  assert.deepEqual(value(await read('LRANGE', [K('l'), '0', '-1'])), ['a', 'b', 'c']);
  assert.deepEqual([...value(await read('SMEMBERS', [K('set')]))].sort(), ['x', 'y', 'z']);
  assert.deepEqual(value(await read('ZRANGE', [K('z'), '0', '-1', 'WITHSCORES'])), ['m', 1.5, 'n', 2]);
  assert.equal(value(await read('ZSCORE', [K('z'), 'm'])), 1.5);
  assert.equal(value(await read('GETBIT', [K('bits'), '7'])), 1);
  assert.deepEqual(value(await read('XRANGE', [K('stream'), '-', '+'])), [[streamId, ['f', 'v']]]);
  assert.equal(value(await read('XLEN', [K('stream')])), 1);
  assert.deepEqual(value(await read('SCAN', ['0', 'MATCH', `${K('')}*`, 'COUNT', '1000'])).length, 2);

  // A value that looks like a number is still a string; integers that are replies are numbers.
  assert.equal(value(await write('SET', [K('digits'), '123'])), 'OK');
  assert.equal(value(await read('GET', [K('digits')])), '123');
  assert.equal(typeof value(await read('DBSIZE')), 'number');
  assert.equal(value(await read('EXISTS', [K('s'), K('missing')])), 1);
  // Beyond 2^53 the reply keeps its exact text.
  await write('SET', [K('big'), '9007199254740992']);
  assert.equal(value(await write('INCR', [K('big')])), '9007199254740993');
  assert.equal(value(await write('INCR', [K('counter')])), 1);

  // Server information
  assert.match(value(await read('INFO', ['server'])), /redis_version:/);
  assert.deepEqual(value(await read('ROLE')), ['master', 0, []]);
  assert.equal(value(await read('CONFIG', ['GET', 'maxmemory'])).maxmemory, '0');
  assert.equal(value(await read('CONFIG GET', ['maxmemory'])).maxmemory, '0');
  assert.equal(value(await read('PING')), 'PONG');
  assert.equal(value(await read('CLIENT', ['GETNAME'])), `redis-mcp-server:${main.transport.pid}`);
  assert.equal((await read('TIME')).json.result.length, 2);

  // 改
  assert.equal(value(await write('SET', [K('s'), 'second'])), 'OK');
  assert.equal(value(await read('GET', [K('s')])), 'second');
  assert.equal(value(await write('HSET', [K('h'), 'f1', 'changed'])), 0);
  assert.equal(value(await read('HGET', [K('h'), 'f1'])), 'changed');
  assert.equal(value(await write('ZADD', [K('z'), '9', 'm'])), 0);
  assert.equal(value(await read('ZSCORE', [K('z'), 'm'])), 9);
  assert.equal(value(await write('LSET', [K('l'), '0', 'A'])), 'OK');
  assert.equal(value(await write('RENAME', [K('m1'), K('m1-renamed')])), 'OK');
  assert.equal(value(await write('EXPIRE', [K('s'), '100'])), 1);
  assert.equal(value(await write('PERSIST', [K('s')])), 1);
  assert.equal(value(await read('TTL', [K('s')])), -1);

  // 删
  assert.equal(value(await write('HDEL', [K('h'), 'f2'])), 1);
  assert.equal(value(await write('SREM', [K('set'), 'y'])), 1);
  assert.equal(value(await write('ZREM', [K('z'), 'n'])), 1);
  assert.equal(value(await write('LPOP', [K('l')])), 'A');
  assert.equal(value(await write('RPOP', [K('l')])), 'c');
  assert.equal(value(await write('UNLINK', [K('bits')])), 1);
  assert.equal(value(await write('DEL', [K('m2'), K('missing')])), 1);
  assert.equal(value(await read('GET', [K('m2')])), null);
});

test('scripts, the `db` argument, and commands typed in either shape', async () => {
  const write = (command, args, db = SCRATCH) => call('write_command', { command, args, db });
  const read = (command, args, db = SCRATCH) => call('read_command', { command, args, db });
  const value = (result) => {
    assert.equal(result.isError, false, result.text);
    return result.json.result;
  };

  assert.equal(value(await write('EVAL', ['return KEYS[1] .. ":" .. ARGV[1]', '1', 'a', 'b'])), 'a:b');
  const sha = value(await write('SCRIPT LOAD', ['return redis.call("INCR", KEYS[1])']));
  assert.match(sha, /^[0-9a-f]{40}$/);
  assert.deepEqual(value(await read('SCRIPT', ['EXISTS', sha])), [1]);
  assert.equal(value(await write('EVALSHA', [sha, '1', K('scripted')])), 1);
  assert.equal(value(await write('EVALSHA', [sha, '1', K('scripted')])), 2);
  assert.equal(value(await write('PUBLISH', [K('channel'), 'hello'])), 0);

  // A call names another database with `db`; the keys there are invisible from the first one.
  assert.equal(value(await write('SET', [K('other'), 'in 14'], OTHER)), 'OK');
  assert.equal(value(await read('GET', [K('other')])), null);
  assert.equal(value(await read('GET', [K('other')], OTHER)), 'in 14');
  // After a call to another database, calls without `db` are back where they started.
  assert.equal(value(await write('SET', [K('back'), 'home'])), 'OK');
  assert.equal(value(await read('GET', [K('back')])), 'home');
});

test('array replies are capped, long values are cut, oversized replies are refused', async () => {
  const write = (command, args) => call('write_command', { command, args, db: SCRATCH });
  const read = (command, args, extra = {}) => call('read_command', { command, args, db: SCRATCH, ...extra });
  const value = (result) => {
    assert.equal(result.isError, false, result.text);
    return result.json.result;
  };

  await write('DEL', [K('many')]);
  await write('RPUSH', [K('many'), ...Array.from({ length: 250 }, (_, n) => `item-${n}`)]);
  const all = await read('LRANGE', [K('many'), '0', '-1']);
  assert.equal(all.json.result.length, 200);
  assert.deepEqual(all.json.truncated, { returned: 200, total: 250 });
  const few = await read('LRANGE', [K('many'), '0', '-1'], { limit: 5 });
  assert.deepEqual([few.json.result, few.json.truncated], [['item-0', 'item-1', 'item-2', 'item-3', 'item-4'], { returned: 5, total: 250 }]);
  assert.equal((await read('LRANGE', [K('many'), '0', '-1'], { limit: 1000 })).json.truncated, undefined);
  const tooMuch = await read('LRANGE', [K('many'), '0', '-1'], { limit: 2001 });
  assert.equal(tooMuch.isError, true);

  const long = 'x'.repeat(5000);
  await write('SET', [K('long'), long]);
  const cut = value(await read('GET', [K('long')]));
  assert.ok(cut.endsWith('…[1000 more chars]') && cut.length < 4100, `length ${cut.length}`);

  await write('DEL', [K('wide')]);
  await write('RPUSH', [K('wide'), ...Array.from({ length: 60 }, () => 'y'.repeat(3900))]);
  const refused = await read('LRANGE', [K('wide'), '0', '-1']);
  assert.equal(refused.isError, true);
  assert.match(refused.text, /too large to return/);
  assert.equal((await read('LRANGE', [K('wide'), '0', '-1'], { limit: 10 })).json.result.length, 10);

  // Pairs become objects, capped by field.
  await write('DEL', [K('hash')]);
  await write('HSET', [K('hash'), ...Array.from({ length: 30 }, (_, n) => `f${n}`).flatMap((f, n) => [f, `v${n}`])]);
  const hash = await read('HGETALL', [K('hash')], { limit: 4 });
  assert.deepEqual([Object.keys(hash.json.result).length, hash.json.truncated], [4, { returned: 4, total: 30 }]);
  assert.ok(Object.entries(hash.json.result).every(([field, value]) => [/^f\d+$/.test(field), value === `v${field.slice(1)}`]));
});

test('binary values survive the round trip as base64', async () => {
  const javaSerialized = Buffer.from([0xac, 0xed, 0x00, 0x05, 0x73, 0x72, 0x00, 0x19, 0x63, 0x6f, 0x6d, 0x2e, 0x6d, 0x61, 0x6f, 0x7a, 0x69, 0x2e, 0x55, 0x73, 0x65, 0x72, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x4c]);
  const set = await call('write_command', { command: 'SET', args: [K('binary'), { base64: javaSerialized.toString('base64') }], db: SCRATCH });
  assert.equal(set.isError, false, set.text);

  const got = await call('read_command', { command: 'GET', args: [K('binary')], db: SCRATCH });
  assert.equal(got.isError, false, got.text);
  const result = got.json.result;
  assert.equal(result.base64, javaSerialized.toString('base64'));
  assert.equal(result.bytes, javaSerialized.length);
  assert.ok(result.preview.startsWith('\\xac\\xed\\x00\\x05sr\\x00\\x19com.maozi.User'), result.preview);

  // Bytes that happen to be valid UTF-8 but full of control characters are not passed off as text.
  await call('write_command', { command: 'SET', args: [K('proto'), { base64: Buffer.from([0x08, 0x01, 0x10, 0xff]).toString('base64') }], db: SCRATCH });
  const proto = await call('read_command', { command: 'GET', args: [K('proto')], db: SCRATCH });
  assert.equal(proto.json.result.base64, 'CAEQ/w==');

  // Text with non-ASCII characters, and a key with a binary name, stay what they are.
  await call('write_command', { command: 'SET', args: [K('text'), '中文 émoji 🚀'], db: SCRATCH });
  assert.equal((await call('read_command', { command: 'GET', args: [K('text')], db: SCRATCH })).json.result, '中文 émoji 🚀');

  // DUMP hands out raw bytes, RESTORE takes them back.
  await call('write_command', { command: 'SET', args: [K('dumped'), 'anything'], db: SCRATCH });
  const dump = (await call('read_command', { command: 'DUMP', args: [K('dumped')], db: SCRATCH })).json.result;
  assert.equal(dump.base64, (await admin.callBuffer('DUMP', K('dumped'))).toString('base64'));
  const restored = await call('write_command', {
    command: 'RESTORE',
    args: [K('restored'), '0', { base64: dump.base64 }],
    db: SCRATCH,
  });
  assert.equal(restored.isError, false, restored.text);
  assert.equal((await call('read_command', { command: 'GET', args: [K('restored')], db: SCRATCH })).json.result, 'anything');

  // A big blob reports its size and shows only its head.
  await call('write_command', { command: 'SET', args: [K('blob'), { base64: Buffer.alloc(5000, 0xff).toString('base64') }], db: SCRATCH });
  const blob = (await call('read_command', { command: 'GET', args: [K('blob')], db: SCRATCH })).json.result;
  const marker = '…[2000 more bytes]';
  assert.deepEqual([blob.bytes, blob.base64.length, blob.base64.endsWith(marker)], [5000, 4000 + marker.length, true]);
  assert.equal((await call('read_command', { command: 'STRLEN', args: [K('blob')], db: SCRATCH })).json.result, 5000);

  // Arguments that cannot be sent are refused by name, never stringified into garbage.
  for (const args of [[{ base64: 'not base64!!' }], [{ base64: 'a', extra: 1 }], [{ json: '{}' }], [[1, 2]], [null], [true]]) {
    const refused = await call('write_command', { command: 'SET', args: [K('never'), ...args], db: SCRATCH });
    assert.equal(refused.isError, true, JSON.stringify(args));
    assert.match(refused.text, /args\[\d\]/, JSON.stringify(args));
  }
  assert.equal((await call('read_command', { command: 'GET', args: [K('never')], db: SCRATCH })).json.result, null);
  // Whitespace-wrapped base64, as produced by many tools, is accepted.
  const wrapped = Buffer.from('wrapped').toString('base64').replace(/(.{4})/g, '$1\n');
  await call('write_command', { command: 'SET', args: [K('wrapped'), { base64: wrapped }], db: SCRATCH });
  assert.equal((await call('read_command', { command: 'GET', args: [K('wrapped')], db: SCRATCH })).json.result, 'wrapped');
});

test('read_command refuses everything that is not known to be read-only', async () => {
  for (const [command, args] of [
    ['SET', [K('no'), 'x']],
    ['DEL', [K('no')]],
    ['INCR', [K('no')]],
    ['LPUSH', [K('no'), 'x']],
    ['FLUSHALL', []],
    ['CONFIG', ['SET', 'maxmemory', '100mb']],
    ['CONFIG SET', ['maxmemory', '100mb']],
    ['CLIENT', ['KILL', 'TYPE', 'normal']],
    ['BITFIELD', [K('no'), 'SET', 'u8', '0', '1']],
    ['EVAL', ['return 1', '0']],
    ['JSON.GET', [K('no')]],
    ['NO-SUCH-COMMAND', []],
  ]) {
    const refused = await call('read_command', { command, args, db: SCRATCH });
    assert.equal(refused.isError, true, command);
    assert.match(refused.text, new RegExp(`^"${command.split(' ')[0]}" may change data or server state, so read_command does not run it\\. Use write_command\\.$`), command);
  }
  assert.equal((await call('read_command', { command: 'EXISTS', args: [K('no')], db: SCRATCH })).json.result, 0);
  const empty = await call('read_command', { command: '   ', db: SCRATCH });
  assert.match(empty.text, /is not a command name/);
});

test('commands that cannot fit a single call are refused with the reason', async () => {
  for (const [command, args, expected] of [
    ['SELECT', [OTHER], /the database is chosen with the `db` argument/],
    ['AUTH', ['secret'], /credentials come from the server configuration/],
    ['HELLO', ['3'], /negotiated by the client library/],
    ['MULTI', [], /runs exactly one command\. Use EVAL or EVALSHA/],
    ['EXEC', [], /runs exactly one command/],
    ['SUBSCRIBE', [K('channel')], /subscribes to a stream of messages/],
    ['PSUBSCRIBE', ['news.*'], /subscribes to a stream of messages/],
    ['MONITOR', [], /streams every command/],
    ['SYNC', [], /replication stream/],
    ['CLIENT', ['REPLY', 'OFF'], /how a connection that other calls share receives its replies/],
    ['QUIT', [], /the server owns its connections/],
  ]) {
    for (const name of ['read_command', 'write_command']) {
      const refused = await call(name, { command, args, db: SCRATCH });
      assert.equal(refused.isError, true, `${name} ${command}`);
      assert.match(refused.text, new RegExp(`^"${command}" is not supported here: .*${expected.source}`), `${name} ${command}`);
    }
  }
  // The shared connection is untouched: no transaction is open and the database is the same.
  assert.equal((await call('read_command', { command: 'CLIENT', args: ['GETNAME'], db: SCRATCH })).json.result.split(' ')[0], `redis-mcp-server:${main.transport.pid}`);
});

test('commands that affect the whole server or other clients need confirm', async () => {
  await call('write_command', { command: 'SET', args: [K('survivor'), 'still here'], db: SCRATCH });
  const refusedCommands = [
    ['FLUSHALL', []],
    ['FLUSHALL', ['ASYNC']],
    ['FLUSHDB', []],
    ['SHUTDOWN', []],
    ['SHUTDOWN', ['NOSAVE']],
    ['DEBUG', ['SLEEP', '0']],
    ['DEBUG OBJECT', [K('survivor')]],
    ['CONFIG', ['SET', 'maxmemory', '100mb']],
    ['CONFIG', ['RESETSTAT']],
    ['CONFIG', ['REWRITE']],
    ['REPLICAOF', ['127.0.0.1', '6379']],
    ['SLAVEOF', ['127.0.0.1', '6379']],
    ['ACL', ['SETUSER', 'e2e', 'on', '>e2e', '~*', '&*']],
    ['ACL', ['DELUSER', 'e2e']],
    ['CLIENT', ['KILL', 'TYPE', 'normal']],
    ['CLIENT', ['PAUSE', '1000']],
    ['SWAPDB', [OTHER, SCRATCH]],
    ['FAILOVER', []],
    ['CLUSTER', ['RESET']],
    ['MODULE', ['LOAD', '/tmp/none.so']],
    ['FUNCTION', ['FLUSH']],
  ];
  for (const [command, args] of refusedCommands) {
    const refused = await call('write_command', { command, args, db: SCRATCH });
    assert.equal(refused.isError, true, command);
    assert.match(refused.text, new RegExp(`^Refused: ".*${command}.*" .*\\. Show the command to the user and call again with confirm: true once they approve it\\.$`), command);
  }
  // Nothing above reached the server.
  assert.equal((await call('read_command', { command: 'GET', args: [K('survivor')], db: SCRATCH })).json.result, 'still here');
  assert.equal((await call('read_command', { command: 'PING', db: SCRATCH })).json.result, 'PONG');
  assert.equal((await call('read_command', { command: 'ROLE', db: SCRATCH })).json.result[0], 'master');
  assert.equal((await call('read_command', { command: 'CONFIG', args: ['GET', 'maxmemory'], db: SCRATCH })).json.result.maxmemory, '0');
  assert.equal((await call('read_command', { command: 'ACL', args: ['GETUSER', 'e2e'], db: SCRATCH })).json.result, null);

  // Confirming runs it. Swapping a database with itself leaves everything in place.
  const confirmed = await call('write_command', { command: 'SWAPDB', args: [SCRATCH, SCRATCH], db: SCRATCH, confirm: true });
  assert.equal(confirmed.isError, false, confirmed.text);
  assert.equal(confirmed.json.result, 'OK');
  assert.equal((await call('read_command', { command: 'GET', args: [K('survivor')], db: SCRATCH })).json.result, 'still here');
  // Ceasing to be a replica changes nothing, so it never needed confirmation.
  const promote = await call('write_command', { command: 'REPLICAOF', args: ['NO', 'ONE'], db: SCRATCH });
  assert.equal(promote.json.result, 'OK');
});

test('Redis error replies come back as tool errors that name the command', async () => {
  await call('write_command', { command: 'SET', args: [K('a-string'), 'x'], db: SCRATCH });
  const wrongType = await call('write_command', { command: 'LPUSH', args: [K('a-string'), 'x'], db: SCRATCH });
  assert.equal(wrongType.isError, true);
  assert.match(wrongType.text, new RegExp(`Redis error: WRONGTYPE Operation against a key holding the wrong kind of value  \\(command: LPUSH ${K('a-string')} x\\)`));

  const unknown = await call('write_command', { command: 'NO-SUCH-COMMAND', db: SCRATCH });
  assert.match(unknown.text, /Redis error: ERR unknown command .*\(command: NO-SUCH-COMMAND\)/);

  const arity = await call('write_command', { command: 'SET', args: [K('only-key')], db: SCRATCH });
  assert.match(arity.text, /Redis error: ERR wrong number of arguments for 'set' command/);

  // …and the server is still healthy afterwards.
  assert.equal((await call('read_command', { command: 'PING', db: SCRATCH })).json.result, 'PONG');
});

test('scan_keys pages through keys with their type, TTL and size', async () => {
  await call('write_command', { command: 'SET', args: [K('scan:str'), 'v'], db: SCRATCH });
  await call('write_command', { command: 'SET', args: [K('scan:temp'), 'v', 'EX', '100'], db: SCRATCH });
  await call('write_command', { command: 'RPUSH', args: [K('scan:list'), 'a', 'b'], db: SCRATCH });
  await call('write_command', { command: 'HSET', args: [K('scan:hash'), 'f', 'v'], db: SCRATCH });
  await call('write_command', { command: 'SADD', args: [K('scan:set'), 'm'], db: SCRATCH });
  await call('write_command', { command: 'ZADD', args: [K('scan:zset'), '1', 'm'], db: SCRATCH });
  await call('write_command', { command: 'XADD', args: [K('scan:stream'), '*', 'f', 'v'], db: SCRATCH });
  await call('write_command', { command: 'SET', args: [K('scan:other'), 'v'], db: OTHER });

  const page = await call('scan_keys', { pattern: `${K('')}scan:*`, db: SCRATCH });
  assert.equal(page.isError, false, page.text);
  assert.equal(page.json.cursor, '0');
  assert.equal(page.json.db, SCRATCH);
  const byKey = Object.fromEntries(page.json.keys.map((key) => [key.key, key]));
  assert.deepEqual(Object.keys(byKey).sort(), ['hash', 'list', 'set', 'str', 'stream', 'temp', 'zset'].map((n) => K(`scan:${n}`)).sort());
  assert.deepEqual([byKey[K('scan:str')].type, byKey[K('scan:str')].ttl, typeof byKey[K('scan:str')].bytes], ['string', -1, 'number']);
  assert.deepEqual([byKey[K('scan:list')].type, byKey[K('scan:hash')].type, byKey[K('scan:set')].type, byKey[K('scan:zset')].type, byKey[K('scan:stream')].type], ['list', 'hash', 'set', 'zset', 'stream']);
  assert.ok(byKey[K('scan:temp')].ttl > 90);

  // A page stops at `limit` and says where to continue.
  const first = await call('scan_keys', { pattern: `${K('')}scan:*`, limit: 3, count: 1, db: SCRATCH });
  const second = await call('scan_keys', { pattern: `${K('')}scan:*`, limit: 3, count: 1, cursor: first.json.cursor, db: SCRATCH });
  const third = await call('scan_keys', { pattern: `${K('')}scan:*`, limit: 3, count: 1, cursor: second.json.cursor, db: SCRATCH });
  const seen = [...first.json.keys, ...second.json.keys, ...third.json.keys].map((key) => key.key);
  assert.equal(new Set(seen).size, 7, JSON.stringify(seen));

  // One round returns all seven matches at once (a large COUNT) while each page may hold a single key:
  // the rest must travel inside the cursor instead of being dropped.
  const singles = [];
  let pageCursor = '0';
  for (let page = 0; page < 10; page++) {
    const single = await call('scan_keys', { pattern: `${K("")}scan:*`, limit: 1, count: 1000, cursor: pageCursor, db: SCRATCH });
    assert.equal(single.isError, false, single.text);
    assert.equal(single.json.keys.length, 1, `page ${page} holds exactly one key (${single.text})`);
    singles.push(single.json.keys[0].key);
    pageCursor = single.json.cursor;
    if (pageCursor === '0') break;
  }
  assert.deepEqual(singles.slice().sort(), seen.slice().sort());
  assert.equal(pageCursor, '0');
  for (const bogus of ['abc', 'p1.0.!!!', 'p1.0.eyJub3QtYS1saXN0IjoxfQ']) {
    assert.match((await call('scan_keys', { cursor: bogus, db: SCRATCH })).text, /cursor must be one returned by an earlier scan_keys call/);
  }

  const lists = await call('scan_keys', { pattern: `${K('')}scan:*`, type: 'list', db: SCRATCH });
  assert.deepEqual(lists.json.keys.map((key) => key.key), [K('scan:list')]);
  const nothing = await call('scan_keys', { pattern: `${K('')}nothing:*`, db: SCRATCH });
  assert.deepEqual([nothing.json.cursor, nothing.json.keys], ['0', []]);
});

test('blocking commands wait on a connection of their own, for at most the wait limit', async () => {
  const started = Date.now();
  const empty = await call('write_command', { command: 'BLPOP', args: [K('queue'), '1'], db: SCRATCH });
  assert.equal(empty.isError, false, empty.text);
  assert.equal(empty.json.result, null); // the command's own timeout of one second ran out
  assert.ok(Date.now() - started >= 1000);

  // No server-side timeout: the wait limit of the server cuts it short.
  const cut = await call('write_command', { command: 'BLPOP', args: [K('queue'), '0'], db: SCRATCH });
  assert.equal(cut.isError, true);
  assert.match(cut.text, /did not answer BLPOP .* within 2500 ms, so the connection was closed to abort it/);

  // The shared connection was not involved, and nothing of ours is left blocked on the server.
  const pingAt = Date.now();
  assert.equal((await call('read_command', { command: 'PING', db: SCRATCH })).json.result, 'PONG');
  assert.ok(Date.now() - pingAt < 500, 'the shared connection must not have waited');
  assert.equal((await ourConnections()).filter((connection) => connection.flags.includes('b')).length, 0);

  // While one call waits, another one is served right away …
  const waiting = call('write_command', { command: 'BLPOP', args: [K('queue'), '2'], db: SCRATCH });
  await waitFor(async () => (await ourConnections()).some((connection) => connection.flags.includes('b')));
  const quickAt = Date.now();
  assert.equal((await call('read_command', { command: 'PING', db: SCRATCH })).json.result, 'PONG');
  assert.ok(Date.now() - quickAt < 500);
  // … and the waiting call still gets what arrives.
  await admin.rpush(K('queue'), 'job');
  const delivered = await waiting;
  assert.deepEqual(delivered.json.result, [K('queue'), 'job']);

  const stream = await call('read_command', { command: 'XREAD', args: ['BLOCK', '200', 'STREAMS', K('never'), '$'], db: SCRATCH });
  assert.equal(stream.json.result, null);
  await call('write_command', { command: 'XADD', args: [K('events'), '*', 'f', 'v'], db: SCRATCH });
  const events = await call('read_command', { command: 'XREAD', args: ['STREAMS', K('events'), '0'], db: SCRATCH });
  assert.equal(events.json.result[0][0], K('events'));
});

test('recovers when the server drops the connections', async () => {
  await call('read_command', { command: 'PING', db: SCRATCH });
  for (const connection of await ourConnections()) await admin.call('CLIENT', 'KILL', 'ID', connection.id);
  await sleep(100);
  assert.equal((await call('read_command', { command: 'PING', db: SCRATCH })).json.result, 'PONG');

  // A blocking call whose connection is killed fails at once instead of waiting out its timeout.
  const waiting = call('write_command', { command: 'BLPOP', args: [K('queue'), '10'], db: SCRATCH });
  const blocked = await waitFor(async () => (await ourConnections()).find((connection) => connection.flags.includes('b')));
  assert.ok(blocked, 'the blocking call should show up as a blocked client');
  await admin.call('CLIENT', 'KILL', 'ID', blocked.id);
  const at = Date.now();
  const result = await waiting;
  assert.match(result.text, /connection to Redis was lost while running BLPOP/);
  assert.ok(Date.now() - at < 1500, 'it must fail promptly');
  assert.equal((await call('read_command', { command: 'PING', db: SCRATCH })).json.result, 'PONG');
});

test('a read is repeated once when an established connection drops underneath it — and only then', async () => {
  const dropped = (command, args = []) =>
    new Failure('Command aborted due to connection close', new Error('Command aborted due to connection close'), new Error('socket closed'), command, args, true);
  const neverConnected = (command) =>
    Object.assign(new Failure('Reached the max retries', new Error('Reached the max retries'), Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }), command, [], false));
  const timedOutFailure = (command) =>
    new Failure('Command timed out', new Error('Command timed out'), undefined, command, [], true);

  /** A server wired to a fake gateway, in memory: no Redis needed for the retry policy. */
  async function withGateway(run) {
    const server = new McpServer({ name: 'stub', version: '1.0.0' });
    registerTools(server, {
      config: { host: '127.0.0.1', port: 6390, db: 0, timeoutMs: 1500, readonly: false },
      gateway: { run: (command, args) => run(command, args), runAlone: (command, args) => run(command, args), shutdown: async () => undefined, close: () => undefined },
    });
    const client = new Client({ name: 'stub-client', version: '1.0.0' });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    await client.connect(clientSide);
    return callerFor(client);
  }

  let attempts = 0;
  const retried = await withGateway(async () => (++attempts === 1 ? Promise.reject(dropped('GET')) : Buffer.from('second try')));
  const get = await retried('read_command', { command: 'GET', args: ['k'] });
  assert.deepEqual([get.isError, get.json.result, attempts], [false, 'second try', 2]);

  attempts = 0;
  const write = await withGateway(async (command, args) => (++attempts, Promise.reject(dropped(command, args))));
  const set = await write('write_command', { command: 'SET', args: ['k', 'v'] });
  assert.match(set.text, /connection to Redis was lost while running SET k v: socket closed .* may or may not have been applied/);
  assert.equal(attempts, 1, 'a write is not repeated');

  attempts = 0;
  const blocking = await withGateway(async (command) => (++attempts, Promise.reject(dropped(command))));
  assert.equal((await blocking('read_command', { command: 'XREAD', args: ['BLOCK', '1', 'STREAMS', 's', "$"] })).isError, true);
  assert.equal(attempts, 1, 'a blocking command is not repeated');

  attempts = 0;
  const slow = await withGateway(async (command) => (++attempts, Promise.reject(timedOutFailure(command))));
  const timeout = await slow('read_command', { command: 'KEYS', args: ['*'] });
  assert.match(timeout.text, /did not answer KEYS.* within 1500 ms/);
  assert.equal(attempts, 1, 'a timed-out command is not repeated');

  attempts = 0;
  const offline = await withGateway(async (command) => (++attempts, Promise.reject(neverConnected(command))));
  const refused = await offline('write_command', { command: 'SET', args: ['k', 'v'] });
  assert.match(refused.text, /Cannot connect to Redis at 127.0.0.1:6390: connection refused/);
  assert.equal(attempts, 1, 'a server that cannot be reached is not tried twice');
});

test('.env: a malformed or misspelled line stops the server instead of being ignored', async () => {
  assert.throws(() => parseEnvSource('REDIS_PASSWIRD=typo\n', '.env'), /unknown setting REDIS_PASSWIRD.*REDIS_PASSWORD/s);
  assert.throws(() => parseEnvSource('REDIS_PASSWORD: secret\n', '.env'), /not KEY=VALUE.*REDIS_PASSWORD: secret/s);
  assert.deepEqual(
    parseEnvSource('# comment\n\nREDIS_PASSWORD=from-file\nexport REDIS_HOST=10.0.0.1\nREDIS_PASSWORD="p#ss word"\n', '.env'),
    { REDIS_PASSWORD: 'p#ss word', REDIS_HOST: '10.0.0.1' },
  );

  const before = snapshotEnv();
  const dir = temporaryDirectory();
  try {
    delete process.env.REDIS_HOST;
    delete process.env.REDIS_PORT;
    process.env.REDIS_PASSWORD = 'from-environment';
    const file = writeEnvFile(path.join(dir, 'settings.env'), { REDIS_PASSWORD: 'from-file', REDIS_HOST: '10.0.0.1', REDIS_PORT: '6380', REDIS_DB: '3' });
    const config = loadConfig({ defaultEnvFile: file });
    // The environment wins over the file; everything else comes from it.
    assert.deepEqual([config.password, config.host, config.port, config.db, config.envFile], ['from-environment', '10.0.0.1', 6380, 3, file]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    restoreEnv(before);
  }
  assert.equal(loadConfig().port, target.port);
});

test('--env-file: the named file replaces <project>/.env, and the environment still outranks it', async () => {
  const dir = temporaryDirectory();
  try {
    const defaults = writeEnvFile(path.join(dir, 'default.env'), { REDIS_HOST: '10.9.9.9', REDIS_USER: 'from-default', REDIS_PASSWORD: 'default-secret' });
    const named = writeEnvFile(path.join(dir, 'named.env'), { REDIS_HOST: '127.0.0.1', REDIS_PORT: '6381', REDIS_USER: 'from-named', REDIS_MCP_READONLY: 'yes' });
    const before = snapshotEnv();
    try {
      for (const key of Object.keys(before)) delete process.env[key];

      assert.equal(loadConfig({ defaultEnvFile: defaults }).username, 'from-default');
      const config = loadConfig({ defaultEnvFile: defaults, envFile: named });
      assert.deepEqual(
        { host: config.host, port: config.port, user: config.username, password: config.password, readonly: config.readonly, envFile: config.envFile },
        { host: '127.0.0.1', port: 6381, user: 'from-named', password: undefined, readonly: true, envFile: named },
      );
      process.env.REDIS_PORT = '6382';
      assert.equal(loadConfig({ defaultEnvFile: defaults, envFile: named }).port, 6382);

      assert.equal(loadConfig({ defaultEnvFile: path.join(dir, 'absent.env') }).host, '127.0.0.1');
      assert.throws(
        () => loadConfig({ defaultEnvFile: defaults, envFile: path.join(dir, 'absent.env') }),
        (err) => err.message === `${path.join(dir, 'absent.env')} does not exist (it was named with --env-file)`,
      );
    } finally {
      restoreEnv(before);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--env-file on the command line supplies the whole connection', async () => {
  const dir = temporaryDirectory();
  const settings = { REDIS_HOST: target.host, REDIS_PORT: target.port, REDIS_USER: target.username ?? '', REDIS_PASSWORD: target.password ?? '', REDIS_MCP_READONLY: '1' };
  // No REDIS_* variable in the environment and no project .env: the connection can only come from this file.
  const file = writeEnvFile(path.join(dir, 'other-redis.env'), Object.fromEntries(Object.entries(settings).filter(([, value]) => value !== '')));
  try {
    const withoutRedis = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('REDIS_')));
    const server = await startServer({ args: ['--env-file', file], bareEnv: { ...withoutRedis, REDIS_MCP_TIMEOUT_MS: '2500' } });
    try {
      const callHere = callerFor(server.client);
      const { tools } = await server.client.listTools();
      assert.deepEqual(
        tools.map((tool) => tool.name),
        ['read_command', 'scan_keys'],
        'REDIS_MCP_READONLY from the file must apply',
      );
      const ping = await callHere('read_command', { command: 'PING' });
      assert.equal(ping.isError, false, ping.text);
      assert.equal(ping.json.result, 'PONG');
    } finally {
      await server.client.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an MCP client's `env` block alone carries the connection, and outranks <project>/.env", async () => {
  // Exactly what a client hands a stdio server configured with an `env` block: those variables
  // and nothing else in the environment (no PATH, no HOME).
  const server = await startServer({
    bareEnv: {
      REDIS_HOST: target.host,
      REDIS_PORT: String(target.port),
      ...(target.username ? { REDIS_USER: target.username } : {}),
      ...(target.password ? { REDIS_PASSWORD: target.password } : {}),
      REDIS_DB: String(SCRATCH),
      REDIS_MCP_READONLY: '0',
      REDIS_MCP_TIMEOUT_MS: '2500',
    },
  });
  try {
    const callHere = callerFor(server.client);
    await callHere('write_command', { command: 'SET', args: [K('env-block'), 'here'] });
    // Without a `db` argument the call lands in the database named by the environment.
    assert.equal((await callHere('read_command', { command: 'GET', args: [K('env-block')] })).json.result, 'here');
    assert.equal((await callHere('read_command', { command: 'GET', args: [K('env-block')], db: OTHER })).json.result, null);
  } finally {
    await server.client.close();
  }
});

test('--env-file: relative paths, a missing file and mistyped switches', async () => {
  const dir = temporaryDirectory();
  const run = (args, options = {}) =>
    spawnSync(process.execPath, [entry, ...args], {
      encoding: 'utf8',
      // Should the server ever get past a refusal below, it can only reach this test's own server.
      env: { ...process.env, REDIS_HOST: target.host, REDIS_PORT: String(target.port), REDIS_DB: String(SCRATCH), REDIS_MCP_READONLY: '0', REDIS_MCP_TIMEOUT_MS: '2500' },
      ...options,
    });
  try {
    const settings = writeEnvFile(path.join(dir, 'settings.env'), { REDIS_PASSWORD: target.password ?? '' });

    const inline = run(['--env-file=' + settings, '--check']);
    assert.equal(inline.status, 0, inline.stderr);
    assert.ok(inline.stdout.includes(`配置文件: ${settings}`), inline.stdout);

    // A relative path resolves against the working directory the client starts the server in
    // (which the OS may report through a symlink, hence the real path).
    const relative = run(['--env-file', 'settings.env', '--check'], { cwd: dir });
    assert.equal(relative.status, 0, relative.stderr);
    assert.ok(relative.stdout.includes(`配置文件: ${realpathSync(settings)}`), relative.stdout);

    // Node 24 itself refuses a missing --env-file file before the server even starts
    // ("node: …: not found", exit 9); older runtimes leave it to the server's own error.
    const missing = run(['--env-file', path.join(dir, 'nope.env'), '--check']);
    assert.notEqual(missing.status, 0);
    assert.ok(missing.stderr.includes(path.join(dir, 'nope.env')), missing.stderr);

    const broken = path.join(dir, 'broken.env');
    writeFileSync(broken, 'REDIS_PASSWORD: oops\n');
    const malformed = run(['--env-file', broken, '--check']);
    assert.equal(malformed.status, 1);
    assert.ok(malformed.stderr.includes(`[redis-mcp-server] ${broken}: this line is not KEY=VALUE`), malformed.stderr);

    for (const [args, expected] of [
      [['--env-file'], /--env-file needs a path|--env-file requires an argument/],
      [['--env-file', '--check'], /--env-file needs a path|--check: not found/],
      [['--env-fiel', settings, '--check'], /unknown option "--env-fiel"/],
      [['--env-file', settings, '--env-file', settings, '--check'], /may only be given once/],
    ]) {
      const refused = run(args);
      assert.notEqual(refused.status, 0, args.join(' '));
      assert.match(refused.stderr, expected, args.join(' '));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('read-only mode hides write_command', async () => {
  const readonly = await startServer({ env: { REDIS_MCP_READONLY: '1' } });
  try {
    const { tools } = await readonly.client.listTools();
    assert.deepEqual(
      tools.map((tool) => tool.name),
      ['read_command', 'scan_keys'],
    );
  } finally {
    await readonly.client.close();
  }
});

test('--check reports a healthy connection and explains the usual failures', async () => {
  const env = { ...process.env, REDIS_DB: String(SCRATCH), ...serverEnv };
  const healthy = spawnSync(process.execPath, [entry, '--check'], { env, encoding: 'utf8' });
  assert.equal(healthy.status, 0, healthy.stderr);
  assert.match(healthy.stdout, /已连接 Redis \d+\.\d+/);
  assert.match(healthy.stdout, /standalone \/ master/);
  assert.ok(healthy.stdout.includes(`默认数据库: ${SCRATCH}（现有`), healthy.stdout);
  assert.match(healthy.stdout, /等待上限: 2500 ms/);

  if (target.password) {
    const noPassword = spawnSync(process.execPath, [entry, '--check'], { env: { ...env, REDIS_PASSWORD: '' }, encoding: 'utf8' });
    assert.equal(noPassword.status, 1, noPassword.stdout);
    assert.match(noPassword.stderr, /连接失败: Redis requires a password .* Set REDIS_PASSWORD/s);

    const wrongPassword = spawnSync(process.execPath, [entry, '--check'], {
      env: { ...env, REDIS_PASSWORD: 'definitely-wrong' },
      encoding: 'utf8',
    });
    assert.equal(wrongPassword.status, 1);
    assert.match(wrongPassword.stderr, /连接失败: Redis rejected the credentials: WRONGPASS.*Check REDIS_USER and REDIS_PASSWORD/s);
  }

  const unreachable = spawnSync(process.execPath, [entry, '--check'], { env: { ...env, REDIS_PORT: '6399' }, encoding: 'utf8' });
  assert.equal(unreachable.status, 1);
  assert.match(unreachable.stderr, /连接失败: Cannot connect to Redis at 127.0.0.1:6399: connection refused\. Is the Redis server running\?/);
});

test('the server exits once the client closes its stdin', async () => {
  const extra = await startServer();
  const { pid } = extra.transport;
  await extra.client.close();
  const gone = await waitFor(() => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  });
  assert.ok(gone, 'server still running 5 s after the client closed');
});

test('SHUTDOWN, once confirmed, stops the server and says so', async () => {
  if (!DISPOSABLE) return { skipped: 'set E2E_DISPOSABLE_REDIS=yes on a throwaway instance to run it' };
  assert.equal((await call('write_command', { command: 'FLUSHDB', db: SCRATCH, confirm: true })).json.result, 'OK');
  assert.equal((await call('read_command', { command: 'DBSIZE', db: SCRATCH })).json.result, 0);
  const stopped = await call('write_command', { command: 'SHUTDOWN', db: SCRATCH, confirm: true });
  assert.equal(stopped.isError, false, stopped.text);
  assert.match(stopped.json.result, /Redis is shutting down: it closed the connection without a reply/);
  shutDown = true;
  await sleep(300);
  const after = await call('read_command', { command: 'PING', db: SCRATCH });
  assert.equal(after.isError, true);
  assert.match(after.text, /Cannot connect to Redis at .*: connection refused/);
  return 'the server under test was shut down';
});

let failed = 0;
const target = connectionOptions();
if (!['127.0.0.1', 'localhost', '::1'].includes(target.host) && process.env.E2E_ALLOW_REMOTE !== 'yes') {
  console.error(
    `Refusing to run: this test writes keys, and it is pointed at ${target.host}:${target.port}.\n` +
      'Point the REDIS_* settings at a disposable Redis, or set E2E_ALLOW_REMOTE=yes to accept the risk.',
  );
  process.exit(2);
}
/** The test's own connections: `admin` for killing and listing clients and for db 15, `side` for db 14. */
const own = (db) => {
  const connection = new Redis({ ...target, db, lazyConnect: true, maxRetriesPerRequest: 1 });
  connection.on('error', () => undefined);
  return connection;
};
admin = own(SCRATCH);
side = own(OTHER);
await admin.connect().catch((err) => {
  console.error(`Cannot reach Redis at ${target.host}:${target.port}: ${err.message}. Point the REDIS_* settings at a reachable server.`);
  process.exit(2);
});
main = await startServer();
call = callerFor(main.client);
ourConnections = async () => {
  const name = `redis-mcp-server:${main.transport.pid}`;
  return String(await admin.call('CLIENT', 'LIST'))
    .split('\n')
    .map((line) => Object.fromEntries(line.split(' ').map((field) => field.split('='))))
    .filter((client) => client.name === name);
};
try {
  console.log(`Scratch keys mcp:e2e:${process.pid}:* in databases ${SCRATCH} and ${OTHER} of ${target.host}:${target.port}\n`);
  for (const { name, fn } of tests) {
    try {
      const note = await fn();
      console.log(note?.skipped ? `  skip  ${name}  (${note.skipped})` : `  ok    ${name}${note ? `  (${note})` : ''}`);
    } catch (err) {
      failed++;
      console.log(`  FAIL  ${name}`);
      console.log(String(err.message).split('\n').map((line) => `        ${line}`).join('\n'));
      if ('actual' in err && 'expected' in err) console.log(`        actual: ${JSON.stringify(err.actual)}\n        expected: ${JSON.stringify(err.expected)}`);
    }
  }
} finally {
  await main.client.close().catch(() => undefined);
  // The keys this test created go, and nothing else: no FLUSH, so running against a real database costs nothing.
  if (!shutDown) {
    try {
      await cleanup();
    } catch (err) {
      console.error(`cleanup: ${err.message}`);
    }
  }
  side.disconnect();
  admin.disconnect();
}

async function cleanup() {
  for (const connection of [admin, side]) {
    let cursor = '0';
    do {
      const [next, keys] = await connection.scan(cursor, 'MATCH', `mcp:e2e:${process.pid}:*`, 'COUNT', '1000');
      cursor = next;
      if (keys.length) await connection.del(...keys);
    } while (cursor !== '0');
  }
}

console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed === 0 ? 0 : 1);
