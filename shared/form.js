// Application Autofill: shared toolkit for single-page React application forms (Greenhouse, Ashby).
// `AAF.makeFormAdapter(cfg)` returns a full adapter (same interface as adapters/workday.js); the
// portal adapters only pass their selectors and quirks:
//   cfg.name, cfg.detect()          adapter name and host check
//   cfg.formSel                     the application form's root (falls back to document.body)
//   cfg.formRoot()                  optional: computes the root instead (Ashby), null = use formSel
//   cfg.hasForm()                   page hint: is there an application form on this page
//   cfg.isEduField(f)               fields filled by the education step (fillLate), not the main pass
//   cfg.fileBoxSel                  the wrapper around a file input that shows the uploaded file name
//   cfg.skipFile(input)             file inputs never used for the resume (Ashby's "Autofill from resume")
//   cfg.requiredSel                 an element inside a field container that marks it required
//   cfg.valueFromInput              comboboxes show their value in the input itself (not react-select)
//   cfg.dateInput(el)               text inputs that are really date pickers
//   cfg.entrySel                    a field's own wrapper: the container never grows past it
//   cfg.jobInfo()                   optional: the posting's { location, description } (shared/job.js)
//   cfg.suggestSel                  extra selector for a location autocomplete's suggestion rows (Lever)
//   cfg.plainLocationFallback       a location input that never shows suggestions gets the first accepted name typed
//   cfg.keepPrefilled               keep a value the portal prefilled (resume parse) when it matches the profile
//   cfg.labelSel                    the question text's element inside a field container (Lever `.application-label`)
//   cfg.uploadedCheck(input, name)  did the resume upload take? (default: the file name shows in fileBoxSel)
//   cfg.afterUpload()               optional wait after the upload (Lever: its resume parse); returns a log line
//   cfg.hiddenSelects               a hidden native <select> behind a custom widget (select2 / chosen style) is a field
//   cfg.repeatables                 repeated experience / education blocks, matched to profile entries by name (iCIMS)
//   cfg.noAI(f)                     fields Claude must never answer (Ashby: "your own, unassisted writing")
//   cfg.customSelect                a portal's own dropdown: over a hidden <select> (iCIMS), or a button with a portal menu
//                                   (Gem: `controls(root)` lists the buttons, which become dropdown fields): { match(el),
//                                   open(f) -> menu, menu(f), options(f) -> [{el, text}], search(f, term), value(f),
//                                   close(f), searchable(f) }. Its fields are kind "custom" and go through the same
//                                   choosers as react-select (setReact, chooseStep, setByNames, readOptions).
//   cfg.fieldInfo(ctrl)             the portal's own label for a control: { label, section } (iCIMS rows / collections)
//   cfg.addButtons                  repeatable blocks may get more blocks from an "Add" / "Add More" button inside the form
//   cfg.ignoreSel                   inputs that are part of a widget, never fields of their own
//   cfg.beforeUpload()              before the resume is set (iCIMS: its upload submits the form and reloads the frame)
//
// Discovery is control-first and label-driven: every input / select / textarea / combobox, plus
// Yes / No button toggles, grouped into fields; the label comes from label[for], aria-labelledby,
// legend, or a label element in the field's container.

