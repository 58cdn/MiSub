# 登录安全与管理员通知接口 v1

登录安全使用独立 D1，前端按本契约实现。所有示例均为合成数据。

### 开关和无 DB 行为

- 无 `MISUB_SECURITY_DB`：登录维持当前行为；成功响应增加 `loginSecurity:{enabled:false,warning:null}`。
- 独立数据库的 `login_security_config` 单例行 `enabled` 默认为 0；只有人工批准后初始化并将其设为 1 才开启。不开自动建表、自动迁移或生产配置。
- 已绑定而表缺失/连接失败：新登录及安全接口 503，固定 `code:'login_security_unavailable'`，不悄悄降级。已登录会话其他流量不受影响。
- 管理员消息接口 disabled 响应 `{success:true,enabled:false,items:[],unreadCount:0,nextCursor:null}`；前端显示“登录保护未启用”，不能当作“无风险”。
- disabled 下 read 返回 `{success:true,enabled:false}`。已保存的旧审计在关闭开关时不展示，重新启用后按保留期显示。

### 登录

成功 200：

```json
{
    "success": true,
    "loginSecurity": {
        "enabled": true,
        "warning": {
            "id": 42,
            "failedAttempts": 10,
            "since": 1791900000000,
            "lastFailureAt": 1791900010000
        }
    }
}
```

无待提醒失败时 warning 为 null。保留现有 securityWarning 默认密码提示，二者可并存。警告是全站最近30天尚未消费的失败汇总；任一管理员成功登录原子消费一次，持久事件仍保留到已读/过期。多标签页并发登录不会重复产生相同汇总。

- 密码错误第1–9次：401 `{error:"密码错误"}`。
- 第10次及锁定期：429 `{error:"登录尝试过多，请稍后重试",code:"login_locked",retryAfter:600,lockedUntil:1791900610000}`，`Retry-After` 为向上取整秒数；前端倒计时仅参考，服务器判定为准。
- 无可信来源：503 `{error:"登录安全服务暂不可用，请稍后重试",code:"login_source_unavailable"}`。
- JSON 无效400/超限413（锁定优先）；非字符串 password 为400，不算密码失败。
- 所有上述响应 no-store；不返回失败 IP 给匿名请求。

### 管理员接口（仅有效 Cookie，会话外 token/探针 token 不可访问）

GET `/api/admin/notifications?before=42&limit=20`，GET `/api/admin/login-audit?before=42&limit=20`

```json
{
    "success": true,
    "enabled": true,
    "items": [
        {
            "id": 41,
            "type": "login_success",
            "createdAt": 1791900020000,
            "readAt": null,
            "ip": "203.0.113.1",
            "browser": "Firefox",
            "os": "Windows",
            "device": "desktop",
            "failedAttempts": null,
            "since": null,
            "lastFailureAt": null,
            "target": "security"
        }
    ],
    "unreadCount": 3,
    "nextCursor": 41
}
```

- ID 正安全整数且按 ID 降序稳定分页；before 是排他上界，limit 默认20/最大50。nextCursor 仅有更多时返回本页最后 ID，否则 null。时间为 Unix 毫秒。
- `login_warning` 事件 IP/browser/os/device 为 null，failedAttempts/since/lastFailureAt 为有效数值；`login_success` 相反。browser/os/device 为粗粒度枚举，无原始UA。
- audit 仅筛选成功登录；其 unreadCount 也只统计成功登录。notifications 的 unreadCount 统计保留期内所有未读事件，不受当前分页限制。
- GET 不标已读；`POST /api/admin/notifications/read` JSON `{ids:[41,42]}`（1–50正整数，重复去重）；响应 `{success:true,enabled:true}`。首次 readAt 保留，重复/不存在/已清理 ID 均幂等成功；没有“未来全读”水位线，不会误标并发新事件。
- 所有管理员共同使用同一已读状态（MiSub 为单管理员密码模型）；不新增用户账户或浏览器指纹。
- 非法参数400，未授权401，错误方法405，后端失败503。只读接口 no-store。read 额外拒绝跨站 Origin/Sec-Fetch-Site。
- `target` 固定为枚举 `security`，前端映射固定站内安全视图；不返回 URL/HTML。系统信息入口由前端固定站内路由提供，不接受服务端任意跳转。
- 30天保留，访问时按索引清理，闲置期间不承诺物理及时删除。

