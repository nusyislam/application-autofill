// Selective backup import (Options; loaded after options.js and uses its $, getPath, setPath, save, load, DEFAULT_PROFILE,
// DEFAULT_SETTINGS, RULES, changed). `globalThis.AAF_IMPORT`. Choosing a backup file opens a dialog with what's in it
// and a checkbox per part:
//   - Profile fields: contact, work history, education, languages, skills, fixed answers, self-ID (with counts).
//   - Materials: resume text, LinkedIn text, extra notes, projects to highlight.
//   - Settings: the toggles, the threshold, the model names (never the API key).
//   - Learned answers: approved / pending / recently deleted.
// Profile fields and materials: "Only fill empty fields" (default; a value equal to the built-in default counts as
// empty) or "Replace" (the backup's values win; the dialog says how many of your values that changes). Jobs / schools /
// languages: a backup card that doesn't match one of yours (company + title / school / language) is added; a matching
// one is merged field by field by the same mode; never a duplicate. Learned answers: matched by question + company
// scope; yours win; new ones keep their status; never one in your Recently deleted or one a never-learn rule now blocks
// (logged). The API key is never imported. Afterwards: a summary ("Filled 12 empty fields, added 2 jobs, ...").
(() => {
  const MATERIALS = ["resumeText", "linkedinText", "extraNotes", "projectsHighlight"];
  const SETTINGS = ["useAI", "learn", "drafts", "threshold", "notifyDone", "learnNoReview", "cleanParsedPanels"];
  const MODELS = ["api.model", "api.draftModel"];
  // Values Options fills in on load when blank: they count as empty (not set by you).
  const LOAD_DEFAULTS = { "answers.securitiesLicenses": "None", "answers.countCurrentIntern": "Yes" };
  const CARDS = {
    experiences: { what: ["job", "jobs"], key: (c) => `${n(c.company)}|${n(c.title)}` },
    education: { what: ["school", "schools"], key: (c) => n(c.school) },
    languages: { what: ["language", "languages"], key: (c) => n(c.name) },
  };
  const n = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9+#]+/g, " ").trim();
  const has = (v) => (Array.isArray(v) ? v.length > 0 : typeof v === "boolean" ? v : String(v ?? "").trim() !== "");
  const log = (...a) => console.info("[autofill] import:", ...a);
  const $d = (s) => $("#importDlg").querySelector(s);

  // The profile's own scalar fields (every Options box with a data-k), split into materials and the rest.
  const fieldKeys = () => [...new Set([...document.querySelectorAll("[data-k]")].map((el) => el.dataset.k))].filter((k) => k !== "api.key" && !MODELS.includes(k));
  const profileKeys = () => fieldKeys().filter((k) => !MATERIALS.includes(k));
  // A value equal to what Options puts in a blank box (the built-in defaults). Fixed answers are your choices even when
  // they equal a default (Travel = Maximum), except the two Options fills in on load.
  const isDefault = (k, v) => {
    if (/^(answers|eeo)\./.test(k) && !(k in LOAD_DEFAULTS)) return false;
    const def = getPath(DEFAULT_PROFILE, k) ?? LOAD_DEFAULTS[k];
    return def != null && String(def).trim() !== "" && String(v ?? "").trim() === String(def).trim();
  };
  const emptyHere = (k, v) => !has(v) || isDefault(k, v);
  const labelOf = (k) => {
    const el = $(`[data-k="${k}"]`)?.closest("label");
    return (el?.firstChild?.textContent || k).trim().replace(/\s*\(.*$/, "");
  };
  const qKey = (x) => `${n(x?.q)}|${n(x?.company)}`;

  let backup = null;
  let current = null;

  // ---- what the import would do (also the dialog's counts and the Replace warning)
  function planFields(keys, mode, { lists = false } = {}) {
    const fill = [];
    const replace = [];
    for (const k of keys) {
      const b = getPath(backup.profile || {}, k);
      if (!has(b) || isDefault(k, b)) continue; // nothing in the backup, or only the built-in default
      const c = getPath(current.profile, k);
      if (emptyHere(k, c)) {
        if (String(b).trim() !== String(c ?? "").trim()) fill.push(k);
      } else if (mode === "replace" && n(b) !== n(c)) replace.push(k);
    }
    // Role interests (a checklist): a list, taken whole.
    const bri = backup.profile?.roleInterests;
    if (lists) {
      if (has(bri) && !has(current.profile.roleInterests)) fill.push("roleInterests");
      else if (mode === "replace" && has(bri) && JSON.stringify(bri) !== JSON.stringify(current.profile.roleInterests)) replace.push("roleInterests");
    }
    return { fill, replace };
  }
  function planCards(mode) {
    const out = {};
    for (const [list, def] of Object.entries(CARDS)) {
      const mine = (current.profile[list] || []).filter((c) => Object.entries(c).some(([f, v]) => f !== "degreeOptions" && f !== "schoolSearch" && f !== "fieldFallbacks" && has(v)));
      const add = [];
      const merges = [];
      let dups = 0;
      for (const c of Array.isArray(backup.profile?.[list]) ? backup.profile[list] : []) {
        if (!def.key(c).replace(/\|/g, "").trim()) continue;
        if (add.some((x) => def.key(x) === def.key(c))) continue;
        const m = mine.find((x) => def.key(x) === def.key(c));
        if (!m) {
          add.push(c);
          continue;
        }
        dups++;
        const f = Object.entries(c).filter(([fk, v]) => has(v) && (mode === "replace" ? n(v) !== n(m[fk]) : !has(m[fk])));
        if (f.length) merges.push({ into: m, from: c, fields: f.map(([fk]) => fk), replaced: f.filter(([fk]) => has(m[fk])).length });
      }
      out[list] = { mine, add, merges, dups };
    }
    return out;
  }
  function planLearned() {
    const mine = new Set((current.learned || []).map(qKey));
    const gone = new Set((current.learnedDeleted || []).map(qKey));
    const add = [];
    const skipped = { dup: [], deleted: [], blocked: [] };
    for (const x of Array.isArray(backup.learned) ? backup.learned : []) {
      if (!x || !x.q) continue;
      const k = qKey(x);
      if (mine.has(k) || add.some((y) => qKey(y) === k)) skipped.dup.push(x);
      else if (gone.has(k)) skipped.deleted.push(x);
      else if (RULES.entryCategory(x).blocked) skipped.blocked.push({ x, why: RULES.entryCategory(x).category });
      else add.push(x);
    }
    const delAdd = (Array.isArray(backup.learnedDeleted) ? backup.learnedDeleted : []).filter((x) => x?.q && !mine.has(qKey(x)) && !gone.has(qKey(x)));
    return { add, skipped, delAdd };
  }

  // ---- the dialog
  function preview() {
    const p = backup.profile || {};
    const contact = profileKeys().filter((k) => !/^(answers|eeo)\./.test(k) && !["skills", "certifications"].includes(k) && has(getPath(p, k)) && !isDefault(k, getPath(p, k))).length;
    const count = (pre) => Object.entries(p[pre] || {}).filter(([k, v]) => has(v) && !isDefault(`${pre}.${k}`, v)).length;
    const cards = (list) => (Array.isArray(p[list]) ? p[list] : []).filter((c) => CARDS[list].key(c).replace(/\|/g, "").trim()).length;
    const plural = (k, [one, many]) => `${k} ${k === 1 ? one : many}`;
    const parts = [
      `${plural(contact, ["contact field", "contact fields"])}`,
      plural(cards("experiences"), CARDS.experiences.what),
      plural(cards("education"), CARDS.education.what),
      plural(cards("languages"), CARDS.languages.what),
      has(p.skills) || has(p.certifications) ? "skills" : "no skills",
      plural(count("answers"), ["fixed answer", "fixed answers"]),
      plural(count("eeo"), ["self-ID answer", "self-ID answers"]),
    ];
    $d("#impProfileCount").textContent = parts.join(", ");
    const mats = MATERIALS.filter((k) => has(p[k])).map(labelOf);
    $d("#impMaterialsCount").textContent = mats.length ? mats.join(", ") : "none";
    const s = backup.settings || {};
    const sets = SETTINGS.filter((k) => k in s).length + MODELS.filter((k) => has(getPath(p, k))).length;
    $d("#impSettingsCount").textContent = `${sets} setting${sets === 1 ? "" : "s"}`;
    const L = Array.isArray(backup.learned) ? backup.learned : [];
    const D = Array.isArray(backup.learnedDeleted) ? backup.learnedDeleted : [];
    $d("#impLearnedCount").textContent = `${L.filter((x) => !x.pending).length} approved, ${L.filter((x) => x.pending).length} pending, ${D.length} recently deleted`;
    for (const [id, ok] of [["#impProfile", contact + cards("experiences") + cards("education") + cards("languages") + count("answers") + count("eeo") > 0 || has(p.skills)], ["#impMaterials", mats.length > 0], ["#impSettings", sets > 0], ["#impLearned", L.length + D.length > 0]]) {
      $d(id).checked = ok;
      $d(id).disabled = !ok;
    }
    updateWarning();
  }
  const mode = () => ($d('input[name="impMode"]:checked')?.value === "replace" ? "replace" : "empty");
  function updateWarning() {
    const w = $d("#impWarn");
    if (mode() !== "replace") return (w.hidden = true);
    const keys = [...($d("#impProfile").checked ? profileKeys() : []), ...($d("#impMaterials").checked ? MATERIALS : [])];
    const { replace } = planFields(keys, "replace", { lists: $d("#impProfile").checked });
    const cards = $d("#impProfile").checked ? Object.values(planCards("replace")).reduce((s, c) => s + c.merges.reduce((t, m) => t + m.replaced, 0), 0) : 0;
    const total = replace.length + cards;
    w.hidden = false;
    w.textContent = total
      ? `Replace changes ${total} of your values to the backup's: ${[...replace.map(labelOf), ...(cards ? [`${cards} in matching job / school / language cards`] : [])].slice(0, 8).join(", ")}${replace.length > 8 ? ", ..." : ""}.`
      : "Replace changes none of your values: the backup only adds to them.";
  }

  async function open(data) {
    if (!data || typeof data !== "object" || Array.isArray(data) || !(data.profile || data.settings || data.learned || data.learnedDeleted)) {
      $("#importStatus").textContent = "That file isn't a backup from this extension.";
      return;
    }
    backup = structuredClone(data);
    if (backup.profile?.api) delete backup.profile.api.key; // never imported
    $d("#impMsg").textContent = "";
    $d('input[name="impMode"][value="empty"]').checked = true;
    current = await chrome.storage.local.get(["profile", "settings", "learned", "learnedDeleted"]);
    current.profile = merge(DEFAULT_PROFILE, current.profile || {});
    preview();
    $("#importDlg").showModal();
    $d("#impCancel").focus();
  }

  // ---- doing it
  async function run() {
    const m = mode();
    // Your unsaved edits first, so "only empty" sees what's on the page.
    if (!(await save())) {
      $d("#impMsg").textContent = "Your current page has an invalid value (see the bar below); fix it first.";
      return null;
    }
    current = await chrome.storage.local.get(["profile", "settings", "learned", "learnedDeleted"]);
    const prof = structuredClone(current.profile || {});
    current.profile = merge(DEFAULT_PROFILE, current.profile || {});
    const sum = { filled: 0, replaced: 0, added: {}, cardFields: 0, learned: 0, dups: 0, deleted: 0, blocked: 0, settings: false };
    const apply = (keys, lists = false) => {
      const { fill, replace } = planFields(keys, m, { lists });
      for (const k of [...fill, ...replace]) {
        const v = k === "roleInterests" ? backup.profile.roleInterests : getPath(backup.profile, k);
        k === "roleInterests" ? (prof.roleInterests = v) : setPath(prof, k, v);
      }
      sum.filled += fill.length;
      sum.replaced += replace.length;
    };
    if ($d("#impProfile").checked) {
      apply(profileKeys(), true);
      for (const [list, plan] of Object.entries(planCards(m))) {
        const mine = (prof[list] || []).filter((c) => plan.mine.some((x) => CARDS[list].key(x) === CARDS[list].key(c)));
        for (const mg of plan.merges) {
          const target = mine.find((c) => CARDS[list].key(c) === CARDS[list].key(mg.into));
          for (const f of mg.fields) target[f] = mg.from[f];
          sum.cardFields += mg.fields.length;
        }
        prof[list] = [...mine, ...plan.add.map((c) => structuredClone(c))];
        sum.added[list] = plan.add.length;
        sum.dups += plan.dups;
      }
    }
    if ($d("#impMaterials").checked) apply(MATERIALS);
    const out = { profile: prof };
    if ($d("#impSettings").checked) {
      const s = { ...DEFAULT_SETTINGS, ...(current.settings || {}) };
      for (const k of SETTINGS) if (k in (backup.settings || {})) s[k] = backup.settings[k];
      out.settings = s;
      for (const k of MODELS) if (has(getPath(backup.profile || {}, k))) setPath(prof, k, getPath(backup.profile, k));
      sum.settings = true;
    }
    if ($d("#impLearned").checked) {
      const plan = planLearned();
      for (const { x, why } of plan.skipped.blocked) log(`learned answer not imported (never learned: ${why}): ${x.q}`);
      for (const x of plan.skipped.deleted) log(`learned answer not imported (in your Recently deleted): ${x.q}`);
      out.learned = [...(current.learned || []), ...plan.add];
      out.learnedDeleted = RULES.pruneDeleted([...(current.learnedDeleted || []), ...plan.delAdd]);
      sum.learned = plan.add.length;
      sum.dups += plan.skipped.dup.length;
      sum.deleted = plan.skipped.deleted.length;
      sum.blocked = plan.skipped.blocked.length;
    }
    // The API key stays yours, whatever the file holds.
    prof.api = { ...(prof.api || {}), key: current.profile.api?.key || "" };
    await chrome.storage.local.set(out);
    return sum;
  }
  function summaryOf(s) {
    const parts = [];
    if (s.filled) parts.push(`Filled ${s.filled} empty field${s.filled === 1 ? "" : "s"}`);
    if (s.replaced) parts.push(`replaced ${s.replaced}`);
    for (const [list, k] of Object.entries(s.added)) if (k) parts.push(`added ${k} ${CARDS[list].what[k === 1 ? 0 : 1]}`);
    if (s.cardFields) parts.push(`updated ${s.cardFields} field${s.cardFields === 1 ? "" : "s"} in matching cards`);
    if (s.learned) parts.push(`added ${s.learned} learned answer${s.learned === 1 ? "" : "s"}`);
    if (s.dups) parts.push(`skipped ${s.dups} duplicate${s.dups === 1 ? "" : "s"}`);
    if (s.deleted) parts.push(`skipped ${s.deleted} in your Recently deleted`);
    if (s.blocked) parts.push(`skipped ${s.blocked} that are never learned`);
    if (s.settings) parts.push("settings imported");
    const text = parts.join(", ") || "Nothing to import: the backup adds nothing to what you have";
    return text.charAt(0).toUpperCase() + text.slice(1) + ".";
  }

  $d("#impCancel").addEventListener("click", () => $("#importDlg").close());
  for (const el of $("#importDlg").querySelectorAll('input[name="impMode"], #impProfile, #impMaterials')) el.addEventListener("change", updateWarning);
  $d("#impGo").addEventListener("click", async () => {
    const btns = $("#importDlg").querySelectorAll("button");
    btns.forEach((b) => (b.disabled = true));
    try {
      const s = await run();
      if (!s) return;
      // An older backup can hold learned entries the guards now forbid: the background purge moves them (it already
      // skipped the blocked ones here; this catches anything else, as before).
      await chrome.runtime.sendMessage({ type: "PURGE_LEARNED" }).catch(() => {});
      $("#importDlg").close();
      await load();
      const text = summaryOf(s);
      $("#importStatus").textContent = text;
      log(text);
    } catch (e) {
      $d("#impMsg").textContent = `Couldn't import: ${e?.message || e}`;
    } finally {
      btns.forEach((b) => (b.disabled = false));
    }
  });

  globalThis.AAF_IMPORT = { open };
})();