(() => {
  const AAF = globalThis.AAF;
  if (!AAF.once("form")) return;
  const { norm, dbg, show, sleep, waitFor, visible, checkboxOn, parseDate, splitAlts, setField, timed } = AAF;
  const { click, key, kbd, typeInto, nativeSet, bestOption, hasPhrase, matchAlts, mark, unmark, toast } = AAF;
  const { choiceOptions, setChoice, setCheckbox, dataUrlToFile } = AAF; // shared/controls.js

  // Education card titles ("Education History", "Education", "Academic background") and search placeholders that say
  // what a box asks ("Search schools...", "Search degrees..."): see the education card naming in describe().
  const EDU_CARD = /^(education|education history|educational history|education background|educational background|academic (history|background)|schools? attended|your education)$/;
  const EDU_PLACEHOLDER = /^(search|select|find|type|enter|start typing)( (a|your|for))? (schools?|universit(y|ies)|colleges?|institutions?|degrees?|majors?|fields? of study|disciplines?)\b/;
  const EDU_SUB = [
    [/\b(schools?|universit(y|ies)|colleges?|institutions?)\b/, "School"],
    [/\bdegrees?( type| level)?\b/, "Degree"],
    [/\b(majors?|fields? of study|area of study|disciplines?|concentration)\b/, "Field of study"],
    [/\bgpa\b|\bgrade point\b/, "GPA"],
    [/\bstart( date| year| month)?\b|\bfrom\b/, "Start date"],
    [/\b(end|graduation|completion)( date| year| month)?\b|\bto\b/, "End date"],
  ];
  const eduNamed = new Set();
  // What a control in an education card asks: the nearest short text before it in its card (a label / div / span of a
  // few words naming school / degree / major / GPA / start / end), else its placeholder or aria-label.
  function eduSubLabel(ctrl, card, title) {
    const short = (t) => String(t || "").replace(/[*✱]/g, "").replace(/\s+/g, " ").trim();
    const named = (t) => {
      const n = norm(t);
      if (!n || n.length > 40 || EDU_CARD.test(n)) return "";
      const hit = EDU_SUB.find(([rx]) => rx.test(n));
      return hit ? hit[1] : "";
    };
    // Its own words first: a sub-label right before it (within 3 levels), then its placeholder / aria-label.
    let el = ctrl;
    for (let up = 0; el && el !== card?.parentElement && up < 3; up++, el = el.parentElement) {
      let prev = el.previousElementSibling;
      for (let k = 0; prev && k < 3; k++, prev = prev.previousElementSibling) {
        if (prev.querySelector?.("input, select, textarea, [role=combobox]")) break;
        const t = short(prev.textContent);
        if (t && named(t)) return t.length <= 30 ? t : named(t);
      }
    }
    const ph = short(ctrl.getAttribute?.("placeholder") || ctrl.getAttribute?.("aria-label") || "");
    if (ph && named(ph)) return named(ph);
    return EDU_PLACEHOLDER.test(title) ? named(title) : "";
  }

  // A custom question whose WHOLE label asks for a school / degree / major / GPA (Ashby, Lever): these
  // go to the education step (school keyword + aliases, degree fallback steps) instead of the main pass.
  AAF.EDU_LABEL = /^((current |most recent )?(school|university|college|institution)( name)?|name of (your )?(school|university|college)|(what )?(school|university|college) (do|did) you (attend|go to)|(which|what) (school|university|college) (are you (currently )?attending|do you (currently )?attend|did you (last )?attend)|degree( type)?|(highest |current )?degree( level)?|major|(intended )?major|field of study|area of study|discipline|gpa|(cumulative |overall )?gpa)$/;

  // Why an option matched a step, for the log: the same text, an abbreviation (BS for Bachelor of Science), the same
  // words with abbreviations expanded ("Computer Eng." = "Computer Engineering"), or a whole phrase inside it.
  function matchWhy(alts, text) {
    const t = norm(text);
    const exact = alts.find((a) => norm(a) === t);
    if (exact) return "same text";
    const ab = alts.find((a) => AAF.isAbbrev?.(a) && AAF.abbrevIn?.(text, a));
    if (ab) return `abbreviation "${ab}"`;
    const fk = alts.find((a) => AAF.sameField?.(a, text));
    if (fk) return `the same words as "${fk}", abbreviations expanded`;
    const ph = alts.find((a) => hasPhrase(text, a));
    return ph ? `contains "${ph}"` : "closest option";
  }

  AAF.makeFormAdapter = function makeFormAdapter(cfg) {
    // Every EEO / self-identification / diversity block on the page belongs to the fill, even outside the
    // form root (Ashby's survey containers sit beside the main form): the root grows to the smallest element
    // holding the form and those blocks. A block = a short heading naming it plus, within 6 levels up, an
    // element with choice controls (radio, checkbox, select), so a footer's "Equal Opportunity Employer"
    // line beside a newsletter box doesn't count. Logged once per heading.
    const EEO_HEAD = /\bdiversity\b|self[- ]?identif|equal (employment )?opportunit|\beeoc?\b|voluntary (disclosure|self)|\bdemographic|^veteran status$/i;
    const blocksLogged = new Set();
    function widenRoot(root) {
      if (!root || root === document.body) return root;
      const extra = [];
      // Headings by tag or class, Gem's generated ones too ("h2-45": Notional's "Voluntary Self-Identification" and
      // "Veteran Status" selects, outside the form container, were never found).
      for (const h of document.querySelectorAll("h1, h2, h3, h4, legend, strong, [class*='title'], [class*='header'], [class*='heading'], [class^='h1-'], [class^='h2-'], [class^='h3-'], [class*=' h2-'], [class*=' h3-']")) {
        if (root.contains(h) || h.contains(root)) continue;
        const t = (h.textContent || "").trim().replace(/\s+/g, " ");
        if (!t || t.length > 120 || !EEO_HEAD.test(t)) continue;
        let b = h;
        const hasControl = (el) => !!el.querySelector('input[type="radio"], input[type="checkbox"], select') || !!cfg.customSelect?.controls?.(el).length;
        for (let i = 0; b && i < 6 && !hasControl(b); i++) b = b.parentElement;
        if (!b || b === document.body || b.contains(root) || extra.some((x) => x.contains(b))) continue;
        extra.push(b);
        if (!blocksLogged.has(t)) {
          blocksLogged.add(t);
          dbg(`survey section found: ${t.slice(0, 80)}`);
        }
      }
      if (!extra.length) return root;
      let a = root;
      while (a && !extra.every((x) => a.contains(x))) a = a.parentElement;
      return a || root;
    }
    const formRoot = () => widenRoot(cfg.formRoot?.() || document.querySelector(cfg.formSel) || document.body);
    const isEduField = (f) => !!cfg.isEduField?.(f) || !!f.eduBlock;
    // Education blocks (cfg.eduBlocks; Ashby, Cascade Research): the School field's entry also holds Degree,
    // Start / End Date Month + Year dropdowns and a "Still Student?" box, which on their own read only "Month"
    // / "Year". The block is the smallest ancestor of the School field (6 levels at most) holding 2-12 other
    // fields and text about start / end dates, graduation or still studying, and no contact / resume fields.
    // Its fields go to the education step (`eduBlock`), each with the date title before it (`eduCtx`).
    const EDU_BLOCK_TEXT = /\b(start|end) (date|year)\b|\bgraduat|\bstill (a )?student\b|\bstill studying\b|\bcurrently (attending|enrolled|studying|study)\b|\bstudy here\b/i;
    const DATE_TITLE = /\b(start|end|from|to|graduation|completion)\b/i;
    // Never another field's own label (Nimbus: "Why do you want to work at Nimbus? - Graduation Date").
    function titleBefore(x, b, fields = []) {
      const cands = [...b.querySelectorAll("label, legend, h3, h4, h5, strong, [class*='title'], [class*='label'], [class*='heading']")]
        .filter((el) => !el.contains(x.c) && !x.c.contains(el) && !fields.some((y) => y !== x && y.c.contains(el)) && el.compareDocumentPosition(x.c) & Node.DOCUMENT_POSITION_FOLLOWING && DATE_TITLE.test(textOf(el)) && textOf(el).length <= 40);
      return cands.length ? textOf(cands[cands.length - 1]) : "";
    }
    // An education field: school, degree, major / field, GPA, start / end / graduation dates, "still student", or a
    // bare date part ("Month", "Year", "MM", "YYYY", or no label at all: the block's Month / Year dropdowns).
    // Melodex: "Start year" right after School was cut off; grade / class rank are part of the block (left yellow
    // unless the profile has them).
    const EDU_WORDS = /\b(school|university|college|institution|degree|major|minor|field of study|area of study|discipline|concentration|gpa|grade point|grades?|class rank|honou?rs|classification|graduat\w*|start (date|year|month)|end (date|year|month)|completion (date|year)|still (a )?student|still studying|currently (attending|enrolled|studying)|study here)\b/;
    const DATE_PART = /^(month|year|day|mm|yyyy|dd|select month|select year)\b/;
    // "Add a second degree?", "Add another company?": yes / no questions about the blocks, not block fields (a rule
    // answers them).
    const ADD_ANOTHER = /^(do you want to |would you like to |do you have )?(add|include)? ?(another|a second|an additional|more|a 2nd)\b/;
    function eduLike(x) {
      const own = norm(`${x.label || ""} ${x.ctrl?.getAttribute?.("placeholder") || ""} ${x.ctrl?.getAttribute?.("aria-label") || ""}`);
      if (!norm(x.label || "")) return true;
      if (ADD_ANOTHER.test(norm(x.label))) return false;
      if (DATE_PART.test(norm(x.label))) return true;
      return EDU_WORDS.test(own) && norm(x.label).length <= 60;
    }
    function markEduBlocks(fields) {
      if (!cfg.eduBlocks) return;
      // Blocks in page order: the Nth School field's block takes the Nth education entry (`eduIdx`).
      let idx = 0;
      for (const s of fields.filter((f) => cfg.isEduField?.(f) && /\b(school|university|college|institution)\b/.test(f.nl))) {
        s.eduIdx = idx++;
        let b = s.c;
        for (let i = 0; i < 6 && b && b !== document.body; i++) {
          b = b.parentElement;
          if (!b || b === document.body) break;
          const inside = fields.filter((x) => x !== s && b.contains(x.c));
          if (inside.length > 12 || inside.some((x) => /\b(email|phone|first name|last name|full name|resume|linkedin)\b/.test(x.nl))) break;
          if (inside.length >= 2 && EDU_BLOCK_TEXT.test(b.innerText || "")) {
            // Only the run of education fields around School, in page order, stopping at the first field that
            // isn't one (Nimbus: the section held School, Graduation Date, then "How many prior internships",
            // "Why do you want to work at Nimbus?", "Github Link", ..., which were all taken as education).
            const order = [...inside, s].sort((p, q) => (p.c.compareDocumentPosition(q.c) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
            const at = order.indexOf(s);
            const run = [];
            for (let i = at + 1; i < order.length && eduLike(order[i]); i++) run.push(order[i]);
            for (let i = at - 1; i >= 0 && eduLike(order[i]); i--) run.unshift(order[i]);
            const left = inside.filter((x) => !run.includes(x));
            const stop = order[at + 1 + run.filter((x) => order.indexOf(x) > at).length] || left[0];
            if (left.length && !AAF.namedLogged?.has("edublock|" + s.label)) AAF.namedLogged?.add("edublock|" + s.label), dbg(`education block: ${run.length} education field${run.length === 1 ? "" : "s"} with School; stopped at "${(stop?.label || "").slice(0, 60)}" (not an education field), ${left.length} other field${left.length === 1 ? "" : "s"} left to the normal rules`);
            if (!run.length) break;
            for (const x of run) {
              x.eduBlock = true;
              x.eduIdx = s.eduIdx;
              // Only a bare date part takes the title before it ("Start Date" for a "Month" dropdown).
              x.eduCtx = !norm(x.label || "") || DATE_PART.test(norm(x.label)) ? titleBefore(x, b, fields) : "";
            }
            // The controls under one date title, in page order (a Month + Year pair).
            for (const x of run) if (x.eduCtx) x.eduGroup = run.filter((y) => y.eduCtx === x.eduCtx && y.type !== "checkbox");
            break;
          }
        }
      }
    }

    // Work-experience blocks (cfg.eduBlocks forms; Melodex, revealed by "Do you have work experience?"): a "Most
    // recent company" / "Company" field starts a block, and the work fields after it in page order (role / title,
    // start / end year or date, "Still work here", location, description) belong to it, up to the first field that
    // isn't one. The Nth block takes the Nth experience (`workIdx`; the current one first). Filled by `fillWork`, never
    // the main pass or Claude.
    const WORK_ANCHOR = /^(most recent |current |previous |last |latest )?(company|employer|organi[sz]ation)( name)?$/;
    const WORK_WORDS = /\b(company|employer|organi[sz]ation|role|title|job title|position|start (date|year|month)|end (date|year|month)|still work\w*|currently work\w*|work here|current(ly)? (employed|working)|location|responsibilities|description)\b/;
    const workLike = (x) => !norm(x.label || "") || DATE_PART.test(norm(x.label)) || (!ADD_ANOTHER.test(norm(x.label)) && WORK_WORDS.test(norm(x.label)) && norm(x.label).length <= 60);
    const docOrder = (p, q) => (p.c.compareDocumentPosition(q.c) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
    function markWorkBlocks(fields) {
      if (!cfg.eduBlocks) return;
      const order = fields.slice().sort(docOrder);
      let idx = 0;
      for (const s of order.filter((f) => WORK_ANCHOR.test(f.nl) && !f.eduBlock && ["text", "dropdown"].includes(f.type))) {
        s.workBlock = true;
        s.workIdx = idx++;
        const run = [s];
        for (let i = order.indexOf(s) + 1; i < order.length; i++) {
          const x = order[i];
          if (x.eduBlock || WORK_ANCHOR.test(x.nl) || !workLike(x)) break;
          x.workBlock = true;
          x.workIdx = s.workIdx;
          run.push(x);
        }
        if (!AAF.namedLogged?.has("workblock|" + s.workIdx + s.label)) {
          AAF.namedLogged?.add("workblock|" + s.workIdx + s.label);
          dbg(`work experience block ${s.workIdx + 1}: ${show(run.map((x) => x.label || x.type))}`);
        }
      }
    }

    // ------------------------------------------------------- field discovery
    const isCombo = (el) => el.matches('input[role="combobox"]');
    // Yes / No toggles: two or three sibling <button>s (not radios) whose texts include Yes and No
    // (Ashby's boolean questions). The parent element is the group.
    const isToggleBtn = (el) => el.tagName === "BUTTON";
    function toggleButtons(root) {
      const byParent = new Map();
      for (const b of root.querySelectorAll("button")) {
        if (AAF.isOwnUI?.(b) || !visible(b)) continue;
        const p = b.parentElement;
        if (!byParent.has(p)) byParent.set(p, []);
        byParent.get(p).push(b);
      }
      const out = [];
      for (const [p, btns] of byParent) {
        const all = [...p.children].filter((x) => x.tagName === "BUTTON");
        const t = all.map((b) => norm(b.innerText));
        if (all.length >= 2 && all.length <= 3 && t.includes("yes") && t.includes("no")) out.push(...btns);
      }
      return out;
    }
    // Every fillable control: inputs, selects, textareas, react-select comboboxes, toggle buttons.
    // Radios / checkboxes and file inputs are often visually hidden behind styled labels or an
    // "Attach" button, so they're kept when their label (or parent) is visible.
    function controls(root) {
      const inputs = [...root.querySelectorAll("input, select, textarea")].filter((el) => {
        const t = (el.type || "").toLowerCase();
        if (["hidden", "submit", "button", "image", "reset"].includes(t)) return false;
        if (cfg.ignoreSel && el.matches(cfg.ignoreSel)) return false; // a widget's own parts (iCIMS dropdown search box)
        if (el.getAttribute("aria-hidden") === "true" && !isCombo(el)) return false; // react-select's required-input shim
        if (t === "file") return true;
        if (t === "radio" || t === "checkbox") {
          const lab = el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
          return visible(el) || visible(lab) || visible(el.parentElement);
        }
        if (isCombo(el)) return visible(el.closest('[class*="control"]') || el.parentElement);
        // A hidden native select behind a custom searchable widget: set through the select (the widget
        // mirrors it on change).
        if (cfg.hiddenSelects && el.tagName === "SELECT" && !visible(el)) {
          const w = el.nextElementSibling || el.parentElement;
          return !!w && visible(w) && /select2|chosen|dropdown|combo|select/i.test(`${typeof w.className === "string" ? w.className : ""} ${w.id || ""}`);
        }
        return visible(el);
      });
      // A portal's own dropdown buttons (Gem: a "Please select" button whose options open in a portal), in page order.
      const customs = cfg.customSelect?.controls?.(root) || [];
      if (customs.length) {
        inputs.push(...customs.filter((b) => !inputs.includes(b)));
        inputs.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
      }
      const toggles = toggleButtons(root);
      if (!toggles.length) return inputs;
      // An input mirroring a toggle's value belongs to the toggle, not a field of its own: anything
      // inside the buttons' parent (Ashby's `input[type=checkbox]` sits next to the two buttons and is
      // not hidden), or a hidden one next to it.
      const groups = new Set(toggles.map((b) => b.parentElement));
      const own = (el) => [...groups].some((g) => g.contains(el) || (g.parentElement?.contains(el) && !visible(el)));
      return [...inputs.filter((el) => !own(el)), ...toggles].sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
    }
    // Radios without a name or fieldset (Gem: ids only) belong to the nearest ancestor holding two or
    // more radios: the option list. Otherwise every "Yes" / "No" option became a field of its own.
    function radioGroupOf(el) {
      for (let a = el.parentElement, i = 0; a && i < 6; i++, a = a.parentElement) {
        if (a.querySelectorAll('input[type="radio"]').length >= 2) return a;
      }
      return null;
    }
    // Nameless checkboxes (Gem, Notional: "If you have held a U.S. security clearance in the past, what level?" became 5
    // separate checkbox fields, each labelled by its option): the nearest ancestor (6 levels) holding 2+ checkboxes,
    // no other control and at most one question label (cfg.labelSel), is their question. A lone consent box never
    // joins another question's.
    function checkboxGroupOf(el) {
      if (!cfg.labelSel) return null; // only where question labels can be told apart (Gem, Lever)
      for (let a = el.parentElement, i = 0; a && a !== document.body && i < 6; i++, a = a.parentElement) {
        if (a.querySelector('select, textarea, input:not([type="checkbox"]):not([type="hidden"])') || (cfg.labelSel && a.querySelectorAll(cfg.labelSel).length >= 2)) return null;
        if (a.querySelectorAll('input[type="checkbox"]').length >= 2) return a;
      }
      return null;
    }
    // Radios / checkboxes are grouped by their fieldset (or name, or for nameless radios / checkboxes their option
    // list), toggle buttons by their parent; everything else is one control.
    function groupsOf(ctrls) {
      const keys = [];
      const byKey = new Map();
      for (const el of ctrls) {
        let k = el;
        if (el.type === "radio" || el.type === "checkbox") k = el.closest("fieldset") || (el.name ? "name:" + el.name : (el.type === "radio" ? radioGroupOf(el) : checkboxGroupOf(el)) || el);
        else if (isToggleBtn(el)) k = el.parentElement;
        if (!byKey.has(k)) {
          byKey.set(k, []);
          keys.push(k);
        }
        byKey.get(k).push(el);
      }
      return keys.map((k) => byKey.get(k));
    }
    // The field's container: the outermost ancestor (up to 8 levels) that holds no other field's control.
    // That's the field wrapper on every generation of markup, label included.
    function containerFor(group, all) {
      const own = new Set(group);
      const others = all.filter((o) => !own.has(o));
      // A self-labelled control (aria-label / label[for]) whose parent already holds another field's control
      // (Ashby's Month + Year dropdowns side by side) is its own container; otherwise one field's outline
      // covered both. Unlabelled ones keep the shared parent, whose text labels them (classic Greenhouse's
      // "Start Date" MM / YYYY boxes).
      const g0 = group[0];
      const selfLabelled = !!g0.getAttribute("aria-label") || (!!g0.id && !!document.querySelector(`label[for="${CSS.escape(g0.id)}"]`));
      if (group.length === 1 && selfLabelled && others.some((o) => g0.parentElement?.contains(o))) return g0;
      let best = group[0].parentElement;
      for (let el = best, i = 0; el && el !== document.body && i < 8; i++, el = el.parentElement) {
        if (others.some((o) => el.contains(o))) break;
        best = el;
        // Ashby: a field alone in its section would otherwise take the whole section (header included).
        if (cfg.entrySel && el.matches(cfg.entrySel)) break;
      }
      return best;
    }
    // Label text without any controls nested in the label (classic boards put the <select> inside it).
    // Label text never includes widget chatter: an autocomplete's status / results inside the label
    // (Lever: "Current location No location found. Try entering a different location ... Loading"
    // went to Claude instead of the location rule), live regions, or hidden elements.
    const NOT_LABEL = '[aria-live], [role="status"], [role="alert"], [role="listbox"], [role="option"], [class*="dropdown"], [class*="results"], [class*="suggestion"], script, style, template';
    function textOf(el) {
      if (!el) return "";
      if (!el.querySelector(`input, select, textarea, ${NOT_LABEL}`)) return (el.innerText || "").replace(/\s+/g, " ").trim();
      // Walk the label's own text: skip controls and widget chatter, and (when the label is rendered)
      // anything not rendered.
      const shown = visible(el);
      let out = "";
      const walk = (n) => {
        for (const ch of n.childNodes) {
          if (ch.nodeType === 3) out += ch.nodeValue;
          else if (ch.nodeType === 1) {
            if (ch.matches("input, select, textarea, option") || ch.matches(NOT_LABEL)) continue;
            if (shown && !visible(ch) && getComputedStyle(ch).display !== "contents") continue;
            walk(ch);
          }
        }
      };
      walk(el);
      return out.replace(/\s+/g, " ").trim();
    }
    function labelFor(group, c) {
      const ctrl = group[0];
      const isChoice = ctrl.type === "radio" || ctrl.type === "checkbox";
      let t = "";
      if (!isChoice || group.length === 1) {
        if (ctrl.id && !(isChoice && group.length > 1)) t = textOf(document.querySelector(`label[for="${CSS.escape(ctrl.id)}"]`));
        if (!t) {
          const ids = ctrl.getAttribute("aria-labelledby");
          if (ids) t = ids.split(/\s+/).map((i) => textOf(document.getElementById(i))).join(" ").trim();
        }
      }
      if (!t && cfg.labelSel) t = textOf(c.querySelector(cfg.labelSel));
      // A label wrapping the control (`<label>Employer <input></label>`, iCIMS): its own text, controls stripped.
      if (!t && !isChoice) t = textOf(ctrl.closest("label"));
      if (!t) t = textOf(c.querySelector("legend"));
      if (!t) {
        // A label in the container that isn't one of the group's option labels.
        const optionLabel = (l) => {
          const f = l.getAttribute("for");
          const target = f && document.getElementById(f);
          return (target && (target.type === "radio" || target.type === "checkbox")) || l.querySelector('input[type="radio"], input[type="checkbox"]');
        };
        t = textOf([...c.querySelectorAll("label, .label, [class*='label']")].find((l) => !optionLabel(l) && textOf(l)));
      }
      // Labels in table cells (iCIMS): the row's first cell that holds no control.
      if (!t) {
        const row = c.closest("tr") || c.querySelector("tr");
        const cell = row && [...row.children].find((td) => /^(TD|TH)$/.test(td.tagName) && !td.querySelector("input, select, textarea"));
        if (cell) t = textOf(cell);
      }
      if (!t && isChoice && group.length === 1) t = textOf(ctrl.closest("label")) || textOf(ctrl.id && document.querySelector(`label[for="${CSS.escape(ctrl.id)}"]`));
      if (!t && !isToggleBtn(ctrl)) t = ctrl.getAttribute("aria-label") || ctrl.getAttribute("placeholder") || "";
      return t;
    }
    // A label read twice ("How many years of experience do you have How many years of experience do you have
    // working in ML?", Oriel: aria-labelledby naming the title and a block that repeats it): a leading run of
    // words that's repeated right after it is dropped; an exact "A A" becomes "A".
    function dedupeLabel(t) {
      const w = String(t || "").split(/\s+/).filter(Boolean);
      const k = (x) => norm(x);
      for (let n = Math.floor(w.length / 2); n >= 3; n--) {
        let same = true;
        for (let i = 0; i < n && same; i++) same = k(w[i]) === k(w[n + i]);
        if (same) return w.slice(n).join(" ");
      }
      return String(t || "");
    }
    // A field's description / helper text (normalized): the container's text without the label and the
    // option texts ("In-Office Work" + "Are you fully prepared to work from our Brooklyn, NY office five days
    // a week?", Oriel). "" when there's nothing substantial.
    function descOf(c, label, group) {
      let t = norm(textOf(c));
      const cut = (x) => {
        const n = norm(x || "");
        if (n) t = ` ${t} `.replace(` ${n} `, " ").trim();
      };
      cut(label);
      for (const el of group) cut(el.tagName === "BUTTON" ? textOf(el) : el.id && textOf(document.querySelector(`label[for="${CSS.escape(el.id)}"]`)));
      t = t.replace(/\b(select|select an option|choose|please select)\b/g, " ").replace(/\s+/g, " ").trim();
      // A short helper that states a length ("One sentence.", "50 words max") still counts: the draft limit reads it.
      return t.length >= 15 || (t && /\b(sentences?|words?|char(acter)?s?)\b/.test(t)) ? t.slice(0, 400) : "";
    }
    // Date inputs: <input type=date>, or a text input the portal marks as a date picker.
    const isDateText = (el) => !!cfg.dateInput?.(el);
    function describe(group, all) {
      const ctrl0 = group[0];
      const c = containerFor(group, all);
      const t = (ctrl0.type || "").toLowerCase();
      let type;
      let ctrl = ctrl0;
      let kind = null;
      if (ctrl0.tagName !== "SELECT" && cfg.customSelect?.match(ctrl0)) {
        type = "dropdown";
        kind = "custom";
      } else if (isToggleBtn(ctrl0)) {
        type = "radio";
        kind = "toggle";
        ctrl = c;
      } else if (t === "radio") {
        type = "radio";
        ctrl = c;
      } else if (t === "checkbox") {
        type = group.length > 1 ? "checkgroup" : "checkbox";
        if (group.length > 1) ctrl = c;
      } else if (t === "file") type = "file";
      else if (ctrl0.tagName === "SELECT") {
        type = "dropdown";
        kind = cfg.customSelect?.match(ctrl0) ? "custom" : "native";
      } else if (isCombo(ctrl0)) {
        type = "dropdown";
        kind = "react";
      } else if (ctrl0.tagName === "TEXTAREA") type = "textarea";
      else if (t === "date") {
        type = "date";
        kind = "native";
      } else if (isDateText(ctrl0)) {
        type = "date";
        kind = "text";
      } else {
        type = "text";
        // A plain text input with a location autocomplete list (classic Greenhouse, Ashby).
        if (/location/i.test(ctrl0.id + " " + ctrl0.name + " " + ctrl0.className) || cfg.isAutocomplete?.(ctrl0)) kind = "autocomplete";
      }
      // The adapter's row label (iCIMS: the row's InfoField cell), for single controls and for radio /
      // checkbox groups (Perimeter's veteran radios had no label of their own and were skipped silently).
      const info = group.length === 1 || ["radio", "checkbox"].includes(t) ? cfg.fieldInfo?.(ctrl0) : null;
      let rawLabel = dedupeLabel(info?.label || labelFor(group, c));
      // A lone checkbox whose own label is only "Yes" / "I agree" (2Password: "unhandled field: Yes"): the question is
      // the field's title (another label, legend or question title in its container); "Yes" stays its option text.
      if (t === "checkbox" && group.length === 1 && /^(yes|i agree|agree|i accept|accept|i confirm|confirm|i acknowledge|acknowledge|ok|okay)\s*[*✱]?$/i.test(rawLabel.trim())) {
        const own = ctrl0.id ? document.querySelector(`label[for="${CSS.escape(ctrl0.id)}"]`) : ctrl0.closest("label");
        const title = [...c.querySelectorAll("legend, label, [class*='question-title'], [class*='title']" + (cfg.labelSel ? `, ${cfg.labelSel}` : ""))].find((el) => el !== own && !el.contains(ctrl0) && textOf(el).trim() && !/^(yes|no)$/i.test(textOf(el).trim()));
        if (title) rawLabel = dedupeLabel(textOf(title));
      }
      // A control under an education card title (Kestrel, Ashby: "Education History" with School "Search schools..." and
      // "+ Add Education" was "classified education status: left for you"; the label was the card's title, so no
      // education rule knew it was the school): named by what it asks, its own sub-label in the card ("School",
      // "Degree") or its placeholder ("Search schools..." -> School), the title becoming its section. Also a field
      // labelled only by such a placeholder. Every form portal.
      let eduCard = "";
      const bareTitle = norm(rawLabel.replace(/[*✱]/g, ""));
      if (EDU_CARD.test(bareTitle) || EDU_PLACEHOLDER.test(bareTitle)) {
        const sub = eduSubLabel(ctrl0, c, bareTitle);
        if (sub) {
          if (EDU_CARD.test(bareTitle)) eduCard = rawLabel.replace(/[*✱]/g, "").trim();
          rawLabel = sub + (/[*✱]/.test(rawLabel) ? " *" : "");
          if (!eduNamed.has(eduCard + "|" + sub)) {
            eduNamed.add(eduCard + "|" + sub);
            dbg(`education card${eduCard ? ` "${eduCard}"` : ""}: a field named by ${EDU_CARD.test(bareTitle) ? "its sub-label / placeholder" : "its placeholder"} -> "${sub}"`);
          }
        }
      }
      // Required markers: "*" (Greenhouse), "✱" (Lever).
      const label = rawLabel.replace(/[*✱]/g, "").replace(/\s+/g, " ").trim();
      const id = (isToggleBtn(ctrl0) ? "" : ctrl0.id || ctrl0.name) || "";
      const required =
        /[*✱]/.test(rawLabel) ||
        group.some((el) => el.required || el.getAttribute("aria-required") === "true") ||
        (!!cfg.requiredSel && !!c.querySelector(cfg.requiredSel));
      const f = { c, id, label, nl: norm(label), nid: norm(id), type, ctrl, kind, required, group, section: info?.section || eduCard || "" };
      const desc = descOf(c, label, group);
      if (desc) f.desc = desc;
      if (cfg.noAI?.(f)) f.noAI = true;
      // A single checkbox under a card heading ("Confirmation of Information Provided"): its own option
      // text, and the card's text, for the consent / certification rule.
      if (type === "checkbox") {
        const own = textOf((ctrl0.id && document.querySelector(`label[for="${CSS.escape(ctrl0.id)}"]`)) || ctrl0.closest("label"));
        if (own && norm(own) !== f.nl) f.optionText = own;
        f.cardText = (c.innerText || "").replace(/\s+/g, " ").trim().slice(0, 800);
      }
      return f;
    }
    // Portals renumber ids when they re-render (Greenhouse: "school--0" became "school--1"), so a
    // field's stable identity is its id base (id without the trailing number) or, without an id, its
    // label, plus its position among fields with the same base: `refKey` and `nth`.
    const idBase = (id) => String(id || "").replace(/[-_]*\d+$/, "");
    // Once per fill: the fields under a self-identification / EEO heading (Gem, Notional: "Voluntary
    // Self-Identification" and "... of Veteran Status" with Gender, Race, Veteran status dropdowns), logged
    // `self-ID: found N fields (Gender, Race, Veteran status)`.
    let selfIdRun = null;
    function logSelfId(root, fields) {
      if (selfIdRun === AAF.run || !root) return;
      const heads = [...root.querySelectorAll("h1, h2, h3, h4, legend, strong, [class*='title'], [class*='header'], [class*='heading'], [class^='h1-'], [class^='h2-'], [class^='h3-'], [class*=' h2-'], [class*=' h3-']")]
        .filter((h) => {
          const t = (h.textContent || "").trim().replace(/\s+/g, " ");
          return t && t.length <= 120 && EEO_HEAD.test(t);
        });
      if (!heads.length) return;
      // The fields after the first such heading, up to the end of its section (the heading's parent).
      const scope = heads[0].parentElement;
      const after = (el) => !!(heads[0].compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
      const list = fields.filter((f) => scope?.contains(f.c) && after(f.c));
      if (!list.length) return;
      selfIdRun = AAF.run;
      dbg(`self-ID: found ${list.length} field${list.length === 1 ? "" : "s"} (${list.map((f) => f.label.slice(0, 30)).join(", ")})`);
    }
    function discover(root = formRoot()) {
      const all = controls(root);
      // One field per control: the same element or id described twice is filled twice (Greenhouse HCT:
      // "Are you a veteran?" was attempted twice).
      const seenEl = new Set();
      const seenId = new Set();
      const fields = groupsOf(all).map((g) => describe(g, all)).filter((f) => {
        const el = f.group[0];
        const id = el.id;
        if (seenEl.has(el) || (id && seenId.has(id))) {
          dbg(`${f.label.slice(0, 60)}: duplicate of an earlier field (same ${seenEl.has(el) ? "element" : `id "${id}"`}), skipped`);
          return false;
        }
        seenEl.add(el);
        if (id) seenId.add(id);
        return true;
      });
      // Labels sharing a section prefix ("New Grad 2027 Application Questions : Why are you interested in Notional?",
      // five textareas on Notional): the prefix becomes the field's section and the rest its label, so the rules, the
      // classifier and draft routing see the question itself. Only a " : " prefix two or more labels share.
      // "Questions : Why ..." or "Questions: Why ..."; a section title of 3+ words, never a part label like iCIMS's
      // "From: (Month / Day / Year)".
      const PRE = /^((?:[^\s:]+\s+){2,}[^\s:]+?)\s*:\s+(\S.*)$/;
      const shared = {};
      for (const f of fields) {
        const m = f.label.match(PRE);
        if (m) shared[m[1]] = (shared[m[1]] || 0) + 1;
      }
      for (const f of fields) {
        const m = f.label.match(PRE);
        if (!m || shared[m[1]] < 2) continue;
        if (!blocksLogged.has("prefix|" + m[1])) {
          blocksLogged.add("prefix|" + m[1]);
          dbg(`labels share the section prefix "${m[1].slice(0, 60)}" (${shared[m[1]]} fields): read without it`);
        }
        f.section ||= m[1];
        f.label = m[2];
        f.nl = norm(m[2]);
      }
      const seen = {};
      for (const f of fields) {
        f.refKey = `${f.type}|${idBase(f.id) || "label:" + f.nl}`;
        f.nth = seen[f.refKey] = (seen[f.refKey] ?? -1) + 1;
      }
      markEduBlocks(fields);
      markWorkBlocks(fields);
      logSelfId(root, fields);
      return fields;
    }

    // ---------------------------------------------------------- react-select / combobox
    const CS = cfg.customSelect;
    const isCustom = (f) => f.kind === "custom";
    const reactValue = (f) => {
      if (isCustom(f)) return CS.value(f);
      const single = f.c.querySelector('[class*="singleValue"], [class*="single-value"]');
      if (single) return single.innerText.trim();
      const multi = [...f.c.querySelectorAll('[class*="multiValue"] [class*="label"], [class*="multi-value__label"]')].map((e) => e.innerText.trim()).join(", ");
      if (multi || !cfg.valueFromInput) return multi;
      return (f.ctrl.value || "").trim();
    };
    // The open menu: by aria-controls, inside the field, or a portal menu (react-select menuPortalTarget).
    function reactMenu(f) {
      if (isCustom(f)) return CS.menu(f);
      const id = f.ctrl.getAttribute("aria-controls") || f.ctrl.getAttribute("aria-owns");
      const byId = id && document.getElementById(id);
      if (byId && visible(byId)) return byId.closest('[class*="menu"]') || byId;
      const inField = [...f.c.querySelectorAll('[class*="menu"], [role="listbox"]')].filter(visible)[0];
      if (inField) return inField;
      const portals = [...document.querySelectorAll('[id^="react-select"][id$="-listbox"], [class*="select__menu"]')].filter(visible);
      return portals[portals.length - 1] || null;
    }
    // An option's text: its first line. Ashby's school results read "Lakeview University / United States /
    // lakeview.edu" on three lines, and the whole text never equalled the value shown after the pick
    // ("clicked but not selected").
    const optLine = (el) => ((el.innerText || el.textContent || "").split(/\n/).map((t) => t.trim()).find(Boolean) || "");
    // Options (innermost), without "No options" / "Loading..." notices.
    const reactOptions = (menu) => {
      if (!menu) return [];
      const els = [...menu.querySelectorAll('[role="option"], [class*="option"], [id*="-option-"]')].filter(visible);
      const inner = els.filter((el) => !els.some((o) => o !== el && el.contains(o)) || el.matches('[role="option"]'));
      // A [role=option] holding styled lines (Ashby) is one option, not its line divs.
      const opts = inner.filter((el) => !inner.some((o) => o !== el && o.contains(el) && o.matches('[role="option"]')));
      return opts
        .filter((el) => !/notice/.test(el.className))
        .map((el) => ({ el, text: optLine(el) }))
        .filter((o) => o.text);
    };
    async function closeReact(f) {
      if (f && isCustom(f)) return CS.close(f);
      const el = f?.ctrl || document.activeElement;
      if (el) key(el, "Escape");
      el?.blur?.();
      // blur() fires no events when the page isn't focused; react-select needs focusout to reset.
      el?.dispatchEvent?.(new FocusEvent("focusout", { bubbles: true }));
      await sleep(100);
    }
    // react-select only opens on a control click once it believes its input is focused, and el.focus()
    // fires no focus events while the page itself isn't focused (DevTools open, another window). So
    // dispatch focusin / focus explicitly. (Greenhouse menus read [] for School and Degree without this.)
    function focusReact(f) {
      f.ctrl.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
      f.ctrl.focus();
      f.ctrl.dispatchEvent(new FocusEvent("focus"));
    }
    // A field described earlier may have been replaced by a re-render (after parsing an uploaded
    // resume): its control is detached, so focusing / typing into it does nothing ("focused=false,
    // aria-expanded=false, menu not found" on School and Degree). Swap in the live field, in place, so
    // every caller holding `f` sees it: by id base + position (school--0 -> school--1), else by label +
    // position within the same section (education or not). Never by exact id: ids get renumbered.
    function live(f) {
      if (f.ctrl?.isConnected && f.c?.isConnected) return f;
      const all = discover();
      const byPos = (list) => list[f.nth ?? 0] || (list.length === 1 ? list[0] : null);
      const fresh =
        (f.refKey && byPos(all.filter((x) => x.refKey === f.refKey))) ||
        byPos(all.filter((x) => x.type === f.type && x.nl === f.nl && isEduField(x) === isEduField(f)));
      if (fresh) {
        dbg(`${f.label.slice(0, 60)}: field was re-rendered, using the live one (id "${f.id}" is now "${fresh.id}")`);
        Object.assign(f, fresh);
      } else dbg(`${f.label.slice(0, 60)}: field is detached and no live field matches (id base "${idBase(f.id)}", label "${f.label}", position ${f.nth})`);
      return f;
    }
    // Open the menu: focus (some boards open on focus), else mousedown on the control (clicking an
    // already-open menu would close it), else ArrowDown. Logs which method opened it.
    async function openReact(f) {
      live(f);
      if (isCustom(f)) {
        const m = await CS.open(f);
        dbg(`${f.label.slice(0, 60)}: menu ${m ? "opened" : "did not open"}`);
        return m;
      }
      const ctl = f.ctrl.closest('[class*="control"]') || f.ctrl;
      focusReact(f);
      let method = "focus";
      let menu = await waitFor(() => reactMenu(f), 300);
      if (!menu) {
        method = "click";
        click(ctl);
        menu = await waitFor(() => reactMenu(f), 1200);
      }
      if (!menu) {
        method = "ArrowDown";
        kbd(f.ctrl, "keydown", "ArrowDown", 40);
        menu = await waitFor(() => reactMenu(f), 800);
      }
      dbg(`${f.label.slice(0, 60)}: menu ${menu ? `opened by ${method}` : "did not open on focus, click, or ArrowDown"}`);
      return menu;
    }
    // Run a fill; if it failed because the field was re-rendered DURING it (a resume parse landing
    // mid-search), swap in the live field and run it once more. `ok(result)` says whether it worked.
    async function retryIfDetached(f, run, ok = (r) => !!r) {
      let r = await run();
      if (!ok(r) && !(f.ctrl?.isConnected && f.c?.isConnected)) {
        dbg(`${f.label.slice(0, 60)}: re-rendered during the fill, trying once more`);
        live(f);
        r = await run();
      }
      return r;
    }
    // Type a search term into the combobox (the same way for every react-select: Country, Location,
    // School, Degree, ...); logs when typing is what opened the menu.
    async function typeSearch(f, term) {
      live(f);
      if (isCustom(f)) return CS.search(f, term);
      const wasOpen = !!reactMenu(f);
      await typeInto(f.ctrl, term, { blur: false });
      if (!wasOpen && (await waitFor(() => reactMenu(f), 1000))) dbg(`${f.label.slice(0, 60)}: menu opened by typing "${term}"`);
    }
    // Options currently in the menu, waiting up to `ms` for at least one. Skips "Loading..." /
    // "No options" notices (not options).
    // The open menu's options for any popup kind.
    const menuOpts = (f) => (isCustom(f) ? CS.options(f) : reactOptions(reactMenu(f)));
    // Clears typed search text (never the control itself: a custom widget's control is its <select>).
    const clearSearch = (f) => (isCustom(f) ? CS.search(f, "") : typeInto(f.ctrl, "", { blur: false }));
    // A custom widget whose list is searched server-side shows only part of its options until typed into.
    const partialList = (f) => isCustom(f) && !!CS.searchable?.(f);
    const menuOptions = async (f, ms) => (await waitFor(() => {
      if (!f.ctrl.isConnected) return []; // re-rendered: stop waiting (the caller retries on the live field)
      const o = menuOpts(f);
      return o.length ? o : null;
    }, ms)) || [];
    // Why a menu read nothing, for the log: menu state, the input's ARIA state, and the menu's HTML.
    function menuDiag(f) {
      const m = reactMenu(f);
      const lbs = [...document.querySelectorAll('[role="listbox"], [class*="__menu"]')].filter(visible).length;
      return `menu ${m ? `found (${(m.className || m.id || m.tagName).toString().slice(0, 60)}, text "${(m.innerText || "").trim().slice(0, 60)}")` : "not found"}; ` +
        `aria-expanded=${f.ctrl.getAttribute("aria-expanded")}, aria-controls=${f.ctrl.getAttribute("aria-controls") || "none"}, ` +
        `focused=${document.activeElement === f.ctrl}, detached=${!f.ctrl.isConnected}, visible listboxes/menus on page=${lbs}` +
        (m ? `; menu HTML: ${m.outerHTML.slice(0, 1500)}` : "");
    }
    // Selected: the control shows the clicked option, or part of it (phone Country shows "+1" for
    // "United States +1"). A combobox whose input holds the value (cfg.valueFromInput) must show the
    // option exactly: the typed search text is a part of it too.
    const selectedOk = (f, text) => () => {
      const v = norm(reactValue(f));
      const t = norm(text);
      if (cfg.valueFromInput && !f.c.querySelector('[class*="singleValue"], [class*="single-value"]')) return v === t;
      return !!v && (v === t || v.split(", ").includes(t) || t.includes(v));
    };

    // react-select with an ordered fallback list: open, take the first alternative with a strong match
    // (then a weak one) among the listed options; if nothing matches (or the list is an async search),
    // type each alternative in order and match its results. Success = the control shows the value.
    async function setReact(f, wanted) {
      const alts = (Array.isArray(wanted) ? wanted : [wanted]).filter(Boolean).map(String);
      await openReact(f);
      let opts = await menuOptions(f, 1500);
      // Leftover search text filters the menu (a previous attempt's typing): clear it and read again.
      if (!opts.length && !cfg.valueFromInput && !isCustom(f) && (f.ctrl.value || "").trim()) {
        dbg(`${f.label.slice(0, 60)}: the menu was filtered by leftover text "${f.ctrl.value}", clearing it`);
        await typeInto(f.ctrl, "", { blur: false });
        opts = await menuOptions(f, 1000);
      }
      const first = pickAlt(opts, alts);
      let pick = first?.o;
      let pickI = first?.i ?? -1;
      let everSaw = opts.length > 0;
      // The menu listed its options without typing: match against that full list only. Typing a long
      // fallback ("I am not a protected veteran") filters a static menu down to nothing (HCT: the
      // veteran question failed with options: []). Typing is only for async menus, empty until typed.
      const listed = opts.length > 0 && !partialList(f);
      if (!pick && listed) {
        dbg(`no option for ${show(alts)} in ${f.label.slice(0, 60)}; options:`, show(opts.map((o) => o.text).slice(0, 25)));
        AAF.run.noMatch?.add(`${f.type}|${f.nl}`);
      }
      const budget = AAF.now() + 8000; // all typed searches together
      for (const [ai, a] of alts.entries()) {
        if (pick || listed || AAF.now() > budget) break;
        pickI = ai;
        await typeSearch(f, a.split("|")[0]);
        const end = Math.min(AAF.now() + 4000, budget);
        while (AAF.now() < end && f.ctrl.isConnected) {
          opts = menuOpts(f);
          everSaw ||= opts.length > 0;
          if ((pick = bestOption(opts, a, 85))) break;
          await sleep(150);
        }
        if (!pick) pick = bestOption(opts, a);
        if (!pick) dbg(`no option for "${a}" in ${f.label.slice(0, 60)}; options:`, show(opts.map((o) => o.text).slice(0, 15)));
      }
      // Extra search terms (country: "United"): typed, but a result must strongly match one of the alternatives.
      for (const term of (!pick && !listed && wanted?.searches) || []) {
        await typeSearch(f, term);
        const end = AAF.now() + 4000;
        while (!pick && AAF.now() < end && f.ctrl.isConnected) {
          opts = menuOpts(f);
          everSaw ||= opts.length > 0;
          for (const [ai, a] of alts.entries()) {
            if ((pick = bestOption(opts, a, 85))) {
              pickI = ai;
              dbg(`${wanted.what || f.label.slice(0, 60)}: searched "${term}"`);
              break;
            }
          }
          if (!pick) await sleep(150);
        }
        if (pick) break;
        dbg(`no option for ${show(alts)} after searching "${term}" in ${f.label.slice(0, 60)}; options:`, show(opts.map((o) => o.text).slice(0, 15)));
      }
      if (!pick && !everSaw) dbg(`${f.label.slice(0, 60)}: the menu never showed options: ${menuDiag(f)}`);
      if (!pick) {
        await clearSearch(f);
        await closeReact(f);
        return wanted?.what ? pickOther(f, wanted.what) : false;
      }
      click(pick.el);
      let ok = !!(await waitFor(selectedOk(f, pick.text), 1500));
      // A portal's own dropdown (Gem) that didn't take the click: reopen and click the same option once more.
      if (!ok && isCustom(f) && CS.controls) {
        dbg(`clicked "${pick.text}" in ${f.label.slice(0, 60)} but it shows "${reactValue(f) || "(nothing)"}"; trying once more`);
        await closeReact(f);
        await openReact(f);
        const again = (await menuOptions(f, 1500)).find((o) => norm(o.text) === norm(pick.text));
        if (again) {
          click(again.el);
          ok = !!(await waitFor(selectedOk(f, pick.text), 1500));
        }
      }
      await closeReact(f);
      if (ok) {
        f.picked = pick.text;
        logAlt(wanted, alts, pickI, pick.text);
      }
      if (!ok) dbg(`clicked "${pick.text}" in ${f.label.slice(0, 60)} but it shows "${reactValue(f)}"`);
      return ok;
    }

    // The first alternative with a strong match (score >= 85), then the first with a weak one: { o, i }.
    const pickAlt = (opts, alts) => {
      for (const min of [85, undefined]) for (const [i, a] of alts.entries()) {
        const o = bestOption(opts, a, min);
        if (o) return { o, i };
      }
      return null;
    };
    // A fallback list tagged with `what` (how did you hear) logs which alternative matched.
    const logAlt = (wanted, alts, i, text) => {
      if (wanted?.what && alts.length > 1) dbg(`${wanted.what}: fallback ${i + 1} ("${alts[i]}") matched "${text}"`);
    };

    // ---------------------------------------------------------- native select
    const selectOptions = (sel) =>
      [...sel.options].map((o) => ({ el: o, text: (o.text || "").trim(), value: o.value })).filter((o) => o.text && o.value !== "");
    function pickNative(f, o) {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(f.ctrl, o.value);
      f.ctrl.dispatchEvent(new Event("input", { bubbles: true }));
      f.ctrl.dispatchEvent(new Event("change", { bubbles: true })); // select2 / jQuery mirror the select on change
      return f.ctrl.value === o.value;
    }
    async function setNative(f, wanted) {
      const alts = (Array.isArray(wanted) ? wanted : [wanted]).filter(Boolean);
      const opts = selectOptions(f.ctrl);
      const hit = pickAlt(opts, alts);
      const pick = hit?.o;
      if (!pick) {
        dbg("no dropdown match", f.label, show(wanted), `${opts.length} options seen:`, show(opts.map((o) => o.text).slice(0, 20)));
        return wanted?.what ? pickOther(f, wanted.what) : false;
      }
      const ok = pickNative(f, pick);
      if (ok) {
        f.picked = pick.text;
        logAlt(wanted, alts, hit.i, pick.text);
      }
      await sleep(100);
      return ok;
    }

    // ------------------------------------------------------- turned off by the form
    // A field the form has disabled (Old Harbor: checking "Still Student?" disables End Date; the fill set End Date
    // first and the final sweep refilled it, and submit said "Invalid value: Education History") is never filled or
    // refilled. Off = disabled, aria-disabled, inside a disabled fieldset, or (the control or a wrapper up to 3 levels,
    // inside its field) Ashby's data-disabled="true", aria-disabled or a "disabled" class (react-select's "--is-disabled",
    // CSS-module "_disabled_x"); a read-only text box too, but not one that opens a list or picker (combobox /
    // aria-haspopup). Groups: every option off.
    const DISABLED_CLASS = /(^|[\s_-])(is-?)?disabled([\s_-]|$)/i;
    function ctrlOff(f, el) {
      if (!el) return false;
      if (el.disabled || el.getAttribute("aria-disabled") === "true" || el.closest("fieldset[disabled]")) return true;
      let n = el;
      for (let i = 0; i < 4 && n && n !== document.body; i++, n = n.parentElement) {
        if (n.getAttribute("data-disabled") === "true" || n.getAttribute("aria-disabled") === "true") return true;
        if (DISABLED_CLASS.test(typeof n.className === "string" ? n.className : "")) return true;
        if (n === f.c) break;
      }
      return !!el.readOnly && el.matches("textarea, input:not([type=checkbox]):not([type=radio])") && !el.matches('[role="combobox"], [aria-haspopup]') && !["react", "custom", "autocomplete"].includes(f.kind);
    }
    function isDisabled(f) {
      const els = (f.group?.length ? f.group : [f.ctrl]).filter(Boolean);
      return els.length > 0 && els.every((el) => ctrlOff(f, el));
    }

    // ------------------------------------------------------- Yes / No toggles
    // Two <button>s, not radios. "Selected" is whatever the portal shows: aria-pressed / -checked /
    // -selected, or an active / selected class (Ashby: "_active_..."). If the portal shows neither,
    // a click counts when the clicked button's class changed and now differs from the others.
    const toggleOpts = (f) => [...f.c.querySelectorAll("button")].filter((b) => f.group.some((g) => norm(g.innerText) === norm(b.innerText))).map((el) => ({ el, text: (el.innerText || "").trim() }));
    // When the buttons carry aria state (Ashby: aria-pressed, rendered from React state), only that counts:
    // a class alone is styling, and a hover / focus "_active_" class once passed for selected with
    // aria-pressed="false" (Vellum: "Yes" looked selected, submit said "Missing entry for required field").
    const ariaState = (b) => ["aria-pressed", "aria-checked", "aria-selected"].map((a) => b.getAttribute(a)).find((v) => v === "true" || v === "false");
    const pressed = (b) => {
      const group = b.parentElement ? [...b.parentElement.children].filter((x) => x.tagName === "BUTTON") : [b];
      if (group.some((x) => ariaState(x) != null)) return ariaState(b) === "true";
      return /(^|[\s_-])(active|selected|checked|pressed|is-?selected)([\s_-]|$)/i.test(typeof b.className === "string" ? b.className : "");
    };
    // Ashby's mirror checkbox (next to the buttons) holds the submitted value: Yes = checked, No = unchecked.
    const mirrorOf = (f) => toggleOpts(f)[0]?.el.parentElement?.querySelector('input[type="checkbox"]') || null;
    // Registered = the portal's own state agrees: the button's aria state (or class, when there's no aria),
    // and the mirror checkbox for Yes / No.
    function toggleRegistered(f, text) {
      const o = toggleOpts(f).find((x) => norm(x.text) === norm(text || ""));
      if (!o || !pressed(o.el)) return false;
      const m = mirrorOf(f);
      if (m && /^(yes|no)$/.test(norm(o.text)) && m.checked !== (norm(o.text) === "yes")) return false;
      return true;
    }
    const toggleStateText = (f) => {
      const m = mirrorOf(f);
      return toggleOpts(f).map((o) => `${o.text}: aria-pressed=${o.el.getAttribute("aria-pressed") ?? "none"}, class="${(typeof o.el.className === "string" ? o.el.className : "").trim().slice(0, 60)}"`).join("; ") + (m ? `; mirror checkbox checked=${m.checked}` : "");
    };
    // Ashby's hidden <input type="checkbox" name=<field id>> holds the submitted Yes / No. The button click is supposed
    // to set it, but on real pages it didn't always take (Vellum, Rivulet, then Old Harbor's sponsorship "No": pressed,
    // submit said "Missing entry"), and "No" (unchecked) looks the same as no answer. So every Yes / No answer is also
    // set through the checkbox itself, the way the component's own handler sees a change: a real click on it (React's
    // checkbox onChange listens to click; the click fires input / change), which toggles it. Already in the wanted
    // state: clicked twice (off and on again), so the form hears this answer. Then both must agree, 300 ms later too:
    // the wanted button aria-pressed="true" and the checkbox checked for Yes / unchecked for No; if the checkbox's
    // handler moved the buttons, the wanted button is clicked again (and the checkbox set once more if it disagrees).
    // Once per field per run (`committed`); every toggle without the checkbox is unchanged.
    let committedRun = null;
    let committed = new WeakMap();
    const committedOf = (f) => {
      if (committedRun !== AAF.run) {
        committedRun = AAF.run;
        committed = new WeakMap();
      }
      return committed.get(f.c);
    };
    async function commitMirror(f, text) {
      const t = norm(text || "");
      const m = mirrorOf(f);
      if (!m || !/^(yes|no)$/.test(t)) return true;
      const want = t === "yes";
      const twice = m.checked === want;
      for (let i = 0; i < (twice ? 2 : 1); i++) {
        click(mirrorOf(f) || m);
        await sleep(150);
      }
      const agree = () => {
        const mm = mirrorOf(f);
        return !!mm && mm.checked === want && toggleRegistered(f, text);
      };
      let fixed = "";
      if (!agree()) {
        const b = toggleOpts(f).find((o) => norm(o.text) === t);
        if (b && !pressed(b.el)) {
          click(b.el);
          await sleep(250);
          fixed = `, clicked "${b.text}" again`;
        }
        const mm = mirrorOf(f);
        if (mm && mm.checked !== want) {
          click(mm);
          await sleep(150);
          fixed += ", set the checkbox once more";
        }
      }
      await sleep(300);
      const ok = agree();
      dbg(`yes/no "${text}" in ${f.label.slice(0, 60)}: set the hidden checkbox (name="${m.name || m.id || "?"}") by clicking it${twice ? ` twice (it already read ${want ? "checked" : "unchecked"})` : ""}${fixed} -> ${ok ? "registered" : "NOT registered"} (${toggleStateText(f)})`);
      if (ok) {
        committedOf(f);
        committed.set(f.c, t);
      }
      return ok;
    }
    async function setToggle(f, wanted) {
      const opts = toggleOpts(f);
      const pick = Array.isArray(wanted) ? wanted.filter(Boolean).map((w) => bestOption(opts, w)).find(Boolean) : bestOption(opts, wanted);
      if (!pick) {
        dbg(`no toggle button matches ${JSON.stringify(wanted)} in ${f.label.slice(0, 60)}; buttons:`, show(opts.map((o) => o.text)));
        return false;
      }
      // The clicked button, re-found by text if the click re-rendered the group.
      const cur = () => (pick.el.isConnected ? pick.el : toggleOpts(f).find((o) => o.text === pick.text)?.el);
      // Already registered (not merely styled): nothing to click, but the hidden checkbox is set once this run.
      if (cur() && toggleRegistered(f, pick.text)) {
        if (mirrorOf(f) && committedOf(f) !== norm(pick.text) && !(await commitMirror(f, pick.text))) return false;
        f.picked = pick.text;
        return true;
      }
      if (cur() && pressed(cur())) dbg(`toggle "${pick.text}" in ${f.label.slice(0, 60)} looks selected but isn't registered (${toggleStateText(f)}); clicking it`);
      const before = opts.map((o) => o.el.className);
      // Aria state or a mirror checkbox: judged by them only. Neither: a class change that sets it apart.
      const hasState = () => toggleOpts(f).some((o) => ariaState(o.el) != null) || !!mirrorOf(f);
      const changed = () => {
        const b = cur();
        if (!b) return false;
        if (hasState()) return toggleRegistered(f, pick.text);
        if (pressed(b)) return true;
        const others = toggleOpts(f).filter((o) => o.el !== b).map((o) => o.el.className);
        return b.className !== before[opts.indexOf(pick)] && !others.includes(b.className);
      };
      click(pick.el);
      let ok = !!(await waitFor(changed, 1000));
      // Shown as pressed but the mirror disagrees (or nothing changed): one more real click, unless the
      // button now reads as pressed (clicking a pressed toggle can unselect it).
      if (!ok && cur() && !pressed(cur())) {
        dbg(`toggle "${pick.text}" in ${f.label.slice(0, 60)} not registered after the click (${toggleStateText(f)}); clicking once more`);
        click(cur());
        ok = !!(await waitFor(changed, 1000));
      }
      // Shown as selected is not registered: aria-pressed is rendered from React state, so it must
      // still hold after a re-render (a value the state didn't take reverts).
      if (ok) {
        await sleep(300);
        ok = changed();
        if (!ok) dbg(`toggle "${pick.text}" in ${f.label.slice(0, 60)} showed as selected, then reverted (not registered)`);
      }
      // Still not registered while the button reads pressed (the stored answer was reset under a button that
      // kept showing it): force a real change, the other option, then this one.
      if (!ok && cur() && pressed(cur())) {
        const other = toggleOpts(f).find((o) => norm(o.text) !== norm(pick.text));
        if (other) {
          dbg(`toggle "${pick.text}" in ${f.label.slice(0, 60)} shows pressed but isn't registered (${toggleStateText(f)}); clicking "${other.text}", then "${pick.text}"`);
          click(other.el);
          await sleep(250);
          if (cur()) click(cur());
          ok = !!(await waitFor(changed, 1000));
          if (ok) {
            await sleep(300);
            ok = changed();
          }
        }
      }
      if (ok && mirrorOf(f)) ok = await commitMirror(f, pick.text);
      if (ok) {
        f.picked = pick.text;
        const i = toggleFills.findIndex((r) => r.f.c === f.c);
        if (i >= 0) toggleFills.splice(i, 1);
        toggleFills.push({ f, text: pick.text });
      } else dbg(`toggle "${pick.text}" in ${f.label.slice(0, 60)} didn't register (${toggleStateText(f)}); group HTML: ${(cur()?.parentElement?.outerHTML || "").slice(0, 500)}`);
      return ok;
    }
    // Yes / No answers set this run, re-checked after the fill (cfg.watchToggles, Ashby): for 20 s, every
    // second, each one must still be registered (aria + mirror checkbox); one that was reset (a late resume
    // parse) is clicked again, logged "re-registered: <label> (reset after the fill)". A question you click
    // yourself is left alone from then on. Not while another fill runs.
    const toggleFills = [];
    const userToggled = new WeakSet();
    // At the end of every fill (cfg.watchToggles, Ashby; awaited, before the Done toast): EVERY Yes / No question on
    // the form showing an answer is checked, not only those set this run. Set this run: aria-pressed and the hidden
    // checkbox must still agree, else it's set again (setToggle, which sets the checkbox too). Showing an answer this
    // run didn't set (kept): its hidden checkbox is set once (commitMirror). Your own clicks are left alone. Logged
    // `yes/no check at the end: N questions with an answer, N registered ...`.
    async function checkAllToggles() {
      const all = discover().filter((x) => x.kind === "toggle" && mirrorOf(x));
      const setBy = (f) => toggleFills.find((r) => r.f.c === f.c || r.f.nl === f.nl);
      const shown = all.map((f) => ({ f, text: toggleOpts(f).find((o) => pressed(o.el))?.text || setBy(f)?.text || "" })).filter((r) => r.text && !userToggled.has(r.f.c));
      if (!shown.length) return;
      const again = [];
      const bad = [];
      for (const { f, text } of shown) {
        const want = setBy(f)?.text || text;
        if (toggleRegistered(f, want) && committedOf(f) === norm(want)) continue;
        // Kept from an earlier fill in this tab (a rerun): that run set it through its checkbox; registered = handled,
        // not clicked again (Dodecal: every kept Yes / No was "not set in the hidden checkbox this run; setting it again").
        // ("Set by an earlier fill": recorded before this run started; this run's own fill must still commit it.)
        if (toggleRegistered(f, want) && (AAF.ours?.(f)?.at || Infinity) < (AAF.run?.startedAt || 0)) {
          AAF.handled(f);
          continue;
        }
        dbg(`yes/no check: ${f.label.slice(0, 60)}: "${want}" ${toggleRegistered(f, want) ? "not set in the hidden checkbox this run" : "not registered"} (${toggleStateText(f)}); setting it again`);
        if (await setToggle(f, want)) again.push(f.label.slice(0, 60));
        else {
          bad.push(f.label.slice(0, 60));
          mark(f, "needs");
        }
      }
      dbg(`yes/no check at the end: ${shown.length} question${shown.length === 1 ? "" : "s"} with an answer, ${shown.length - bad.length} registered (aria-pressed and the hidden checkbox agree)${again.length ? `; set again: ${again.join("; ")}` : ""}${bad.length ? `; NOT registered, left for you: ${bad.join("; ")}` : ""}`);
    }
    async function afterFill() {
      if (!cfg.watchToggles) return;
      try {
        await checkAllToggles();
      } catch (e) {
        if (!(e instanceof AAF.Cancelled)) throw e;
        return;
      }
      if (!toggleFills.length) return;
      const until = Date.now() + 20000;
      const timer = setInterval(async () => {
        if (Date.now() > until || !AAF.alive()) return clearInterval(timer);
        if (AAF.filling || afterFill.busy) return;
        afterFill.busy = true;
        try {
          for (const r of [...toggleFills]) {
            const f = r.f.c.isConnected ? r.f : discover().find((x) => x.kind === "toggle" && x.nl === r.f.nl);
            if (!f || userToggled.has(f.c)) continue;
            if (toggleRegistered(f, r.text)) continue;
            dbg(`${f.label.slice(0, 60)}: "${r.text}" is no longer registered after the fill (${toggleStateText(f)}); clicking it again`);
            if (await setToggle(f, r.text)) dbg(`re-registered: ${f.label.slice(0, 80)} (reset after the fill)`);
            else {
              dbg(`reset after fill: ${f.label.slice(0, 80)}`);
              mark(f, "needs");
            }
          }
        } catch {
          // a new fill cancelled this (AAF.Cancelled from sleep): it re-checks for itself
        } finally {
          afterFill.busy = false;
        }
      }, 1000);
    }
    // Is this filled choice still registered in the portal's own state (the final sweep asks)? Toggles:
    // aria + mirror; radios: the picked option's input checked and not aria-checked="false"; checkbox
    // groups: some option checked, none checked with aria-checked="false"; single checkboxes: as wanted.
    // null = not a choice field.
    const ariaOf = (el) => el.getAttribute("aria-checked") ?? el.closest('[role="radio"], [role="checkbox"]')?.getAttribute("aria-checked") ?? null;
    function registered(f, picked, wanted) {
      if (f.type === "radio") {
        if (f.kind === "toggle") return toggleRegistered(f, picked || currentValue(f));
        const opts = choiceOptions(f.c, "radio");
        const o = picked ? opts.find((x) => norm(x.text) === norm(picked)) : opts.find((x) => x.el.checked);
        return !!o && o.el.checked && ariaOf(o.el) !== "false";
      }
      if (f.type === "checkgroup") {
        const on = [...f.c.querySelectorAll('input[type="checkbox"]')].filter((x) => x.checked);
        return on.length > 0 && on.every((x) => ariaOf(x) !== "false");
      }
      if (f.type === "checkbox") {
        const want = typeof wanted === "boolean" ? wanted : checkboxOn(wanted);
        return f.ctrl.checked === want && ariaOf(f.ctrl) !== String(!want);
      }
      return null;
    }
    // Radio-type fields: real radios or toggle buttons.
    const setRadio = (f, v) => (f.kind === "toggle" ? setToggle(f, v) : setChoice(f, "radio", v));

    // ------------------------------------------------------------------ dates
    // { month, day, year } (profile rules) or a date string. <input type=date> takes YYYY-MM-DD; a text
    // date picker is typed in its placeholder's format (MM/DD/YYYY by default, MM/YYYY when the
    // placeholder has no day). A month/year-only date in a full-date field uses the 1st, marked blue.
    // ---- Date-picker boxes (Nimbus's Graduation Date: a text box that opens a month grid) ----------------
    const CAL_MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
    const CAL_HEADER = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?,?\s+(\d{1,6})\b/i;
    const monthNo = (t) => CAL_MONTHS.findIndex((m) => m.startsWith(norm(t).slice(0, 3))) + 1;
    // A greyed day from the previous / next month, or one that can't be picked.
    const CAL_OUTSIDE = /outside|other-?month|adjacent|disabled|muted|not-?current|prev-?month|next-?month|(^|[\s_-])off([\s_-]|$)|gr[ae]y/i;

    // Empty a date box the way a user does: focus, select all (Ctrl+A), Backspace and Delete (left to the page when it
    // cancels them), then the native setter to "" with an input event. True when no digits are left.
    async function clearDateBox(el) {
      const setVal = (v) => Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, v);
      el.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
      el.focus();
      const selectAll = () => {
        try {
          el.select();
          el.setSelectionRange(0, (el.value || "").length);
        } catch {}
      };
      selectAll();
      el.dispatchEvent(new KeyboardEvent("keydown", { key: "a", code: "KeyA", ctrlKey: true, bubbles: true, cancelable: true }));
      el.dispatchEvent(new KeyboardEvent("keyup", { key: "a", code: "KeyA", ctrlKey: true, bubbles: true, cancelable: true }));
      for (const [k, code, type] of [["Backspace", 8, "deleteContentBackward"], ["Delete", 46, "deleteContentForward"]]) {
        selectAll();
        kbd(el, "keydown", k, code);
        if (el.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: type }))) {
          setVal("");
          el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: type }));
        }
        kbd(el, "keyup", k, code);
      }
      setVal("");
      el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
      await sleep(100);
      return !/\d/.test(el.value || "");
    }
    // Day-number cells (1-31), innermost only (a button inside a gridcell is the cell).
    function dayCells(root) {
      const all = [...root.querySelectorAll('[role="gridcell"], td, button, [role="button"], [class*="day" i]')].filter((x) => {
        const t = (x.innerText || x.textContent || "").trim();
        return /^\d{1,2}$/.test(t) && +t >= 1 && +t <= 31;
      });
      return all.filter((x) => !all.some((y) => y !== x && x.contains(y)));
    }
    const outsideDay = (cell) => {
      for (let x = cell, i = 0; x && i < 3; x = x.parentElement, i++) {
        if (CAL_OUTSIDE.test(typeof x.className === "string" ? x.className : "")) return true;
        if (x.getAttribute("aria-disabled") === "true" || x.hasAttribute("disabled") || x.getAttribute("aria-hidden") === "true" || x.hasAttribute("data-outside")) return true;
      }
      return false;
    };
    // The open calendar: the smallest visible element (not ours) with a "<Month> <year>" header and 28+ day cells.
    function findCalendar() {
      const sel = '[role="dialog"], [role="grid"], [role="application"], [class*="calendar" i], [class*="datepicker" i], [class*="date-picker" i], [class*="daypicker" i], [class*="rdp" i], [class*="picker" i]';
      let best = null;
      for (const c of document.querySelectorAll(sel)) {
        if (!visible(c) || AAF.isOwnUI?.(c) || c.closest("[id^='aaf-']")) continue;
        if (!CAL_HEADER.test(c.innerText || "") || dayCells(c).length < 28) continue;
        if (!best || best.contains(c)) best = c;
      }
      return best;
    }
    // { m, y, text } from the header: its month / year dropdowns when it has them, else its "<Month> <year>" text.
    function calHeader(cal) {
      const sels = [...cal.querySelectorAll("select")];
      const monthSel = sels.find((s) => [...s.options].filter((o) => MONTH_RX.test(o.text.trim())).length >= 12);
      const yearSel = sels.find((s) => [...s.options].filter((o) => /^\d{4}$/.test(o.text.trim())).length >= 3);
      if (monthSel && yearSel) {
        const m = monthNo(monthSel.options[monthSel.selectedIndex]?.text || "");
        const y = +(yearSel.options[yearSel.selectedIndex]?.text || 0);
        return { m, y, text: `${CAL_MONTHS[m - 1] || "?"} ${y}`, monthSel, yearSel };
      }
      const hit = (cal.innerText || "").match(CAL_HEADER);
      return hit ? { m: monthNo(hit[1]), y: +hit[2], text: `${hit[1]} ${hit[2]}` } : null;
    }
    // The month arrow: "next" / "previous" by aria-label, title or text (›, », >, ‹, «, <); a month arrow before a
    // year arrow.
    function calArrow(cal, dir) {
      const days = new Set(dayCells(cal));
      const rx = dir === "next" ? /\bnext\b|›|»|→|^>$|forward|following/i : /\bprev(ious)?\b|‹|«|←|^<$|\bback\b|earlier/i;
      const btns = [...cal.querySelectorAll('button, [role="button"], a')].filter((b) => !days.has(b) && visible(b) && rx.test(`${b.getAttribute("aria-label") || ""} ${b.getAttribute("title") || ""} ${(b.innerText || "").trim()}`));
      return btns.find((b) => !/year/i.test(`${b.getAttribute("aria-label") || ""} ${b.getAttribute("title") || ""}`)) || btns[0] || null;
    }
    // Pick { y, m, d } in the calendar the box opens. "none" = no calendar opened, "picked" = the day was clicked,
    // "failed" = a calendar opened but the date couldn't be reached (logged). The calendar is tagged while in use so
    // the navigation guard lets its arrows through (shared/dom.js).
    async function pickFromCalendar(f, t) {
      const el = f.ctrl;
      const label = f.label.slice(0, 60);
      el.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
      el.focus();
      click(el);
      let cal = null;
      const until = AAF.now() + 1500;
      while (!(cal = findCalendar()) && AAF.now() < until) await sleep(100);
      if (!cal) return "none";
      const want = `${CAL_MONTHS[t.m - 1].replace(/^./, (c) => c.toUpperCase())} ${t.y}`;
      const start = calHeader(cal)?.text || "(no header)";
      let clicks = 0;
      try {
        for (;;) {
          cal.setAttribute("data-aaf-calendar", "");
          const h = calHeader(cal);
          if (!h) {
            dbg(`${label}: the calendar has no month / year header I can read; left for you`);
            return "failed";
          }
          if (h.m === t.m && h.y === t.y) break;
          if (h.monthSel && h.yearSel) {
            const pick = (s, test) => {
              const o = [...s.options].find((x) => test(x.text.trim()));
              if (o) {
                s.value = o.value;
                s.dispatchEvent(new Event("input", { bubbles: true }));
                s.dispatchEvent(new Event("change", { bubbles: true }));
              }
              return !!o;
            };
            if (!pick(h.yearSel, (x) => +x === t.y) || !pick(h.monthSel, (x) => monthNo(x) === t.m)) {
              dbg(`${label}: the calendar's month / year dropdowns have no ${want}; left for you`);
              return "failed";
            }
            await sleep(200);
            cal = findCalendar() || cal;
            const again = calHeader(cal);
            if (!again || again.m !== t.m || again.y !== t.y) {
              dbg(`${label}: set the calendar's dropdowns to ${want} but it shows ${again?.text || "nothing"}; left for you`);
              return "failed";
            }
            break;
          }
          const diff = t.y * 12 + t.m - (h.y * 12 + h.m);
          if (Math.abs(diff) + clicks > 60) {
            dbg(`${label}: the calendar shows ${h.text}, ${Math.abs(diff)} months from ${want} (60 clicks at most); left for you`);
            return "failed";
          }
          const b = calArrow(cal, diff > 0 ? "next" : "previous");
          if (!b) {
            dbg(`${label}: the calendar shows ${h.text} and has no ${diff > 0 ? "next" : "previous"} month arrow; left for you`);
            return "failed";
          }
          click(b);
          clicks++;
          await sleep(120);
          cal = findCalendar() || cal;
        }
        cal.setAttribute("data-aaf-calendar", "");
        const name = CAL_MONTHS[t.m - 1];
        const cells = dayCells(cal).filter((x) => +(x.innerText || x.textContent).trim() === t.d && !outsideDay(x));
        // Several (a two-month view): the one whose aria-label names the month, else the first.
        const cell = cells.find((x) => new RegExp(`\\b${name}\\b`, "i").test(x.getAttribute("aria-label") || "")) || cells[0];
        if (!cell) {
          dbg(`${label}: the calendar shows ${want} but has no day ${t.d} to click; left for you`);
          return "failed";
        }
        click(cell);
        dbg(`${label}: calendar ${start} -> ${want} (${clicks} click${clicks === 1 ? "" : "s"}), clicked day ${t.d}`);
        await sleep(150);
        return "picked";
      } finally {
        cal?.removeAttribute("data-aaf-calendar");
        if (findCalendar()) key(el, "Escape");
        el.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      }
    }

    async function setDate(f, v) {
      const d = v && typeof v === "object" && !Array.isArray(v) ? v : parseDate(Array.isArray(v) ? v[0] : v);
      if (!d.year) {
        if (f.kind !== "text" || typeof v !== "string") return false;
        await typeInto(f.ctrl, v);
        f.picked = v;
        return true;
      }
      const mm = d.month ? String(d.month).padStart(2, "0") : "";
      let dd = d.day ? String(d.day).padStart(2, "0") : "";
      const ph = (f.ctrl.getAttribute("placeholder") || "").toLowerCase();
      const monthYearOnly = f.kind === "text" && /mm/.test(ph) && !/dd/.test(ph);
      if (!mm) return false;
      let guessedDay = false;
      if (!dd && !monthYearOnly) {
        dd = "01";
        guessedDay = true;
      }
      let s;
      if (f.kind === "native") s = `${d.year}-${mm}-${dd}`;
      else if (monthYearOnly) s = `${mm}/${d.year}`;
      else if (/^y/.test(ph)) s = `${d.year}-${mm}-${dd}`;
      else if (/^dd/.test(ph)) s = `${dd}/${mm}/${d.year}`;
      else s = `${mm}/${dd}/${d.year}`;
      // What the box must show afterwards: the same digits in the same order (separators may differ).
      const want = s.replace(/\D/g, "");
      const shows = () => f.ctrl.value.trim();
      // A plain box that just took "05212027" as typed isn't right either: it must show separators.
      const right = () => shows().replace(/\D/g, "") === want && (shows() === s || /\D/.test(shows()));
      let ok;
      if (f.kind === "native") {
        // <input type=date>: the native setter, read back; once more after clearing.
        nativeSet(f.ctrl, s);
        if (f.ctrl.value !== s) {
          dbg(`${f.label.slice(0, 60)}: set "${s}" but the date box holds "${f.ctrl.value}"; clearing and setting it once more`);
          nativeSet(f.ctrl, "");
          nativeSet(f.ctrl, s);
        }
        ok = f.ctrl.value === s;
      } else {
        // Text date boxes, in order (Nimbus's Graduation Date is a calendar picker: typing showed "01/01/20005",
        // then "01/01/52120", and its calendar header followed the garbled year):
        //   1. clear it properly (select all + Backspace / Delete, then the native setter to "");
        //   2. the formatted date through the native setter + input / change / blur, read back;
        //   3. the calendar, when clicking the box opens one: go to the month (its month / year dropdowns, or the
        //      next / previous arrows, 60 clicks at most), click the day (never a greyed day of a neighbouring month);
        //   4. typing: a masked box (one that showed a template, "__/__/____", "MM/DD/YYYY", digits, or carries mask
        //      attributes) digits only ("05212027") so the mask writes each one itself, others the formatted date,
        //      then the other way once.
        // `ok` only when the box reads back as the date; still wrong = FAIL and yellow.
        const el = f.ctrl;
        const masked = /[_#]|\b(mm|dd|yy|yyyy)\b|\d/i.test(el.value || "") || /mask/i.test(`${el.className || ""} ${[...el.attributes].map((x) => x.name).join(" ")}`) || el.getAttribute("inputmode") === "numeric" || /_/.test(el.getAttribute("placeholder") || "");
        const label = f.label.slice(0, 60);
        ok = false;
        let cal = "none";
        if (!(await clearDateBox(el))) dbg(`${label}: couldn't empty the box (it shows "${shows()}"); going on`);
        nativeSet(el, s);
        el.dispatchEvent(new FocusEvent("blur"));
        el.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
        await sleep(150);
        if ((ok = right())) dbg(`${label}: set "${s}" directly, it reads back "${shows()}"`);
        else {
          dbg(`${label}: set "${s}" directly but it shows "${shows()}"`);
          cal = await pickFromCalendar(f, { y: +d.year, m: +mm, d: +dd });
          if (cal === "picked") {
            await sleep(200);
            if ((ok = right())) dbg(`${label}: picked from the calendar, it reads back "${shows()}"`);
            else dbg(`${label}: picked from the calendar but it shows "${shows()}"`);
          }
        }
        // A box with a calendar is never typed into (typing garbled Nimbus's); one without gets the typing ways.
        if (!ok && cal !== "none") dbg(`${label}: a calendar box, not typed into; left for you`);
        const ways = ok || cal !== "none" ? [] : masked ? [want, s] : [s, want];
        for (const [i, t] of ways.entries()) {
          await typeInto(el, t, { blur: false, respectCancel: true });
          key(el, "Escape"); // close the date picker popup
          el.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
          await sleep(150);
          if ((ok = right())) {
            if (i) dbg(`${f.label.slice(0, 60)}: "${shows()}" after typing "${t}"`);
            break;
          }
          dbg(`${f.label.slice(0, 60)}: typed "${t}"${masked && !i ? " (a masked box, digits only)" : ""} but it shows "${shows()}"${i ? "; left for you" : "; clearing it and trying once more"}`);
        }
        if (ok) s = shows();
        // Wrong after both ways: the box holds a wrong value, so it's yellow even though it looks filled (the retry
        // pass skips filled fields).
        else mark(f, "needs");
      }
      if (ok) {
        f.picked = s;
        if (guessedDay) {
          dbg(`${f.label.slice(0, 60)}: the profile date has no day, used the 1st (marked blue)`);
          mark(f, "review");
        }
      }
      return ok;
    }

    // ---------------------------------------------- ordered steps / names
    // Same contract as the Workday chooser: try steps in order against the full option list (exact or
    // whole-word, non-negated phrase via matchAlts; `exact: true` = normalized equality only). If the
    // open menu lists nothing (an async list), type `search` (when given) or each step's alternatives,
    // and match the results; all typing together is capped at 8s. Returns { step (1-based, 0 = none), text }.
    // `near` (application location only): the accepted-names list; with no exact match, an option for
    // the same city counts ("New York, US" for "New York, NY"; AAF.inMetro), marked blue by the caller.
    // `searches` (field of study): search terms tried in turn on a searchable list; the options seen across
    // them are pooled, step 1 found stops the search early, otherwise the best step over the pool wins.
    async function chooseStep(f, steps, what, exclude = null, { search = "", exact = false, near = "", searches = null } = {}) {
      const allowed = (t) => !(exclude && exclude.test(norm(t)));
      const match = (texts, alts) => (exact ? texts.find((t) => alts.some((a) => norm(t) === norm(a))) || null : matchAlts(texts, alts));
      const firstHit = (opts) => {
        const texts = opts.filter((o) => allowed(o.text)).map((o) => o.text);
        for (const [i, alts] of steps.entries()) {
          const text = match(texts, alts);
          if (text) return { i, alts, text };
        }
        const close = near && texts.find((t) => AAF.inMetro(t, near));
        if (close) return { i: steps.length, alts: ["same city as an accepted name"], text: close, near: true };
        // A location list of countries / states / regions (GlobeQuant: countries; the rule typed "New York", options []):
        // your country / state / region instead, blue, logged `location: options are countries -> United States`.
        const lv = /location/.test(what) && AAF.placeLevel ? AAF.placeLevel(texts, AAF.state?.profile || {}) : null;
        for (const alts of lv?.steps || []) {
          const t = matchAlts(texts, alts);
          if (t) {
            dbg(`${what}: options are ${lv.level} -> ${t}`);
            return { i: steps.length, alts, text: t, near: true, level: lv.level };
          }
        }
        return null;
      };
      // Radio / checkbox groups: match the steps against the option texts, then click that option.
      if (f.type === "radio" || f.type === "checkgroup") {
        const kind = f.type === "radio" ? "radio" : "checkbox";
        const opts = (kind === "radio" && f.kind === "toggle" ? toggleOpts(f) : choiceOptions(f.c, kind)).map((o) => ({ el: o.el, text: o.text }));
        const chosen = opts.find((o) => o.el.checked && near && AAF.inMetro(o.text, near));
        if (chosen) {
          dbg(`${what}: "${chosen.text}" is already chosen`);
          f.picked = chosen.text;
          return { step: 1, text: chosen.text };
        }
        const hit = firstHit(opts);
        if (hit && (await (kind === "radio" ? setRadio(f, hit.text) : setChoice(f, "checkbox", hit.text)))) {
          dbg(`${what}: step ${hit.i + 1} (${hit.alts.join(" | ")}) matched "${hit.text}" (${matchWhy(hit.alts, hit.text)})`);
          f.picked = hit.text;
          if (/office/.test(what)) dbg(`${what}: options seen ${show(opts.map((o) => o.text))}`);
          return { step: hit.i + 1, text: hit.text, near: !!hit.near, level: hit.level || "" };
        }
        dbg(`${what}: no step matched; options were:`, show(opts.map((o) => o.text)));
        if (opts.length) AAF.run.noMatch?.add(`${f.type}|${f.nl}`);
        return { step: 0 };
      }
      if (f.type !== "dropdown") {
        // The raw setter: the caller's AAF.setField already logs this fill (it used to log twice).
        for (const [i, alts] of steps.entries()) for (const a of alts) if (await setFieldOnce(f, a)) return { step: i + 1, text: a };
        return { step: 0 };
      }
      // A multiselect that already holds a same-city choice ("additional offices": New York already in).
      if (near && f.kind === "react") {
        const have = reactValue(f).split(", ").find((x) => x && AAF.inMetro(x, near));
        if (have) {
          dbg(`${what}: "${have}" is already chosen`);
          f.picked = have;
          return { step: 1, text: have };
        }
      }
      if (f.kind === "native") {
        const opts = selectOptions(f.ctrl);
        const hit = firstHit(opts);
        if (hit && pickNative(f, opts.find((o) => o.text === hit.text))) {
          dbg(`${what}: step ${hit.i + 1} (${hit.alts.join(" | ")}) matched "${hit.text}" (${matchWhy(hit.alts, hit.text)})`);
          f.picked = hit.text;
          if (/office/.test(what)) dbg(`${what}: options seen ${show(opts.map((o) => o.text))}`);
          return { step: hit.i + 1, text: hit.text, near: !!hit.near, level: hit.level || "" };
        }
        dbg(`${what}: no step matched; options were:`, show(opts.map((o) => o.text)));
        if (opts.length) AAF.run.noMatch?.add(`${f.type}|${f.nl}`);
        return { step: 0 };
      }
      await openReact(f);
      let opts = await menuOptions(f, 1500);
      let everSaw = opts.length > 0;
      // The listed options first, even with a search term (a static list needs no typing). A partial
      // (server-searched) list only settles it with step 1 when `searches` are given.
      let hit = firstHit(opts);
      const pool = new Map(opts.map((o) => [o.text, ""]));
      if (hit && searches && partialList(f) && hit.i > 0) hit = null;
      // `searches` only for lists that need typing (server-searched, or empty until typed): a short static
      // list already shows every option.
      if (!hit && (search || !opts.length || partialList(f))) {
        const budget = AAF.now() + (searches ? 6000 * searches.length : 8000);
        const terms = searches || (search ? [search] : steps.flat());
        let lastTerm = "";
        for (const term of terms) {
          if (AAF.now() > budget) break;
          await typeSearch(f, term);
          lastTerm = term;
          opts = await menuOptions(f, Math.min(3000, Math.max(0, budget - AAF.now())));
          everSaw ||= opts.length > 0;
          for (const o of opts) if (!pool.has(o.text)) pool.set(o.text, term);
          if ((hit = firstHit(opts)) && (!searches || hit.i === 0)) break;
          if (searches) {
            dbg(`${what}: searched "${term}": ${opts.length ? show(opts.map((o) => o.text).slice(0, 12)) : "no results"}`);
            hit = null;
          }
        }
        if (searches && !hit) {
          hit = firstHit([...pool.keys()].map((text) => ({ text })));
          // Show the winning option again: it came from an earlier search.
          if (hit && pool.get(hit.text) !== lastTerm) {
            await typeSearch(f, pool.get(hit.text));
            opts = await menuOptions(f, 3000);
          }
        }
      }
      // A searched location list that found nothing for the city: maybe it lists countries. Your country's names, typed.
      if (!hit && /location/.test(what) && AAF.countryAlts && AAF.state?.profile?.country && f.ctrl.isConnected) {
        for (const term of AAF.countryAlts(AAF.state.profile).map(String).slice(0, 3)) {
          await typeSearch(f, term);
          opts = await menuOptions(f, 2500);
          everSaw ||= opts.length > 0;
          const t = opts.find((o) => norm(o.text) === norm(term)) || bestOption(opts, term, 85);
          if (t) {
            hit = { i: steps.length, alts: [term], text: t.text, near: true, level: "countries" };
            dbg(`${what}: nothing for "${search || steps[0]?.[0] || ""}"; searched "${term}" -> "${t.text}" (a country list)`);
            break;
          }
        }
      }
      if (!hit) {
        dbg(`${what}: no step matched${search ? ` (searched "${search}"${exact ? ", exact matches only" : ""})` : ""}; options were:`, show(opts.map((o) => o.text)));
        if (!everSaw) dbg(`${what}: the menu never showed options: ${menuDiag(f)}`);
        if (everSaw) AAF.run.noMatch?.add(`${f.type}|${f.nl}`);
        await clearSearch(f);
        await closeReact(f);
        if (await pickOther(f, what)) return { step: steps.length + 1, text: f.picked, other: true };
        return { step: 0 };
      }
      const el = menuOpts(f).find((o) => o.text === hit.text)?.el;
      if (el) click(el);
      const ok = !!(await waitFor(selectedOk(f, hit.text), 1500));
      await closeReact(f);
      if (!ok) {
        dbg(`${what}: clicked "${hit.text}" but it shows "${reactValue(f)}"`);
        return { step: 0 };
      }
      dbg(`${what}: step ${hit.i + 1} (${hit.alts.join(" | ")}) matched "${hit.text}" (${matchWhy(hit.alts, hit.text)})`);
      f.picked = hit.text;
      if (/office/.test(what)) dbg(`${what}: options seen ${show(opts.map((o) => o.text))}`);
      return { step: hit.i + 1, text: hit.text, near: !!hit.near, level: hit.level || "" };
    }

    // School (and any name field). Searchable react-selects are searched with `search` (the school
    // search keyword, e.g. "Lakeview": Greenhouse's school search found nothing for the full names)
    // or else each name. A result counts when it strongly matches a name (aliases include the board's
    // wording, e.g. "Lakeland State University-Lakeview"), or contains a name or the keyword as a
    // whole phrase. Never "Other".
    async function setByNames(f, names, what, search = "") {
      const phrases = search ? [...names, search] : names;
      // The FIRST result in the dropdown's own order that matches any name (strong match) or contains a
      // name / the keyword as a whole phrase. Not the alias order: "lakeview" lists "State University
      // of New York-Lakeview" before "Lsu Lakeview University", and the first one is picked.
      const choose = (opts) => opts.find((o) => names.some((n) => bestOption([o], n, 85)) || phrases.some((n) => hasPhrase(o.text, n)));
      if (f.type === "dropdown" && f.kind === "native") {
        const opts = selectOptions(f.ctrl);
        const pick = choose(opts);
        if (pick && pickNative(f, pick)) {
          dbg(`${what}: matched "${pick.text}"`);
          f.picked = pick.text;
          return true;
        }
        dbg(`${what}: none of ${JSON.stringify(phrases)} matched`);
        return pickOther(f, what);
      }
      if (f.type !== "dropdown") return setField(f, names[0]);
      let everSaw = false;
      // A Yes / No list is no school picker (GlobeQuant: "Have you been a student with GlobeQuant University ...?" had
      // its school aliases typed into a Yes / No dropdown for 40 s): read the options first, never type into it.
      {
        await openReact(f);
        const first = await menuOptions(f, 800);
        if (first.length && first.every((o) => /^(yes|no|n\/?a|prefer not\b.*|i prefer not\b.*)$/i.test(o.text.trim()))) {
          dbg(`${what}: the options are ${show(first.map((o) => o.text))}, not a school list; left to the yes / no rules: ${f.label.slice(0, 60)}`);
          await closeReact(f);
          AAF.run.noMatch?.add(`${f.type}|${f.nl}`);
          return false;
        }
        await closeReact(f);
      }
      // Every search together: 10 s at most, then yellow (FAIL), never 40 s on one field.
      const budget = AAF.now() + 10000;
      // The keyword first, then every name and alias (2Password's institution list matched none of the keyword's
      // results; every search and its results are logged).
      for (const term of [...new Set([search, ...names].filter(Boolean))]) {
        if (AAF.now() > budget) {
          dbg(`${what}: 10 s of searching without a match; stopped`);
          break;
        }
        await openReact(f);
        await typeSearch(f, term);
        let last = [];
        let pick = null;
        const end = Math.min(AAF.now() + 5000, budget);
        while (AAF.now() < end && f.ctrl.isConnected) {
          last = menuOpts(f);
          everSaw ||= last.length > 0;
          if ((pick = choose(last))) break;
          await sleep(150);
        }
        if (pick) {
          click(pick.el);
          const ok = !!(await waitFor(selectedOk(f, pick.text), 1500));
          await closeReact(f);
          dbg(`${what}: ${ok ? "matched" : "clicked but not selected:"} "${pick.text}" (searched "${term}")`);
          if (ok) f.picked = pick.text;
          return ok;
        }
        // Re-rendered during the search (Greenhouse after a resume parse): stop here, the caller retries on the live field.
        if (!f.ctrl.isConnected) return false;
        dbg(`${what}: no result for "${term}"; options:`, show(last.map((o) => o.text).slice(0, 10)));
        if (!everSaw) dbg(`${what}: the menu never showed options: ${menuDiag(f)}`);
        await clearSearch(f);
        await closeReact(f);
      }
      dbg(`${what}: none of ${JSON.stringify(phrases)} matched`);
      return pickOther(f, what);
    }
    // "Other" as the last resort (school, degree, field of study, how did you hear), only when the form has a box right
    // after the dropdown for what isn't listed ("If your institution was not listed, enter it here", "Please specify"):
    // the dropdown gets its Other / Not listed option (blue), and that box your value (`fillOtherFollowups`). Never
    // "None of the above" / "Prefer not to say". Logged `<what>: no match; selected "Other" ...`.
    const OTHER_OPT = /^(other|others|not listed|other \w+|other \(\w+( \w+)?\)|(my )?(school|institution|university|college|degree|major|field|source) (is )?not listed|(my )?(school|institution|degree|major) (isnt|is not) (listed|here)|not on (the|this) list)$/;
    const FOLLOW_SPEC = /\bplease specify\b|\bnot listed\b|\bif other\b|\benter it here\b|\bif you (selected|chose|picked|responded|answered) (with )?other\b|^(please )?specify\b|^other( \w+)?$/;
    // The box for an unlisted value: for a school, a "school / institution not listed ... enter it" box anywhere on the
    // form; for the others, a "please specify / not listed / if other" box right after the dropdown.
    function otherFollowup(f, what = "", all = discover()) {
      if (/school|institution/.test(what) || /\b(school|university|college|institution)\b/.test(f.nl)) {
        const box = all.find((y) => y !== f && ["text", "textarea"].includes(y.type) && AAF.SCHOOL_NOT_LISTED?.test(y.nl));
        if (box) return box;
      }
      const i = all.findIndex((x) => x.c === f.c);
      const n = i >= 0 ? all[i + 1] : null;
      return n && ["text", "textarea"].includes(n.type) && FOLLOW_SPEC.test(n.nl) ? n : null;
    }
    async function pickOther(f, what) {
      if (!/school|degree|field of study|major|how did you hear|institution/.test(what) || !otherFollowup(f, what)) return false;
      let opts = [];
      // Radios (not toggles): their own options, clicked through the shared chooser.
      if (f.type === "radio" && f.kind !== "toggle") {
        const o = choiceOptions(f.c, "radio").find((x) => OTHER_OPT.test(norm(x.text)));
        const ok = !!o && (await setChoice(f, "radio", o.text));
        dbg(`${what}: no match; ${ok ? `selected "${o.text}" (blue), so the box for it gets your value` : "no \"Other\" option; left for you"}`);
        if (ok) {
          f.picked = o.text;
          f.otherChosen = true;
          mark(f, "review");
        }
        return ok;
      }
      if (f.type !== "dropdown") return false;
      if (f.kind === "native") opts = selectOptions(f.ctrl);
      else {
        await openReact(f);
        opts = await menuOptions(f, 1200);
        if (!opts.some((o) => OTHER_OPT.test(norm(o.text)))) {
          await typeSearch(f, "Other");
          opts = (await waitFor(() => (menuOpts(f).some((o) => OTHER_OPT.test(norm(o.text))) ? menuOpts(f) : null), 3000)) || menuOpts(f);
        }
      }
      const o = opts.find((x) => OTHER_OPT.test(norm(x.text)));
      if (!o) {
        dbg(`${what}: no match and no "Other" option; left for you`);
        if (f.kind !== "native") await closeReact(f);
        return false;
      }
      let ok;
      if (f.kind === "native") ok = pickNative(f, o);
      else {
        click(o.el);
        ok = !!(await waitFor(selectedOk(f, o.text), 1500));
        await closeReact(f);
      }
      dbg(`${what}: no match; ${ok ? `selected "${o.text}" (blue), so the box for it ("${otherFollowup(f, what)?.label.slice(0, 50)}") gets your value` : `clicked "${o.text}" but it didn't register`}`);
      if (ok) {
        f.picked = o.text;
        f.otherChosen = true;
        mark(f, "review");
      }
      return ok;
    }
    // ------------------------------------------------- location autocomplete
    const suggestions = () =>
      [...document.querySelectorAll('.pac-item, [role="option"], ul[id*="autocomplete"] li, .ui-autocomplete li, [class*="suggestion"]' + (cfg.suggestSel ? ", " + cfg.suggestSel : ""))]
        .filter(visible)
        .map((el) => ({ el, text: (el.innerText || "").trim() }))
        .filter((o) => o.text);
    // Application location on a plain autocomplete input: type the search term, pick the first EXACT
    // match in step order; with no exact match, clear the field and leave it for the user.
    async function setAutocompleteSteps(f, v) {
      // Prefilled (Lever's resume parse) with an accepted name already: keep it.
      const cur = (f.ctrl.value || "").trim();
      if (cfg.keepPrefilled && cur && (v.steps.flat().some((a) => norm(a) === norm(cur)) || (v.near && AAF.inMetro(cur, v.near)))) {
        dbg(`${v.what || f.label}: kept the prefilled "${cur}" (matches an accepted name)`);
        f.picked = cur;
        return true;
      }
      await typeInto(f.ctrl, v.search, { blur: false });
      const got = (await waitFor(() => (suggestions().length ? suggestions() : null), 3000)) || [];
      // No suggestion list at all: a plain text input after all. Type the first accepted name.
      if (!got.length && cfg.plainLocationFallback) {
        const s = v.steps[0]?.[0] || v.search;
        await typeInto(f.ctrl, s);
        dbg(`${v.what || f.label}: no suggestions appeared, typed "${s}" as plain text`);
        f.picked = s;
        return true;
      }
      for (const alts of v.steps) {
        const pick = got.find((o) => alts.some((a) => norm(o.text) === norm(a)));
        if (pick) {
          click(pick.el);
          await sleep(300);
          dbg(`${v.what || f.label}: picked "${pick.text}"`);
          f.picked = pick.text;
          f.ctrl.dispatchEvent(new Event("change", { bubbles: true }));
          f.ctrl.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
          return true;
        }
      }
      // Same city as an accepted name ("New York, NY, USA"): picked, marked blue.
      const close = v.near && got.find((o) => AAF.inMetro(o.text, v.near));
      if (close) {
        click(close.el);
        await sleep(300);
        dbg(`${v.what || f.label}: no exact match; picked "${close.text}" (same city as an accepted name, marked blue)`);
        f.picked = close.text;
        f.ctrl.dispatchEvent(new Event("change", { bubbles: true }));
        f.ctrl.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
        mark(f, "review");
        return true;
      }
      dbg(`${v.what || f.label}: no exact match for ${show(v.steps.flat())}; suggestions:`, show(got.map((o) => o.text).slice(0, 8)));
      await typeInto(f.ctrl, "");
      return false;
    }
    // Plain autocomplete: type, then pick a suggestion that matches; if none appears, the typed text stays.
    async function setAutocomplete(f, s) {
      await typeInto(f.ctrl, s, { blur: false });
      const got = (await waitFor(() => (suggestions().length ? suggestions() : null), 3000)) || [];
      const pick = bestOption(got, s, 50) || bestOption(got, s.split(",")[0], 85);
      if (pick) {
        click(pick.el);
        await sleep(300);
        dbg(`${f.label}: picked suggestion "${pick.text}"`);
        f.picked = pick.text;
      } else dbg(`${f.label}: no matching suggestion, kept the typed text; suggestions:`, show(got.map((o) => o.text).slice(0, 8)));
      f.ctrl.dispatchEvent(new Event("change", { bubbles: true }));
      f.ctrl.blur();
      f.ctrl.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      return true;
    }

    // Does a prefilled value match the profile value? Same text, same phone digits (a leading US 1
    // ignored), same URL (protocol / www / trailing slash ignored), or the same company (sameCompany).
    const samePrefill = (a, b, f) => AAF.samePrefill(a, b, f); // shared/profile.js

    // The value a field shows now, as text ("" when empty): text, a select's chosen option, a
    // react-select's value, the checked radio / pressed toggle. Other types return "" (not compared).
    function currentValue(f) {
      switch (f.type) {
        case "text":
        case "textarea":
        case "date":
          return (f.ctrl.value || "").trim();
        case "dropdown":
          if (f.kind === "native") return isFilled(f) ? (f.ctrl.selectedOptions[0]?.text || "").trim() : "";
          return reactValue(f);
        case "radio":
          if (f.kind === "toggle") return toggleOpts(f).find((o) => pressed(o.el))?.text || "";
          return choiceOptions(f.c, "radio").find((o) => o.el.checked)?.text || "";
        case "checkgroup":
          // The ticked options (for logs, and so a rerun knows its own earlier answer).
          return choiceOptions(f.c, "checkbox").filter((o) => o.el.checked).map((o) => o.text).join(", ");
        default:
          return "";
      }
    }

    // Steps that need the page in front (menus, typed searches, suggestion lists): paused while the tab
    // is hidden or the window unfocused, resumed automatically (shared/core.js focusStep).
    setReact = AAF.focused("dropdown", setReact);
    const popupField = (f) => f.type === "dropdown" && f.kind !== "native";
    chooseStep = AAF.focused("dropdown", chooseStep, popupField);
    setByNames = AAF.focused("search", setByNames, popupField);
    setAutocomplete = AAF.focused("autocomplete", setAutocomplete);
    setAutocompleteSteps = AAF.focused("autocomplete", setAutocompleteSteps);

    // ------------------------------------------------------------ setField
    function isFilled(f) {
      switch (f.type) {
        case "text":
        case "textarea":
        case "date":
          return !!f.ctrl.value.trim();
        case "dropdown":
          if (f.kind === "native") return f.ctrl.selectedIndex > 0 || (!!f.ctrl.value && !!selectOptions(f.ctrl).find((o) => o.value === f.ctrl.value));
          return !!reactValue(f);
        case "radio":
          if (f.kind === "toggle") return toggleOpts(f).some((o) => pressed(o.el));
          return !!f.c.querySelector('input[type="radio"]:checked');
        case "checkgroup":
          return !!f.c.querySelector('input[type="checkbox"]:checked');
        case "checkbox":
          return f.ctrl.checked;
        case "file":
          return !!f.ctrl.files?.length;
        default:
          return false;
      }
    }

    // The adapter's setField: no logging here (shared AAF.setField logs every call).
    async function setFieldRaw(f, v) {
      if (v == null || v === "") return false;
      live(f);
      return retryIfDetached(f, () => setFieldOnce(f, v));
    }
    async function setFieldOnce(f, v) {
      if (f.type === "date") return setDate(f, v);
      // Several options at once (languages checkbox group): every matching option is checked.
      if (v && typeof v === "object" && Array.isArray(v.checkAll)) return f.type === "checkgroup" ? AAF.checkAllMatching(f, v.checkAll, v.what, v.match) : false;
      // School names { school, search } (a profile rule: "Which university are you currently attending?").
      if (v && typeof v === "object" && Array.isArray(v.school)) return f.type === "dropdown" ? setByNames(f, v.school, "school", v.search) : setFieldOnce(f, v.school[0]);
      // Degree steps (education blocks): the degree chooser; the step is kept for the substitute outline.
      if (v && typeof v === "object" && Array.isArray(v.degreeSteps)) {
        f.degreeStep = (await chooseStep(f, v.degreeSteps, "degree")).step;
        return f.degreeStep > 0;
      }
      // Field of study already holding a value (a resume parse): keep it when it matches step N and no
      // earlier step is in the list; replace it only with an earlier step. A value matching none of the steps
      // is replaced only by step 1; never by a later fallback (Zephyr: "Engineering" became fallback 4,
      // "Computer Science"): then it's kept and left yellow.
      if (v?.fos && Array.isArray(v.steps) && !["text", "textarea"].includes(f.type) && isFilled(f)) {
        const cur = currentValue(f);
        const k = cur ? v.steps.findIndex((alts) => !!matchAlts([cur], alts)) : -1;
        if (cur && k === 0) {
          dbg(`${v.what}: kept prefilled "${cur}" (step 1)`);
          f.picked = cur;
          f.keptOnly = true;
          return true;
        }
        if (cur) {
          const earlier = k > 0 ? v.steps.slice(0, k) : v.steps.slice(0, 1);
          const r = await chooseStep(f, earlier, v.what, v.exclude, { searches: v.searches });
          if (r.step > 0) {
            dbg(`${v.what}: replaced prefilled "${cur}" (${k > 0 ? `step ${k + 1}` : "none of your steps"}) with step ${r.step} "${r.text}"`);
            mark(f, "review"); // a replaced prefill is double-checked, like every other one
            return true;
          }
          if (k > 0) {
            dbg(`${v.what}: kept prefilled "${cur}" (step ${k + 1}; no earlier step in the list)`);
            f.picked = cur;
            f.keptOnly = true;
            if (k >= 1) mark(f, "review");
            return true;
          }
          dbg(`${v.what}: kept prefilled "${cur}" (none of your steps, and "${v.steps[0][0]}" isn't in the list; a later fallback never replaces it), left for you (yellow)`);
          f.held = true;
          mark(f, "needs");
          return false;
        }
      }
      // Ordered steps { steps, what, exclude }: same chooser contract as Workday.
      if (v && typeof v === "object" && Array.isArray(v.steps)) {
        // Location autocomplete with the application location: exact suggestions only.
        if (f.kind === "autocomplete" && v.search) return setAutocompleteSteps(f, v);
        const r = await chooseStep(f, v.steps, v.what || f.label, v.exclude, { search: v.search, exact: v.exact, near: v.near, searches: v.searches });
        if (r.near) {
          dbg(`${v.what || f.label}: "${r.text}" ${r.level ? `is your ${r.level.replace(/ies$/, "y").replace(/s$/, "")} (the options are ${r.level})` : "is the same city as an accepted name"}, marked blue`);
          mark(f, "review");
        }
        // Field of study: a fallback (not your own field) is double-checked.
        if (v.fos && r.step > 1) {
          dbg(`${v.what}: matched fallback ${r.step} ("${r.text}"), marked blue`);
          mark(f, "review");
        }
        return r.step > 0;
      }
      // Ranked choice { choose(optionTexts) -> text | null, text, what } (willing to travel = highest option).
      if (v && typeof v === "object" && typeof v.choose === "function") {
        if (f.type === "text" || f.type === "textarea") return v.text ? setFieldRaw(f, v.text) : false;
        if (f.type === "checkbox") return setCheckbox(f, true);
        const texts = (await readOptions(f)) || [];
        const pick = v.choose(texts);
        dbg(`${v.what || f.label}: options ${show(texts)} -> ${pick ? `"${pick}"` : "none acceptable"}`);
        // The same chooser over the same options would decide the same way: the retry pass skips it.
        if (!pick && texts.length) AAF.run.noMatch?.add(`${f.type}|${f.nl}`);
        if (!pick) return false;
        if (f.type === "dropdown") return (await chooseStep(f, [[pick]], `${v.what || f.label}: selecting`, null, { exact: true })).step > 0;
        if (f.type === "radio") return setRadio(f, pick);
        if (f.type === "checkgroup") return setChoice(f, "checkbox", pick);
        return false;
      }
      switch (f.type) {
        case "text":
        case "textarea": {
          const s = String(Array.isArray(v) ? v[0] : v).split("|")[0];
          f.picked = s;
          if (f.ctrl.value === s) return true;
          // A value the portal prefilled from the resume that already matches the profile stays.
          const cur = (f.ctrl.value || "").trim();
          if (cfg.keepPrefilled && cur) {
            if (samePrefill(cur, s, f)) {
              dbg(`${f.label.slice(0, 60)}: kept the prefilled "${cur.slice(0, 80)}" (matches your profile)`);
              f.picked = cur;
              f.keptOnly = true;
              return true;
            }
            dbg(`${f.label.slice(0, 60)}: replacing the prefilled "${cur.slice(0, 80)}" with your profile value`);
          }
          if (f.kind === "autocomplete") return setAutocomplete(f, s);
          if (isPhoneField(f, s)) return setPhone(f, s);
          await typeInto(f.ctrl, s);
          return true;
        }
        case "dropdown":
          // Arrays are ordered fallbacks: the first alternative that matches wins (never several values).
          return f.kind === "native" ? setNative(f, v) : setReact(f, v);
        case "radio":
          return (await setRadio(f, v)) || (v?.what ? pickOther(f, v.what) : false);
        case "checkgroup":
          return setChoice(f, "checkbox", v);
        case "checkbox":
          return setCheckbox(f, checkboxOn(v));
      }
      return false;
    }

    // ---- Phone boxes (Ashby "Contact Number": a masked input; the number set in one go read back as "0100", twice).
    // Cleared, then typed one key at a time with the page's own handling of keys it cancels (an input mask writes the
    // digit itself), in the format the field hints at (its placeholder / label: "(555) 555-5555", "+1 ..."), else as
    // saved; read back digits-only (a leading country code 1 allowed). Wrong: cleared and typed as digits only
    // ("6465550100"). Still wrong: false (FAIL, yellow).
    const PHONE_LABEL = /\b(phone|mobile|cell|cellphone|telephone|tel)\b|\bcontact (number|no|num)\b/;
    function isPhoneField(f, s) {
      const d = String(s).replace(/\D/g, "");
      return d.length >= 10 && d.length <= 11 && /^[\d\s()+.\-]+$/.test(String(s).trim()) && (f.ctrl.type === "tel" || PHONE_LABEL.test(f.nl || ""));
    }
    // The number laid into a hint whose digit slots (digits, x, #, _) hold 10 digits, or 11 starting with 1 / +1.
    function phoneInHint(hint, d10) {
      for (const h of String(hint || "").match(/[+(]?[\dxX#_][\dxX#_()\s.\-]{8,}[\dxX#_]/g) || []) {
        const slots = (h.match(/[\dxX#_]/g) || []).length;
        const digits = slots === 10 ? d10 : slots === 11 && /^\+?\(?1/.test(h) ? "1" + d10 : null;
        if (!digits) continue;
        let i = 0;
        return h.replace(/[\dxX#_]/g, () => digits[i++]);
      }
      return null;
    }
    async function setPhone(f, s) {
      const d10 = String(s).replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
      const hint = `${f.ctrl.placeholder || ""} ${f.label || ""}`;
      const formatted = phoneInHint(hint, d10) || String(s);
      const tries = [formatted, d10].filter((t, i, a) => a.indexOf(t) === i);
      const reads = [];
      for (const [i, t] of tries.entries()) {
        await typeInto(f.ctrl, t, { respectCancel: true });
        await sleep(150);
        const shown = f.ctrl.value || "";
        const got = shown.replace(/\D/g, "");
        if (got === d10 || got === "1" + d10) {
          f.picked = shown;
          if (i) dbg(`phone: digits only "${t}" -> "${shown}"`);
          else if (t !== String(s)) dbg(`phone: typed in the field's format "${t}" (from its hint) -> "${shown}"`);
          return true;
        }
        reads.push(shown);
        if (i + 1 < tries.length) dbg(`phone: typed "${t}" but it shows "${shown}"; clearing it and typing digits only`);
      }
      dbg(`phone: still wrong after ${tries.length} tries (${tries.map((t, i) => `"${t}" -> "${reads[i]}"`).join(", ")}); left for you`);
      AAF.run.noMatch?.add(`${f.type}|${f.nl}`); // the retry pass would type the same two ways again
      return false;
    }

    async function readOptions(f) {
      if (f.type === "dropdown" && f.kind === "native") return selectOptions(f.ctrl).map((o) => o.text);
      if (f.type === "dropdown")
        return AAF.focusStep("dropdown", async () => {
          await openReact(f);
          const o = (await menuOptions(f, 1500)).map((x) => x.text);
          await closeReact(f);
          return o;
        });
      if (f.type === "radio" && f.kind === "toggle") return toggleOpts(f).map((o) => o.text);
      if (f.type === "radio") return choiceOptions(f.c, "radio").map((o) => o.text);
      if (f.type === "checkgroup") return choiceOptions(f.c, "checkbox").map((o) => o.text);
      return null;
    }

    // ---------------------------------------- repeatable blocks (cfg.repeatables; iCIMS, UNVERIFIED)
    // Experience / education entries as repeated blocks of fields on one page. Each Company / Employer
    // (or School) field starts a block: the largest ancestor (up to 8 levels, inside the form root) that
    // holds no other block's name field, no name field of the other kind, and no contact field. Blocks
    // are matched to profile entries BY NAME (company AND title, then company alone; school name or an
    // alias as a phrase), never by position. A matched block keeps agreeing values, replaces differing
    // ones (blue, logged), fills empty ones. Blocks matching no entry are untouched and outlined yellow.
    // Entries with no block go into empty blocks, else are logged: Add buttons are never clicked here.
    const KINDS = {
      experience: {
        name: /^(current |previous |most recent )?(company|employer)( name)?$/,
        sub: /(^| )(job |position )?title$|(^| )position$/,
        // State / country too (Steadfast: the block's State got your home state from the main pass).
        vocab: /company|employer|title|position|location|city|\bstate\b|province|country|start|end|from|to\b|month|year|date|description|responsibilit|duties|current|present/,
      },
      education: {
        // iCIMS: "College / University - School Name".
        name: /^(school|university|college|institution)( name)?$|(^| )school name$/,
        sub: /(^| )degree( type| level)?$|(^| )(major|field of study|discipline)$/,
        vocab: /school|university|college|institution|degree|major|field of study|discipline|gpa|start|end|from|to\b|month|year|date|graduat/,
      },
    };
    const CONTACT = /^(legal |preferred )?(first|last|middle|full)( name)?$|^name$|e ?mail|phone|^address|street|zip|postal/;
    // A label read without its hint in parentheses (Steadfast: 'School (If school not found, select "Other College/High
    // School")' was no block name, so the whole education block went to the main pass and stayed yellow).
    const bare = (f) => f.bnl ?? (f.bnl = norm(String(f.label || "").replace(/\([^)]*\)/g, " ").replace(/[*✱]/g, " ")));
    function blocksOf(kind, fields) {
      const K = KINDS[kind];
      const O = KINDS[kind === "experience" ? "education" : "experience"];
      const root = formRoot();
      return fields.filter((f) => K.name.test(bare(f))).map((nf) => {
        let panel = nf.c;
        for (let el = nf.c.parentElement, i = 0; el && el !== root && el !== document.body && i < 8; i++, el = el.parentElement) {
          if (fields.some((x) => x !== nf && el.contains(x.c) && (K.name.test(bare(x)) || O.name.test(bare(x)) || CONTACT.test(bare(x))))) break;
          panel = el;
        }
        return { panel, name: nf, fields: fields.filter((x) => panel.contains(x.c)) };
      })
        // A block has its second field too (title; degree or major): iCIMS HMSY's clearance group ("Type/Level",
        // "Employer:") was taken for an experience block and got a company name.
        .filter((b) => b.fields.some((x) => x !== b.name && K.sub.test(bare(x))));
    }
    let blockCache = { t: 0, set: new Set() };
    // Fields inside a block whose label belongs to that block's vocabulary (others stay in the main pass).
    function inBlock(f) {
      if (!cfg.repeatables) return false;
      if (Date.now() - blockCache.t > 300) {
        const fields = discover().filter((x) => x.type);
        const set = new Set();
        for (const kind of Object.keys(KINDS))
          for (const b of blocksOf(kind, fields)) for (const x of b.fields) if (KINDS[kind].vocab.test(x.nl)) set.add(x.c);
        blockCache = { t: Date.now(), set };
      }
      return blockCache.set.has(f.c);
    }
    const schoolNamesOf = (x) => [x.school, ...(/\|/.test(x.schoolAliases || "") ? splitAlts(x.schoolAliases) : String(x.schoolAliases || "").split(",").map((t) => t.trim()))].filter(Boolean);
    const sameTitle = (a, x) => !!a && !!x.title && (norm(a) === norm(x.title) || hasPhrase(a, x.title) || hasPhrase(x.title, a));
    // Which part of a split date a control is: the label's last word ("Start Date (Month / Day / Year) - Day", iCIMS: the
    // hint names all three parts, so /month/ matched the Day and Year boxes too and they got "10" / "October"), else the
    // control's own placeholder / options (`datePart`), else none (a whole-date box).
    function partOf(f) {
      const last = (f.nl.match(/\b(month|day|date|year|yyyy|mm|dd)$/) || [])[1];
      if (last && last !== "date") return { mm: "month", dd: "day", yyyy: "year" }[last] || last;
      const dp = datePart(f);
      return dp && dp !== "none" ? dp : "";
    }
    // A job's location as city / state ("Riverton, NJ" -> "Riverton" / New Jersey | NJ).
    function locParts(loc) {
      const m = String(loc || "").match(/^\s*([^,]+?)\s*,\s*([A-Za-z .]+?)\s*(?:,\s*(?:USA?|United States(?: of America)?))?\s*$/);
      if (!m) return { city: String(loc || "").trim(), state: "" };
      const abbrs = AAF.STATE_ABBR || {};
      const s = m[2].trim();
      const full = Object.keys(abbrs).find((k) => abbrs[k].toLowerCase() === s.toLowerCase().replace(/\./g, "")) || (abbrs[norm(s)] ? norm(s) : "");
      const title = (w) => w.replace(/\b\w/g, (c) => c.toUpperCase());
      return { city: m[1], state: full ? title(full) : s, abbr: full ? abbrs[full] : "" };
    }
    function expValue(f, x, block) {
      const L = f.nl;
      if (KINDS.experience.name.test(L)) return x.company;
      if (KINDS.experience.sub.test(L)) return x.title;
      // The JOB's location, never your home address. With a separate State field the city goes alone ("Riverton",
      // not "Riverton, NJ"); State gets the state's name, then its abbreviation.
      const hasState = (block?.fields || []).some((y) => /^(job )?(state|state province|province)$/.test(y.nl));
      if (/^(job )?(state|state province|province)$/.test(L)) {
        const lp = locParts(x.location);
        return lp.state ? [lp.state, ...(lp.abbr ? [lp.abbr] : [])] : undefined;
      }
      if (/^(job )?(location|city)/.test(L)) return /^(job )?city$/.test(L) && hasState ? locParts(x.location).city || undefined : x.location;
      if (f.type === "checkbox" && /current|present/.test(L)) return !!x.current;
      // "Currently Employed Here?" as a Yes / No.
      if (["dropdown", "radio"].includes(f.type) && /\b(current(ly)?|present(ly)?|still)\b/.test(L) && !/\b(start|end|from|to|date)\b/.test(L)) return [x.current ? "Yes" : "No"];
      if (/description|responsibilit|duties/.test(L)) return x.description;
      const isStart = /start|from/.test(L);
      const isEnd = /end|to\b/.test(L);
      if (!isStart && !isEnd) return undefined;
      if (isEnd && !isStart && x.current) return undefined;
      const m = isStart ? x.startMonth : x.endMonth;
      const y = isStart ? x.startYear : x.endYear;
      const part = partOf(f);
      if (part === "month") return m ? monthAlts(m) : undefined;
      if (part === "year") return y || undefined;
      // Your dates are month + year: a day already shown stays; an empty one gets the 1st.
      if (part === "day") return y && !isFilled(f) ? ["1", "01"] : undefined;
      if (f.type === "date") return y ? { month: m, year: y } : undefined;
      return y ? (m ? `${String(m).padStart(2, "0")}/${y}` : String(y)) : undefined;
    }
    // The Add button for a kind of block: an <a> / <button> reading "Add", "Add More (...)", "Add Another ...",
    // in or just around the last block, inside the form root. Never anything else (the navigation guard
    // in shared/dom.js still checks every click).
    const ADD = /^\+?\s*add( more| another| new)?\b/i;
    // Only an Add for this kind of block (Steadfast: "Add More (Additional Attachment(s))" was clicked for an experience):
    // a label naming the kind, or a bare "Add" / "Add More" in the block's own collection (the smallest element holding
    // both holds no other Add). A label naming anything else (attachments, documents, references, languages, the other
    // kind ...) is never clicked, logged.
    const KIND_WORDS = { experience: /\b(work|employment|experience|employer|job|position|career|professional)\b/, education: /\b(education|school|college|universit\w*|degree|academic)\b/ };
    const NOT_A_BLOCK = /\b(attach\w*|documents?|files?|resumes?|cover|references?|languages?|certif\w*|licen[cs]\w*|skills?|phones?|address(es)?|e ?mails?|websites?|links?|awards?|publications?|volunteer\w*)\b/;
    function addButtonFor(panel, kind) {
      const root = formRoot();
      const other = kind === "experience" ? KIND_WORDS.education : KIND_WORDS.experience;
      for (let el = panel, i = 0; el && i < 4; i++, el = el.parentElement) {
        for (const btn of [...el.querySelectorAll("a, button, [role=button]")].filter((x) => visible(x) && root.contains(x) && ADD.test((x.innerText || "").trim()))) {
          const label = (btn.innerText || "").trim();
          const what = norm(label.replace(ADD, ""));
          if (what && (NOT_A_BLOCK.test(what) || other.test(what)) && !KIND_WORDS[kind].test(what)) {
            if (!AAF.namedLogged?.has(`addno|${kind}|${label}`)) {
              AAF.namedLogged?.add(`addno|${kind}|${label}`);
              dbg(`${kind}: not clicking "${label.slice(0, 60)}" (it adds something else, not ${kind})`);
            }
            continue;
          }
          if (what && KIND_WORDS[kind].test(what)) return btn;
          // A bare "Add" / "Add More": only when it belongs to this block's collection.
          let common = btn.parentElement;
          while (common && !common.contains(panel)) common = common.parentElement;
          const adds = common ? [...common.querySelectorAll("a, button, [role=button]")].filter((x) => visible(x) && ADD.test((x.innerText || "").trim())) : [];
          if (adds.length === 1) return btn;
        }
        if (el === root) break;
      }
      return null;
    }
    async function addBlock(kind, info) {
      const last = info[info.length - 1];
      const btn = last && addButtonFor(last.b.panel, kind);
      if (!btn) return null;
      info.addTried = true;
      const known = new Set(info.map((o) => o.b.name.ctrl));
      const label = (btn.innerText || "").trim().slice(0, 60);
      if (!click(btn)) return null;
      const fresh = await waitFor(() => blocksOf(kind, discover().filter((f) => f.type)).find((b) => !known.has(b.name.ctrl)), 3000);
      dbg(`${kind}: clicked "${label}"${fresh ? ", a new block appeared" : ", but no new block appeared"}`);
      if (!fresh) return null;
      const o = { b: fresh, name: "", sub: "", empty: fresh.fields.every((x) => !isFilled(x)) };
      info.push(o);
      return o.empty ? o : null;
    }
    async function fillBlocks(p, stats) {
      const fields = discover().filter((f) => f.type);
      for (const [kind, entries] of [["experience", p.experiences || []], ["education", p.education || []]]) {
        const blocks = blocksOf(kind, fields);
        if (!blocks.length || !entries.length) continue;
        dbg(`${kind}: ${blocks.length} block(s) on this page`);
        const sameName = kind === "experience"
          ? (v, x) => !!x.company && AAF.sameCompany(v, x.company)
          : (v, x) => schoolNamesOf(x).some((n) => norm(n) === norm(v) || hasPhrase(v, n) || hasPhrase(n, v));
        const subOf = (b) => b.fields.find((x) => KINDS[kind].sub.test(bare(x)));
        const info = blocks.map((b) => ({ b, name: currentValue(b.name), sub: subOf(b) ? currentValue(subOf(b)) : "", empty: b.fields.every((x) => !isFilled(x)) }));
        const used = new Set();
        const pairs = [];
        // Scored matching, as on Workday (every portal; Steadfast: a resume-parsed block with your Contoso title and start date
        // but no employer "matched none" and Contoso was added again): each block against each entry, signals strong (2) or
        // weak (1): company (the same name / one containing the other), title (the same / a phrase of it), start date (month
        // and year / year only). A pair = title and company both at least weak, or two strong signals; never a block naming
        // a different employer. The best pairs go first. Education: the school name, or a nameless block whose degree /
        // major doesn't contradict the entry.
        const startOf = (b) => {
          const fs = b.fields.filter((y) => /start|from/.test(y.nl) && isFilled(y));
          const pick = (part) => fs.find((y) => partOf(y) === part);
          const mo = pick("month") ? monthNum(currentValue(pick("month"))) : "";
          const yr = pick("year") ? (currentValue(pick("year")).match(/\d{4}/) || [""])[0] : (fs.map((y) => currentValue(y)).join(" ").match(/\b(19|20)\d{2}\b/) || [""])[0];
          return { mo: mo ? String(+mo) : "", yr };
        };
        if (kind === "experience") {
          const scored = [];
          for (const o of info) {
            if (o.empty) continue;
            const st = startOf(o.b);
            for (const [i, x] of entries.entries()) {
              const company = !o.name ? 0 : AAF.exactCompany?.(o.name, x.company || "") ? 2 : x.company && sameName(o.name, x) ? 1 : -1;
              if (company < 0) continue; // a block naming another employer is not this entry
              const title = !o.sub || !x.title ? 0 : norm(o.sub) === norm(x.title) ? 2 : sameTitle(o.sub, x) ? 1 : 0;
              const date = !st.yr || !x.startYear ? 0 : String(st.yr) === String(x.startYear) ? (st.mo && String(+x.startMonth) === st.mo ? 2 : st.mo ? 0 : 1) : 0;
              const strong = [company, title, date].filter((s) => s === 2).length;
              // Also the employer alone when the block shows no title of its own (a different title is a different job).
              if ((company >= 1 && title >= 1) || strong >= 2 || (company === 2 && !o.sub)) scored.push({ o, i, total: company + title + date, why: `company ${["none", "weak", "strong"][company]}, title ${["none", "weak", "strong"][title]}, dates ${["none", "weak", "strong"][date]}` });
            }
          }
          for (const s of scored.sort((a, b) => b.total - a.total)) {
            if (used.has(s.o) || pairs.some((q) => q.i === s.i)) continue;
            used.add(s.o);
            pairs.push({ i: s.i, o: s.o });
            dbg(`experience: "${s.o.name || "(no employer)"}${s.o.sub ? " / " + s.o.sub : ""}" block matches your entry ${s.i + 1} (${s.why})`);
          }
        } else {
          for (const [i, x] of entries.entries()) {
            const o = info.find((o) => !used.has(o) && !o.empty && o.name && sameName(o.name, x));
            if (o) {
              used.add(o);
              pairs.push({ i, o });
              dbg(`education: block "${o.name}" matches your entry ${i + 1}`);
            }
          }
          for (const [i, x] of entries.entries()) {
            if (pairs.some((q) => q.i === i)) continue;
            const o = info.find((o) => !used.has(o) && !o.empty && !o.name && (!o.sub || hasPhrase(o.sub, x.field || "") || hasPhrase(x.field || "", o.sub) || /degree/.test(subOf(o.b)?.nl || "")));
            if (o) {
              used.add(o);
              pairs.push({ i, o });
              dbg(`education: a block with no school (${o.sub ? `"${o.sub}"` : "other fields prefilled"}) takes your entry ${i + 1} (${x.school || "?"})`);
            }
          }
        }
        for (const [i, x] of entries.entries()) {
          if (pairs.some((q) => q.i === i)) continue;
          let o = info.find((o) => !used.has(o) && o.empty);
          // No empty block: the form's own "Add" / "Add More" button (cfg.addButtons, iCIMS), then the new block.
          if (!o && cfg.addButtons) o = await addBlock(kind, info);
          if (o) {
            used.add(o);
            pairs.push({ i, o });
          } else dbg(`${kind}: no empty block for your entry ${i + 1} (${x.company || x.school || "?"}); add one yourself${!cfg.addButtons ? " (Add isn't clicked here)" : info.addTried ? " (the Add button gave no new block)" : " (no Add button found)"}`);
        }
        for (const o of info) {
          if (used.has(o) || o.empty) continue;
          dbg(`${kind}: the "${o.name || "(no name)"}" block matches none of your entries; left as is for you to review or delete`);
          mark({ c: o.b.panel }, "needs");
          stats.needs++;
        }
        for (const { i, o } of pairs.sort((a, b) => a.i - b.i)) {
          for (const f of o.b.fields) {
            f.blockFields = o.b.fields;
            const v = kind === "experience" ? expValue(f, entries[i], o.b) : eduValue(f, entries[i], p);
            if (v === AAF.SKIP) {
              AAF.handled(f);
              continue;
            }
            if (v === undefined || v === "" || v == null) {
              // A value your profile has nothing for stays (a split date's Day: your dates are month + year): kept, so
              // the final check doesn't list it as unhandled.
              if (isFilled(f)) {
                dbg(`${kind} ${i + 1}: ${f.label}: kept "${currentValue(f)}" (${partOf(f) === "day" ? "your dates are month + year" : "nothing in your profile for it"})`);
                AAF.handled(f);
              }
              continue;
            }
            const before = isFilled(f) ? currentValue(f) : "";
            if (before && AAF.matchesValue(before, v, f) === true) {
              dbg(`${kind} ${i + 1}: ${f.label}: kept "${before}" (matches your profile)`);
              AAF.countKept(f);
              continue;
            }
            let ok;
            if (v?.school) ok = await setByNames(f, v.school, "school", v.search);
            else ok = await setField(f, v); // degree steps too, so the fill gets its "ok" line
            if (ok && v?.degreeSteps && f.degreeStep >= 3) {
              dbg("degree: substitute, marked blue");
              mark(f, "review");
              stats.review++;
            }
            if (ok && !f.keptOnly) AAF.countFill(f);
            else if (!ok && !isFilled(f)) {
              mark(f, "needs");
              stats.needs++;
            }
            const after = isFilled(f) ? currentValue(f) : "";
            if (ok && before && after && norm(after) !== norm(before)) {
              dbg(`${kind} ${i + 1}: ${f.label}: replaced "${before}" with "${after}"`);
              mark(f, "review");
              stats.review++;
            }
          }
        }
      }
    }

    // Education, block and file fields are filled by fillSections / fillLate, never by the main pass.
    const isSectionField = (f) => f.type === "file" || isEduField(f) || !!f.workBlock || inBlock(f);

    // ---------------------------------------------------------------- resume
    async function uploadResume() {
      const { resumeFile } = await chrome.storage.local.get("resumeFile");
      if (!resumeFile?.dataUrl) return false;
      const inputs = [...document.querySelectorAll('input[type="file"]')].filter((i) => !cfg.skipFile?.(i));
      if (!inputs.length) return false;
      // By id/name first (#resume vs #cover_letter), then by the nearest text that says Resume/CV.
      const purpose = (inp) => {
        // data-testid too (Rippling: "input-resume", "input-cover_letter"), and "Résumé" read without accents.
        const idn = `${inp.id} ${inp.name} ${inp.getAttribute("data-testid") || ""}`;
        if (/cover/i.test(idn)) return "other";
        if (/resume|(^|[_\W])cv([_\W]|$)/i.test(idn)) return "resume";
        let el = inp.parentElement;
        for (let i = 0; el && el !== document.body && i < 6; i++, el = el.parentElement) {
          const t = (el.innerText || "").normalize("NFD").replace(/[̀-ͯ]/g, "");
          const r = /resume|\bcv\b/i.test(t);
          const o = /cover letter|transcript/i.test(t);
          if (r && !o) return "resume";
          if (o && !r) return "other";
          if (r && o) return null;
        }
        return null;
      };
      const input = inputs.find((i) => purpose(i) === "resume");
      if (!input) {
        dbg(`resume: no resume file input (${inputs.length} file inputs: ${show(inputs.map((i) => i.id || i.name))})`);
        return false;
      }
      const box = input.closest(cfg.fileBoxSel) || input.parentElement;
      const uploaded = () => (cfg.uploadedCheck ? cfg.uploadedCheck(input, resumeFile.name) : (box.innerText || "").includes(resumeFile.name));
      // A file already listed: the same name is kept, a different one deleted first (then yours is uploaded).
      const prior = await AAF.clearOldUpload(box, resumeFile.name, dbg);
      if (prior.state === "kept") {
        AAF.countKept("resume");
        return false;
      }
      if (prior.state === "stuck") return false;
      const had = prior.state === "deleted" ? false : uploaded();
      if (had) {
        if (cfg.uploadedCheck) dbg(`resume: already uploaded${typeof had === "string" ? ` ("${had}")` : ""}, not uploading again`);
        return false;
      }
      const dt = new DataTransfer();
      dt.items.add(dataUrlToFile(resumeFile));
      // Some portals submit the form on the file input's change and reload the page with the parsed resume
      // (iCIMS). That's noticed here, and the run stops cleanly (cfg.beforeUpload can arrange to continue).
      let leaving = false;
      const onLeave = () => (leaving = true);
      addEventListener("beforeunload", onLeave);
      addEventListener("pagehide", onLeave);
      cfg.beforeUpload?.();
      // Never click "Attach" / "Upload File": it opens the OS file dialog. Set the input's files directly.
      input.files = dt.files;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      const ok = !!(await waitFor(() => leaving || uploaded(), 5000));
      removeEventListener("beforeunload", onLeave);
      removeEventListener("pagehide", onLeave);
      if (leaving) {
        dbg("resume: uploaded; the page is reloading with the parsed resume");
        return "reload";
      }
      cfg.afterUploadSettled?.();
      dbg(`resume: ${ok ? "uploaded via file input" : "set the file input, but the file name never appeared"}`);
      if (ok && prior.old) dbg(`replaced resume "${prior.old}" with "${resumeFile.name}"`);
      return ok;
    }

    // ------------------------------------------------------------- education
    const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    // A month given as 1-12 or a name ("September", "Sep").
    const monthNum = (m) => {
      const t = String(m || "").trim();
      if (/^\d{1,2}$/.test(t) && +t >= 1 && +t <= 12) return +t;
      const i = MONTHS.findIndex((x) => t.length >= 3 && x.toLowerCase().startsWith(t.toLowerCase().slice(0, 3)));
      return i >= 0 ? i + 1 : undefined;
    };
    // Month or year, for a date control without a word for it in its label (Ashby, Cascade Research: only a
    // "Month..." / "Year..." placeholder shown in the box). From, in order: the control's placeholder /
    // aria-label ("MM" / "YYYY" too), a short placeholder-like text in its box, a native select's options
    // (month names vs 4-digit years), then its position in a two-control date group (month first). Remembered
    // as f.datePartWhy for the log.
    const MONTH_RX = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?$/i;
    function datePart(f) {
      const say = (part, why) => ((f.datePartWhy = `${part}, from ${why}`), part);
      // A whole-date box ("MM/DD/YYYY", a date picker) is no month or year part (Nimbus's Graduation Date).
      if (f.type === "date") return "";
      const attr = f.ctrl?.getAttribute ? norm(`${f.ctrl.getAttribute("placeholder") || ""} ${f.ctrl.getAttribute("aria-label") || ""}`) : "";
      if (/\bmm\b.*\bdd\b.*\byyyy\b|\byyyy\b.*\bmm\b.*\bdd\b|\bdd\b.*\bmm\b.*\byyyy\b/.test(attr)) return "";
      if (/\bmonth\b|\bmm\b/.test(attr)) return say("month", "its placeholder / aria-label");
      if (/\byear\b|\byyyy\b/.test(attr)) return say("year", "its placeholder / aria-label");
      // The smallest wrapper around the control that holds no other date control of its group: its
      // placeholder element, or its whole text when that's short.
      const others = (f.eduGroup || []).filter((y) => y !== f).map((y) => y.ctrl);
      let box = "";
      for (let el = f.ctrl, i = 0; el && i < 5 && !box; i++, el = el.parentElement) {
        if (el === document.body || others.some((o) => el.contains(o))) break;
        const ph = el.querySelectorAll ? [...el.querySelectorAll('[class*="placeholder" i]')].map((x) => norm(textOf(x))).join(" ") : "";
        box = ph || (textOf(el).length <= 30 ? norm(textOf(el)) : "");
        if (el === f.c) break;
      }
      if (/\bmonth\b|\bmm\b/.test(box)) return say("month", `the box's "${box}"`);
      if (/\byear\b|\byyyy\b/.test(box)) return say("year", `the box's "${box}"`);
      if (f.ctrl?.tagName === "SELECT") {
        const opts = [...f.ctrl.options].map((o) => o.text.trim()).filter(Boolean);
        if (opts.filter((t) => MONTH_RX.test(t)).length >= 6) return say("month", "its options (month names)");
        if (opts.filter((t) => /^(19|20)\d\d$/.test(t)).length >= 3) return say("year", "its options (years)");
      }
      if (f.eduCtx && f.eduGroup?.length === 2) return say(f.eduGroup[0] === f ? "month" : "year", "its position (month first)");
      return "";
    }
    const monthAlts = (m) => (m ? [MONTHS[Number(m) - 1], MONTHS[Number(m) - 1]?.slice(0, 3), String(m).padStart(2, "0"), String(Number(m))].filter(Boolean) : undefined);
    // Value for one education field (one education entry is shown; only the first profile entry is used).
    // Degree steps by meaning (Steadfast: Degree had "BS" but no BE; the saved list put "Bachelor's" before Bachelor of
    // Science): for a bachelor's in engineering, the engineering wordings first (Bachelor of Engineering / BEng / B.E. /
    // BE), then science (Bachelor of Science / BS / B.S. / BSc), then a generic Bachelor's, then the rest in your order.
    // Any other degree keeps your saved order.
    function degreeStepsOf(x) {
      const steps = String(x.degreeOptions || x.degree || "").split("\n").map(splitAlts).filter((s) => s.length);
      const rank = (st) => {
        const t = st.map((a) => a.replace(/\./g, "")).map(norm);
        if (t.some((w) => /\bbachelor s? of engineering\b|^beng$|^b ?e$/.test(w))) return 0;
        if (t.some((w) => /\bbachelor s? of science\b|^bsc$|^b ?s$/.test(w))) return 1;
        if (t.some((w) => /^bachelor s?( degree)?$|^bachelors( degree)?$|^bachelor degree$|^undergraduate$/.test(w))) return 2;
        return 3;
      };
      if (!steps.length || rank(steps[0]) !== 0) return steps;
      const sorted = steps.map((st, i) => ({ st, i, r: rank(st) })).sort((a, b) => a.r - b.r || a.i - b.i).map((o) => o.st);
      if (sorted.some((st, i) => st !== steps[i]) && !AAF.namedLogged?.has("degorder")) {
        AAF.namedLogged?.add("degorder");
        dbg("degree: steps ordered by meaning (engineering, then science, then a generic bachelor's): " + sorted.map((st) => st[0]).join(" > "));
      }
      return sorted;
    }
    function eduValue(f, x, p) {
      // Class year / standing ("What year are you currently in?"): from the expected graduation date (shared/profile.js).
      if (AAF.CLASS_YEAR_Q?.test(f.nl)) {
        const c = AAF.classYearChoice(p);
        dbg(`education: ${f.label.slice(0, 60)}: class year: ${!c ? "no expected graduation date in Options" : c.none ? c.none : c.what}`);
        if (!c || c.none) return undefined;
        f.reviewAfter = true;
        return f.type === "text" ? ["Senior", "Junior", "Sophomore", "Freshman"][c.left] : { choose: c.choose, text: "Senior", what: "class year" };
      }
      // A yes / no question in the education block ("Have you been a student with GlobeQuant University within the past 12
      // months?") is never the school picker: the named-school rule (No unless it's your school), blue.
      if (["dropdown", "radio", "checkgroup"].includes(f.type) && /^(have|are|were|did|do|is) you\b/.test(f.nl) && !AAF.STUDENT_NOW.test(f.nl)) {
        const r = AAF.namedSchoolAnswer?.(f, p, f.nl);
        if (r) {
          f.reviewAfter = true;
          return r.value;
        }
        if (/\b(school|university|college|institution)\b/.test(f.nl)) return undefined; // a yes / no about a school: yours
      }
      // An education block's own Month / Year controls read their date title ("Start Date", "End Date").
      const L = `${f.nl} ${norm(f.eduCtx || "")} ${datePart(f)} | ${f.nid}`;
      if (f.type === "checkbox" && AAF.STUDENT_NOW.test(`${f.nl} ${norm(f.optionText || "")}`)) {
        const now = AAF.studentNow(p);
        return now === null ? undefined : { checked: now };
      }
      // "Still studying?" as Yes / No (Melodex): Yes while the expected graduation is ahead.
      if (["radio", "dropdown"].includes(f.type) && AAF.STUDENT_NOW.test(f.nl)) {
        const now = AAF.studentNow(p);
        return now === null ? undefined : [now ? "Yes" : "No"];
      }
      // iCIMS labels repeat the section ("College / University - Major"): the specific word wins over school.
      if (/degree/.test(f.nl)) {
        const steps = degreeStepsOf(x);
        return steps.length ? { degreeSteps: steps } : undefined;
      }
      if (/discipline|field of study|major/.test(f.nl)) return AAF.fieldOfStudyValue(x);
      if (/gpa/.test(f.nl)) return x.gpa || undefined; // blank = left for you (yellow), not a blank fill
      // "Graduated?" (yes / no): not yet when the entry ends in the future (the expected graduation date for
      // the entry ending that year).
      // Also "Did You Graduate?" (Steadfast, prefilled Yes; it went to the graduation-date rule and failed): from your
      // education, whatever the form shows.
      if ((/\bgraduated\b/.test(f.nl) || /^(did|have) you graduate\b/.test(f.nl)) && !/\b(date|when|year|month|day)\b/.test(f.nl) && f.type !== "text" && (x.endYear || p.expectedGraduation)) {
        const g = parseDate(p.expectedGraduation);
        const endYear = x.endYear || g.year;
        const end = String(g.year) === String(endYear) && g.month ? { y: +g.year, m: +g.month } : { y: +endYear, m: 12 };
        const t = AAF.today();
        const notYet = end.y > t.year || (end.y === t.year && end.m >= t.month);
        dbg(`education: ${f.label}: ${notYet ? `graduation (${g.month ? `${g.month}/` : ""}${end.y}) is ahead -> No` : "graduated -> Yes"} (from your education, not what the form shows)`);
        return [notYet ? "No" : "Yes"];
      }
      if (/date issued|date (awarded|conferred|received)/.test(f.nl)) return undefined;
      // "Other College/High School" (the box for a school not in the list): your school only when the block's school
      // field shows Other; blank otherwise (Steadfast: it got your school next to a matched one).
      if (f.type === "text" && /^(other|if other)\b|\bnot (listed|found|in the list)\b/.test(f.nl) && /school|college|university|institution/.test(f.nl)) {
        const sf = (f.blockFields || []).find((y) => y !== f && y.type !== "text" && /school|college|university|institution/.test(y.nl) && !/^other\b/.test(y.nl));
        const shown = sf ? currentValue(sf) : "";
        const other = /^(other|not listed|none of the above)\b/i.test(shown.trim());
        dbg(`education: ${f.label}: the school field shows ${shown ? `"${shown}"` : "nothing"}${other ? `, entering "${x.school}"` : ", so this stays blank"}`);
        return other ? x.school || undefined : AAF.SKIP; // blank by design: handled, not a gap
      }
      if (/school|university|institution|college/.test(L)) {
        if (!x.school) return undefined;
        const aliases = /\|/.test(x.schoolAliases || "") ? splitAlts(x.schoolAliases) : String(x.schoolAliases || "").split(",").map((t) => t.trim()).filter(Boolean);
        // Blank keyword: derived from the school name ("Lakeview University" -> "Lakeview").
        return { school: [x.school, ...aliases.filter((a) => norm(a) !== norm(x.school))], search: x.schoolSearch?.trim() || AAF.schoolKeyword(x.school) };
      }
      if (/degree/.test(L)) {
        const steps = degreeStepsOf(x);
        return steps.length ? { degreeSteps: steps } : undefined;
      }
      if (/discipline|field of study|major/.test(L)) return AAF.fieldOfStudyValue(x);
      if (/gpa/.test(L)) return x.gpa || undefined;
      // The part from the label's last word first (iCIMS "Graduation Date (Month / Day / Year) - Day": the hint names all
      // three parts, so Month and Day got "2027"), else the control / date title as before.
      const part = partOf(f);
      const isMonth = part ? part === "month" : /month/.test(L);
      const isYear = part ? part === "year" : /year/.test(L);
      // A month + year date: a day already shown stays; an empty one gets the 1st.
      if (part === "day") return /start|end|graduat|completion/.test(L) && !isFilled(f) ? ["1", "01"] : undefined;
      if (/start/.test(L) && (isMonth || isYear)) return isMonth ? monthAlts(monthNum(x.startMonth)) : x.startYear || undefined;
      // One box for the whole start date ("Start Date" MM/YYYY in Kestrel's Education History card): the entry's start
      // month / year in the box's format (year only for a year-only box); no start month = only a year-only box.
      if (/start/.test(L)) {
        const mo = monthNum(x.startMonth);
        if (!x.startYear) return undefined;
        if (f.type === "date") return mo ? { month: mo, year: x.startYear } : undefined;
        if (f.type !== "text") return undefined;
        const yearOnly = /^\s*yyyy\s*$/i.test(f.ctrl?.getAttribute?.("placeholder") || "");
        if (yearOnly) return String(x.startYear);
        return mo ? AAF.gradText(f, { expectedGraduation: `${String(mo).padStart(2, "0")}/01/${x.startYear}` }) : undefined;
      }
      if (/end|graduat|completion/.test(L)) {
        // End: the expected graduation date (its year when the entry has no end year).
        const d = parseDate(p.expectedGraduation);
        if (isYear) return x.endYear || d.year || undefined;
        if (isMonth) return d.month && (!x.endYear || String(d.year) === String(x.endYear)) ? monthAlts(d.month) : undefined;
        // One box for the whole date ("Graduation Date", Nimbus): the full expected graduation date in the box's
        // format (year only for a year-only box).
        if (p.expectedGraduation && d.year) {
          if (f.type === "date") return d;
          if (f.type === "dropdown" || f.type === "radio") return { choose: AAF.graduationChoice(d), what: "graduation date" };
          if (f.type === "text") return AAF.gradText(f, p);
        }
      }
      return undefined;
    }
    // Education / work fields this run already handled (by container): the section steps run again whenever fields are
    // revealed later (Melodex: the education and work blocks appeared only after the Claude round), and then take only
    // the new ones.
    let sectionRun = null;
    let sectionDone = new WeakSet();
    const sectionNew = (f) => {
      if (sectionRun !== AAF.run) {
        sectionRun = AAF.run;
        sectionDone = new WeakSet();
      }
      return !sectionDone.has(f.c);
    };
    // Fields in page order, except that within each entry (block index `idx`) the "still studying / still work here"
    // fields (`isStill`) come first.
    function stillFirst(fields, idx, isStill) {
      const at = new Map(fields.map((f, i) => [f, i]));
      return [...fields].sort((a, b) => idx(a) - idx(b) || (isStill(b) ? 1 : 0) - (isStill(a) ? 1 : 0) || at.get(a) - at.get(b));
    }
    // Disabled / read-only on the form right now (re-read before every section field): never filled, no outline.
    function offNow(f, what) {
      if (!isDisabled(f)) return false;
      dbg(`${what}: ${(f.eduCtx && !norm(f.label).includes(norm(f.eduCtx)) ? `${f.eduCtx} - ` : "") + (f.label || datePart(f) || f.type).slice(0, 60)}: turned off on the form (disabled / read-only), not filled`);
      return true;
    }
    // `late`: only empty fields (a re-render renumbers ids, so filled ones can look new: Greenhouse).
    async function fillEducation(p, stats, late = false) {
      const entries = p.education || [];
      if (!entries.length) return;
      // "Still Student?" / "Currently attending" first in each entry: checking it can disable End Date (Old Harbor), and
      // a date filled before that is an invalid entry. The fields after it are judged as they are by then.
      const fields = stillFirst(discover().filter((f) => isEduField(f) && sectionNew(f) && !(late && isFilled(f))), (f) => f.eduIdx || 0, (f) => ["checkbox", "radio", "dropdown"].includes(f.type) && !/\b(which|what)\b/.test(f.nl) && AAF.STUDENT_NOW.test(`${f.nl} ${norm(f.optionText || "")}`));
      if (!fields.length) return;
      if (entries.length > 1 && !fields.some((f) => f.eduIdx > 0)) dbg(`education: ${entries.length} entries in profile; only the first is filled`);
      for (const f of fields) {
        sectionDone.add(f.c);
        live(f); // earlier fills (and resume parsing) can re-render the education block
        if (offNow(f, "education")) continue;
        // The Nth education block takes the Nth entry ("Add a second degree?" = Yes revealed it).
        const x = entries[f.eduIdx || 0];
        if (!x) {
          dbg(`education: ${(f.label || f.type).slice(0, 60)}: education block ${f.eduIdx + 1}, but your profile has ${entries.length} entr${entries.length === 1 ? "y" : "ies"}; left for you`);
          mark(f, "needs");
          stats.needs++;
          continue;
        }
        f.blockFields = fields; // the "Other" box reads the school field next to it
        const v = eduValue(f, x, p);
        if (v === AAF.SKIP) {
          AAF.handled(f);
          continue;
        }
        const own = f.label || (f.datePartWhy ? f.datePartWhy.split(",")[0] : "") || f.type;
        const name = f.eduCtx && !norm(f.label).includes(norm(f.eduCtx)) ? `${f.eduCtx} - ${own}` : own;
        if (f.datePartWhy && !f.label) dbg(`education: ${name}: ${f.datePartWhy}`);
        if (v === undefined) {
          // Never skipped silently: said, and yellow when it's part of the education block (or required).
          if (isFilled(f)) {
            dbg(`education: ${name.slice(0, 60)}: kept "${String(currentValue(f) || "(filled)").slice(0, 60)}" (${partOf(f) === "day" ? "your dates are month + year" : "nothing in your profile for it"})`);
            AAF.handled(f);
          } else {
            dbg(`education: ${name.slice(0, 60)}: nothing in your profile for it, left for you`);
            if (f.eduBlock || f.required) {
              mark(f, "needs");
              stats.needs++;
            }
          }
          continue;
        }
        if (f.eduBlock && v?.checked === undefined) dbg(`education: ${name.slice(0, 60)} <- ${show(v?.school ? v.school[0] : v?.degreeSteps ? "degree steps" : v)}`);
        if (v?.checked !== undefined) {
          // "Still Student?" / "I currently study here": checked while the expected graduation is ahead, blue.
          const want = v.checked;
          dbg(`education: ${name.slice(0, 60)}: expected graduation ${p.expectedGraduation} is ${want ? "ahead" : "past"} -> ${want ? "checked" : "unchecked"} (blue)`);
          if (await setField(f, want)) {
            if (!f.keptOnly) AAF.countFill(f);
            mark(f, "review");
            stats.review++;
          } else {
            mark(f, "needs");
            stats.needs++;
          }
          continue;
        }
        let ok;
        if (v?.school) {
          ok = await timed(`school: ${f.label}`, () => retryIfDetached(f, () => setByNames(f, v.school, "school", v.search)));
          // The final verification sweep re-checks it (and picks it again when the field shows something else).
          if (ok && AAF.filledThisRun) AAF.filledThisRun.push({ f, v, picked: f.picked });
        }
        else if (v?.degreeSteps) {
          const { step } = await timed(`degree: ${f.label}`, () => retryIfDetached(f, () => chooseStep(f, v.degreeSteps, "degree"), (r) => r.step > 0));
          ok = step > 0;
          if (step >= 3) {
            dbg("degree: substitute, marked blue");
            mark(f, "review");
            stats.review++;
          }
        } else ok = await setField(f, v);
        if (ok && f.reviewAfter) {
          mark(f, "review");
          stats.review++;
        }
        if (ok && !f.keptOnly) AAF.countFill(f);
        // A date that didn't read back right holds a wrong value (a mask's "00/55/2211"): yellow even though filled.
        else if (v !== "" && v != null && (!isFilled(f) || (!ok && f.type === "date"))) {
          mark(f, "needs");
          stats.needs++;
        }
      }
    }

    // Work-experience blocks (`markWorkBlocks`): every field from the block's experience, by rule (blue), never
    // Claude. Experiences in your order with the current one first ("Most recent company").
    const STILL_WORK = /\b(still|currently) work\w*|\bwork here\b|\bcurrent(ly)? (employed|working)\b/;
    function workValue(f, x) {
      const L = `${f.nl} ${datePart(f)}`;
      if (STILL_WORK.test(f.nl)) return f.type === "checkbox" ? { checked: !!x.current } : [x.current ? "Yes" : "No"];
      if (/\b(company|employer|organi[sz]ation)\b/.test(f.nl)) return x.company || undefined;
      if (/\b(role|title|position)\b/.test(f.nl)) return x.title || undefined;
      if (/\blocation\b/.test(f.nl)) return x.location || undefined;
      if (/\b(description|responsibilities)\b/.test(f.nl)) return x.description || undefined;
      const start = /\b(start|from)\b/.test(L);
      const end = /\b(end|to|until)\b/.test(L);
      if (!start && !end) return undefined;
      if (end && !start && x.current) return null; // a current job has no end date
      const m = monthNum(start ? x.startMonth : x.endMonth);
      const y = start ? x.startYear : x.endYear;
      if (/\bmonth\b/.test(L)) return monthAlts(m);
      if (/\byear\b/.test(L)) return y || undefined;
      if (f.type === "date") return y ? { month: m, year: y } : undefined;
      return y ? (m ? `${String(m).padStart(2, "0")}/${y}` : String(y)) : undefined;
    }
    async function fillWork(p, stats, late = false) {
      const all = p.experiences || [];
      const ordered = [...all.filter((x) => x.current), ...all.filter((x) => !x.current)];
      const fields = stillFirst(discover().filter((f) => f.workBlock && sectionNew(f) && !(late && isFilled(f))), (f) => f.workIdx || 0, (f) => STILL_WORK.test(f.nl));
      for (const f of fields) {
        sectionDone.add(f.c);
        live(f);
        if (offNow(f, "work experience")) continue;
        const name = (f.label || f.type).slice(0, 60);
        const x = ordered[f.workIdx || 0];
        if (!x) {
          dbg(`work experience: ${name}: block ${f.workIdx + 1}, but your profile has ${ordered.length} experience entr${ordered.length === 1 ? "y" : "ies"}; left for you`);
          mark(f, "needs");
          stats.needs++;
          continue;
        }
        const v = workValue(f, x);
        if (v === null) {
          dbg(`work experience: ${name}: left blank (${x.company} is your current job)`);
          continue;
        }
        if (v === undefined) {
          dbg(`work experience: ${name}: nothing in your profile for it, left for you`);
          mark(f, "needs");
          stats.needs++;
          continue;
        }
        const cur = isFilled(f) ? currentValue(f) || "" : "";
        if (cur && v?.checked === undefined && AAF.matchesValue?.(cur, v, f) === true) {
          dbg(`work experience: ${name}: kept "${cur.slice(0, 60)}" (matches your profile)`);
          AAF.countKept(f);
          continue;
        }
        dbg(`work experience: ${name} <- ${show(v?.checked !== undefined ? (v.checked ? "checked" : "unchecked") : v)} (${x.title || "?"} at ${x.company || "?"}, blue)`);
        const ok = await setField(f, v?.checked !== undefined ? v.checked : v);
        if (ok) mark(f, "review");
        else {
          mark(f, "needs");
          stats.needs++;
        }
      }
    }

    // ------------------------------------------------------ sections (in fillPage order)
    // Resolves once the form has had no DOM changes for `quietMs` (or after `maxMs`); returns ms waited.
    function waitQuiet(root, quietMs = 700, maxMs = 5000) {
      return new Promise((resolve) => {
        const t0 = AAF.now();
        let timer;
        const done = () => {
          obs.disconnect();
          clearTimeout(timer);
          clearTimeout(cap);
          resolve(AAF.now() - t0);
        };
        const obs = new MutationObserver(() => {
          clearTimeout(timer);
          timer = setTimeout(done, quietMs);
        });
        obs.observe(root, { childList: true, subtree: true, attributes: true });
        timer = setTimeout(done, quietMs);
        const cap = setTimeout(done, maxMs);
      });
    }
    async function fillSections(p, stats) {
      const up = await uploadResume();
      if (up === "reload") {
        AAF.reloading = true; // shared/main.js stops the run cleanly
        return;
      }
      if (up) {
        AAF.countFill("resume");
        toast("Uploaded resume…");
        // The portal may parse the resume and re-render parts of the form; let it settle first.
        dbg(`resume: waited ${await waitQuiet(formRoot())} ms for the form to settle`);
        if (cfg.afterUpload) dbg(await cfg.afterUpload());
      }
    }
    // Education runs AFTER the main pass (fillLate), well past the re-render that follows a resume
    // upload, and its fields are found fresh then.
    // `late`: again for fields revealed after the main pass (after the Claude round too): the education and work
    // blocks only, each taking just the fields not handled yet this run.
    async function fillLate(p, stats, { late = false } = {}) {
      await fillEducation(p, stats, late);
      await fillWork(p, stats, late);
      if (late) return;
      if (cfg.repeatables) await fillBlocks(p, stats);
      await fillSchoolNotListed(p);
    }
    // Boxes for what a dropdown didn't list ("If your school isn't listed, please enter it here", Stitchly; "If your
    // institution was not listed above, enter it here", 2Password; a "Please specify" right after a degree / major /
    // how-did-you-hear dropdown). Decided after the education step, from the dropdown they belong to (the school field
    // for a school box, else the field right before): it shows Other / Not listed = your value (school name, degree,
    // field of study, the how-did-you-hear free text), blue; it shows a real choice = blank; it's empty = blank too
    // (never filled while the dropdown is empty; yellow when required). Logged `not listed: ...`.
    async function fillSchoolNotListed(p) {
      const x = (p.education || [])[0];
      const all = discover();
      const isOther = (v) => /^(other|others|not listed)\b|\bnot listed\b|^other \(/i.test(String(v || "").trim());
      const valueFor = (parent) => {
        const L = parent.nl;
        if (/\b(school|university|college|institution)\b/.test(L)) return x?.school || "";
        if (/\bdegree\b/.test(L)) return splitAlts(String(x?.degreeOptions || x?.degree || "").split("\n")[0])[0] || "";
        if (/\b(major|field of study|discipline)\b/.test(L)) return x?.field || "";
        if (/\bhow did you (hear|learn|find)|\bwhere did you (hear|find|learn)|\bwhat brought you\b|\bsource\b/.test(L)) return p.hearText?.trim() || "LinkedIn";
        return null; // not a list this step knows
      };
      for (const f of all.filter((y) => ["text", "textarea"].includes(y.type))) {
        const i = all.indexOf(f);
        const schoolBox = AAF.SCHOOL_NOT_LISTED?.test(f.nl);
        let parent = null;
        if (schoolBox) parent = all.find((y) => y !== f && ["dropdown", "text", "multi"].includes(y.type) && /\b(school|university|college|institution)\b/.test(y.nl) && !AAF.SCHOOL_NOT_LISTED.test(y.nl));
        else if (FOLLOW_SPEC.test(f.nl) && i > 0 && ["dropdown", "radio"].includes(all[i - 1].type) && valueFor(all[i - 1]) !== null) parent = all[i - 1];
        if (!schoolBox && !parent) continue;
        const v = parent && isFilled(parent) ? currentValue(parent) : "";
        const name = f.label.slice(0, 60);
        if (isFilled(f) && !(parent && !isOther(v))) {
          dbg(`not listed: kept "${String(currentValue(f)).slice(0, 60)}": ${name}`);
          AAF.countKept(f);
          continue;
        }
        if (v && !isOther(v)) {
          dbg(`not listed: "${parent.label.slice(0, 50)}" shows "${v}", so this stays blank: ${name}`);
          AAF.handled(f);
          continue;
        }
        if (!v) {
          dbg(`not listed: ${parent ? `"${parent.label.slice(0, 50)}" is empty` : "no field it belongs to was found"}, so this stays blank${f.required ? " (yellow, required)" : ""}: ${name}`);
          if (f.required) mark(f, "needs");
          else AAF.handled(f);
          continue;
        }
        const val = valueFor(parent) || "";
        if (!val) {
          mark(f, "needs");
          continue;
        }
        dbg(`not listed: "${parent.label.slice(0, 50)}" shows "${v}", entering "${val}" (blue): ${name}`);
        if (await setField(f, val)) mark(f, "review");
      }
    }

    // -------------------------------------------------------------- learning wiring
    function watchUserAnswers() {
      const fieldOf = (el) => discover().find((f) => f.group.includes(el) || f.c.contains(el));
      document.addEventListener(
        "change",
        (e) => {
          const t = e.target;
          if (!e.isTrusted || AAF.isSecretInput(t) || !t.matches?.("input, select, textarea") || t.type === "file" || isCombo(t)) return;
          const f = fieldOf(t);
          // A Yes / No's hidden checkbox: set by us (commitMirror's click fires a change Chrome marks as trusted, which
          // removed the blue outline); your own answer is a button click, seen below.
          if (!f || f.kind === "toggle") return;
          let v;
          if (t.type === "radio") v = choiceOptions(f.c, "radio").find((o) => o.el.checked)?.text;
          else if (t.type === "checkbox") {
            if (f.c.dataset.wdaf) unmark(f.c);
            return;
          } else if (t.tagName === "SELECT") v = t.selectedOptions[0]?.text;
          else v = t.value;
          if (v) AAF.learn(f, v.trim());
        },
        true
      );
      // react-select picks: a click on an option in the field's menu. Toggles: a click on Yes / No.
      document.addEventListener(
        "click",
        (e) => {
          if (!e.isTrusted) return;
          const btn = e.target.closest?.("button");
          if (btn && !AAF.isOwnUI?.(btn)) {
            const f = discover().find((x) => x.kind === "toggle" && x.group.includes(btn));
            if (f) userToggled.add(f.c); // the post-fill re-check leaves your answer alone
            if (f) AAF.learn(f, btn.innerText.trim());
            if (f) return;
          }
          const opt = e.target.closest?.('[role="option"], [class*="option"]');
          if (!opt) return;
          const menu = opt.closest('[role="listbox"], [class*="menu"]');
          const f = discover().find((x) => (x.kind === "react" || x.kind === "custom") && (x.c.contains(opt) || (menu?.id && x.ctrl.getAttribute("aria-controls") === menu.id)));
          if (f) AAF.learn(f, opt.innerText.trim());
        },
        true
      );
    }

    // The form root, for the "fields found" log line.
    function rootInfo() {
      const r = formRoot();
      if (r === document.body) return "<body> (no form root matched)";
      const cls = typeof r.className === "string" ? r.className.trim().split(/\s+/).slice(0, 4).join(".") : "";
      return `<${r.tagName.toLowerCase()}${r.id ? "#" + r.id : ""}${cls ? "." + cls : ""}>`;
    }

    // ---------------------------------------------------------------- adapter
    return {
      rootInfo,
      jobInfo: cfg.jobInfo,
      name: cfg.name,
      detect: cfg.detect,
      discoverFields: () => discover(),
      isFilled,
      currentValue,
      registered,
      isDisabled,
      afterFill,
      // The form's own text (not the job description around it), for the AI-use policy check.
      formText: () => (formRoot()?.innerText || "").slice(0, 60000),
      // On a stop: close any open menu / suggestion list (Escape on open comboboxes and the focused element).
      closePopups: () => {
        for (const el of document.querySelectorAll('[aria-expanded="true"]')) if (!AAF.isOwnUI?.(el)) key(el, "Escape");
        if (document.activeElement && document.activeElement !== document.body) key(document.activeElement, "Escape");
      },
      isSectionField,
      // The education step's value for one field (your first entry), for a fixed education label the step didn't take
      // (main.js asks it before the field is left for you).
      eduValueFor: (f, p) => {
        const x = (p.education || [])[0];
        if (!x) return undefined;
        f.blockFields = discover().filter((y) => y.type && /school|college|university|institution/.test(y.nl));
        return eduValue(f, x, p);
      },
      setField: setFieldRaw,
      readOptions,
      fillSections,
      fillLate,
      // An empty education / work field the late section step would fill (main.js counts them in late reveals).
      lateField: (f) => (isEduField(f) || !!f.workBlock) && !isFilled(f),
      watchUserAnswers,
      // Page-type hints. These portals are a single page; fixed answers are blue everywhere anyway.
      isFormPage: cfg.hasForm,
      isApplicationFlow: cfg.hasForm,
      isApplicationQuestionsPage: () => false,
    };
  };
})();
