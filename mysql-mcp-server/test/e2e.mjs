// Drives the built server the way an MCP client does (stdio) against a real MySQL.
// Connection settings come from the usual MYSQL_* variables. The test only touches scratch
// databases it creates itself (_mcp_e2e_<pid>*), so it needs an account that may create
// databases; point MYSQL_* at a disposable instance anyway.

import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {createConnection} from 'mysql2/promise';
import {loadConfig, parseEnvSource} from '../dist/config.js';
import {readRows} from '../dist/db.js';
import {classify} from '../dist/sql-guard.js';

const entry = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
const SCRATCH = `_mcp_e2e_${process.pid}`;
/** Second scratch database, created and dropped through the tools under test. */
const EXTRA = `${SCRATCH}_extra`;
/** Backtick-quoted `scratch.table`, safe to embed in SQL text. */
const T = (table) => `\`${SCRATCH}\`.\`${table}\``;
const serverEnv = { MYSQL_MCP_READONLY: '0', MYSQL_MCP_QUERY_TIMEOUT_MS: '1500' };

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/** Same resolution as the server itself: environment first, then <project>/.env, then defaults. */
function connectionOptions() {
  const { host, port, user, password } = loadConfig();
  return { host, port, user, password };
}

/**
 * Starts the server over stdio. `env` is layered over the environment the tests normally use;
 * `bareEnv` replaces that environment wholesale, to prove nothing comes from anywhere else.
 */
async function startServer({ args = [], env = {}, bareEnv } = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry, ...args],
    // Unless overridden, the server connects inside the scratch database, so that this test's
    // connections can be told apart from any other (and killed) by that.
    env: bareEnv ?? { ...process.env, MYSQL_DATABASE: SCRATCH, ...serverEnv, ...env },
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

let main;
let call;

test('initialize and tools/list', async () => {
  const { tools } = await main.client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name), [
    'list_databases',
    'list_tables',
    'describe_table',
    'read_query',
    'write_query',
  ]);
  assert.match(main.client.getInstructions(), /describe_table/);
  const read = tools.find((tool) => tool.name === 'read_query');
  assert.equal(read.annotations.readOnlyHint, true);
  assert.equal(read.inputSchema.properties.limit.default, 100);
  const write = tools.find((tool) => tool.name === 'write_query');
  assert.equal(write.annotations.destructiveHint, true);
  assert.equal(write.inputSchema.properties.confirm.default, false);
});

test('list_databases hides system databases unless asked', async () => {
  const { json } = await call('list_databases');
  assert.ok(json.databases.some((db) => db.name === SCRATCH));
  assert.ok(!json.databases.some((db) => ['mysql', 'information_schema', 'sys', 'performance_schema'].includes(db.name)));
  assert.ok(json.databases.every((db) => typeof db.tables === 'number' && typeof db.size_mb === 'number'));
  const all = await call('list_databases', { include_system: true });
  assert.ok(all.json.databases.some((db) => db.name === 'mysql'));
});

test('write_query: CREATE TABLE, then list_tables and describe_table see it', async () => {
  const created = await call('write_query', {
    sql: `CREATE TABLE ${T('customers')} (
      id INT PRIMARY KEY AUTO_INCREMENT,
      name VARCHAR(50) NOT NULL,
      email VARCHAR(100) NOT NULL,
      balance DECIMAL(10,2) NOT NULL DEFAULT 0,
      big BIGINT UNSIGNED NULL,
      created_at DATETIME NULL,
      profile JSON NULL,
      region_id TINYINT NULL,
      parent_id INT NULL,
      UNIQUE KEY uniq_email (email),
      KEY idx_region_name (region_id, name(10)),
      CONSTRAINT fk_parent FOREIGN KEY (parent_id) REFERENCES ${T('customers')} (id)
    ) COMMENT = 'e2e customers'`,
  });
  assert.equal(created.isError, false, created.text);
  assert.deepEqual(Object.keys(created.json), ['affected_rows', 'elapsed_ms']);

  const tables = await call('list_tables', { database: SCRATCH });
  assert.deepEqual(tables.json.tables, [
    { name: 'customers', type: 'BASE TABLE', approx_rows: 0, engine: 'InnoDB', comment: 'e2e customers' },
  ]);
  // Without the argument the configured default database is used.
  assert.equal((await call('list_tables')).json.count, 1);

  const { json } = await call('describe_table', { database: SCRATCH, table: 'customers' });
  assert.equal(json.type, 'BASE TABLE');
  assert.equal(json.engine, 'InnoDB');
  assert.equal(json.comment, 'e2e customers');
  assert.deepEqual(
    json.columns.map((column) => [column.name, column.type, column.nullable, column.key ?? '', column.default ?? '', column.extra ?? '']),
    [
      ['id', 'int', false, 'PRI', '', 'auto_increment'],
      ['name', 'varchar(50)', false, '', '', ''],
      ['email', 'varchar(100)', false, 'UNI', '', ''],
      ['balance', 'decimal(10,2)', false, '', '0.00', ''],
      ['big', 'bigint unsigned', true, '', '', ''],
      ['created_at', 'datetime', true, '', '', ''],
      ['profile', 'json', true, '', '', ''],
      ['region_id', 'tinyint', true, 'MUL', '', ''],
      ['parent_id', 'int', true, 'MUL', '', ''],
    ],
  );
  // Unique indexes first, then the rest alphabetically.
  assert.deepEqual(json.indexes, [
    { name: 'PRIMARY', unique: true, columns: ['id'] },
    { name: 'uniq_email', unique: true, columns: ['email'] },
    { name: 'fk_parent', unique: false, columns: ['parent_id'] },
    { name: 'idx_region_name', unique: false, columns: ['region_id', 'name(10)'] },
  ]);
  assert.deepEqual(json.foreign_keys, [
    { name: 'fk_parent', columns: ['parent_id'], references: { table: 'customers', columns: ['id'] } },
  ]);
});

