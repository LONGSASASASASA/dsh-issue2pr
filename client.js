// client.js — Issue2PR 工作台（项目 / 任务 / 全局设置）
// 设计语言：沿用 v9 明暗配色，主题选择跟随 DSH 宿主，
// 数据（id/路径/产物/耗时）用 JetBrains Mono，图标全 SVG 描边（无 emoji），
// 页面结构沿用 v9；任务头部、阶段导航和执行记录按二期紧凑原型演进。数据源 /issue2pr/api/*。
// 零 npm 依赖：React 与官方 UI 原语（MarkdownText 等）均来自宿主模块表（require），样式注入单个 <style> 标签。
window.__ModuleLoader__.load({
	id: "dsh-issue2pr",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const React = require("react");
		const { MarkdownText } = require("@deepseek-ai/dsh-client-ui-primitives");
		const h = React.createElement;
		// 宿主 Markdown 的代码块与脚注需要完整文案；保持引用稳定以复用渲染缓存。
		const MARKDOWN_LABELS = { code: { copyLabel: "复制", copiedLabel: "已复制" }, footnotes: "脚注" };
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
			  about: "失败旁路（仅在任一阶段失败时执行）：依据本轮报告和日志分析实现、测试、环境、权限、超时或取消问题，并给出处理路径（replan/rollback/escalate）。证据不足显示原因未确定；反复失败必须有真实历史记录支持。" },
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
			degraded:        ["t-warn", "已生成基础分析"],
			analysis_completed: ["t-good", "分析完成"],
			flow_ended:      ["t-off", "流程已结束"],
			acceptance_passed: ["t-good", "验收通过"],
			acceptance_failed: ["t-err", "验收未通过"],
			acceptance_pending: ["t-off", "验收待确认"],
			acceptance_loading: ["t-off", "读取验收…"],
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
.studio .studio-run-icon.flow_ended{color:var(--secondary)}
.studio .studio-run-icon.awaiting_review{color:var(--amber)}
.studio .studio-pagination{padding:12px 0;font-size:12px}
.studio .studio-empty{padding:55px 22px;text-align:center;max-width:570px;margin:0 auto;color:var(--secondary);display:grid;justify-items:center;gap:14px}
.studio .studio-empty h3{font-size:16px;color:var(--ink)}
.studio .studio-dialog{width:min(560px,calc(100vw - 32px));max-height:calc(100dvh - 48px);border:1px solid var(--line);border-radius:14px;padding:0;background:var(--surface);color:var(--ink);box-shadow:var(--shadow)}
.studio .studio-dialog.wide{width:min(960px,calc(100vw - 32px))}
.studio .studio-dialog::backdrop{background:#14232e55;backdrop-filter:blur(3px)}
.studio .studio-dialog-head{padding:20px 24px 12px}
.studio .studio-dialog-body{padding:8px 24px 24px;overflow-wrap:anywhere}
.studio .studio-dialog-body>p{color:var(--secondary);margin-bottom:17px}
.studio .studio-task{display:flex;flex-direction:column;flex:1;min-height:0;background:var(--surface)}
.studio .studio-task-head{padding:18px 26px 16px;flex:none;border-bottom:1px solid var(--line)}
.studio .studio-breadcrumb{font-size:12px;color:var(--muted);margin-bottom:4px;line-height:18px;flex-wrap:wrap}
.studio .studio-breadcrumb button{padding:0;color:var(--secondary)}
.studio .studio-breadcrumb .mono{max-width:170px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.studio .studio-task-title{gap:12px}
.studio .studio-task-title{flex-wrap:wrap}
.studio .studio-task-title h1{font-size:21px;line-height:30px;font-weight:650}
.studio .studio-task-name{flex:1;min-width:220px}
.studio .studio-task-caption{margin-top:5px;color:var(--secondary);font-size:13px;line-height:21px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}
.studio .studio-topology{padding:0 26px;border-bottom:1px solid var(--line);flex:none}
.studio .studio-workflow-summary{min-height:44px;gap:12px}
.studio .studio-workflow-summary strong{font-size:13px}
.studio .studio-track{display:grid;grid-template-columns:repeat(10,minmax(0,1fr));gap:2px;padding-top:6px}
.studio .studio-track.compact{padding:0 0 8px;overflow-x:auto;grid-template-columns:repeat(10,minmax(86px,1fr));scrollbar-width:thin}
.studio .studio-track.compact .studio-stage{flex-direction:row;justify-content:center;gap:5px;padding:7px 4px;white-space:nowrap}
.studio .studio-track.compact .studio-stage:before{display:none}
.studio .studio-track.compact .studio-stage-mark{width:16px;height:20px;margin:0;border:0;border-radius:0;background:transparent}
.studio .studio-track.compact .studio-stage .studio-stage-mark{background:transparent}
.studio .studio-track.compact .studio-stage-code{display:none}
.studio .studio-track.compact .studio-stage.on{border-color:var(--border);background:var(--accent-soft);color:var(--accent)}
.studio .studio-track.compact .studio-stage.acceptance_failed.on{background:var(--red-soft);color:var(--red)}
.studio .studio-track.compact .studio-stage.acceptance_pending.on,.studio .studio-track.compact .studio-stage.acceptance_loading.on{background:var(--soft);color:var(--secondary)}
.studio .studio-workflow-location{font-size:12px;color:var(--secondary)}
.studio .studio-workflow-summary{flex-wrap:wrap;gap:8px}
.studio .studio-flow-toggle{white-space:nowrap;font-size:12px;color:var(--accent);padding:5px 0}
.studio .studio-stage{border:1px solid transparent;border-radius:7px;padding:5px 2px;display:flex;align-items:center;flex-direction:column;position:relative;min-width:0}
/* 二期 S4：节点连线加粗并按阶段状态着色（原先 1px var(--line) 对比约 1.2:1 近不可见） */
/* 二期 E1：间距与连线缩短——连线两端各内缩 14px（避开 27px 圆点边缘），不再从圆心画到圆心 */
.studio .studio-stage:before{content:"";position:absolute;top:17px;right:calc(50% + 14px);width:calc(100% - 28px);height:2px;background:var(--border);border-radius:1px}
.studio .studio-stage.approved:before,.studio .studio-stage.completed:before,.studio .studio-stage.acceptance_passed:before{background:var(--accent)}
.studio .studio-stage.current:before{background:var(--blue)}
.studio .studio-stage.failed:before,.studio .studio-stage.acceptance_failed:before{background:var(--red)}
.studio .studio-stage.awaiting_review:before{background:var(--amber)}
.studio .studio-stage:first-child:before{display:none}
.studio .studio-stage:hover{background:var(--soft)}
.studio .studio-stage.on{background:var(--soft);border-color:var(--border)}
.studio .studio-stage-mark{width:27px;height:27px;display:grid;place-items:center;border:1px solid var(--border);background:var(--surface);border-radius:50%;position:relative;z-index:1;margin-bottom:7px;font-size:11px}
.studio .studio-stage.approved .studio-stage-mark,.studio .studio-stage.completed .studio-stage-mark,.studio .studio-stage.acceptance_passed .studio-stage-mark{background:var(--accent-soft);color:var(--accent);border-color:transparent}
.studio .studio-stage.current .studio-stage-mark{background:var(--blue-soft);color:var(--blue);border-color:transparent}
.studio .studio-stage.failed .studio-stage-mark,.studio .studio-stage.acceptance_failed .studio-stage-mark{background:var(--red-soft);color:var(--red);border-color:transparent}
.studio .studio-stage.acceptance_passed.current .studio-stage-mark{background:var(--accent-soft);color:var(--accent)}
.studio .studio-stage.acceptance_pending .studio-stage-mark,.studio .studio-stage.acceptance_loading .studio-stage-mark{background:var(--soft);color:var(--secondary)}
.studio .studio-stage.awaiting_review .studio-stage-mark{background:var(--amber-soft);color:var(--amber)}
.studio .studio-stage strong{font-size:13px;font-weight:400;line-height:1.5}
.studio .studio-stage-code{font-size:12px;color:var(--muted);margin-top:3px}
.studio .studio-track-footer{justify-content:space-between;font-size:12px;min-height:31px;color:var(--secondary)}
.studio .studio-return-lane{margin:0 0 8px;padding:5px 10px;border-radius:7px;background:var(--amber-soft);color:var(--amber);font-size:12px}
.studio .studio-tabs{display:flex;gap:24px;padding:0 26px;height:43px;border-bottom:1px solid var(--line);flex:none}
.studio .studio-tabs button{padding:0 1px}
.studio .studio-tabs button.on{color:var(--accent);border-bottom-color:var(--accent)}
.studio .studio-stage-bar{padding:12px 26px 0;flex:none;border-bottom:1px solid var(--line)}
.studio .studio-stage-bar .studio-section-heading{margin:0 0 8px}
.studio .studio-stage-bar h2{font-size:17px;font-weight:650}
.studio .studio-runtime-meta{font-size:12px;flex:1;min-width:120px;overflow-wrap:anywhere}
.studio .studio-activity{margin:0 0 14px;padding:12px 16px;background:var(--soft);border:1px solid var(--line);border-radius:8px;display:grid;gap:8px;min-width:0}
.studio .studio-activity-dot{width:7px;height:7px;display:inline-block;border-radius:50%;background:var(--accent);margin-right:8px}
.studio .studio-activity.warn .studio-activity-dot{background:var(--amber)}
.studio .studio-activity.bad .studio-activity-dot{background:var(--red)}
.studio .studio-activity.quiet .studio-activity-dot{background:var(--muted)}
.studio .studio-activity-task{padding-top:8px;border-top:1px solid var(--line);min-width:0}
.studio .studio-activity summary{cursor:pointer;overflow-wrap:anywhere}
.studio .studio-activity pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:180px;overflow:auto;margin:8px 0 0}
.studio .studio-activity time{font-variant-numeric:tabular-nums}
.studio .studio-stage-tabs{display:flex;align-items:stretch;gap:20px;min-width:0;overflow-x:auto}
.studio .studio-stage-tabs .studio-execution-tabs{margin:0;border:0;flex-shrink:0}
.studio .studio-stage-tabs .studio-execution-tabs button{padding:8px 3px;margin-right:10px;white-space:nowrap;background:none}
.studio .studio-stage-tabs .studio-tabs{padding:0;height:38px;border:0;margin-left:auto;gap:14px;white-space:nowrap}
.studio .studio-stage-tabs .studio-tabs button{font-size:12px}
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
/* 二期 A2/A3：外部执行事件表——四列单行、行高 34px、区域内横滚不撑破页面 */
.studio .studio-events{border:1px solid var(--line);border-radius:10px;min-width:0}
.studio .studio-events-toolbar .f-select{width:180px;min-height:34px;padding:4px 9px;font-size:12px}
.studio .studio-events-toolbar .f-input{width:auto;flex:1;min-width:180px;min-height:34px;padding:4px 9px;font-size:12px}
.studio .studio-events-scroll{overflow:visible}
.studio .studio-events-grid{min-width:0}
.studio .studio-events-head,.studio .studio-event-row{display:grid;grid-template-columns:76px 92px 150px minmax(220px,1fr);gap:12px;align-items:center;padding:0 12px}
.studio .studio-events-head{height:30px;font-size:12px;color:var(--muted);border-bottom:1px solid var(--line);background:var(--soft);position:sticky;top:0;z-index:1}
.studio .studio-event-row{height:34px;width:100%;border:0;border-bottom:1px solid var(--line);text-align:left;font-size:12px;background:transparent}
.studio .studio-event-row:hover,.studio .studio-event-row.on{background:var(--soft)}
.studio .studio-event-row>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.studio .studio-event-full{padding:10px 12px;border-bottom:1px solid var(--line);background:var(--soft);white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.7 var(--mono)}
.studio .studio-timeline{min-width:0}
.studio .studio-timeline-status{position:sticky;bottom:0;padding:7px 10px;background:var(--surface);border:1px solid var(--line);border-radius:7px;z-index:2;font-size:12px}
.studio .studio-timeline.focused{display:flex;flex-direction:column;height:min(64dvh,640px);gap:10px}
.studio .studio-timeline.focused .studio-events{flex:1;min-height:0;overflow:hidden;display:flex;flex-direction:column}
.studio .studio-timeline.focused .studio-events-scroll{overflow:auto;min-height:0;flex:1}
.studio .studio-timeline-status .hint{flex:1;min-width:140px}
.studio .studio-input-summary{display:flex;align-items:baseline;gap:10px;min-width:0}
.studio .studio-input-summary .studio-message-body{flex:1;min-width:0;margin:0}
.studio .studio-output-files{margin-top:8px}
.studio .studio-output-files summary{margin-top:8px}
.studio .studio-instance-meta{margin-left:auto}
/* 二期 A1：单轮结构消息块（输入/输出）；A4：详情弹窗分区与命中高亮 */
.studio .studio-message{border:1px solid var(--line);border-radius:10px;padding:10px 13px}
.studio .studio-message-body{margin:4px 0 0;color:var(--secondary);line-height:1.7;overflow-wrap:anywhere}
.studio .studio-turn{position:relative;padding-left:30px;min-width:0}
.studio .studio-turn:before{content:"";position:absolute;left:8px;top:14px;bottom:0;width:1px;background:var(--border)}
.studio .studio-turn-head{position:relative;display:flex;align-items:center;flex-wrap:wrap;gap:10px;min-height:30px;margin-bottom:10px}
.studio .studio-turn-head:before{content:"";position:absolute;left:-29px;top:7px;width:15px;height:15px;border:2px solid var(--accent);border-radius:50%;background:var(--surface);box-sizing:border-box}
.studio .studio-turn-head h3{font-weight:650;font-size:14px}
.studio .studio-turn-time{margin-left:auto;font-size:12px;color:var(--muted)}
.studio .studio-turn-body{display:grid;gap:14px;min-width:0}
.studio .studio-turn-body>.studio-message:first-child{background:var(--soft)}
.studio .studio-detail-section h3{font-size:13px;font-weight:600;margin:0}
.studio .studio-detail-body{margin:6px 0 0;padding:10px 12px;background:var(--soft);border-radius:8px;font:12px/1.7 var(--mono);white-space:pre-wrap;overflow-wrap:anywhere;max-height:50vh;overflow:auto}
.studio .studio-detail-body .hit{background:var(--warn-bg);color:var(--warn);border-radius:3px}
.studio .studio-terminal-shell{background:var(--terminal);color:var(--term-text);border-radius:9px;overflow:hidden}
.studio .studio-terminal-head{min-height:36px;padding:3px 12px;border-bottom:1px solid #ffffff14;font-size:12px}
.studio .studio-terminal-tools{padding:7px 14px;border-bottom:1px solid #ffffff14;font-size:12px;gap:10px}
.studio .studio-terminal-tools input{background:#ffffff08;color:var(--term-text);border:1px solid #ffffff25;border-radius:5px;min-width:0;width:210px;padding:2px 8px;font:12px/18px var(--mono)}
.studio .studio-terminal-tools input::placeholder{color:#a6bbc5}
.studio .studio-terminal-tools button{color:#c5d8e2;white-space:nowrap}
.studio .studio-terminal{font:13px/1.9 var(--mono);min-height:0;overflow-x:auto;padding:13px 16px;white-space:pre}
.studio .studio-terminal-shell.focused{display:flex;flex-direction:column}
.studio .studio-terminal-shell.focused:not(.browsing){height:auto}
.studio .studio-terminal-shell.focused.browsing{height:min(64dvh,640px)}
.studio .studio-terminal-shell:not(.browsing) .studio-terminal>div{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.studio .studio-terminal-shell.focused .studio-terminal{min-height:0;flex:1;overflow:auto}
.studio .studio-terminal-shell.focused .studio-terminal-head,.studio .studio-terminal-shell.focused .studio-terminal-tools,.studio .studio-terminal-shell.focused .studio-terminal-foot{flex-shrink:0}
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
/* 二期 B：P2 候选文件卡片——文件、职责、置信度与证据相邻呈现（替代通用 kv 表标签与值分离） */
.studio .studio-candidate{border:1px solid var(--line);border-radius:7px;padding:10px 13px}
.studio .studio-candidate-head{gap:9px}
.studio .studio-candidate-head strong{font-size:13px;font-weight:600;overflow-wrap:anywhere}
.studio .studio-candidate-evidence{margin:6px 0 0;font-size:13px;color:var(--secondary);line-height:1.7;overflow-wrap:anywhere}
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
.studio .studio-dialog .studio-files{height:min(70dvh,620px)}
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
 .studio .studio-task-head{padding:14px 18px}
 .studio .studio-task-title h1{font-size:18px;line-height:26px}
 .studio .studio-topology{padding:0 18px}
 .studio .studio-stage-bar{padding:10px 18px 0}
 .studio .studio-process{padding:16px 18px}
 .studio .studio-stage-tabs{flex-wrap:wrap;gap:0}
 .studio .studio-stage-tabs .studio-execution-tabs{flex:1;overflow-x:auto}
 .studio .studio-turn{padding-left:24px}
 .studio .studio-turn-head:before{left:-23px}
 .studio .studio-events-head,.studio .studio-event-row{grid-template-columns:64px 70px 84px minmax(0,1fr);gap:8px;padding:0 8px}
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
			React.useLayoutEffect(() => {
				const previous = document.activeElement, dialog = ref.current;
				dialog.showModal();
				return () => { dialog.close(); if (previous?.isConnected) previous.focus(); };
			}, []);
			return h("dialog", { ref, className: "studio-dialog" + (wide ? " wide" : ""), "aria-label": title,
				onCancel: e => { e.preventDefault(); onClose(); } },
				h("div", { className: "studio-row studio-dialog-head" }, h("h2", { className: "studio-grow" }, title),
					studioButton("关闭", onClose, "ghost sm")), h("div", { className: "studio-dialog-body" }, children));
		}
		function useRunArtifact(slug, runId, path, tree, mode = "", identity = "") {
			const file = (tree || []).find(entry => entry.path === path);
			const param = mode === "tail" ? "&tail=1" : mode === "full" ? "&full=1" : "";
			return useResource(slug && runId && path && file
				? [slug, runId, path, file.mtimeMs, file.size, mode, identity].join("|") : null,
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
		// TASK-10：完整产物下载链接（服务端按字节流发送，无 200KB/5MB 预览上限）。
		// 预览读取上限只约束查看，不反向变成存储截断——大文件从这里拿完整内容。
		function artifactDownloadHref(slug, runId, path) {
			return API + "/projects/" + encodeURIComponent(slug) + "/runs/" + encodeURIComponent(runId)
				+ "/artifact?path=" + encodeURIComponent(path) + "&download=1";
		}
		// TASK-10：结构化错误（run.json 的 st.errorInfo）→ 错误类别徽标。
		// 区分协议错误 / 调用错误 / 业务验收失败 / 留档不完整，四类互斥可叠加（如协议错误 + 留档写入失败）。
		// 补全：环境错误（开工前 clone/凭据缺失）与外部执行失败（委外执行器观测事实）单列徽标。
		const LLM_CAUSE_LABELS = { timeout: "超时", provider: "服务错误", cancelled: "取消", empty: "空响应", unknown: "未知" };
		const LOG_INTEGRITY_LABELS = { partial: "部分写入", write_failed: "写入失败", corrupt: "校验损坏", open: "未封存" };
		const DELEGATE_KIND_LABELS = { spawn: "启动失败", timeout: "超时终止", "result-error": "错误结果", exit: "异常退出", empty: "空输出", agent: "异常结束" };
		function errorKindChips(info) {
			if (!info || typeof info !== "object") return [];
			const chips = [];
			const code = String(info.code || "");
			if (["json_parse_failed", "schema_validation_failed", "output_truncated"].includes(code))
				chips.push({ kind: "protocol", label: "协议错误 · " + (code === "output_truncated" ? "输出截断" : "JSON 契约") });
			if (code === "llm_call_failed")
				chips.push({ kind: "call", label: "调用错误 · " + (LLM_CAUSE_LABELS[info.llmCause] || "未知原因") });
			if (code === "business_gate_failed") chips.push({ kind: "gate", label: "业务验收失败" });
			if (code === "environment_error") chips.push({ kind: "env", label: "环境错误" });
			if (DELEGATE_KIND_LABELS[info.failureKind]) chips.push({ kind: "exec", label: "外部执行失败 · " + DELEGATE_KIND_LABELS[info.failureKind] });
			if (LOG_INTEGRITY_LABELS[info.logIntegrity]) chips.push({ kind: "archive", label: "留档不完整 · " + LOG_INTEGRITY_LABELS[info.logIntegrity] });
			return chips;
		}
		const ERROR_CHIP_TAGS = { protocol: "t-warn", call: "t-acc", gate: "t-err", archive: "t-off", env: "t-acc", exec: "t-acc" };
		function ArtifactContent({ text, path, raw = false, numbered: wantNumbers = false }) {
			if (text == null) return h("p", { className: "hint" }, "读取中…");
			if (!text) return h("p", { className: "hint" }, "空文件");
			return !raw && /\.md$/i.test(path) ? h("div", { className: "md-view" }, h(MarkdownText, { text, labels: MARKDOWN_LABELS }))
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
				|| (["08-test-output.txt", "08-test-activity.json"].includes(path) ? "P8" : path === "11-eval-report.json" ? "P11" : null)
				|| STAGES.find(item => run?.stages?.[item.id]?.artifact === path)?.id;
			const owners = instances.filter(item => item && executionPatchPath(item.patch) === path);
			return { stage: stage || "other", label: stage ? stage + " " + STUDIO_STAGE_NAMES[stage] : "其他文件 · 归属未确认",
				instance: owners.length === 1 && typeof owners[0].node === "string" ? owners[0].node : null };
		}
		function artifactLabel(path) {
			if (/external-exec\.messages\.jsonl$/.test(path)) return "Agent 完整原始消息";
			if (/external-exec\.events\.jsonl$/.test(path)) return "Agent 事件摘要与原始消息索引";
			if (/events\.jsonl$/.test(path)) return "全过程事件";
			if (/spans\.jsonl$/.test(path)) return "阶段耗时记录";
			if (/^reviews\//.test(path)) return "人工复核记录";
			if (/task\.md$/.test(path)) return "委托输入";
			if (/\.(diff|patch)$/.test(path)) return "代码补丁";
			if (/external-exec\.log$/.test(path)) return "外部执行输出";
			if (/coder-report\.json$/.test(path)) return "实例结果汇总";
			if (/test-report\.json$/.test(path)) return "任务测试结论";
			if (/test-output\.txt$/.test(path)) return "测试命令输出";
			if (path === "08-test-activity.json") return "测试执行状态";
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
			const [raw, setRaw] = React.useState(!!p.initialRaw);
			const [page, setPage] = React.useState(0);
			const [collapsed, setCollapsed] = usePreference(memoryKey + ".collapsed", {});
			const reader = React.useRef(null), treeRef = React.useRef(null);
			const files = p.tree || [];
			const path = files.some(file => file.path === selected) || (p.initialPath && selected === p.initialPath) ? selected : files[0]?.path || "";
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
						p.onReturn ? studioButton(p.returnLabel || "返回现场", p.onReturn, "ghost sm") : null,
						studioButton("复制", () => copyStudio(content.value, p.toast), "ghost sm", content.value == null),
						// TASK-10：超预览上限的文件提供服务端完整下载（字节流无上限）；已读内容仍可另存片段
						partial && p.slug && p.runId && path ? h("a", { className: "btn ghost sm", href: artifactDownloadHref(p.slug, p.runId, path) }, "下载完整文件") : null,
						studioButton(partial ? "下载已读内容" : "下载", () => downloadStudio(path, content.value), "ghost sm", content.value == null),
						studioButton("打开目录", async () => { try {
							const result = await apiPost("/projects/" + p.slug + "/runs/" + p.runId + "/open", {}); p.toast(result.message || "已打开", result.ok ? "ok" : "bad");
						} catch (error) { p.toast(error.message, "bad"); } }, "ghost sm")),
						h("div", { className: "hint studio-path" }, (p.project?.name || p.slug) + " · " + owner.label + (owner.instance ? " · " + owner.instance : "") + " · 当前存储文件"),
						h("div", { className: "mono hint studio-path" }, path),
						h("div", { className: "studio-row" }, h("span", { className: "hint studio-grow" }, fmtSize(file?.size) + (content.value != null ? " · " + (partial ? "尾部 " : "") + content.value.split("\n").length + " 行" : "")),
						h("nav", { className: "studio-segmented", "aria-label": "文件显示方式" }, [[false, "排版"], [true, "原文"]].map(([value, label]) =>
							h("button", { key: label, type: "button", className: raw === value ? "on" : "", "aria-pressed": raw === value, onClick: () => setRaw(value) }, label)))),
					owner.stage !== "task" && owner.stage !== "other" ? h("p", { className: "hint" }, evidenceState(p.run, owner.stage, file)) : null,
						partial ? h("p", { className: "callout warn" }, "文件超过预览上限，仅显示尾部最近内容；复制/下载为该部分，完整内容请打开目录查看原文件。") : null,
					h(ResourceNotice, { resource: content }), pages > 1 ? h("div", { className: "studio-row" }, studioButton("上一段", () => setPage(safePage - 1), "sm", safePage === 0),
						h("span", { className: "hint" }, (safePage + 1) + " / " + pages), studioButton("下一段", () => setPage(safePage + 1), "sm", safePage + 1 === pages)) : null),
					h("div", { className: "studio-file-reader", ref: reader, onScroll: e => writePreference(memoryKey + ".scroll." + path, e.currentTarget.scrollTop) },
						path && !file ? h(EmptyState, { title: "文件当前不存在" }, h("p", null, "此文件尚未生成或已移除，可从左侧选择其他产物。")) : path ? !raw && /\.(diff|patch)$/i.test(path) ? h(DiffContent, { text: content.value?.slice(safePage * 60000, (safePage + 1) * 60000), path })
							: h(ArtifactContent, { text: content.value == null ? null : content.value.slice(safePage * 60000, (safePage + 1) * 60000), path, raw: raw || pages > 1, numbered: pages > 1 && !raw })
							: h(EmptyState, { title: "暂未生成文件" }))));
		}

		// 所有产物入口共用同一弹窗与阅读器；来自详情/专注日志时替换该弹窗并保留返回入口。
		function ArtifactsDialog(p) {
			return h(StudioDialog, { title: "全部产物 · " + (p.tree || []).length + " 个文件", wide: true, onClose: p.onClose },
				h(ArtifactsPanel, p));
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
			if (stage === "P11") return "本轮评测已执行，验收结论以评测报告为准";
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
		// 流程执行状态不能代替验收结论；历史 completed 记录也必须核对实际评测文件。
		function deliveryEvaluation(resource, run, tree, description) {
			const file = (tree || []).find(item => item.path === "11-eval-report.json");
			if (resource?.error) return { state: "unknown", message: "验收结论未能确认：评测报告读取失败" };
			if (resource?.value == null) return file
				? { state: "loading", message: "正在读取验收结论…" }
				: { state: "unknown", message: "验收结论未能确认：评测报告尚未生成" };
			const report = parseJson(resource.value), keys = ["ROOT", "PATCH", "TEST", "DIFF", "DESC", "ACCEPT"];
			if (!report || typeof report !== "object" || Array.isArray(report)
				|| !keys.every(key => ["pass", "fail"].includes(report[key]) || (report.schemaVersion === 2 && report[key] === null)))
				return { state: "unknown", message: "验收结论未能确认：评测报告格式异常或门禁记录不完整" };
			const startedAt = Date.parse(run?.stages?.P11?.startedAt);
			if (Number.isFinite(file?.mtimeMs) && Number.isFinite(startedAt) && file.mtimeMs < startedAt)
				return { state: "unknown", message: "验收结论未能确认：当前文件早于本轮评测，请重新评测" };
			if (keys.some(key => report[key] === "fail")) return { state: "fail", report };
			if (!keys.every(key => report[key] === "pass")) return { state: "unknown", message: "验收结论未能确认：仍有门禁未评测", report };
			if (description?.error) return { state: "unknown", message: "验收结论未能确认：交付说明读取失败" };
			if (description?.value == null) return (tree || []).some(item => item.path === "10-pr-description.md")
				? { state: "loading", message: "正在读取交付说明…" }
				: { state: "unknown", message: "验收结论未能确认：交付说明尚未生成" };
			if (!String(description.value).trim()) return { state: "unknown", message: "验收结论未能确认：交付说明为空" };
			return { state: "pass", report };
		}
		function p11DisplayStatus(run, evaluation) {
			const status = run?.stages?.P11?.status || "pending";
			if (["pending", "running", "stopped"].includes(status)) return status;
			if (evaluation.state === "fail") return "acceptance_failed";
			if (status === "failed") return status;
			if (evaluation.state === "loading") return "acceptance_loading";
			if (evaluation.state !== "pass") return "acceptance_pending";
			return ["approved", "completed"].includes(status) ? "acceptance_passed" : status;
		}
		function taskDisplayStatus(run, evaluation) {
			if (run.status !== "completed") return run.status;
			const status = p11DisplayStatus(run, evaluation);
			return status.startsWith("acceptance_") ? status : "acceptance_pending";
		}
		function gateReasons(report, name) {
			return Array.isArray(report?.reasons?.[name]) ? report.reasons[name].filter(line => typeof line === "string" && line.trim()) : [];
		}
		// 二期 S1：门禁值分色——未通过必须红章可一眼识别，通过绿章，其余保持灰提示。
		function gateValue(value, unassessed = false) {
			return value === "pass" ? h("span", { className: "tg t-good" }, Ic("check", 11), "通过")
				: value === "fail" ? h("span", { className: "tg t-err" }, Ic("x", 11), "未通过")
				: h("span", { className: "hint" }, unassessed ? "未评测" : gateLabel(value));
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
		const GATE_NAMES = { ROOT: "根因证据", PATCH: "补丁应用", TEST: "回归测试", DIFF: "变更审查", DESC: "说明忠实", ACCEPT: "验收门禁" };
		// 二期 C2：失败门禁「查看证据」跳转映射——文件类直跳对应产物，ACCEPT 跨全流程只能看汇总
		const GATE_EVIDENCE = { ROOT: "04-hypotheses.json", PATCH: "ledger/patch-ledger.jsonl", TEST: "07-test-report.json", DIFF: "08-review-report.json", DESC: "10-pr-description.md", ACCEPT: "summary" };
		function DeliveryPanel({ run, tree, description, evaluation, toast, onFile, onSummary }) {
			const stats = gateStats(evaluation);
			const assessment = deliveryEvaluation(evaluation, run, tree, description);
			const report = parseJson(evaluation.value);
			// 二期 C3：PATCH 未通过时直显证据校验具体原因（报告已含 patchEvidence.errors 字符串数组）
			const patchErrors = report?.PATCH === "fail" && !gateReasons(report, "PATCH").length && Array.isArray(report?.patchEvidence?.errors)
				? report.patchEvidence.errors.filter(item => typeof item === "string" && item.trim()) : [];
			// 二期 C1：存在未通过门禁时顶部警示条；流程未收尾（复核中）时不说「已结束」
			const ended = ["completed", "failed", "stopped"].includes(run.status);
			return h("div", { className: "studio-stack" },
				assessment.state === "fail" ? h("div", { className: "callout err" }, h("strong", null, (ended ? "流程已结束，" : "") + "交付验收尚未通过 · " + stats.fail + " 项未通过"))
					: assessment.message ? h("p", { className: "callout" }, assessment.message) : null,
				h("div", { className: "studio-row wrap" }, h("h2", { className: "studio-grow" }, "交付与验收"), h("span", { className: "hint" }, "远程 PR 尚未创建"),
					studioButton("复制说明", () => copyStudio(description.value, toast), "sm", description.value == null)),
				h("div", { className: "studio-grid" }, Object.keys(GATE_NAMES).map(name => h("div", { className: "studio-check", key: name },
					h("div", { className: "studio-row" }, h("span", { className: "studio-grow" }, GATE_NAMES[name]), gateValue(report?.[name], report?.schemaVersion === 2 && report[name] === null)),
					report?.[name] === "fail" || (report?.schemaVersion === 2 && report[name] === null) ? h("div", { className: "studio-gate-reasons" }, gateReasons(report, name).length
						? gateReasons(report, name).map((line, index) => h("p", { key: index, className: "studio-path" }, line))
						: h("p", { className: "studio-path" }, report.reasons == null ? "旧报告未记录原因，需重新评测" : "报告未记录有效原因，需重新评测")) : null,
					report?.[name] === "fail" ? h("div", { className: "studio-row" }, h("span", { className: "studio-grow" }),
						GATE_EVIDENCE[name] === "summary" ? studioButton("查看汇总", () => onSummary?.(), "ghost sm")
							: studioButton("查看证据 ↗", () => onFile(GATE_EVIDENCE[name]), "ghost sm", !tree.some(file => file.path === GATE_EVIDENCE[name]))) : null))),
				patchErrors.length ? h("div", { className: "callout err" }, h("strong", null, "补丁应用证据校验未通过 · 原因"), patchErrors.map((line, i) => h("p", { key: i, className: "studio-path" }, line))) : null,
				// 二期 S2：报告可解析时尾部给门禁汇总，替代无条件「本轮阶段已通过」的成功叙事
				h("p", { className: "hint" }, stats ? stats.total + " 项门禁：" + stats.pass + " 通过 / " + stats.fail + " 未通过"
					+ (stats.total - stats.pass - stats.fail > 0 ? " / " + (stats.total - stats.pass - stats.fail) + (report?.schemaVersion === 2 ? " 未评测 / 待确认" : " 未记录") : "")
					: assessment.message), h(ResourceNotice, { resource: evaluation }), h(ResourceNotice, { resource: description }),
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
		// 二期 B：P2 检索结果按候选文件卡片呈现——文件、职责、置信度与证据相邻（02-search-candidates.json 契约字段）。
		function SearchCandidatesCard({ parsed }) {
			const rows = (Array.isArray(parsed?.candidates) ? parsed.candidates : []).filter(item => item && typeof item === "object");
			const conf = value => ({ high: ["t-good", "高"], medium: ["t-warn", "中"], low: ["t-off", "低"] })[String(value ?? "").toLowerCase()] || ["t-off", "未标注"];
			const list = (title, values) => Array.isArray(values) && values.length ? h("details", null,
				h("summary", null, title + " · " + values.length),
				h("div", { className: "studio-plan-tags" }, values.map((item, i) => h("span", { key: i, className: "studio-path" }, typeof item === "string" ? item : JSON.stringify(item))))) : null;
			return h("div", { className: "studio-stack" },
				h("p", { className: "hint" }, "候选 " + rows.length + " 个文件，按相关度排序；证据为检索阶段的选择理由，代码细节见后续阶段。"),
				rows.map((row, i) => h("article", { className: "studio-candidate", key: i },
					h("div", { className: "studio-row wrap studio-candidate-head" },
						h("strong", { className: "mono studio-path" }, String(row.path || "—")),
						row.role != null && String(row.role) ? h("span", { className: "hint" }, String(row.role)) : null,
						h("span", { className: "tg " + conf(row.confidence)[0] }, conf(row.confidence)[1] + " 置信度")),
					row.evidence != null && String(row.evidence) ? h("p", { className: "studio-candidate-evidence" }, h("span", { className: "hint" }, "证据 · "), String(row.evidence)) : null)),
				list("测试候选文件", parsed?.test_candidates), list("待探索项", parsed?.uncertain));
		}
		function StageResult(p) {
			const state = p.run?.stages?.[p.stage], modernP10 = p.stage === "P10" && !!(state?.analysisId || state?.sourceStage);
			const currentAnalysis = modernP10 && !!currentP10(p.run), finishedAnalysis = currentAnalysis && ["approved", "completed", "degraded"].includes(state.status);
			const candidates = stageFiles(p.stage, p.tree, p.run).filter(file => !/\/task|task\.md$|\.log$|\.jsonl$/.test(file.path));
			const file = modernP10 ? finishedAnalysis && p.tree.find(file => file.path === (state.artifact || "trace/failures/" + state.analysisId + ".json"))
				: candidates.find(file => file.path === state?.artifact) || candidates[0];
			const resource = useRunArtifact(p.slug, p.runId, file?.path, p.tree);
			let parsed = null, parseError = false;
			if (resource.value != null) {
				try { parsed = JSON.parse(resource.value); } catch { parseError = true; }
			}
			if (modernP10) {
				const loading = !!file && resource.value == null && !resource.error;
				const schemaValid = parsed && !Array.isArray(parsed) && typeof parsed === "object"
					&& typeof parsed.category === "string" && !!parsed.category.trim() && ["replan", "rollback", "escalate"].includes(parsed.action)
					&& typeof parsed.analysisId === "string" && !!parsed.analysisId && typeof parsed.sourceStage === "string" && !!parsed.sourceStage
					&& (parsed.sourceStartedAt === null || typeof parsed.sourceStartedAt === "string" && !!parsed.sourceStartedAt);
				const identityValid = schemaValid && parsed.analysisId === state.analysisId && parsed.sourceStage === state.sourceStage
					&& (parsed.sourceStartedAt || null) === (state.sourceStartedAt || null);
				const valid = finishedAnalysis && !resource.error && identityValid;
				const taskFile = currentAnalysis && state.status === "awaiting_review" && p.tree.find(file => file.path === state.artifact);
				const historicalFile = p.tree.find(file => file.path === "09-failure-analysis.json");
				const message = !currentAnalysis ? "历史失败分析，不代表本轮执行结果。"
					: state.status === "running" ? "正在分析本轮失败，结果生成后会显示在这里。"
						: state.status === "awaiting_review" ? "等待本轮外部失败分析。提交外部报告后重跑 P10 读取。"
							: state.status === "failed" ? "本轮失败分析未完成，可查看阶段事件和错误详情。"
								: !file ? "本轮失败分析报告尚未生成。" : resource.error ? "本轮失败分析读取失败：" + resource.error
									: loading ? "正在读取本轮失败分析…" : parseError ? "报告不是有效 JSON，未作为本轮结果展示。"
										: !schemaValid ? "报告结构无效，缺少必要字段或字段值不符合约定，未作为本轮结果展示。"
											: !identityValid ? "报告分析身份不匹配，未作为本轮结果展示。" : "";
				return h("div", { className: "studio-stack" },
					message ? h("p", { className: resource.error ? "callout err" : "hint", role: resource.error ? "alert" : "status" }, message) : null,
					resource.error ? studioButton("重试读取本轮分析", resource.reload, "sm") : null,
					valid ? h(ReadableValue, { value: parsed }) : null,
					taskFile ? studioButton("查看本轮分析任务包", () => p.onFile(taskFile.path), "ghost sm") : null,
					currentAnalysis && state.status === "awaiting_review" && state.responseArtifact ? h("p", { className: "studio-path hint" }, "外部报告位置：", state.responseArtifact) : null,
					valid ? studioButton("查看结果文件", () => p.onFile(file.path), "ghost sm")
						: historicalFile ? studioButton("查看历史分析文件", () => p.onFile(historicalFile.path), "ghost sm") : null);
			}
			const nodes = Array.isArray(parsed?.nodes) ? parsed.nodes.filter(node => node && typeof node === "object") : null;
			const text = value => value == null ? "" : Array.isArray(value) ? value.map(text).join("、") : typeof value === "object" ? JSON.stringify(value) : String(value);
			return h("div", { className: "studio-stack" }, h(ResourceNotice, { resource }),
				!file ? h(EmptyState, { title: "本阶段尚未生成结果" }, h("p", null, "执行结果生成后会显示在这里，平台执行记录可通过阶段标题旁的「阶段事件」查看。")) :
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
				p.stage === "P2" && Array.isArray(parsed?.candidates) ? h(SearchCandidatesCard, { parsed }) :
				parsed && typeof parsed === "object" ? h(ReadableValue, { value: parsed }) : h(ArtifactContent, { text: resource.value, path: file.path }),
				file ? studioButton("查看结果文件", () => p.onFile(file.path), "ghost sm") : null);
		}
		// 日志预览自动读尾部，搜索按需读取 full=1（服务端上限 5MB）。同一轮更新失败保留快照；切任务、重跑或删除文件时清空。
		const LOG_PREVIEW_LINES = 5, LOG_PAGE_LINES = 50;
		function useLogArtifact(slug, runId, path, tree, identity = "") {
			const file = (tree || []).find(entry => entry.path === path), source = [slug, runId, path, identity].join("|");
			const cache = React.useRef({ source: null, generation: 0 });
			const previous = cache.current;
			const reset = previous.source !== source || (!!previous.exists && !file)
				|| (file && previous.exists && (file.size < previous.size || file.mtimeMs < previous.mtimeMs));
			if (reset) cache.current = { source, generation: previous.generation + 1, value: null, full: null };
			const snapshot = cache.current;
			snapshot.exists = !!file; snapshot.size = file?.size; snapshot.mtimeMs = file?.mtimeMs;
			const scope = source + "|" + snapshot.generation, partial = file?.size > 200 * 1024;
			const [requested, setRequested] = React.useState(null), wantsFull = requested === scope && !!file && partial;
			const preview = useRunArtifact(slug, runId, path, tree, partial ? "tail" : "", scope);
			const complete = useRunArtifact(slug, runId, wantsFull ? path : null, tree, "full", scope);
			if (file && preview.value != null) snapshot.value = preview.value;
			if (file && wantsFull && complete.value != null) snapshot.full = complete.value;
			const resource = { ...preview, value: file ? snapshot.value ?? null : null, loading: !!file && preview.value == null && !preview.error, scope, available: !!file };
			const full = partial ? { ...complete, value: wantsFull ? snapshot.full ?? null : null,
				loading: wantsFull && complete.value == null && !complete.error, stale: wantsFull && complete.value == null && snapshot.full != null } : resource;
			return { resource, full, partial, onFull: () => { if (file && partial) setRequested(scope); } };
		}
		function stageLogText(value, stage) {
			if (value == null || !stage) return value;
			return parseLines(value).filter(event => event.stage === stage)
				.map(event => [fmtClock(event.at), event.kind, event.name, event.detail].filter(Boolean).join("  ")).join("\n");
		}
		function RunLogPanel(p) {
			const own = useLogArtifact(p.slug, p.runId, p.log ? null : p.path, p.tree, p.identity);
			const log = p.log || own;
			const display = value => { const text = stageLogText(value, p.stage); return text == null ? text : p.format ? p.format(text) : text; };
			return h(OutputPanel, { ...p, text: display(log.resource.value) || "", resource: log.resource,
				full: { ...log.full, value: display(log.full.value) }, onFull: log.onFull, partial: log.partial,
				searchScope: p.stage ? "本阶段事件" : p.searchScope,
				artifactProps: p.artifactProps ? { ...p.artifactProps, initialPath: p.path, initialRaw: true } : undefined });
		}
		function OutputPanel({ text = "", resource, full, onFull, label, memoryKey, filename, toast, onFile, partial = false, artifactProps, dialog = false, onClose, onInspect, searchScope = "日志全文", emptyText = "尚未记录输出", slug = "", runId = "", path = "" }) {
			const [search, setSearch] = React.useState(""), [matchPage, setMatchPage] = React.useState(0);
			const [follow, setFollow] = usePreference(memoryKey + ".follow", true), [wrap, setWrap] = usePreference(memoryKey + ".wrap", true);
			const [expanded, setExpanded] = React.useState(false), [history, setHistory] = React.useState(false), [historyPage, setHistoryPage] = React.useState(null);
			const [fileOpen, setFileOpen] = React.useState(false), [unseen, setUnseen] = React.useState(0), [readingVersion, setReadingVersion] = React.useState(0);
			const ref = React.useRef(null), root = React.useRef(null), scroller = React.useRef(null);
			const expandButton = React.useRef(null), returnFocus = React.useRef(false), workspaceTop = React.useRef(null), lastScroll = React.useRef(0);
			const focused = dialog || expanded, query = search.trim().toLowerCase(), reading = history || !!query;
			const scope = memoryKey + "|" + (resource?.scope || ""), linesOf = value => value ? String(value).replace(/\r?\n$/, "").split("\n") : [];
			const lines = linesOf(text), preview = React.useRef({ scope, text, initialized: resource ? resource.value != null : true }), readingSnapshot = React.useRef({ key: null });
			if (preview.current.scope !== scope) preview.current = { scope, text, initialized: resource ? resource.value != null : true };
			if ((follow && !reading && !fileOpen) || (!preview.current.initialized && resource?.value != null && !reading && !fileOpen)) {
				preview.current.text = text; if (text || resource?.value != null) preview.current.initialized = true;
			}
			const previewText = preview.current.text, previewLines = linesOf(previewText);
			const readingKey = scope + "|" + readingVersion;
			if (reading && readingSnapshot.current.key !== readingKey) readingSnapshot.current = { key: readingKey, value: full?.value ?? previewText,
				complete: full?.value != null || (!partial && (!resource || resource.value != null)) };
			// 全量首次返回时扩充历史快照；之后的新记录只累计提示，不能挤走正在阅读的历史页。
			if (reading && !readingSnapshot.current.complete && full?.value != null) readingSnapshot.current = { key: readingKey, value: full.value, complete: true };
			const readText = reading ? String(readingSnapshot.current.value || "") : previewText;
			const readLines = linesOf(readText), filtered = query ? readLines.filter(line => line.toLowerCase().includes(query)) : readLines;
			const pages = Math.max(1, Math.ceil(filtered.length / LOG_PAGE_LINES));
			const page = Math.min(query ? matchPage : historyPage ?? pages - 1, pages - 1);
			const visibleLines = reading ? filtered.slice(page * LOG_PAGE_LINES, (page + 1) * LOG_PAGE_LINES) : previewLines.slice(-LOG_PREVIEW_LINES);
			const errorLine = /(error|failed|fatal|失败|✖|exit code [1-9]|exit [1-9]\b)/i;
			const observed = React.useRef({ scope, lines, ready: resource ? resource.value != null : true });
			React.useEffect(() => { setUnseen(0); }, [scope]);
			React.useLayoutEffect(() => {
				if (fileOpen) return;
				const node = focused ? ref.current : root.current?.closest?.(".studio-workspace"); scroller.current = node;
				if (!node) return;
				if (focused) node.scrollTop = readPreference(memoryKey + ".focus.scroll", 0);
				else if (workspaceTop.current != null) { node.scrollTop = workspaceTop.current; workspaceTop.current = null; }
				lastScroll.current = node.scrollTop;
				const onScroll = () => { if (node.scrollTop < lastScroll.current - 2) setFollow(false); lastScroll.current = node.scrollTop;
					if (focused) writePreference(memoryKey + ".focus.scroll", node.scrollTop); };
				const onFocus = event => { if (!root.current?.contains?.(event.target)) setFollow(false); };
				node.addEventListener?.("scroll", onScroll, { passive: true }); node.addEventListener?.("focusin", onFocus);
				return () => { node.removeEventListener?.("scroll", onScroll); node.removeEventListener?.("focusin", onFocus); };
			}, [focused, fileOpen, memoryKey]);
			React.useEffect(() => {
				const ready = observed.current.scope === scope && observed.current.ready, before = observed.current.scope === scope ? observed.current.lines : [];
				observed.current = { scope, lines, ready: resource ? resource.value != null : true };
				const prefix = before.length <= lines.length && before.every((line, i) => line === lines[i]);
				const last = before.length ? lines.lastIndexOf(before.at(-1)) : -1, added = prefix ? lines.length - before.length : last >= 0 ? lines.length - last - 1 : 0;
				if (ready && (!follow || reading || fileOpen)) setUnseen(value => value + Math.max(0, added));
				else if (follow && !reading && !fileOpen) setUnseen(0);
			}, [text, scope]);
			// 普通五行窗口不滚动整个工作区；只有历史页切换调整弹窗内的滚动位置。
			React.useLayoutEffect(() => {
				if (focused && reading && !fileOpen && ref.current) ref.current.scrollTop = !query && historyPage == null ? ref.current.scrollHeight : 0;
			}, [focused, reading, page, query, readingSnapshot.current.complete]);
			React.useLayoutEffect(() => { if (!focused && returnFocus.current) { expandButton.current?.focus?.(); returnFocus.current = false; } }, [focused]);
			React.useEffect(() => { if (reading) onFull?.(); }, [reading, scope, resource?.available, partial]);
			const pause = () => { preview.current.initialized = true; setFollow(false); };
			const resume = () => { preview.current = { scope, text, initialized: true }; setSearch(""); setMatchPage(0); setHistory(false); setHistoryPage(null); setFollow(true); setUnseen(0); };
			const inspectHistory = () => { onInspect?.(); pause(); setSearch(""); setMatchPage(0); setHistory(true); setHistoryPage(null); setReadingVersion(value => value + 1); };
			const openSource = () => { setFollow(false); if (focused && artifactProps) setFileOpen(true); else onFile?.(); };
			const readPartial = partial && (!reading || !readingSnapshot.current.complete), copyValue = readText;
			const range = !readPartial ? "全量" : "已读内容", status = reading
				? (query ? "匹配 " + filtered.length + " / 共 " + readLines.length + " 行" : "历史记录 · 共 " + readLines.length + " 行") + " · " + range + " · " + searchScope
					+ (filtered.length ? " · 显示第 " + (page * LOG_PAGE_LINES + 1) + "–" + Math.min((page + 1) * LOG_PAGE_LINES, filtered.length) + (query ? " 条匹配" : " 行") : "")
					+ (full?.loading ? " · 正在加载全量日志…" : full?.error ? " · 全量读取失败" : "")
					: previewText ? "共 " + previewLines.length + " 行 · 显示最近 " + Math.min(LOG_PREVIEW_LINES, previewLines.length) + " 行" + (partial ? " · 仅尾部最近内容" : "") : emptyText === "尚未记录输出" ? "尚无输出；开始执行后这里会显示日志" : emptyText;
			const content = h("div", { className: "studio-terminal-shell" + (focused ? " focused" : "") + (reading ? " browsing" : ""), ref: root },
				h("div", { className: "studio-terminal-head studio-row" }, h("span", { className: "studio-grow" }, label), !focused ? h("button", { ref: expandButton,
					onClick: () => { workspaceTop.current = scroller.current?.scrollTop ?? null; returnFocus.current = true; setExpanded(true); inspectHistory(); } }, "专注查看") : null,
					focused && !history ? h("button", { onClick: inspectHistory }, "查看历史") : null,
					reading ? h("button", { onClick: resume }, "最近 " + LOG_PREVIEW_LINES + " 行") : null),
				resource ? h(ResourceNotice, { resource }) : null,
				reading && full?.error ? h(ResourceNotice, { resource: { ...full, reload: full.reload || onFull } }) : null,
				h("div", { className: "studio-terminal-tools studio-row wrap" },
					h("input", { type: "search", value: search, placeholder: "搜索" + searchScope, "aria-label": "搜索日志", onChange: e => {
						if (!reading && e.target.value.trim()) { setReadingVersion(value => value + 1); onInspect?.(); }
						setFollow(false); setSearch(e.target.value); setMatchPage(0);
					} }),
					reading ? h("button", { onClick: () => setWrap(!wrap), "aria-pressed": wrap }, "换行") : null,
					h("button", { onClick: () => follow && !reading ? pause() : resume() }, follow && !reading ? "暂停跟随" : "跟随最新"),
					h("button", { onClick: () => copyStudio(copyValue, toast), disabled: !copyValue }, readPartial ? "复制已读内容" : "复制日志"),
					// TASK-10：只读到尾部片段时提供完整文件的服务端下载链接（预览上限 ≠ 存储截断）
					readPartial && slug && runId && (path || artifactProps?.initialPath)
						? h("a", { className: "btn", href: artifactDownloadHref(slug, runId, path || artifactProps.initialPath) }, "下载完整文件") : null,
					h("button", { onClick: () => downloadStudio(filename, copyValue), disabled: !copyValue }, readPartial ? "下载已读内容" : "下载日志"),
					reading && pages > 1 ? h(React.Fragment, null,
						h("button", { onClick: () => query ? setMatchPage(page - 1) : setHistoryPage(page - 1), disabled: page === 0 }, query ? "上一页匹配" : "上一页"),
						h("span", null, page + 1 + " / " + pages),
						h("button", { onClick: () => query ? setMatchPage(page + 1) : setHistoryPage(page + 1), disabled: page + 1 === pages }, query ? "下一页匹配" : "下一页")) : null),
				h("div", { className: "studio-terminal" + (wrap ? " wrapped" : ""), ref, role: "log", tabIndex: focused ? 0 : undefined, "aria-label": label,
					onScroll: e => { const node = e.currentTarget; if (focused) { writePreference(memoryKey + ".focus.scroll", node.scrollTop); if (node.scrollHeight - node.scrollTop - node.clientHeight > 40) setFollow(false); } } },
					visibleLines.length ? visibleLines.map((line, i) => h("div", { key: i, className: errorLine.test(line) ? "bad" : undefined, title: reading ? undefined : line }, line))
						: query ? "没有匹配输出" : resource?.error ? "输出暂不可读取" : emptyText),
				h("div", { className: "studio-terminal-foot studio-row wrap" }, h("span", { className: "studio-grow" }, status,
					copyValue ? h("span", null, " · 复制/下载：" + (readPartial ? "已读片段" : "全量内容") + "（不受五行预览、搜索或分页影响）") : null),
					unseen > 0 ? h("button", { onClick: resume }, "有 " + unseen + " 条新记录") : null,
					onFile || artifactProps ? h("button", { onClick: openSource }, "打开源文件") : null));
			if (fileOpen && artifactProps) return h(ArtifactsDialog, { ...artifactProps, onClose: () => setFileOpen(false), onReturn: () => setFileOpen(false), returnLabel: "返回日志" });
			return focused ? h(StudioDialog, { title: label, wide: true, onClose: () => { if (dialog) onClose?.(); else { setExpanded(false); setHistory(false); } } }, content) : content;
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
		// 二期 E2：时间线新格式 `YYYY-MM-DD HH:MM:SS|kind|text`（旧格式无日期前缀）；展示剥离日期只显时分秒
		function timelineStripDate(line) { return String(line).replace(/^\d{4}-\d{2}-\d{2}[ T]/, ""); }
		// 展示行保留规则：滤掉写入门禁/环境探测类 raw 遥测行（新旧时间格式一并匹配）
		function timelineKeep(line) { const t = String(line).trim(); return !!t && !/^(?:\d{4}-\d{2}-\d{2}[ T])?(?:\d{2}:\d{2}:\d{2}\|)?raw\|(=== |bin=|permission=|auth=|--- )/.test(t); }
		// 二期 A2：时间线行 → 事件对象（入参为已剥离日期的 `HH:MM:SS|kind|内容`）。
		// 名称只取真实值：tool 行首 token 是工具名；其余 kind 无名称字段显示 —，不造中文动作名。
		function parseTimelineEvent(line) {
			const m = /^(\d{2}:\d{2}:\d{2})\|([^|]+)\|([\s\S]*)$/.exec(String(line ?? "").trim());
			if (!m) return null;
			let name = "—", content = m[3];
			if (m[2] === "tool") {
				const head = content.split(/\s+/)[0];
				if (head) { name = head; content = content.slice(head.length).trim(); }
			}
			return { time: m[1], kind: m[2], name, content };
		}
		function agentTimelinePairs(text, structured = false) {
			if (text == null) return null;
			return String(text).split("\n").flatMap(raw => {
				if (!structured) return timelineKeep(raw) ? [[raw, timelineStripDate(raw)]] : [];
				const record = parseJson(raw);
				return record?.id && typeof record.kind === "string" && typeof record.text === "string"
					? [[raw, fmtClock(record.at) + "|" + record.kind + "|" + record.text]] : [];
			});
		}
		// ReadableValue 面向报告摘要；原始消息使用不改字段名、不裁剪条目的独立 JSON 查看器。
		function AgentJsonNode({ value, label, depth = 0 }) {
			const [open, setOpen] = React.useState(depth === 0);
			const prefix = label == null ? "" : JSON.stringify(label) + ": ";
			if (value === null || typeof value !== "object") return h("div", null, prefix + JSON.stringify(value));
			const entries = Object.entries(value), array = Array.isArray(value);
			return h("details", { open, onToggle: e => { if (open !== e.currentTarget.open) setOpen(e.currentTarget.open); } },
				h("summary", null, prefix + (array ? "[" : "{") + " " + entries.length + " 项" + (open ? "" : array ? " ]" : " }")),
				open ? h("div", { style: { paddingLeft: "18px" } }, entries.map(([key, item]) => h(AgentJsonNode, { key, label: key, value: item, depth: depth + 1 }))) : null,
				open ? h("div", null, array ? "]" : "}") : null);
		}
		function agentMessageSections(message, record) {
			const sections = [], add = (label, value) => {
				if (value != null) sections.push({ label, content: typeof value === "string" ? value : JSON.stringify(value, null, 2) });
			};
			const body = message?.type === "assistant/message" ? message.data?.message : message?.message;
			if (Array.isArray(body?.content)) {
				body.content.forEach((block, i) => {
					if (record?.blockIndex != null && record.blockIndex !== i) return;
					if (block.type === "thinking" || block.type === "reasoning") add("Agent 返回的思考文本", block.thinking ?? block.text);
					else if (block.type === "text") add("正文", block.text);
					else if (block.type === "tool_use") add("工具参数 · " + (block.name || "工具"), block.input);
					else if (block.type === "tool-call") add("工具参数 · " + (block.name || "工具"), block.arguments);
					else if (block.type === "tool_result" || block.type === "tool-result") add("工具结果", block.content);
					else add("消息内容", block);
				});
			} else if (message?.type === "tool/call") add("工具参数 · " + (message.data?.name || "工具"), message.data?.arguments ?? message.data?.input);
			else if (message?.type === "tool/result") {
				const blocks = message.data?.message?.content;
				if (Array.isArray(blocks)) blocks.forEach((block, i) => { if (record?.blockIndex == null || record.blockIndex === i) add("工具结果", block.content ?? block); });
				else add("工具结果", message.data?.result ?? message.data?.content ?? message.data);
			}
			else if (message?.type === "result") add("最终回复", message.result ?? message.resultText);
			if (!sections.length) add("消息内容", message);
			return sections;
		}
		// 二期 A2：内容预览 ≤max 码点（默认 120，含省略号），压缩空白换行；完整内容走悬停 title 与行内展开/详情
		function previewClamp(text, max = 120) {
			const flat = String(text ?? "").replace(/\s+/g, " ").trim();
			const chars = [...flat];
			return chars.length <= max ? flat : chars.slice(0, max - 1).join("") + "…";
		}
		function taskInputSummary(text) {
			const goal = /^#{1,6}\s+(?:目标|任务目标|Goal|Objective)\s*[:：]?\s*\r?\n([\s\S]*?)(?=^#{1,6}\s|$(?![\s\S]))/im.exec(String(text || ""));
			// 当前 P6 任务包使用 TaskGraph；只取实际节点标题，不概括或编造目标。
			const block = /^#{1,6}\s+TaskGraph\s*\r?\n\s*```json\s*\r?\n([\s\S]*?)\r?\n```/im.exec(String(text || ""));
			const graph = parseJson(block?.[1]), titles = Array.isArray(graph?.nodes)
				? graph.nodes.map(node => node?.title).filter(title => typeof title === "string" && title.trim()).join("；") : "";
			return previewClamp(goal?.[1]?.trim() || titles || text, 160);
		}

		// 按事件 ID 读取经校验的真实消息；旧时间线只能在唯一匹配原始帧时恢复。
		function EventDetailDialog({ event, sourcePath, slug, runId, tree, toast, onClose, artifactProps }) {
			const [mode, setMode] = React.useState("detail"), [selected, setSelected] = React.useState(0);
			const [query, setQuery] = React.useState(""), [match, setMatch] = React.useState(0);
			const [file, setFile] = React.useState(null), hitRef = React.useRef(null);
			const record = event.record, platform = record?.origin === "platform";
			const lookup = record?.id ? "id=" + encodeURIComponent(record.id) : "legacyLine=" + encodeURIComponent(event.raw || "");
			const identity = slug && runId && !platform && (record?.id || event.raw) ? slug + "/" + runId + "/" + lookup : "";
			const version = (tree || []).filter(f => /external-exec\.(?:events\.jsonl|messages\.jsonl|log)$/.test(f.path)).map(f => [f.path, f.size, f.mtimeMs].join(":")).join("|");
			const resource = useResource(identity, signal => readOk("/projects/" + encodeURIComponent(slug) + "/runs/" + encodeURIComponent(runId) + "/agent-event?" + lookup, signal));
			const observedVersion = React.useRef({ identity, version });
			React.useEffect(() => {
				const previous = observedVersion.current; observedVersion.current = { identity, version };
				if (identity && previous.identity === identity && previous.version !== version) resource.reload();
			}, [identity, version]);
			const result = resource.value, available = result?.status === "available" && result.message != null;
			const messages = available ? [{ event: result.event || record, message: result.message }, ...(result.related || [])] : [];
			const current = messages[selected] || messages[0];
			const rawText = current ? JSON.stringify(current.message, null, 2) : "";
			const sections = available ? messages.flatMap((item, i) => agentMessageSections(item.message, item.event).map(section => ({ ...section, label: (i ? "关联 · " : "") + section.label })))
				: [{ label: platform ? "平台事件" : "事件摘要", content: event.content || "" }];
			const reason = platform ? "此事件由平台生成，没有对应的 Agent 原始消息。" : result?.reason || (resource.error ? "原始消息读取失败，请重试。" : identity && !result ? "正在读取原始消息…" : "未记录可可靠关联的原始消息；当前仅保留事件摘要。");
			const q = query.trim().toLowerCase(), detailText = sections.map(section => section.content).join("\n\n");
			const hits = q ? (mode === "raw" ? rawText : detailText).split("\n").map((line, i) => [line, i]).filter(([line]) => line.toLowerCase().includes(q)) : [];
			const hitLine = hits.length ? hits[match % hits.length][1] : -1;
			React.useEffect(() => { hitRef.current?.scrollIntoView?.({ block: "nearest" }); }, [query, match, mode, selected]);
			const renderLines = (text, offset) => String(text).split("\n").map((line, i) => h("div", { key: i, ...(offset + i === hitLine ? { className: "hit", ref: hitRef } : {}) }, line || " "));
			const copyAll = () => copyStudio(mode === "raw" ? rawText : sections.map(section => section.label + "\n" + section.content).join("\n\n"), toast);
			const originalPath = result?.sourcePath || sourcePath;
			if (file) return h(ArtifactsDialog, { ...artifactProps, slug, runId, tree, toast, initialPath: file, initialRaw: true,
				onClose: () => setFile(null), onReturn: () => setFile(null), returnLabel: "← 返回事件" });
			let offset = 0;
			return h(StudioDialog, { title: event.name !== "—" ? event.name + " · " + event.kind : event.kind, wide: true, onClose },
				h("div", { className: "studio-stack" },
					h("div", { className: "kv" }, kvRow("时间", event.time, true), kvRow("类型", event.kind, true), kvRow("名称", event.name, true)),
					h("nav", { className: "studio-segmented" }, [["detail", "详情"], ["raw", "原始 JSON"]].map(([id, label]) =>
						h("button", { key: id, className: mode === id ? "on" : "", "aria-pressed": mode === id, onClick: () => { setMode(id); setMatch(0); } }, label))),
					h(ResourceNotice, { resource }),
					!available ? h("p", { className: "hint", role: "status" }, reason) : null,
					result?.relatedReason ? h("p", { className: "hint" }, result.relatedReason) : null,
					mode === "raw" && messages.length > 1 ? h("div", { className: "studio-row wrap", "aria-label": "选择原始消息" }, messages.map((item, i) => studioButton(i === 0 ? "当前消息" : (item.event?.relation === "call" ? "关联工具调用 " : "关联工具结果 ") + i,
						() => { setSelected(i); setMatch(0); }, selected === i ? "on sm" : "ghost sm"))) : null,
					h("div", { className: "studio-row wrap" },
						h("input", { className: "f-input", type: "search", placeholder: mode === "raw" ? "搜索当前原始消息的全部字段" : "在详情中搜索", "aria-label": "搜索事件详情", value: query,
							onChange: e => { setQuery(e.target.value); setMatch(0); } }),
						hits.length ? h("span", { className: "hint" }, "匹配 " + (match % hits.length + 1) + " / " + hits.length + " 行") : q ? h("span", { className: "hint" }, "无匹配") : null,
						hits.length > 1 ? h(React.Fragment, null,
							studioButton("上一个", () => setMatch((match - 1 + hits.length) % hits.length), "ghost sm"),
							studioButton("下一个", () => setMatch((match + 1) % hits.length), "ghost sm")) : null,
						studioButton(mode === "raw" ? "复制完整 JSON" : "复制全部", copyAll, "ghost sm", mode === "raw" ? !available : !detailText)),
					mode === "raw" ? h(React.Fragment, null,
						available ? h(React.Fragment, null, q ? h("pre", { className: "studio-detail-body" }, renderLines(rawText, 0))
							: h("div", { className: "studio-detail-body", "aria-label": "完整原始 JSON" }, h(AgentJsonNode, { key: identity + selected, value: current.message })),
							h("p", { className: "hint" }, "显示 Agent 实际返回的完整消息，包含未列入摘要的字段。同一消息的多个内容块共享这份 JSON。搜索包含折叠字段；复制不受折叠或搜索影响。")) : null,
						originalPath ? studioButton("打开源文件", () => setFile(originalPath), "ghost sm", !(tree || []).some(entry => entry.path === originalPath)) : null)
						: h(React.Fragment, null, sections.map((section, i) => {
							const start = offset; offset += String(section.content).split("\n").length + 1;
							return h("section", { key: i, className: "studio-detail-section" },
								h("div", { className: "studio-row" }, h("h3", { className: "studio-grow" }, section.label), studioButton("复制", () => copyStudio(section.content, toast), "ghost sm")),
								h("pre", { className: "studio-detail-body" }, renderLines(section.content, start)));
						}), h("p", { className: "hint" }, available ? "正文、工具参数和结果来自原始消息；其他字段见「原始 JSON」。" : "摘要可能已截断，不能用来恢复 Agent 的全部字段。"))));
		}
		// 二期 A2/A3/A5：外部执行器事件表——四列单行、整行点击行内展开；类型下拉（动态）+异常开关+搜索（沿用 full=1 全量）。
		// 内置多智能体实例不走此表（输出结构不同，保持原样）。
		function TimelineTable({ lines, rawLines, full, onFull, sourcePath, slug, runId, tree, onFile, toast, artifactProps, onInspect,
			live = false, observedLines, observedRaw, recordedAt, recordingNote, partial = false }) {
			const [type, setType] = React.useState("all"), [abnormal, setAbnormal] = React.useState(false);
			const [search, setSearch] = React.useState(""), [open, setOpen] = React.useState(-1), [detail, setDetail] = React.useState(null);
			const [follow, setFollow] = React.useState(live), [unseen, setUnseen] = React.useState(0), [focused, setFocused] = React.useState(false);
			const [sourceOpen, setSourceOpen] = React.useState(false);
			const [held, setHeld] = React.useState(null), [page, setPage] = React.useState(null);
			const latest = React.useRef(null), archive = React.useRef(null);
			const savedFocusScroll = React.useRef(null);
			const root = React.useRef(null), end = React.useRef(null), scroller = React.useRef(null), lastScroll = React.useRef(0);
			const focusButton = React.useRef(null), restoreFocus = React.useRef(false);
			const observed = Array.isArray(observedLines) ? observedLines : Array.isArray(lines) ? lines : [];
			const previous = React.useRef(observed), observation = observed.join("\n");
			const query = search.trim().toLowerCase(), filtering = type !== "all" || abnormal || !!query;
			const browsing = focused || filtering;
			const preview = held || { lines: observed, raw: observedRaw || rawLines };
			if (!browsing) archive.current = null;
			if (browsing && (!archive.current || (!archive.current.complete && full?.value != null))) {
				archive.current = { lines: Array.isArray(lines) ? lines : [], raw: rawLines, complete: full?.value != null || !partial };
			}
			const displayLines = browsing ? archive.current.lines : preview.lines;
			const events = displayLines.map((line, i) => ({ ...parseTimelineEvent(line), raw: (browsing ? archive.current.raw : preview.raw)?.[i], record: parseJson((browsing ? archive.current.raw : preview.raw)?.[i]) })).filter(item => item.time);
			const available = (browsing ? archive.current.lines : Array.isArray(lines) ? lines : []).map(parseTimelineEvent).filter(Boolean);
			const kinds = [...new Set(available.map(item => item.kind))].map(kind => [kind, available.filter(item => item.kind === kind).length]);
			// 镜像日志不携带执行器原生状态：异常=按内容错误关键字筛选，开关 title 明示派生方式
			const isErrorRow = item => /error|denied|forbidden|unauthorized|timeout|失败|异常/i.test(item.content);
			const rows = events.map((item, i) => ({ ...item, i }))
				.filter(item => (type === "all" || item.kind === type) && (!abnormal || isErrorRow(item))
					&& (!query || (item.raw || item.time + " " + item.name + " " + item.kind + " " + item.content).toLowerCase().includes(query)));
			const pages = Math.max(1, Math.ceil(rows.length / LOG_PAGE_LINES));
			const safePage = Math.min(page ?? pages - 1, pages - 1);
			const visible = browsing ? rows.slice(safePage * LOG_PAGE_LINES, (safePage + 1) * LOG_PAGE_LINES) : rows.slice(-LOG_PREVIEW_LINES);
			latest.current = { lines: observed, raw: observedRaw || rawLines, page: safePage };
			const pause = () => {
				setFollow(false); setHeld(value => value || { lines: latest.current.lines, raw: latest.current.raw });
				if (focused) setPage(latest.current.page);
			};
			const filterChanged = () => { onInspect?.(); pause(); setOpen(-1); setPage(0); onFull?.(); };
			const turnPage = value => { pause(); setPage(value); setOpen(-1); if (focused && scroller.current) scroller.current.scrollTop = 0; };
			const jumpLatest = () => {
				const node = scroller.current, target = end.current;
				if (focused && node?.getBoundingClientRect && target?.getBoundingClientRect) {
					node.scrollTop += target.getBoundingClientRect().bottom - node.getBoundingClientRect().bottom + 52;
					lastScroll.current = node.scrollTop;
				}
				setUnseen(0);
			};
			React.useLayoutEffect(() => {
				const node = focused ? root.current?.querySelector?.(".studio-events-scroll") : root.current?.closest?.(".studio-workspace");
				scroller.current = node;
				if (!node) return;
				if (focused && savedFocusScroll.current != null) { node.scrollTop = savedFocusScroll.current; savedFocusScroll.current = null; }
				lastScroll.current = node.scrollTop;
				const onScroll = () => {
					if (node.scrollTop < lastScroll.current - 2) pause();
					lastScroll.current = node.scrollTop;
				};
				const onFocus = event => { if (!root.current?.contains(event.target)) pause(); };
				node.addEventListener("scroll", onScroll, { passive: true });
				node.addEventListener("focusin", onFocus);
				return () => { node.removeEventListener("scroll", onScroll); node.removeEventListener("focusin", onFocus); };
			}, [focused, !!detail, sourceOpen]);
			React.useEffect(() => {
				const before = previous.current;
				previous.current = observed;
				// 只比较观测快照：全量搜索、筛选和刷新空窗不计算为新增事件。
				const prefix = before.length <= observed.length && before.every((line, i) => line === observed[i]);
				const last = before.length ? observed.lastIndexOf(before.at(-1)) : -1;
				const added = prefix ? observed.length - before.length : last >= 0 ? observed.length - last - 1 : 0;
				if (!follow || filtering || detail) setUnseen(value => value + Math.max(0, added));
			}, [observation]);
			React.useLayoutEffect(() => {
				if (follow && !filtering && !detail && !sourceOpen) jumpLatest();
			}, [observation, follow, filtering, focused, !!detail, sourceOpen]);
			React.useLayoutEffect(() => {
				if (!focused && restoreFocus.current) { focusButton.current?.focus?.(); restoreFocus.current = false; }
			}, [focused]);
			const resume = () => { archive.current = null; setType("all"); setAbnormal(false); setSearch(""); setOpen(-1); setHeld(null); setPage(null); setFollow(true); jumpLatest(); };
			const lastEvent = parseTimelineEvent(observed.at(-1));
			const content = h("div", { ref: root, className: "studio-stack studio-timeline" + (focused ? " focused" : "") },
				h("div", { className: "studio-row wrap studio-events-toolbar" },
					h("select", { className: "f-select", "aria-label": "筛选事件类型", value: type, onFocus: () => onFull?.(), onChange: e => { setType(e.target.value); filterChanged(); } },
						[h("option", { key: "all", value: "all" }, "全部类型 · " + events.length),
							...kinds.map(([kind, count]) => h("option", { key: kind, value: kind }, kind + " · " + count))]),
					h("button", { className: "btn ghost sm", "aria-pressed": abnormal, title: "按内容错误关键字筛选；镜像日志未携带执行器原生状态", onClick: () => { setAbnormal(!abnormal); filterChanged(); } }, "异常"),
					h("input", { className: "f-input", placeholder: "搜索事件内容", "aria-label": "搜索事件", value: search,
						onChange: e => { setSearch(e.target.value); filterChanged(); } }),
					!focused ? h("button", { ref: focusButton, className: "btn ghost sm", onClick: () => { onInspect?.(); pause(); setPage(filtering ? 0 : null); onFull?.(); restoreFocus.current = true; setFocused(true); } }, "专注查看") : null,
					sourcePath ? studioButton("打开源文件", () => {
						pause();
						if (focused) { savedFocusScroll.current = scroller.current?.scrollTop ?? 0; setSourceOpen(true); }
						else onFile?.(sourcePath, { raw: true });
					}, "ghost sm") : null),
				browsing && full?.error ? h(ResourceNotice, { resource: full }) : null,
				events.length ? h("div", { className: "studio-events", "aria-label": "执行事件表" }, h("div", { className: "studio-events-scroll", tabIndex: focused ? 0 : undefined, "aria-label": focused ? "执行事件滚动区" : undefined }, h("div", { className: "studio-events-grid" },
					h("div", { className: "studio-events-head" }, ["时间", "类型", "名称", "内容"].map(label => h("span", { key: label }, label))),
					visible.map(item => h(React.Fragment, { key: item.i },
						h("button", { className: "studio-event-row" + (open === item.i ? " on" : ""), title: item.content, "aria-expanded": open === item.i,
							onClick: () => { setOpen(open === item.i ? -1 : item.i); pause(); } },
							h("span", { className: "mono" }, item.time), h("span", { className: "mono" }, item.kind), h("span", { className: "mono" }, item.name),
							h("span", null, previewClamp(item.content))),
						// 二期 A3/A4：行内展开完整镜像内容；长内容/复制/原始记录进详情弹窗
						open === item.i ? h("div", { className: "studio-event-full" }, item.content || "—",
							[...item.content].length >= 500 ? h("span", { className: "hint" }, "（当前为摘要，完整内容见详情）") : null,
							studioButton("详情 ↗", () => { onInspect?.(); pause(); if (focused) savedFocusScroll.current = scroller.current?.scrollTop ?? 0; setDetail(item); }, "ghost sm")) : null)),
					!rows.length ? h("p", { className: "hint" }, "没有匹配的事件") : null, h("div", { ref: end })) ))
					: h("p", { className: "hint" }, "时间线没有可显示的事件行。"),
				h("div", { className: "studio-row wrap studio-timeline-status" },
					h("span", { className: "hint", title: recordedAt || "" },
						"显示 " + visible.length + " / " + events.length + " 行" + (!browsing ? " · 最近 " + LOG_PREVIEW_LINES + " 条" : filtering ? " · 匹配 " + rows.length + " 条" : " · 历史记录")
						+ (browsing && full?.value != null ? " · 全量" : partial ? " · 最近片段" : "")
						+ (browsing && full?.loading ? " · 全量加载中…" : browsing && full?.error ? " · 全量读取失败，仅显示已读内容" : "") + (lastEvent ? " · 最近记录 " + lastEvent.time : "")
						+ (recordingNote ? " · " + recordingNote : "")),
					browsing && pages > 1 ? h(React.Fragment, null, studioButton("上一页", () => turnPage(safePage - 1), "ghost sm", safePage === 0),
						h("span", { className: "hint" }, safePage + 1 + " / " + pages), studioButton("下一页", () => turnPage(safePage + 1), "ghost sm", safePage + 1 === pages)) : null,
					unseen > 0 ? studioButton("有 " + unseen + " 条新记录", resume, "ghost sm") : null,
					live ? studioButton(follow && !filtering ? "暂停跟随" : "跟随最新", () => follow && !filtering ? pause() : resume(), "ghost sm") : null),
				h("p", { className: "hint" }, (events.some(item => item.record?.id) ? "搜索范围：全部已读事件摘要，内容可能已截断；原始消息全部字段在详情中搜索。" : "搜索范围：时间线镜像记录，内容可能已截断。") + (sourcePath?.endsWith("external-exec.log") ? "原始日志见「打开源文件」。" : "")));
			// 专注视图与事件详情互相替换，避免叠加两层模态框。
			if (sourceOpen) return h(ArtifactsDialog, { ...artifactProps, slug, runId, tree, toast, initialPath: sourcePath, initialRaw: true,
				onClose: () => setSourceOpen(false), onReturn: () => setSourceOpen(false), returnLabel: "← 返回执行记录" });
			if (detail) {
				const dialog = h(EventDetailDialog, { key: detail.record?.id || detail.raw, event: detail, sourcePath, slug, runId, tree, toast, artifactProps, onClose: () => setDetail(null) });
				return focused ? dialog : h(React.Fragment, null, content, dialog);
			}
			return focused ? h(StudioDialog, { title: "Agent 执行记录", wide: true, onClose: () => setFocused(false) }, content) : content;
		}
		function ExecutionsPanel(p) {
			const [filter, setFilter] = React.useState("all"), [search, setSearch] = React.useState("");
			const [view, setView] = usePreference("i2p.execution-view." + p.slug + "/" + p.runId, "output");
			const structured = p.tree.some(file => file.path === "06-implementation/external-exec.events.jsonl");
			const timelinePath = "06-implementation/external-exec." + (structured ? "events.jsonl" : "timeline.log");
			const timelineFile = p.tree.find(file => file.path === timelinePath);
			const observationKey = [p.slug, p.runId, p.outputKey, p.run.externalExec?.startedAt].join("|");
			const externalReading = useLogArtifact(p.slug, p.runId, "06-implementation/external-exec.log", p.tree, observationKey);
			const externalLog = externalReading.resource;
			const timelineReading = useLogArtifact(p.slug, p.runId, timelinePath, p.tree, observationKey);
			const agentTimeline = timelineReading.resource, agentTimelineFull = timelineReading.full;
			const sessionTask = useRunArtifact(p.slug, p.runId, "06-implementation/session-task.md", p.tree); // 交给外部 agent 的任务包（输入）
			const [instanceOpen, setInstanceOpen] = React.useState(false);
			const outputRef = React.useRef(null);
			const hasSessionTask = p.tree.some(file => file.path === "06-implementation/session-task.md");
			const report = parseJson(p.coder.value), items = executionItems(p.run, report);
			// 单个外部执行直接内嵌展示，不写入实例选择，保留当前阶段的复核上下文。
			const selected = items.find(item => item.id === p.selection) || (items.length === 1 && items[0].external ? items[0] : null);
			const filtered = items.filter(item => (filter === "all" || (filter === "done" ? ["done", "patched", "no_change"].includes(item.status) : item.status === filter))
				&& [item.title, item.reason, item.patch, item.executor].join(" ").toLowerCase().includes(search.toLowerCase()));
			const files = stageFiles("P6", p.tree, p.run).filter(file => !selected || selected.external || selected.patch === file.path);
			const outputFiles = files.filter(file => /\.(?:diff|patch)$/.test(file.path) || /(?:report|result)[^/]*\.json$/.test(file.path));
			const auxiliaryFiles = files.filter(file => !outputFiles.includes(file));
			const live = selected?.status === "running" && selected?.executor === "claude-code";
			const recordingNote = selected?.executor === "dsh-agent" ? "执行结束后提供记录" : live ? "记录自动刷新" : "";
			const rawTail = externalLog.value != null ? formatAgentLog(externalLog.value) : null;
			// 保留（来源行, 展示行）配对：新事件携带 ID，旧时间线保留完整原行用于严格匹配。
			const timelinePairs = agentTimeline.value != null
				? agentTimelinePairs(agentTimeline.value, structured) : null;
			const timelineFullPairs = agentTimelineFull.value != null
				? agentTimelinePairs(agentTimelineFull.value, structured) : null;
			const timelineLines = timelinePairs ? timelinePairs.map(pair => pair[1]) : null;
			const timelineRaw = timelinePairs ? timelinePairs.map(pair => pair[0]) : null;
			const timelineDisplay = timelineLines ? timelineLines.join("\n\n") : null;
			const output = selected?.external
				? (timelineDisplay != null ? timelineDisplay : rawTail != null ? rawTail : p.eventsText)
				: "此执行报告未记录独立实例输出。平台记录可从阶段标题右侧的「阶段事件」查看。";
			const messagesPath = "06-implementation/external-exec.messages.jsonl";
			const logPath = selected?.external && p.tree.some(file => file.path === messagesPath) ? messagesPath : selected?.external && p.tree.some(file => file.path === "06-implementation/external-exec.log")
				? "06-implementation/external-exec.log" : timelineFile?.path || "trace/events.jsonl";
			// 最终回复：优先时间线的 result 行，回退原始日志的 result 帧（二期 E2：正则兼容日期前缀）
			const finalReply = (() => {
				if (!selected?.external) return null;
				// DSH 的 turn/end 只记录结束原因；最终回复取真实 assistant 文本摘要。
				if (structured && selected.executor === "dsh-agent") {
					const reply = timelinePairs?.map(pair => parseJson(pair[0])).findLast(record => record?.kind === "text");
					return reply?.text || null;
				}
				const outLines = String(output).split("\n");
				for (let i = outLines.length - 1; i >= 0; i--) {
					const m = /^(?:\d{4}-\d{2}-\d{2}[ T])?\d{2}:\d{2}:\d{2}\|result\|(.+)$/.exec(outLines[i]);
					if (m && m[1].trim()) return m[1];
				}
				for (let i = outLines.length - 1; i >= 0; i--) {
					try { const f = JSON.parse(outLines[i]); if (f.type === "result" && f.result) return String(f.result).slice(0, 500); } catch { /* 继续扫 */ }
				}
				return null;
			})();
			const showOutput = () => {
				const target = outputRef.current, node = target?.closest?.(".studio-workspace");
				if (node && target) { node.scrollTop += target.getBoundingClientRect().top - node.getBoundingClientRect().top - 12; target.focus(); }
			};
			return h("div", { className: "studio-stack" }, h(ResourceNotice, { resource: p.coder }),
				selected ? h(React.Fragment, null,
					h("div", { className: "studio-row studio-execution-head wrap" }, items.length > 1 || !selected.external ? studioButton("← 全部实例", () => p.onSelect(""), "ghost sm") : null,
						h("h2", null, selected.title),
						selected.external ? h("div", { className: "studio-row studio-instance-meta" },
							studioButton("查看输出 ↓", showOutput, "ghost sm"), studioButton("实例详情", () => { p.onInspect?.(); setInstanceOpen(true); }, "ghost sm")) : null,
						// 二期 A1：外部实例改单轮结构不再用三页签；内置实例保持原页签视图
						selected.external ? null : h("nav", { className: "studio-execution-tabs", "aria-label": "实例视图" }, [["output", "执行输出"], ["checks", "本实例检查"], ["artifacts", "本实例产物"]].map(([id, label]) => h("button", { key: id, className: view === id ? "on" : "", onClick: () => setView(id) }, label)))),
					!selected.external ? h("div", { className: "studio-row wrap" }, h("span", { className: "tg " + (selected.status === "failed" ? "t-err" : selected.status === "running" ? "t-acc" : "t-off") }, instanceStatus(selected.status)),
						h("span", { className: "hint studio-path studio-grow" }, selected.reason)) : null,
					selected.external ? h("article", { className: "studio-turn", "aria-label": "本次执行的单轮记录" },
						h("header", { className: "studio-turn-head" }, h("h3", null, "第 1 轮"),
							h("span", { className: "hint" }, "任务执行"),
							h("span", { className: "tg " + (selected.status === "failed" ? "t-err" : selected.status === "running" ? "t-acc" : "t-off") }, instanceStatus(selected.status)),
							selected.startedAt ? h("time", { className: "studio-turn-time", dateTime: selected.startedAt, title: [selected.startedAt, selected.finishedAt].filter(Boolean).join(" — ") },
								fmtClock(selected.startedAt) + (selected.finishedAt ? " — " + fmtClock(selected.finishedAt) : "")) : null),
						h("div", { className: "studio-turn-body" },
						// 二期 A1：单轮结构——输入（任务包内嵌块）→ 执行过程（事件表）→ 输出（最终回复 + 关联产物链接）。
						// 当前外部会话不支持多轮续接，按一轮呈现；不提供补充输入 composer。
						hasSessionTask ? h("section", { className: "studio-message studio-input-summary" },
							h("strong", null, "输入"),
							h("p", { className: "studio-message-body" }, sessionTask.value != null ? taskInputSummary(sessionTask.value) : sessionTask.error ? "任务包读取失败" : "任务包读取中…"),
							studioButton("查看完整输入", () => p.onFile("06-implementation/session-task.md"), "ghost sm")) : null,
						h("section", { className: "studio-stack" },
							h("div", { className: "studio-row wrap" }, h("strong", null, "执行过程"),
								h("span", { className: "hint" }, timelineLines ? "" : timelineFile ? "正在读取执行记录…" : selected.executor === "dsh-agent" && selected.status === "running" ? recordingNote : "显示原始日志尾部")),
							h(ResourceNotice, { resource: agentTimeline }),
							// 二期 A6：有时间线镜像走事件表；旧运行无镜像回退原文本输出
								timelineLines ? h(TimelineTable, { key: observationKey + ".events." + structured, live, observedLines: timelineLines, observedRaw: timelineRaw,
									recordedAt: structured ? parseJson(timelineRaw.at(-1))?.at : timelineRaw.at(-1)?.split("|")[0], recordingNote, partial: timelineFile?.size > 200 * 1024,
								lines: timelineFullPairs ? timelineFullPairs.map(pair => pair[1]) : timelineLines,
								rawLines: timelineFullPairs ? timelineFullPairs.map(pair => pair[0]) : timelineRaw,
								full: agentTimelineFull,
								onFull: timelineReading.onFull, sourcePath: logPath, slug: p.slug, runId: p.runId, tree: p.tree, onFile: p.onFile, toast: p.toast, artifactProps: p, onInspect: p.onInspect }) :
								h(RunLogPanel, { ...p, key: observationKey, path: logPath, log: logPath === "06-implementation/external-exec.log" ? externalReading : undefined,
								searchScope: logPath === "trace/events.jsonl" ? "本阶段事件" : logPath.endsWith("timeline.log") ? "时间线镜像记录" : "Agent 日志记录",
								stage: logPath === "trace/events.jsonl" ? "P6" : undefined, format: logPath === "trace/events.jsonl" ? undefined : formatAgentLog, identity: observationKey,
								label: selected.title + " · 执行输出", memoryKey: p.outputKey + "." + selected.id, filename: p.runId + "-P6-" + selected.id + ".log", artifactProps: p, onFile: () => p.onFile(logPath, { raw: true }) })),
						h("section", { className: "studio-message", ref: outputRef, tabIndex: -1, "aria-label": "执行输出" },
							h("div", { className: "studio-row wrap" }, h("strong", null, "输出"), h("span", { className: "hint studio-grow" }, "实例执行结果不代表任务回归或最终验收通过")),
							finalReply ? h("p", { className: "studio-message-body" }, finalReply) : h("p", { className: "hint" }, selected.status === "running" ? "执行中，尚未记录最终回复。" : "结果帧未记录最终回复。"),
							files.length ? h("div", { className: "studio-output-files" },
								outputFiles.length ? h("div", { className: "studio-row wrap" }, h("span", { className: "hint" }, "阶段产物"),
									outputFiles.map(file => h("button", { key: file.path, type: "button", className: "btn ghost sm", onClick: () => p.onFile(file.path) }, file.path.split("/").at(-1)))) : null,
								auxiliaryFiles.length ? h("details", null, h("summary", null, "更多文件 " + auxiliaryFiles.length), h("div", { className: "studio-row wrap" },
									auxiliaryFiles.map(file => h("button", { key: file.path, type: "button", className: "btn ghost sm", onClick: () => p.onFile(file.path) }, file.path.split("/").at(-1))))) : null) : null))) :
					h(React.Fragment, null,
						view === "checks" ? h("div", { className: "studio-stack" }, h("h3", null, "执行报告"),
							h(ReadableValue, { value: { status: instanceStatus(selected.status), reason: selected.reason || "未记录说明" } }),
							h("p", { className: "hint" }, "实例执行结果不代表任务回归或最终验收通过。"), studioButton("查看原始报告", () => p.onFile("06-implementation/coder-report.json"), "ghost sm", p.coder.value == null)) :
						view === "artifacts" ? h("div", { className: "studio-stack" }, files.length ? files.map(file => studioButton(file.path, () => p.onFile(file.path), "ghost sm")) : h("p", { className: "hint" }, "尚无明确归属到本实例的文件。")) :
							h(OutputPanel, { key: selected.id, text: output, label: "实例输出记录", memoryKey: p.outputKey + "." + selected.id, filename: p.runId + "-P6-" + selected.id + ".log", toast: p.toast, onInspect: p.onInspect }))) :
				h(React.Fragment, null,
					h("div", { className: "studio-execution-filters" },
						h("div", { className: "studio-segmented" }, [["all", "全部"], ["running", "执行中"], ["done", "完成"], ["failed", "失败"]].map(([id, label]) =>
							h("button", { key: id, className: filter === id ? "on" : "", onClick: () => setFilter(id) }, label + " " + items.filter(item => id === "all" || (id === "done" ? ["done", "patched", "no_change"].includes(item.status) : item.status === id)).length))),
						h("input", { className: "f-input", placeholder: "搜索实例或文件", "aria-label": "搜索执行实例", value: search, onChange: e => setSearch(e.target.value) })),
					filtered.length ? h("div", null, filtered.map(item => h("button", { key: item.id, className: "studio-execution-row", onClick: () => p.onSelect(item.id) },
						h("strong", null, item.title, h("small", null, item.external ? "外部会话" : "任务节点结果")), h("span", null, item.reason || item.error || (item.external ? "执行整个任务图" : item.patch || "结果报告")),
						h("span", null, h("span", { className: "tg " + (item.status === "failed" ? "t-err" : item.status === "running" ? "t-acc" : "t-off") }, instanceStatus(item.status)), h("small", null, stageFiles("P6", p.tree, p.run).filter(file => item.external || item.patch === file.path).length + " 个产物")), Ic("right", 14)))) :
						h("p", { className: "hint" }, items.length ? "没有匹配实例" : "尚无实例结果报告；平台记录可从阶段标题右侧的「阶段事件」查看。")),
				instanceOpen && selected ? h(StudioDialog, { title: "实例详情", wide: true, onClose: () => setInstanceOpen(false) },
					h("div", { className: "kv" }, kvRow("执行器", selected.title), kvRow("执行状态", instanceStatus(selected.status)),
						kvRow("会话编号", selected.sessionId || "未记录", true), kvRow("开始时间", fmtTime(selected.startedAt)),
						kvRow("结束时间", selected.finishedAt ? fmtTime(selected.finishedAt) : "尚未记录"), kvRow("退出码", selected.exitCode ?? "尚未记录")),
					selected.sessionId ? studioButton("复制会话编号", () => copyStudio(selected.sessionId, p.toast), "ghost sm") : null,
					h("p", { className: "hint" }, "展示本次执行已有记录；历史轮次未记录。")) : null);
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
			return h("section", null, h("div", { className: "studio-row wrap" }, h("h2", { className: "studio-grow" }, "补丁"), patchStat ? h("span", { className: "hint" }, "涉及 " + patchStat) : null, path ? studioButton("打开补丁文件", () => p.onFile(path), "ghost sm") : null),
				stale > 0 ? h("p", { className: "hint" }, "另有 " + stale + " 个上一轮补丁文件仍保留在产物中，已不作为本轮验证依据。") : null,
				current.length ? h("select", { className: "f-select", "aria-label": "选择补丁", value: path, onChange: e => setSelected(e.target.value) }, current.map(file => h("option", { key: file.path, value: file.path }, file.path)))
					: h(EmptyState, { title: stale ? "本轮尚未生成补丁" : "尚未生成补丁" }, stale ? h("p", { className: "hint" }, "上一轮补丁可从「全部产物」查看，但不代表本轮结果。") : null),
				h(ResourceNotice, { resource: content }), path ? h(DiffContent, { path, text: content.value }) : null);
		}
		function durationText(ms) {
			const sec = Math.max(0, Math.floor(ms / 1000)), min = Math.floor(sec / 60);
			return sec < 60 ? sec + " 秒" : min < 60 ? min + " 分 " + (sec % 60) + " 秒" : Math.floor(min / 60) + " 小时 " + (min % 60) + " 分";
		}
		// 以最近一次成功读取的服务器时间为锚点；断线时冻结在该确认点。
		function useRunClock(run, error) {
			const [, refresh] = React.useState(0), anchor = React.useRef(null);
			if (!anchor.current || (!error && anchor.current.run !== run)) {
				anchor.current = { run, clientAt: Date.now(), serverAt: Date.parse(run?.observedAt) || Date.now() };
			}
			const live = !!run && (["running", "awaiting_review"].includes(run.status) || currentP10(run)?.status === "running") && !error;
			React.useEffect(() => {
				if (!live) return;
				const timer = setInterval(() => refresh(value => value + 1), 1000);
				return () => clearInterval(timer);
			}, [run?.id, live]);
			return anchor.current.serverAt + (live ? Math.max(0, Date.now() - anchor.current.clientAt) : 0);
		}
		function stageTimingText(run, id, records, now, disconnected = false) {
			const state = run.stages?.[id];
			if (!state || state.status === "pending") return "";
			const start = Date.parse(state.startedAt), finish = Date.parse(state.finishedAt), stopped = Date.parse(state.stoppedAt);
			const running = state.status === "running" && (run.status === "running" && run.current === id || id === "P10" && !!currentP10(run));
			let elapsed;
			if (running && Number.isFinite(start)) elapsed = Math.max(0, now - start);
			else if (Number.isFinite(start) && Number.isFinite(stopped) && stopped >= start) elapsed = stopped - start;
			else if (Number.isFinite(start) && Number.isFinite(finish) && finish >= start) elapsed = finish - start;
			else {
				const times = records.filter(event => event.stage === id).map(event => Date.parse(event.at))
					.filter(at => Number.isFinite(at) && (!Number.isFinite(start) || at >= start));
				if (times.length) elapsed = Math.max(...times) - (Number.isFinite(start) ? start : Math.min(...times));
			}
			if (elapsed == null) return "";
			let label = (disconnected && running ? "上次确认已运行 " : running ? "已运行 " : "耗时 ") + durationText(elapsed);
			if (state.status === "awaiting_review" && run.current === id && run.status === "awaiting_review" && !state.external && Number.isFinite(finish) && finish >= start) {
				label += " · " + (disconnected ? "上次确认等待复核 " : "等待复核 ") + durationText(Math.max(0, now - finish));
			}
			return label;
		}
		function agentActivityView(run, now, error) {
			const activity = run.agentActivity || { status: "unavailable" }, stage = run.stages?.P6 || {};
			const live = run.current === "P6" && run.status === "running" && stage.status === "running";
			const signalAt = Date.parse(activity.lastSignalAt), logAt = Date.parse(activity.lastLogUpdateAt);
			const age = Number.isFinite(signalAt) ? Math.max(0, now - signalAt) : null;
			const sinceStart = now - Date.parse(stage.startedAt);
			const quietMs = activity.thresholds?.quietMs || 60000, staleMs = activity.thresholds?.staleMs || 180000;
			let title, tone = "quiet";
			if (error) { title = "连接中断，正在重试"; tone = "warn"; }
			else if (stage.status === "stopped" || (run.current === "P6" && run.status === "stopped")) title = "任务已停止";
			else if (activity.phase === "timeout") { title = "Agent 执行超时"; tone = "bad"; }
			else if (stage.status === "failed" || activity.phase === "failed") { title = "Agent 执行失败"; tone = "bad"; }
			else if (activity.phase === "completed" || (!live && ["approved", "completed", "awaiting_review"].includes(stage.status))) title = "Agent 执行已结束";
			else if (activity.status === "legacy") {
				title = live && Number.isFinite(logAt) && now - logAt < quietMs ? "日志仍有更新" : "未采集实时活动摘要";
			} else if (activity.status !== "available") title = "尚未收到活动摘要";
			else if (live && (age ?? sinceStart) >= quietMs) { title = "暂未收到新活动"; tone = "warn"; }
			else if (live) { title = ({ starting: "正在启动 Agent", thinking: "正在推理", tool: "正在调用工具", responding: "正在输出回复", waiting: "等待后续活动", stopped: "执行器已停止" })[activity.phase] || "等待后续活动"; tone = activity.phase === "stopped" ? "quiet" : "active"; }
			else title = "当前执行状态未确认";
			const signal = error ? "活动状态暂未确认" : age != null ? "最近信号 · " + durationText(age) + "前"
				: Number.isFinite(logAt) ? "日志更新 · " + fmtTime(activity.lastLogUpdateAt) : "尚无可靠活动时间";
			const tasks = activity.status === "available" && Array.isArray(activity.backgroundTasks) ? activity.backgroundTasks.filter(task => task && task.isBackgrounded !== false) : [];
			const process = activity.process, processText = error ? "当前进程状态未确认"
				: process?.state === "alive" ? "执行器进程存活" : process?.state === "exited" ? "执行器进程已退出" : "进程状态未确认";
			const warning = !error && live && (age ?? sinceStart) >= staleMs && activity.status === "available"
				? "持续未收到新消息；" + processText + "。活动信号不足以判断是否卡住，任务未自动停止。" : "";
			return { activity, live, title, tone, signal, tasks, processText, warning };
		}
		function AgentActivityPanel({ run, now, error, onFile }) {
			const { activity, live, title, tone, signal, tasks, processText, warning } = agentActivityView(run, now, error);
			const taskStatus = task => ({ completed: "已完成", failed: "失败", stopped: "已停止", submitted: "已提交后台", unknown: "状态待确认" })[task.status]
				|| (live && !error ? "运行中" : "结束状态未确认");
			return h("section", { className: "studio-activity " + tone, "aria-label": "Agent 当前活动" },
				h("div", { className: "studio-row wrap" }, h("strong", { className: "studio-grow" }, h("span", { className: "studio-activity-dot", "aria-hidden": "true" }), title), h("span", { className: "hint" }, signal)),
				activity.lastAction ? h("div", { className: "hint studio-path" }, "最近动作 · " + (activity.lastAction.name || activity.lastAction.kind) + " · " + fmtTime(activity.lastAction.at)) : null,
				warning ? h("p", { className: "hint", role: "status" }, warning) : null,
				activity.status === "legacy" ? h("p", { className: "hint" }, "本次执行未采集结构化活动，仅展示原始日志更新时间。") : null,
				tasks.map(task => {
					const start = Date.parse(task.startedAt), finish = Date.parse(task.finishedAt);
					const elapsed = Number.isFinite(start) && Number.isFinite(finish) && finish >= start ? durationText(finish - start)
						: live && Number.isFinite(start) && task.status === "running" ? (error ? "上次确认 " : "已运行 ") + durationText(Math.max(0, now - start)) : "";
					return h("details", { key: activity.captureId + ":" + task.id, className: "studio-activity-task" },
						h("summary", null, (task.name || task.description || "后台任务") + " · " + taskStatus(task) + (elapsed ? " · " + elapsed : "")),
						task.command ? h("pre", null, task.command) : null,
						h("p", { className: "hint" }, "开始：" + (task.startedAt ? fmtTime(task.startedAt) : "未记录") + (task.finishedAt ? " · 结束：" + fmtTime(task.finishedAt) : "") + (task.exitCode != null ? " · 退出码 " + task.exitCode : "")),
						h("pre", null, task.summary || "尚未收到任务输出或完成通知"));
				}),
				h("details", null, h("summary", { className: "hint" }, "活动依据"),
					h("p", { className: "hint" }, processText + (!error && activity.process?.checkedAt ? " · 核对时间 " + fmtTime(activity.process.checkedAt) : "")),
					h("p", { className: "hint" }, error ? "页面同步失败；保留最近确认内容，正在自动重试。" : "页面最近同步：" + fmtTime(run.observedAt)),
					activity.thinking?.estimatedTokens != null ? h("p", { className: "hint" }, "执行器最近报告的推理计数：" + activity.thinking.estimatedTokens + "（估算值，不代表完成进度）") : null,
					onFile ? studioButton("查看原始日志", () => onFile("06-implementation/external-exec.log", { raw: true }), "ghost sm") : null));
		}
		function testActivityView(run, tree, events, now, error) {
			const stage = run.stages?.P8 || {}, start = Date.parse(stage.startedAt), raw = run.testActivity;
			const available = raw?.status === "available" && raw.stageStartedAt === stage.startedAt && stage.status !== "pending";
			const activity = available ? raw : null, stale = raw?.reasonCode === "stale" || (raw?.status === "available" && !available);
			const fresh = file => stage.status !== "pending" && (!Number.isFinite(start) || file.mtimeMs >= start);
			const outputFile = !stale && activity?.outputReady !== false && (tree || []).find(file => file.path === "08-test-output.txt" && fresh(file));
			const reportFile = !stale && (tree || []).find(file => file.path === "07-test-report.json" && fresh(file));
			const stageRunning = stage.status === "running" && run.current === "P8" && run.status === "running";
			const executing = activity?.executionStatus === "running", ended = activity && !executing;
			const stopped = stage.status === "stopped" || (run.current === "P8" && run.status === "stopped");
			const process = error ? "unknown" : activity?.process?.state || "unknown";
			const commandEvent = (events || []).filter(event => event.stage === "P8" && event.kind === "test"
				&& (!Number.isFinite(start) || Date.parse(event.at) >= start)).at(-1);
			const command = activity?.command || commandEvent?.name || run.executionConfig?.testCommand || "";
			const lastOutputAt = Date.parse(activity?.lastOutputAt), since = Number.isFinite(lastOutputAt) ? lastOutputAt : Date.parse(activity?.startedAt);
			const quietFor = Number.isFinite(since) ? Math.max(0, now - since) : 0;
			let title, tone = "quiet", note = "";
			if (error) { title = "同步中断，正在重试"; tone = "warn"; note = "保留最近确认的内容，当前测试状态待确认。"; }
			else if (activity?.logError) { title = "测试记录保存异常"; tone = "bad"; note = activity.logError; }
			else if (!available && ["invalid", "read_error"].includes(raw?.reasonCode)) { title = "测试状态读取失败"; tone = "warn"; note = raw.reason || "正在重试读取实时执行状态。"; }
			else if (activity?.executionStatus === "timeout") { title = "测试已超时"; tone = "bad"; }
			else if (activity?.executionStatus === "cancelled") title = "测试已取消";
			else if (["environment_error", "preflight_failed"].includes(activity?.executionStatus)) { title = "测试环境检查未通过"; tone = "bad"; }
			else if (activity?.executionStatus === "spawn_failed") { title = "测试命令启动失败"; tone = "bad"; }
			else if (activity?.executionStatus === "failed") { title = "测试未通过"; tone = "bad"; }
			else if (activity?.executionStatus === "completed" && activity.exitCode === 0) title = "测试命令已通过";
			else if (executing && process === "alive") {
				title = stopped ? "流程已停止，测试命令仍在执行" : "测试命令执行中";
				tone = stopped || quietFor >= 60000 ? "warn" : "active";
				if (quietFor >= 60000) note = "已 " + durationText(quietFor) + "没有新输出；测试进程仍在运行，暂不能据此判断是否卡住。";
			} else if (executing) { title = "测试执行状态待确认"; tone = "warn"; note = "当前宿主没有可确认的测试进程状态。"; }
			else if (stopped) title = "流程已停止";
			else if (stageRunning) { title = "测试阶段运行中"; note = "本次执行未采集实时状态；已有输出生成后会显示在下方。"; }
			else if (stage.status === "pending") title = "等待测试开始";
			else { title = "测试执行记录"; note = "本次执行未采集实时状态，可查看已保存的输出和阶段结果。"; }
			if (!note && activity?.error) note = typeof activity.error === "string" ? activity.error : activity.error.message || "";
			const signal = error ? "最近输出时间待同步" : Number.isFinite(lastOutputAt)
				? "最近输出 · " + (executing ? durationText(Math.max(0, now - lastOutputAt)) + "前" : fmtTime(activity.lastOutputAt))
				: activity ? "尚未收到测试输出" : outputFile ? "日志更新时间 · " + fmtTime(outputFile.mtimeMs) : "尚无测试输出";
			const emptyText = error ? "同步恢复后将继续读取测试输出" : stale || stage.status === "pending" ? "等待本轮测试输出；上一轮记录未作为当前输出展示"
				: ended ? "测试已结束，没有可显示的输出" : executing ? "测试命令已启动，等待首条输出" : "尚未收到本轮测试输出";
			return { activity, title, tone, note, signal, command, emptyText, reportFile, outputFile,
				outputTree: outputFile ? [outputFile] : [], identity: activity?.captureId || stage.startedAt || "legacy" };
		}
		function TestActivityPanel({ view }) {
			const { activity, title, tone, note, signal, command } = view;
			return h("section", { className: "studio-activity " + tone, "aria-label": "测试当前活动" },
				h("div", { className: "studio-row wrap" }, h("strong", { className: "studio-grow" }, h("span", { className: "studio-activity-dot", "aria-hidden": "true" }), title), h("span", { className: "hint" }, signal)),
				command ? h("div", { className: "studio-path" }, "测试命令：", h("code", null, command)) : h("span", { className: "hint" }, "正在等待实际测试命令"),
				activity?.environment ? h("div", { className: "hint" }, "执行环境：", [activity.environment.platform,
					activity.environment.shell ? "Shell " + activity.environment.shell : "",
					activity.environment.cwd ? "目录 " + activity.environment.cwd : ""].filter(Boolean).join(" · ")) : null,
				note ? h("p", { className: "hint", role: "status" }, note) : null,
				activity ? h("div", { className: "hint" }, ["开始：" + fmtTime(activity.startedAt),
					activity.finishedAt ? "结束：" + fmtTime(activity.finishedAt) : "",
					activity.exitCode != null ? "退出码 " + activity.exitCode : "",
					activity.signal ? "退出信号 " + activity.signal : ""].filter(Boolean).join(" · ")) : null);
		}
		function currentP10(run) {
			const state = run?.stages?.P10;
			return run?.status === "failed" && state?.sourceStage === run.current
				&& (state.sourceStartedAt || null) === (run.stages?.[run.current]?.startedAt || null) ? state : null;
		}
		function currentFailureOf(run) {
			const failure = run?.failureAnalysis;
			if (run?.status !== "failed" || !failure || typeof failure.category !== "string" || !failure.category.trim()
				|| typeof failure.action !== "string" || !failure.action.trim()) return null;
			const state = run.stages?.P10;
			// 新报告必须匹配失败阶段和分析身份；无身份的旧报告仅在旧任务失败时兼容显示。
			if (failure.analysisId || state?.analysisId || failure.sourceStage || state?.sourceStage) {
				if (!currentP10(run) || !["completed", "degraded", "approved"].includes(state.status) || !["replan", "rollback", "escalate"].includes(failure.action)
					|| !failure.analysisId || failure.analysisId !== state.analysisId || failure.sourceStage !== run.current
					|| (failure.sourceStartedAt || null) !== (run.stages?.[run.current]?.startedAt || null)) return null;
			}
			return failure;
		}
		function RunsPanel(p) {
			const key = p.slug + "/" + p.runId;
			const now = useRunClock(p.run, p.error);
			// v9 隔离规则：节点选择不跨访问记忆——每次进入默认当前阶段（执行中）/最后节点（已完成），
			// 默认跟随推进；手动选择即暂停跟随，紧凑与完整流程都可返回当前阶段。
			const [stage, setStage] = React.useState(p.run?.current || "P1");
			const [trackOpen, setTrackOpen] = usePreference("i2p.track." + key, false);
			const [followStage, setFollowStage] = React.useState(true);
			// 文件只覆盖为弹窗，阶段正文保持挂载；不再读取旧的整页文件偏好。
			const [fileDialog, setFileDialog] = React.useState(null), [eventsOpen, setEventsOpen] = React.useState(false);
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
			const eventsLog = useLogArtifact(p.slug, p.runId, "trace/events.jsonl", p.tree, key + "|" + (p.run?.stages?.[stage]?.startedAt || ""));
			const events = eventsLog.resource;
			const ledger = useRunArtifact(p.slug, p.runId, "ledger/patch-ledger.jsonl", p.tree);
			const coder = useRunArtifact(p.slug, p.runId, "06-implementation/coder-report.json", p.tree);
			const description = useRunArtifact(p.slug, p.runId, "10-pr-description.md", p.tree);
			const evaluation = useRunArtifact(p.slug, p.runId, "11-eval-report.json", p.tree);
			const issueAnalysis = useRunArtifact(p.slug, p.runId, "01-issue-analysis.json", p.tree);
			React.useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
			React.useEffect(() => { if (followStage && p.run?.current && !fileDialog && !eventsOpen && !contextOpen) { setStage(p.run.current); setInstance(""); } }, [p.run?.current, followStage, !!fileDialog, eventsOpen, contextOpen]);
			React.useEffect(() => { setComment(""); }, [stage, p.run?.current, p.run?.stages?.[p.run?.current]?.attempts]);
			const activeStage = STAGES.some(item => item.id === stage) ? stage : p.run?.current || "P1";
			React.useEffect(() => { setNodeTab(""); }, [activeStage, activeStage === "P8" ? p.run?.stages?.P8?.startedAt : null]);
			const selectStage = id => { setStage(id); setInstance(""); setFollowStage(false); };
			const openFile = (file, options = {}) => setFileDialog({ path: file || "", raw: !!options.raw, stage: activeStage });
			const retainStage = () => { if (activeStage !== p.run?.current) setFollowStage(false); };
			const closeFile = () => { retainStage(); setFileDialog(null); };
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
			const acceptance = deliveryEvaluation(evaluation, run, tree, description), p11Status = p11DisplayStatus(run, acceptance);
			const taskStatus = taskDisplayStatus(run, acceptance);
			const execConfig = run.executionConfig;
			const phenomenon = parseJson(issueAnalysis.value)?.phenomenon;
			const taskCaption = typeof phenomenon === "string" && phenomenon.trim() !== taskTitle(run).trim() ? phenomenon.trim() : "";
			const files = stageFiles(activeStage, tree, run), reviews = tree.filter(file => file.path.startsWith("reviews/"));
			const report = parseJson(coder.value), instances = Array.isArray(report?.tasks) ? report.tasks : Array.isArray(report?.patches) ? report.patches : [];
			const currentInstance = activeStage === "P6" && executionItems(run, report).some(item => item.id === instance) ? instance : "";
			const externalReady = !["session", "claude", "dsh"].includes(run.p6Mode) || run.externalExec?.status === "done" || !!run.externalProgress?.report || run.externalProgress?.patches > 0;
			const reviewContext = activeStage === run.current && !currentInstance && !fileDialog && !eventsOpen && !contextOpen;
			const reviewReady = reviewContext && run.status === "awaiting_review" && current?.status === "awaiting_review"
				&& (run.current !== "P6" || externalReady) && (run.current !== "P11" || acceptance.state === "pass");
			const backCurrent = () => { setStage(run.current); setInstance(""); setFollowStage(true); };
			const review = decision => {
				if (!reviewContext) { p.toast("请先返回当前阶段的复核对象", "bad"); return; }
				if (decision === "approve" && !reviewReady) { p.toast(run.current === "P11" ? "六项验收门禁确认通过后才能完成复核" : "等待当前阶段产物就绪", "bad"); return; }
				if (decision === "reject" && !comment.trim()) { p.toast("打回需要填写复核意见", "bad"); return; }
				act("review", { decision, comment, expectedStage: run.current, expectedStatus: run.status, expectedAttempt: current?.attempts || 0, expectedStartedAt: current?.startedAt || null });
			};
			const mainFlow = STAGES.filter(item => !item.bypass), done = mainFlow.filter(item => ["approved", "completed", "failed", "stopped"].includes(run.stages?.[item.id]?.status)).length;
			const records = parseLines(events.value).filter(event => event.stage === activeStage);
			const testView = testActivityView(run, tree, records, now, p.error);
			// TASK-10：事件行携带留档完整性标记（非 complete 才标），完整日志经 logRef 回溯；
			// logRef 只显示末两段（callId/attemptId 或 journal 目录名），完整路径在 JSON 原文可查
			const shortLogRef = ref => String(ref || "").split("/").filter(Boolean).slice(-2).join("/");
			const eventsText = records.map(event => [fmtClock(event.at), event.kind, event.name,
				event.logIntegrity && event.logIntegrity !== "complete" ? "［留档" + event.logIntegrity + "］" : "",
				event.logRef ? "日志 " + shortLogRef(event.logRef) : "", event.detail].filter(Boolean).join("  ")).join("\n");
			const stageUntouched = (state?.status || "pending") === "pending" && !files.length && !records.length;
			const timingEvents = eventsLog.partial ? [] : parseLines(events.value);
			const stageDurationText = id => stageTimingText(run, id, timingEvents, now, !!p.error);
			// 阶段运行信息：模型取启动快照的阶段覆盖，未配置回落 defaultRoute；执行器按阶段语义展示（P7/P8 不走模型）
			const runtimeModelOf = id => {
				const override = (execConfig ? execConfig.stageConfig : p.project?.stageConfig)?.[id];
				if (override?.provider && override?.model) return override.model;
				return execConfig?.defaultRoute?.model || null;
			};
			// 阶段运行方式：外部 Agent 执行显示委托方式（不显示模型），内置显示模型，P7/P8 无模型
			const stageRunTextOf = id => {
				if (id === "P7") return "补丁管线 · 无模型调用";
				if (id === "P8") return "测试执行" + (execConfig?.testCommand ? " · " + execConfig.testCommand : "");
				const override = (execConfig ? execConfig.stageConfig : p.project?.stageConfig)?.[id];
				if (id === "P6" && ["claude", "dsh"].includes(run.p6Mode)) return p6ModeLabel(run.p6Mode);
				if (run.stages?.[id]?.external || override?.delegate?.mode === "session" || (id === "P6" && run.p6Mode === "session")) return "外部会话 · 过程未采集";
				const modelText = override?.provider && override?.model
					? "模型 " + override.model + "（阶段覆盖）"
					: runtimeModelOf(id) ? "模型 " + runtimeModelOf(id) : "模型 宿主默认";
				if (id === "P6") {
					return "内置多智能体 · " + modelText;
				}
				return modelText;
			};
			const runtimeText = [
				...(!stageUntouched ? [state?.attempts > 0 ? activeStage === "P10" ? "第 " + state.attempts + " 次分析" : "已打回 " + state.attempts + " 次" : null, stageDurationText(activeStage)] : []),
				stageRunTextOf(activeStage),
			].filter(Boolean).join(" · ");
			const p10File = tree.some(file => file.path === "09-failure-analysis.json");
			const currentFailure = currentFailureOf(run), p10 = currentP10(run);
			const p10Label = currentFailure ? "已生成" : p10?.status === "running" ? "分析中" : p10?.status === "failed" ? "分析失败"
				: p10?.status === "awaiting_review" ? "等待外部分析" : p10File || run.failureAnalysis ? "历史记录" : "按需触发";
			const outputKey = "i2p.output." + key + "." + activeStage + "." + (state?.attempts || 0) + "." + (state?.startedAt || "");
			const stageDef = STAGES.find(item => item.id === activeStage);
			// v9 规则：未触及的节点（pending 且没有任何事件与产物）只显示一条等待空态，不渲染零内容区块。
			// 方案三：节点内容盘点置顶为子页签（带计数），没有内容的区块不出页签（留空规则）。
			const allPatches = tree.filter(file => /\.(diff|patch)$/.test(file.path));
			const p6StartedAt = Date.parse(run.stages?.P6?.startedAt || "");
			const currentPatches = Number.isFinite(p6StartedAt) ? allPatches.filter(file => file.mtimeMs >= p6StartedAt) : [];
			const nodeTabs = [];
			if (activeStage === "P6") nodeTabs.push(["instances", "Agent 执行记录"]);
			else if (activeStage === "P8") { nodeTabs.push(["testout", "测试输出"]); if (testView.reportFile) nodeTabs.push(["result", "阶段结果"]); }
			else if (activeStage === "P7") nodeTabs.push(["result", "补丁账本"]);
			else if (activeStage === "P11") nodeTabs.push(["delivery", "交付"], ["summary", "全流程汇总"]);
			else nodeTabs.push(["result", "阶段结果"]);
			if (activeStage === "P6" && allPatches.length) nodeTabs.push(["patches", "补丁 " + currentPatches.length]);
			if (files.length) nodeTabs.push(["artifacts", "阶段产物 " + files.length]);
			const nodeTabId = nodeTabs.some(item => item[0] === nodeTab) ? nodeTab : nodeTabs[0]?.[0];
			
			return h("div", { className: "studio-task" },
				h("header", { className: "studio-task-head" },
					// 二期 L-A：面包屑 id 超长自动省略（CSS 170px 上限），title 悬停可见全量
					h("div", { className: "studio-breadcrumb studio-row" }, h("button", { onClick: p.onBack }, "← 任务列表"), "/", h("span", null, p.project?.name || p.slug), "/", h("button", { className: "mono studio-path", title: run.id + " · 点击复制", onClick: () => copyStudio(run.id, p.toast) }, run.id)),
					h("div", { className: "studio-row studio-task-title" },
						h("div", { className: "studio-task-name" }, h("h1", { className: "studio-path" }, taskTitle(run)),
							taskCaption ? h("p", { className: "studio-task-caption", title: "需求分析 · " + taskCaption }, taskCaption) : null),
						h(StatusBadge, { status: taskStatus }), studioButton("任务详情", () => setContextOpen(true)),
						["running", "awaiting_review"].includes(run.status) ? h("button", { type: "button", className: "btn", onClick: () => act("stop"), disabled: busy }, Ic("stop", 14), "停止") : null,
						h("details", { className: "studio-run-actions", open: actionsOpen, onToggle: e => setActionsOpen(e.currentTarget.open), ref: actionsRef }, h("summary", { "aria-label": "更多任务操作" }, "•••"),
							h("div", { className: "studio-action-menu" }, run.status !== "running" ? h(React.Fragment, null,
								h("select", { className: "f-select", "aria-label": "重跑起始阶段", value: rerunStage, onChange: e => setRerunStage(e.target.value) }, STAGES.map(item => h("option", { key: item.id, value: item.id }, item.id + " " + STUDIO_STAGE_NAMES[item.id]))),
								studioButton("重跑", () => { if (window.confirm("从 " + rerunStage + " 重跑，后续阶段状态将重置，相关委外旧产物会清理。继续？")) act("rerun", { stage: rerunStage }); }, "", busy)) : null,
							studioButton("删除任务", () => { if (window.confirm("删除此任务及全部产物？此操作不可恢复。")) act("", {}, "DELETE"); }, "danger", busy),
							h("small", { className: "hint" }, "停止后不再推进；当前内置阶段可能仍需执行完毕，外部执行器会收到终止请求。"))))),
				h("section", { className: "studio-topology", "aria-label": "流水线阶段" },
					h("div", { className: "studio-row studio-workflow-summary" }, h("strong", null, run.status === "completed" ? "流程已结束 · " + tag(taskStatus)[1] : run.current + " · " + STUDIO_STAGE_NAMES[run.current]),
						h("span", { className: "hint studio-stage-total" }, done + " / 10 阶段已结束"), h("span", { className: "studio-grow" }),
						!trackOpen && !followStage ? h("button", { className: "studio-workflow-location", onClick: backCurrent, title: "返回当前阶段并恢复跟随" }, "正在查看 " + activeStage + " · 返回当前 " + run.current + " →") : null,
						h("button", { className: "studio-flow-toggle", "aria-expanded": trackOpen, onClick: () => setTrackOpen(!trackOpen) }, trackOpen ? "收起流程" : "展开流程")),
					h("nav", { className: "studio-track" + (trackOpen ? "" : " compact"), "aria-label": trackOpen ? "完整阶段流程" : "紧凑阶段流程" }, mainFlow.map(item => {
						const status = item.id === "P11" ? p11Status : run.stages?.[item.id]?.status || "pending";
						const stale = item.id !== "P10" && status === "pending" && stageFiles(item.id, tree, run).length > 0;
							return h("button", { key: item.id, className: "studio-stage " + status + (item.id === activeStage ? " on" : "") + (item.id === run.current ? " current" : ""), title: item.id + " " + STUDIO_STAGE_NAMES[item.id] + "，" + tag(status)[1] + (stageDurationText(item.id) ? " · " + stageDurationText(item.id) : "") + " · " + stageRunTextOf(item.id), "aria-label": item.id + " " + STUDIO_STAGE_NAMES[item.id] + "，" + tag(status)[1], "aria-pressed": item.id === activeStage, onClick: () => selectStage(item.id) },
							h("span", { className: "studio-stage-mark" }, ["approved", "completed", "acceptance_passed"].includes(status) ? Ic("check", 13) : ["failed", "acceptance_failed"].includes(status) ? Ic("x", 13) : status === "awaiting_review" ? "!" : item.id === run.current ? "●" : ""),
							h("strong", null, STUDIO_STAGE_NAMES[item.id]), h("span", { className: "studio-stage-code" }, item.id + (item.id === run.current ? " · 当前" : stale ? " · 待重验" : item.key ? " · 复核" : "")));
					})), trackOpen ? h("div", { className: "studio-row studio-track-footer wrap" }, followStage ? h("span", { className: "hint" }, "跟随当前阶段 ✓") : h("button", { onClick: backCurrent, title: "点击返回当前阶段并恢复跟随" }, "正在查看 " + activeStage + " · 返回当前 " + run.current + " →"), h("button", { onClick: () => selectStage("P10") }, "P10 失败分析 · " + p10Label)) : null,
					// 二期 M-A4：页面级失败条只保留结论与动作，详细描述留在阶段级错误条，不再重复
					currentFailure ? h("div", { className: "studio-return-lane studio-row wrap" }, h("span", { className: "studio-grow" }, [currentFailure.category, currentFailure.action].filter(value => typeof value === "string").join(" · ")), studioButton("查看失败分析", () => selectStage("P10"), "ghost sm")) : null),
				h("section", { className: "studio-stage-bar" },
					h("div", { className: "studio-section-heading" }, h("div", { className: "studio-row wrap" },
						h("h2", null, activeStage + " · " + STUDIO_STAGE_NAMES[activeStage]), h(StatusBadge, { status: activeStage === "P11" ? p11Status : activeStage === "P10" && state?.status === "approved" ? "analysis_completed" : state?.status }),
						h("span", { className: "studio-runtime-meta hint" }, runtimeText),
						tree.some(file => file.path === "trace/events.jsonl") ? studioButton("阶段事件" + (events.error ? " · 读取失败" : events.loading ? " · 读取中" : eventsLog.partial ? " · 最近 " + records.length : " " + records.length), () => setEventsOpen(true), "ghost sm") : null,
						tree.length ? studioButton("全部产物 " + tree.length + " ↗", () => openFile(""), "ghost sm") : null)),
					h("div", { className: "studio-stage-tabs" },
						nodeTabs.length > 1 && !stageUntouched ? h("nav", { className: "studio-execution-tabs", "aria-label": "节点内容" },
							nodeTabs.map(([id, label]) => h("button", { key: id, className: nodeTabId === id ? "on" : "", "aria-pressed": nodeTabId === id, onClick: () => setNodeTab(id) }, label))) : null)),
				h("div", { className: "studio-workspace" },
					h("div", { className: "studio-process" }, h("section", { className: "studio-process-main" },
						activeStage === "P6" && run.p6Mode === "claude" && !stageUntouched ? h(AgentActivityPanel, { run, now, error: p.error, onFile: openFile }) : null,
						activeStage === "P8" && !stageUntouched ? h(TestActivityPanel, { view: testView }) : null,
						state?.error ? h("div", { style: { marginBottom: 14 } },
							h("p", { className: "callout err" }, state.error),
							// TASK-10：错误类别徽标（协议/调用/业务验收/留档）+ 完整留档目录引用。
							// 徽标来自结构化错误（st.errorInfo），缺省即旧形态不加行，不推测不补造。
							errorKindChips(state.errorInfo).length || state.errorInfo?.logRefs?.length ? h("div", { className: "studio-row wrap", style: { marginTop: 6 } },
								errorKindChips(state.errorInfo).map((chip, index) => h("span", { key: "errchip" + index, className: "tg " + ERROR_CHIP_TAGS[chip.kind], title: "结构化错误 code=" + state.errorInfo.code }, chip.label)),
								state.errorInfo?.logRefs?.length ? h("span", { key: "errlog", className: "mono studio-path hint", title: "本次调用的完整请求/响应留档目录（trace 下按 callId/attemptId 组织）" }, "留档 " + state.errorInfo.logRefs.join("、")) : null) : null) : null,
												stageUntouched ? h(EmptyState, { title: activeStage === "P10" ? "目前没有需要分析的失败" : activeStage === run.current ? "本阶段尚未开始执行" : "等待上游阶段完成" },
							h("p", null, activeStage === "P10" ? "P10 在主线阶段失败时触发，帮助定位原因并选择恢复方式。" : (STUDIO_STAGE_NAMES[activeStage] || stageDef?.name || activeStage) + "尚未开始，结果生成后会显示在这里。"),
							stageDef?.art ? h("p", { className: "hint" }, "预期产物：" + stageDef.art) : null) :
						h(React.Fragment, null,
							nodeTabId === "instances" ? h(ExecutionsPanel, { ...p, tree, coder, events, eventsText, outputKey, selection: currentInstance, onSelect: setInstance, onFile: openFile, onInspect: () => setFollowStage(false) }) :
							nodeTabId === "patches" ? h(PatchPreview, { ...p, tree, onFile: openFile }) :
							nodeTabId === "testout" ? h(RunLogPanel, { ...p, tree: testView.outputTree, key: outputKey + ".testout", path: "08-test-output.txt", identity: outputKey + "." + testView.identity, label: "P8 · 测试输出", searchScope: "测试输出全文", emptyText: testView.emptyText, memoryKey: outputKey + ".testout", filename: p.runId + "-P8-output.txt", artifactProps: testView.outputFile ? { ...p, instances } : undefined, onFile: testView.outputFile ? () => openFile("08-test-output.txt", { raw: true }) : undefined, onInspect: () => setFollowStage(false) }) :
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
							nodeTabId === "delivery" ? h(DeliveryPanel, { run, tree, description, evaluation, toast: p.toast, onFile: openFile, onSummary: () => setNodeTab("summary") }) :
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
					studioButton("打回", () => review("reject"), "danger", busy), studioButton("通过 " + run.current + " 并继续", () => review("approve"), "pri", busy || !reviewReady), !reviewReady ? h("span", { className: "hint" }, run.current === "P11" ? acceptance.state === "loading" ? "正在读取验收结论…" : "重新评测并通过六项门禁后可复核通过" : "等待外部产物就绪") : null)
					: h("div", { className: "studio-row wrap" }, h("span", { className: "studio-grow hint" }, "当前正在查看其他内容；" + run.current + " 的阶段汇总等待复核。"), studioButton("返回当前复核对象", backCurrent, "pri"))) : null,
				contextOpen && !fileDialog ? h(StudioDialog, { title: "任务详情", wide: true, onClose: () => { retainStage(); setContextOpen(false); } }, h("div", { className: "studio-stack" },
					h("div", { className: "kv" }, kvRow("项目", p.project?.name || p.slug), kvRow("任务编号", run.id, true), kvRow("来源", run.trigger?.uri || "—", true), kvRow("创建时间", fmtTime(run.createdAt)), kvRow("复核方式", reviewModeLabel(run.reviewMode)), kvRow("代码执行器", p6ModeLabel(run.p6Mode))),
					h("p", { className: "hint" }, run.executionConfig ? "使用启动配置 v" + run.executionConfig.revision + " · 默认模型 " + (run.executionConfig.defaultRoute?.model || "未记录") : "历史任务未记录配置快照，兼容读取旧项目配置。"),
					h("p", { className: "hint" }, "测试环境配置：", execConfig?.testEnvironment
						? (execConfig.testEnvironment.platform === "host" ? "当前 DSH 主机" : execConfig.testEnvironment.platform) + " · Shell " + (execConfig.testEnvironment.shell || "系统默认")
						: "未记录环境快照；实际环境以本轮测试执行记录为准。"),
					run.executionConfig ? h("details", null, h("summary", null, "查看启动配置"), h("pre", { className: "studio-json" }, JSON.stringify(run.executionConfig, null, 2))) : null,
					h("details", null, h("summary", null, "阶段职责与契约"), h(StageContractCard, { stageId: activeStage, defaults: p.defaults }), h(StageGuideCard, { stageId: activeStage, defaults: p.defaults })),
						h("details", null, h("summary", null, "复核历史 · " + reviews.length), reviews.length ? reviews.slice(-20).reverse().map(file => studioButton(file.path.split("/").at(-1), () => openFile(file.path), "ghost sm")) : h("p", { className: "hint" }, "暂无复核记录")),
					studioButton("调整新任务的阶段默认值", () => { setContextOpen(false); p.onConfig(activeStage); }, "ghost"))) : null,
				// 保留原阶段正文，文件与阶段事件均通过弹窗查看。
				eventsOpen ? h(RunLogPanel, { ...p, key: outputKey, log: eventsLog, path: "trace/events.jsonl", stage: activeStage, label: activeStage + " · 阶段事件", memoryKey: outputKey + ".events", filename: p.runId + "-" + activeStage + "-events.log", dialog: true, onClose: () => { retainStage(); setEventsOpen(false); }, artifactProps: { ...p, instances }, onFile: () => openFile("trace/events.jsonl", { raw: true }) }) : null,
				fileDialog ? h(ArtifactsDialog, { ...p, tree, instances, initialPath: fileDialog.path, initialRaw: fileDialog.raw, onClose: closeFile,
					onReturn: contextOpen ? closeFile : undefined, returnLabel: "← 返回任务详情" }) : null);
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
				triggers: existing?.triggers || [],
				testPlatform: existing?.testEnvironment?.platform || "host", testShell: existing?.testEnvironment?.shell || ""
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
						triggers: form.triggers.filter(item => item.uri.trim()),
						testEnvironment: { platform: form.testPlatform, shell: form.testShell.trim() } });
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
					h("fieldset", { className: "studio-stack" }, h("legend", null, "测试环境"),
						settingField("测试平台", form.testPlatform, value => field("testPlatform", value), { disabled: busy,
							choices: [["host", "当前 DSH 主机"], ["win32", "Windows"], ["linux", "Linux"], ["darwin", "macOS"]],
							hint: "平台不匹配时在测试前报错；不会自动切换操作系统或启动远程环境。" }),
						settingField("测试 Shell", form.testShell, value => field("testShell", value), { disabled: busy,
							placeholder: "留空使用系统默认，或填写 Shell 可执行文件的绝对路径",
							hint: "支持 cmd.exe 或 POSIX 兼容 Shell（如 Bash、sh）；同时用于外层测试命令和 npm 内部脚本，不填写参数。保存后用于新建任务，已有任务保留原环境快照。" })),
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
					h("div", { className: "studio-segmented", "aria-label": "筛选任务状态" }, [["all", "全部"], ["attention", "待处理 " + attention], ["running", "执行中"], ["completed", "流程已结束"]].map(([id, label]) =>
						h("button", { key: id, className: status === id ? "on" : "", "aria-pressed": status === id, onClick: () => { setStatus(id); setPage(0); } }, label)))),
				h("div", { className: "studio-row studio-filter-result" }, h("span", { className: "studio-grow" }, (effectiveFilter === "all" ? "全部项目" : selected[0]?.name) + " · " + rows.length + " / " + allRows.length + " 项任务"),
					status !== "all" || search ? studioButton("清除搜索与状态筛选", () => { setStatus("all"); setSearch(""); setPage(0); }, "ghost sm") : null,
					studioButton("刷新", source.reload, "ghost sm")),
				h(ResourceNotice, { resource: source }),
				source.value?.errors.length ? h("div", { className: "callout err", role: "alert" }, "部分项目读取失败，保留其上次结果：" + source.value.errors.join("；"), studioButton("重试", source.reload, "sm")) : null,
				source.value == null && !source.error ? h(Skel) : rows.length ? h("div", { className: "studio-task-list", "aria-label": "任务列表" },
					rows.slice(currentPage * 30, (currentPage + 1) * 30).map(run => h("button", { className: "studio-run-row", key: run.slug + "/" + run.id, onClick: () => p.onOpen(run.slug, run.id) },
						h("span", { className: "studio-run-icon " + (run.status === "completed" ? "flow_ended" : run.status) }, Ic(run.status === "failed" ? "x" : "git", 20)),
						h("span", null, h("strong", null, taskTitle(run)), h("span", { className: "studio-run-description" }, run.projectName + " · " + run.id), h("span", { className: "studio-run-reason" }, taskReason(run))),
						h(StatusBadge, { status: run.status === "completed" ? "flow_ended" : run.status }), h("span", { className: "studio-run-time hint", title: fmtTime(run.createdAt) }, fmtTime(run.createdAt).slice(5, 10)))))
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
											: h(MarkdownText, { text: m.text, labels: MARKDOWN_LABELS }))
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
