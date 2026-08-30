# CLAUDE.md

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.


> 本文件是 AI 编码助手在本项目的工作约束。所有生成的代码必须遵守。
> 完整规范见 [CODE_STYLE.md](./CODE_STYLE.md)，本文件为精简执行版。

## 代码风格

- S01. 缩进 4 空格，禁用 Tab；单行 ≤ 100 字符
- S02. 字符串用双引号；优先 f-string
- S03. 命名：模块/函数 `snake_case`，类 `PascalCase`，常量与环境变量 `UPPER_SNAKE_CASE`
- S04. Agent 节点函数命名 `verb_noun`（`extract_entity`、`route_intent`）
- S05. ❌ 禁止单字母变量（循环索引除外）、拼音命名、覆盖内置名（`list/id/type`）
- S06. ❌ 禁止保留注释掉的死代码
- S07. 注释解释"为什么"，代码本身回答"做什么"

## 类型注解

- T01. 使用 3.10+ 原生语法：`list[str]`、`dict[str, int]`、`X | None`；❌ 禁止 `List`、`Optional`
- T02. 公共 API、Agent 节点、Tool 函数、Pydantic 字段**必须**全量类型注解
- T03. 复杂返回结构必须用 Pydantic v2 / TypedDict / dataclass；❌ 禁止裸 `dict` 作为返回值
- T04. ❌ 避免 `Any`；必须使用时附 `# noqa: ANN401` + 注释说明原因与收敛计划
- T05. Pydantic 一律 v2 语法（`model_validate` / `model_dump` / `@field_validator`）

## 文档注释

- D01. 公共函数 / 类 / 模块**必须**有 Google Style docstring
- D02. docstring 必备段落：一句话摘要（注释推荐使用简体中文） + Args + Returns + Raises（有则写）
- D03. 私有函数仅在逻辑非显然时写 docstring

## 异常处理

- E01. 自定义异常必须继承项目基类 `AppError`，包含 `code` 字段
- E02. ❌ 禁止裸 `except` 与 `except Exception`（顶层兜底除外，且必须打日志）
- E03. ❌ 禁止用异常控制业务分支
- E04. 重新抛出必须用 `raise NewError(...) from e` 保留链路
- E05. 错误信息：中文描述 + 上下文（对象 ID / 阶段 / 关键参数），异常类名与 code 用英文

## 配置与密钥

- C01. 所有配置经 `config/settings.py` 的 Pydantic Settings 加载
- C02. ❌ 业务代码禁止直接 `os.getenv` / `os.environ`
- C03. ❌ 禁止硬编码 API Key、URL、模型名、提示词；提示词从 `prompts/` 加载
- C04. 新增依赖必须在回复中声明并说明用途，不得隐式引入

## 资源与异步

- R01. `httpx.AsyncClient` / LLM Client / DB / Redis / 向量库 Client **必须**应用级单例化
- R02. 文件、临时连接、子进程**必须**用 `with` / `async with`
- R03. 异步 IO 优先；❌ 禁止在 async 函数内调用阻塞 IO（`requests` / `time.sleep` / 同步 ORM），需要时用 `asyncio.to_thread`
- R04. 涉及时间统一使用 `datetime.now(UTC)`；❌ 禁止 naive datetime 与 `datetime.utcnow()`

## LLM / Agent 调用

- L01. 涉及 LLM / 外部 API 的调用必须包含：`timeout` + `retry`（指数退避 + jitter）+ 限速 + fallback + 幂等键
- L02. 仅对幂等请求 / 网络错误 / 5xx 重试，4xx 不重试
- L03. LLM 调用日志必须含：`trace_id`、`agent`、`model`、`prompt_version`、`token_input/output`、`latency_ms`、`status`
- L04. ❌ 禁止日志输出明文 API Key、token、用户身份证 / 手机号
- L05. 提示词模板存放 `prompts/<domain>/<name>.v<X.Y>.jinja`，通过 `PromptRegistry` 加载，禁止 `version="latest"` 上生产

## 测试要求

- TS01. 使用 pytest 原生 `assert`；❌ 禁用 unittest 风格
- TS02. 文件名 `test_<对象>.py`；函数名 `test_<目标>_<场景>_<期望>`
- TS03. AAA 模式（Arrange / Act / Assert，空行分隔）
- TS04. 外部 HTTP / LLM 调用**必须** mock（`respx` / `pytest-httpx`），E2E 例外并打 `@pytest.mark.e2e`
- TS05. 新增/变更代码 diff coverage **≥ 80%**；核心模块行覆盖 ≥ 80%，工具函数 ≥ 90%
- TS06. ❌ 禁止删除或注释已有测试用例以"通过"测试
- TS07. 新增业务逻辑必须同时生成对应测试

## 提交与 PR

- G01. Conventional Commits：`<type>(<scope>): <subject>`，subject 中文 ≤ 50 字
- G02. type: `feat | fix | refactor | docs | test | chore | perf | ci`
- G03. PR 描述必须含：变更动机、方案、影响面、测试说明、回滚方案
- G04. CI 必须全绿：`ruff check` + `ruff format --check` + `mypy --strict` + `pytest --cov` + `pip-audit` + 敏感信息扫描

## AI 协作约束

- A01. 修改既有函数**禁止**擅自变更签名；如需变更，必须列出全部调用点与影响
- A02. 多文件变更按文件路径分块输出，附变更概述、关键决策、潜在风险
- A03. 不确定的设计决策必须向用户确认，禁止臆测填补
- A04. 生成代码前先 grep 项目内是否已有同类实现，避免重复造轮子
- A05. 引用本文规则时使用编号（如"按 T03，应改为 Pydantic Model"）

## rg 在这个环境里被拒绝执行，换 PowerShell。

## UV 路径C:\Users\gang4.long\.local\bin\uv.exe

## 本地环境禁用 docker ，当涉及运行服务（测试验证；跑起来）若需要docker用到，与用户确认是否是指远程linux环境。