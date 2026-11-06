// Application Autofill: Ashby adapter (jobs.ashbyhq.com/<company>/<job-id>/application, and the
// jobs.ashbyhq.com iframe embedded on company career sites; the manifest loads it with all_frames).
//
// Ashby is one React page. Confirmed on a real posting (Parallax):
//   - `div.ashby-application-form-container` > `.ashby-application-form-section-container` (optional
//     header with title + description) > `.ashby-application-form-field-entry` (data-field-path =
//     "_systemfield_name" or a UUID) > `label.ashby-application-form-question-title[for]` (class
//     `_required_...` when required; Ashby draws the asterisk in CSS) + the control.
//   - Text / email / tel / url inputs and textareas with ids = the field path.
//   - Resume: `input#_systemfield_resume[type=file]` inside `.ashby-application-form-input-file`,
//     the uploaded name in `.ashby-application-form-input-file-item-name`.
//   - Location: `input.ashby-application-form-input-autocomplete[role=combobox]` WITHOUT an id or
//     name (its label's `for="_systemfield_location"` points nowhere), plus a toggle-arrow button.
//   - Yes / No: `div.ashby-application-form-input-yesno` holding two
//     `button.ashby-application-form-input-yesno-option[aria-pressed][data-option=yes|no]` and a
//     (not hidden) `input[type=checkbox]` mirroring the value.
//   - The "Autofill from resume" box sits OUTSIDE (before) the form container. A loose
//     `[class*='ashby-application-form']` selector matched it first, so discovery searched only that
//     box and found zero fields on the real page.
// Discovery, widgets, resume, education, and learning come from shared/form.js; this file only holds
// Ashby's selectors and quirks.

