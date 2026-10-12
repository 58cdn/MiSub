# 探测结果契约、验收覆盖与诊断能力改进建议

状态：建议方案，待审阅。本文对应的 PR 保持 Draft / Open，不自动合并；下述方案均未在本 PR 实现。Issue #7 的安装交付与发行准备继续在独立功能 PR 推进。

## 审阅基线与方法

| 项目  | 固定基线                                                 | 用途                               |
| ----- | -------------------------------------------------------- | ---------------------------------- |
| MiSub | [`2a9ea3608536a2e0b5eb289af34572bf1820ca10`][misub-base] | 分析当前控制面、检测器与 CI        |
| REA   | [`ad08510a113d7a9b8d92fb1e385757880e469869`][rea-base]   | 参考契约、能力清单、诊断与证据机制 |

REA 是提供 CLI / MCP 的逆向分析工具。本文借鉴其工程机制，建议仍围绕 MiSub 的订阅管理、可信检测器与节点诊断，不引入逆向分析功能、REA 运行时或其外部工具依赖。[REA 项目定位][rea-readme]

复核日期：2026-10-12。证据分为：

- **E1 源码确认**：在固定提交读取实现、契约或工作流，可以确认静态行为与调用关系。
- **E2 离线复现**：执行实际函数或请求处理器，使用内存 SQLite、合成输入；可以证明这些边界的行为。
- **E3 集成验收**：在实现 PR 的最终提交运行对应 CI、浏览器或原生平台用例，证明指定集成场景。
- **E4 实际环境验收**：经授权在真实设备、已发布资产和明确的网络条件下执行，单独记录范围和结果。

本文取得 E1 与下述 E2 证据。没有执行 REA 安装器，没有调用真实节点或 Provider，也没有在生产环境投递畸形结果。浏览器覆盖缺口来自工作流和发现规则审阅，不能据此认定页面已损坏。普通 Pages 部署、mock 验收、原生 CI 与真实设备安装分别提供不同证据。

## 优先级与拟交付

| 编号 | 优先级 | 已确认的问题或补充项                                   | 建议独立交付                                | 当前证据       |
| ---- | ------ | ------------------------------------------------------ | ------------------------------------------- | -------------- |
| R1   | P1     | 通用检查接受矛盾状态、错误码及不合类型的指标           | 按检查类型收紧结果契约与 HTTP / SQLite 回归 | E1、E2         |
| R2   | P1     | observations 浏览器验收未接入现有 CI，零测试可成功退出 | 接入现有 lane，并校验测试发现与执行清单     | E1             |
| R3   | P2     | 管理页缺少可解释的检测器能力与不兼容排队原因           | 扩展白名单能力声明和管理展示                | E1；方案待验证 |
| R4   | P2     | 版本、配置、自检与安装状态分散                         | 增加默认本地、只读、脱敏的 doctor 聚合      | E1；方案待验证 |
| R5   | P2     | 历史结果缺少固定的执行版本快照                         | 保存有限、可解释且有来源标记的执行身份      | E1；方案待验证 |

P1 表示优先修复的数据正确性或验收缺口，不表示发现了匿名越权漏洞。R1 结果接口仍要求有效检测器身份和任务租约。能力自报与身份快照用于兼容、排障和追溯，不能替代授权、隔离、完整性验证或可信构建证明。

## R1：按检查类型建立联合结果契约

### 事实与影响

`sanitizeResult()` 对一般检查分别验证 `status` 和 `code` 的枚举；指标只要求有限数值和范围，没有普遍验证检查类型、状态、错误码与指标的组合。observations 容器已有专门状态表，HTTP 429 已有专门限制，应保留这些约束。[结果校验器][misub-contract]

固定基线下，以下四例均通过直接函数调用；进一步经实际 `createProbeHandler()` 与内存 SQLite 提交，均返回 HTTP 200，任务进入 `done`：

