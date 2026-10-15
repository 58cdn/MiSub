# Probe alpha 测试版本发行

Probe 产品版本固定为 `0.0.1-alpha.N`，例如 `0.0.1-alpha.1`。N 为无前导零正整数，
从完整远端 Probe 标签与发行记录（含草稿）并集的已用最大值加一，首次为1；
标签为 `probe-v` 加产品版本。主应用的 `v0.0.1-alpha.N` 使用独立计数，不占用 Probe 序号。
新可分发测试版本必须递增，禁止按日期重置、复用或回退。基础 `0.0.1` 与 alpha 通道
在用户明确最终验收之前固定；所有 Release 标记 `prerelease=true`、测试通道且非 latest。

`detector/VERSION` 记录源树中的 Probe 产品版本，独立于主应用元数据。普通开发构建
从此文件读取N；新可分发版本先通过代码审查提交该文件的递增，再固定准确main发行。
手动输入必须同时匹配源码 VERSION 和远端下一N，不能在运行中改写源码版本或使用
过期默认值。分配不改变历史记录，读取失败或历史身份不一致应停止处理。

产品版本按完整 SemVer 的数字规则比较，`alpha.9 < alpha.10`。开发显示单独派生为
`0.0.1-alpha.N.sha.<真实SHA前12位>`，完整源码 SHA 同时保存，SHA 不参与升级排序。
未知或有未提交改动的源码须明确显示未验证状态，不能伪造开发身份。历史稳定版本
仅作为显式迁移来源，不与测试通道混排为最新推荐，内核仍使用自己的上游版本。

当前旧版分发暂停。新发行通过公开资产和目标环境验收后，经独立目录PR恢复安装入口。
已有客户端、配置、服务器身份和历史标签保留。Release永久删除是另行明确对象的操作，
发行流程不会自动删除、覆盖或补传旧资产。领单声明记录模式默认关闭，数据库迁移和
record/read激活遵循[独立阶段协议](probe-agent-runtime.md)。

## 候选身份与产物

发行源码必须是最终审查通过并合并到 `main` 的精确 commit。PR 的临时合并
commit、测试构建摘要、合成 fixture 摘要都不能填入正式发行目录。

| 原生目标        | 可执行文件                      |
| --------------- | ------------------------------- |
| `linux-amd64`   | `misub-probe-linux-amd64`       |
| `linux-arm64`   | `misub-probe-linux-arm64`       |
| `darwin-amd64`  | `misub-probe-darwin-amd64`      |
| `darwin-arm64`  | `misub-probe-darwin-arm64`      |
| `windows-amd64` | `misub-probe-windows-amd64.exe` |

下载前缀为 `https://github.com/58cdn/MiSub/releases/download/probe-vVERSION/`，
其中VERSION必须替换为本次确定的完整 alpha 产品版本，不能使用开发显示后缀。
每目标还有 `misub-wrapper-source-TARGET.tar.gz`、`mihomo-source-TARGET.tar.gz`
及 `evidence-TARGET.json`；加上 `install.sh`、`install.ps1`、
`release-catalog.json`、`release-manifest.json`、`SOURCE.md`、`SHA256SUMS`，
共 26 项。五平台各自的大小与 SHA256 必须来自同一次正式手动发行运行，
由组装门槛写入目录和安装脚本，再核验远端实际字节与认证来源。

Bootstrap 协议仍为 1，能力集合仍是 `pair`、`install`、`start`、`status`、
`check-config`、`bootstrap-v1`。`doctor` 是独立的只读 CLI 诊断，不能加入
这组六项安装协议能力；其可用性由最终二进制的 schema 2 原生证据证明。
`pair` 的离线证据验证本地协议/回环行为，不能证明真实管理员批准或真实节点通信。

## 发布前交接

1. 固定最终 `main` commit，检查对应五平台原生 CI、许可映射、版本和 doctor
   证据、安装 fixture、应用 CI，并确认没有并行发行占用相同标签。
