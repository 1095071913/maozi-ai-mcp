# nacos-mcp-server

本地使用的 Nacos MCP server（stdio 传输）。Claude Code、ZCode 等 AI 客户端通过它管理 Nacos 的命名空间、服务、实例和配置，其余 Nacos 接口也都能调用。

## 提供的工具

| 工具 | 用途 | 改数据 |
|---|---|---|
| `list_namespaces` | 列出命名空间 | 否 |
| `list_services` | 列出某个命名空间下所有分组的服务，带集群数和实例数 | 否 |
| `describe_service` | 服务的设置、集群和**全部**实例（含已停用的），以及订阅者数量 | 否 |
| `list_configs` | 列出配置（不含内容） | 否 |
| `get_config` | 读一条配置：内容、格式、md5、创建和修改信息 | 否 |
| `config_history` | 列出一条配置被替换过的历史版本 | 否 |
| `read_request` | 对 Nacos 接口发任意 GET 请求：集群节点、监控指标、监听者、订阅者、用户和角色、导出等 | 否 |
| `save_namespace` | 新建命名空间，或修改已有命名空间的名称和描述 | 是 |
| `delete_namespace` | 删除命名空间（必须为空） | 是 |
| `save_service` | 新建服务，或修改保护阈值、元数据、选择器 | 是 |
| `delete_service` | 删除服务（必须没有实例） | 是 |
| `register_instance` | 注册实例 | 是 |
| `update_instance` | 修改实例的权重、是否启用、元数据 | 是 |
| `deregister_instance` | 摘除实例 | 是 |
| `publish_config` | 发布配置（新建或替换内容） | 是 |
| `delete_config` | 删除配置 | 是 |
| `request` | 对 Nacos 接口发任意请求（POST、PUT、DELETE 等），覆盖其余所有操作：导入导出、克隆、交换机、用户和权限、集群等 | 是 |

## 环境要求

- Node.js ≥ 20.12（在 v24.13.1 上开发和验证）
- 一个能连上的 Nacos。在 Nacos 2.4.2 单机模式上验证，覆盖三种部署：MySQL 存储不开鉴权、MySQL 存储开鉴权、内嵌 Derby 存储（与你本地 `maozi-cloud-basic-nacos` 容器同一个镜像）

## 安装

```bash
cd /Users/maozi/maozi-cloud/maozi-ai-mcp/nacos-mcp-server
npm install
npm run build
```

## 配置连接

`.env` 已按 `.env.example` 生成在项目目录下，默认指向 `http://127.0.0.1:8848/nacos`，按需要修改（`.env` 已在 `.gitignore` 里，不会被提交）。各项含义：

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `NACOS_ADDRESS` | `http://127.0.0.1:8848/nacos` | Nacos 地址，**要带上下文路径**（Docker 默认部署是 `/nacos`）。不带协议时按 `http://` 处理，末尾的 `/` 可写可不写 |
| `NACOS_USERNAME` | 不设置 | 仅在 Nacos 开启了鉴权时填写 |
| `NACOS_PASSWORD` | 不设置 | 密码 |
| `NACOS_MCP_READONLY` | `0` | 置为 `1` 则不提供写操作的工具，只保留 7 个只读工具 |
| `NACOS_MCP_TIMEOUT_MS` | `15000` | 单次请求等待回复的上限，`0` 表示不限制 |

几点说明：

- **配置只在服务启动时读取一次。** 改了 `.env` 之后要重启会话，让客户端重新拉起服务，否则仍在用旧配置。
- 开启了鉴权的 Nacos：服务会用账号密码登录并自动续期令牌，不需要手工获取。注意 Nacos 2.4 开启鉴权后默认**没有管理员账号**，要先在 Nacos 控制台里初始化一个。
- 密码里含有空格或 `#` 时要加引号，例如 `NACOS_PASSWORD="p#ss word"`。
- 键名拼错、地址不合法或写成 `NACOS_PASSWORD: xxx` 这种格式时，服务会**拒绝启动**并指出问题，而不是悄悄用默认值去连别的服务器。
- 已经存在的环境变量优先于 `.env`，所以也可以把连接信息写在客户端的 MCP 配置 `env` 里，或者用 `export` 临时覆盖。

### 换一个配置文件：`--env-file`

默认读取服务目录下的 `.env`。想用别的文件（比如每个项目各一份），在启动参数里加上 `--env-file`：

```text
--env-file /absolute/path/to/.env      # 写成 --env-file=/absolute/path/to/.env 也可以
```