| 检查             | 提交内容摘要                                                          | 当前结果   | 缺陷                                   |
| ---------------- | --------------------------------------------------------------------- | ---------- | -------------------------------------- |
| proxy            | `status: passed, code: invalid_format`                                | 接受并完成 | 成功状态与格式错误矛盾                 |
| proxy            | `status: failed, code: ok`                                            | 接受并完成 | 失败状态与成功码矛盾                   |
| tcp              | `status: passed, code: ok, httpStatus: 200.5`                         | 接受并完成 | TCP 检查携带 HTTP 指标，且状态码为小数 |
| unlock / Netflix | 容器 `unknown / probe_inconclusive`，服务项 `passed / invalid_format` | 接受并完成 | 服务项也使用宽泛组合校验               |

OpenAPI 将 `httpStatus` 声明为整数。当前 UI 通常按 `status` 显示通过或失败，并对 `service_reachable` 显示“可访问，解锁未知”；矛盾数据因而有误导展示的风险。本文没有执行上述异常数据的浏览器展示，该影响判断来自显示逻辑。[OpenAPI Check][misub-openapi]、[节点面板][misub-panel]

`finish()` 先规范化结果再计算摘要和更新状态，因此应在现有校验入口拒绝不合法组合，而不是存储后修正显示。保留相同合法结果重放时使用原完成时间的机制，避免重试改变结果摘要或观测新鲜度。[完成与幂等路径][misub-finish]

### 修复方案

参考 REA 将输入、输出和作用声明放入同一公开工具契约，以及枚举合法错误投影的 conformance 测试；在 MiSub 内原创实现按检查类型区分的契约，不复制 REA 代码。[REA ToolContract][rea-contract]、[REA 错误投影测试][rea-projection]

1. 先从实际 Go 生产路径、格式解析器及现有兼容 fixture 枚举合法输出，形成可审阅的兼容表。按 `format / tcp / proxy / speed / unlock / observations` 分派校验，unlock 服务项再按 Provider 规则校验。不得仅取“常见成功输出”构造白名单。
2. 在联合契约中规定允许的 `status + code`、可选或必需指标、字段类型和上下界。`httpStatus` 使用整数；TCP 不接受 HTTP 指标；服务可访问不能升级为已解锁。OpenAPI、校验器、Go 输出 fixture 和 UI 标签同步验收。
3. 对当前版本尚无合法生产路径的 `native_unlocked / originals_only` 等结论，先检查历史已支持版本与 fixture，再决定版本化兼容或拒绝规则；不能因为枚举中存在名称就认可任意成功组合。
4. 维持凭据字段清除、每项服务时间戳、独立来源、冲突及原有 observations 校验。新增错误采用固定错误码，不返回原始节点、请求头或服务响应。

下表是必须保留的实际行为样例，不是完整允许集合：

| 实际路径                 | 当前合法语义                                                                                                              | 契约调整注意点                                  |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| TCP 成功                 | `passed / ok`，节点 TCP 连接耗时                                                                                          | 不把 HTTP 站点耗时混入 TCP                      |
| Proxy URLTest            | 204 且空响应为 `passed / ok`；其他响应可为 `failed / http_error`                                                          | HTTP 204 本身不证明出口质量或解锁               |
| Speed 读取途中超时或取消 | 可以保留已读字节数、速率和耗时，同时为 `timeout / deadline` 或 `cancelled / cancelled`                                    | 不能一律禁止非成功结果携带测量                  |
| Speed 不足 65,536 字节   | `unknown / probe_inconclusive`，可有部分测量                                                                              | 不升级为成功或改写成失败                        |
| HTTP 429                 | `unknown / rate_limited`，HTTP 429，可有有界重试间隔                                                                      | 保留专门规则，不能携带成功测量                  |
| 内核启动阶段取消         | 当前可输出 `unsupported / cancelled`                                                                                      | 兼容此路径；若调整语义需同步客户端与契约        |
| Unlock                   | 容器通常 `unknown / probe_inconclusive`，服务独立 `unknown / service_reachable`、`blocked / region_blocked`、超时或取消等 | 2xx、401 或普通挑战页均不自动证明解锁           |
| Observations             | 容器无总体质量结论；来源可为 `partial`、未知、限流等                                                                      | `partial` 属于来源结果，不能当成通用 Check 状态 |

