// Drives the built server the way an MCP client does (stdio) against a real Nacos.
// Connection settings come from the usual NACOS_* variables (then <project>/.env). The test creates
// two namespaces of its own (mcp-e2e-<pid>*), works only inside them, and removes them at the end.

import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createServer as createNetServer} from 'node:net';
import {createHash} from 'node:crypto';
import {mkdtempSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {Api} from '../dist/api.js';
import {loadConfig, parseEnvSource} from '../dist/config.js';

const entry = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
const STAMP = `${process.pid}`;
const NS = `mcp-e2e-${STAMP}`;
const NS2 = `mcp-e2e-${STAMP}-copy`;
const serverEnv = { NACOS_MCP_READONLY: '0' };

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const md5 = (content) => createHash('md5').update(content, 'utf8').digest('hex');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Resolves the connection settings the way the server does: environment first, then <project>/.env, then defaults. */
function target() {
  const { address, username, password } = loadConfig();
  return { address, username, password };
}

async function waitFor(probe, timeoutMs = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await probe();
    if (value) return value;
    await sleep(100);
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

/** Some tests change NACOS_* variables in this process; these hand them back afterwards. */
function snapshotEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('NACOS_')));
}

function restoreEnv(snapshot) {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('NACOS_')) delete process.env[key];
  }
  for (const [key, value] of Object.entries(snapshot)) process.env[key] = value;
}

const temporaryDirectory = () => mkdtempSync(path.join(tmpdir(), 'nacos-mcp-e2e-'));

/** Writes a settings file in .env form. Values are double-quoted, which Node's parser understands. */
function writeEnvFile(file, settings) {
  const lines = Object.entries(settings)
    .filter(([, value]) => value !== '')
    .map(([key, value]) => `${key}=${JSON.stringify(String(value))}`);
  writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

const READ_TOOLS = [
  'config_history',
  'get_config',
  'list_configs',
  'list_namespaces',
  'list_services',
  'read_request',
  'describe_service',
].sort();
const WRITE_TOOLS = [
  'delete_config',
  'delete_namespace',
  'delete_service',
  'deregister_instance',
  'publish_config',
  'register_instance',
  'request',
  'save_namespace',
  'save_service',
  'update_instance',
];

let main;
let call;
let api;
let names = {};

test('initialize and tools/list', async () => {
  const { tools } = await main.client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [...READ_TOOLS, ...WRITE_TOOLS].sort());
  assert.match(main.client.getInstructions(), /publish_config/);
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  for (const name of READ_TOOLS) assert.equal(byName[name].annotations.readOnlyHint, true, name);
  assert.equal(byName.delete_config.annotations.destructiveHint, true);
  assert.equal(byName.delete_namespace.inputSchema.properties.confirm.default, false);
  assert.equal(byName.list_configs.inputSchema.properties.page_size.default, 50);
});

test('namespaces are resolved by id, by name, and "public" is the public namespace', async () => {
  const list = await call('list_namespaces');
  assert.equal(list.isError, false, list.text);
  assert.equal(list.json.namespaces[0].id, '');
  assert.equal(list.json.namespaces[0].name, 'public');
  const mine = list.json.namespaces.find((item) => item.id === NS);
  assert.deepEqual(mine, { id: NS, name: NS, description: 'made by the e2e test', config_count: 0 });

  const missing = await call('list_configs', { namespace: 'no-such-namespace' });
  assert.equal(missing.isError, true);
  assert.match(missing.text, new RegExp(`Namespace "no-such-namespace" does not exist\\. Known namespaces: .*${NS}`));
  // A configuration published into an unknown namespace would be stored where nothing can see it.
  const orphan = await call('publish_config', { data_id: 'x', content: 'x', namespace: 'no-such-namespace' });
  assert.match(orphan.text, /Namespace "no-such-namespace" does not exist/);
});

test('namespaces: create, update, and delete only when empty', async () => {
  const id = `${NS}-extra`;
  const created = await call('save_namespace', { id, name: 'e2e extra', description: 'first' });
  assert.deepEqual(created.json, { namespace: { id, name: 'e2e extra', description: 'first' }, created: true });

  // Same id again: an update, by id or by name alone.
  const renamed = await call('save_namespace', { id, name: 'e2e extra renamed', description: 'second' });
  assert.deepEqual(renamed.json, { namespace: { id, name: 'e2e extra renamed', description: 'second' }, created: false });
  const byName = await call('save_namespace', { name: 'e2e extra renamed' });
  assert.equal(byName.json.created, false);
  assert.equal(byName.json.namespace.id, id);
  assert.equal(byName.json.namespace.description, 'second', 'the description is kept when not given');
  assert.equal((await api.namespaces()).find((item) => item.id === id)?.name, 'e2e extra renamed');

  const generated = await call('save_namespace', { name: `${NS}-generated` });
  assert.equal(generated.json.created, true);
  assert.match(generated.json.namespace.id, /^[0-9a-f]{32}$/);
  names[generated.json.namespace.id] = generated.json.namespace.name;

  // The public namespace and unknown ones are out of reach.
  assert.match((await call('delete_namespace', { namespace: 'public', confirm: true })).text, /public namespace cannot be deleted/);
  assert.match((await call('delete_namespace', { namespace: 'no-such-namespace', confirm: true })).text, /does not exist/);

  // Deleting needs confirmation, and a namespace that holds something is refused even then.
  assert.match(
    (await call('delete_namespace', { namespace: id })).text,
    /Refused: deleting namespace "e2e extra renamed" cannot be undone/,
  );
  await call('publish_config', { data_id: 'orphan.yaml', group: 'g', namespace: id, content: 'x' });
  const full = await call('delete_namespace', { namespace: id, confirm: true });
  assert.match(full.text, /not empty: 1 configurations and 0 services\. Deleting it would leave the configurations stored but invisible/);
  assert.ok(
    (await api.namespaces()).some((item) => item.id === id),
    'the namespace must still exist',
  );
  await call('delete_config', { data_id: 'orphan.yaml', group: 'g', namespace: id, confirm: true });

  // Invalid ids never leave the server: the schema stops them.
  const badId = await call('save_namespace', { id: 'has spaces', name: 'never' });
  assert.equal(badId.isError, true);
  assert.equal(
    (await api.namespaces()).some((item) => item.name === 'never'),
    false,
  );

  assert.deepEqual((await call('delete_namespace', { namespace: 'e2e extra renamed', confirm: true })).json, {
    deleted: true,
    namespace: { id, name: 'e2e extra renamed' },
  });
  assert.equal(
    (await api.namespaces()).some((item) => item.id === id),
    false,
  );
  assert.deepEqual((await call('delete_namespace', { namespace: generated.json.namespace.id, confirm: true })).json.deleted, true);
});

