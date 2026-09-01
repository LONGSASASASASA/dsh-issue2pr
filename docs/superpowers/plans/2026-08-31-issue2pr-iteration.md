# Issue2PR 工作台与可靠性加固实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (\`- [ ]\`) syntax for tracking.

**Goal:** 按已确认的顺序完成工作台视觉落地、Run 可靠性修复、回滚与重试边界、安全存储和路由/哈希契约修复，并保持现有 API 与流水线语义兼容。

**Architecture:** 先在现有 client.js 上做命名空间内的视觉演进，保留所有数据绑定和事件处理。服务端修复优先抽取小型、可单测的边界：原子产物写入、驱动异常兜底、ledger 状态、秘密存储和 patch 指纹；不引入新的业务框架。

**Tech Stack:** Node.js 18+ ESM、原生 node:test、React 运行时（由 DSH 宿主注入）、原生 CSS、Git 子进程。

**Spec:** docs/design-taste.md、docs/review-deep-issues.md

## Global Constraints

- 保持现有 REST 路径、字段名、阶段 ID、产物路径和复核语义不变。
- UI 视觉遵循暖灰瓷面、单一绿色强调色、3px 圆角、低动效和高信息密度令牌。
- C2 分两层：先尝试系统 keychain；不可用时使用无新增依赖的权限收紧 fallback。fallback 始终是非加密存储，权限硬化不得标记为“已安全”。
- 新增业务逻辑必须先有失败测试；外部 Git/网络调用在测试中使用现有注入钩子或临时仓库。
- 不使用 Docker，不新增未确认的生产依赖。

---

### Task 1: 工作台视觉落地

**Files:**
- Modify: client.js
- Test: tests/manual/preview.mjs, tests/manual/smoke.mjs（必要时只补断言，不改变 API 流程）
- Check: docs/design-taste.md

**Interfaces:** 保留现有 WorkbenchPage、页面导航、Run/Artifact/Config 数据绑定和 DOM 可访问性属性；只改变令牌、布局和展示结构。

- [x] 审计现有 CSS/组件并记录需要保留的交互。
- [x] 引入定稿令牌、明暗主题和 3px 形状体系。
- [x] 依次重排项目、运行、产物、配置、说明页面。
- [x] 保留树目录 aria-expanded/aria-controls、焦点样式、空/加载/错误态。
- [x] 用 Playwright 在 1257x1320、880x1000 和窄屏检查无溢出、无 Console 错误。
- [x] 运行现有 UI smoke 与 npm test。

### Task 2: B1 驱动与产物写入可靠性

**Files:**
- Modify: lib/core/store.js, index.js
- Test: tests/unit/store.test.js, tests/integration/api.test.js

**Interfaces:** writeArtifact(runDir, rel, content) 签名不变；drive 失败必须留下可查询的 failed Run 和日志。

- [x] 写出半截写入和 drive rejection 的失败测试。
- [x] 实现唯一临时文件、写后替换和清理；保留路径穿越校验。
- [x] 在 drive 顶层记录错误并调用 failRun 兜底，避免锁链吞错。
- [x] 验证 malformed run.json、P10 失败和 stop/delete 竞态不产生静默 running。

### Task 3: B2/B3 回滚与重试边界

**Files:**
- Modify: lib/stages/p7-patch.js, lib/core/pipeline.js, index.js
- Test: tests/stages/stages-p7-p8-p10.test.js, tests/unit/pipeline.test.js, tests/integration/api.test.js

**Interfaces:** rollbackLedger 仍接受现有参数；ledger 新字段向后兼容旧行；复核上限错误可由 API/UI 展示。

- [x] 添加重复回滚、已变更工作区和超限打回的失败测试。
- [x] 回滚前执行 git apply -R --check，成功后记录状态，重复请求幂等。
- [x] 增加默认且可配置的最大复核尝试次数，超过后转 failed/P10。
- [x] 回归已有 patch apply、rollback 和 reject 行为。

### Task 4: C1/C2/C3 凭据与证据链

**Files:**
- Create: lib/infra/secretStore.js
- Modify: lib/infra/connections.js, lib/infra/relayAuth.js, index.js, lib/stages/p7-patch.js, lib/stages/p11-pr-builder.js, README.md
- Test: tests/unit/secret-store.test.js, tests/unit/connections.test.js, tests/unit/relay-auth.test.js, tests/stages/stages-p7-p8-p10.test.js, tests/stages/stages-p9-p11.test.js

**Interfaces:** 现有 connections/relay API 保持不变；SecretStore 内部先支持权限硬化和可插拔 keychain，不能把 token 返回给 UI。

- [x] 先写出 argv 不含 token、文件权限/迁移、patch hash 和实际 diff 校验的失败测试。
- [x] Git clone/ls-remote 改为 askpass/credential helper 或 header 注入，避免 URL argv 泄露。
- [x] 实现无依赖权限硬化；JSON 只作为明确标记的 fallback，不宣称加密。
- [x] 增加 keychain-first 适配边界和旧明文迁移路径；无可用 keychain 时显式降级。
- [x] ledger 记录每个 diff 的 SHA-256，P11 校验实际仓库变更与已应用 patch 一致。
- [x] 验证日志、错误和 API 响应无明文 token。

### Task 5: D3/D4 与最终验证

**Files:**
- Modify: lib/infra/llm.js, lib/stages/p7-patch.js, docs/review-deep-issues.md
- Test: tests/unit/llm.test.js, tests/stages/stages-p7-p8-p10.test.js

- [x] 写出部分路由覆盖和 git hash 失败的失败测试。
- [x] 部分 provider/model 覆盖显式报错，不再静默回落。
- [x] hash 失败使用明确错误/null 契约，禁止 'nogit' 混入真实 hash 字段。
- [x] 跑 npm test（209/209）、git diff --check、`npm pack --dry-run`；另补 P7 批次重跑回归（P9/P11 定向 10/10）。
- [x] 更新审查报告状态和剩余已知取舍；不创建未经确认的发布 tag。
