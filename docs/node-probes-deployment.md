# 节点检测部署与验收

本功能继续使用已有 GitHub Actions → Cloudflare Pages 部署链路。原有 `MISUB_KV`、`MISUB_DB` 原样保留；检测器身份、任务租约和结果使用独立 `MISUB_PROBE_DB`，不会迁移订阅源或节点表。

## Cloudflare 权限

已有三个 Repository Secrets 仍为 `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`、`ADMIN_PASSWORD`。无需提交数据库 ID 或新增检测器 Token Secret。Cloudflare API Token 除原来的 Pages/KV 权限，还需要目标账户的 **D1 Edit/Write**（控制台通常显示 Account / D1 / Edit）。仅需在 Cloudflare 调整现有 Token 的权限；不要把 Token 值粘贴到 issue、聊天或日志。

工作流设置 `PROVISION_NODE_PROBES=true`，`scripts/provision-probe-d1.sh` 先保留已绑定的 `MISUB_PROBE_DB`，否则按稳定名称 `<Pages项目名>-probes` 查找/创建独立数据库。重复执行重用数据库，不重复创建，不切换既有 ID；403 会明确停止，不伪装成不存在后另建资源。未指定此开关的手工运行仍保留已有绑定，但不会自动创建。

现有 KV、业务 D1 或检测 D1 的显式覆盖 ID 如与当前生产绑定冲突，部署直接失败。检测库不能和业务 D1 使用同一 ID。其他未知资源绑定仍沿用已有的防覆盖保护。首次创建检测库后，在管理员首次调用管理接口时初始化 `probe_agents`、`probe_jobs`、`probe_tasks` 等独立表。

D1、Pages 请求和检测节点流量由自己的 Cloudflare/服务器账户承担。并发和轮询应按检测器数量控制；默认每检测器空闲 60 秒领取一次、运行中每 20 秒续租。

## 发布门槛

`Probe detector` 在 Linux amd64/arm64、macOS Intel/Apple Silicon 四个原生 runner 上执行带内核测试、禁止直接回退测试、单文件构建和 `--self-test`，并生成锁定 Mihomo 版本的源码与 vendor 依赖归档。

相关变更合并 main 后，只有本次四平台和源码任务全部通过才首次发布 `probe-v0.1.0`。已经存在的同名 Release 不会覆盖；新的版本必须显式更新版本与 tag。手动 workflow_dispatch 仍可使用 `publish=true` 触发同样门槛。PR 不发布、不获取生产 Secrets。

Release 含四个运行包、SHA256SUMS 和内核对应源码。用户运行无需下载内核或安装编程运行时；只需要下载对应包、在 MiSub 创建检测器并保存私密配置。

## 自动生产验收

`Cloudflare Pages` 在主项目全量测试/构建之后构建 Linux 检测器、部署 Pages，再执行 `scripts/smoke-node-probes.mjs`：

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
