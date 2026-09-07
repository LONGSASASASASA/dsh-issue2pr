# 已确认问题记录

## 记录协议

- 批次：`BYYYYMMDD-NN`，同一天从 `01` 递增。
- 时间：`YYYY-MM-DD HH:mm:ss +08:00`。
- 问题编号：每个批次独立从 `ISSUE-001` 开始编号；编号仅在批次内唯一，跨批次引用使用 `批次 + ISSUE-NNN`。
- 状态：`已复现` / `已确认` / `待进一步复现` / `暂不修复` / `已修复` / `不处理`。
- 批次切换：只有用户明确允许后才能新建批次；未获允许时继续更新当前批次。
- 每条记录至少包含：状态、范围、现象、证据、修复方向。

---

## B20260905-01

时间：2026-09-05 18:09:27 +08:00

### ISSUE-001 超时后底层调用未真正取消

状态：已修复  
范围：LLM / 外部执行  
现象：外层超时可以返回失败，但底层 stream 或清理流程仍可能继续运行。  
证据：`lib/infra/llm.js` 使用外层超时竞争；`lib/delegate/executors/dsh-agent.js` 的执行和清理阶段缺少完整的可取消边界。  
修复方向：让超时与真实执行生命周期绑定，并向底层调用传播取消信号。
复测：LLM 超时后 `llm_stream_aborted=true`；DSH agent 在 `whenIdle()` 不响应取消时仍返回 `timeout`。

### ISSUE-002 P10 在 LLM 故障时无法可靠降级

状态：已修复  
范围：错误处理 / P10  
现象：认证或 API 调用失败后仍可能重试，P10 又调用同一故障 LLM，导致失败分析本身继续失败。  
证据：已出现认证失败后 P10 再次调用 LLM 的实际运行失败；`lib/stages/p10-failure.js` 当前先依赖 LLM 生成失败分析。  
修复方向：先落盘基础结构化失败报告，再把 LLM 分析作为可选增强；4xx 认证类错误不重试。
复测：认证失败只调用一次；P10 保留失败产物并降级为 `escalate`，组合回归通过。

### ISSUE-003 builtin P6 缺少 diff 校验和并发上限

状态：已修复  
范围：P6 / builtin coder  
现象：assignment 可一次性全部并发执行，模型返回内容在严格确认 unified diff 前就可能写入 `.diff`。  
证据：`lib/stages/p6-coder.js` 当前对 assignments 使用无上限并发，并直接处理模型返回文本。  
修复方向：增加并发上限；写入和计数前校验 unified diff 格式。
复测：4 个 assignment 最大并发为 2；非法 diff 被拒绝且未生成 `.diff` 文件。

### ISSUE-005 connections/test-repo 测试写死 Git config 槽位

状态：已修复  
范围：测试 / Git 托管连接  
现象：当进程环境已经存在 `GIT_CONFIG_COUNT` 时，认证配置会追加到后续槽位，但测试固定断言 `GIT_CONFIG_VALUE_0`，导致完整测试失败。  
证据：本地环境已有两个 `safe.directory` Git config 槽位，实际 Basic 认证正确写入 `GIT_CONFIG_VALUE_2`，测试仍读取 `_0`。  
修复方向：按测试真实目的查找 `GIT_CONFIG_VALUE_N` 中的 Basic 认证头，不假设固定槽位；继续验证凭据不进入 argv 且错误信息脱敏。

### ISSUE-006 P6 将任务完成错误等同于必须产出 patch

