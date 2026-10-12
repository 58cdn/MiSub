# 更新日志

本文件记录 MiSub 项目的重要变更。

日志格式遵循 [Keep a Changelog 1.1.0](https://keepachangelog.com/zh-CN/1.1.0/)，版本管理遵循 [Semantic Versioning（语义化版本）2.0.0](https://semver.org/lang/zh-CN/)。

MiSub 主应用与 MiSub Probe 独立维护版本；检测器 Git 标签采用 `probe-vX.Y.Z`。

## [未发布]

组件：MiSub 主应用与 MiSub Probe。

### 新增

- 手动节点页支持“选择节点”“检测选中”和“检测全部”；全部检测覆盖跨页的手动节点，包含已禁用节点，检测使用点击时的节点快照。（[#12]）
- 支持格式检查、TCP 端口检测、真实代理连通性与请求延迟、限量下载测速、流媒体与服务网络侧检测五类任务；格式检查可独立运行。（[#8]、[#12]）
- 支持多地点检测器的身份创建、最近心跳查看、凭据撤销和一次性私密配置下载；结果按节点与检测地点分别保存。（[#8]、[#12]）
- 提供任务进度、历史记录、结果分页、地点筛选、当前结果页的指定地点代理延迟排序、任务取消和原批次幂等重试。（[#12]）
- 提供 `/api/probes/v1` 管理与检测器接口及 [OpenAPI 3.1 文档](docs/node-probes.openapi.yaml)，支持已保存的全部手动节点、指定节点 ID 和已解析节点快照三种任务范围。（[#8]、[#12]）
- 使用独立 `MISUB_PROBE_DB` D1 保存检测任务、租约和结果，业务存储继续使用 `MISUB_KV` / `MISUB_DB`。（[#8]）
- 提供中英文界面、暗色与移动布局、[节点检测操作说明](docs/node-probes.md)和[部署说明](docs/node-probes-deployment.md)。（[#12]、[#14]）
- 新增 `AGENTS.md`，定义 Agent 交付要求、更新日志与版本规范以及提交检查规则。（[#15]）

### 变更

- Cloudflare Pages 保留普通代码测试、构建与主分支部署；新增检测 D1 配置和创建临时检测器身份的生产验收分别由默认关闭的手动选项控制，自动推送和 PR 不执行这两项操作。（[#11]）
- 检测器二进制、源码制品上传及 Release 发布暂停，待许可证、NOTICE 与完整对应源码等分发材料核验完成后，经独立审查恢复手动发布；既有发行版本保持不变。（[#11]）

### 修复

- 浏览器 HTTP 检测正确区分请求成功、失败和超时，显示浏览器请求耗时。（[#6]）
- 检测器在读取响应体前保留代理、测速和服务检测的 HTTP `429`，返回经过校验的 `Retry-After` 等待秒数（`0–86400`）；不自动重试，结果保持限流或未知状态。（[#11]）

### 安全

- 管理端使用登录 Cookie 与同源写入校验；检测器使用独立、可撤销的 Bearer Token，服务端保存凭据摘要，结果采用脱敏字段白名单。（[#8]、[#12]）
- 网络检测需授权将节点凭据发送给选定检测器；测速默认关闭，需单独确认流量。默认每节点每次读取 `5 MiB`，最多 `20 MiB`；包含最多三次尝试的整体应用数据读取预算为 `1 GiB`，协议头、握手与缓冲另有开销。（[#8]、[#12]）
- 任务采用原子领取与 `90` 秒租约，每个检测器身份最多持有一条有效租约；支持最多三次尝试、幂等回传及越权、过期、取消和撤销校验。（[#8]）
- 任务完成或取消后清理任务中的节点凭据副本；任务有效期为 `24` 小时，记录保留七天，清理由后续 API 活动触发。（[#8]）
- 检测器在 DNS 查询前递归校验 TLS 选项，拒绝关闭证书校验、类型不符和内核等价字段别名；Hysteria2 Realm 等引入额外目标的配置返回不支持。（[#11]）
- SOCKS5 TLS 仅接受能够保留证书身份校验的 IP 字面量配置；域名或自定义证书名配置返回不支持。节点出口请求保持代理侧域名解析、证书校验和无直连回退。（[#11]）

## [MiSub Probe 0.1.0] - 2026-10-12

### 新增

- 提供 `detector/` 独立检测器和 Linux amd64、Linux arm64、macOS Intel、macOS Apple Silicon 四种单文件运行包，内置 Mihomo `v1.19.32`。（[#10]、[#14]）
- 通过 HTTPS 主动领取任务、续租并回传结果，支持多地点独立部署；每台机器使用独立身份，以普通用户运行。（[#10]）
- 支持格式检查、TCP 建连、经指定节点的 HTTPS 请求测试、限量下载测速及服务检测；原生 UDP 协议的 TCP 项返回不适用。（[#10]）
- 服务检测覆盖 Netflix、YouTube、OpenAI、Claude、Gemini、Disney+、Spotify 和 TikTok，提供地区拒绝、限流、挑战及可访问性等网络侧证据；账号权限与播放能力由实际服务使用情况决定。（[#10]）
- 提供 `--check-config`、`--self-test`、`--once`、`--version`、`--config` 选项、[运行指南](detector/README.md)、Linux 用户服务与 macOS LaunchAgent 模板。（[#10]）
- 发行页提供 `SHA256SUMS`、MiSub 与 Mihomo 根许可证，以及内核源码和 vendor 依赖归档。现有分发材料的依赖许可证、NOTICE 和生成 CA 数据等内容仍需补全与核验，详见[检测器安全与分发边界](docs/detector-hardening.md)。（[#10]、[#14]）

### 安全

- 构建与运行时校验内置内核的 SHA-256；内核仅监听回环地址并使用随机认证，配置文件权限为 `0600`，私有临时目录权限为 `0700`。（[#10]）
- 校验节点地址及全部 DNS 答案，拒绝私网、回环、链路本地、CGNAT、保留地址和云元数据目标；将节点服务器地址固定为通过校验的 IP。（[#10]）
- 拒绝顶层布尔值 `skip-cert-verify: true` 和已列明的额外路由及传输字段；代理请求通过所选节点，代理失败返回错误。（[#10]）
- 每 `20` 秒续租，续租失败即停止当前检测并终止内核；API 拒绝重定向，日志仅输出固定状态。（[#10]）

[未发布]: https://github.com/58cdn/MiSub/compare/3253e9b1c8767cd4ba490bd93d9d7281446f42c9...main
[MiSub Probe 0.1.0]: https://github.com/58cdn/MiSub/releases/tag/probe-v0.1.0
[#6]: https://github.com/58cdn/MiSub/pull/6
[#8]: https://github.com/58cdn/MiSub/pull/8
[#10]: https://github.com/58cdn/MiSub/pull/10
[#11]: https://github.com/58cdn/MiSub/pull/11
[#12]: https://github.com/58cdn/MiSub/pull/12
[#14]: https://github.com/58cdn/MiSub/pull/14
[#15]: https://github.com/58cdn/MiSub/pull/15
