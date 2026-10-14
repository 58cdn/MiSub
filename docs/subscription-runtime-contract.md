# 订阅运行时协议：默认关闭的接入约定

本实现依赖 PR #43，继续保持生产冻结。当前工作树只供离线合成测试；生产 schema、资源、凭据、备份、排空和切换不在执行范围。

## 后端选择与门控

- 未配置 `MISUB_SUBSCRIPTION_PROTOCOL` 或显式设为 `legacy`：保留现有 D1/KV 行为，不提供跨请求原子保证。
- 显式 `d1-v1`：仅使用已选定的业务 `MISUB_DB`，同时要求 `MISUB_SUBSCRIPTION_AUTHORITY` 与预先初始化的元数据一致。运行时不创建 schema、不迁移旧 main、不读取 KV 作为备用数据。设置保存/重置/恢复不能改变权威实例。
- KV-only 无法实现相同语义；严格模式必须拒绝，继续 legacy 则保留其并发覆盖风险。选择 D1 或 Durable Object 需要用户最终决定，代码不会自动把 KV 迁移到 D1。
- 其他模式、缺绑定、元数据缺失或不匹配均明确失败，不隐式降级。

此门控允许在本地实现并验证 D1 协议，不预先替用户决定 KV 部署的迁移路径。生产启用前需要的一句话决策是：确认目标实例采用已有业务 D1 原子协议，或 KV 保持兼容弱一致/另行选定 D1 或 DO 迁移方案。

## 实现接口

严格存储适配器提供 `subscriptionProtocol: 'd1-v1'`、`readSubscriptionSnapshot()` 与 `commitSubscriptionOperations(request)`。快照统一为 `{ version: { epoch, revision }, subscriptions, profiles }`；普通行写与整集合 put 不可绕过协议。

请求为 `{ operationId, baseVersion, operations }`。operations 支持明确 create/update/remove/reorder/link/unlink/runtime；恢复使用独立候选及新 epoch。客户端编辑必须提供自己的基线，不能由服务端替旧快照填入当前版本。后台 runtime 更新绑定开始时目标身份、只更新白名单字段、有限重试，删除或配置改变后拒绝旧结果。

运行时操作语义、全部 writer 覆盖矩阵、幂等保留边界、合成迁移演练和验收证据在实现完成后记录于本文及 Issue #33。所有入口保持默认关闭，CI 成功不解除生产冻结。