test('write_query: INSERT with parameters (create)', async () => {
  const inserted = await call('write_query', {
    sql: `INSERT INTO ${T('customers')}
          (name, email, balance, big, created_at, profile, region_id, parent_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?)`,
    params: [
      'Ann', 'ann@example.com', '19.99', '9007199254740993', '2026-11-23 10:20:30', { vip: true, tags: ['a', 'b'] }, 1, null,
      "Bob'; DROP TABLE customers; --", 'bob@example.com', 0, 0, null, null, 2, 1,
    ],
  });
  assert.deepEqual(Object.keys(inserted.json).sort(), ['affected_rows', 'elapsed_ms', 'insert_id']);
  assert.equal(inserted.json.affected_rows, 2);
  assert.equal(inserted.json.insert_id, 1);
});

test('read_query: SELECT returns stored values with their exact types (read)', async () => {
  const { json } = await call('read_query', {
    sql: `SELECT * FROM ${T('customers')} WHERE id <> ? ORDER BY id`,
    params: [99],
  });
  assert.deepEqual(json.columns, ['id', 'name', 'email', 'balance', 'big', 'created_at', 'profile', 'region_id', 'parent_id']);
  assert.deepEqual([json.row_count, json.truncated], [2, false]);

  const [ann, bob] = json.rows;
  assert.deepEqual(ann, {
    id: 1, // INT: a number
    name: 'Ann',
    email: 'ann@example.com',
    balance: '19.99', // DECIMAL: text, not a float
    big: '9007199254740993', // BIGINT: text, so 19-digit ids survive
    created_at: '2026-11-23 10:20:30', // as stored, not shifted to UTC
    profile: { vip: true, tags: ['a', 'b'] }, // JSON column: nested value
    region_id: 1,
    parent_id: null,
  });
  assert.equal(bob.name, "Bob'; DROP TABLE customers; --");
  assert.equal(bob.big, '0');
  assert.equal(bob.parent_id, 1);
});

test('write_query: UPDATE and DELETE with a WHERE (update / delete)', async () => {
  const updateSql = `UPDATE ${T('customers')} SET name = ?, balance = balance + ? WHERE email = 'ann@example.com'`;
  const updated = await call('write_query', { sql: updateSql, params: ['Ann Smith', '0.01'] });
  // affected_rows counts matched rows, changed_rows only those that ended up different.
  assert.deepEqual(Object.keys(updated.json).sort(), ['affected_rows', 'changed_rows', 'elapsed_ms']);
  assert.deepEqual([updated.json.affected_rows, updated.json.changed_rows], [1, 1]);
  const unchanged = await call('write_query', { sql: `UPDATE customers SET name = 'Ann Smith' WHERE email = 'ann@example.com'` });
  assert.deepEqual([unchanged.json.affected_rows, unchanged.json.changed_rows], [1, 0]);

  const ann = await call('read_query', { sql: 'SELECT name, balance FROM customers WHERE id = 1' });
  assert.deepEqual(ann.json.rows, [{ name: 'Ann Smith', balance: '20.00' }]);

  // A WHERE inside a string literal is not a clause…
  const literal = await call('write_query', { sql: `UPDATE customers SET name = 'where' WHERE id = 2` });
  assert.equal(literal.json.affected_rows, 1);
  // …and a WHERE that does exist lets a delete through.
  const deleted = await call('write_query', { sql: `DELETE FROM customers WHERE id = 999` });
  assert.deepEqual(Object.keys(deleted.json), ['affected_rows', 'elapsed_ms']);
  assert.equal(deleted.json.affected_rows, 0);
});