### IP / 时序

只使用 Cloudflare Pages 平台 request.cf 和规范化 CF-Connecting-IP；XFF/X-Real-IP 全忽略。同区 Worker 可改变来源字段，因此带 CF-Worker 的登录拒绝。Pseudo IPv4 仅在 CF-Connecting-IP 为 240/4 时使用有效 CF-Connecting-IPv6，不能让普通IPv4请求通过伪造IPv6头轮换配额。
固定10分钟统计窗口从首次失败起；第10次锁10分钟且不续期，到期可登录；成功重置该IP计数。D1事务串行确定竞态结果，已认证其他接口不调用限流器。此措施不能代替完整暴力破解防护。

### 存储与事务

开关与锁定预检在同一数据库读取快照内判定；列表、已读和登录记录各自在事务内复核开关。切换发生在读取或事务完成之后时，已经完成判定的在途响应可能仍报告该快照状态；后续请求读取新状态。

`migrations/login-security/0001_login_security.sql` 定义独立数据库的配置、IP 状态、待提醒失败时间和事件四张表。运行时不执行 DDL，也不向订阅或检测器存储写入登录数据。D1 主库读取与 `batch` 事务使计数更新、登录准入、审计插入、失败汇总及消费按一个原子操作完成；同一事务失败会全部回滚，不发登录 Cookie。时钟以服务器毫秒时间单调推进，避免较早开始但较晚执行的请求回拨窗口。密码校验前检查锁定，事务内再次检查，防止校验期间出现第10次失败后仍发 Cookie。

成功登录会清零该 IP 当前计数，并消费全站尚未提醒的失败；其他 IP 的有效锁定不会解除。统计窗口不会因第2–9次错误而滑动；锁定期间的尝试不增加失败汇总、不更新 IP 时间。已读只影响提醒状态，不删除审计。所有管理员共用已读状态；不建立设备身份、不保存原始 UA。

IP 状态按最后实际处理的登录尝试时间保留30天，仍有效的锁定不被清理；待提醒失败时间保留30天；成功登录事件和警告摘要按事件创建时间保留30天。警告中 `since`/`lastFailureAt` 描述生成摘要时的待提醒失败时间。访问登录安全接口时清理过期记录；闲置数据库和平台备份不承诺实时物理删除。默认开关关闭时不采集登录数据，历史数据暂不展示。

### 生产启用与回退边界

创建数据库、迁移、绑定、开关以及真实锁定测试均是独立生产操作，必须先获批准。建议顺序：核对目标 Pages 项目和现有绑定；建立专用安全数据库；对该库执行 schema；验证 `schema_version=1,enabled=0`；添加 `MISUB_SECURITY_DB` 绑定；以测试通过的代码部署；另行批准启用 `enabled=1`。任何一步都不应复用 `MISUB_DB` 或 `MISUB_PROBE_DB`。没有初始化表的绑定会让新登录返回503，因此先初始化、后绑定。

普通部署脚本只保留已存在的 `MISUB_SECURITY_DB`，验证它与业务/检测库 ID 不同；不会创建数据库、运行 schema 或改变开关。开启后 D1 故障时仅新登录和安全接口不可用；现有管理员会话、公开页面、订阅和探针接口继续原有路径。经批准将 `enabled` 改为0可停用采集与锁定，不清除原记录；解绑同样代表关闭保护，不能宣称仍有限流。不要为恢复登录而自动更换密码或 Cookie Secret。

共享 NAT 用户共用配额；IPv6 使用完整规范化地址，不封整个网段。攻击者轮换地址、利用大规模来源或资源耗尽仍需平台层防护。直接经过 Cloudflare Pages 的入口才在此可信来源模型内；自建代理和 Worker 转发需要另行设计来源验证。

依据：[D1 batch 事务语义](https://developers.cloudflare.com/d1/worker-api/d1-database/)、[Cloudflare 来源 IP 与 Worker 子请求头](https://developers.cloudflare.com/fundamentals/reference/http-headers/)。
