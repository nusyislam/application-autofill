// First-run setup guide for the Options page (loaded after options.js; uses its $, save, load and `profile`).
// One step at a time over the REAL sections of the page (each <section data-step="..."> belongs to a step); the other
// sections are hidden while the guide is open. Shown automatically the first time Options opens with an empty
// profile; "Run setup again" restarts it, "Skip setup" ends it. Progress is kept in chrome.storage.local
// `onboarding` ({ step } while open, { finished, how } after), so closing the tab resumes at the same step.
// Next saves the page (save() in options.js); Back and Skip step don't.
(() => {
  const STEPS = [
    {
      id: "materials",
      title: "Resume and LinkedIn",
      text: [
        "Choose the resume file applications should get (PDF, DOC or DOCX). If it's a PDF, its text is read right here, in this browser, into Resume text.",
        "Then, on your LinkedIn profile, choose More > Save to PDF and upload that PDF below: its text goes into LinkedIn profile (text). Only the text is kept, never the LinkedIn file.",
        "Nothing is uploaded anywhere. Check the text and fix anything that came out wrong.",
      ],
    },
    {
      id: "contact",
      title: "Contact info and links",
      text: [
        "Your name, email, phone and address, as applications should get them, and your LinkedIn, GitHub and website links.",
        "The application location fields decide what's picked in Location dropdowns; leave them blank and those questions are left for you.",
      ],
    },
    {
      id: "work",
      title: "Work experience",
      text: ["One card per job, most recent first. Months as numbers (1-12). Tick \"I currently work here\" for a job you still have."],
    },
    {
      id: "education",
      title: "Education",
      text: ["Your school, the degree wordings in order of preference, your field of study, and your expected graduation date (MM/DD/YYYY or MM/YYYY)."],
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
    {
      id: "api",
      title: "Claude API key (optional)",
      text: [
        "Optional. Claude can answer application questions no built-in rule answers, and draft open-ended answers for you to review.",
        "It uses your own Anthropic API key (bring your own key, from console.anthropic.com), so requests are billed to your Anthropic account. Requests go straight from this browser to api.anthropic.com; there is no other server.",
        "What a request can contain: the unanswered questions and their options, the job description, a summary of your profile and, for drafts, your resume text, LinkedIn text and notes. Never sent: self-identification answers, attestations, pay, passwords and other sensitive fields, and the resume file itself.",
        "Without a key everything else still works; those questions are left for you.",
      ],
    },
    { id: "done", title: "Done", text: ["Here's what's filled and what's still blank. Blank fields aren't a problem: those questions are left for you on forms. You can change anything on this page later."] },
  ];

  // Hook for the rest of the "First-run setup" issue: prefilling profile fields from the resume / LinkedIn text.
  // Called after step 1's Next has saved, with the text boxes' contents; set it to an async function that fills the
  // fields of the later steps (it runs before step 2 is shown). Nothing is registered yet.
  const hooks = { afterMaterials: null };

  let step = -1;
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
    return [
      ["Resume file", !!resumeFile, resumeFile?.name || "", 0],
      ["Resume text", has(p.resumeText), chars(p.resumeText), 0],
      ["LinkedIn profile text", has(p.linkedinText), chars(p.linkedinText), 0],
      ["Name", has(p.firstName) && has(p.lastName), [p.firstName, p.lastName].filter(has).join(" "), 1],
      ["Email", has(p.email), p.email, 1],
      ["Phone", has(p.phone), p.phone, 1],
      ["Address", has(p.address1) && has(p.city) && has(p.zip), [p.city, p.state].filter(has).join(", "), 1],
      ["LinkedIn URL", has(p.linkedin), "", 1],
      ["GitHub / website", has(p.github) || has(p.website), "", 1, true],
      ["Work experience", jobs > 0, `${jobs} job${jobs === 1 ? "" : "s"}`, 2],
      ["Education", schools > 0, `${schools} school${schools === 1 ? "" : "s"}`, 3],
      ["Expected graduation date", has(p.expectedGraduation), p.expectedGraduation, 3, true],
      ["Work authorization and fixed answers", count(a, fixed) === fixed.length, `${count(a, fixed)} of ${fixed.length} set`, 4],
      ["Government / military history", count(a, gov) === gov.length, `${count(a, gov)} of ${gov.length} set`, 4],
      ["Self-identification", count(e, eeo) > 0, `${count(e, eeo)} of ${eeo.length} set`, 5, true],
      ["Claude API key", has(p.api?.key), "", 6, true],
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
    for (const [what, filled, detail, goto, optional] of await summary()) {
      const li = document.createElement("li");
      li.dataset.item = what;
      li.dataset.state = filled ? "filled" : "blank";
      const w = document.createElement("span");
      w.className = "what";
      w.textContent = what + (optional ? " (optional)" : "") + (detail ? `: ${detail}` : "");
      const tag = document.createElement("span");
      tag.className = "tag" + (filled ? " filled" : "");
      tag.textContent = filled ? "filled" : "blank";
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
      if (!(await save())) {
        $("#obMsg").className = "status err";
        $("#obMsg").textContent = "Not saved: fix the value named in the bar below, then Next.";
        return;
      }
      if (STEPS[step].id === "materials" && hooks.afterMaterials) {
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