(() => {
  const AAF = globalThis.AAF;
  if (!AAF.once("adapter:ashby")) return;

  // Field entries: the main form's `.ashby-application-form-field-entry`, and the survey's plain
  // `div[data-field-path]` (Vellum's Diversity Survey / EEOC entries carry no entry class).
  const ENTRY = ".ashby-application-form-field-entry, [data-field-path]";
  const CONTAINER = ".ashby-application-form-container";
  // The form root: the smallest element holding every form container and field entry. Vellum's page has the
  // main container, then `div.ashby-survey-form-container` with two more (Diversity Survey, EEOC + veteran
  // status) outside it; a root on the first container found 9 fields and never the survey.
  const surveysLogged = new Set();
  const formRoot = () => {
    const conts = [...document.querySelectorAll(CONTAINER)];
    const entries = [...document.querySelectorAll(ENTRY)];
    if (!conts.length) return entries.length ? document.body : null;
    const all = [...conts, ...entries];
    let root = conts[0];
    while (root && !all.every((e) => root.contains(e))) root = root.parentElement;
    for (const c of conts.slice(1)) {
      if (conts[0].contains(c)) continue;
      const head = c.querySelector(".ashby-application-form-section-header-title")?.innerText ||
        c.querySelector(".ashby-application-form-section-header-description strong")?.innerText ||
        c.querySelector(".ashby-application-form-question-title")?.innerText || "";
      const h = head.trim().replace(/\s+/g, " ").slice(0, 80);
      if (!surveysLogged.has(h)) {
        surveysLogged.add(h);
        AAF.dbg(`survey section found: ${h || "(no heading)"}`);
      }
    }
    return root || document.body;
  };
  const hasForm = () => !!document.querySelector(`${CONTAINER}, ${ENTRY}`) || !!document.querySelector('#_systemfield_name, input[name="_systemfield_name"], #_systemfield_email');

  // Ashby has no education block; schools, degrees and majors are custom questions. Only short labels
  // that ask exactly for one of them go to the education step (school search keyword + aliases,
  // degree fallback steps). Longer questions ("Expected graduation date", "Are you currently pursuing
  // a degree?") stay with the main pass.
  const isEduField = (f) => f.type !== "file" && (AAF.EDU_LABEL.test(f.nl) || !!globalThis.AAF_LEARN_RULES?.eduFixedLabel(f.label)); // shared/form.js

  // The "Autofill from resume" box has its own file input: uploading there makes Ashby parse the
  // resume and overwrite fields. The resume goes into the Resume field only.
  const skipFile = (inp) => {
    if (/autofill/i.test(`${inp.id} ${inp.name} ${inp.className}`)) return true;
    let el = inp.parentElement;
    for (let i = 0; el && el !== document.body && i < 5; i++, el = el.parentElement) {
      if (el.matches(ENTRY)) return false;
      if (/autofill/i.test(typeof el.className === "string" ? el.className : "")) return true;
      if (/autofill from resume/i.test(el.innerText || "")) return true;
    }
    return false;
  };

  // Date pickers are text inputs: a date-format or "Pick date" placeholder, or a date-ish class.
  // (Not seen on a real Ashby posting yet.)
  const dateInput = (el) =>
    el.tagName === "INPUT" &&
    (/^\s*(mm|dd|yyyy)\b|pick (a )?date|select (a )?date/i.test(el.getAttribute("placeholder") || "") ||
      /(^|[\s_-])date(picker|-?input)?([\s_-]|$)/i.test(typeof el.className === "string" ? el.className : ""));

  // Sections that forbid AI-written answers. Parallax's "More about yourself": "please respond in
  // your own original, unassisted writing ... Submitting writing from other humans or AI models as
  // your own will result in permanent disqualification". Those fields are never sent to Claude.
  const OWN_WRITING = /unassisted|your own (original )?(words|writing)|own original|writing from (other humans or )?ai|ai[- ]generated|without (the )?(use|help) of ai|(use of )?ai (tools |models )?(is|are) (not (permitted|allowed)|prohibited)/i;
  const noAI = (f) => {
    const sec = f.c.closest(".ashby-application-form-section-container");
    const desc = sec?.querySelector(".ashby-application-form-section-header-description")?.innerText || "";
    return OWN_WRITING.test(desc) || OWN_WRITING.test(f.label);
  };

  // ----------------------------------------------------------- job posting
  // The posting's location and description (office-attendance rule, draft mode). The /application tab
  // may not show them, so: the job sidebar's "Location" on this page, Ashby's inline app data
  // (`window.__appData = {...}`: locationName, secondaryLocations, descriptionPlainText /
  // descriptionHtml), then the same from the overview page (/<company>/<id>, fetched same-origin),
  // then its JSON-LD. A string field from the inline data, unescaped.
  function appData(root) {
    const txt = [...root.querySelectorAll("script:not([src])")].map((s) => s.textContent).find((t) => /__appData/.test(t)) || "";
    const strs = (k) =>
      [...txt.matchAll(new RegExp(String.raw`"${k}"\s*:\s*"((?:[^"\\]|\\.)*)"`, "g"))].map((m) => {
        try {
          return JSON.parse(`"${m[1]}"`);
        } catch {
          return "";
        }
      }).filter(Boolean);
    const locs = [...new Set(strs("locationName"))];
    const plain = strs("descriptionPlainText")[0];
    return { location: locs.join("; "), description: plain || AAF.htmlToText(strs("descriptionHtml")[0] || "") };
  }
  // The sidebar's "Location" heading (outside the form; the form's own Location label is skipped).
  function sidebarLocation(root) {
    const form = root.querySelector(CONTAINER);
    for (const h of root.querySelectorAll("h1, h2, h3, h4, h5, dt, strong, p, span, div")) {
      if (h.children.length || form?.contains(h) || !/^location$/i.test((h.textContent || "").trim())) continue;
      const next = h.nextElementSibling || h.parentElement?.nextElementSibling;
      const t = (next?.textContent || "").replace(/\s+/g, " ").trim();
      if (t && t.length < 200) return t;
    }
    return "";
  }
  async function jobInfo() {
    const here = appData(document);
    const got = { location: sidebarLocation(document) || here.location, description: here.description };
    if (got.location && got.description) return got;
    const m = location.pathname.match(/^(\/[^/]+\/[0-9a-f-]{8,})\/application/i);
    const doc = m && (await AAF.fetchDoc(location.origin + m[1]));
    if (doc) {
      const there = appData(doc);
      const ld = AAF.jobFromLD(doc);
      got.location ||= sidebarLocation(doc) || there.location || ld.location || "";
      got.description ||= there.description || ld.description || "";
    }
    return got;
  }

  // The resume parse after the upload. On Vellum and Rivulet the FIRST Yes / No question after the upload showed
  // "Yes" (aria-pressed="true") but submit said "Missing entry for required field", while the next one
  // (sponsorship) registered: the parse landing after we answered fits, resetting the stored answer while the
  // button kept showing it. So wait for it (name / email prefilled, up to 6 s), then a moment more.
  async function afterUpload() {
    const t0 = AAF.now();
    const sel = '#_systemfield_name, input[name="_systemfield_name"], #_systemfield_email, input[name="_systemfield_email"]';
    const filled = () => [...document.querySelectorAll(sel)].some((i) => i.value.trim());
    if (filled()) return "resume parse: name / email already filled before the upload";
    const ok = await AAF.waitFor(filled, 6000);
    if (ok) await AAF.sleep(800);
    return `resume parse: ${ok ? `fields prefilled after ${AAF.now() - t0} ms` : "nothing prefilled within 6 s"}`;
  }

  AAF.adapters.ashby = AAF.makeFormAdapter({
    name: "ashby",
    detect: () => location.hostname === "jobs.ashbyhq.com",
    formSel: CONTAINER,
    formRoot,
    entrySel: ENTRY,
    eduBlocks: true, // the School entry's Degree / Start / End Date / Still Student? fields (shared/form.js)
    hasForm,
    isEduField,
    skipFile,
    dateInput,
    noAI,
    jobInfo,
    fileBoxSel: `${ENTRY}, .ashby-application-form-input-file`,
    requiredSel: 'label[class*="_required"]',
    valueFromInput: true,
    afterUpload,
    watchToggles: true, // re-check Yes / No answers for a while after the fill (shared/form.js afterFill)
  });
})();
