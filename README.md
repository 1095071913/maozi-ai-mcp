# maozi-ai-mcp

给 Claude Code、Codex、ZCode 等 AI 客户端用的三个本地 MCP server（均为 stdio 传输，TypeScript 编写）。配置好之后，直接在会话里用自然语言操作本地中间件。

| 目录 | 服务名 | 用途 | 验证环境 |
|---|---|---|---|
| [`nacos-mcp-server`](nacos-mcp-server/README.md) | `nacos` | 管理命名空间、服务、实例、配置，其余 Nacos 接口也都能调 | Nacos 2.4.2  |
| [`redis-mcp-server`](redis-mcp-server/README.md) | `redis` | 执行 Redis 命令、分页扫描 key | Redis 6.2.6  |
| [`mysql-mcp-server`](mysql-mcp-server/README.md) | `mysql` | 查看库表结构、执行查询、增删改和 DDL | MySQL 8.0.29 |

## 快速开始

三个服务的安装和验证步骤完全一样，在每个目录里执行：

```bash
cd /Users/maozi/maozi-cloud/maozi-ai-mcp/<目录名>
npm install        # Node.js ≥ 20.12
npm run build      # 产出 dist/，客户端配置里指向它
npm run check      # 验证连接，输出实际读取的配置文件
```

然后在客户端里注册服务（见下文），会话开始时客户端会自动拉起服务，**不需要手动常驻启动**。

## 注册服务

在客户端的 MCP 配置文件里，三个服务一起注册：

```jsonc
{
  "mcpServers": {
    "nacos": {
      "type": "stdio",
      // node 的绝对路径，nvm 环境下客户端不一定有 PATH，不能只写 node
      "command": "/Users/maozi/.nvm/versions/node/v24.13.1/bin/node",
      // 指向 build 产物 dist/index.js
      "args": ["/Users/maozi/maozi-cloud/maozi-ai-mcp/nacos-mcp-server/dist/index.js"],
      "env": {
        // Nacos 地址，要带上下文路径（Docker 默认部署是 /nacos）
        "NACOS_ADDRESS": "http://127.0.0.1:8848/nacos",
        // 账号、密码：仅在 Nacos 开启鉴权时填写，未开鉴权时保持为空
        "NACOS_USERNAME": "nacos",
        "NACOS_PASSWORD": "nacos"
      }
    },
    "redis": {
      "type": "stdio",
      "command": "/Users/maozi/.nvm/versions/node/v24.13.1/bin/node",
      "args": ["/Users/maozi/maozi-cloud/maozi-ai-mcp/redis-mcp-server/dist/index.js"],
      "env": {
        "REDIS_HOST": "127.0.0.1",        // Redis 地址
        "REDIS_PORT": "6379",             // 端口
        "REDIS_PASSWORD": "password",     // 密码，无密码时留空
        "REDIS_DB": ""                   // 不带 db 参数的命令默认用哪个库，不需要就留空
      }
    },
    "mysql": {
      "type": "stdio",
      "command": "/Users/maozi/.nvm/versions/node/v24.13.1/bin/node",
      "args": ["/Users/maozi/maozi-cloud/maozi-ai-mcp/mysql-mcp-server/dist/index.js"],
      "env": {
        "MYSQL_HOST": "127.0.0.1",        // MySQL 地址
        "MYSQL_PORT": "3306",             // 端口
        "MYSQL_USER": "root",             // 用户名
        "MYSQL_PASSWORD": "password",     // 密码
        "MYSQL_DATABASE": ""              // 不写库名的 SQL 默认用哪个库，不需要就留空
      }
    }
  }
}
```

配置文件必须是合法 JSON，`//` 注释仅供说明，复制时删掉。

## 目录结构

```text
maozi-ai-mcp/
├── nacos-mcp-server/    Nacos MCP server（详细文档见其 README.md）
├── redis-mcp-server/    Redis MCP server（详细文档见其 README.md）
└── mysql-mcp-server/    MySQL MCP server（详细文档见其 README.md）
```