import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import type {CallToolResult} from '@modelcontextprotocol/sdk/types.js';
import type {Pool} from 'mysql2/promise';
import {z} from 'zod';
import type {Config} from './config.js';
import {isStaleConnection, MAX_ROWS, readRows, type Rows, writeStatement} from './db.js';
import {classify} from './sql-guard.js';

export const INSTRUCTIONS = `Access to a MySQL database through five tools.
1. Look up the schema before touching data: list_databases → list_tables → describe_table. Never guess column names.
2. read_query runs one SELECT / SHOW / DESCRIBE / EXPLAIN statement. It is read-only and returns at most \`limit\` rows.
3. write_query runs one INSERT / UPDATE / DELETE / REPLACE / DDL statement. Pass values through \`params\` (? placeholders) instead of pasting them into the SQL text.
4. Statements that are hard to undo are refused until \`confirm\` is true. Set it only after the user has agreed to that exact statement.
5. Every statement commits on its own; there are no multi-statement calls or transactions. If several changes must succeed or fail together, tell the user instead of improvising.`;

const SYSTEM_DATABASES = ['information_schema', 'mysql', 'performance_schema', 'sys'];
/** Longest string returned in a row before it is cut off. */
const MAX_VALUE_CHARS = 2000;
/** Largest result, as JSON, that is handed back; anything bigger is refused with a hint. */
const MAX_RESULT_CHARS = 100_000;
const NO_DATABASE = 'No database given: pass the `database` argument or set MYSQL_DATABASE for the server.';

const TABLE_SQL = `SELECT TABLE_TYPE AS table_type, ENGINE AS engine, TABLE_COLLATION AS table_collation, TABLE_COMMENT AS table_comment
  FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`;
const COLUMN_SQL = `SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable, COLUMN_DEFAULT AS default_value,
  COLUMN_KEY AS column_key, EXTRA AS extra, COLUMN_COMMENT AS comment
  FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`;
const INDEX_SQL = `SELECT INDEX_NAME AS name, NON_UNIQUE AS non_unique, COLUMN_NAME AS column_name, SUB_PART AS sub_part
  FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY INDEX_NAME, SEQ_IN_INDEX`;
const FOREIGN_KEY_SQL = `SELECT CONSTRAINT_NAME AS name, COLUMN_NAME AS column_name,
  REFERENCED_TABLE_NAME AS ref_table, REFERENCED_COLUMN_NAME AS ref_column
  FROM information_schema.KEY_COLUMN_USAGE
  WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL
  ORDER BY CONSTRAINT_NAME, ORDINAL_POSITION`;

/** A row addressed by column name, for the server's own metadata queries. */
type Row = Record<string, any>;

interface IndexInfo {
  name: string;
  unique: boolean;
  columns: string[];
}

interface ForeignKeyInfo {
  name: string;
  columns: string[];
  references: { table: string; columns: string[] };
}

export interface ToolContext {
  config: Config;
  readPool: Pool;
  /** Absent in read-only mode, which is what hides write_query. */
  writePool?: Pool;
}

type Body = () => Promise<CallToolResult>;

function text(payload: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

function failure(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

/** Rebuilds row objects from the field list, passing each value through `transform`. */
function toObjects({ columns, rows }: Rows, transform: (value: unknown) => unknown = (value) => value): Row[] {
  return rows.map((row) => Object.fromEntries(columns.map((column, i) => [column, transform(row[i])])));
}

/** Drops empty values, which are the norm in metadata (no default, no comment, not a key). */
function prune(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== null && value !== '' && value !== undefined),
  );
}

