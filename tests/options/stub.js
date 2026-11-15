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
    resume: { onboarding: { step: 3 } },
    skipped: { onboarding: { finished: true, how: "skipped" } },
    pdf: {},
    next: {},
    done: { profile: { firstName: "Test", lastName: "Applicant", email: "test@example.com", answers: { workAuth: "Yes" } }, onboarding: { step: 7 } },
    "clear-default": full(),
    "clear-ticked": full(),
    "clear-cancel": full(),
    "clear-export": full(),
  };
  const store = structuredClone(SEEDS[scenario] || {});
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
  window.chrome = {
    runtime: { id: "test", sendMessage: async () => ({}), getManifest: () => ({ version: "test" }) },
    storage: {
      local: {
        get: async (keys) => pick(keys),
        set: async (obj) => void Object.assign(store, structuredClone(obj)),
        remove: async (keys) => void [].concat(keys).forEach((k) => delete store[k]),
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
