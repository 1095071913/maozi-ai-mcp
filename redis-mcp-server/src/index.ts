import {createRequire} from 'node:module';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {loadConfig} from './config.js';
import {Gateway} from './db.js';
import {encodeReply} from './reply.js';
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
async function check(config: ReturnType<typeof loadConfig>, gateway: Gateway): Promise<boolean> {
  // Shown in both outcomes: when the connection fails, the file that was read is the first question.
  const settingsLine = `  配置文件: ${config.envFile ?? '（未找到 .env，使用环境变量和默认值）'}`;
  try {
    const info = String(await gateway.run('INFO', ['server'], config.db));
    const version = /redis_version:(\S+)/.exec(info)?.[1] ?? '?';
    const mode = /redis_mode:(\S+)/.exec(info)?.[1] ?? '?';
    const role = (await gateway.run('ROLE', [], config.db)) as unknown[];
    const size = encodeReply(await gateway.run('DBSIZE', [], config.db));
    console.log(`✔ 已连接 Redis ${version}  ${config.host}:${config.port}  ${mode} / ${String(role[0])}`);
    console.log(settingsLine);
    console.log(`  默认数据库: ${config.db}（现有 ${size} 个键）`);
    console.log(`  写操作: ${config.readonly ? '已禁用 (REDIS_MCP_READONLY)' : '已启用'}`);
    console.log(`  单条命令等待上限: ${config.timeoutMs > 0 ? `${config.timeoutMs} ms` : '不限制'}`);
    return true;
  } catch (error) {
    console.error(`✘ 连接失败: ${describeError(error, config)}`);
    console.error(settingsLine);
    return false;
  }
}

async function main(): Promise<void> {
  const switches = parseArguments(process.argv.slice(2));
  const config = loadConfig(switches);
  const gateway = new Gateway(config);

  if (switches.check) {
    const healthy = await check(config, gateway);
    gateway.close();
    process.exit(healthy ? 0 : 1);
  }

  // stdout carries the MCP protocol, so diagnostics go to stderr (clients log it).
  const target = `${config.host}:${config.port}/${config.db}`;
  const settings = config.envFile ? ` (settings: ${config.envFile})` : '';
  console.error(`[redis-mcp-server] ${target} — ${config.readonly ? 'read-only' : 'read-write'}${settings}`);

  process.on('unhandledRejection', (error) => console.error('[redis-mcp-server] unhandled rejection:', error));
  const shutdown = (): void => {
    gateway.close();
    process.exit(0);
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, shutdown);
  // The client closing stdin means it is done with us: free the Redis connections instead of lingering.
  process.stdin.on('end', shutdown);

  const server = new McpServer({ name: 'redis-mcp-server', version }, { instructions: INSTRUCTIONS });
  registerTools(server, { config, gateway });
  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  console.error(`[redis-mcp-server] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