/** Long values are cut so that a single row cannot flood the model's context. */
function clip(value: unknown): unknown {
  if (Buffer.isBuffer(value)) {
    // MySQL's own binary literal syntax, so the value can be reused in a follow-up statement.
    const shown = value.subarray(0, (MAX_VALUE_CHARS - 2) / 2);
    const hiddenBytes = value.length - shown.length;
    return `0x${shown.toString('hex')}${hiddenBytes > 0 ? `…[${hiddenBytes * 2} more hex chars]` : ''}`;
  }
  if (typeof value === 'string' && value.length > MAX_VALUE_CHARS) {
    return `${value.slice(0, MAX_VALUE_CHARS)}…[${value.length - MAX_VALUE_CHARS} more chars]`;
  }
  return value;
}

/** Turns a driver or MySQL error into a message the model can act on. */
export function describeError(err: unknown, config: Config, writing = false): string {
  const e = err as { code?: string; errno?: number; sqlMessage?: string } | null;
  switch (e?.code) {
    case 'ECONNREFUSED':
      return `Cannot connect to MySQL at ${config.host}:${config.port}: connection refused. Is the MySQL server running?`;
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return `Cannot resolve the MySQL host "${config.host}". Check MYSQL_HOST.`;
    case 'ETIMEDOUT':
      return `Connecting to MySQL at ${config.host}:${config.port} timed out.`;
    case 'ER_ACCESS_DENIED_ERROR':
      return `MySQL rejected user "${config.user}": ${e.sqlMessage}. Check MYSQL_USER and MYSQL_PASSWORD.`;
    case 'ER_BAD_DB_ERROR':
      return `MySQL does not know the default database "${config.database}". Check MYSQL_DATABASE.`;
    case 'ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION':
      return `read_query cannot change anything: MySQL rejected the statement inside its read-only transaction (${e.sqlMessage}). Use write_query for that.`;
    case 'ER_QUERY_TIMEOUT':
      return `${e.sqlMessage} (SELECT statements are limited to ${config.queryTimeoutMs} ms; raise MYSQL_MCP_QUERY_TIMEOUT_MS if this query needs longer).`;
  }
  if (isStaleConnection(err) && writing) {
    return 'The MySQL connection dropped while the statement was running, so it may or may not have been applied. Check with read_query before repeating it.';
  }
  if (e?.errno !== undefined && e.sqlMessage) return `MySQL error ${e.errno} (${e.code}): ${e.sqlMessage}`;
  return err instanceof Error ? err.message : String(err);
}