test('read_query keeps columns that share a name', async () => {
  const { json } = await call('read_query', {
    sql: `SELECT c.id, p.id, c.name FROM customers c JOIN customers p ON p.id = c.parent_id`,
  });
  // Both columns are qualified with their alias, so neither value is lost.
  assert.deepEqual(json.columns, ['c.id', 'p.id', 'name']);
  assert.deepEqual(json.rows, [{ 'c.id': 2, 'p.id': 1, name: 'where' }]);
});

test('read_query: SHOW / DESCRIBE / EXPLAIN work, limit and truncation are honoured', async () => {
  assert.equal((await call('read_query', { sql: `SHOW TABLES FROM \`${SCRATCH}\`` })).json.row_count, 1);
  assert.equal((await call('read_query', { sql: 'DESCRIBE customers' })).json.row_count, 9);
  assert.equal((await call('read_query', { sql: 'EXPLAIN SELECT * FROM customers' })).isError, false);

  await call('write_query', { sql: `CREATE TABLE ${T('numbers')} (n INT PRIMARY KEY)` });
  const values = Array.from({ length: 250 }, (_, n) => `(${n})`).join(', ');
  assert.equal((await call('write_query', { sql: `INSERT INTO ${T('numbers')} (n) VALUES ${values}` })).json.affected_rows, 250);

  const page = await call('read_query', { sql: 'SELECT n FROM numbers ORDER BY n', limit: 5 });
  assert.deepEqual([page.json.row_count, page.json.truncated, page.json.rows.length, page.json.rows[4].n], [5, true, 5, 4]);
  const all = await call('read_query', { sql: 'SELECT n FROM numbers ORDER BY n DESC', limit: 1000 });
  assert.deepEqual([all.json.row_count, all.json.truncated, all.json.rows[0].n], [250, false, 249]);
  const empty = await call('read_query', { sql: 'SELECT n FROM numbers WHERE n > 1000' });
  assert.deepEqual(empty.json, { columns: ['n'], row_count: 0, truncated: false, elapsed_ms: empty.json.elapsed_ms, rows: [] });
});

test('MySQL applies the row cap server-side on this server', async () => {
  // read_query relies on this session variable, so make sure this MySQL honours it.
  const connection = await createConnection(connectionOptions());
  try {
    await connection.query('SET SESSION sql_select_limit = 6');
    const [rows] = await connection.query(`SELECT n FROM ${T('numbers')} ORDER BY n`);
    assert.equal(rows.length, 6);
    await connection.query('SET SESSION sql_select_limit = DEFAULT');
    const [restored] = await connection.query(`SELECT n FROM ${T('numbers')} ORDER BY n`);
    assert.equal(restored.length, 250);
  } finally {
    await connection.end();
  }
});

test('read_query clips long values and refuses oversized results', async () => {
  await call('write_query', { sql: `CREATE TABLE ${T('texts')} (id INT PRIMARY KEY, body MEDIUMTEXT)` });
  await call('write_query', { sql: `INSERT INTO ${T('texts')} (id, body) VALUES (1, ?)`, params: ['x'.repeat(5000)] });

  const one = await call('read_query', { sql: 'SELECT body FROM texts' });
  assert.ok(one.json.rows[0].body.endsWith('…[3000 more chars]'), one.json.rows[0].body.slice(-40));
  assert.ok(one.json.rows[0].body.length < 2100);

  // 250 joined rows of ~2000 characters each exceed the result budget…
  const join = `SELECT t.body FROM numbers n JOIN texts t ON t.id = 1`;
  const refused = await call('read_query', { sql: join });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /too large to return/);
  // …whereas a page of it is fine.
  assert.equal((await call('read_query', { sql: join, limit: 20 })).json.row_count, 20);
});

test('read_query kills SELECTs that exceed the time limit', async () => {
  assert.equal((await call('read_query', { sql: 'SELECT COUNT(*) AS n FROM numbers' })).isError, false);
  // Roughly 10^8 joined rows: the optimizer cannot shortcut it, and it cannot finish in 1500 ms.
  const slow = await call('read_query', {
    sql: `SELECT COUNT(*) AS n FROM numbers a JOIN numbers b ON a.n < b.n
          JOIN numbers c ON b.n < c.n JOIN numbers d ON c.n < d.n`,
  });
  assert.equal(slow.isError, true, slow.text);
  assert.match(slow.text, /maximum statement execution time exceeded/);
  assert.ok(slow.text.includes('1500 ms'), slow.text);
});