- 优先级：**环境变量 > `--env-file` 指定的文件 > 内置默认值**。指定了 `--env-file` 时默认的 `.env` 就不再读取，两个文件不会叠加。
- 参数要写在脚本路径**之后**，由服务自己解析，同样有格式和键名校验。
- 相对路径按客户端启动服务时的工作目录解析，而这个目录随工作区变化，所以请写绝对路径。
- 文件不存在时拒绝启动；在 Node 24 上这时报错来自 Node 本身（`node: …: not found`，退出码 9）。参数名写错（如 `--env-fiel`）同样拒绝启动。

### 不用配置文件：写进客户端的 `env` 块

```json
"env": {
  "NACOS_ADDRESS": "http://127.0.0.1:8848/nacos",
  "NACOS_USERNAME": "nacos",
  "NACOS_PASSWORD": "你的密码"
}
```

- 优先级不变：`env` 里写了的键以 `env` 为准；没写的键仍然从服务目录的 `.env` 取（如果这个文件存在）。
- 这种写法下密码会明文保存在客户端的配置文件里；用 `.env` 文件则不会。

## 验证连接

```bash
npm run check                                    # 用默认的 .env
npm run check -- --env-file /path/to/other.env   # 用 --env-file 指定的文件
```

连接正常时输出类似这样（命名空间取决于你的库）：

```text
✔ 已连接 Nacos 2.4.2  http://127.0.0.1:8848/nacos  （standalone，未开启鉴权）
  配置文件: /Users/maozi/maozi-cloud/maozi-ai-mcp/nacos-mcp-server/.env
  账号: 未配置
  命名空间 (3): public, dev, test
  写操作: 已启用
  单次请求超时: 15000 ms
```

开启了鉴权时第二行是 `账号: nacos（令牌有效）`。连接失败时也会显示读的是哪个配置文件。常见的几种情况：

| 输出 | 原因 |
|---|---|
| `Cannot reach Nacos at …: connection refused. Is Nacos running…` | 地址或端口不对，或 Nacos 没启动 |
| `Nacos has no API at "v1/console/server/state" for this path: HTTP 404 … NACOS_ADDRESS is probably missing the context path` | 地址漏了上下文路径，通常是 `/nacos` |
| `Nacos rejected the login of user "…": user not found!` | 密码不对 |
| `Nacos rejected the login of user "…": User … not found` | 用户名不对 |
| `Nacos rejected the login of user "…": … leave both empty for a server without authentication` | Nacos 没开鉴权却填了账号，把账号密码留空即可 |
| `✔ 已连接 …` 但带有 `⚠ 该 Nacos 开启了鉴权` | Nacos 开了鉴权但没填账号密码，所有操作都会被拒绝 |
| `⚠ 该 Nacos 使用内嵌 Derby 存储…` | 见下面「已知限制」的第一条 |
| `NACOS_ADDRESS …` / `unknown setting …` | `.env` 写错了，按提示修改 |

## 如何启动

这是一个 stdio 类型的 MCP 服务，**不需要也不应该手动常驻启动**：Claude Code / ZCode 会在会话开始时自动拉起它，会话结束时自动退出。

需要手动调试时可以这样：

```bash
node dist/index.js                           # 启动后停在那里等待 stdin 上的 MCP 协议消息，Ctrl+C 退出
node dist/index.js --env-file /path/to/.env  # 同上，读取指定的配置文件
npm run check                                # 只检查连接，不启动服务
```

服务只认识 `--env-file <路径>` 和 `--check` 两个参数，写别的会拒绝启动。

## 在 Claude Code 中使用

下面命令里的 node 路径是 nvm 管理的绝对路径，用 `which node` 可以查看你当前的路径。

### 方式一：用户级（所有项目都能用，推荐）

```bash
claude mcp add --scope user nacos -- \
  /Users/maozi/.nvm/versions/node/v24.13.1/bin/node \
  /Users/maozi/maozi-cloud/maozi-ai-mcp/nacos-mcp-server/dist/index.js \
  --env-file /Users/maozi/maozi-cloud/maozi-ai-mcp/nacos-mcp-server/.env
```

### 方式二：项目级 `.mcp.json`（随仓库共享给他人）

在项目根目录新建 `.mcp.json`：

```json
{
  "mcpServers": {
    "nacos": {
      "type": "stdio",
      "command": "/Users/maozi/.nvm/versions/node/v24.13.1/bin/node",
      "args": [
        "/Users/maozi/maozi-cloud/maozi-ai-mcp/nacos-mcp-server/dist/index.js",
        "--env-file",
        "/Users/maozi/maozi-cloud/maozi-ai-mcp/nacos-mcp-server/.env"
      ]
    }
  }
}
```

