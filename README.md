# MySQL Backup

[![License](https://img.shields.io/github/license/yi-ge/mysql-backup.svg?style=flat-square)](LICENSE)
[![Backup verification](https://github.com/yi-ge/mysql-backup/actions/workflows/backup.yml/badge.svg)](https://github.com/yi-ge/mysql-backup/actions/workflows/backup.yml)

定时全量备份 MySQL 到阿里云 OSS、腾讯云 COS 或七牛云。工作台用于管理计划、跟踪运行、解冻和下载归档，以及在空的隔离库演练恢复。同一套工作台可独立运行，也可安装到 DesireCore 桌面或 Web。加密模式使用 AES ZIP。

## 安装工作节点

从要部署的源码版本构建镜像，配置独立持久卷。以下示例只在本机监听，远程管理时由 HTTPS 反向代理提供可信域名。

```bash
docker build -t mysql-backup:local .
mkdir -p ./backup-data
docker run -d --name mysql-backup --restart unless-stopped \
  -v "$PWD/backup-data:/project/db" -p 127.0.0.1:8080:80 mysql-backup:local
```

打开 `http://127.0.0.1:8080`。从持久卷中的 `setup-code` 读取一次性初始化码，创建管理员。初始化后登录，先在「设置」添加私有存储，再建备份计划。计划支持时区、5 或 6 段 Cron、表包含/排除、多个存储目的地和立即运行。以运行记录中的实际结果为准。如果外部上传的结果无法确认，工作台会标记未知，供人工核对。

OSS 使用 Bucket 的存储类型，COS 和七牛云的上传策略设置归档类型。私有归档的解冻、取回可能计费。并发写入时，备份中的各张表可能来自不同时间点。

源码安装使用 [指定版本](.node-version) 的 Node.js 和随附 npm。恢复演练需要系统安装 `mysql` CLI。

```bash
npm ci
npm run build
HOST=127.0.0.1 PORT=8080 WORKPATH=./db npm start
```

| 变量 | 作用 |
| --- | --- |
| `PORT` / `HOST` | 应用监听位置，默认 `80` / `0.0.0.0` |
| `WORKPATH` | 持久数据目录，默认 `db`。DesireCore 注入的 `APP_DATA_DIR` 或 `APP_DATA_ROOT` 优先 |
| `MYSQL_BACKUP_PUBLIC_URL` | 工作节点对操作者开放的 HTTPS origin。托管工作台依赖它生成下载地址 |
| `MYSQL_BACKUP_UPSTREAM` | 可选工作节点 HTTPS origin。设置后此进程仅作为工作台代理，也可写入数据目录下的 `console.json` |
| `MYSQL_BACKUP_RECOVERY` | 运维人员提供的隔离恢复目标 JSON。见下文 |
| `MYSQL_BACKUP_MYSQL_CLIENT` | 恢复用客户端，默认 `mysql` |

同一数据目录只运行一个工作节点。将 SQLite、`.workbench-key` 及必要的历史 JSON 作为整卷进行离线快照并保护访问权限。

## 从旧版迁移

1. 停止旧容器，快照实际配置卷。旧容器内部默认文件为 `/project/db/mysql-backup-db.json`。旧挂载位置不一致时，在删除旧容器前用 `docker cp` 导出文件。
2. 将旧 JSON 放在新数据卷根目录并启动新版。首次启动事务式导入可解析的配置、用户、计划、运行、存储归档引用和通知。迁移读取已解析的数据字段，历史 JavaScript 始终只保留在旧文件中。旧默认管理员需要重新初始化，其他已迁移用户首次登录时升级密码摘要。迁移状态可在工作台查看。
3. 核对跳过数量、计划启用状态、时区和下一次执行时间，再验证一条实备份。历史档案可能缺少原始校验和，恢复结果会区分是否对过原始校验。旧页面、JWT 及 Swagger 接口可通过 `MYSQL_BACKUP_LEGACY=1` 在旧模式继续使用。需要回退时，停止新版，恢复旧快照并用旧模式启动。新版写入保存在独立 SQLite，回退前请保留这份卷。

旧版变量、接口及短信模板参见[迁移前的使用说明](https://github.com/yi-ge/mysql-backup/blob/b867780/README.md)。

## 恢复演练

源备份账号按库授予必要的 `SELECT`、`SHOW VIEW`、`TRIGGER` 权限。恢复目标由部署者预先创建，建议使用独立数据库实例。使用只对恢复 schema 有权限的账号。目标 schema 名需与源不同，发起时需为空。通过安全的运行环境变量配置连接，字段包括 `host`、`port`、`user`、`database` 和 `password`。例如目标定义可以形如：

```json
{"host":"recovery.internal","port":3306,"user":"backup_drill","database":"recovery_sandbox","password":"replace-at-deploy"}
```

在运行详情选择归档副本，根据对象存储状态解冻。点击「隔离恢复」，确认目标，然后查看校验、导入和对象计数结果。恢复账号、目标和下载权限由服务端管理。若导入中断，目标可能已被部分写入。检查原运行和目标，清理或替换隔离目标后可再次演练。对关键表的数据完整性仍可按业务要求做进一步核对。

## DesireCore 和 Agent

使用已上传镜像的实际 digest 生成固定发布材料：

```bash
npm run release:desirecore -- --image "$IMAGE_REPO_DIGEST" --commit "$(git rev-parse HEAD)" --output ./dist-desirecore
```

按 [DesireCore 纳管和 Web 配置说明](desirecore/run.md) 安装。工作节点应保持常驻。安装材料引用精确镜像和源码提交，密钥、旧配置及业务数据保留在部署侧。

在工作台「设置 → Agent 工具」按用途签发可撤销令牌。MCP 使用 Streamable HTTP `POST /mcp`，通过 `Authorization: Bearer …` 认证。只读工具列出计划和运行、读取回执、检查归档状态。操作范围还支持立即备份、解冻以及按管理员权限发起隔离恢复。由实际权限共同限制访问范围。备份和恢复提交接受 `requestId`，以同一值重试可获取原运行 ID。

## 验证和维护

```bash
npm ci
npm run lint
npm run typecheck:web
npm run build
MYSQL_TEST_PORT=33060 MYSQL_TEST_PASSWORD='test-password' npm test
npm run test:browser
```

测试需一台专用 MySQL，测试会自行创建和删除数据库与最小权限账号。可用 `MYSQL_TEST_USER` 指定管理员，`MYSQL_TEST_CLIENT` 指定客户端路径。CI 覆盖 MySQL 5.7、8.0 和 8.4。集成测试使用本地对象存储服务模拟器，浏览器回归使用系统安装的 Chrome。

依赖更新应同步提交 `package.json` 和 `package-lock.json`，再用 `npm ci` 验证。生产依赖用 `npm audit --omit=dev` 检查。更新 `mysqldump` 或 `mysql2` 时验证现有补丁及导出、恢复兼容性。
