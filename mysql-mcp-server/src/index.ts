import {createRequire} from 'node:module';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import type {Pool} from 'mysql2/promise';
import {loadConfig} from './config.js';
import {openDatabase, readRows} from './db.js';
import {describeError, INSTRUCTIONS, registerTools} from './tools.js';

const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

interface Switches {
  /** `--check`: connect once, report, and exit instead of serving. */
  check: boolean;
  /** `--env-file <path>`: the settings file to read instead of <project>/.env. */
  envFile?: string;
}

/** The switches this server understands; anything else is a typo worth stopping for. */
function parseArguments(argv: string[]): Switches {
  const switches: Switches = { check: false };
  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i] ?? '';
    if (argument === '--check') {
      switches.check = true;
    } else if (argument === '--env-file' || argument.startsWith('--env-file=')) {
      // The path may be a separate argument, which the loop then has to step over.
      const value = argument === '--env-file' ? argv[++i] : argument.slice('--env-file='.length);
      // Another switch where the path should be is a forgotten path, not a file name.
      if (!value || value.startsWith('-')) throw new Error('--env-file needs a path: --env-file /path/to/.env');
      if (switches.envFile !== undefined) throw new Error('--env-file may only be given once');
      switches.envFile = value;
    } else {
      throw new Error(`unknown option "${argument}". Supported: --env-file <path>, --check`);
    }
  }
  return switches;
}

/**
 * `node dist/index.js --check`: connects with the resolved settings and reports what it found,
 * so connection problems show up in the terminal instead of inside the MCP client.
 */
async function check(config: ReturnType<typeof loadConfig>, readPool: Pool): Promise<boolean> {
  // Shown in both outcomes: when the connection fails, the file that was read is the first question.
  const settingsLine = `  配置文件: ${config.envFile ?? '（未找到 .env，使用环境变量和默认值）'}`;
  try {
    const { rows } = await readRows(readPool, 'SELECT VERSION() AS version, CURRENT_USER() AS account', [], 1);
    console.log(`✔ 已连接 MySQL ${rows[0]?.[0]}  ${config.host}:${config.port}  账号 ${rows[0]?.[1]}`);
    console.log(settingsLine);
    console.log(`  默认数据库: ${config.database ?? '（未设置，SQL 中需写 库名.表名）'}`);
    console.log(`  写操作: ${config.readonly ? '已禁用 (MYSQL_MCP_READONLY)' : '已启用'}`);
    const { rows: schemas } = await readRows(readPool, 'SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME');
    console.log(`  可见数据库 (${schemas.length}): ${schemas.map((row) => row[0]).join(', ')}`);
    return true;
  } catch (err) {
    console.error(`✘ 连接失败: ${describeError(err, config)}`);
    console.error(settingsLine);
    return false;
  }
}

async function main(): Promise<void> {
  const switches = parseArguments(process.argv.slice(2));
  const config = loadConfig(switches);
  const database = openDatabase(config);

  if (switches.check) {
    const healthy = await check(config, database.readPool);
    await database.close();
    process.exit(healthy ? 0 : 1);
  }

  // stdout carries the MCP protocol, so diagnostics go to stderr (clients log it).
  const target = `${config.host}:${config.port}`;
  const settings = config.envFile ? ` (settings: ${config.envFile})` : '';
  console.error(
    `[mysql-mcp-server] ${config.user}@${target}${config.database ? `/${config.database}` : ''} — ${config.readonly ? 'read-only' : 'read-write'}${settings}`,
  );

  process.on('unhandledRejection', (err) => console.error('[mysql-mcp-server] unhandled rejection:', err));
  const shutdown = async (): Promise<void> => {
    await database.close().catch(() => undefined);
    process.exit(0);
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => void shutdown());
  // The client closing stdin means it is done with us: free the MySQL connections instead of lingering.
  process.stdin.on('end', () => void shutdown());

  const server = new McpServer({ name: 'mysql-mcp-server', version }, { instructions: INSTRUCTIONS });
  registerTools(server, { config, readPool: database.readPool, writePool: database.writePool });
  await server.connect(new StdioServerTransport());
}

main().catch((err: unknown) => {
  console.error(`[mysql-mcp-server] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
