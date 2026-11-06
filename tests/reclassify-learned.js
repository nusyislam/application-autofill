// Read-only re-check of learned answers saved while the learning classifier was down (temperature 400s, 33c93d4 to
// 915478e: 2026-10-26 to 2026-11-01). Run by hand, never by run.ps1:
//   1. Options > Export backup (the key is left out of the file).
//   2. PowerShell: $env:ANTHROPIC_API_KEY = "sk-ant-..."; node tests\reclassify-learned.js <backup.json> [--from 2026-10-26] [--to 2026-11-01]
// For every learned entry (pending and approved) whose `updated` date falls in the window, it prints the category
// Options shows now (the patterns, shared/learnrules.js), whether the patterns block it, what was stored from the
// classifier (`classified`), and the classifier's verdict now (one real Haiku call for the batch, question text only,
// with an empty cache). Nothing is moved, deleted or written: neither the backup nor the extension's storage.
const fs = require("fs");
const { loadBackground } = require("./lib-bg");

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--") && !/^\d{4}-\d\d-\d\d$/.test(a));
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };
const key = process.env.ANTHROPIC_API_KEY;
if (!file || !key) {
  console.log("usage: set ANTHROPIC_API_KEY, then node tests/reclassify-learned.js <backup.json> [--from YYYY-MM-DD] [--to YYYY-MM-DD]");
  process.exit(2);
}
const day = (s, end) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d + (end ? 1 : 0)).getTime(); };
const from = day(opt("from", "2026-10-26"));
const to = day(opt("to", "2026-11-01"), true); // through the end of that day, local time

const backup = JSON.parse(fs.readFileSync(file, "utf8"));
const learned = backup.learned || [];
const inWindow = learned.filter((x) => Number(x.updated) >= from && Number(x.updated) < to);
const undated = learned.filter((x) => !x.updated).length;

// The worker with an empty learned list (so its start-up purge has nothing to touch) and an empty classifier cache.
const store = { profile: { ...(backup.profile || {}), api: { ...(backup.profile?.api || {}), key } }, settings: { ...(backup.settings || {}), useAI: true }, learned: [], learnClassCache: {} };
const statuses = [];
const bg = loadBackground({ store, fetch: async (url, init) => { const r = await fetch(url, init); statuses.push(r.status); return r; } });
const R = bg.AAF_LEARN_RULES;

(async () => {
  // Company scopes the next start will repair (any date): "bank of" -> "bank of fictionland", "official" -> general.
  const fixes = learned.map((x) => [x, R.scopeFix(x)]).filter(([, f]) => f);
  console.log(`== company scopes the next start will repair: ${fixes.length}${fixes.map(([x, f]) => `\n"${String(x.q).slice(0, 110)}"\n   "${f.from}" -> ${f.to ? `"${f.to}"` : "general (not a company)"}`).join("")}\n`);
  console.log(`backup: ${learned.length} learned entries; ${inWindow.length} saved from ${opt("from", "2026-10-26")} to ${opt("to", "2026-11-01")}${undated ? `; ${undated} have no date (not checked)` : ""}`);
  if (!inWindow.length) return;
  const res = await bg.classifyQuestions(inWindow.map((x) => x.q));
  if (res.error) { console.log(`classifier: ERROR ${res.error} (HTTP ${statuses.join(", ") || "-"})`); process.exit(1); }
  console.log(`classifier: ${res.model}, HTTP ${statuses.join(", ")}\n`);
  const blockedNow = [];
  const changed = [];
  const same = [];
  for (const x of inWindow) {
    const pat = R.entryCategory(x);
    const verdict = res.categories[String(x.q).trim()] || "(no verdict)";
    const before = x.classified || "not classified (classifier was down)";
    const line = [
      `"${String(x.q).slice(0, 110)}" = "${String(x.a).slice(0, 60)}"`,
      `   ${x.pending ? "pending" : "approved"}${x.company ? `, only for ${x.company}` : ""}, saved ${new Date(Number(x.updated)).toLocaleDateString("en-CA")}`, // local YYYY-MM-DD, like the window
      `   Options category now: ${pat.category}${pat.blocked ? " (BLOCKED by the patterns)" : ""}${x.category ? ` (picked by you: ${x.category})` : ""}`,
      `   classifier then: ${before}; now: ${verdict}`,
    ].join("\n");
    const classifierBlocks = verdict !== "general" && verdict !== "(no verdict)";
    if (pat.blocked || classifierBlocks) blockedNow.push(`${line}\n   -> would be blocked${pat.blocked ? ` by the patterns (${pat.category})` : ""}${classifierBlocks ? `${pat.blocked ? " and" : ""} by the classifier (${verdict})` : ""}`);
    else if (x.classified && x.classified !== verdict) changed.push(`${line}\n   -> classifier verdict changes: ${x.classified} -> ${verdict}`);
    else same.push(line);
  }
  console.log(`== would now be blocked (never learned): ${blockedNow.length}\n${blockedNow.join("\n\n")}\n`);
  console.log(`== classifier verdict changes, still allowed: ${changed.length}\n${changed.join("\n\n")}\n`);
  console.log(`== unchanged, still allowed: ${same.length}\n${same.join("\n\n")}\n`);
  console.log("Nothing was moved or written. Confirm in chat before anything is changed.");
})();
