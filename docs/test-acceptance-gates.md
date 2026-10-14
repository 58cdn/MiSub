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

若其他分支新增 `.check.mjs`、浏览器入口或报告结构，后合入的提交应更新清单并在新的准确 HEAD 重跑相关 CI。特别是结果契约分支新增的 `result-contract.check.mjs` 应登记为 Node 入口；需要专用后端的浏览器集成不能直接当作普通合成 fixture。清单不会为尚不存在的文件预留成功状态。
