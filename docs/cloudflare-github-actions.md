# 通过 GitHub Actions 自动部署 Cloudflare Pages

本方案适用于 MiSub（Vue/Vite + Pages Functions），不需要在 Cloudflare Pages 控制台连接 GitHub 仓库。仓库的 `main` 分支推送、上游同步后的推送、或手动 `workflow_dispatch` 都会自动测试、构建并部署到生产环境；Pull Request **只执行测试和构建**，不访问生产 Secrets。

## 1. 配置 Repository Secrets

在 Fork 仓库打开 **Settings → Secrets and variables → Actions → Repository secrets → New repository secret**。

| Secret | 是否必需 | 用途 |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | 是 | Cloudflare API Token；至少授予当前账号 **Cloudflare Pages: Edit** 和 **Workers KV Storage: Edit**，用于创建/检查 Pages 项目、自动创建/查询 KV、部署与设置 Pages Secret |
| `CLOUDFLARE_ACCOUNT_ID` | 是 | Cloudflare Account ID（不是 Zone ID） |
| `ADMIN_PASSWORD` | 是 | MiSub 管理员登录密码；部署时加密写入 Pages `ADMIN_PASSWORD`，禁止使用默认的 `admin` |
| `COOKIE_SECRET` | 否，推荐 | 稳定的随机会话密钥，加密写入 Pages；避免会话密钥意外变化 |
| `CLOUDFLARE_PAGES_PROJECT_NAME` | 否 | Pages 项目名，默认 `misub`；同一 Cloudflare 账号中不得重名，只能使用小写字母、数字、连字符 |
| `CLOUDFLARE_KV_NAMESPACE_ID` | 否 | 已有 KV namespace ID；省略时优先复用 Pages 生产环境的 `MISUB_KV` 绑定，其次复用同名 `<项目名>-misub-kv` namespace，最后自动创建 |
| `CLOUDFLARE_D1_DATABASE_ID` | 否 | 已创建的 D1 数据库 ID；如 Pages 生产环境已绑定 `MISUB_DB`，会优先保留现有绑定 |
| `CLOUDFLARE_D1_DATABASE_NAME` | 否 | 绑定的 D1 实际数据库名称，默认 `misub`；有 D1 ID 时建议明确设置 |

建议创建 **自定义 API Token**，限制 Account Resources 为需要部署的 Cloudflare 账号。不要使用 Global API Key，不要把 Token、密码或 KV/D1 ID 写入仓库代码。创建 Token 入口：[Cloudflare API Tokens](https://dash.cloudflare.com/profile/api-tokens)。Cloudflare 账号页面可找到 Account ID。

> GitHub Actions 的 `GITHUB_TOKEN` 由 GitHub 自动提供，不需要额外配置。部署不会使用 `SYNC_PAT`。

## 2. 启动部署

在 GitHub 仓库打开 **Actions → Cloudflare Pages → Run workflow**，选择 `main` 手动执行首次部署；以后每次推送到 `main` 自动执行。

工作流按顺序完成：

1. `npm ci`、`npm run test:run`、`npm run build`，产物在 `dist`，`functions/` 由 Wrangler 打包。
2. 先检查 Pages 项目：存在则复用，不存在则创建（生产分支 `main`）。
3. 绑定必须的 `MISUB_KV`：已有绑定优先，绝不自动删除或重置 KV；否则创建一个项目专用的 KV namespace。
4. 使用项目已有的 `wrangler-cf-pages.toml` 生成仅存在于 CI Runner 的临时 `wrangler.toml`（含 KV 和可选 D1 绑定）。
5. 把 `ADMIN_PASSWORD`、可选的 `COOKIE_SECRET` 作为 Cloudflare Pages 的加密 Secrets 写入，然后使用 `wrangler pages deploy dist --branch=main` 发布。

默认访问地址：`https://misub.pages.dev/login`。如果项目名已修改，用对应的 `https://<项目名>.pages.dev/login` 访问。实际域名以 Actions 部署输出为准；自定义域名和 DNS 需要单独配置。

**安全保护：** 缺少三个必需 Secrets，部署会直接失败，不会以默认管理员密码上线。对已经绑定了另一 KV/D1 ID 的项目，脚本拒绝把存储悄悄切换到新的资源；遇到额外 KV/D1 绑定时也会中止，以免覆写生产配置。

## 3. 现有 Cloudflare Pages 项目注意事项

- 如果项目已绑定 `MISUB_KV`，直接复用原来的 namespace；切勿主动换 ID，否则旧订阅数据会变得不可见。
- 已使用 D1 的项目应设置 D1 ID 和**实际数据库名称**。本工作流不会自动创建 D1、执行 `schema.sql` 或迁移已有数据。若第一次启用 D1，可在 Cloudflare 侧创建并执行：`npx wrangler d1 execute <数据库名> --file=schema.sql --remote`。
- `wrangler.toml` 是 Pages Functions 的部署配置来源。**现有项目如有额外生产环境变量或 KV/D1 以外的资源绑定，部署脚本会主动中止**，避免覆写这些设置。请先在 Cloudflare 侧检查、备份和迁移现有配置；非标准的预览环境配置也需人工核对。
- 如果 Pages 已经通过 Cloudflare Git Integration 连接仓库，可能出现 Cloudflare 和 GitHub Actions **重复部署**。可以在 Pages 项目的 Branch control 禁用 Cloudflare 原生自动部署，仅保留 GitHub Actions。
- 首次部署会创建资源并消耗 Cloudflare 配额；API Token 需要有实际授权。

## 4. 验收与故障排查

| 现象 | 应检查 |
| --- | --- |
| `Missing Repository secret` | GitHub Actions 的三个必需 Secrets 名称和值是否正确 |
| `Cloudflare Pages project lookup failed` | Account ID 是否正确；Token 是否具备 Pages 读写权限 |
| KV 查询或创建失败 | API Token 是否有 Workers KV Storage 读写权限 |
| D1 绑定出错 | D1 ID 与实际数据库名称是否匹配；是否初始化 `schema.sql` |
| `MISUB_KV already points at another namespace` | 新填的 KV ID 与现有 Pages 绑定不一致；为避免覆盖数据故意失败 |
| 发布成功但访问功能报错 | 检查 Pages Functions 日志、`MISUB_KV` 绑定、`ADMIN_PASSWORD` 以及 D1 表结构 |

本地验证代码：`npm ci && npm run test:run && npm run build`。

## 5. Fork 上游同步与部署关系

`.github/workflows/fork-sync.yml` 已改成 **仅快进（fast-forward）**，不再执行 `git reset --hard upstream/main` / 强制推送清除 Fork 自有提交。发生分叉时此工作流会跳过，由现有 `sync-upstream.yml` 尝试普通合并；若有冲突，需要人工处理，不能自动丢弃本地的部署配置。
