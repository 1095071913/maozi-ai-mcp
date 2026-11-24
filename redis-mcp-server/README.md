# redis-mcp-server

本地使用的 Redis MCP server（stdio 传输）。Claude Code、ZCode 等 AI 客户端通过它执行 Redis 命令、分页浏览 key。除少数几类天然不适合「一问一答」的命令外，所有 Redis 命令都可以执行。

## 提供的工具

| 工具 | 用途 | 会不会改数据 |
|---|---|---|
| `read_command` | 执行一条只读命令：`GET`、`HGETALL`、`LRANGE`、`SMEMBERS`、`ZRANGE`、`SCAN`、`TTL`、`TYPE`、`INFO`、`CONFIG GET` 等 | 否 |
| `write_command` | 执行任意一条命令：`SET`、`DEL`、`INCR`、`LPUSH`、`HSET`、`EXPIRE`、`EVAL`、`CONFIG SET` 等 | 是 |
| `scan_keys` | 分页扫描某个库的 key，每个 key 带类型、TTL 和大小 | 否 |

## 环境要求

- Node.js ≥ 20.12（在 v24.13.1 上开发和验证）
- 一个能连上的单机 Redis（在 Redis 6.2.6 上验证，与你本地 `maozi-cloud-basic-redis` 容器同一个镜像）

## 安装

```bash
cd /Users/maozi/maozi-cloud/maozi-ai-mcp/redis-mcp-server
npm install
npm run build
```

## 配置数据库连接

`.env` 已按 `.env.example` 生成在项目目录下，填上你的 Redis 密码即可（`.env` 已在 `.gitignore` 里，不会被提交）。各项含义：

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `REDIS_HOST` | `127.0.0.1` | Redis 地址 |
| `REDIS_PORT` | `6379` | 端口 |
| `REDIS_PASSWORD` | 不设置 | 密码 |
| `REDIS_USER` | 不设置 | 仅在使用 ACL 用户（而不是 `default` 用户）时填写 |
| `REDIS_DB` | `0` | 不带 `db` 参数的命令默认用哪个库 |
| `REDIS_MCP_READONLY` | `0` | 置为 `1` 则不提供 `write_command`，只保留两个只读工具 |
| `REDIS_MCP_TIMEOUT_MS` | `30000` | 单条命令等待回复的上限，`0` 表示不限制 |

几点说明：

- **配置只在服务启动时读取一次。** 改了 `.env` 之后要重启会话，让客户端重新拉起服务，否则仍在用旧配置。
- 密码里含有空格或 `#` 时要加引号，例如 `REDIS_PASSWORD="p#ss word"`。
- 键名拼错或写成 `REDIS_PASSWORD: xxx` 这种格式时，服务会**拒绝启动**并指出是哪一行，而不是悄悄用默认值去连别的服务器。
- 已经存在的环境变量优先于 `.env`，所以也可以把连接信息写在客户端的 MCP 配置 `env` 里，或者用 `export` 临时覆盖。

### 换一个配置文件：`--env-file`

默认读取服务目录下的 `.env`。想用别的文件（比如每个项目各一份），在启动参数里加上 `--env-file`：

```text
--env-file /absolute/path/to/.env      # 写成 --env-file=/absolute/path/to/.env 也可以
```

- 优先级：**环境变量 > `--env-file` 指定的文件 > 内置默认值**。指定了 `--env-file` 时默认的 `.env` 就不再读取，两个文件不会叠加，指向另一台 Redis 时不会混进默认文件里的地址和密码。
- 参数要写在脚本路径**之后**，由服务自己解析，同样有格式和键名校验。
- 相对路径按客户端启动服务时的工作目录解析，而这个目录随工作区变化，所以请写绝对路径。
- 文件不存在时拒绝启动；在 Node 24 上这时报错来自 Node 本身（`node: …: not found`，退出码 9）。参数名写错（如 `--env-fiel`）同样拒绝启动，不会被忽略后悄悄用回默认配置。

### 不用配置文件：写进客户端的 `env` 块

MCP 客户端的配置里可以直接带一个 `env` 块，键名与 `.env` 里的相同，服务会从环境变量读取。完整示例见下面 Claude Code 和 ZCode 两节，这里只看这一块：

