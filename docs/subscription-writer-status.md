# 订阅 writer 覆盖状态

本表对应 [PR #44](https://github.com/58cdn/MiSub/pull/44) 的默认关闭 `d1-v1` 路径，要求内部 schema 2。默认 legacy 保留既有 D1/KV 语义，不获得跨请求 CAS。协议、容量和迁移边界见[运行时约定](subscription-runtime-contract.md)。

| 入口                                          | 严格模式行为                                                                                                               | 离线验证                                                                 |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| /api/data                                     | 单条 SQL 读取订阅、组、settings、rules 及同一版本；已配置的 lazy task 在捕获响应快照后调度                                 | atomic-domain-api、atomic-subscription-api                               |
| /api/misubs、浏览器保存                       | 明确操作、客户端基线、稳定请求；失败保留编辑；成功响应核验及提交后编辑重放                                                 | atomic-subscription-api、data-store-subscription-protocol                |
| 外部 CRUD、link/unlink                        | 客户端版本与稳定 ID，字段白名单、引用校验和事务提交                                                                        | atomic-subscription-api                                                  |
| node_count、网页自动刷新                      | 绑定获取前 epoch、目标身份、TLS 策略及观测时间；仅写 runtime 字段                                                          | subscription-runtime-writers-sqlite                                      |
| 外部 refresh                                  | 使用规范 UA/代理/解析策略；每项固定观察、条件提交，批量允许部分成功                                                        | atomic-external-refresh-policy、atomic-subscription-api                  |
| 通知 Cron                                     | 规范获取后条件写 runtime，再发送预警及条件写通知时间；不提供消息 exactly-once                                              | subscription-runtime-writers-sqlite、notifications-disabled-subscription |
| /_schedule、/_cron、/api/cron/trigger         | 同一受限刷新 runner；/_schedule、/_cron 接受管理员 POST 或现有 cronSecret；/api/cron/trigger 仅管理员 POST；CF-Cron 不认证 | subscription-schedule、cron-trigger-route                                |
| 平台 scheduled 函数                           | 直接调用同一 runner；未增加生产调度配置                                                                                    | subscription-schedule                                                    |
| 订阅下载                                      | 请求前快照；等价规范参数的原始节点数可条件提交；过滤、客户端流量、缓存回退独立记录                                         | subscription-download-observations、既有 subscription-service 测试       |
| Telegram 只读命令/分页                        | 请求内完整权威快照，保留现有显示和分页                                                                                     | telegram-preview                                                         |
| Telegram 删除/排序/导入/改名/启停/组操作/绑定 | 旧索引解析只生成稳定 ID 预览；确认时重验认证，提交保存的操作与原版本                                                       | telegram-preview、telegram-preview-sqlite                                |
| Telegram 预览                                 | actor/chat/update 绑定、十分钟首次确认、SQL 数据库时钟准入、重复请求复用、容量拒绝                                         | telegram-preview-sqlite、subscription-runtime-migration-d1               |
| /settings GET/POST/reset                      | 脱敏读取及独立客户端基线；保存/重置使用共享版本，不切 authority 或 mirror 到 KV                                            | atomic-domain-api、domain-mutation-frontend                              |
| /rule_templates GET/POST                      | 稳定 ID、严格结构/INI 校验、完整数组和客户端版本；拒绝静默删项/生成 ID                                                     | atomic-domain-api、domain-mutation-frontend                              |
| 备份导出                                      | 订阅、组、规则与设置取同一内部快照，敏感字段按原导出范围排除                                                               | atomic-domain-api、webdav-backup                                         |
| 本地/WebDAV 恢复                              | dataOnly/dataAndSettings 含恢复前备份；subscriptions-only 仅双集合；完整输入、新 epoch 与目标域同一事务                    | atomic-domain-api、subscription-domain-core                              |
| 恢复 UI                                       | 确认前取得基线，提交固定基线；冲突不代填新版本；本地文件与远端路径合成测试                                                 | backup-version-confirmation                                              |
| WebDAV 状态、lazy task 时间                   | 只接受限定状态字段；同 epoch 内有限冲突重算，不提交旧整份 settings                                                         | atomic-domain-api                                                        |
| 旧 collection/settings/rules adapter mutators | 严格模式拒绝；原始受保护表 DML 由 SQL trigger 拒绝                                                                         | subscription-runtime-core、subscription-domain-core                      |
| 旧在线迁移/自动 DDL                           | 明确拒绝，运行请求不执行 schema 初始化                                                                                     | atomic-subscription-api、subscription-runtime-migration-d1               |
| 离线迁移规划器                                | legacy main/独立行合成展开；冲突重复、坏数据和悬空引用停止；已初始化目标拒绝                                               | subscription-runtime-migration-d1                                        |
| 内部 schema 1                                 | 读取及提交拒绝；不包含 1→2 升级器                                                                                          | subscription-domain-core                                                 |
| 登录认证 KV、节点缓存、下载计数、消息         | 不属于权威业务域；不承诺与业务事务原子，不能用它们推导规范节点状态                                                         | 对应既有回归及静态 writer 检查                                           |

所有验证使用合成 fixture/mock、真实内存 SQLite 或本地 Miniflare D1。未读取生产数据、发送真实 Telegram 消息或执行 WebDAV 上传；CI 成功不代表生产迁移、发布或实网验收成功。生产冻结保持。