2. 分页读取所有远端标签和发行（含草稿），仅在 `probe-v0.0.1-alpha.N` 命名空间
   取已用最大序号加一。历史标签和草稿占用的 N 不可复用；主应用标签不参与分配。
   不能把鉴权、网络或分页失败视为空列表；保留原始清单及版本分配记录。
3. 根据现场发布授权决定是否运行下列命令。默认 `publish=false` 只构建测试，
   不上传制品、不创建标签或 Release：

    ```sh
    gh workflow run probe-source-release.yml --repo 58cdn/MiSub --ref main \
      -f version=VERSION -f source_commit=EXACT_COMMIT -f publish=false
    ```

4. 按测试发行授权执行以下命令，从 dispatch 时的 `main` 重新构建全部资产，
   使用工作流的短期 OIDC 身份签证，创建新 tag、草稿及资产，并在核验后公开：

    ```sh
    gh workflow run probe-source-release.yml --repo 58cdn/MiSub --ref main \
      -f version=VERSION -f source_commit=EXACT_COMMIT -f publish=true
    ```

    dispatch 前后立即核对 `main` 和运行的 `head_sha`；若与已批准的 commit 不符，
    立即停止该运行，按用户具体批准范围重新核实准确提交后再发起，不得让发布在审查期间继续。
    工作流在构建前、发行前核对完整远端版本集合和准确main；创建标签前及公开草稿前再核对main。
    现存 tag/Release 会阻止发行。上传失败保留现场，
    按[草稿恢复流程](detector-draft-recovery.md)核验原运行，不能覆盖重传。
    同一 Probe 发布并发组串行运行，标签创建为原子占位；第二个占用相同 N 的请求
    失败，不覆盖第一个请求的资产。重试只读核验已保留材料，已公开版本不可重写。

## 公开发行与安装目录验收

- 下载全部 26 项公开资产，核对大小、SHA256、manifest、固定 URL、Release ID、
  资产 ID、原运行/attempt 和认证来源；复核五份 evidence 的源码身份、平台、
  `--capabilities`、版本输出和 doctor 报告一致。
- 对比两个引导脚本中的版本、源码 commit、五平台字节数和摘要；脚本摘要应与
  目录一致。短命令下载固定 tag 的 `install.sh` 或 `install.ps1`，不能引用
  `latest` 或原始分支文件。验证脚本满足 64 KiB、UTF-8/LF、无 NUL/BOM 边界。
- 单独提交 `detector/release-catalog.json` 更新。历史记录保持原身份且不生成下载入口，
  通过现有目录、生成命令和安装 fixture 测试，审查目录变更触发 Pages 部署的
  影响后再合并。目标环境验收尚未通过时保持`distributionReady=false`，不以可下载或CI通过代替实际可用。
  alpha 目录的 `release.channel` 为 `testing`、`release.prerelease` 为 `true`；
  发布流水线生成的目录保持 `distributionReady=false`，不凭发行成功开启推荐。
- 在明确批准的真实环境验收公开网络安装、Windows 普通用户/提升令牌/SYSTEM
  提示、macOS/Linux 用户服务、实际启动与持续运行、真实配对批准、领取任务、
  节点检测、结果回传和页面显示全流程。五平台证据必须匹配同一版本和完整源码提交。
  需要服务注册、持久
  身份或系统权限的操作应事先列出具体动作并获得授权。

最终正式发布和通道升级必须取得用户明确确认；CI、制品、签证和测试 Release
均不能代替该确认，也不能代替上述真实环境验收。

CI 中缺失配置的 doctor 返回 `issues_found`/退出码 1 是预期诊断。其服务、
内核执行、网络为 `not_run`；这些字段以及 CI 的生产验收跳过都不能记作现场通过。
0.2.0 的既有安装不能据源码更新宣称支持 doctor 或执行版本快照。