```json
"env": {
  "REDIS_HOST": "127.0.0.1",
  "REDIS_PORT": "6379",
  "REDIS_PASSWORD": "你的密码",
  "REDIS_DB": "0"
}
```

- 优先级不变：**环境变量 > `.env` > 默认值**。`env` 里写了的键以 `env` 为准；没写的键仍然从服务目录的 `.env` 取（如果这个文件存在）。
- 因此连接信息最好只放一处。改用 `env` 之后，可以把服务目录下的 `.env` 删掉，免得改了一处忘另一处。
- 这种写法下密码会明文保存在客户端的配置文件里（ZCode 是 `~/.zcode/cli/config.json`）；用 `.env` 文件则不会。两种方式服务都支持，按你的习惯选。

## 验证连接

```bash
npm run check                                    # 用默认的 .env
npm run check -- --env-file /path/to/other.env   # 用 --env-file 指定的文件
```

连接正常时输出类似这样（键的数量取决于你的库）：

```text
✔ 已连接 Redis 6.2.6  127.0.0.1:6379  standalone / master
  配置文件: /Users/maozi/maozi-cloud/maozi-ai-mcp/redis-mcp-server/.env
  默认数据库: 0（现有 128 个键）
  写操作: 已启用
  单条命令等待上限: 30000 ms
```

第二行显示服务实际读取的是哪个配置文件（连接失败时也会显示）。

连接不上时会给出具体原因，常见的几种：

| 输出 | 原因 |
|---|---|
| `Cannot connect to Redis at 127.0.0.1:6379: connection refused. Is the Redis server running?` | 地址或端口不对，或 Redis 没启动 |
| `Redis rejected the credentials: WRONGPASS …` | 密码（或 `REDIS_USER`）不对；如果是在客户端里看到，而 `npm run check` 正常，说明服务是在你改 `.env` 之前启动的，重启会话 |
| `Redis requires a password and none was accepted: NOAUTH …` | 没有填密码 |
| `Redis refused the permission: NOPERM …` | 该 ACL 用户没有执行这条命令的权限 |
| `Redis did not answer … within 30000 ms` | 命令超时，可调大 `REDIS_MCP_TIMEOUT_MS` |
| `.env: this line is not KEY=VALUE …` / `unknown setting …` | `.env` 写错了，按提示的那一行修改 |
| `node: …/.env: not found` | `--env-file` 指向的文件不存在 |

## 如何启动

这是一个 stdio 类型的 MCP 服务，**不需要也不应该手动常驻启动**：Claude Code / ZCode 会在会话开始时自动拉起它，会话结束时自动退出。

需要手动调试时可以这样：

```bash
node dist/index.js                           # 启动后停在那里等待 stdin 上的 MCP 协议消息，Ctrl+C 退出
node dist/index.js --env-file /path/to/.env  # 同上，读取指定的配置文件
npm run check                                # 只检查数据库连接，不启动服务
```

服务只认识 `--env-file <路径>` 和 `--check` 两个参数，写别的会拒绝启动。注意 stdout 承载 MCP 协议，所以服务只往 stderr 写日志。

## 在 Claude Code 中使用

下面命令里的 node 路径是 nvm 管理的绝对路径，用 `which node` 可以查看你当前的路径。

### 方式一：用户级（所有项目都能用，推荐）

```bash
claude mcp add --scope user redis -- \
  /Users/maozi/.nvm/versions/node/v24.13.1/bin/node \
  /Users/maozi/maozi-cloud/maozi-ai-mcp/redis-mcp-server/dist/index.js \
  --env-file /Users/maozi/maozi-cloud/maozi-ai-mcp/redis-mcp-server/.env
```

### 方式二：项目级 `.mcp.json`（随仓库共享给他人）

在项目根目录新建 `.mcp.json`：

```json
{
  "mcpServers": {
    "redis": {
      "type": "stdio",
      "command": "/Users/maozi/.nvm/versions/node/v24.13.1/bin/node",
      "args": [
        "/Users/maozi/maozi-cloud/maozi-ai-mcp/redis-mcp-server/dist/index.js",
        "--env-file",
        "/Users/maozi/maozi-cloud/maozi-ai-mcp/redis-mcp-server/.env"
      ]
    }
  }
}
```

`.mcp.json` 里的服务首次使用时需要你在 Claude Code 里确认一次才会连接。最后两个参数可以省略，省略时读取服务目录下默认的 `.env`。

