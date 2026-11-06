const DEFAULT_DEGREE_OPTIONS = [
  "Bachelor of Engineering | BEng | B.E. | BE",
  "Bachelor's Degree | Bachelor's | Bachelors | Bachelor Degree",
  "Bachelor of Science | BS | B.S. | BSc",
  "Undergraduate",
].join("\n");

const NATIVE_LEVELS = "Native or Bilingual | Native | Fluent | Expert | Advanced";
// "None"-style levels first; if the company's scale has none, the lowest real level.
const NO_LITERACY_LEVELS = "None | No Proficiency | Not Applicable | Beginner | Elementary | Basic";

// Default school search keyword: the name without generic words ("Lakeview University" -> "Lakeview").
// Keep in sync with schoolKeyword in shared/profile.js.
const schoolKeyword = (school) =>
  String(school || "").replace(/\b(the|university|college|of|at|suny|cuny|state|institute|school)\b/gi, " ").replace(/[()]/g, " ").replace(/\s+/g, " ").trim() || String(school || "");

const DEFAULT_PROFILE = {
  firstName: "",
  lastName: "",
  preferredName: "",
  email: "",
  phone: "",
  // Ordered fallbacks, "|"-separated (keep the default in sync with shared/profile.js).
  phoneType: "Mobile | Cell | Cellular | Cell Phone | Mobile Phone | Home Cellular | Personal Cell | Personal Mobile",
  phoneCountry: "United States of America",
  address1: "",
  address2: "",
  city: "",
  state: "",
  zip: "",
  country: "United States of America",
  // How did you hear (dropdowns / search boxes): an ordered fallback list, first option that matches wins.
  source: "LinkedIn | Social Media | Job Board",
  // Free-text "how / where did you hear about this role" fields (dropdowns use `source`).
  hearText: "LinkedIn",
  linkedin: "",
  github: "",
  website: "",
  resumeText: "",
  extraNotes: "",
  // One per line, "Name: what it shows best": drafts prefer these when they fit (background.js draftAI).
  projectsHighlight: "",
  // Pasted LinkedIn profile text: draft mode reads it for open-ended questions.
  linkedinText: "",
  // One blank entry each; your own entries are saved in Options (chrome.storage), never here.
  experiences: [
    { title: "", company: "", location: "", current: false, startMonth: "", startYear: "", endMonth: "", endYear: "", description: "" },
  ],
  education: [
    {
      school: "",
      schoolAliases: "",
      schoolSearch: "",
      degreeOptions: DEFAULT_DEGREE_OPTIONS,
      field: "",
      // Majors to accept when a list doesn't have yours ("|"-ordered; blank = your field alone).
      fieldFallbacks: "",
      gpa: "",
      startYear: "",
      endYear: "",
    },
  ],
  expectedGraduation: "",
  // Location / City autocomplete fields: type `search`, pick the first EXACT match from `matches` (else
  // leave for you). Keep in sync with DEFAULT_LOCATION in shared/profile.js.
  applicationLocation: { search: "", matches: "" },
  // Languages you speak: none by default (Options adds them; see the language fields there for the levels).
  languages: [],
  skills: "",
  answers: {
    workAuth: "",
    sponsorship: "",
    over18: "",
    citizen: "",
    usPerson: "",
    relocate: "",
    clearance: "",
    travel: "Maximum",
    restrictions: "None",
    previousEmployers: "",
    // Office attendance: job locations you can commute to (|-separated). Keep in sync with
    // DEFAULT_OFFICE_METRO in shared/profile.js.
    officeMetro: "",
  },
  // racePrefs: ordered race options, overriding `race` when set (exact first, never another subgroup).
  eeo: { gender: "", hispanic: "", race: "", racePrefs: "", veteran: "", disability: "", lgbtq: "", transgender: "", lgbtqMember: "", birthMonth: "", communities: "" },
  // model: regular questions; draftModel: draft mode (open-ended answers). Keep the draft default in
  // sync with DEFAULT_DRAFT_MODEL in background.js.
  api: { key: "", model: "claude-haiku-5-5", draftModel: "claude-sonnet-5-5" },
};
const DEFAULT_SETTINGS = { useAI: true, learn: true, drafts: true, threshold: 0.75, notifyDone: true, learnNoReview: false, cleanParsedPanels: true };