test('read_query refuses anything that is not a plain read', async () => {
  for (const sql of [
    'DELETE FROM customers WHERE id = 1',
    "UPDATE customers SET name = 'x' WHERE id = 1",
    'DROP TABLE customers',
    'INSERT INTO numbers (n) VALUES (1)',
    'TRUNCATE TABLE customers',
  ]) {
    const refused = await call('read_query', { sql });
    assert.equal(refused.isError, true, sql);
    assert.match(refused.text, /use write_query/, sql);
  }
});

test('read_query stays read-only for writes that start like a read', async () => {
  for (const sql of [
    'WITH gone AS (SELECT id FROM customers) DELETE FROM customers WHERE id IN (SELECT id FROM gone)',
    'EXPLAIN ANALYZE DELETE FROM customers',
    'EXPLAIN ANALYZE UPDATE customers SET name = "x"',
  ]) {
    const refused = await call('read_query', { sql });
    assert.equal(refused.isError, true, sql);
    assert.match(refused.text, /read_query cannot change anything/, sql);
  }
  assert.equal((await call('read_query', { sql: 'SELECT COUNT(*) AS n FROM customers' })).json.rows[0].n, '2');
});

test('write_query refuses session statements, temporary tables and stacked statements', async () => {
  const refused = [
    ['USE mysql', /"USE" is not a statement/],
    ['SET @x = 1', /"SET" is not a statement/],
    ['START TRANSACTION', /"START" is not a statement/],
    ['KILL 1', /"KILL" is not a statement/],
    ['SHUTDOWN', /"SHUTDOWN" is not a statement/],
    ['CREATE TEMPORARY TABLE scratch (n INT)', /temporary tables/],
    ['SELECT 1 /*! ; DROP TABLE numbers */', /executable comments/],
    ['   ', /statement is empty/],
    ['SELECT 1', /use read_query/],
    ['DELETE FROM numbers WHERE n = 0; DROP TABLE numbers', /MySQL error 1064/],
  ];
  for (const [sql, expected] of refused) {
    const result = await call('write_query', { sql });
    assert.equal(result.isError, true, sql);
    assert.match(result.text, expected, sql);
  }
  assert.equal((await call('read_query', { sql: 'SELECT COUNT(*) AS n FROM numbers' })).json.rows[0].n, '250');
});

test('write_query refuses hard-to-undo statements without confirm', async () => {
  const refused = [
    ['DELETE FROM numbers', /no WHERE clause/],
    ['DELETE FROM numbers /* WHERE n = 1 */', /no WHERE clause/],
    ['DELETE FROM numbers -- WHERE n = 1\n', /no WHERE clause/],
    ['UPDATE numbers SET n = n + 1', /no WHERE clause/],
    ['UPDATE numbers SET n = (SELECT MAX(n) FROM numbers WHERE n < 5)', /no WHERE clause/],
    ['DELETE FROM numbers WHERE 1 = 1', /matches every row/],
    ['DELETE FROM numbers WHERE true', /matches every row/],
    ['DELETE FROM `where`', /no WHERE clause/],
    // The only WHERE is inside a string literal, so this would touch every row.
    ["UPDATE customers SET name = 'where'", /no WHERE clause/],
    [`DROP TABLE ${T('numbers')}`, /drops or truncates/],
    ['TRUNCATE TABLE numbers', /drops or truncates/],
    [`DROP DATABASE \`${SCRATCH}\``, /drops or truncates/],
    ['ALTER TABLE numbers DROP COLUMN n', /drops a column/],
    ['ALTER TABLE numbers DROP INDEX PRIMARY, ADD INDEX (n)', /drops a column/],
  ];
  for (const [sql, expected] of refused) {
    const result = await call('write_query', { sql });
    assert.equal(result.isError, true, sql);
    assert.match(result.text, expected, sql);
    assert.match(result.text, /confirm: true/, sql);
  }
  // Nothing above reached the database.
  assert.equal((await call('read_query', { sql: 'SELECT COUNT(*) AS n FROM numbers' })).json.rows[0].n, '250');
});