上述行为来自 [Go 检查执行器][misub-checks]、[服务分类器][misub-services]、[限流证据][misub-rate-limit]、[observations 契约][misub-observations]。节点格式前置失败、DNS 失败、危险目标、协议不支持、未执行与租约取消同样纳入完整回归矩阵。

### 验收标准

- 四个反例在函数边界被拒绝；通过真实请求处理器提交时返回 HTTP 400，原任务保持 `running`，不写入结果或完成时间。随后在有效租约内提交合法结果仍可完成。
- 在内存 SQLite 下验证合法结果首次接受、相同内容幂等重放，以及异租约、已过期或被取消任务继续受现有边界约束。
- Go 生产函数生成的合法 fixture 全部被服务端接受；覆盖各状态、Provider、429、网络取消、部分下载、旧客户端缺省时间戳和 observations 混合来源结果。
- OpenAPI 与运行时都拒绝小数 HTTP 状态码、错误指标类型和跨检查指标；仍保留合法有限测量与未知值。
- 浏览器 mock 验证“可访问，解锁未知”、限流、取消和来源冲突的展示，不引入统一“优质 IP”或未证实的解锁结论。

## R2：让已存在的 observations 浏览器验收成为持续门槛

### 事实与影响

`tests/browser/probe-observations.mjs` 已含独立来源、空值、冲突、过期、同意确认、IPPure 选择、窄屏、焦点返回和未配置存储等离线验收。当前 `probe-control.yml` 的 browser-fixtures job 仅显式执行 management、pairing、table-archive 三个脚本。[现有 observations 用例][misub-browser]、[控制面工作流][misub-control-ci]

Pages 工作流运行 `npm run test:run`，而 Vitest 只发现 `tests/**/*.{test,spec}.{js,ts}`，不会顺带执行该 `.mjs`；配置和 npm 测试命令均允许零测试。由此只能确认持续覆盖缺口，不能推断已有单测全部无效或浏览器功能已失败。[Vitest 配置][misub-vitest]、[npm 脚本][misub-package]、[Pages 测试入口][misub-pages-ci]

### 修复方案

借鉴 REA 比较预期文件与 Vitest 实际发现结果、拒绝遗漏或重复的机制，以及区分模块、边界与实际工具验收的做法。MiSub 继续使用已有 Vitest、Node test 和 Playwright，不照搬 REA 的测试目录规模或工具栈。[REA 发现检查][rea-discovery]、[REA 验收层次][rea-testing]

1. 将 `probe-observations.mjs` 加入现有离线浏览器 lane，保持 mock API 和外部请求阻断；复用已安装 Chromium。
2. 为独立浏览器脚本和 Node `.check.mjs` 建立明确执行清单。将清单与实际文件、CI 命令和完成报告核对；新增、改名、漏跑、重复或执行数量为零均应失败。辅助模块单独列为非入口，不能盲目执行所有 `.mjs`。
3. 对必须包含测试的 CI 命令禁用 `passWithNoTests`。Vitest 比较预期测试集合与实际发现集合，单独验证过滤条件匹配为空时失败。
4. 记录最终提交、用例集合、通过数量及未执行项；失败或取消时保留必要脱敏诊断，不能因缺少报告判为成功。真实节点验收保留为另行授权的步骤。

### 验收标准

- 最终 HEAD 的现有浏览器 job 明确运行四个脚本，包括 observations；其来源冲突、过期、确认、键盘焦点及窄屏断言全部通过。
- 检查 fixture 故意遗漏一个脚本、重复入口、增加未登记脚本或设置空匹配，发现检查都失败；辅助模块不会被误记为测试。
- 浏览器保持零意外外部请求、零页面错误，端口和浏览器进程在结束或失败时清理。
- 报告区分离线行为验收、原生执行和实网验收，不能用 CI 绿色替代未发生的真实检测。

## R3：扩展已存在的能力协商及不兼容解释

### 事实与影响

检测器 claim 已上报 `observationsVersion: 1`；控制面在领取任务时过滤不支持 observations 版本的客户端，已有旧客户端跳过相关租约的测试。因此问题是管理端缺少足够解释，而不是没有能力协商。当前 `agentSummary()` 的 `capabilities` 与 `lastHeartbeatAt` 固定为 `null`。[claim 客户端][misub-client]、[调度与版本过滤][misub-claim]、[管理摘要][misub-summary]、[兼容性回归][misub-observation-tests]