const $ = (s) => document.querySelector(s);
const getPath = (o, p) => p.split(".").reduce((x, k) => (x == null ? x : x[k]), o);
const setPath = (o, p, v) => {
  const ks = p.split(".");
  let x = o;
  ks.slice(0, -1).forEach((k) => (x = x[k] ??= {}));
  x[ks.at(-1)] = v;
};
const merge = (d, s) => {
  const out = structuredClone(d);
  for (const [k, v] of Object.entries(s || {})) {
    out[k] = v && typeof v === "object" && !Array.isArray(v) && typeof d[k] === "object" && !Array.isArray(d[k]) ? merge(d[k], v) : v;
  }
  return out;
};

let profile, settings, learned, learnedDeleted;
const RULES = globalThis.AAF_LEARN_RULES;

function renderList(container, tplId, items) {
  const box = $(container);
  box.innerHTML = "";
  items.forEach((item) => addCard(box, tplId, item));
}
function addCard(box, tplId, item = {}) {
  const node = $(tplId).content.firstElementChild.cloneNode(true);
  node.querySelectorAll("[data-f]").forEach((el) => {
    const v = item[el.dataset.f];
    if (el.type === "checkbox") el.checked = !!v;
    else el.value = v ?? "";
  });
  node.querySelector(".rm").addEventListener("click", () => node.remove());
  box.appendChild(node);
}
function readList(container) {
  return [...$(container).querySelectorAll(".card")].map((card) => {
    const o = {};
    card.querySelectorAll("[data-f]").forEach((el) => (o[el.dataset.f] = el.type === "checkbox" ? el.checked : el.value.trim()));
    return o;
  });
}