test('write_query runs them once confirm is set', async () => {
  assert.equal((await call('write_query', { sql: 'ALTER TABLE numbers ADD COLUMN note VARCHAR(10)' })).isError, false);
  const dropped = await call('write_query', { sql: 'ALTER TABLE numbers DROP COLUMN note', confirm: true });
  assert.equal(dropped.isError, false, dropped.text);
  const truncated = await call('write_query', { sql: 'TRUNCATE TABLE numbers', confirm: true });
  assert.equal(truncated.isError, false, truncated.text);
  assert.equal((await call('read_query', { sql: 'SELECT COUNT(*) AS n FROM numbers' })).json.rows[0].n, '0');

  assert.equal((await call('write_query', { sql: `CREATE DATABASE \`${EXTRA}\`` })).isError, false);
  const created = await call('list_databases');
  assert.ok(created.json.databases.some((db) => db.name === EXTRA));
  assert.equal((await call('write_query', { sql: `DROP DATABASE \`${EXTRA}\``, confirm: true })).isError, false);
  const droppedDb = await call('list_databases');
  assert.ok(!droppedDb.json.databases.some((db) => db.name === EXTRA));
});

test('write_query reports warnings', async () => {
  await call('write_query', { sql: `CREATE TABLE ${T('notes')} (id INT)` });
  const again = await call('write_query', { sql: `CREATE TABLE IF NOT EXISTS ${T('notes')} (id INT)` });
  assert.equal(again.isError, false, again.text);
  assert.deepEqual(again.json.warnings, ["Note 1050: Table 'notes' already exists"]);
});

test('SQL errors come back as tool errors instead of crashing the server', async () => {
  const unknownColumn = await call('read_query', { sql: 'SELECT nope FROM customers' });
  assert.equal(unknownColumn.isError, true);
  assert.match(unknownColumn.text, /MySQL error 1054 .*Unknown column/);

  const missingTable = await call('describe_table', { table: 'no_such_table' });
  assert.equal(missingTable.isError, true);
  assert.match(missingTable.text, /was not found/);

  const badArgument = await call('read_query', { sql: 'SELECT 1', limit: 1001 });
  assert.equal(badArgument.isError, true);
  assert.match(badArgument.text, /1000|less than|at most/);

  const missingSql = await call('read_query', {});
  assert.equal(missingSql.isError, true);

  // …and the server is still healthy afterwards. An integer literal is typed BIGINT, hence text.
  const one = await call('read_query', { sql: 'SELECT 1 AS one' });
  assert.deepEqual(one.json.rows, [{ one: '1' }]);
});

test('recovers after the server drops idle connections', async () => {
  // Warm both pools.
  await call('read_query', { sql: 'SELECT 1' });
  await call('write_query', { sql: 'INSERT INTO numbers (n) VALUES (?)', params: [7] });
  // Kill exactly this server's connections: they are the only ones using the scratch database.
  const admin = await createConnection(connectionOptions());
  try {
    const [threads] = await admin.query('SELECT ID FROM information_schema.PROCESSLIST WHERE DB = ?', [SCRATCH]);
    assert.ok(threads.length >= 2, `expected pooled connections, saw ${threads.length}`);
    for (const { ID } of threads) await admin.query('KILL ?', [ID]);
  } finally {
    await admin.end();
  }
  await new Promise((resolve) => setTimeout(resolve, 300));

  const read = await call('read_query', { sql: 'SELECT n FROM numbers' });
  assert.equal(read.isError, false, read.text);
  assert.deepEqual(read.json.rows, [{ n: 7 }]);
  const write = await call('write_query', { sql: 'INSERT INTO numbers (n) VALUES (?)', params: [8] });
  assert.equal(write.isError, false, write.text);
});

test('a read on a dead pooled connection is retried once, other errors are not', async () => {
  const dead = {
    query: async () => {
      throw Object.assign(new Error('Connection lost: The server closed the connection.'), { code: 'PROTOCOL_CONNECTION_LOST' });
    },
    release() {},
  };
  const alive = {
    query: async (sql) => (typeof sql === 'object' ? [[[1]], [{ name: 'id', table: '' }]] : [{ affectedRows: 0 }]),
    release() {},
  };
  let handedOut = 0;
  const pool = { getConnection: async () => (++handedOut === 1 ? dead : alive) };
  assert.deepEqual((await readRows(pool, 'SELECT id FROM t')).rows, [[1]]);
  assert.equal(handedOut, 2);

  const broken = {
    query: async () => {
      throw Object.assign(new Error('Unknown column'), { code: 'ER_BAD_FIELD_ERROR', errno: 1054 });
    },
    release() {},
  };
  handedOut = 0;
  const failing = { getConnection: async () => (handedOut++, broken) };
  await assert.rejects(readRows(failing, 'SELECT nope FROM t'), { code: 'ER_BAD_FIELD_ERROR' });
  assert.equal(handedOut, 1);
});

