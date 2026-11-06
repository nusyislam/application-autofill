// Application Autofill: shared floating "Autofill page" button and toast.

(() => {
  const AAF = globalThis.AAF;
  if (!AAF.once("ui")) return;

  // Inside an iframe (a Greenhouse form embedded on a company career page) the frame is as tall as the
  // whole form, so a fixed button would sit off-screen. There the panel is never shown; the popup's
  // "Fill this page" and the keyboard shortcut (Alt+Shift+F) fill the frame instead, and the toolbar
  // badge shows progress.
  const inFrame = window.top !== window;

  // ------------------------------------------------------ floating panel
  let ui;
  function ensureUI() {
    if (ui) return ui;
    const host = document.createElement("div");
    host.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483647;";
    if (inFrame) host.style.display = "none";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>
        .wrap{font:13px/1.4 system-ui,sans-serif;display:flex;flex-direction:column;align-items:flex-end;gap:8px}
        button{all:unset;cursor:pointer;background:#111827;color:#fff;padding:10px 14px;border-radius:999px;font-weight:600;box-shadow:0 4px 14px rgba(0,0,0,.25)}
        button:hover{background:#1f2937}
        button[disabled]{opacity:.6;cursor:default}
        .toast{display:none;max-width:280px;background:#fff;color:#111827;border:1px solid #e5e7eb;border-radius:10px;padding:10px 12px;box-shadow:0 4px 14px rgba(0,0,0,.15)}
        .dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px;vertical-align:middle}
      </style>
      <div class="wrap"><div class="toast"></div><button>Autofill page</button></div>`;
    document.documentElement.appendChild(host);
    const btn = root.querySelector("button");
    btn.addEventListener("click", () => AAF.fillPage({ fromButton: true }));
    ui = { host, btn, toast: root.querySelector(".toast") };
    return ui;
  }
  function toast(html, ms) {
    const u = ensureUI();
    u.toast.innerHTML = html;
    u.toast.style.display = "block";
    clearTimeout(u._t);
    if (ms) u._t = setTimeout(() => (u.toast.style.display = "none"), ms);
  }
  // Show the button only on form pages (the adapter decides what a form page is), never in an iframe.
  function showButton(isForm) {
    if (inFrame) return;
    if (isForm) ensureUI().host.style.display = "";
    else if (ui) ui.host.style.display = "none";
  }
  // True for elements inside our own floating panel (never typed into or treated as page fields).
  const isOwnUI = (el) => !!ui?.host.contains(el);

  // The progress toast ("Filling…") goes away when the Done toast (shared/donetoast.js) appears.
  const hideToast = () => {
    if (ui) ui.toast.style.display = "none";
  };
  Object.assign(AAF, { ensureUI, toast, hideToast, showButton, isOwnUI });
})();
