# MiSub Probe / 独立节点检测器

本目录是主动拉取任务的 Linux、macOS 与 Windows 检测器源码。固定版本 Mihomo 嵌入单个可执行文件，运行时不依赖 Go、Python、Node.js 或 Docker。Windows 目标为 `windows-amd64`，要求 Windows 10 / Windows Server 2016 或更新版本的 x64 系统；不包含 Windows ARM64 或旧版 Windows。

[MiSub Probe 0.2.0](https://github.com/58cdn/MiSub/releases/tag/probe-v0.2.0) 于 2026-10-13 从 MiSub 提交 `9ccee76c3cab149f34dca96c304310c9574c0d29` 发行，提供 Linux/macOS 的 amd64、arm64 与 Windows amd64 原始可执行文件。安装入口核对固定版本、平台、长度、SHA256 与客户端能力。旧 `probe-v0.1.0` 不支持当前配对和用户级安装命令。发行资产可用不代表已完成你的设备安装或实际节点验收。

## 启动

未发布源码新增 [`--doctor` 本地只读诊断](../docs/detector-doctor.md)，可输出脱敏 JSON 报告，汇总构建、内核材料、安装记录与配置检查。已发布的 0.2.0 尚不支持此命令。

设置页在兼容发行可用时提供[一次复制的安装入口](../docs/detector-one-command-install.md)，下载、核验后进行网页批准和用户安装。Windows 默认命令直接运行已核验的 EXE；单独下载的 `install.ps1` 仅供本机执行策略已允许该脚本的高级使用者，不自动修改执行策略。Linux/macOS 使用 Bash 与系统 HTTPS、SHA256 工具；本源码发行的 macOS 最低版本为 13。

当前发行采用[固定源码构建与手动发行流程](../docs/detector-source-release.md)，随发行提供对应源码、构建配方、完整许可/通知材料及校验文件。历史[离线库存审计器](../docs/detector-distribution-audit.md)继续用于检查旧预编译归档，其 `ready: false` 不代表新源码发行的门槛结果。新流程独立验证源码、实际链接文件许可映射、重复构建输出和 GitHub 构建来源证明。

已有草稿可按[恢复流程](../docs/detector-draft-recovery.md)重新核验全部产物和原签名运行，再公开同一个 Release ID。恢复不重建或替换程序；发行程序的原源码提交与恢复工具提交分别记录。

### 安装并连接

1. 进入“设置 → 数据与集成 → 添加 / 管理检测器 → 安装并连接检测器”，选择目标设备使用的 Linux/macOS Bash 或 Windows PowerShell。
2. 开启五分钟安装窗口，复制完整命令，在目标设备的普通用户终端运行。命令会下载、校验客户端，无需先下载程序或切换目录。
3. 在网页输入终端短码，核对站点、会话指纹和客户端声明后批准。默认入口保存私密配置、安装并显式启动；回到管理页确认首次真实通信。

站点和窗口 ID 是公开关联信息，不能单独授权。过期或取消的窗口不可复用。安装中断但配置已保存时使用页面的“恢复已有安装”，它不重新配对或领取身份。完整步骤与平台前提见[一次复制安装说明](../docs/detector-one-command-install.md)。

### 高级方式：直接配对 CLI

已取得并核验本版本程序的用户可以单独运行 `--pair`。该命令只保存配置并退出，不安装、不启动；下列示例不是网页默认的一次复制命令：

```sh
misub-probe --pair --server https://your-misub.example --pair-window <window-id> --config <private-config-path>
```

将占位符替换为实际值。Linux/macOS 配置路径必须是绝对路径，例如 `"$HOME/.misub-probe/probe.json"`；客户端可创建最后一层 0700 私有目录，已有配置父目录也必须属于当前用户且权限为 0700，路径中不允许符号链接。

Windows 在普通用户的 PowerShell 中使用对应本地程序，默认私密目录为 `%LOCALAPPDATA%\MiSubProbe`：

```powershell
.\misub-probe-windows-amd64.exe --pair --server https://your-misub.example --pair-window PUBLIC_WINDOW_ID --config "$env:LOCALAPPDATA\MiSubProbe\probe.json"
```

Windows 使用仅当前用户与 SYSTEM 可访问的受保护 ACL；配对可创建最后一层私密目录，已有目录或文件权限不安全时拒绝继续，不自动更改权限。路径必须是支持持久 ACL 的本地卷上的绝对路径，不接受 UNC、设备路径、符号链接或目录联接；详细路径限制见 [Windows 说明](../docs/detector-windows.md)。

不要把长期凭据或私密设备证明放入命令行。客户端会显示短码、站点和本次随机请求的比对指纹；在网页输入短码，核对这三项以及客户端声明的名称、平台与版本后明确批准。该指纹用于比对会话，不是硬件身份认证。

客户端只在批准后一次领取长期凭据，安全保存配置并退出。配对不会启动代理内核、领取节点任务、安装服务或启用自启；之后显式执行 `misub-probe --config <private-config-path>` 才开始运行。页面中的“身份已创建”与“首次通信”分别表示兑换完成和实际收到领单/心跳。

配置通过完整写入后原子发布保存，已有目标不会被覆盖。配对过期、取消或已兑换无法再次领取凭据；若成功响应丢失或本机保存失败，在网页撤销该未连接身份后重新配对。完整协议见[配对 API 契约](../docs/detector-pairing-api.md)。

### 高级方式：手动配置

1. 需要手动管理凭据时，在“添加 / 管理检测器”使用高级手动创建入口，下载一次性生成的 `probe.json`。每台机器使用不同的配置；不要把同一个身份复制到多台机器。
2. 从 [MiSub Probe 0.2.0](https://github.com/58cdn/MiSub/releases/tag/probe-v0.2.0) 取得匹配平台的原始程序，并按发行的校验文件与来源证明核验。目标为 `linux-amd64`、`linux-arm64`、`darwin-amd64`、`darwin-arm64` 和 `windows-amd64`；Windows 文件名为 `misub-probe-windows-amd64.exe`。旧 `probe-v0.1.0` 不能用于以下管理命令。

```sh
chmod 600 probe.json
chmod 700 misub-probe-linux-amd64
./misub-probe-linux-amd64 --check-config --config ./probe.json
./misub-probe-linux-amd64 --self-test
./misub-probe-linux-amd64 --config ./probe.json
```

Windows 的手动配置也必须满足私密 ACL 检查；普通下载目录中的文件不应直接作为私密配置。优先使用配对流程创建合格目录和文件，然后运行：

```powershell
.\misub-probe-windows-amd64.exe --check-config --config "$env:LOCALAPPDATA\MiSubProbe\probe.json"
.\misub-probe-windows-amd64.exe --self-test
.\misub-probe-windows-amd64.exe --config "$env:LOCALAPPDATA\MiSubProbe\probe.json"
```

在 MiSub 选择检测器与节点后提交任务即可。Ctrl-C 正常停止。`--once` 最多处理一条待测节点任务后退出；`--version` 显示构建版本。配置包含可读取授权节点凭据的 Token，请勿提交、粘贴到聊天或打印到日志。丢失配置时撤销该身份并重新创建，不能再次读取旧 Token。

不需要公网 IP、入站防火墙规则、SSH、TUN、系统代理或管理员权限。内核只在本机回环地址短暂监听，并使用随机认证；不会设置系统网络。使用普通用户运行。内核使用系统 CA，TLS 证书验证保持启用；Linux 需要已安装的系统 CA 证书，缺少可信根会返回 TLS 错误。Linux 最低内核为 3.2，macOS 为 13，Windows 为 Windows 10 / Server 2016 x64；默认安装另需可用的用户服务环境。各平台须允许从私有用户目录执行程序。系统或组织策略阻止执行时应由用户核实程序来源并按本机规则处理，安装流程不会关闭系统防护或修改执行策略。

“无依赖”不等于“只联网 MiSub 就能测任何节点”：检测机仍必须能连到 MiSub、节点服务器，并经节点访问测试站点。首次安装可在别处下载后传到检测机；运行时不访问 GitHub 下载内核。

## 六类检测及结果含义

| 类型           | 实际执行                                                                                          | 边界                                                                                                               |
| -------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `format`       | MiSub 的 URI 解析、必须字段检查                                                                   | 格式合法不是测活；不支持的路由参数明确返回 unsupported                                                             |
| `tcp`          | 检测机到节点公开 IP/端口的 TCP 建连                                                               | HY/HY2/TUIC/WireGuard 等 UDP 协议返回不适用，不据此否决真实代理检测                                                |
| `proxy`        | 经过所选节点请求固定 HTTPS 204 地址                                                               | 包含协议、TLS、HTTP 开销，不称为 TCP RTT；必须空响应 204 才通过                                                    |
| `speed`        | 经过节点读取固定测速站点的限量数据                                                                | 仅显式选择；默认 5 MiB、最多 20 MiB/节点/次；界面显示最坏重试预算                                                  |
| `unlock`       | 经节点探测 Netflix、YouTube、OpenAI、Claude、Gemini、Disney+、Spotify、TikTok 的固定公开页面/接口 | 返回明确地区拒绝、限流、挑战/未知、可访问但解锁未知；不把普通 200/401 或 Netflix CDN 地址当作能播放/账号可用的证明 |
| `observations` | 经节点访问选定的固定 HTTPS 来源，记录出口 IP、国家、ASN 与可选的 IPPure 质量证据                  | 各来源独立保留时间、错误、未知值和冲突；IPPure 为实验性来源，IPinfo 未配置，来源请求耗时不作为节点延迟             |

服务检测是**网络侧可用性证据**，不登录、不申请 API Key、不验证订阅套餐或真实播放。所有普通网页成功仍保留 `status=unknown, code=service_reachable`，明确拒绝才标记 blocked。服务规则会随平台变化，空结果或挑战页不能显示绿色“已解锁”。这一保守语义有回归测试。

同一节点在不同检测器上的结果分别展示，不能把一个云服务器的延迟视为用户本机的延迟。测速读数使用 bytes/s，界面可换算 MiB/s。限额指读取的应用数据，TLS/TCP 头、预读缓冲和协议握手还有额外流量，不能当作运营商精确计费上限。默认不启用测速；检查流量计费后再勾选。

## 安全与任务生命周期

检测器只使用固定 HTTPS MiSub 源，拒绝 API 重定向，不读取系统代理环境变量。原始节点配置只交给授权检测器；任务领取后保留在内存与私有临时文件中，任务退出清理。Linux/macOS 使用 0700 目录与 0600 配置；Windows 使用当前用户与 SYSTEM 的受保护 ACL。Windows 内核无窗口启动，并在执行前加入 Job Object；取消或检测器进程退出会终止其内核及子进程。进程被强制终止或断电后无法保证临时文件清理，系统临时目录仍应按本机策略定期清理。

节点目标拒绝 loopback、私网、链路本地、CGNAT、保留/文档/组播地址、云元数据目标，以及包含私网答案的 DNS 结果。通过校验后固定目标 IP，并保留协议支持的 TLS 身份；无直接联网回退。当前内核的 SOCKS5 TLS 不支持独立 SNI，因此域名服务器与自定义身份明确返回 unsupported；不会关闭验证来补偿。链式代理、额外路由/次级目标、任何层级的 skip-cert-verify 与当前未安全支持的传输参数同样返回 unsupported。Provider 请求仍由节点侧处理目标域名，不替换为检测机的 DNS 结果。

HTTP 429 在读取响应体前保留为 `unknown/rate_limited`，合法 `Retry-After` 归一化为 0–86400 秒；无效值丢弃，不回传原始头或错误文本。检测器不会自动重试该来源。

每个检测器身份只有一条有效租约，90 秒超时、20 秒心跳，失去续租立即取消检测并终止内核。结果重复发送幂等；丢失回执不重新测速。最多三次任务尝试，24 小时任务有效期。离线任务留在对应地点等待恢复，不让另一个地点冒名回填。多个地点测试时创建节点×检测器任务矩阵。

默认空闲 60 秒轮询、任务结束后继续领取下一条；配置 `pollSeconds` 可设 30–300。多台检测器会产生 Pages/D1 请求与写入，注意账户额度。任务不会删除、禁用、重命名原始节点。

## 用户级安装管理

以下为已取得并核验本版本程序后的高级管理命令。默认安装请使用上文的一次复制入口。示例使用 Linux amd64 文件，macOS 替换为对应平台文件名；旧 `probe-v0.1.0` 不包含这些命令。

```sh
./misub-probe-linux-amd64 --install --config "$HOME/.misub-probe/probe.json"
./misub-probe-linux-amd64 --start
./misub-probe-linux-amd64 --status --json
./misub-probe-linux-amd64 --stop
./misub-probe-linux-amd64 --reinstall
./misub-probe-linux-amd64 --uninstall
```

单独的 `--install` 只复制当前程序并生成私有清单与进程描述，不联网配对或启动进程；`--pair` 只保存配置；`--start` 在已有有效私密配置后显式启动。网页默认入口依次完成这些操作，Windows 使用原生 `--setup`。Linux 使用当前用户的 systemd 会话和临时关联，macOS 使用当前用户 GUI 会话的显式 launchd 加载。登录自动启动、系统服务、`linger`、提权、系统代理和 TUN 均不由安装流程配置。

重装和卸载要求服务已停止；文件内容、归属或注册信息不明时拒绝修改。重装复用原配置路径且不自动启动，卸载保留配置及服务器撤销状态。`--status` 表示本机进程状态，连接 MiSub 仍以管理页实际通信为准。进程运行时可在断网后继续等待恢复，凭据失效则退出；没有自动崩溃重启。具体目录与恢复限制见[用户安装说明](../docs/detector-user-install.md)。

Windows 在非管理员 PowerShell 中使用相同管理选项：

```powershell
.\misub-probe-windows-amd64.exe --install
.\misub-probe-windows-amd64.exe --start
.\misub-probe-windows-amd64.exe --status --json
.\misub-probe-windows-amd64.exe --stop
.\misub-probe-windows-amd64.exe --reinstall
.\misub-probe-windows-amd64.exe --uninstall
```

Windows 默认配置为 `%LOCALAPPDATA%\MiSubProbe\probe.json`，安装目录为 `%LOCALAPPDATA%\MiSubProbe\install`。`--install --config <绝对路径>` 可指定安装目录之外的其他私密配置。安装结果和 `--status --json` 的 `executablePath` 提供已核验的程序路径；安装后的文件名为 `<安装目录>\<代号>\misub-probe.exe`。`--start` 创建无窗口的用户进程，不注册 Windows 服务、计划任务、开机启动或 PATH；启动和停止须处于同一用户的同一 Windows 登录会话。

Windows 的私密 `runtime.json` 保存进程 PID、创建时间、程序路径与用户 SID，停止前核验这些值，避免把复用的 PID 当成原进程；这些值不是硬件身份认证。`--status` 只检查本机状态，不验证 MiSub 连接。重装和卸载前须停止；重装保留配置及旧代文件，最多八代。Windows 无法删除正在执行的自身程序，因此从安装目录内运行 `--uninstall` 会在删除前拒绝；请用安装目录之外另一份已核验可信的本地程序卸载。卸载保留配置与服务器身份，停用设备时另在网页撤销。详见 [Windows 安装与安全说明](../docs/detector-windows.md)。

## 可选开机运行

Linux/macOS 用户可在完成前台 `--self-test` 与一条任务验收后另行配置开机运行。仓库提供 `services/misub-probe.service`（Linux 用户服务）和 `services/com.misub.probe.plist`（macOS LaunchAgent）模板，替换绝对路径后再安装。不会自动要求 sudo、创建系统用户或修改防火墙。Windows 管理命令不提供开机运行配置。日志只输出固定状态，不输出配置、Token、URI 或内核原始日志。

## 源码构建与测试

当前发行使用[源码构建配方](../docs/detector-source-build.md)和[原生构建/发行流程](../docs/detector-source-release.md)。`source-build-lock.json` 固定 Mihomo 提交 `88dcbf7f1614a67c3b36b848ee3592dfa92ada36`、vendor 与标准 Go 1.27.2 工具链，内核版本为 `v1.19.32-misub-source`。构建机需要 Python 3.10 或更新版本与对应构建工具，安装、运行已发行程序不需要 Go、Python、Node.js 或 Docker。

五个原生目标运行 race、vet、真实内核回环测试和本地引导 fixture；同一配方双构建要求内核与 wrapper 字节一致。Windows race 测试另需兼容的 MinGW-w64 编译器。交叉编译或跳过真实内核测试不能代替原生验证。

核心启动在共享的 10 秒预算内，通过带认证 HTTP 入站到专用临时回环端点的完整随机标识握手确认能处理请求；控制接口可响应、端口可连接或 CONNECT 200 均不足以判定就绪。端点不转发目标，握手不访问真实节点、不计为节点延迟，结束或取消时关闭端点及连接。普通检测仍只经过所选节点，不提供直连回退，详见[本机就绪设计](../docs/detector-core-readiness.md)。

源码保留上游空的嵌入 CA 文件，采用上游系统证书池路径；不注入额外根证书，也不关闭 TLS 验证。旧 `kernel-lock.json` 和 `bundle.py` 描述历史上游预编译内核，不是新源码发行的构建入口。CI 回环测试不证明实际用户节点或地区解锁状态。

## 许可证与来源

MiSub 检测器包装代码沿用仓库 MIT 许可证。Mihomo 以独立子进程运行，保留其 GPL-3.0 及依赖许可。发行页提供本版本的 wrapper、内核和工具链对应源码、构建配方及完整许可/通知材料，入口见随包 `SOURCE.md`。镜像分发也须保留对应材料及各自许可。材料与来源验证范围见[源码发行说明](../docs/detector-source-release.md)，旧版本的分发事实见[安全与分发记录](../docs/detector-hardening.md)。

- 内核：<https://github.com/MetaCubeX/mihomo/tree/88dcbf7f1614a67c3b36b848ee3592dfa92ada36>
- 上游 Release：<https://github.com/MetaCubeX/mihomo/releases/tag/v1.19.32>
- 构建和许可：上游源码中的 `go.mod`、`go.sum`、`LICENSE` 及 `vendor` 目录。
- 设计参考：<https://github.com/beck-8/subs-check>；没有复制其 GPL 检测实现或内置 API 凭据。
