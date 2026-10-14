# 生产只读取证与恢复记录

用途：核实 #33 订阅数量 4→3 的现场事实，以及上线前的资源映射。当前根因未知；本流程不执行迁移、备份恢复或应用初始化。

## 第一阶段：身份和目标

通过用户已有管理面会话检查登录状态、账户和 Pages 项目，读取当前部署 SHA、时间、生产域名和绑定名称/资源 ID。只记录必要非秘密元数据。看见登录页或明确拒绝才请求恢复登录；工具不可用不等于用户未登录。

分别核对 `MISUB_KV`、`MISUB_DB`、`MISUB_PROBE_DB`、`MISUB_SECURITY_DB`、`MISUB_SESSION_DB` 及已配置模式的名称/值。不要读取 secret 值，不调用 secret create/put、绑定更新或部署。当前/历史部署绑定差异必须分别标明时间，不能把当前绑定套到事故时间。

## 第二阶段：最小只读查询

仅在已确认的业务 D1 上使用管理查询通道。每条 SQL 单独复核为 SELECT，先检查结构再选择适用查询；不调用应用 `/api/data`、备份连接测试或可能初始化存储的路由。以下查询没有数据写入；执行需要现有授权的只读通道，不能为了运行它们新建凭据。

```sql
SELECT type, name, tbl_name FROM sqlite_schema
WHERE type IN ('table', 'index', 'trigger') AND name NOT LIKE 'sqlite_%'
ORDER BY type, name;

SELECT name, type, pk, hidden FROM pragma_table_xinfo('subscriptions');
SELECT name, type, pk, hidden FROM pragma_table_xinfo('profiles');
SELECT name, type, pk, hidden FROM pragma_table_xinfo('settings');
```

只有三表列符合仓库 legacy 布局后才执行下列统计；不输出 `data`、`value` 或其中的 URL/密钥。

```sql
SELECT 'subscriptions' AS collection, COUNT(*) AS physical_rows,
       SUM(CASE WHEN json_valid(data) THEN 0 ELSE 1 END) AS invalid_json,
       SUM(CASE WHEN id = 'main' THEN 1 ELSE 0 END) AS main_rows
FROM subscriptions
UNION ALL
SELECT 'profiles', COUNT(*),
       SUM(CASE WHEN json_valid(data) THEN 0 ELSE 1 END),
       SUM(CASE WHEN id = 'main' THEN 1 ELSE 0 END)
FROM profiles;

SELECT id, CASE WHEN json_valid(data) THEN json_type(data) ELSE 'invalid' END AS shape,
       CASE WHEN json_valid(data) THEN
            CASE WHEN json_type(data) = 'array' THEN json_array_length(data) ELSE NULL END
       ELSE NULL END AS array_count
FROM subscriptions WHERE id = 'main';
```

物理行数不等于来源数量，`main` 可能是集合数组；还需区分手动节点、隐藏/禁用来源、筛选和历史部署读取路径。必要 ID 在本地会话内以稳定别名 S1/S2 等映射，只输出同 ID/缺失/新增关系；不输出名称或 URL，不把内容摘要当作备份。未知 schema、非法 JSON、数组/独立行冲突均停止进一步解释，不自动修复。

KV 数据不能借 D1 计数推断。KV 只先取命名空间 ID 与相关 key 的存在性/元数据；读取完整 value 或下载私密副本需具体范围及安全落盘位置，不能发布到 PR/CI。

## 第三阶段：事故和备份时间线

对事故前后分别记录部署 SHA/时间、绑定 ID、已知来源别名数量、可见筛选、备份存在性/时间/大小以及已有恢复窗口元数据。未取得的字段写“未知”。备份正文、完整数据库导出和 WebDAV 凭据不纳入默认报告。只读属性查询不能创建目录或产生连接测试写入；生产 restore 不是取证操作。

输出一份脱敏清单，包含查询模板 ID、时间、目标别名、成功/拒绝/未执行、行数与异常数量。每阶段独立保存，断开后从最后已确认步骤恢复；重连先重新核对目标和部署，禁止基于过期绑定继续。

## 结论规则

仅当事故时刻的权威来源与历史副本可比，才能区分显示差异、读取不同存储、保存覆盖或实际删除。只有当前三条的计数不能确定原第四条为何消失。源码缺陷复现、合成浏览器通过与普通 Pages 部署成功均不能代替上述生产证据。

需要恢复时先制定并演练独立恢复计划，保留当前数据与新增写入；本只读流程不会执行恢复、DDL、DELETE、UPDATE、迁移或模式切换。
