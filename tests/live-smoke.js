// Live smoke test of every Claude path in background.js, with real API calls. Run by hand, never by run.ps1:
//   PowerShell: $env:ANTHROPIC_API_KEY = "sk-ant-..."; node tests\live-smoke.js
// One tiny request per path (fake profile, one short question), so a full run costs a few cents at most. Prints
// each path's model and HTTP status, and fails (exit 1) when a path gets an HTTP error, returns an error, or
// Claude's reply can't be parsed. The key is read from the environment only and never printed or saved.
const { loadBackground } = require("./lib-bg");

const key = process.env.ANTHROPIC_API_KEY;
if (!key) { console.log("set ANTHROPIC_API_KEY first (it is never printed or saved)"); process.exit(2); }

const store = {
  profile: {
    firstName: "Test", lastName: "Applicant", email: "test@example.com", city: "Springfield", state: "New York",
    expectedGraduation: "05/2027", skills: "Python",
    resumeText: "Test Applicant. Software Engineer Intern at Examplecorp: built Python data tools.",
    experiences: [{ company: "Examplecorp", title: "Software Engineer Intern" }],
    education: [{ school: "Example University", field: "Computer Engineering" }],
    api: { key, model: "claude-haiku-5-5" },
  },
  settings: { useAI: true, learn: true },
  learned: [],
};
let calls = [];
const bg = loadBackground({
  store,
  fetch: async (url, init) => {
    const r = await fetch(url, init);
    calls.push({ model: JSON.parse(init.body).model, status: r.status });
    return r;
  },
});

const job = { location: "New York, NY", description: "Build developer tools." };
const paths = {
  "question classifier": () => bg.classifyAsk({ questions: [{ id: 1, question: "What is your favorite color?", type: "text" }], site: `smoke-${Date.now()}` }),
  "answers": () => bg.askAI({ questions: [{ id: 1, question: "What is your favorite programming language?", type: "text" }], context: {} }),
  "drafts": () => bg.draftAI({ questions: [{ id: 1, question: "In one sentence, why this role?", type: "textarea" }], job, context: {} }),
  "experience check": () => bg.experienceCheck({ questions: [{ id: 1, question: "Do you have experience with Python?" }] }),
  "meaning mapper": () => bg.mapMeaningAI({ question: "Are you 18 or older?", meaning: "yes", options: ["I am 18 or older", "I am under 18"] }),
  "preference mapper": () => bg.mapPrefs({ question: "Which teams interest you?", options: ["Search & Ranking", "Payroll"], prefs: ["Machine learning"] }),
  "learning classifier": () => bg.classifyQuestions([`What is your favorite color? (${Date.now()})`]),
  "YC note": () => bg.ycNoteAI({ founder: "Alex", company: "Examplecorp", job: { title: "Software Engineer", description: "Developer tools." } }),
};

(async () => {
  let failed = 0;
  for (const [name, fn] of Object.entries(paths)) {
    calls = [];
    let res;
    try { res = await fn(); } catch (e) { res = { error: `threw ${e.message}` }; }
    const http = calls.map((c) => c.status);
    const model = [...new Set(calls.map((c) => c.model))].join(", ") || "-";
    const bad = !calls.length || http.some((s) => s !== 200) || !!res?.error;
    if (bad) failed++;
    const retried = calls.length > 1 ? " (asked again for JSON only)" : "";
    console.log(`${bad ? "FAIL" : "ok  "} ${name.padEnd(20)} model ${model.padEnd(18)} HTTP ${http.join(", ") || "none sent"}${retried}${res?.error ? `  ERROR ${res.error}` : ""}`);
  }
  console.log(failed ? `live smoke: ${failed} of ${Object.keys(paths).length} paths failed` : `live smoke: all ${Object.keys(paths).length} paths OK`);
  process.exit(failed ? 1 : 0);
})();
