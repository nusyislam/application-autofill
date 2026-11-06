// Application Autofill: iCIMS adapter (*.icims.com: careers-<company>.icims.com/jobs/<id>/<title>/candidate,
// and iCIMS forms embedded on company career sites).
//
// Built from a real form (careers-hmsy.icims.com, Harbor Marine Shipyard: form#profileForm inside
// icims_content_iframe; tests/fixtures/icims-combined.html). One page can hold everything: resume upload
// ("Upload Your Resume First To Prepopulate Your Information"), "Create a login" (Login, Password,
// Password re-enter), "Enter your information", collections (Phones, Addresses, College / University),
// questions, and a "Submit Profile" button.
//
// - Markup: rows `.iCIMS_TableRow` with the label in `.iCIMS_InfoField` and the control in `.iCIMS_InfoData`;
//   many controls have generic names (rcf2123), so the label is the row's InfoField text (`fieldInfo`).
//   Collections are `fieldset.iCIMS_CollectionGroup` with a legend ("Phones (1)"), an "Add More (Phones)"
//   link (`<a href="javascript:void(0)" onclick="showGroup(...)">`) after it. Date fields are Month / Day
//   selects + a Year input in one row (labelled "<row label> - Month" etc.).
// - Dropdowns: plain native selects (Phone Type), or iCIMS's own searchable widget over a hidden select
//   (`icimsdropdown-enabled="1"`, often `icimsdropdown-ajax="1"`: the select holds no options; they load into
//   `#<id>_icimsDropdown_ctnr ul.dropdown-results li.dropdown-result` when the `a#<id>_icimsDropdown` opens,
//   filtered server-side by typing into `input.dropdown-search`). `customSelect` drives that widget.
// - The application runs in an iframe (`#icims_content_iframe`); the manifest entry has all_frames. The
//   top-level iCIMS page around it never fills itself (`passiveFrame`); its floating button hands the
//   fill to the iframe (postMessage; the frame accepts it only from its parent on *.icims.com).
// - Account step = a page with nothing but sign-in / create-account fields: only the email is filled. On a
//   combined page only the passwords / security fields are skipped (sensitive on every portal).
// - Resume: already on file (the name next to "Replace Resume") = not uploaded again. A new upload submits
//   the form and reloads the frame; the run stops cleanly and continues in the reloaded page.
// - Repeatable experience / education blocks are matched by company / school; "Add More" inside the form
//   is clicked for entries without a block.

