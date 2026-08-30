# dsh-issue2pr 深层问题审查报告

> 审查范围:README.md、issue2pr-research.html、index.js、lib/(pipeline / llm / store / connections / stageConfig / assistant / agents / repoState)、lib/stages/(P1-P11)、client.js、tests/
> 审查视角:高级开发专家,以 README/HTML 两个目标交付物为锚点,找"实现撑不住承诺"的深层问题。
> 状态标记:🔴 A 类四项已于 2026-08-30 修复(见文末【修复记录】),其余项待排期。

---

## 总评

插件的单阶段工程质量相当高:异步子进程(不阻塞事件循环)、`safeJoin` 防路径穿越、`esc()` 全量转义、项目文件原子写(tmp+rename)、trace/events 证据流、"写失败不影响主流程"的容错、凭据注入后 `redactUrl` 脱敏日志,这些都做对了。

真正的问题集中在**跨阶段 / 跨 Run 的状态一致性**——这正是 README「五条不变式」(不可跳步 / 可打回 / 可回滚 / 可追溯 / 可复现)中,实现撑不住的部分:不变式的守护停留在单阶段粒度,尚未提升到跨阶段、跨 Run 粒度。

---

## 🔴 A 类:状态机与仓库一致性(已修复)

### A1. 跨 Run 工作区污染 —— 补丁管线的根基性缺陷

**位置**:`index.js` `ensureRepo()`(只在 `.git` 不存在时 clone)、`lib/stages/p11-pr-builder.js`(只写 markdown)。

一个 Run 结束后 repo 工作区仍带着已 apply 的补丁,全程无任何 `reset / checkout / clean`。同项目发起第二个 Run 时:

- P2/P3 对**脏代码**做检索和理解;
- P6 builtin 基于污染状态生成 diff;
- P7 的 `hashBefore` 失去"基线"意义(HEAD 没变但工作区已脏),ledger 无法解释补丁应用前状态。

唯一清理路径是手动调 rollback API。直接违反 HTML 调研的「可复现」不变式。

**修复**:P7 执行器应用补丁前 `git reset --hard HEAD && git clean -fd`(保留 `.gitignore` 目录如 node_modules);drive 进入 P2-P6 前同样重置(双保险;P8-P11 不重置,需保留 P7 已应用状态)。

### A2. 打回/重跑语义与补丁管线的耦合缺陷(三个必败场景)

**位置**:`lib/pipeline.js` `applyReview()`(reject 只重置当前门)、`index.js` rerun 接口(重置下游阶段状态,但不清旧产物、不回滚 repo)。

| 场景 | 后果(修复前) |
|---|---|
| P6 打回后重跑(session 模式) | 旧 `patches/*.diff` 仍在 → `delegateReady` 立即满足 → **复核门形同虚设**,带旧补丁直接放行;P7 把过期 patch 当本轮补丁应用 |
| "每阶段"模式 reject P7 | P7 重跑 → 已 apply 的补丁再 apply → `git apply --check` 失败 → **P7 必败死循环** |
| 从 P6 rerun | 旧+新 patch 混合进入 `collectPatches` → 应用顺序/内容错乱 |