test('SQL classifier decides read / write / dangerous / unsupported as intended', async () => {
  const cases = {
    read: [
      'SELECT 1', '  /* c */ select 1', '-- comment\nSELECT 1', '# comment\nSHOW TABLES',
      'WITH x AS (SELECT 1) SELECT * FROM x', 'DESCRIBE t', 'DESC t', 'EXPLAIN SELECT 1',
      'SELECT /*+ MAX_EXECUTION_TIME(1000) */ 1', 'select "drop table", `where`',
    ],
    write: [
      'INSERT INTO t (a) VALUES (1)', 'UPDATE t SET a = 1 WHERE id = 1', 'DELETE FROM t WHERE id = 1',
      'DELETE FROM t WHERE id = 1;', 'DELETE FROM t WHERE id IN (SELECT id FROM u WHERE x)',
      "DELETE FROM t WHERE name = 'drop where; -- x'", "UPDATE t SET note = '/* not a comment */' WHERE id = 1",
      'DELETE FROM t WHERE 1 = 1 AND id = 5', 'CREATE TABLE drop_me (drop_col INT)', 'CREATE OR REPLACE VIEW v AS SELECT 1',
      'ALTER TABLE t ADD COLUMN c INT', 'REPLACE INTO t (id) VALUES (1)', "GRANT SELECT ON db.* TO 'u'@'%'",
    ],
    dangerous: [
      'DELETE FROM t', 'DELETE t1 FROM t1 JOIN t2 ON t1.id = t2.id', 'UPDATE t SET a = 1',
      'UPDATE t JOIN u ON t.id = u.id SET t.a = 1', 'UPDATE t SET a = (SELECT MAX(a) FROM u WHERE b)',
      'DELETE FROM t -- WHERE id = 1', 'DELETE FROM t /* WHERE id = 1 */', "UPDATE t SET name = 'where'",
      'DELETE FROM t WHERE 1', 'DELETE FROM t WHERE 1=1', 'DELETE FROM t WHERE TRUE', 'DELETE FROM t WHERE true ORDER BY id',
      'drop table t', 'DROP DATABASE IF EXISTS d', 'TRUNCATE t',
      'ALTER TABLE t DROP COLUMN c', 'ALTER TABLE t DROP INDEX i, ADD INDEX (c)',
    ],
    unsupported: [
      'USE db', 'SET @a = 1', 'SET NAMES utf8mb4', 'START TRANSACTION', 'BEGIN', 'COMMIT', 'ROLLBACK',
      'LOCK TABLES t WRITE', 'UNLOCK TABLES', 'PREPARE s FROM \'SELECT 1\'', 'KILL 1', 'SHUTDOWN', 'RESTART',
      'CREATE TEMPORARY TABLE t (id INT)', 'SELECT 1 /*!50000 , 2 */', '/*! DELETE FROM t */',
      '', '   ', '-- just a comment', '/* block */', '`select` * from t', 'a--b SELECT',
    ],
  };
  for (const [expected, statements] of Object.entries(cases)) {
    for (const sql of statements) {
      const { kind, danger } = classify(sql);
      const actual = kind === 'write' && danger ? 'dangerous' : kind;
      assert.equal(actual, expected, JSON.stringify(sql));
    }
  }
});

/** Some tests change MYSQL_* variables in this process; these hand them back afterwards. */
function snapshotEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('MYSQL_')));
}

function restoreEnv(snapshot) {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('MYSQL_')) delete process.env[key];
  }
  for (const [key, value] of Object.entries(snapshot)) process.env[key] = value;
}

const temporaryDirectory = () => mkdtempSync(path.join(tmpdir(), 'mysql-mcp-e2e-'));

/** Writes a settings file in .env form. Values are double-quoted, which Node's parser understands. */
function writeEnvFile(file, settings) {
  writeFileSync(file, Object.entries(settings).map(([key, value]) => `${key}=${JSON.stringify(String(value))}`).join('\n') + '\n');
  return file;
}

