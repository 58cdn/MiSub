# 订阅运行时协议

[PR #44](https://github.com/58cdn/MiSub/pull/44) 提供默认关闭的业务 D1 版本写入路径，承接 [SQL 模型](subscription-atomic-model.md)。订阅与组引用在一个提交中更新；浏览器提交明确操作，后台仅提交与观测身份匹配的运行数据。入口状态见[逐 writer 覆盖表](subscription-writer-status.md)。

## 后端选择与启用边界

| 部署状态                                              | 行为与保证                                                                         |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 未配置 `MISUB_SUBSCRIPTION_PROTOCOL`，空值或 `legacy` | 保留现有 D1/KV 路径，不提供本协议的跨请求原子保证                                  |
| 显式 `d1-v1`                                          | 只使用业务 `MISUB_DB`，要求已有协议 schema 及匹配的 `MISUB_SUBSCRIPTION_AUTHORITY` |
| KV-only、错误模式、缺失绑定或元数据                   | 明确失败，不读取 KV 作为业务备用数据、不自动初始化或迁移                           |

已有业务 D1 是本实现推荐的原子提交目标；KV-only 继续兼容运行时仍有最终一致和并发覆盖风险。KV 没有本协议需要的 CAS，写前重读、进程内锁或缓存不能提供同等保证。Durable Object 是另一个需要独立设计、绑定和迁移的方案，本实现不包含 DO 后端。Probe 数据库不承载订阅业务集合。

authority 是实例身份标签，不是凭据。严格模式在读取设置缓存前选择权威业务 D1；设置保存不允许切换存储类型，旧在线迁移及设置重置拒绝执行。业务读取失败不降级为空集合或 KV。协议路径不执行 DDL，仓库的生产 schema、绑定及默认设置没有启用此能力。

生产启用仍需明确决定：**目标实例采用经迁移验收的业务 D1 原子协议，或 KV 保持兼容弱一致并另行选择迁移方案。** 代码交付、草稿 PR 和 CI 成功不代表已批准生产备份、冻结 writer、schema 变更、切换或部署。

## 快照、编辑与错误

严格适配器标记 `subscriptionProtocol: 'd1-v1'`。`readSubscriptionSnapshot()` 用一个 SQL 读取 `{version:{epoch,revision}, requestPolicy, subscriptions, profiles}`，校验物理行、ID、引用及实例身份。管理 `/api/data` 返回 misubs、profiles、version 和协议标记。缓存仅用于显示，不能给旧客户端补上当前版本。

`commitSubscriptionOperations({operationId, baseVersion, operations})` 接收以下明确操作：

| type          | 必填内容                            | 语义                                             |
| ------------- | ----------------------------------- | ------------------------------------------------ |
| create        | collection、item（含客户端稳定 ID） | 已存在 ID 冲突；订阅必须有 URL                   |
| update        | collection、id、fields              | 只更新共享配置白名单；未知 ID 冲突               |
| remove        | collection、ids                     | 明确删除；删除订阅同步清理两类组引用             |
| reorder       | collection、完整 ids                | IDs 必须覆盖该集合且不重复                       |
| link / unlink | collection=profiles、id、field、ids | field 为 subscriptions/manualNodes，校验引用存在 |

集合为 subscriptions 或 profiles。配置白名单在 [subscription-edit-operations.js](../src/shared/subscription-edit-operations.js)，不允许普通编辑写节点数、流量、内部生成标识或排序序号。未知旧字段保留在权威数据中。上限为每集合 1000 项、每请求 2000 操作、规范 JSON 256 KiB。

外部 API 保留已有启用开关和 Bearer token 检查；新写入需要 operationId/baseVersion，可通过 JSON 或 `X-MiSub-Operation-Id`、`X-MiSub-Epoch`、`X-MiSub-Revision` 传递。创建必须由客户端提供稳定 ID。代理/UA 字段映射到共享规范字段；组引用仍区分远程订阅和手动节点。

| 状态      | 含义                                                            |
| --------- | --------------------------------------------------------------- |
| 409       | 版本、epoch、操作摘要、目标身份或观测时序冲突；不能自动全量覆盖 |
| 428       | 缺少版本或入口仍是旧式写入                                      |
| 400 / 413 | 输入、引用或容量不合法                                          |
| 503       | 权威存储、schema、模式或收据容量不可用；无降级写入              |

协议错误采用固定代码，不包含底层 SQL、URL、凭据或异常正文；既有网络获取错误继续使用该入口的错误响应。

浏览器仅从完整权威响应启用协议。保存根据确认基线生成配置差异，保留失败请求原 operationId、版本和 payload；后续编辑不混入同一 ID 的重试。成功响应须有匹配收据及合法快照，再把提交后的编辑重放到新快照；409 保留编辑并阻止自动重试。未决请求只保存在当前 store 生命周期内，重新载入不会自动重放。

## 原子边界与幂等保留

一个 D1 batch 依次清理过期收据、插入 gate、替换两个受版本约束的集合、推进版本、写收据、关闭 gate、读取收据，共十条 SQL。新操作的版本/身份不匹配由触发器抛 SQL 错误，使整个 batch 回滚。普通旧式集合 DML 需要 gate；延迟外键阻止截断事务提交，关闭检查阻止提前结束。

gate 是已枚举业务路径的完整性保护，不是对任意数据库管理员 SQL 的权限隔离。拥有直接数据库写权限的管理员仍可修改表或约束；上线必须保持管理权限及旁路约束。

收据保存 epoch、operationId、摘要、确认版本、计数及到期时间，不保存请求正文或原始节点信息。保留期七天，最多 10000 条未过期收据，达到上限拒绝新提交。相同 ID 和摘要在当前 epoch 返回既有收据，不重复推进版本；响应快照可以包含收据之后的其他提交。改变同一 ID 的内容会冲突。

收据到期后，旧编辑的 baseVersion 已过期，不能被当成新写入。运行数据还有每字段观测时钟，过期观测重发不能回退数据。所有使用过的 epoch 永久登记，恢复不能重用历史 epoch。epoch 切换后旧请求（包括丢失响应的恢复重试）会冲突，客户端须重新读取核对；恢复不提供跨 epoch 自动幂等重放。

## 运行数据与网络策略

内部 `commitRuntimeObservation` 接收目标 ID、开始时的身份摘要、观测时间、请求策略、稳定 operationId 和运行字段。身份绑定 `_writeGeneration`、URL、代理、UA 及影响请求的配置；展示名称等字段不参与绑定。删除后重建同 ID 会生成新身份，旧请求不能复活对象或污染新 URL。每字段时钟拒绝旧值，互不相同字段可以拥有相同时间。

requestPolicy 只记录 builtinSkipCertVerify 的整数 0/1，只有设置中的 JSON boolean true 对应 1。node_count、Cron 和外部 refresh 使用开始快照中的策略发起请求，SQL gate 在同一提交内再次校验。策略改变后新观测提交被拒绝；已提交收据重放不产生新写入。完整 settings 可能含凭据，不进入 gate 或收据。

后台内部只对 revision 冲突重试，最多三次，保持同一观测和 operationId。身份、删除、epoch 或时序冲突返回明确未应用。外部 refresh 的 HTTP 重发旧 baseVersion 在网络前冲突；单节点提交可以幂等，但整个 refresh 请求不是网络观测幂等事务，批量结果可以部分成功。

node_count 与 Cron 采用固定的规范观测参数；单源请求有 15 秒中止，Cron 每批最多六个订阅，每个订阅获取节点与流量两个响应。普通下载具有客户端 UA 和组覆盖范围，严格模式不把其运行信息写成全局订阅状态；下载、请求内信息与独立节点缓存仍可使用。

严格 Cron 在观测提交后发送预警，再条件提交通知时间。Telegram 与 D1 不是同一事务，可能重复发送或发送后标记失败，没有 exactly-once 承诺。严格 Cron 尚不发送旧节点变化及汇总消息。

## 恢复与离线迁移

严格恢复仅接受明确 `scope: 'subscriptions-only'`、完整 subscriptions/profiles 数组、操作基线及新 epoch。缺失数组不会被解释为空。rules/settings 等跨域恢复拒绝，现有通用恢复 UI 尚未接入这种新请求；导出仍可读取备份，但多域备份不能直接当作严格恢复输入。两个集合在同一事务恢复，生成新的目标身份并清除旧观测时钟。

[离线迁移规划器](../experiments/subscription-transactions/migration.js) 只接收调用者提供的物理 id/data 行并生成计划，不解析生产绑定、不执行 SQL。它展开旧 main 数组及规范行，合并完全相同的重复项；不同内容的同 ID、损坏 JSON、映射不一致和悬空引用均停止，保留未知业务字段。计划包含源/目标摘要、数量和初始化隔离副本的语句，已初始化目标在任何集合变更前失败。

本地演练仅使用合成数据，在 SQLite 和 Miniflare D1 中验证迁移、DDL、业务提交的各语句失败回滚；这不是可直接运行的生产迁移器。生产方案还需备份及恢复演练、所有 writer 排空、原始物理行取证与源摘要复核、差异决策、目标身份校验、受控切换和回滚窗口。

已初始化协议数据库上的旧 writer 会被触发器拒绝；仅把环境门控改回 legacy 不能算可用回滚。回滚必须采用经批准、已校验的完整备份或独立反向迁移方案，不能自动删除触发器或约束。

## 验证边界

测试覆盖同基线竞争、响应丢失重放、操作 ID 冲突、删除/重建、旧观测、请求策略竞态、Cron/导入/API/浏览器保存、各 SQL 失败回滚及合成物理行迁移。命令、日志、独立审查和最终 HEAD CI 记录于 PR #44 与 Issue #33。

未使用真实订阅、节点凭据、生产 D1/KV 或真实 Telegram/WebDAV；没有执行生产 schema、资源创建、迁移、配对、服务注册或部署。KV 路径及明确停用的入口不获得原子能力，也不据此认定生产数据减少问题已被实网复现或修复。