test('services: create, inspect, update, and delete only when empty', async () => {
  const created = await call('save_service', {
    service: 'order-service',
    namespace: NS,
    protect_threshold: 0.5,
    metadata: { version: 'v1', owner: 'maozi' },
  });
  assert.equal(created.isError, false, created.text);
  assert.deepEqual(created.json, {
    namespace: NS,
    service: 'order-service',
    group: 'DEFAULT_GROUP',
    ephemeral: false,
    protect_threshold: 0.5,
    metadata: { version: 'v1', owner: 'maozi' },
    created: true,
    note: 'Nacos removes a service that has no instances after about a minute. Register an instance to keep it.',
  });

  const described = await call('describe_service', { service: 'order-service', namespace: NS });
  assert.equal(described.isError, false, described.text);
  assert.equal(described.json.ephemeral, false);
  assert.equal(described.json.protect_threshold, 0.5);
  assert.deepEqual(described.json.metadata, { version: 'v1', owner: 'maozi' });
  assert.deepEqual(described.json.clusters, []);
  assert.deepEqual(described.json.instances, []);
  assert.equal(described.json.subscriber_count, 0);

  // Fields that are left out keep their values.
  const updated = await call('save_service', { service: 'order-service', namespace: NS, protect_threshold: 0.9 });
  assert.equal(updated.json.created, false);
  assert.deepEqual(
    [updated.json.protect_threshold, updated.json.metadata, updated.json.ephemeral],
    [0.9, { version: 'v1', owner: 'maozi' }, false],
  );

  // The kind of a service is fixed at creation.
  const switched = await call('save_service', { service: 'order-service', namespace: NS, ephemeral: true });
  assert.match(switched.text, /is persistent; that cannot be changed/);
  const ephemeral = await call('save_service', { service: 'gateway', namespace: NS, group: 'INFRA', ephemeral: true });
  assert.equal(ephemeral.json.ephemeral, true);

  assert.match(
    (await call('delete_service', { service: 'order-service', namespace: NS })).text,
    /Refused: deleting service "order-service"/,
  );
  assert.deepEqual((await call('delete_service', { service: 'order-service', namespace: NS, confirm: true })).json, {
    deleted: true,
    service: 'order-service',
    group: 'DEFAULT_GROUP',
    namespace: NS,
  });
  assert.match((await call('describe_service', { service: 'order-service', namespace: NS })).text, /does not exist/);
  assert.match((await call('delete_service', { service: 'order-service', namespace: NS, confirm: true })).text, /does not exist/);
});

