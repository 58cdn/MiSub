# 节点检测部署与验收

本功能继续使用已有 GitHub Actions → Cloudflare Pages 部署链路。原有 `MISUB_KV`、`MISUB_DB` 原样保留；检测器身份、任务租约和结果使用独立 `MISUB_PROBE_DB`，不会迁移订阅源或节点表。

## Cloudflare 权限

已有三个 Repository Secrets 仍为 `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`、`ADMIN_PASSWORD`。无需提交数据库 ID 或新增检测器 Token Secret。Cloudflare API Token 除原来的 Pages/KV 权限，还需要目标账户的 **D1 Edit/Write**（控制台通常显示 Account / D1 / Edit）。仅需在 Cloudflare 调整现有 Token 的权限；不要把 Token 值粘贴到 issue、聊天或日志。

普通 main push 只测试、构建并发布 Pages，保留已绑定的 `MISUB_PROBE_DB`，不创建检测数据库或检测器身份。PR 只做离线测试和构建。需要新增检测数据库时，必须在 main 上手动 `workflow_dispatch` 并主动勾选默认关闭的 `provision_node_probes`；只有此路径设置 `PROVISION_NODE_PROBES=true`。脚本另行拒绝 Actions 的自动事件，防止开关被误接。

手动路径的 `scripts/provision-probe-d1.sh` 先保留已绑定数据库，否则按稳定名称 `<Pages项目名>-probes` 查找/创建独立数据库。重复执行重用数据库，不切换既有 ID；403 明确停止，不自动修改 Token 权限或其他安全配置。未开启此开关时，不查询或创建未绑定的检测库。

现有 KV、业务 D1 或检测 D1 的显式覆盖 ID 如与当前生产绑定冲突，部署直接失败。检测库不能和业务 D1 使用同一 ID。其他未知资源绑定仍沿用已有的防覆盖保护。首次创建检测库后，在管理员首次调用管理接口时初始化 `probe_agents`、`probe_jobs`、`probe_tasks` 等独立表。

D1、Pages 请求和检测节点流量由自己的 Cloudflare/服务器账户承担。并发和轮询应按检测器数量控制；默认每检测器空闲 60 秒领取一次、运行中每 20 秒续租。

## 发布门槛

`Probe detector` 在 Linux amd64/arm64、macOS Intel/Apple Silicon 四个原生 runner 上执行带内核测试、禁止直接回退测试、单文件构建和 `--self-test`，并生成锁定 Mihomo 版本的源码与 vendor 依赖归档。

push/PR 不发布二进制或源码制品。手动 main `workflow_dispatch` 保留默认关闭的 `publish` 输入，但当前分发材料验收门槛仍为关闭状态：即使选择发布也不会上传或发布。后续需独立审核对应源码、生成的 CA 数据及所有依赖 LICENSE/NOTICE，再通过 PR 打开这道门槛；四平台测试通过本身不足以解锁发布。既有同名 Release 不覆盖、不删除，新版本需显式更新版本与 tag。

现有 `probe-v0.1.0` 已由此前 PR #14 于 2026-10-12 发布，含四个运行包、SHA256SUMS 和源码归档；它不含后续 #11 安全修复。现有生产资源和发布资产不会被本次修复修改或撤回。详见[分发材料检查](./detector-hardening.md)。

## 手动生产验收

只有 main 上手动 `workflow_dispatch` 并主动勾选默认关闭的 `accept_node_probes`，才会构建 Linux 检测器并在 Pages 发布后执行 `scripts/smoke-node-probes.mjs`。它独立于数据库配置开关。脚本还要求 `RUN_NODE_PROBE_ACCEPTANCE=true` 并拒绝 Actions 的 push/PR/非 main 调用，在任何网络访问和凭据检查之前停止。此手动验收会产生以下生产副作用，必须单独授权，本轮不执行：

1. 从 Cloudflare API 核对实际生产域名、部署状态与本次 Git SHA，不猜测 `pages.dev` 子域名。
2. 检查检测 API 未登录返回 401，然后使用已有登录密码登录；失败时不改密码、不重置会话 Secret。
3. 创建两个临时检测器身份，给每个身份写 0600 临时配置，以真实单文件检测器领取、执行并回传同一批节点快照任务。
4. 测试节点使用保留文档地址 `198.51.100.1`。五项必须返回格式通过、四项网络检测明确阻止 unsafe_target；不访问用户节点、不访问流媒体目标、不产生测速下载。
5. 验证重复提交幂等、两个地点结果独立且没有凭据，最后撤销临时身份并删除配置。测试记录保留正常审计周期，名称明确带 CI 标记。

这验证的是**生产控制面 + 实际检测器通信 + 安全拒绝**。真正的代理链路由四平台 CI 的受控 CONNECT 代理验证；用户自己的节点延迟、下载速度和服务地区结果，仍需用户在其机器运行检测器后逐项确认。不能把保留地址安全测试说成真实节点全部测通或流媒体已解锁。

成功时 Actions Summary 给出实际生产 URL、部署 URL 与 Git SHA。部署已成功但冒烟失败会明确让工作流失败，不悄悄回滚或修改业务数据。排查时只记录固定错误码，不能输出服务端登录响应、节点 URI、检测器 Token 或内核原始日志。

## 本地验证

```sh
bash -n scripts/deploy-cloudflare-pages.sh
bash -n scripts/provision-probe-d1.sh
node --test tests/deployment/*.test.mjs
node --test tests/probes/*.check.mjs
npm run test:run
npm run build
```

生产冒烟只在有授权的部署环境运行，不向本地开发者要求粘贴生产凭据。

接口：[OpenAPI](./node-probes.openapi.yaml)。操作：[检测面板](./node-probes.md)。检测器：[运行指南](../detector/README.md)。
