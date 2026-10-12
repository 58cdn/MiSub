# 检测器短效配对 API 契约

基址 `/api/probes/v1`；所有响应使用现有 `{success:true,data}` 或 `{success:false,error:{code,retryAfterSeconds?}}` 包装，`Cache-Control: no-store`。时间为 Unix 毫秒。配对 JSON 请求最多 8192 字节，拒绝未声明字段、重复查询参数及额外查询参数。生产身份仅在用户明确批准后、原生客户端成功兑换时创建。

管理员接口要求有效 `auth_session`；所有 POST 同时要求 Origin 精确匹配实际 HTTPS 请求 origin。原生接口拒绝 Cookie、Origin、Authorization，不接受浏览器会话或既有检测器 token。公开接口不会创建数据库表；管理员创建窗口时初始化配对表。

## 格式

- `windowId`、`id`：小写 UUID（`xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`）。公共关联 ID 不能单独授权。
- `deviceCode`：`pdc1_` 加 64 个小写十六进制字符，仅客户端持有；服务器只存哈希。
- 客户端先用安全随机数生成 32 字节，将其编码为 64 位小写十六进制字符串 `proof`；`proofHash` 是 **proof 字符串 UTF-8 字节**的 SHA-256 小写十六进制值。proof 只在原生 token 请求中发送，不进入命令、网页或日志。
- `fingerprint`：proofHash 前 16 位转大写，每 4 位用 `-` 分组。用于人工比对本次随机配对请求，**不是硬件认证**。
- `userCode`：10 个 Crockford Base32 字符，按 `XXXXX-XXXXX` 显示；输入允许小写和省略中间连字符。它只能供管理员核对，不能兑换凭据。
- `name`：1–60 字符、无控制字符；`version`：`[A-Za-z0-9_.+-]{1,50}`；`platform`：`[a-z0-9_-]{1,30}`。它们是客户端声明，批准后不修改。

## 管理员接口

| 方法与路径                                 | JSON 请求                   | HTTP 成功响应的 data       |
| ------------------------------------------ | --------------------------- | -------------------------- |
| `POST /pairings/windows`                   | `{}`                        | `201`，Window              |
| `GET /pairings/windows/{windowId}`         | 无                          | `200`，Window              |
| `POST /pairings/windows/{windowId}/cancel` | `{}`                        | `200`，Window              |
| `POST /pairings/resolve`                   | `{windowId,userCode}`       | `200`，Pairing             |
| `GET /pairings/requests/{id}`              | 无                          | `200`，Pairing             |
| `POST /pairings/requests/{id}/approve`     | `{userCode,confirmed:true}` | `200`，Pairing（approved） |

Window：`{id,origin,status,createdAt,expiresAt,checkedAt,requests}`。status 为 `open|expired|cancelled`；最长 300 秒，requests 最多 3 个 Pairing。重复批准同一已批准请求可返回其 approved 状态；已兑换不能再次批准。

Pairing：`{id,windowId,origin,name,version,platform,fingerprint,status,createdAt,expiresAt,approvedAt,consumedAt,agentId,lastSeen,checkedAt}`。status 为 `pending|approved|consumed|expired|cancelled`；approvedAt、consumedAt、agentId 无值时为 null；lastSeen 未连接为 0。**consumed 表示已创建身份，不代表已写入客户端或在线**。最后通信沿用真实 claim/heartbeat。

网页先创建窗口，展示仅含站点及公共 windowId 的客户端启动参数；用户输入客户端显示的 userCode 后核对 fingerprint 和站点，再明确批准。网页不读取长期 token、deviceCode、proof 或其哈希。取消窗口使其中未兑换请求全部失效；已兑换身份仍显示 agentId，需使用既有检测器撤销确认流程。

## 原生客户端接口

`POST /device-pairing/start`

请求：`{windowId,name,version,platform,proofHash}`。

`201` data：`{id,windowId,origin,deviceCode,userCode,fingerprint,expiresAt,intervalSeconds:5}`。

客户端校验响应 origin 等于预期 HTTPS origin、格式与过期时间，显示 userCode、fingerprint 和站点。服务器窗口创建后最长 300 秒；start 不延长它。

`POST /device-pairing/token`

请求：`{windowId,id,deviceCode,proof}`。

- 首次轮询及后续轮询均至少等待 start 返回的 intervalSeconds。
- 待确认：`202` data `{status:'pending',expiresAt,intervalSeconds}`。
- 兑换成功：`200` data `{status:'consumed',agent:{id,name,createdAt},config:{version:1,server:origin,token,pollSeconds:60}}`。config.token 为新的 `mp1_` 长期凭据，只返回一次；服务端只存带 origin 的域分离哈希。
- `429` error `{code:'pairing_slow_down'|'pairing_rate_limited',retryAfterSeconds}`，同时提供 Retry-After；客户端将后续间隔提高至至少 `max(当前间隔+5,retryAfterSeconds)`，并遵守过期时间。
- `404 pairing_unavailable`：不存在、错误站点或错误 secret/proof，统一响应。
- `409 pairing_consumed`：已兑换，**不返回凭据**；须在网页撤销该身份后重新配对。
- `410 pairing_expired|pairing_cancelled`：终止；重新配对需要用户动作。
- `409 agent_limit`：达到有效身份上限，终止并提示网页处理。
- `503 probe_unavailable` 或其他 `5xx`、网络中断、无效响应：兑换结果不确定，停止轮询，提示在网页核查并撤销未连接身份后重新配对。错误响应不能证明事务尚未提交。

客户端在兑换前检查本机安全保存条件；成功后将 config 原子写入私有文件并退出。用户之后显式启动检测器，才进入原有 claim 流程。丢失成功响应或保存失败时不重复索取 token，不自动创建新请求；网页撤销重配。

## 约束与通用错误

管理员与原生接口均要求 HTTPS、拒绝重定向语义。请求原始 origin 为唯一站点绑定依据，不信任 body、Host 转发头中的站点。原有手动 token 继续兼容；新配对 token 不接受共享 D1 的其他 origin。

输入格式错误 `400 invalid_pairing_request`；缺少明确批准 `400 pairing_confirmation_required`；管理员未登录 `401 unauthorized`；不合法 Origin `403 invalid_origin`；原生携带浏览器或鉴权头 `403 pairing_native_request_required`；请求状态已不允许批准 `409 pairing_unavailable`；缺失或已关闭的有效窗口、短码不匹配统一 `404 pairing_unavailable`。大 body、Content-Type 和读超时沿用已有 413/415/408 错误。错误不回显用户输入、SQL 或秘密。

预算持久化且原子执行：D1 全局每小时最多 12 个窗口、同时最多 4 个窗口；公开 start 每分钟 120 次；公开 token 每分钟 2400 次；管理员 resolve/approve 每分钟 60 次。每窗口 start 尝试最多 10 次、请求最多 3 个，resolve/approve 尝试最多 10 次，token 尝试最多 300 次（包含错误 secret）；每请求最多 100 次有效 secret 轮询。预算不因更换 Worker 实例重置；未知窗口也消耗全局预算。清理每次最多 100 个超出 24 小时窗口及其关联请求，无界随机限流键不落库。

兑换采用同一 D1 事务中的条件更新与身份插入，取消、过期、站点、审批及 32 个身份额度在写入条件中重验。只有事务赢家取得一次明文响应；插入失败整体回滚。审批与客户端提交的元数据不会在兑换时被替换。
