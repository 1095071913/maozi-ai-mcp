import type {Connection as CallbackConnection} from 'mysql2';
import {createPool, type FieldPacket, type Pool, type ResultSetHeader, type RowDataPacket,} from 'mysql2/promise';
import type {Config} from './config.js';

/** Largest `limit` a caller may ask for; also the cap applied to the server's own metadata queries. */
export const MAX_ROWS = 1000;

export interface Rows {
  /** Keys of the row objects, in column order. */
  columns: string[];
  /** One array of values per row, aligned with `columns`. */
  rows: unknown[][];
  /** True when the statement matched more rows than were returned. */
  truncated: boolean;
}

export interface WriteResult {
  /** Rows inserted, deleted, or — for UPDATE — rows matched by the WHERE clause. */
  affectedRows: number;
  insertId: number;
  /** UPDATE only: of the matched rows, those whose values actually changed. */
  changedRows?: number;
  /** The server's summary line, when it says more than `affectedRows` already does. */
  info: string;
  warnings: string[];
}

export interface Database {
  readPool: Pool;
  /** Absent in read-only mode. */
  writePool?: Pool;
  close(): Promise<void>;
}

export function openDatabase(config: Config): Database {
  const readPool = newPool(config, config.queryTimeoutMs);
  const writePool = config.readonly ? undefined : newPool(config, 0);
  return {
    readPool,
    writePool,
    close: () => Promise.all([readPool.end(), writePool?.end()]).then(() => undefined),
  };
}

function newPool(config: Config, selectTimeoutMs: number): Pool {
  const pool = createPool({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    connectionLimit: 3,
    maxIdle: 2,
    idleTimeout: 60_000,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10_000,
    // Values come back positionally; mysql2's row objects silently drop a column whose
    // name appears twice ("SELECT u.id, o.id"), and the keys are rebuilt from the field list.
    rowsAsArray: true,
    // Return DATETIME and TIMESTAMP as stored. DECIMAL and BIGINT always arrive as strings:
    // exact for 19-digit ids and money, and a column never mixes numbers with strings.
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    // The driver then refuses a second statement, so a ";" cannot smuggle one in.
    multipleStatements: false,
  });
  if (selectTimeoutMs > 0) {
    pool.on('connection', (connection) => {
      // Best effort: MariaDB and MySQL < 5.7.8 do not know this variable.
      // The event carries the callback-style connection, not the promise wrapper.
      const raw = connection as unknown as CallbackConnection;
      raw.query(`SET SESSION max_execution_time = ${selectTimeoutMs}`, () => undefined);
    });
  }
  return pool;
}

/**
 * Errors that mean a pooled connection turned out to be dead. They say nothing about the
 * database itself, and a fresh connection normally works.
 */
export function isStaleConnection(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === 'PROTOCOL_CONNECTION_LOST' || code === 'ECONNRESET' || code === 'EPIPE';
}

/** Runs one read-only statement. Safe to repeat, hence the single retry on a dead connection. */
export async function readRows(pool: Pool, sql: string, values: unknown[] = [], limit = MAX_ROWS): Promise<Rows> {
  try {
    return await readOnce(pool, sql, values, limit);
  } catch (err) {
    if (!isStaleConnection(err)) throw err;
  }
  return readOnce(pool, sql, values, limit);
}

async function readOnce(pool: Pool, sql: string, values: unknown[], limit: number): Promise<Rows> {
  const connection = await pool.getConnection();
  try {
    // MySQL stops sending after limit + 1 rows, so a huge table is never pulled into memory.
    // The extra row is what makes `truncated` detectable.
    await connection.query('SET SESSION sql_select_limit = ?', [limit + 1]);
    // Enforced by MySQL itself: any write inside this transaction fails with
    // ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION, whatever the keyword checks concluded.
    await connection.query('START TRANSACTION READ ONLY');
    let rows: unknown[][];
    let columns: string[];
    try {
      // Rows arrive as arrays (rowsAsArray); the driver's generic only knows its object shape.
      const [result, fields] = await connection.query<RowDataPacket[][]>({ sql, values });
      rows = result as unknown[][];
      columns = uniqueKeys(fields ?? []);
      await connection.query('COMMIT');
    } catch (err) {
      // Hand the connection back outside the read-only transaction.
      await connection.query('ROLLBACK').catch(() => undefined);
      throw err;
    }
    const truncated = rows.length > limit;
    return { columns, rows: truncated ? rows.slice(0, limit) : rows, truncated };
  } finally {
    connection.release();
  }
}

/** Column names as used for row keys; colliding names are qualified with their table or alias. */
function uniqueKeys(fields: FieldPacket[]): string[] {
  const counts = new Map<string, number>();
  for (const field of fields) counts.set(field.name, (counts.get(field.name) ?? 0) + 1);
  const used = new Set<string>();
  return fields.map((field) => {
    // "SELECT u.id, o.id" has two `id` columns, but an object can only hold one.
    let key = (counts.get(field.name) ?? 0) > 1 && field.table ? `${field.table}.${field.name}` : field.name;
    for (let n = 2; used.has(key); n++) key = `${field.name}#${n}`;
    used.add(key);
    return key;
  });
}

/**
 * Runs one statement that changes data or schema. Not retried on a lost connection: the
 * statement may already have been applied, and repeating it is not necessarily harmless.
 */
export async function writeStatement(pool: Pool, sql: string, values: unknown[] = []): Promise<WriteResult> {
  const connection = await pool.getConnection();
  try {
    const [result] = await connection.query({ sql, values: values.map(asSqlParam) });
    // CALL returns every result set followed by the final OK packet.
    const header = (Array.isArray(result) ? result[result.length - 1] : result) as ResultSetHeader;
    let warnings: string[] = [];
    if (header.warningStatus > 0) {
      // SHOW WARNINGS columns: Level, Code, Message.
      const [warningRows] = await connection.query<RowDataPacket[][]>('SHOW WARNINGS');
      warnings = (warningRows as unknown[][]).map(([level, code, message]) => `${level} ${code}: ${message}`);
    }
    // "Rows matched: 3  Changed: 1  Warnings: 0" is worth keeping as numbers: for UPDATE,
    // affectedRows counts the matched rows, not only those that ended up different.
    const update = /^Rows matched: (\d+)\s+Changed: (\d+)\s+Warnings: (\d+)$/.exec(header.info);
    return {
      affectedRows: header.affectedRows,
      insertId: Number(header.insertId),
      changedRows: update ? Number(update[2]) : undefined,
      // "Records: 2  Duplicates: 0  Warnings: 0" (INSERT, ALTER TABLE) only repeats affectedRows.
      info: !update && !/^Records: \d+\s+Duplicates: 0\s+Warnings: 0$/.test(header.info) ? header.info : '',
      warnings,
    };
  } finally {
    connection.release();
  }
}

/** mysql2 expands a plain object into `key = value` pairs (its `SET ?` syntax); as a parameter, JSON text is what was meant. */
function asSqlParam(value: unknown): unknown {
  return Object.prototype.toString.call(value) === '[object Object]' ? JSON.stringify(value) : value;
}