test('.env: a malformed or misspelled line stops the server instead of being ignored', async () => {
  assert.throws(() => parseEnvSource('MYSQL_PASSWIRD=typo\n', '.env'), /unknown setting MYSQL_PASSWIRD.*MYSQL_PASSWORD/s);
  assert.throws(() => parseEnvSource('MYSQL_PASSWORD: secret\n', '.env'), /not KEY=VALUE.*MYSQL_PASSWORD: secret/s);
  assert.throws(() => parseEnvSource('this is not an env line\n', '.env'), /\.env: this line is not KEY=VALUE/);
  // Quoted values keep their spaces and "#".
  assert.deepEqual(
    parseEnvSource('# comment\n\nMYSQL_PASSWORD=from-file\nexport MYSQL_HOST=10.0.0.1\nMYSQL_USER="root #1"\n', '.env'),
    { MYSQL_PASSWORD: 'from-file', MYSQL_HOST: '10.0.0.1', MYSQL_USER: 'root #1' },
  );

  const before = snapshotEnv();
  const dir = temporaryDirectory();
  try {
    delete process.env.MYSQL_HOST;
    delete process.env.MYSQL_USER;
    process.env.MYSQL_PASSWORD = 'from-environment';
    const file = writeEnvFile(path.join(dir, 'settings.env'), { MYSQL_PASSWORD: 'from-file', MYSQL_HOST: '10.0.0.1', MYSQL_USER: 'root #1' });
    // The environment wins over the file; everything else comes from it.
    const config = loadConfig({ defaultEnvFile: file });
    assert.deepEqual([config.password, config.host, config.user, config.envFile], ['from-environment', '10.0.0.1', 'root #1', file]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    restoreEnv(before);
  }
});

test('--env-file: the named file replaces <project>/.env, and the environment still outranks it', async () => {
  const dir = temporaryDirectory();
  try {
    const defaults = writeEnvFile(path.join(dir, 'default.env'), {
      MYSQL_HOST: '10.9.9.9',
      MYSQL_USER: 'from-default',
      MYSQL_PASSWORD: 'default-secret',
    });
    const named = writeEnvFile(path.join(dir, 'named.env'), {
      MYSQL_HOST: '127.0.0.1',
      MYSQL_PORT: '3307',
      MYSQL_USER: 'from-named',
      MYSQL_MCP_READONLY: 'yes',
    });
    const before = snapshotEnv();
    try {
      for (const key of Object.keys(before)) delete process.env[key];

      // Without --env-file the default file is read…
      assert.equal(loadConfig({ defaultEnvFile: defaults }).user, 'from-default');
      // …with it, only the named one: nothing carries over from the default file.
      const config = loadConfig({ defaultEnvFile: defaults, envFile: named });
      assert.deepEqual(
        { host: config.host, port: config.port, user: config.user, password: config.password, readonly: config.readonly, envFile: config.envFile },
        { host: '127.0.0.1', port: 3307, user: 'from-named', password: '', readonly: true, envFile: named },
      );
      // The environment still wins over the file.
      process.env.MYSQL_PORT = '3308';
      assert.equal(loadConfig({ defaultEnvFile: defaults, envFile: named }).port, 3308);

      // A missing default file is fine; a missing named file is an error.
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
  // No MYSQL_* variable in the environment and no project .env: the connection can only come from this file.
  const file = writeEnvFile(path.join(dir, 'other-database.env'), {
    MYSQL_HOST: target.host,
    MYSQL_PORT: target.port,
    MYSQL_USER: target.user,
    MYSQL_PASSWORD: target.password,
    MYSQL_DATABASE: SCRATCH,
    MYSQL_MCP_READONLY: '1',
  });
  try {
    const withoutMysql = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('MYSQL_')));
    const server = await startServer({ args: ['--env-file', file], bareEnv: { ...withoutMysql, MYSQL_MCP_QUERY_TIMEOUT_MS: '1500' } });
    try {
      const callHere = callerFor(server.client);
      const { tools } = await server.client.listTools();
      assert.ok(!tools.some((tool) => tool.name === 'write_query'), 'MYSQL_MCP_READONLY from the file must apply');
      const result = await callHere('read_query', { sql: 'SELECT DATABASE() AS db, CURRENT_USER() AS account' });
      assert.equal(result.isError, false, result.text);
      assert.deepEqual([result.json.rows[0].db, result.json.rows[0].account.split('@')[0]], [SCRATCH, target.user]);
    } finally {
      await server.client.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an MCP client's `env` block alone carries the connection, and outranks <project>/.env", async () => {
  // Exactly what a client hands a stdio server that is configured with an `env` block: those
  // variables and nothing else in the environment (no PATH, no HOME). The database name is set
  // here only, so seeing it back proves the environment outranked the settings file.
  const server = await startServer({
    bareEnv: {
      MYSQL_HOST: target.host,
      MYSQL_PORT: String(target.port),
      MYSQL_USER: target.user,
      MYSQL_PASSWORD: target.password,
      MYSQL_DATABASE: SCRATCH,
      MYSQL_MCP_READONLY: '0',
      MYSQL_MCP_QUERY_TIMEOUT_MS: '1500',
    },
  });
  try {
    const callHere = callerFor(server.client);
    const result = await callHere('read_query', { sql: 'SELECT DATABASE() AS db' });
    assert.equal(result.isError, false, result.text);
    assert.deepEqual(result.json.rows, [{ db: SCRATCH }]);
    const { tools } = await server.client.listTools();
    assert.equal(tools.length, 5, 'write_query is enabled because the environment says so');
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
      env: {
        ...process.env,
        MYSQL_HOST: target.host,
        MYSQL_PORT: String(target.port),
        MYSQL_USER: target.user,
        MYSQL_PASSWORD: target.password,
        MYSQL_MCP_READONLY: '0',
        MYSQL_MCP_QUERY_TIMEOUT_MS: '1500',
      },
      ...options,
    });
  try {
    const settings = writeEnvFile(path.join(dir, 'settings.env'), { MYSQL_DATABASE: SCRATCH });

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
    // Either way the process must not come up, and the message must name the file.
    const missing = run(['--env-file', path.join(dir, 'nope.env'), '--check']);
    assert.notEqual(missing.status, 0);
    assert.ok(missing.stderr.includes(path.join(dir, 'nope.env')), missing.stderr);

    const broken = path.join(dir, 'broken.env');
    writeFileSync(broken, 'MYSQL_PASSWORD: oops\n');
    const malformed = run(['--env-file', broken, '--check']);
    assert.equal(malformed.status, 1);
    assert.ok(malformed.stderr.includes(`[mysql-mcp-server] ${broken}: this line is not KEY=VALUE`), malformed.stderr);

    for (const [args, expected] of [
      // Alone, the switch reaches the server. Followed by another switch, Node 24 takes that
      // one for the path and reports it as not found before the server starts.
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

test('read-only mode hides write_query', async () => {
  const readonly = await startServer({ env: { MYSQL_MCP_READONLY: '1' } });
  try {
    const { tools } = await readonly.client.listTools();
    assert.deepEqual(
      tools.map((tool) => tool.name),
      ['list_databases', 'list_tables', 'describe_table', 'read_query'],
    );
  } finally {
    await readonly.client.close();
  }
});

test('--check reports a healthy connection and fails on a bad password', async () => {
  const env = { ...process.env, MYSQL_DATABASE: SCRATCH, ...serverEnv };
  const healthy = spawnSync(process.execPath, [entry, '--check'], { env, encoding: 'utf8' });
  assert.equal(healthy.status, 0, healthy.stderr);
  assert.match(healthy.stdout, /已连接 MySQL/);
  assert.match(healthy.stdout, new RegExp(`默认数据库: ${SCRATCH}`));
  assert.match(healthy.stdout, /可见数据库 \(\d+\): .*information_schema/);

  const wrongPassword = spawnSync(process.execPath, [entry, '--check'], {
    env: { ...env, MYSQL_PASSWORD: 'definitely-wrong' },
    encoding: 'utf8',
  });
  assert.equal(wrongPassword.status, 1);
  assert.match(wrongPassword.stderr, /连接失败.*MYSQL_PASSWORD/);
});

test('the server exits once the client closes its stdin', async () => {
  const extra = await startServer();
  const { pid } = extra.transport;
  await extra.client.close();
  const started = Date.now();
  while (Date.now() - started < 5000) {
    let running = true;
    try {
      process.kill(pid, 0);
    } catch {
      running = false;
    }
    if (!running) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail('server still running 5 s after the client closed');
});

let failed = 0;
const target = connectionOptions();
if (!['127.0.0.1', 'localhost', '::1'].includes(target.host) && process.env.E2E_ALLOW_REMOTE !== 'yes') {
  console.error(
    `Refusing to run: this test creates and drops databases, and it is pointed at ${target.user}@${target.host}:${target.port}.\n` +
      'Point the MYSQL_* settings at a disposable MySQL, or set E2E_ALLOW_REMOTE=yes to accept the risk.',
  );
  process.exit(2);
}
// The server opens its connections in the scratch database, so that has to exist first.
const admin = await createConnection(target);
await admin.query(`CREATE DATABASE \`${SCRATCH}\``);
main = await startServer();
call = callerFor(main.client);
try {
  console.log(`Scratch database ${SCRATCH} on ${target.host}:${target.port}\n`);
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`  ok    ${name}`);
    } catch (err) {
      failed++;
      console.log(`  FAIL  ${name}`);
      console.log(String(err.message).split('\n').map((line) => `        ${line}`).join('\n'));
    }
  }
} finally {
  await main.client.close();
  for (const name of [SCRATCH, EXTRA]) await admin.query(`DROP DATABASE IF EXISTS \`${name}\``);
  await admin.end();
}

console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed === 0 ? 0 : 1);
