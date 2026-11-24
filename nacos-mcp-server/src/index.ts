import {createRequire} from 'node:module';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {Api} from './api.js';
import {loadConfig} from './config.js';
import {isEmbeddedStore} from './nacos.js';
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
async function check(config: ReturnType<typeof loadConfig>, api: Api): Promise<boolean> {
  // Shown in both outcomes: when the connection fails, the file that was read is the first question.
  const settingsLine = `  配置文件: ${config.envFile ?? '（未找到 .env，使用环境变量和默认值）'}`;
  try {
    // Server state is public even on a server with authentication switched on.
    const state = await api.json('GET', 'v1/console/server/state');
    const authEnabled = String(state.auth_enabled) === 'true';
    let namespaces: { id: string; name: string; configCount: number }[] = [];
    let warning: string | undefined;
    if (config.username || !authEnabled) {
      if (config.username) {
        // The namespace list is public too; this one is answered only with a valid token.
        await api.call('GET', 'v1/cs/configs', { query: { search: 'blur', dataId: '*', group: '*', pageNo: 1, pageSize: 1 } });
      }
      try {
        namespaces = await api.namespaces();
      } catch (error) {
        // A server on the embedded Derby store is connected all the same; it just cannot list its namespaces.
        if (!isEmbeddedStore(error)) throw error;
        warning =
          '⚠ 该 Nacos 使用内嵌 Derby 存储，它自己无法列出命名空间：这里只能操作 public 命名空间，要使用其他命名空间需改用 MySQL 存储';
      }
    }
    console.log(
      `✔ 已连接 Nacos ${String(state.version ?? '?')}  ${config.address}  （${String(state.startup_mode ?? '?')}，${authEnabled ? '已开启鉴权' : '未开启鉴权'}）`,
    );
    console.log(settingsLine);
    console.log(`  账号: ${config.username ? `${config.username}（令牌有效）` : '未配置'}`);
    console.log(
      `  命名空间 (${namespaces.length}): ${namespaces.length ? namespaces.map((item) => item.name).join(', ') : warning ? '（该服务器无法列出）' : '（无权查看）'}`,
    );
    console.log(`  写操作: ${config.readonly ? '已禁用 (NACOS_MCP_READONLY)' : '已启用'}`);
    console.log(`  单次请求超时: ${config.timeoutMs > 0 ? `${config.timeoutMs} ms` : '不限制'}`);
    if (!config.username && authEnabled) {
      console.log('  ⚠ 该 Nacos 开启了鉴权：请在 .env 里填写 NACOS_USERNAME 和 NACOS_PASSWORD，否则所有操作都会被拒绝');
    }
    if (warning) console.log(`  ${warning}`);
    return true;
  } catch (error) {
    console.error(`✘ 连接失败: ${describeError(error)}`);
    console.error(settingsLine);
    return false;
  }
}

async function main(): Promise<void> {
  const switches = parseArguments(process.argv.slice(2));
  const config = loadConfig(switches);
  const api = new Api(config);

  if (switches.check) {
    const healthy = await check(config, api);
    process.exit(healthy ? 0 : 1);
  }

  // stdout carries the MCP protocol, so diagnostics go to stderr (clients log it).
  const settings = config.envFile ? ` (settings: ${config.envFile})` : '';
  console.error(
    `[nacos-mcp-server] ${config.address}${config.username ? ` as ${config.username}` : ''} — ${config.readonly ? 'read-only' : 'read-write'}${settings}`,
  );

  process.on('unhandledRejection', (error) => console.error('[nacos-mcp-server] unhandled rejection:', error));
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => process.exit(0));
  // The client closing stdin means it is done with us.
  process.stdin.on('end', () => process.exit(0));

  const server = new McpServer({ name: 'nacos-mcp-server', version }, { instructions: INSTRUCTIONS });
  registerTools(server, { config, api });
  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  console.error(`[nacos-mcp-server] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
