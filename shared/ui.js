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
    // A press on the button never reaches the page: a dialog that closes on any pointerdown outside it (YC Work at
    // a Startup's Radix Apply dialog) closed itself when the button was clicked, leaving nothing to fill. Every
    // portal; the click itself still runs the fill.
    for (const type of ["pointerdown", "mousedown", "touchstart"]) host.addEventListener(type, (e) => e.stopPropagation());
    const btn = root.querySelector("button");
    btn.addEventListener("click", () => AAF.fillPage({ fromButton: true }));
    ui = { host, btn, toast: root.querySelector(".toast") };
    return ui;
  }
  // Where the button sits: floating at the bottom right (the default), or inside an element the adapter names
  // (`buttonSpot()`: { parent, before }), so a click on it counts as inside that element (YC's Apply dialog). It
  // goes back to floating when the spot is gone (the dialog closed and took the button with it).
  const FLOAT = "position:fixed;right:16px;bottom:16px;z-index:2147483647;";
  const INLINE = "position:static;display:inline-flex;align-self:center;margin:0 8px 0 0;z-index:auto;";
  function placeButton(spot) {
    const u = ensureUI();
    if (spot?.parent?.isConnected) {
      const before = spot.before?.parentElement === spot.parent ? spot.before : null;
      if (u.host.parentElement !== spot.parent || (before && u.host.nextSibling !== before)) {
        spot.parent.insertBefore(u.host, before);
        u.host.dataset.aafSpot = "inline";
        AAF.dbg?.("Autofill button placed inside the open dialog (a click there counts as inside it)");
      }
      if (u.host.style.position !== "static") u.host.style.cssText = INLINE + (u.host.style.display === "none" ? "display:none;" : "");
    } else if (u.host.parentElement !== document.documentElement) {
      const hidden = u.host.style.display === "none";
      document.documentElement.appendChild(u.host);
      u.host.style.cssText = FLOAT + (hidden ? "display:none;" : "");
      delete u.host.dataset.aafSpot;
    }
  }
  function toast(html, ms) {
    const u = ensureUI();
    u.toast.innerHTML = html;
    u.toast.style.display = "block";
    clearTimeout(u._t);
    if (ms) u._t = setTimeout(() => (u.toast.style.display = "none"), ms);
  }
  // Show the button only on form pages (the adapter decides what a form page is), never in an iframe.
  function showButton(isForm, spot = null) {
    if (inFrame) return;
    if (isForm || ui) placeButton(isForm ? spot : null);
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
