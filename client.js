// client.js — 占位页（Task 11 替换为完整三 tab UI）
window.__ModuleLoader__.load({
  id: "dsh-issue2pr",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    const React = require("react");
    const h = React.createElement;
    const zh = { nav: "Issue2PR" };
    const en = { nav: "Issue2PR" };
    function Section() {
      return h("div", { style: { maxWidth: 860, fontSize: 14 } },
        h("h2", null, "Issue2PR"),
        h("p", null, "插件骨架已加载。完整 UI 在后续任务提供。"));
    }
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