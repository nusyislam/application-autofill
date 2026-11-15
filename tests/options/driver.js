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
      check("Run setup again link present", !!$("#runSetup"));
      check("Skip setup present", !!$("#obSkipAll") && !$("#obSkipAll").hidden);
    },
    async "api-only"() {
      check("a profile with only the API key counts as empty", guideOpen());
    },
    async filled() {
      check("guide not shown on a filled profile", !guideOpen());
      check("all sections shown", !/^secResume$/.test(shown()) && shown().split(",").length >= 8, shown());
      check("no onboarding state written", !("onboarding" in store()), JSON.stringify(store().onboarding));
      click("#runSetup");
      await settle();
      check("Run setup again opens step 1", guideOpen() && title() === "Resume and LinkedIn");
      check("the filled values are still shown", val("email") === "test@example.com");
    },
    async resume() {
      check("resumes at the saved step (4: Education)", guideOpen() && title() === "Education", title());
      check("Education section shown", shown() === "secEdu", shown());
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
      check("resume: no blank line after every line (never two blank lines)", !/\n\s*\n\s*\n/.test(rt) && rt.split("\n").filter((l) => !l.trim()).length <= 5, `${rt.split("\n").filter((l) => !l.trim()).length} blank lines`);
      check("resume: name and contact lines", /^Test Applicant\ntest@example\.com \| 646-555-0100 \| Springfield, NY \| github\.com\/test-applicant\n/.test(rt));
      check("resume: right-aligned dates / places stay on the title's line", /\nSoftware Engineer Intern \| Jun 2026 – Aug 2026\nContoso \| New York, NY\n/.test(rt) && has(rt, "Lakeview University | Expected May 2027"));
      check("resume: a wrapped bullet is one line (word-by-word pieces spaced)", has(rt, "• Built an internal deploy CLI used by three teams to ship services, cutting release time from two hours to fifteen minutes across staging and production."));
      check("resume: second bullet one line", rt.split("\n").some((l) => /^• Wrote retrieval .* evals\. Most regressions were then caught .* runs end-to-end on every pull request\.$/.test(l)));
      check("resume: no Page N of M footer", !/Page \d+ of \d+/i.test(rt));
      check("resume: entries separated by a blank line", /production\.\n• Wrote/.test(rt) && /semester\n\nTeaching Assistant \| Sep 2025 – Dec 2025\n/.test(rt));
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
      check("LinkedIn: sidebar lists stay one item per line", lt.includes("\nRetrieval-Augmented Generation\nPython\nDocker\n"));
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
        check("after a reload: the extracted resume text is kept (no Next)", /Built an internal deploy CLI/.test(val("resumeText")) && /^Test Applicant\n/.test(val("resumeText")));
        check("after a reload: a typed field is kept (auto-saved)", val("extraNotes") === "Notes typed during setup", JSON.stringify(val("extraNotes")));
        click("#obNext");
        await until(() => title() === "Contact info and links");
        type("phone", "6465550100");
        await wait(800);
        sessionStorage.setItem("__aafPhase", "3");
        return "reload";
      }
      check("after a second reload: setup resumes on step 2", guideOpen() && title() === "Contact info and links", title());
      check("after a second reload: the step 2 value typed without Next is kept", val("phone") === "6465550100", JSON.stringify(val("phone")));
      check("and step 1's text too", /Built an internal deploy CLI/.test(val("resumeText")));
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
      type("resumeText", "Test Applicant resume text");
      click("#obNext");
      await until(() => title() === "Contact info and links");
      check("Next saves step 1", store().profile?.resumeText === "Test Applicant resume text", JSON.stringify(store().profile?.resumeText));
      check("Next moves to step 2", title() === "Contact info and links" && shown() === "secInfo", `${title()} / ${shown()}`);
      check("progress saved as step 2", store().onboarding?.step === 1, JSON.stringify(store().onboarding));
      check("focus moves to the step title", document.activeElement === $("#obTitle"));
      type("email", "test@example.com");
      await wait(200);
      check("an edit isn't saved before the 500 ms auto-save delay", store().profile?.email === "", JSON.stringify(store().profile?.email));
      await wait(600);
      check("an edit during setup is auto-saved (no Next)", store().profile?.email === "test@example.com", JSON.stringify(store().profile?.email));
      click("#obBack");
      await settle();
      check("Back goes to step 1", title() === "Resume and LinkedIn");
      click("#obNext");
      await until(() => title() === "Contact info and links");
      click("#obNext");
      await until(() => title() === "Work experience");
      check("Next on step 2 saves the email", store().profile?.email === "test@example.com", JSON.stringify(store().profile?.email));
      click("#obSkipStep");
      await settle();
      check("Skip step goes on without saving", title() === "Education");
      type("expectedGraduation", "May 2027");
      click("#obNext");
      await settle();
      check("an invalid value keeps Next on the step", title() === "Education" && /Not saved/.test($("#obMsg").textContent), `${title()} / ${$("#obMsg").textContent}`);
      type("expectedGraduation", "05/2027");
      click("#obNext");
      await until(() => title() === "Work authorization and fixed answers");
      check("then Next goes on", title() === "Work authorization and fixed answers" && shown() === "secFixed,secGov", shown());
      click("#obSkipStep");
      await settle();
      check("step 6 is self-identification", title() === "Self-identification (optional)" && shown() === "secEeo", shown());
      click("#obSkipStep");
      await settle();
      check("step 7 is the API key", title() === "Claude API key (optional)" && shown() === "secApi" && /bring your own key/.test($("#obBody").textContent), shown());
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
