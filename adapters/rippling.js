// Application Autofill: Rippling adapter (ats.rippling.com/<company>/jobs/<id>/apply, and Rippling forms embedded as
// iframes; the manifest loads it with all_frames). A config for shared/form.js.
//
// Built from a real application form (tests/fixtures/rippling-raw.html, git-ignored) and an open dropdown
// (rippling-dropdown-raw.html). Class names are generated ("css-1y9duzt", "e1yeqa1v2") and never used; the stable
// hooks are data-testid / data-input attributes, roles and labels:
//   - every field sits in a div[data-testid="field"]; its label is a span#field-N-label the control names with
//     aria-labelledby; text inputs carry data-input="<name>" / data-testid="input-<name>" (first_name, email, ...);
//   - custom questions ("Are you legally authorized to work in the United States?") have no label in the field: the
//     question is a <p> in the block just before it;
//   - dropdowns: a [data-testid="select-controller"] holding a role=combobox (a search <input> for Pronouns / Race /
//     the phone country code, else a div showing "Select" / "Select..."). The options exist only while it's open, in
//     div[data-testid="popper"][role="dialog"] > ul[role="listbox"][data-testid="menuList"] > li[role="option"]
//     (text in [data-testid="menuListLabel"]);
//   - Location: an <input aria-autocomplete="list" aria-haspopup="listbox"> without role=combobox, its suggestions in
//     a popper too (role=option);
//   - radios: div[role="radiogroup"] > div[role="radio"] > input[type=radio] named by aria-labelledby;
//   - Résumé / Cover letter: input[type=File][data-testid="input-resume" | "input-cover_letter"] in a drop zone; "The
//     résumé will be parsed to fill in the application details";
//   - Apply is button[type=submit][data-testid="Apply"] (the navigation guard blocks it); a Cloudflare Turnstile box
//     (#turnstile-container) is never touched.

