# 检测器本地诊断

`--doctor` 汇总检测器本机的构建信息、内核包摘要、安装记录和配置检查，适合提交脱敏的排错报告。本功能属于未发布源码；已发布的 MiSub Probe 0.2.0 不支持此命令，发行目录仍以已核实的版本为准。

```sh
misub-probe --doctor
misub-probe --doctor --json --config /absolute/private/probe.json
```

Windows 使用对应的本地可执行文件：

```powershell
.\misub-probe-windows-amd64.exe --doctor --json --config "$env:LOCALAPPDATA\MiSubProbe\probe.json"
```

使用安装所属的普通用户运行。命令只接受 `--doctor`、可选的 `--json` 和 `--config`；其他命令或参数组合被拒绝，包括 `--doctor=false`、位置参数、`--self-test`、`--status`、配对和安装参数。

## 检查范围

| 检查 ID            | 行为                                         | 结果含义                                                     |
| ------------------ | -------------------------------------------- | ------------------------------------------------------------ |
| `build`            | 校验当前程序声明的版本与源码修订格式         | 只代表构建元数据格式有效；不替代发行来源验证                 |
| `platform`         | 检查当前编译目标是否在五个支持平台中         | Linux/macOS amd64、arm64 和 Windows amd64                    |
| `kernel_materials` | 限量读取内嵌压缩包并核对固定 SHA256          | 不解压或执行；摘要匹配不证明内核可运行                       |
| `installation`     | 只读打开现有安装清单并核对清单记录的文件摘要 | 未安装显示 `info`；不创建目录或操作锁，不判断服务是否运行    |
| `configuration`    | 使用现有配置解析和私有权限检查               | 配置有效不代表服务端接受身份或网络连通                       |
| `service`          | `not_run`                                    | 独立的 `--status` 才会查询服务管理器                         |
| `kernel_execution` | `not_run`                                    | 独立的 `--self-test` 会解压并执行内核，需要用户另行选择      |
| `network`          | `not_run`                                    | 不访问 MiSub、节点或外部站点，不推断在线、身份有效或节点可用 |

配置按以下顺序选择：显式 `--config` → 校验通过的安装清单中的配置路径 → 未安装时当前工作目录的 `probe.json`。安装记录不可读取或不可信时，默认配置检查标记为 `configuration_location_unknown`；显式指定配置可以单独检查该文件，但不会消除安装错误。

读取范围是上述本地文件。诊断不调用 HTTP、DNS、服务管理器、内核进程或修复操作，不更改配置、权限、安装、凭据和系统设置。Windows 在读取前拒绝 UNC、设备路径、映射网络盘和父目录联接；Unix 复用本地文件读取接口，无法据此证明用户挂载的文件系统没有底层网络活动。配置与安装目录应位于本地磁盘。

## JSON 契约 v1

`--json` 将一个 JSON 对象输出到标准输出；默认输出可读文本。报告不包含配置内容、Token、服务器地址、用户名、文件路径、环境变量或原始异常文本。版本字段仅接收有长度限制的版本格式；其他不可信值使用 `unknown`、固定错误码或省略字段。

| 字段                           | 含义                                                                                                                         |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion`                | 固定为 `1`                                                                                                                   |
| `checkedAt`                    | 本机时钟的 UTC RFC3339 时间，不是服务端接收时间                                                                              |
| `scope`                        | 固定为 `local_read_only`                                                                                                     |
| `status`                       | 任一检查为 `error` 时是 `issues_found`，否则为 `local_checks_passed`                                                         |
| `platform`                     | 支持的编译目标或 `unsupported`                                                                                               |
| `version` / `revision`         | 当前程序声明的版本与源码修订；无效时为 `unknown`                                                                             |
| `displayVersion`               | 产品版单独展示；干净且已知源码的 development 构建追加 `.sha.<实际SHA前12位>`，未知或脏源码明确保持未验证状态，不用于升级排序 |
| `buildChannel` / `sourceState` | 构建通道 `development` / `testing` 与源码状态 `clean` / `dirty` / `unknown`；均为本地声明，不是发行来源签证                  |
| `kernelLockVersion`            | 可安全表示时输出内核锁文件声明的版本，不代表执行结果                                                                         |
| `installedVersion`             | 安装文件检查通过时输出清单声明的当前版本，不代表服务进程版本                                                                 |
| `checks`                       | 上表八项检查，含 `id`、`state`、固定 `code` 和可选的固定 `remediation`                                                       |
| `checks[].source`              | 配置检查的来源枚举：`explicit_config`、`installation_manifest`、`working_directory`；位置未知时省略                          |

检查状态为 `ok`、`info`、`error` 或 `not_run`。消费者应按检查 ID 读取，并在不支持的 schema 或未知状态时保留未知，不据此推断健康。`local_checks_passed` 只汇总已执行的本地检查，始终保留服务、内核执行和网络的 `not_run`。

主要错误码：

- 配置：`configuration_missing`、`configuration_path_invalid`、`configuration_private_permissions_required`、`configuration_too_large`、`configuration_invalid`、`configuration_unreadable`。配置仅接受现有 schema 1；缺省 `pollSeconds` 使用现有默认值，未知字段和多个 JSON 值仍被拒绝。
- 安装：`installation_record_invalid`、`installation_files_changed`、`installation_regular_user_required`、`installation_private_permissions_required`、`installation_path_invalid`、`installation_unreadable`。
- 内核材料：`kernel_materials_missing`、`kernel_target_missing`、`kernel_archive_checksum_mismatch`、`kernel_materials_invalid`。
- 构建与平台：`build_metadata_invalid`、`build_source_unverified`、`platform_unsupported`。源码为dirty/unknown时保留该状态，不把已有基础修订当作当前源码的准确身份。

退出码：`0` 表示已执行的本地检查通过；`1` 表示检查发现问题或报告写入失败；`2` 表示诊断参数冲突或命令行解析失败。参数冲突输出固定 `doctor_flags_conflict`，报告写入失败输出固定 `doctor_output_failed`。命令行解析器对未知参数的用法提示不属于 JSON 报告；不要把秘密放在命令行参数中。

## 故障处理

缺少内核材料时使用对应平台的完整构建包；源码目录中的占位文件不会被当作有效内核。安装记录异常时参考[用户级安装恢复](detector-user-install.md)，配置权限或路径问题参考 [Windows 说明](detector-windows.md)及[检测器 README](../detector/README.md)。诊断命令不会自动执行建议或修改失败对象。
