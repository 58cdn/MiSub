# Probe 日期版本发行

Probe 使用 `0.0.1.{yymmdd}.{num}`，例如 `0.0.1.261015.1`。日期按 UTC+8，
同日序号从完整远端标签与发行记录（含草稿）并集的最大值加一，从1开始，
最多999999；标签为 `probe-v` 加完整版本。真实日期、无前导零正整数和准确源码
共同组成不可变身份，不按SemVer判断升级顺序，主应用及内核版本规则独立。

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
其中VERSION必须替换为本次确定的完整日期版本。
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
2. 分页读取所有远端标签和发行（含草稿），按UTC+8日期取同日已用最大序号加一。
   不能把鉴权、网络或分页失败视为空列表；保留原始清单及版本分配记录。
   以原始手动运行的创建时间固定日期，构建跨午夜仍沿用同一版本，不重新编号。
3. 根据现场发布授权决定是否运行下列命令。默认 `publish=false` 只构建测试，
   不上传制品、不创建标签或 Release：

    ```sh
    gh workflow run probe-source-release.yml --repo 58cdn/MiSub --ref main \
      -f version=VERSION -f source_commit=EXACT_COMMIT -f publish=false
    ```

4. 正式发布需要明确批准。以下命令会从 dispatch 时的 `main` 重新构建全部资产，
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
  应用版本与Probe版本独立，不伪造发行日期。
- 在明确批准的真实环境验收公开网络安装、Windows 普通用户/提升令牌/SYSTEM
  提示、macOS/Linux 用户服务、真实配对和实际节点检查。需要服务注册、持久
  身份或系统权限的操作应事先列出具体动作并获得授权。

CI 中缺失配置的 doctor 返回 `issues_found`/退出码 1 是预期诊断。其服务、
内核执行、网络为 `not_run`；这些字段以及 CI 的生产验收跳过都不能记作现场通过。
0.2.0 的既有安装不能据源码更新宣称支持 doctor 或执行版本快照。
