# mysql-mcp-server

本地使用的 MySQL MCP server（stdio 传输）。Claude Code、ZCode 等 AI 客户端通过它查看库表结构、执行查询、增删改数据以及执行建表等 DDL。

## 提供的工具

| 工具 | 用途 | 会不会改数据 |
|---|---|---|
| `list_databases` | 列出当前账号可见的数据库（表数量、近似大小） | 否 |
| `list_tables` | 列出某个库的表和视图（行数估计、注释） | 否 |
| `describe_table` | 表的列、索引、外键 | 否 |
| `read_query` | 执行单条 `SELECT` / `SHOW` / `DESCRIBE` / `EXPLAIN` | 否（MySQL 层面强制只读） |
| `write_query` | 执行单条 `INSERT` / `UPDATE` / `DELETE` / `REPLACE` / `CREATE` / `ALTER` / `DROP` 等语句 | 是 |

## 环境要求

- Node.js ≥ 20.12（在 v24.13.1 上开发和验证）
- 一个能连上的 MySQL（在 MySQL 8.0.29 上验证，与你本地 `maozi-cloud-basic-mysql` 容器同一个镜像）

## 安装

```bash
cd /Users/maozi/maozi-cloud/maozi-ai-mcp/mysql-mcp-server
npm install
npm run build
```

## 配置数据库连接

`.env` 已按 `.env.example` 生成在项目目录下，填上你的 MySQL 密码即可（`.env` 已在 `.gitignore` 里，不会被提交）。各项含义：

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `MYSQL_HOST` | `127.0.0.1` | MySQL 地址 |
| `MYSQL_PORT` | `3306` | 端口 |
| `MYSQL_USER` | `root` | 用户名 |
| `MYSQL_PASSWORD` | 空 | 密码 |
| `MYSQL_DATABASE` | 不设置 | 不写库名的 SQL 默认用哪个库 |
| `MYSQL_MCP_READONLY` | `0` | 置为 `1` 则只提供 4 个只读工具，不提供 `write_query` |
| `MYSQL_MCP_QUERY_TIMEOUT_MS` | `60000` | `SELECT` 超过多少毫秒会被中止，`0` 表示不限制 |

几点说明：

- **配置只在服务启动时读取一次。** 改了 `.env` 之后要重启会话，让客户端重新拉起服务，否则仍在用旧配置。
- 密码里含有空格或 `#` 时要加引号，例如 `MYSQL_PASSWORD="p#ss word"`。
- 键名拼错或写成 `MYSQL_PASSWORD: xxx` 这种格式时，服务会**拒绝启动**并指出是哪一行，而不是悄悄用默认值去连别的库。
- 已经存在的环境变量优先于 `.env`，所以也可以把连接信息写在客户端的 MCP 配置 `env` 里，或者用 `export` 临时覆盖。

### 换一个配置文件：`--env-file`

默认读取服务目录下的 `.env`。想用别的文件（比如每个项目各一份），在启动参数里加上 `--env-file`：

```text
--env-file /absolute/path/to/.env      # 写成 --env-file=/absolute/path/to/.env 也可以
```

- 优先级：**环境变量 > `--env-file` 指定的文件 > 内置默认值**。指定了 `--env-file` 时默认的 `.env` 就不再读取，两个文件不会叠加，指向另一个库时不会混进默认文件里的地址和密码。
- 参数要写在脚本路径**之后**，由服务自己解析，同样有格式和键名校验。
- 相对路径按客户端启动服务时的工作目录解析，而这个目录随工作区变化，所以请写绝对路径。
- 文件不存在时拒绝启动；在 Node 24 上这时报错来自 Node 本身（`node: …: not found`，退出码 9）。参数名写错（如 `--env-fiel`）同样拒绝启动，不会被忽略后悄悄用回默认配置。

### 不用配置文件：写进客户端的 `env` 块

MCP 客户端的配置里可以直接带一个 `env` 块，键名与 `.env` 里的相同，服务会从环境变量读取。完整示例见下面 Claude Code 和 ZCode 两节，这里只看这一块：

```json
"env": {
  "MYSQL_HOST": "127.0.0.1",
  "MYSQL_PORT": "3306",
  "MYSQL_USER": "root",
  "MYSQL_PASSWORD": "你的密码",
  "MYSQL_DATABASE": "你的库名"
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

连接正常时输出类似这样（最后一行取决于你库里的实际情况）：

```text
✔ 已连接 MySQL 8.0.29  127.0.0.1:3306  账号 root@%
  配置文件: /Users/maozi/maozi-cloud/maozi-ai-mcp/mysql-mcp-server/.env
  默认数据库: （未设置，SQL 中需写 库名.表名）
  写操作: 已启用
  可见数据库 (5): app, information_schema, mysql, performance_schema, sys
