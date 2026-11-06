// Application Autofill: shared setters for native form controls that look the same on every portal:
// radio groups, checkbox groups, and single checkboxes. Portal widgets (listboxes, search prompts,
// react-select) stay in the adapters.

(() => {
  const AAF = globalThis.AAF;
  if (!AAF.once("controls")) return;
  const { dbg, show, sleep, waitFor, visible, click, bestOption, norm } = AAF;

  // Radio / checkbox options in a container, each with its visible label text.
  // An option's visible text: its <label for> (anywhere on the page), a wrapping <label>, the parent when it
  // holds only this input, then the text right after (or before) the input up to the next control or line
  // break. The value only as a last resort, with camelCase / underscores split: iCIMS (Perimeter) veteran radios
  // were read as "ProtectedVeteran" / "NotProtectedVeteran" / "optout" instead of "I AM NOT A PROTECTED
  // VETERAN", and nothing matched. Matching is case-insensitive (norm), so ALL CAPS options work.
  const textOf = (el) => ((el && (el.innerText || el.textContent)) || "").replace(/\s+/g, " ").trim();
  const STOP = "input, select, textarea, br, label";
  function adjacentText(inp, dir) {
    let s = "";
    for (let n = inp[dir]; n; n = n[dir]) {
      if (n.nodeType === 1 && (n.matches(STOP) || n.querySelector(STOP))) break;
      s = dir === "nextSibling" ? s + n.textContent : n.textContent + s;
      if (s.trim().length > 200) break;
    }
    return s.replace(/\s+/g, " ").trim();
  }
  const splitValue = (v) => String(v || "").replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  function optionText(inp, c) {
    const sel = inp.id && `label[for="${CSS.escape(inp.id)}"]`;
    const forLab = sel && ((c && c.querySelector(sel)) || document.querySelector(sel));
    let t = textOf(forLab);
    // aria-labelledby (Rippling: the radio's text sits in a div the input names, nowhere near it).
    if (!t && inp.getAttribute("aria-labelledby")) t = inp.getAttribute("aria-labelledby").split(/\s+/).map((id) => textOf(document.getElementById(id))).filter(Boolean).join(" ");
    if (!t) t = textOf(inp.closest("label"));
    if (!t && inp.parentElement && inp.parentElement.querySelectorAll("input, select, textarea").length === 1) t = textOf(inp.parentElement);
    if (!t) t = adjacentText(inp, "nextSibling") || adjacentText(inp, "previousSibling");
    // The input alone in an empty wrapper (<span><input></span> I AM NOT A PROTECTED VETERAN<br>): the
    // wrapper's neighbours.
    const wrap = inp.parentElement;
    if (!t && wrap && wrap.querySelectorAll("input, select, textarea").length === 1 && !textOf(wrap)) t = adjacentText(wrap, "nextSibling") || adjacentText(wrap, "previousSibling");
    return t || splitValue(inp.value);
  }
  function choiceOptions(c, kind) {
    return [...c.querySelectorAll(`input[type="${kind}"]`)].map((inp) => ({ el: inp, text: optionText(inp, c) }));
  }

  // Visually checked is NOT registered. A checkbox can show a tick while the portal's React state never
  // changed: on Ashby (Chainmail Labs), "How did you hear about us?" showed LinkedIn ticked after a
  // click on the <input>, and submit said "Missing entry for required field". The portal's handler
  // can live on the label or a styled element rather than the input, and a controlled input reverts a
  // value its state didn't take. So, for every radio / checkbox on every portal:
  //   - never set .checked; click the control a user would click, with the full pointer / mouse
  //     sequence (AAF.click): the label first, then a styled role=checkbox|radio element, then the
  //     input, then its parent;
  //   - verify `checked` AND `aria-checked` (on the input or the styled element) after the click; if
  //     it isn't in the wanted state (no effect, or toggled twice), click the same target once more;
  //   - wait 300 ms and verify again (a controlled React input reverts what its state didn't take);
  //     if it reverted, move on to the next target;
  //   - then dispatch input / change and focusout / blur on the input.
  const styledOf = (inp) =>
    inp.closest('[role="checkbox"], [role="radio"]') ||
    [...(inp.parentElement?.children || [])].find((x) => x !== inp && x.matches('[role="checkbox"], [role="radio"]')) ||
    null;
  const labelOf = (inp) => (inp.id && document.querySelector(`label[for="${CSS.escape(inp.id)}"]`)) || inp.closest("label");
  function clickTargets(inp) {
    const list = [
      ["label", labelOf(inp)],
      ["styled control", styledOf(inp)],
      ["input", inp],
      ["parent", inp.parentElement],
    ];
    const seen = new Set();
    return list.filter(([, el]) => el && !seen.has(el) && seen.add(el) && (el === inp || visible(el)));
  }
  // Click until the input is in the wanted state and stays there. Returns how it got there, or null.
  async function setChecked(inp, want, what) {
    const id = inp.id;
    const cur = () => (inp.isConnected ? inp : (id && document.getElementById(id)) || inp);
    const is = () => {
      const el = cur();
      const aria = el.getAttribute("aria-checked") ?? styledOf(el)?.getAttribute("aria-checked");
      return want ? el.checked && aria !== "false" : !el.checked && aria !== "true";
    };
    if (is()) return "already";
    const tried = [];
    for (const [how, el] of clickTargets(cur())) {
      tried.push(how);
      click(el);
      if (!(await waitFor(is, 800))) {
        // No effect, or toggled twice (label + input handlers): one more click on the same target.
        click(el);
        if (!(await waitFor(is, 800))) continue;
      }
      await sleep(300);
      if (!is()) {
        dbg(`${what}: set after clicking the ${how}, but reverted (not registered); trying the next target`);
        continue;
      }
      const x = cur();
      x.dispatchEvent(new Event("input", { bubbles: true }));
      x.dispatchEvent(new Event("change", { bubbles: true }));
      x.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      x.dispatchEvent(new FocusEvent("blur"));
      if (tried.length > 1) dbg(`${what}: registered after clicking the ${how} (tried ${tried.join(", ")})`);
      return how;
    }
    const x = cur();
    dbg(`${what}: didn't register (tried ${tried.join(", ")}; checked=${x.checked}, aria-checked=${x.getAttribute("aria-checked") ?? styledOf(x)?.getAttribute("aria-checked") ?? "none"}); HTML: ${(x.closest("label")?.parentElement || x.parentElement)?.outerHTML.slice(0, 400)}`);
    return null;
  }

  // Radios / checkbox groups: pick the option, then setChecked. An array is an ordered fallback list:
  // the first alternative that matches an option wins.
  async function setChoice(f, kind, wanted) {
    const opts = choiceOptions(f.c, kind);
    const pick = Array.isArray(wanted) ? wanted.filter(Boolean).map((w) => bestOption(opts, w)).find(Boolean) : bestOption(opts, wanted);
    if (!pick) {
      dbg(`no ${kind} option matches ${JSON.stringify(wanted)} in ${f.label.slice(0, 60)}; options:`, show(opts.map((o) => o.text)));
      return false;
    }
    const ok = !!(await setChecked(pick.el, true, `${kind} "${pick.text}" in ${f.label.slice(0, 60)}`));
    if (ok) f.picked = pick.text;
    return ok;
  }

  // A checkbox group where several options apply ("Language Skill(s) (Check all that apply)"): every option
  // whose text (a code in parentheses ignored: "English (ENG)") is one of `names` gets checked. Returns
  // false when none matches (the field stays yellow). Never unchecks anything.
  // `match` (optional): which option texts to check, in place of the names (relocation cities: the same city as an
  // accepted location).
  async function checkAllMatching(f, names, what = f.label, match = null) {
    const strip = (t) => norm(String(t).replace(/\([^)]*\)/g, " "));
    const opts = choiceOptions(f.c, "checkbox");
    const hits = opts.filter((o) => (match ? match(o.text) : names.some((n) => strip(o.text) === norm(n) || strip(o.text) === strip(n))));
    if (!hits.length) {
      dbg(`${what}: ${match ? "no option matches" : `none of ${show(names)} is an option`}; options:`, show(opts.map((o) => o.text)));
      return false;
    }
    let all = true;
    for (const o of hits) all = !!(await setChecked(o.el, true, `${what}: "${o.text}"`)) && all;
    f.picked = hits.map((o) => o.text).join(", ");
    dbg(`${what}: checked ${show(hits.map((o) => o.text))}`);
    return all;
  }

  async function setCheckbox(f, on) {
    return !!(await setChecked(f.ctrl, !!on, `checkbox ${f.label.slice(0, 60)}`));
  }

  // The saved resume (chrome.storage "resumeFile": { name, type, dataUrl }) as a File for an <input type=file>.
  function dataUrlToFile({ dataUrl, name, type }) {
    const [head, b64] = dataUrl.split(",");
    const mime = type || head.match(/data:(.*?);/)?.[1] || "application/pdf";
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], name, { type: mime });
  }

  // An uploaded file already listed in an upload section ("Use my last application", a resume parse, an earlier
