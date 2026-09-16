<div align="center">
  <img src="docs/assets/banner.svg" alt="dsh-issue2pr — 从一条 Issue 到一份被合并的 PR，中间不能跳步" width="100%">
  <p>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-2A3F7A?style=flat-square" alt="License: MIT"></a>
    <a href="https://www.npmjs.com/package/dsh-issue2pr"><img src="https://img.shields.io/npm/v/dsh-issue2pr?style=flat-square&color=506B3A" alt="npm version"></a>
    <img src="https://img.shields.io/badge/node-%E2%89%A5%2018-506B3A?style=flat-square&logo=nodedotjs&logoColor=white" alt="Node ≥ 18">
    <img src="https://img.shields.io/badge/host-DSH%20%E6%8F%92%E4%BB%B6-A07A1F?style=flat-square" alt="DSH 插件">
    <img src="https://img.shields.io/badge/pipeline-11%20stages%20%C2%B7%204%20gates-2A3F7A?style=flat-square" alt="11 stages · 4 review gates">
    <img src="https://img.shields.io/badge/%E5%B7%A5%E4%BD%9C%E5%8F%B0-5%20%E9%A1%B5%20%2B%20%E6%99%BA%E8%83%BD%E5%8A%A9%E6%89%8B-A6453A?style=flat-square" alt="工作台 5 页 + 智能助手">
    <a href="#-贡献"><img src="https://img.shields.io/badge/PRs-welcome-506B3A?style=flat-square" alt="PRs welcome"></a>
  </p>
</div>

> **从一条 Issue 到一份被合并的 PR，中间不能跳步。**
> 每一段路径都有自己的输入契约、失败信号、可回滚产物与可独立审查的 Artifact。