### 方式三：不用文件，连接信息用 `-e` 传环境变量

```bash
claude mcp add --scope user redis \
  -e REDIS_HOST=127.0.0.1 -e REDIS_PORT=6379 -e REDIS_PASSWORD=你的密码 -e REDIS_DB=0 \
  -- /Users/maozi/.nvm/versions/node/v24.13.1/bin/node \
     /Users/maozi/maozi-cloud/maozi-ai-mcp/redis-mcp-server/dist/index.js
```

`.mcp.json` 里对应的写法，是在服务下加一个 `"env": { "REDIS_HOST": "…", "REDIS_PASSWORD": "…" }` 块。

### 验证与管理

```bash
claude mcp list                    # 应能看到 redis，状态为 Connected
claude mcp get redis               # 查看详情
claude mcp remove redis            # 移除（-s user 指定作用域）
```

进入 `claude` 会话后输入 `/mcp` 也能看到连接状态。工具在会话里的名字是 `mcp__redis__read_command`、`mcp__redis__write_command`、`mcp__redis__scan_keys`。

## 在 ZCode 中使用

### 方式一：设置界面

打开 **Settings → MCP**，新增一个 stdio 类型的服务，`Command` 填第一行，`Args` 里依次填后几行：

```text
/Users/maozi/.nvm/versions/node/v24.13.1/bin/node
/Users/maozi/maozi-cloud/maozi-ai-mcp/redis-mcp-server/dist/index.js
--env-file
/Users/maozi/maozi-cloud/maozi-ai-mcp/redis-mcp-server/.env
```

连接信息由 `--env-file` 指向的文件提供。最后两个参数可以省略，省略时读取服务目录下默认的 `.env`。

### 方式二：用户级配置文件（所有工作区都能用）

编辑 `~/.zcode/cli/config.json`，在 `mcp.servers` 下加一项：

```json
{
  "mcp": {
    "servers": {
      "redis": {
        "type": "stdio",
        "command": "/Users/maozi/.nvm/versions/node/v24.13.1/bin/node",
        "args": [
          "/Users/maozi/maozi-cloud/maozi-ai-mcp/redis-mcp-server/dist/index.js",
          "--env-file",
          "/Users/maozi/maozi-cloud/maozi-ai-mcp/redis-mcp-server/.env"
        ]
      }
    }
  }
}
```

这个文件里已经有 `mysql` 的话，把 `redis` 这一项加到同一个 `mcp.servers` 下面即可。

### 方式三：不用文件，连接信息写进 `env` 块

```json
{
  "mcp": {
    "servers": {
      "redis": {
        "type": "stdio",
        "command": "/Users/maozi/.nvm/versions/node/v24.13.1/bin/node",
        "args": ["/Users/maozi/maozi-cloud/maozi-ai-mcp/redis-mcp-server/dist/index.js"],
        "env": {
          "REDIS_HOST": "127.0.0.1",
          "REDIS_PORT": "6379",
          "REDIS_PASSWORD": "你的密码",
          "REDIS_DB": "0"
        }
      }
    }
  }
}
```

### 方式四：工作区级（只对某个项目生效）

在项目里新建 `<项目>/.zcode/config.json`，内容与方式二相同。这种方式最适合让每个项目用自己的配置文件：把 `--env-file` 后面的路径换成该项目自己的 `.env` 即可。

### 注意事项

- **必须写绝对路径**：ZCode 不会展开 `${...}` 变量，而且桌面应用启动时未必有 nvm 的 PATH，写 `node` 可能报 `spawn node ENOENT`。
- **配置项名称是严格的**：只接受 `type`、`command`、`args`、`env`、`cwd`、`enabled`、`timeoutMs`，写错一个键整个服务会被忽略。
- 修改后需要**重启会话**（必要时重启 ZCode）才会生效，然后在 **Settings → MCP** 查看状态，连接失败时错误会直接显示在那里。
- 同名的服务，用户级配置会覆盖工作区级配置。
- 工具在会话里的名字是 `mcp__redis__read_command`、`mcp__redis__write_command`、`mcp__redis__scan_keys`。

## 使用示例

配置好之后，直接在 Claude Code 或 ZCode 里用自然语言说即可，例如：

