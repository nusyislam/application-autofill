// Application Autofill: Lever adapter (jobs.lever.co/<company>/<job-id>/apply, jobs.eu.lever.co, and
// the jobs.lever.co iframe embedded on company career sites; the manifest loads it with all_frames).
//
// Lever's form is mostly plain server-rendered HTML with stable input names (built from Lever's known
// markup; not yet confirmed on a real posting):
//   - `form` (id / action vary) > `.application-question` list items > a <label> wrapping
//     `.application-label` (text + `<span class="required">✱</span>`) and `.application-field` (the control).
//   - Inputs: `name` (one full-name field), `email`, `phone`, `org` (current company), `location`
//     (`#location-input`, an autocomplete with `.dropdown-results` / `.dropdown-location` rows and a
//     hidden `selectedLocation`), `urls[LinkedIn]`, `urls[GitHub]`, `urls[Portfolio]`, `urls[Other]`.
//   - Resume: `input[type=file][name=resume]` inside an "ATTACH RESUME/CV" button-styled link. Lever
//     parses the upload and may prefill name / email / phone / org / urls.
//   - Custom questions ("cards"): `.application-question.custom-question` with `cards[<uuid>][fieldN]`
//     names: text, textarea, radio lists (`ul[data-qa="multiple-choice"]`), checkbox lists
//     (`ul[data-qa="checkboxes"]`), native <select>s. Option text in `.application-answer-alternative`.
//   - "Additional information": `textarea[name=comments]` under an h4, with only a placeholder.
//   - EEO: native selects `eeo[gender]`, `eeo[race]`, `eeo[veteran]`, `eeo[disability]`, plus the
//     disability form's signature name / date inputs.
// Discovery, widgets, resume, education, and learning come from shared/form.js; this file only holds
// Lever's selectors and quirks.

(() => {
  const AAF = globalThis.AAF;
  if (!AAF.once("adapter:lever")) return;

  const QUESTION = ".application-question";
  const ANCHOR = 'input[name="name"], input[name="email"], input[name="resume"], input[name="org"], textarea[name="comments"]';
  // The form root: the <form> holding Lever's own inputs. Never a section class: Lever has several
  // `.section.application-form` blocks, and a root on the first one would miss the rest (the Ashby
  // zero-fields bug). No <form>: the body.
  const formRoot = () => {
    const a = document.querySelector(ANCHOR) || document.querySelector(QUESTION);
    return a ? a.closest("form") || document.body : null;
  };
  const hasForm = () => !!document.querySelector(ANCHOR) || !!document.querySelector(`${QUESTION} input, ${QUESTION} select, ${QUESTION} textarea`);

  // Lever has no education block; school / degree / major questions are custom cards.
  const isEduField = (f) => f.type !== "file" && (AAF.EDU_LABEL.test(f.nl) || !!globalThis.AAF_LEARN_RULES?.eduFixedLabel(f.label));

  // ----------------------------------------------------------- job posting
  // Location and description for the office-attendance rule and draft mode. The /apply page shows the
  // headline (`.posting-categories .location`, workplace type) but not the description, so: this page,
  // then the posting page (/<company>/<id>, fetched same-origin: `[data-qa="job-description"]` /
  // `.section-wrapper .section`), then Lever's public postings API.
  const textOf = (el) => (el?.innerText || el?.textContent || "").replace(/\s+\n/g, "\n").trim();
  function fromPage(root) {
    const form = root.querySelector(ANCHOR)?.closest("form");
    const loc = [...root.querySelectorAll('.posting-categories .location, .posting-category.location, [data-qa="posting-location"], .location')].find((el) => !form?.contains(el));
    const desc = [...root.querySelectorAll('[data-qa="job-description"], [data-qa="closing-description"], .posting-page .section-wrapper .section.page-full-width')]
      .filter((el) => !el.querySelector(ANCHOR))
      .map(textOf)
      .filter(Boolean);
    return { location: textOf(loc), description: desc.join("\n\n") };
  }
  async function jobInfo() {
    const got = fromPage(document);
    if (got.location && got.description) return got;
    const m = location.pathname.match(/^\/([^/]+)\/([0-9a-f-]{8,})/i);
    if (!m) return got;
    const doc = await AAF.fetchDoc(`${location.origin}/${m[1]}/${m[2]}`);
    if (doc) {
      const there = fromPage(doc);
      const ld = AAF.jobFromLD(doc);
      got.location ||= there.location || ld.location || "";
      got.description ||= there.description || ld.description || "";
    }
    if (!got.location || !got.description) {
      const host = /\.eu\./.test(location.hostname) ? "api.eu.lever.co" : "api.lever.co";
      const j = await AAF.fetchJSON(`https://${host}/v0/postings/${encodeURIComponent(m[1])}/${encodeURIComponent(m[2])}`);
      got.location ||= [j?.categories?.location, ...(j?.categories?.allLocations || [])].filter(Boolean).filter((x, i, a) => a.indexOf(x) === i).join("; ");
      got.description ||= [j?.descriptionPlain, ...(j?.lists || []).map((l) => `${l.text}\n${AAF.htmlToText(l.content)}`), j?.additionalPlain].filter(Boolean).join("\n\n");
    }
    return got;
  }

  // Resume upload took: Lever shows "Success!" next to the button and the file name inside it,
  // uppercased and truncated ("TESTAPPLICANTRES…"). The old check wanted the full name and logged a
  // false "the file name never appeared".
  function uploadedCheck(input, name) {
    const q = input.closest(QUESTION) || input.parentElement;
    const text = (q.innerText || "").toLowerCase();
    if (/\bsuccess\b/.test(text)) return true;
    const stem = name.toLowerCase().replace(/\.[a-z0-9]+$/, "").slice(0, 8);
    return !!stem && text.includes(stem);
  }
  // Lever parses the resume after the upload and prefills name / email / phone / company / location.
  // Wait for it (up to 5 s) so the main pass sees the prefilled values instead of racing them.
  async function afterUpload() {
    const t0 = AAF.now();
    const filled = () => ["name", "email", "phone"].some((n) => document.querySelector(`input[name="${n}"]`)?.value.trim());
    const ok = await AAF.waitFor(filled, 5000);
    return `resume parse: ${ok ? `fields prefilled after ${AAF.now() - t0} ms` : "nothing prefilled within 5 s"}`;
  }

  AAF.adapters.lever = AAF.makeFormAdapter({
    name: "lever",
    detect: () => /^jobs(\.eu)?\.lever\.co$/.test(location.hostname),
    formSel: "form#application-form, form[action*='/apply']",
    formRoot,
    entrySel: QUESTION,
    hasForm,
    isEduField,
    fileBoxSel: `${QUESTION}, .application-field`,
    labelSel: ".application-label",
    uploadedCheck,
    afterUpload,
    requiredSel: ".required",
    // Lever's location dropdown rows.
    suggestSel: ".dropdown-results .dropdown-location, .dropdown-results li, .dropdown-location",
    plainLocationFallback: true,
    keepPrefilled: true,
    jobInfo,
  });
})();
