# 订阅 writer 接入状态

本表对应 [PR #44](https://github.com/58cdn/MiSub/pull/44) 的 `d1-v1` 路径。默认 legacy 仍使用原有 D1/KV 行为；“拒绝”表示功能在严格模式不可用，不表示已经完成等价转换。协议及上线边界见[运行时约定](subscription-runtime-contract.md)，历史完整清单见[写入设计](subscription-write-protocol.md)。

## 管理与外部 API

| 入口 / 实际函数                                            | 严格模式状态                                                                            | 验证位置                                                         |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `/api/data` / handleDataRequest                            | 单 SQL 双集合快照；禁止 profile ID 隐式迁移、lazy scheduled task；不填补下载计数        | atomic-subscription-api、api-handler-authoritative-reads         |
| `/api/misubs` / handleMisubsSave / saveAtomicSubscriptions | operations、客户端版本和固定操作 ID；旧 full/diff 请求拒绝；成功后才清缓存/通知         | atomic-subscription-api                                          |
| 浏览器 useDataStore.saveData                               | 配置差异、稳定请求重试、409 停止、收据核验、提交后编辑重放；缓存不授予版本              | data-store-subscription-protocol、subscription-edit-operations   |
| 网页单源/批量/自动刷新                                     | 按 ID、版本调用 node_count，未决保存或冲突时停止；旧配置结果不贴到新编辑配置            | data-store-subscription-protocol、subscriptions-auto-update      |
| EditForm 代理测试                                          | inspectOnly，不匹配 URL 回写；读取真实 success/data 响应                                | subscription-proxy-inspection                                    |
| external subscriptions/manual-nodes/profiles GET           | 每请求一个快照及 meta.version                                                           | atomic-subscription-api                                          |
| 同三类 POST create                                         | 客户端稳定 ID，显式 create，运行字段拒绝                                                | atomic-subscription-api                                          |
| 同三类 PATCH                                               | 允许字段 update，UA/代理别名规范化，不整体覆盖                                          | atomic-subscription-api                                          |
| 同三类 DELETE                                              | remove 与双引用清理原子提交；支持版本请求头                                             | atomic-subscription-api                                          |
| external profile link/unlink                               | 单引用操作，校验 remote/manual 类型                                                     | atomic-subscription-api                                          |
| external subscription validate / manual-node validate      | 只读检查，远程检查显式 inspectOnly                                                      | atomic-subscription-api、external-manual-node-profile-operations |
| external subscription/batch/profile refresh                | 固定规范观测参数与策略，逐节点 runtime 提交；部分成功分别报告，旧 HTTP 基线在获取前拒绝 | atomic-subscription-api                                          |
| external 路由鉴权设置失败                                  | 脱敏失败，无 legacy fallback                                                            | atomic-subscription-api                                          |

测试名指 `tests/unit/*.test.js`。现有路由鉴权和 external 启用开关/Bearer token 检查仍有效，协议版本不是身份认证。

## 后台和下载

| 入口 / 实际函数                                                                                | 严格模式状态                                                                                      | 验证位置                                                          |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| handleNodeCountRequest 普通刷新                                                                | 捕获目标身份/策略，只写运行字段；删除、重建、URL、TLS 变化后拒绝；疑似截断返回未应用              | subscription-runtime-writers、subscription-runtime-writers-sqlite |
| handleNodeCountRequest inspectOnly                                                             | 网络获取但不持久化；内部策略参数不能由 HTTP body 覆盖                                             | 同上                                                              |
| handleBatchUpdateNodesRequest                                                                  | 只读批量获取；严格持久化刷新使用逐 ID node_count                                                  | subscription-runtime-writers                                      |
| handleCleanNodesRequest / handleHealthCheckRequest                                             | 预览或格式检查，无订阅 writer                                                                     | 静态控制流检查                                                    |
| handleCronTrigger / handleAtomicCron                                                           | 单快照、每批六个目标、逐节点条件 runtime 提交；没有整表回写                                       | subscription-runtime-writers、subscription-runtime-writers-sqlite |
| checkAndNotify / lastNotifiedExpire、Traffic                                                   | 观测提交后发送预警，再条件提交时间；消息与数据库非原子                                            | subscription-runtime-writers                                      |
| persistSubscriptionsForCron                                                                    | 严格专用路径提前分流，旧整体保存不可达                                                            | subscription-runtime-writers                                      |
| Cron 旧节点变化消息/汇总消息                                                                   | 未接入；严格模式不发送                                                                            | 功能限制                                                          |
| fetchSingleSubscription / scheduleSubscriptionRuntimeInfoUpdate / writeSubscriptionRuntimeInfo | 严格模式跳过所有下载 runtime 回写；客户端 UA/组覆盖结果不是全局规范观测                           | subscription-runtime-writers、subscription-runtime-writers-sqlite |
| handleMisubRequest                                                                             | 两集合来自同一 snapshot；GET 不自动迁移或保存 profile ID                                          | subscription-runtime-writers                                      |
| 节点缓存、独立下载计数                                                                         | 不属权威订阅集合，保留原行为，不赋予 CAS                                                          | 既有 subscription-service 测试及静态调用检查                      |
| `_schedule.js` performSubscriptionSync / onRequest / 旧 cron trigger                           | 读取 raw binding、网络、SQL 前拒绝；_schedule.onRequest 返回 428，旧 /api/cron/trigger 包装为 500 | subscription-runtime-writers                                      |

## Telegram

webhook 先进行 secret 与用户权限验证。严格模式统一拒绝全部旧 callback（包括只读翻页），提示使用网页；不会使用旧按钮携带的数组索引推测当前目标。

| 下游路径                                                             | 严格模式状态                                           |
| -------------------------------------------------------------------- | ------------------------------------------------------ |
| delete/del/rm → handleDeleteCommand                                  | 拒绝删除及引用清理                                     |
| enable/on/disable/off、toggle 回调                                   | 拒绝启用和停用                                         |
| rename → handleRenameCommand                                         | 拒绝重命名                                             |
| grename / applyGroupOperation、gmrm_/gmcl_/gmrn_                     | 拒绝组重命名、删除、清空                               |
| sort → handleSortCommand                                             | 拒绝排序                                               |
| dup/dedup clean/remove、cmd_dup_clean                                | 拒绝去重写入；纯 dup 检查只读                          |
| import → handleImportCommand                                         | 拒绝 JSON/命令导入                                     |
| 普通 URL/节点文本 → handleNodeInput                                  | 拒绝导入与自动绑定                                     |
| document/photo → handleFileInput                                     | 附件下载前拒绝                                         |
| link/unlink node/sub、单项/批量 toggle、所有 confirm/delete 回调     | 统一 callback gate 拒绝                                |
| bind/unbind、bind_profile_/unbind_profile                            | 拒绝默认组绑定及设置回写                               |
| persistCachedSubscriptions / persistCachedProfiles                   | 当前只有定义、无调用；严格 adapter 仍拒绝旧 putAll     |
| persistCachedSettings / 导入后缓存清理 / 限额计数                    | 对应 strict 写流程不可达；不宣称 settings/cache 事务化 |
| start/help/menu/list/stats/search/sub/info/copy/export/groups 及别名 | 保留只读命令，生成的旧按钮不可用                       |

测试为 `subscription-runtime-writers` 的各命令、callback、附件和只读 stats 合成用例；其他只读展示没有逐项重新实网验收。

## 备份、设置与底层存储

| 入口 / 函数                                                   | 严格模式状态                                                                          | 验证位置                                                     |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| buildBackupPayload / readBusinessData                         | 订阅/组同快照并记录 version；rules/settings 另读，非跨域原子备份                      | atomic-subscription-api                                      |
| restoreBackupPayload / handleBackupRestore                    | 仅显式 subscriptions-only、两数组、客户端基线及新 epoch；拒绝多域恢复，不隐式补空数组 | atomic-subscription-api                                      |
| handleWebdavRestore                                           | 远端读取前检查 scope/metadata，恢复语义同上                                           | atomic-subscription-api                                      |
| WebDAV status/list/test/run                                   | 不写订阅集合；test/run 原有目录/上传行为属于明确功能调用，未在本轮实网执行            | atomic-subscription-api、webdav-backup                       |
| handleSettingsSave                                            | 只写选定 D1；禁切换 storageType；无 KV mirror，不提供 settings CAS                    | atomic-subscription-api                                      |
| handleSettingsReset                                           | 删除前拒绝                                                                            | atomic-subscription-api                                      |
| migrate_to_d1 / migrate_legacy_d1 / migrate                   | 认证后拒绝，旧迁移副作用前退出                                                        | atomic-subscription-api                                      |
| detect_legacy_d1                                              | 只读检查，无迁移                                                                      | 静态检查                                                     |
| SettingsCache / StorageFactory                                | gate 先于缓存/存储类型选择，authority 匹配，无 KV 业务 fallback                       | subscription-runtime-core                                    |
| adapter put/delete 集合键及 putAll/put/update/delete 单行方法 | 严格统一拒绝；不暴露 db/kv 原始句柄                                                   | subscription-runtime-core                                    |
| ensureD1Settings / migrateKVToD1 / migrateLegacyD1MainRows    | 严格模式拒绝，绝不自动 DDL                                                            | subscription-runtime-core                                    |
| raw 旧 main INSERT/UPDATE/DELETE                              | schema trigger 阻断；非通用数据库管理员隔离                                           | subscription-runtime-core、subscription-runtime-migration-d1 |
| offline migration planner                                     | 只生成隔离副本计划；歧义/损坏/悬空引用停止，各迁移 SQL 失败回滚                       | subscription-runtime-migration-d1                            |
| 登录/password、rules、独立任务/缓存/日志                      | 非本协议业务集合域，不提供跨域原子保证                                                | 既有回归及静态写调用清单                                     |

本轮全部执行证据来自合成 fixture/mock、真实内存 SQLite 或本地 Miniflare D1；没有生产数据、真实网络检测、Telegram 消息或 WebDAV 上传。不能把安全拒绝、单域事务、消息发送或缓存操作统称为“全部 writer 功能等价”。