```

第二行显示服务实际读取的是哪个配置文件（连接失败时也会显示）。

连接不上时会给出具体原因，常见的几种：

| 输出 | 原因 |
|---|---|
| `connection refused. Is the MySQL server running?` | 地址或端口不对，或 MySQL 没启动 |
| `MySQL rejected user "root": Access denied ...` | 用户名或密码不对；如果是在客户端里看到，而 `npm run check` 正常，说明服务是在你改 `.env` 之前启动的，重启会话 |
| `MySQL does not know the default database "xxx"` | `MYSQL_DATABASE` 填的库不存在 |
| `.env: this line is not KEY=VALUE ...` / `unknown setting ...` | `.env` 写错了，按提示的那一行修改 |
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

下面命令里的 node 路径是 nvm 管理的绝对路径，用 `which node` 可以查看你当前的路径。最后两个参数（`--env-file` 和配置文件路径）写明了用哪个 `.env`；省略它们则读取服务目录下默认的 `.env`。

### 方式一：用户级（所有项目都能用，推荐）

```bash
claude mcp add --scope user mysql -- \
  /Users/maozi/.nvm/versions/node/v24.13.1/bin/node \
  /Users/maozi/maozi-cloud/maozi-ai-mcp/mysql-mcp-server/dist/index.js \
  --env-file /Users/maozi/maozi-cloud/maozi-ai-mcp/mysql-mcp-server/.env
```

### 方式二：项目级 `.mcp.json`（随仓库共享给他人）

在项目根目录新建 `.mcp.json`：

```json
{
  "mcpServers": {
    "mysql": {
      "type": "stdio",
      "command": "/Users/maozi/.nvm/versions/node/v24.13.1/bin/node",
      "args": [
        "/Users/maozi/maozi-cloud/maozi-ai-mcp/mysql-mcp-server/dist/index.js",
        "--env-file",
        "/Users/maozi/maozi-cloud/maozi-ai-mcp/mysql-mcp-server/.env"
      ]
    }
  }
}
```

`.mcp.json` 里的服务首次使用时需要你在 Claude Code 里确认一次才会连接。

### 方式三：不用文件，连接信息用 `-e` 传环境变量

```bash
claude mcp add --scope user mysql \
  -e MYSQL_HOST=127.0.0.1 -e MYSQL_PORT=3306 -e MYSQL_USER=root \
  -e MYSQL_PASSWORD=你的密码 -e MYSQL_DATABASE=你的库名 \
  -- /Users/maozi/.nvm/versions/node/v24.13.1/bin/node \
     /Users/maozi/maozi-cloud/maozi-ai-mcp/mysql-mcp-server/dist/index.js
