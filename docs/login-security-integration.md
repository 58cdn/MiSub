# 登录安全与通知中心本地联调

本地 Chromium 加载前端生产构建，登录、注销、通知、已读和登录审计请求交给真实的 `handleApiRequest` 路由与认证中间件。安全存储采用后端提供的内存 SQLite D1 接口夹具。仪表盘等外围查询使用空数据夹具，浏览器外部请求及后端网络请求均阻断。

## 固定版本与结果

- 前端运行源码：`344b613b2163aebe6122a5944ea75c1501075c1c`（PR #40）。
- 后端：`8b9d52cafc3d7a6c8358d7476476716d1a11ffbc`（PR #38）。
- 独立组合工作树：全量 Vitest 176 个文件、1354 项通过；包含本地 Miniflare D1 并发、警告去重和事务回滚测试。
- Vite 生产构建通过；浏览器联调 8 组行为检查通过，生成 10 张截图。
- 主存储写入、后端出网、未预期 API、页面异常均为零。

[机器可读证据摘要](images/admin-notifications/backend-integration-report.json)记录时间、固定源码、构建与日志摘要、请求状态和截图摘要。完整原始报告及截图由测试命令写入指定的本地输出目录。

测试程序逐字核对关键后端模块与固定提交，并检查前端 `src`、`public`、入口、构建配置及依赖清单相对固定提交无差异。构建需单独执行，报告内的入口 SHA256 用于识别产物，本身不构成独立的源码到构建证明。

## 已覆盖行为

1. 未登录访问通知、审计和已读接口均返回 401，存储不变。
2. 第 1–9 次密码错误返回 401，第 10 次返回 429；页面显示等待时间并禁用提交。锁定期间使用正确密码仍被拒绝，锁定截止时间不变。
3. 合成后端时钟前进 10 分钟后可正常登录；生成 HttpOnly 会话及包含 10 次失败的警告。成功登录事件与持久警告进入通知列表。
4. 24 条通知按 20/4 分页，游标排他且无重复；GET 不改已读。单条和本页确认只更新明确的 ID，重复确认保持原已读时间。
5. 登录审计只列出 23 条成功记录，按 20/3 分页，不改未读总数。
6. 开关关闭及缺少安全数据库绑定时，密码验证和正常登录均保持可用；列表/审计/已读返回禁用契约，页面清除安全数据，已有事件与已读时间不变。
7. 清除会话后真实接口返回 401，前端退出登录并移除通知；不存在上一会话的数据残留。
8. 已配置但不可用的安全存储返回 503，页面显示服务不可用提示。

## 复现

在包含本测试程序的 PR #40 检出目录执行。示例为 POSIX shell，Windows 可设置对应环境变量后运行同一 Node 程序。需要 Node 22.13+ 或 Node 24，以及 Playwright 支持的 Chromium；本次本地验收使用 Node 24.20.0。

```sh
git fetch origin feat/login-security-backend feat/admin-notification-center
git worktree add --detach ../MiSub-notification-integration 344b613b2163aebe6122a5944ea75c1501075c1c
git -C ../MiSub-notification-integration restore --source=8b9d52cafc3d7a6c8358d7476476716d1a11ffbc --worktree -- \
  functions scripts/deploy-cloudflare-pages.sh tests/deployment/cloudflare-pages.test.mjs \
  tests/fixtures tests/unit/auth-kv-limit-regression.test.js tests/unit/security-hardening.test.js \
  tests/unit/login-security-d1.test.js tests/unit/login-security-http.test.js \
  tests/unit/login-security-store.test.js migrations/login-security docs/login-security-contract.md
cd ../MiSub-notification-integration
npm ci
npm run test:run
npm run build
cd -
MISUB_LOGIN_SECURITY_BACKEND_ROOT=../MiSub-notification-integration \
MISUB_INTEGRATION_DIST=../MiSub-notification-integration/dist \
  node tests/browser/notification-backend-integration.mjs tmp/notification-integration
```

测试入口所在检出目录也需安装依赖。可用 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` 指定已有 Chromium。工作树应使用自己的依赖目录；Windows 跨工作树目录链接可能使 Vitest 的 Vue 动态导入出现路径解析错误。

本程序是显式执行的本地验收，不加入普通 PR 的自动运行，因为两个实现仍分别位于独立草稿 PR。默认全量 Vitest 继续覆盖各自分支的单元与已有回归测试。

## 验证边界

浏览器 API 拦截后调用真实后端处理器，未经过真实 Cloudflare Pages HTTP 部署链路。来源 IP 和 Cloudflare 元信息由夹具注入；浏览器联调用内存 SQLite，本地 D1 运行时测试独立执行。因此这些结果不代表真实 D1 部署、Cloudflare 来源可信链路、生产端到端或真机 Safari 已通过。

所有账号、密码、来源 IP 和事件均为合成测试值。测试不加载环境凭据，不读取真实节点，不执行远程迁移、资源配置、身份创建或生产登录。生产启用和真实验收依照 [Issue #32](https://github.com/58cdn/MiSub/issues/32) 的授权边界执行。