`.mcp.json` 里的服务首次使用时需要你在 Claude Code 里确认一次才会连接。最后两个参数可以省略，省略时读取服务目录下默认的 `.env`。

### 方式三：不用文件，连接信息用 `-e` 传环境变量

```bash
claude mcp add --scope user nacos \
  -e NACOS_ADDRESS=http://127.0.0.1:8848/nacos -e NACOS_USERNAME=你的账号 -e NACOS_PASSWORD=你的密码 \
  -- /Users/maozi/.nvm/versions/node/v24.13.1/bin/node \
     /Users/maozi/maozi-cloud/maozi-ai-mcp/nacos-mcp-server/dist/index.js
```

### 验证与管理

```bash
claude mcp list                    # 应能看到 nacos，状态为 Connected
claude mcp get nacos               # 查看详情
claude mcp remove nacos            # 移除（-s user 指定作用域）
```

进入 `claude` 会话后输入 `/mcp` 也能看到连接状态。工具在会话里的名字是 `mcp__nacos__list_services`、`mcp__nacos__publish_config` 等。

## 在 ZCode 中使用

### 方式一：设置界面

打开 **Settings → MCP**，新增一个 stdio 类型的服务，`Command` 填第一行，`Args` 里依次填后几行：

```text
/Users/maozi/.nvm/versions/node/v24.13.1/bin/node
/Users/maozi/maozi-cloud/maozi-ai-mcp/nacos-mcp-server/dist/index.js
--env-file
/Users/maozi/maozi-cloud/maozi-ai-mcp/nacos-mcp-server/.env
```

最后两个参数可以省略，省略时读取服务目录下默认的 `.env`。

### 方式二：用户级配置文件（所有工作区都能用）

编辑 `~/.zcode/cli/config.json`，在 `mcp.servers` 下加一项（已有 `mysql`、`redis` 的话，加在它们旁边）：

```json
{
  "mcp": {
    "servers": {
      "nacos": {
        "type": "stdio",
        "command": "/Users/maozi/.nvm/versions/node/v24.13.1/bin/node",
        "args": [
          "/Users/maozi/maozi-cloud/maozi-ai-mcp/nacos-mcp-server/dist/index.js",
          "--env-file",
          "/Users/maozi/maozi-cloud/maozi-ai-mcp/nacos-mcp-server/.env"
        ]
      }
    }
  }
}
```

### 方式三：不用文件，连接信息写进 `env` 块

```json
"nacos": {
  "type": "stdio",
  "command": "/Users/maozi/.nvm/versions/node/v24.13.1/bin/node",
  "args": ["/Users/maozi/maozi-cloud/maozi-ai-mcp/nacos-mcp-server/dist/index.js"],
  "env": {
    "NACOS_ADDRESS": "http://127.0.0.1:8848/nacos",
    "NACOS_USERNAME": "你的账号",
    "NACOS_PASSWORD": "你的密码"
  }
}
```

Nacos 没开鉴权的话把 `NACOS_USERNAME` 和 `NACOS_PASSWORD` 两行删掉。

### 注意事项

- **必须写绝对路径**：ZCode 不会展开 `${...}` 变量，而且桌面应用启动时未必有 nvm 的 PATH，写 `node` 可能报 `spawn node ENOENT`。
- **配置项名称是严格的**：只接受 `type`、`command`、`args`、`env`、`cwd`、`enabled`、`timeoutMs`，写错一个键整个服务会被忽略。
- 修改后需要**重启会话**（必要时重启 ZCode）才会生效，然后在 **Settings → MCP** 查看状态。
- 工具在会话里的名字是 `mcp__nacos__list_services`、`mcp__nacos__publish_config` 等。

## 使用示例

配置好之后，直接在 Claude Code 或 ZCode 里用自然语言说即可，例如：

- 「Nacos 里有哪些命名空间？」
- 「`dev` 命名空间里有哪些服务？每个有几个实例？」
- 「看一下 `order-service` 的实例详情，哪个权重高？」
- 「把 `10.0.0.3:8080` 这个实例下线」（停用，应用不再拿到它，但实例还在，可以随时恢复）
- 「把 `gateway` 服务的保护阈值调成 0.6」
- 「`dev` 里 `order-service.yaml` 这个配置现在是什么内容？」
- 「把 `order-service.yaml` 里的线程池大小改成 20」
- 「这个配置上次是谁在什么时候改的？改之前是什么内容？」
- 「新建一个 `uat` 命名空间，把 `dev` 的配置克隆过去」
- 「哪些客户端在监听 `order-service.yaml` 这个配置？」