test('instances: register, update without losing the rest, disable, deregister', async () => {
  await call('save_service', { service: 'stock', group: 'BIZ', namespace: NS, ephemeral: false });
  const registered = await call('register_instance', {
    service: 'stock',
    group: 'BIZ',
    namespace: NS,
    ip: '10.0.0.1',
    port: 8080,
    metadata: { zone: 'a', rack: 'r1' },
  });
  assert.equal(registered.isError, false, registered.text);
  const first = registered.json;
  assert.equal(first.created_service, false);
  assert.equal(typeof first.visible_after_ms, 'number');
  assert.deepEqual(first.instance, {
    ip: '10.0.0.1',
    port: 8080,
    cluster: 'DEFAULT',
    weight: 1,
    healthy: true,
    enabled: true,
    ephemeral: false,
    metadata: { zone: 'a', rack: 'r1' },
  });
  assert.equal(first.note, undefined);

  const described = await call('describe_service', { service: 'stock', group: 'BIZ', namespace: NS });
  assert.deepEqual(
    described.json.clusters.map((cluster) => [cluster.name, cluster.health_check, cluster.check_port, cluster.use_instance_port_for_check]),
    [['DEFAULT', 'TCP', 80, true]],
  );
  assert.equal(described.json.instances.length, 1);

  // Nacos resets whatever an update leaves out; the tool fills that in from the current state.
  const weighed = await call('update_instance', { service: 'stock', group: 'BIZ', namespace: NS, ip: '10.0.0.1', port: 8080, weight: 0.5 });
  assert.equal(weighed.isError, false, weighed.text);
  assert.deepEqual(
    [weighed.json.visible, weighed.json.instance.weight, weighed.json.instance.metadata],
    [true, 0.5, { zone: 'a', rack: 'r1' }],
  );
  const tagged = await call('update_instance', {
    service: 'stock',
    group: 'BIZ',
    namespace: NS,
    ip: '10.0.0.1',
    port: 8080,
    metadata: { zone: 'b' },
  });
  assert.deepEqual([tagged.json.instance.metadata, tagged.json.instance.weight], [{ zone: 'b' }, 0.5]);

  // Disabled instances stay visible to the tool, although applications no longer get them.
  const disabled = await call('update_instance', {
    service: 'stock',
    group: 'BIZ',
    namespace: NS,
    ip: '10.0.0.1',
    port: 8080,
    enabled: false,
  });
  assert.equal(disabled.json.instance.enabled, false);
  const after = await call('describe_service', { service: 'stock', group: 'BIZ', namespace: NS });
  assert.deepEqual(
    after.json.instances.map((instance) => [instance.ip, instance.port, instance.enabled]),
    [['10.0.0.1', 8080, false]],
  );
  const enabled = await call('update_instance', {
    service: 'stock',
    group: 'BIZ',
    namespace: NS,
    ip: '10.0.0.1',
    port: 8080,
    enabled: true,
  });
  assert.equal(enabled.json.instance.enabled, true);

  const unknown = await call('update_instance', { service: 'stock', group: 'BIZ', namespace: NS, ip: '10.9.9.9', port: 1, weight: 3 });
  assert.match(
    unknown.text,
    /Instance 10\.9\.9\.9:1 is not registered with service "stock" in group "BIZ"\. Registered: 10\.0\.0\.1:8080\./,
  );

  assert.match(
    (await call('deregister_instance', { service: 'stock', group: 'BIZ', namespace: NS, ip: '10.9.9.9', port: 1 })).text,
    /is not registered/,
  );
  const gone = await call('deregister_instance', { service: 'stock', group: 'BIZ', namespace: NS, ip: '10.0.0.1', port: 8080 });
  assert.deepEqual(gone.json, {
    deregistered: true,
    service: 'stock',
    group: 'BIZ',
    namespace: NS,
    instance: { ip: '10.0.0.1', port: 8080 },
    gone: true,
  });
  assert.deepEqual((await call('describe_service', { service: 'stock', group: 'BIZ', namespace: NS })).json.instances, []);
  assert.match(
    (await call('deregister_instance', { service: 'stock', group: 'BIZ', namespace: NS, ip: '10.0.0.1', port: 8080 })).text,
    /is not registered/,
  );
  await call('delete_service', { service: 'stock', group: 'BIZ', namespace: NS, confirm: true });
});

test('instances: kinds must match, and the tool says when one will expire', async () => {
  // A service that does not exist yet is created the way applications register theirs.
  const made = await call('register_instance', { service: 'fresh', namespace: NS, ip: '10.0.0.7', port: 80 });
  assert.equal(made.json.created_service, true);
  assert.equal(made.json.instance.ephemeral, true);
  assert.match(made.json.note, /ephemeral: without heartbeats Nacos removes it after about 30 seconds/);

  const wrongKind = await call('register_instance', { service: 'fresh', namespace: NS, ip: '10.0.0.8', port: 80, ephemeral: false });
  assert.equal(wrongKind.isError, true, wrongKind.text);

  const persistent = await call('register_instance', {
    service: 'fixed',
    namespace: NS,
    ip: '10.0.0.9',
    port: 81,
    ephemeral: false,
    weight: 2,
    cluster: 'c2',
  });
  assert.equal(persistent.json.instance.ephemeral, false);
  assert.deepEqual([persistent.json.instance.cluster, persistent.json.instance.weight], ['c2', 2]);
  assert.equal(persistent.json.note, undefined);
  const clusters = (await call('describe_service', { service: 'fixed', namespace: NS })).json.clusters.map((cluster) => cluster.name);
  assert.deepEqual(clusters, ['c2']);

  // A service with instances cannot be deleted.
  const busy = await call('delete_service', { service: 'fixed', namespace: NS, confirm: true });
  assert.match(busy.text, /still has 1 instance\(s\) \(10\.0\.0\.9:81\)\. Deregister them first/);
  await call('deregister_instance', { service: 'fresh', namespace: NS, ip: '10.0.0.7', port: 80 });
  await call('deregister_instance', { service: 'fixed', namespace: NS, ip: '10.0.0.9', port: 81 });
  await call('delete_service', { service: 'fresh', namespace: NS, confirm: true });
  await call('delete_service', { service: 'fixed', namespace: NS, confirm: true });
});

test('list_services covers every group and filters by group and keyword', async () => {
  await call('save_service', { service: 'pay', group: 'BIZ', namespace: NS });
  await call('register_instance', { service: 'pay', group: 'BIZ', namespace: NS, ip: '10.1.1.1', port: 80, ephemeral: false });
  await call('save_service', { service: 'pay', group: 'DEFAULT_GROUP', namespace: NS });
  await call('register_instance', { service: 'pay', group: 'DEFAULT_GROUP', namespace: NS, ip: '10.1.1.2', port: 80, ephemeral: false });

  // The list is refreshed about once a second.
  const page = await waitFor(async () => {
    const reply = await call('list_services', { namespace: NS });
    return reply.json?.total === 2 ? reply : undefined;
  });
  assert.ok(page, 'both services should be listed');
  assert.deepEqual(
    page.json.services
      .map((service) => [
        service.name,
        service.group,
        service.clusters,
        service.instances,
        service.healthy_instances,
        service.protection_triggered,
      ])
      .sort(),
    [
      ['pay', 'BIZ', 1, 1, 1, false],
      ['pay', 'DEFAULT_GROUP', 1, 1, 1, false],
    ].sort(),
  );
  assert.equal(page.json.namespace, NS);

  const biz = await call('list_services', { namespace: NS, group: 'BIZ' });
  assert.deepEqual(
    biz.json.services.map((service) => service.group),
    ['BIZ'],
  );
  const none = await call('list_services', { namespace: NS, keyword: 'nothing-matches' });
  assert.deepEqual([none.json.total, none.json.services], [0, []]);
  const publicOnly = await call('list_services', {});
  assert.ok(Array.isArray(publicOnly.json.services));
});