### 修复方案

参考 REA 为能力列出可用性、原因和修复建议，并保留其他可用能力的机制。[REA 能力清单][rea-capabilities]

- 设计版本化、有长度和数量上限的能力声明，例如协议版本、检查类型、observations 版本、来源标识和 Provider 规则版本；所有值经服务端白名单校验，新增字段对旧客户端可选。
- 分开存储检测器声明、服务端接收时间与实际任务反馈。报告时间明确采用服务端时钟；旧版本或未报告显示“未知”，不从平台名或版本字符串猜能力。
- 基于同一调度判断向管理员展示“检测器离线”“当前声明不支持该任务版本”“能力未知”等有界原因与处理方式；过期或离线声明不能显示为实时保证。
- 保持不兼容任务不能被误领、其他兼容任务仍能领取。声明能力不放宽节点传输同意、鉴权、租约与结果校验；控制面的全局 capabilities API 也不能冒充单个检测器的实际能力。

### 验收标准

旧客户端 claim 原样可用；当前 observationsVersion=1 调度行为不变；未知版本、超长或重复能力不能扩大可领取范围。管理 API 和页面覆盖未报告、过期、离线、不兼容与兼容五类情形，输出不包含路径、环境变量或凭据。声明与实际行为不符时呈现明确限制，不能显示“可信”或“已验证安全”。

## R4：聚合本地 doctor，复用现有诊断能力

### 事实与影响

CLI 已支持 `--version`、`--check-config`、`--self-test` 以及 `--status --json`。其中 `--self-test` 会解包并执行内核版本命令；`--status` 属于已有安装管理操作。建议提供一个可读、可机器解析的入口，减少用户收集信息时的遗漏，不把现有能力描述为缺失。[CLI 分派][misub-main]、[安装状态实现][misub-install]

### 修复方案

借鉴 REA 通过只读 host 接口收集检查项、明确状态和修复建议的 doctor 设计。在一键安装、发行资产和 CLI 参数匹配问题完成后再交付此项。[REA Doctor][rea-doctor]

- 新增拟议 `--doctor --json`，通过可测试的内部检查函数复用版本、配置与安装状态逻辑。输出有版本的固定结构，包含检查时间、平台、支持范围、结果码和脱敏修复建议。
- 默认只检查本地已有文件、权限、安装清单、配置形状和版本；不得自动配对、写配置、改 ACL、安装工具、启动服务或读取后输出令牌、节点 URI 与环境变量。
- 内核执行和联网检查必须分别显式选择；默认报告“未执行”。不能默认直接调用会执行内核的 `--self-test`。网络检查仅使用明确批准的固定目标、有界超时与并发，服务器可访问不能被表述为节点出口正常。
- 以固定错误码区分旧包缺少功能、错误架构、缺失配置、权限不合要求、安装记录异常和未执行项。真实路径默认用类别或脱敏形式表示，详细输出也不得包含秘密。

### 验收标准

跨平台 fixture 验证默认零联网、零子进程、零文件修改；缺失、畸形、旧版和无权限配置都产生可理解的有界输出。显式内核自检使用已有受控执行路径并验证清理；显式网络检查通过 mock 验证超时和目标限制。状态退出码、JSON 版本、时间与未知字段策略有明确契约，命令重复执行不改变配置或安装状态。

## R5：保留历史结果的执行身份快照

### 事实与影响

任务已有 `result_json / result_hash / completed_at / attempt`。完成时清除 `node_payload`，领取时更新检测器当前版本和平台，这些行为合理。缺口是历史结果没有固定记录当次 wrapper、内核和规则版本；检测器后续升级会覆盖当前版本，无法由当前 agent 行可靠还原历史执行身份。[表结构][misub-schema]、[claim 更新][misub-claim]、[结果保存与查询][misub-finish]

### 修复方案

参考 REA 的证据结构：结论关联 Provider、执行环境、来源类别和限制；MiSub 仅引入解释探测所必需的白名单元数据，不保存原始探测载荷。[REA Evidence][rea-evidence]