(() => {
  const AAF = globalThis.AAF;
  if (!AAF.once("adapter:icims")) return;
  const { visible, dbg, sleep, waitFor, click, key, kbd, typeInto } = AAF;

  const IS_ICIMS = (host) => /(^|\.)icims\.com$/.test(host || "");
  const inFrame = (() => {
    try {
      return window.top !== window;
    } catch {
      return true;
    }
  })();
  const byId = (id) => (id ? document.getElementById(id) : null);
  const text = (el) => (el ? (el.innerText ?? el.textContent ?? "") : "").replace(/\s+/g, " ").trim();

  // The application's controls (not header / nav / footer, a site search box, or a dropdown's own search input).
  const appControls = () =>
    [...document.querySelectorAll("input, select, textarea")].filter((el) => {
      const t = (el.type || "").toLowerCase();
      if (["hidden", "submit", "button", "search", "image", "reset"].includes(t)) return false;
      if (el.closest("header, nav, footer, [role=search]") || el.matches(".dropdown-search")) return false;
      return t === "file" || t === "radio" || t === "checkbox" || el.tagName === "SELECT" || visible(el);
    });
  // The form root: the <form> holding every application control, else their smallest common ancestor.
  // Never a class name.
  function formRoot() {
    const all = appControls();
    if (!all.length) return null;
    const form = all[0].closest("form");
    if (form && all.every((c) => form.contains(c))) return form;
    for (let el = all[0].parentElement; el && el !== document.body; el = el.parentElement) {
      if (all.every((c) => el.contains(c))) return el;
    }
    return document.body;
  }
  const hasOwnForm = () => appControls().length >= 2;

  // The iCIMS form iframe(s) on this page (top-level iCIMS page): by id / name, or an *.icims.com src.
  const formFrames = () =>
    [...document.querySelectorAll("iframe")].filter((fr) => {
      if (/icims_content_iframe/i.test(`${fr.id} ${fr.name}`)) return true;
      try {
        return !!fr.getAttribute("src") && IS_ICIMS(new URL(fr.src, location.href).hostname);
      } catch {
        return false;
      }
    });
  // A top-level page whose form lives in an iCIMS iframe: never filled itself (HMSY's top page logged
  // "fields found: 1 (text 1), form root <div#page>" from its own search box), unless it holds a real form.
  // The icims_content_iframe itself makes the top page passive whatever it holds (a job page can carry search
  // filters); any other *.icims.com iframe only when the top page has fewer than 5 controls of its own.
  const passiveFrame = () => !inFrame && (formFrames().some((fr) => /icims_content_iframe/i.test(`${fr.id} ${fr.name}`)) || (formFrames().length > 0 && appControls().length < 5));
  // The floating button on that page: ask the iframe to fill itself.
  function delegateFill() {
    if (!passiveFrame()) return false;
    for (const fr of formFrames()) {
      try {
        fr.contentWindow.postMessage({ aaf: "icims-fill" }, fr.getAttribute("src") ? new URL(fr.src, location.href).origin : location.origin);
      } catch {}
    }
    dbg(`asked the iCIMS form iframe to fill (${formFrames().map((fr) => fr.id || fr.name || "iframe").join(", ")})`);
    AAF.toast?.("Filling the application form below…", 4000);
    return true;
  }
  // Inside the iframe: fill when the parent iCIMS page's button asks.
  if (inFrame) {
    window.addEventListener("message", (e) => {
      if (e.source !== window.parent || e.data?.aaf !== "icims-fill") return;
      let host = "";
      try {
        host = new URL(e.origin).hostname;
      } catch {}
      if (!IS_ICIMS(host)) return;
      AAF.fillPage?.();
    });
  }

  // Account step: a password field and nothing but sign-in / create-account fields (email / login, names,
  // passwords, security question). Only email fields are filled there. A combined page (HMSY: resume,
  // "Create a login" and the whole profile on one page) is NOT an account step: its passwords are skipped
  // as sensitive and everything else is filled normally.
  const ACCOUNT = /pass|log ?in|user ?(name|id)|e-?mail|security|secret|first|last|given|family|confirm|re-?enter/i;
  const labelText = (el) => text(el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`));
  function accountStep() {
    if (!document.querySelector('input[type="password"]')) return false;
    return !appControls().some((el) => el.type !== "password" && !ACCOUNT.test(`${el.name} ${el.id} ${el.getAttribute("autocomplete") || ""} ${labelText(el)}`));
  }
  const restrictTo = (f) => !accountStep() || (f.type === "text" && /\be ?mail\b/.test(`${f.nl} ${f.nid}`));

  // ----------------------------------------------------------- labels
  // The row's InfoField text ("Legal First Name*"; the required star is kept for `required`). Date rows
  // get the part ("... (Month / Day / Year) - Month"). Collection fields carry their legend as `section`
  // ("Phones", "Branch of U.S. Armed Forces/Government Agency Served:"), and a bare "Type" / "Number"
  // label gets it in front ("Phone Type", "Phone Number (Format: 123-456-7890)").
  const clean = (s) => s.replace(/\s*required\.?\s*$/i, "").trim();
  const singular = (s) => s.replace(/sses$/i, "ss").replace(/([^s])s$/i, "$1");
  function fieldInfo(ctrl) {
    const data = ctrl.closest(".iCIMS_InfoData");
    const row = data?.parentElement;
    const cell = row && [...row.children].find((x) => x.classList?.contains("iCIMS_InfoField"));
    const set = ctrl.closest("fieldset.iCIMS_CollectionGroup");
    const section = set ? clean(text(set.querySelector("legend"))).replace(/\(\d+\)/g, "").replace(/\*/g, "").replace(/\s+/g, " ").trim() : "";
    let label = cell ? clean(text(cell)) : "";
    if (!label) return section ? { label: "", section } : null;
    // Several visible controls in one row (a date's Month / Day / Year): the part's own label is added.
    const parts = [...data.querySelectorAll("input, select, textarea")].filter((el) => el.type !== "hidden" && !el.matches(".dropdown-search") && (el === ctrl || visible(el)));
    // (Not for radios / checkboxes: those are one group, labelled by the row.)
    if (parts.length > 1 && parts.includes(ctrl) && !["radio", "checkbox"].includes(ctrl.type)) {
      const part = labelText(ctrl);
      if (part && part !== label.replace(/\*/g, "").trim()) label = `${label} - ${part}`;
    }
    if (/^[a-z]+$/i.test(section) && /^(type|number)(\s*\(|$)/i.test(label)) label = `${singular(section.split(/\s+/)[0])} ${label}`;
    return { label, section };
  }

  // ----------------------------------------------------------- iCIMS dropdown widget
  const widget = (sel) => byId(sel.id + "_icimsDropdown");
  const ctnrOf = (sel) => byId(sel.id + "_icimsDropdown_ctnr");
  const isOpen = (sel) => {
    const c = ctnrOf(sel);
    return !!c && !c.classList.contains("dropdown-invisible") && visible(c);
  };
  const loading = (sel) => {
    const l = ctnrOf(sel)?.querySelector(".dropdown-loading");
    return !!l && !l.classList.contains("hide") && visible(l);
  };
  const rows = (sel) =>
    [...(ctnrOf(sel)?.querySelectorAll("li.dropdown-result, [role=option]") || [])]
      .filter((li) => visible(li) && li.getAttribute("dropdown-index") !== "-1" && !li.querySelector(".dropdown-placeholder"))
      .map((el) => ({ el, text: text(el) }))
      .filter((o) => o.text);
  const searchBox = (sel) => {
    const i = ctnrOf(sel)?.querySelector("input.dropdown-search");
    return i && !i.classList.contains("dropdown-invisible") ? i : null;
  };
  const customSelect = {
    match: (sel) => sel.getAttribute("icimsdropdown-enabled") === "1" && !!widget(sel),
    searchable: (f) => f.ctrl.getAttribute("icimsdropdown-search") === "1" && !!searchBox(f.ctrl),
    menu: (f) => (isOpen(f.ctrl) ? ctnrOf(f.ctrl) : null),
    options: (f) => (isOpen(f.ctrl) && !loading(f.ctrl) ? rows(f.ctrl) : []),
    async open(f) {
      if (isOpen(f.ctrl)) return ctnrOf(f.ctrl);
      const a = widget(f.ctrl);
      if (!a) return null;
      click(a);
      if (!(await waitFor(() => isOpen(f.ctrl), 1500))) {
        kbd(a, "keydown", "ArrowDown", 40);
        await waitFor(() => isOpen(f.ctrl), 800);
      }
      if (!isOpen(f.ctrl)) dbg(`${f.label.slice(0, 60)}: the iCIMS dropdown didn't open; widget HTML: ${a.outerHTML.slice(0, 300)}`);
      return isOpen(f.ctrl) ? ctnrOf(f.ctrl) : null;
    },
    // Type into the widget's search box and wait for this search's own results (ajax lists keep the
    // previous rows until they arrive).
    async search(f, term) {
      const box = searchBox(f.ctrl);
      if (!box) return;
      if (box.value === term) return;
      const before = rows(f.ctrl).map((o) => o.text).join("|");
      await typeInto(box, term, { blur: false });
      await waitFor(() => !loading(f.ctrl) && rows(f.ctrl).map((o) => o.text).join("|") !== before, term ? 3000 : 1200);
      await sleep(150);
    },
    value(f) {
      const shown = byId(f.ctrl.id + "_fakeSelected_icimsDropdown");
      if (shown) return shown.querySelector(".dropdown-placeholder") ? "" : text(shown);
      const o = f.ctrl.selectedOptions?.[0];
      return o && o.value ? text(o) : "";
    },
    async close(f) {
      if (!isOpen(f.ctrl)) return;
      key(searchBox(f.ctrl) || widget(f.ctrl), "Escape");
      if (await waitFor(() => !isOpen(f.ctrl), 500)) return;
      click(widget(f.ctrl));
      await waitFor(() => !isOpen(f.ctrl), 500);
    },
  };

  // ----------------------------------------------------------- resume
  // On file already: the name shown next to "Replace Resume" (`#<field>_FileNameLabel`).
  function uploadedCheck(input, name) {
    const base = (input.id || input.name || "").replace(/_File$/, "");
    const lab = byId(base + "_FileNameLabel");
    const shown = lab && visible(lab) ? text(lab) : "";
    if (shown) return shown;
    const row = input.closest(".iCIMS_TableRow, tr, fieldset");
    return row && name && text(row).includes(name) ? name : false;
  }
  // A new upload submits the form (`this.form.submit()` with uploadResume=1) and reloads the frame with the
  // parsed resume: note it, so the reloaded page continues the fill.
  const CONT = "aaf-icims-continue";
  const beforeUpload = () => {
    try {
      sessionStorage.setItem(CONT, String(Date.now()));
    } catch {}
  };
  const afterUploadSettled = () => {
    try {
      sessionStorage.removeItem(CONT);
    } catch {}
  };
  try {
    const t = Number(sessionStorage.getItem(CONT));
    if (t && Date.now() - t < 120000) {
      sessionStorage.removeItem(CONT);
      const go = () =>
        setTimeout(() => {
          if (!hasOwnForm()) return;
          dbg("page reloaded after resume parse, continuing the fill");
          AAF.fillPage?.();
        }, 1500);
      if (document.readyState === "complete") go();
      else addEventListener("load", go, { once: true });
    }
  } catch {}

  // ----------------------------------------------------------- job posting
  // iCIMS job headers show locations like "US-CT-New London" (several separated by "|" or new lines) under
  // a "Location" / "Job Locations" heading (HMSY: `dl.iCIMS_JobHeaderGroup` dt / dd, inside the form);
  // they're rewritten "New London, CT" for the office rule. JSON-LD (shared) is the fallback.
  const fixLoc = (s) => s.replace(/\b([A-Z]{2})-([A-Z]{2})-([^|\n;]+)/g, (_, c, st, city) => `${city.trim()}, ${st}`);
  function jobInfo() {
    const root = formRoot();
    const outside = (el) => !root || root === document.body || !root.contains(el) || !!el.closest("dl, [class*='JobHeader' i], [class*='JobsTable' i]");
    let location = "";
    for (const el of document.querySelectorAll("dt, th, td, span, div, label, strong, h2, h3, h4")) {
      if (el.children.length > 1 || !outside(el)) continue;
      if (!/^(job )?locations?:?$/i.test((el.textContent || "").trim())) continue;
      const next = el.nextElementSibling || el.parentElement?.nextElementSibling;
      const t = (next?.innerText || next?.textContent || "").trim();
      if (t && t.length < 300) {
        location = fixLoc(t).split(/\s*(?:\||\n|;)\s*/).filter(Boolean).join("; ");
        break;
      }
    }
    const blocks = [...document.querySelectorAll("[class*='description' i], [class*='jobdetail' i], article, main")].filter((b) => !root || !root.contains(b));
    const description = blocks.map((b) => (b.innerText || "").trim()).sort((a, b) => b.length - a.length)[0] || "";
    return { location, description: description.slice(0, 12000) };
  }

  const A = AAF.makeFormAdapter({
    name: "icims",
    detect: () => IS_ICIMS(location.hostname),
    formSel: "form",
    formRoot,
    // The button shows on a page with its own form, or on the top-level iCIMS page hosting the form iframe.
    hasForm: () => hasOwnForm() || passiveFrame(),
    // Education in a collection is a repeatable block; a fixed education label outside one (Steadfast: plain School /
    // Degree / Major rows) goes to the education step, never the classifier.
    isEduField: (f) => f.type !== "file" && !!globalThis.AAF_LEARN_RULES?.eduFixedLabel(f.label) && !f.c.closest("fieldset.iCIMS_CollectionGroup"),
    fileBoxSel: ".iCIMS_TableRow, [class*='upload' i], [class*='file' i], [class*='resume' i], fieldset, tr",
    skipFile: (i) => !/resume|(^|[_\W])cv([_\W]|$)/i.test(`${i.id} ${i.name}`), // never the DD214 / other document uploads
    uploadedCheck,
    beforeUpload,
    afterUploadSettled,
    hiddenSelects: true,
    ignoreSel: ".dropdown-search",
    customSelect,
    fieldInfo,
    repeatables: true,
    addButtons: true,
    keepPrefilled: true,
    plainLocationFallback: true,
    jobInfo,
  });
  // Learning only on real application steps (not the account step).
  A.isApplicationFlow = () => hasOwnForm() && !accountStep();
  Object.assign(A, { restrictTo, passiveFrame, delegateFill });
  AAF.adapters.icims = A;
})();