```

`.mcp.json` 里对应的写法，是在服务下加一个 `"env": { "MYSQL_HOST": "…", "MYSQL_PASSWORD": "…" }` 块。环境变量优先于 `.env`，用这种方式时建议把服务目录下的 `.env` 删掉。

### 验证与管理

```bash
claude mcp list                    # 应能看到 mysql，状态为 Connected
claude mcp get mysql               # 查看详情
claude mcp remove mysql            # 移除（-s user 指定作用域）
```

进入 `claude` 会话后输入 `/mcp` 也能看到连接状态。工具在会话里的名字是 `mcp__mysql__read_query`、`mcp__mysql__write_query` 等。

## 在 ZCode 中使用

### 方式一：设置界面

打开 **Settings → MCP**，新增一个 stdio 类型的服务，`Command` 填第一行，`Args` 里依次填后三行（`--env-file` 和路径是两个独立的参数）：

```text
/Users/maozi/.nvm/versions/node/v24.13.1/bin/node
/Users/maozi/maozi-cloud/maozi-ai-mcp/mysql-mcp-server/dist/index.js
--env-file
/Users/maozi/maozi-cloud/maozi-ai-mcp/mysql-mcp-server/.env
```

数据库密码由 `--env-file` 指向的文件提供，不需要写进这里。最后两个参数可以省略，省略时读取服务目录下默认的 `.env`。

### 方式二：用户级配置文件（所有工作区都能用）

编辑 `~/.zcode/cli/config.json`（文件不存在就新建），在 `mcp.servers` 下加一项：

```json
{
  "mcp": {
    "servers": {
      "mysql": {
        "type": "stdio",
        "command": "/Users/maozi/.nvm/versions/node/v24.13.1/bin/node",
        "args": [
          "/Users/maozi/maozi-cloud/maozi-ai-mcp/mysql-mcp-server/dist/index.js",
          "--env-file",
          "/Users/maozi/maozi-cloud/maozi-ai-mcp/mysql-mcp-server/.env"
        ]
      }
    }
  }
}
```

### 方式三：不用文件，连接信息写进 `env` 块

编辑 `~/.zcode/cli/config.json`，把 `args` 里的 `--env-file` 两项去掉，改用 `env` 块：

```json
{
  "mcp": {
    "servers": {
      "mysql": {
        "type": "stdio",
        "command": "/Users/maozi/.nvm/versions/node/v24.13.1/bin/node",
        "args": ["/Users/maozi/maozi-cloud/maozi-ai-mcp/mysql-mcp-server/dist/index.js"],
        "env": {
          "MYSQL_HOST": "127.0.0.1",
          "MYSQL_PORT": "3306",
          "MYSQL_USER": "root",
          "MYSQL_PASSWORD": "你的密码",
          "MYSQL_DATABASE": "你的库名"
        }
      }
    }
  }
}
```

`type` 写不写都可以，有 `command` 时 ZCode 会按 stdio 处理。环境变量优先于 `.env`，用这种方式时建议把服务目录下的 `.env` 删掉。

### 方式四：工作区级（只对某个项目生效）

在项目里新建 `<项目>/.zcode/config.json`，内容与方式二相同。这种方式最适合让每个项目用自己的配置文件：把 `--env-file` 后面的路径换成该项目自己的 `.env` 即可。

### 注意事项

- **必须写绝对路径**：ZCode 不会展开 `${...}` 变量，而且桌面应用启动时未必有 nvm 的 PATH，写 `node` 可能报 `spawn node ENOENT`。
- **配置项名称是严格的**：只接受 `type`、`command`、`args`、`env`、`cwd`、`enabled`、`timeoutMs`，写错一个键整个服务会被忽略。
- 修改后需要**重启会话**（必要时重启 ZCode）才会生效，然后在 **Settings → MCP** 查看状态，连接失败时错误会直接显示在那里。
- 同名的服务，用户级配置会覆盖工作区级配置。
- 工具在会话里的名字是 `mcp__mysql__read_query`、`mcp__mysql__write_query` 等。

## 使用示例

配置好之后，直接在 Claude Code 或 ZCode 里用自然语言说即可，例如：

- 「本地有哪些数据库？`app` 库里有哪些表？」
- 「看一下 `users` 表的结构」
- 「查一下最近 7 天注册的用户，按时间倒序，只看前 20 条」
- 「往 `users` 表插一条数据：name 张三，email zhang@example.com」
- 「把 id 为 5 的用户状态改成 disabled」
- 「`users` 表加一个 `phone` 字段，varchar(20)，允许为空」
- 「清空 `logs` 表」——这属于危险语句，AI 会先把语句给你看，你确认后才会执行

模型实际调用工具时大致是这样：

```jsonc
// 查
{ "sql": "SELECT * FROM users WHERE created_at > ? ORDER BY id DESC", "params": ["2026-11-16"], "limit": 20 }
// → {"columns":["id","name","…"],"row_count":20,"truncated":true,"elapsed_ms":2,"rows":[…]}

// 增
{ "sql": "INSERT INTO users (name, email) VALUES (?, ?)", "params": ["张三", "zhang@example.com"] }
// → {"affected_rows":1,"insert_id":42,"elapsed_ms":3}

// 改（affected_rows 是匹配到的行数，changed_rows 是真正发生变化的行数）
{ "sql": "UPDATE users SET status = ? WHERE id = ?", "params": ["disabled", 5] }
// → {"affected_rows":1,"changed_rows":1,"elapsed_ms":2}

