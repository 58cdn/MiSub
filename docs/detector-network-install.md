# 检测器短网络安装入口

在设置页选择 Windows PowerShell 或 Linux / macOS，开启安装窗口后复制网络命令。命令从 `58cdn/MiSub` 的固定 Probe 发行下载安装脚本，先验证长度和 SHA-256，再运行。站点和公开窗口编号只作为参数；长期凭据由检测器保存，不进入命令。已有配置使用独立恢复命令。

## 为什么保留一小段引导代码

目前采用发行目录中的 `install.sh` / `install.ps1`，不新增下载路由或脚本镜像。版本、脚本摘要与二进制摘要由同一已核验目录绑定，复用正式发行的来源证明。命令不接受用户指定的脚本 URL，不使用 `latest`、可变分支、短网址或当前 MiSub 站点作为代码来源。

仅把 URL 接到 `curl | bash` 或 `irm | iex` 会失去完整下载、摘要校验和失败不执行的保证。固定提交上的静态脚本可以省去发行 CDN 跳转处理，但还需要单独的脚本发行、来源证明与切换门槛；本入口复用已有固定版本发行，减少独立信任对象。

## 安全与运行范围

- 首次请求固定为 `https://github.com/58cdn/MiSub/releases/download/probe-vX.Y.Z/install.sh` 或 `install.ps1`，最多允许两次 HTTPS 跳转到 `release-assets.githubusercontent.com` / `objects.githubusercontent.com`。用户信息、显式端口、反斜线、空白、片段和其他主机不作为跳转目标。
- 每次请求最多 45 秒，共至多三次请求。第一阶段不自动重试，失败由用户检查网络后重新执行；原安装器的有界下载重试保持原有行为。
- 第一阶段脚本最多 64 KiB；Unix 额外允许 8 KiB 状态尾标空间，超过即拒绝。Unix 只接受无 NUL、无 CR 的 LF 文本，保留末尾换行后核对精确长度与 SHA-256。Windows 限制整个响应缓冲，先核验原始字节，再严格 UTF-8 解码。非法内容不会进入脚本解析或安装。
- 校验完成前不写入磁盘，也不运行远端代码。脚本保存在内存中，避免临时脚本文件的替换竞态。下载公共脚本后，原发行安装器才检查平台、普通用户、私有目录、既有配置、二进制长度/摘要和版本能力；不跳过这些检查。
- 配对参数沿用 HTTPS 规范站点、公开 UUID 与窗口有效期检查。恢复命令不带站点或旧窗口。脚本失败后的配置保护与恢复仍由发行安装器负责。
- Windows 使用交互式、摘要固定的内存脚本；它与 `.ps1` 文件的来源标记/签名执行规则不同。显式 MachinePolicy/UserPolicy 的 Restricted、AllSigned、RemoteSigned，以及有效 AllSigned 均在网络请求前拒绝。普通本地 Restricted/RemoteSigned 仍可运行用户粘贴的交互命令。入口不设置执行策略、不解锁文件、不请求提权；语言模式和应用控制限制仍可能拒绝执行，应联系设备管理员。
- Bash 需要 `curl`、`head`、`tr`、`sha256sum` 或 `shasum`；Windows 需要 PowerShell 5.1+ 与系统 HttpClient。平台要求继续为 Windows x64 10 / Server 2016+、macOS 13+、具有用户级 systemd 的 Linux，Unix 自动识别 amd64/arm64。

## 网络和代理

Unix 使用终端的 curl 代理环境，忽略 `.curlrc`，要求 HTTPS 和证书校验。Windows 0.2.0 的安装脚本和此入口均要求直接 HTTPS 访问 GitHub，不使用系统代理，也不发送当前 Windows 登录凭据。Windows 使用系统 TLS 设置，不更改进程或系统安全设置。

网络、HTTP、跳转、长度、摘要或编码失败显示固定提示，不回显响应正文、代理 URL 或下载异常原文。请先检查 GitHub HTTPS 连通性；Unix 还应检查终端代理。不得通过关闭证书验证、放宽脚本策略或替换下载主机解决错误。过期窗口需返回网页重新准备；已保存配置使用恢复入口。

## 各平台示例

下面的文本文件是由真实 0.2.0 元数据生成的**展示示例，不要执行**。`https://misub.fixture.invalid` 和示例公开 UUID 都是无效合成数据；实际命令应从自己的安装页复制。

| 平台                | 终端                     | 安装命令示例                                       |
| ------------------- | ------------------------ | -------------------------------------------------- |
| Windows x64         | 普通用户 PowerShell 5.1+ | [Windows 命令](examples/probe-install-windows.txt) |
| macOS amd64 / arm64 | Bash 3.2+                | [Unix 命令](examples/probe-install-unix.txt)       |
| Linux amd64 / arm64 | Bash                     | [Unix 命令](examples/probe-install-unix.txt)       |

示例保留全部验证步骤，不提供省略校验的快捷形式。

## 新版本切换计划

本入口使用已公开的 0.2.0 字节，不能通过修改仓库模板改变这些资产。Windows 权限提示工作由 [#34](https://github.com/58cdn/MiSub/issues/34) / [#36](https://github.com/58cdn/MiSub/pull/36) 独立处理；其新脚本提示只有进入新 Probe 发行后才会出现在短入口中。

解冻并取得发行授权后，选择尚未占用的新版本（例如 `0.2.1`，以发行时核实为准），从已审查提交执行现有五平台原生构建、许可材料与来源证明门槛。新标签和资产必须一次创建；公开后匿名回读七项安装资产的精确字节，单独审核 `release-catalog.json` 的版本、提交、能力、长度和摘要，再切换网页目录。新 Unix 脚本需保持 LF/无 NUL，两个脚本不超过 64 KiB。不替换或追加改写 0.2.0 安装资产。

当前受 [#33](https://github.com/58cdn/MiSub/issues/33) 调查冻结约束，交付为草稿 PR；合并、部署、发行和生产写入均不执行。自动化验证使用合成传输和只输出标记的脚本，不代表真实安装、配对、身份创建、自启动或节点检测验收。
