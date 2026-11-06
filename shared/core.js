// Application Autofill: shared core. Loaded first.
// All content-script files share one namespace object, globalThis.AAF, in the extension's isolated
// world. Each file is an IIFE that reads what it needs from AAF and adds its own exports. Load order
// (manifest content_scripts): shared/core, dom, matching, highlights, ui, profile, learning, then the
// portal adapters (adapters/*.js), then shared/main (picks the adapter and runs everything).

(() => {
  const AAF = (globalThis.AAF ??= { _loaded: new Set(), adapters: {} });
  // Re-injection guard: the popup injects the files if the tab was open before the extension loaded.
  AAF.once = (name) => (AAF._loaded.has(name) ? false : (AAF._loaded.add(name), true));
  if (!AAF.once("core")) return;

  // ---------------------------------------------------------------- utils
  // Logs every field attempt to the page console (filter by "[autofill]"). Set false to silence.
  const DEBUG = true;
  const dbg = (...a) => DEBUG && console.log("[autofill]", ...a);
  // Readable values for log lines: the console collapses arrays/objects to "Array(3)" / "Object".
  // Ordered steps ({ steps: [[alts], ...] }) print as "steps: A > B | C".
  const show = (v) =>
    Array.isArray(v) ? "[" + v.map(show).join(", ") + "]"
    : v && typeof v === "object"
      ? Array.isArray(v.steps) ? (v.search ? `search "${v.search}", ` : "") + "steps: " + v.steps.map((s) => s.join(" | ")).join(" > ")
        : typeof v.choose === "function" ? `best option (${v.what || "ranked"})`
        : JSON.stringify(v)
    : String(v);
  // ---- Waiting in background tabs. Every wait in the content scripts goes through sleep() (waitFor
  // polls with it). Chrome throttles timers in hidden tabs (one wake-up per second, about one per
  // minute after 5 minutes), so a fill stalled whenever the user switched tabs.
  //   - delay(): visible tab = setTimeout. Hidden tab = the extension's background worker answers a
  //     "WAKE" message after `ms` (its timers don't depend on this tab's visibility, and the answer is a
  //     message, not a timer), raced with setTimeout as a fallback. A MessageChannel can only yield, not
  //     wait, so delays use the worker; at least 4 ms, so nothing busy-loops.
  //   - Steps that need the page in front (dropdown / listbox popups, react-select menus, search boxes)
  //     run inside focusStep(): their sleeps first wait until the tab is visible (and, in the top frame,
  //     the window focused again after a blur during the fill), log "paused: ..." / "resumed after N ms",
  //     and stop the clock meanwhile. Text, checkboxes, radios and uploads keep running while hidden.
  //   - now(): a clock that stops while paused; timeouts and "long wait" budgets use it, so time in
  //     another tab never counts toward a timeout or a not-found.
  //   - Never calls window.focus() or steals focus back.
  const inFrame = (() => {
    try {
      return window.top !== window;
    } catch {
      return true;
    }
  })();
  const pause = { total: 0, since: 0, blurred: false, depth: 0, what: [], filling: false };
  // A window blur DURING a fill pauses focus steps (top frame only: an embedded form's frame blurs
  // whenever the user clicks the surrounding page). A fill started from the toolbar popup or with
  // DevTools focused begins unfocused without any event, and isn't paused for that.
  window.addEventListener("blur", () => {
    if (pause.filling && !inFrame) pause.blurred = true;
  });
  window.addEventListener("focus", () => (pause.blurred = false));
  const isActive = () => !document.hidden && !pause.blurred;
  const now = () => Date.now() - pause.total - (pause.since ? Date.now() - pause.since : 0);
  function delay(ms) {
    ms = Math.max(4, ms || 0);
    if (!document.hidden) return new Promise((r) => setTimeout(r, ms));
    return new Promise((resolve) => {
      let done = false;
      const fin = () => {
        if (!done) {
          done = true;
          resolve();
        }
      };
      setTimeout(fin, ms);
      try {
        if (chrome.runtime?.id) chrome.runtime.sendMessage({ type: "WAKE", ms }).then(fin, fin);
      } catch {}
    });
  }
  function notifyPause(paused) {
    try {
      if (chrome.runtime?.id) chrome.runtime.sendMessage({ type: "PAUSED", paused }).catch(() => {});
    } catch {}
    AAF.toast?.(paused ? "Paused, click back to continue" : "Filling…");
  }
  async function waitActive() {
    if (isActive()) return;
    const what = pause.what[pause.what.length - 1] || "step";
    dbg(`paused: ${document.hidden ? "tab hidden" : "window unfocused"} (${what})`);
    pause.since = Date.now();
    notifyPause(true);
    await new Promise((resolve) => {
      const check = () => {
        // A stop while paused (the tab hidden or the window unfocused) still ends the run.
        if (!isActive() && !cancel.reason) return;
        document.removeEventListener("visibilitychange", check);
        window.removeEventListener("focus", check);
        clearInterval(iv);
        resolve();
      };
      document.addEventListener("visibilitychange", check);
      window.addEventListener("focus", check);
      const iv = setInterval(check, 2000); // in case an event is missed
    });
    const d = Date.now() - pause.since;
    pause.total += d;
    pause.since = 0;
    dbg(`resumed after ${d} ms (${what})`);
    notifyPause(false);
  }
  // Cancelling a fill (shared/main.js: the page / step changed, or a new fill started). Every wait goes
  // through sleep(), so the run stops at its next wait, wherever it is (a Workday skills retry from the
  // previous step kept going for 89 skills after the page had changed).
  class Cancelled extends Error {}
  const cancel = { reason: "" };
  async function sleep(ms) {
    if (cancel.reason) throw new Cancelled(cancel.reason);
    if (pause.depth > 0) await waitActive();
    await delay(ms);
    if (cancel.reason) throw new Cancelled(cancel.reason);
  }
  // Runs fn as a step that needs the page in front (see above); nests.
  async function focusStep(what, fn) {
    pause.depth++;
    pause.what.push(what);
    try {
      await waitActive();
      return await fn();
    } finally {
      pause.depth--;
      pause.what.pop();
    }
  }
  // Wraps an async function as a focus step: setMulti = focused("search box", setMulti).
  // `needs(...args)` (optional) decides per call: a radio group or native select handled by the same
  // function needs no focus and keeps running.
  const focused = (what, fn, needs = null) => (...args) => (!needs || needs(...args) ? focusStep(what, () => fn(...args)) : fn(...args));
  // Fill bookkeeping for main.js: start / end, and the paused time.
  const fillClock = {
    start() {
      pause.filling = true;
      pause.blurred = false;
      pause.total = 0;
      return Date.now();
    },
    end() {
      pause.filling = false;
      return pause.total;
    },
  };
  const norm = (s) =>
    (s || "")
      .normalize("NFKC") // folds ligatures: Lexidos labels contain "ofﬁcials" with U+FB01
      .replace(/[\u200B-\u200D\u2060\uFEFF\u00AD]/g, "") // zero-width / soft hyphen: iCIMS HMSY's "V\u200Bendor" became "v endor"
      .toLowerCase()
      .replace(/[’']/g, "")
      .replace(/[^a-z0-9+#]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  const visible = (el) => !!el && el.getClientRects().length > 0;
  const SKIP = Symbol("skip");

  async function waitFor(fn, timeout = 3000, step = 100) {
    const end = now() + timeout;
    while (now() < end) {
      const v = fn();
      if (v) return v;
      await sleep(step);
    }
    return null;
  }

  const checkboxOn = (v) => v === true || /^(yes|true|checked)$/i.test(String(v));

  function parseDate(v) {
    // M/D/YYYY, MM/DD/YYYY, MM/YYYY, M/YYYY, YYYY, or YYYY-MM(-DD). setDate fills whichever of the
    // Month / Day / Year boxes the form has, so a full date still works on a month/year-only field.
    const s = String(v || "").trim();
    let m;
    if ((m = s.match(/^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?$/))) return { month: m[2], day: m[3], year: m[1] };
    if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) return { month: m[1], day: m[2], year: m[3] };
    if ((m = s.match(/^(\d{1,2})\/(\d{4})$/))) return { month: m[1], year: m[2] };
    if ((m = s.match(/^(\d{4})$/))) return { year: m[1] };
    return {};
  }

  const splitAlts = (s) => String(s || "").split(/\s*\|\s*/).map((t) => t.replace(/^\s*\d+[).]\s*/, "").trim()).filter(Boolean);

  // Every field fill goes through here for the log line; the adapter's setField does the work.
  // The fill's tally (reset by main.js per run): fields filled and fields kept (already correct), each
  // counted once by its container, however many paths touched it (retry pass, verification sweep).
  // `extra`: fills that aren't one field each (Workday skills chips).
  // `handled`: every field some step decided this run (a fill attempt, a kept value, an outline, a logged skip),
  // by container and by type + label; main.js's final check logs any field without one ("unhandled field").
  AAF.run = { filled: new Set(), kept: new Set(), extra: 0, handled: new Set(), noMatch: new Set() };
  const keyOf = (f) => (f && typeof f === "object" && "c" in f ? f.c : f);
  AAF.handled = (f) => {
    if (!f || typeof f !== "object" || !AAF.run.handled) return;
    if (f.c) AAF.run.handled.add(f.c);
    if (f.label != null && f.type) AAF.run.handled.add(`${f.type}|${f.nl ?? norm(f.label)}`);
  };
  AAF.countFill = (f) => {
    const k = keyOf(f);
    AAF.run.kept.delete(k);
    AAF.run.filled.add(k);
    AAF.handled(f);
  };
  AAF.countKept = (f) => {
    const k = keyOf(f);
    if (!AAF.run.filled.has(k)) AAF.run.kept.add(k);
    AAF.handled(f);
  };
  // What this extension wrote in this tab (sessionStorage, per page; field type + label -> the value it showed after the
  // fill, and whether it was a draft). A rerun reads it: a field still holding our own earlier answer is never "you
  // entered" (Notional's second fill left the export-control question yellow as if you'd typed it: our own label click
  // had fired a trusted event), and a field still holding our earlier draft is "kept (earlier draft)", not unhandled.
  const OURS = "aaf-ours";
  const oursKey = (f) => `${location.host}${location.pathname}|${f.type}|${f.nl ?? norm(f.label || "")}`;
  const oursAll = () => {
    try {
      return JSON.parse(sessionStorage.getItem(OURS) || "{}");
    } catch {
      return {};
    }
  };
  AAF.noteOurs = (f, extra = {}) => {
    try {
      const v = norm(String(AAF.adapter?.currentValue?.(f) ?? f.picked ?? ""));
      if (!v) return;
      const all = oursAll();
      all[oursKey(f)] = { v, ...extra, at: Date.now() };
      const keys = Object.keys(all);
      if (keys.length > 500) keys.sort((a, b) => all[a].at - all[b].at).slice(0, keys.length - 500).forEach((k) => delete all[k]);
      sessionStorage.setItem(OURS, JSON.stringify(all));
    } catch {}
  };
  // The record for this field when it still shows what we wrote, else null.
  AAF.ours = (f) => {
    const r = oursAll()[oursKey(f)];
    if (!r) return null;
    const cur = norm(String(AAF.adapter?.currentValue?.(f) ?? ""));
    return cur && cur === r.v ? r : null;
  };
  async function setField(f, v) {
    AAF.handled(f);
    if (v == null || v === "") {
      dbg("skip", `[${f.type}]`, f.label || f.id, "skipped (blank in profile)");
      return false;
    }
    // Turned off on the form (disabled / read-only: End Date after "Still Student?"): never filled or refilled.
    if (AAF.adapter.isDisabled?.(f)) {
      dbg("skip", `[${f.type}]`, f.label || f.id, "skipped (turned off on the form: disabled / read-only)");
      f.offForm = true;
      return false;
    }
    let ok = false;
    const t0 = now();
    // Adapters record the option / text they actually selected in f.picked, so the log shows
    // "<- No" rather than the whole fallback list "<- [No, I have not, I have never, Never]".
    f.picked = undefined;
    f.keptOnly = false;
    f.held = false;
    try {
      // A preference question ({ prefMap: { areas, what } }, shared/prefmap.js): this form's options mapped to the
      // areas you checked in Options, then selected like any other value (check all / the first in your order).
      if (v && typeof v === "object" && v.prefMap) {
        const texts = AAF.adapter.readOptions ? (await AAF.adapter.readOptions(f)) || [] : [];
        const picks = AAF.mapPreferences ? await AAF.mapPreferences(f, v.prefMap, texts) : [];
        const what = v.prefMap.what || "preference";
        if (!picks.length) {
          dbg(`${what}: no option matches your areas, left for you`);
          return false;
        }
        v = f.type === "checkgroup" ? { checkAll: picks, what } : { steps: picks.map((x) => [x]), exact: true, what };
      }
      ok = await AAF.adapter.setField(f, v);
      // A fixed "Yes" the options can't take (no Yes option): the option that means yes for your profile
      // (shared/profile.js yesOption: your country, "I am a U.S. person"), logged with the reason; none =
      // logged and left for you (FAIL, the retry pass marks it yellow).
      if (!ok && f.yesAlt && v === (f.yesAlt.for || "Yes") && AAF.adapter.readOptions) {
        const texts = (await AAF.adapter.readOptions(f)) || [];
        const hit = f.yesAlt.choose(texts);
        dbg(`${f.yesAlt.what}: no "${v}" option; options ${show(texts)} -> ${hit ? `"${hit.text}" (${hit.why})` : `none clearly means ${v.toLowerCase()}, left for you`}`);
        if (hit) ok = await AAF.adapter.setField(f, hit.text);
      }
      // Any other meaning a choice field couldn't take literally ("Yes" / "No" / "None" / "N/A" from any rule, or the
      // classifier): the shared meaning mapper (shared/prefmap.js mapMeaning: synonyms, then Haiku among the options).
      // Logged as meaning -> option, not as a failure of the literal text.
      // Also after a field's own chooser found nothing ("Authorized - US citizen" has no country in it); Haiku returns
      // none when no option says the meaning (a country list for "yes"). Not when an option has the literal text (then
      // the fill failed for another reason: a popup, a re-render).
      if (!ok && typeof v === "string" && /^(yes|no|none|n\/?a)$/i.test(v) && ["radio", "dropdown", "checkgroup"].includes(f.type) && AAF.mapMeaning && AAF.adapter.readOptions && !f.held) {
        const texts = (await AAF.adapter.readOptions(f)) || [];
        const literal = texts.some((t) => norm(t) === norm(v));
        // The rule's specific meaning goes with it ("the applicant lives in New York City today (not relocating)"), and an
        // option contradicting it (a relocation option for "you live there") is rejected: left for you (Kestrel).
        const alt = f.yesAlt && v === (f.yesAlt.for || "Yes") ? f.yesAlt : null;
        let hit = literal ? null : await AAF.mapMeaning(f, { meaning: v, what: "meaning", detail: alt?.detail || "" }, texts);
        if (hit && alt?.not && alt.not.test(norm(hit.text))) {
          dbg(`meaning "${v.toLowerCase()}" (${alt.detail}): "${hit.text}" (${hit.why}) contradicts it; rejected, left for you: ${(f.label || "").slice(0, 60)}`);
          hit = null;
        } else if (!literal) dbg(`meaning "${v.toLowerCase()}": options ${show(texts)} -> ${hit ? `"${hit.text}" (${hit.why})` : "none expresses it, left for you"}: ${(f.label || "").slice(0, 60)}`);
        if (hit) ok = await AAF.adapter.setField(f, hit.text);
        // The same options would be mapped the same way (and Claude asked again): the retry pass skips it.
        else if (texts.length) AAF.run.noMatch?.add(`${f.type}|${f.nl}`);
      }
      // Counted here, where the "ok" line is logged. A prefilled value the adapter kept (it matched the
      // profile) is "kept", not "filled".
      if (ok) (f.keptOnly ? AAF.countKept : AAF.countFill)(f);
      // Remembered for the final verification sweep (shared/main.js): the field, what was asked, and
      // what the adapter says it selected.
      if (ok) AAF.filledThisRun?.push({ f, v, picked: f.picked });
      if (ok) AAF.noteOurs(f);
      return ok;
    } finally {
      dbg(ok ? "ok  " : f.held ? "held" : "FAIL", `[${f.type}]`, f.label || f.id, "<-", ok && f.picked != null ? String(f.picked) : show(v), `(${now() - t0} ms)`);
    }
  }
  // Timing for fills that don't go through setField (school, degree, languages, skills).
  async function timed(what, fn) {
    const t0 = now();
    const r = await fn();
    dbg(`${what} (${now() - t0} ms)`);
    return r;
  }

  // After the extension is reloaded or updated, content scripts already on the page are orphaned:
  // chrome.runtime.id is gone and every chrome.* call throws "Extension context invalidated". Code
  // that runs on page events checks this and exits quietly.
  const alive = () => {
    try {
      return !!chrome.runtime?.id;
    } catch {
      return false;
    }
  };

  // A promise that also ends when the run is cancelled (an in-flight Claude request: its answer is discarded).
  function untilCancel(promise) {
    let iv;
    const stop = new Promise((_, reject) => {
      iv = setInterval(() => {
        if (cancel.reason) reject(new Cancelled(cancel.reason));
      }, 100);
    });
    return Promise.race([promise, stop]).finally(() => clearInterval(iv));
  }
  Object.assign(AAF, { cancel, Cancelled, untilCancel, now, delay, focusStep, focused, fillClock, alive, DEBUG, dbg, show, sleep, norm, visible, SKIP, waitFor, checkboxOn, parseDate, splitAlts, setField, timed });
})();
