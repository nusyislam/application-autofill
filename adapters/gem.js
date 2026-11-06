// Application Autofill: Gem adapter (jobs.gem.com/<company>/<id>, the application form on the job
// page itself, and Gem forms embedded as iframes from jobs.gem.com; the manifest loads it with
// all_frames).
//
// Built WITHOUT a real Gem posting at hand: nothing here depends on Gem's class names. The form root
// is the element holding the application's own inputs (email, resume, a name field), the job location
// comes from the posting header's "City • City • In office" line, and the rest is shared/form.js's
// label-driven discovery (text, textarea, radios, checkboxes, native selects, react-select comboboxes).
// The log's `fields found: N ..., form root <...>` line is the first thing to check on a real page.

(() => {
  const AAF = globalThis.AAF;
  if (!AAF.once("adapter:gem")) return;
  const { norm, visible } = AAF;

  // Gem's class names carry generated suffixes ("formLayout-43", "form-38", "bodyImportant-47",
  // "fileContainer-102"), so they're matched by PREFIX, never exactly.
  const P = (name) => `[class^="${name}-"], [class*=" ${name}-"]`;
  const LABEL = P("bodyImportant");
  // The form root: Gem's form container / layout ("Ready to apply?" + the questions + Apply), else the
  // <form>, else the smallest ancestor holding every visible application control (not in header / nav /
  // footer, not a site search box). The first real page (jobs.gem.com/nuvix) has no <form> and its Email
  // is a plain type="text" input with no name, so the old email-based lookup found nothing: root <body>,
  // no floating button.
  const appControls = () =>
    [...document.querySelectorAll("input, select, textarea")].filter((el) => {
      const t = (el.type || "").toLowerCase();
      if (["hidden", "submit", "button", "search", "image", "reset"].includes(t)) return false;
      if (el.closest("header, nav, footer, [role=search]")) return false;
      return t === "file" || t === "radio" || t === "checkbox" || visible(el);
    });
  function formRoot() {
    const byClass = [...document.querySelectorAll(`${P("formContainer")}, ${P("formLayout")}`)].find((el) => el.querySelector("input, textarea, select"));
    if (byClass) return byClass;
    const all = appControls();
    if (!all.length) return null;
    const form = all[0].closest("form");
    if (form && all.every((c) => form.contains(c))) return form;
    for (let el = all[0].parentElement; el && el !== document.body; el = el.parentElement) {
      if (all.every((c) => el.contains(c))) return el;
    }
    return document.body;
  }
  // A form page: a root (not the whole body) with at least two questions' controls, so the floating
  // button shows on the job page.
  const hasForm = () => {
    const r = formRoot();
    return !!r && r !== document.body && r.querySelectorAll("input, textarea, select").length >= 2;
  };

  // Resume uploaded: Gem shows the file's name next to an X in a block BESIDE the dropzone (not around
  // the input), so the whole field (the element holding the "Resume" label) is checked, case-insensitive,
  // allowing a shortened name.
  function uploadedCheck(input, name) {
    let field = input.parentElement;
    while (field && field !== document.body && !field.querySelector(LABEL)) field = field.parentElement;
    const text = ((field || input.parentElement).innerText || "").toLowerCase();
    const stem = name.toLowerCase().replace(/\.[a-z0-9]+$/, "").slice(0, 8);
    return text.includes(name.toLowerCase()) || (!!stem && text.includes(stem));
  }

  // Gem has no education block; school / degree / major / GPA questions are custom questions.
  const isEduField = (f) => f.type !== "file" && (AAF.EDU_LABEL.test(f.nl) || !!globalThis.AAF_LEARN_RULES?.eduFixedLabel(f.label));

  // ----------------------------------------------------------- job posting
  // The posting header (outside the form): the job title (h1) and a line of "•"-separated facts like
  // "San Francisco • New York • In office • Full-time". Workplace / employment words are dropped; the
  // rest are locations ("San Francisco; New York"). Description: the longest text block outside the
  // form. JSON-LD on the page is the shared fallback (shared/job.js).
  const NOT_PLACE = /^(in office|on ?site|hybrid|remote|full ?time|part ?time|contract|contractor|intern(ship)?|temporary|permanent|\d+\+? (years?|yrs?)|engineering|product|design|sales|marketing|operations|\$.*)$/;
  function jobInfo() {
    const root = formRoot();
    const outside = (el) => !root || !root.contains(el);
    const h1 = [...document.querySelectorAll("h1")].find((h) => outside(h) && visible(h));
    let location = "";
    const scope = h1 ? h1.closest("header, section, div") || document.body : document.body;
    for (const el of scope.querySelectorAll("p, span, div, li")) {
      if (!outside(el) || el.children.length > 3) continue;
      const t = (el.innerText || "").trim();
      if (!t.includes("•") || t.length > 200) continue;
      const parts = t.split("•").map((x) => x.trim()).filter(Boolean);
      const places = parts.filter((x) => !NOT_PLACE.test(norm(x)));
      if (places.length) {
        location = places.join("; ");
        break;
      }
    }
    const blocks = [...document.querySelectorAll("article, main section, [class*='description' i], [class*='content' i]")].filter(outside);
    const description = blocks.map((b) => (b.innerText || "").trim()).sort((a, b) => b.length - a.length)[0] || "";
    return { location, description: description.slice(0, 12000) };
  }

  // ----------------------------------------------------------- Gem's own dropdowns
  // Notional's self-ID (Gender, Race, Veteran status), and maybe other questions: a <button type="button"> showing
  // "Please select" (or the choice) in a div.input-NNN whose label is the bodyImportant div beside it. The options
  // exist only while it's open, in a portal at body level: div#floating-ui-portal > div > menu.menu-NNN >
  // li[role="menuitem"].dropdownItem-NNN > ... > div.text-NNN. Matched by prefix, role and structure (the class
  // suffixes are generated). shared/form.js drives it as a `custom` dropdown (open, read, click, verify, close).
  const { click, key, kbd, waitFor, sleep, dbg } = AAF;
  const PLACEHOLDER = /^(please select|select\.*|select one|choose\.*)$/i;
  const isDropBtn = (b) =>
    b?.tagName === "BUTTON" && b.type === "button" && !!b.parentElement?.matches(P("input")) && [...b.parentElement.children].some((c) => c !== b && c.matches(LABEL));
  const menus = () =>
    [...document.querySelectorAll('#floating-ui-portal menu, #floating-ui-portal [role="menu"], menu[class^="menu-"], menu[class*=" menu-"]')]
      .filter((m, i, all) => all.indexOf(m) === i && visible(m) && m.querySelector('[role="menuitem"]'));
  const openMenu = () => menus().pop() || null;
  let owner = null; // the button whose menu we opened
  const closeAny = async () => {
    if (!openMenu()) return;
    key(document.activeElement && document.activeElement !== document.body ? document.activeElement : openMenu(), "Escape");
    if (await waitFor(() => !openMenu(), 500)) return;
    key(openMenu(), "Escape");
    await waitFor(() => !openMenu(), 500);
  };
  const itemText = (li) => ((li.querySelector(P("text")) || li).innerText || "").split("\n")[0].trim();
  const customSelect = {
    match: (el) => isDropBtn(el),
    controls: (root) => [...root.querySelectorAll('button[type="button"]')].filter((b) => isDropBtn(b) && visible(b)),
    searchable: () => false,
    menu: (f) => (owner === f.ctrl ? openMenu() : null),
    options: (f) =>
      owner === f.ctrl
        ? [...(openMenu()?.querySelectorAll('[role="menuitem"]') || [])].filter((li) => li.getAttribute("aria-disabled") !== "true" && visible(li)).map((el) => ({ el, text: itemText(el) })).filter((o) => o.text)
        : [],
    async open(f) {
      if (owner === f.ctrl && openMenu()) return openMenu();
      await closeAny(); // a leftover menu (another dropdown's) first
      owner = f.ctrl;
      click(f.ctrl);
      if (!(await waitFor(openMenu, 1500))) {
        kbd(f.ctrl, "keydown", "ArrowDown", 40);
        await waitFor(openMenu, 800);
      }
      if (!openMenu()) dbg(`${f.label.slice(0, 60)}: the Gem dropdown didn't open; button HTML: ${f.ctrl.outerHTML.slice(0, 300)}`);
      return openMenu();
    },
    async search() {},
    value: (f) => {
      const t = (f.ctrl.innerText || "").trim().split("\n")[0].trim();
      return PLACEHOLDER.test(t) ? "" : t;
    },
    async close() {
      await closeAny();
      owner = null;
      await sleep(50);
    },
  };

  AAF.adapters.gem = AAF.makeFormAdapter({
    name: "gem",
    detect: () => location.hostname === "jobs.gem.com",
    formSel: "form",
    formRoot,
    hasForm,
    isEduField,
    labelSel: LABEL,
    uploadedCheck,
    fileBoxSel: "[class*='upload' i], [class*='dropzone' i], [class*='file' i], fieldset",
    keepPrefilled: true,
    plainLocationFallback: true,
    customSelect,
    jobInfo,
  });
})();