// 删（危险语句必须带 confirm，否则会被拒绝并把原因返回给模型）
{ "sql": "TRUNCATE TABLE logs", "confirm": true }
```

返回值里的类型约定：

- `INT` 类是数字；`DECIMAL`、`BIGINT`（包括 `COUNT(*)`、整数常量）是**字符串**，避免金额和雪花 ID 丢精度。
- `DATETIME` / `TIMESTAMP` 按库里存储的原文返回，不做时区转换。
- `JSON` 列返回为嵌套的 JSON 值。
- 查询里出现同名列（如 `SELECT u.id, o.id`）时，两列都会带上别名，返回 `u.id`、`o.id`。

## 安全机制

| 机制 | 说明 |
|---|---|
| 读写分离 | `read_query` 在 MySQL 的 `READ ONLY` 事务里执行，即使语句伪装成查询（如 `WITH … DELETE`、`EXPLAIN ANALYZE DELETE`）也会被 MySQL 拒绝 |
| 危险语句需确认 | 没有 `WHERE` 的 `UPDATE`/`DELETE`、`WHERE 1=1`、`DROP`、`TRUNCATE`、`ALTER … DROP` 必须带 `confirm: true` 才会执行 |
| 一次一条语句 | 驱动层关闭了多语句，`;` 后面再跟一条会被 MySQL 拒绝 |
| 不支持会话级语句 | `USE`、`SET`、事务控制、临时表、`KILL`、`SHUTDOWN` 等都不执行（连接是池化复用的，会话状态会串到别的调用上） |
| 行数上限 | 默认最多返回 100 行，最多可指定 1000 行，超出时 `truncated: true`；上限由 MySQL 在服务端截断，大表不会被整个拉进内存 |
| 结果体积保护 | 单个超长值截断到 2000 字符；结果整体超过约 100 KB 时拒绝返回，并提示缩小查询范围 |
| 查询超时 | `SELECT` 默认超过 60 秒被 MySQL 中止（可用 `MYSQL_MCP_QUERY_TIMEOUT_MS` 调整） |
| 只读模式 | `MYSQL_MCP_READONLY=1` 时不提供 `write_query` |
| 连接失效自愈 | 空闲连接断开后，读操作自动换一条连接重试一次；写操作不重试，并提示先用读操作确认是否已生效 |

这些机制针对的是「AI 手滑」和「写错条件」，并不能替代备份。对重要数据请先备份，或者用只读模式。

## 测试

```bash
npm run test:e2e
```

会以 MCP 客户端的方式真实拉起服务，跑完整的增删改查、安全守卫、连接恢复、`--env-file`、`env` 块等 29 项用例。测试会自己创建并删除名为 `_mcp_e2e_<进程号>` 的临时数据库，不碰其他库；默认只允许连本机地址，连其他主机需要设置 `E2E_ALLOW_REMOTE=yes`。连接信息同样取自环境变量和 `.env`。

## 已知限制

- 每次调用只执行一条语句，各自立即提交，**没有事务**。需要多条语句要么全成功要么全失败时，请让 AI 把语句列出来，由你在 MySQL 客户端里包在事务中执行。
- 不支持 `CREATE TEMPORARY TABLE`，因为临时表只在一条池化连接上可见。
- 查询超时只对 `SELECT` 生效；`SLEEP()`、`BENCHMARK()` 这类函数被超时打断时返回的是结果而不是错误。`UPDATE`/`DELETE` 没有超时限制。
- 危险语句的判定基于关键字，偏保守：偶尔会要求一次不必要的确认（比如列名恰好叫 `drop`）。
- 验证范围：MySQL 8.0.29。服务本身用官方 SDK 的 stdio 客户端驱动跑过 29 项用例；在真实的 ZCode 会话里确认过 ZCode 能拉起服务、工具调用能往返，但那一次调用因为服务启动时 `.env` 里还没有密码而被 MySQL 拒绝。ZCode 里的完整读写流程、Claude Code、MySQL 5.7 / MariaDB 都还没有实际跑过。

## 目录结构

```text
mysql-mcp-server/
├── src/
│   ├── config.ts       连接配置：环境变量 → --env-file 指定的文件或 .env → 默认值
│   ├── sql-guard.ts    语句分类（读 / 写 / 危险 / 不支持）
│   ├── db.ts           连接池、只读事务、行数上限、失效重试
│   ├── tools.ts        5 个 MCP 工具的定义和处理
│   └── index.ts        入口：解析启动参数、启动服务、--check
├── dist/               npm run build 的产物，客户端配置里指向这里
├── test/e2e.mjs        端到端测试
├── .env                数据库连接信息（不提交）
└── .env.example
```

修改源码后执行 `npm run build`，再重启 Claude Code / ZCode 的会话即可生效。
