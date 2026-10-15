# 探测契约、验收覆盖与诊断能力交付记录

R1–R5 已按各实现 PR 的定稿范围完成代码交付，并完成准确提交的独立审查、CI 和普通 Pages 部署。本文归档分析依据、交付范围及后续追踪；生产激活、二进制发行与真实设备验收分别记录。

## 分析依据

原始分析以 MiSub `2a9ea3608536a2e0b5eb289af34572bf1820ca10` 和 REA `ad08510a113d7a9b8d92fb1e385757880e469869` 为固定基线。完整源码引用、许可核查、四个旧结果契约反例及隔离复现步骤保存在[原始分析快照](https://github.com/58cdn/MiSub/blob/8a9dfc557057d6f4388c02096e5687103bb860de/docs/rea-diagnostics-review.md)。该快照描述当时基线，不代表当前实现状态。

本文与实现只借鉴契约、测试发现、能力声明、诊断和证据机制，不引入 REA 运行时或复制其实现。原始分析保留固定提交的 MIT 与第三方许可引用；检测器分发材料仍按[源码发行门槛](detector-source-release.md)独立核验。

## 已交付范围

| 项  | 实现 PR                                                                                      | 定稿代码范围与验收依据                                                                               | 使用限制                                                                         |
| --- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| R1  | [#45](https://github.com/58cdn/MiSub/pull/45)                                                | 按检查类型联合验证状态、错误码及指标；合法 Go 输出、非法 HTTP 提交不完成任务、幂等重放与界面含义回归 | 可访问不等于服务解锁，未知与部分测量保留原意                                     |
| R2  | [#47](https://github.com/58cdn/MiSub/pull/47)                                                | Vitest、Node、browser 的入口发现、执行和完成清单；空匹配、遗漏、重复失败；报告绑定准确源码           | 离线浏览器及 CI 不能代替真实网络和用户设备验收                                   |
| R3  | [#53](https://github.com/58cdn/MiSub/pull/53)                                                | observations v1 最小版本声明、当前 claim 兼容判断、原子持久化、独立成功续租时间和管理解释            | 默认 off；最近自报不是实时能力或安全证明；通用检查类型/Provider 能力目录另见 #54 |
| R4  | [#49](https://github.com/58cdn/MiSub/pull/49)                                                | 本地只读 doctor、固定脱敏输出和八项诊断；默认零主动联网、零子进程、零修改，五平台材料门槛            | 联网及内核执行子模式另见 #54；现有独立命令保留自身边界                           |
| R5  | [#50](https://github.com/58cdn/MiSub/pull/50)、[#51](https://github.com/58cdn/MiSub/pull/51) | 被接受完成结果的固定执行声明、首次完成与重放约束、旧记录未知、历史界面来源说明                       | 包括被接受的失败检查结果，但不记录未完成或未提交尝试；自报不证明实际内核执行     |

对应契约见[领单声明](probe-agent-runtime.md)、[doctor](detector-doctor.md)、[执行声明](probe-execution-metadata.md)与[OpenAPI](node-probes.openapi.yaml)。所有旧客户端、非法输入、存储故障、租约和授权限制继续由各实现契约约束。

## 集成证据

上述实现与 [#52 发行准备](https://github.com/58cdn/MiSub/pull/52) 已集成到 main `db2bb5459502a9999b3f6cb84554848cb94e11ae`，tree `5a85c6e27d219470f204091afc6eb4ca737de0a5`。该提交四个工作流全部成功，17 项检查成功，两个正式发布 job 按事件规则跳过：

- [Pages](https://github.com/58cdn/MiSub/actions/runs/38591001564)：实际部署成功，沿用既有密钥和资源。
- [控制面](https://github.com/58cdn/MiSub/actions/runs/38591001696)：完整测试发现与执行门槛通过。
- [检测器](https://github.com/58cdn/MiSub/actions/runs/38591001749)：原生与分发边界通过。
- [源码发行门槛](https://github.com/58cdn/MiSub/actions/runs/38591001711)：五平台原始记录的源码 SHA/tree 均一致，Linux 各350、macOS 各351、Windows388项原生测试及 race、内核回环和材料门槛通过。

这是上述固定提交的集成记录。本文所在文档 PR 自身的最终提交与 CI 单独记录在 PR 中。源码 CI 的候选不含正式发行来源签证，不能用于填造生产 catalog；doctor 在未配置 runner 上的 `issues_found` 和服务/网络 `not_run` 不计作真实设备通过。

## 有限后续追踪

[Issue #54](https://github.com/58cdn/MiSub/issues/54) 独立登记两项可选扩展：通用检查类型/来源/Provider 能力目录，以及显式内核执行/联网 doctor 子模式。状态为待需求取舍；它们不阻塞本轮 R1–R5 定稿代码与本文收口，也不自动成为已批准的实施或上线范围。

| 后续事项       | 追踪与完成条件                                                                                                                                                                                |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R3 生产启用    | [阶段协议](probe-agent-runtime.md)：核实指定库和恢复点，另行批准迁移及 record/read；首次和每次 off 后重启，都须从确认 record 生效起连续完整300秒后再按授权进入 read                           |
| Probe 日期版本 | [发行清单](detector-dated-release.md)：准确main、日期和序号、正式重建签证、公开资产及目标环境核验、独立catalog PR；已安装客户端不会自动更新                                                   |
| 节点与设备     | [#7](https://github.com/58cdn/MiSub/issues/7)：指定设备安装/配对/通信、用户浏览器、授权节点和另行确认的测速                                                                                   |
| 登录安全       | [#32](https://github.com/58cdn/MiSub/issues/32)：原始代码验收已完成；生产审计/会话启用及指定真实环境验收由 [#55](https://github.com/58cdn/MiSub/issues/55) 独立追踪，不为代码收口擅自创建资源 |
| 订阅4→3        | [#33](https://github.com/58cdn/MiSub/issues/33)：权威存储及当前/历史绑定、脱敏ID/计数、备份和现场归因；writer接入已交付，迁移/恢复另行批准                                                    |
| Windows权限    | [#34](https://github.com/58cdn/MiSub/issues/34)：新提示进入正式发行与catalog，指定设备普通/提升/SYSTEM令牌实测                                                                                |

完整关闭门槛见[未完成事项](open-work-readiness.md)和[上线决定](go-live-decisions.md)。本文收口不关闭上述 Issue，不启用安全数据库，不发布检测器，不对未经授权的节点执行检查。
