// The same server against a Nacos on its embedded Derby store. Nacos itself cannot list namespaces
// there (its SQL is not valid on Derby), so this checks what still works: the public namespace.
// Run only against a throwaway server, giving its address: NACOS_DERBY_ADDRESS=http://127.0.0.1:18850/nacos
// It writes one configuration (mcp-e2e-derby-<pid>.txt) into the public namespace and removes it.

import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

const entry = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
const address = process.env.NACOS_DERBY_ADDRESS;
if (!address) {
  console.log('NACOS_DERBY_ADDRESS is not set: nothing to do.');
  process.exit(0);
}
if (!/\/\/(127\.0\.0\.1|localhost|\[::1\])[:/]/.test(address)) {
  console.error(`Refusing to run against ${address}: this test writes a configuration. Use a throwaway server.`);
  process.exit(2);
}

const dataId = `mcp-e2e-derby-${process.pid}.txt`;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const base = { NACOS_ADDRESS: address, NACOS_MCP_READONLY: '0' };
const notDerby = /embedded Derby store/;

async function startServer() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    env: { ...process.env, ...base },
    stderr: 'inherit',
  });
  const client = new Client({ name: 'derby-test', version: '1.0.0' });
  await client.connect(transport);
  return { client, call: callerFor(client) };
}

function callerFor(client) {
  return async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const text = result.content.map((part) => (part.type === 'text' ? part.text : '')).join('\n');
    return result.isError ? { isError: true, text } : { isError: false, text, json: JSON.parse(text) };
  };
}

let main;
let call;

test('--check connects and warns about the store', async () => {
  const healthy = spawnSync(process.execPath, [entry, '--check'], { env: { ...process.env, ...base }, encoding: 'utf8' });
  assert.equal(healthy.status, 0, healthy.stderr);
  assert.match(healthy.stdout, /✔ 已连接 Nacos/);
  assert.match(healthy.stdout, /命名空间 \(0\): （该服务器无法列出）/);
  assert.match(healthy.stdout, /⚠ 该 Nacos 使用内嵌 Derby 存储.*只能操作 public 命名空间/);
});

test('what needs the namespace list says why it cannot work', async () => {
  const listed = await call('list_namespaces');
  assert.equal(listed.isError, true);
  assert.match(
    listed.text,
    /Nacos could not list its namespaces: it runs on its embedded Derby store.*Only the public namespace can be used/s,
  );
  for (const [name, args] of [
    ['list_configs', { namespace: 'some-namespace' }],
    ['list_services', { namespace: 'some-namespace' }],
    ['publish_config', { data_id: 'x', content: 'x', namespace: 'some-namespace' }],
  ]) {
    const reply = await call(name, args);
    assert.equal(reply.isError, true, name);
    assert.match(reply.text, notDerby, name);
  }
});

test('the public namespace works as usual', async () => {
  const published = await call('publish_config', { data_id: dataId, group: 'DEFAULT_GROUP', content: 'written on Derby', type: 'text' });
  assert.equal(published.isError, false, published.text);
  assert.equal(published.json.namespace, 'public');
  const read = await call('get_config', { data_id: dataId });
  assert.equal(read.json.content, 'written on Derby');
  const listed = await call('list_configs', {});
  assert.ok(listed.json.configs.some((config) => config.data_id === dataId));
  const services = await call('list_services', {});
  assert.equal(services.isError, false, services.text);
  const metrics = await call('read_request', { path: 'v1/ns/operator/metrics' });
  assert.deepEqual(metrics.json.body, { status: 'UP' });
});

test('cleanup', async () => {
  const deleted = await call('delete_config', { data_id: dataId, confirm: true });
  assert.equal(deleted.isError, false, deleted.text);
  assert.equal(deleted.json.deleted, true);
});

let failed = 0;
main = await startServer();
call = main.call;
try {
  console.log(`Embedded-store server ${address}\n`);
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
    }
  }
} finally {
  await main.client.close().catch(() => undefined);
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed === 0 ? 0 : 1);
