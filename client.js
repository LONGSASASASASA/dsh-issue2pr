// client.js — Issue2PR 工作台（项目 / 任务 / 全局设置）
// 设计语言：沿用 v9 明暗配色，主题选择跟随 DSH 宿主，
// 数据（id/路径/产物/耗时）用 JetBrains Mono，图标全 SVG 描边（无 emoji），
// 页面结构与交互以 docs/ui-prototype/v9.html 为基准。数据源 /issue2pr/api/*。
// 零 npm 依赖：React 与官方 UI 原语（MarkdownText 等）均来自宿主模块表（require），样式注入单个 <style> 标签。
window.__ModuleLoader__.load({
	id: "dsh-issue2pr",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const React = require("react");
		const { MarkdownText } = require("@deepseek-ai/dsh-client-ui-primitives");
		const h = React.createElement;
		const zh = { nav: "Issue2PR" };
		const en = { nav: "Issue2PR" };
		const API = "/issue2pr/api";

		// ---------- 常量：11 阶段（与 lib/core/pipeline.js STAGES 对齐；P10 为失败旁路，不在 MAIN_FLOW） ----------
		// about：阶段职责说明（「运行」页阶段详情·说明 tab 展示；输入 → 做什么 → 输出 → 何时介入）
		const STAGES = [
			{ id: "P1",  name: "IssueAnalyzer",      desc: "Issue → 结构化契约",            art: "01-issue-analysis.json",    key: false,
			  about: "把触发源原文（需求文档或 Issue）提炼为机器可读的结构化契约：现象、触发条件、影响模块、可验证成功标准、约束与风险等级。后续所有阶段都以该契约为源头，跑偏多因 P1 契约含糊——打回时优先补「成功标准」。" },
			{ id: "P2",  name: "Search Layer",       desc: "候选文件 + 证据",                art: "02-search-candidates.json", key: false,
			  about: "扫描仓库文件清单，结合 P1 契约选出候选修改文件，每条附选择理由（SearchEvidence）与置信度，另列测试候选与待探索项。仓库过大时受「扫描上限」参数约束；候选质量直接决定 P3 的理解深度。" },
			{ id: "P3",  name: "Code Understanding", desc: "调用链与修改点",                 art: "03-code-understanding.md",  key: false,
			  about: "按 P2 候选置信度取前 N 个文件读真实源码，分析关键函数、调用方与潜在修改点，产出中文理解报告。报告是假设与规划的依据；「深读文件数」「单文件读取上限」两个参数控制上下文规模。" },
			{ id: "P4",  name: "Hypothesis",         desc: "可验证根因假设",                 art: "04-hypotheses.json",        key: false,
			  about: "把 P3 报告转为可验证的根因假设：每条必须携带证据、验证文件与验证方法，禁止「我看着像」式结论。多假设并存时由 P5 规划验证顺序。" },
			{ id: "P5",  name: "Planner",            desc: "TaskGraph 规划 · 复核门",        art: "05-task-graph.json",        key: true,
			  about: "把修复任务拆成有依赖关系的 TaskGraph：每节点有输入产物、输出产物、成功标准与风险，并指定复核门与 PR 门。这是第一个关键复核门——规划错了后面全白跑，建议人工核对节点拆分与依赖。" },
			{ id: "P6",  name: "代码优化",            desc: "多智能体协同 · 复核门",          art: "06-implementation/",        key: true,
			  about: "按 TaskGraph 实施代码修改：内置模式为 Planner 派单 → 并行 Coder（TDD/最小 diff）→ Reviewer 门控；也可委托外部会话或 Claude Code CLI（执行模式三选一）。产物为逐节点 unified diff + coder-report，P7 落盘前不碰你的仓库。" },
			{ id: "P7",  name: "Patch Pipeline",     desc: "版本校验 → 落盘 + ledger",       art: "ledger/patch-ledger.jsonl", key: false,
			  about: "确定性 patch 应用管线（不调用大模型）：校验基线版本 → 逐条 git apply 落盘 → 写 patch ledger。每条 patch 可在运行页逐条回滚；基线不匹配会拒绝应用，防止盲覆盖。" },
			{ id: "P8",  name: "TestRunner",         desc: "沙箱真实执行",                   art: "07-test-report.json",       key: false,
			  about: "在仓库真实执行任务启动配置中的测试命令，留空自动探测 npm test。完整输出落盘 08-test-output.txt，报告只留末尾。结果必须来自真实执行。" },
			{ id: "P9",  name: "Reviewer",           desc: "三维门控审查 · 复核门",          art: "08-review-report.json",     key: true,
			  about: "独立 Reviewer 读真实 diff 与测试报告做三维门控：①Diff 范围（过大/越权/遗漏调用方）②API 与安全 ③测试补强与说明忠实。测试通过 ≠ 可合并；verdict=fail 会打回 P6。" },
			{ id: "P10", name: "FailureClassifier",  desc: "失败旁路 · 仅失败时执行",        art: "09-failure-analysis.json",  key: false, bypass: true,
			  about: "失败旁路（仅在任一阶段失败时执行）：把失败归入六类——实现错误/根因错误/测试选择/环境缺失/权限被拒/反复失败，并给出处理路径（replan/rollback/escalate）。分类决定重跑策略，避免盲目重试。" },
			{ id: "P11", name: "PRBuilder + Eval",   desc: "PR 说明 + Gate 评测 · 复核门",   art: "10-pr-description.md",      key: true,
			  about: "双角色收尾：PR 说明忠实反映修改与验证过程（背景/根因/修改点/验证证据/风险，禁止夸大）；Gate 按六项判定——ROOT 根因有证据 / PATCH 干净应用 / TEST 无回归 / DIFF 可审查 / DESC 说明忠实 / ACCEPT 门控通过。全部 pass 才算交付。" },
		];

		// 状态 → tag 样式（映射宿主语义状态色：成功/警告/错误/进行中）
		const TAG = {
			approved:        ["t-good", "已通过"],
			awaiting_review: ["t-warn", "待复核"],
			running:         ["t-acc",  "运行中"],
			failed:          ["t-err",  "失败"],
			stopped:         ["t-off",  "已停止"],
			pending:         ["t-off",  "未开始"],
			completed:       ["t-good", "已完成"],
		};
		function tag(status) { return TAG[status] || TAG.pending; }

		/* ================================================================
		 * 样式（工作台 .studio 作用域；v9 配色，主题选择及字体跟随宿主）
		 * ================================================================ */
		const css = `
/* v9 palette: exact prototype values; aliases keep existing official controls compatible. */
.i2p,.i2p-page{
 --bg:#f6f7f9;--surface:#ffffff;--soft:#f3f5f7;--ink:#1c2833;--secondary:#596875;--muted:#72808a;
 --line:#e7ebed;--border:#d7dfe2;--accent:#177b62;--accent-hover:#10624e;--accent-soft:#eaf4ef;
 --amber:#986318;--amber-soft:#fbf3e4;--red:#bb4346;--red-soft:#fcf0f0;--blue:#426b9c;--blue-soft:#edf3fb;
 --terminal:#18232b;--term-text:#d6e4e9;--shadow:0 16px 64px #18232b1f;
 --ink-2:var(--secondary);--caption:var(--muted);--shell:var(--bg);--porcelain:var(--bg);
 --porcelain-strong:var(--surface);--line-2:var(--border);--card:var(--surface);--panel:var(--surface);
 --accent-strong:var(--accent-hover);--accent-ink:#fff;--hover:var(--soft);--nav-on:var(--accent-soft);--acc-soft:var(--accent-soft);
 --good:var(--accent);--good-bg:var(--accent-soft);--warn:var(--amber);--warn-bg:var(--amber-soft);
 --err:var(--red);--err-bg:var(--red-soft);--code-bg:var(--terminal);--code-line:var(--border);
 --mono:var(--ds-font-family-code,"SF Mono","JetBrains Mono","Fira Code",Consolas,"Liberation Mono",Menlo,Courier,"PingFang SC","Microsoft YaHei");
 font-family:var(--dsw-font-family,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei","Helvetica Neue",Helvetica,Arial,sans-serif);
 font-size:var(--dsh-content-font-size,14px);line-height:calc(24px + var(--dsh-content-font-size,14px) - 14px);background:var(--bg);
}
[data-i2p-theme=dark] .i2p,[data-i2p-theme=dark] .i2p-page{
 --bg:#141b20;--surface:#1a2329;--soft:#222e35;--ink:#e5edf0;--secondary:#b6c3ca;--muted:#94a5af;
 --line:#2a373f;--border:#41515b;--accent:#79cbb0;--accent-hover:#a2e1ca;--accent-soft:#203c34;
 --amber:#e8bd76;--amber-soft:#383023;--red:#f09598;--red-soft:#3c272d;--blue:#97bbed;--blue-soft:#26374b;
 --terminal:#111a21;--shadow:0 16px 64px #0005;--accent-ink:#10291f;
 --ink-2:var(--secondary);--caption:var(--muted);--shell:var(--bg);--porcelain:var(--bg);
 --porcelain-strong:var(--surface);--line-2:var(--border);--card:var(--surface);--panel:var(--surface);
 --accent-strong:var(--accent-hover);--hover:var(--soft);--nav-on:var(--accent-soft);--acc-soft:var(--accent-soft);
 --good:var(--accent);--good-bg:var(--accent-soft);--warn:var(--amber);--warn-bg:var(--amber-soft);
 --err:var(--red);--err-bg:var(--red-soft);
}
/* v9 component styles. Host chrome and the assistant keep their own selectors. */
.i2p,.i2p-page{color:var(--ink);flex:1;min-width:0;min-height:0;display:flex;flex-direction:column;--fs-xs:12px;--fs-sm:13px;--fs-md:14px;--fs-lg:15px}
.i2p-page{position:fixed;overflow:hidden;background:var(--surface)}
.i2p-page-body{display:flex;flex:1;min-width:0;min-height:0}
.i2p-page-hint{margin:10px 26px 0;padding:8px 12px;border:1px solid var(--line);border-left:3px solid var(--amber);border-radius:7px;background:var(--amber-soft);color:var(--amber);font-size:12px;overflow-wrap:anywhere}
.studio{container-type:inline-size}
.studio *{box-sizing:border-box}
.studio :where(button,input,select,textarea){font:inherit;color:inherit}
.studio :where(button){cursor:pointer;border:0;background:none}
.studio :where(button):disabled{opacity:.5;cursor:not-allowed}
.studio :where(a){color:var(--accent);text-decoration:none}
.studio :where(a):hover{text-decoration:underline}
.studio :focus-visible{outline:2px solid var(--accent);outline-offset:3px}
.studio :where(h1,h2,h3,h4,p){margin:0}
.studio h1{font-size:21px;line-height:30px;font-weight:700}
.studio h2{font-size:16px;line-height:24px;font-weight:500}
.studio h3,.studio h4{font-size:14px;line-height:22px;font-weight:500}
.studio :where(code,pre,.mono){font-family:var(--mono)}
.studio svg{flex:none;vertical-align:middle}
.studio .hint,.studio small{font-size:12px;color:var(--secondary)}
.studio .muted{color:var(--muted)}
.studio .studio-row{display:flex;align-items:center;gap:10px;min-width:0}
.studio .wrap{flex-wrap:wrap}
.studio .studio-grow{flex:1;min-width:0}
.studio .studio-path{overflow-wrap:anywhere}
.studio .studio-stack{display:grid;gap:16px;align-content:start;min-width:0}
.studio .studio-grid,.studio .grid-2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px}
.studio .studio-span{grid-column:1/-1}
.studio .btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;min-height:36px;padding:6px 13px;border:1px solid var(--border);background:var(--surface);border-radius:7px;font-size:14px;line-height:22px;font-weight:500;white-space:nowrap}
.studio .btn:hover{background:var(--soft)}
.studio .btn.pri{background:var(--accent);border-color:var(--accent);color:var(--accent-ink)}
.studio .btn.pri:hover{background:var(--accent-hover)}
.studio .btn.ghost{background:transparent;border-color:transparent}
.studio .btn.ghost:hover{background:var(--soft)}
.studio .btn.sm{min-height:30px;padding:3px 9px;font-size:12px;line-height:18px}
.studio .btn.danger{color:var(--red)}
.studio .card{border:1px solid var(--line);border-radius:9px;padding:20px;background:var(--surface);min-width:0}
.studio .tg{display:inline-flex;align-items:center;gap:6px;border-radius:5px;padding:3px 9px;font-size:12px;font-weight:500;line-height:24px;white-space:nowrap;color:var(--secondary);background:var(--soft)}
.studio .tg:before{content:"";height:6px;width:6px;border-radius:50%;background:currentColor}
.studio .tg.t-good{color:var(--accent);background:var(--accent-soft)}
.studio .tg.t-warn{color:var(--amber);background:var(--amber-soft)}
.studio .tg.t-err{color:var(--red);background:var(--red-soft)}
.studio .tg.t-acc{color:var(--blue);background:var(--blue-soft)}
.studio .f-input,.studio .f-select{width:100%;min-width:0;max-width:100%;min-height:40px;padding:8px 11px;border:1px solid var(--border);border-radius:7px;background:var(--surface);color:var(--ink);font-size:14px;line-height:22px}
.studio .f-input::placeholder{color:var(--muted)}
.studio textarea{resize:vertical}
.studio .studio-field,.studio label.field{display:flex;flex-direction:column;gap:7px;font-weight:500;min-width:0}
.studio .studio-field small{font-weight:400}
.studio .field{margin:0 0 13px}
.studio .f-label{display:block;font-size:12px;color:var(--secondary);margin:12px 0 6px}
.studio .callout{padding:13px 16px;border:1px solid var(--line);border-radius:8px;background:var(--blue-soft);color:var(--blue);font-size:13px;overflow-wrap:anywhere}
.studio .callout p{margin:5px 0}
.studio .callout.warn{background:var(--amber-soft);color:var(--amber)}
.studio .callout.err{background:var(--red-soft);color:var(--red)}
.studio .callout.good,.studio .callout.acc{background:var(--accent-soft);color:var(--accent)}
.studio .tbl{width:100%;border-collapse:collapse;font-size:13px;margin:12px 0}
.studio .tbl th,.studio .tbl td{text-align:left;padding:8px;border-bottom:1px solid var(--line);overflow-wrap:anywhere}
.studio .tbl th{font-size:12px;color:var(--secondary);font-weight:500}
.studio .kv{display:grid;grid-template-columns:120px minmax(0,1fr);gap:7px 14px;font-size:13px}
.studio .kv .k{color:var(--muted)}
.studio .kv .v{min-width:0;overflow-wrap:anywhere}
.studio .view{margin:0;padding:17px;background:var(--bg);color:var(--ink);border:0;border-radius:8px;font:13px/1.85 var(--mono);white-space:pre-wrap;overflow-wrap:anywhere;overflow:auto;max-height:65vh}
.studio .view .k,.studio .view .hunk{color:var(--blue)}
.studio .view .s,.studio .view .add{color:var(--accent)}
.studio .view .c{color:var(--muted)}
.studio .view .del{color:var(--red)}
.studio .view .ln{display:inline-block;min-width:3em;margin-right:14px;text-align:right;color:var(--muted);user-select:none;-webkit-user-select:none}
.studio .md-view{overflow-wrap:anywhere;min-width:0}
.studio .md-view :where(p,ul,ol){margin:10px 0 19px}
.studio .md-view :where(h1,h2,h3){margin:22px 0 12px}
.studio .md-view pre{overflow:auto;max-width:100%}
.studio .studio-topbar{height:52px;flex:none;display:flex;align-items:center;padding:0 28px;gap:26px;background:var(--surface);border-bottom:1px solid var(--line)}
.studio .studio-brand{display:flex;align-items:center;gap:10px;font-size:18px;font-weight:700;letter-spacing:-.7px}
.studio .studio-brand svg{color:var(--accent)}
.studio .studio-topnav{display:flex;align-self:stretch;gap:24px;margin-left:12px}
.studio .studio-topnav button,.studio .studio-tabs button{border:0;border-bottom:2px solid transparent;background:none;color:var(--secondary);padding:0 3px;font-size:14px}
.studio .studio-topnav button.on{color:var(--ink);font-weight:600;border-bottom-color:var(--accent)}
.studio .studio-toptools{margin-left:auto}
.studio .studio-main{flex:1;min-height:0;display:flex;flex-direction:column;overflow:auto}
.studio .studio-page{padding:30px 32px;max-width:1144px;width:100%;margin:0 auto}
.studio .studio-page-heading{margin-bottom:26px}
.studio .studio-page-heading p{font-size:14px;color:var(--secondary);margin-top:5px}
.studio .studio-project-card{padding:24px;border-radius:12px}
.studio .studio-repo-logo{width:43px;height:43px;background:var(--accent-soft);color:var(--accent);border-radius:10px;display:grid;place-items:center;flex:none}
.studio .studio-repo-address{margin:16px 0 22px;font-size:13px;color:var(--secondary);overflow-wrap:anywhere}
.studio .studio-project-foot{border-top:1px solid var(--line);padding-top:17px}
.studio .studio-project-more{margin-top:24px}
.studio .studio-toolbar{display:flex;align-items:center;gap:15px;margin-bottom:20px;flex-wrap:wrap}
.studio .studio-project-filter{display:flex;align-items:center;gap:8px;white-space:nowrap;font-size:14px}
.studio .studio-project-filter .f-select{width:215px}
.studio .studio-search{width:270px;max-width:100%;min-width:130px}
.studio .studio-segmented{display:flex;align-items:center;background:var(--soft);padding:3px;border-radius:7px;gap:3px;flex-wrap:wrap}
.studio .studio-segmented button{background:none;border:0;padding:6px 12px;color:var(--secondary);border-radius:5px;font-size:13px}
.studio .studio-segmented button.on{background:var(--surface);color:var(--ink);box-shadow:0 1px 3px #18232b12}
.studio .studio-filter-result{margin:-8px 0 16px;color:var(--secondary);font-size:12px}
.studio .studio-task-list{border:1px solid var(--line);border-radius:11px;background:var(--surface);overflow:hidden}
.studio .studio-run-row{display:grid;grid-template-columns:30px minmax(0,1fr) auto 60px;gap:15px;align-items:center;padding:16px 20px;border-bottom:1px solid var(--line);text-align:left;width:100%;color:var(--ink)}
.studio .studio-run-row:hover{background:var(--bg)}
.studio .studio-run-row:last-child{border-bottom:0}
.studio .studio-run-row strong{display:block;font-weight:500;overflow-wrap:anywhere}
.studio .studio-run-description{display:block;margin-top:4px;color:var(--secondary);font-size:12px;overflow-wrap:anywhere}
.studio .studio-run-reason{display:block;margin-top:4px;color:var(--secondary);font-size:13px;overflow-wrap:anywhere}
.studio .studio-run-icon{color:var(--accent)}
.studio .studio-run-icon.failed{color:var(--red)}
.studio .studio-run-icon.awaiting_review{color:var(--amber)}
.studio .studio-pagination{padding:12px 0;font-size:12px}
.studio .studio-empty{padding:55px 22px;text-align:center;max-width:570px;margin:0 auto;color:var(--secondary);display:grid;justify-items:center;gap:14px}
.studio .studio-empty h3{font-size:16px;color:var(--ink)}
.studio .studio-dialog{width:min(560px,calc(100vw - 32px));max-height:calc(100dvh - 48px);border:1px solid var(--line);border-radius:14px;padding:0;background:var(--surface);color:var(--ink);box-shadow:var(--shadow)}
.studio .studio-dialog.wide{width:min(850px,calc(100vw - 32px))}
.studio .studio-dialog::backdrop{background:#14232e55;backdrop-filter:blur(3px)}
.studio .studio-dialog-head{padding:20px 24px 12px}
.studio .studio-dialog-body{padding:8px 24px 24px;overflow-wrap:anywhere}
.studio .studio-dialog-body>p{color:var(--secondary);margin-bottom:17px}
.studio .studio-task{display:flex;flex-direction:column;flex:1;min-height:0;background:var(--surface)}
.studio .studio-task-head{padding:8px 26px 5px;flex:none}
.studio .studio-breadcrumb{font-size:12px;color:var(--muted);margin-bottom:4px;line-height:18px;flex-wrap:wrap}
.studio .studio-breadcrumb button{padding:0;color:var(--secondary)}
.studio .studio-breadcrumb .mono{max-width:170px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.studio .studio-task-title{gap:12px}
.studio .studio-task-title h1{font-size:16px;line-height:24px;font-weight:600}
.studio .studio-topology{padding:0 26px;border-bottom:1px solid var(--line);flex:none}
.studio .studio-workflow-summary{min-height:44px;gap:12px}
.studio .studio-workflow-summary strong{font-size:13px}
.studio .studio-progress{display:flex;gap:3px;width:110px;flex:none}
.studio .studio-progress i{height:4px;flex:1;border-radius:2px;background:var(--border)}
.studio .studio-progress i.done{background:var(--accent)}
.studio .studio-progress i.current{background:var(--blue)}
.studio .studio-progress i.failed{background:var(--red)}
.studio .studio-track{display:grid;grid-template-columns:repeat(10,minmax(0,1fr));gap:4px;padding-top:8px}
.studio .studio-stage{border:1px solid transparent;border-radius:7px;padding:8px 2px;display:flex;align-items:center;flex-direction:column;position:relative;min-width:0}
/* 二期 S4：节点连线加粗并按阶段状态着色（原先 1px var(--line) 对比约 1.2:1 近不可见） */
.studio .studio-stage:before{content:"";position:absolute;top:20px;right:50%;width:100%;height:2px;background:var(--border);border-radius:1px}
.studio .studio-stage.approved:before,.studio .studio-stage.completed:before{background:var(--accent)}
.studio .studio-stage.current:before{background:var(--blue)}
.studio .studio-stage.failed:before{background:var(--red)}
.studio .studio-stage.awaiting_review:before{background:var(--amber)}
.studio .studio-stage:first-child:before{display:none}
.studio .studio-stage:hover{background:var(--soft)}
.studio .studio-stage.on{background:var(--soft);border-color:var(--border)}
.studio .studio-stage-mark{width:27px;height:27px;display:grid;place-items:center;border:1px solid var(--border);background:var(--surface);border-radius:50%;position:relative;z-index:1;margin-bottom:7px;font-size:11px}
.studio .studio-stage.approved .studio-stage-mark,.studio .studio-stage.completed .studio-stage-mark{background:var(--accent-soft);color:var(--accent);border-color:transparent}
.studio .studio-stage.current .studio-stage-mark{background:var(--blue-soft);color:var(--blue);border-color:transparent}
.studio .studio-stage.failed .studio-stage-mark{background:var(--red-soft);color:var(--red)}
.studio .studio-stage.awaiting_review .studio-stage-mark{background:var(--amber-soft);color:var(--amber)}
.studio .studio-stage strong{font-size:13px;font-weight:400;line-height:1.5}
.studio .studio-stage-code{font-size:12px;color:var(--muted);margin-top:3px}
.studio .studio-track-footer{justify-content:space-between;font-size:12px;min-height:31px;color:var(--secondary)}
.studio .studio-return-lane{margin:0 0 8px;padding:5px 10px;border-radius:7px;background:var(--amber-soft);color:var(--amber);font-size:12px}
.studio .studio-tabs{display:flex;gap:24px;padding:0 26px;height:43px;border-bottom:1px solid var(--line);flex:none}
.studio .studio-tabs button{padding:0 1px}
.studio .studio-tabs button.on{color:var(--accent);border-bottom-color:var(--accent)}
.studio .studio-runtime-meta{padding:8px 26px 0;font-size:12px;flex:none}
.studio .studio-workspace{overflow:auto;min-height:0;flex:1;scrollbar-gutter:stable}
.studio .studio-process{padding:16px 26px;display:grid;grid-template-columns:minmax(0,1fr);gap:24px;align-items:start}
.studio .studio-process-main{min-width:0}
.studio .studio-section-heading{margin-bottom:14px}
.studio .studio-section-heading p{margin-top:3px;font-size:13px;color:var(--secondary)}
.studio .studio-stage-deliverables{margin-top:20px;padding-top:12px;border-top:1px solid var(--line)}
.studio summary{cursor:pointer;color:var(--secondary);font-size:12px}
.studio .studio-stage-deliverables>summary{font-size:13px;font-weight:600;margin-bottom:12px}
.studio .studio-artifacts{display:grid;gap:12px;justify-items:start}
.studio .studio-artifacts-group{display:grid;gap:2px;justify-items:start}
.studio .studio-artifacts-dir{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--muted)}
.studio .studio-artifacts .btn{justify-content:flex-start;text-align:left;white-space:normal;overflow-wrap:anywhere}
.studio .studio-execution-row{display:grid;grid-template-columns:120px minmax(0,1fr) auto 18px;gap:15px;padding:12px 10px;border-bottom:1px solid var(--line);text-align:left;width:100%;align-items:center}
.studio .studio-execution-row:hover{background:var(--soft)}
.studio .studio-execution-row strong{font-size:14px;font-weight:500}
.studio .studio-execution-row span{overflow-wrap:anywhere}
.studio .studio-execution-head{padding-bottom:10px;border-bottom:1px solid var(--line)}
.studio .studio-execution-head .studio-execution-tabs{margin:0 0 0 auto;border:0}
.studio .studio-plan-item{display:grid;grid-template-columns:30px minmax(0,1fr);gap:12px;padding:20px 0;border-bottom:1px solid var(--line)}
.studio .studio-plan-item>span{padding-top:2px}
.studio .studio-plan-item h3{font-size:15px;margin:0 0 8px;font-weight:500}
.studio .studio-plan-item p{margin:0 0 10px;color:var(--secondary);line-height:1.7}
.studio .studio-plan-tags{display:flex;flex-wrap:wrap;gap:7px;color:var(--secondary);font-size:12px}
.studio .studio-plan-tags>span{border:1px solid var(--line);border-radius:4px;padding:1px 7px;overflow-wrap:anywhere}
.studio .studio-execution-filters{display:flex;align-items:center;gap:16px;flex-wrap:wrap}
.studio .studio-execution-filters>.f-input{width:220px;margin-left:auto}
.studio .studio-execution-row small{display:block;margin-top:4px;font-size:11px;color:var(--muted)}
.studio .studio-execution-tabs{display:flex;gap:10px;border-bottom:1px solid var(--line);margin:8px 0 14px}
.studio .studio-execution-tabs button{padding:6px 10px;font-size:13px;color:var(--secondary)}
.studio .studio-execution-tabs button.on{box-shadow:inset 0 -2px var(--accent);background:var(--soft);color:var(--ink)}
.studio .studio-terminal-shell{background:var(--terminal);color:var(--term-text);border-radius:9px;overflow:hidden}
.studio .studio-terminal-head{min-height:36px;padding:3px 12px;border-bottom:1px solid #ffffff14;font-size:12px}
.studio .studio-terminal-tools{padding:7px 14px;border-bottom:1px solid #ffffff14;font-size:12px;gap:10px}
.studio .studio-terminal-tools input{background:#ffffff08;color:var(--term-text);border:1px solid #ffffff25;border-radius:5px;min-width:0;width:210px;padding:2px 8px;font:12px/18px var(--mono)}
.studio .studio-terminal-tools input::placeholder{color:#a6bbc5}
.studio .studio-terminal-tools button{color:#c5d8e2;white-space:nowrap}
.studio .studio-terminal{font:13px/1.9 var(--mono);max-height:min(56vh,560px);min-height:180px;overflow:auto;padding:13px 16px;white-space:pre}
.studio .studio-terminal.wrapped{white-space:pre-wrap;overflow-wrap:anywhere}
.studio .studio-terminal summary{font:inherit;color:inherit;white-space:inherit}
.studio .studio-terminal pre{font:inherit;white-space:inherit;padding-left:16px;margin:0 0 7px}
.studio .studio-terminal .bad{color:#f5a6a9}
.studio .studio-terminal mark{background:#f0ce7a;color:#19242a}
.studio .studio-terminal-foot{padding:8px 15px;color:#a6bbc5;font-size:12px;border-top:1px solid #ffffff14}
.studio .studio-review{padding:12px 26px;border-top:1px solid var(--line);background:var(--surface);flex:none}
.studio .studio-review .f-input{min-height:38px;font-size:13px;min-width:170px}
.studio .studio-run-actions{position:relative}
.studio .studio-run-actions>summary{list-style:none;cursor:pointer;padding:5px 10px;border-radius:7px}
.studio .studio-action-menu{position:absolute;top:calc(100% + 8px);right:0;width:300px;max-width:80vw;padding:16px;background:var(--surface);border:1px solid var(--border);border-radius:9px;box-shadow:var(--shadow);z-index:10;display:grid;gap:10px}
.studio .studio-report{padding:20px 26px;display:grid;gap:24px}
.studio .studio-report-split{display:grid;grid-template-columns:minmax(0,1.6fr) minmax(240px,1fr);gap:24px;align-items:start}
.studio .studio-check{padding:14px 0;border-bottom:1px solid var(--line)}
.studio .studio-check p{margin:5px 0;font-size:13px;color:var(--secondary)}
.studio .studio-diff{border:1px solid var(--line);border-radius:9px;overflow:hidden;margin-top:14px}
.studio .studio-diff-head{padding:10px 14px;background:var(--bg);border-bottom:1px solid var(--line);font-size:13px}
.studio .studio-diff-lines{padding:10px 0;overflow:auto;max-height:60vh}
.studio .studio-diff-line{display:flex;min-width:max-content;font:13px/1.9 var(--mono);white-space:pre;padding-right:15px}
.studio .studio-diff-line.add{background:var(--accent-soft)}
.studio .studio-diff-line.del{background:var(--red-soft)}
.studio .studio-diff-line.hunk{background:var(--blue-soft);color:var(--blue)}
.studio .studio-diff-line small{display:inline-block;width:48px;flex:none;color:var(--muted);text-align:right;padding-right:15px;user-select:none}
.studio .studio-delivery-prose{max-width:760px}
.studio .studio-files{display:grid;grid-template-columns:300px minmax(0,1fr);height:100%;min-height:0;overflow:hidden}
.studio .studio-tree{padding:16px;border-right:1px solid var(--line);background:var(--bg);display:flex;flex-direction:column;min-height:0}
.studio .studio-tree>.f-input{flex:none;margin-top:10px;min-height:34px;padding:5px 10px;font-size:13px}
.studio .tree{min-height:0;flex:1;overflow:auto;margin-top:10px}
.studio .tree .dir,.studio .tree .file{width:100%;text-align:left;display:flex;align-items:center;gap:6px;padding:6px 3px;border-radius:5px;min-height:34px}
.studio .tree .dir{font-size:13px;font-weight:500}
.studio .tree .file{font-size:12px}
.studio .tree .file:hover,.studio .tree .dir:hover{background:var(--soft)}
.studio .tree .file.on{background:var(--accent-soft);color:var(--accent)}
.studio .tree .file small{display:block;color:var(--muted);font-size:11px}
.studio .tree .ts{font-size:11px;color:var(--muted);margin-left:auto;flex:none}
.studio .studio-file-content{display:flex;flex-direction:column;min-width:0;min-height:0;overflow:hidden}
.studio .studio-file-head{padding:16px 20px 10px;border-bottom:1px solid var(--line);flex:none;display:grid;gap:8px}
.studio .studio-file-reader{flex:1;min-height:0;overflow:auto;padding:18px 22px;overflow-anchor:none}
.studio .studio-file-reader .view{max-height:none}
.studio .studio-settings-layout{display:grid;grid-template-columns:175px minmax(0,1fr);gap:35px;align-items:start}
.studio .studio-settings-nav,.studio .studio-prompt-nav{display:grid;gap:5px;align-content:start}
.studio .studio-settings-nav button{padding:10px 13px;text-align:left;border-radius:7px;color:var(--secondary)}
.studio .studio-settings-nav button.on,.studio .studio-prompt-nav button.on{background:var(--accent-soft);color:var(--accent);font-weight:600}
.studio .studio-settings-main{min-width:0}
.studio .studio-settings-main>.card{padding:24px}
.studio .studio-settings-main details{margin-top:24px}
.studio .studio-form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:22px;margin-top:24px}
.studio .studio-settings-save{padding:0;margin-top:24px;justify-content:flex-end}
.studio .studio-prompt-layout{display:grid;grid-template-columns:142px minmax(0,1fr);gap:22px;margin-top:22px}
.studio .studio-prompt-nav button{padding:7px 9px;font-size:12px;text-align:left;border-radius:5px;color:var(--secondary)}
.studio .studio-prompt-editor{min-height:275px;font:14px/1.9 var(--mono)}
.studio .studio-soft-card{padding:20px;background:var(--soft);border-radius:8px}
.studio .studio-soft-card p{margin-top:7px;color:var(--secondary);font-size:13px}
.studio .studio-connection{border-bottom:1px solid var(--line);padding:18px 0}
.studio .studio-probe-steps{margin:18px 0;display:grid;gap:12px}
.studio .studio-provider-note{display:flex;align-items:center;gap:10px;padding:12px;background:var(--soft);border-radius:7px;color:var(--secondary)}
.studio .studio-dialog .studio-prompt-editor{min-height:100px}
.studio .studio-json{max-width:100%;max-height:320px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.7 var(--mono)}
.studio .studio-json-fold{margin:4px 0}
.studio .studio-diff-line small{width:40px;padding-right:12px}
.studio .studio-link{padding:0;text-align:left;color:var(--accent)}
.studio .studio-link:hover{text-decoration:underline}
.studio .guide .lede{color:var(--secondary);margin-bottom:16px}
.studio .guide ol{padding-left:20px}
.studio .guide .grid-2{margin:16px 0}
.studio .hint-line{font-size:13px;color:var(--secondary);margin:12px 0}
.studio .skel-box{padding:24px}
.studio .skel{height:14px;background:var(--soft);border-radius:6px;margin:9px 0}
.studio .i2p-toast{position:fixed;bottom:28px;left:50%;transform:translateX(-50%);background:var(--ink);color:var(--surface);padding:11px 18px;border-radius:8px;z-index:100;box-shadow:var(--shadow);max-width:calc(100vw - 36px);font-size:13px}
.studio .i2p-toast.t-bad{background:var(--red);color:var(--surface)}
@container (max-width:1000px){
 .studio .studio-toolbar{gap:10px}
 .studio .studio-toolbar .studio-search{width:210px}
 .studio .studio-terminal-tools{flex-wrap:wrap;gap:8px}
 .studio .studio-terminal-tools input{flex:1;min-width:180px}
  }
@container (max-width:760px){
 .studio .studio-topbar{padding:0 18px;gap:15px}
 .studio .studio-topnav{gap:18px;margin:0}
 .studio .studio-page{padding:24px 20px}
 .studio .studio-settings-layout,.studio .studio-report-split{grid-template-columns:1fr;gap:22px}
 .studio .studio-settings-nav{display:flex;flex-wrap:wrap}
 .studio .studio-track{grid-template-columns:repeat(5,minmax(0,1fr))}
 .studio .studio-stage:nth-child(6):before{display:none}
 .studio .studio-project-filter{width:100%}
 .studio .studio-project-filter .f-select{width:auto;flex:1}
 .studio .studio-progress{display:none}
 .studio .studio-files{grid-template-columns:250px minmax(0,1fr)}
}

.i2p-entry{box-sizing:border-box;cursor:pointer;width:calc(100% + 4px);height:42px;
  color:var(--dsw-alias-label-primary);background:none;border:none;border-radius:3px;
  flex:none;align-items:center;gap:8px;margin:4px -2px;padding:0 10px 0 8px;
  font-family:inherit;font-size:14px;line-height:22px;display:flex;overflow:hidden;text-align:left}
.i2p-entry:hover{background:var(--dsw-alias-interactive-bg-hover)}
.i2p-entry:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-2px}
.i2p-entry.rail{border-radius:50%;justify-content:center;gap:0;width:36px;height:36px;margin:8px 0 10px;padding:0}
.i2p-entry-label{white-space:nowrap;overflow:hidden}

/* ===== 悬浮智能助手（轻量工具面板，绿色只做强调色） ===== */
.i2p-ai{position:absolute;inset:0;pointer-events:none;z-index:9999}
.i2p-ai button{font-family:inherit;cursor:pointer;color:inherit}
/* 入口 = 中性工具钮（非"AI 球"）：sparkle 图标，hover 才显底；开启态反色 */
@keyframes i2p-ai-in{from{opacity:0;transform:translateX(14px)}to{opacity:1;transform:none}}
/* 面板：轻绿色底（color-mix 混主题底色，官方 Markdown 文字两主题可读），
   全部强调（边框/focus/hover/chip 圆点）统一同一绿色系，避免杂色。
   每处 color-mix 前都有一行传统语法兜底：旧内核（Chromium<111）把不认识的值整条丢弃、
   保留兜底行——面板退化为"无绿色染色但结构完整"，而不是无背景无边框 */
.i2p-ai-panel{pointer-events:auto;position:absolute;top:60px;width:440px;height:calc(100% - 76px);
  min-width:240px;min-height:200px;
  display:flex;flex-direction:column;
  background:var(--panel,#fff);
  background:color-mix(in srgb,var(--accent,#177b62) 7%,var(--panel,#fff));
  border:1px solid var(--line-2,#d8dae3);
  border:1px solid color-mix(in srgb,var(--accent,#177b62) 20%,var(--line-2,#d8dae3));border-radius:3px;
  box-shadow:0 6px 28px rgba(9,12,20,.12);overflow:hidden;
  animation:i2p-ai-in .2s cubic-bezier(.2,.8,.2,1)}
/* resize 层：四边+四角，hover 显绿色；角命中区 24×24（WCAG 2.2 目标尺寸），
   贴面板内侧（外伸会被 overflow:hidden 裁剪点不到）；双击任一处恢复默认位置与尺寸 */
.i2p-ai-rz{position:absolute;z-index:4;touch-action:none}
.i2p-ai-rz.n{top:0;left:24px;right:24px;height:7px;cursor:ns-resize}
.i2p-ai-rz.s{bottom:0;left:24px;right:24px;height:7px;cursor:ns-resize}
.i2p-ai-rz.e{right:0;top:24px;bottom:24px;width:7px;cursor:ew-resize}
.i2p-ai-rz.w{left:0;top:24px;bottom:24px;width:7px;cursor:ew-resize}
.i2p-ai-rz.nw{top:0;left:0;width:24px;height:24px;cursor:nwse-resize}
.i2p-ai-rz.ne{top:0;right:0;width:24px;height:24px;cursor:nesw-resize}
.i2p-ai-rz.sw{bottom:0;left:0;width:24px;height:24px;cursor:nesw-resize}
.i2p-ai-rz.se{bottom:0;right:0;width:24px;height:24px;cursor:nwse-resize}
.i2p-ai-rz:hover{background:var(--hover);background:color-mix(in srgb,var(--accent,#177b62) 35%,transparent)}
/* 头部：标题 + 小字副题 + 关闭，细分割线（无图标） */
.i2p-ai-head{flex:none;display:flex;align-items:baseline;gap:8px;padding:11px 14px;cursor:move;
  border-bottom:1px solid var(--line,#e5e6ec);
  border-bottom:1px solid color-mix(in srgb,var(--accent,#177b62) 14%,var(--line,#e5e6ec))}
.i2p-ai-title{font-size:var(--fs-md,13.5px);font-weight:600;color:var(--ink);letter-spacing:.01em}
.i2p-ai-sub{font-size:var(--fs-xs,11.5px);color:var(--muted)}
.i2p-ai-close{margin-left:auto;align-self:center;width:26px;height:26px;border:none;border-radius:7px;background:none;
  color:var(--muted);display:inline-flex;align-items:center;justify-content:center;
  transition:background .15s,color .15s}
.i2p-ai-close:hover{background:var(--hover);color:var(--ink)}
/* 消息区：助手回答平铺（与宿主聊天区同语言），用户问题轻底块 */
.i2p-ai-msgs{flex:1;min-height:0;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:12px;
  scrollbar-width:thin;scrollbar-color:var(--line-2) transparent}
.i2p-ai-msgs::-webkit-scrollbar{width:6px}
.i2p-ai-msgs::-webkit-scrollbar-thumb{background:var(--line-2);border-radius:6px}
/* 空态：一句能力说明 + 快捷问题（浅底单行钮，前缀绿色圆点） */
.i2p-ai-empty{display:flex;flex-direction:column;gap:10px;padding-top:2px}
.i2p-ai-hint{margin:0;font-size:var(--fs-sm,12.5px);color:var(--muted);line-height:1.6}
.i2p-ai-chip{display:flex;align-items:center;gap:8px;text-align:left;
  background:var(--card,#fff);
  background:color-mix(in srgb,var(--card,#fff) 58%,transparent);
  border:none;border-radius:8px;padding:7px 11px;font-size:var(--fs-md,13.5px);color:var(--ink-2);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
  transition:background .15s,color .15s}
.i2p-ai-chip::before{content:"";flex:none;width:5px;height:5px;border-radius:50%;
  background:var(--accent,#177b62);
  background:color-mix(in srgb,var(--accent,#177b62) 70%,var(--muted,#82848f))}
.i2p-ai-chip:hover:not(:disabled){background:var(--hover);background:color-mix(in srgb,var(--accent,#177b62) 12%,var(--panel,#fff));color:var(--ink)}
.i2p-ai-chip:disabled{opacity:.5;cursor:default}
/* 用户问题：半透明面板色块，全宽不挤字 */
.i2p-ai-m{max-width:100%;font-size:var(--fs-md,13.5px);line-height:1.65}
.i2p-ai-m.user .i2p-ai-t{background:var(--card,#fff);
  background:color-mix(in srgb,var(--card,#fff) 62%,transparent);
  border:1px solid var(--line,#e5e6ec);
  border:1px solid color-mix(in srgb,var(--accent,#177b62) 12%,var(--line,#e5e6ec));
  border-radius:3px;padding:8px 12px;color:var(--ink);white-space:pre-wrap;word-break:break-word}
.i2p-ai-m.assistant{overflow-wrap:break-word}
.i2p-ai-m.assistant.err .i2p-ai-t{color:var(--err);font-size:var(--fs-sm,12.5px);
  background:var(--err-bg,rgba(213,70,58,.10));border-radius:8px;padding:7px 11px}
.i2p-ai-m .i2p-ai-t{white-space:pre-wrap;word-break:break-word}
.i2p-ai-md{font-size:var(--fs-md,13.5px);color:var(--ink)}
.i2p-ai-md :first-child{margin-top:0}
.i2p-ai-md :last-child{margin-bottom:0}
/* 助手回答 Markdown：插件自持排版，不随宿主 .md 全局样式版本漂移——
   ".i2p-page .i2p-ai-md xxx" 的 specificity 压过宿主 ".md xxx" 类规则，所有电脑渲染一致 */
.i2p-page .i2p-ai-md p,.i2p-page .i2p-ai-md ul,.i2p-page .i2p-ai-md ol{margin:0 0 8px}
.i2p-page .i2p-ai-md li{margin:2px 0}
.i2p-page .i2p-ai-md h1,.i2p-page .i2p-ai-md h2,.i2p-page .i2p-ai-md h3,.i2p-page .i2p-ai-md h4{
  margin:12px 0 6px;line-height:1.4;color:var(--ink)}
.i2p-page .i2p-ai-md h1{font-size:16px}
.i2p-page .i2p-ai-md h2{font-size:15px}
.i2p-page .i2p-ai-md h3{font-size:var(--fs-lg,14.5px)}
.i2p-page .i2p-ai-md h4{font-size:var(--fs-md,13.5px)}
.i2p-page .i2p-ai-md code{font-family:var(--mono);font-size:12.5px;background:var(--hover);
  padding:1px 5px;border-radius:4px}
.i2p-page .i2p-ai-md pre{background:var(--code-bg);border-radius:8px;padding:10px 12px;overflow-x:auto}
.i2p-page .i2p-ai-md pre code{background:none;padding:0;font-size:12.5px;line-height:1.6;color:#e6edf3}
.i2p-page .i2p-ai-md table{border-collapse:collapse;margin:0 0 8px;font-size:var(--fs-sm,12.5px)}
.i2p-page .i2p-ai-md th,.i2p-page .i2p-ai-md td{border:1px solid var(--line);padding:4px 8px;text-align:left}
.i2p-page .i2p-ai-md blockquote{margin:0 0 8px;padding:2px 0 2px 10px;border-left:3px solid var(--line-2);color:var(--ink-2)}
.i2p-page .i2p-ai-md a{color:var(--accent)}
.i2p-page .i2p-ai-md hr{border:none;border-top:1px solid var(--line);margin:10px 0}
/* 流式等待：三点呼吸 */
@keyframes i2p-ai-dot{50%{opacity:.25}}
.i2p-ai-dots{display:inline-flex;gap:4px;padding:2px 0}
.i2p-ai-dots i{width:6px;height:6px;border-radius:50%;background:var(--muted);
  animation:i2p-ai-dot 1.2s ease-in-out infinite}
.i2p-ai-dots i:nth-child(2){animation-delay:.2s}
.i2p-ai-dots i:nth-child(3){animation-delay:.4s}
/* 输入区：半透明卡色输入框 + 图标钮（生成中变停止，可中断） */
.i2p-ai-input{flex:none;display:flex;gap:8px;align-items:flex-end;padding:10px 12px 12px;
  border-top:1px solid var(--line,#e5e6ec);
  border-top:1px solid color-mix(in srgb,var(--accent,#177b62) 14%,var(--line,#e5e6ec))}
.i2p-ai-input textarea{flex:1;min-height:38px;max-height:150px;resize:none;overflow-y:auto;
  background:var(--card,#fff);
  background:color-mix(in srgb,var(--card,#fff) 66%,transparent);
  border:1px solid var(--line-2,#d8dae3);
  border:1px solid color-mix(in srgb,var(--accent,#177b62) 16%,var(--line-2,#d8dae3));
  border-radius:3px;color:var(--ink);padding:8px 11px;font-size:var(--fs-md,13.5px);
  line-height:1.55;font-family:inherit;transition:border-color .15s}
.i2p-ai-input textarea:focus{border-color:var(--accent);border-color:color-mix(in srgb,var(--accent,#177b62) 55%,var(--line-2,#d8dae3))}
.i2p-ai-input textarea::placeholder{color:var(--muted)}
.i2p-ai-send{flex:none;width:38px;height:38px;border-radius:3px;
  border:1px solid var(--line-2,#d8dae3);
  border:1px solid color-mix(in srgb,var(--accent,#177b62) 30%,var(--line-2,#d8dae3));
  background:var(--panel,#fff);
  background:color-mix(in srgb,var(--accent,#177b62) 12%,var(--panel,#fff));color:var(--ink-2);
  display:inline-flex;align-items:center;justify-content:center;
  transition:background .15s,border-color .15s,color .15s,transform .1s}
.i2p-ai-send:hover:not(:disabled){border-color:var(--accent);border-color:color-mix(in srgb,var(--accent,#177b62) 55%,var(--line-2,#d8dae3));color:var(--ink)}
.i2p-ai-send:active:not(:disabled){transform:scale(.95)}
.i2p-ai-send:disabled{opacity:.4;cursor:default}


`;

		const tagId = "dsh-issue2pr/styles";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=\"" + tagId + "\"]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-issue2pr";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		// DSH 主题挂在 body 的 data-ds-*-theme；兼容旧宿主时再读取背景亮度。
		function detectHostDark(doc) {
			if (doc.body?.hasAttribute("data-ds-dark-theme")) return true;
			if (doc.body?.hasAttribute("data-ds-light-theme")) return false;
			let value = "";
			try { value = getComputedStyle(doc.body || doc.documentElement).getPropertyValue("--dsw-alias-bg-base").trim(); } catch { /* 退回主题属性 */ }
			const hex = value.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
			const rgb = hex ? (hex[1].length === 3 ? [...hex[1]].map(c => parseInt(c + c, 16)) : hex[1].match(/../g).map(c => parseInt(c, 16)))
				: /^rgba?\(/.test(value) ? (value.match(/[\d.]+/g) || []).slice(0, 3).map(Number) : [];
			return rgb.length === 3 ? (rgb[0] * 299 + rgb[1] * 587 + rgb[2] * 114) / 1000 < 128 : doc.documentElement.dataset.theme === "dark";
		}
		if (typeof document !== "undefined" && document.documentElement
			&& !document.documentElement.dataset.i2pThemeWatch) {
			document.documentElement.dataset.i2pThemeWatch = "1";
			const detectArchTheme = function () {
				document.documentElement.dataset.i2pTheme = detectHostDark(document) ? "dark" : "light";
			};
			detectArchTheme();
			setInterval(detectArchTheme, 1000);
		}

		/* ================================================================
		 * 工具函数
		 * ================================================================ */
		function esc(s) {
			return String(s).replace(/[&<>"']/g, function (c) {
				return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
			});
		}

		// JSON 顺序词法高亮（key 金 / 字符串绿 / 注释灰）
		function jsonHtml(text) {
			const src = String(text);
			const re = /("(?:\\.|[^"\\])*")(\s*:)?|\/\/[^\n]*|\/\*[\s\S]*?\*\//g;
			const out = [];
			let last = 0, m;
			while ((m = re.exec(src))) {
				out.push(esc(src.slice(last, m.index)));
				if (m[0][0] === "/") out.push('<span class="c">' + esc(m[0]) + "</span>");
				else if (m[2]) out.push('<span class="k">' + esc(m[1]) + "</span>" + esc(m[2]));
				else out.push('<span class="s">' + esc(m[1]) + "</span>");
				last = m.index + m[0].length;
			}
			out.push(esc(src.slice(last)));
			return out.join("");
		}

		// diff 着色（hunk 头 / 增 / 删）
		function diffHtml(text) {
			return String(text).split("\n").map(function (line) {
				if (/^(\+\+\+|---|@@)/.test(line)) return '<span class="hunk">' + esc(line) + "</span>";
				if (/^\+/.test(line)) return '<span class="add">' + esc(line) + "</span>";
				if (/^-/.test(line)) return '<span class="del">' + esc(line) + "</span>";
				return esc(line);
			}).join("\n");
		}

		// 二期 L-B：行号槽——按行注入不可选中的行号列（复制按钮取原始文本，选择复制也不带行号杂质）
		function numbered(html) {
			const lines = String(html).replace(/\n$/, "").split("\n");
			return lines.map((line, index) => '<span class="ln">' + (index + 1) + "</span>" + line).join("\n");
		}
		function renderView(text, name) {
			const n = String(name || "").toLowerCase();
			if (/\.json$/.test(n)) return jsonHtml(text);
			if (/\.md$/.test(n)) return esc(text);
			if (/\.(diff|patch)$/.test(n)) return numbered(diffHtml(text));
			if (/^(diff |--- |\+\+\+ )/.test(text)) return numbered(diffHtml(text));
			return numbered(esc(text));
		}

		function reviewModeLabel(m) {
			return ({ every: "每阶段都停", "key-only": "只停关键门", auto: "全自动" })[m] || String(m || "");
		}
		function p6ModeLabel(m) {
			// 执行器文案单一源：与新建任务弹窗的"代码执行器"下拉共用 STUDIO_EXECUTORS 一张表
			const match = STUDIO_EXECUTORS.find(([id]) => id === m);
			return match ? match[1] : String(m || "");
		}
		// 委外门禁结果键：bin + 认证中转摘要（改路径或换预设后 key 不匹配即失效需重测）
		function fmtClock(iso) {
			if (!iso) return "";
			const d = new Date(iso);
			if (isNaN(d.getTime())) return "";
			const p = (x) => String(x).padStart(2, "0");
			return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
		}
		function fmtTime(iso) {
			if (!iso) return "";
			const d = new Date(iso);
			if (isNaN(d.getTime())) return String(iso).slice(0, 19);
			const p = (x) => String(x).padStart(2, "0");
			return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
		}
		function fmtSize(n) {
			if (n == null) return "";
			if (n < 1024) return n + " B";
			if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
			return (n / 1024 / 1024).toFixed(1) + " MB";
		}
		function apiGet(path, signal) {
			return fetch(API + path, { signal }).then(async function (response) {
				const result = await response.json().catch(() => ({ ok: false, message: "响应不是有效 JSON" }));
				return response.ok ? result : { ...result, ok: false, message: result.message || "HTTP " + response.status };
			});
		}
		function apiPost(path, body) {
			return fetch(API + path, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body || {}),
			}).then(function (r) { return r.json().catch(function () { return {}; }); });
		}
		function apiDelete(path) {
			return fetch(API + path, { method: "DELETE" })
				.then(function (r) { return r.json().catch(function () { return {}; }); });
		}
		function apiPut(path, body) {
			return fetch(API + path, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body || {}),
			}).then(function (r) { return r.json().catch(function () { return {}; }); });
		}

		// SVG 描边图标（24 网格 lucide 路径，按 width/height 缩放；stroke 继承 currentColor）
		const ICONS = {
			git: '<circle cx="6" cy="5" r="3"/><circle cx="6" cy="19" r="3"/><circle cx="18" cy="6" r="3"/><path d="M6 8v8M18 9a10 10 0 0 1-10 10"/>',
			branch: '<circle cx="6" cy="5" r="3"/><circle cx="6" cy="19" r="3"/><circle cx="18" cy="6" r="3"/><path d="M6 8v8M18 9a10 10 0 0 1-10 10"/>',
			right: '<path d="m9 5 7 7-7 7"/>',
			file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h8M8 17h5"/>',
			play: '<path d="M7 4.5v15l12-7.5z" fill="currentColor" stroke="none"/>',
			stop: '<rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" stroke="none"/>',
			redo: '<path d="M3 2v6h6"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L3 8"/>',
			folder: '<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/>',
			trash: '<path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M10 11v6"/><path d="M14 11v6"/>',
			x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
			check: '<path d="M20 6 9 17l-5-5"/>',
			plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
			collapse: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/><path d="m16 9-3 3 3 3"/>',
			expand: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/><path d="m13 9 3 3-3 3"/>',
			box: '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
			book: '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>',
			sliders: '<line x1="21" x2="14" y1="4" y2="4"/><line x1="10" x2="3" y1="4" y2="4"/><line x1="21" x2="12" y1="12" y2="12"/><line x1="8" x2="3" y1="12" y2="12"/><line x1="21" x2="16" y1="20" y2="20"/><line x1="12" x2="3" y1="20" y2="20"/><line x1="14" x2="14" y1="2" y2="6"/><line x1="8" x2="8" y1="10" y2="14"/><line x1="16" x2="16" y1="18" y2="22"/>',
			upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" x2="12" y1="3" y2="15"/>',
			reset: '<path d="M3 2v6h6"/><path d="M3 13a9 9 0 1 0 3-7.7L3 8"/>',
			sparkle: '<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/><path d="M4 17v2"/><path d="M5 18H3"/>',
			send: '<path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/>',
			msg: '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>',
		};
		function Ic(name, size) {
			return h("svg", {
				width: size || 14, height: size || 14, viewBox: "0 0 24 24",
				fill: "none", stroke: "currentColor", strokeWidth: 2,
				strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true",
				dangerouslySetInnerHTML: { __html: ICONS[name] || "" },
			});
		}

		// 数据加载骨架（shimmer 扫过；reduce-motion 下 CSS 已将其静止）
		function Skel(props) {
			return h("div", Object.assign({ className: "skel-box", role: "status", "aria-label": "加载中" }, props),
				h("div", { className: "skel", style: { width: "38%" } }),
				h("div", { className: "skel", style: { width: "86%" } }),
				h("div", { className: "skel", style: { width: "64%" } }));
		}

		/* ================================================================
		 * 工作台目录列几何（宽窄/显隐）：模块级 store，localStorage 记忆，
		 * WorkbenchPage 头部按钮与 Section 目录列共享
		 * ================================================================ */
		/* ================================================================
		 * 视图位置（当前页面 / 选中项目 / 选中 Run）：模块级 store，
		 * Section 写入、悬浮智能助手读取（"聚焦现在的页面"）
		 * ================================================================ */
		const viewStore = {
			nav: "projects", slug: null, runId: null,
			listeners: new Set(),
			set(patch) { Object.assign(this, patch); for (const fn of this.listeners) fn(); },
			subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); },
		};
		function useViewState() {
			const [v, setV] = React.useState({ nav: viewStore.nav, slug: viewStore.slug, runId: viewStore.runId });
			React.useEffect(() => viewStore.subscribe(() => setV({ nav: viewStore.nav, slug: viewStore.slug, runId: viewStore.runId })), []);
			return v;
		}

		/* ================================================================
		 * lastRun 记忆（按项目记最近选中的 Run）：localStorage 快路径 + 服务端
		 * ui-state 兜底（与 i2p.proj 同双写策略）。宿主标签切换会销毁重建插件
		 * webview，选中 Run 的现场以此恢复，而不是每次都掉回最新 Run。
		 * ================================================================ */
		const lastRunStore = {
			map: (function () { try { return JSON.parse(localStorage.getItem("i2p.run") || "{}") || {}; } catch (e) { return {}; } })(),
			get(slug) { return this.map[slug] || null; },
			set(slug, runId) {
				if (!slug) return;
				if (runId) this.map[slug] = runId; else delete this.map[slug];
				try { localStorage.setItem("i2p.run", JSON.stringify(this.map)); } catch (e) { /* 忽略 */ }
				apiPost("/ui-state", { lastRunBySlug: runId ? { [slug]: runId } : { [slug]: null } })
					.catch(function () { /* 兜底写失败静默：localStorage 仍有效 */ });
			},
			// 服务端兜底返回后并入（只补缺失键，不覆盖本地较新的记忆）
			adopt(map) {
				if (!map || typeof map !== "object") return;
				for (const k of Object.keys(map)) if (!this.map[k] && map[k]) this.map[k] = map[k];
			},
		};

		/* ================================================================
		 * 运行页现场（选中阶段 / 二级菜单 / 产物文件）：模块级 store，
		 * RunsPanel 每次渲染写回；切走一级标签卸载后重挂载，runId 一致则恢复
		 * ================================================================ */
		/* ================================================================
		 * Git 托管连接辅助：host 解析（与服务端 lib/infra/connections.js 对齐）。
		 * 支持 https / ssh:// / scp（git@host:path）三种形态。
		 * ================================================================ */
		function hostOfUri(uri) {
			const s = String(uri || "").trim();
			const m = s.match(/^(?:https?|ssh|git):\/\/(?:[^@\/]+@)?([^\/:?#]+)/i);
			if (m) return m[1].toLowerCase();
			const scp = s.match(/^git@([^\/:?#]+):/);
			return scp ? scp[1].toLowerCase() : null;
		}
		function isSshUri(uri) {
			const s = String(uri || "").trim();
			return /^(ssh|git):\/\//i.test(s) || /^git@[^\/:?#]+:/i.test(s);
		}
		// 本地绝对路径触发源（Windows 盘符 / POSIX / ~ 开头且非 URL）

		/* ================================================================
		 * 01 项目
		 * ================================================================ */
		// —— Git 托管连接卡（项目页内嵌，数据全局共享）：连接列表 + 添加/测试/删除 ——
		// GitHub/GitLab 用 Access Token；CodeArts 用「个人设置 → HTTPS 密码」的 用户名+密码。
		// connections.json 只保存元数据/secretRef；秘密由系统密钥环或明确标记的本机 fallback 管理。
		const CONN_KIND_META = {
			github: { label: "GitHub", host: "github.com", hostFixed: true, needsUser: false, tokenLabel: "Access Token", hint: "GitHub → Settings → Developer settings → Personal access tokens" },
			gitlab: { label: "GitLab", host: "gitlab.com", hostFixed: false, needsUser: false, tokenLabel: "Access Token", hint: "自建实例请改 host；token 需 read_api + read_repository 权限" },
			codearts: { label: "CodeArts", host: "", hostFixed: false, needsUser: true, tokenLabel: "HTTPS 密码", hint: "华为云 CodeArts 仓库页右上角 → 个人设置 → HTTPS 密码；用户名形如 租户名/IAM用户名" },
		};
		function kvRow(k, v, mono) {
			return h(React.Fragment, null,
				h("span", { className: "k" }, k),
				h("span", { className: "v" + (mono ? " mono" : "") }, v));
		}

		// 阶段契约卡：上游输入 → 输出产物 → 输出契约（「配置」表单与「运行」页阶段详情共用；
		// 数据源 defaults.stages[id].delegateSpec——内置执行与委托外部智能体同受此约束；
		// P7/P8 为确定性执行阶段，无 LLM 输出契约）
		function StageContractCard(props) {
			const d = props.defaults && props.defaults.stages ? props.defaults.stages[props.stageId] : null;
			const spec = d && d.delegateSpec;
			return h("div", { className: "field" },
				h("span", { className: "f-label" }, "阶段契约 · 输入 → 输出（内置执行与委托外部智能体同受约束）"),
				spec
					? h("div", { className: "kv" },
						spec.inputs ? kvRow("上游输入", (Array.isArray(spec.inputs) ? spec.inputs : [spec.inputs]).join("、"), true) : null,
						kvRow("输出产物", spec.output, true),
						kvRow("输出契约", spec.contract, true))
					: h("p", { className: "hint-line", style: { margin: 0 } },
						"确定性执行阶段（不调用大模型），无 LLM 输出契约。"));
		}

		// 任务详情弹窗中的阶段职责、输入输出、委托契约与专属参数说明。
		function StageGuideCard(props) {
			const s = STAGES.find(function (x) { return x.id === props.stageId; });
			if (!s) return null;
			const d = props.defaults && props.defaults.stages ? props.defaults.stages[s.id] : null;
			const caps = (d && d.caps) || {};
			const params = (d && d.params) || {};
			const paramKeys = Object.keys(params);
			return h("div", null,
				h("p", { className: "run-hint", style: { margin: "0 0 12px" } }, s.about),
				h("div", { className: "kv", style: { marginBottom: 14 } },
					kvRow("职责", s.desc),
					kvRow("产物", s.art, true),
					kvRow("复核门", s.key ? "是 · 产物就绪需人工通过后推进" : s.bypass ? "否 · 失败旁路，仅失败时执行" : "否 · 产物就绪自动推进"),
					kvRow("能力", [
						caps.route ? "可调模型/思考深度" : null,
						caps.exec ? "可调超时" + (caps.test ? "/测试命令" : "/maxTokens") : null,
						caps.delegate ? "可委托外部智能体" : null,
						!caps.route && !caps.delegate ? "确定性执行（不调用大模型）" : null,
					].filter(Boolean).join(" · ")),
					d && d.delegateSpec ? kvRow("委托产出", d.delegateSpec.output, true) : null,
					d && d.delegateSpec ? kvRow("输出契约", d.delegateSpec.contract, true) : null),
				h("span", { className: "f-label" }, "本阶段专属参数"),
				paramKeys.length ? h("table", { className: "tbl", style: { margin: "6px 0 0" } },
					h("thead", null, h("tr", null,
						h("th", null, "参数"), h("th", null, "默认值"), h("th", null, "说明"))),
					h("tbody", null, paramKeys.map(function (k) {
						const meta = params[k];
						return h("tr", { key: k },
							h("td", null, h("code", null, k)),
							h("td", null, h("code", null, meta.type === "string" && !meta.def ? "（自动探测）" : String(meta.def) + (meta.unit ? " " + meta.unit : ""))),
							h("td", null, meta.label + "——" + meta.hint));
					})))
					: h("p", { className: "hint-line", style: { margin: "4px 0 0" } },
						"本阶段没有专属参数；新任务的通用项在「设置 → 阶段提示词」中调整。"),
				h("p", { className: "hint-line" },
					"这里展示系统默认说明；当前任务的启动配置可在任务上下文中查看。全局设置保存后仅影响新任务。"));
		}


		// v9 工作台：切换视图后旧响应不能覆盖新选择。
		function readPreference(key, fallback) {
			try { const value = JSON.parse(localStorage.getItem(key)); return value == null ? fallback : value; }
			catch { return fallback; }
		}
		function writePreference(key, value) {
			try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 内存状态仍可用 */ }
		}
		function usePreference(key, fallback) {
			const [value, setValue] = React.useState(() => readPreference(key, fallback));
			React.useEffect(() => { writePreference(key, value); }, [key, value]);
			return [value, setValue];
		}
		async function readOk(path, signal) {
			const result = await apiGet(path, signal);
			if (!result || result.ok === false) throw new Error(result?.message || "读取失败");
			return result;
		}
		function useResource(key, loader, interval = 0) {
			const [data, setData] = React.useState({ key: null, value: null, error: "" });
			const [revision, setRevision] = React.useState(0);
			const loaderRef = React.useRef(loader); loaderRef.current = loader;
			React.useEffect(() => {
				if (!key) return;
				let active = true, timer;
				const controller = new AbortController();
				const tick = async () => {
					try {
						const value = await loaderRef.current(controller.signal);
						if (active) setData({ key, value, error: "" });
					} catch (error) {
						if (active) setData(prev => ({ key, value: prev.key === key ? prev.value : null,
							error: error.message || "连接中断" }));
					} finally { if (active && interval) timer = setTimeout(tick, interval); }
				};
				tick();
				return () => { active = false; controller.abort(); clearTimeout(timer); };
			}, [key, revision, interval]);
			return { value: data.key === key ? data.value : null, error: data.key === key ? data.error : "",
				reload: () => setRevision(value => value + 1) };
		}
		function ResourceNotice({ resource }) {
			return resource.error ? h("div", { className: "callout err studio-row", role: "alert" },
				h("span", { className: "studio-grow" }, "读取失败，保留上次内容：" + resource.error),
				h("button", { className: "btn sm", onClick: resource.reload }, "重试")) : null;
		}
		function StatusBadge({ status }) {
			const entry = TAG[status] || ["t-off", status || "未开始"];
			return h("span", { className: "tg " + entry[0] }, entry[1]);
		}
		function studioButton(label, onClick, className = "", disabled = false) {
			return h("button", { type: "button", className: "btn " + className, onClick, disabled }, label);
		}
		function EmptyState({ title, children }) {
			return h("div", { className: "studio-empty" }, Ic("box", 28), h("h3", null, title), children);
		}
		function StudioDialog({ title, onClose, children, wide = false }) {
			const ref = React.useRef(null);
			React.useEffect(() => {
				const previous = document.activeElement, dialog = ref.current;
				dialog.showModal();
				return () => { dialog.close(); if (previous?.isConnected) previous.focus(); };
			}, []);
			return h("dialog", { ref, className: "studio-dialog" + (wide ? " wide" : ""), "aria-label": title,
				onCancel: e => { e.preventDefault(); onClose(); } },
				h("div", { className: "studio-row studio-dialog-head" }, h("h2", { className: "studio-grow" }, title),
					studioButton("关闭", onClose, "ghost sm")), h("div", { className: "studio-dialog-body" }, children));
		}
		function useRunArtifact(slug, runId, path, tree, mode = "") {
			const file = (tree || []).find(entry => entry.path === path);
			const param = mode === "tail" ? "&tail=1" : mode === "full" ? "&full=1" : "";
			return useResource(slug && runId && path && file
				? [slug, runId, path, file.mtimeMs, file.size, mode].join("|") : null,
				async signal => (await readOk("/projects/" + slug + "/runs/" + runId
					+ "/artifact?path=" + encodeURIComponent(path) + param, signal)).text);
		}
		function parseJson(text) { try { return JSON.parse(text); } catch { return null; } }
		function parseLines(text) {
			return String(text || "").split("\n").map((line, index) => {
				const row = parseJson(line); return row && { ...row, lineNo: index };
			}).filter(Boolean);
		}
		async function copyStudio(text, toast) {
			try { await navigator.clipboard.writeText(String(text)); toast("已复制"); }
			catch { toast("复制失败，请选择文本后手动复制", "bad"); }
		}
		function downloadStudio(path, text) {
			const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
			const link = document.createElement("a"); link.href = url;
			link.download = path.split("/").pop(); link.click();
			setTimeout(() => URL.revokeObjectURL(url), 1000);
		}
		function ArtifactContent({ text, path, raw = false, numbered: wantNumbers = false }) {
			if (text == null) return h("p", { className: "hint" }, "读取中…");
			if (!text) return h("p", { className: "hint" }, "空文件");
			return !raw && /\.md$/i.test(path) ? h("div", { className: "md-view" }, h(MarkdownText, { text }))
				: h("pre", { className: "view", tabIndex: 0,
					// raw=用户显式「查看源文件」保真无行号；分页切片（wantNumbers）注入行号便于段内定位
					dangerouslySetInnerHTML: { __html: raw ? (wantNumbers ? numbered(esc(text)) : esc(text)) : renderView(text, path) } });
		}
		function executionPatchPath(value) {
			if (typeof value !== "string" || !value.trim()) return null;
			const raw = value.trim().replace(/\\/g, "/");
			if (raw.split("/").includes("..")) return null;
			return raw.startsWith("06-implementation/") ? raw : "06-implementation/" + raw.replace(/^\/+/, "");
		}
		function artifactOwner(path, run, instances = []) {
			if (/^(trace\/|reviews\/|run\.json$)/.test(path)) return { stage: "task", label: "任务级记录" };
			const delegated = path.match(/^delegate\/(P\d+)(?:-|\/)/);
			const stage = STAGES.find(item => item.id === delegated?.[1])?.id || STAGES.find(item => path === item.art || (item.art.endsWith("/") && path.startsWith(item.art)))?.id
				|| (path === "08-test-output.txt" ? "P8" : path === "11-eval-report.json" ? "P11" : null)
				|| STAGES.find(item => run?.stages?.[item.id]?.artifact === path)?.id;
			const owners = instances.filter(item => item && executionPatchPath(item.patch) === path);
			return { stage: stage || "other", label: stage ? stage + " " + STUDIO_STAGE_NAMES[stage] : "其他文件 · 归属未确认",
				instance: owners.length === 1 && typeof owners[0].node === "string" ? owners[0].node : null };
		}
		function artifactLabel(path) {
			if (/events\.jsonl$/.test(path)) return "全过程事件";
			if (/spans\.jsonl$/.test(path)) return "阶段耗时记录";
			if (/^reviews\//.test(path)) return "人工复核记录";
			if (/task\.md$/.test(path)) return "委托输入";
			if (/\.(diff|patch)$/.test(path)) return "代码补丁";
			if (/external-exec\.log$/.test(path)) return "外部执行输出";
			if (/coder-report\.json$/.test(path)) return "实例结果汇总";
			if (/test-report\.json$/.test(path)) return "任务测试结论";
			if (/test-output\.txt$/.test(path)) return "测试命令输出";
			if (/review-report\.json$/.test(path)) return "任务审查结论";
			if (/eval-report\.json$/.test(path)) return "交付评测";
			return /\.md$/.test(path) ? "Markdown 文档" : /\.jsonl?$/.test(path) ? "结构化记录" : "文本文件";
		}
		// 按统一 diff 头（@@ -o,n +p,m @@）推算每行的旧/新文件行号；文件头与 "\ No newline" 行不计数。
		function diffLineNumbers(lines) {
			let oldNo = null, newNo = null;
			return lines.map(line => {
				if (line.startsWith("@@")) {
					const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
					if (match) { oldNo = Number(match[1]); newNo = Number(match[2]); }
					return { old: null, new: null };
				}
				if ((oldNo === null && newNo === null) || line.startsWith("diff --git ") || line.startsWith("index ") || line.startsWith("--- ") || line.startsWith("+++ ") || line.startsWith("\\ ")) return { old: null, new: null };
				if (line.startsWith("+")) return { old: null, new: newNo === null ? null : newNo++ };
				if (line.startsWith("-")) return { old: oldNo === null ? null : oldNo++, new: null };
				const numbers = { old: oldNo, new: newNo };
				if (oldNo !== null) oldNo++;
				if (newNo !== null) newNo++;
				return numbers;
			});
		}
		function DiffContent({ text, path }) {
			if (text == null) return h("p", { className: "hint" }, "正在读取补丁…");
			const lines = String(text).split("\n");
			const numbers = diffLineNumbers(lines);
			return h("div", { className: "studio-diff" }, h("div", { className: "studio-diff-head mono studio-path" }, path),
				h("div", { className: "studio-diff-lines", tabIndex: 0, "aria-label": "补丁内容" }, lines.map((line, index) => {
					const kind = line.startsWith("@@") ? "hunk" : /^\+[^+]/.test(line) ? "add" : /^-[^-]/.test(line) ? "del" : "";
					return h("div", { key: index, className: "studio-diff-line " + kind },
						h("small", null, numbers[index].old ?? ""),
						h("small", null, numbers[index].new ?? ""),
						h("span", null, line || " "));
				})));
		}
		function ArtifactsPanel(p) {
			const memoryKey = "i2p.file." + p.slug + "." + p.runId;
			const [selected, setSelected] = React.useState(() => p.initialPath || readPreference(memoryKey, ""));
			const [search, setSearch] = React.useState("");
			const [raw, setRaw] = React.useState(false);
			const [page, setPage] = React.useState(0);
			const [collapsed, setCollapsed] = usePreference(memoryKey + ".collapsed", {});
			const reader = React.useRef(null), treeRef = React.useRef(null);
			const files = p.tree || [];
			const path = files.some(file => file.path === selected) ? selected : files[0]?.path || "";
			const file = files.find(item => item.path === path), owner = artifactOwner(path, p.run, p.instances);
			// N1：超过服务端 200KB 整读上限的文件自动降级尾部读取，预览不再 400 空白
			const content = useRunArtifact(p.slug, p.runId, path, p.tree, file?.size > 200 * 1024 ? "tail" : "");
			React.useEffect(() => {
				if (!p.initialPath) return;
				setSelected(p.initialPath); setSearch("");
				const target = artifactOwner(p.initialPath, p.run, p.instances);
				setCollapsed(previous => ({ ...previous, [target.stage]: false, [target.stage + ":" + target.instance]: false }));
			}, [p.initialPath]);
			React.useEffect(() => { if (path) writePreference(memoryKey, path); setPage(0); }, [path, memoryKey]);
			React.useLayoutEffect(() => {
				if (reader.current && content.value != null) reader.current.scrollTop = readPreference(memoryKey + ".scroll." + path, 0);
			}, [path, content.value != null]);
			React.useLayoutEffect(() => { if (treeRef.current) treeRef.current.scrollTop = readPreference(memoryKey + ".tree-scroll", 0); }, [memoryKey]);
			const query = search.trim().toLowerCase();
			const visible = files.filter(file => {
				const info = artifactOwner(file.path, p.run, p.instances);
				return [file.path, artifactLabel(file.path), info.label, info.instance].join(" ").toLowerCase().includes(query);
			});
			const nodes = [];
			for (const stage of [...STAGES.map(item => item.id), "task", "other"]) {
				const stageFiles = visible.filter(file => artifactOwner(file.path, p.run, p.instances).stage === stage);
				if (!stageFiles.length && (query || ["task", "other"].includes(stage))) continue;
				const expanded = !!query || !collapsed[stage], label = stage === "task" ? "任务级记录" : stage === "other" ? "其他文件 · 归属未确认" : stage + " " + STUDIO_STAGE_NAMES[stage];
				nodes.push(h("button", { key: stage, className: "dir", "aria-expanded": expanded, onClick: () => setCollapsed(prev => ({ ...prev, [stage]: expanded })) },
					h("span", null, expanded ? "▾" : "▸"), Ic("folder", 15), h("span", { className: "studio-grow" }, label), h("span", { className: "ts" }, stageFiles.length || tag(p.run?.stages?.[stage]?.status)[1])));
				if (!expanded) continue;
				const groups = [...new Set(stageFiles.map(file => artifactOwner(file.path, p.run, p.instances).instance))].sort((a, b) => a == null ? -1 : b == null ? 1 : a.localeCompare(b));
				for (const instance of groups) {
					const groupKey = stage + ":" + instance, groupExpanded = !!query || !collapsed[groupKey];
					if (instance) nodes.push(h("button", { key: groupKey, className: "dir", style: { paddingLeft: 18 }, "aria-expanded": groupExpanded,
						onClick: () => setCollapsed(prev => ({ ...prev, [groupKey]: groupExpanded })) }, (groupExpanded ? "▾ " : "▸ ") + instance));
					if (instance && !groupExpanded) continue;
					for (const entry of stageFiles.filter(file => artifactOwner(file.path, p.run, p.instances).instance === instance)) nodes.push(h("button", {
						key: entry.path, className: "file" + (path === entry.path ? " on" : ""), style: { paddingLeft: instance ? 36 : 18 }, title: entry.path,
						"aria-current": path === entry.path ? "true" : undefined, onClick: () => setSelected(entry.path)
					}, Ic("file", 15), h("span", { className: "studio-grow studio-path" }, entry.path.split("/").at(-1), h("small", null, artifactLabel(entry.path))), h("span", { className: "ts" }, fmtSize(entry.size))));
				}
			}
			const pages = Math.max(1, Math.ceil((content.value?.length || 0) / 60000)), safePage = Math.min(page, pages - 1);
			const partial = file?.size > 200 * 1024;
			return h("div", { className: "studio-files" },
				h("aside", { className: "studio-tree", "aria-label": "产物文件树" }, h("div", { className: "studio-row" }, h("strong", { className: "studio-grow" }, "文件与证据"), h("span", { className: "hint" }, files.length + " · 全部产物")),
					h("input", { type: "search", className: "f-input", value: search, placeholder: "搜索文件、阶段或实例", "aria-label": "搜索文件", onChange: e => setSearch(e.target.value) }),
					h("div", { className: "tree", ref: treeRef, onScroll: e => writePreference(memoryKey + ".tree-scroll", e.currentTarget.scrollTop) }, nodes.length ? nodes : h("p", { className: "hint" }, "没有匹配文件"))),
				h("section", { className: "studio-file-content" },
					h("div", { className: "studio-file-head" }, h("div", { className: "studio-row wrap" },
						h("h3", { className: "studio-grow studio-path" }, path.split("/").at(-1) || "文件预览"),
						p.onReturn ? studioButton("返回现场", p.onReturn, "ghost sm") : null,
						studioButton("复制", () => copyStudio(content.value, p.toast), "ghost sm", content.value == null),
						studioButton(partial ? "下载已读内容" : "下载", () => downloadStudio(path, content.value), "ghost sm", content.value == null),
						studioButton("打开目录", async () => { try {
							const result = await apiPost("/projects/" + p.slug + "/runs/" + p.runId + "/open", {}); p.toast(result.message || "已打开", result.ok ? "ok" : "bad");
						} catch (error) { p.toast(error.message, "bad"); } }, "ghost sm")),
						h("div", { className: "hint studio-path" }, (p.project?.name || p.slug) + " · " + owner.label + (owner.instance ? " · " + owner.instance : "") + " · 当前存储文件"),
						h("div", { className: "mono hint studio-path" }, path),
						h("div", { className: "studio-row" }, h("span", { className: "hint studio-grow" }, fmtSize(file?.size) + (content.value != null ? " · " + (partial ? "尾部 " : "") + content.value.split("\n").length + " 行" : "")),
						studioButton(raw ? "查看排版" : "查看源文件", () => setRaw(!raw), "ghost sm")),
					owner.stage !== "task" && owner.stage !== "other" ? h("p", { className: "hint" }, evidenceState(p.run, owner.stage, file)) : null,
						partial ? h("p", { className: "callout warn" }, "文件超过预览上限，仅显示尾部最近内容；复制/下载为该部分，完整内容请打开目录查看原文件。") : null,
					h(ResourceNotice, { resource: content }), pages > 1 ? h("div", { className: "studio-row" }, studioButton("上一段", () => setPage(safePage - 1), "sm", safePage === 0),
						h("span", { className: "hint" }, (safePage + 1) + " / " + pages), studioButton("下一段", () => setPage(safePage + 1), "sm", safePage + 1 === pages)) : null),
					h("div", { className: "studio-file-reader", ref: reader, onScroll: e => writePreference(memoryKey + ".scroll." + path, e.currentTarget.scrollTop) },
						path ? !raw && /\.(diff|patch)$/i.test(path) ? h(DiffContent, { text: content.value?.slice(safePage * 60000, (safePage + 1) * 60000), path })
							: h(ArtifactContent, { text: content.value == null ? null : content.value.slice(safePage * 60000, (safePage + 1) * 60000), path, raw: raw || pages > 1, numbered: pages > 1 && !raw })
							: h(EmptyState, { title: "暂未生成文件" }))));
		}

		const STUDIO_STAGE_NAMES = {
			P1: "需求分析", P2: "代码检索", P3: "代码理解", P4: "根因假设", P5: "任务规划",
			P6: "代码实现", P7: "补丁应用", P8: "测试验证", P9: "代码审查", P10: "失败分析", P11: "交付评测"
		};
		const REVIEW_QUESTIONS = { P5: "这个实施计划可以开始吗？", P6: "这些修改符合预期吗？", P9: "验证与审查是否充分？", P11: "这份交付说明是否准确？" };
		function stageFiles(stage, tree, run) { return (tree || []).filter(file => artifactOwner(file.path, run).stage === stage); }
		function evidenceState(run, stage, file) {
			const state = run?.stages?.[stage];
			if (!file) return "未生成";
			if (!state?.startedAt || !Number.isFinite(file.mtimeMs)
				|| file.mtimeMs < Date.parse(state.startedAt)) return "本轮有效性未确认";
			if (!["approved", "completed"].includes(state.status)) return "尚未通过本轮复核";
			return "本轮阶段已通过";
		}
		function gateLabel(value) { return value === "pass" ? "通过" : value === "fail" ? "未通过" : value == null ? "未记录" : "格式异常"; }
		// 二期 S1/S2：门禁统计（汇总叙事用）。仅当报告为对象且至少一项有值时返回，避免空报告误报。
		function gateStats(resource) {
			const report = parseJson(resource?.value);
			if (!report || typeof report !== "object" || Array.isArray(report)) return null;
			const keys = ["ROOT", "PATCH", "TEST", "DIFF", "DESC", "ACCEPT"];
			const pass = keys.filter(key => report[key] === "pass").length;
			const fail = keys.filter(key => report[key] === "fail").length;
			return pass || fail ? { pass, fail, total: keys.length } : null;
		}
		// 二期 S1：门禁值分色——未通过必须红章可一眼识别，通过绿章，其余保持灰提示。
		function gateValue(value) {
			return value === "pass" ? h("span", { className: "tg t-good" }, Ic("check", 11), "通过")
				: value === "fail" ? h("span", { className: "tg t-err" }, Ic("x", 11), "未通过")
				: h("span", { className: "hint" }, gateLabel(value));
		}
		function reportSummary(stage, raw) {
			if (raw == null) return "正在读取结果…";
			if (stage === "P7") { const rows = parseLines(raw); return "账本记录 " + rows.length + " 条 · 回滚 " + rows.filter(row => row.rollbackOf != null).length + " 条"; }
			const report = parseJson(raw);
			if (!report || typeof report !== "object" || Array.isArray(report)) return "报告格式异常，请查看原文";
			if (stage === "P8") return (report.passed === true ? "测试通过" : report.passed === false ? "测试失败" : "测试结论未记录")
				+ (typeof report.exitCode === "number" ? " · 退出码 " + report.exitCode : "") + (typeof report.command === "string" ? " · " + report.command : "");
			if (stage === "P9") return "审查结论：" + gateLabel(report.verdict) + (typeof report.diff_scope === "string" ? " · " + report.diff_scope : "");
			return "文件记录：" + ["ROOT", "PATCH", "TEST", "DIFF", "DESC", "ACCEPT"].filter(name => report[name] === "pass").length + " / 6 项评测通过";
		}
		function RunReportCard({ title, stage, path, run, tree, onFile, slug, runId }) {
			const file = (tree || []).find(item => item.path === path);
			const report = useRunArtifact(slug, runId, path, tree);
			if ((run.stages?.[stage]?.status || "pending") === "pending" && !file)
				return h("div", { className: "studio-check studio-row" }, h("span", { className: "studio-grow" }, title),
					h("span", { className: "hint" }, stage + " 尚未执行"));
			const result = parseJson(report.value);
			const gates = ["ROOT", "PATCH", "TEST", "DIFF", "DESC", "ACCEPT"];
			const passed = stage === "P8" ? result?.passed : stage === "P9" ? (result?.verdict === "pass" ? true : result?.verdict === "fail" ? false : null)
				: stage === "P11" ? (gates.every(key => result?.[key] === "pass") ? true : gates.some(key => result?.[key] === "fail") ? false : null) : null;
			return h("article", { className: "studio-check" }, h("div", { className: "studio-row" },
				h("h3", { className: "studio-grow" }, title), stage === "P7" ? h(StatusBadge, { status: run.stages?.[stage]?.status }) :
					h("span", { className: "tg " + (passed === true ? "t-good" : passed === false ? "t-err" : "t-off") }, passed === true ? "报告通过" : passed === false ? "报告未通过" : "尚无结论")),
				h("p", { className: "hint" }, "阶段状态：" + evidenceState(run, stage, file)),
				h(ResourceNotice, { resource: report }),
				h("p", { className: "studio-path" }, run.stages?.[stage]?.error || (file ? reportSummary(stage, report.value) : "尚未生成结果文件")),
				studioButton("查看证据", () => onFile(path), "sm", !file));
		}
		// P11 节点子页签：交付（P11 自身产物）与全流程汇总（跨阶段，明确标注归属）分开呈现。
		function DeliveryPanel({ run, tree, description, evaluation, toast }) {
			const stats = gateStats(evaluation);
			return h("div", { className: "studio-stack" },
				h("div", { className: "studio-row wrap" }, h("h2", { className: "studio-grow" }, "交付与验收"), h("span", { className: "hint" }, "远程 PR 尚未创建"),
					studioButton("复制说明", () => copyStudio(description.value, toast), "sm", description.value == null)),
				h("div", { className: "studio-grid" }, ["ROOT", "PATCH", "TEST", "DIFF", "DESC", "ACCEPT"].map(name => h("div", { className: "studio-check studio-row", key: name }, h("span", { className: "studio-grow" }, ({ ROOT: "根因证据", PATCH: "补丁应用", TEST: "回归测试", DIFF: "变更审查", DESC: "说明忠实", ACCEPT: "验收门禁" })[name]), gateValue(parseJson(evaluation.value)?.[name])))),
				// 二期 S2：报告可解析时尾部给门禁汇总，替代无条件「本轮阶段已通过」的成功叙事
				h("p", { className: "hint" }, stats ? stats.total + " 项门禁：" + stats.pass + " 通过 / " + stats.fail + " 未通过"
					+ (stats.total - stats.pass - stats.fail > 0 ? " / " + (stats.total - stats.pass - stats.fail) + " 未记录" : "")
					: evidenceState(run, "P11", tree.find(file => file.path === "11-eval-report.json"))), h(ResourceNotice, { resource: evaluation }), h(ResourceNotice, { resource: description }),
				h("article", { className: "studio-delivery-prose" }, description.value != null ? h(ArtifactContent, { path: "10-pr-description.md", text: description.value }) : h(EmptyState, { title: "PR 说明尚未生成" })));
		}
		function DeliverySummaryPanel({ run, tree, slug, runId, onFile }) {
			return h("div", { className: "studio-stack" },
				h("div", { className: "studio-row wrap" }, h("h2", { className: "studio-grow" }, "全流程验证汇总"), h("span", { className: "hint" }, "跨阶段内容 · 不属于 P11 单一节点")),
				[["补丁应用", "P7", "ledger/patch-ledger.jsonl"], ["测试验证", "P8", "07-test-report.json"], ["代码审查", "P9", "08-review-report.json"]].map(([title, stage, path]) => h(RunReportCard, { title, stage, path, key: stage, run, tree, slug, runId, onFile })));
		}
		function ReadableValue({ value, depth = 0 }) {
			if (value == null) return h("span", { className: "muted" }, "未记录");
			if (typeof value !== "object") return h("span", { className: "studio-path" }, String(value));
			if (depth > 2) {
				const count = Array.isArray(value) ? value.length : Object.keys(value).length;
				return h("details", { className: "studio-json-fold" },
					h("summary", null, "展开 " + count + " 项"),
					h(ReadableValue, { value, depth: depth + 1 }));
			}
			if (Array.isArray(value)) return h("ul", null, value.slice(0, 60).map((item, i) => h("li", { key: i }, h(ReadableValue, { value: item, depth: depth + 1 }))));
			const names = { phenomenon: "现象", trigger: "触发条件", risk_level: "风险等级", candidates: "候选文件", hypotheses: "根因假设", verification: "验证方式", title: "标题", summary: "总结", scope: "影响范围", symptom: "现象", symptoms: "现象", root_cause: "根因", hypothesis: "假设", evidence: "证据", confidence: "置信度", path: "文件", reason: "说明", success_criteria: "通过条件", constraints: "约束", risk: "风险", deps: "依赖", input: "输入", output: "输出", status: "状态", verdict: "审查结论", passed: "测试通过", exitCode: "退出码", command: "测试命令", diff_scope: "变更范围", api_safety: "API 与安全", test_coverage: "测试覆盖" };
			return h("div", { className: "kv" }, Object.entries(value).slice(0, 40).map(([key, item]) => h(React.Fragment, { key },
				h("span", { className: "k" }, names[key] || key), h("div", { className: "v" }, h(ReadableValue, { value: item, depth: depth + 1 })))));
		}
		function StageResult(p) {
			const candidates = stageFiles(p.stage, p.tree, p.run).filter(file => !/\/task|task\.md$|\.log$|\.jsonl$/.test(file.path));
			const file = candidates.find(file => file.path === p.run?.stages?.[p.stage]?.artifact) || candidates[0];
			const resource = useRunArtifact(p.slug, p.runId, file?.path, p.tree);
			const parsed = parseJson(resource.value);
			const nodes = Array.isArray(parsed?.nodes) ? parsed.nodes.filter(node => node && typeof node === "object") : null;
			const text = value => value == null ? "" : Array.isArray(value) ? value.map(text).join("、") : typeof value === "object" ? JSON.stringify(value) : String(value);
			return h("div", { className: "studio-stack" }, h(ResourceNotice, { resource }),
				!file ? h(EmptyState, { title: "本阶段尚未生成结果" }, h("p", null, "执行结果生成后会显示在这里，过程事件可在下方查看。")) :
				resource.value == null ? null : /\.md$/.test(file.path) ? h(ArtifactContent, { text: resource.value, path: file.path }) :
				p.stage === "P5" && nodes ? h("div", null, h("p", { className: "hint" }, nodes.length + " 项任务，按依赖关系安排执行。"),
					nodes.map((node, i) => h("article", { className: "studio-plan-item", key: String(node.id || i) },
						h("span", { className: "mono hint" }, text(node.id)), h("div", null, h("h3", null, text(node.title) || "任务"),
							node.success_criteria ? h("p", null, text(node.success_criteria)) : null,
							h("div", { className: "studio-plan-tags" }, node.output ? h("span", null, "输出 · " + text(node.output)) : null,
								h("span", null, Array.isArray(node.deps) && node.deps.length ? "依赖 " + text(node.deps) : "无前置依赖"),
								node.risk ? h("span", null, ({ low: "低风险", medium: "中风险", high: "高风险" })[node.risk] || text(node.risk)) : null),
							node.input ? h("details", { className: "hint" }, h("summary", null, "输入依据"), h(ReadableValue, { value: node.input })) : null))),
					parsed.review_gates || parsed.pr_gate ? h("div", { className: "callout acc" }, h(ReadableValue, { value: { ...(parsed.review_gates ? { "复核门": parsed.review_gates } : {}), ...(parsed.pr_gate ? { "PR 门": parsed.pr_gate } : {}) } })) : null) :
				parsed && typeof parsed === "object" ? h(ReadableValue, { value: parsed }) : h(ArtifactContent, { text: resource.value, path: file.path }),
				file ? studioButton("查看结果文件", () => p.onFile(file.path), "ghost sm") : null);
		}
		function OutputPanel({ text = "", resource, full, onFull, label, memoryKey, filename, toast, onFile, partial = false }) {
			const [search, setSearch] = React.useState("");
			const [follow, setFollow] = usePreference(memoryKey + ".follow", true);
			const [wrap, setWrap] = usePreference(memoryKey + ".wrap", true);
			const [expanded, setExpanded] = React.useState(false);
			const ref = React.useRef(null), expandButton = React.useRef(null), returnFocus = React.useRef(false);
			React.useLayoutEffect(() => { if (!expanded && returnFocus.current) { expandButton.current?.focus(); returnFocus.current = false; } }, [expanded]);
			const lines = String(text).split("\n"), query = search.toLowerCase();
			const searchSource = query && full && full.value != null ? String(full.value) : null;
			const searchLines = searchSource !== null ? searchSource.split("\n") : lines;
			const filtered = query ? searchLines.filter(line => line.toLowerCase().includes(query)) : lines;
			const errorLine = /(error|failed|fatal|失败|✖|exit code [1-9]|exit [1-9]\b)/i;
			const visibleLines = text ? (query ? filtered : lines.slice(-600)) : null;
			React.useLayoutEffect(() => { if (!search && ref.current) ref.current.scrollTop = readPreference(memoryKey + ".scroll", 0); }, [memoryKey, expanded, !!search]);
			React.useEffect(() => { if (follow && !search && ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [text, follow, search, expanded]);
			React.useEffect(() => { if (query && onFull) onFull(); }, [!!query]);
			const content = h("div", { className: "studio-terminal-shell" },
				h("div", { className: "studio-terminal-head studio-row" }, h("span", { className: "studio-grow" }, label), h("button", { ref: expandButton, onClick: () => { returnFocus.current = true; setExpanded(!expanded); } }, expanded ? "还原" : "放大")),
				h("div", { className: "studio-terminal-tools studio-row" },
					h("input", { type: "search", value: search, placeholder: "搜索输出", "aria-label": "搜索日志", onChange: e => setSearch(e.target.value) }),
					h("button", { onClick: () => setWrap(!wrap), "aria-pressed": wrap }, "换行"),
					h("button", { onClick: () => setFollow(!follow) }, follow ? "暂停跟随" : "恢复跟随"),
					h("button", { onClick: () => copyStudio(text, toast), disabled: !text }, "复制日志"),
					h("button", { onClick: () => downloadStudio(filename, text), disabled: !text }, partial ? "下载已读内容" : "下载日志"),
					search ? h("span", null, filtered.length + " 行匹配") : null),
				h("div", { className: "studio-terminal" + (wrap ? " wrapped" : ""), ref, role: "log", tabIndex: 0, "aria-label": label,
					onScroll: e => { const node = e.currentTarget; if (!search) { writePreference(memoryKey + ".scroll", node.scrollTop); if (node.scrollHeight - node.scrollTop - node.clientHeight > 40) setFollow(false); } } },
					visibleLines ? visibleLines.map((line, i) => errorLine.test(line) ? h("div", { key: i, className: "bad" }, line) : h("div", { key: i }, line))
							: query ? "没有匹配输出" : resource?.error ? "输出暂不可读取" : "尚未记录输出"),
				h("div", { className: "studio-terminal-foot studio-row wrap" }, h("span", { className: "studio-grow" },
					partial ? "文件超过预览上限，仅显示尾部最近内容；复制/下载为该部分"
						: query ? (full && full.loading ? "正在加载全量日志…" : "匹配 " + filtered.length + " / 共 " + searchLines.length + " 行" + (searchSource !== null ? " · 全量" : ""))
						: text ? "共 " + lines.length + " 行 · 显示最近 600 行" : "尚无输出；开始执行后这里会显示日志"),
					onFile ? h("button", { onClick: onFile }, "查看源文件") : null));
			return h(React.Fragment, null, resource ? h(ResourceNotice, { resource }) : null,
				expanded ? h(StudioDialog, { title: label, wide: true, onClose: () => setExpanded(false) }, content) : content);
		}
		function executionItems(run, report) {
			const tasks = Array.isArray(report?.tasks) ? report.tasks : Array.isArray(report?.patches) ? report.patches.map(item => ({ ...item, status: "patched" })) : [];
			// An external invocation executes the task graph as a whole; its nodes are not separate CLI sessions.
			if (run.externalExec) return [{ ...run.externalExec, id: "external", title: run.externalExec.executor === "claude-code" ? "Claude Code" : "DSH 原生智能体", external: true }];
			const valid = tasks.filter(item => item && typeof item === "object");
			return valid.map((item, index) => ({ ...item, patch: executionPatchPath(item.patch),
				id: String(item.node || "record") + (valid.filter(other => other.node === item.node).length > 1 || !item.node ? "#" + index : ""),
				title: String(item.node || "任务 " + (index + 1)) + (item.file ? " · " + item.file : "") }));
		}
		function instanceStatus(value) {
			return ({ patched: "已生成补丁", no_change: "无需修改", failed: "失败", running: "执行中", done: "执行结束", stopped: "已停止", skipped: "未启动" })[value] || "结果已记录";
		}
		// 委外 agent 日志：stream-json 帧逐条美化（只格式化，不做语义映射）；非 JSON 行原样保留。
		function formatAgentLog(text) {
			return String(text || "").split("\n").map(line => {
				const t = line.trim();
				if (!t.startsWith("{")) return line;
				try {
					const frame = JSON.parse(t);
					if (frame.type === "system" && frame.subtype && frame.subtype !== "init") return null; // 纯遥测帧（计数心跳）滤噪
					return JSON.stringify(frame, null, 2);
				} catch { return line; }
			}).filter((line) => line !== null).join("\n");
		}
		function ExecutionsPanel(p) {
			const [filter, setFilter] = React.useState("all"), [search, setSearch] = React.useState("");
			const [view, setView] = usePreference("i2p.execution-view." + p.slug + "/" + p.runId, "output");
			const externalLog = useRunArtifact(p.slug, p.runId, "06-implementation/external-exec.log", p.tree, "tail"); // 委外日志常超限，尾部读取（原始保真）
			const agentTimeline = useRunArtifact(p.slug, p.runId, "06-implementation/external-exec.timeline.log", p.tree); // 写入时已格式化的人读时间线
			const [agentFullSearch, setAgentFullSearch] = React.useState(false);
			const agentTimelineFull = useRunArtifact(p.slug, p.runId, agentFullSearch ? "06-implementation/external-exec.timeline.log" : null, p.tree, "full"); // 搜索时才加载全量
			const sessionTask = useRunArtifact(p.slug, p.runId, "06-implementation/session-task.md", p.tree); // 交给外部 agent 的任务包（输入）
			const [inputOpen, setInputOpen] = React.useState(false);
			const hasSessionTask = p.tree.some(file => file.path === "06-implementation/session-task.md");
			const report = parseJson(p.coder.value), items = executionItems(p.run, report);
			const selected = items.find(item => item.id === p.selection);
			const filtered = items.filter(item => (filter === "all" || (filter === "done" ? ["done", "patched", "no_change"].includes(item.status) : item.status === filter))
				&& [item.title, item.reason, item.patch, item.executor].join(" ").toLowerCase().includes(search.toLowerCase()));
			const files = stageFiles("P6", p.tree, p.run).filter(file => !selected || selected.external || selected.patch === file.path);
			const rawTail = externalLog.value != null ? formatAgentLog(externalLog.value) : null;
			const timelineDisplay = agentTimeline.value != null
				? agentTimeline.value.split("\n")
					.filter(l => l.trim() && !/^(\d{2}:\d{2}:\d{2}\|)?raw\|(=== |bin=|permission=|auth=|--- )/.test(l.trim()))
					.join("\n\n")
				: null;
			const output = selected?.external
				? (timelineDisplay != null ? timelineDisplay : rawTail != null ? rawTail : p.eventsText)
				: "此执行报告未记录独立实例输出。返回全部实例可查看阶段事件。";
			const logPath = selected?.external && externalLog.value != null ? "06-implementation/external-exec.log" : "trace/events.jsonl";
			// 最终回复：优先时间线的 result 行，回退原始日志的 result 帧
			const finalReply = (() => {
				if (!selected?.external) return null;
				const outLines = String(output).split("\n");
				for (let i = outLines.length - 1; i >= 0; i--) {
					const m = /^\d{2}:\d{2}:\d{2}\|result\|(.+)$/.exec(outLines[i]);
					if (m && m[1].trim()) return m[1];
				}
				for (let i = outLines.length - 1; i >= 0; i--) {
					try { const f = JSON.parse(outLines[i]); if (f.type === "result" && f.result) return String(f.result).slice(0, 500); } catch { /* 继续扫 */ }
				}
				return null;
			})();
return h("div", { className: "studio-stack" }, h(ResourceNotice, { resource: p.coder }),
				selected ? h(React.Fragment, null,
					h("div", { className: "studio-row studio-execution-head wrap" }, studioButton("← 全部实例", () => p.onSelect(""), "ghost sm"),
						h("h2", null, selected.title),
						h("nav", { className: "studio-execution-tabs", "aria-label": "实例视图" }, [["output", "执行输出"], ["checks", "本实例检查"], ["artifacts", "本实例产物"]].map(([id, label]) => h("button", { key: id, className: view === id ? "on" : "", onClick: () => setView(id) }, label))),
						hasSessionTask ? studioButton("输入 · 任务包", () => setInputOpen(true), "ghost sm") : null),
					h("div", { className: "studio-row wrap" }, h("span", { className: "tg " + (selected.status === "failed" ? "t-err" : selected.status === "running" ? "t-acc" : "t-off") }, instanceStatus(selected.status)),
						h("span", { className: "hint studio-path studio-grow" }, selected.external ? [selected.sessionId ? "会话 " + selected.sessionId : "", selected.startedAt ? "开始 " + fmtTime(selected.startedAt) : "", selected.exitCode != null ? "退出码 " + selected.exitCode : ""].filter(Boolean).join(" · ") : selected.reason)),
					view === "checks" ? h("div", { className: "studio-stack" }, h("h3", null, "执行报告"),
						h(ReadableValue, { value: selected.external ? { status: instanceStatus(selected.status), reason: selected.error || selected.stats?.result || "未记录独立检查结论" } : { status: instanceStatus(selected.status), reason: selected.reason || "未记录说明" } }),
						h("p", { className: "hint" }, "实例执行结果不代表任务回归或最终验收通过。"), studioButton("查看原始报告", () => p.onFile("06-implementation/coder-report.json"), "ghost sm", p.coder.value == null)) :
					view === "artifacts" ? h("div", { className: "studio-stack" }, files.length ? files.map(file => studioButton(file.path, () => p.onFile(file.path), "ghost sm")) : h("p", { className: "hint" }, "尚无明确归属到本实例的文件。")) :
						h(OutputPanel, { key: selected.id, text: output, resource: selected.external ? (agentTimeline.value != null ? null : externalLog) : null, full: { value: agentTimelineFull.value, loading: agentFullSearch && agentTimelineFull.value == null && !agentTimelineFull.error }, onFull: () => setAgentFullSearch(true), label: selected.external && (agentTimeline.value != null || externalLog.value != null) ? selected.title + " · 执行输出" : selected.external ? "阶段调用事件" : "实例输出记录", memoryKey: p.outputKey + "." + selected.id, filename: p.runId + "-P6-" + selected.id + ".log", toast: p.toast,
						partial: p.tree.find(file => file.path === logPath)?.size > 200 * 1024, onFile: selected.external ? () => p.onFile(logPath) : undefined }),
					finalReply ? h("div", { className: "studio-final-reply" }, h("h3", null, "最终回复"), h("p", null, finalReply)) : null) :
				h(React.Fragment, null,
					h("div", { className: "studio-execution-filters" },
						h("div", { className: "studio-segmented" }, [["all", "全部"], ["running", "执行中"], ["done", "完成"], ["failed", "失败"]].map(([id, label]) =>
							h("button", { key: id, className: filter === id ? "on" : "", onClick: () => setFilter(id) }, label + " " + items.filter(item => id === "all" || (id === "done" ? ["done", "patched", "no_change"].includes(item.status) : item.status === id)).length))),
						h("input", { className: "f-input", placeholder: "搜索实例或文件", "aria-label": "搜索执行实例", value: search, onChange: e => setSearch(e.target.value) })),
					filtered.length ? h("div", null, filtered.map(item => h("button", { key: item.id, className: "studio-execution-row", onClick: () => p.onSelect(item.id) },
						h("strong", null, item.title, h("small", null, item.external ? "外部会话" : "任务节点结果")), h("span", null, item.reason || item.error || (item.external ? "执行整个任务图" : item.patch || "结果报告")),
						h("span", null, h("span", { className: "tg " + (item.status === "failed" ? "t-err" : item.status === "running" ? "t-acc" : "t-off") }, instanceStatus(item.status)), h("small", null, stageFiles("P6", p.tree, p.run).filter(file => item.external || item.patch === file.path).length + " 个产物")), Ic("right", 14)))) :
						h("p", { className: "hint" }, items.length ? "没有匹配实例" : "尚无实例结果报告；阶段事件可在「执行日志」页签查看。")),
				h("p", { className: "hint" }, "展示已有执行记录；未记录的实例生命周期与历史轮次不可用。"),
				inputOpen ? h(StudioDialog, { title: "输入 · 任务包", wide: true, onClose: () => setInputOpen(false) }, sessionTask.value != null ? h(ArtifactContent, { text: sessionTask.value, path: "06-implementation/session-task.md" }) : h("p", { className: "hint" }, "任务包未生成")) : null);
		}
		function PatchPreview(p) {
			const patches = p.tree.filter(file => /\.(diff|patch)$/.test(file.path));
			const startedAt = Date.parse(p.run?.stages?.P6?.startedAt || "");
			const current = Number.isFinite(startedAt) ? patches.filter(file => file.mtimeMs >= startedAt) : [];
			const stale = patches.length - current.length;
			const [selected, setSelected] = React.useState("");
			const path = current.some(file => file.path === selected) ? selected : current[0]?.path;
			const content = useRunArtifact(p.slug, p.runId, path, p.tree);
			if (!patches.length) return null;
			const diffLines = content.value ? String(content.value).split("\n") : null;
			const patchStat = diffLines ? diffLines.filter(line => line.startsWith("diff --git ")).length + " 文件 · +" + diffLines.filter(line => /^\+[^+]/.test(line)).length + " −" + diffLines.filter(line => /^-[^-]/.test(line)).length : "";
			return h("section", null, h("div", { className: "studio-row wrap" }, h("h2", { className: "studio-grow" }, "变更文件"), patchStat ? h("span", { className: "hint" }, patchStat) : null, path ? studioButton("查看文件", () => p.onFile(path), "ghost sm") : null),
				stale > 0 ? h("p", { className: "hint" }, "另有 " + stale + " 个上一轮补丁文件仍保留在产物中，已不作为本轮验证依据。") : null,
				current.length ? h("select", { className: "f-select", "aria-label": "选择补丁", value: path, onChange: e => setSelected(e.target.value) }, current.map(file => h("option", { key: file.path, value: file.path }, file.path)))
					: h(EmptyState, { title: stale ? "本轮尚未生成补丁" : "尚未生成补丁" }, stale ? h("p", { className: "hint" }, "上一轮补丁可在文件页查看，但不代表本轮结果。") : null),
				h(ResourceNotice, { resource: content }), path ? h(DiffContent, { path, text: content.value }) : null);
		}
		function RunsPanel(p) {
			const key = p.slug + "/" + p.runId;
			// v9 隔离规则：节点选择不跨访问记忆——每次进入默认当前阶段（执行中）/最后节点（已完成），
			// 默认跟随推进；手动选择即暂停跟随（流程展开后底部显示"已偏离"，点击返回并恢复）。页签只保留 执行过程 / 全部产物。
			const [stage, setStage] = React.useState(p.run?.current || "P1");
			const [storedTab, setTab] = usePreference("i2p.tasktab." + key, "process");
			const tab = storedTab === "files" ? "files" : "process";
			const [trackOpen, setTrackOpen] = usePreference("i2p.track." + key, false);
						const [followStage, setFollowStage] = React.useState(true);
			const [path, setPath] = React.useState("");
			const [returnTo, setReturnTo] = usePreference("i2p.file-return." + key, { tab: "process", stage, instance: "" });
			const [comment, setComment] = React.useState("");
			const [busy, setBusy] = React.useState(false), [contextOpen, setContextOpen] = React.useState(false);
			const [instance, setInstance] = usePreference("i2p.instance." + key, "");
			const [nodeTab, setNodeTab] = React.useState("");
			const [rerunStage, setRerunStage] = React.useState(p.run?.current || "P1");
			// 二期 S5：••• 操作菜单改为受控 details——Esc 关闭、点击外部关闭（关闭态原生不可聚焦已实测确认）
			const [actionsOpen, setActionsOpen] = React.useState(false);
			const actionsRef = React.useRef(null);
			React.useEffect(() => {
				if (!actionsOpen) return undefined;
				const menu = actionsRef.current;
				const onDoc = e => { if (menu && !menu.contains?.(e.target)) setActionsOpen(false); };
				const onKey = e => { if (e.key === "Escape") { e.stopPropagation(); setActionsOpen(false); menu?.querySelector?.("summary")?.focus?.(); } };
				document.addEventListener("click", onDoc);
				document.addEventListener("keydown", onKey);
				return () => { document.removeEventListener("click", onDoc); document.removeEventListener("keydown", onKey); };
			}, [actionsOpen]);
			const busyRef = React.useRef(false), alive = React.useRef(true);
			const events = useRunArtifact(p.slug, p.runId, "trace/events.jsonl", p.tree);
			const ledger = useRunArtifact(p.slug, p.runId, "ledger/patch-ledger.jsonl", p.tree);
			const coder = useRunArtifact(p.slug, p.runId, "06-implementation/coder-report.json", p.tree);
			const description = useRunArtifact(p.slug, p.runId, "10-pr-description.md", p.tree);
			const evaluation = useRunArtifact(p.slug, p.runId, "11-eval-report.json", p.tree);
			const testOutput = useRunArtifact(p.slug, p.runId, "08-test-output.txt", p.tree);
			React.useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
			React.useEffect(() => { if (followStage && p.run?.current) { setStage(p.run.current); setInstance(""); } }, [p.run?.current, followStage]);
			React.useEffect(() => { setComment(""); }, [stage, p.run?.current, p.run?.stages?.[p.run?.current]?.attempts]);
			const activeStage = STAGES.some(item => item.id === stage) ? stage : p.run?.current || "P1";
			React.useEffect(() => { setNodeTab(""); }, [activeStage]);
			const selectStage = id => { setStage(id); setInstance(""); setTab("process"); setFollowStage(false); };
			const openFile = file => { setReturnTo({ tab, stage: activeStage, instance }); setPath(file); setTab("files"); };
			const returnFromFile = () => { setStage(returnTo.stage); setInstance(returnTo.instance || ""); setTab(returnTo.tab === "files" ? "process" : returnTo.tab); };
			const act = async (action, body = {}, method = "POST") => {
				if (busyRef.current) return;
				busyRef.current = true; setBusy(true);
				try {
					const result = method === "DELETE" ? await apiDelete("/projects/" + p.slug + "/runs/" + p.runId) : await apiPost("/projects/" + p.slug + "/runs/" + p.runId + "/" + action, body);
					if (!result?.ok) throw new Error(result?.message || "操作失败");
					if (!alive.current) return;
					p.toast(result.message || "操作成功"); setComment(""); if (method === "DELETE") p.onDeleted(); else p.onChanged();
				} catch (error) { if (alive.current) p.toast(error.message, "bad"); }
				finally { busyRef.current = false; if (alive.current) setBusy(false); }
			};
			if (!p.run) return h(EmptyState, { title: p.error ? "任务读取失败" : "正在读取任务…" });
			const run = p.run, tree = p.tree || [], state = run.stages?.[activeStage], current = run.stages?.[run.current];
			const execConfig = run.executionConfig;
			const files = stageFiles(activeStage, tree, run), reviews = tree.filter(file => file.path.startsWith("reviews/"));
			const report = parseJson(coder.value), instances = Array.isArray(report?.tasks) ? report.tasks : Array.isArray(report?.patches) ? report.patches : [];
			const currentInstance = activeStage === "P6" && executionItems(run, report).some(item => item.id === instance) ? instance : "";
			const externalReady = !["session", "claude", "dsh"].includes(run.p6Mode) || run.externalExec?.status === "done" || !!run.externalProgress?.report || run.externalProgress?.patches > 0;
			const reviewContext = tab === "process" && activeStage === run.current && !currentInstance;
			const reviewReady = reviewContext && run.status === "awaiting_review" && current?.status === "awaiting_review" && (run.current !== "P6" || externalReady);
			const backCurrent = () => { setStage(run.current); setInstance(""); setTab("process"); setFollowStage(true); };
			const review = decision => {
				if (!reviewContext) { p.toast("请先返回当前阶段的复核对象", "bad"); return; }
				if (decision === "approve" && !reviewReady) { p.toast("等待当前阶段产物就绪", "bad"); return; }
				if (decision === "reject" && !comment.trim()) { p.toast("打回需要填写复核意见", "bad"); return; }
				act("review", { decision, comment, expectedStage: run.current, expectedStatus: run.status, expectedAttempt: current?.attempts || 0, expectedStartedAt: current?.startedAt || null });
			};
			const mainFlow = STAGES.filter(item => !item.bypass), done = mainFlow.filter(item => ["approved", "completed"].includes(run.stages?.[item.id]?.status)).length;
			const records = parseLines(events.value).filter(event => event.stage === activeStage);
			const eventsText = records.map(event => [fmtClock(event.at), event.kind, event.name, event.detail].filter(Boolean).join("  ")).join("\n");
			const stageUntouched = (state?.status || "pending") === "pending" && !files.length && !records.length;
			const stageTimes = {};
			for (const ev of parseLines(events.value)) {
				const ts = Date.parse(ev.at);
				if (!Number.isFinite(ts)) continue;
				const span = stageTimes[ev.stage] || (stageTimes[ev.stage] = { min: ts, max: ts });
				span.min = Math.min(span.min, ts);
				span.max = Math.max(span.max, ts);
			}
			const fmtDuration = ms => {
				const sec = Math.max(0, Math.round(ms / 1000));
				if (sec < 60) return sec + " 秒";
				const min = Math.floor(sec / 60);
				return min < 60 ? min + " 分 " + (sec % 60) + " 秒" : Math.floor(min / 60) + " 小时 " + (min % 60) + " 分";
			};
			const stageDurationText = id => stageTimes[id] ? "耗时 " + fmtDuration(stageTimes[id].max - stageTimes[id].min) : "";
			// 阶段运行信息：模型取启动快照的阶段覆盖，未配置回落 defaultRoute；执行器按阶段语义展示（P7/P8 不走模型）
			const runtimeModelOf = id => {
				const override = execConfig?.stageConfig?.[id];
				if (override?.provider && override?.model) return override.model;
				return execConfig?.defaultRoute?.model || null;
			};
			// 阶段运行方式：外部 Agent 执行显示委托方式（不显示模型），内置显示模型，P7/P8 无模型
			const stageRunTextOf = id => {
				if (id === "P7") return "补丁管线 · 无模型调用";
				if (id === "P8") return "测试执行" + (execConfig?.testCommand ? " · " + execConfig.testCommand : "");
				const override = execConfig?.stageConfig?.[id];
				const modelText = override?.provider && override?.model
					? "模型 " + override.model + "（阶段覆盖）"
					: runtimeModelOf(id) ? "模型 " + runtimeModelOf(id) : "模型 宿主默认";
				if (id === "P6") {
					if (["session", "claude", "dsh"].includes(run.p6Mode)) return p6ModeLabel(run.p6Mode);
					return "内置多智能体 · " + modelText;
				}
				return modelText;
			};
			const runtimeText = [
				...(!stageUntouched ? ["第 " + ((state?.attempts || 0) + 1) + " 轮", stageTimes[activeStage] ? stageDurationText(activeStage) : null] : []),
				stageRunTextOf(activeStage),
			].filter(Boolean).join(" · ");
			const p10File = tree.some(file => file.path === "09-failure-analysis.json");
			const outputKey = "i2p.output." + key + "." + activeStage + "." + (state?.attempts || 0) + "." + (state?.startedAt || "");
			const stageDef = STAGES.find(item => item.id === activeStage);
			// v9 规则：未触及的节点（pending 且没有任何事件与产物）只显示一条等待空态，不渲染零内容区块。
			const tabs = [["process", "执行过程"], ["files", "全部产物"]];
			// 方案三：节点内容盘点置顶为子页签（带计数），没有内容的区块不出页签（留空规则）。
			const allPatches = tree.filter(file => /\.(diff|patch)$/.test(file.path));
			const p6StartedAt = Date.parse(run.stages?.P6?.startedAt || "");
			const currentPatches = Number.isFinite(p6StartedAt) ? allPatches.filter(file => file.mtimeMs >= p6StartedAt) : [];
			const nodeTabs = [];
			if (activeStage === "P6") nodeTabs.push(["instances", "执行实例"]);
			else if (activeStage === "P7") nodeTabs.push(["result", "补丁账本"]);
			else if (activeStage === "P11") nodeTabs.push(["delivery", "交付"], ["summary", "全流程汇总"]);
			else nodeTabs.push(["result", "阶段结果"]);
			if (activeStage === "P8" && tree.some(file => file.path === "08-test-output.txt")) nodeTabs.push(["testout", "测试输出"]);
			if (activeStage === "P6" && allPatches.length) nodeTabs.push(["patches", "变更文件 " + currentPatches.length]);
			if (records.length) nodeTabs.push(["log", "执行日志 " + records.length]);
			if (files.length) nodeTabs.push(["artifacts", "阶段产物 " + files.length]);
			const nodeTabId = nodeTabs.some(item => item[0] === nodeTab) ? nodeTab : nodeTabs[0]?.[0];
			// 二期 S2：P11 门禁存在未通过时，阶段标题绿徽章旁并列警示章，打破「纯成功」叙事
			const p11Gates = activeStage === "P11" ? gateStats(evaluation) : null;
			
			return h("div", { className: "studio-task" },
				h("header", { className: "studio-task-head" },
					// 二期 L-A：面包屑 id 超长自动省略（CSS 170px 上限），title 悬停可见全量
					h("div", { className: "studio-breadcrumb studio-row" }, h("button", { onClick: p.onBack }, "← 任务列表"), "/", h("span", null, p.project?.name || p.slug), "/", h("button", { className: "mono studio-path", title: run.id + " · 点击复制", onClick: () => copyStudio(run.id, p.toast) }, run.id)),
					h("div", { className: "studio-row studio-task-title" }, h("h1", { className: "studio-grow studio-path" }, taskTitle(run)), h(StatusBadge, { status: run.status }),
						["running", "awaiting_review"].includes(run.status) ? studioButton([Ic("stop", 14), "停止"], () => act("stop"), "", busy) : null,
						h("details", { className: "studio-run-actions", open: actionsOpen, onToggle: e => setActionsOpen(e.currentTarget.open), ref: actionsRef }, h("summary", { "aria-label": "更多任务操作" }, "•••"),
							h("div", { className: "studio-action-menu" }, studioButton("任务详情", () => setContextOpen(true), "ghost sm"), run.status !== "running" ? h(React.Fragment, null,
								h("select", { className: "f-select", "aria-label": "重跑起始阶段", value: rerunStage, onChange: e => setRerunStage(e.target.value) }, STAGES.map(item => h("option", { key: item.id, value: item.id }, item.id + " " + STUDIO_STAGE_NAMES[item.id]))),
								studioButton("重跑", () => { if (window.confirm("从 " + rerunStage + " 重跑，后续阶段状态将重置，相关委外旧产物会清理。继续？")) act("rerun", { stage: rerunStage }); }, "", busy)) : null,
							studioButton("删除任务", () => { if (window.confirm("删除此任务及全部产物？此操作不可恢复。")) act("", {}, "DELETE"); }, "danger", busy),
							h("small", { className: "hint" }, "停止后不再推进；当前内置阶段可能仍需执行完毕，外部执行器会收到终止请求。"))))),
					tab !== "files" ? h("section", { className: "studio-topology", "aria-label": "流水线阶段" },
					h("div", { className: "studio-row studio-workflow-summary" }, h("strong", null, run.current + " · " + STUDIO_STAGE_NAMES[run.current]),
						// 二期 M-A1：展开轨道时隐藏折叠小进度条，两种进度展示不叠加
						trackOpen ? null : h("span", { className: "studio-progress", "aria-hidden": true }, mainFlow.map(item => h("i", { key: item.id, className: ["approved", "completed"].includes(run.stages?.[item.id]?.status) ? "done" : run.stages?.[item.id]?.status === "failed" ? "failed" : item.id === run.current ? "current" : "" }))),
						h("span", { className: "hint studio-stage-total" }, done + " / 10 阶段已完成"), h("span", { className: "studio-grow" }),
						h("button", { className: "btn ghost sm", "aria-expanded": trackOpen, onClick: () => setTrackOpen(!trackOpen) }, trackOpen ? "收起流程" : "完整流程")),
					trackOpen ? h(React.Fragment, null, h("nav", { className: "studio-track", "aria-label": "完整阶段流程" }, mainFlow.map(item => {
						const status = run.stages?.[item.id]?.status || "pending";
						const stale = item.id !== "P10" && status === "pending" && stageFiles(item.id, tree, run).length > 0;
							return h("button", { key: item.id, className: "studio-stage " + status + (item.id === activeStage ? " on" : "") + (item.id === run.current ? " current" : ""), title: item.id + " " + STUDIO_STAGE_NAMES[item.id] + "，" + tag(status)[1] + (stageTimes[item.id] ? " · " + stageDurationText(item.id) : "") + " · " + stageRunTextOf(item.id), "aria-label": item.id + " " + STUDIO_STAGE_NAMES[item.id] + "，" + tag(status)[1], "aria-pressed": item.id === activeStage, onClick: () => selectStage(item.id) },
							h("span", { className: "studio-stage-mark" }, ["approved", "completed"].includes(status) ? Ic("check", 13) : status === "failed" ? Ic("x", 13) : status === "awaiting_review" ? "!" : item.id === run.current ? "●" : ""),
							h("strong", null, STUDIO_STAGE_NAMES[item.id]), h("span", { className: "studio-stage-code" }, item.id + (item.id === run.current ? " · 当前" : stale ? " · 待重验" : item.key ? " · 复核" : "")));
					})), h("div", { className: "studio-row studio-track-footer wrap" }, followStage ? h("span", { className: "hint" }, "跟随当前阶段 ✓") : h("button", { onClick: backCurrent, title: "点击返回当前阶段并恢复跟随" }, "正在查看 " + activeStage + " · 返回当前 " + run.current + " →"), h("button", { onClick: () => selectStage("P10") }, "P10 失败分析 · " + (run.failureAnalysis ? "已生成" : p10File ? "历史记录" : "按需触发")))) : null,
					// 二期 M-A4：页面级失败条只保留结论与动作，详细描述留在阶段级错误条，不再重复
					run.failureAnalysis ? h("div", { className: "studio-return-lane studio-row wrap" }, h("span", { className: "studio-grow" }, [run.failureAnalysis.category, run.failureAnalysis.action].filter(value => typeof value === "string").join(" · ")), studioButton("查看失败分析", () => selectStage("P10"), "ghost sm")) : null) : null,
				h("nav", { className: "studio-tabs", "aria-label": "任务视图" }, tabs.map(([id, label]) => h("button", { key: id, className: tab === id ? "on" : "", "aria-current": tab === id ? "page" : undefined, onClick: () => { if (id === "files" && tab !== "files") { setPath(""); setReturnTo({ tab, stage: activeStage, instance }); } setTab(id); } }, label + (id === "files" ? " " + tree.length : "")))),
				// 二期 M-A3：运行元信息降级为页签下方独立次要行，不再与页签同行混排
				tab === "process" && runtimeText ? h("div", { className: "studio-runtime-meta hint" }, runtimeText) : null,
				h("div", { className: "studio-workspace" },
					tab === "files" ? h(ArtifactsPanel, { ...p, instances, initialPath: path, onReturn: returnFromFile }) :
					h("div", { className: "studio-process" }, h("section", { className: "studio-process-main" },
						h("div", { className: "studio-section-heading" }, h("div", { className: "studio-row wrap" }, h("h2", { className: "studio-grow" }, activeStage + " · " + STUDIO_STAGE_NAMES[activeStage]), h(StatusBadge, { status: state?.status }),
							p11Gates?.fail ? h("span", { className: "tg t-warn", title: "交付评测六项门禁存在未通过项，详见交付页" }, Ic("x", 11), p11Gates.fail + " 项门禁未通过") : null,
														nodeTabs.length > 1 && !stageUntouched ? h("nav", { className: "studio-execution-tabs", "aria-label": "节点内容", style: { margin: "0 0 0 auto", alignSelf: "flex-end" } },
								nodeTabs.map(([id, label]) => h("button", { key: id, className: nodeTabId === id ? "on" : "", "aria-pressed": nodeTabId === id, onClick: () => setNodeTab(id) }, label))) : null,
							), state?.error ? h("p", { className: "callout err", style: { marginTop: 10 } }, state.error) : null),
												stageUntouched ? h(EmptyState, { title: activeStage === "P10" ? "目前没有需要分析的失败" : activeStage === run.current ? "本阶段尚未开始执行" : "等待上游阶段完成" },
							h("p", null, activeStage === "P10" ? "P10 在主线阶段失败时触发，帮助定位原因并选择恢复方式。" : (STUDIO_STAGE_NAMES[activeStage] || stageDef?.name || activeStage) + "尚未开始，结果生成后会显示在这里。"),
							stageDef?.art ? h("p", { className: "hint" }, "预期产物：" + stageDef.art) : null) :
						h(React.Fragment, null,
							nodeTabId === "instances" ? h(ExecutionsPanel, { ...p, tree, coder, events, eventsText, outputKey, selection: currentInstance, onSelect: setInstance, onFile: openFile }) :
							nodeTabId === "patches" ? h(PatchPreview, { ...p, tree, onFile: openFile }) :
							nodeTabId === "testout" ? h(OutputPanel, { key: "testout", text: testOutput.value || "", resource: testOutput, label: "P8 · 测试输出", memoryKey: outputKey + ".testout", filename: p.runId + "-P8-output.txt", toast: p.toast, onFile: () => openFile("08-test-output.txt"), partial: tree.find(file => file.path === "08-test-output.txt")?.size > 200 * 1024 }) :
							nodeTabId === "log" ? h(OutputPanel, { key: outputKey, text: eventsText, resource: events, label: activeStage + " · 阶段事件", memoryKey: outputKey, filename: p.runId + "-" + activeStage + ".log", toast: p.toast, onFile: () => openFile("trace/events.jsonl"), partial: tree.find(file => file.path === "trace/events.jsonl")?.size > 200 * 1024 }) :
							nodeTabId === "artifacts" ? h("div", { className: "studio-artifacts" },
								(() => {
									const groups = new Map();
									for (const file of files) {
										const parts = file.path.split("/");
										const dir = parts.length > 1 ? parts.slice(0, -1).join("/") : "";
										if (!groups.has(dir)) groups.set(dir, []);
										groups.get(dir).push(file);
									}
									return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([dir, list]) =>
										h("div", { className: "studio-artifacts-group", key: dir },
											dir ? h("div", { className: "studio-artifacts-dir" }, Ic("folder", 14), dir) : null,
											list.map(file => studioButton([Ic("file", 15), file.path.split("/").at(-1)], () => openFile(file.path), "ghost sm"))));
								})()) :
							nodeTabId === "delivery" ? h(DeliveryPanel, { run, tree, description, evaluation, toast: p.toast }) :
							nodeTabId === "summary" ? h(DeliverySummaryPanel, { run, tree, slug: p.slug, runId: p.runId, onFile: openFile }) :
							activeStage === "P7" ? h("div", { className: "studio-stack" }, h(ResourceNotice, { resource: ledger }),
							parseLines(ledger.value).length ? parseLines(ledger.value).map(row => h("div", { className: "studio-row wrap studio-check", key: row.lineNo }, h("span", { className: "studio-grow studio-path" }, "#" + row.lineNo + " " + (row.patch || "回滚 #" + row.rollbackOf)),
								row.rollbackOf == null ? studioButton("回滚", () => { if (window.confirm("仅撤销账本 #" + row.lineNo + " 对应的补丁，并追加回滚记录？")) act("rollback", { lineNo: row.lineNo }); }, "sm danger", busy || ["running", "awaiting_review"].includes(run.status) || parseLines(ledger.value).some(item => item.rollbackOf === row.lineNo)) : null)) : h(EmptyState, { title: "尚无补丁应用记录" })) :
								h(StageResult, { ...p, stage: activeStage, onFile: openFile }))))),

				run.status === "awaiting_review" ? h("footer", { className: "studio-review" }, reviewContext ? h("div", { className: "studio-row wrap" },
					h("div", null, h("strong", null, run.current + " 等待复核"), h("div", { className: "hint" }, (() => {
							const next = STAGES.slice(STAGES.findIndex(item => item.id === run.current) + 1).find(item => !item.bypass);
							return (REVIEW_QUESTIONS[run.current] || "确认当前阶段结果") + (next ? "；通过后进入 " + next.id + " · " + STUDIO_STAGE_NAMES[next.id] : "；通过后任务完成");
						})())),
					h("input", { className: "f-input studio-grow", value: comment, "aria-label": "复核意见", placeholder: "复核意见（打回必填）", onChange: e => setComment(e.target.value) }),
					studioButton("打回", () => review("reject"), "danger", busy), studioButton("通过 " + run.current + " 并继续", () => review("approve"), "pri", busy || !reviewReady), !reviewReady ? h("span", { className: "hint" }, "等待外部产物就绪") : null)
					: h("div", { className: "studio-row wrap" }, h("span", { className: "studio-grow hint" }, "当前正在查看其他内容；" + run.current + " 的阶段汇总等待复核。"), studioButton("返回当前复核对象", backCurrent, "pri"))) : null,
				contextOpen ? h(StudioDialog, { title: "任务详情", wide: true, onClose: () => setContextOpen(false) }, h("div", { className: "studio-stack" },
					h("div", { className: "kv" }, kvRow("项目", p.project?.name || p.slug), kvRow("任务编号", run.id, true), kvRow("来源", run.trigger?.uri || "—", true), kvRow("创建时间", fmtTime(run.createdAt)), kvRow("复核方式", reviewModeLabel(run.reviewMode)), kvRow("代码执行器", p6ModeLabel(run.p6Mode))),
					h("p", { className: "hint" }, run.executionConfig ? "使用启动配置 v" + run.executionConfig.revision + " · 默认模型 " + (run.executionConfig.defaultRoute?.model || "未记录") : "历史任务未记录配置快照，兼容读取旧项目配置。"),
					run.executionConfig ? h("details", null, h("summary", null, "查看启动配置"), h("pre", { className: "studio-json" }, JSON.stringify(run.executionConfig, null, 2))) : null,
					h("details", null, h("summary", null, "阶段职责与契约"), h(StageContractCard, { stageId: activeStage, defaults: p.defaults }), h(StageGuideCard, { stageId: activeStage, defaults: p.defaults })),
						h("details", null, h("summary", null, "复核历史 · " + reviews.length), reviews.length ? reviews.slice(-20).reverse().map(file => studioButton(file.path.split("/").at(-1), () => { setContextOpen(false); openFile(file.path); }, "ghost sm")) : h("p", { className: "hint" }, "暂无复核记录")),
					studioButton("调整新任务的阶段默认值", () => { setContextOpen(false); p.onConfig(activeStage); }, "ghost"))) : null);
		}

		function GuidePanel() {
			return h("div", { className: "guide" },
				h("p", { className: "lede" },
					"从一条 Issue 到一份可合并 PR 的可验证流水线：11 个阶段逐级推进，每阶段产出结构化产物，",
					"关键门需人工复核，失败自动分类、可回退可回滚。交付物 = 产物 + 测试 + PR 说明，而非一段回答。"),
				h("div", { className: "card" },
					h("h4", null, "五条规则"),
					h("ol", { className: "tight", style: { margin: 0 } },
						h("li", null, h("b", null, "不可跳步"), " — 分析、检索、理解、假设、规划、修改、测试、审查、评测，一步不省。"),
						h("li", null, h("b", null, "可定位"), " — 任何失败都落到具体阶段与错误信息。"),
						h("li", null, h("b", null, "可回滚"), " — Agent 引入的 patch 逐条可逆（P7 ledger）。"),
						h("li", null, h("b", null, "可审查"), " — 每个阶段都有可检查的产物文件。"),
						h("li", null, h("b", null, "可复现"), " — trace/spans.jsonl 记录每阶段耗时与决策。"))),
				h("table", { className: "tbl" },
					h("thead", null, h("tr", null,
						h("th", null, "阶段"), h("th", null, "职责"), h("th", null, "产物"), h("th", null, "复核门"))),
					h("tbody", null,
						STAGES.map(function (s) {
							return h("tr", { key: s.id },
								h("td", null, h("code", null, s.id)),
								h("td", null, s.name, s.bypass ? h("span", { className: "tg t-warn", style: { marginLeft: 6 } }, "失败旁路") : null),
								h("td", null, h("code", null, s.art)),
								h("td", null, s.key ? "是" : "—"));
						}))),
				h("div", { className: "grid-2" },
					h("div", { className: "callout acc" },
						h("h4", null, "复核模式"),
						h("ul", { style: { margin: 0, paddingLeft: 18, fontSize: 13.5 } },
							h("li", null, h("b", null, "每阶段都停"), " — 每阶段产物都等人工通过（默认）"),
							h("li", null, h("b", null, "只停关键门"), " — P5 规划 / P6 代码 / P9 审查 / P11 PR"),
							h("li", null, h("b", null, "全自动"), " — 不停顿，事后仍可打回重跑"))),
					h("div", { className: "callout warn" },
						h("h4", null, "失败怎么办"),
						h("ul", { style: { margin: 0, paddingLeft: 18, fontSize: 13.5 } },
							h("li", null, "阶段失败 → 自动经 P10 写失败分类，然后停住"),
							h("li", null, "「重跑」从任一已到达阶段回退重跑"),
							h("li", null, "P7 ledger 支持逐条回滚单个 patch"))),
					h("div", { className: "callout acc" },
						h("h4", null, "按阶段调参"),
						h("ul", { style: { margin: 0, paddingLeft: 18, fontSize: 13.5 } },
							h("li", null, "「设置 → 阶段提示词」集中管理各阶段与角色；任务详情可以查看启动配置"),
							h("li", null, "可调：提示词 / 模型 / 思考深度 / 超时 / 阶段专属参数（扫描上限、深读数、claude 路径等）/ 委托外部智能体"),
							h("li", null, "可把任一 LLM 阶段委托外部智能体（生成任务包，产出落盘后回复核门）"),
							h("li", null, "留空继承默认；全局设置保存后只影响新任务，已有任务及重跑使用启动配置。无快照的历史任务兼容读取旧项目配置")))),
				h("div", { className: "card" },
					h("h4", null, "数据落盘位置"),
					h("p", { style: { margin: 0 } },
						"项目配置、Run 状态与全部产物都在 ", h("code", { style: { fontFamily: "var(--mono)", background: "var(--hover)", padding: "1px 6px", borderRadius: 4, fontSize: 11.5, color: "var(--ink-2)" } }, "~/.dsh/issue2pr/projects/<slug>/"),
						" 下：", h("code", { style: { fontFamily: "var(--mono)", background: "var(--hover)", padding: "1px 6px", borderRadius: 4, fontSize: 11.5, color: "var(--ink-2)" } }, "project.json"),
						" 配置、", h("code", { style: { fontFamily: "var(--mono)", background: "var(--hover)", padding: "1px 6px", borderRadius: 4, fontSize: 11.5, color: "var(--ink-2)" } }, "runs/<id>/run.json"),
						" 状态、", h("code", { style: { fontFamily: "var(--mono)", background: "var(--hover)", padding: "1px 6px", borderRadius: 4, fontSize: 11.5, color: "var(--ink-2)" } }, "repo/"),
						" 本地克隆。删除项目 / Run 即删除对应目录。")));
		}

		/* ================================================================
		 * 主 Section：左侧导航 + 共享数据 + 3s 轮询
		 * ================================================================ */


		function settingField(label, value, onChange, options = {}) {
			return h("label", { className: "studio-field" }, h("span", null, label),
				options.choices ? h("select", { className: "f-select", value: value ?? "", disabled: options.disabled, onChange: e => onChange(e.target.value) },
					options.choices.map(([key, title]) => h("option", { key, value: key }, title)))
					: h(options.multiline ? "textarea" : "input", { className: "f-input" + (options.multiline ? " studio-prompt-editor" : ""),
						value: value ?? "", type: options.type || "text", placeholder: options.placeholder,
						readOnly: options.readOnly, disabled: options.disabled, min: options.min,
						onChange: e => onChange(e.target.value), autoComplete: options.type === "password" ? "new-password" : undefined }),
				options.hint ? h("small", { className: "hint" }, options.hint) : null);
		}
		const STUDIO_EXECUTORS = [["builtin", "内置多智能体"], ["session", "DSH 人工会话"],
			["claude", "外部 Agent：Claude Code"], ["dsh", "DSH 原生智能体"]];
		const settingsDrafts = new Map();
		function updateStageConfig(project, stage, patch) {
			return { ...project, stageConfig: { ...project.stageConfig,
				[stage]: { ...project.stageConfig?.[stage], ...patch } } };
		}
		function executorSignature(project) {
			const params = project.stageConfig?.P6?.params || {};
			return JSON.stringify([project.p6Mode, params.claudeBin || "", params.claudeAuthPreset || "none", params.claudeBaseUrl || ""]);
		}
		function ProjectDialog(p) {
			const existing = p.projects.find(project => project.slug === p.slug);
			const [form, setForm] = React.useState(() => ({
				name: existing?.name || "", slug: existing?.slug || "",
				repo: typeof existing?.repos?.[0] === "string" ? existing.repos[0] : existing?.repos?.[0]?.uri || "",
				extra: (existing?.repos || []).slice(1).map(repo => typeof repo === "string" ? repo : repo.uri).join("\n"),
				triggers: existing?.triggers || []
			}));
			const [busy, setBusy] = React.useState(false), [error, setError] = React.useState("");
			const lock = React.useRef(false);
			const field = (key, value) => setForm(prev => ({ ...prev, [key]: value }));
			const host = hostOfUri(form.repo);
			const provider = /github/i.test(host) ? "GitHub" : /gitlab/i.test(host) ? "GitLab"
				: /codearts|myhuaweicloud/i.test(host) ? "CodeArts" : isSshUri(form.repo) ? "SSH 仓库" : "Git 仓库";
			const suggested = form.repo.replace(/\.git\/?$/, "").split(/[/:]/).filter(Boolean).at(-1) || "";
			const submit = async e => {
				e.preventDefault(); if (lock.current) return;
				const name = form.name.trim() || suggested, slug = form.slug.trim() || suggested.toLowerCase().replace(/[^a-z0-9-]/g, "-");
				if (!name || !/^[a-z0-9-]+$/.test(slug) || !form.repo.trim()) { setError("请填写仓库地址、项目名称和有效目录名"); return; }
				if (!existing && p.projects.some(project => project.slug === slug)) { setError("项目目录名已存在，请更换"); return; }
				lock.current = true; setBusy(true); setError("");
				try {
					const check = await apiPost("/connections/test-repo", { uri: form.repo.trim() });
					if (!check?.ok) throw new Error(check?.message || "仓库连接失败");
					const result = await apiPost("/projects", { name, slug,
						repos: [form.repo, ...form.extra.split("\n")].map(uri => uri.trim()).filter(Boolean).map(uri => ({ uri })),
						triggers: form.triggers.filter(item => item.uri.trim()) });
					if (!result?.ok) throw new Error(result?.message || "保存失败");
					p.onSaved(slug); p.onClose();
				} catch (error) { setError(error.message); } finally { setBusy(false); lock.current = false; }
			};
			return h(StudioDialog, { title: existing ? "管理项目" : "连接项目", onClose: () => { if (!busy) p.onClose(); } },
				h("form", { className: "studio-stack", onSubmit: submit },
					settingField("Git 仓库地址", form.repo, value => field("repo", value), { disabled: busy, placeholder: "粘贴 HTTPS 或 SSH 克隆地址" }),
					h("div", { className: "studio-provider-note" }, Ic("git", 18), h("span", null, provider + (host ? " · " + host : " · 根据仓库地址自动识别"))),
					settingField("项目名称", form.name, value => field("name", value), { disabled: busy, placeholder: "留空使用 " + (suggested || "仓库名称") }),
					settingField("项目目录名", form.slug, value => field("slug", value), { disabled: busy, readOnly: !!existing,
						placeholder: suggested.toLowerCase(), hint: "小写字母、数字和连字符；用于区分项目，创建后不修改。" }),
					h("p", { className: "hint" }, "HTTPS 按域名匹配“连接与凭据”；SSH 使用 DSH 所在机器的密钥。公开仓库可匿名访问。"),
					h("details", null, h("summary", null, "其他仓库与保存的来源"),
						settingField("其他仓库（每行一个）", form.extra, value => field("extra", value), { multiline: true, disabled: busy }),
						form.triggers.map((trigger, index) => h("div", { className: "studio-row wrap", key: index },
							settingField("来源类型", trigger.kind, value => field("triggers", form.triggers.map((item, pos) => pos === index ? { ...item, kind: value } : item)),
								{ disabled: busy, choices: [["issue", "Issue"], ["requirement", "需求文档"]] }),
							settingField("来源路径", trigger.uri, value => field("triggers", form.triggers.map((item, pos) => pos === index ? { ...item, uri: value } : item)), { disabled: busy }),
							studioButton("移除", () => field("triggers", form.triggers.filter((_, pos) => pos !== index)), "sm", busy))),
						studioButton("添加来源", () => field("triggers", [...form.triggers, { kind: "issue", uri: "" }]), "sm", busy)),
					error ? h("div", { className: "callout err", role: "alert" }, error) : null,
					h("div", { className: "studio-row wrap" }, h("span", { className: "studio-grow hint" }, busy ? "正在检查仓库并保存…" : "保存前执行真实仓库连通性检查"),
						existing ? studioButton("删除项目", async () => {
							if (busy || !window.confirm("删除项目 " + existing.name + " 及其全部任务、产物和本地克隆？不可恢复。")) return;
							setBusy(true);
							try {
								const result = await apiDelete("/projects/" + existing.slug + "?confirm=" + encodeURIComponent(existing.slug));
								if (!result?.ok) throw new Error(result?.message || "删除失败");
								settingsDrafts.delete(existing.slug); p.onDeletedProject();
							} catch (error) { setError(error.message); } finally { setBusy(false); }
						}, "danger sm", busy) : null,
						h("button", { className: "btn pri", disabled: busy }, busy ? "检查中…" : existing ? "检查并保存" : "检查并连接"))));
		}
		function StudioConnections(p) {
			const [draft, setDraft] = React.useState(null), [busy, setBusy] = React.useState(false);
			const [results, setResults] = React.useState({}), [error, setError] = React.useState("");
			const lock = React.useRef(false);
			const execute = async (path, body, callback, method = "POST") => {
				if (lock.current) return;
				lock.current = true; setBusy(true); setError("");
				try {
					const result = method === "DELETE" ? await apiDelete(path) : await apiPost(path, body);
					if (!result?.ok) throw new Error(result?.message || "操作失败");
					callback(result);
				} catch (error) { setError(error.message); }
				finally { setBusy(false); lock.current = false; }
			};
			return h("article", { className: "card" },
				h("div", { className: "studio-row" }, h("h2", { className: "studio-grow" }, "连接与凭据"),
					studioButton("添加连接", () => { setDraft({ kind: "github", host: "github.com", username: "", token: "" }); setError(""); }, "sm")),
				h("p", { className: "hint" }, "同一域名的连接可供多个项目使用。凭据单独保存，不随项目设置草稿保存。"),
				h(ResourceNotice, { resource: p.resource }),
				(p.resource.value || []).map(connection => h("div", { className: "studio-connection", key: connection.id },
					h("div", { className: "studio-row" }, Ic("git", 20), h("div", { className: "studio-grow" },
						h("h3", null, CONN_KIND_META[connection.kind]?.label || connection.kind),
						h("span", { className: "hint" }, connection.host)),
						h("span", { className: "tg" }, results[connection.id] || "已保存，尚未测试")),
					h("p", { className: "hint" }, (connection.username || "未指定账号") + " · " + (connection.token || "未配置令牌")),
					h("p", { className: "hint" }, connection.secretEncrypted ? "操作系统加密存储" : connection.secretWarning || "存储方式：" + connection.secretStorage),
					h("div", { className: "studio-row wrap" },
						studioButton("测试连接", () => execute("/connections/test", { id: connection.id },
							result => setResults(prev => ({ ...prev, [connection.id]: "已验证 " + (result.account || "") }))), "sm", busy),
						studioButton("更新凭据", () => { setDraft({ kind: connection.kind, host: connection.host, username: connection.username || "", token: "" }); setError(""); }, "sm", busy),
						studioButton("移除", () => {
							if (window.confirm("移除此域名的共享连接？相关项目后续访问可能需要重新认证。"))
								execute("/connections/" + encodeURIComponent(connection.id), {}, p.resource.reload, "DELETE");
						}, "sm danger", busy)))),
				!p.resource.value?.length ? h(EmptyState, { title: "尚未配置共享连接" }) : null,
				error && !draft ? h("p", { className: "callout err", role: "alert" }, error) : null,
				draft ? h(StudioDialog, { title: "配置连接", onClose: () => { if (!busy) { setDraft(null); setError(""); } } },
					h("form", { className: "studio-stack", onSubmit: e => { e.preventDefault();
						if (!draft.token.trim()) { setError("请输入新的凭据，已存掩码不能作为凭据提交"); return; }
						execute("/connections", draft, () => { setDraft(null); p.resource.reload(); p.toast("连接已保存"); });
					} },
						settingField("托管平台", draft.kind, kind => setDraft(prev => ({ ...prev, kind, host: CONN_KIND_META[kind]?.host || "" })),
							{ disabled: busy, choices: Object.entries(CONN_KIND_META).map(([key, value]) => [key, value.label]) }),
						settingField("托管域名", draft.host, host => setDraft(prev => ({ ...prev, host })), { disabled: busy }),
						settingField("账号", draft.username, username => setDraft(prev => ({ ...prev, username })), { disabled: busy }),
						settingField(CONN_KIND_META[draft.kind]?.tokenLabel || "访问令牌", draft.token, token => setDraft(prev => ({ ...prev, token })),
							{ type: "password", disabled: busy, hint: "输入新凭据；保存后只显示掩码。" }),
						error ? h("p", { className: "callout err", role: "alert" }, error) : null,
						h("button", { className: "btn pri", disabled: busy }, busy ? "保存中…" : "保存连接"))) : null);
		}
		function StudioSettings(p) {
			const [draft, setDraft] = React.useState(() => settingsDrafts.get("global")?.draft || structuredClone(p.settings));
			const [baseline, setBaseline] = React.useState(() => settingsDrafts.get("global")?.baseline || structuredClone(p.settings));
			const [role, setRole] = React.useState("");
			const [busy, setBusy] = React.useState(false), [error, setError] = React.useState("");
			const [probe, setProbe] = React.useState(null), [probeKey, setProbeKey] = React.useState("");
			const [candidates, setCandidates] = React.useState([]);
			const [relayToken, setRelayToken] = React.useState(""), [relayInfo, setRelayInfo] = React.useState(null);
			const lock = React.useRef(false);
			const signature = executorSignature(draft);
			const dirty = JSON.stringify(draft) !== JSON.stringify(baseline);
			React.useEffect(() => { settingsDrafts.set("global", { draft, baseline }); }, [draft, baseline]);
			React.useEffect(() => {
				const controller = new AbortController();
				readOk("/relay-auth", controller.signal).then(setRelayInfo).catch(error => { if (error.name !== "AbortError") setError(error.message); });
				return () => controller.abort();
			}, []);
			const field = (key, value) => setDraft(prev => ({ ...prev, [key]: value }));
			const stage = p.stage || "P1", definition = p.defaults?.stages?.[stage] || {};
			const config = draft.stageConfig?.[stage] || {}, params = draft.stageConfig?.P6?.params || {};
			const setConfig = patch => setDraft(prev => updateStageConfig(prev, stage, patch));
			const setParam = (name, value) => setDraft(prev => updateStageConfig(prev, "P6", { params: { ...prev.stageConfig?.P6?.params, [name]: value } }));
			const roles = Object.keys(definition.prompts || {});
			const activeRole = roles.includes(role) ? role : roles[0] || "";
			const prompt = config.prompts?.[activeRole] ?? definition.prompts?.[activeRole] ?? "";
			const roleLabels = { "": "阶段提示词", planner: "Planner", coder: "Coder", reviewer: "Reviewer", desc: "PR 说明", gate: "交付评测" };
			const request = async operation => {
				if (lock.current) return;
				lock.current = true; setBusy(true); setError("");
				try { await operation(); } catch (error) { setError(error.message); }
				finally { lock.current = false; setBusy(false); }
			};
			const save = () => request(async () => {
				if (["dsh", "claude"].includes(draft.p6Mode) && signature !== executorSignature(baseline)
					&& !(probe?.ok && probeKey === signature)) throw new Error("执行器配置已改变，请先在“执行器与环境”运行探测并通过门禁");
				for (const [id, override] of Object.entries(draft.stageConfig || {})) {
					if (!!override.provider?.trim() !== !!override.model?.trim()) throw new Error(id + " 的服务商与模型必须同时填写，或同时留空");
				}
				const result = await apiPut("/settings", draft);
				if (!result?.ok) throw new Error(result?.message || "设置保存失败");
				setDraft(structuredClone(result.settings)); setBaseline(structuredClone(result.settings)); p.onSaved();
			});
			const probeExecutor = () => request(async () => {
				setProbe(null); setProbeKey("");
				if (["builtin", "session"].includes(draft.p6Mode)) {
					const result = await readOk("/preflight");
					setProbe({ ok: !!result.preflight?.git?.ok, gate: { steps: [
						{ name: "Git 环境", ok: !!result.preflight?.git?.ok },
						{ name: "模型来源：" + (result.preflight?.llm?.model || "未解析"), ok: !!result.preflight?.llm?.model }
					], message: "环境探测不等于模型认证成功；人工会话由用户在 DSH 中执行。" } });
					return;
				}
				const result = await apiPost("/agents/test", draft.p6Mode === "dsh" ? { executor: "dsh-agent" } : {
					executor: "claude-code", bin: params.claudeBin || "",
					auth: { preset: params.claudeAuthPreset || "none", baseUrl: params.claudeBaseUrl || "", token: relayToken } });
				setProbe(result); setProbeKey(signature);
				if (!result?.ok && !result?.gate) throw new Error(result?.message || "探测失败");
			});
			const promptView = h("div", { className: "studio-prompt-layout" },
				h("nav", { className: "studio-prompt-nav", "aria-label": "选择提示词阶段" }, STAGES.map(item => {
					// 二期 L-C：已覆盖默认提示词的阶段在列表项加标识点
					const overridden = Object.values(draft.stageConfig?.[item.id]?.prompts || {}).some(value => value != null);
					return h("button", { key: item.id, className: stage === item.id ? "on" : "",
						onClick: () => { p.onStage(item.id); setRole(""); }, title: overridden ? "此阶段已覆盖默认提示词" : undefined },
						h("span", { className: "mono" }, item.id + (overridden ? " •" : "")), " " + STUDIO_STAGE_NAMES[item.id]);
				})),
				h("div", { className: "studio-stack" },
					h("div", { className: "studio-row" }, h("h3", { className: "studio-grow" }, stage + " · " + STUDIO_STAGE_NAMES[stage]),
						roles.length ? studioButton("恢复默认", () => {
							const prompts = { ...config.prompts }; delete prompts[activeRole]; setConfig({ prompts });
						}, "sm", busy) : null),
					roles.length ? h(React.Fragment, null,
						h("div", { className: "studio-segmented" }, roles.map(item => h("button", { key: item,
							className: activeRole === item ? "on" : "", onClick: () => setRole(item) }, roleLabels[item] || item))),
						settingField("阶段提示词内容", prompt, value => setConfig({ prompts: { ...config.prompts, [activeRole]: value } }),
							{ multiline: true, disabled: busy }),
						// 二期 L-C：编辑器底部常显覆盖标识与字符计数
						h("div", { className: "studio-row wrap" },
							config.prompts?.[activeRole] != null ? h("span", { className: "tg t-warn", title: "恢复默认可撤回此覆盖" }, "已覆盖默认值") : h("span", { className: "hint" }, "使用默认提示词"),
							h("span", { className: "studio-grow" }),
							h("span", { className: "hint mono" }, prompt.length + " 字符")),
						h("p", { className: "hint" }, "默认继承宿主模型；执行器采用独立模型配置时，以实际执行记录为准。"))
						: h("div", { className: "studio-soft-card" }, h("h3", null, "此阶段不调用大模型"), h("p", null,
							stage === "P7" ? "补丁按校验与账本规则应用，无需提示词。" : "测试阶段运行项目测试命令，无需提示词。")),
					h("details", null, h("summary", null, "模型、执行与高级参数"),
						h("div", { className: "studio-form-grid" },
							definition.caps?.route ? h(React.Fragment, null,
								settingField("模型服务商", config.provider || "", value => setConfig({ provider: value }), { placeholder: "留空继承宿主" }),
								settingField("模型名称", config.model || "", value => setConfig({ model: value }), { placeholder: "与服务商成对填写" }),
								settingField("思考深度", config.reasoningEffort || "", value => setConfig({ reasoningEffort: value }),
									{ choices: [["", "继承默认"], ["none", "none"], ["low", "low"], ["medium", "medium"], ["high", "high"], ["xhigh", "xhigh"]] })) : null,
							settingField("超时（毫秒）", config.timeoutMs ?? "", value => setConfig({ timeoutMs: value === "" ? undefined : Number(value) }), { type: "number", min: 0 }),
							definition.caps?.route ? settingField("输出 token 上限", config.maxTokens ?? "", value => setConfig({ maxTokens: value === "" ? undefined : Number(value) }), { type: "number", min: 0 }) : null,
							stage !== "P6" && definition.caps?.delegate ? settingField("阶段执行方式", config.delegate?.mode || "off",
								value => setConfig({ delegate: { ...config.delegate, mode: value } }), { choices: [["off", "插件执行"], ["session", "委托人工会话"]] }) : null,
							config.delegate?.mode === "session" ? h(React.Fragment, null,
								settingField("指定智能体", config.delegate.agent || "", value => setConfig({ delegate: { ...config.delegate, agent: value } })),
								settingField("委托附加要求", config.delegate.brief || "", value => setConfig({ delegate: { ...config.delegate, brief: value } }))) : null,
							Object.entries(definition.params || {}).map(([name, meta]) => h("div", { key: name },
								settingField(meta.label || name, config.params?.[name] ?? "", value => {
									const next = { ...config.params };
									if (value === "") delete next[name]; else next[name] = meta.type === "string" ? value : Number(value);
									setConfig({ params: next });
								}, { type: meta.type === "string" ? "text" : "number", min: 1,
									choices: meta.options ? [["", "默认：" + meta.def], ...meta.options.map(value => [value, value])] : undefined,
									placeholder: String(meta.def ?? ""), hint: meta.hint })))))));
			return h("div", { className: "studio-settings-layout" },
				h("nav", { className: "studio-settings-nav", "aria-label": "设置分类" },
					[["general", "常用设置"], ["prompts", "阶段提示词"], ["executors", "执行器与环境"], ["connections", "连接与凭据"]].map(([id, label]) =>
						h("button", { key: id, className: p.tab === id ? "on" : "", onClick: () => p.onTab(id) }, label))),
				h("div", { className: "studio-settings-main" },
					p.settings.revision === 0 ? h("details", { className: "card" }, h("summary", null, "首次设置：从已有项目导入执行配置"),
						h("p", { className: "hint" }, "尚未保存全局设置，新任务使用系统默认。可选择旧项目配置导入草稿，检查后保存为全局。"),
						p.projects.map(project => studioButton(project.name, () => setDraft(prev => ({ ...prev, reviewMode: project.reviewMode, p6Mode: project.p6Mode, testCommand: project.testCommand || "", stageConfig: structuredClone(project.stageConfig || {}), maxReviewAttempts: project.maxReviewAttempts })), "sm", busy))) : null,
					p.tab === "connections" ? h(StudioConnections, { resource: p.connections, toast: p.toast }) :
					h("fieldset", { className: "card studio-settings-fields", disabled: busy },
						h("h2", null, p.tab === "prompts" ? "阶段提示词" : p.tab === "executors" ? "执行器与环境" : "常用设置"),
						h("p", { className: "hint" }, p.tab === "general" ? "决定如何执行任务，以及何时等待复核。"
							: p.tab === "prompts" ? "按阶段和角色调整提示词，保留默认值与覆盖值的区别。" : "开始任务前检查执行器是否可用。"),
						p.tab === "prompts" ? promptView : p.tab === "executors" ? h("div", { className: "studio-stack" },
							settingField("执行器", draft.p6Mode, value => field("p6Mode", value), { choices: STUDIO_EXECUTORS, disabled: busy }),
							draft.p6Mode === "claude" ? h(React.Fragment, null,
								settingField("Claude Code 程序路径", params.claudeBin || "", value => setParam("claudeBin", value), { placeholder: "留空自动探测", disabled: busy }),
								studioButton("扫描本机执行器", () => request(async () => {
									const result = await readOk("/agents/discover"); setCandidates(result.agents || []);
								}), "sm", busy),
								candidates.map((item, index) => studioButton(item.path || item.bin || "候选 " + index, () => setParam("claudeBin", item.path || item.bin || ""), "sm", busy)),
								settingField("认证来源", params.claudeAuthPreset || "none", value => setParam("claudeAuthPreset", value),
									{ disabled: busy, choices: [["none", "运行环境已有登录"], ["glm", "GLM Coding Plan"], ["custom", "自定义中转"]] }),
								params.claudeAuthPreset === "custom" ? settingField("中转地址", params.claudeBaseUrl || "", value => setParam("claudeBaseUrl", value), { disabled: busy }) : null,
								params.claudeAuthPreset && params.claudeAuthPreset !== "none" ? h(React.Fragment, null,
									settingField("中转令牌", relayToken, setRelayToken, { type: "password", disabled: busy, hint: "留空使用已保存令牌；令牌单独存储。" }),
									studioButton("保存中转令牌", () => request(async () => {
										const result = await apiPut("/relay-auth", { token: relayToken });
										if (!result?.ok) throw new Error(result?.message || "令牌保存失败");
										setRelayToken(""); setRelayInfo(result); p.toast("中转令牌已保存");
									}), "sm", busy || !relayToken.trim()),
									studioButton("清除已保存令牌", () => request(async () => {
										if (!confirm("清除全局中转令牌？使用此令牌的执行器下次调用需要重新配置。")) return;
										const result = await apiDelete("/relay-auth");
										if (!result?.ok) throw new Error(result?.message || "清除失败");
										setRelayInfo(result); setProbe(null); setProbeKey("");
									}), "sm", busy || !relayInfo?.exists),
									relayInfo ? h("p", { className: "hint" }, relayInfo.exists ? "已保存：" + relayInfo.masked : "尚未保存令牌", relayInfo.warning ? " · " + relayInfo.warning : "") : null) : null) : null,
							h("div", { className: "studio-probe-steps" },
								(probeKey === signature || ["builtin", "session"].includes(draft.p6Mode)) && probe
									? h(React.Fragment, null, h("span", { className: "tg " + (probe.ok ? "t-good" : "t-err") }, probe.ok ? "探测通过" : "需要处理"),
										(probe.gate?.steps || []).map((step, index) => h("div", { key: index }, (step.ok ? "✓ " : "× ") + step.name)),
										h("p", null, probe.gate?.message || probe.message || probe.gate?.version || ""))
									: h("p", { className: "hint" }, "尚未探测当前执行器配置")),
							studioButton(busy ? "正在探测…" : "运行环境探测", probeExecutor, "pri", busy),
							h("p", { className: "hint" }, "Claude Code / DSH 原生智能体的门禁会执行一次极小真实调用。更改绑定或认证后需要重新探测。"))
							: h(React.Fragment, null, h("div", { className: "studio-form-grid" },
								settingField("复核方式", draft.reviewMode, value => field("reviewMode", value),
									{ disabled: busy, choices: [["key-only", "仅关键阶段复核"], ["every", "每个阶段都复核"], ["auto", "自动执行，完成后查看"]], hint: "关键门：P5、P6、P9、P11。" }),
								settingField("代码执行器", draft.p6Mode, value => field("p6Mode", value), { disabled: busy, choices: STUDIO_EXECUTORS }),
								settingField("模型来源", p.preflight?.llm?.model || "继承 DSH 当前默认模型", () => {}, { readOnly: true, hint: "阶段覆盖在“阶段提示词”中编辑。" }),
								settingField("测试命令", draft.testCommand || "", value => field("testCommand", value), { disabled: busy, placeholder: "例如 npm test", hint: "留空由项目自动探测。" }),
								// 二期 M-B：显式回显生效值——未设置时用服务端默认 3（lib/core/pipeline.js DEFAULT_MAX_REVIEW_ATTEMPTS），清空输入即恢复默认
								settingField("最多打回次数", draft.maxReviewAttempts ?? 3, value => field("maxReviewAttempts", value === "" ? undefined : Number(value)), { disabled: busy, type: "number", min: 1, placeholder: "默认 3 次", hint: "留空恢复默认 3 次；达到上限后任务失败，并进入 P10 失败分析。" })),
								h("div", { className: "callout", style: { marginTop: 24 } },
									"适用于所有项目的新任务。任务启动时保存配置和默认模型快照，后续执行及重跑保留启动配置。"))),
					error ? h("p", { className: "callout err", role: "alert" }, error) : null,
					p.tab !== "connections" ? h("div", { className: "studio-settings-save studio-row wrap" },
						h("span", { className: "studio-grow hint" }, dirty ? "有未保存的修改 · 切换页面保留本次草稿" : "已与全局配置同步"),
						studioButton("放弃修改", () => { setDraft(structuredClone(baseline)); setError(""); }, "", busy || !dirty),
						studioButton("重新载入", () => request(async () => {
							if (dirty && !confirm("重新载入将丢弃当前未保存的草稿，继续？")) return;
							const result = await readOk("/settings");
							setDraft(structuredClone(result.settings)); setBaseline(structuredClone(result.settings)); setProbe(null);
						}), "", busy),
						studioButton(busy ? "处理中…" : "保存设置", save, "pri", busy || !dirty)) : null));
		}


		function NewTaskDialog(p) {
			const [slug, setSlug] = React.useState(p.slug || p.projects[0]?.slug || "");
			const [kind, setKind] = React.useState("issue");
			const [uri, setUri] = React.useState("");
			const [error, setError] = React.useState("");
			const [busy, setBusy] = React.useState(false);
			const lock = React.useRef(false), active = React.useRef(true);
			React.useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
			const project = p.projects.find(item => item.slug === slug);
			const submit = async e => {
				e.preventDefault(); if (lock.current) return;
				if (!slug || !uri.trim()) { setError("请选择项目并填写来源"); return; }
				lock.current = true; setBusy(true); setError("");
				try {
					const result = await apiPost("/projects/" + slug + "/runs", { kind, uri: uri.trim() });
					if (!result?.ok || !result.runId) throw new Error(result?.message || "创建失败");
					if (active.current) p.onCreated(slug, result.runId);
				} catch (error) { if (active.current) setError(error.message); }
				finally { lock.current = false; if (active.current) setBusy(false); }
			};
			return h(StudioDialog, { title: "新建任务", onClose: () => { if (!busy) p.onClose(); } },
				h("form", { className: "studio-stack", onSubmit: submit },
					h("label", { className: "field" }, "项目", h("select", { className: "f-select", value: slug, disabled: busy,
						onChange: e => setSlug(e.target.value) }, p.projects.map(item => h("option", { key: item.slug, value: item.slug }, item.name)))),
					h("label", { className: "field" }, "来源类型", h("select", { className: "f-select", value: kind, disabled: busy,
						onChange: e => { setKind(e.target.value); setUri(""); } },
						h("option", { value: "issue" }, "Issue"), h("option", { value: "requirement" }, "需求文档"))),
					h("label", { className: "field" }, "来源链接或路径", h("input", { className: "f-input", value: uri, required: true, disabled: busy,
						placeholder: "https://… 或 DSH 所在机器的文档路径", onChange: e => setUri(e.target.value) })),
					h("p", { className: "hint" }, "任务将读取来源并立即启动。路径应属于运行 DSH 的机器；此表单不上传浏览器本地文件。"),
					(project?.triggers || []).filter(item => item.kind === kind).map((item, index) =>
						h("button", { key: index, type: "button", className: "btn sm studio-path", disabled: busy,
							onClick: () => setUri(item.uri) }, item.uri)),
					error ? h("p", { className: "callout err", role: "alert" }, error) : null,
					h("button", { className: "btn pri", disabled: busy || !slug }, busy ? "正在创建…" : "创建并开始")));
		}
		async function loadTaskList(projects, signal) {
			const rows = [], queue = projects.slice();
			// 同时最多读取三个项目；保留部分失败而不是把失败项目显示为空列表。
			const errors = [], failedSlugs = [];
			await Promise.all(Array.from({ length: Math.min(3, queue.length) }, async () => {
				while (queue.length && !signal.aborted) {
					const project = queue.shift();
					try {
						const result = await readOk("/projects/" + project.slug + "/runs", signal);
						rows.push(...(result.runs || []).map(run => ({ ...run, slug: project.slug, projectName: project.name })));
					} catch (error) { errors.push(project.name + "：" + error.message); failedSlugs.push(project.slug); }
				}
			}));
			return { rows: rows.sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt))), errors, failedSlugs };
		}
		function taskTitle(run) {
			if (run.title || run.trigger?.title) return run.title || run.trigger.title;
			const first = String(run.trigger?.text || "").split("\n").find(line => line.trim());
			if (first) return first.replace(/^\s*#+\s*/, "").slice(0, 160);
			const source = run.trigger?.uri?.split(/[\\/]/).pop();
			return /^\d+$/.test(source || "") ? "Issue #" + source : source || run.id;
		}
		function taskReason(run) {
			const current = run.stages?.[run.current];
			if (run.currentError || current?.error) return run.currentError || current.error;
			if (run.current === "P6" && ["running", "awaiting_review"].includes(run.status) && (run.externalStatus === "running" || run.externalExec?.status === "running")) return "外部执行器正在处理，等待执行结果";
			if (run.status === "awaiting_review") return run.current + " " + (STUDIO_STAGE_NAMES[run.current] || "") + " · 等待复核";
			if (run.status === "failed") return "任务未通过，打开详情查看失败记录";
			if (run.status === "stopped") return "任务已停止，可从已到达阶段重新执行";
			if (run.status === "completed") return "流程已结束，查看验证结论与交付说明";
			return run.current + " " + (STUDIO_STAGE_NAMES[run.current] || "") + " · " + tag(run.status)[1];
		}
		function needsAttention(run) { return ["awaiting_review", "failed"].includes(run.status); }
		function useProjectRuns(projects, revision) {
			const previous = React.useRef([]);
			return useResource("tasks:" + projects.map(project => project.slug).join(",") + ":" + revision, async signal => {
				const result = await loadTaskList(projects, signal);
				const rows = [...result.rows, ...previous.current.filter(row => result.failedSlugs.includes(row.slug))]
					.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
				if (!signal.aborted) previous.current = rows;
				return { ...result, rows };
			}, 5000);
		}
		function repoProvider(uri) {
			const host = hostOfUri(uri);
			return { host, name: /github/i.test(host) ? "GitHub" : /gitlab/i.test(host) ? "GitLab" : /codearts|myhuaweicloud/i.test(host) ? "CodeArts" : "Git 仓库" };
		}
		function ProjectsPanel(p) {
			const source = useProjectRuns(p.projects, p.revision);
			return h("div", { className: "studio-page" },
				h("div", { className: "studio-page-heading studio-row" }, h("div", { className: "studio-grow" }, h("h1", null, "项目"),
					h("p", null, "连接你的 Git 仓库，集中查看任务与交付。")), studioButton([Ic("plus", 18), "连接项目"], p.onCreate, "pri")),
				h(ResourceNotice, { resource: source }),
				h("div", { className: "studio-grid" }, p.projects.map(project => {
					const repo = typeof project.repos?.[0] === "string" ? project.repos[0] : project.repos?.[0]?.uri || "";
					const provider = repoProvider(repo), runs = source.value?.rows.filter(run => run.slug === project.slug) || [];
					const failed = source.value?.failedSlugs.includes(project.slug), attention = runs.filter(needsAttention).length;
					return h("article", { className: "card studio-project-card", key: project.slug },
						h("div", { className: "studio-row" }, h("span", { className: "studio-repo-logo" }, Ic("git", 23)),
							h("div", { className: "studio-grow" }, h("h2", null, project.name), h("span", { className: "hint" }, provider.name)),
							studioButton("管理", () => p.onEdit(project.slug), "ghost sm")),
						h("div", { className: "studio-repo-address" }, h("div", { className: "mono" }, repo || "未配置仓库"), h("div", { className: "hint" }, provider.host)),
						h("div", { className: "studio-project-foot studio-row wrap" },
							h("span", { className: "hint studio-grow" }, failed ? "任务统计读取失败" : !source.value ? "正在读取任务…" : runs.length + " 项任务" + (attention ? " · " + attention + " 项待处理" : "")),
							studioButton(["查看任务", Ic("right", 14)], () => p.onTasks(project.slug), "ghost sm")));
				})),
				!p.projects.length ? h(EmptyState, { title: "连接第一个代码仓库" }, h("p", null, "GitHub、GitLab、华为云 CodeArts，或使用其他 Git 仓库地址。"), studioButton("连接代码仓库", p.onCreate, "pri")) : null,
				h("div", { className: "studio-row wrap studio-project-more" }, h("span", { className: "hint studio-grow" }, "HTTPS 与 SSH 地址均可使用；私有仓库按域名匹配连接。"),
					studioButton("管理托管连接", p.onConnections, "ghost sm")));
		}
		function TaskList(p) {
			const [filter, setFilter] = usePreference("i2p.task-filter", "all");
			const [status, setStatus] = React.useState("all");
			const [search, setSearch] = React.useState("");
			const [page, setPage] = React.useState(0);
			const effectiveFilter = p.projects.some(item => item.slug === filter) ? filter : "all";
			const selected = effectiveFilter === "all" ? p.projects : p.projects.filter(item => item.slug === filter);
			const source = useProjectRuns(selected, p.revision);
			const allRows = source.value?.rows || [], attention = allRows.filter(needsAttention).length;
			const rows = allRows.filter(run => (status === "all" || (status === "attention" ? needsAttention(run) : run.status === status))
				&& [taskTitle(run), run.id, run.projectName, run.trigger?.uri].join(" ").toLowerCase().includes(search.toLowerCase()));
			const pages = Math.max(1, Math.ceil(rows.length / 30)), currentPage = Math.min(page, pages - 1);
			return h("div", { className: "studio-page" },
				h("div", { className: "studio-page-heading studio-row" }, h("div", { className: "studio-grow" }, h("h1", null, "任务"),
					h("p", null, "按项目查看进度，处理复核与失败。")), studioButton([Ic("plus", 18), "新建任务"], p.onCreate, "pri", !p.projects.length)),
				h("div", { className: "studio-toolbar" },
					h("label", { className: "studio-project-filter" }, "项目", h("select", { className: "f-select", "aria-label": "筛选项目", value: effectiveFilter,
						onChange: e => { setFilter(e.target.value); setPage(0); } }, h("option", { value: "all" }, "全部项目"), p.projects.map(item => h("option", { key: item.slug, value: item.slug }, item.name)))),
					h("input", { type: "search", className: "f-input studio-search", value: search, "aria-label": "搜索任务", placeholder: "搜索任务、编号或项目",
						onChange: e => { setSearch(e.target.value); setPage(0); } }),
					h("div", { className: "studio-segmented", "aria-label": "筛选任务状态" }, [["all", "全部"], ["attention", "待处理 " + attention], ["running", "执行中"], ["completed", "已完成"]].map(([id, label]) =>
						h("button", { key: id, className: status === id ? "on" : "", "aria-pressed": status === id, onClick: () => { setStatus(id); setPage(0); } }, label)))),
				h("div", { className: "studio-row studio-filter-result" }, h("span", { className: "studio-grow" }, (effectiveFilter === "all" ? "全部项目" : selected[0]?.name) + " · " + rows.length + " / " + allRows.length + " 项任务"),
					status !== "all" || search ? studioButton("清除搜索与状态筛选", () => { setStatus("all"); setSearch(""); setPage(0); }, "ghost sm") : null,
					studioButton("刷新", source.reload, "ghost sm")),
				h(ResourceNotice, { resource: source }),
				source.value?.errors.length ? h("div", { className: "callout err", role: "alert" }, "部分项目读取失败，保留其上次结果：" + source.value.errors.join("；"), studioButton("重试", source.reload, "sm")) : null,
				source.value == null && !source.error ? h(Skel) : rows.length ? h("div", { className: "studio-task-list", "aria-label": "任务列表" },
					rows.slice(currentPage * 30, (currentPage + 1) * 30).map(run => h("button", { className: "studio-run-row", key: run.slug + "/" + run.id, onClick: () => p.onOpen(run.slug, run.id) },
						h("span", { className: "studio-run-icon " + run.status }, Ic(run.status === "completed" ? "check" : run.status === "failed" ? "x" : "git", 20)),
						h("span", null, h("strong", null, taskTitle(run)), h("span", { className: "studio-run-description" }, run.projectName + " · " + run.id), h("span", { className: "studio-run-reason" }, taskReason(run))),
						h(StatusBadge, { status: run.status }), h("span", { className: "studio-run-time hint", title: fmtTime(run.createdAt) }, fmtTime(run.createdAt).slice(5, 10)))))
					: h(EmptyState, { title: "暂无匹配任务" }, h("p", null, "选择其他筛选条件，或新建一个任务。")),
				pages > 1 ? h("div", { className: "studio-row studio-pagination" }, h("span", { className: "studio-grow hint" }, rows.length + " 个任务"),
					studioButton("上一页", () => setPage(currentPage - 1), "sm", currentPage === 0), h("span", null, (currentPage + 1) + " / " + pages),
					studioButton("下一页", () => setPage(currentPage + 1), "sm", currentPage + 1 === pages)) : null);
		}

		function Section() {
			const [nav, setNav] = usePreference("i2p.studio-nav", "projects");
			const [selSlug, setSelSlug] = React.useState(() => {
				try { return localStorage.getItem("i2p.proj") || null; } catch { return null; }
			});
			const [selRunId, setSelRunId] = React.useState(() => lastRunStore.get(selSlug));
			const [toast, setToast] = React.useState(null);
			const [dialog, setDialog] = React.useState(null);
			const [editing, setEditing] = React.useState(null);
			const [settingsTab, setSettingsTab] = usePreference("i2p.settings-tab", "general");
			const [cfgStage, setCfgStage] = React.useState("P1");
			const [revision, setRevision] = React.useState(0);
			const touched = React.useRef(false);
			const toastFn = React.useCallback((msg, kind = "ok") => setToast({ msg, kind }), []);
			React.useEffect(() => {
				if (!toast) return;
				const timer = setTimeout(() => setToast(null), toast.kind === "bad" ? 7000 : 3500);
				return () => clearTimeout(timer);
			}, [toast]);
			const projectsResource = useResource("projects", async signal => (await readOk("/projects", signal)).projects);
			const projects = projectsResource.value || [];
			const connectionsResource = useResource("connections", async signal => (await readOk("/connections", signal)).connections);
			const defaultsResource = useResource("defaults", async signal => (await readOk("/stage-defaults", signal)).defaults);
			const preflightResource = useResource("preflight", async signal => (await readOk("/preflight", signal)).preflight);
			const settingsResource = useResource("settings", async signal => (await readOk("/settings", signal)).settings);
			const currentProject = projects.find(item => item.slug === selSlug);
			const detailKey = nav === "run" && selSlug && selRunId ? selSlug + "/" + selRunId : null;
			const detail = useResource(detailKey, async signal => {
				const base = "/projects/" + selSlug + "/runs/" + selRunId;
				const [run, tree] = await Promise.all([readOk(base, signal), readOk(base + "/tree", signal)]);
				if (!run.id) throw new Error("任务不存在，请返回任务列表");
				return { run, tree: tree.files };
			}, 3000);
			const selectProject = slug => {
				touched.current = true; setSelSlug(slug);
				setSelRunId(lastRunStore.get(slug));
				try { if (slug) localStorage.setItem("i2p.proj", slug); else localStorage.removeItem("i2p.proj"); } catch { /* fallback below */ }
				apiPost("/ui-state", { lastProject: slug || null }).catch(() => {});
			};
			React.useEffect(() => {
				let active = true;
				readOk("/ui-state").then(result => {
					if (!active || touched.current) return;
					lastRunStore.adopt(result.state?.lastRunBySlug);
					if (!selSlug && result.state?.lastProject) {
						setSelSlug(result.state.lastProject); setSelRunId(lastRunStore.get(result.state.lastProject));
					}
				}).catch(() => {});
				return () => { active = false; };
			}, []);
			React.useEffect(() => {
				if (projectsResource.value && selSlug && !projects.some(project => project.slug === selSlug)) {
					selectProject(null); if (nav === "run") setNav("tasks");
				}
			}, [projectsResource.value, selSlug]);
			React.useEffect(() => {
				if (nav === "run" && (!selSlug || !selRunId)) setNav("tasks");
			}, [nav, selSlug, selRunId]);
			React.useEffect(() => {
				viewStore.set({ nav: nav === "tasks" || nav === "run" ? "runs" : nav === "settings" ? "config" : nav,
					slug: selSlug, runId: selRunId });
			}, [nav, selSlug, selRunId]);
			const refresh = () => { detail.reload(); setRevision(value => value + 1); };
			React.useEffect(() => {
				const focus = () => { if (document.visibilityState !== "hidden") refresh(); };
				window.addEventListener("focus", focus);
				document.addEventListener("visibilitychange", focus);
				return () => { window.removeEventListener("focus", focus); document.removeEventListener("visibilitychange", focus); };
			}, [detailKey]);
			const openRun = (slug, runId) => {
				selectProject(slug); setSelRunId(runId); lastRunStore.set(slug, runId);
				setNav("run"); setDialog(null); setRevision(value => value + 1);
			};
			const onSaved = slug => { selectProject(slug); projectsResource.reload(); preflightResource.reload(); toastFn("配置已保存"); };
			const formProps = {
				projects, slug: dialog === "project" ? editing : selSlug, toast: toastFn,
				onSelectProject: slug => { if (dialog === "project") setEditing(slug); else selectProject(slug); },
				onSaved, onRunStarted: openRun, connections: connectionsResource.value,
				preflight: preflightResource.value, reloadConnections: connectionsResource.reload,
				onDeletedProject: () => { selectProject(null); projectsResource.reload(); setDialog(null); }
			};
			const activeNav = nav === "run" ? "tasks" : nav;
			return h("div", { className: "i2p studio" },
				h("header", { className: "studio-topbar" },
					h("div", { className: "studio-brand" }, Ic("branch", 22), "Issue2PR"),
					h("nav", { className: "studio-topnav", "aria-label": "Issue2PR 主导航" },
						[["projects", "项目"], ["tasks", "任务"], ["settings", "设置"]].map(([id, label]) =>
							h("button", { key: id, className: activeNav === id ? "on" : "", "aria-current": activeNav === id ? "page" : undefined,
								onClick: () => setNav(id) }, label))),
					h("div", { className: "studio-toptools studio-row" },
						studioButton("帮助", () => setDialog("help"), "sm"),
						studioButton("助手", () => { panelStore.set(true); aiStore.set(!aiStore.open); }, "sm"),
						studioButton("关闭", () => panelStore.set(false), "sm"))),
				h("main", { className: "studio-main" },
					h(ResourceNotice, { resource: projectsResource }),
					projectsResource.value == null ? (projectsResource.error ? null : h(Skel)) :
					nav === "run" ? h(React.Fragment, null, h(ResourceNotice, { resource: detail }),
						detail.value?.run ? h(RunsPanel, { key: detailKey, slug: selSlug, runId: selRunId, run: detail.value?.run,
							tree: detail.value?.tree, project: currentProject, defaults: defaultsResource.value,
							error: detail.error, toast: toastFn, onChanged: refresh, onBack: () => setNav("tasks"),
							onDeleted: () => { lastRunStore.set(selSlug, null); setSelRunId(null); setNav("tasks"); refresh(); },
							onConfig: stage => { setCfgStage(stage); setSettingsTab("prompts"); setNav("settings"); } }) : detail.error ?
							h(EmptyState, { title: "暂时无法打开此任务" }, studioButton("返回任务列表", () => setNav("tasks"), "pri")) : h(Skel)) :
					nav === "tasks" ? h(TaskList, { projects, revision, onCreate: () => setDialog("task"), onOpen: openRun }) :
					nav === "settings" ? h("div", { className: "studio-page" },
						h("div", { className: "studio-page-heading studio-row" }, h("div", { className: "studio-grow" },
							h("span", { className: "hint mono" }, "TASK DEFAULTS"), h("h1", null, "新任务默认设置"),
							h("p", { className: "hint" }, "适用于所有项目的新任务；已启动任务保留原配置。")),
							selRunId ? studioButton("返回任务现场", () => setNav("run"), "sm") : null),
						h(ResourceNotice, { resource: settingsResource }), h(ResourceNotice, { resource: defaultsResource }),
						settingsResource.value && defaultsResource.value ? h(StudioSettings, { settings: settingsResource.value, projects,
							defaults: defaultsResource.value, preflight: preflightResource.value, tab: settingsTab, onTab: setSettingsTab,
							stage: cfgStage, onStage: setCfgStage, connections: connectionsResource, toast: toastFn,
							onSaved: () => { settingsResource.reload(); preflightResource.reload(); toastFn("全局设置已保存，仅新任务使用"); } }) : settingsResource.error || defaultsResource.error ? null : h(Skel)) :
					h(ProjectsPanel, { projects, revision,
						onCreate: () => { setEditing(null); setDialog("project"); },
						onEdit: slug => { setEditing(slug); setDialog("project"); },
						onTasks: slug => { selectProject(slug); writePreference("i2p.task-filter", slug); setNav("tasks"); },
						onConnections: () => { setSettingsTab("connections"); setNav("settings"); } })),
				dialog === "project" ? h(ProjectDialog, { ...formProps, slug: editing, onClose: () => setDialog(null) }) : null,
				dialog === "task" ? h(NewTaskDialog, { projects, slug: selSlug, onClose: () => setDialog(null), onCreated: openRun }) : null,
				dialog === "help" ? h(StudioDialog, { title: "使用说明", wide: true, onClose: () => setDialog(null) }, h(GuidePanel)) : null,
				toast ? h("div", { className: "i2p-toast" + (toast.kind === "bad" ? " t-bad" : ""), role: "status" }, toast.msg) : null);
		}


		/* ================================================================
		 * 工作台开关（sidebar.footer.action 入口与 shell.overlay 页面共享）
		 * ================================================================ */
		const panelStore = {
			open: false,
			listeners: new Set(),
			set(v) { this.open = v; for (const fn of this.listeners) fn(); },
			subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); },
		};
		function usePanelOpen() {
			const [open, setOpen] = React.useState(panelStore.open);
			React.useEffect(() => panelStore.subscribe(() => setOpen(panelStore.open)), []);
			return open;
		}

		/* ================================================================
		 * 工作台助手：顶部入口打开可拖动、缩放的对话面板。
		 * 后端 /assistant/ask 流式 JSONL（{"delta"}… {"done"|"error"}），
		 * 上下文（页面位置/项目/Run/最近事件）由后端每次现读
		 * ================================================================ */
		// 初始（重置）位置固定值：面板右上角锚定工作台右上角内侧——右偏 78px
			// （避宿主右缘悬浮按钮排约 70px）、顶偏 60px（工作台头部下方）
			const AI_ANCHOR = { right: 78, top: 60 };
		const aiStore = {
			open: false,
			// 自由窗口矩形：运行时 x/y/w/h（相对工作台左上）；**持久化/恢复一律用右上角相对坐标**
			// （aiR=面板右缘距工作台右缘、aiT=面板顶距工作台顶）——窗口尺寸变化后面板与
			// 右缘的相对位置不漂移。兼容旧字段（aiX 绝对坐标/aiTop）按当前页宽换算迁移
				rect: (function () {
					const d = aiDefaultRect();
					const r = clampInt(localStorage.getItem("i2p.aiR"), 0, 2000, null);
					const t = clampInt(localStorage.getItem("i2p.aiT"), 44, 2000, null);
					const oldT = t != null ? t : clampInt(localStorage.getItem("i2p.aiTop"), 44, 2000, null);
					const w = clampInt(localStorage.getItem("i2p.aiW"), 240, 760, null);
					const h = clampInt(localStorage.getItem("i2p.aiH"), 200, 1800, null);
					const oldX = clampInt(localStorage.getItem("i2p.aiX"), 0, 4000, null);
					if (r == null && oldT == null && w == null && h == null && oldX == null) return d;
					const p = aiPageRect();
					const w2 = w != null ? w : d.w;
					const r2 = r != null ? r
						: (oldX != null ? Math.max(4, Math.round(p.w - oldX - w2)) : AI_ANCHOR.right);
					const t2 = oldT != null ? oldT : AI_ANCHOR.top;
				// 恢复的矩形可能来自大屏（localStorage 按机器各存各的），先按当前页面收敛再启用
				return aiClampRect(
					Math.round(p.w - r2 - w2), t2, w2,
					h != null ? h : Math.max(200, Math.round(p.h - 16 - t2)));
			})(),
			listeners: new Set(),
			set(v) { this.open = v; if (v) this.normalize(); for (const fn of this.listeners) fn(); },
			// setRect：先 clamp 尺寸再 clamp 位置（面板始终完整落在工作台内）；
			// resize 的锚定边由调用方以推导后的 x/y 一并传入（西/北边拖动时对边固定）
			setRect(patch, persist) {
				const cur = this.rect;
				this.rect = aiClampRect(
					patch.x != null ? Math.round(patch.x) : cur.x,
					patch.y != null ? Math.round(patch.y) : cur.y,
					patch.w != null ? Math.round(patch.w) : cur.w,
					patch.h != null ? Math.round(patch.h) : cur.h);
				if (persist) {
					const pageRect = aiPageRect();
					const savedRect = {
						aiR: Math.round(pageRect.w - this.rect.x - this.rect.w),
						aiT: this.rect.y,
						aiW: this.rect.w,
						aiH: this.rect.h,
					};
					// 右上角相对坐标落盘：aiR=右缘偏移、aiT=顶部偏移；旧绝对键清除防干扰
					try {
						localStorage.setItem("i2p.aiR", String(savedRect.aiR));
						localStorage.setItem("i2p.aiT", String(savedRect.aiT));
						localStorage.setItem("i2p.aiW", String(savedRect.aiW));
						localStorage.setItem("i2p.aiH", String(savedRect.aiH));
						localStorage.removeItem("i2p.aiX");
						localStorage.removeItem("i2p.aiY");
						localStorage.removeItem("i2p.aiTop");
					} catch (e) { /* webview localStorage 可能被禁，服务端兜底仍在 */ }
					fetch(API + "/ui-state", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify(savedRect),
					}).catch(function () { /* 兜底失败静默 */ });
				}
				for (const fn of this.listeners) fn();
			},
			resetRect() { this.setRect(aiDefaultRect(), true); },
			// 收敛当前矩形到页面内（不落盘，用户偏好不动）：打开面板与页面几何变化时调用，
			// 修掉"大屏存下的尺寸到小屏溢出屏幕"；矩形没变化时不触发监听
			normalize() {
				const cur = this.rect;
				const n = aiClampRect(cur.x, cur.y, cur.w, cur.h);
				if (n.x === cur.x && n.y === cur.y && n.w === cur.w && n.h === cur.h) return;
				this.rect = n;
				for (const fn of this.listeners) fn();
			},
			subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); },
		};
			function useAiState() {
				const [s, setS] = React.useState({ open: aiStore.open, rect: aiStore.rect });
				React.useEffect(() => aiStore.subscribe(() => setS({ open: aiStore.open, rect: aiStore.rect })), []);
				return s;
			}

			const AI_CHIPS = ["现在的运行到哪一步了？", "P1-P11 各做什么？", "这个 Run 为什么会失败？"];

		function clampInt(v, lo, hi, def) {
			const n = parseInt(v, 10);
			return Number.isFinite(n) && n >= lo && n <= hi ? n : def;
		}
		// 工作台 page 的可用尺寸（查询失败退回视口近似——smoke/preview 环境无真实 rect）
		function aiPageRect() {
			const el = document.querySelector(".i2p-page");
			const r = el && el.getBoundingClientRect ? el.getBoundingClientRect() : null;
			return r ? { w: r.width, h: r.height } : { w: window.innerWidth || 1280, h: window.innerHeight || 720 };
		}
		// 矩形收敛（与 setRect 同边界）：尺寸先 clamp（240..760/页宽-24、200..页高-60），
		// 位置后 clamp（面板完整落在工作台内）——恢复路径/打开面板/页面几何变化共用
		function aiClampRect(x, y, w, h) {
			const p = aiPageRect();
			w = Math.max(240, Math.min(Math.max(240, Math.min(760, p.w - 24)), w));
			h = Math.max(200, Math.min(Math.max(200, p.h - 60), h));
			x = Math.max(4, Math.min(Math.max(4, p.w - w - 4), x));
			y = Math.max(44, Math.min(Math.max(44, p.h - h - 8), y));
			return { x: x, y: y, w: w, h: h };
		}
		// 默认窗口：右上角按 AI_ANCHOR 固定偏移锚定（窗口尺寸变化时相对位置不变）
		function aiDefaultRect() {
			const p = aiPageRect();
			// 二期 M-C：默认宽度 400 → 440，输入区随之加宽（已保存自定义尺寸不受影响）
			return {
				x: Math.max(4, Math.round(p.w - AI_ANCHOR.right - 440)),
				y: AI_ANCHOR.top, w: 440,
				h: Math.max(200, Math.round(p.h - 76)),
			};
		}

		function AssistantDock() {
			const ai = useAiState();
			const open = ai.open;
			const view = useViewState();
			const [msgs, setMsgs] = React.useState([]); // {role:"user"|"assistant", text, err?}
			const [input, setInput] = React.useState("");
			const [busy, setBusy] = React.useState(false);
			const acRef = React.useRef(null);
			const scrollRef = React.useRef(null);
			const taRef = React.useRef(null);

			// Esc 只关助手面板：capture 阶段拦截，避免穿透到工作台的「Esc 关工作台」
			React.useEffect(function () {
				if (!open) return undefined;
				const onKey = function (e) {
					if (e.key === "Escape") { e.stopPropagation(); aiStore.set(false); }
				};
				window.addEventListener("keydown", onKey, true);
				return function () { window.removeEventListener("keydown", onKey, true); };
			}, [open]);

			// 打开时聚焦输入框；新消息滚动到底
			React.useEffect(function () {
				if (open && taRef.current && taRef.current.focus) taRef.current.focus();
			}, [open]);
			React.useEffect(function () {
				const el = scrollRef.current;
				if (el) el.scrollTop = el.scrollHeight;
			}, [msgs]);
			// 输入清空（发送/清屏）后把自适应高度收回去，输入框回到单行基准
			React.useEffect(function () {
				if (!input && taRef.current) taRef.current.style.height = "";
			}, [input]);

			const send = React.useCallback(async function (q) {
				const question = String(q != null ? q : input).trim();
				if (!question || busy) return;
				setInput("");
				const hist = msgs.slice(-6)
					.filter(function (m) { return m.text && !m.err; })
					.map(function (m) { return { role: m.role, text: m.text }; });
				setMsgs(function (ms) { return ms.concat([{ role: "user", text: question }, { role: "assistant", text: "" }]); });
				setBusy(true);
				if (acRef.current) acRef.current.abort();
				const ac = new AbortController();
				acRef.current = ac;
				const patchLast = function (fn) {
					setMsgs(function (ms) {
						if (!ms.length || ms[ms.length - 1].role !== "assistant") return ms;
						const next = ms.slice();
						next[next.length - 1] = fn(next[next.length - 1]);
						return next;
					});
				};
				try {
					const r = await fetch(API + "/assistant/ask", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ question: question, history: hist, focus: { nav: view.nav, slug: view.slug, runId: view.runId } }),
						signal: ac.signal,
					});
					if (!r.ok || !r.body) throw new Error("HTTP " + r.status);
					const reader = r.body.getReader();
					const dec = new TextDecoder();
					let buf = "";
					for (;;) {
						const rd = await reader.read();
						if (rd.done) break;
						buf += dec.decode(rd.value, { stream: true });
						const lines = buf.split("\n");
						buf = lines.pop();
						for (const line of lines) {
							if (!line.trim()) continue;
							let ev = null;
							try { ev = JSON.parse(line); } catch (e) { continue; }
							if (ev.error) throw new Error(ev.error);
							if (ev.delta) {
								const d = ev.delta;
								patchLast(function (m) { return { role: "assistant", text: m.text + d }; });
							}
						}
					}
					patchLast(function (m) { return m.text ? m : { role: "assistant", text: "（空回答）", err: true }; });
				} catch (e) {
					if (ac.signal.aborted) {
						// 被新请求或工作台关闭取代：消息列表归新请求/卸载流程管，这里不动
					} else {
						const msg = String((e && e.message) || e);
						patchLast(function (m) { return { role: "assistant", text: m.text || msg, err: !m.text }; });
					}
				} finally {
					setBusy(false);
					if (acRef.current === ac) acRef.current = null;
				}
			}, [input, busy, msgs, view]);

			// 工作台关闭（组件卸载）时中断进行中的生成
			React.useEffect(function () {
				return function () { if (acRef.current) acRef.current.abort(); };
			}, []);

			// 面板窗口矩形兜底：宿主 webview 的 localStorage 不跨软件重启——本地无记忆时
			// 从服务端 ui-state 恢复（右上角相对坐标 aiR/aiT；兼容旧 aiX/aiY/aiTop 按当前
			// 页宽换算）；本地有记忆时反向同步服务端（防旧值空窗）
			React.useEffect(function () {
				apiGet("/ui-state").then(function (r) {
					if (!r || !r.ok || !r.state) return;
					const local = ["i2p.aiR", "i2p.aiT", "i2p.aiW", "i2p.aiH", "i2p.aiX", "i2p.aiTop"].some(function (k) { return localStorage.getItem(k) != null; });
					const p = aiPageRect();
					if (local) {
						fetch(API + "/ui-state", {
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({ aiR: Math.round(p.w - aiStore.rect.x - aiStore.rect.w), aiT: aiStore.rect.y, aiW: aiStore.rect.w, aiH: aiStore.rect.h }),
						}).catch(function () { /* 兜底失败静默 */ });
					} else if (r.state.aiR != null || r.state.aiX != null || r.state.aiW != null || r.state.aiTop != null) {
						const w2 = r.state.aiW != null ? r.state.aiW : aiStore.rect.w;
						const r2 = r.state.aiR != null ? r.state.aiR
							: (r.state.aiX != null ? Math.max(4, Math.round(p.w - r.state.aiX - w2)) : AI_ANCHOR.right);
						aiStore.setRect({
							x: Math.round(p.w - r2 - w2),
							y: r.state.aiT != null ? r.state.aiT : r.state.aiTop,
							w: r.state.aiW, h: r.state.aiH,
						}, false);
					}
				}).catch(function () { /* 兜底失败静默 */ });
			}, []);

			// 自由窗口拖拽：resize 边/角（含双向角点）+ 标题栏拖动移动。
			// 原生事件委托（宿主注入环境里 React 合成事件对 pointer 不可靠）；
			// 双击 resize 区或标题栏 = 恢复默认位置与尺寸（WCAG 2.2 拖拽的单指针替代路径）
			React.useEffect(function () {
				const hitOf = function (t) {
					if (!t || !t.closest) return null;
					return t.closest(".i2p-ai-rz") || t.closest(".i2p-ai-head");
				};
				const down = function (e) {
					if (e.button !== 0) return;
					const hit = hitOf(e.target);
					if (!hit) return;
					// 标题栏上的按钮（关闭等）不触发拖动
					if (hit.classList.contains("i2p-ai-head") && e.target.closest && e.target.closest("button")) return;
					const page = hit.closest(".i2p-page");
					if (!page) return;
					e.preventDefault();
					const mode = hit.classList.contains("i2p-ai-head") ? "move"
						: ((hit.className.match(/i2p-ai-rz\s+(\S+)/) || [])[1] || "");
					if (!mode) return;
					const start = {
						x: e.clientX, y: e.clientY,
						rect: { x: aiStore.rect.x, y: aiStore.rect.y, w: aiStore.rect.w, h: aiStore.rect.h },
					};
					document.body.classList.add("i2p-dragging");
					document.body.style.cursor = mode === "move" ? "move"
						: (/n|s/.test(mode) && /e|w/.test(mode) ? (/nw|se/.test(mode) ? "nwse-resize" : "nesw-resize")
						: (/n|s/.test(mode) ? "ns-resize" : "ew-resize"));
					const move = function (ev) {
						const dx = ev.clientX - start.x, dy = ev.clientY - start.y;
						if (mode === "move") {
							aiStore.setRect({ x: start.rect.x + dx, y: start.rect.y + dy }, false);
							return;
						}
						let w = start.rect.w, h = start.rect.h, x = start.rect.x, y = start.rect.y;
						if (mode.indexOf("e") >= 0) w = start.rect.w + dx;
						if (mode.indexOf("s") >= 0) h = start.rect.h + dy;
						if (mode.indexOf("w") >= 0) { w = start.rect.w - dx; x = start.rect.x + dx; }
						if (mode.indexOf("n") >= 0) { h = start.rect.h - dy; y = start.rect.y + dy; }
						aiStore.setRect({ x: x, y: y, w: w, h: h }, false);
					};
					const up = function () {
						window.removeEventListener("pointermove", move);
						window.removeEventListener("pointerup", up);
						document.body.style.cursor = "";
						document.body.classList.remove("i2p-dragging");
						aiStore.setRect({}, true); // 拖动结束落盘（双写）
					};
					window.addEventListener("pointermove", move);
					window.addEventListener("pointerup", up);
				};
				const dbl = function (e) {
					if (hitOf(e.target)) aiStore.resetRect();
				};
				document.addEventListener("pointerdown", down);
				document.addEventListener("dblclick", dbl);
				return function () {
					document.removeEventListener("pointerdown", down);
					document.removeEventListener("dblclick", dbl);
				};
			}, []);

			return h("div", { className: "i2p-ai" },
				open ? h("aside", {
					className: "i2p-ai-panel", role: "complementary", "aria-label": "智能助手",
					style: { left: ai.rect.x + "px", top: ai.rect.y + "px", width: ai.rect.w + "px", height: ai.rect.h + "px" },
				},
					["n", "s", "e", "w", "nw", "ne", "sw", "se"].map(function (d) {
						return h("div", { key: d, className: "i2p-ai-rz " + d, title: "拖动调整大小 · 双击恢复默认" });
					}),
					h("div", { className: "i2p-ai-head", title: "拖动移动位置 · 双击恢复默认" },
							h("span", { className: "i2p-ai-title" }, "智能助手"),
						h("span", { className: "i2p-ai-sub" }, "问答 · 运行状态"),
						h("button", {
							type: "button", className: "i2p-ai-close", onClick: function () { aiStore.set(false); },
							"aria-label": "关闭（Esc）", title: "关闭（Esc）",
						}, Ic("x", 14))),
					h("div", { className: "i2p-ai-msgs", ref: scrollRef },
						msgs.length === 0 ? h("div", { className: "i2p-ai-empty" },
							h("p", { className: "i2p-ai-hint" }, "我能看到你的项目、Run 进度与最近事件——直接问。"),
							h("div", { className: "i2p-ai-chips" },
								AI_CHIPS.map(function (c) {
									return h("button", {
										key: c, type: "button", className: "i2p-ai-chip", title: c,
										disabled: busy, onClick: function () { send(c); },
									}, c);
								}))) : null,
						msgs.map(function (m, i) {
							const waiting = busy && i === msgs.length - 1 && m.role === "assistant" && !m.err && !m.text;
							return h("div", { key: i, className: "i2p-ai-m " + m.role + (m.err ? " err" : "") },
								m.role === "assistant" && !m.err
									? h("div", { className: "i2p-ai-md" },
										waiting ? h("span", { className: "i2p-ai-dots" }, h("i"), h("i"), h("i"))
											: h(MarkdownText, { text: m.text }))
									: h("span", { className: "i2p-ai-t" }, m.text));
						})),
					h("div", { className: "i2p-ai-input" },
						h("textarea", {
							ref: taRef, value: input, rows: 1,
							// 二期 M-C：占位缩短防截断，Enter 操作提示放 title 常驻可查
							placeholder: busy ? "回答生成中…" : "问运行状态、失败原因…",
							title: "Enter 发送，Shift+Enter 换行",
							onChange: function (e) {
								setInput(e.target.value);
								// 高度随内容自适应：先归零再量 scrollHeight，封顶后内部滚动
								const el = e.target;
								el.style.height = "auto";
								el.style.height = Math.min(el.scrollHeight, 150) + "px";
							},
							onKeyDown: function (e) {
								// isComposing：中文输入法组词期按 Enter 是"上屏候选词"，不能当发送
								if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
									e.preventDefault(); send();
								}
							},
						}),
						h("button", {
							type: "button", className: "i2p-ai-send", disabled: !busy && !input.trim(),
							onClick: function () { if (busy) { if (acRef.current) acRef.current.abort(); return; } send(); },
							// 二期 M-C：禁用态 hover 有解释，不再只显示操作名
							"aria-label": busy ? "中断生成" : input.trim() ? "发送（Enter）" : "输入内容后发送",
							title: busy ? "中断生成" : input.trim() ? "发送（Enter）" : "输入内容后发送",
						}, Ic(busy ? "stop" : "send", 15)))) : null);
		}

		// 宿主侧栏的 Issue2PR 入口图标。
		function EntryGlyph(props) {
			return h("svg", Object.assign({
				viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.5,
				strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true",
			}, props),
				h("circle", { cx: 4.5, cy: 3.5, r: 2 }),
				h("circle", { cx: 4.5, cy: 12.5, r: 2 }),
				h("circle", { cx: 11.5, cy: 6.5, r: 2 }),
				h("path", { d: "M4.5 5.5v5M11.5 8.5c0 2.8-3.2 2.4-4.7 3.2" }));
		}

		// 侧边栏底部入口按钮：1:1 复刻宿主设置按钮几何与交互
		// （宽列 = 42px 整行·图标+文字靠左；收起列 = 36×36 圆形·仅图标；点击开/关工作台）
		function FooterEntry(props) {
			const wide = !!(props && props.wide);
			const open = usePanelOpen();
			return h("button", {
				type: "button", className: "i2p-entry" + (wide ? "" : " rail"),
				onClick: () => panelStore.set(!open),
				"aria-expanded": open ? "true" : "false",
			},
				h(EntryGlyph, { width: wide ? 16 : 18, height: wide ? 16 : 18 }),
				wide ? h("span", { className: "i2p-entry-label" }, "Issue2PR") : null);
		}

		// 主区整页工作台（shell.overlay 槽位）：贴合 conversation 列 rect，
		// 未开启时渲染 null；sidebar 拖动/窗口缩放实时跟随
		function WorkbenchPage() {
			const open = usePanelOpen();
			const [rect, setRect] = React.useState(null);
			React.useEffect(() => {
				if (!open) return undefined;
				const previous = document.activeElement;
				const onKey = (e) => { if (e.key === "Escape" && !document.querySelector(".studio-dialog[open]")) panelStore.set(false); };
				window.addEventListener("keydown", onKey);
				return () => { window.removeEventListener("keydown", onKey); if (previous?.isConnected) previous.focus(); };
			}, [open]);
			// 二期 S6：打开后焦点落在面板根（region），首个 Tab 进入面板内首个控件；
			// 不再高亮「关闭」按钮（原先聚焦 toptools 最后一个按钮导致每次重开都出现关闭按钮 outline）
			React.useEffect(() => {
				if (open && rect) document.querySelector(".i2p-page")?.focus();
			}, [open, !!rect]);
			React.useLayoutEffect(() => {
				if (!open) { setRect(null); return undefined; }
				// conversation 槽位 anchor 的父级即主内容列（CenterColumn）。
				// 用轻量轮询贴合而非 resize/ResizeObserver：嵌入式 webview（IAB）
				// 里两者都可能不触发；300ms 轮询一次 getBoundingClientRect 且值
				// 不变不 setState，顺带覆盖 sidebar 拖动、details 开关等一切变化。
				// 锚点缺失（宿主视图未挂载或结构变更）时每轮重查并回退视口居中，
				// 入口不再静默空白；锚点恢复后自动重新贴合。
				let last = "";
				const tick = () => {
					const anchor = document.querySelector('[data-slot="conversation"]');
					const host = anchor && anchor.parentElement;
					const box = host ? host.getBoundingClientRect() : null;
					const vw = window.innerWidth || 1280, vh = window.innerHeight || 720;
					const r = box || { left: Math.round(vw * 0.08), top: 0, width: Math.round(vw * 0.84), height: vh };
					const key = (box ? "" : "f:") + r.left + "," + r.top + "," + r.width + "," + r.height;
					if (key !== last) {
						last = key;
						setRect({ left: r.left, top: r.top, width: r.width, height: r.height, fallback: !box });
					}
				};
				tick();
				const timer = setInterval(tick, 300);
				return () => clearInterval(timer);
			}, [open]);
			// 页面几何变化（宿主布局/窗口缩放，由上方 300ms 轮询驱动 rect）后把助手面板
			// 收敛回页面内；effect 在 DOM 提交后运行，aiPageRect 读到的已是新尺寸
			React.useEffect(function () {
				if (aiStore.open) aiStore.normalize();
			}, [rect]);
			if (!open || rect === null) return null;
			return h("div", {
				className: "i2p-page", role: "region", "aria-label": "Issue2PR 工作台", tabIndex: -1,
				style: {
					left: rect.left + "px", top: rect.top + "px",
					width: rect.width + "px", height: rect.height + "px",
				},
			},
					rect.fallback ? h("div", { className: "i2p-page-hint" },
						"未能定位宿主主内容列，工作台暂以居中布局显示；宿主界面结构可能已更新。") : null,
					h("div", { className: "i2p-page-body" }, h(Section)),
					h(AssistantDock));
		}

		/* ================================================================
		 * apply：主入口 = 侧边栏底部按钮 + 主区整页工作台；
		 *        settings.section 保留为次级入口
		 * ================================================================ */
		function apply(ctx) {
			const t = ctx.locale.bind("issue2pr");
			ctx.effect(() => ctx.locale.register("issue2pr", { zh, en }), "issue2pr: dictionaries");
			ctx.slots.inject("settings.section", () => ctx.slots.register(
				{ name: "settings.section", id: "issue2pr", order: 17, label: () => t("nav"), locale: "issue2pr" }, Section));
			ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register(
				{ name: "sidebar.footer.action", id: "issue2pr", order: 30 }, FooterEntry), "issue2pr: sidebar entry");
			ctx.slots.inject("shell.overlay", () => ctx.slots.register(
				{ name: "shell.overlay", id: "issue2pr", order: 90 }, WorkbenchPage), "issue2pr: main-area page");
		}
		exports.apply = apply;
		exports.inject = ["slots", "locale"];
		return module.exports;
	}
});