- 在结果格式的兼容扩展中加入有限执行快照：wrapper 版本与 commit、内核版本、结果 schema 版本、Provider 规则版本；优先采用发行清单中的公开身份字段。
- 快照区分检测器自报和服务端已知信息。`attempt`、任务身份及服务端接受时间由控制面确定；客户端执行时间单独验证并标记。自报 commit 或版本不等于签名证明或实际执行证明。
- 同一结果被接受后固定快照；幂等重放不能因当前 agent 升级或服务端接收时间变化而改变摘要。租约重试如何归属 attempt 在契约中明确，避免用最后一次 claim 覆盖旧结果。
- 旧记录不回填当前版本，展示 `unknown`；继续原有保留期限及 `node_payload` 清理。不得保存原始节点配置、口令、令牌、原始响应或可公开枚举的裸配置 hash。

### 验收标准

检测器从版本 A 升级到 B 后，A 结果的快照和摘要保持不变；旧记录显示未知。覆盖租约重试、过期提交、首次完成、重复完成和清理任务。扩展字段超限、非法或包含秘密时拒绝或剔除；API、导出和 UI 都标识信息来源，不把自报包装为受信证明。

## 实施顺序与决策边界

R1、R2 可在各自实现 PR 中并行处理；二者共用的 mock 和契约 fixture 应在集成后重验。R3、R5 需要先确定版本兼容与存储方案，再实现 API、迁移和展示。R4 在实际可用的一键安装交付后进行。各实现 PR 都应独立审查，最终 HEAD 的相关 CI 全通过，再按该 PR 获得的合并授权执行。

本建议 PR 不改变产品行为，不修改 Issue #7 正文，不关闭 Issue，不提供新的安装命令，也不改变发行门槛。正式二进制是否可安装须另行验证对应 Release 资产、平台架构、校验来源、CLI 能力和实际路径；文档合并或 Pages 成功不代表二进制发行完成。

| 后续决定      | 建议默认                             | 完成前必须保留的限制             |
| ------------- | ------------------------------------ | -------------------------------- |
| R1 兼容范围   | 按实际生产输出与支持版本建立集合     | 不拒绝合法取消、未知和部分测量   |
| R3 能力新版本 | 可选、有界、自报字段；服务端确定解释 | 旧客户端能力未知，不能猜测       |
| R5 快照存储   | 版本化扩展，保留期限与现有结果一致   | 不回填旧数据、不扩张敏感数据存储 |
| R4 联网模式   | 默认关闭，另行显式选择               | 不自动运行内核或真实节点任务     |
| 建议 PR 状态  | Draft / Open，等待明确审阅决定       | 不自动合并、不混入安装实现       |

## 离线复核记录与可复现步骤

在固定 MiSub 基线使用 Windows / Node.js v24.20.0，完成四个 `sanitizeResult()` 直接调用和四个实际请求处理器调用。每个请求使用独立的内存 SQLite；合成检测器令牌、租约和节点只存在于测试进程，没有发出网络请求、启动监听器或创建生产身份。HTTP 指这里执行 Request / Response 处理边界，并非 Cloudflare 部署实测。

以下脚本可从该基线仓库根目录以 `node --input-type=module` 从标准输入执行。它描述修复前观察，不应作为期望接受非法数据的产品测试；R1 实现后应将对应断言改为拒绝，并检查状态保持不变。

