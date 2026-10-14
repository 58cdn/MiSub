# Probe 源码构建与手动发行

`Probe source release` 工作流从固定 Mihomo 源码、vendor 和标准 Go 工具链构建
五个平台的检测器。每次 PR 或相关 main 变更都会运行原生构建与离线/回环测试。
仅 `workflow_dispatch` 的 `publish=true` 会进入发行步骤；默认值为 `false`。
发行版本必须是新版本，现存标签和 Release 均不可覆盖。

该流程与历史二进制库存审计分开。`audit_distribution.py` 的 `ready:false`
以及 `probe-detector.yml` 的发行冻结仍然有效。新流程不为历史内核补作来源证明。

## 构建输入与运行验证

源码构建配方见 [detector-source-build.md](detector-source-build.md)。
`detector/source-build-lock.json` 固定源码 commit、Git tree、完整压缩包 SHA256、
vendor 和五个平台的 Go 工具链摘要。构建器逐文件验证展开后的输入，Go 模块获取
关闭，使用 `with_gvisor`、固定构建时间和 `CGO_ENABLED=0`。同一配方执行两次，
内核与 wrapper 都必须得到相同字节。

wrapper 输入通过 `git archive` 从工作流的精确 commit 读取，并重建 Git tree
验证；本地未跟踪文件不会进入源码包。构建只在临时副本中生成该目标的
`kernel-lock.json` 和嵌入内核，生成内容、编译参数及输出摘要记录在目标证据中。
归档命令使用局部 LF 设置，保持已提交 blob 的字节，不修改 runner 的 Git 配置。

每个原生 runner 必须完成：

- Go race 全套测试、`go vet`，并解析 JSON 测试结果，要求四个真实内核回环测试
  通过：节点路由、禁止直连回退、Provider TLS 身份以及拒绝不可信节点证书。
  跳过关键测试不能通过此门槛。
- 对最终可执行文件运行 `--capabilities` 与 `--version`，逐字匹配协议、版本、
  源码 commit、平台和内核锁版本；随后执行 `--self-test`。
- 在隔离的用户目录、安装目录和临时目录运行 `--doctor --json --config`，
  指向一个不存在的临时配置。必须返回退出码 1、八项准确的只读诊断、正确的
  构建身份，且不得创建文件。服务、内核执行和网络均须标为 `not_run`。
  安装项根据独立读取的当前令牌/root 状态检查，提升权限的 runner 必须报告
  `installation_regular_user_required`；此检查不改变系统权限。
- Bash 或 Windows PowerShell 的本地 mock 引导安装 fixture。测试不会配对、
  注册用户服务、启用登录启动或连接真实节点。