// visit): [{ name, del }] (del = its delete / remove / trash button, or null). Leaf-most elements whose text
// is a file name ("resume 7.7.pdf"), not instructions (".pdf, .docx").
const FILE_NAME = /(^|\s)([A-Za-z0-9][^\\/:*?"<>|\n]{0,120}?\.(pdf|docx?|rtf|txt|odt|pages))\b/i;
function uploadedFiles(box) {
  if (!box) return [];
  const els = [...box.querySelectorAll("*")].filter((el) => !el.matches("input, script, style, option") && FILE_NAME.test(el.textContent || "") && (el.textContent || "").length < 200);
  const leaves = els.filter((el) => !els.some((o) => o !== el && el.contains(o)));
  const out = [];
  for (const el of leaves) {
    const name = (el.textContent.match(FILE_NAME) || [])[2]?.trim();
    if (!name || out.some((x) => x.name === name)) continue;
    // A drop zone's instructions name file types, not a file ("Drop or select (.doc / .docx / .pdf)", Rippling).
    if (/^(drop|drag|select|choose|browse|upload|attach|click)\b|\(\s*\.\w+\s*\/|^\(?\.\w+\)?$/i.test(name) || /\b(drop|drag) (or|and|&) (select|drop|browse)\b|\baccepted (file )?types?\b/i.test(el.textContent)) continue;
    let del = null;
    for (let a = el; a && a !== box.parentElement && !del; a = a.parentElement) {
      del = [...a.querySelectorAll('button, [role="button"], a')].find((b) => {
        const t = `${b.innerText || ""} ${b.getAttribute("aria-label") || ""} ${b.getAttribute("title") || ""} ${b.getAttribute("data-automation-id") || ""} ${typeof b.className === "string" ? b.className : ""}`;
        return /delete|remove|trash|clear/i.test(t) && !/replace|upload|select files|attach/i.test(t);
      }) || null;
      if (a === box) break;
    }
    out.push({ name, del });
  }
  return out;
}
// Same file as the one in Options: names compared without case, extension, spaces / punctuation; a shown name
// cut short ("TESTAPPLICANTRES…") counts when it's a start of 8+ characters.
const fileKey = (n) => String(n || "").toLowerCase().replace(/\.(pdf|docx?|rtf|txt|odt|pages)$/i, "").replace(/[^a-z0-9]/g, "");
function sameFileName(shown, mine) {
  const a = fileKey(String(shown).replace(/[…]|\.\.\.$/g, ""));
  const b = fileKey(mine);
  return !!a && (a === b || (a.length >= 8 && b.startsWith(a)));
}
// Before uploading: an already-listed file with the same name is kept; a different one is deleted with its
// own delete button (inside the upload section only) so yours replaces it, at most once per tab session (a
// portal that renames uploads would otherwise loop). Returns "kept" | "deleted" | "none" | "stuck".
async function clearOldUpload(box, mine, log) {
  const files = uploadedFiles(box);
  if (!files.length) return { state: "none" };
  const same = files.find((x) => sameFileName(x.name, mine));
  if (same) {
    log(`resume: kept "${same.name}" (the same file as in Options)`);
    return { state: "kept", name: same.name };
  }
  const old = files[0];
  let replacedAt = 0;
  try {
    replacedAt = +sessionStorage.getItem("aaf-resume-replaced") || 0;
  } catch {}
  if (Date.now() - replacedAt < 10 * 60 * 1000) {
    log(`resume: "${old.name}" is listed; yours was already uploaded in this tab a few minutes ago, so it's kept (the portal may have renamed it)`);
    return { state: "kept", name: old.name };
  }
  if (!old.del) {
    log(`resume: "${old.name}" is listed (not your "${mine}") and has no delete button; uploading yours`);
    return { state: "none", old: old.name };
  }
  AAF.click(old.del);
  const gone = await AAF.waitFor(() => !uploadedFiles(box).some((x) => x.name === old.name), 3000);
  if (!gone) {
    log(`resume: clicked delete on "${old.name}", but it's still listed; left it for you (not uploading next to it)`);
    return { state: "stuck", old: old.name };
  }
  try {
    sessionStorage.setItem("aaf-resume-replaced", String(Date.now()));
  } catch {}
  return { state: "deleted", old: old.name };
}

Object.assign(AAF, { uploadedFiles, sameFileName, clearOldUpload, optionText, splitValue, choiceOptions, setChoice, setCheckbox, setChecked, checkAllMatching, dataUrlToFile });
})();
