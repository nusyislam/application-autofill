// Options-page tests (tests/options/run.js): runs the scenario named in the URL (?s=<name>) against the real
// options.html (stub.js seeded the storage) and writes PASS / FAIL lines into <pre id="aaf-report"> between @@BEGIN
// and @@END. Fake data only.
(() => {
  const lines = JSON.parse(sessionStorage.getItem("__aafLines") || "[]"); // lines from before a reload
  const check = (name, ok, detail = "") => lines.push(`${ok ? "PASS" : "FAIL"} ${name}${ok && !detail ? "" : detail ? ` (${detail})` : ""}`);
  const $ = (s) => document.querySelector(s);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 10000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      try {
        if (fn()) return true;
      } catch {}
      await wait(50);
    }
    return false;
  };
  const store = () => window.__store;
  const guideOpen = () => !!$("#ob") && !$("#ob").hidden && document.body.classList.contains("onboarding");
  const title = () => $("#obTitle")?.textContent || "";
  const shown = () => [...document.querySelectorAll("main > section")].filter((s) => getComputedStyle(s).display !== "none").map((s) => s.id || "?").join(",");
  const val = (k) => $(`[data-k="${k}"]`)?.value ?? "(no field)";
  const type = (k, v) => {
    const el = $(`[data-k="${k}"]`);
    el.value = v;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const bytes = (path) =>
    new Promise((res, rej) => {
      const x = new XMLHttpRequest();
      x.open("GET", path);
      x.responseType = "arraybuffer";
      x.onload = () => (x.status === 200 ? res(x.response) : rej(new Error(`HTTP ${x.status} for ${path}`)));
      x.onerror = () => rej(new Error(`can't load ${path}`));
      x.send();
    });
  const upload = async (sel, path, type) => {
    const name = path.split("/").pop();
    const dt = new DataTransfer();
    dt.items.add(new File([await bytes(path)], name, { type }));
    const input = $(sel);
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const click = (sel) => $(sel).click();
  const unsavedShown = () => !!$("#unsaved") && !$("#unsaved").hidden;
  // Would leaving the page ask first? (a beforeunload listener cancelled the event)
  const leaveAsks = () => {
    const e = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(e);
    return e.defaultPrevented;
  };
  const settle = () => wait(300);

  const SCENARIOS = {
    async empty() {
      check("guide opens on an empty profile", guideOpen());
      check("starts at step 1", /step 1 of 8/.test($("#obProgress").textContent) && title() === "Resume and LinkedIn", `${$("#obProgress").textContent} / ${title()}`);
      check("only the step's real section is shown", shown() === "secResume", shown());
      check("the step's fields are the real ones", !!$("#secResume.ob-on #resumeFile") && !!$('#secResume.ob-on [data-k="linkedinText"]') && !!$("#secResume.ob-on #linkedinPdf"));
      check("Back is disabled on step 1", $("#obBack").disabled);
      check("progress saved", store().onboarding?.step === 0, JSON.stringify(store().onboarding));
      check("Walk through setup link present, with its hint", $("#runSetup")?.textContent === "Walk through setup" && $("#runSetupHint")?.textContent === "Your answers are kept. To start over, use Clear fields.");
      check("Suggest fields from my resume is hidden while the setup guide is open", getComputedStyle($("#prefillRow")).display === "none");
      check("Skip setup present", !!$("#obSkipAll") && !$("#obSkipAll").hidden);
    },
    async "api-only"() {
      check("a profile with only the API key counts as empty", guideOpen());
    },
    async filled() {
      check("guide not shown on a filled profile", !guideOpen());
      check("all sections shown", !/^secResume$/.test(shown()) && shown().split(",").length >= 8, shown());
      check("no onboarding state written", !("onboarding" in store()), JSON.stringify(store().onboarding));
      check("Suggest fields from my resume shown outside setup, with its hint", getComputedStyle($("#prefillRow")).display !== "none" && $("#prefillBtn").textContent === "Suggest fields from my resume" && $("#prefillRow .hint").textContent === "Only fills empty fields; you review each suggestion.");
      click("#runSetup");
      await settle();
      check("Walk through setup opens step 1", guideOpen() && title() === "Resume and LinkedIn");
      check("the filled values are still shown", val("email") === "test@example.com");
    },
    async resume() {
      check("resumes at the saved step (5: Education and languages)", guideOpen() && title() === "Education and languages", title());
      check("Education and Languages sections shown", shown() === "secEdu,secLang", shown());
    },
    async skipped() {
      check("a skipped setup doesn't come back on its own", !guideOpen());
    },
    async pdf() {
      await upload("#resumeFile", "tests/options/fake-resume.pdf", "application/pdf");
      const got = await until(() => /Built an internal deploy CLI/.test(val("resumeText")), 15000);
      const rt = val("resumeText");
      lines.push(`INFO resume text:\n${rt.replace(/^/gm, "INFO | ")}`);
      const has = (t, s) => t.split("\n").includes(s);
      check("resume PDF text extracted into Resume text", got, JSON.stringify(rt.slice(0, 80)));
      check("resume: no blank line after every line (never two blank lines)", !/\n\s*\n\s*\n/.test(rt) && rt.split("\n").filter((l) => !l.trim()).length <= 6, `${rt.split("\n").filter((l) => !l.trim()).length} blank lines`);
      check("resume: name and contact lines", /^Test \(Tess\) Applicant\ntest@example\.com \| 646-555-0100 \| Springfield, NY \| github\.com\/test-applicant \| testapplicant\.dev\/portfolio\n/.test(rt));
      check("resume: right-aligned dates / places stay on the title's line", /\nSoftware Engineer Intern \| Jun 2026 – Aug 2026\nContoso \| New York, NY\n/.test(rt) && has(rt, "Lakeview University | Expected May 2027"));
      check("resume: a wrapped bullet is one line (word-by-word pieces spaced)", has(rt, "• Built an internal deploy CLI used by three teams to ship services, cutting release time from two hours to fifteen minutes across staging and production."));
      check("resume: second bullet one line", rt.split("\n").some((l) => /^• Wrote retrieval .* evals\. Most regressions were then caught .* runs end-to-end on every pull request\.$/.test(l)));
      check("resume: no Page N of M footer", !/Page \d+ of \d+/i.test(rt));
      check("resume: entries separated by a blank line", /production\.\n• Wrote/.test(rt) && /semester\n\nTeaching Assistant \| Sep 2025 – Present\n/.test(rt));
      // After a bullet whose last line reaches the right edge, at the normal line spacing:
      check("resume: a bold title with its date is not appended to the bullet before it", /pull request\.\nAI Engineer Intern \| Jun 2025 – Aug 2025\nNorthwind \| Riverton, NJ\n/.test(rt));
      check("resume: a bold title without a date starts its own line", /compliance reviewers set\.\nResearch Assistant\n• Ran ablations/.test(rt));
      check("resume: a plain line back at the left margin starts its own line", /grant reports to the department\.\nLakeview Research Group, part-time during the spring semester\n/.test(rt));
      check("resume: \"Label: list\" lines stay separate (plain and bold labels)", /\nLanguages: Python, .* and PostgreSQL\nFrameworks: Node\.js, .* and NumPy\nTools: Docker, .*, Linux\n/.test(rt));
      check("resume: pieces with no space after a period get one (\"evals.Most\")", /ranking evals\. Most regressions/.test(rt) && !/evals\.Most/.test(rt));
      check("resume: no space added in a decimal, e.g., a link or an email", has(rt, "Notes: version 2.5, e.g.Docker, example.com/Guide, Tess.Applicant@example.com"));
      await until(() => store().resumeFile, 3000);
      check("resume file saved", store().resumeFile?.name === "fake-resume.pdf");
      check("status says it was read here", /Read \d+ characters from fake-resume\.pdf/.test($("#resumeTextStatus").textContent), $("#resumeTextStatus").textContent);
      await upload("#linkedinPdf", "tests/options/fake-linkedin.pdf", "application/pdf");
      const got2 = await until(() => /AI Engineer Intern/.test(val("linkedinText")), 15000);
      const lt = val("linkedinText");
      lines.push(`INFO LinkedIn text:\n${lt.replace(/^/gm, "INFO | ")}`);
      const at = (s) => lt.indexOf(s);
      check("LinkedIn PDF text extracted (both pages)", got2 && /Bachelor of Engineering/.test(lt));
      check("LinkedIn: no Page N of M footers", !/Page \d+ of \d+/i.test(lt));
      check("LinkedIn: never two blank lines in a row", !/\n\s*\n\s*\n/.test(lt));
      check("LinkedIn: main column not interleaved with the sidebar", /^Test Applicant\nComputer Engineering Student at Lakeview University\nSpringfield, New York, United States\n/.test(lt));
      check("LinkedIn: sidebar after all main content (page 2 included)", at("Summary") < at("Bachelor of Engineering") && at("Bachelor of Engineering") < at("Contact") && at("Contact") < at("Top Skills"), `${at("Summary")} ${at("Bachelor of Engineering")} ${at("Contact")} ${at("Top Skills")}`);
      check("LinkedIn: profile link rejoined", lt.includes("\nwww.linkedin.com/in/test-applicant-0a1b2c (LinkedIn)\n"));
      check("LinkedIn: email stays its own line", lt.includes("Contact\ntest@example.com\nwww.linkedin.com"));
      check("LinkedIn: sidebar lists stay one item per line", lt.includes("\nRetrieval-Augmented Generation\nPython\nDocker\ndeployhub.io\n") && lt.includes("(LinkedIn)\ntestapplicant.dev (Personal)\n"));
      check("LinkedIn: wrapped paragraph is one line, joined with a space", lt.split("\n").some((l) => /^Computer engineering student who builds .* offline evals\. Most of them end .* opens\.$/.test(l)));
      check("LinkedIn: a real hyphen kept across a line break", /one shared, nightly end-to-end regression report that the search team reviewed every morning\./.test(lt));
      check("LinkedIn: a list across a page break has no blank line inside", lt.includes("reviewed every morning.\n• Cut the nightly report runtime from forty minutes to six.\n• Wrote the on-call runbook for the evaluation jobs.\n• Presented the results to the search team leads.\n\nContoso\n"));
      check("LinkedIn: headings and entries keep their own lines", lt.includes("\nExperience\nNorthwind\nAI Engineer Intern\nJune 2025 - August 2025 (3 months)\n"));
      check("the LinkedIn PDF file itself is not stored", !Object.keys(store()).some((k) => /linkedin/i.test(k)), Object.keys(store()).join(","));
      // A box with the user's own text is not overwritten: the status offers to replace it.
      type("linkedinText", "My own pasted text");
      await upload("#linkedinPdf", "tests/options/fake-linkedin.pdf", "application/pdf");
      await until(() => /already has text/.test($("#linkedinTextStatus").textContent), 15000);
      check("own text kept, replace offered", val("linkedinText") === "My own pasted text" && !!$("#linkedinTextStatus button"));
      $("#linkedinTextStatus button").click();
      check("replace puts the PDF text in", /AI Engineer Intern/.test(val("linkedinText")));
      await until(() => /AI Engineer Intern/.test(store().profile?.linkedinText || ""), 3000);
      check("extracted texts are saved at once (setup), without Next", /Built an internal deploy CLI/.test(store().profile?.resumeText || "") && /AI Engineer Intern/.test(store().profile?.linkedinText || ""));
    },
    // Setup: extract a PDF and type in a field, reload without Next: the step, the file and the texts are kept. Then
    // Next, type on step 2, reload again: step 2 with the typed value.
    async "reload-setup"() {
      const phase = sessionStorage.getItem("__aafPhase") || "1";
      if (phase === "1") {
        await upload("#resumeFile", "tests/options/fake-resume.pdf", "application/pdf");
        await until(() => /Built an internal deploy CLI/.test(val("resumeText")), 15000);
        type("extraNotes", "Notes typed during setup");
        check("no Unsaved changes note during setup", !unsavedShown());
        await wait(800); // the 500 ms auto-save
        check("nothing unsaved after the auto-save: leaving doesn't ask", !leaveAsks());
        sessionStorage.setItem("__aafPhase", "2");
        return "reload";
      }
      if (phase === "2") {
        check("after a reload: setup resumes on step 1", guideOpen() && title() === "Resume and LinkedIn", title());
        check("after a reload: the resume file is kept", $("#resumeName").textContent === "Saved: fake-resume.pdf", $("#resumeName").textContent);
        check("after a reload: the extracted resume text is kept (no Next)", /Built an internal deploy CLI/.test(val("resumeText")) && /^Test \(Tess\) Applicant\n/.test(val("resumeText")));
        check("after a reload: a typed field is kept (auto-saved)", val("extraNotes") === "Notes typed during setup", JSON.stringify(val("extraNotes")));
        click("#obNext");
        await until(() => title() === "Claude API key (optional)");
        click("#obNext"); // no key: the contact details are suggested from the text
        await until(() => title() === "Contact info and links");
        type("address1", "1 Test Street");
        await wait(800);
        sessionStorage.setItem("__aafPhase", "3");
        return "reload";
      }
      check("after a second reload: setup resumes on the contact step", guideOpen() && title() === "Contact info and links", title());
      check("after a second reload: a value typed without Next is kept", val("address1") === "1 Test Street", JSON.stringify(val("address1")));
      check("and step 1's text too", /Built an internal deploy CLI/.test(val("resumeText")));
      check("suggestions not yet accepted come back after a reload, still unsaved", val("email") === "test@example.com" && $('[data-k="email"]').classList.contains("suggested") && store().profile?.email === "", JSON.stringify(store().profile?.email));
    },
    // Outside setup: an extracted PDF text is saved with it at once (only that box), so a reload keeps it.
    async "reload-outside"() {
      const phase = sessionStorage.getItem("__aafPhase") || "1";
      if (phase === "1") {
        check("setup not shown (filled profile)", !guideOpen());
        await upload("#linkedinPdf", "tests/options/fake-linkedin.pdf", "application/pdf");
        await until(() => /AI Engineer Intern/.test(store().profile?.linkedinText || ""), 15000);
        check("the extracted text alone leaves nothing unsaved", !unsavedShown() && !leaveAsks());
        check("only that box was written (other fields as stored)", store().profile?.email === "test@example.com" && store().profile?.resumeText === "Test Applicant, Lakeview University");
        sessionStorage.setItem("__aafPhase", "2");
        return "reload";
      }
      check("after a reload: the extracted LinkedIn text is kept", /AI Engineer Intern/.test(val("linkedinText")));
    },
    // Outside setup: an edit shows "Unsaved changes" and leaving asks first; Save clears both.
    async "leave-warns"() {
      check("nothing changed: no note, leaving doesn't ask", !unsavedShown() && !leaveAsks());
      type("email", "changed@example.com");
      check("an edit shows Unsaved changes next to Save", unsavedShown() && $("#unsaved").textContent === "Unsaved changes" && $(".bar #unsaved") !== null);
      check("leaving with unsaved changes asks first (beforeunload)", leaveAsks());
      await wait(800);
      check("outside setup nothing is saved on its own", store().profile?.email === "test@example.com");
      click("#save");
      await until(() => store().profile?.email === "changed@example.com");
      check("Save saves and clears the note", store().profile?.email === "changed@example.com" && !unsavedShown() && !leaveAsks());
      click("#addExp");
      check("adding a job card counts as a change", leaveAsks() && unsavedShown());
      click("#save");
      await settle();
      $("#experiences .card:last-child .rm").click();
      check("removing a card counts as a change", leaveAsks());
    },
    async next() {
      type("resumeText", "plain resume text without contact details");
      click("#obNext");
      await until(() => title() === "Claude API key (optional)");
      check("Next saves step 1", store().profile?.resumeText === "plain resume text without contact details", JSON.stringify(store().profile?.resumeText));
      check("step 2 is the API key, explained", title() === "Claude API key (optional)" && shown() === "secApi" && /bring your own key/.test($("#obBody").textContent) && /reads your resume and LinkedIn text into the next steps/.test($("#obBody").textContent), shown());
      check("progress saved as step 2", store().onboarding?.step === 1, JSON.stringify(store().onboarding));
      check("focus moves to the step title", document.activeElement === $("#obTitle"));
      click("#obNext");
      await until(() => title() === "Contact info and links");
      check("step 3 is contact info", shown() === "secInfo", shown());
      type("email", "test@example.com");
      await wait(200);
      check("an edit isn't saved before the 500 ms auto-save delay", store().profile?.email === "", JSON.stringify(store().profile?.email));
      await wait(600);
      check("an edit during setup is auto-saved (no Next)", store().profile?.email === "test@example.com", JSON.stringify(store().profile?.email));
      click("#obBack");
      await settle();
      check("Back goes to step 2", title() === "Claude API key (optional)");
      click("#obNext");
      await until(() => title() === "Contact info and links");
      click("#obNext");
      await until(() => title() === "Work experience and skills");
      check("step 4 is work experience and skills", shown() === "secWork,secSkills", shown());
      check("Next on step 3 saves the email", store().profile?.email === "test@example.com", JSON.stringify(store().profile?.email));
      click("#obSkipStep");
      await settle();
      check("Skip step goes on; step 5 is education and languages", title() === "Education and languages" && shown() === "secEdu,secLang", shown());
      type("expectedGraduation", "May 2027");
      click("#obNext");
      await settle();
      check("an invalid value keeps Next on the step", title() === "Education and languages" && /Not saved/.test($("#obMsg").textContent), `${title()} / ${$("#obMsg").textContent}`);
      type("expectedGraduation", "05/2027");
      click("#obNext");
      await until(() => title() === "Work authorization and fixed answers");
      check("then Next goes on", title() === "Work authorization and fixed answers" && shown() === "secFixed,secGov", shown());
      click("#obSkipStep");
      await settle();
      check("step 7 is self-identification", title() === "Self-identification (optional)" && shown() === "secEeo", shown());
      click("#obSkipStep");
      await settle();
      check("step 8 is Done", title() === "Done");
      click("#obSkipAll");
      await settle();
      check("Skip setup closes the guide", !guideOpen() && shown().split(",").length >= 8);
      check("Skip setup is remembered", store().onboarding?.finished === true && store().onboarding?.how === "skipped", JSON.stringify(store().onboarding));
    },
    async done() {
      await until(() => document.querySelectorAll("#obBody li").length > 5);
      check("step 8 shows a summary", title() === "Done" && shown() === "", `${title()} / ${shown()}`);
      const state = (what) => document.querySelector(`#obBody li[data-item="${what}"]`)?.dataset.state;
      check("summary: filled items", state("Name") === "filled" && state("Email") === "filled", `${state("Name")} ${state("Email")}`);
      check("summary: blank items", state("Phone") === "blank" && state("Resume file") === "blank" && state("Claude API key") === "blank" && state("Work authorization and fixed answers") === "blank");
      check("blank items link to their step", !!document.querySelector('#obBody li[data-item="Phone"] button'));
      document.querySelector('#obBody li[data-item="Phone"] button').click();
      await settle();
      check("Go to step opens Contact info", title() === "Contact info and links");
      await (async () => {
        for (let i = 0; i < 6; i++) {
          click("#obSkipStep");
          await settle();
        }
      })();
      check("back at Done, the button reads Finish", title() === "Done" && $("#obNext").textContent === "Finish" && $("#obSkipStep").hidden);
      click("#obNext");
      await settle();
      check("Finish closes and remembers it", !guideOpen() && store().onboarding?.finished === true && store().onboarding?.how === "done", JSON.stringify(store().onboarding));
    },
    // Setup with a key: both PDFs, the prefill after the API key step, suggestions accepted / discarded / edited, Next
    // accepting the rest, the invented job dropped, the date conflict flagged, fixed answers and self-ID untouched.
    async "prefill-setup"() {
      const sugg = (k) => $(`[data-k="${k}"]`).classList.contains("suggested");
      await upload("#resumeFile", "tests/options/fake-resume.pdf", "application/pdf");
      await until(() => /Built an internal deploy CLI/.test(store().profile?.resumeText || ""), 15000);
      await upload("#linkedinPdf", "tests/options/fake-linkedin.pdf", "application/pdf");
      await until(() => /AI Engineer Intern/.test(store().profile?.linkedinText || ""), 15000);
      click("#obNext");
      await until(() => title() === "Claude API key (optional)");
      type("api.key", "sk-ant-test-not-a-real-key");
      click("#obNext");
      await until(() => title() === "Contact info and links", 15000);
      const sent = window.__messages.filter((m) => m.type === "PREFILL");
      check("one Claude call (PREFILL) with the resume and LinkedIn texts", sent.length === 1 && sent[0].resumeHasContoso && sent[0].linkedinHasNorthwind, JSON.stringify(sent));
      const sum = $("#prefillSummary").textContent;
      check("summary: Filled N fields from your resume; review each step.", /^Filled \d+ fields from your resume; review each step\./.test(sum), sum);
      check("summary mentions the date conflict and what was left out", /dates that differ between your resume and LinkedIn/.test(sum) && /Left out \d+ items? not found in your text/.test(sum), sum);
      check("the left-out list names the invented job and bullet", /Quantum Widgets/.test(sum) && /forty engineers/.test(sum));
      click("#obBack");
      await until(() => title() === "Claude API key (optional)");
      click("#obNext");
      await until(() => title() === "Contact info and links");
      check("Back and Next again: no second Claude call, the step says why", window.__messages.filter((m) => m.type === "PREFILL").length === 1 && $("#prefillSummary").textContent.startsWith("Already filled from this resume;"), $("#prefillSummary").textContent);
      // Contact step: deterministic suggestions.
      const want = { firstName: "Test", lastName: "Applicant", preferredName: "Tess", email: "test@example.com", phone: "6465550100", linkedin: "https://www.linkedin.com/in/test-applicant-0a1b2c", github: "https://github.com/test-applicant", website: "https://testapplicant.dev/portfolio", city: "Springfield", state: "New York" };
      const wrong = Object.entries(want).filter(([k, v]) => val(k) !== v || !sugg(k)).map(([k]) => `${k}=${JSON.stringify(val(k))}`);
      check("contact details, links, city / state and the nickname as preferred first name suggested (outlined)", !wrong.length, wrong.join(" "));
      check("a domain-like tool in LinkedIn's Top Skills is never the website", !/deployhub/.test(val("website")));
      check("a section bar offers Accept all / Discard all", /10 suggestions from your resume/.test($("#secInfo .sugg-bar")?.textContent || ""), $("#secInfo .sugg-bar")?.textContent);
      await wait(800);
      check("suggestions are not saved before they're accepted (auto-save ignores them)", store().profile?.email === "" && store().profile?.firstName === "", JSON.stringify([store().profile?.email, store().profile?.firstName]));
      [...$('[data-k="email"]').closest("label").querySelectorAll(".sugg-ctl button")].find((b) => b.textContent === "Accept").click();
      await wait(800);
      check("Accept saves that field (auto-save during setup)", store().profile?.email === "test@example.com" && !sugg("email"));
      [...$('[data-k="phone"]').closest("label").querySelectorAll(".sugg-ctl button")].find((b) => b.textContent === "Discard").click();
      await settle();
      check("Discard empties the field", val("phone") === "" && !sugg("phone"));
      type("city", "Springfield Gardens");
      await wait(800);
      check("editing a suggestion makes it yours (saved as edited)", store().profile?.city === "Springfield Gardens" && !sugg("city"));
      click("#obNext");
      await until(() => title() === "Work experience and skills");
      check("Next accepts the step's remaining suggestions and saves them", store().profile?.firstName === "Test" && store().profile?.lastName === "Applicant" && store().profile?.github === "https://github.com/test-applicant" && store().profile?.state === "New York");
      check("a discarded suggestion stays out", store().profile?.phone === "");
      // Work step: cards.
      const cards = [...document.querySelectorAll("#experiences .card")];
      const titles = cards.map((c) => `${c.querySelector('[data-f="title"]').value} at ${c.querySelector('[data-f="company"]').value}`);
      check("five suggested job cards (one only on LinkedIn), most recent first, the blank template card gone", cards.length === 5 && cards.every((c) => c.classList.contains("suggested")) && titles[0] === "Teaching Assistant at Lakeview University", titles.join("; "));
      check("the invented job is dropped", !titles.some((t) => /Quantum|Chief Technology/.test(t)));
      const card = (co) => cards.find((c) => c.querySelector('[data-f="company"]').value === co);
      const f = (c, k) => (c.querySelector(`[data-f="${k}"]`).type === "checkbox" ? c.querySelector(`[data-f="${k}"]`).checked : c.querySelector(`[data-f="${k}"]`).value);
      check("the current job: I currently work here, no end date", f(card("Lakeview University"), "current") === true && f(card("Lakeview University"), "endYear") === "" && f(card("Lakeview University"), "startMonth") === "9");
      check("the date conflict is flagged on the card (the resume's dates filled in)", /LinkedIn says May 2026 – Aug 2026; your resume says Jun 2026 – Aug 2026/.test(card("Contoso").textContent) && f(card("Contoso"), "startMonth") === "6");
      check("the invented bullet is dropped, real bullets kept", !/forty engineers/.test(f(card("Contoso"), "description")) && /Built an internal deploy CLI/.test(f(card("Contoso"), "description")));
      check("the resume's wording wins (location)", f(card("Northwind"), "location") === "Riverton, NJ");
      // Descriptions: the resume's by default, a toggle where LinkedIn's differs, never picked by length.
      const nw = card("Northwind");
      const resumeNw = "Built a retrieval evaluation harness and a citation checker for the support pilot, so that every generated answer quoted its sources and followed the strict evidence rules that the compliance reviewers set.";
      const alt = () => nw.querySelector(".desc-alt");
      const altBtn = () => alt()?.querySelector("button");
      check("a merged job keeps the resume's description by default", f(nw, "description") === resumeNw);
      check("its card offers LinkedIn's instead, with both lengths", /Resume: 206 characters; LinkedIn: 370 characters\./.test(alt()?.textContent || "") && altBtn()?.textContent === "Use LinkedIn description instead", alt()?.textContent);
      altBtn().click();
      await settle();
      check("Use LinkedIn description instead puts LinkedIn's text in", /^Built an evaluation harness for a retrieval pipeline.*\nCut the nightly report runtime/s.test(f(nw, "description")) && altBtn()?.textContent === "Use resume description" && nw.classList.contains("suggested"));
      check("the chosen text is kept in the pending suggestion (not saved yet)", /Cut the nightly report runtime/.test(store().prefill?.cards?.find((c) => c.item.company === "Northwind")?.item.description || "") && !(store().profile?.experiences || []).some((e) => e.company === "Northwind"));
      check("a job only on LinkedIn uses LinkedIn's text, no toggle", f(card("Fabrikam"), "description") === "Tutored first-year students in introductory programming twice a week." && !card("Fabrikam").querySelector(".desc-alt"));
      check("a job only on the resume, or without a LinkedIn description: no toggle", !card("Lakeview University").querySelector(".desc-alt") && !card("Contoso").querySelector(".desc-alt"));
      check("skills: the resume's list only", sugg("skills") && /^Python, TypeScript, .*PostgreSQL, Node\.js, .*NumPy, Docker, .*Linux$/.test(val("skills")) && !/version|@|Retrieval|deployhub/.test(val("skills")), val("skills"));
      const liSkills = () => $('[data-extra="skillsLinkedIn"]');
      check("LinkedIn's Top Skills: a separate suggestion with only the ones the resume lacks", /Your LinkedIn Top Skills add: Retrieval-Augmented Generation, deployhub\.io\./.test(liSkills()?.textContent || "") && /Add to skills/.test(liSkills()?.textContent || ""), liSkills()?.textContent);
      check("certifications suggested: the certificate listed under Education, not the fellowship (its organization is a job), and LinkedIn's Machine Learning Foundations kept once in the resume's wording", sugg("certifications") && val("certifications") === "Online Certification in Machine Learning Foundations\nOnline Certification in Data Analytics, Litware Online Academy\nFake Cloud Practitioner", JSON.stringify(val("certifications")));
      await wait(800);
      check("cards aren't saved before they're accepted", !(store().profile?.experiences || []).some((e) => e.company), JSON.stringify(store().profile?.experiences));
      [...card("Lakeview Research Group").querySelectorAll(".sugg-ctl button")].find((b) => b.textContent === "Discard").click();
      await settle();
      [...$("#secWork .sugg-bar").querySelectorAll("button")].find((b) => b.textContent === "Accept all").click();
      await wait(800);
      const exps = store().profile?.experiences || [];
      check("Accept all saves the section's cards (with the description chosen); the discarded one stays out", exps.find((e) => e.company === "Northwind")?.description.startsWith("Built an evaluation harness") && exps.length === 4 && !exps.some((e) => e.company === "Lakeview Research Group") && exps.some((e) => e.company === "Contoso" && e.startMonth === "6"), JSON.stringify(exps.map((e) => e.company)));
      const nw2 = [...document.querySelectorAll("#experiences .card")].find((c) => c.querySelector('[data-f="company"]').value === "Northwind");
      nw2.querySelector(".desc-alt button").click();
      await wait(800);
      check("the toggle works after Accept too (saved as a change)", store().profile?.experiences?.find((e) => e.company === "Northwind")?.description === resumeNw && nw2.querySelector(".desc-alt button")?.textContent === "Use LinkedIn description instead");
      const ta = nw2.querySelector('[data-f="description"]');
      ta.value = "My own words about this internship.";
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      check("after your own edit the toggle is gone (it never overwrites your text)", !nw2.querySelector(".desc-alt"));
      const co2 = [...document.querySelectorAll("#experiences .card")].find((c) => c.querySelector('[data-f="company"]').value === "Contoso");
      const cta = co2.querySelector('[data-f="description"]');
      cta.value = "x".repeat(2100);
      cta.dispatchEvent(new Event("input", { bubbles: true }));
      check("a description over 2,000 characters is warned about", !co2.querySelector(".desc-warn").hidden && /2,100 characters, over 2,000: Workday's Role Description/.test(co2.querySelector(".desc-warn").textContent));
      cta.value = "Short again.";
      cta.dispatchEvent(new Event("input", { bubbles: true }));
      check("the warning goes when it's back under", co2.querySelector(".desc-warn").hidden);
      [...$('[data-k="skills"]').closest("label").querySelectorAll(".sugg-ctl button")].find((b) => b.textContent === "Accept").click();
      await settle();
      liSkills().querySelectorAll("button")[1].click(); // Discard LinkedIn's
      await settle();
      click("#obNext");
      await until(() => title() === "Education and languages");
      check("the resume's skills accepted, LinkedIn's skipped", /^Python, .*Linux$/.test(store().profile?.skills || "") && !/Retrieval|deployhub/.test(store().profile?.skills || "") && store().profile?.certifications === "Online Certification in Machine Learning Foundations\nOnline Certification in Data Analytics, Litware Online Academy\nFake Cloud Practitioner", store().profile?.skills);
      const eduCards = [...document.querySelectorAll("#education .card")];
      check("only the degree is an education card (no certificate or fellowship cards)", eduCards.length === 1 && !/Litware|Fellowship|Certification/.test(eduCards.map((c) => c.querySelector('[data-f="school"]').value + c.querySelector('[data-f="degreeOptions"]').value).join(" ")), eduCards.map((c) => c.querySelector('[data-f="school"]').value).join("; "));
      const edu = $("#education .card.suggested");
      check("education suggested: school, degree steps led by the resume's B.E., field, dates (LinkedIn's start month fills the gap)", !!edu && edu.querySelector('[data-f="school"]').value === "Lakeview University" && /^Bachelor of Engineering \| BEng \| B\.E\. \| BE/.test(edu.querySelector('[data-f="degreeOptions"]').value) && edu.querySelector('[data-f="field"]').value === "Computer Engineering" && edu.querySelector('[data-f="startMonth"]').value === "8" && edu.querySelector('[data-f="startYear"]').value === "2023" && edu.querySelector('[data-f="endYear"]').value === "2027");
      check("expected graduation suggested from the degree in progress", sugg("expectedGraduation") && val("expectedGraduation") === "05/2027");
      check("a language suggested with its proficiency", $("#languages .card.suggested [data-f=name]")?.value === "Italian" && $("#languages .card.suggested [data-f=general]")?.value === "Elementary");
      const es = [...document.querySelectorAll("#languages .card")].find((c) => c.querySelector("[data-f=name]").value === "Spanish");
      const lf = (k) => es?.querySelector(`[data-f="${k}"]`);
      check("one overall level (Native or Bilingual): only Combined, I am fluent not ticked, the separate levels empty", lf("general")?.value === "Native or Bilingual" && lf("fluent")?.checked === false && ["comprehension", "overall", "reading", "speaking", "writing"].every((k) => lf(k).value === ""));
      check("the language card says to set reading / writing yourself", /Set reading\/writing yourself if they differ\./.test(es?.querySelector(".card-note")?.textContent || ""));
      click("#obNext");
      await until(() => title() === "Work authorization and fixed answers");
      const p = store().profile || {};
      check("Next saved education, graduation and languages", p.education?.length === 1 && p.education?.[0]?.school === "Lakeview University" && p.expectedGraduation === "05/2027" && p.languages?.[0]?.name === "Italian" && p.languages?.find((l) => l.name === "Spanish")?.fluent === false);
      const fixed = ["workAuth", "sponsorship", "citizen", "usPerson", "relocate", "clearance", "clearanceEligible"].filter((k) => p.answers?.[k]);
      const eeo = ["gender", "hispanic", "race", "veteran", "disability", "lgbtq", "transgender", "pronouns", "birthMonth"].filter((k) => p.eeo?.[k]);
      check("fixed answers and self-identification untouched", !fixed.length && !eeo.length && !document.querySelector("#secFixed .suggested, #secGov .suggested, #secEeo .suggested"), JSON.stringify({ fixed, eeo }));
      check("the API key is what was typed", p.api?.key === "sk-ant-test-not-a-real-key");
    },
    // The link and name rules on small texts (AAF_PREFILL.deterministic): where a website may come from, and nicknames.
    async "prefill-links"() {
      const d = (resume, linkedin = "") => AAF_PREFILL.deterministic(resume, linkedin);
      const site = (resume, linkedin) => d(resume, linkedin).website ?? null;
      check("header: a link with a path is a website", site("Test Applicant\ntest@example.com | testapplicant.dev/portfolio") === "https://testapplicant.dev/portfolio");
      check("header: www. and https:// links are websites", site("Test Applicant\nwww.testapplicant.dev") === "https://www.testapplicant.dev" && site("Test Applicant\nhttps://testapplicant.dev") === "https://testapplicant.dev");
      check("header: a bare domain is not (it could be a tool)", site("Test Applicant\ntest@example.com | testapplicant.dev") === null);
      check("an email's domain is not a website", site("Test Applicant\ntest@testapplicant.dev") === null);
      check("LinkedIn Top Skills: a domain-like tool is never the website", site("Test Applicant", "Contact\ntest@example.com\n\nTop Skills\ndeployhub.io\nPython") === null);
      check("a link in a sentence outside the header is not taken", site("Test Applicant\ntest@example.com\n\nEXPERIENCE\nShipped the dashboard at www.deployhub.io/demo for the team") === null);
      check("a skills line with a domain is not taken", site("Test Applicant\n\nSKILLS\nTools: deployhub.io, Docker") === null);
      check("a labeled line: Portfolio: / Website: (a bare domain is fine there)", site("Test Applicant\n\nPortfolio: testapplicant.dev") === "https://testapplicant.dev" && site("Test Applicant\n\nWebsite: https://testapplicant.dev/") === "https://testapplicant.dev/");
      check("LinkedIn Contact: a site LinkedIn tags (Personal) is taken", site("Test Applicant", "Contact\ntest@example.com\ntestapplicant.dev (Personal)\n\nTop Skills\nPython") === "https://testapplicant.dev");
      check("LinkedIn Contact: an untagged bare domain is not", site("Test Applicant", "Contact\ndeployhub.io\n\nTop Skills\nPython") === null);
      const n = (l) => {
        const x = d(l);
        return [x.firstName, x.preferredName, x.lastName].map((v) => v ?? "-").join("/");
      };
      check("First (Nickname) Last -> first, preferred, last", n("Test (Tess) Applicant\ntest@example.com") === "Test/Tess/Applicant", n("Test (Tess) Applicant"));
      check('First "Nickname" Last too', n('Test "Tess" Applicant') === "Test/Tess/Applicant" && n("Test “Tess” Applicant") === "Test/Tess/Applicant");
      check("a middle name before the last name", n("Test (Tess) Middle Applicant") === "Test/Tess/Applicant");
      check("no nickname: no preferred name", n("Test Applicant") === "Test/-/Applicant");
      const P = AAF_PREFILL;
      check("certifications: the same core name is one entry, the first (resume) wording kept", JSON.stringify(P.dedupeCerts(["Online Certification in Machine Learning Foundations", "Machine Learning Foundations"])) === JSON.stringify(["Online Certification in Machine Learning Foundations"]));
      check("certifications: generic words aside, either way round", JSON.stringify(P.dedupeCerts(["Data Analytics", "Certificate of Data Analytics (online course)"])) === JSON.stringify(["Data Analytics"]) && P.coreName("Online Certification in Machine Learning Foundations") === "machine learning foundations");
      check("certifications: different names both kept", P.dedupeCerts(["Machine Learning Foundations", "Cloud Security Basics", "Fake Cloud Practitioner"]).length === 3);
      check("an organization with a job card, by core name", P.sameOrg("Litware Online Academy", "Litware Academy") && P.sameOrg("Lakeview Research Group", "Lakeview Research Group") && !P.sameOrg("Litware Online Academy", "Northwind"));
    },
    // Setup without a key: the contact details from the text only; no Claude call, no cards, the summary says why.
    async "prefill-nokey"() {
      await upload("#resumeFile", "tests/options/fake-resume.pdf", "application/pdf");
      await until(() => /Built an internal deploy CLI/.test(store().profile?.resumeText || ""), 15000);
      click("#obNext");
      await until(() => title() === "Claude API key (optional)");
      click("#obNext");
      await until(() => title() === "Contact info and links", 15000);
      check("no Claude call without a key", !window.__messages.some((m) => m.type === "PREFILL"));
      check("contact details suggested from the text alone", val("preferredName") === "Tess" && val("website") === "https://testapplicant.dev/portfolio" && val("email") === "test@example.com" && val("phone") === "6465550100" && val("github") === "https://github.com/test-applicant" && val("city") === "Springfield" && val("state") === "New York" && val("firstName") === "Test");
      check("LinkedIn URL not suggested (not in the resume; no LinkedIn PDF)", val("linkedin") === "");
      check("the summary says a key would fill work history", /Add a Claude API key/.test($("#prefillSummary").textContent), $("#prefillSummary").textContent);
      check("no job / school cards suggested", !document.querySelector(".card.suggested"));
      check("skills still suggested (deterministic)", /^Python, /.test(val("skills")));
      click("#obBack");
      await until(() => title() === "Claude API key (optional)");
      click("#obNext");
      await until(() => title() === "Contact info and links");
      check("Back and Next again: the step says it already ran for this resume", $("#prefillSummary").textContent.startsWith("Already filled from this resume; upload a new one to get new suggestions."), $("#prefillSummary").textContent);
      check("and the pending suggestions are still shown", val("email") === "test@example.com" && $('[data-k="email"]').classList.contains("suggested"));
    },
    // Outside setup, a filled profile: "Fill from my resume" never overwrites a value (Replace is offered), doesn't add
    // a job or school already there, leaves fixed answers and self-ID alone; suggestions survive a reload unsaved.
    async "prefill-existing"() {
      const phase = sessionStorage.getItem("__aafPhase") || "1";
      if (phase === "1") {
        type("email", "mine@example.com");
        await upload("#linkedinPdf", "tests/options/fake-linkedin.pdf", "application/pdf");
        await until(() => /AI Engineer Intern/.test(val("linkedinText")), 15000);
        await upload("#resumeFile", "tests/options/fake-resume.pdf", "application/pdf");
        await until(() => /already has text/.test($("#resumeTextStatus").textContent), 15000);
        $("#resumeTextStatus button").click();
        await until(() => /Built an internal deploy CLI/.test(store().profile?.resumeText || ""));
        click("#prefillBtn");
        await until(() => /^Filled/.test($("#prefillStatus").textContent), 15000);
        const sum = $("#prefillStatus").textContent;
        check("summary outside setup", /^Filled \d+ fields? from your resume; review each step\./.test(sum) && /already in your profile, not added again/.test(sum) && /"Replace" is offered/.test(sum), sum);
        check("a value you typed is never overwritten", val("email") === "mine@example.com" && !$('[data-k="email"]').classList.contains("suggested"));
        check("an unchanged value gets no suggestion", val("firstName") === "Test" && !$('[data-k="firstName"]').closest("label").querySelector(".sugg-ctl"));
        const liCtl = $('[data-k="linkedin"]').closest("label").querySelector(".sugg-ctl");
        check("a different stored value: Replace offered, value kept", val("linkedin") === "https://www.linkedin.com/in/test-applicant" && /test-applicant-0a1b2c/.test(liCtl?.textContent || "") && /Replace/.test(liCtl?.textContent || ""));
        check("an empty field is suggested", val("github") === "https://github.com/test-applicant" && $('[data-k="github"]').classList.contains("suggested"));
        const cos = [...document.querySelectorAll('#experiences [data-f="company"]')].filter((el) => el.value === "Contoso");
        check("a job already in the profile isn't added again", cos.length === 1 && !cos[0].closest(".card").classList.contains("suggested"));
        check("a school already in the profile isn't added again", [...document.querySelectorAll('#education [data-f="school"]')].filter((el) => el.value === "Lakeview University").length === 1);
        check("other jobs are suggested", document.querySelectorAll("#experiences .card.suggested").length === 4);
        const sk = $('[data-k="skills"]');
        check("skills: the resume's suggested, LinkedIn's offered separately", sk.classList.contains("suggested") && !/Retrieval/.test(sk.value) && /Retrieval-Augmented Generation, deployhub\.io/.test($('[data-extra="skillsLinkedIn"]')?.textContent || ""));
        [...$('[data-extra="skillsLinkedIn"]').querySelectorAll("button")].find((b) => b.textContent === "Add to skills").click();
        await settle();
        check("Add to skills appends LinkedIn's (the resume's become yours with them)", /Linux, Retrieval-Augmented Generation, deployhub\.io$/.test(sk.value) && !sk.classList.contains("suggested") && !$('[data-extra="skillsLinkedIn"]') && unsavedShown(), sk.value);
        check("fixed answers and self-ID untouched on the page", $('[data-k="answers.workAuth"]').value === "Yes" && $('[data-k="answers.sponsorship"]').value === "No" && $('[data-k="eeo.gender"]').value === "" && !document.querySelector("#secFixed .suggested, #secEeo .suggested, #secGov .suggested"));
        check("nothing saved by the prefill itself", store().profile?.github === undefined || store().profile?.github === "");
        liCtl.querySelector("button").click(); // Replace
        await settle();
        check("Replace puts the resume's value in, as an unsaved change", val("linkedin") === "https://www.linkedin.com/in/test-applicant-0a1b2c" && unsavedShown());
        click("#save");
        await until(() => store().profile?.linkedin === "https://www.linkedin.com/in/test-applicant-0a1b2c");
        check("Save saves accepted values only, not pending suggestions", store().profile?.email === "mine@example.com" && !store().profile?.github && (store().profile?.experiences || []).length === 1, JSON.stringify({ github: store().profile?.github, n: store().profile?.experiences?.length }));
        sessionStorage.setItem("__aafPhase", "2");
        return "reload";
      }
      check("after a reload: pending suggestions are shown again, still unsaved", val("github") === "https://github.com/test-applicant" && $('[data-k="github"]').classList.contains("suggested") && document.querySelectorAll("#experiences .card.suggested").length === 4 && !store().profile?.github, JSON.stringify({ github: val("github"), sugg: $('[data-k="github"]').classList.contains("suggested"), cards: document.querySelectorAll("#experiences .card.suggested").length, stored: store().profile?.github, pending: store().prefill && Object.keys(store().prefill.fields) }));
      const nwr = [...document.querySelectorAll("#experiences .card")].find((c) => c.querySelector('[data-f="company"]').value === "Northwind");
      check("after a reload: the description toggle is still offered", /Use LinkedIn description instead/.test(nwr?.querySelector(".desc-alt")?.textContent || ""));
      check("after a reload: fixed answers still as stored", store().profile?.answers?.workAuth === "Yes" && store().profile?.answers?.clearance === "No");
    },
    // run.js --dump <pdf>: only print what pdftext.js makes of that file (no checks).
    async dump() {
      const f = new URLSearchParams(location.search).get("f");
      const text = await globalThis.AAF_PDFTEXT.extract(await bytes(f));
      lines.push(`INFO ${f}:\n${text.replace(/^/gm, "INFO | ")}`);
    },
    async "clear-default"() {
      check("guide not shown before clearing", !guideOpen());
      check("Clear fields is in the bottom bar", !!$(".bar #clearAll") && $(".bar #save").compareDocumentPosition($("#clearAll")) & Node.DOCUMENT_POSITION_FOLLOWING);
      click("#clearAll");
      check("dialog opens (a modal, not window.confirm)", $("#clearDlg").open && $("#clearDlg").matches(":modal"));
      check("dialog text", /Clear your profile\?/.test($("#clearDlg").textContent) && /removes your contact info, work history, education, answers, resume and materials from this browser/.test($("#clearDlg").textContent));
      check("boxes start unticked", !$("#clearKey").checked && !$("#clearLearnedToo").checked);
      check("focus starts on Cancel", document.activeElement === $("#clearCancel"));
      click("#clearConfirm");
      await until(() => !$("#clearDlg").open);
      await settle();
      const p = store().profile || {};
      check("profile cleared", !p.firstName && !p.email && !p.experiences && !p.resumeText, JSON.stringify(p));
      check("API key kept", p.api?.key === "sk-ant-test-not-a-real-key", JSON.stringify(p.api));
      check("resume file removed", !("resumeFile" in store()));
      check("learned answers kept", store().learned?.length === 1 && store().learnedDeleted?.length === 1);
      check("settings kept", store().settings?.useAI === true);
      check("fields on the page cleared", val("firstName") === "" && val("email") === "" && val("resumeText") === "");
      check("API key still in its field", val("api.key") === "sk-ant-test-not-a-real-key");
      check("setup starts again at step 1", guideOpen() && title() === "Resume and LinkedIn" && store().onboarding?.step === 0, JSON.stringify(store().onboarding));
    },
    async "clear-ticked"() {
      click("#clearAll");
      $("#clearKey").click();
      $("#clearLearnedToo").click();
      click("#clearConfirm");
      await until(() => !$("#clearDlg").open);
      await settle();
      check("API key removed when ticked", !store().profile?.api?.key && val("api.key") === "", JSON.stringify(store().profile));
      check("model settings kept", store().profile?.api?.model === "claude-haiku-5-5");
      check("learned answers removed when ticked", !("learned" in store()) && !("learnedDeleted" in store()));
      check("Approved list empty on the page", /Nothing yet/.test($("#learned").textContent));
      check("setup starts again", guideOpen());
    },
    async "clear-cancel"() {
      const before = JSON.stringify(store());
      click("#clearAll");
      $("#clearKey").click();
      $("#clearLearnedToo").click();
      click("#clearCancel");
      await settle();
      check("Cancel closes the dialog", !$("#clearDlg").open);
      check("Cancel changes nothing", JSON.stringify(store()) === before);
      check("fields still shown", val("email") === "test@example.com");
      click("#clearAll");
      check("ticks reset when reopened", !$("#clearKey").checked && !$("#clearLearnedToo").checked);
      // Escape closes a <dialog> natively (no handler of ours runs); closing it that way must change nothing either.
      $("#clearDlg").close();
      await settle();
      check("closing it another way (Escape) changes nothing", !$("#clearDlg").open && JSON.stringify(store()) === before);
      check("guide stays closed", !guideOpen());
    },
    async "clear-export"() {
      click("#clearAll");
      click("#clearExport");
      await until(() => window.__downloads.length);
      check("Export backup first downloads the backup", window.__downloads[0] === "application-autofill-backup.json", JSON.stringify(window.__downloads));
      check("dialog stays open after the export", $("#clearDlg").open && /Backup exported/.test($("#clearMsg").textContent));
      check("nothing cleared by the export", store().profile?.email === "test@example.com" && store().resumeFile);
    },
  };

  const report = () => {
    const pre = document.createElement("pre");
    pre.id = "aaf-report";
    pre.textContent = `@@BEGIN\n${lines.join("\n")}\n@@END`;
    document.body.appendChild(pre);
  };
  window.addEventListener("error", (e) => lines.push(`FAIL script error: ${e.message} (${e.filename?.split("/").pop()}:${e.lineno})`));
  window.addEventListener("unhandledrejection", (e) => lines.push(`FAIL unhandled rejection: ${e.reason?.message || e.reason}`));
  (async () => {
    const run = SCENARIOS[window.__scenario];
    try {
      if (!run) throw new Error(`no scenario "${window.__scenario}"`);
      // options.js loaded (optionsReady) and the guide decided (it shows, or the page is idle).
      if (typeof optionsReady === "undefined") {
        lines.push("INFO options.js has no optionsReady (an older Options page); waiting 800 ms instead");
        await wait(800);
      } else await optionsReady;
      await wait(400);
      // A scenario that reloads the page returns "reload": its lines so far are carried over (sessionStorage) and the
      // report is written after the last phase.
      if ((await run()) === "reload") {
        sessionStorage.setItem("__aafLines", JSON.stringify(lines));
        location.reload();
        return;
      }
    } catch (e) {
      lines.push(`FAIL ${e.message || e}`);
    }
    report();
  })();
})();
