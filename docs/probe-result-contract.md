# 检测结果兼容契约

结果接口在完成任务前验证每类检查的状态、错误码与指标。非法结果返回固定错误码与 HTTP 400，不保存结果或完成时间；有效租约可以继续提交合法结果。未知的非契约字段仍被剔除，不回显原始错误、请求头或节点凭据。

本契约依据 main `b752b16d1d6b5650a3d8616e506b8acb3fdbb398` 的格式解析器和原生检测器，并核对 `probe-v0.1.0`、`probe-v0.2.0` 的输出。关联 [#25 R1](https://github.com/58cdn/MiSub/pull/25)。OpenAPI 的 `FormatCheck / TCPCheck / ProxyCheck / SpeedCheck / UnlockCheck / ServiceCheck` 定义各类型的合法组合。

| 检查        | 执行结果                                                                                                                                                                            | 测量字段                            |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| format      | passed/ok、failed/invalid_format、unsupported/unsupported_protocol 或 unsupported_transport                                                                                         | 无                                  |
| tcp         | passed/ok、failed/connect_failed、timeout/deadline、cancelled/cancelled                                                                                                             | latencyMs                           |
| proxy       | passed/ok、failed/request_failed 或 http_error、timeout/deadline、cancelled/cancelled、unknown/rate_limited                                                                         | 请求耗时；响应结果可有 HTTP 状态    |
| speed       | passed/ok、failed/request_failed 或 http_error、timeout/deadline、cancelled/cancelled、unknown/probe_inconclusive 或 rate_limited                                                   | 耗时、整数下载字节、速率、HTTP 状态 |
| unlock 容器 | unknown/probe_inconclusive、cancelled/cancelled                                                                                                                                     | 无；服务证据独立                    |
| 服务项      | unknown/probe_inconclusive、service_reachable 或 rate_limited；blocked/region_blocked；failed/request_failed；timeout/deadline；cancelled/cancelled；unsupported/probe_inconclusive | HTTP 状态、可选独立 checkedAt       |

除 format 和服务项外，前置结果也允许 skipped/prerequisite_failed、failed/invalid_format 或 dns_failed、blocked/unsafe_target、unsupported/unsupported_protocol 或 unsupported_transport。proxy、speed、unlock 的内核前置结果还允许 unsupported/kernel_missing、kernel_failed 或 cancelled。这些前置结果不携带测量。

指标保持可选。HTTP 状态必须为 100–599 整数，TCP 不携带 HTTP 状态，下载字节必须为整数。代理成功如携带 HTTP 状态，必须为 204。下载成功及部分测量如携带 HTTP 状态，必须为 200；成功的已报告字节至少 65,536，短读的 unknown/probe_inconclusive 少于该值。读取中途失败、超时或取消仍可保留已测字节、速率与耗时。未收到响应的请求失败也可只携带耗时。

429 必须是 unknown/rate_limited，并携带 httpStatus:429；可保留 0–86,400 整数秒的 retryAfterSeconds，不携带成功测量。此约束沿用已有行为；0.1.0 的旧 proxy/speed 429 输出已不符合此前的限流契约，本次不扩展该兼容范围。

普通 2xx、401 或服务可达不是解锁证明。上述已支持检测器不会输出 native_unlocked、originals_only 或 region，本契约不接受这些未经支持的结论。旧服务项可以缺省 checkedAt，不以回传时间补齐；容器取消仍可以保留各服务先前完成的独立证据。observations 的版本、来源、时效和冲突校验沿用现有规则。

本交付不更改已有历史记录、数据库布局或结果幂等摘要算法。相同合法结果重放继续使用原完成时间；租约、身份和取消保护由既有完成接口验证。第三方检测器必须遵循公开类型契约，不能以旧宽泛枚举推导未实现的能力。
