// Application Autofill: YC Work at a Startup adapter (www.workatastartup.com, and ycombinator.com job pages that
// lead there). UNVERIFIED until tested on a real page: built from two pasted fragments (the apply dialog and the
// job page behind it); the JobDetailPage JSON wasn't in them, so its shape is guessed.
//
// How it works on the site: the candidate profile is filled once on WaaS itself; applying to a job opens a
// dialog ("Reach out to <Founder> at <Company>") with a textarea for a short note to the founder, then Close /
// Send, under a weekly application limit. So the only thing to fill is that note:
//   - the dialog: div[id^="headlessui-dialog-panel"][data-headlessui-state="open"] holding a textarea and a
//     Send button (Grammarly injects its own elements into it);
//   - the job: the JobDetailPage react-component JSON when there is one, else the visible page (h1 "<Title> at
//     <Company> (W25)", the breadcrumb, the one-liner, the location / type / visa tags, "About the role");
//   - the note is drafted with the draft model (background.js YC_NOTE), set with the native setter + input
//     events (React-controlled), verified, outlined YELLOW (the dialog says human-written messages are more
//     likely to get a response), never sent: Send / Close / Apply are blocked by the navigation guard;
//   - text already in the box is never overwritten; the Done toast offers "Redraft note".
// Discovery returns just the note as a section field, so the generic pass, learning and the Claude batch never
// touch the page.