// The category tag for a learned entry (shared/learnrules.js): what it's about, or the rule that blocks it.
function tagFor(x) {
  const { category, blocked, chosen } = RULES.entryCategory(x);
  const wrap = document.createElement("span");
  const add = (text, cls, title = "") => {
    const el = document.createElement("span");
    el.className = "tag" + (cls ? " " + cls : "");
    el.textContent = text;
    el.title = title;
    el.style.marginRight = "4px";
    wrap.appendChild(el);
  };
  add(blocked ? `blocked: ${category}` : category, blocked ? "blocked" : "", blocked ? (chosen ? "You picked a category that is never reused: this entry isn't used for filling." : "A learning rule forbids this category: it's never used for filling.") : chosen ? "The category you picked." : "");
  if (x.coveredByRule) add("covered by rule", "blocked", "A rule answers this question now; the rule is used, not this entry.");
  if (RULES.garbledCompany(x)) add("garbled, re-check", "blocked", "An older version replaced ordinary capitalized words with [company], and the original wording wasn't kept: check it and delete it if it's wrong. It isn't reused for filling.");
  if (x.company) add(`only for ${x.company}`, "", "Names a company: reused only on that company's applications.");
  if (x.scopeFixed) add(`scope fixed (was "${x.scopeFixed.from}")`, "", `The company was read wrongly from the question before; now ${x.scopeFixed.to ? `"${x.scopeFixed.to}"` : "general (not a company)"}.`);
  return wrap;
}
// The category picker beside each entry (learned-answers review: "other" was overused and some were wrong): automatic
// (shared/learnrules.js `categoryOf`) or one you pick, saved at once. A rule's block can't be lifted here.
function categoryPicker(i) {
  const sel = document.createElement("select");
  sel.title = "Change the category (Automatic = what the rules say)";
  const auto = RULES.categoryOf(learned[i].q, learned[i].type, learned[i].a);
  sel.add(new Option(`Automatic (${auto.category})`, ""));
  for (const c of RULES.CATEGORY_NAMES) sel.add(new Option(c, c));
  sel.value = learned[i].category || "";
  sel.disabled = auto.blocked;
  if (auto.blocked) sel.title = "A learning rule blocks this question; the category can't be changed.";
  sel.addEventListener("change", async () => {
    if (sel.value) learned[i].category = sel.value;
    else delete learned[i].category;
    await chrome.storage.local.set({ learned });
    renderLearned();
  });
  return sel;
}
// Pending review: learned since the last review, not reused until approved (Approve / Edit / Reject).
// The pending rows' answer boxes, by learned index (Approve all takes their edited text).
let pendingBoxes = new Map();
function renderPending() {
  const t = $("#learnedPending");
  t.innerHTML = "";
  pendingBoxes = new Map();
  const rows = learned.map((x, i) => [x, i]).filter(([x]) => x.pending);
  $("#approveAll").disabled = $("#rejectAll").disabled = !rows.length;
  if (!rows.length) {
    t.innerHTML = '<tr><td class="hint">Nothing to review.</td></tr>';
    return;
  }
  for (const [x, i] of rows) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td style="width:40%"></td><td style="width:1%"></td><td><textarea></textarea></td><td style="white-space:nowrap"><button class="ok">Approve</button> <button class="no">Reject</button></td>`;
    tr.children[0].textContent = x.q;
    tr.children[1].appendChild(tagFor(x));
    tr.children[1].appendChild(categoryPicker(i));
    const ta = tr.querySelector("textarea");
    ta.value = x.a;
    ta.title = "Edit the answer, then Approve";
    pendingBoxes.set(i, ta);
    tr.querySelector(".ok").addEventListener("click", async () => {
      learned[i] = { ...learned[i], a: ta.value, pending: false, updated: Date.now() };
      delete learned[i].pending;
      await chrome.storage.local.set({ learned });
      renderLearned();
    });
    tr.querySelector(".no").addEventListener("click", () => deleteLearned([i], "rejected in review"));
    t.appendChild(tr);
  }
}
function renderLearned() {
  renderPending();
  const t = $("#learned");
  t.innerHTML = "";
  $("#clearLearned").disabled = !learned.length;
  if (!learned.some((x) => !x.pending)) {
    t.innerHTML = '<tr><td class="hint">Nothing yet.</td></tr>';
    return;
  }
  learned.forEach((x, i) => {
    if (x.pending) return;
    const tr = document.createElement("tr");
    tr.innerHTML = `<td style="width:45%"></td><td style="width:1%"></td><td><textarea></textarea></td><td><button>Delete</button></td>`;
    tr.children[0].textContent = x.q;
    tr.children[1].appendChild(tagFor(x));
    tr.children[1].appendChild(categoryPicker(i));
    const ta = tr.querySelector("textarea");
    ta.value = x.a;
    ta.addEventListener("input", () => (learned[i].a = ta.value));
    tr.querySelector("button").addEventListener("click", () => deleteLearned([i]));
    t.appendChild(tr);
  });
}
// Skills not in a Workday site's list (shared by adapters/workday.js, `skillMisses`: { tenant: { key: { name, at } } }),
// skipped there for 7 days. Clear forgets them all.
async function renderSkillMisses() {
  const t = $("#skillMisses");
  let misses = {};
  try {
    ({ skillMisses: misses = {} } = await chrome.storage.local.get("skillMisses"));
  } catch {}
  const now = Date.now();
  const rows = Object.entries(misses).flatMap(([site, m]) => Object.values(m || {}).filter((x) => now - x.at < 7 * 864e5).map((x) => [site, x]));
  t.innerHTML = "";
  $("#clearSkillMisses").disabled = !rows.length;
  if (!rows.length) {
    t.innerHTML = '<tr><td class="hint">None.</td></tr>';
    return;
  }
  for (const [site, x] of rows) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td></td><td></td><td class="hint" style="margin:0"></td>`;
    tr.children[0].textContent = site;
    tr.children[1].textContent = x.name;
    const days = Math.max(0, 7 - Math.floor((now - x.at) / 864e5));
    tr.children[2].textContent = `skipped there for ${days} more day${days === 1 ? "" : "s"}`;
    t.appendChild(tr);
  }
}
$("#clearSkillMisses").addEventListener("click", async () => {
  await chrome.storage.local.set({ skillMisses: {} });
  renderSkillMisses();
});
function renderDeleted() {
  const t = $("#learnedDeleted");
  t.innerHTML = "";
  if (!learnedDeleted.length) {
    t.innerHTML = '<tr><td class="hint">Nothing deleted in the last 30 days.</td></tr>';
    return;
  }
  learnedDeleted.forEach((x, i) => {
    const tr = document.createElement("tr");
    const days = Math.max(0, RULES.DELETED_DAYS - Math.floor((Date.now() - x.deletedAt) / 864e5));
    tr.innerHTML = `<td style="width:40%"></td><td style="width:1%"></td><td></td><td class="hint" style="margin:0"></td><td class="del-actions"><div class="stack"><button class="restore">Restore</button><button class="purge">Delete permanently</button></div></td>`;
    tr.children[0].textContent = x.q;
    tr.children[1].appendChild(tagFor(x));
    tr.children[2].textContent = x.a;
    tr.children[3].textContent = `${x.reason || "deleted"}; ${days} day${days === 1 ? "" : "s"} left`;
    tr.querySelector(".restore").addEventListener("click", () => restoreDeleted([i]));
    tr.querySelector(".purge").addEventListener("click", async () => {
      learnedDeleted.splice(i, 1);
      await chrome.storage.local.set({ learnedDeleted });
      renderDeleted();
    });
    t.appendChild(tr);
  });
}
// The Undo bar (8 s), for deletes, Clear all, Approve all and Reject all.
let undoTimer;
function showUndo(text, undo) {
  $("#undoText").textContent = text;
  $("#undo").style.display = "flex";
  clearTimeout(undoTimer);
  undoTimer = setTimeout(() => ($("#undo").style.display = "none"), 8000);
  $("#undoBtn").onclick = async () => {
    $("#undo").style.display = "none";
    clearTimeout(undoTimer);
    await undo();
    renderLearned();
    renderDeleted();
  };
}
// Deleting (one entry or "Clear all") moves entries to Recently deleted right away, with an Undo button.
async function deleteLearned(indexes, reason = "deleted by you", text = "") {
  const now = Date.now();
  const moved = indexes.map((i) => ({ ...learned[i], deletedAt: now, reason }));
  learned = learned.filter((_, i) => !indexes.includes(i));
  learnedDeleted = RULES.pruneDeleted([...moved, ...learnedDeleted], now);
  await chrome.storage.local.set({ learned: learned.filter((x) => x.a !== ""), learnedDeleted });
  renderLearned();
  renderDeleted();
  showUndo(text || (moved.length === 1 ? "Learned answer deleted." : `${moved.length} learned answers deleted.`), async () => {
    const keys = new Set(moved.map((x) => x.deletedAt + "|" + x.q));
    learnedDeleted = learnedDeleted.filter((x) => !keys.has(x.deletedAt + "|" + x.q));
    learned = [...learned, ...moved.map(({ deletedAt, reason, ...x }) => x)];
    await chrome.storage.local.set({ learned, learnedDeleted });
  });
}
const pendingIndexes = () => learned.map((x, i) => (x.pending ? i : -1)).filter((i) => i >= 0);
const plural = (n) => `${n} answer${n === 1 ? "" : "s"}`;
// Approve all: every pending entry to Approved, with the text in its box (edits included). Undo puts them
// back as they were.
$("#approveAll").addEventListener("click", async () => {
  const idx = pendingIndexes();
  if (!idx.length || !confirm(`Approve ${plural(idx.length)}?`)) return;
  const before = idx.map((i) => [i, { ...learned[i] }]);
  const now = Date.now();
  for (const i of idx) {
    const { pending, ...x } = learned[i];
    learned[i] = { ...x, a: pendingBoxes.get(i)?.value ?? x.a, updated: now };
  }
  await chrome.storage.local.set({ learned });
  renderLearned();
  showUndo(`${plural(idx.length)} approved.`, async () => {
    const keys = new Set(before.map(([, x]) => x.q));
    learned = learned.filter((x) => !keys.has(x.q));
    learned.push(...before.map(([, x]) => x));
    await chrome.storage.local.set({ learned });
  });
});
// Reject all: every pending entry to Recently deleted ("rejected in review"), with Undo.
$("#rejectAll").addEventListener("click", () => {
  const idx = pendingIndexes();
  if (!idx.length || !confirm(`Reject ${plural(idx.length)}? They move to Recently deleted.`)) return;
  return deleteLearned(idx, "rejected in review", `${plural(idx.length)} rejected.`);
});
async function restoreDeleted(indexes) {
  const back = indexes.map((i) => learnedDeleted[i]);
  learnedDeleted = learnedDeleted.filter((_, i) => !indexes.includes(i));
  // A restored entry in a blocked category stays (the purge skips `restored`) but is never used for filling.
  learned = [...learned, ...back.map(({ deletedAt, reason, ...x }) => ({ ...x, restored: true }))];
  await chrome.storage.local.set({ learned, learnedDeleted });
  renderLearned();
  renderDeleted();
}
$("#clearLearned").addEventListener("click", () => learned.length && deleteLearned(learned.map((_, i) => i), "cleared with Clear all"));

