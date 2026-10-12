# MiSub Probe / 独立节点检测器

本目录是主动拉取任务的 Linux/macOS 检测器。发行包内的单个可执行文件已包含固定版本的 Mihomo；用户不必安装 Go、Python、Node.js、Docker 或代理内核。构建过程使用 Python/Go，运行过程不使用。

## 启动

1. 在 MiSub 节点页打开“节点检测 / 检测器”，创建一台检测器，下载一次性生成的 `probe.json`。每台机器使用不同的配置；不要把同一个身份复制到多台机器。
2. 从本仓库 `probe-v*` Release 下载匹配系统和 CPU 的压缩包，验证 SHA256 后解压。`linux-amd64` 对应常见 x86 服务器，`linux-arm64` 对应 ARM 服务器；`darwin-amd64` 是 Intel Mac，`darwin-arm64` 是 Apple Silicon。
3. 在文件所在目录执行（替换为下载包内的实际文件名）：

```sh
chmod 600 probe.json
chmod 700 misub-probe-linux-amd64
./misub-probe-linux-amd64 --check-config --config ./probe.json
./misub-probe-linux-amd64 --self-test
./misub-probe-linux-amd64 --config ./probe.json
```

在 MiSub 选择检测器与节点后提交任务即可。Ctrl-C 正常停止。`--once` 最多处理一条待测节点任务后退出；`--version` 显示构建版本。配置包含可读取授权节点凭据的 Token，请勿提交、粘贴到聊天或打印到日志。丢失配置时撤销该身份并重新创建，不能再次读取旧 Token。

不需要公网 IP、入站防火墙规则、SSH、TUN、系统代理或管理员权限。内核只在本机回环地址短暂监听，并使用随机认证；不会设置系统网络。建议用普通用户运行。Linux 必须有正常的系统 CA 证书；Linux/macOS 必须允许在用户临时目录执行文件。macOS 未签名程序可能需要通过系统安全设置进行一次明确批准；不要批量关闭 Gatekeeper。

“无依赖”不等于“只联网 MiSub 就能测任何节点”：检测机仍必须能连到 MiSub、节点服务器，并经节点访问测试站点。首次安装可在别处下载后传到检测机；运行时不访问 GitHub 下载内核。

## 五类检测及结果含义

| 类型 | 实际执行 | 边界 |
| --- | --- | --- |
| `format` | MiSub 的 URI 解析、必须字段检查 | 格式合法不是测活；不支持的路由参数明确返回 unsupported |
| `tcp` | 检测机到节点公开 IP/端口的 TCP 建连 | HY/HY2/TUIC/WireGuard 等 UDP 协议返回不适用，不据此否决真实代理检测 |
| `proxy` | 经过所选节点请求固定 HTTPS 204 地址 | 包含协议、TLS、HTTP 开销，不称为 TCP RTT；必须空响应 204 才通过 |
| `speed` | 经过节点读取固定测速站点的限量数据 | 仅显式选择；默认 5 MiB、最多 20 MiB/节点/次；界面显示最坏重试预算 |
| `unlock` | 经节点探测 Netflix、YouTube、OpenAI、Claude、Gemini、Disney+、Spotify、TikTok 的固定公开页面/接口 | 返回明确地区拒绝、限流、挑战/未知、可访问但解锁未知；不把普通 200/401 或 Netflix CDN 地址当作能播放/账号可用的证明 |

服务检测是**网络侧可用性证据**，不登录、不申请 API Key、不验证订阅套餐或真实播放。所有普通网页成功仍保留 `status=unknown, code=service_reachable`，明确拒绝才标记 blocked。服务规则会随平台变化，空结果或挑战页不能显示绿色“已解锁”。这一保守语义有回归测试。

同一节点在不同检测器上的结果分别展示，不能把一个云服务器的延迟视为用户本机的延迟。测速读数使用 bytes/s，界面可换算 MiB/s。限额指读取的应用数据，TLS/TCP 头、预读缓冲和协议握手还有额外流量，不能当作运营商精确计费上限。默认不启用测速；检查流量计费后再勾选。

## 安全与任务生命周期

检测器只使用固定 HTTPS MiSub 源，拒绝 API 重定向，不读取系统代理环境变量。原始节点配置只交给授权检测器；任务领取后保留在内存与 0700 私有临时目录里的 0600 内核配置，任务退出清理。SIGKILL/断电不能执行清理，系统临时目录仍应按本机策略定期清理。

节点目标拒绝 loopback、私网、链路本地、CGNAT、保留/文档/组播地址、云元数据目标，以及包含私网答案的 DNS 结果。通过校验后固定目标 IP，同时保留 SNI；无直接联网回退。链式代理、额外路由/次级目标、关闭 TLS 验证及当前未安全支持的传输参数返回 unsupported，不悄悄更改后报告通过。

每个检测器身份只有一条有效租约，90 秒超时、20 秒心跳，失去续租立即取消检测并终止内核。结果重复发送幂等；丢失回执不重新测速。最多三次任务尝试，24 小时任务有效期。离线任务留在对应地点等待恢复，不让另一个地点冒名回填。多个地点测试时创建节点×检测器任务矩阵。

默认空闲 60 秒轮询、任务结束后继续领取下一条；配置 `pollSeconds` 可设 30–300。多台检测器会产生 Pages/D1 请求与写入，注意账户额度。任务不会删除、禁用、重命名原始节点。

## 可选开机运行

先完成前台 `--self-test` 与一条任务验收。仓库提供 `services/misub-probe.service`（Linux 用户服务）和 `services/com.misub.probe.plist`（macOS LaunchAgent）模板，替换绝对路径后再安装。不会自动要求 sudo、创建系统用户或修改防火墙。日志只输出固定状态，不输出配置、Token、URI 或内核原始日志。

## 源码构建与测试

```sh
cd detector
python3 scripts/bundle.py linux-amd64
MISUB_PROBE_REQUIRE_KERNEL=1 go test -race ./...
CGO_ENABLED=0 go build -trimpath -o misub-probe .
./misub-probe --self-test
```

仅构建机需要 Python 3 和 Go；只从锁定的官方地址下载并验证 SHA256。源代码单元测试可不下载内核执行 `go test -race ./...`，此时两个真实内核测试会跳过；不能据此声称代理链路已通过。发行 CI 在 Linux/macOS 两种 CPU 的原生 runner 上执行内核测试，校验请求确实通过指定代理、坏节点不直接回退，再生成发行包。

Mihomo 固定 `v1.19.32` / `88dcbf7f1614a67c3b36b848ee3592dfa92ada36`，四平台压缩文件 SHA256 记录于 `kernel-lock.json`。原生构建、代理 fixture、真实用户节点验收是不同层次；CI fixtures 不证明你已有节点的地区解锁状态。

## 许可证与来源

MiSub 检测器包装代码沿用仓库 MIT 许可证。Mihomo 以独立子进程运行，保留其 GPL-3.0 及依赖许可，不声称内核可以改按 MIT 分发。发行包附上内核许可和来源，Release 同时提供锁定内核的源码（含 vendor 依赖）。镜像分发时也要保留对应源码入口与许可。

- 内核：<https://github.com/MetaCubeX/mihomo/tree/88dcbf7f1614a67c3b36b848ee3592dfa92ada36>
- 上游 Release：<https://github.com/MetaCubeX/mihomo/releases/tag/v1.19.32>
- 构建和许可：上游源码中的 `go.mod`、`go.sum`、`LICENSE` 及 `vendor` 目录。
- 设计参考：<https://github.com/beck-8/subs-check>；没有复制其 GPL 检测实现或内置 API 凭据。