(() => {
  const AAF = globalThis.AAF;
  if (!AAF.once("adapter:yc")) return;
  const { dbg, mark, sleep, nativeSet } = AAF;

  const DIALOG = 'div[id^="headlessui-dialog-panel"][data-headlessui-state="open"]';
  const text = (el) => ((el && (el.innerText || el.textContent)) || "").replace(/\s+/g, " ").trim();
  const isWaas = () => /(^|\.)workatastartup\.com$/i.test(location.hostname);
  const isYcJobs = () => /(^|\.)ycombinator\.com$/i.test(location.hostname) && /^\/companies\/[^/]+\/jobs\b/.test(location.pathname);

  // ------------------------------------------------------------- the dialog
  function dialog() {
    return [...document.querySelectorAll(DIALOG)].find((d) => d.querySelector("textarea") && [...d.querySelectorAll("button")].some((b) => /^send$/i.test(text(b)))) || null;
  }
  // "Reach out to Alex at AfterPlan" -> founder first name and company; the orange "qualifications might not
  // match this job" note.
  function dialogInfo(d) {
    const title = [...d.querySelectorAll("div, h1, h2, h3")].map(text).find((t) => /^reach out to .+ at .+$/i.test(t)) || "";
    const m = title.match(/^reach out to (.+?) at (.+)$/i) || [];
    const note = [...d.querySelectorAll("p")].map(text).find((t) => /qualifications might not match/i.test(t)) || "";
    return { founder: (m[1] || "").trim().split(/\s+/)[0] || "", company: (m[2] || "").trim(), note };
  }
  // An explicit ban on AI-written notes. "Human-written messages are more likely to get a response" is not a
  // ban, and neither is "your application may be evaluated using AI-assisted tools".
  const NOTE_BAN = /\b(do not|don t|dont|must not|never|please do not)\b[^.]{0,60}\b(ai|chat ?gpt|llms?|generative|language models?)\b|\b(ai|chat ?gpt|llm)[- ]?(written|generated)\b[^.]{0,50}\b(not (be )?(accepted|considered|allowed|permitted)|rejected|disqualif\w*|ignored)\b/i;
  const noteField = (d) => {
    const ta = d.querySelector("textarea");
    const { founder, company } = dialogInfo(d);
    const label = `Note to ${founder || "the founder"}${company ? ` at ${company}` : ""}`;
    return { c: ta.parentElement || ta, id: "yc-note", label, nl: AAF.norm(label), nid: "yc note", type: "textarea", ctrl: ta, required: true };
  };

  // ------------------------------------------------------------- the job
  // The JobDetailPage react-component props (element id "jobs/public/pages/JobDetailPage-react-component-..."):
  // JSON in a data attribute or an embedded JSON script. The first value under any of `keys`, searched depth
  // first.
  function pageJSON() {
    const el = document.querySelector('[id^="jobs/public/pages/JobDetailPage-react-component"]');
    if (!el) return null;
    const raws = [el.getAttribute("data-react-props"), el.getAttribute("data-props"), el.getAttribute("data-page"), el.tagName === "SCRIPT" ? el.textContent : el.querySelector('script[type="application/json"]')?.textContent];
    for (const raw of raws) {
      if (!raw) continue;
      try {
        return JSON.parse(raw);
      } catch {}
    }
    return null;
  }
  function pick(obj, keys, depth = 0) {
    if (!obj || typeof obj !== "object" || depth > 6) return undefined;
    for (const k of keys) if (obj[k] != null && obj[k] !== "") return obj[k];
    for (const v of Object.values(obj)) {
      const r = typeof v === "object" ? pick(v, keys, depth + 1) : undefined;
      if (r !== undefined) return r;
    }
    return undefined;
  }
  const asText = (v) => (v == null ? "" : typeof v === "string" ? (/<[a-z]/i.test(v) ? AAF.htmlToText?.(v) || v : v) : Array.isArray(v) ? v.map(asText).filter(Boolean).join(" / ") : typeof v === "object" ? asText(v.name || v.title || v.label || "") : String(v)).trim();
  function jobFromJSON() {
    const j = pageJSON();
    if (!j) return null;
    const job = pick(j, ["job"]) || j;
    const co = pick(j, ["company"]);
    const companyObj = co && typeof co === "object" ? co : j;
    const r = {
      title: asText(pick(job, ["title", "jobTitle"])),
      company: asText(co && typeof co === "object" ? pick(co, ["name"]) : co),
      oneLiner: asText(pick(companyObj, ["oneLiner", "one_liner", "tagline"])),
      batch: asText(pick(companyObj, ["batch", "batchName", "yc_batch"])),
      location: asText(pick(job, ["location", "locations", "prettyLocation", "pretty_location"])),
      visa: asText(pick(job, ["visa", "visaRequirement", "visa_requirement", "visaRequired"])),
      type: asText(pick(job, ["jobType", "job_type", "type", "roleType"])),
      description: asText(pick(job, ["description", "descriptionHtml", "description_html", "body"])),
    };
    return r.title || r.description ? r : null;
  }
  // The visible page: h1 "<Title> at <Company> (W25)", the breadcrumb "<Company> (W25)", the one-liner, the tags
  // (location, type, visa) and "About the role"; plus any company / founder sections when they're shown.
  function jobFromPage() {
    const h1 = document.querySelector("h1");
    if (!h1) return null;
    const t = text(h1);
    const m = t.match(/^(.*?) at (.+?)(?:\s*\(([A-Z]\d{2})\))?$/) || [];
    const crumb = [...document.querySelectorAll('a[href^="/companies/"]')].map(text).find((x) => /\([A-Z]\d{2}\)$/.test(x)) || "";
    const box = h1.parentElement;
    const tags = [...(box?.querySelectorAll("span.inline-flex > span") || [])].map(text).filter(Boolean);
    const sectionText = (re) => {
      const head = [...document.querySelectorAll("span, h2, h3")].find((x) => re.test(text(x)));
      return head ? text(head.parentElement?.querySelector(".prose") || head.nextElementSibling) : "";
    };
    return {
      title: (m[1] || t).trim(),
      company: (m[2] || "").trim() || crumb.replace(/\s*\([A-Z]\d{2}\)$/, ""),
      batch: m[3] || (crumb.match(/\(([A-Z]\d{2})\)$/) || [])[1] || "",
      oneLiner: text(box?.querySelector(".text-gray-700")),
      location: tags.find((x) => /,|remote/i.test(x)) || "",
      type: tags.find((x) => /^(intern(ship)?|full[- ]time|part[- ]time|contract)$/i.test(x)) || "",
      visa: tags.find((x) => /visa|citizen|sponsor/i.test(x)) || "",
      description: [sectionText(/^about the role$/i), sectionText(/^(about the company|about|founders?)$/i)].filter(Boolean).join("\n\n"),
    };
  }
  let lastJob = null;
  function jobInfo() {
    const j = jobFromJSON() || jobFromPage();
    if (!j) return null;
    lastJob = j;
    const head = [`${j.title}${j.company ? ` at ${j.company}` : ""}${j.batch ? ` (YC ${j.batch})` : ""}`, j.oneLiner, j.type && `Type: ${j.type}`, j.location && `Location: ${j.location}`, j.visa && `Visa: ${j.visa}`].filter(Boolean).join("\n");
    return { location: j.location || "", description: `${head}\n\n${j.description || ""}`.trim() };
  }

  // ------------------------------------------------------------- the note
  const noDashes = (s) => String(s).replace(/\s*—\s*/g, ", ").replace(/\s*–\s*/g, "-").replace(/,\s*,/g, ",");
  async function draftNote(p, stats) {
    const d = dialog();
    const info = dialogInfo(d);
    const f = noteField(d);
    const ta = f.ctrl;
    const redraft = !!AAF.ycForce;
    if (info.note) {
      AAF.setNote?.("YC: your qualifications might not match this job");
      dbg(`YC: "${info.note.slice(0, 140)}"`);
    }
    // An explicit ban on AI-written notes: nothing drafted, and no redraft offered.
    const banned = NOTE_BAN.exec(text(d));
    if (banned) {
      dbg(`YC: the dialog forbids AI-written notes ("${banned[0].slice(0, 80)}"), left for you`);
      mark(f, "needs");
      return;
    }
    AAF.run.toastAction = { label: "Redraft note", run: () => AAF.ycRedraft() };
    // Text already in the box (yours, or an earlier draft): never overwritten; the toast offers a redraft.
    if (ta.value.trim() && !redraft) {
      dbg(`YC note: the box already has text (${ta.value.trim().length} chars), kept it; "Redraft note" on the toast replaces it`);
      AAF.countKept(f.c);
      mark(f, "needs");
      return;
    }
    AAF.setStep(`Drafting the note to ${info.founder || "the founder"}`);
    const job = await AAF.jobInfo();
    const j = lastJob || {};
    let res;
    try {
      res = await AAF.untilCancel(chrome.runtime.sendMessage({
        type: "YC_NOTE",
        founder: info.founder,
        company: info.company || j.company || "",
        job: { title: j.title || "", type: j.type || "", location: job.location, description: (job.description || "").slice(0, 8000) },
      }));
    } catch (e) {
      if (e instanceof AAF.Cancelled) throw e;
      res = { error: `couldn't reach the background script: ${e.message}` };
    }
    if (AAF.cancel.reason) throw new AAF.Cancelled(AAF.cancel.reason);
    const inc = res?.included;
    if (inc) dbg(`YC note: request included LinkedIn text ${inc.linkedinChars} chars, resume text ${inc.resumeChars}, extra notes ${inc.notesChars}, job description ${inc.descriptionChars}, projects to highlight ${inc.highlightCount}`);
    let note = res?.answers?.[0]?.answer;
    if (!note) {
      dbg(`YC note: no draft (${res?.error ? `ERROR ${res.error}` : res?.answers?.[0]?.reason || "null"}), left for you`);
      if (res?.raw != null) dbg(`YC note: the reply started: ${JSON.stringify(res.raw)}`);
      mark(f, "needs");
      return;
    }
    const clean = noDashes(note).trim();
    if (clean !== note.trim()) dbg("YC note: removed dashes from the draft");
    note = clean;
    const hi = `Hi ${info.founder || ""},`.replace(" ,", ",");
    if (info.founder && !note.startsWith(hi)) {
      note = `${hi}\n\n${note.replace(/^(hi|hello|hey)\b[^,\n]*,?\s*/i, "")}`;
      dbg(`YC note: started it with "${hi}"`);
    }
    if (note.length < 50) {
      dbg(`YC note: the draft is only ${note.length} characters (the site wants at least 50), left for you`);
      mark(f, "needs");
      return;
    }
    if (note.length > 600) dbg(`YC note: the draft is ${note.length} characters (aim was under ~600); shorten it if you like`);
    // React-controlled: the native setter + input events, then check the value stuck (Grammarly runs here too).
    nativeSet(ta, note);
    await sleep(300);
    if (ta.value !== note) {
      dbg("YC note: the box didn't keep the text after the native set; typing it instead");
      await AAF.typeInto(ta, note, { blur: false });
      await sleep(300);
    }
    if (ta.value !== note) {
      dbg(`YC note: the box shows ${ta.value.length} characters instead of the draft's ${note.length}; left for you`);
      mark(f, "needs");
      return;
    }
    if (res.answers[0].project) dbg(`YC note: project "${res.answers[0].project}"`);
    AAF.countFill(f.c);
    stats.drafts++;
    mark(f, "needs"); // yellow: rewrite it in your own words before sending
    AAF.run.toastNote = "YC note: rewrite it in your own words before sending (the site says human-written messages get more replies).";
    dbg(`YC note drafted${redraft ? " (redraft)" : ""}, review before sending (${note.length} chars)`);
  }

  // "Redraft note" on the toast: a fill that replaces the box's text.
  AAF.ycRedraft = async () => {
    AAF.ycForce = true;
    try {
      return await AAF.fillPage();
    } finally {
      AAF.ycForce = false;
    }
  };

  async function fillSections(p, stats) {
    if (dialog()) return draftNote(p, stats);
    if (isWaas() && /^\/(application|profile|candidates?|users?)(\/|$)/.test(location.pathname)) dbg("YC profile page, nothing to fill");
    else if (isYcJobs()) dbg("YC job page on ycombinator.com: apply on Work at a Startup (the extension never clicks Apply)");
    else dbg("YC: no apply dialog open (click Apply first; the extension never clicks it)");
  }

  AAF.adapters.yc = {
    name: "yc",
    detect: () => isWaas() || isYcJobs(),
    discoverFields: () => {
      const d = dialog();
      return d ? [noteField(d)] : [];
    },
    isFilled: (f) => !!f.ctrl?.value?.trim(),
    currentValue: (f) => (f.ctrl?.value || "").trim(),
    isSectionField: () => true, // the note is the adapter's own step
    setField: async (f, v) => {
      nativeSet(f.ctrl, String(v));
      await sleep(200);
      return f.ctrl.value === String(v);
    },
    readOptions: async () => [],
    fillSections,
    watchUserAnswers: () => {}, // nothing on WaaS is learned
    jobInfo,
    formText: () => "", // the note's own ban check is above (the dialog's "AI-assisted tools" line is no ban)
    closePopups: () => {}, // never close the dialog
    rootInfo: () => (dialog() ? "<the apply dialog>" : "<no apply dialog>"),
    noFieldsWhy: () => (dialog() ? "" : "no apply dialog open, nothing to fill"),
    isFormPage: () => !!dialog(),
    isApplicationFlow: () => false,
    isApplicationQuestionsPage: () => false,
  };
})();
