// Store screenshot source (fake data, fictional companies): a chrome.storage stub for options.html, loaded by the
// screenshot build page before options.js (tools/screenshots.ps1). window.__shot = "options" (the top of the page) or
// "learned" (only the Learned answers section is shown).
(() => {
  const now = Date.now();
  const STORE = {
    profile: {
      firstName: "Test", lastName: "Applicant", preferredName: "Tess", email: "test@example.com", phone: "6465550100",
      phoneType: "Mobile | Cell | Cellular | Cell Phone | Mobile Phone | Home Cellular | Personal Cell | Personal Mobile",
      phoneCountry: "United States of America",
      address1: "1 Test Street", address2: "Apt 4B", city: "Springfield", state: "New York", zip: "10001", country: "United States of America",
      applicationLocation: { search: "New York", matches: "New York, NY | New York, NY, USA | New York City, New York, United States" },
      source: "LinkedIn | Social Media | Job Board", hearText: "LinkedIn",
      linkedin: "https://www.linkedin.com/in/test-applicant", github: "https://github.com/test-applicant", website: "https://test-applicant.example.com",
      resumeText: "Test Applicant\nSoftware Engineer Intern, Contoso (Jun 2026 - Aug 2026): built an internal deploy CLI used by three teams.\nAI Engineer Intern, Northwind (Jun 2025 - Aug 2025): evaluation harness for a retrieval pipeline.\nLakeview University, B.E. Computer Engineering, expected May 2027.",
      extraNotes: "Open to hybrid roles in New York. Available for a summer 2027 internship.",
      projectsHighlight: "Deploy CLI: shipping tools other engineers use every day\nRecipe Planner: a full-stack side project with real users",
      linkedinText: "Computer engineering student at Lakeview University (class of 2027). Internships at Contoso and Northwind.",
      experiences: [
        { title: "Software Engineer Intern", company: "Contoso", location: "New York, NY", current: false, startMonth: "6", startYear: "2026", endMonth: "8", endYear: "2026", description: "Built an internal deploy CLI used by three teams." },
        { title: "AI Engineer Intern", company: "Northwind", location: "Riverton, NJ", current: false, startMonth: "6", startYear: "2025", endMonth: "8", endYear: "2025", description: "Evaluation harness for a retrieval pipeline." },
      ],
      education: [{ school: "Lakeview University", schoolAliases: "LSU Lakeview University", schoolSearch: "Lakeview", degreeOptions: "Bachelor of Engineering | BEng | B.E. | BE\nBachelor's Degree | Bachelor's | Bachelors | Bachelor Degree\nBachelor of Science | BS | B.S. | BSc\nUndergraduate", field: "Computer Engineering", fieldFallbacks: "Computer Engineering | Electrical & Computer Engineering | Computer Science", gpa: "3.8", startMonth: "8", startYear: "2023", endYear: "2027" }],
      expectedGraduation: "05/21/2027",
      languages: [{ name: "Italian", aliases: "Italiano", fluent: false, comprehension: "Intermediate | Basic", overall: "Intermediate | Basic", reading: "Basic", speaking: "Intermediate | Basic", writing: "Basic", general: "Intermediate | Basic" }],
      skills: "Python, TypeScript, React, PostgreSQL, Docker, Git",
      roleInterests: ["Backend", "Infrastructure / Platform", "AI / ML"],
      answers: { workAuth: "Yes", sponsorship: "No", over18: "Yes", citizen: "Yes", usPerson: "Yes", relocate: "Yes", clearance: "No", travel: "Maximum", restrictions: "None", previousEmployers: "", officeMetro: "New York City | NYC | Brooklyn | Jersey City | Hoboken", employmentType: "Internship", interviewLanguage: "Python", securitiesLicenses: "None", restrictiveAgreements: "None", govEmployee: "No", armedForces: "No", militarySpouse: "No", foreignOfficial: "No", govProjects: "Yes", countCurrentIntern: "Yes" },
      eeo: { gender: "", hispanic: "", race: "", racePrefs: "", veteran: "I am not a protected veteran|I am not a veteran|not a veteran", disability: "", lgbtq: "", transgender: "", lgbtqMember: "", birthMonth: "", communities: "" },
      api: { key: "sk-ant-api03-example-key-not-real", model: "claude-haiku-5-5", draftModel: "claude-sonnet-5-5" },
    },
    settings: { useAI: true, learn: true, drafts: true, threshold: 0.75, notifyDone: true, learnNoReview: false, cleanParsedPanels: true },
    learned: [
      { q: "Do you have any relatives employed by Kestrel Labs?", a: "No", type: "radio", pending: true, company: "kestrel labs", at: now - 3600e3 },
      { q: "Have you previously applied to Kestrel Labs?", a: "No", type: "dropdown", pending: true, company: "kestrel labs", at: now - 3600e3 },
      { q: "Have you personally built and deployed a machine learning model?", a: "Yes", type: "radio", pending: true, at: now - 3500e3 },
      { q: "Do you know anyone who currently works at Wrenly?", a: "No", type: "radio", company: "wrenly", at: now - 4 * 864e5 },
      { q: "Are you a current Nimbus customer?", a: "No", type: "radio", company: "nimbus", at: now - 9 * 864e5 },
      { q: "What is your T-shirt size?", a: "M", type: "dropdown", at: now - 12 * 864e5 },
    ],
    learnedDeleted: [
      { q: "When is the earliest you could start?", a: "June 2027", type: "text", deletedAt: now - 2 * 864e5, reason: "removed automatically (start date / availability)" },
      { q: "What are your salary expectations?", a: "Open to discussion", type: "text", deletedAt: now - 5 * 864e5, reason: "removed automatically (compensation)" },
    ],
    resumeFile: { name: "Test_Applicant_Resume.pdf", type: "application/pdf", dataUrl: "data:application/pdf;base64,JVBERi0xLjQK" },
  };
  window.chrome = {
    storage: {
      local: {
        get: async (keys) => {
          const ks = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys || {});
          const out = {};
          for (const k of ks) if (STORE[k] !== undefined) out[k] = JSON.parse(JSON.stringify(STORE[k]));
          return out;
        },
        set: async (o) => Object.assign(STORE, o),
      },
      onChanged: { addListener: () => {} },
    },
    runtime: { id: "screenshot", sendMessage: async () => ({}), openOptionsPage: () => {} },
  };
  // The learned-answers shot: only that section (and the title), so it sits at the top of the viewport.
  if (window.__shot === "learned") {
    document.addEventListener("DOMContentLoaded", () => {
      for (const s of document.querySelectorAll("main > section")) if (!s.querySelector("#learnedPending")) s.style.display = "none";
      const hint = document.querySelector("main > p.hint");
      if (hint) hint.textContent = "Answers you gave to questions the extension skipped. Reviewed by you before they are reused, scoped to the company a question names, and never learned for pay, availability, EEO or attestations.";
    });
  }
})();
