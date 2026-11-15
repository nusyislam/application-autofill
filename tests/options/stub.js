// Options-page tests (tests/options/run.js): a chrome.* stub loaded before options.js. The storage is seeded from
// the scenario named in the URL (?s=<name>); window.__store is the storage itself, so the driver can read what was
// saved. Fake data only. Download links (the backup export) are recorded in window.__downloads, not followed.
(() => {
  const scenario = new URLSearchParams(location.search).get("s") || "";
  const FILLED = {
    firstName: "Test", lastName: "Applicant", email: "test@example.com", phone: "6465550100",
    address1: "1 Test Street", city: "Springfield", state: "New York", zip: "10001",
    linkedin: "https://www.linkedin.com/in/test-applicant", resumeText: "Test Applicant, Lakeview University",
    experiences: [{ title: "Software Engineer Intern", company: "Contoso", location: "New York, NY", current: false, startMonth: "6", startYear: "2026", endMonth: "8", endYear: "2026", description: "" }],
    education: [{ school: "Lakeview University", schoolAliases: "", schoolSearch: "Lakeview", degreeOptions: "Bachelor of Engineering", field: "Computer Engineering", fieldFallbacks: "", gpa: "", startYear: "2023", endYear: "2027" }],
    expectedGraduation: "05/21/2027",
    answers: { workAuth: "Yes", sponsorship: "No", over18: "Yes", citizen: "Yes", usPerson: "Yes", relocate: "Yes", clearance: "No", travel: "Maximum", restrictions: "None" },
    api: { key: "sk-ant-test-not-a-real-key", model: "claude-haiku-5-5", draftModel: "claude-sonnet-5-5" },
  };
  const LEARNED = [{ q: "What is your T-shirt size?", a: "M", type: "dropdown", at: 1 }];
  const DELETED = [{ q: "Favorite color?", a: "Blue", type: "text", at: 1, deletedAt: Date.now(), reason: "deleted by you" }];
  const RESUME = { name: "fake-resume.pdf", type: "application/pdf", dataUrl: "data:application/pdf;base64,JVBERi0=" };
  const full = () => ({ profile: structuredClone(FILLED), settings: { useAI: true }, learned: structuredClone(LEARNED), learnedDeleted: structuredClone(DELETED), resumeFile: RESUME, onboarding: { finished: true, how: "done" } });
  const SEEDS = {
    empty: {},
    filled: { profile: structuredClone(FILLED), resumeFile: RESUME },
    // Only the API settings saved (what Clear leaves): still an empty profile.
    "api-only": { profile: { api: { key: "sk-ant-test-not-a-real-key" } } },
    resume: { onboarding: { step: 4 } },
    skipped: { onboarding: { finished: true, how: "skipped" } },
    pdf: {},
    next: {},
    done: { profile: { firstName: "Test", lastName: "Applicant", email: "test@example.com", answers: { workAuth: "Yes" } }, onboarding: { step: 7 } },
    "clear-default": full(),
    "clear-ticked": full(),
    "clear-cancel": full(),
    "clear-export": full(),
    "reload-setup": {},
    "reload-outside": { profile: structuredClone(FILLED), resumeFile: RESUME },
    "leave-warns": { profile: structuredClone(FILLED), resumeFile: RESUME },
    "prefill-setup": {},
    "prefill-nokey": {},
    "prefill-existing": { profile: structuredClone(FILLED), resumeFile: RESUME, onboarding: { finished: true, how: "done" } },
  };
  // The storage survives a reload of the page (sessionStorage), like chrome.storage does: the reload scenarios check
  // what was saved before it.
  const kept = sessionStorage.getItem("__aafStore");
  const store = kept ? JSON.parse(kept) : structuredClone(SEEDS[scenario] || {});
  const persist = () => sessionStorage.setItem("__aafStore", JSON.stringify(store));
  persist();
  window.__store = store;
  window.__scenario = scenario;
  const pick = (keys) => {
    if (keys == null) return structuredClone(store);
    const list = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
    const out = {};
    for (const k of list) {
      if (k in store) out[k] = structuredClone(store[k]);
      else if (keys && typeof keys === "object" && !Array.isArray(keys)) out[k] = keys[k];
    }
    return out;
  };
  // The setup prefill's Claude reply (background.js PREFILL), as the fake PDFs read: three real jobs plus the current
  // one, and two things that are NOT in the texts (an invented job and an invented bullet: both must be dropped), and
  // Contoso starting in May on LinkedIn but June on the resume (a conflict to flag).
  const PREFILL = {
    resume: {
      experience: [
        { company: "Contoso", title: "Software Engineer Intern", location: "New York, NY", start: { month: 6, year: 2026 }, end: { month: 8, year: 2026 }, current: false, bullets: ["Built an internal deploy CLI used by three teams to ship services, cutting release time from two hours to fifteen minutes across staging and production.", "Wrote retrieval quality checks, labeling guidelines and the first set of offline ranking evals. Most regressions were then caught before code review, and the shared test suite now runs end-to-end on every pull request.", "Led a team of forty engineers across three continents."] },
        { company: "Northwind", title: "AI Engineer Intern", location: "Riverton, NJ", start: { month: 6, year: 2025 }, end: { month: 8, year: 2025 }, current: false, bullets: ["Built a retrieval evaluation harness and a citation checker for the support pilot, so that every generated answer quoted its sources and followed the strict evidence rules that the compliance reviewers set."] },
        { company: "Lakeview Research Group", title: "Research Assistant", location: null, start: null, end: null, current: false, bullets: ["Ran ablations on chunk size and reranking for a campus search prototype, and wrote the weekly summaries the lab used to plan the next round of experiments and the quarterly grant reports to the department."] },
        { company: "Lakeview University", title: "Teaching Assistant", location: "Springfield, NY", start: { month: 9, year: 2025 }, end: null, current: true, bullets: ["Held weekly office hours for an introductory programming course and graded labs."] },
        { company: "Quantum Widgets", title: "Chief Technology Officer", location: "Remote", start: { month: 1, year: 2020 }, end: { month: 12, year: 2022 }, current: false, bullets: ["Scaled the platform to ten million users."] },
      ],
      education: [
        { school: "Lakeview University", degree: "B.E.", field: "Computer Engineering", start: null, end: { month: 5, year: 2027 }, inProgress: true },
        { school: "Litware Online Academy", degree: "Online Certification in Data Analytics", field: null, start: { month: 3, year: 2024 }, end: { month: 6, year: 2024 }, inProgress: false },
        { school: "Lakeview Research Group", degree: "Summer Research Fellowship", field: null, start: null, end: { month: null, year: 2025 }, inProgress: false },
      ],
      languages: [],
      certifications: [],
    },
    linkedin: {
      experience: [
        { company: "Northwind", title: "AI Engineer Intern", location: "Riverton, New Jersey, United States", start: { month: 6, year: 2025 }, end: { month: 8, year: 2025 }, current: false, bullets: ["Built an evaluation harness for a retrieval pipeline and replaced the weekly manual spot checks and ad hoc queries with one shared, nightly end-to-end regression report that the search team reviewed every morning.", "Cut the nightly report runtime from forty minutes to six.", "Wrote the on-call runbook for the evaluation jobs.", "Presented the results to the search team leads."] },
        { company: "Contoso", title: "Software Engineer Intern", location: "New York, New York, United States", start: { month: 5, year: 2026 }, end: { month: 8, year: 2026 }, current: false, bullets: [] },
        { company: "Fabrikam", title: "Volunteer Tutor", location: "Springfield, New York, United States", start: { month: 1, year: 2024 }, end: { month: 5, year: 2024 }, current: false, bullets: ["Tutored first-year students in introductory programming twice a week."] },
      ],
      education: [{ school: "Lakeview University", degree: "Bachelor of Engineering - BE", field: "Computer Engineering", start: { month: 8, year: 2023 }, end: { month: 5, year: 2027 }, inProgress: true }],
      languages: [{ name: "Italian", proficiency: "Elementary" }, { name: "Spanish", proficiency: "Native or Bilingual" }],
      certifications: ["Fake Cloud Practitioner"],
    },
  };
  window.__messages = JSON.parse(sessionStorage.getItem("__aafMessages") || "[]");
  const sendMessage = async (msg) => {
    window.__messages.push({ type: msg?.type, resumeChars: (msg?.resumeText || "").length, linkedinChars: (msg?.linkedinText || "").length, resumeHasContoso: /Contoso/.test(msg?.resumeText || ""), linkedinHasNorthwind: /Northwind/.test(msg?.linkedinText || "") });
    sessionStorage.setItem("__aafMessages", JSON.stringify(window.__messages));
    if (msg?.type === "PREFILL") return { model: "claude-sonnet-5-5", answers: [{ id: 0, answer: structuredClone(PREFILL) }] };
    return {};
  };
  window.chrome = {
    runtime: { id: "test", sendMessage, getManifest: () => ({ version: "test" }) },
    storage: {
      local: {
        get: async (keys) => pick(keys),
        set: async (obj) => void (Object.assign(store, structuredClone(obj)), persist()),
        remove: async (keys) => void ([].concat(keys).forEach((k) => delete store[k]), persist()),
      },
    },
  };
  window.__downloads = [];
  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (this.download) return void window.__downloads.push(this.download);
    return click.call(this);
  };
})();