**修复**:① `applyReview` reject 委托阶段时调用 `purgeDelegateArtifacts` 清空旧外部产物(coder-report.json + patches/*.diff,任务包保留由执行器重新生成);② rerun 接口对被重置的委托阶段同样清场;③ P7 应用前重置工作区(见 A1)。

### A3. 同项目多 Run 并发共享一个 repoDir

**位置**:`index.js` `sessionFor`(锁粒度是 runDir,不是 project)。

两个 Run 同时推进 → 同一工作区交错 apply / `hashRepo` → ledger 与实际仓库状态脱节,互相污染证据链。复核门等待期间放开的窗口更让 P8-P11 在别人的工作区上读代码。

**修复**:① 每 Run 独立 `git worktree`(`projects/<slug>/worktrees/<runId>`),P7/P8/P9/P11 与外部智能体都在自己的工作区操作,Run 删除时移除;worktree 创建失败兜底回退基线 repo。② drive 在单 Run 锁外再套**项目级互斥锁**,基线 repo 的 clone/reset 管理操作串行化。

### A4. "全自动"模式 + P6 session = 必然失败

**位置**:`lib/pipeline.js` `isGate()`(reviewMode 非 every/key-only 时返回 false → 全程无门)、`advance()`。

P6 session 模式只写任务包就返回,全自动模式下直接 approved → P7 立即执行 → `collectPatches` 为空 → P7 必败。`delegateReady` 的拦截只存在于 `applyReview`,而全自动模式下 applyReview 根本不会被调用;项目配置与 run 创建均未校验此组合。

**修复**:① `advance` 泛化拦截——任何委托阶段产物未就绪(`stageDelegated && !delegateReady`)时强制 `awaiting_review`,与复核模式无关;外部产出就绪后方可放行(通用适用于所有可委托阶段,不止 P6)。② 兜底:进入 P7 前复查委托产物,缺失则显式失败走 P10 分类,不空跑。

---

## 🟠 B 类:可靠性(待修复)

### B1. drive 循环异常被静默吞掉 + 产物写入非原子
`s.lock = task.then(() => {}, () => {})` 吞掉 drive 内一切异常(典型:`loadRun` 的 `JSON.parse` 遇到半截 run.json)→ Run 永远停在 running,UI 僵死。根因放大器:`writeArtifact` 直接 `writeFileSync` 非原子(两行之外的 `saveProject` 用了 tmp+rename)。
**建议**:catch 中 `logger.error` + `failRun` 兜底;`writeArtifact` 统一 tmp+rename。

### B2. rollbackLedger 无幂等、无前置校验
重复回滚同一行 → `git apply -R` 直接失败;不检查当前 repo 是否仍处于"补丁已应用"状态;ledger 追加 `rollbackOf` 但原行不做标记。
**建议**:回滚前 `git apply -R --check`;ledger 行增加 status 字段。

### B3. attempts 无上限
打回循环无最大次数保护,P6 builtin 每次重跑都是真实 LLM 成本;attempts 记录了但没有任何决策消费它。**建议**:超限转 failed 并提示人工介入。

---

## 🟡 C 类:安全(待修复)

### C1. 令牌泄露到进程 argv(被 redactUrl 掩盖的盲区)
`execFile("git", ["clone", uri])` 中 uri 含 `user:token@` —— 日志侧 `redactUrl` 做得很好,但 Linux 多用户环境下 `ps` / `/proc/<pid>/cmdline` 直接可见令牌。
**建议**:改用 `GIT_ASKPASS` 临时脚本、`http.extraHeader` 配置或 credential helper 走 stdin。

### C2. connections.json 明文存储令牌
磁盘明文落盘。README 应补数据安全说明(目录权限建议、备份风险);长期考虑系统 keychain。

### C3. 委托模式的证据链是"自证"
外部 agent 对 runDir 有完整写权限,可直接写 coder-report.json、patches(甚至 run.json);P9 复核与 P11 Gate 评测基于这些自报产物。diff 本身可验证(apply 成功),但 report 里的通过声明不可验证——这是 HTML「可验证产物」理念与实现的真实差距。
**建议**:ledger 记录每份 diff 的 sha256;P11 Gate 增加"patch 内容 == repo 实际 diff"的机械校验(可自动验却不验,是最可惜的一环)。

---

## 🔵 D 类:README / HTML 文档层(部分随 A 类修复自动解决)

1. ~~**"打回重跑"语义未写透**(README L42):reject 只重跑当前阶段~~ → A2 修复后行为一致(打回即清场重生成),README 已补说明。
2. **"全自动"模式是文档陷阱**(L26):~~与委托 P6 组合必然失败~~ → A4 修复后改为"挂起等待外部产出",README 已补说明;同时建议 HTML 正面论述"全自动跳过的是人工验证而非阶段"这一张力。
3. **routeInfo 部分覆盖被静默忽略**(`lib/llm.js`):`ov.provider && ov.model` 必须同时存在才生效,只配一个会静默落到宿主默认,preflight 展示与用户配置直觉不符。**建议**配置校验时报错而非静默。
4. **hashRepo 失败返回 `"nogit"` 字符串**混入 ledger,与真实哈希不可区分,削弱"可追溯"。**建议**失败时显式报错或记录 null。

---

## 修复优先级

| 优先级 | 项 | 状态 |
|---|---|---|
| P0 | A1 + A2(数据正确性根基) | ✅ 已修复 |
| P0 | A3 / A4(并发损坏 / 必败组合) | ✅ 已修复 |
| P0 | B1(僵死 Run 是用户可直接感知的故障) | ⬜ 待办 |
| P1 | B2, B3, C1 | ⬜ 待办 |
| P2 | C2, C3, D3, D4 | ⬜ 待办 |

---

## 【修复记录】A 类(2026-08-30)

| 文件 | 改动 |
|---|---|
| `lib/repoState.js`(新增) | `resetRepoClean`(基线重置)、`baseRepoDir / runRepoDir`(路径模型:基线 repo + per-Run worktree)、`ensureWorktree`(幂等创建,失败兜底回基线路径)、`removeWorktree`(Run 删除时清理) |
| `lib/pipeline.js` | `advance`:委托阶段产物未就绪强制 `awaiting_review`(A4,通用化到所有可委托阶段);进入 P7 前复查委托产物,缺失显式失败(A4 兜底);`applyReview`:reject 委托阶段时 `purgeDelegateArtifacts` 清场 + 记事件(A2) |
| `lib/stageConfig.js` | 新增 `purgeDelegateArtifacts`:P6 清 coder-report.json + patches/*.diff(任务包保留),其余委托阶段清 `delegateSpec.output` 文件(A2) |
| `lib/stages/p7-patch.js` | 应用补丁前 `resetRepoClean`(A1/A2 场景 2/3 的根治);空 patch 诊断保持在 reset 之前(错误契约不变) |
| `index.js` | drive 单 Run 锁外再套项目级互斥 `withProjectLock`(A3);开工时 `ensureWorktree` + 进入 P2-P6 前基线重置(A1/A3);`buildRcx.repoDir` 指向 per-Run worktree;rerun 接口对被重置的委托阶段清场(A2);rollback 接口对准 run 的 worktree;delete 接口尽力移除 worktree;`ensureRepo` 改用 `baseRepoDir` |
| `tests/` | 新增 `repo-state.test.js`(reset/worktree/隔离证据);`pipeline.test.js` +3(auto+session 挂起、打回清场、P7 兜底失败);`stages-p7-p8-p10.test.js` +1(P7 重跑自动重置);`stage-config.test.js` +1(purgeDelegateArtifacts)。合计 121 用例全过 |

**已知取舍 / 后续注意**:
- 基线 repo 只 clone 一次,不自动 `git fetch` 更新(与修复前行为一致);需要追上游新提交时属产品决策(是否每次 Run 前拉取),未纳入本次范围。
- worktree 随 Run 生命周期存续(Run 删除时清理),completed 的 Run 保留 worktree 供检查/开 PR,磁盘占用随之增长,由用户删除 Run 收敛。
- 若外部智能体在 worktree 内做了 `git commit`(而非约定的"工作区干净 + 产出 diff"),`reset --hard HEAD` 只能回到被移动后的 HEAD——该场景由 P7 的 `git apply --check` 显式失败兜底,走 P10 分类。

---

## 【修复记录】A4 修正：「拿到委外结果 + 验证 ok」才往下流转（2026-08-30 第二轮）

**修正动机**：A4 初版只拦「空手放行」（产物不存在 → 挂起等待），但「文件存在 ≠ 产物可用」：全自动模式下 claude 产出的坏补丁（上下文不匹配 / 结构残缺 / report 损坏）仍会直通 P7 才在 `git apply` 炸出难定位的错；且全自动 + session 挂起后没有任何机制在产物就绪时自动续跑，「全自动」名不副实。

**修正后的放行不变式**：委托阶段流转到下一阶段，当且仅当 ①拿到委外结果（补丁清单非空，与 P7 应用清单同口径）且 ②机器验证 ok（结构完整 + 对 HEAD 基线应用性演练通过）。三条放行路径同一口径：

| 路径 | 行为 |
|---|---|
| 人工门（every / key-only） | `approve` 时执行 `verifyDelegateResult`，验证不过拒绝放行并给出逐条错误（applyReview 异步化） |
| 全自动（auto） | drive 挂起时启动就绪监听（默认 5s，可 `ISSUE2PR_DELEGATE_WATCH_MS` 调）；产物就绪 → 验证 → 通过即自动放行（落 `reviews/*-auto-approve-*.json` 审计记录）并续跑；连续 3 次（可 `ISSUE2PR_DELEGATE_VERIFY_MAX_FAILS` 调）不过 → Run 显式失败 + P10 归因，不无限等待 |
| advance 直通（claude 同步执行完） | 产物就绪立即验证，不过就地 failed（事件留痕），P7 不执行 |

**验证算法（`lib/delegateVerify.js`）**：

- P6：补丁清单复用 P7 的 `collectPatches`（导出复用，清单口径 1:1）；逐份存在/非空/形如 unified diff；report 可解析且清单文件齐全。
- 应用性演练：临时 `GIT_INDEX_FILE` → `read-tree HEAD` 构建一次性基线索引 → 按应用序逐份 `git apply --cached`——不碰工作区（无需工作区干净）、多补丁在前序之上验证（与 P7 reset→顺序 apply 语义一致）、索引即抛（丢弃无痕）。repoDir 缺失（纯单测）仅结构验证；repoDir 存在但非 git 仓库 → 显式验证失败。
- 其余委托阶段（P1-P5/P9/P11）轻验证：产物存在、非空、`.json` 契约可解析。
- 顺带修复：`collectPatches` 对坏 report JSON 从裸 `SyntaxError` 崩溃改为显式可定位错误（P7 同步受益）。

| 文件 | 改动 |
|---|---|
| `lib/delegateVerify.js`（新增） | `verifyDelegateResult`（结构 + 演练两层）；`execGit` 正确处理 stdin（execFile 无 input 选项，`git apply -` 须手写 stdin——否则 60s 超时挂死） |
| `lib/pipeline.js` | advance：委托阶段就绪即验证、不过显式失败；P7 前兜底升级为完整验证（存在性快速路径保留，错误契约兼容）；applyReview 异步化 + approve 验证门 |
| `lib/stages/p7-patch.js` | 导出 `collectPatches`；坏 report JSON 显式报错 |
| `index.js` | `delegateWatchTick` / `maybeWatchDelegate` / `stopDelegateWatch`（就绪监听，间隔与失败阈值环境变量可调，unref 不阻退出）；review/stop/rerun/delete/项目删除全部停监听；review 接口 `await applyReview` |
| `tests/` | 新增 `delegate-verify.test.js`（7：结构拦截/演练通过/不可应用拦截/顺序依赖语义/非 git 仓库/轻验证）与 `delegate-watch.test.js`（6：waiting/gate/idle/自动放行+审计/连续失败+P10/容错窗口修正后放行）；`pipeline.test.js` +4（人工放行过机器验证 ×2、全自动坏补丁显式失败、全自动好补丁直通 P7）。合计 138 用例全过 |

**已知取舍**：

- 全自动监听的容错窗口（3 次 × 5s）是为「外部会话可能仍在写产物」留的稳定窗口；产物被外部反复改写时可能多等几轮，但绝不空手放行。
- 演练用 `git apply --cached`（非 `--3way`）：与 P7 实际应用策略一致，不做三方合并的「侥幸通过」。
- 有人工门的模式（key-only 的 P6）不自动放行——机器验证只是守门员，关键门仍由人决策；验证防止人被「文件存在」误导。