模型实际调用工具时大致是这样：

```jsonc
// 查
list_services     { "namespace": "dev" }
describe_service  { "service": "order-service", "namespace": "dev" }
get_config        { "data_id": "order-service.yaml", "group": "DEFAULT_GROUP", "namespace": "dev" }
config_history    { "data_id": "order-service.yaml", "namespace": "dev" }
read_request      { "path": "v1/cs/configs/listener", "query": { "dataId": "order-service.yaml" } }

// 改：停用实例（没提到的字段保持不变）
update_instance   { "service": "order-service", "ip": "10.0.0.3", "port": 8080, "enabled": false, "namespace": "dev" }

// 改配置：带上读到的 md5，期间被别人改过就会拒绝
publish_config    { "data_id": "order-service.yaml", "namespace": "dev", "content": "…", "expected_md5": "读到的 md5" }

// 删（必须带 confirm，否则会被拒绝并把原因返回给模型）
delete_config     { "data_id": "order-service.yaml", "namespace": "dev", "confirm": true }
```

约定：

- **命名空间**可以写 id，也可以写名称；不写或写 `public` 都是 public 命名空间。写了一个不存在的命名空间会直接报错并列出可用的，不会悄悄新建——Nacos 本身允许往不存在的命名空间写数据，那些数据之后在控制台里是看不到的。
- **分组**默认是 `DEFAULT_GROUP`。
- 结果里超过约 100 KB 会被拒绝并提示缩小范围；单条配置的内容超过 6 万字符会被截断。

## 这个服务替你处理掉的 Nacos 行为

这些都是对着 Nacos 2.4.2 实测出来的。直接调接口的话，每一条都是一个坑：

| Nacos 的行为 | 服务做了什么 |
|---|---|
| public 命名空间的 id 是空字符串，写 `public` 查不到任何东西 | 两种写法都接受，名称和 id 都能识别 |
| 「更新实例」接口会把没传的字段重置为默认值 | `update_instance` 先读现状再合并提交，改权重不会丢元数据 |
| 停用的实例在给应用的实例列表里消失，常规列表接口也查不到 | 用控制台自己的接口取实例，停用的也在 |
| 手动改健康状态只对「临时服务 + 关闭健康检查」有效 | 不提供这个操作，下线统一用「停用」 |
| 服务列表接口一次只能查一个分组 | 用控制台的列表接口，跨分组列出 |
| 通过接口注册的临时实例，没有心跳，约 30 秒后被摘除 | 注册时明确提示；新服务默认建成和应用一样的临时服务 |
| 往不存在的命名空间发布配置会成功，配置变成看不见的孤儿数据 | 发布前先确认命名空间存在 |
| 删除还有配置的命名空间会成功，配置同样变成孤儿数据 | `delete_namespace` 在非空时拒绝 |
| 发布配置后立刻读，可能还是旧内容 | 发布后等到新内容可读才返回 |
| 配置的「按 md5 防覆盖」参数在 v1、v2 接口上都不生效，带着过期的 md5 也能覆盖 | 在工具层比对：和读的时候不一致就拒绝 |
| 删除不存在的配置、摘除不存在的实例，Nacos 都返回成功 | 先确认存在，不会报一个假的「删除成功」 |
| 对不存在的配置，带 `show=all` 查询返回 200 和空响应体，不带才是 404 | 两种都识别为「不存在」 |
| v1 的灰度发布接口已经不是真正的灰度：发布后普通读取直接读到灰度内容 | 不提供灰度工具 |
| 导出接口少传一个参数（哪怕是空串）就返回 500 且没有响应体 | 在 `request` 工具的说明里写明了必须传哪些参数 |
| 带上 `Accept: application/json` 时，导出的 zip 会被标成 JSON | 按内容识别二进制，返回 base64 |
| 地址漏了上下文路径时，返回的是一整页 HTML 的 404 | 识别出来并提示检查 `NACOS_ADDRESS` |
| 用户列表接口会返回密码的哈希值 | 返回给模型前抹掉 |
| 内嵌 Derby 存储下，命名空间列表接口报 500 | 给出明确的说明，而不是一串 SQL 错误 |

## 安全机制