(() => {
  const AAF = globalThis.AAF;
  if (!AAF.once("adapter:rippling")) return;
  const { visible, click, key, typeInto, waitFor, sleep, dbg, norm } = AAF;
  const text = (el) => (el?.innerText || el?.textContent || "").replace(/\s+/g, " ").trim();
  const FIELD = '[data-testid="field"]';

  // The form root: the <form> holding Rippling's field wrappers.
  function formRoot() {
    const forms = [...document.querySelectorAll("form")].filter((f) => f.querySelector(FIELD));
    return forms.sort((a, b) => b.querySelectorAll(FIELD).length - a.querySelectorAll(FIELD).length)[0] || null;
  }
  const hasForm = () => !!formRoot();

  // Labels the shared reader can't find: a custom question's text in the block before its field wrapper (the
  // field itself has no label), and the phone number's country-code dropdown nested in the phone field.
  function fieldInfo(ctrl) {
    const field = ctrl.closest(FIELD);
    if (!field) return null;
    // A radio / checkbox's aria-labelledby names its option ("Yes - I consent to receiving text messages"), not the question.
    const choice = ["radio", "checkbox"].includes((ctrl.type || "").toLowerCase());
    const named = !choice && (ctrl.getAttribute("aria-labelledby") || "").split(/\s+/).map((id) => document.getElementById(id)).find((el) => el && text(el));
    if (named) return null; // the shared reader takes it
    if (ctrl.closest('[data-testid$="-code"]')) return { label: "Phone country code" };
    const ownLabel = field.querySelector('[id$="-label"]');
    if (ownLabel && text(ownLabel)) return { label: text(ownLabel) };
    // The block before the field wrapper (or before its parent, for a wrapper alone in a container).
    for (let el = field; el && el !== document.body; el = el.parentElement) {
      let prev = el.previousElementSibling;
      while (prev && !text(prev)) prev = prev.previousElementSibling;
      if (prev) {
        const q = [...prev.querySelectorAll("p")].map(text).find(Boolean) || text(prev);
        return q ? { label: q.slice(0, 600) } : null;
      }
      if (el.parentElement?.querySelectorAll(FIELD).length > 1) break;
    }
    return null;
  }

  // ----------------------------------------------------------- Rippling's dropdowns
  const isPick = (el) => el?.getAttribute("role") === "combobox" && !!el.closest('[data-testid="select-controller"]');
  const poppers = () => [...document.querySelectorAll('[data-testid="popper"]')].filter((p) => visible(p) && p.querySelector('[role="listbox"], [data-testid="menuList"]'));
  const openMenu = () => poppers().pop() || null;
  let owner = null;
  const PLACEHOLDER = /^(select\.*|search|select one|please select)$/i;
  const closeAny = async () => {
    if (!openMenu()) return;
    key(document.activeElement && document.activeElement !== document.body ? document.activeElement : openMenu(), "Escape");
    if (await waitFor(() => !openMenu(), 600)) return;
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await waitFor(() => !openMenu(), 600);
  };
  const searchBox = (f) => (f.ctrl.tagName === "INPUT" ? f.ctrl : openMenu()?.querySelector("input")) || null;
  const items = () =>
    [...(openMenu()?.querySelectorAll('[role="option"]') || [])]
      .filter((li) => li.getAttribute("aria-disabled") !== "true" && visible(li))
      .map((el) => ({ el, text: text(el.querySelector('[data-testid="menuListLabel"]') || el) }))
      .filter((o) => o.text);
  const customSelect = {
    match: isPick,
    controls: (root) => [...root.querySelectorAll('[data-testid="select-controller"] [role="combobox"]:not(input)')].filter(visible),
    searchable: (f) => !!searchBox(f),
    menu: (f) => (owner === f.ctrl ? openMenu() : null),
    options: (f) => (owner === f.ctrl ? items() : []),
    async open(f) {
      if (owner === f.ctrl && openMenu()) return openMenu();
      await closeAny(); // the previous dropdown's popper first
      owner = f.ctrl;
      const ctl = f.ctrl.closest('[data-testid="select-controller"]') || f.ctrl;
      f.ctrl.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
      click(ctl);
      if (!(await waitFor(openMenu, 1200))) {
        click(f.ctrl);
        if (!(await waitFor(openMenu, 800))) {
          key(f.ctrl, "ArrowDown");
          await waitFor(openMenu, 800);
        }
      }
      if (!openMenu()) dbg(`${f.label.slice(0, 60)}: the Rippling dropdown didn't open; HTML: ${ctl.outerHTML.slice(0, 300)}`);
      return openMenu();
    },
    // Long lists (school, location, ...): type into the search box, then wait for this search's own options.
    async search(f, term) {
      const box = searchBox(f);
      if (!box || box.value === term) return;
      const before = items().map((o) => o.text).join("|");
      await typeInto(box, term, { blur: false });
      await waitFor(() => items().map((o) => o.text).join("|") !== before, term ? 2500 : 1000);
      await sleep(150);
    },
    value(f) {
      const ctl = f.ctrl.closest('[data-testid="select-controller"]');
      const shown = f.ctrl.tagName === "INPUT" ? (f.ctrl.value || "").trim() : text(f.ctrl);
      const v = shown || text(ctl?.querySelector("p"));
      return PLACEHOLDER.test(v) ? "" : v;
    },
    async close() {
      await closeAny();
      owner = null;
      await sleep(50);
    },
  };

  // Location: an autocomplete input (suggestions in a popper), not a role=combobox.
  const isAutocomplete = (el) => el.matches('input[aria-autocomplete="list"][aria-haspopup="listbox"]:not([role="combobox"])');

  // ----------------------------------------------------------- resume
  // Uploaded: the drop zone's screen-reader line ("Total 1 file selected") or the file's name in the field.
  function uploadedCheck(input, name) {
    const field = input.closest(FIELD) || input.parentElement;
    const t = text(field).toLowerCase();
    return /total [1-9]\d* files? selected/.test(t) || (!!name && t.includes(name.toLowerCase().replace(/\.[a-z0-9]+$/, "").slice(0, 8)));
  }
  // "The résumé will be parsed to fill in the application details": wait for the parse (name / email prefilled).
  async function afterUpload() {
    const filled = () => ["first_name", "last_name", "email"].some((n) => (document.querySelector(`input[data-input="${n}"]`)?.value || "").trim());
    const t0 = AAF.now();
    if (await waitFor(filled, 6000)) {
      await sleep(800);
      return `resume parse: fields prefilled after ${AAF.now() - t0} ms`;
    }
    return "resume parse: nothing prefilled within 6 s";
  }

  // ----------------------------------------------------------- job posting
  // The title is the page header ("Application: Software Engineer, ML ..."); location and description come from
  // the posting page (/<company>/jobs/<id>, fetched same-origin): its JSON-LD, else its Next.js data, else its text.
  async function jobInfo() {
    const h1 = text(document.querySelector("h1"));
    const title = h1.replace(/^application:\s*/i, "");
    const m = location.pathname.match(/^(\/[^/]+\/jobs\/[^/]+)\/apply\b/);
    let loc = "";
    let description = "";
    const doc = m ? await AAF.fetchDoc(location.origin + m[1]) : null;
    if (doc) {
      const ld = AAF.jobFromLD(doc);
      loc = ld.location || "";
      description = ld.description || "";
      if (!loc || !description) {
        try {
          const data = JSON.parse(doc.getElementById("__NEXT_DATA__")?.textContent || "null");
          const find = (o, k, d = 0) => (o && typeof o === "object" && d < 12 ? (k in o ? o[k] : Object.values(o).reduce((r, v) => r ?? find(v, k, d + 1), undefined)) : undefined);
          const locs = find(data, "locations") || find(data, "workLocations");
          if (!loc && Array.isArray(locs)) loc = locs.map((x) => (typeof x === "string" ? x : x?.name || x?.city || "")).filter(Boolean).join("; ");
          const desc = find(data, "description");
          if (!description && desc) description = AAF.htmlToText(typeof desc === "string" ? desc : JSON.stringify(desc));
        } catch {}
      }
      if (!description) description = text(doc.querySelector("main") || doc.body).slice(0, 12000);
    }
    return { title, location: loc, description: description.slice(0, 12000) };
  }

  AAF.adapters.rippling = AAF.makeFormAdapter({
    name: "rippling",
    detect: () => /(^|\.)rippling\.com$/.test(location.hostname) && /\/jobs\//.test(location.pathname),
    formSel: "form",
    formRoot,
    hasForm,
    isEduField: (f) => f.type !== "file" && (AAF.EDU_LABEL.test(f.nl) || !!globalThis.AAF_LEARN_RULES?.eduFixedLabel(f.label)),
    entrySel: FIELD,
    fieldInfo,
    customSelect,
    isAutocomplete,
    ignoreSel: '#turnstile-container *, [data-testid="input-aiOptOut"]',
    fileBoxSel: '[data-testid="resume"], label[type="DEFAULT"]',
    skipFile: (input) => /cover/i.test(input.getAttribute("data-testid") || ""),
    uploadedCheck,
    afterUpload,
    keepPrefilled: true,
    plainLocationFallback: true,
    jobInfo,
  });
})();
