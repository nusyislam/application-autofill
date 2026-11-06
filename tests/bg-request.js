// Request-body check for background.js (run by tests/run.ps1, or: node tests/bg-request.js).
// Loads background.js with a stubbed `chrome` and `fetch`, calls every Claude path (answers, drafts, YC note, meaning
// mapper, experience check, question classifier, preference mapper, learning classifier) and fails (exit 1) when a
// request body carries a sampling parameter (temperature / top_p / top_k), which current models reject. Also checks
// that an HTTP 400 is reported as a rejected request, naming the parameter.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.join(__dirname, "..");
const store = {
  profile: { firstName: "Test", lastName: "Applicant", email: "test@example.com", api: { key: "test-key", model: "claude-haiku-5-5" }, experiences: [], education: [] },
  settings: { useAI: true, learn: true },
  learned: [],
};
const bodies = [];
let reply = { status: 200, json: { content: [{ type: "text", text: "[]" }], stop_reason: "end_turn" } };
// Replies to send in order before falling back to `reply` (the cut-off retry check).
const replies = [];

// Any chrome API not stubbed below: a callable proxy whose calls resolve to undefined.
const any = () => new Proxy(function () {}, { get: (t, k) => (k === "then" ? undefined : any()), apply: () => Promise.resolve(undefined) });
const chrome = new Proxy({
  storage: { local: {
    get: async (keys) => {
      const ks = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys || {});
      const out = typeof keys === "object" && !Array.isArray(keys) && keys ? { ...keys } : {};
      for (const k of ks) if (store[k] !== undefined) out[k] = JSON.parse(JSON.stringify(store[k]));
      return out;
    },
    set: async (o) => Object.assign(store, o),
  }, onChanged: any() },
}, { get: (t, k) => (k in t ? t[k] : any()) });

const ctx = {
  chrome, console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout, AbortController, URL, TextEncoder,
  fetch: async (url, init) => {
    bodies.push(JSON.parse(init.body));
    const r = replies.length ? replies.shift() : reply;
    return { ok: r.status < 300, status: r.status, json: async () => r.json };
  },
};
ctx.globalThis = ctx;
ctx.self = ctx;
ctx.importScripts = (...files) => { for (const f of files) vm.runInContext(fs.readFileSync(path.join(root, f), "utf8"), ctx, { filename: f }); };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(root, "background.js"), "utf8"), ctx, { filename: "background.js" });

const calls = {
  "answers (askAI)": () => ctx.askAI({ questions: [{ id: 1, question: "Why this role?" }], context: {} }),
  "drafts (draftAI)": () => ctx.draftAI({ questions: [{ id: 1, question: "Why Acme?" }], job: {}, context: {} }),
  "YC note (ycNoteAI)": () => ctx.ycNoteAI({ founder: "Alex", company: "Acme", job: {} }),
  "meaning mapper (mapMeaningAI)": () => ctx.mapMeaningAI({ question: "Are you 18?", meaning: "yes", options: ["I am 18 or older", "I am not"] }),
  "experience check (experienceCheck)": () => ctx.experienceCheck({ questions: [{ id: 1, question: "Do you have experience with Python?" }] }),
  "question classifier (classifyAsk)": () => ctx.classifyAsk({ questions: [{ id: 1, question: "What is your favorite color?", type: "text" }], site: "test" }),
  "preference mapper (mapPrefs)": () => ctx.mapPrefs({ question: "Which teams?", options: ["Search & Ranking"], prefs: ["Infrastructure"] }),
  "learning classifier (classifyQuestions)": () => ctx.classifyQuestions(["What is your favorite color?"]),
};