```js
import { createProbeHandler } from './functions/services/probe-http.js';
import { ProbeStore } from './functions/services/probe-store.js';
import { normalizeOptions } from './functions/services/probe-contract.js';
import { database } from './tests/probes/sqlite-helper.mjs';

const cases = [
    [
        'proxy_passed_invalid_format',
        'proxy',
        {
            proxy: { status: 'passed', code: 'invalid_format' },
        },
    ],
    [
        'proxy_failed_ok',
        'proxy',
        {
            proxy: { status: 'failed', code: 'ok' },
        },
    ],
    [
        'tcp_fractional_http_status',
        'tcp',
        {
            tcp: { status: 'passed', code: 'ok', httpStatus: 200.5 },
        },
    ],
    [
        'unlock_netflix_passed_invalid_format',
        'unlock',
        {
            unlock: {
                status: 'unknown',
                code: 'probe_inconclusive',
                services: [{ service: 'netflix', status: 'passed', code: 'invalid_format' }],
            },
        },
    ],
];
for (const [name, type, checks] of cases) {
    const db = database();
    const store = await new ProbeStore(db).init();
    const agent = await store.addAgent('offline-fixture');
    await store.createJob(
        {
            nodes: [
                {
                    id: 'fixture-node',
                    name: 'fixture',
                    proxy: null,
                    format: { status: 'failed', code: 'invalid_format' },
                },
            ],
            agentIds: [agent.id],
            ...normalizeOptions({ types: [type], options: { services: ['netflix'] } }, 1, 1),
        },
        'rea-repro-' + name
    );
    const task = await store.claim(agent);
    const handler = createProbeHandler({ authorizeAdmin: async () => false });
    const response = await handler(
        new Request('https://misub.example/api/probes/v1/agent/tasks/' + task.id + '/result', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: 'Bearer ' + agent.token,
            },
            body: JSON.stringify({ leaseToken: task.leaseToken, checks }),
        }),
        { MISUB_PROBE_DB: db }
    );
    const row = await store.q('SELECT state FROM probe_tasks WHERE id=?', task.id).first();
    console.log(JSON.stringify({ name, httpStatus: response.status, state: row.state }));
}
```

固定基线的实际输出：

```json
{"name":"proxy_passed_invalid_format","httpStatus":200,"state":"done"}
{"name":"proxy_failed_ok","httpStatus":200,"state":"done"}
{"name":"tcp_fractional_http_status","httpStatus":200,"state":"done"}
{"name":"unlock_netflix_passed_invalid_format","httpStatus":200,"state":"done"}
```

R2 的复核读取了工作流、npm 脚本、Vitest include 与浏览器入口；R3—R5 为源码支持的改进建议，尚无实施结果。本文未执行新的完整项目测试或实网验收，不将历史 CI 结果归属于本文建议的实现。

## 许可与引用方式

已核对固定基线的 [MiSub LICENSE][misub-license] 与 [REA LICENSE][rea-license]，两库根许可均为 MIT；REA 明确保留第三方材料和外部工具的独立许可，见 [THIRD_PARTY_NOTICES.md][rea-notices]。本文为原创分析和设计建议，只引用固定提交的机制及证据，不复制 REA 源码、测试或资源，也不将根 MIT 许可解释为任何捆绑内核或第三方工具的统一发行许可。

