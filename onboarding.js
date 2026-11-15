// First-run setup guide for the Options page (loaded after options.js; uses its $, save, load and `profile`).
// One step at a time over the REAL sections of the page (each <section data-step="..."> belongs to a step); the other
// sections are hidden while the guide is open. Shown automatically the first time Options opens with an empty
// profile; "Run setup again" restarts it, "Skip setup" ends it. Progress is kept in chrome.storage.local
// `onboarding` ({ step } while open, { finished, how } after), so closing the tab resumes at the same step.
// While the guide is open, options.js saves every change on its own (500 ms after the last edit, at once after a PDF's
// text), so a reload resumes the step with everything kept; Next saves too and moves on.
(() => {
  const STEPS = [
    {
      id: "materials",
      title: "Resume and LinkedIn",
      text: [
        "Choose the resume file applications should get (PDF, DOC or DOCX). If it's a PDF, its text is read right here, in this browser, into Resume text.",
        "Then, on your LinkedIn profile, choose More > Save to PDF and upload that PDF below: its text goes into LinkedIn profile (text). Only the text is kept, never the LinkedIn file.",
        "Nothing is uploaded anywhere. Check the text and fix anything that came out wrong. During setup, everything you enter is saved as you go.",
      ],
    },
    {
      id: "api",
      title: "Claude API key (optional)",
      text: [
        "Optional. With a key, Claude reads your resume and LinkedIn text into the next steps (work history, education, languages) as suggestions for you to accept, and later answers application questions no built-in rule answers and drafts open-ended answers for you to review.",
        "It uses your own Anthropic API key (bring your own key, from console.anthropic.com), so requests are billed to your Anthropic account. Requests go straight from this browser to api.anthropic.com; there is no other server.",
        "What a request can contain: your resume and LinkedIn text (for these suggestions and for drafts), the unanswered questions and their options, the job description, a summary of your profile and your notes. Never sent: self-identification answers, attestations, pay, passwords and other sensitive fields, and the resume file itself.",
        "Without a key everything else still works: your contact details, links and skills are still suggested from the text, and you fill in the rest.",
      ],
    },    {
      id: "contact",
      title: "Contact info and links",
      text: [
        "Your name, email, phone and address, as applications should get them, and your LinkedIn, GitHub and website links.",
        "The application location fields decide what's picked in Location dropdowns; leave them blank and those questions are left for you.",
      ],
    },
    {
      id: "work",
      title: "Work experience and skills",
      text: ["One card per job, most recent first. Months as numbers (1-12). Tick \"I currently work here\" for a job you still have. Then your skills (searched in Workday's skills box) and certifications."],
    },
    {
      id: "education",
      title: "Education and languages",
      text: ["Your school, the degree wordings in order of preference, your field of study, and your expected graduation date (MM/DD/YYYY or MM/YYYY). Then the languages you speak, if any."],
    },
    {
      id: "answers",
      title: "Work authorization and fixed answers",
      text: [
        "Work authorization, sponsorship, relocation, clearance, travel and your government / military history.",
        "These are only ever filled from here, never guessed by AI. Blank = the question is left for you on every form.",
      ],
    },
    {
      id: "eeo",
      title: "Self-identification (optional)",
      text: [
        "Optional. Gender, race, veteran, disability and similar questions are filled only from these settings, and are never sent to Claude.",
        "Leaving them blank is fine: those questions are then left for you. Use Skip step if you'd rather not.",
      ],
    },
    { id: "done", title: "Done", text: ["Here's what's filled and what's still blank. Blank fields aren't a problem: those questions are left for you on forms. You can change anything on this page later."] },
  ];

  // Prefill from the resume / LinkedIn text (prefill.js registers it): called after the API key step's Next has saved
  // (so the key, if any, is known), with the saved texts, before the contact step is shown.
  const hooks = { afterMaterials: null };

  let step = -1;
  const ix = (id) => STEPS.findIndex((s) => s.id === id);
  const $ = (s) => document.querySelector(s);
  const store = (v) => chrome.storage.local.set({ onboarding: v });

  // Empty = nothing of the user's own saved yet (the defaults Options fills in don't count; the API settings don't either).
  function profileIsEmpty(p, resumeFile) {
    if (resumeFile) return false;
    if (!p) return true;
    const own = ["firstName", "lastName", "preferredName", "email", "phone", "address1", "city", "zip", "linkedin", "github", "website", "resumeText", "linkedinText", "extraNotes", "skills", "expectedGraduation"];
    if (own.some((k) => String(p[k] || "").trim())) return false;
    if ((p.experiences || []).some((e) => (e.title || e.company || "").trim())) return false;
    if ((p.education || []).some((e) => (e.school || "").trim())) return false;
    return true;
  }

  function para(t) {
    const el = document.createElement("p");
    el.textContent = t;
    return el;
  }

  async function summary() {
    const { resumeFile } = await chrome.storage.local.get("resumeFile");
    const p = profile;
    const a = p.answers || {};
    const e = p.eeo || {};
    const has = (v) => !!String(v || "").trim();
    const count = (obj, keys) => keys.filter((k) => has(obj[k])).length;
    const jobs = (p.experiences || []).filter((x) => has(x.title) || has(x.company)).length;
    const schools = (p.education || []).filter((x) => has(x.school)).length;
    const fixed = ["workAuth", "sponsorship", "over18", "citizen", "usPerson", "relocate", "clearance"];
    const gov = ["govEmployee", "armedForces", "militarySpouse", "foreignOfficial"];
    const eeo = ["gender", "hispanic", "race", "veteran", "disability"];
    const chars = (s) => `${String(s || "").trim().length} characters`;
    // Each item: filled (everything it covers is set), partial (some of it), blank (nothing).
    const st = (n, of) => (n >= of ? "filled" : n > 0 ? "partial" : "blank");
    const b = (v) => (v ? "filled" : "blank");
    const addr = ["address1", "city", "state", "zip"];
    return [
      ["Resume file", b(resumeFile), resumeFile?.name || "", ix("materials")],
      ["Resume text", b(has(p.resumeText)), chars(p.resumeText), ix("materials")],
      ["LinkedIn profile text", b(has(p.linkedinText)), chars(p.linkedinText), ix("materials")],
      ["Name", st(count(p, ["firstName", "lastName"]), 2), [p.firstName, p.lastName].filter(has).join(" "), ix("contact")],
      ["Email", b(has(p.email)), p.email, ix("contact")],
      ["Phone", b(has(p.phone)), p.phone, ix("contact")],
      ["Address", st(count(p, addr), addr.length), [p.address1, p.city, p.state, p.zip].filter(has).join(", "), ix("contact")],
      ["LinkedIn URL", b(has(p.linkedin)), "", ix("contact")],
      ["GitHub / website", b(has(p.github) || has(p.website)), "", ix("contact"), true],
      ["Work experience", b(jobs > 0), `${jobs} job${jobs === 1 ? "" : "s"}`, ix("work")],
      ["Education", b(schools > 0), `${schools} school${schools === 1 ? "" : "s"}`, ix("education")],
      ["Expected graduation date", b(has(p.expectedGraduation)), p.expectedGraduation, ix("education"), true],
      ["Work authorization and fixed answers", st(count(a, fixed), fixed.length), `${count(a, fixed)} of ${fixed.length} set`, ix("answers")],
      ["Government / military history", st(count(a, gov), gov.length), `${count(a, gov)} of ${gov.length} set`, ix("answers")],
      ["Self-identification", st(count(e, eeo), eeo.length), `${count(e, eeo)} of ${eeo.length} set`, ix("eeo"), true],
      ["Claude API key", b(has(p.api?.key)), "", ix("api"), true],
    ];
  }

  async function renderBody(s) {
    const body = $("#obBody");
    body.textContent = "";
    s.text.forEach((t) => body.appendChild(para(t)));
    if (s.id !== "done") return;
    const ul = document.createElement("ul");
    ul.className = "summary";
    ul.setAttribute("aria-label", "Setup summary");
    const TAG = { filled: "filled", partial: "partly filled", blank: "blank" };
    for (const [what, state, detail, goto, optional] of await summary()) {
      const filled = state === "filled";
      const li = document.createElement("li");
      li.dataset.item = what;
      li.dataset.state = state;
      const w = document.createElement("span");
      w.className = "what";
      w.textContent = what + (optional ? " (optional)" : "") + (detail ? `: ${detail}` : "");
      const tag = document.createElement("span");
      tag.className = `tag ${state}`;
      tag.textContent = TAG[state];
      li.append(w, tag);
      if (!filled) {
        const b = Object.assign(document.createElement("button"), { type: "button", textContent: "Go to step" });
        b.setAttribute("aria-label", `Go to step ${goto + 1}: ${STEPS[goto].title}`);
        b.addEventListener("click", () => show(goto));
        li.appendChild(b);
      }
      ul.appendChild(li);
    }
    body.appendChild(ul);
  }

  async function show(i, { focus = true } = {}) {
    step = Math.max(0, Math.min(STEPS.length - 1, i));
    const s = STEPS[step];
    document.body.classList.add("onboarding");
    $("#ob").hidden = false;
    document.querySelectorAll("main > section").forEach((sec) => sec.classList.toggle("ob-on", sec.dataset.step === s.id));
    $("#obProgress").textContent = `Setup: step ${step + 1} of ${STEPS.length}`;
    $("#obTitle").textContent = s.title;
    $("#obMsg").textContent = "";
    $("#obBack").disabled = step === 0;
    $("#obSkipStep").hidden = s.id === "done";
    $("#obNext").textContent = s.id === "done" ? "Finish" : "Next";
    await renderBody(s);
    await store({ step });
    window.scrollTo(0, 0);
    if (focus) $("#obTitle").focus();
  }

  async function finish(how) {
    step = -1;
    await store({ finished: true, how, at: Date.now() });
    document.body.classList.remove("onboarding");
    document.querySelectorAll("main > section.ob-on").forEach((sec) => sec.classList.remove("ob-on"));
    $("#ob").hidden = true;
    $("#runSetup").focus();
  }

  async function next() {
    if (step < 0) return;
    if (STEPS[step].id === "done") return finish("done");
    $("#obNext").disabled = true;
    try {
      // Next accepts this step's suggestions from the resume (prefill.js), then saves.
      await globalThis.AAF_PREFILL?.acceptIn([...document.querySelectorAll("main > section.ob-on")]);
      if (!(await save())) {
        $("#obMsg").className = "status err";
        $("#obMsg").textContent = "Not saved: fix the value named in the bar below, then Next.";
        return;
      }
      if (STEPS[step].id === "api" && hooks.afterMaterials) {
        $("#obMsg").className = "status";
        $("#obMsg").textContent = "Reading your resume into the form…";
        await hooks.afterMaterials({ resumeText: profile.resumeText || "", linkedinText: profile.linkedinText || "" });
      }
      await show(step + 1);
    } finally {
      $("#obNext").disabled = false;
    }
  }

  // Decides at page load: in progress = resume there; finished or skipped = nothing; never seen + empty profile = start.
  async function maybeStart() {
    const { profile: stored, resumeFile, onboarding } = await chrome.storage.local.get(["profile", "resumeFile", "onboarding"]);
    if (onboarding?.finished) return;
    if (Number.isInteger(onboarding?.step)) return show(onboarding.step, { focus: false });
    if (profileIsEmpty(stored, resumeFile)) return show(0, { focus: false });
  }

  $("#obNext").addEventListener("click", next);
  $("#obBack").addEventListener("click", () => step > 0 && show(step - 1));
  $("#obSkipStep").addEventListener("click", () => step >= 0 && show(step + 1));
  $("#obSkipAll").addEventListener("click", () => finish("skipped"));
  $("#runSetup").addEventListener("click", () => show(0));

  globalThis.AAF_ONBOARDING = { hooks, restart: () => show(0), maybeStart, profileIsEmpty, STEPS };
  optionsReady.then(maybeStart);
})();
