# 登录安全与通知中心本地联调

本地 Chromium 加载当前检出的前端生产构建，登录、注销、通知、已读和登录审计请求交给同一源码的真实 `handleApiRequest` 路由与认证中间件。安全存储使用内存 SQLite D1 接口夹具，外围查询使用合成空数据；浏览器外部请求与后端网络请求阻断。

## 源码身份与自动门禁

`tests/browser/notification-backend-integration.mjs` 读取当前 `HEAD`，核对前端输入及关键后端文件与该提交一致，并在当前 checkout 内执行 Vite build。只接受当前 checkout 的后端与 `dist`，不拼接不同历史分支或使用外部历史构建。

入口已登记于 `tests/acceptance-manifest.json`，由 `.github/workflows/probe-control.yml` 的 browser-fixtures 运行。`npm run test:browser` 会核对入口发现、实际执行和完成报告；缺失、重复或未完成不计作通过。

main `db2bb5459502a9999b3f6cb84554848cb94e11ae` 的[控制面CI](https://github.com/58cdn/MiSub/actions/runs/38591001696)与[实际Pages部署](https://github.com/58cdn/MiSub/actions/runs/38591001564)已成功；准确受审树的完整browser门禁包含本入口8组联调。该固定版本证据与后续每次运行的HEAD分别记录。仓库内[早期组合报告](images/admin-notifications/backend-integration-report.json)保留其原始提交身份，不作为当前构建证明。

## 已覆盖行为

1. 未登录访问通知、审计和已读接口返回401，存储不变。
2. 第1–9次密码错误返回401，第10次返回429；页面显示等待时间并禁用提交。锁期内正确密码仍被拒绝，锁定截止时间不变。
3. 合成时钟推进10分钟后登录成功，产生HttpOnly会话、成功审计和包含10次失败的持久警告。
4. 24条通知按20/4排他分页；GET不改已读，明确ID及重复确认保持幂等。
5. 登录审计仅列成功记录，按20/3分页，不改未读总数。
6. 关闭开关或缺少安全绑定时正常登录可用，接口返回禁用契约，页面清除安全数据，已有记录保持不变。
7. 会话清除后接口401使前端退出并清除上次会话私有状态。
8. 已配置但不可用的安全存储返回503，页面明确显示不可用。

边界与并发另由 `login-security-store/http/d1.test.js` 及会话集成单测覆盖；本地Miniflare D1与浏览器内存SQLite不是同一种环境，证据分别记录。

## 复现

使用包含本入口的干净checkout和其独立依赖目录，需要Node22.13+或Node24及Playwright Chromium：

```sh
npm ci
npx playwright install chromium
node tests/browser/notification-backend-integration.mjs tmp/notification-integration
```

入口自行构建前端，不需要手动拼装后端或先运行另一工作树的构建。已有Chromium可通过 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` 指定；Windows设置同名环境变量后运行相同Node入口。完整浏览器门禁使用 `npm run test:browser`。当前源码不变且已有准确CI时，无需为更新文档重复全部测试。

运行向指定输出目录写入 `report.json`、截图及必要诊断；报告记录源码、构建与日志摘要、请求状态和结果。构建入口摘要用于识别产物，需与准确checkout和实际执行记录一起评估。

## 验证与上线边界

这些请求由浏览器拦截后调用真实后端函数，未经过实际Cloudflare HTTP链路；来源IP和平台元信息由夹具注入。它们不表示生产D1、真实可信来源链路或任意用户设备/Safari已经验收。

账号、密码、IP与事件均为合成值，不加载环境凭据、不读取真实节点、不执行远程迁移、资源创建或生产登录。[Issue #32](https://github.com/58cdn/MiSub/issues/32)的原始代码验收与[上线追踪 #55](https://github.com/58cdn/MiSub/issues/55)分开；生产审计/会话启用及指定环境验收按后者和[上线决定](go-live-decisions.md)逐阶段处理。