状态：已修复  
范围：P5 / P6 / P7 / Claude Code 外部执行  
现象：P5 可以规划纯分析、审计、验证节点，这类任务正常完成时可能没有代码修改；但 P6 外部执行契约要求每个节点都生成 `.diff`，导致正常的 no-change 节点被写成空 diff，随后被 P6 验证器判定失败，真实有效的代码修复也无法继续进入 P7。  
证据：运行 `20260905-200255-37` 中 T1-T4、T6 的输出契约均为报告、审计或验证结果，`coder-report.json` 明确标记这些节点“无代码变更（空补丁）”，仅 T5 生成 528 字节真实 patch；再次调用当前 `verifyDelegateResult(..., "P6")` 稳定返回 `ok: false`，错误正是 `0001/0002/0003/0004/0006` 五个 diff 内容为空。  
判断：必须修复；只要 TaskGraph 同时包含 no-change 节点和真实修改节点，当前契约就可能确定性地产生假失败，不属于偶发执行异常。  
修复方向：最小修改 P6 外部产物协议，用结构化任务结果区分 `patched` / `no_change` / `failed`；只有 `patched` 必须声明 patch，并继续执行现有非空、unified diff、`git apply` 严格校验；`no_change` 不生成空 diff，但必须记录原因；P6 按任务结果统计完成进度，P7 只消费真实 patch。禁止直接放宽为空 diff 也通过。
复测：`no_change` 无 patch + `patched` 有真实 diff 可通过；缺少 no_change 原因、缺少任务结果或出现 `failed` 均被拦截；针对性测试 21/21、全量测试 216/216 通过。

---

## B20260905-02

时间：2026-09-05 18:36:04 +08:00

### ISSUE-001 P6 完成任务后 review / 修补 / 全链重验缺少停止边界

状态：暂不修复  
范围：P6 / Claude Code 外部执行  
现象：TaskGraph 已显示 `7/7` 后，外部执行仍继续 review、修改已完成 patch 并重新跑全链验证；验证型 T7 原本可无代码 diff，但又为了避免空 patch 被额外转成仓库内验证报告，进一步延长 P6。  
证据：本次运行约 18:24 已完成 T1-T7 产物；之后日志出现 `Review patches 0001-0004`、`Review patches 0005-0007`。18:38 后又重新生成 `0002-T2.diff`、`0005-T5.diff`、`0006-T6.diff`；18:40 将原空的 `0007-T7.diff` 改为新增 `docs/verification-report.md`，随后重新应用 `0001`→`0007` 并执行 `npm test`、publish smoke、browser bundle；18:41 `run.json` 仍为 P6 / running 且日志持续增长。  
判断：当前不是卡死，review 确实发现并修补了问题；但 `7/7` 不能表示 P6 即将结束，最终 review / 修补 / 重验没有清晰的轮次或收敛边界，同时“每个任务都要有 patch”会诱导验证型任务产生非必要仓库改动。  
修复方向：后续为 `7/7` 后增加明确的“最终审查”状态；限制 review / fix 轮次或定义收敛条件；允许验证型任务只产出验证 artifact 而不强制生成 diff；最后一次修改后至多执行一次必要的全链验证。

### ISSUE-002 P11 Gate 任一项 fail 时内置路径仍返回成功

状态：暂不修复  
范围：P11 / builtin Gate  
现象：P11 的六项 Gate 已写入 `11-eval-report.json`，但即使 `ROOT/PATCH/TEST/DIFF/DESC/ACCEPT` 中存在 `fail`，阶段仍返回成功。  
证据：二次复现中 patch 证据合法、`ACCEPT: "fail"`，P11 仍返回 `PR 说明 + Gate 评测完成`，且未抛出错误。  
修复方向：落盘评测结果后检查六项 Gate，任一项不是 `pass` 时让 P11 门控失败。

### ISSUE-003 P9 Reviewer 按字符截断 diff 导致后续 hunk 不可见

状态：暂不修复  
范围：P9 / Reviewer  
现象：每份 diff 默认只读取前 `1200` 字，位于中部或尾部的修改可能完全不进入 Reviewer prompt。  
证据：3040 字复现 diff 中仅头部标记可见，中部和尾部均不可见；改成简单“头部 + 尾部”后，中部标记仍然不可见。  
修复方向：保持总输入预算，按 unified diff 的 `@@ ... @@` hunk 做预算内采样，使头、中、尾 hunk 都获得审查覆盖。