- 「Redis 里有哪些 key？看看 `user:*` 开头的」
- 「`user:1` 这个 key 是什么类型、还剩多久过期、里面有什么」
- 「把 `config:timeout` 设成 30，过期时间 1 小时」
- 「`counter` 加 5」
- 「往 `queue` 列表左边压入三个任务」
- 「清空 3 号库」——这属于危险命令，AI 会先把命令给你看，你确认后才会执行

模型实际调用工具时大致是这样：

```jsonc
// 查
{ "command": "GET",     "args": ["user:1"] }              // → {"db":0,"result":"…","elapsed_ms":1}
{ "command": "HGETALL", "args": ["user:1"] }              // → {"db":0,"result":{"name":"张三","age":"30"},"elapsed_ms":1}
{ "command": "LRANGE",  "args": ["queue", "0", "9"], "limit": 10 }
{ "command": "CONFIG GET", "args": ["maxmemory"] }        // → {"db":0,"result":{"maxmemory":"0"},"elapsed_ms":1}

// 增 / 改 / 删（危险命令必须带 confirm，否则会被拒绝并把原因返回给模型）
{ "command": "SET",  "args": ["k", "v", "EX", "60"] }     // → {"db":0,"result":"OK","elapsed_ms":1}
{ "command": "INCR", "args": ["counter"] }                // → {"db":0,"result":1,"elapsed_ms":1}
{ "command": "DEL",  "args": ["k"] }                      // → {"db":0,"result":1,"elapsed_ms":1}

// 分页扫描（cursor 原样传回即可取下一页，"0" 表示已经扫完）
{ "pattern": "user:*", "limit": 100 }
// → {"db":0,"cursor":"0","count":3,"keys":[{"key":"user:1","type":"hash","ttl":-1,"bytes":72}, …],"elapsed_ms":2}
```

`command` 里可以只写命令名、把子命令放进 `args`（`"command": "CONFIG", "args": ["GET", "maxmemory"]`），也可以写成 `"command": "CONFIG GET"`，两种写法效果一样。

返回值里的约定：

- 文本值返回字符串；**数值型回复**（计数、`INCR` 的结果、分数等）返回数字，只有超过 2^53 的整数保留原始文本以免丢精度。像 `"123"` 这样存成字符串的值仍然是字符串。
- `HGETALL`、`CONFIG GET`、`MEMORY STATS`、`XINFO STREAM`、`ACL GETUSER` 这种「字段-值」形式的回复会转成对象。
- **二进制值**（例如 JDK 序列化、protobuf 的内容）不会被当成文本弄坏，而是返回 `{ base64, bytes, preview }`：`bytes` 是长度，`preview` 是开头若干字节的转义形式，方便认出格式。写入二进制用 `{ "base64": "…" }` 作为参数。
- 超过 4000 字符的值会被截断并注明还剩多少；需要完整内容时用 `GETRANGE` 之类的命令分段读取。

## 支持与不支持的命令

| 类别 | 处理方式 |
|---|---|
| 字符串、哈希、列表、集合、有序集合、位图、HyperLogLog、GEO、Stream | 全部支持 |
| 脚本（`EVAL`、`EVALSHA`、`SCRIPT`、`FUNCTION`）、`PUBLISH`、`SORT`、`DUMP`/`RESTORE`、`MIGRATE` | 支持 |
| 阻塞命令（`BLPOP`、`BRPOP`、`BLMOVE`、`XREAD BLOCK` 等） | 支持，但走一条独立的临时连接，最多等待 `REDIS_MCP_TIMEOUT_MS`，到时断开并报超时，不影响其他调用 |
| 订阅与监视：`SUBSCRIBE`、`PSUBSCRIBE`、`MONITOR` | 不支持。它们会持续输出消息，一次调用返回不了 |
| 事务：`MULTI`、`EXEC`、`DISCARD`、`WATCH` | 不支持。每次调用只有一条命令；需要原子性用 `EVAL` |
| 连接级：`SELECT`、`AUTH`、`HELLO`、`RESET`、`QUIT`、`CLIENT REPLY` | 不支持。库用 `db` 参数选，凭据来自配置 |
| 主从同步：`SYNC`、`PSYNC`、`REPLCONF` | 不支持 |
| 模块命令（如 RedisJSON 的 `JSON.GET`） | 只能通过 `write_command` 执行：服务不认识它们，不敢按只读放行 |

## 安全机制

