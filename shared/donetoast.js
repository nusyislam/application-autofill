// Application Autofill: the "Done" toast. One self-contained function (globalThis.AAF_DONE_TOAST), used
// three ways:
//   - by the content scripts (shared/main.js) on an ordinary page, and as the fallback inside an iframe;
//   - by background.js, which injects exactly this function into the TOP frame of a tab whose form is an
//     embedded iframe (Greenhouse / Lever / Gem / iCIMS on a company site), with chrome.scripting and the
//     activeTab grant from the popup / Alt+Shift+F. Nothing else is ever injected into the top page.
// It must not use anything outside itself (chrome.scripting serializes the function).
//
// data: { filled, kept, needs, blue, drafts, aiError, site }
// opts: { local }  "need you" scrolls this document to the first yellow field (else it asks the background
//                  to scroll the frame that filled);
//       { frame }  inside an iframe: placed in the part of the iframe that is visible on screen (an embedded
//                  form's iframe is as tall as the form, so a fixed toast would sit far below the fold).
// Stays about 10 s, or until closed.

(() => {
  if (globalThis.AAF_DONE_TOAST) return;
  globalThis.AAF_DONE_TOAST = function showDoneToast(data, opts = {}) {
    const ID = "aaf-done-toast";
    document.getElementById(ID)?.remove();
    document.getElementById("aaf-progress")?.remove(); // the "Autofilling…" panel gives way to this toast
    const host = document.createElement("div");
    host.id = ID;
    host.style.cssText = "position:fixed;top:16px;right:16px;z-index:2147483647;";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>
        .box{font:13px/1.45 system-ui,sans-serif;max-width:300px;background:#fff;color:#111827;border:1px solid #e5e7eb;border-radius:10px;padding:10px 30px 10px 12px;box-shadow:0 6px 18px rgba(0,0,0,.18);position:relative}
        .x{all:unset;position:absolute;top:6px;right:8px;cursor:pointer;color:#6b7280;font-size:15px;line-height:1}
        .dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px;vertical-align:middle}
        .needs{cursor:pointer;text-decoration:underline}
        .mut{color:#6b7280}
      </style>
      <div class="box"><button class="x" title="Close">&times;</button></div>`;
    const box = root.querySelector(".box");
    const line = (text, color, cls) => {
      const d = document.createElement("div");
      if (color) {
        const dot = document.createElement("span");
        dot.className = "dot";
        dot.style.background = color;
        d.appendChild(dot);
      }
      const t = document.createElement("span");
      t.textContent = text;
      if (cls) t.className = cls;
      d.appendChild(t);
      box.appendChild(d);
      return t;
    };
    const n = (v) => Number(v) || 0;
    const head = document.createElement("div");
    const b = document.createElement("b");
    b.textContent = data.stopped ? "Stopped." : "Done.";
    head.append(b, ` Filled ${n(data.filled)}, kept ${n(data.kept)} (already correct).`);
    box.appendChild(head);
    if (data.aiError) line(`Claude error: ${data.aiError}`);
    if (n(data.honesty)) line(`${n(data.honesty)} question${n(data.honesty) === 1 ? "" : "s"} about using AI / tools on this application (red): answer yourself`, "#dc2626");
    if (n(data.traps)) line(`${n(data.traps)} possible AI-detection trap${n(data.traps) === 1 ? "" : "s"} (red): leave blank`, "#dc2626");
    if (data.note) line(data.note, "#f59e0b");
    const needs = line(`${n(data.needs)} need you (yellow)`, "#f59e0b", n(data.needs) ? "needs" : "");
    if (n(data.blue)) line(`${n(data.blue)} to double-check (blue)`, "#3b82f6");
    line(`${n(data.drafts)} draft${n(data.drafts) === 1 ? "" : "s"} to review`);
    line("Review, then continue / submit yourself.", null, "mut");
    // An adapter's follow-up action (YC: "Redraft note"), only where the content script shows the toast itself.
    if (data.action && typeof opts.onAction === "function") {
      const b2 = document.createElement("button");
      b2.textContent = data.action;
      b2.style.cssText = "all:unset;cursor:pointer;margin-top:6px;background:#111827;color:#fff;padding:4px 10px;border-radius:999px;font-weight:600;display:inline-block";
      b2.addEventListener("click", () => {
        host.remove();
        opts.onAction();
      });
      box.appendChild(b2);
    }
    if (n(data.needs)) {
      needs.title = "Scroll to the first field that needs you";
      needs.addEventListener("click", () => {
        if (opts.local) document.querySelector('[data-wdaf="needs"]')?.scrollIntoView({ block: "center" });
        else
          try {
            chrome.runtime.sendMessage({ type: "SCROLL_NEEDS" });
          } catch {}
      });
    }
    let io = null;
    let marks = null;
    const close = () => {
      io?.disconnect();
      marks?.remove();
      host.remove();
    };
    root.querySelector(".x").addEventListener("click", close);
    setTimeout(close, data.action || data.note || n(data.traps) || n(data.honesty) ? 30000 : 10000);
    (document.body || document.documentElement).appendChild(host);
    // Inside an iframe: the part of the frame that is on screen. An iframe can't read the page's scroll
    // position, but IntersectionObserver reports its elements against the top-level viewport, so a column
    // of invisible 1px markers (one every 100 px) tells which band of this document is visible; the toast
    // sits near the top of that band and follows it as the page scrolls.
    if (opts.frame && typeof IntersectionObserver === "function") {
      host.style.position = "absolute";
      host.style.top = `${Math.round((document.scrollingElement || document.documentElement).scrollTop + 16)}px`;
      const docH = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0);
      marks = document.createElement("div");
      marks.setAttribute("aria-hidden", "true");
      marks.style.cssText = "position:absolute;left:0;top:0;width:1px;height:0;pointer-events:none;visibility:hidden;";
      const seen = new Set();
      for (let y = 0; y < docH; y += 100) {
        const m = document.createElement("div");
        m.style.cssText = `position:absolute;left:0;top:${y}px;width:1px;height:1px;`;
        m.dataset.y = String(y);
        marks.appendChild(m);
      }
      (document.body || document.documentElement).appendChild(marks);
      io = new IntersectionObserver((entries) => {
        for (const e of entries) (e.isIntersecting ? seen.add : seen.delete).call(seen, Number(e.target.dataset.y));
        if (!seen.size) return;
        const top = Math.min(...seen);
        host.style.top = `${top + 16}px`;
      });
      for (const m of marks.children) io.observe(m);
    }
    return true;
  };

  // The "Autofilling… <step>" panel with a Stop button, shown while a fill runs, in the toast's spot (top
  // right). Self-contained like the toast: background.js injects exactly this function into the TOP frame of
  // an embedded form's tab. data: { step } (update) | { done: true } (remove). opts: { onStop } (the content
  // script's own stop; without it, Stop asks the background, which stops the fill in every frame of the
  // tab); { frame } (inside an iframe: in the part of the frame that's on screen, like the toast).
  globalThis.AAF_PROGRESS_PANEL = function progressPanel(data, opts = {}) {
    const ID = "aaf-progress";
    let host = document.getElementById(ID);
    if (data && data.done) {
      if (host) {
        host.__aafIO?.disconnect();
        host.__aafMarks?.remove();
        host.remove();
      }
      return true;
    }
    if (!host) {
      host = document.createElement("div");
      host.id = ID;
      host.style.cssText = "position:fixed;top:16px;right:16px;z-index:2147483647;";
      const root = host.attachShadow({ mode: "open" });
      root.innerHTML = `
        <style>
          .box{font:13px/1.45 system-ui,sans-serif;display:flex;align-items:center;gap:10px;max-width:320px;background:#fff;color:#111827;border:1px solid #e5e7eb;border-radius:10px;padding:8px 10px 8px 12px;box-shadow:0 6px 18px rgba(0,0,0,.18)}
          .spin{width:10px;height:10px;border-radius:50%;border:2px solid #93c5fd;border-top-color:#2563eb;animation:r .9s linear infinite;flex:none}
          @keyframes r{to{transform:rotate(360deg)}}
          .t{flex:1;min-width:0}
          .step{color:#6b7280;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
          .note{color:#c2410c;font-size:12px}
          button{all:unset;cursor:pointer;background:#111827;color:#fff;padding:5px 10px;border-radius:999px;font-weight:600;flex:none}
          button[disabled]{opacity:.6;cursor:default}
        </style>
        <div class="box"><span class="spin"></span><div class="t"><b>Autofilling…</b> <span class="step"></span><div class="note"></div></div><button class="stop" title="Stop the autofill (fields already filled stay as they are)">Stop</button></div>`;
      const stop = root.querySelector(".stop");
      stop.addEventListener("click", () => {
        stop.disabled = true;
        stop.textContent = "Stopping…";
        if (typeof host.__aafStop === "function") host.__aafStop();
        else
          try {
            chrome.runtime.sendMessage({ type: "STOP_FILL" });
          } catch {}
      });
      (document.body || document.documentElement).appendChild(host);
      if (opts.frame && typeof IntersectionObserver === "function") {
        host.style.position = "absolute";
        host.style.top = `${Math.round((document.scrollingElement || document.documentElement).scrollTop + 16)}px`;
        const docH = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0);
        const marks = document.createElement("div");
        marks.setAttribute("aria-hidden", "true");
        marks.style.cssText = "position:absolute;left:0;top:0;width:1px;height:0;pointer-events:none;visibility:hidden;";
        const seen = new Set();
        for (let y = 0; y < docH; y += 100) {
          const m = document.createElement("div");
          m.style.cssText = `position:absolute;left:0;top:${y}px;width:1px;height:1px;`;
          m.dataset.y = String(y);
          marks.appendChild(m);
        }
        (document.body || document.documentElement).appendChild(marks);
        const io = new IntersectionObserver((entries) => {
          for (const e of entries) (e.isIntersecting ? seen.add : seen.delete).call(seen, Number(e.target.dataset.y));
          if (seen.size) host.style.top = `${Math.min(...seen) + 16}px`;
        });
        for (const m of marks.children) io.observe(m);
        host.__aafIO = io;
        host.__aafMarks = marks;
      }
    }
    if (opts.onStop) host.__aafStop = opts.onStop;
    host.shadowRoot.querySelector(".step").textContent = (data && data.step) || "";
    host.shadowRoot.querySelector(".note").textContent = (data && data.note) || "";
    return true;
  };
})();