test('configurations: publish, read, update guarded by md5, list, delete', async () => {
  const first = await call('publish_config', {
    data_id: 'app.yaml',
    group: 'mcp',
    namespace: NS,
    content: 'server:\n  port: 8080\n',
    type: 'yaml',
    description: 'the application',
    tags: ['core'],
  });
  assert.equal(first.isError, false, first.text);
  assert.deepEqual(first.json, {
    data_id: 'app.yaml',
    group: 'mcp',
    namespace: NS,
    type: 'yaml',
    md5: md5('server:\n  port: 8080\n'),
    created: true,
    readable_after_ms: first.json.readable_after_ms,
  });
  assert.equal(typeof first.json.readable_after_ms, 'number');

  const read = await call('get_config', { data_id: 'app.yaml', group: 'mcp', namespace: NS });
  assert.equal(read.isError, false, read.text);
  assert.equal(read.json.content, 'server:\n  port: 8080\n');
  assert.equal(read.json.md5, md5('server:\n  port: 8080\n'));
  assert.deepEqual(
    [read.json.type, read.json.data_id, read.json.group, read.json.namespace, read.json.description],
    ['yaml', 'app.yaml', 'mcp', NS, 'the application'],
  );
  assert.match(read.json.created_at, /^\d{4}-\d{2}-\d{2}T/);

  // An update with the md5 that was read goes through, and keeps the format when none is given.
  const second = await call('publish_config', {
    data_id: 'app.yaml',
    group: 'mcp',
    namespace: NS,
    content: 'server:\n  port: 8081\n',
    expected_md5: read.json.md5,
  });
  assert.equal(second.isError, false, second.text);
  assert.deepEqual([second.json.created, second.json.md5, second.json.type], [false, md5('server:\n  port: 8081\n'), 'yaml']);

  // The same md5 again is stale now: someone else may have changed the configuration in between.
  const stale = await call('publish_config', {
    data_id: 'app.yaml',
    group: 'mcp',
    namespace: NS,
    content: 'lost update',
    expected_md5: read.json.md5,
  });
  assert.equal(stale.isError, true);
  const secondVersion = 'server:\n  port: 8081\n';
  assert.match(
    stale.text,
    new RegExp(
      `has changed since it was read: its md5 is now ${md5(secondVersion)} \\(modified .+\\), not ${read.json.md5}\\. Read it again`,
    ),
  );
  assert.equal((await call('get_config', { data_id: 'app.yaml', group: 'mcp', namespace: NS })).json.content, 'server:\n  port: 8081\n');

  const forNew = await call('publish_config', {
    data_id: 'new.yaml',
    group: 'mcp',
    namespace: NS,
    content: 'x',
    expected_md5: read.json.md5,
  });
  assert.match(forNew.text, /expected_md5 was given, but configuration "new\.yaml" in group "mcp" does not exist/);

  const tooBig = await call('publish_config', { data_id: 'big', group: 'mcp', namespace: NS, content: 'x'.repeat(100_001) });
  assert.match(tooBig.text, /Nacos refuses configurations over about 100 KB/);

  // Listing never carries the content.
  const all = await call('list_configs', { namespace: NS });
  assert.deepEqual([all.json.total, all.json.pages, all.json.namespace], [1, 1, NS]);
  // Nacos's list does not carry tags; they are part of a configuration's detail (get_config).
  assert.deepEqual(Object.keys(all.json.configs[0]).sort(), ['data_id', 'group', 'id', 'type']);
  assert.deepEqual([all.json.configs[0].data_id, all.json.configs[0].group, all.json.configs[0].type], ['app.yaml', 'mcp', 'yaml']);
  const found = await call('list_configs', { namespace: NS, data_id: 'app' });
  assert.equal(found.json.total, 1);
  const byGroup = await call('list_configs', { namespace: NS, group: 'mcp', data_id: '*.yaml' });
  assert.equal(byGroup.json.total, 1);
  assert.equal((await call('list_configs', { namespace: NS, data_id: 'nothing' })).json.total, 0);

  assert.match(
    (await call('delete_config', { data_id: 'app.yaml', group: 'mcp', namespace: NS })).text,
    /Refused: deleting configuration "app\.yaml"/,
  );
  const deleted = await call('delete_config', { data_id: 'app.yaml', group: 'mcp', namespace: NS, confirm: true });
  assert.deepEqual(deleted.json, { deleted: true, data_id: 'app.yaml', group: 'mcp', namespace: NS, gone: true });
  assert.match(
    (await call('get_config', { data_id: 'app.yaml', group: 'mcp', namespace: NS })).text,
    /Configuration "app\.yaml" in group "mcp" of namespace .* does not exist\./,
  );
  // Nacos itself answers "true" for deleting what is not there; the tool does not pretend a deletion happened.
  assert.match((await call('delete_config', { data_id: 'app.yaml', group: 'mcp', namespace: NS, confirm: true })).text, /does not exist/);
});

