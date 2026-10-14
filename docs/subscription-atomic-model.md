# 订阅原子写入：本地模型与接入门槛

此项依赖 PR37、PR41、PR42，补充 [版本及迁移协议](subscription-write-protocol.md)。交付限于独立 SQL 模型、合成测试和实际写入口盘点，不接入应用路由，不自动创建 schema、迁移数据或改变运行时能力。

## 后端选择

| 后端 | 已有结构 | 原子协议需要 | 本轮范围 |
| --- | --- | --- | --- |
| 已绑定业务 D1 | subscriptions/profiles JSON 行；兼容 id=main 旧数组；settings | 规范化旧行；epoch/revision、操作收据、事务准入记录及旧写入口约束；所有 writer 改造 | 离线 SQL 模型，不执行生产迁移 |
| KV-only | 两个独立集合键，最终一致 | 选定一个 D1 或 Durable Object 权威存储并迁移，或在严格模式拒绝写入 | 只验证能力拒绝，不伪造 KV CAS |
| 未初始化/无绑定 | 无可验证权威版本 | 完成显式初始化后才可写 | 拒绝，禁止自动降级 |

D1 batch 在语句失败时回滚整个序列，因此版本门槛必须在 SQL 中抛错；条件 UPDATE 影响零行不够。[D1 batch](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch) KV 的一致性和原子操作限制不同，不能用写前重读或进程内锁补足。[KV 一致性](https://developers.cloudflare.com/kv/concepts/how-kv-works/)

## 具体离线模型

待补实现与最终证据。模型只验证原子提交内核；显式编辑操作转换、所有应用 writer 接入、迁移执行器和实际 D1 平台验收分别列为后续门槛，不以模型测试代替。

## 必须另行批准的执行

复用已有业务 D1 仍需授权生产 schema/旧 main 迁移、私密备份位置、维护窗口及所有旧部署/Cron/在途 waitUntil 的排空或阻断。KV-only 还需先决定权威存储及相应资源/绑定。不能复用 Probe 或登录安全库保存业务集合。本轮不需要批准就可完成本地模型、失败注入和草稿 PR；生产执行继续冻结。