const BANNED = ["temperature", "top_p", "top_k"];
(async () => {
  let failed = 0;
  for (const [name, fn] of Object.entries(calls)) {
    const before = bodies.length;
    try { await fn(); } catch (e) { console.log(`FAIL ${name}: threw ${e.message}`); failed++; continue; }
    const sent = bodies.slice(before);
    if (!sent.length) { console.log(`FAIL ${name}: no request was sent`); failed++; continue; }
    const bad = sent.flatMap((b) => BANNED.filter((k) => k in b));
    if (bad.length) { console.log(`FAIL ${name}: request body has ${[...new Set(bad)].join(", ")}`); failed++; }
    else console.log(`ok   ${name}: ${sent.length} request(s), keys ${[...new Set(sent.flatMap(Object.keys))].join(", ")}`);
  }
  // A rejected request (HTTP 400 naming a parameter) is an error that says so, not "unavailable".
  reply = { status: 400, json: { type: "error", error: { type: "invalid_request_error", message: "`temperature` is deprecated for this model." } } };
  const cachesBefore = JSON.stringify([store.askClassCache, store.learnClassCache]);
  const res = await ctx.classifyAsk({ questions: [{ id: 1, question: "Another question?", type: "text" }], site: "test-400" });
  if (/rejected the request \(HTTP 400, a request parameter\): `temperature` is deprecated/.test(res?.error || "")) console.log(`ok   HTTP 400: "${res.error}"`);
  else { console.log(`FAIL HTTP 400: got ${JSON.stringify(res)}`); failed++; }
  // A failed classifier call (either classifier) writes nothing to its cache.
  const lres = await ctx.classifyQuestions(["Another question?"]);
  const cachesAfter = JSON.stringify([store.askClassCache, store.learnClassCache]);
  if (lres?.error && cachesAfter === cachesBefore) console.log("ok   failed classifier calls: both caches unchanged");
  else { console.log(`FAIL failed classifier calls changed a cache: ${cachesBefore} -> ${cachesAfter}`); failed++; }
  // On start, entries that aren't a category are dropped; real ones stay.
  store.askClassCache = { "a|text|good": { c: "other", at: 1 }, "a|text|bad": { c: "unavailable", at: 1 }, "a|text|empty": {}, "steadfast.icims.com|dropdown|degree": { c: "education status", at: 1 }, "steadfast.icims.com|text|major": { c: "education status", at: 1 }, "jobs.ashbyhq.com|radio|what year are you currently in": { c: "education status", at: 1 } };
  store.learnClassCache = { good: "general", bad: "", worse: "unavailable" };
  const dropped = await ctx.cleanClassCaches();
  const ok = dropped === 7 && JSON.stringify(Object.keys(store.askClassCache)) === '["a|text|good"]' && JSON.stringify(store.learnClassCache) === '{"good":"general"}';
  if (ok) console.log("ok   start-up cleanup: dropped 7 entries (not a category, or a fixed education label: Degree / Major / class year), kept the real ones");
  else { console.log(`FAIL start-up cleanup: dropped ${dropped}, left ${JSON.stringify([store.askClassCache, store.learnClassCache])}`); failed++; }
  // On start the purge repairs scopes the old extraction mangled, and records the old one (Options shows it).
  reply = { status: 200, json: { content: [{ type: "text", text: "[]" }], stop_reason: "end_turn" } };
  store.learned = [
    { q: "Do you have any relatives employed by Bank of Fictionland?", a: "No", type: "radio", company: "bank of" },
    { q: "Do you have any relatives employed by B&Q Global?", a: "No", type: "radio", company: "b q global" },
    { q: "Are you an immediate family member of a non-US Government Official?", a: "No", type: "radio", company: "official" },
  ];
  await ctx.purgeLearned();
  const got = store.learned.map((x) => `${x.company || "(general)"}${x.scopeFixed ? ` (was ${x.scopeFixed.from})` : ""}`).join(", ");
  if (got === "bank of fictionland (was bank of), b q global, (general) (was official)") console.log(`ok   scope repair on start: ${got}`);
  else { console.log(`FAIL scope repair on start: ${got}`); failed++; }
  // A profile field learned as an answer (Steadfast: "Email (Please do not use an .edu email address)" = your email,
  // pending) is moved to Recently deleted on start.
  store.learned = [{ q: "Email (Please do not use an .edu email address)", a: "test@example.com", type: "text", company: "steadfast", pending: true }];
  store.learnedDeleted = [];
  await ctx.purgeLearned();
  const del = (store.learnedDeleted || []).find((x) => /\.edu email/.test(x.q));
  if (!store.learned.length && del && /profile field/.test(del.reason)) console.log(`ok   profile-field entry removed on start: "${del.reason}"`);
  else { console.log(`FAIL profile-field entry: learned ${JSON.stringify(store.learned)}, deleted ${JSON.stringify(store.learnedDeleted)}`); failed++; }
  // An AI / tool usage disclosure learned as an answer (Stackline AV: "Application Verification: If LLM assistance ...",
  // pending, shown as "Automatic (other)") is moved to Recently deleted on start.
  store.learned = [{ q: "Application Verification: If LLM assistance or automated tool generation was used in completing this application, please indicate so here.", a: "No", type: "dropdown", pending: true }];
  store.learnedDeleted = [];
  await ctx.purgeLearned();
  const aiDel = (store.learnedDeleted || []).find((x) => /LLM assistance/.test(x.q));
  if (!store.learned.length && aiDel && /AI \/ tool usage disclosure/.test(aiDel.reason)) console.log(`ok   AI-usage disclosure entry removed on start: "${aiDel.reason}"`);
  else { console.log(`FAIL AI-usage disclosure entry: learned ${JSON.stringify(store.learned)}, deleted ${JSON.stringify(store.learnedDeleted)}`); failed++; }
  // The meaning mapper's budget and a reply cut off at max_tokens (Kestrel: 200 tokens cut it off, and the retry carried
  // the truncated reply): sent again as the same request (one user message, the DETAIL line kept, no truncated
  // assistant turn) with four times the room.
  {
    const before = bodies.length;
    replies.push({ status: 200, json: { content: [{ type: "text", text: "[{\"id\": " }], stop_reason: "max_tokens" } });
    replies.push({ status: 200, json: { content: [{ type: "text", text: "[{\"id\": 0}]" }], stop_reason: "end_turn" } });
    const r = await ctx.mapMeaningAI({ question: "Are you based in New York City?", meaning: "yes", detail: "the applicant lives in New York City today (not relocating)", options: ["I live in NYC today", "I'd relocate to NYC"] });
    const [b1, b2] = bodies.slice(before);
    const ok = r?.option === "I live in NYC today" && b1?.max_tokens >= 1024 && b2?.max_tokens === b1.max_tokens * 4 &&
      b2.messages.length === 1 && b2.messages[0].content === b1.messages[0].content && /DETAIL: the applicant lives in New York City/.test(b1.messages[0].content);
    if (ok) console.log(`ok   meaning mapper cut off at max_tokens: sent again as the same request with ${b2.max_tokens} tokens (first ${b1.max_tokens}), the DETAIL kept`);
    else { console.log(`FAIL meaning mapper cut-off retry: ${JSON.stringify({ r, b1: b1 && { max: b1.max_tokens, n: b1.messages.length }, b2: b2 && { max: b2.max_tokens, n: b2.messages.length } })}`); failed++; }
  }
  console.log(failed ? `background request check: ${failed} failed` : "background request check: all passed");
  process.exit(failed ? 1 : 0);
})();