Windows PowerShell fixture 子进程使用本版本的默认模块搜索路径，避免从
PowerShell 7 经 Python 继承不兼容的模块。该处理仅作用于子进程环境，依据
[微软的模块路径说明](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_psmodulepath?view=powershell-7.5#starting-windows-powershell-from-powershell-7)。

内核使用上游原生的系统 CA 模式，TLS 证书验证保持启用。Linux 需要系统 CA
证书；macOS 最低版本为 13，Windows 为 Windows 10 / Server 2016 x64。

## 许可与材料门槛

`detector/source-license-review.json` 是随源码审查的逐文件许可映射，其字段为：

| 字段               | 含义                                                    |
| ------------------ | ------------------------------------------------------- |
| `schemaVersion`    | 当前为 `1`                                              |
| `sourceLockSha256` | 规范化源码构建锁的 SHA256                               |
| `reviews[].scope`  | `mihomo`、`go` 或 vendor 的原始 module path             |
| `inputFiles`       | 五目标实际链接文件的并集，记录包内路径、字节数和 SHA256 |
| `notices`          | 包内完整、非空许可/通知文件及相同摘要字段               |
| `rationale`        | 该映射适用的来源与理由，供独立审查                      |

门槛重新散列源码包的每个文件，与内部 manifest 一一对应，并校验许可映射的
每个输入、全文通知及所有实际链接文件。wrapper 的标准库依赖也纳入检查。
模块按最长真实 module path 匹配，不能借父模块映射掩盖子模块缺项。
缺少映射、全文、任何链接文件或摘要不符都会阻止发行。

此机械验证确认审查过的材料与构建输入一致，不取代对许可适用性的审查。
新增依赖、许可来源、构建锁或映射必须重新独立审查。`ready:true`、通知文件数量
或者任意外部 JSON 中的“verified”标记均不能替代真实材料检查。

原生构建及源码包报告保留 `releaseReady:false`，因为它们尚无认证的发行来源
证明。一般 CI 会显示具体材料阻塞；手动发行要求材料门槛通过后，才向同一次
Actions 运行传输候选资产。PR、push 和 `publish=false` 不上传二进制制品。

新候选使用 native evidence schema 2，组装阶段再次核对版本和 doctor 报告。
schema 1 仅用于恢复既有 `0.2.0`、源码提交
`9ccee76c3cab149f34dca96c304310c9574c0d29` 的原资产；完整源码 tree、文件摘要
与原始发行运行的认证来源证明仍须通过原有验证，其他候选不能降级此门槛。

## 认证来源与发布顺序

发布 job 仅允许 `58cdn/MiSub` 的 `main` 手动触发，并验证工作流路径、事件类型
与精确 `GITHUB_SHA`。只有该 job 获得 `contents:write`、`id-token:write` 和
`attestations:write`；工作流不保存长期签名凭据或创建生产检测器身份。
外部 Actions 固定到已核实的 commit。

1. 收集同一次运行的五目标候选。重新验证全部二进制、源码、许可、目标能力和
   原生测试证据，按固定模板生成 Bash/PowerShell 引导脚本和候选发布目录。
2. 使用 GitHub Actions OIDC 对所有发行文件生成来源证明。
3. 对每个文件调用真实 `gh attestation verify`，校验签名、文件摘要、预期仓库、
   工作流、`refs/heads/main`、source/signer commit，并拒绝自托管 runner。
   任一验证失败都不会调用 Release 写接口。
4. 查询现有 Release 与标签；查询失败不能视为“版本不存在”。使用原子的
   Git ref 创建请求固定新标签到本次 commit，已有标签导致失败，不强制更新。
5. 创建新草稿 Release，记录返回的 Release ID，并通过该 ID 上传完整资产和
   读取远端资产清单。逐个要求名称、
   数量、大小、`uploaded` 状态及 GitHub 返回的 SHA256 与已证明的文件一致，
   然后才按同一 ID 公开 Release。检测器发行不设为 MiSub 主应用的 latest。

签证说明与核验参数依据 GitHub 的
[artifact attestation CLI](https://cli.github.com/manual/gh_attestation_verify)
及固定版本的
[attest-build-provenance action](https://github.com/actions/attest-build-provenance/blob/977bb373ede98d70efdf65b84cb5f73e068dcc2a/action.yml)。
这类证明认证 GitHub 工作流身份与产物，不声称达到隔离式可重现构建器的更强等级。

上传或远端校验失败会留下新标签/草稿供检查。自动重试不会覆盖其内容；维护者应先
检查失败记录，再按[草稿恢复流程](detector-draft-recovery.md)核验实际下载字节、
完整材料与原运行的签名来源证明。恢复默认只读；显式公开前重新确认标签、草稿及
资产身份均未变化。恢复仅公开原草稿，不重新构建、上传或替换旧发行资产。

## 发行内容与网页启用

[MiSub Probe 0.2.0](https://github.com/58cdn/MiSub/releases/tag/probe-v0.2.0) 于 2026-10-13 从 MiSub 提交 `9ccee76c3cab149f34dca96c304310c9574c0d29` 发行。该提交对应实际程序、源码材料、tag 与原始构建签名；如经草稿恢复公开，恢复工具自身提交另行记录，不改变原资产源码身份。站点目录激活是后续独立提交。原 run/attempt、恢复操作记录和公开下载核验结果保存在本次发行/目录 PR 的证据中。

发行包含五个原生可执行文件、每目标完整 wrapper 源码快照和内核/工具链源码包、
五目标构建证据、两种引导脚本、`release-catalog.json`、`release-manifest.json`、
`SOURCE.md` 与 `SHA256SUMS`。源码快照都验证同一 Git tree，压缩字节可以随
原生 Git 实现不同；每份实际归档均有独立摘要。

最终 manifest 记录文件身份与必须满足的来源核验策略，不记录易失的执行状态。
签证完成后不修改已证明的字节；验证结果由实际 `gh attestation verify` 给出。

引导脚本只插入确定的版本、commit、平台、字节数及 SHA256，不接受任意下载
地址或 shell 片段。原始可执行文件的固定下载 URL 与 CLI 能力验证一致。

候选 `release-catalog.json` 只随成功公开的发行提供；工作流不会自动修改仓库的
`detector/release-catalog.json` 或部署网页。公开后还须下载并核验远端资产、确认
发行状态，再通过独立审查的目录更新启用网页命令。代码合并、普通 Pages 部署、
候选构建成功，都不能单独说明用户已能安装。

组装从同一源码快照读取已发布目录并保留其历史版本。新的引导脚本必须为
无 BOM、无 NUL 的 LF UTF-8 文本，每份不超过 64 KiB，以满足短安装命令的
下载边界。下一版的准备与交接见 [Probe 0.3.0 发行清单](detector-release-0.3.0.md)。

真实设备安装、浏览器配对批准、持久凭据配置和真实节点验收由用户明确执行或
逐项确认。上述 CI 使用临时和回环 fixture，不构成这些实网验收。

## 本地 fixture 与构建命令

开发、源码构建、发行工具及其 Python fixture 需要 Python 3.10 或更新版本。`release_gate.py` 使用 `Path.write_text(..., newline=...)`；该参数从 [Python 3.10](https://docs.python.org/3.10/library/pathlib.html#pathlib.Path.write_text) 起支持。下载、安装和运行已发行的单文件检测器不依赖 Python。

先运行 `python3 --version` 确认版本。macOS 的 `python3` 可能仍指向较旧版本；若低于 3.10，请使用本机已经安装的兼容解释器，并在后续 fixture、构建与发行命令中始终使用同一解释器。例如已安装 Python 3.14 时，先运行 `python3.14 --version`，再将下面命令的 `python3` 替换为 `python3.14`。没有兼容解释器时先停止工具操作；这些命令不会安装 Python 或修改系统默认解释器。

```sh
python3 -B -m unittest discover -s detector/scripts -p 'test_release_gate.py' -v
python3 -B detector/scripts/release_gate.py native \
  --target linux-amd64 --version 0.3.0 --commit EXACT_COMMIT \
  --work-dir /absolute/new/temporary/build-directory
```

`native` 需要干净且匹配 commit 的 checkout，下载的是锁定的公开构建材料。
`--require-materials` 将缺少许可映射视为失败。`assemble` 和 `publish` 要求真实的
手动工作流上下文；最终发布还必须通过实际签名核验，不接受本地伪造结果文件。
