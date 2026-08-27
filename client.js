// client.js — Issue2PR 完整三 tab UI（项目 / 运行 / 产物）
// 视觉与交互照抄 issue2pr-ui-preview.html（设计令牌、布局、class 命名），
// 数据源替换为同源 REST API（/issue2pr/api/*，由本插件 node 半提供）。
// 零 npm 依赖：React 来自宿主（require("react")），样式注入单个 <style> 标签。
window.__ModuleLoader__.load({
	id: "dsh-issue2pr",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const React = require("react");
		const h = React.createElement;
		const zh = { nav: "Issue2PR" };
		const en = { nav: "Issue2PR" };
		const API = "/issue2pr/api";

		// ---------- 常量：11 阶段（与 lib/pipeline.js STAGES 对齐） ----------
		const STAGES = [
			{ id: "P1",  name: "IssueAnalyzer",      desc: "Issue → 结构化契约",      art: "01-issue-analysis.json" },
			{ id: "P2",  name: "Search Layer",       desc: "候选文件 + 证据",          art: "02-search-candidates.json" },
			{ id: "P3",  name: "Code Understanding", desc: "调用链与修改点",           art: "03-code-understanding.md" },
			{ id: "P4",  name: "Hypothesis",         desc: "可验证根因假设",           art: "04-hypotheses.json" },
			{ id: "P5",  name: "Planner",            desc: "TaskGraph 规划",           art: "05-task-graph.json" },
			{ id: "P6",  name: "代码优化",            desc: "多智能体协同",             art: "06-implementation/" },
			{ id: "P7",  name: "Patch Pipeline",     desc: "版本校验 → 落盘",          art: "ledger/patch-ledger.jsonl" },
			{ id: "P8",  name: "TestRunner",         desc: "沙箱真实执行",             art: "07-test-report.json" },
			{ id: "P9",  name: "Reviewer",           desc: "门控审查",                 art: "08-review-report.json" },
			{ id: "P10", name: "FailureClassifier",  desc: "失败分类（按需）",          art: "09-failure-analysis.json" },
			{ id: "P11", name: "PRBuilder + Eval",   desc: "PR 说明 + Gate 评测",      art: "10-pr-description.md" },
		];

		// ---------- 状态 chip 映射（同预览稿） ----------
		const STAGE_CHIP = {
			approved:        ["c-done", "已通过"],
			awaiting_review: ["c-wait", "待复核"],
			running:         ["c-run",  "运行中"],
			failed:          ["c-bad",  "失败"],
			pending:         ["c-idle", "未开始"],
		};
		const RUN_CHIP = {
			completed:       ["c-done", "已完成"],
			awaiting_review: ["c-wait", "待复核"],
			running:         ["c-run",  "运行中"],
			failed:          ["c-bad",  "失败"],
			pending:         ["c-idle", "排队中"],
		};

		/* ================================================================
		 * 样式（照抄预览稿令牌与布局；全部选择器加 .i2p 前缀，
		 * 令牌定义在 .i2p 容器下，避免污染宿主 GUI 全局样式）
		 * ================================================================ */
		const css = `
.i2p{
  --bg:#18191b; --surface:#1e2023; --surface-2:#25272b; --surface-3:#2c2f34;
  --border:#31343a; --border-strong:#43474f;
  --ink:#e8e9eb; --ink-2:#b8bbc1; --muted:#8d919a;
  --accent:#7d9bd4; --accent-soft:rgba(125,155,212,.13);
  --good:#5da886; --good-soft:rgba(93,168,134,.13);
  --warn:#cfa25c; --warn-soft:rgba(207,162,92,.13);
  --bad:#cd7474; --bad-soft:rgba(205,116,116,.12);
  --mono:'JetBrains Mono','Cascadia Code',Consolas,'Liberation Mono',monospace;
  --sans:'Inter','PingFang SC','Microsoft YaHei',system-ui,sans-serif;
  --radius:10px;
  background:var(--bg); color:var(--ink);
  font-family:var(--sans); font-size:14px; line-height:1.6;
  -webkit-font-smoothing:antialiased;
}
.i2p *{box-sizing:border-box}
.i2p button{font-family:inherit;cursor:pointer}
.i2p button:focus-visible,.i2p input:focus-visible,.i2p textarea:focus-visible,.i2p select:focus-visible{
  outline:2px solid var(--accent);outline-offset:2px;
}
.i2p ::selection{background:var(--accent);color:#fff}
.i2p .page{max-width:1180px;margin:0 auto;padding:12px 0 56px}

/* ===== 页头 ===== */
.i2p header.top{
  display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap;
  padding-bottom:18px;border-bottom:1px solid var(--border);margin-bottom:20px;
}
.i2p .title-block h1{
  margin:0;font-size:22px;font-weight:650;letter-spacing:.01em;display:flex;align-items:center;gap:10px;
}
.i2p .title-block h1 .glyph{
  width:26px;height:26px;border-radius:7px;background:var(--accent-soft);
  display:inline-flex;align-items:center;justify-content:center;
  font-family:var(--mono);font-size:13px;color:var(--accent);border:1px solid rgba(125,155,212,.35);
}
.i2p .title-block p{margin:4px 0 0;color:var(--muted);font-size:13px}
.i2p .env-badge{
  font-family:var(--mono);font-size:11.5px;color:var(--muted);
  border:1px solid var(--border);border-radius:20px;padding:5px 14px;background:var(--surface);
}
.i2p .env-badge b{color:var(--ink-2);font-weight:600}

/* ===== Tab 栏 ===== */
.i2p .tabs{display:flex;gap:6px;margin-bottom:20px;border-bottom:1px solid var(--border)}
.i2p .tab{
  background:none;border:none;border-bottom:2px solid transparent;
  color:var(--muted);font-size:14px;padding:9px 18px 11px;margin-bottom:-1px;border-radius:6px 6px 0 0;
}
.i2p .tab:hover{color:var(--ink-2);background:var(--surface)}
.i2p .tab[aria-selected="true"]{color:var(--accent);border-bottom-color:var(--accent);font-weight:600}
.i2p .tab .count{
  font-family:var(--mono);font-size:11px;background:var(--surface-3);border-radius:9px;
  padding:1px 7px;margin-left:7px;color:var(--ink-2);
}

/* ===== 通用卡片 / 按钮 / 表单 ===== */
.i2p .card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:18px 20px}
.i2p .btn{
  border:1px solid var(--border-strong);background:var(--surface-2);color:var(--ink);
  border-radius:8px;padding:7px 16px;font-size:13px;transition:background .15s,border-color .15s;
}
.i2p .btn:hover{background:var(--surface-3)}
.i2p .btn.primary{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600}
.i2p .btn.primary:hover{background:#6a8ac9}
.i2p .btn.good{background:var(--good);border-color:var(--good);color:#06281a;font-weight:600}
.i2p .btn.danger{background:none;border-color:var(--bad);color:var(--bad)}
.i2p .btn.danger:hover{background:var(--bad-soft)}
.i2p .btn.ghost{background:none}
.i2p .btn:disabled{opacity:.45;cursor:not-allowed}
.i2p .btn.sm{padding:4px 12px;font-size:12px}
.i2p label.f-label{display:block;font-size:12.5px;color:var(--muted);margin:0 0 6px;font-weight:600}
.i2p .f-input,.i2p .f-select{
  width:100%;background:var(--bg);border:1px solid var(--border-strong);border-radius:8px;
  color:var(--ink);padding:8px 12px;font-size:13.5px;font-family:inherit;
}
.i2p textarea.f-input{width:100%;background:var(--bg);border:1px solid var(--border-strong);border-radius:8px;color:var(--ink);padding:8px 12px;font-size:13.5px;font-family:inherit}
.i2p .f-input.mono,.i2p .f-select.mono{font-family:var(--mono);font-size:12.5px}
.i2p .f-input::placeholder{color:#5a6070}
.i2p .field{margin-bottom:16px}
.i2p .field-row{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media (max-width:760px){.i2p .field-row{grid-template-columns:1fr}}

/* 动态行（git 链接 / 触发源） */
.i2p .dyn-row{display:flex;gap:8px;margin-bottom:8px;align-items:center}
.i2p .dyn-row .f-input{flex:1}
.i2p .dyn-row .rm{flex:none;color:var(--muted);border:1px solid var(--border);background:none;border-radius:7px;width:32px;height:32px;font-size:15px;line-height:1}
.i2p .dyn-row .rm:hover{color:var(--bad);border-color:var(--bad)}
.i2p .add-row{
  background:none;border:1px dashed var(--border-strong);color:var(--accent);border-radius:8px;
  padding:6px 14px;font-size:12.5px;margin-top:2px;
}
.i2p .add-row:hover{border-color:var(--accent)}

/* 触发源（需求文档 / Issue 文档） */
.i2p fieldset.trig-src{border:1px solid var(--border);border-radius:var(--radius);padding:14px 16px 16px;margin:0 0 16px}
.i2p .trig-group{margin-top:14px}
.i2p .trig-group:first-of-type{margin-top:10px}
.i2p .trig-head{font-size:13px;font-weight:600;color:var(--ink-2);margin-bottom:8px;display:flex;align-items:center;gap:8px}
.i2p .trig-head .hint{font-weight:400;font-size:11.5px;color:var(--muted)}
.i2p .trig-tag{font-family:var(--mono);font-size:10.5px;color:var(--accent);border:1px solid rgba(125,155,212,.4);border-radius:4px;padding:1px 6px}
.i2p .trig-tag.issue{color:var(--warn);border-color:rgba(207,162,92,.4)}
.i2p .run-btn{
  flex:none;width:32px;height:32px;border-radius:7px;border:1px solid var(--border-strong);
  background:var(--surface-2);color:var(--good);font-size:11px;line-height:1;
}
.i2p .run-btn:hover{border-color:var(--good)}

/* 单选组 */
.i2p .radio-group{display:flex;gap:10px;flex-wrap:wrap}
.i2p .radio-chip{
  display:flex;align-items:center;gap:8px;border:1px solid var(--border-strong);border-radius:8px;
  padding:7px 14px;font-size:13px;color:var(--ink-2);cursor:pointer;user-select:none;
}
.i2p .radio-chip input{accent-color:var(--accent);margin:0}
.i2p .radio-chip.on{border-color:var(--accent);background:var(--accent-soft);color:var(--ink)}
.i2p .radio-chip .hint{font-size:11.5px;color:var(--muted)}

/* ===== 项目 tab 布局 ===== */
.i2p .proj-layout{display:grid;grid-template-columns:250px 1fr;gap:18px;align-items:start}
@media (max-width:860px){.i2p .proj-layout{grid-template-columns:1fr}}
.i2p .proj-list{display:flex;flex-direction:column;gap:8px}
.i2p .proj-item{
  text-align:left;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);
  padding:12px 14px;color:var(--ink);
}
.i2p .proj-item:hover{border-color:var(--border-strong)}
.i2p .proj-item.on{border-color:var(--accent);background:var(--accent-soft)}
.i2p .proj-item .p-name{font-weight:600;font-size:14px;display:flex;align-items:center;gap:8px}
.i2p .proj-item .p-meta{font-family:var(--mono);font-size:11px;color:var(--muted);margin-top:4px}

/* ===== 运行 tab：流水线 ===== */
.i2p .run-bar{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:18px}
.i2p .run-bar .f-label{margin:0}
.i2p .run-bar .f-select{width:auto;min-width:340px;background:var(--bg);border:1px solid var(--border-strong);border-radius:8px;color:var(--ink);padding:8px 12px;font-size:12.5px;font-family:var(--mono)}
.i2p .pipe-layout{display:grid;grid-template-columns:340px 1fr;gap:18px;align-items:start}
@media (max-width:960px){.i2p .pipe-layout{grid-template-columns:1fr}}

.i2p .stage-list{display:flex;flex-direction:column;gap:6px}
.i2p .stage{
  display:grid;grid-template-columns:auto 1fr auto;gap:12px;align-items:center;
  background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);
  padding:10px 14px;text-align:left;color:var(--ink);width:100%;
}
.i2p .stage:hover{border-color:var(--border-strong)}
.i2p .stage.on{border-color:var(--accent);background:var(--accent-soft)}
.i2p .stage .idx{font-family:var(--mono);font-size:11px;color:var(--muted);width:30px}
.i2p .stage .s-name{font-size:13.5px;font-weight:600}
.i2p .stage .s-desc{font-size:11.5px;color:var(--muted);font-weight:400;margin-top:1px}
.i2p .stage.done{opacity:.88}
.i2p .stage.waiting{border-color:var(--warn);background:var(--warn-soft)}
.i2p .stage.running{border-color:var(--accent)}
.i2p .stage.idle{opacity:.55}
.i2p .stage.bad{border-color:var(--bad);background:var(--bad-soft)}

.i2p .chip{
  display:inline-flex;align-items:center;gap:6px;font-size:11px;font-weight:600;
  border-radius:20px;padding:3px 10px;white-space:nowrap;border:1px solid transparent;
}
.i2p .chip::before{content:"";width:7px;height:7px;border-radius:50%;background:currentColor}
.i2p .chip.c-done{color:var(--good);background:var(--good-soft);border-color:rgba(93,168,134,.35)}
.i2p .chip.c-wait{color:var(--warn);background:var(--warn-soft);border-color:rgba(207,162,92,.4)}
.i2p .chip.c-run{color:var(--accent);background:var(--accent-soft);border-color:rgba(125,155,212,.45)}
.i2p .chip.c-run::before{animation:pulse 1.1s ease-in-out infinite}
.i2p .chip.c-idle{color:var(--muted);background:var(--surface-2);border-color:var(--border)}
.i2p .chip.c-bad{color:var(--bad);background:var(--bad-soft);border-color:rgba(205,116,116,.35)}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.25}}
@media (prefers-reduced-motion:reduce){.i2p .chip.c-run::before{animation:none}}

/* 阶段详情 */
.i2p .detail-head{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;flex-wrap:wrap;margin-bottom:14px}
.i2p .detail-head h2{margin:0;font-size:17px}
.i2p .detail-head .path{font-family:var(--mono);font-size:11.5px;color:var(--muted);margin-top:4px}
.i2p .artifact-tabs{display:flex;gap:6px;margin-bottom:12px;flex-wrap:wrap}
.i2p .a-tab{
  background:var(--surface-2);border:1px solid var(--border);color:var(--ink-2);
  border-radius:7px;padding:5px 12px;font-size:12px;font-family:var(--mono);
}
.i2p .a-tab.on{border-color:var(--accent);color:var(--accent);background:var(--accent-soft)}
.i2p pre.view{
  background:var(--bg);border:1px solid var(--border);border-radius:8px;
  padding:14px 16px;font-family:var(--mono);font-size:12.5px;line-height:1.65;
  overflow-x:auto;margin:0;max-height:380px;overflow-y:auto;color:var(--ink-2);
}
.i2p pre.view .k{color:#a3b8d8}
.i2p pre.view .s{color:#9fc4a3}
.i2p pre.view .c{color:#5a6070;font-style:italic}
.i2p pre.view .add{color:var(--good)}
.i2p pre.view .del{color:var(--bad)}
.i2p pre.view .hunk{color:var(--accent)}

.i2p .review-box{
  margin-top:16px;border:1px solid rgba(207,162,92,.45);background:var(--warn-soft);
  border-radius:var(--radius);padding:16px 18px;
}
.i2p .review-box h3{margin:0 0 4px;font-size:14px;color:var(--warn);display:flex;align-items:center;gap:8px}
.i2p .review-box p{margin:0 0 12px;font-size:12.5px;color:var(--ink-2)}
.i2p .review-actions{display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap}
.i2p .review-actions textarea{flex:1;min-width:240px;min-height:64px;resize:vertical}
.i2p .gate-note{font-family:var(--mono);font-size:11px;color:var(--muted);margin-top:10px}

/* ===== 产物 tab：文件树 ===== */
.i2p .art-layout{display:grid;grid-template-columns:320px 1fr;gap:18px;align-items:start}
@media (max-width:900px){.i2p .art-layout{grid-template-columns:1fr}}
.i2p .tree{font-family:var(--mono);font-size:12.5px;color:var(--ink-2);overflow-x:auto}
.i2p .tree .dir{color:var(--ink);font-weight:600;padding:3px 0}
.i2p .tree .file{
  display:block;width:100%;text-align:left;background:none;border:none;color:var(--ink-2);
  padding:3px 8px;border-radius:6px;font-family:inherit;font-size:inherit;
}
.i2p .tree .file:hover{background:var(--surface-2)}
.i2p .tree .file.on{background:var(--accent-soft);color:var(--accent)}
.i2p .tree .ts{color:var(--muted);font-size:11px}

.i2p .toast{
  position:fixed;bottom:26px;left:50%;transform:translateX(-50%);
  background:var(--surface-3);border:1px solid var(--good);color:var(--ink);
  padding:10px 22px;border-radius:10px;font-size:13px;z-index:50;max-width:80%;
  opacity:0;pointer-events:none;transition:opacity .2s;
}
.i2p .toast.show{opacity:1}
.i2p .toast.t-bad{border-color:var(--bad)}
@media (prefers-reduced-motion:reduce){.i2p .toast{transition:none}}

.i2p .hint-line{font-size:12px;color:var(--muted);margin:14px 0 0}
.i2p .hint-line code{font-family:var(--mono);background:var(--surface-3);padding:1px 6px;border-radius:4px;font-size:11px}
.i2p .empty-hint{color:var(--muted);font-size:13px;padding:18px 0}
`;

		const tagId = "dsh-issue2pr/styles";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=\"" + tagId + "\"]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-issue2pr";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}

		/* ================================================================
		 * 工具函数
		 * ================================================================ */
		function esc(s) {
			return String(s).replace(/[&<>"']/g, function (c) {
				return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
			});
		}

		// JSON 顺序词法高亮（key 蓝 / 字符串绿 / 注释灰；跨标签不嵌套）
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

		// 按文件名/内容选择渲染方式：JSON 高亮 / diff 着色 / md 原样
		function renderView(text, name) {
			const n = String(name || "").toLowerCase();
			if (/\.json$/.test(n)) return jsonHtml(text);
			if (/\.(diff|patch)$/.test(n)) return diffHtml(text);
			if (/\.md$/.test(n)) return esc(text);
			if (/^(diff |--- |\+\+\+ )/.test(text)) return diffHtml(text);
			return esc(text);
		}

		function reviewModeLabel(m) {
			return ({ every: "每阶段都停", "key-only": "只停关键门", auto: "全自动" })[m] || String(m || "");
		}
		function p6ModeLabel(m) {
			return ({ builtin: "插件内多智能体", session: "交给 DSH 会话" })[m] || String(m || "");
		}
		function kindLabel(k) { return k === "issue" ? "Issue" : "需求"; }
		function stageClass(status) {
			return { approved: "done", awaiting_review: "waiting", running: "running", pending: "idle", failed: "bad" }[status] || "idle";
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
		function apiGet(path) {
			return fetch(API + path).then(function (r) { return r.json().catch(function () { return {}; }); });
		}
		function apiPost(path, body) {
			return fetch(API + path, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body || {}),
			}).then(function (r) { return r.json().catch(function () { return {}; }); });
		}

		/* ================================================================
		 * 项目 tab
		 * ================================================================ */
		function ProjectsPanel(props) {
			const p = props;
			const [form, setForm] = React.useState(null);
			const [saving, setSaving] = React.useState(false);

			const blankForm = function () {
				return { name: "", slug: "", repos: [{ uri: "" }], triggers: [], reviewMode: "every", p6Mode: "builtin", testCommand: "" };
			};

			// slug 或项目列表变化 → 装载表单（新建 = 空表单）
			React.useEffect(function () {
				const pr = p.projects ? p.projects.find(function (x) { return x.slug === p.slug; }) : null;
				if (!pr) { setForm(blankForm()); return; }
				setForm({
					name: pr.name || "",
					slug: pr.slug || "",
					repos: (pr.repos || []).map(function (r) {
						return typeof r === "string" ? { uri: r } : { uri: (r && r.uri) || "" };
					}),
					triggers: (pr.triggers || []).map(function (t) { return { kind: t.kind, uri: (t.uri || "") }; }),
					reviewMode: pr.reviewMode || "every",
					p6Mode: pr.p6Mode || "builtin",
					testCommand: pr.testCommand || "",
				});
			}, [p.slug, p.projects]);

			if (!form) return h("p", { className: "empty-hint" }, "加载中…");

			const setField = function (k, v) { setForm(function (f) { return Object.assign({}, f, { [k]: v }); }); };
			const setRepo = function (i, uri) { setForm(function (f) { const r = f.repos.slice(); r[i] = { uri: uri }; return Object.assign({}, f, { repos: r }); }); };
			const rmRepo = function (i) { setForm(function (f) { if (f.repos.length <= 1) return f; const r = f.repos.slice(); r.splice(i, 1); return Object.assign({}, f, { repos: r }); }); };
			const addRepo = function () { setForm(function (f) { return Object.assign({}, f, { repos: f.repos.concat([{ uri: "" }]) }); }); };
			const setTrig = function (i, uri) { setForm(function (f) { const t = f.triggers.slice(); t[i] = Object.assign({}, t[i], { uri: uri }); return Object.assign({}, f, { triggers: t }); }); };
			const rmTrig = function (i) { setForm(function (f) { const t = f.triggers.slice(); t.splice(i, 1); return Object.assign({}, f, { triggers: t }); }); };
			const addTrig = function (kind) { setForm(function (f) { return Object.assign({}, f, { triggers: f.triggers.concat([{ kind: kind, uri: "" }]) }); }); };

			const collect = function () {
				const f = form;
				return {
					name: (f.name || "").trim(),
					slug: (f.slug || "").trim(),
					repos: f.repos.map(function (r) { return (r.uri || "").trim(); }).filter(Boolean).map(function (uri) { return { uri: uri }; }),
					triggers: f.triggers
						.map(function (t) { return { kind: t.kind, uri: (t.uri || "").trim() }; })
						.filter(function (t) { return t.uri; }),
					reviewMode: f.reviewMode,
					p6Mode: f.p6Mode,
					testCommand: (f.testCommand || "").trim(),
				};
			};
			const validate = function (o) {
				if (!o.name) return "请填写项目名称";
				if (!/^[a-z0-9-]+$/.test(o.slug)) return "slug 只允许小写字母/数字/连字符";
				if (o.repos.length === 0) return "至少填写一个 Git 仓库链接";
				return null;
			};

			const ensureSaved = function () {
				const o = collect();
				const err = validate(o);
				if (err) { p.toast(err, "bad"); return Promise.resolve(null); }
				setSaving(true);
				return apiPost("/projects", o).then(function (r) {
					setSaving(false);
					if (!r || !r.ok) { p.toast((r && r.message) || "保存失败", "bad"); return null; }
					p.onSaved(o.slug);
					return o.slug;
				}).catch(function (e) { setSaving(false); p.toast("请求失败: " + e, "bad"); return null; });
			};

			const startRun = function (kind, uri) {
				const u = (uri || "").trim();
				if (!u) { p.toast("请先填写该触发源路径", "bad"); return; }
				ensureSaved().then(function (slug) {
					if (!slug) return;
					apiPost("/projects/" + slug + "/runs", { kind: kind, uri: u }).then(function (r) {
						if (!r || !r.ok) { p.toast((r && r.message) || "发起 Run 失败", "bad"); return; }
						p.onRunStarted(slug, r.runId);
					}).catch(function (e) { p.toast("请求失败: " + e, "bad"); });
				});
			};

			const runFirst = function () {
				const o = collect();
				if (o.triggers.length === 0) { p.toast("请先添加触发源（需求文档或 Issue）", "bad"); return; }
				startRun(o.triggers[0].kind, o.triggers[0].uri);
			};

			const radioGroup = function (labelId, opts, value, onChange, name) {
				return h("div", { className: "radio-group", role: "radiogroup", "aria-labelledby": labelId },
					opts.map(function (o) {
						const on = value === o.value;
						return h("label", { key: o.value, className: "radio-chip" + (on ? " on" : "") },
							h("input", { type: "radio", name: name, value: o.value, checked: on, onChange: function () { onChange(o.value); } }),
							o.label,
							h("span", { className: "hint" }, o.hint));
					}));
			};

			const trigGroup = function (kind, title, tagCls, tagText, hint) {
				const rows = [];
				form.triggers.forEach(function (t, i) {
					if (t.kind !== kind) return;
					rows.push(h("div", { key: "tr" + i, className: "dyn-row" },
						h("input", {
							className: "f-input mono", value: t.uri,
							placeholder: kind === "requirement" ? "D:\\path\\to\\spec.md 或 https://…" : "D:\\issues\\xxx.md 或 issue 链接，格式不限",
							"aria-label": title + " " + (i + 1),
							onChange: function (e) { setTrig(i, e.target.value); },
						}),
						h("button", {
							type: "button", className: "run-btn",
							title: "用此" + title + "发起 Run", "aria-label": "用此" + title + "发起 Run",
							onClick: function () { startRun(kind, t.uri); },
						}, "▶"),
						h("button", { type: "button", className: "rm", "aria-label": "删除该行", onClick: function () { rmTrig(i); } }, "×")));
				});
				return h("div", { className: "trig-group", key: kind },
					h("div", { className: "trig-head" },
						h("span", { className: "trig-tag" + (tagCls ? " " + tagCls : "") }, tagText),
						title,
						h("span", { className: "hint" }, hint)),
					rows,
					h("button", { type: "button", className: "add-row", onClick: function () { addTrig(kind); } }, "＋ 添加" + (kind === "issue" ? " Issue" : "需求文档")));
			};

			const listItems = (p.projects || []).map(function (pr) {
				const on = pr.slug === p.slug;
				return h("button", {
					key: pr.slug, className: "proj-item" + (on ? " on" : ""), role: "option",
					"aria-selected": on ? "true" : "false",
					onClick: function () { p.onSelectProject(pr.slug); },
				},
					h("span", { className: "p-name" }, pr.name),
					h("span", { className: "p-meta" },
						(pr.repos || []).length + " 个仓库 · " + (pr.triggers || []).length + " 份文档 · 复核:" + reviewModeLabel(pr.reviewMode)));
			});
			listItems.push(h("button", { key: "__new__", className: "add-row", onClick: function () { p.onSelectProject(null); } }, "＋ 新建项目"));

			return h("div", { className: "proj-layout" },
				h("div", { className: "proj-list", role: "listbox", "aria-label": "项目列表" }, listItems),
				h("form", {
					className: "card", onSubmit: function (e) { e.preventDefault(); ensureSaved(); },
				},
					h("div", { className: "field-row" },
						h("div", { className: "field" },
							h("label", { className: "f-label", htmlFor: "f-name" }, "项目名称"),
							h("input", { className: "f-input", id: "f-name", value: form.name, onChange: function (e) { setField("name", e.target.value); } })),
						h("div", { className: "field" },
							h("label", { className: "f-label", htmlFor: "f-slug" }, "目录名（slug，产物根下的项目文件夹）"),
							h("input", { className: "f-input mono", id: "f-slug", value: form.slug, onChange: function (e) { setField("slug", e.target.value); } }))),
					h("div", { className: "field" },
						h("label", { className: "f-label" }, "Git 仓库链接（可多个，第一个为主仓库）"),
						form.repos.map(function (r, i) {
							return h("div", { key: i, className: "dyn-row" },
								h("input", {
									className: "f-input mono", value: r.uri, placeholder: "https://github.com/org/repo.git",
									"aria-label": "仓库链接 " + (i + 1),
									onChange: function (e) { setRepo(i, e.target.value); },
								}),
								h("button", { type: "button", className: "rm", "aria-label": "删除该行", onClick: function () { rmRepo(i); } }, "×"));
						}),
						h("button", { type: "button", className: "add-row", onClick: addRepo }, "＋ 添加仓库")),
					h("fieldset", { className: "trig-src" },
						h("span", { className: "f-label", style: { display: "block" } }, "触发源 · 需求文档与 Issue 均可单独发起 Run（可多个，格式不限）"),
						trigGroup("requirement", "需求文档", "", "需求", "本地路径或 URL"),
						trigGroup("issue", "Issue 文档", "issue", "Issue", "格式不限：md / txt / 工单导出文本 / issue 链接…")),
					h("div", { className: "field-row" },
						h("div", { className: "field" },
							h("span", { className: "f-label", id: "rg-review-label" }, "人工复核模式"),
							radioGroup("rg-review-label", [
								{ value: "every", label: "每阶段都停", hint: "默认" },
								{ value: "key-only", label: "只停关键门", hint: "规划/代码/Review/PR" },
								{ value: "auto", label: "全自动", hint: "事后可打回" },
							], form.reviewMode, function (v) { setField("reviewMode", v); }, "review")),
						h("div", { className: "field" },
							h("span", { className: "f-label", id: "rg-exec-label" }, "P6 代码优化执行模式"),
							radioGroup("rg-exec-label", [
								{ value: "builtin", label: "插件内多智能体", hint: "Planner/Coder/Reviewer 并行" },
								{ value: "session", label: "交给 DSH 会话", hint: "真 workflow + superpowers" },
							], form.p6Mode, function (v) { setField("p6Mode", v); }, "exec"))),
					h("div", { className: "field" },
						h("label", { className: "f-label", htmlFor: "f-test" }, "测试命令（可选，P8 使用）"),
						h("input", {
							className: "f-input mono", id: "f-test", value: form.testCommand,
							placeholder: "如 npm test / python -m pytest …",
							onChange: function (e) { setField("testCommand", e.target.value); },
						})),
					h("div", { style: { display: "flex", gap: 10, alignItems: "center" } },
						h("button", { type: "submit", className: "btn primary", disabled: saving }, "保存配置"),
						h("button", { type: "button", className: "btn", onClick: runFirst }, "▶ 用该项目发起 Run")),
					h("p", { className: "hint-line" },
						"配置写入 ", h("code", null, "…\\issue2pr\\projects\\" + (form.slug || "<slug>") + "\\project.json"),
						"（含 ", h("code", null, "repos"), " 与 ", h("code", null, "triggers"),
						" 两个数组，触发源分 需求/Issue 两类）；发起 Run 时自动读取触发文档文本进入 11 阶段流水线。")));
		}

		/* ================================================================
		 * 运行 tab
		 * ================================================================ */
		function RunsPanel(props) {
			const p = props;
			const [selStage, setSelStage] = React.useState(null);
			const [selArt, setSelArt] = React.useState(null);
			const [artText, setArtText] = React.useState(null);
			const [comment, setComment] = React.useState("");
			const [lastRev, setLastRev] = React.useState(null);
			const commentRef = React.useRef(null);
			const artRef = React.useRef(null);
			React.useEffect(function () { artRef.current = selArt; }, [selArt]);

			// run 切换：重置选择；流水线停住（待复核/失败/完成）时钉到 run.current（跟随推进）
			React.useEffect(function () {
				setSelArt(null); setArtText(null); setComment("");
				if (p.run) setSelStage(p.run.current || "P1");
				else setSelStage(null);
				// eslint-disable-next-line react-hooks/exhaustive-deps
			}, [p.runId]);
			React.useEffect(function () {
				if (!p.run) return;
				if (p.run.status === "awaiting_review" || p.run.status === "failed" || p.run.status === "completed") {
					setSelStage(p.run.current || null);
				} else if (!selStage) {
					setSelStage(p.run.current || null);
				}
				// eslint-disable-next-line react-hooks/exhaustive-deps
			}, [p.run && p.run.status, p.run && p.run.current, p.runId]);

			// 阶段产物文件列表（来自 run 产物树，按阶段产物根过滤）
			const listFiles = function (stageId) {
				const s = STAGES.find(function (x) { return x.id === stageId; });
				if (!s || !p.tree) return [];
				const root = s.art;
				return p.tree.filter(function (f) {
					return f.path === root || f.path.indexOf(root + "/") === 0;
				});
			};
			const files = listFiles(selStage);
			const filesKey = selStage + "|" + files.map(function (f) { return f.path; }).join(",");

			const fetchArt = function (path) {
				artRef.current = path;
				setArtText(null);
				apiGet("/projects/" + p.slug + "/runs/" + p.runId + "/artifact?path=" + encodeURIComponent(path))
					.then(function (r) {
						// 只采纳仍选中该产物时的响应（防乱序覆盖）
						if (artRef.current !== path) return;
						if (r && r.ok) setArtText(r.text);
						else p.toast((r && r.message) || "读取产物失败", "bad");
					})
					.catch(function (e) { p.toast("请求失败: " + e, "bad"); });
			};

			// 阶段或产物文件变化 → 自动选中第一个产物并读取
			React.useEffect(function () {
				if (!selStage || !p.runId) return;
				const fs = listFiles(selStage);
				if (!fs.length) { setSelArt(null); setArtText(null); return; }
				setSelArt(fs[0].path);
				fetchArt(fs[0].path);
				// eslint-disable-next-line react-hooks/exhaustive-deps
			}, [selStage, filesKey, p.runId]);

			// 最近的复核决定（reviews/*.json 按文件名倒序取最新）
			React.useEffect(function () {
				if (!p.tree || !p.runId) { setLastRev(null); return; }
				const revs = p.tree.filter(function (f) { return f.path.indexOf("reviews/") === 0; }).sort().reverse();
				if (!revs.length) { setLastRev(null); return; }
				apiGet("/projects/" + p.slug + "/runs/" + p.runId + "/artifact?path=" + encodeURIComponent(revs[0].path))
					.then(function (r) {
						if (r && r.ok) { try { setLastRev(JSON.parse(r.text)); } catch (e) { setLastRev(null); } }
					});
				// eslint-disable-next-line react-hooks/exhaustive-deps
			}, [p.tree, p.runId]);

			const review = function (decision) {
				if (!p.runId) return;
				if (decision === "reject" && !(comment || "").trim()) {
					p.toast("打回需要填写复核意见", "bad");
					if (commentRef.current) commentRef.current.focus();
					return;
				}
				apiPost("/projects/" + p.slug + "/runs/" + p.runId + "/review", { decision: decision, comment: comment })
					.then(function (r) {
						if (r && r.ok) {
							p.toast(r.message || (decision === "approve" ? "已通过" : "已打回"));
							setComment("");
							p.onChanged();
						} else {
							p.toast((r && r.message) || "复核提交失败", "bad");
						}
					})
					.catch(function (e) { p.toast("请求失败: " + e, "bad"); });
			};

			// —— 渲染 ——
			const runChip = p.run && RUN_CHIP[p.run.status] ? RUN_CHIP[p.run.status] : null;
			const options = (p.runs && p.runs.length ? p.runs : []).map(function (r) {
				const c = RUN_CHIP[r.status] || RUN_CHIP.pending;
				return h("option", { key: r.id, value: r.id },
					r.id + "（" + c[1] + " · 触发:" + kindLabel(r.trigger && r.trigger.kind) + "）");
			});
			if (!options.length) {
				options.push(h("option", { key: "__none__", value: "" }, "（暂无 Run，请先在「项目」tab 发起）"));
			}

			const sDef = STAGES.find(function (x) { return x.id === selStage; });
			const st = p.run && p.run.stages ? p.run.stages[selStage] : null;
			const stStatus = st ? st.status : null;

			let viewHtml = '<span class="c">选择一个阶段查看产物。</span>';
			if (!sDef) viewHtml = '<span class="c">选择一个阶段查看产物。</span>';
			else if (artText != null) viewHtml = renderView(artText, selArt);
			else if (selArt) viewHtml = '<span class="c">读取中…</span>';
			else if (!stStatus || stStatus === "pending") viewHtml = '<span class="c">该阶段尚未运行，暂无产物。</span>';
			else if (stStatus === "failed") viewHtml = '<span class="c">该阶段执行失败：' + esc(st.error || "未知错误") + "</span>";
			else viewHtml = '<span class="c">该阶段暂无文件产物（执行中或产物为目录）。</span>';

			const showReview = stStatus === "awaiting_review";
			const gateNote = "复核模式：" + (p.run ? reviewModeLabel(p.run.reviewMode) : "—")
				+ (lastRev ? " · 上一个决定：" + lastRev.stage + " " + (lastRev.decision === "approve" ? "通过" : "打回")
					+ "（" + fmtTime(lastRev.at) + "，" + (lastRev.comment ? "意见：" + lastRev.comment : "无意见") + "）" : "");

			return h("div", null,
				h("div", { className: "run-bar" },
					h("label", { className: "f-label", htmlFor: "run-select" }, "当前 Run"),
					h("select", {
						className: "f-select", id: "run-select", value: p.runId || "",
						onChange: function (e) { p.onPickRun(e.target.value); },
					}, options),
					runChip ? h("span", { className: "chip " + runChip[0] }, runChip[1]) : null),
				h("div", { className: "pipe-layout" },
					h("div", { className: "stage-list", "aria-label": "流水线阶段" },
						STAGES.map(function (s) {
							const cur = p.run && p.run.stages ? p.run.stages[s.id] : null;
							const status = cur ? cur.status : "pending";
							const chip = STAGE_CHIP[status] || STAGE_CHIP.pending;
							const extra = cur && cur.attempts ? " · 重试 " + cur.attempts + " 次" : "";
							return h("button", {
								key: s.id,
								className: "stage " + stageClass(status) + (s.id === selStage ? " on" : ""),
								onClick: function () { setSelStage(s.id); },
							},
								h("span", { className: "idx" }, s.id),
								h("span", null,
									h("span", { className: "s-name" }, s.name),
									h("br", null),
									h("span", { className: "s-desc" }, s.desc + " · " + s.art + extra)),
								h("span", { className: "chip " + chip[0] }, chip[1]));
						})),
					h("div", { className: "card" },
						h("div", { className: "detail-head" },
							h("div", null,
								h("h2", null, sDef ? sDef.id + " · " + sDef.name : "阶段详情"),
								h("div", { className: "path" },
									"产物：" + (p.runId ? "runs\\" + p.runId + "\\" + (sDef ? sDef.art.replace(/\//g, "\\") : "") : ""))),
							stStatus ? h("span", { className: "chip " + (STAGE_CHIP[stStatus] || STAGE_CHIP.pending)[0] },
								(STAGE_CHIP[stStatus] || STAGE_CHIP.pending)[1]) : null),
						files.length ? h("div", { className: "artifact-tabs" },
							files.map(function (f) {
								return h("button", {
									key: f.path,
									className: "a-tab" + (f.path === selArt ? " on" : ""),
									onClick: function () { setSelArt(f.path); fetchArt(f.path); },
								}, f.path.split("/").pop());
							})) : null,
						h("pre", { className: "view", tabIndex: 0, dangerouslySetInnerHTML: { __html: viewHtml } }),
						showReview ? h("div", { className: "review-box" },
							h("h3", null, "⏸ 人工复核门"),
							h("p", null,
								"该阶段产物已生成。通过后进入下一阶段；打回将把意见注入本阶段重跑。决定会带时间戳写入 ",
								h("span", { style: { fontFamily: "var(--mono)" } }, "reviews\\"),
								"。"),
							h("div", { className: "review-actions" },
								h("textarea", {
									className: "f-input", ref: commentRef, value: comment,
									placeholder: "复核意见（打回时必填，通过时可选）…", "aria-label": "复核意见",
									onChange: function (e) { setComment(e.target.value); },
								}),
								h("button", { className: "btn good", onClick: function () { review("approve"); } }, "✓ 通过，继续"),
								h("button", { className: "btn danger", onClick: function () { review("reject"); } }, "✗ 打回重跑")),
							h("div", { className: "gate-note" }, gateNote)) : null)));
		}

		/* ================================================================
		 * 产物 tab：文件树
		 * ================================================================ */
		function ArtifactsPanel(props) {
			const p = props;
			const [selFile, setSelFile] = React.useState(null);
			const [fileText, setFileText] = React.useState(null);
			const fileRef = React.useRef(null); // 竞态守卫：记录当前选中文件
			React.useEffect(function () { fileRef.current = selFile; }, [selFile]);

			React.useEffect(function () {
				setSelFile(null); setFileText(null);
			}, [p.runId]);

			if (!p.runId) {
				return h("p", { className: "empty-hint" },
					"请先在「项目」tab 发起 Run，或在「运行」tab 选择一个 Run，再查看其产物树。");
			}

			const pick = function (path) {
				fileRef.current = path;
				setSelFile(path); setFileText(null);
				apiGet("/projects/" + p.slug + "/runs/" + p.runId + "/artifact?path=" + encodeURIComponent(path))
					.then(function (r) {
						// 只采纳仍选中该文件时的响应（防乱序覆盖）
						if (fileRef.current !== path) return;
						if (r && r.ok) setFileText(r.text);
						else p.toast((r && r.message) || "读取产物失败", "bad");
					})
					.catch(function (e) { p.toast("请求失败: " + e, "bad"); });
			};

			const indentStyle = function (depth) { return depth ? { paddingLeft: 8 + 18 * depth } : null; };

			const renderNode = function (node, depth, out) {
				Object.keys(node.children).sort().forEach(function (k) {
					const c = node.children[k];
					out.push(h("div", { key: "d-" + depth + "-" + k, className: "dir", style: indentStyle(depth) }, "▸ " + k + "\\"));
					renderNode(c, depth + 1, out);
				});
				node.files.sort(function (a, b) { return a.path.localeCompare(b.path); }).forEach(function (f) {
					const on = selFile === f.path;
					out.push(h("button", {
						key: f.path,
						className: "file" + (on ? " on" : ""),
						style: indentStyle(depth),
						onClick: function () { pick(f.path); },
					},
						h("span", null, f.path.split("/").pop()),
						h("span", { className: "ts" }, "  " + fmtSize(f.size))));
				});
			};

			const root = { name: "", children: {}, files: [] };
			(p.tree || []).forEach(function (f) {
				const segs = f.path.split("/");
				let node = root;
				for (let i = 0; i < segs.length - 1; i++) {
					node = node.children[segs[i]] || (node.children[segs[i]] = { name: segs[i], children: {}, files: [] });
				}
				node.files.push(f);
			});
			const treeItems = [];
			renderNode(root, 0, treeItems);

			const viewHtml = fileText != null
				? renderView(fileText, selFile)
				: (selFile ? '<span class="c">读取中…</span>' : '<span class="c">点击左侧文件预览内容。</span>');

			return h("div", null,
				h("p", { className: "hint-line" }, "当前 Run：", h("code", null, p.runId), "（在「运行」tab 切换 Run；以下是该 Run 的完整产物目录）"),
				h("div", { className: "art-layout" },
					h("div", { className: "card" },
						p.tree && p.tree.length
							? h("div", { className: "tree", "aria-label": "产物目录树" }, treeItems)
							: h("p", { className: "empty-hint" }, "该 Run 暂无产物（可能尚未开始）。")),
					h("div", { className: "card" },
						h("div", { className: "detail-head" },
							h("div", null,
								h("h2", { style: { fontSize: 15 } }, selFile ? selFile.split("/").pop() : "产物预览"),
								h("div", { className: "path" },
									"~/.dsh/issue2pr/projects\\" + p.slug + "\\runs\\" + p.runId + (selFile ? "\\" + selFile.replace(/\//g, "\\") : ""))),
							h("button", {
								className: "btn sm",
								onClick: function () {
									p.toast("产物目录：~/.dsh/issue2pr/projects\\" + p.slug + "\\runs\\" + p.runId + "（v1 仅提示路径，不自动打开）");
								},
							}, "打开所在目录")),
						h("pre", { className: "view", tabIndex: 0, style: { maxHeight: 520 }, dangerouslySetInnerHTML: { __html: viewHtml } }))));
		}

		/* ================================================================
		 * 主 Section：三 tab 容器 + 共享数据 + 3s 轮询
		 * ================================================================ */
		function Section() {
			const [tab, setTab] = React.useState("projects");
			const [toast, setToast] = React.useState(null);
			const [projects, setProjects] = React.useState(null);
			const [selSlug, setSelSlug] = React.useState(null);
			const [runs, setRuns] = React.useState(null);
			const [selRunId, setSelRunId] = React.useState(null);
			const [run, setRun] = React.useState(null);
			const [tree, setTree] = React.useState(null);

			// 竞态守卫键：始终反映最新的 slug/runId，异步响应到达时比对，
			// 不匹配则丢弃（防止旧项目的 runs/run/tree 响应覆盖新选择）
			const ctxRef = React.useRef({ slug: null, runId: null });
			ctxRef.current.slug = selSlug;
			ctxRef.current.runId = selRunId;

			const toastFn = React.useCallback(function (msg, kind) {
				setToast({ msg: msg, kind: kind || "ok" });
			}, []);
			React.useEffect(function () {
				if (!toast) return;
				const t = setTimeout(function () { setToast(null); }, 2600);
				return function () { clearTimeout(t); };
			}, [toast]);

			// 项目列表（挂载 / 保存后）
			const loadProjects = React.useCallback(function () {
				apiGet("/projects").then(function (r) {
					if (r && r.ok) setProjects(r.projects);
					else toastFn((r && r.message) || "项目列表加载失败", "bad");
				}).catch(function (e) { toastFn("请求失败: " + e, "bad"); });
			}, [toastFn]);
			React.useEffect(function () { loadProjects(); }, [loadProjects]);

			// slug 变化 → 重置 run 选择并加载 runs 摘要
			React.useEffect(function () {
				setSelRunId(null); setRun(null); setTree(null);
				if (!selSlug) { setRuns(null); return; }
				const slug = selSlug;
				setRuns(null);
				apiGet("/projects/" + slug + "/runs").then(function (r) {
					if (!r || !r.ok) return;
					// 响应时用户已切到别的项目 → 丢弃旧项目的 runs 回填
					if (ctxRef.current.slug !== slug) return;
					setRuns(r.runs || []);
					// 函数式设置：若期间已显式选了 run（如刚发起的新 run），不覆盖
					setSelRunId(function (prev) {
						return prev || (r.runs && r.runs.length ? r.runs[0].id : null);
					});
				});
			}, [selSlug]);

			// run 详细 + 产物树（切换 run 时；stale 守卫防旧响应覆盖新选择）
			React.useEffect(function () {
				if (!selSlug || !selRunId) { setRun(null); setTree(null); return; }
				let stale = false;
				apiGet("/projects/" + selSlug + "/runs/" + selRunId).then(function (r) {
					if (stale) return;
					if (r && r.id) setRun(r);
					else if (r && r.ok === false) setRun(null);
				});
				apiGet("/projects/" + selSlug + "/runs/" + selRunId + "/tree").then(function (r) {
					if (!stale) setTree(r && r.ok ? r.files : null);
				});
				return function () { stale = true; };
			}, [selSlug, selRunId]);

			// 3s 轮询 run 摘要 / 详细 / 产物树（卸载时清理；响应按最新 slug/runId 守卫）
			React.useEffect(function () {
				if (!selSlug) return;
				const slug = selSlug, runId = selRunId;
				const timer = setInterval(function () {
					apiGet("/projects/" + slug + "/runs").then(function (r) {
						if (r && r.ok && ctxRef.current.slug === slug) setRuns(r.runs || []);
					});
					if (runId) {
						apiGet("/projects/" + slug + "/runs/" + runId).then(function (r) {
							if (r && r.id && ctxRef.current.slug === slug && ctxRef.current.runId === runId) setRun(r);
						});
						apiGet("/projects/" + slug + "/runs/" + runId + "/tree").then(function (r) {
							if (r && r.ok && ctxRef.current.slug === slug && ctxRef.current.runId === runId) setTree(r.files);
						});
					}
				}, 3000);
				return function () { clearInterval(timer); };
			}, [selSlug, selRunId]);

			// 复核等动作后立即刷新（不等轮询；响应同样按最新 slug/runId 守卫）
			const refreshNow = React.useCallback(function () {
				const slug = selSlug, runId = selRunId;
				if (slug) {
					apiGet("/projects/" + slug + "/runs").then(function (r) {
						if (r && r.ok && ctxRef.current.slug === slug) setRuns(r.runs || []);
					});
				}
				if (slug && runId) {
					apiGet("/projects/" + slug + "/runs/" + runId).then(function (r) {
						if (r && r.id && ctxRef.current.slug === slug && ctxRef.current.runId === runId) setRun(r);
					});
					apiGet("/projects/" + slug + "/runs/" + runId + "/tree").then(function (r) {
						if (r && r.ok && ctxRef.current.slug === slug && ctxRef.current.runId === runId) setTree(r.files);
					});
				}
			}, [selSlug, selRunId]);

			const onSaved = React.useCallback(function (slug) {
				setSelSlug(slug);
				loadProjects();
			}, [loadProjects]);

			const onRunStarted = React.useCallback(function (slug, runId) {
				setSelSlug(slug);
				setSelRunId(runId);
				setTab("runs");
				apiGet("/projects/" + slug + "/runs").then(function (r) {
					if (r && r.ok && ctxRef.current.slug === slug) setRuns(r.runs || []);
				});
			}, []);

			const awaitingCount = (runs || []).filter(function (r) { return r.status === "awaiting_review"; }).length;
			const runsCount = runs != null ? (awaitingCount > 0 ? awaitingCount + " 待复核" : String(runs.length)) : "";

			const tabDefs = [
				{ id: "projects", label: "项目", count: projects != null ? String(projects.length) : "" },
				{ id: "runs", label: "运行", count: runsCount },
				{ id: "artifacts", label: "产物", count: "" },
			];

			const tabKey = function (e, i) {
				if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
				e.preventDefault();
				const next = (i + (e.key === "ArrowRight" ? 1 : -1) + tabDefs.length) % tabDefs.length;
				tabDefs[next] && setTab(tabDefs[next].id);
			};

			const tabEls = tabDefs.map(function (t, i) {
				return h("button", {
					key: t.id, className: "tab", role: "tab",
					"aria-selected": tab === t.id ? "true" : "false",
					"aria-controls": "panel-" + t.id,
					onClick: function () { setTab(t.id); },
					onKeyDown: function (e) { tabKey(e, i); },
				}, t.label, t.count ? h("span", { className: "count" }, t.count) : null);
			});

			return h("div", { className: "i2p" },
				h("div", { className: "page" },
					h("header", { className: "top" },
						h("div", { className: "title-block" },
							h("h1", null,
								h("span", { className: "glyph" }, "i→P"),
								"Issue2PR"),
							h("p", null, "从一条 Issue 到一份可合并 PR 的可验证交付链 · 每阶段产物可审查，推进需人工复核")),
						h("span", { className: "env-badge" }, "DSH 插件 · ", h("b", null, "设置面板页"), " · Issue2PR v0.1")),
					h("div", { className: "tabs", role: "tablist", "aria-label": "主视图" }, tabEls),
					tab === "projects" ? h(ProjectsPanel, {
						projects: projects,
						slug: selSlug,
						toast: toastFn,
						onSelectProject: function (s) { setSelSlug(s); },
						onSaved: onSaved,
						onRunStarted: onRunStarted,
					}) : null,
					tab === "runs" ? h(RunsPanel, {
						slug: selSlug,
						runId: selRunId,
						runs: runs,
						run: run,
						tree: tree,
						toast: toastFn,
						onPickRun: function (id) { setSelRunId(id); },
						onChanged: refreshNow,
					}) : null,
					tab === "artifacts" ? h(ArtifactsPanel, {
						slug: selSlug,
						runId: selRunId,
						tree: tree,
						toast: toastFn,
					}) : null),
				toast ? h("div", {
					className: "toast show" + (toast.kind === "bad" ? " t-bad" : ""),
					role: "status", "aria-live": "polite",
				}, toast.msg) : null);
		}

		/* ================================================================
		 * apply：注册 settings.section（沿用占位实现）
		 * ================================================================ */
		function apply(ctx) {
			const t = ctx.locale.bind("issue2pr");
			ctx.effect(() => ctx.locale.register("issue2pr", { zh, en }), "issue2pr: dictionaries");
			ctx.slots.inject("settings.section", () => ctx.slots.register(
				{ name: "settings.section", id: "issue2pr", order: 17, label: () => t("nav"), locale: "issue2pr" }, Section));
		}
		exports.apply = apply;
		exports.inject = ["slots", "locale"];
		return module.exports;
	}
});