| 机制 | 说明 |
|---|---|
| 删除需要确认 | 删除命名空间、服务、配置，以及通用请求里的 `DELETE` 方法，必须带 `confirm: true`。AI 会先把要执行的内容给你看 |
| 非空不删 | `delete_namespace` 和 `delete_service` 在还有配置或实例时拒绝 |
| 改配置防覆盖 | `publish_config` 支持 `expected_md5`：配置在读之后被改过就拒绝 |
| 权限类请求需要确认 | 通过 `request` 改用户、角色、权限，让节点退出集群，批量导入或克隆，都要 `confirm: true` |
| 只读模式 | `NACOS_MCP_READONLY=1` 时不提供任何写操作的工具 |
| 结果保护 | 超过约 100 KB 的结果不返回；密码哈希不返回 |

`request` 工具能做这个 Nacos 账号能做的任何事，确认机制只覆盖上面列出的几类。这些机制针对的是「AI 手滑」，并不能替代备份和 Nacos 自身的权限控制。给 AI 用的账号按最小权限分配，是最有效的保护。

## 测试

```bash
npm run test:e2e                                     # 连接信息取自环境变量和 .env
NACOS_ADDRESS=http://127.0.0.1:18848/nacos npm run test:e2e                    # 指定服务器
NACOS_USERNAME=nacos NACOS_PASSWORD=nacos npm run test:e2e                    # 开启了鉴权的服务器
NACOS_DERBY_ADDRESS=http://127.0.0.1:18850/nacos npm run test:derby           # 内嵌 Derby 存储的服务器
```

`test:e2e` 会以 MCP 客户端的方式真实拉起服务，跑 21 项用例：命名空间、服务、实例、配置的各项操作，防覆盖，历史版本，导入导出和克隆，各种拒绝，配置文件解析等。测试新建两个自己的命名空间（`mcp-e2e-<进程号>`），只在里面操作，结束时删除。默认只允许连本机地址，连其他主机需要设置 `E2E_ALLOW_REMOTE=yes`。

`test:derby` 是针对内嵌 Derby 存储的 4 项用例，只在给了 `NACOS_DERBY_ADDRESS` 时运行，它会往 public 命名空间里写一条配置再删掉，所以只能对一次性的服务器使用。

## 已知限制

- **内嵌 Derby 存储**（docker 单机模式不带 MySQL 参数时的默认值）：Nacos 自身在这个存储上无法列出命名空间，v1 和 v2 接口都报错，它的控制台里命名空间页面同样打不开。这种部署下本服务**只能操作 public 命名空间**，要使用其他命名空间请把 Nacos 的存储换成 MySQL。
- **只在 Nacos 2.4.2 单机模式上验证过。** 结构化工具用的是从 1.x 起就有的 v1 接口；「服务是否为临时服务」这一项取自 v2 接口，更老的服务器上会显示不出来。2.5 及以后的版本新增了 v3 接口，可以用 `request` 调用，但没有测过。集群模式也没有测过。
- **配置历史**里保存的是「被替换掉的版本」，当前版本要等它被替换后才出现；各版本会用 `is_current` 标出是不是当前内容。Nacos 没有回滚接口，要恢复某个版本就用 `publish_config` 发布它的内容。
- **md5 防覆盖**是「先比对再发布」两步，两步之间理论上仍有极短的时间窗口。Nacos 自带的参数如果以后生效了，也会一并带上。
- **没有事务**：一次工具调用是一个或几个独立的 HTTP 请求，中途失败时前面已完成的不会回滚。
- **真实的 Claude Code / ZCode 会话**里还没有实际跑过，测试用的是官方 SDK 的 stdio 客户端。

## 目录结构

```text
nacos-mcp-server/
├── src/
│   ├── config.ts       连接配置：环境变量 → --env-file 指定的文件或 .env → 默认值，地址规范化
│   ├── nacos.ts        HTTP 客户端：登录与令牌、错误归类、回复解码、密码哈希脱敏
│   ├── api.ts          Nacos 接口的封装，每处坑都对应一个函数
│   ├── tools.ts        17 个 MCP 工具的定义和处理
│   └── index.ts        入口：解析启动参数、启动服务、--check
├── dist/               npm run build 的产物，客户端配置里指向这里
├── test/e2e.mjs        端到端测试
├── test/derby.mjs      内嵌 Derby 存储的测试
├── .env                连接信息（不提交）
└── .env.example
```

修改源码后执行 `npm run build`，再重启 Claude Code / ZCode 的会话即可生效。