[misub-base]: https://github.com/58cdn/MiSub/tree/2a9ea3608536a2e0b5eb289af34572bf1820ca10
[rea-base]: https://github.com/morluto/rea/tree/ad08510a113d7a9b8d92fb1e385757880e469869
[misub-contract]: https://github.com/58cdn/MiSub/blob/2a9ea3608536a2e0b5eb289af34572bf1820ca10/functions/services/probe-contract.js#L55-L112
[misub-openapi]: https://github.com/58cdn/MiSub/blob/2a9ea3608536a2e0b5eb289af34572bf1820ca10/docs/node-probes.openapi.yaml#L820-L861
[misub-panel]: https://github.com/58cdn/MiSub/blob/2a9ea3608536a2e0b5eb289af34572bf1820ca10/src/components/nodes/NodeDetectionPanel.vue#L90-L112
[misub-finish]: https://github.com/58cdn/MiSub/blob/2a9ea3608536a2e0b5eb289af34572bf1820ca10/functions/services/probe-store.js#L227-L270
[misub-checks]: https://github.com/58cdn/MiSub/blob/2a9ea3608536a2e0b5eb289af34572bf1820ca10/detector/checks.go#L16-L227
[misub-services]: https://github.com/58cdn/MiSub/blob/2a9ea3608536a2e0b5eb289af34572bf1820ca10/detector/services.go#L26-L135
[misub-rate-limit]: https://github.com/58cdn/MiSub/blob/2a9ea3608536a2e0b5eb289af34572bf1820ca10/detector/rate_limit.go#L11-L41
[misub-observations]: https://github.com/58cdn/MiSub/blob/2a9ea3608536a2e0b5eb289af34572bf1820ca10/functions/services/probe-observations.js
[misub-browser]: https://github.com/58cdn/MiSub/blob/2a9ea3608536a2e0b5eb289af34572bf1820ca10/tests/browser/probe-observations.mjs
[misub-control-ci]: https://github.com/58cdn/MiSub/blob/2a9ea3608536a2e0b5eb289af34572bf1820ca10/.github/workflows/probe-control.yml#L17-L34
[misub-vitest]: https://github.com/58cdn/MiSub/blob/2a9ea3608536a2e0b5eb289af34572bf1820ca10/vitest.config.js#L6-L11
[misub-package]: https://github.com/58cdn/MiSub/blob/2a9ea3608536a2e0b5eb289af34572bf1820ca10/package.json#L7-L16
[misub-pages-ci]: https://github.com/58cdn/MiSub/blob/2a9ea3608536a2e0b5eb289af34572bf1820ca10/.github/workflows/cloudflare-pages.yml#L47-L57
[misub-client]: https://github.com/58cdn/MiSub/blob/2a9ea3608536a2e0b5eb289af34572bf1820ca10/detector/client.go#L77-L81
[misub-claim]: https://github.com/58cdn/MiSub/blob/2a9ea3608536a2e0b5eb289af34572bf1820ca10/functions/services/probe-store.js#L196-L214
[misub-summary]: https://github.com/58cdn/MiSub/blob/2a9ea3608536a2e0b5eb289af34572bf1820ca10/functions/services/probe-store.js#L22-L33
[misub-observation-tests]: https://github.com/58cdn/MiSub/blob/2a9ea3608536a2e0b5eb289af34572bf1820ca10/tests/probes/observations.check.mjs#L73-L89
[misub-main]: https://github.com/58cdn/MiSub/blob/2a9ea3608536a2e0b5eb289af34572bf1820ca10/detector/main.go#L14-L131
[misub-install]: https://github.com/58cdn/MiSub/blob/2a9ea3608536a2e0b5eb289af34572bf1820ca10/detector/install.go
[misub-schema]: https://github.com/58cdn/MiSub/blob/2a9ea3608536a2e0b5eb289af34572bf1820ca10/functions/services/probe-store.js#L4-L10
[misub-license]: https://github.com/58cdn/MiSub/blob/2a9ea3608536a2e0b5eb289af34572bf1820ca10/LICENSE
[rea-readme]: https://github.com/morluto/rea/blob/ad08510a113d7a9b8d92fb1e385757880e469869/README.md#L40-L43
[rea-contract]: https://github.com/morluto/rea/blob/ad08510a113d7a9b8d92fb1e385757880e469869/src/contracts/toolContractTypes.ts#L39-L58
[rea-projection]: https://github.com/morluto/rea/blob/ad08510a113d7a9b8d92fb1e385757880e469869/tests/conformance/contracts/analysisErrorProjection.test.ts#L10-L70
[rea-discovery]: https://github.com/morluto/rea/blob/ad08510a113d7a9b8d92fb1e385757880e469869/scripts/verify-test-discovery.mjs#L12-L66
[rea-testing]: https://github.com/morluto/rea/blob/ad08510a113d7a9b8d92fb1e385757880e469869/docs/testing.md#L167-L226
[rea-capabilities]: https://github.com/morluto/rea/blob/ad08510a113d7a9b8d92fb1e385757880e469869/src/application/CapabilityInventory.ts#L163-L216
[rea-doctor]: https://github.com/morluto/rea/blob/ad08510a113d7a9b8d92fb1e385757880e469869/src/application/Doctor.ts#L44-L122
[rea-evidence]: https://github.com/morluto/rea/blob/ad08510a113d7a9b8d92fb1e385757880e469869/src/domain/evidence.ts#L91-L124
[rea-license]: https://github.com/morluto/rea/blob/ad08510a113d7a9b8d92fb1e385757880e469869/LICENSE
[rea-notices]: https://github.com/morluto/rea/blob/ad08510a113d7a9b8d92fb1e385757880e469869/THIRD_PARTY_NOTICES.md
