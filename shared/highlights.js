// Application Autofill: shared field highlights (blue = auto-filled, double-check; yellow = needs you;
// red = possible AI-detection trap, leave it blank).

(() => {
  const AAF = globalThis.AAF;
  if (!AAF.once("highlights")) return;

  // ------------------------------------------------------------ highlights
  const COLORS = { needs: "#f59e0b", ai: "#3b82f6", review: "#3b82f6", trap: "#dc2626", honesty: "#dc2626" };
  const TITLES = {
    needs: "Application Autofill: answer this one yourself",
    trap: "Application Autofill: possible AI-detection trap, leave it blank",
    honesty: "Application Autofill: a question about using AI / tools on this application, answer it yourself",
  };
  function mark(f, kind) {
    AAF.handled?.(f);
    const c = f.c;
    c.dataset.wdaf = kind;
    c.style.outline = `2px solid ${COLORS[kind]}`;
    c.style.outlineOffset = "4px";
    c.style.borderRadius = "6px";
    c.title = TITLES[kind] || "Application Autofill: filled automatically, double-check it";
  }
  function unmark(c) {
    delete c.dataset.wdaf;
    c.style.outline = "";
    c.style.outlineOffset = "";
    c.title = "";
  }
  const clearMarks = () => document.querySelectorAll("[data-wdaf]").forEach(unmark);

  Object.assign(AAF, { mark, unmark, clearMarks });
})();