**dsh-issue2pr** 是一个运行在 [DSH 宿主](#-快速开始)里的全局插件：把一条 GitHub / GitLab Issue（或本地需求文档）交给一条 **11 阶段流水线**，经过检索、理解、诊断、规划、多智能体编码、真实测试、三维审查与 Gate 评测，最终产出一份**忠实反映修改与验证过程**的 PR 说明——以及一整条可打回、重跑、回滚与追溯的证据链。

它不是又一个「一把梭」的 coding agent。真正的交付物不是 PR 文本，而是一份**可审查的系统**：每段产出有编号产物落盘，每次状态变更有 Trace，每个关键节点有人工复核门。

---

## ✨ 特性总览

- 🔗 **11 阶段全链路**：Issue 分析 → 检索 → 代码理解 → 根因假设 → 任务规划 → 编码 → 补丁管线 → 测试 → 审查 → PR 构建，一步不省。
- 🚦 **人工复核门**：P5 / P6 / P9 / P11 四道门控，`approve` 放行、`reject` 带意见打回；复核模式可选每阶段 / 仅关键 / 全自动。委托阶段放行前必须通过**机器验证**（产物完整 + 对 HEAD 基线可应用），全自动模式同样先验证再放行——不空手放行、不带病放行。
- 🧾 **产物证据链**：每个阶段落盘编号产物（`01-issue-analysis.json` … `11-eval-report.json`），输入来自上游、输出去往下游契约，可独立审查、可打回重做。
- 🔁 **可回滚**：Patch Pipeline 带台账（ledger），只撤销 Agent 引入的修改，不碰用户自己的代码。
- 🧪 **真实测试**：结果必须来自真实工具执行——在克隆的仓库里跑真实测试命令，完整输出落盘可回溯。
- 🤝 **多智能体 + 外部委托**：P6 内置 Planner / Coder / Reviewer 协同；也可把任务包委托 DSH 会话、Claude Code CLI 或 DSH 原生智能体执行。
- 🖥️ **工作台 UI**：项目 / 运行 / 产物 / 配置 / 说明五页 + 悬浮智能助手（实时上下文问答、流式输出、可拖拽缩放）。
- 🔌 **Git 托管连接**：GitHub / GitLab / 华为云 CodeArts 凭据全局共享，克隆与 Issue 抓取自动注入；带探活与仓库连通性测试。
- 🧭 **逐阶段配置**：每个阶段可单独改提示词、换模型、调超时与专属参数，改完下一阶段即生效。
- 📡 **全程可观测**：`trace/events.jsonl` 记录每次 LLM 调用、git 操作、测试执行的开始 / 完成 / 失败。

## 🧭 工作原理

<div align="center">
  <img src="docs/assets/pipeline.svg" alt="11 阶段流水线：主流程 P1→P9→P11，复核门 P5/P6/P9/P11，失败旁路 P10" width="100%">
</div>

一次 **Run** 就是一条证据链：从触发源读入 Issue 原文，主流程 `P1→P9→P11` 依次推进、每步落盘产物；任何阶段失败立即停下进入 P10 分类旁路；到复核门时等待人工 `approve / reject`，打回意见会传回该阶段重新执行（委托阶段的旧外部产物同时清场；P7 应用补丁前会把工作区重置回基线，不残留上一轮补丁）。

### 阶段一览

| 阶段 | 名称 | 职责 | 落盘产物 | 复核门 |
| --- | --- | --- | --- | --- |
| **P1** | IssueAnalyzer | 自然语言 Issue → 结构化契约：现象 / 触发条件 / 影响范围 / 可验证成功标准 / 风险等级 | `01-issue-analysis.json` | |
| **P2** | Search Layer | 按文件清单选候选文件，附理由与置信度 | `02-search-candidates.json` | |
| **P3** | Code Understanding | 深读候选源码，输出关键函数、调用链与修改点（`路径:行号` 锚点） | `03-code-understanding.md` | |
| **P4** | Hypothesis | 可验证根因假设：每条带证据、验证文件与验证方法 | `04-hypotheses.json` | |
| **P5** | Planner | 拆解为有依赖的 TaskGraph，节点可独立验证 | `05-task-graph.json` | ✅ |
| **P6** | 代码优化 | 多智能体协同，或委托外部执行器（见下） | `06-implementation/patches/*.diff` | ✅ |
| **P7** | Patch Pipeline | diff 版本校验 → 落盘，写 patch 台账（回滚依据） | `ledger/patch-ledger.jsonl` | |
| **P8** | TestRunner | 真实仓库执行测试命令，完整输出落盘 | `07-test-report.json` | |
| **P9** | Reviewer | 三维门控：① Diff 范围 ② API 与安全 ③ 测试补强与说明忠实——测试通过 ≠ 可合并 | `08-review-report.json` | ✅ |
| **P10** | FailureClassifier | 六类归因（实现 / 根因 / 测试选择 / 环境 / 权限 / 反复失败）→ 重跑 / 回滚 / 转人工 | `09-failure-analysis.json` | 仅失败时 |
| **P11** | PRBuilder + Eval | 忠实 PR 说明 + Gate 六项评测 | `10-pr-description.md` · `11-eval-report.json` | ✅ |

### 五条不变命题

> 从 Issue 到 PR 这条链上，无论 Agent 如何演进，这 5 条不能变。

| 命题 | 含义 |
| --- | --- |
| **不可跳步** | 分析、检索、理解、规划、修改、测试、Review、评测，省了任何一步都不能称为「交付」。 |
| **可定位** | 任何失败都必须落到具体模块；没有归属的失败不允许简单重跑。 |
| **可回滚** | Agent 引入的修改必须可逆，且能区分「用户改的」与「Agent 改的」。 |
| **可审查** | Patch、测试日志、PR 说明与评测报告——每一份都要能被打回重做。 |
| **可复现** | 全链路 Trace 从 Issue 贯穿到 PR；没有 Trace，PR 的生成过程无法解释。 |

### 两种关键模式

**复核模式 `reviewMode`**——哪些阶段停下来等人：

| 取值 | 行为 |
| --- | --- |
| `every` | 每个阶段完成后都进入复核门 |
| `key-only` | 仅 P5 / P6 / P9 / P11 停（推荐） |
| `auto` | 全自动推进（委托阶段仍需产物验证，见下） |

**P6 执行模式 `p6Mode`**——代码由谁写：

| 取值 | 行为 |
| --- | --- |
| `builtin` | 内置多智能体：Planner 派单 → 并行 Coder（TDD / 最小 diff 纪律）→ Reviewer 门控 |
| `session` | 生成任务包交给 DSH 会话人工执行，完成并通过复核门放行 |
| `claude` | 任务包自动委托 Claude Code CLI 无人值守执行，失败回退等人工会话 |
| `dsh` | 任务包交给 DSH 宿主原生智能体（`ctx.agents`）执行，零外部认证 |

### 委外产物验证

委托阶段（`session` / `claude` / 各阶段委托开关）的放行不看「文件存在」，看「产物可用」，验证分两层：

1. **结构完整**：补丁清单与 P7 应用清单同口径；逐份补丁存在、非空、形如 unified diff；`coder-report.json` 可解析且清单与文件一致。
2. **应用性演练**：用一次性 git 索引从 `HEAD` 构建基线，按应用序逐份 `git apply --cached` 演练——不碰工作区，语义与 P7 完全一致；对基线不可应用的补丁在此拦截。

三条放行路径同一口径：**人工门** `approve` 必须验证通过；**全自动**（`auto`）插件轮询产物就绪（默认 5s）自动验证，通过即放行并落 `auto-approve` 审计记录，连续 3 次不过则 Run 显式失败并走 P10 归因；**advance 直通**（如 `claude` 同步执行完）验证不过就地失败——绝不把坏补丁带进 P7。

### 委外智能体：发现 + 测试门禁

选 `claude` 模式后，项目页与配置页出现「委外智能体」绑定卡：

- **多方式发现**（去重合并）：项目配置 > 环境变量 `ISSUE2PR_CLAUDE_BIN` > 常见安装位置 > `npm config get prefix` 全局目录 > PATH；也可手动指定完整路径。
- **测试门禁**：保存前真实跑一次极小调用，三步全绿（定位 → `--version` → 认证微任务）才能保存——`403 IP access denied by API-Key restrictions`、未登录这类认证错误在**绑定时**就拦截并给出处置提示，而不是等 Run 走到 P6 才失败。微任务仅一轮、几十 token。
- 改过绑定路径后门禁结果即失效需重测；服务端保存时另有 `--version` 级快检兜底。

## 🚀 快速开始

### 环境要求

- **DSH 宿主**（插件随 dsh web 同生共死）、**Node.js ≥ 18**、**git**
- 可选：**Claude Code CLI**（仅 `p6Mode: "claude"` 需要）
- LLM：优先用 DSH 宿主当前默认模型，也可逐阶段覆盖

### 安装

已发布到 npm（推荐——预构建包，无需授权构建脚本）：

```bash
dsh plugin --profile web add dsh-issue2pr
```

或从源码安装——克隆进 DSH 插件目录后重启 DSH：

```bash
# Windows: C:\Users\<you>\.dsh\plugins\  ·  macOS / Linux: ~/.dsh/plugins/
cd ~/.dsh/plugins
git clone https://github.com/LONGSASASASASA/dsh-issue2pr.git dsh-issue2pr
```

> 也可用 [dsh-plugin-manager](https://github.com/LONGSASASASASA) 插件管理，或审阅源码后用 `dsh plugin --profile web add github:LONGSASASASASA/dsh-issue2pr#<commit>` 锁定 commit 安装。数据与插件目录分离（见[数据布局](#-数据与产物布局)），升级插件不丢数据。

### 五分钟跑通第一单

1. **建项目**：DSH 侧边栏「Issue2PR」→ 项目页 → 新建，填名称、slug、仓库地址；触发源用 Issue 链接或本地需求文档路径。
2. **配连接**（私有仓库需要）：「Git 托管连接」添加凭据并点「测试」探活；公开仓库与 `GITHUB_TOKEN` 环境变量可直接用。
3. **发起 Run**：粘贴 Issue 链接或选本地需求文档，插件自动浅克隆主仓库并开始推进。
4. **盯运行、过复核门**：运行页看阶段进度与事件流；复核门查看产物，`approve` 放行或 `reject` 带意见打回。
5. **拿 PR 说明**：P11 通过后打开 `10-pr-description.md`——背景、根因、修改点、验证证据、风险齐全，据此开 PR；`11-eval-report.json` 是 Gate 六项自评。

> 环境不对劲？项目页的 **preflight 健康探测**会显示 git 版本、claude CLI 是否就绪、默认模型从哪来。

## ⚙️ 配置详解

### 项目配置（project.json）

```jsonc
{
  "name": "我的项目",
  "slug": "my-project",                  // 小写字母/数字/连字符
  "repos": ["https://github.com/me/my-project.git"],
  "triggers": [
    { "kind": "issue", "uri": "https://github.com/me/my-project/issues/42" },
    { "kind": "requirement", "uri": "C:/docs/需求-登录修复.md" }
  ],
  "reviewMode": "key-only",              // every | key-only | auto
  "p6Mode": "builtin",                   // builtin | session | claude | dsh
  "testCommand": "npm test",             // 留空则自动探测 package.json 的 test 脚本
  "testEnvironment": {
    "platform": "host",                 // host | win32 | linux | darwin
    "shell": ""                         // 留空使用系统默认，或 Shell 可执行文件的绝对路径
  },
  "stageConfig": { /* 逐阶段覆盖，见下 */ }
}
```

### 测试执行与失败分析

在项目编辑页设置测试平台和 Shell。新建任务会保存环境快照，后续修改项目配置不会改变已有任务；旧快照没有环境字段时沿用宿主默认环境。`platform` 是运行前的兼容性检查，不会自动启动 WSL、容器或远程 Linux。

Windows 默认使用原生 `cmd.exe`，无需安装 Git Bash。Shell 也支持显式配置 sh 兼容解释器（Bash、sh、dash、zsh）的绝对路径，不带参数；所选 Shell 同时用于外层测试命令及 npm 内部脚本。

Windows CMD 下，P8 将独立、无参数的 `date` 命令适配为 `date /t`，避免等待修改系统日期。适配覆盖外层命令和可确认的根目录 npm 测试调用链（含 `cross-env` 与 pre/post 生命周期），保留全部测试及参数；带参数、引用字符串、复杂 Shell 语法、其他工作目录和 workspace 不猜测改写。npm 脚本只在测试期间临时调整，正常结束、失败、超时及取消后恢复 `package.json` 原始字节，不加入业务补丁。原文备份及前后命令记录在 `trace/test-command-adaptations/`，测试报告通过 `commandAdaptation` 引用；遇到外部修改或回收未确认时保留备份并报错，存在 `trace/cmd-date-pending.json` 时须先核对恢复，不能将残留适配当作源文件继续测试。其他脚本兼容性仍由项目负责。

P8 关闭标准输入，持续保存 stdout/stderr，按 P8 的 `timeoutMs` 限时执行；停止、删除、重跑及正常关闭插件时统一回收测试进程树。环境不匹配或 Shell 不可用时直接报告具体错误。无法确认回收时明确报错并阻止同任务再次启动测试。

`07-test-report.json` 记录实际命令、目录、平台、Shell、执行编号、退出码与超时/取消等事实；`08-test-output.txt` 保存完整输出。P10 仅采用与本轮身份一致的报告和日志，区分执行超时、取消、环境故障与原因未确定，模型失败时仍保存基础证据。单独重跑 P10 只重新分析；委托分析按本轮任务包提交报告后，再重跑 P10 读取结果。历史结果不覆盖新一轮状态。

更新此机制后，需要让 DSH 加载新版插件并重启。若宿主使用安装目录中的副本，须先更新该副本；只刷新页面不会更新后端执行器。

### 逐阶段配置（stageConfig）

每阶段可独立覆盖，未配置项回落默认值，**改动在下一阶段即时生效**：

```jsonc
"stageConfig": {
  "P3": {
    "provider": "deepseek-official",     // 本阶段换模型
    "model": "deepseek-v4-pro",
    "reasoningEffort": "high",
    "timeoutMs": 600000,
    "maxTokens": 16384,
    "prompts": { "": "你是 Code Understanding……（覆盖默认提示词）" },
    "params": { "deepReadFiles": 10, "fileChars": 8000 }
  },
  "P6": {
    "delegate": { "mode": "session" },   // 本阶段委托外部智能体，产出就绪才放行
    "params": {
      "claudeBin": "C:\\Users\\you\\AppData\\Roaming\\npm\\claude.cmd",
      "claudeTimeoutMin": 120,
      "claudeAuthPreset": "glm",         // none | glm | custom（认证中转，403 根治）
      "claudeRelayModel": "glm-5.3",     // glm 预设的驱动模型
      "claudePermission": "acceptEdits", // acceptEdits | bypass | dontAsk
      "dshTimeoutMin": 120
    }
  },
  "P9": { "params": { "diffChars": 2000 } }
}
```

阶段专属参数（`repoScanMax`、`deepReadFiles`、`diffChars`、`claudeBin` 等）在「配置」页有中文说明与默认值——**凡影响执行行为的数值与路径都不硬编码**，全部可被项目配置覆盖。

### Git 托管连接

| 类型 | 凭据 | 说明 |
| --- | --- | --- |
| GitHub | Access Token | 克隆注入 `x-access-token`；Issue 抓取与探活走 `/user` |
| GitLab | Personal Access Token | 支持自建实例（自定义 host）；注入 `oauth2` |
| 华为云 CodeArts | HTTPS 密码 + 用户名 | 凭 `git ls-remote` 真实仓库测试连通 |

- 全局共享一份（`~/.dsh/issue2pr/connections.json`），多项目复用；ssh 地址走本机密钥，不注入。Run 进行中改连接，下一阶段即生效。
- 凭据不落 `connections.json`：SecretStore 按 **keychain-first** 工作（macOS Keychain / Linux Secret Service；Windows 构建无内置 Credential Manager 适配器，明确降级到 `<dataRoot>/secrets/` 非加密文件，仅尝试 `0700`/`0600` 权限收紧，**不保证** ACL 隔离）。UI 一律只显示掩码，事件日志自动抹除 URL 凭据段；旧版明文 token 首次读取时自动迁移，密钥环不可用时显式警告「非加密文件回退」。
- Git `clone` / `ls-remote` 的 URI/argv 不携带 token，认证头仅注入子进程环境；同机可读进程环境的用户应视为可信。

### 委外执行器（P6 自动执行通道）

P6「自动执行」有两个执行器，同一套任务包契约（`session-task.md` → `patches/*.diff` + `coder-report.json`）、同一套产物机器验证，按项目自由切换：

| | claude-code（委托 Claude Code） | dsh-agent（DSH 原生智能体） |
| --- | --- | --- |
| 形态 | 本机 claude CLI 子进程（`-p` headless + stream-json） | 宿主内置 agent loop 进程内执行（`ctx.agents`） |
| 模型 | 本机 claude 认证（可走中转） | 宿主模型路由（Models 页） |
| 外部认证 | 需要（CLI 登录态 / 中转 token） | **零外部认证** |
| 403 IP 白名单 | 配认证中转后根治 | 天然免疫 |
| 依赖 | claude CLI ≥ 2.1（推荐 ≥ 2.1.140） | DSH 宿主提供 `ctx.agents`（完全重启 DSH 生效） |

两者都先过**测试门禁**才能保存：claude 三步（定位 → 版本 → 认证），dsh 两步（智能体服务 + 模型路由 → 真实微任务）。

**认证中转（403 根治）**：公司网络出口漂移会让带 IP 白名单的 API Key 间歇 403。绑定卡「认证中转」选 **GLM Coding Plan** 并保存 token 后，claude 改打 `https://open.bigmodel.cn/api/anthropic`（官方 Anthropic 兼容端点，无 IP 白名单校验）。因用户级 `~/.claude/settings.json` 的 `env` 块会覆盖进程环境变量，中转经 `--settings` 临时文件注入（连 `ANTHROPIC_MODEL` 等模型映射一并覆盖，避免残留模型名报错）；token 由同一套 SecretStore 管理（`relay-auth.json` 只存 `secretRef`），临时文件用后即删、日志零 token。也可选「自定义网关」指向自建 claude-code-router / new-api。

**权限档位**：claude 执行默认 `acceptEdits` + 宽白名单，替代裸 `--dangerously-skip-permissions`；`claudePermission` 可回退 `bypass` 或收紧 `dontAsk`。

**执行可靠性**：stream-json 逐帧解析（`is_error` / 0-token 空结果显式判失败）；stdout 实时落盘 `external-exec.log`；超时杀整棵进程树；`session_id` 落档 `run.json`（为 `--resume` 留钩）。

## 📦 数据与产物布局

所有数据集中在 `~/.dsh/issue2pr/`，一次 Run 一个目录 = 一条完整证据链：

```text
~/.dsh/issue2pr/
├─ connections.json                  # Git 托管连接元数据 + secretRef（不含 token）
├─ relay-auth.json                   # claude 中转元数据 + secretRef（不含 token）
├─ secrets/                          # 仅 keychain 不可用时使用；非加密
│  └─ <sha256(secretRef)>.secret
├─ ui-state.json                     # UI 选中记忆兜底（宿主重启不丢）
└─ projects/
   └─ <slug>/
      ├─ project.json                # 项目配置（含 stageConfig）
      ├─ repo/                       # git clone --depth 1 的主仓库
      └─ runs/<时间戳-slug>/         # 一次 Run 一个目录
         ├─ run.json                 # 状态机唯一事实源（每步落盘）
         ├─ 01-issue-analysis.json   # P1 … P11 的编号产物
         ├─ 02-search-candidates.json
         ├─ 03-code-understanding.md
         ├─ 04-hypotheses.json
         ├─ 05-task-graph.json
         ├─ 06-implementation/       # patches/*.diff + coder-report.json
         ├─ ledger/patch-ledger.jsonl  # P7 台账：rollback 的依据
         ├─ 07-test-report.json      # + 08-test-output.txt（完整测试输出）
         ├─ 08-review-report.json
         ├─ 09-failure-analysis.json # 仅失败路径
         ├─ 10-pr-description.md     # + 11-eval-report.json（Gate 六项）
         ├─ reviews/*.json           # 每一次复核决定（approve/reject + 意见）
         └─ trace/                   # events.jsonl + spans.jsonl 全程可观测
```

`repo/` 是基线克隆，`worktrees/<runId>` 是每个 Run 的独立工作区（同项目并发 Run 互不污染，Run 删除时一并清理）。

## 🖥️ 界面一览

| 页面 | 你在这里做什么 |
| --- | --- |
| **项目** | 新建 / 编辑项目、仓库、触发源、复核模式，管理连接，发起 Run |
| **运行** | 阶段进度、逐阶段事件流（LLM / git / 测试）、复核门审批、停止 / 回退重跑 / 回滚 / 删除 |
| **产物** | 按 Run 浏览产物树，逐文件预览（200KB 内） |
| **配置** | 逐阶段编辑提示词、模型路由、超时、专属参数与委托开关 |
| **说明** | 内置使用说明与阶段速查 |

右上角**悬浮智能助手**：读取当前页面 / 项目 / Run 作为实时上下文，流式回答「跑到哪了、为什么失败」，面板可拖动缩放、跨重启记忆位置。

## 🔌 REST API 一览

插件随宿主注册在 `/issue2pr` 前缀下，UI 之外也可脚本调用：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/issue2pr/api/ping` | 健康检查 |
| GET | `/issue2pr/api/stage-defaults` | 阶段能力表与默认提示词 |
| GET/POST | `/issue2pr/api/ui-state` | UI 偏好兜底存储 |
| GET/POST/DELETE | `/issue2pr/api/connections[/:id]` | Git 托管连接管理 |
| POST | `/issue2pr/api/connections/test` · `test-repo` | 凭据探活 / 真实仓库连通（`git ls-remote`） |
| GET/PUT/DELETE | `/issue2pr/api/relay-auth` | claude 认证中转配置（token 走 SecretStore） |
| GET | `/issue2pr/api/preflight` | 环境健康探测（git / claude CLI / LLM 路由来源） |
| GET | `/issue2pr/api/agents/discover?slug=` | 委外智能体多方式发现 |
| POST | `/issue2pr/api/agents/test` | 委外智能体测试门禁 |
| POST | `/issue2pr/api/check-local` | 本地触发源存在性 |
| POST | `/issue2pr/api/assistant/ask` | 悬浮助手问答（NDJSON 流式） |
| GET/POST | `/issue2pr/api/projects` | 项目列表 / 保存 |
| DELETE | `/issue2pr/api/projects/:slug?confirm=slug` | 删除项目（防误删确认） |
| GET/POST | `/issue2pr/api/projects/:slug/runs` | Run 列表 / 发起（同秒重复返回 409） |
| GET | `.../runs/:runId` | Run 详情（含外部执行进度） |
| POST | `.../runs/:runId/stop` · `rerun` · `review` · `rollback` · `open` | 停止 / 回退重跑 / 复核 / 回滚 / 打开产物目录 |
| DELETE | `.../runs/:runId` | 删除 Run |
| GET | `.../runs/:runId/tree` · `artifact?path=` | 产物树 / 读取单个产物 |

## 🧪 开发与测试

```bash
npm install
npm test        # node --test，覆盖 API / 流水线 / 各阶段执行器 / 连接 / 存储
```

| 模块 | 职责 |
| --- | --- |
| `index.js` | REST API + 驱动循环（node 半，随宿主同生共死） |
| `client.js` | 工作台 UI（web 半） |
| `lib/core/` | 流水线骨架：`pipeline.js` 状态机（`advance` / `applyReview`）、`stageConfig.js` 阶段能力表与委托任务包、`store.js` 目录规则与产物读写（唯一写盘点） |
| `lib/stages/` | `p1…p11` 11 个阶段执行器（输入契约 → 产物落盘） |
| `lib/infra/` | 运行设施：`llm.js` LLM 路由与契约解析、`connections.js` 托管连接与凭据脱敏、`repoState.js` 基线克隆与 per-Run worktree、`secretStore.js` / `relayAuth.js` / `patchEvidence.js` |
| `lib/delegate/` | 委外体系：`agents.js` 发现与测试门禁、`delegateVerify.js` 产物机器验证、`executors/`（claude-code / dsh-agent 执行器） |
| `lib/assistant.js` | 智能助手上下文聚合 |
| `tests/` | `unit/` 单测 · `stages/` 阶段执行器 · `integration/` API 与流水线装配 · `manual/` 人工演练（`e2e-live.mjs` 等不入 npm test） |

设计调研（端到端架构、Sub-Agent 取舍、缓存与记忆边界、评测指标）见 [issue2pr-research.html](./issue2pr-research.html)；工作台视觉方案见 [docs/design-taste.md](./docs/design-taste.md) 与 [design-demo.html](docs/design-demo.html)。

## 📌 当前边界

诚实清单——用之前先知道这些：

- 主仓库 `--depth 1` 浅克隆，当前按**单主仓库**工作（`repos[0]`）。
- P10 只做失败分类与建议动作，**不自动 replan**；重跑 / 回滚由人工在运行页触发。
- 测试命令自动探测只认 `package.json` 的 `test` 脚本，其他语言请显式配置 `testCommand`。
- `secrets/` fallback **不等于加密**，Windows 上连 ACL 收紧都不保证；请按备份 / 管理员权限 / 同机进程可读风险保护整个数据目录，不要提交进任何仓库。
- 产物在线预览上限 200KB，更大的文件请在产物目录直接打开。
- `claude` 委托在宿主进程内无人值守执行（默认 `acceptEdits` + 宽白名单），请按仓库敏感度自行评估。
- 中转 token 与 Git 凭据共用 SecretStore；API 会显示当前是系统 keychain 还是非加密文件回退。

## 🤝 贡献

欢迎 Issue 与 PR！约定：

- 外科手术式改动：只动必须动的地方，不顺手重构。
- 行为变更先补测试（`node --test`），再动实现。
- 阶段执行器保持「输入契约 → 产物落盘」形态，不在阶段内私设全局状态。
- 提交信息用中文，格式参照既有历史（`feat: / fix: / chore: …`）。

## 📄 许可证

[MIT](LICENSE) © LONGSASASASASA
