# 检测器草稿发行恢复

发行操作使用 GitHub Release ID 标识草稿。按 tag 查询接口仅返回已公开发行，草稿验收应使用固定 ID。

## 新发行

创建草稿后取得并固定 Release ID，通过该 ID 上传、读取并验证 tag、草稿状态和完整资产集合。每个资产必须与已验证的本地产物具有相同大小和 SHA256，最终公开也绑定同一 ID。已有标签、发行或资产不覆盖。

## 恢复前提

恢复使用已审查并提交的代码，以及与原发行提交完全匹配的干净源码 checkout。两个提交分别写入报告。需要 Python 3、Git 和已登录且有该仓库发行权限的 GitHub CLI；`gh attestation verify` 必须支持脚本使用的来源与签名约束。

明确记录版本、原源码提交、原手动运行 ID、原运行次数和草稿 Release ID。恢复只接受 `58cdn/MiSub` 的 `main` 手动源码发行运行，要求 fixture、五个平台原生构建、材料汇总和签名步骤已成功。原运行发生重跑时，须重新调查，脚本会拒绝运行次数变化。

资产从固定 GitHub API 主机和资产 ID 下载，数量、单文件大小、总量、命令时间和输出均有限制。全部实际下载字节必须通过以下检查：

- 完整的 26 文件集合、API 大小和摘要、manifest、SHA256SUMS。
- 以原源码中的锁文件、许可映射和模板重建材料，比较目录、安装脚本、五平台证据及完整对应源码。
- 对每个文件执行真实 `gh attestation verify`，验证仓库、工作流、main ref、源码与签名提交、GitHub 托管 runner，以及签名证书中的原运行 ID 和次数。
- 发布前重新读取原运行、标签、草稿和资产列表，确认内容与身份未变。

恢复不构建新二进制、不上传资产、不移动标签，也不替换已有文件。

## 执行

先在修复代码所在的干净 checkout 中进行只读验收。参数中的值由失败运行和原草稿确认；工作目录必须是尚不存在的新目录。

```sh
python3 -B detector/scripts/release_recovery.py \
  --version 0.2.0 \
  --commit ORIGINAL_SOURCE_COMMIT \
  --original-run-id ORIGINAL_RUN_ID \
  --original-run-attempt 1 \
  --draft-id EXISTING_DRAFT_ID \
  --source-root /absolute/original-source-checkout \
  --work-dir /absolute/new/recovery-verification
```

命令默认只读。成功后 `verified.json` 记录两份代码身份、全部资产和签名验证结果，`published` 为 `false`；原始 API 快照及命令证据保存在同一工作目录。

确认具有本次公开发行授权后，使用相同身份参数、新的工作目录并增加 `--publish`。脚本会重新完成全部检查，然后仅对固定 Release ID 执行公开操作。公开后再次读取标签和发行，验证原提交、发布时间以及资产 ID、内容和正文不变，成功时写入 `published.json`。此操作不会将检测器标为主应用的 latest。

失败时保留工作目录和原草稿用于调查。公开请求前写入 `publication-attempt.json`；若请求或后续读取失败，命令返回 `published:null`，应先按 Release ID 核实远端真实状态。已公开发行不能再次进入草稿恢复流程。

GitHub CLI 的 Sigstore 缓存必须可写。若本机默认缓存出现跨磁盘原子重命名错误，可仅为本次进程设置 `XDG_CACHE_HOME` 到同一磁盘上的新缓存目录，再重新执行验证；不修改登录配置、TLS 验证或信任根策略。

## 验证和页面启用

```sh
python3 -B -m unittest discover -s detector/scripts -p 'test_release*.py' -v
```

恢复代码需经过独立审查、离线失败路径测试和最终 HEAD CI。发行公开后还需从公开下载地址复核实际文件，并通过独立 PR 更新页面发行目录。成功发行不等于真实设备安装或真实节点验收；这些操作仍需单独授权。