| 机制 | 说明 |
|---|---|
| 读写分离 | `read_command` 只执行 Redis 官方命令表里标记为只读的命令，外加一份 `INFO`、`CONFIG GET` 这类信息命令的白名单。命令名是独立字段而不是一段要解析的文本，所以写操作无法伪装成读 |
| 危险命令需确认 | `FLUSHALL`、`FLUSHDB`、`SHUTDOWN`、`DEBUG`、`CONFIG SET/RESETSTAT/REWRITE`、`REPLICAOF`、`ACL` 的用户管理、`CLIENT KILL/PAUSE`、`SWAPDB`、`MODULE` 加载卸载、`FUNCTION FLUSH/DELETE/RESTORE`、改变集群状态的 `CLUSTER` 命令，必须带 `confirm: true` 才会执行 |
| 不重发写命令 | 连接在命令执行途中断开时，驱动默认会在重连后把命令**再发一遍**，对写操作可能造成重复执行。这里关掉了该行为：写命令报错并提示「可能已执行，请先确认」；只读命令在连接中断时自动重试一次 |
| 阻塞命令隔离 | 阻塞命令使用独立连接，并受等待上限约束 |
| 结果保护 | 数组回复默认最多 200 个元素（最多可指定 2000），超出时 `truncated` 说明总数；单个值截断到 4000 字符；整体超过约 100 KB 时拒绝返回并提示缩小范围 |
| 只读模式 | `REDIS_MCP_READONLY=1` 时不提供 `write_command` |
| 连接恢复 | 连接被服务端断开或 Redis 重启后，后续调用自动重连，不需要重启服务 |

这些机制针对的是「AI 手滑」，并不能替代备份。对重要数据请先备份，或者用只读模式。

## 测试

```bash
npm run test:e2e
```

会以 MCP 客户端的方式真实拉起服务，跑 23 项用例：增删改查、各种数据结构、二进制往返、命令分类、危险命令拦截、阻塞命令、连接恢复、配置解析等。

测试只在自己创建的 key 上操作（名字以 `mcp:e2e:<进程号>:` 开头，位于 14 号和 15 号库），结束时删除这些 key，不使用 `FLUSH`。默认只允许连本机地址，连其他主机需要设置 `E2E_ALLOW_REMOTE=yes`。

最后一项 `SHUTDOWN` 用例默认跳过。只有明确设置 `E2E_DISPOSABLE_REDIS=yes` 时才会执行，它会 `FLUSHDB` 15 号库并关闭整个 Redis，所以**只能对一次性的实例使用**。

## 已知限制

- 每次调用只执行一条命令，**没有事务**。需要多条命令一起成功或一起失败时，用 `EVAL` 写成 Lua 脚本。
- 不支持集群和哨兵模式，只支持单机。
- `KEYS` 可以执行，但 key 很多时会阻塞 Redis，优先用 `scan_keys`。同理，对超大集合做无范围的查询（如对百万级列表 `LRANGE 0 -1`）会先把整个结果读进服务进程的内存，再截断返回。
- 等待超时只约束「等回复」这一步：超时后服务会断开连接，Redis 随之中止该连接上未完成的命令。
- 验证范围：Redis 6.2.6（单机、`default` 用户、密码登录），以及用官方 SDK 的 stdio 客户端驱动。Redis 7/8、ACL 非 `default` 用户、Redis 模块命令，以及真实的 Claude Code / ZCode 会话都还没有实际跑过。

## 目录结构

```text
redis-mcp-server/
├── src/
│   ├── config.ts       连接配置：环境变量 → --env-file 指定的文件或 .env → 默认值
│   ├── classify.ts     命令分类（只读 / 写 / 危险 / 不支持 / 阻塞），依据 Redis 官方命令标记
│   ├── reply.ts        参数解码（含 base64）与回复编码（文本 / 二进制 / 数字）
│   ├── db.ts           连接管理：共享连接、阻塞命令的独立连接、超时、SHUTDOWN
│   ├── tools.ts        3 个 MCP 工具的定义和处理
│   └── index.ts        入口：解析启动参数、启动服务、--check
├── dist/               npm run build 的产物，客户端配置里指向这里
├── test/e2e.mjs        端到端测试
├── .env                连接信息（不提交）
└── .env.example
```

修改源码后执行 `npm run build`，再重启 Claude Code / ZCode 的会话即可生效。