async function load() {
  const s = await chrome.storage.local.get(["profile", "settings", "learned", "learnedDeleted", "resumeFile"]);
  profile = merge(DEFAULT_PROFILE, s.profile);
  if (s.profile?.experiences) profile.experiences = s.profile.experiences;
  if (s.profile?.education) profile.education = s.profile.education;
  // Migrate entries saved before aliases / degree steps existed: take the defaults for the same
  // school, otherwise turn the old single degree into a one-step list.
  for (const e of profile.education) {
    const def = DEFAULT_PROFILE.education.find((d) => d.school && d.school.toLowerCase() === (e.school || "").toLowerCase());
    if (e.schoolAliases == null) e.schoolAliases = def?.schoolAliases || "";
    // Add default aliases the saved entry is missing (Greenhouse's "Lakeland State University-Lakeview", ...).
    if (def) {
      const have = e.schoolAliases.toLowerCase().split("|").map((a) => a.trim());
      for (const a of def.schoolAliases.split("|").map((x) => x.trim())) if (!have.includes(a.toLowerCase())) e.schoolAliases += (e.schoolAliases ? " | " : "") + a;
    }
    // Blank keyword: the default for a known school, else derived from the name (same rule as shared/profile.js).
    if (!e.schoolSearch?.trim()) e.schoolSearch = def?.schoolSearch || schoolKeyword(e.school);
    if (!e.degreeOptions) e.degreeOptions = def?.degreeOptions || e.degree || "";
    // Blank fallbacks: the default list for the known school, else just the field itself.
    if (!e.fieldFallbacks?.trim()) e.fieldFallbacks = def?.fieldFallbacks || e.field || "";
  }
  // Blank settings show (and save) the real defaults, never empty boxes or placeholder text.
  profile.applicationLocation ??= {};
  if (!profile.applicationLocation.search?.trim()) profile.applicationLocation.search = DEFAULT_PROFILE.applicationLocation.search;
  if (!profile.applicationLocation.matches?.trim()) profile.applicationLocation.matches = DEFAULT_PROFILE.applicationLocation.matches;
  if (!profile.expectedGraduation?.trim()) profile.expectedGraduation = DEFAULT_PROFILE.expectedGraduation;
  profile.api ??= {};
  if (!profile.api.draftModel?.trim()) profile.api.draftModel = DEFAULT_PROFILE.api.draftModel;
  profile.eeo ??= {};
  if (!profile.hearText?.trim()) profile.hearText = DEFAULT_PROFILE.hearText;
  // A single saved value becomes the ordered list it always stood for (it, then Social Media, Job Board).
  if (!profile.source?.trim()) profile.source = DEFAULT_PROFILE.source;
  else if (!/\|/.test(profile.source)) profile.source = `${profile.source.trim()} | Social Media | Job Board`;
  profile.answers ??= {};
  if (!profile.answers.officeMetro?.trim()) profile.answers.officeMetro = DEFAULT_PROFILE.answers.officeMetro;
  // Securities licenses / registrations (FINRA, SIE, Series exams): a real default, None.
  if (!profile.answers.securitiesLicenses?.trim()) profile.answers.securitiesLicenses = "None";
  // Migrate the old single phone type ("Mobile") to the ordered fallback list.
  if (!profile.phoneType || /^mobile$/i.test(profile.phoneType.trim())) profile.phoneType = DEFAULT_PROFILE.phoneType;
  // Migrate languages saved before the combined/general proficiency existed.
  for (const l of profile.languages || []) {
    const def = DEFAULT_PROFILE.languages.find((d) => d.name.toLowerCase() === (l.name || "").toLowerCase());
    if (l.general == null && def) {
      l.general = def.general;
      l.generalReview = !!def.generalReview;
    }
  }
  settings = { ...DEFAULT_SETTINGS, ...(s.settings || {}) };
  learned = s.learned || [];
  learnedDeleted = RULES.pruneDeleted(s.learnedDeleted);
  document.querySelectorAll("[data-k]").forEach((el) => (el.value = getPath(profile, el.dataset.k) ?? ""));
  // Default on: a blank setting shows (and saves) Yes.
  if (!$('[data-k="answers.countCurrentIntern"]').value) $('[data-k="answers.countCurrentIntern"]').value = "Yes";
  renderRoleInterests();
  $("#threshold").value = settings.threshold;
  $("#notifyDone").checked = settings.notifyDone !== false;
  $("#cleanParsedPanels").checked = settings.cleanParsedPanels !== false;
  $("#learnNoReview").checked = !!settings.learnNoReview;
  renderList("#experiences", "#expTpl", profile.experiences);
  renderList("#education", "#eduTpl", profile.education);
  renderList("#languages", "#langTpl", profile.languages || []);
  renderLearned();
  renderSkillMisses();
  renderDeleted();
  $("#resumeName").textContent = s.resumeFile ? `Saved: ${s.resumeFile.name}` : "No resume saved yet";
}

