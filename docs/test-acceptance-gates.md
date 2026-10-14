# 测试发现与完成门槛

CI 对每类测试同时检查应运行的文件、实际发现的文件及完成记录。缺失、重复、未登记、空测试、失败、未登记的平台跳过或取消均不能作为成功验收。

| 命令                   | 范围                             | 完成证据                                                                                            |
| ---------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------- |
| `npm run test:ci`      | `tests/**/*.{test,spec}.{js,ts}` | 独立目录扫描与 Vitest 原生 `list --filesOnly --json`、JSON 完成报告精确比对；逐文件必须有通过的断言 |
| `npm run test:probes`  | 清单中全部 Node `.check.mjs`     | Node 22 的逐文件及累计 `test:summary`；文件集合和用例计数一致                                       |
| `npm run test:browser` | 清单中全部浏览器入口             | 每个子进程成功退出，且在本次新建的独立目录中产生非空、无错误的结果报告                              |
| `npm run test:gates`   | 门槛自身的合成负例               | 缺失、重复、漏登记、零测试、失败、旧报告和异常报告均被拒绝                                          |

`npm test`、`npm run test:run` 与 `npm run test:coverage` 保留 Vitest 原生过滤方式；匹配零测试时失败。`test:ci` 是完整验收命令，不接受文件或名称过滤。

## 新增测试

浏览器与控制面入口统一登记在 [`tests/acceptance-manifest.json`](../tests/acceptance-manifest.json)。浏览器项声明脚本、结果文件名、场景字段和错误数组；Node 项声明 `.check.mjs`。辅助模块单独列在 `helpers`，不能把 `.check/.test/.spec` 文件登记为辅助模块。

门槛递归扫描 `tests/browser` 与 `tests/probes` 下的 JavaScript/TypeScript 脚本，并要求与清单完全相等。新增文件必须连同对应入口登记和报告适配一起审查。需要额外后端、构建产物或专用环境的集成脚本，应单独设计明确的运行入口和完成证据，不能通过忽略文件或伪装为 helper 绕过检查。

Vitest 的文件系统清单独立于配置的 include/exclude；修改发现规则时必须同步说明支持的测试文件范围。原生 discovery 命令或 JSON 格式不兼容时门槛失败，不回退为仅扫描文件后宣称已执行。

## 证据与范围

[`vitest-platforms.json`](../scripts/test-gates/vitest-platforms.json) 按文件、完整用例名和平台精确登记系统专用用例。Windows PowerShell 5.1 语法用例在 Linux/macOS 报告为未执行，并由独立 Windows CI 任务运行完整 Vitest 验收。此项跳过不计入通过数量；其他跳过、待执行、todo、重复或失效的登记仍失败。Linux 与 Windows 的相关 CI 都通过后才能视为平台覆盖完成。

摘要默认位于 `tmp/test-gates/*-summary.json`，记录实际 checkout `head`、CI 提供的 PR `sourceHead`、工作区是否有修改、期望/完成清单、计数及未执行项。PR CI 的 checkout 可能是测试合并提交，因此两个 SHA 分别记录。CI 保留摘要制品；浏览器截图与原始合成报告保留在本地忽略的 `tmp/test-gates/browser-*` 目录。

浏览器报告中的 `reportedScenarios` 是现有脚本报告的场景或布局数量，不是自动统计的断言数。此门槛接通现有 observations 合成验收，不扩展其逐项 UI 断言，也不代表真实节点、已发行二进制或生产验证。生产部署与发行仍由各自现有工作流条件控制。

## 并行分支集成

机场订阅分页入口 `groups-pagination.mjs` 已登记为第六个浏览器入口。它在本地回环地址 `127.0.0.1:5196` 启动 Vite、拦截合成 API 并阻断其他 origin，不需要生产后端、凭据或预构建 dist；端口冲突时直接失败。门槛检查本次 `results.json` 的非空、唯一场景 `checks` 和空 `errors`，退出失败或缺失新报告不能通过。不同场景出现相同结果范围时，报告使用明确的场景名称区分，保留原有界面断言。

结果契约分支的 `result-contract.check.mjs` 已登记为第九个 Node 入口。其他分支新增 `.check.mjs`、浏览器入口或报告结构时，后合入的提交应更新清单并在新的准确 HEAD 重跑相关 CI。需要专用后端的浏览器集成不能直接当作普通合成 fixture。清单不会为尚不存在的文件预留成功状态。

### 通知与会话浏览器环境

十三个浏览器入口全部登记。通知与会话入口同样必须产生本次运行的新报告：

`subscription-form-integration.mjs` 额外现场构建真实前端与 API 路由，在 legacy/d1-v1 会话模式各运行八组实际 DOM 表单、保存重试、完整排序、多标签冲突与退出交错。业务/审计/会话各使用独立 SQLite；要求页面错误和 KV 写入为空，两种模式都通过才能完成此入口。

`probe-execution-history.mjs` 验证历史及远端结果两处的执行声明、未知/无记录/未完成状态、失败保持失败与本地格式检查边界。九组真实浏览器场景使用合成 API，并核对布局溢出、页面异常和外部请求；本地格式检查的模拟请求不代表真实节点执行。

`probe-agent-runtime.mjs` 使用合成管理 API 验证卡片和表格中的领单声明与成功续租时间，覆盖中英文、深浅色、窄屏、刷新失败、未知及过期声明。32 组场景要求无布局溢出、页面异常和外部请求；“最近记录”只依据查询时的服务器时间，不表示实时能力。

| 入口                                   | 构建与运行范围                                                                                                                                                                                                |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `admin-notifications.mjs`              | 验证当前 HEAD 前端路径无修改，现场构建本工作树 dist，使用真实 Chrome 与合成 API；外部字体请求被拦截。                                                                                                         |
| `notification-backend-integration.mjs` | 前后端来自同一当前 HEAD；检查后端源码与 Git 内容、前端路径和构建目录，现场构建。内存 SQLite 执行真实登录安全处理器，业务响应为完整合成数据，外联与业务写入必须为零。可选环境路径必须指向当前工作树及其 dist。 |
| `session-authority.mjs`                | 实际会话路由、客户端、IndexedDB、跨标签消息与 store，独立内存会话/安全 SQLite，真实 Chrome Cookie；覆盖迟到登录、续期、退出、重试和锁定。                                                                     |
| `session-cookie-protocol.mjs`          | 独立离线模型的 Cookie/IndexedDB 交错验收；与实际产品入口分别记录，不能替代产品证据。                                                                                                                          |

所有入口使用合成数据及本次独立证据目录，不需要 Cloudflare 或生产凭据。源码不符、浏览器缺失、未知入口、缺失报告、失败或未执行项均使门槛失败。部署安全脚本另由 Pages CI 在 Linux 使用假 curl/Wrangler 执行离线边界测试。

### 已合并短安装器的平台用例

#39 带来的 24 条 Windows 短入口用例已按文件和完整测试名逐项登记；加上原 PowerShell 解析用例，Linux/macOS 共允许 25 条明确平台未执行项，不计入通过。Windows 全量 Vitest lane 必须实际执行这些用例，且安装器原生 lane 分别运行 PowerShell 5.1/7。登记中的用例缺失、重名、改名，或 Windows 上出现跳过，继续失败关闭。