export function registerTools(server: McpServer, ctx: ToolContext): void {
  const { config, readPool, writePool } = ctx;

  // A tool callback must not throw into the SDK: every failure becomes a message the model can act on.
  const guard = async (body: Body, writing = false): Promise<CallToolResult> => {
    try {
      return await body();
    } catch (err) {
      return failure(describeError(err, config, writing));
    }
  };

  const databaseParam = z.string().min(1).describe('Database name. Defaults to MYSQL_DATABASE from the server configuration.');

  server.registerTool(
    'list_databases',
    {
      title: 'List databases',
      description: 'List the databases visible to the configured MySQL account, with table counts and approximate sizes.',
      inputSchema: {
        include_system: z.boolean().default(false).describe('Also list the system databases (information_schema, mysql, performance_schema, sys).'),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    ({ include_system }) =>
      guard(async () => {
        const result = await readRows(
          readPool,
          `SELECT s.SCHEMA_NAME AS name, COUNT(t.TABLE_NAME) AS tables,
                  COALESCE(ROUND(SUM(t.DATA_LENGTH + t.INDEX_LENGTH) / 1048576, 2), 0) AS size_mb
           FROM information_schema.SCHEMATA s
           LEFT JOIN information_schema.TABLES t ON t.TABLE_SCHEMA = s.SCHEMA_NAME
           GROUP BY s.SCHEMA_NAME
           ORDER BY s.SCHEMA_NAME`,
        );
        const databases = toObjects(result)
          .filter((row) => include_system || !SYSTEM_DATABASES.includes(row.name))
          .map((row) => ({ name: row.name, tables: Number(row.tables), size_mb: Number(row.size_mb) }));
        return text({ count: databases.length, databases, ...(result.truncated ? { truncated: true } : {}) });
      }),
  );

  server.registerTool(
    'list_tables',
    {
      title: 'List tables',
      description: 'List the tables and views of a database, with row estimates (approximate for InnoDB) and comments.',
      inputSchema: { database: databaseParam.optional() },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    ({ database }) =>
      guard(async () => {
        const db = database ?? config.database;
        if (!db) return failure(NO_DATABASE);
        const result = await readRows(
          readPool,
          `SELECT TABLE_NAME AS name, TABLE_TYPE AS table_type, IFNULL(TABLE_ROWS, 0) AS approx_rows,
                  ENGINE AS engine, TABLE_COMMENT AS table_comment
           FROM information_schema.TABLES
           WHERE TABLE_SCHEMA = ?
           ORDER BY TABLE_NAME`,
          [db],
        );
        const tables = toObjects(result).map((row) => {
          const isView = row.table_type === 'VIEW';
          return prune({
            name: row.name,
            type: row.table_type,
            // MySQL reports "VIEW" as a view's comment and has no row count for it.
            approx_rows: isView ? null : Number(row.approx_rows),
            engine: row.engine,
            comment: isView ? '' : row.table_comment,
          });
        });
        return text({ database: db, count: tables.length, tables, ...(result.truncated ? { truncated: true } : {}) });
      }),
  );

  server.registerTool(
    'describe_table',
    {
      title: 'Describe a table',
      description:
        'Show the columns, indexes and foreign keys of a table or view. Use it before writing INSERT or UPDATE statements to get exact column names, types, nullability and defaults.',
      inputSchema: { table: z.string().min(1).describe('Table or view name.'), database: databaseParam.optional() },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    ({ table, database }) =>
      guard(async () => {
        const db = database ?? config.database;
        if (!db) return failure(NO_DATABASE);
        const [meta, columnRows, indexRows, foreignKeyRows] = await Promise.all([
          readRows(readPool, TABLE_SQL, [db, table], 1),
          readRows(readPool, COLUMN_SQL, [db, table]),
          readRows(readPool, INDEX_SQL, [db, table]),
          readRows(readPool, FOREIGN_KEY_SQL, [db, table]),
        ]);
        const info = toObjects(meta)[0];
        if (!info) return failure(`Table "${table}" was not found in database "${db}", or this MySQL account cannot see it.`);
        const columns = toObjects(columnRows);
        const indexes = toObjects(indexRows);
        const foreignKeys = toObjects(foreignKeyRows);

        const indexList = new Map<string, IndexInfo>();
        for (const row of indexes) {
          const index: IndexInfo = indexList.get(row.name) ?? { name: row.name, unique: Number(row.non_unique) === 0, columns: [] };
          // A prefix index such as name(20); functional indexes (MySQL 8) have no column name.
          index.columns.push(row.column_name ? String(row.column_name) + (row.sub_part ? `(${row.sub_part})` : '') : '(expression)');
          indexList.set(row.name, index);
        }

        const foreignKeyList = new Map<string, ForeignKeyInfo>();
        for (const row of foreignKeys) {
          const foreignKey: ForeignKeyInfo =
            foreignKeyList.get(row.name) ?? { name: row.name, columns: [], references: { table: row.ref_table, columns: [] } };
          foreignKey.columns.push(row.column_name);
          foreignKey.references.columns.push(row.ref_column);
          foreignKeyList.set(row.name, foreignKey);
        }

        const isView = info.table_type === 'VIEW';
        return text({
          database: db,
          table,
          type: info.table_type,
          ...prune({ engine: info.engine, collation: info.table_collation, comment: isView ? '' : info.table_comment }),
          columns: columns.map((row) =>
            prune({
              name: row.name,
              type: row.type,
              nullable: row.nullable === 'YES',
              key: row.column_key,
              default: row.default_value,
              extra: row.extra,
              comment: row.comment,
            }),
          ),
          // Unique indexes first (so PRIMARY leads), then the rest; the server's own order
          // depends on its collation.
          indexes: [...indexList.values()].sort((a, b) => Number(b.unique) - Number(a.unique) || a.name.localeCompare(b.name)),
          foreign_keys: [...foreignKeyList.values()],
        });
      }),
  );

  server.registerTool(
    'read_query',
    {
      title: 'Run a read-only SQL statement',
      description:
        'Run one SELECT, SHOW, DESCRIBE or EXPLAIN statement and return its rows. It runs inside a READ ONLY transaction, so it cannot change data whatever the statement contains. ' +
        'At most `limit` rows come back and `truncated: true` means more rows matched. DECIMAL and BIGINT values are returned as strings to keep them exact. Unqualified table names resolve against the default database.',
      inputSchema: {
        sql: z.string().min(1).describe('A single read-only statement. ? placeholders are filled from params.'),
        params: z.array(z.unknown()).optional().describe('Values for the ? placeholders in sql, in order.'),
        limit: z.number().int().min(1).max(MAX_ROWS).default(100).describe('Maximum number of rows to return.'),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    ({ sql, params, limit }) =>
      guard(async () => {
        const statement = classify(sql);
        if (statement.kind !== 'read') {
          return failure(
            statement.kind === 'write'
              ? `"${statement.verb.toUpperCase()}" changes data or schema: use write_query.`
              : `Not a read statement: ${statement.reason}.`,
          );
        }
        const started = Date.now();
        const result = await readRows(readPool, sql, params, limit);
        const rows = toObjects(result, clip);
        const size = JSON.stringify(rows).length;
        if (size > MAX_RESULT_CHARS) {
          return failure(
            `The result is too large to return (${Math.round(size / 1024)} KB). Select fewer columns, tighten the WHERE clause or lower \`limit\` (currently ${limit}).`,
          );
        }
        return text({ columns: result.columns, row_count: rows.length, truncated: result.truncated, elapsed_ms: Date.now() - started, rows });
      }),
  );

  if (writePool) {
    server.registerTool(
      'write_query',
      {
        title: 'Run a statement that changes data or schema',
        description:
          'Run one INSERT, UPDATE, DELETE, REPLACE, CREATE, ALTER, DROP, TRUNCATE, RENAME, CALL or similar statement. Pass values through `params` (? placeholders). ' +
          'The statement commits immediately. Statements that are hard to undo — UPDATE/DELETE without a WHERE, DROP, TRUNCATE, ALTER ... DROP — are refused unless `confirm` is true. ' +
          'Session statements (USE, SET, transactions, temporary tables) and several statements in one call are not supported. Returns affected_rows, insert_id and warnings.',
        inputSchema: {
          sql: z.string().min(1).describe('A single statement. ? placeholders are filled from params.'),
          params: z.array(z.unknown()).optional().describe('Values for the ? placeholders in sql, in order.'),
          confirm: z.boolean().default(false).describe('Required for statements that are hard to undo. Set only after the user approved this exact statement.'),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      },
      ({ sql, params, confirm }) =>
        guard(async () => {
          const statement = classify(sql);
          if (statement.kind !== 'write') {
            return failure(
              statement.kind === 'read'
                ? `"${statement.verb.toUpperCase()}" only reads: use read_query.`
                : `Not executed: ${statement.reason}.`,
            );
          }
          if (statement.danger && !confirm) {
            return failure(
              `Refused: this statement ${statement.danger}. Show it to the user and call again with confirm: true once they approve it.`,
            );
          }
          const started = Date.now();
          const result = await writeStatement(writePool, sql, params);
          return text({
            affected_rows: result.affectedRows,
            ...(result.insertId > 0 ? { insert_id: result.insertId } : {}),
            ...(result.changedRows !== undefined ? { changed_rows: result.changedRows } : {}),
            ...(result.info ? { info: result.info } : {}),
            ...(result.warnings.length > 0 ? { warnings: result.warnings } : {}),
            elapsed_ms: Date.now() - started,
          });
        }, true),
    );
  }
}