// Role interests: a fixed checklist of standard areas (shared/prefmap.js), empty by default.
function renderRoleInterests() {
  const box = $("#roleInterests");
  const mine = Array.isArray(profile.roleInterests) ? profile.roleInterests : [];
  box.textContent = "";
  for (const area of globalThis.AAF_PREFMAP?.ROLE_AREAS || []) {
    const label = document.createElement("label");
    label.style.cssText = "display:flex;gap:6px;align-items:center;flex-direction:row";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = area;
    cb.checked = mine.includes(area);
    label.append(cb, area);
    box.appendChild(label);
  }
}

async function save() {
  const grad = $('[data-k="expectedGraduation"]').value.trim();
  if (grad && !/^\d{1,2}\/(\d{1,2}\/)?\d{4}$/.test(grad)) {
    $("#saved").textContent = "Not saved: expected graduation date must be MM/DD/YYYY or MM/YYYY";
    return;
  }
  const birth = $('[data-k="eeo.birthMonth"]').value.trim();
  if (birth && !/^(0?[1-9]|1[0-2])\/\d{4}$/.test(birth)) {
    $("#saved").textContent = "Not saved: birth month / year must be MM/YYYY";
    return;
  }
  document.querySelectorAll("[data-k]").forEach((el) => setPath(profile, el.dataset.k, el.value.trim()));
  if (profile.eeo) delete profile.eeo.ageRange; // replaced by Birth month / year
  profile.experiences = readList("#experiences");
  profile.education = readList("#education");
  profile.languages = readList("#languages");
  profile.roleInterests = [...document.querySelectorAll("#roleInterests input:checked")].map((el) => el.value);
  settings.threshold = Math.min(1, Math.max(0, parseFloat($("#threshold").value) || 0.75));
  settings.notifyDone = $("#notifyDone").checked;
  settings.cleanParsedPanels = $("#cleanParsedPanels").checked;
  settings.learnNoReview = $("#learnNoReview").checked;
  learned = learned.filter((x) => x.a !== "");
  await chrome.storage.local.set({ profile, settings, learned });
  $("#saved").textContent = "Saved";
  setTimeout(() => ($("#saved").textContent = ""), 2000);
}