test('config_history lists the replaced versions and marks the current one', async () => {
  const versions = ['first', 'second', 'third'];
  for (const [index, content] of versions.entries()) {
    await call('publish_config', { data_id: 'hist.txt', group: 'g', namespace: NS, content, type: 'text', description: `v${index}` });
    await sleep(700);
  }
  const history = await call('config_history', { data_id: 'hist.txt', group: 'g', namespace: NS });
  assert.equal(history.isError, false, history.text);
  // Nacos keeps a version from the moment it is replaced, so "third" itself is not among them yet.
  assert.deepEqual([history.json.total, history.json.current_md5, history.json.versions.length], [3, md5('third'), 3]);
  assert.deepEqual(
    history.json.versions.map((version) => [version.content, version.change, version.is_current]),
    [
      ['second', 'updated', false],
      ['first', 'updated', false],
      ['first', 'created', false],
    ],
  );
  const newest = history.json.versions[0];
  assert.deepEqual(Object.keys(newest).sort(), ['change', 'content', 'from', 'id', 'is_current', 'md5', 'replaced_at']);
  assert.equal(newest.md5, md5('second'));
  assert.match(newest.replaced_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(typeof newest.from, 'string');
  assert.ok(newest.from.length > 0, 'where the change came from is recorded');
  assert.match((await call('config_history', { data_id: 'nope', group: 'g', namespace: NS })).text, /does not exist/);
});

test('read_request reaches what the other tools do not cover', async () => {
  const metrics = await call('read_request', { path: 'v1/ns/operator/metrics' });
  assert.deepEqual([metrics.json.status, metrics.json.body], [200, { status: 'UP' }]);

  // The context path may be part of the path, and so may a query string.
  const prefixed = await call('read_request', { path: '/nacos/v1/ns/operator/metrics' });
  assert.deepEqual(prefixed.json.body, { status: 'UP' });
  const switches = await call('read_request', { path: 'v1/ns/operator/switches', query: { all: 'true' } });
  assert.equal(typeof switches.json.body.defaultCacheMillis, 'number');
  const state = await call('read_request', { path: 'v1/console/server/state' });
  assert.equal(state.json.body.version, '2.4.2');
  const nodes = await call('read_request', { path: 'v1/core/cluster/nodes' });
  assert.ok(Array.isArray(nodes.json.body.data) && nodes.json.body.data.length >= 1);

  // Binary answers, such as an export, come back as base64.
  await call('publish_config', { data_id: 'exported.txt', group: 'g', namespace: NS, content: 'to be exported', type: 'text' });
  const exported = await call('read_request', {
    path: 'v1/cs/configs',
    query: { export: 'true', tenant: NS, group: 'g', appName: '', dataId: '', ids: '' },
  });
  assert.equal(exported.isError, false, exported.text);
  assert.equal(exported.json.status, 200);
  assert.equal(typeof exported.json.body.base64, 'string');
  assert.equal(exported.json.body.bytes, Buffer.from(exported.json.body.base64, 'base64').length);
  assert.match(exported.json.body.content_type, /^application\/octet-stream/);
  names.exportZip = exported.json.body.base64;

  // Mistakes are named.
  assert.match((await call('read_request', { path: 'v1/no/such' })).text, /Nacos has no API at "v1\/no\/such"/);
  assert.match((await call('read_request', { path: 'nope' })).text, /is not an API path: paths start with v1\/ or v2\//);
  const missing = await call('read_request', { path: 'v1/console/namespaces', query: { namespaceId: '' } });
  assert.equal(missing.isError, false, 'a GET with extra parameters is harmless');
  const error = await call('read_request', { path: 'v1/cs/history', query: { dataId: 'x' } });
  assert.equal(error.isError, true);
  assert.match(error.text, /Nacos answered HTTP 500: Required request parameter/);
});

test('request sends the other methods, and asks before anything destructive', async () => {
  const refuse = async (args, expected) => {
    const reply = await call('request', args);
    assert.equal(reply.isError, true, JSON.stringify(args));
    assert.match(reply.text, expected);
  };
  await refuse({ method: 'DELETE', path: 'v1/console/namespaces', query: { namespaceId: NS2 } }, /Refused: this request deletes something/);
  await refuse(
    { method: 'POST', path: 'v1/auth/roles', body: { role: 'x', username: 'y' } },
    /Refused: this request changes who may log in to Nacos/,
  );
  await refuse({ method: 'POST', path: 'v1/cs/configs?clone=true&tenant=x&policy=OVERWRITE', body: [] }, /copies configurations in bulk/);
  await refuse({ method: 'POST', path: 'v1/core/cluster/server/leave' }, /tells this Nacos node to leave the cluster/);
  await refuse(
    { method: 'GET', path: 'v1/nothing', query: { a: [] } },
    /Query parameter "a" must be a string, a number or a boolean, not an array/,
  );

  // A form body, as Nacos takes it for almost everything.
  const registered = await call('request', {
    method: 'POST',
    path: 'v1/ns/instance',
    body: { serviceName: 'raw', ip: '10.6.6.6', port: '8080', namespaceId: NS, ephemeral: 'false' },
  });
  assert.deepEqual(registered.json, { status: 200, body: 'ok' });
  // Nacos needs a moment before a new instance shows up.
  const seen = await waitFor(async () =>
    (await call('describe_service', { service: 'raw', namespace: NS })).json?.instances.length === 1 ? true : undefined,
  );
  assert.equal(seen, true, 'the instance registered through request should be visible');
  const removed = await call('request', {
    method: 'DELETE',
    path: 'v1/ns/instance',
    query: { serviceName: 'raw', ip: '10.6.6.6', port: '8080', namespaceId: NS, ephemeral: 'false' },
    confirm: true,
  });
  assert.equal(removed.json.body, 'ok');

  // Cloning copies configurations into the second namespace: a JSON body that names each configuration
  // by its id as Nacos knows it, and bulk work that needs confirmation.
  const source = (await call('list_configs', { namespace: NS })).json.configs.find((config) => config.data_id === 'exported.txt');
  assert.match(source.id, /^\d+$/);
  await refuse(
    {
      method: 'POST',
      path: 'v1/cs/configs',
      query: { clone: 'true', tenant: NS2, policy: 'OVERWRITE' },
      body: [{ cfgId: source.id, dataId: 'exported.txt', group: 'g' }],
    },
    /copies configurations in bulk/,
  );
  const clone = await call('request', {
    method: 'POST',
    path: 'v1/cs/configs',
    query: { clone: 'true', tenant: NS2, policy: 'OVERWRITE' },
    body: [{ cfgId: source.id, dataId: 'exported.txt', group: 'g' }],
    body_type: 'json',
    confirm: true,
  });
  assert.equal(clone.isError, false, clone.text);
  const copied = await call('get_config', { data_id: 'exported.txt', group: 'g', namespace: NS2 });
  assert.equal(copied.isError, false, copied.text);
  assert.equal(copied.json.content, 'to be exported');

  // A multipart upload: the export read earlier goes back in through an import.
  const imported = await call('request', {
    method: 'POST',
    path: 'v1/cs/configs',
    query: { import: 'true', policy: 'SKIP', tenant: NS2, group: 'g', namespace: NS2 },
    body: { file: { base64: names.exportZip, filename: 'export.zip' } },
    body_type: 'multipart',
    confirm: true,
  });
  assert.equal(imported.isError, false, imported.text);
  // The export holds both configurations of the group: one is already there (cloned) and skipped, the other is imported.
  assert.deepEqual(
    [imported.json.status, imported.json.body.code, imported.json.body.data.skipCount, imported.json.body.data.succCount],
    [200, 200, 1, 1],
  );
  assert.equal((await call('get_config', { data_id: 'exported.txt', group: 'g', namespace: NS2 })).json.content, 'to be exported');
  assert.equal((await call('get_config', { data_id: 'hist.txt', group: 'g', namespace: NS2 })).json.content, 'third');

  // Bodies that cannot be sent, and answers that are not JSON.
  await refuse({ method: 'POST', path: 'v1/ns/instance', body: [1, 2] }, /A form body must be an object, got an array/);
  const text = await call('request', {
    method: 'POST',
    path: 'v1/ns/instance',
    body: 'serviceName=raw&ip=10.0.0.1&port=1',
    body_type: 'text',
  });
  // Nacos does not read a text/plain body as parameters, which is what this is meant to show.
  assert.match(text.text, /Nacos answered HTTP 400: Param 'serviceName' is required/);
  const notJson = await call('request', { method: 'POST', path: 'v1/console/namespaces', body: 'x', body_type: 'text' });
  assert.match(notJson.text, /Nacos answered HTTP 500: Required request parameter/);
});

test('credentials: when the server wants a login, it is done once and reused', async () => {
  const state = (await call('read_request', { path: 'v1/console/server/state' })).json.body;
  const authEnabled = String(state.auth_enabled) === 'true';
  assert.equal(authEnabled, Boolean(target().username), 'the test server with credentials is expected to have authentication on');
  const users = await call('read_request', { path: 'v1/auth/users', query: { search: 'blur', username: '', pageNo: 1, pageSize: 10 } });
  if (authEnabled) {
    assert.equal(users.isError, false, users.text);
    assert.ok(users.json.body.pageItems.length >= 1);
    // Nacos hands out password hashes with its user list; they are of no use to a model.
    assert.ok(users.json.body.pageItems.every((user) => user.password === '[redacted]'));
  } else {
    // Without authentication the user list is open as well.
    assert.equal(users.isError, false, users.text);
    assert.ok(Array.isArray(users.json.body.pageItems));
  }
});

test('.env: a malformed or misspelled line stops the server instead of being ignored', async () => {
  assert.throws(() => parseEnvSource('NACOS_PASSWIRD=typo\n', '.env'), /unknown setting NACOS_PASSWIRD.*NACOS_PASSWORD/s);
  assert.throws(() => parseEnvSource('NACOS_PASSWORD: secret\n', '.env'), /not KEY=VALUE.*NACOS_PASSWORD: secret/s);
  assert.deepEqual(
    parseEnvSource('# comment\n\nNACOS_PASSWORD=from-file\nNACOS_ADDRESS=http://10.0.0.1:8848/\nNACOS_PASSWORD="p#ss word"\n', '.env'),
    { NACOS_PASSWORD: 'p#ss word', NACOS_ADDRESS: 'http://10.0.0.1:8848/' },
  );

  const before = snapshotEnv();
  const dir = temporaryDirectory();
  try {
    delete process.env.NACOS_ADDRESS;
    delete process.env.NACOS_USERNAME;
    process.env.NACOS_PASSWORD = 'from-environment';
    const file = writeEnvFile(path.join(dir, 'settings.env'), {
      NACOS_PASSWORD: 'from-file',
      NACOS_ADDRESS: 'http://10.0.0.1:8848',
      NACOS_USERNAME: 'nacos',
    });
    const config = loadConfig({ defaultEnvFile: file });
    // The environment wins over the file; everything else comes from it.
    assert.deepEqual(
      [config.password, config.address, config.username, config.envFile],
      ['from-environment', 'http://10.0.0.1:8848', 'nacos', file],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    restoreEnv(before);
  }
});

test('the address is normalised and validated', async () => {
  const before = snapshotEnv();
  const dir = temporaryDirectory();
  const configFor = (address) => {
    const file = writeEnvFile(path.join(dir, 'address.env'), { NACOS_ADDRESS: address });
    return loadConfig({ envFile: file });
  };
  try {
    for (const key of Object.keys(before)) delete process.env[key];
    const expected = [
      ['127.0.0.1:8848/nacos', 'http://127.0.0.1:8848/nacos'],
      ['http://127.0.0.1:8848/nacos/', 'http://127.0.0.1:8848/nacos'],
      ['nacos.example.com', 'http://nacos.example.com'],
      ['https://nacos.example.com:443/prod/', 'https://nacos.example.com/prod'],
      ['http://[::1]:8848/nacos', 'http://[::1]:8848/nacos'],
    ];
    for (const [given, address] of expected) assert.equal(configFor(given).address, address, given);
    assert.equal(loadConfig({ envFile: undefined, defaultEnvFile: path.join(dir, 'absent.env') }).address, 'http://127.0.0.1:8848/nacos');
    assert.throws(() => configFor('ftp://x'), /NACOS_ADDRESS must start with http:\/\/ or https:\/\//);
    assert.throws(() => configFor('http://host:8848/nacos?x=1'), /without a query string/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    restoreEnv(before);
  }
});

test('--env-file: the named file replaces <project>/.env, and the environment still outranks it', async () => {
  const dir = temporaryDirectory();
  try {
    const defaults = writeEnvFile(path.join(dir, 'default.env'), {
      NACOS_ADDRESS: 'http://10.9.9.9:8848/nacos',
      NACOS_USERNAME: 'from-default',
      NACOS_PASSWORD: 'default-secret',
    });
    const named = writeEnvFile(path.join(dir, 'named.env'), {
      NACOS_ADDRESS: 'http://127.0.0.1:8848',
      NACOS_PASSWORD: 'from-named',
      NACOS_MCP_READONLY: 'yes',
    });
    const before = snapshotEnv();
    try {
      for (const key of Object.keys(before)) delete process.env[key];

      assert.equal(loadConfig({ defaultEnvFile: defaults }).username, 'from-default');
      const config = loadConfig({ defaultEnvFile: defaults, envFile: named });
      assert.deepEqual(
        {
          address: config.address,
          username: config.username,
          password: config.password,
          readonly: config.readonly,
          envFile: config.envFile,
        },
        { address: 'http://127.0.0.1:8848', username: undefined, password: 'from-named', readonly: true, envFile: named },
      );
      process.env.NACOS_PASSWORD = 'from-environment';
      assert.equal(loadConfig({ defaultEnvFile: defaults, envFile: named }).password, 'from-environment');

      assert.equal(loadConfig({ defaultEnvFile: path.join(dir, 'absent.env') }).address, 'http://127.0.0.1:8848/nacos');
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
  // No NACOS_* variable in the environment and no project .env: the connection can only come from this file.
  const file = writeEnvFile(path.join(dir, 'other-nacos.env'), {
    NACOS_ADDRESS: target().address,
    NACOS_USERNAME: target().username ?? '',
    NACOS_PASSWORD: target().password ?? '',
    NACOS_MCP_READONLY: '1',
  });
  try {
    const withoutNacos = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('NACOS_')));
    const server = await startServer({ args: ['--env-file', file], bareEnv: withoutNacos });
    try {
      const callHere = callerFor(server.client);
      const { tools } = await server.client.listTools();
      assert.deepEqual(tools.map((tool) => tool.name).sort(), READ_TOOLS, 'NACOS_MCP_READONLY from the file must apply');
      const namespaces = await callHere('list_namespaces');
      assert.equal(namespaces.isError, false, namespaces.text);
      assert.ok(namespaces.json.namespaces.some((item) => item.id === NS));
    } finally {
      await server.client.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an MCP client's `env` block alone carries the connection", async () => {
  // Exactly what a client hands a stdio server configured with an `env` block: those variables and nothing else.
  const server = await startServer({
    bareEnv: {
      NACOS_ADDRESS: target().address,
      ...(target().username ? { NACOS_USERNAME: target().username } : {}),
      ...(target().password ? { NACOS_PASSWORD: target().password } : {}),
      NACOS_MCP_READONLY: '0',
    },
  });
  try {
    const namespaces = await callerFor(server.client)('list_namespaces');
    assert.equal(namespaces.isError, false, namespaces.text);
    assert.ok(namespaces.json.namespaces.some((item) => item.id === NS));
  } finally {
    await server.client.close();
  }
});

test('--env-file: relative paths, a missing file and mistyped switches', async () => {
  const dir = temporaryDirectory();
  const base = {
    NACOS_ADDRESS: target().address,
    ...(target().username ? { NACOS_USERNAME: target().username, NACOS_PASSWORD: target().password } : {}),
    NACOS_MCP_READONLY: '0',
  };
  const run = (args, options = {}) =>
    spawnSync(process.execPath, [entry, ...args], { encoding: 'utf8', env: { ...process.env, ...base }, ...options });
  try {
    const settings = writeEnvFile(path.join(dir, 'settings.env'), { NACOS_PASSWORD: target().password ?? '' });

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
    writeFileSync(broken, 'NACOS_PASSWORD: oops\n');
    const malformed = run(['--env-file', broken, '--check']);
    assert.equal(malformed.status, 1);
    assert.ok(malformed.stderr.includes(`[nacos-mcp-server] ${broken}: this line is not KEY=VALUE`), malformed.stderr);

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

test('read-only mode hides the tools that change anything', async () => {
  const readonly = await startServer({ env: { NACOS_MCP_READONLY: '1' } });
  try {
    const { tools } = await readonly.client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), READ_TOOLS);
  } finally {
    await readonly.client.close();
  }
});

test('--check reports a healthy connection and explains the usual failures', async () => {
  const env = { ...process.env, ...serverEnv };
  const healthy = spawnSync(process.execPath, [entry, '--check'], { env, encoding: 'utf8' });
  assert.equal(healthy.status, 0, healthy.stderr);
  assert.match(healthy.stdout, /已连接 Nacos 2\.\d+\.\d+  http:\/\/127\.0\.0\.1:\d+\/nacos/);
  assert.match(healthy.stdout, new RegExp(`命名空间 \\(\\d+\\): public, .*${NS}`));
  assert.match(healthy.stdout, /写操作: 已启用/);
  assert.match(healthy.stdout, /单次请求超时: 15000 ms/);

  const bare = (extra) => {
    const kept = Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('NACOS_')));
    return { ...kept, NACOS_ADDRESS: target().address, NACOS_MCP_READONLY: '0', ...extra };
  };
  const url = new URL(target().address);
  // A port that was free a moment ago: the HTTP client refuses some ports (such as 1) before even trying to connect.
  const closedPort = await new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
  const unreachable = spawnSync(process.execPath, [entry, '--check'], {
    env: bare({ NACOS_ADDRESS: `http://127.0.0.1:${closedPort}/nacos` }),
    encoding: 'utf8',
  });
  assert.equal(unreachable.status, 1);
  assert.match(
    unreachable.stderr,
    /连接失败: Cannot reach Nacos at http:\/\/127\.0\.0\.1:\d+\/nacos: connection refused\. Is Nacos running, and is NACOS_ADDRESS right\?/,
  );

  // Without the context path every call lands outside the API.
  const noContext = spawnSync(process.execPath, [entry, '--check'], {
    env: bare({ NACOS_ADDRESS: `http://${url.host}` }),
    encoding: 'utf8',
  });
  assert.equal(noContext.status, 1, noContext.stdout);
  assert.match(
    noContext.stderr,
    /Nacos has no API at "v1\/console\/server\/state" for this path: HTTP 404\. If this API should exist, NACOS_ADDRESS is probably missing the context path, which usually is "\/nacos"\./,
  );
  assert.ok(noContext.stderr.length < 500, 'an HTML error page must not be dumped into the message');

  const noPassword = spawnSync(process.execPath, [entry, '--check'], {
    env: bare({ NACOS_USERNAME: target().username ?? '', NACOS_PASSWORD: '' }),
    encoding: 'utf8',
  });
  if (target().username) {
    assert.equal(noPassword.status, 1);
    assert.match(noPassword.stderr, /Nacos rejected the login of user ".*": user not found.*Check NACOS_USERNAME and NACOS_PASSWORD/s);
    const unknownUser = spawnSync(process.execPath, [entry, '--check'], {
      env: bare({ NACOS_USERNAME: 'no-such-user', NACOS_PASSWORD: 'x' }),
      encoding: 'utf8',
    });
    assert.match(unknownUser.stderr, /Nacos rejected the login of user "no-such-user": User no-such-user not found/s);
  } else {
    assert.equal(noPassword.status, 0, noPassword.stderr);
    assert.match(noPassword.stdout, /未开启鉴权/);
    // Credentials against a server that needs none are refused as clearly as wrong ones.
    const needless = spawnSync(process.execPath, [entry, '--check'], {
      env: bare({ NACOS_USERNAME: 'nacos', NACOS_PASSWORD: 'nacos' }),
      encoding: 'utf8',
    });
    assert.equal(needless.status, 1);
    assert.match(needless.stderr, /Nacos rejected the login of user "nacos".*leave both empty for a server without authentication/s);
  }
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
  assert.ok(gone, 'server still running 8 s after the client closed');
});

let failed = 0;
const connection = target();
if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(new URL(connection.address).hostname) && process.env.E2E_ALLOW_REMOTE !== 'yes') {
  console.error(
    `Refusing to run: this test creates namespaces, and it is pointed at ${connection.address}.\n` +
      'Point the NACOS_* settings at a disposable Nacos, or set E2E_ALLOW_REMOTE=yes to accept the risk.',
  );
  process.exit(2);
}
api = new Api({ ...connection, timeoutMs: 15_000, readonly: false });
for (const [id, name] of [
  [NS, NS],
  [NS2, NS2],
]) {
  await api.createNamespace(id, name, 'made by the e2e test');
}
main = await startServer();
call = callerFor(main.client);
try {
  console.log(`Scratch namespaces ${NS} and ${NS2} on ${connection.address}\n`);
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`  ok    ${name}`);
    } catch (err) {
      failed++;
      console.log(`  FAIL  ${name}`);
      console.log(
        String(err.message)
          .split('\n')
          .map((line) => `        ${line}`)
          .join('\n'),
      );
      if ('actual' in err && 'expected' in err)
        console.log(`        actual: ${JSON.stringify(err.actual)}\n        expected: ${JSON.stringify(err.expected)}`);
    }
  }
} finally {
  await main.client.close().catch(() => undefined);
  // Only what this test created goes: its two namespaces, emptied first so that Nacos lets them go.
  try {
    for (const id of [NS, NS2, ...Object.keys(names)]) {
      for (const page of [1, 2, 3, 4, 5]) {
        const { configs } = await api.configs(id, undefined, undefined, page, 200);
        for (const config of configs) await api.deleteConfig(config.dataId, config.group, id);
        if (configs.length < 200) break;
      }
      const { services } = await api.services(id, undefined, undefined, 1, 500);
      for (const service of services) {
        for (const instance of await api.instances(service.name, service.group, id)) {
          await api.deregisterInstance(service.name, service.group, id, instance).catch(() => undefined);
        }
        await api.deleteService(service.name, service.group, id).catch(() => undefined);
      }
      await api.deleteNamespace(id);
    }
  } catch (err) {
    console.error(`cleanup: ${err.message}`);
  }
  const left = (await api.namespaces().catch(() => [])).filter((item) => item.id.startsWith('mcp-e2e-'));
  console.log(left.length ? `left behind on the server: ${left.map((item) => item.id).join(', ')}` : 'scratch namespaces removed');
}

console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed === 0 ? 0 : 1);
