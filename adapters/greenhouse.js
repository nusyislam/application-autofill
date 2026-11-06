// Application Autofill: Greenhouse adapter (boards.greenhouse.io, job-boards.greenhouse.io, and the
// boards.greenhouse.io/embed/job_app iframe on company career sites; the manifest loads it with
// all_frames so it runs inside that frame).
//
// Greenhouse is one page: personal info, resume, education, custom questions, EEO. Two generations of
// markup exist, and discovery is label-driven so both work:
//   - newer React boards (job-boards.greenhouse.io): `.field-wrapper`s, react-select dropdowns
//     (`input[role=combobox]` + `.select__control`, menu with `[role=option]`), async searches for
//     school and location, `input#resume[type=file]` behind an "Attach" button.
//   - classic boards (boards.greenhouse.io): `#application_form .field`, native <select>s, a location
//     text input with an autocomplete list.
// Discovery, widgets, resume, education, and learning come from shared/form.js; this file only holds
// Greenhouse's selectors.

(() => {
  const AAF = globalThis.AAF;
  if (!AAF.once("adapter:greenhouse")) return;

  const FORM_SEL = '#application_form, #application-form, form#application, .application--form, form[action*="/applications"]';
  // The education block (filled after the main pass): by container, or by Greenhouse's numbered ids
  // ("school--0", "degree--0", "start-year--0").
  const EDU_SEL = '.education--container, .education--form, #education_section, [class*="education-"], [id^="education"]';
  const isEduField = (f) => !!f.c.closest(EDU_SEL) || /^(school|degree|discipline|start|end)[ -]/.test(f.nid + " ") && /\b\d+$/.test(f.nid);
  const hasForm = () => !!document.querySelector(FORM_SEL) || !!document.querySelector('#first_name, input[name="job_application[first_name]"]');

  // ----------------------------------------------------------- job posting
  // Location and description from the page header (`.job__location`, classic `#header .location`)
  // and description block, else Greenhouse's public job board API, which also covers the embedded
  // iframe (embed/job_app?for=<board>&token=<job id>), where the posting is on the company's page.
  const outsideForm = (el) => el && !el.querySelector(FORM_SEL) && !el.closest(FORM_SEL);
  async function jobInfo() {
    const locEl = [...document.querySelectorAll(".job__location, #header .location, .app-header .location, .job-post-location")].find(outsideForm);
    const descEl = [...document.querySelectorAll(".job__description, #content .content-intro, #content")].find(outsideForm);
    const got = { location: locEl?.innerText || "", description: descEl?.innerText || "" };
    if (got.location && got.description) return got;
    const q = new URLSearchParams(location.search);
    const m = location.pathname.match(/^\/([^/]+)\/jobs\/(\d+)/);
    const board = q.get("for") || m?.[1];
    const id = q.get("token") || m?.[2];
    if (board && id) {
      const j = await AAF.fetchJSON(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board)}/jobs/${encodeURIComponent(id)}`);
      got.location ||= j?.location?.name || "";
      got.description ||= AAF.htmlToText(j?.content || "");
    }
    return got;
  }

  AAF.adapters.greenhouse = AAF.makeFormAdapter({
    name: "greenhouse",
    detect: () => /(^|\.)greenhouse\.io$/.test(location.hostname),
    formSel: FORM_SEL,
    hasForm,
    isEduField,
    fileBoxSel: ".file-upload, .field, .field-wrapper, fieldset",
    jobInfo,
  });
})();
