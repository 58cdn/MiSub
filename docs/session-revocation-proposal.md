# 会话撤销、响应乱序与浏览器状态恢复

状态：2026-10-14，离线候选协议。`experiments/session-cookie-protocol/` 未接入产品鉴权，使用合成凭据。产品 Cookie 复活问题仍未解决；本文不代表 Cloudflare 部署、生产迁移或实网验收通过。

## 后端授权边界

旧产品用时间戳签名的同名 `auth_session`，退出仅删除浏览器 Cookie。迟到登录或 GET 续期会写回有效凭据，迟到退出可能删除新 Cookie。[RFC 6265](https://www.rfc-editor.org/rfc/rfc6265) 描述了并发 Set-Cookie 竞争；过滤前端回调不能撤销服务端权限。

候选协议保证退出事务提交后，固定捕获的会话和登录操作不能再次鉴权或激活，随后独立开始的新登录不受旧退出重试影响。已经完成鉴权的业务请求仍属于业务事务边界。

1. IndexedDB 在票据 HTTP 发出前登记随机操作 ID，同源标签共用登记。最多保留 16 项操作，包括正文丢失、尚未绑定票据的操作。重建数据库不重用旧 ID。
2. 每张票据带对应操作的取消证明，通过独立名称的 Secure、HttpOnly、SameSite=Strict、Path=/ Cookie 留下恢复证明。响应必须绑定原操作，不能被另一票据覆盖。
3. 密码登录仅签发 **pending SID**，使用永不重用的 Cookie 名称。pending 不能鉴权或续期；服务端仅存 secret 摘要。实验顺序 ID/凭据必须由生产 CSPRNG 替代。
4. 收到 SID Cookie 后，浏览器在当前未取消操作中发出 confirm。服务端在同一事务检查原操作证明、Cookie、撤销状态和期限后激活。confirm 不写 Cookie；恢复接口不重发激活证明。
5. 续期只延长服务端 idle 期限，受绝对寿命约束，不发送 Set-Cookie。初次 Cookie 使用绝对寿命；登录重试只返回元数据，不重发 secret 或 Cookie。
6. 普通退出先冻结同源新登录和确认准入，再将冻结的已知 SID、票据证明与实际 Cookie 一起交给服务端。服务器验证全部显式目标，将 active、pending SID 和票据的并集存成固定快照。仍有效但无证明的已知 SID 会拒绝整次捕获。
7. 一个事务撤销全部快照目标。503、丢响应和重载保持未确认；重试仅使用原快照，不扩大到自动附带的新 Cookie。取消证明始终只指向旧 ID，迟到重试不能撤销新会话。

`revokeTargets()` 是定点撤销原语，仅返回 `revokedTargets`，不表示整个浏览器已退出。浏览器退出统一使用 `captureRecovery()` 与 `logoutRecovered()`。空目标、无可恢复证明不当成退出成功。

## 恢复与容量

- IndexedDB 丢失：从实际 Cookie 找回 pending/active SID 和取消票据。新 registry 已有未完成票据时，仍须捕获旧的活动 Cookie。
- Cookie 选择性丢失：仍在 IndexedDB 的取消证明进入快照；不能丢弃可撤销在途确认的证明。
- IndexedDB 与取消 Cookie 全丢失、登录响应仍在途：迟到 SID 保持 pending；新 registry 没有旧操作的确认准入，恢复只能撤销，不能激活。
- 所有证明丢失且 confirm 已在途：confirm 与续期都不写 Cookie，不会恢复已清空浏览器的登录；但无法证明不可关联、可能复制到其他客户端的凭据也被撤销。更大范围保证需要可恢复服务端作用域或明确的全设备撤销。
- 普通鉴权最多 8 个 SID、4 KiB。维护限制 16 KiB、32 个 SID，最多解析 256 个操作 Cookie，每次清理最多 32 个失效票据。active/pending SID 和可用取消 Cookie 不允许清理。超过维护和平台头部上限的恢复仍待实现与实测。
- IndexedDB 不可用、目标覆盖不足时保持未确认；页面状态不能作为退出证据。实际产品的多版本网页、崩溃、Cookie 淘汰仍需接线验收。

## D1 持久化候选边界

`d1-state.js` 是独立持久化实验，尚未将完整协议状态机移植到 D1。每次读取和每个 CAS 重试创建新的 `first-primary` 会话；整个候选状态由一条带 revision 条件的 UPDATE 提交，冲突重新读取并重算。提交响应丢失返回未确认，不盲目重发凭据。缺表、坏格式、超过 256 KiB、未知写结果或竞争重试耗尽均为 503；请求不创建表或初始化记录。

单行状态方案仍需验证容量、争用、完整 schema、GC、收据保留和灾难恢复。它不是已验收的生产 adapter。平台语义见 [D1 数据库接口](https://developers.cloudflare.com/d1/worker-api/d1-database/)；[KV 最终一致性](https://developers.cloudflare.com/kv/concepts/how-kv-works/)不能满足即时撤销。

建议以独立 `MISUB_SESSION_DB` 接口准备生产实现；复用安全 D1 会耦合登录与通知/审计的可用性。接口选择不等于创建资源、绑定或迁移授权。产品切换必须拒绝旧签名 Cookie，并明确强制重登和回滚策略。

## 验证与尚未交付

Node SQLite 与真实 Chromium Cookie/IndexedDB 均使用合成身份和截获 HTTPS，无后端出网。响应 gate 控制服务端提交前与送达前，覆盖响应顺序、状态丢失、跨标签、失败重试、新登录保护、期限和容量。固定提交计数记录在任务与 PR，模型不能替代产品路由验收。

```sh
node node_modules/vitest/vitest.mjs run tests/unit/session-cookie-protocol-model.test.js tests/unit/session-cookie-recovery.test.js tests/unit/session-cookie-d1-state.test.js
node tests/browser/session-cookie-protocol.mjs /absolute/path/to/evidence
```

仍需：完整 D1 状态机与产品 auth/session 接线、CSPRNG、Origin/CSRF 与限流、GC/恢复 epoch、请求和日志脱敏、启用与旧 token 截止、Cloudflare 多 Worker/D1 并发、Safari/WebKit 和实际用户浏览器验收。本目录未改变 `functions/`、`src/`、工作流或生产配置。