$("#addExp").addEventListener("click", () => addCard($("#experiences"), "#expTpl"));
$("#addEdu").addEventListener("click", () => addCard($("#education"), "#eduTpl"));
$("#addLang").addEventListener("click", () => addCard($("#languages"), "#langTpl"));
$("#save").addEventListener("click", save);
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "s") {
    e.preventDefault();
    save();
  }
});

$("#resumeFile").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const r = new FileReader();
  r.onload = async () => {
    await chrome.storage.local.set({ resumeFile: { name: file.name, type: file.type, dataUrl: r.result } });
    $("#resumeName").textContent = `Saved: ${file.name}`;
  };
  r.readAsDataURL(file);
});

$("#export").addEventListener("click", async () => {
  await save();
  const data = await chrome.storage.local.get(["profile", "settings", "learned"]);
  if (data.profile?.api) data.profile.api.key = ""; // don't put the key in backups
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: "application-autofill-backup.json" });
  a.click();
  URL.revokeObjectURL(url);
});

$("#import").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const cur = await chrome.storage.local.get("profile");
    if (data.profile && !data.profile.api?.key && cur.profile?.api?.key) data.profile.api.key = cur.profile.api.key;
    await chrome.storage.local.set(data);
    // An older backup can contain learned entries the guards now forbid (passwords, dates): purge now.
    await chrome.runtime.sendMessage({ type: "PURGE_LEARNED" }).catch(() => {});
    await load();
    $("#saved").textContent = "Imported";
  } catch {
    alert("That file isn't a valid backup.");
  }
});

load();
