// Application Autofill: shared main flow. Loaded last: picks the adapter for this host, then runs
// fillPage(): adapter sections first, then one pass over every field (profile / fixed answers /
// attestation guard / learned answers), a retry pass, then Claude for what's left.

(() => {
  const AAF = globalThis.AAF;
  if (!AAF.once("main")) return;
  const { dbg, show, sleep, norm, SKIP, checkboxOn, setField, ATTEST, profileValue, isSensitive, findLearned, loadState, state } = AAF;
  const { mark, clearMarks, namedLogged, ensureUI, toast, showButton, NEEDS, OFFICE_Q } = AAF;

  // Open-ended questions that are never drafted (they go to the normal Claude batch, whose
  // instructions return null for them): availability, pay, legal and identity topics. Whole words and the question's
  // intent, never a word inside another (Lunex: "relative to others in your field" kept a draft out as a relatives
  // question; "trace" / "embrace" held "race", "addressed" "address", "conviction" "convict"). Relatives use RELATIONSHIP_Q.
  const NO_DRAFT_TOPIC = /\b(salary|salaries|compensation|pay (expectations?|range|requirements?)|desired pay|criminal (record|history|conviction|offen[cs]e|background)|been convicted|convicted of|felony|felonies|referred|referral|references\b(?! (architecture|implementation|design|manual|docs?))|(visa|immigration|employment) sponsorship|sponsorship (now|in the future|for (a |an |your )?(visa|h ?1b|employment|work))|(require|need|requires|needs) (\w+ ){0,3}sponsorship|sponsor (you|your|an? (visa|h ?1b))|visas?|work authori[sz]ation|authori[sz]ed to work|citizenship|(a|us|u s) citizen|your (gender|race|ethnicity|pronouns|sexual orientation)|gender identity|race (\/|or|and) ethnicity|ethnicity|veteran status|protected veteran|disability status|(do|have) you have a disability|pronouns|(mailing|home|street|current|physical|e ?mail) address|your address|phone number|your phone|your e ?mail|e ?mail address)\b/;
  const NO_DRAFT_LINK = /\b(linkedin|github|website|portfolio|urls?)\b/;
  const noDraftTopic = (nl) => NO_DRAFT_TOPIC.test(nl) || !!AAF.isRelationshipQ?.(nl);
  // Open-ended prompts ("Tell me about...", "Describe a project...", "a side project you worked on") are drafted
  // even when they also ask for a link (Plotline: "... share a GitHub link" kept them out of drafts); the draft
  // includes the link from your profile. The other NO_DRAFT topics still keep them out.
  // Why a classified question stays yellow, per category (the classifier dispatch, `classifyAsks`): the ones with no rule
  // by design, and what's missing for the rest.
  const CATEGORY_YELLOW = {
    compensation: "pay is always yours: no rule, never Claude",
    "start date": "start dates are always yours: no rule, never Claude",
    attestation: "an attestation is yours to make: no rule, never Claude",
    disclosure: "a disclosure is yours to make: no rule, never Claude",
    EEO: "no EEO setting answers it: set it in Options",
    referral: "who referred you is yours",
    "work authorization": "Options work authorization is blank",
    sponsorship: "Options sponsorship is blank",
    residence: "no place your address matches",
    "relocation / office": "the office / location / relocation rules couldn't decide (no job location or accepted name)",
    "education status": "no education rule took this question",
    "military / government history": "Options government / military history is blank or not all No",
    "open-ended": "not drafted (AI-use policy, draft mode off, or not a text box)",
  };
  // A length limit the question states (Notional: "a great answer is around 100 words max"; "under 500 characters", "no
  // more than 150 words"): sent with the draft request (`lengthLimit`). A reply over it is sent back once for a rewrite
  // within the limit; a rewrite still over is cut at the last whole sentence that fits, never mid-sentence (none fits:
  // left as is, yellow), logged `... trimmed at a sentence boundary to M`.
  // Lunex: also sentences ("In one sentence", "2-4 sentences", "in 3 sentences or less"), and read from the field's
  // description / helper text as well as its label (the "In one sentence" under "hardest thing you've built" was missed).
  const NUM = "(\\d{1,5}|one|two|three|four|five|six|seven|eight|nine|ten|a single|single)";
  const NUM_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, "a single": 1, single: 1 };
  const UNIT = "(words?|char(?:acter)?s?|sentences?)";
  const QUAL = "(?:around|about|roughly|approximately|up to|no more than|not more than|under|less than|fewer than|at most|max(?:imum)?(?: of)?|limit(?:ed)? to|within|in|using)";
  // norm() turns "2-4" into "2 4", so a space also separates a range.
  const LIMIT_RXS = [
    // "no more than 150 words", "in 2-4 sentences", "in one sentence", "under 500 characters (max)"
    new RegExp(`\\b${QUAL}\\s+(?:${NUM}\\s*(?:-|–|to|\\s)\\s*)?${NUM}[\\s-]*${UNIT}(?:\\s+(?:max(?:imum)?|or (?:less|fewer)))?\\b`, "i"),
    // "250 words max", "(250 words max)", "500 characters or less", "150 word limit", "2-4 sentences"
    new RegExp(`\\b(?:${NUM}\\s*(?:-|–|to|\\s)\\s*)?${NUM}[\\s-]*${UNIT}\\s+(?:max(?:imum)?|or (?:less|fewer)|limit)\\b`, "i"),
    new RegExp(`\\b${NUM}\\s*(?:-|–|to|\\s)\\s*${NUM}[\\s-]*(sentences)\\b`, "i"),
    // "Word limit: 250", "character limit 500"
    /\b(word|char(?:acter)?) (?:limit|count|max(?:imum)?)\s*(?:of|is|:)?\s*(\d{2,5})\b/i,
  ];
  const toNum = (s) => (s == null ? NaN : /^\d/.test(s) ? Number(s) : NUM_WORDS[s.toLowerCase()] ?? NaN);
  function draftLimit(f) {
    const text = `${f.label || ""} ${f.desc || ""}`;
    for (const [i, rx] of LIMIT_RXS.entries()) {
      const m = text.match(rx);
      if (!m) continue;
      let n, u;
      if (i === 3) { n = Number(m[2]); u = m[1]; }
      else { n = toNum(m[2]); if (isNaN(n)) n = toNum(m[1]); u = m[3]; }
      if (!n || isNaN(n)) continue;
      const unit = /^w/i.test(u) ? "words" : /^s/i.test(u) ? "sentences" : "characters";
      // Words / characters need a real number (a "one word" answer isn't a length limit worth enforcing).
      if (unit !== "sentences" && n < 10) continue;
      return { n, unit, text: m[0].trim() };
    }
    return null;
  }
  const sentencesOf = (t) => t.match(/[^.!?]+[.!?]+(\s+|$)|[^.!?]+$/g) || [t];
  const countOf = (t, lim) => (lim.unit === "words" ? t.split(/\s+/).filter(Boolean).length : lim.unit === "sentences" ? sentencesOf(t.trim()).filter((s) => s.trim()).length : t.length);
  function withinLimit(text, lim) {
    if (countOf(text, lim) <= lim.n) return text;
    const sentences = sentencesOf(text);
    let out = "";
    for (const s of sentences) {
      if (countOf((out + s).trim(), lim) > lim.n) break;
      out += s;
    }
    // Whole sentences only, never mid-sentence: "" when even the first one is over (the caller leaves it for you).
    return out.trim();
  }
  // Routed by the question, not the field type (Chartwell Health: "Why Chartwell Health specifically, and why now?" was a
  // single-line box and went to the regular call): these kinds are drafted in a textarea or a text box alike.
  const DRAFT_KINDS = [
    ["motivation", /^why (do you want|would you like|are you (interested|applying|excited)|us\b|this (role|position|company|team|job|opportunity)|join|work (at|for|here|with)|now\b)|\bwhy (are you )?(interested|excited) in\b|\bwhy now\b|\bwhat (excites|interests|draws|attracts|motivates) you\b|^why (\w+ ){1,4}(specifically|in particular)\b|\bwhy do you want to (work|join)\b/],
    ["describe a time", /\b(describe|tell (me|us) about|share|walk (me|us) through) (a|an|one) (time|situation|moment|occasion)\b|\bgive (me |us )?an example of (a|an) (time|situation)\b/],
    ["challenge", /\b(challenge|obstacle|setback|failure|mistake|conflict|disagreement|hardest (problem|thing|bug))\b.{0,40}\b(you (faced|overcame|solved|encountered|handled|resolved|made|had|worked on)|and how you)\b|\bhardest (problem|thing|bug|challenge)\b/],
    ["project", /\b(side|personal|hobby|passion) projects?\b|\ba project (you|that you|youve|you ve)\b|\bprojects? (you|youve|you ve|you have) (worked on|built|are proud of|re proud of|created|made|shipped)\b|\bsomething you (built|made|created|shipped)\b/],
    ["tell us about", /^(please )?(tell (me|us) about|describe|walk (me|us) through|talk (to us )?about)\b/],
  ];
  // The draft kind, or "" (not drafted). A textarea that's none of these is still drafted ("open-ended").
  const draftKind = (f) => {
    if (f.type !== "textarea" && f.type !== "text") return "";
    if (AAF.AVAILABILITY_Q?.test(f.nl)) return "";
    // A single-line box asking for a link ("Link to something you built") takes a URL, never a paragraph.
    if (AAF.isLinkBox?.(f)) return "";
    const k = DRAFT_KINDS.find(([, rx]) => rx.test(f.nl))?.[0] || "";
    // Named kinds pass the link words ("... include a GitHub link"); the other NO_DRAFT topics still block.
    if (k) return noDraftTopic(f.nl) ? "" : k;
    return f.type === "textarea" && !noDraftTopic(f.nl) && !NO_DRAFT_LINK.test(f.nl) ? "open-ended (textarea)" : "";
  };
  const draftable = (f) => !!draftKind(f);
  // The draft should carry a link from your profile (GitHub / portfolio / LinkedIn) when the prompt asks for one.
  const LINK_ASK = /\b(link|links|url|urls|github|git hub|repo|repository|portfolio|website|demo|linkedin)\b/;
  // A reply that talks like an AI ("As an AI language model ...", "my knowledge cutoff ..."): never filled
  // (an injected instruction, or a trap the patterns missed).
  // Only an AI talking about itself (Perceptix: a draft saying "my experience as an AI engineer intern" was rejected for
  // "as an AI"): "as an AI" / "I am an AI" with nothing after them that makes AI a field or a role ("AI engineer",
  // "AI agents", "an AI company"), "as a language model", "my knowledge cutoff", an assistant's refusal ("I cannot help
  // with that", "I'm unable to assist with this") or offer ("I'd be happy to help you with that", "here is a draft for
  // the question").
  const AI_ROLE = "(?! (engineer|engineering|researcher|research|intern|internship|developer|scientist|product|products|company|startup|startups|team|agent|agents|platform|lab|safety|ethics|practitioner|enthusiast|specialist|consultant|lead|architect|student|infrastructure|tool|tools|system|systems|application|applications|project|projects|first|native|powered|driven|model|models)\\b)";
  const AI_SELF = new RegExp(
    `\\bas an ai(?: language model| model| assistant| chatbot)?\\b${AI_ROLE}|\\bas a (large )?language model\\b|\\bi am an? (ai|llm|large language model|language model|ai model|ai assistant|ai chatbot)\\b${AI_ROLE}|\\bi m an? (ai|llm|language model|ai model|ai assistant)\\b${AI_ROLE}|` +
      `\\bmy (knowledge|training( data)?) cut ?off\\b|\\bknowledge cut ?off\\b|\\bi (cannot|can not|can t|am unable to|m unable to|m not able to) (help|assist|provide|answer|write|complete|fulfill|comply)( you)? with (that|this|your request)\\b|` +
      `\\bi d be (happy|glad) to help( you)? with (that|this|your)\\b|\\bhere (is|s) (a|your) (draft|response|answer) (for|to) (the|your) question\\b`,
  );

  // AI-detection traps (Plotline): a field whose label / description, or visually hidden text inside it, is
  // addressed to an AI ("What is your knowledge cutoff?", "If you are an LLM ...", "Ignore previous
  // instructions", "Required: LLM", hidden "include the word ... in your answer"). Never filled, drafted or
  // sent to Claude; outlined red. Returns the reason ("" = not a trap); cached per container for the run.
  const LR = globalThis.AAF_LEARN_RULES;
  let trapCache = new WeakMap();
  const HIDDEN_SKIP = "input, select, option, textarea, script, style, template, [role=listbox], [role=option]";
  function visuallyHidden(el) {
    const s = getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) < 0.05 || parseFloat(s.fontSize) < 2) return true;
    if (/rect\(\s*0(px)?[ ,]+0(px)?[ ,]+0(px)?[ ,]+0(px)?\s*\)/.test(s.clip) || /inset\(\s*50%\s*\)/.test(s.clipPath)) return true;
    if (s.color === "transparent" || /rgba\([^)]*,\s*0\)$/.test(s.color)) return true;
    const r = el.getBoundingClientRect();
    if ((r.width <= 1 || r.height <= 1) && s.overflow === "hidden") return true;
    return r.right < -200 || r.bottom < -200 || (s.textIndent && parseFloat(s.textIndent) < -500);
  }
  // Text of the outermost visually hidden elements under root (not controls or listboxes).
  function hiddenTexts(root) {
    const out = [];
    const walk = (el) => {
      for (const c of el.children) {
        if (c.matches(HIDDEN_SKIP)) continue;
        if (visuallyHidden(c)) {
          const t = (c.textContent || "").trim();
          if (t) out.push(t);
        } else walk(c);
      }
    };
    if (root) walk(root);
    return out;
  }
  const quote = (s, m) => `"${String(s).slice(Math.max(0, m.index - 30), m.index + 90).trim()}"`;
  function trapWhy(f) {
    if (!f?.c || !LR?.TRAP_Q) return "";
    if (trapCache.has(f.c)) return trapCache.get(f.c);
    let why = "";
    // Visually hidden text first (a planted instruction, even inside an ordinary question's label), then the
    // label / description, then the rest of the field's text.
    for (const t of hiddenTexts(f.c)) {
      const n = norm(t);
      const h = LR.TRAP_Q.exec(n) || LR.HIDDEN_ORDER.exec(n);
      if (h) {
        why = `hidden instruction: ${quote(n, h)}`;
        break;
      }
    }
    for (const s of why ? [] : [norm(`${f.label || ""} ${f.desc || ""} ${f.optionText || ""}`), norm(f.c.textContent || "")]) {
      const m = LR.TRAP_Q.exec(s);
      if (m) {
        why = `addressed to an AI: ${quote(s, m)}`;
        break;
      }
    }
    trapCache.set(f.c, why);
    return why;
  }
  // AI-detection text elsewhere on the page (hidden notes, the job description): no field to outline, but
  // the application gets the AI-use signal. Only small, explicitly hidden elements are read (cheap on big pages).
  function pageTrapText() {
    const sel = '[hidden], [aria-hidden="true"], [style*="display: none"], [style*="display:none"], [style*="font-size: 0"], [style*="font-size:0"], [style*="opacity: 0"], [style*="opacity:0"], [class*="sr-only"], [class*="visually-hidden"], [class*="visuallyhidden"], [class*="screen-reader"]';
    for (const el of document.querySelectorAll(sel)) {
      if (el.closest("#aaf-root, [id^='aaf-']") || el.matches(HIDDEN_SKIP)) continue;
      const t = (el.textContent || "").trim();
      if (!t || t.length > 2000) continue;
      const n = norm(t);
      const m = LR?.TRAP_Q.exec(n) || LR?.HIDDEN_ORDER.exec(n);
      if (m) return quote(n, m);
    }
    return "";
  }
  // Generated text never contains em / en dashes (drafts are told so; this is the safety net).
  const noDashes = (s) => String(s).replace(/\s*\u2014\s*/g, ", ").replace(/\s*\u2013\s*/g, "-").replace(/,\s*,/g, ",");

  const A = Object.values(AAF.adapters).find((a) => a.detect());
  if (!A) return;
  AAF.adapter = A;
  A.watchUserAnswers();

  // Stops (and hides the button) once the extension is reloaded: this copy of the scripts is orphaned.
  const tick = setInterval(() => {
    if (!AAF.alive()) {
      clearInterval(tick);
      showButton(false);
      return;
    }
    showButton(A.isFormPage());
  }, 1500);

  // Fields the user edited by hand during this page session (trusted input / change / click events
  // inside them). Their values are never replaced; if they differ from the profile they're outlined
  // yellow instead. `AAF.markUserEdited` is also how tests simulate a hand edit.
  const userEdited = new Set();
  AAF.markUserEdited = (el) => el && userEdited.add(el);
  for (const type of ["input", "change", "click"]) {
    document.addEventListener(type, (e) => {
      if (AAF.filling) return; // our own label clicks fire trusted events during the fill
      if (e.isTrusted && e.target instanceof Element && !AAF.isOwnUI?.(e.target)) userEdited.add(e.target);
    }, true);
  }
  // Not when the field still shows what this extension wrote in this tab (`AAF.ours`): our own label clicks fire trusted
  // events too (during the fill, and in Ashby's re-check after it), and a rerun took them for your edits.
  const editedByUser = (f) => !AAF.ours?.(f) && [...userEdited].some((el) => el.isConnected && f.c?.contains(el));
  // Types whose shown value is compared before writing (multiselect chips, checkboxes, dates and files
  // keep their own handling).
  const COMPARED = new Set(["text", "textarea", "dropdown", "radio"]);

  // ------------------------------------------------------------- verification sweep
  // At the end of every fill (all portals), every field filled ok in this run is read again: a
  // re-render later in the run can reset an answered field (BoFL: a dropdown logged "ok <- No" and
  // ended up showing "Select One" with a blue outline). Empty, or no longer the chosen answer: filled
  // once more; still not: the blue is replaced by yellow, logged `reset after fill: <label>`.
  // Checked: emptiness for every type; the shown value for text / textarea / dropdown / radio (the
  // option or text the adapter recorded, allowing formats like "+1" for "United States +1" and
  // reformatted phone numbers); the state for single checkboxes.
  // The projects earlier drafts on this application used as their main example (sessionStorage, per tab, keyed
  // by the posting: the URL without its apply / step part), sent with the next drafts so a later page of the
  // same application prefers another one when it fits nearly as well.
  const draftAppKey = () => "aaf-draft-projects|" + location.hostname + location.pathname.replace(/\/(apply|application|applyManually|autofillWithResume|useMyLastApplication)(\/.*)?$/i, "");
  function draftUsed() {
    try {
      return JSON.parse(sessionStorage.getItem(draftAppKey()) || "[]");
    } catch {
      return [];
    }
  }
  draftUsed.add = (project, question) => {
    try {
      const list = draftUsed();
      list.push({ project, question });
      sessionStorage.setItem(draftAppKey(), JSON.stringify(list.slice(-20)));
    } catch {}
  };

  async function verifySweep(stats) {
    const runs = AAF.filledThisRun || [];
    AAF.filledThisRun = null; // the re-fills below aren't recorded again
    const last = new Map();
    for (const r of runs) last.set(r.f.c, r); // the last fill of each field
    let fields = null;
    const liveOf = (f) => {
      if (f.c?.isConnected) return f;
      fields ||= A.discoverFields();
      return fields.find((x) => x.type === f.type && x.id === f.id && x.nl === f.nl) || null;
    };
    const CHOICE = ["radio", "checkgroup", "checkbox"];
    const holds = (f, r) => {
      // Radios, toggles, checkboxes: the portal's own state (checked / aria-checked / aria-pressed, Ashby's
      // mirror checkbox), not just what's shown. Vellum's work-authorization "Yes" showed but wasn't registered.
      const reg = CHOICE.includes(f.type) && A.registered ? A.registered(f, r.picked, r.v?.value ?? r.v) : null;
      if (reg === false) return false;
      if (f.type === "checkbox") return typeof r.v === "boolean" || r.v?.value !== undefined ? f.ctrl.checked === checkboxOn(r.v?.value ?? r.v) : A.isFilled(f);
      if (!A.isFilled(f) && f.type !== "date") return false;
      const want = r.picked;
      if (want == null || !["text", "textarea", "dropdown", "radio"].includes(f.type) || !A.currentValue) return true;
      const cur = A.currentValue(f);
      if (!cur) return false;
      const a = norm(cur);
      const b = norm(String(want));
      return a === b || (f.type === "dropdown" && b.includes(a)) || AAF.samePrefill(cur, String(want), f);
    };
    for (const r of last.values()) {
      const f = liveOf(r.f);
      if (!f) continue;
      // Turned off since it was filled (End Date after "Still Student?" was checked): never refilled.
      if (A.isDisabled?.(f)) {
        if (!holds(f, r)) dbg(`${f.label.slice(0, 60) || f.type}: turned off on the form now (disabled / read-only), not refilled`);
        continue;
      }
      if (holds(f, r)) continue;
      const shown = A.currentValue?.(f) || (A.isFilled(f) ? "(filled)" : "(empty)");
      if (CHOICE.includes(f.type)) dbg(`${f.label.slice(0, 60)}: "${r.picked ?? show(r.v)}" is not registered after the fill (shows "${shown}"); clicking it again`);
      else dbg(`${f.label.slice(0, 60)}: after the fill it shows "${shown}" instead of "${r.picked ?? show(r.v)}"; filling it once more`);
      let ok = await setField(f, r.v);
      // Give a re-render a moment: an answer that resets itself shortly after the click must not pass.
      if (ok) {
        await sleep(800);
        ok = holds(liveOf(f) || f, r);
      }
      if (ok) {
        if (CHOICE.includes(f.type)) dbg(`re-registered: ${f.label.slice(0, 80)}`);
        continue;
      }
      dbg(`reset after fill: ${f.label.slice(0, 80)}`);
      const g = liveOf(f) || f;
      if (g.c.dataset.wdaf === "review" || g.c.dataset.wdaf === "ai") stats.review = Math.max(0, stats.review - 1);
      mark(g, "needs");
      stats.needs++;
      AAF.run.filled.delete(g.c);
      AAF.run.filled.delete(r.f.c);
    }
  }

  // ------------------------------------------------------------- progress + stop
  // While a fill runs: the "Autofilling… <step>" panel with a Stop button (shared/donetoast.js
  // AAF_PROGRESS_PANEL), in the toast's spot. In a child frame (an embedded form) the background shows it in
  // the TOP frame, like the toast; when it can't, the frame shows it in its visible part. Updates at most every
  // 400 ms (and on a new step name).
  const inFrame = window.top !== window;
  const progress = {
    step: "",
    last: 0,
    shownHere: false,
    async show(step, force) {
      this.step = step;
      AAF.step = step;
      const now = Date.now();
      if (!force && now - this.last < 400) return;
      this.last = now;
      const note = this.note || "";
      if (!inFrame) {
        globalThis.AAF_PROGRESS_PANEL?.({ step, note }, { onStop: () => stopFill() });
        return;
      }
      let shown = false;
      try {
        shown = !!(await chrome.runtime.sendMessage({ type: "FILL_PROGRESS", data: { step, note } }))?.shown;
      } catch {}
      if (!shown) {
        globalThis.AAF_PROGRESS_PANEL?.({ step, note }, { onStop: () => stopFill(), frame: true });
        this.shownHere = true;
      }
    },
    end() {
      globalThis.AAF_PROGRESS_PANEL?.({ done: true });
      if (inFrame)
        try {
          chrome.runtime.sendMessage({ type: "FILL_PROGRESS", data: { done: true } }).catch(() => {});
        } catch {}
    },
  };
  // A line under the step for the whole run (YC: "your qualifications might not match this job").
  AAF.setNote = (note) => {
    progress.note = note;
    progress.show(progress.step, true);
  };
  // The current step's name for the panel and the stop log ("Skills 34/89"); adapters call it too.
  let lastStepName = "";
  AAF.setStep = (step) => {
    const name = String(step).replace(/\s*\d+\/\d+$/, "");
    const force = name !== lastStepName;
    lastStepName = name;
    progress.show(step, force);
  };
  // Stop (the panel's button, the popup, Alt+Shift+F while running): the existing cancel mechanism, so the run
  // stops at its next wait; in-flight Claude requests are aborted by the background and their answers
  // discarded.
  function stopFill() {
    if (!running) return false;
    AAF.stoppedByUser = true;
    if (!AAF.cancel.reason) AAF.cancel.reason = "stopped by user";
    try {
      chrome.runtime.sendMessage({ type: "ABORT_CLAUDE" }).catch(() => {});
    } catch {}
    return true;
  }
  AAF.stopFill = stopFill;
  chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
    if (msg?.type === "STOP") sendResponse(stopFill());
    // A child frame's progress shown by this top frame (it runs our script: the iCIMS job page).
    if (msg?.type === "SHOW_PROGRESS" && !inFrame) sendResponse(!!globalThis.AAF_PROGRESS_PANEL?.(msg.data || {}, {}));
  });
  // The Done toast (or "Stopped.") with the counts so far; also relayed to the top frame for embedded forms.
  async function finishRun(stats, aiError, stopped) {
    stats.filled = AAF.run.filled.size + AAF.run.extra;
    stats.kept = AAF.run.kept.size;
    stats.needs = document.querySelectorAll('[data-wdaf="needs"]').length;
    stats.blue = document.querySelectorAll('[data-wdaf="review"], [data-wdaf="ai"]').length;
    stats.ai = document.querySelectorAll('[data-wdaf="ai"]').length;
    stats.review = stats.blue - stats.ai;
    dbg(`result: filled ${stats.filled}, kept ${stats.kept}, need you ${stats.needs}, double-check ${stats.blue} (drafts ${stats.drafts})${stopped ? " (stopped)" : ""}`);
    // The Done toast (shared/donetoast.js; a Claude error is repeated in it). On an ordinary page it shows
    // here. In a child frame (an embedded form) the background shows it in the TOP frame; when it can't
    // (no activeTab grant), it shows here, in the part of the iframe that is on screen. The background
    // also sends a desktop notification when the tab isn't in front (Options).
    // An adapter's note line and follow-up action for the toast (YC: "rewrite in your own words", "Redraft note").
    const extra = { ...(AAF.run.toastNote ? { note: AAF.run.toastNote } : {}), ...(AAF.run.toastAction && !stopped ? { action: AAF.run.toastAction.label } : {}) };
    // Possible AI-detection traps (red), shown as their own warning line. Yellow drafts (AI-use signal) are
    // already among "need you", so only the blue ones come off the blue count.
    const traps = document.querySelectorAll('[data-wdaf="trap"]').length;
    if (traps) dbg(`possible AI-detection traps: ${traps} (red), leave them blank`);
    const honesty = document.querySelectorAll('[data-wdaf="honesty"]').length;
    const doneData = { filled: stats.filled, kept: stats.kept, needs: stats.needs, blue: Math.max(0, stats.blue - (stats.drafts - (stats.draftsYellow || 0))), drafts: stats.drafts, ...(traps ? { traps } : {}), ...(honesty ? { honesty } : {}), aiError, site: location.hostname, ...extra, ...(stopped ? { stopped: true } : {}) };
    const onAction = AAF.run.toastAction?.run;
    AAF.hideToast?.();
    progress.end();
    if (!inFrame) globalThis.AAF_DONE_TOAST?.(doneData, { local: true, onAction });
    let shown = !inFrame;
    try {
      const r = await chrome.runtime.sendMessage({ type: "FILL_DONE", data: doneData });
      shown ||= !!r?.shown;
    } catch {}
    if (!shown) {
      dbg("done toast: shown inside this frame (the top page couldn't take it)");
      globalThis.AAF_DONE_TOAST?.(doneData, { local: true, frame: true });
    }
    return stats;
  }

  // ------------------------------------------------------------------ main
  let running = false;
  async function fillPage(opts = {}) {
    // The floating button on a page whose form lives in a child frame (iCIMS: the top-level iCIMS page
    // around icims_content_iframe) hands the fill to that frame.
    if (opts.fromButton && A.delegateFill?.()) return { delegated: true };
    // That top-level page never fills itself (its own search box isn't the application).
    if (A.passiveFrame?.()) return { passive: true };
    // A fill already running (the previous step's, still on its skill retries): stop it, then start.
    if (running) {
      AAF.cancel.reason = "a new fill started";
      dbg("a fill is already running: stopping it first");
      const until = Date.now() + 20000;
      while (running && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
      if (running) return { error: "Already running" };
    }
    AAF.cancel.reason = "";
    if (!AAF.alive()) {
      toast("The extension was reloaded: refresh this page to use it.", 8000);
      return { error: "Extension reloaded; refresh the page." };
    }
    running = true;
    AAF.filling = true; // learning.js: our own label clicks can fire trusted change events
    // The page / step changing under the run (Workday's next step, a new URL) cancels it.
    const stepOf = () => A.stepKey?.() || location.pathname + location.search;
    const startStep = stepOf();
    const stepWatch = setInterval(() => {
      if (!AAF.cancel.reason && stepOf() !== startStep) AAF.cancel.reason = "the page changed";
    }, 700);
    const u = ensureUI();
    u.btn.disabled = true;
    u.btn.style.display = "none"; // the "Autofilling…" panel with its Stop button takes its place
    AAF.stoppedByUser = false;
    progress.note = "";
    let runStats = null;
    progress.show("Starting", true);
    try {
      await loadState();
      const p = state.profile;
      const { learned: stored = [] } = await chrome.storage.local.get("learned");
      // Entries a learning rule now forbids (compensation, notice period, file upload, location /
      // attendance, availability, ...) are never reused, even before the background purge moves them.
      // Also never: entries waiting for your review (Options "Pending review"), and company-specific
      // entries on another company's application.
      const learned = stored.filter(AAF.usableLearned);
      if (learned.length < stored.length) {
        const LRW = globalThis.AAF_LEARN_RULES;
        const why = (x) => {
          const scope = x.company || LRW?.backfillScope(x)?.company;
          return AAF.learnBlock(x.q, x.type, x.a) || (LRW?.entryCategory(x).blocked ? `category set to ${x.category}` : LRW?.garbledCompany(x) ? "garbled, re-check" : x.pending && !state.settings.learnNoReview ? "pending review" : !x.company && /\[company\]/.test(x.q || "") ? "company name lost (old general entry)" : scope ? `only for ${scope}` : "?");
        };
        dbg(`learned answers: ${stored.length - learned.length} not used (${[...new Set(stored.filter((x) => !learned.includes(x)).map(why))].join(", ")})`);
      }
      // Learned entries a rule now answers (fixed answers, named employer, consent, education, location, ...):
      // the rule wins, and the entry is tagged "covered by rule" in Options.
      const covered = new Set();
      const stats = { filled: 0, kept: 0, ai: 0, review: 0, needs: 0, drafts: 0 };
      runStats = stats;
      clearMarks();
      trapCache = new WeakMap();
      // Set by a trap field, or AI-detection text elsewhere on the page / in the job description: drafts are
      // still made, but outlined yellow with "rewrite in your own words before submitting".
      let aiSignal = "";
      document.querySelectorAll("[data-wdaf-gave-up]").forEach((c) => delete c.dataset.wdafGaveUp);
      namedLogged.clear();
      AAF.filledThisRun = [];
      AAF.run = { filled: new Set(), kept: new Set(), extra: 0, handled: new Set(), noMatch: new Set(), startedAt: Date.now() };
      AAF.reloading = false;
      const tFill = AAF.fillClock.start();
      toast("Filling…");

      AAF.setStep("Resume and sections");
      await A.fillSections(p, stats);
      // The resume upload reloads the page (iCIMS submits the form to parse it): stop here cleanly.
      if (AAF.reloading) {
        dbg("page reloaded after resume parse: the fill continues on the reloaded page (if it doesn't, run again)");
        toast("Resume uploaded; the page is reloading with it…", 6000);
        return { reloading: true };
      }

      // Sensitive fields (passwords, SSN, ...) are never filled, learned, or sent to Claude.
      // Why the main pass doesn't take a field ("" = it does). The Workday skills guard is for the skills search box
      // (a "multi" field) only: a textarea whose long instructions mention skills was skipped silently by it.
      const skipWhy = (f) =>
        !f.type ? "no control type" : f.type === "file" ? "file" : trapWhy(f) ? "trap" : LR?.aiUsageQuestion?.(`${f.label} ${f.desc || ""}`) ? "AI / tool usage disclosure" : A.isDisabled?.(f) ? "disabled" : A.isSectionField(f) ? "section field" :
        f.type === "multi" && /skill/.test(f.nl + " " + f.nid) && !/\blanguages?\b/.test(f.nl) ? "skills (filled with the skills section)" : isSensitive(f) ? "sensitive" : A.restrictTo && !A.restrictTo(f) ? "not on this step (account step: email only)" : "";
      const skippable = (f) => !!skipWhy(f);
      // On Application Questions pages every automatic fill gets the blue double-check outline.
      const reviewAll = A.isApplicationQuestionsPage();
      // Page context for profile rules: a form with separate address line / city / zip fields never
      // gets the one-field full address.
      const fieldsNow = A.discoverFields();
      // How many fields discovery found, per type, so a run that found nothing is obvious in the log.
      const byType = {};
      for (const f of fieldsNow) byType[f.type || "unknown"] = (byType[f.type || "unknown"] || 0) + 1;
      dbg(
        `fields found: ${fieldsNow.length} ` +
          (fieldsNow.length ? `(${Object.entries(byType).map(([t, n]) => `${t} ${n}`).join(", ")})` : `(${A.noFieldsWhy?.() || "NONE: the adapter's selectors don't match this page; send the form's outerHTML"})`) +
          (A.rootInfo ? `, form root ${A.rootInfo()}` : "") +
          (window.top !== window ? `, in frame "${(() => { try { return window.frameElement?.id || window.name || location.pathname; } catch { return window.name || location.pathname; } })()}"` : "")
      );
      // Account step (iCIMS sign-in / create account): only the email is filled; passwords, security
      // questions and the rest are the user's.
      if (A.restrictTo && fieldsNow.some((x) => !A.restrictTo(x))) dbg("account step (sign in / create account): only the email is filled; the rest is yours");
      const has = (rx) => fieldsNow.some((x) => rx.test(x.nl + " | " + x.nid));
      const ctx = { splitAddress: has(/address line 1|addressline1|street address|address 1\b/) || (has(/\bcity\b/) && has(/postal|\bzip\b/)) };
      // Every field's label and shown value (ranked preferences: options already chosen in the set).
      ctx.fieldValues = () => A.discoverFields().map((x) => ({ c: x.c, label: x.label, v: A.isFilled(x) && A.currentValue ? A.currentValue(x) : "" }));
      // The how-did-you-hear dropdown's current answer, for its "Please specify" follow-up (read when asked).
      ctx.hearValue = () => {
        const h = A.discoverFields().find((x) => !["text", "textarea"].includes(x.type) && /how did you (hear|learn|find)|\bsource\b/.test(x.nl));
        return h && A.currentValue ? A.currentValue(h) : "";
      };
      // The job's location, only when an office-attendance question is on the page (read + logged once).
      if (fieldsNow.some((x) => OFFICE_Q.test(x.nl) || (x.desc && x.nl.length <= 150 && OFFICE_Q.test(x.desc)))) ctx.job = await AAF.jobInfo();
      // `extra`: more context for the rules (the classifier's category and the field's options, classifyAsks).
      const profileTarget = (f, extra) => {
        const r = profileValue(f, p, extra ? { ...ctx, ...extra } : ctx);
        if (r === SKIP || r === undefined || r === ATTEST || r === NEEDS) return r;
        const hasReview = r && typeof r === "object" && !Array.isArray(r) && "review" in r;
        const value = hasReview ? r.value : r;
        const empty = value == null || value === "" || (Array.isArray(value) && !value.some(Boolean));
        // confirm: filled, but outlined yellow for you to confirm (true, or a function asked after the fill:
        // a degree-in-field Yes when the form has no in-progress option).
        const confirm = hasReview && r.confirm ? (typeof r.confirm === "function" ? r.confirm : () => true) : null;
        return { value, hasReview, empty, confirm };
      };
      // The outline after a successful fill: yellow when the rule asks you to confirm, else blue when it
      // asks for a double-check (or `blue` is forced: a replaced value).
      const markFilled = (f, t, blue = false) => {
        if (t.confirm?.()) {
          dbg(`${f.label.slice(0, 60)}: filled, yellow so you confirm it`);
          mark(f, "needs");
          stats.needs++;
        } else if (blue || t.hasReview || reviewAll) { mark(f, "review"); stats.review++; }
      };
      // Fields with the same id + label (e.g. legal vs. preferred First Name) are told apart by order.
      const keyOf = (f) => f.id + "|" + f.nl;
      const withKeys = (list) => {
        const seen = {};
        return list.map((f) => ((f.key = keyOf(f) + "#" + (seen[keyOf(f)] = (seen[keyOf(f)] ?? -1) + 1)), f));
      };
      const scan = () => withKeys(A.discoverFields());

      const questions = [];
      const filledKeys = new Set();
      // A queue, not a one-time list: answering a question can reveal a follow-up (DataPilot: "If hired,
      // can you provide proof of eligibility?" appears only after "Are you legally permitted to work..." =
      // Yes, and was never discovered). A MutationObserver notes new elements; before the next field the
      // form is re-scanned and unseen fields are inserted right after the one just handled ("new field
      // revealed: ..."). When the queue runs out, up to 3 more passes look for anything still unseen.
      const queue = scan();
      const seenKeys = new Set(queue.map((f) => f.key));
      let added = false;
      const revealObs = new MutationObserver((ms) => {
        if (!added && ms.some((m) => [...m.addedNodes].some((n) => n.nodeType === 1))) added = true;
      });
      revealObs.observe(document.body, { childList: true, subtree: true });
      // Section fields (education / work blocks) are noted too: the queue skips them, and the late reveal runs the
      // adapter's section step on them (Melodex's blocks appeared only after the Claude round and were never filled).
      let sectionRevealed = 0;
      const revealNew = (at) => {
        const fresh = scan().filter((x) => !seenKeys.has(x.key));
        for (const x of fresh) {
          seenKeys.add(x.key);
          if (!skippable(x)) dbg(`new field revealed: ${x.label.slice(0, 80)}`);
          else if (x.type && A.lateField?.(x)) sectionRevealed++;
        }
        queue.splice(at, 0, ...fresh);
        return fresh.filter((x) => !skippable(x)).length;
      };
      let qi = 0;
      let extraPasses = 0;
      // The queue, from `qi`: run once for the main pass, and again for fields revealed later (late reveals).
      const runQueue = async () => {
      while (true) {
        if (added) {
          added = false;
          revealNew(qi);
        }
        if (qi >= queue.length) {
          if (extraPasses >= 3 || !(extraPasses++, revealNew(queue.length))) break;
          continue;
        }
        let f = queue[qi++];
        AAF.setStep(`Questions ${qi}/${queue.length}`);
        // Earlier fills (Country -> State) can re-render a field, detaching the container we captured.
        if (!f.c.isConnected) {
          f = scan().find((x) => x.key === f.key);
          if (!f) continue;
        }
        // A possible AI-detection trap: never filled, drafted or sent to Claude; red. The application gets the
        // AI-use signal (drafts stay, outlined yellow for you to rewrite).
        const trap = f.type ? trapWhy(f) : "";
        if (trap) {
          if (!namedLogged.has("trap|" + f.label)) {
            namedLogged.add("trap|" + f.label);
            dbg(`possible AI-detection trap, left blank (never filled or sent to Claude): ${f.label.slice(0, 80)} (${trap})`);
          }
          mark(f, "trap");
          aiSignal ||= `a possible AI-detection trap ("${f.label.slice(0, 60)}")`;
          continue;
        }
        // A question about using AI / tools on this application (an honesty check): never answered by a rule, learned or
        // sent to Claude; red, for you.
        if (f.type && LR?.aiUsageQuestion?.(`${f.label} ${f.desc || ""}`)) {
          if (!namedLogged.has("aiusage|" + f.label)) {
            namedLogged.add("aiusage|" + f.label);
            dbg(`AI / tool usage disclosure (an honesty check): answer it yourself, never filled, learned or sent to Claude (red): ${f.label.slice(0, 80)}`);
          }
          mark(f, "honesty");
          continue;
        }
        if (f.type && isSensitive(f)) {
          // Never silent: an over-broad SENSITIVE pattern once hid a required BoFL question ("Bank of Fictionland").
          dbg(`sensitive field skipped (not filled, learned, or sent to Claude): ${f.label.slice(0, 80)}`);
          if (f.required && !A.isFilled(f)) { mark(f, "needs"); stats.needs++; }
          continue;
        }
        // Turned off on the form (disabled / read-only): never filled, no outline.
        if (f.type && A.isDisabled?.(f) && !A.isSectionField(f)) {
          if (!namedLogged.has("off|" + f.label)) {
            namedLogged.add("off|" + f.label);
            dbg(`turned off on the form (disabled / read-only), not filled: ${f.label.slice(0, 80)}`);
          }
          continue;
        }
        const skip = skipWhy(f);
        if (skip) {
          // Said once for the kinds no other step logs (sections, files, traps and sensitive fields log their own).
          if (/skills|not on this step/.test(skip) && !namedLogged.has("skip|" + f.label)) {
            namedLogged.add("skip|" + f.label);
            dbg(`not in the main pass (${skip}): ${f.label.slice(0, 80)}`);
          }
          if (/skills|not on this step/.test(skip)) AAF.handled(f);
          continue;
        }
        const t = profileTarget(f);
        if (t && typeof t === "object" && !t.empty) {
          const lh = findLearned(f.label, stored);
          if (lh && !lh.coveredByRule) covered.add(lh.q);
        }
        if (t === SKIP) {
          // A rule leaves it blank (SMS consent, former names, a follow-up ...): one line, so no field ends without one.
          if (!namedLogged.has("rskip|" + f.label)) {
            namedLogged.add("rskip|" + f.label);
            dbg(`left blank by a rule: ${f.label.slice(0, 80)}`);
          }
          AAF.handled(f);
          continue;
        }
        // A rule decided this one is the user's (office attendance for a job outside the metro list).
        if (t === NEEDS) {
          if (!A.isFilled(f)) { mark(f, "needs"); stats.needs++; }
          continue;
        }
        if (t === ATTEST) {
          // Exact learned answer only (no fuzzy match, no rules, no Claude). Otherwise yellow, even
          // if the field already holds a value: that value may be wrong and the user must confirm it.
          const hit = learned.find((x) => norm(x.q) === f.nl);
          if (hit && (await setField(f, hit.a))) {
            mark(f, "review");
            stats.review++;
          } else {
            dbg(`attestation left for you: ${f.label.slice(0, 80)}`);
            mark(f, "needs");
            stats.needs++;
          }
          continue;
        }
        if (t !== undefined) {
          if (t.empty) {
            if (f.required && !A.isFilled(f)) {
              dbg(`profile value is blank, left for you: ${f.label.slice(0, 80)}`);
              mark(f, "needs");
              stats.needs++;
            }
            continue;
          }
          // Already holds a value (a portal's resume parse, or the user): compare before writing.
          // Dates (Workday Month / Day / Year boxes): compared box by box (`dateMatches`), and they count as
          // holding a value once any box has digits.
          const isDate = f.type === "date" && !!A.dateMatches;
          const cur = isDate || (COMPARED.has(f.type) && A.isFilled(f)) ? (A.currentValue?.(f) || "") : "";
          const before = isDate && !/\d/.test(cur) ? "" : cur;
          if (before) {
            const same = isDate ? A.dateMatches(f, t.value) : AAF.matchesValue(before, t.value, f);
            if (editedByUser(f)) {
              // Typed / chosen by hand on this page: never replaced.
              if (same === false) {
                dbg(`${f.label.slice(0, 60)}: you entered "${before.slice(0, 80)}", your profile says ${show(t.value)}; left yours (yellow)`);
                mark(f, "needs");
                stats.needs++;
              } else {
                dbg(`${f.label.slice(0, 60)}: kept your entry "${before.slice(0, 80)}"`);
                AAF.countKept(f);
              }
              filledKeys.add(f.key);
              continue;
            }
            if (same === true) {
              dbg(`${f.label.slice(0, 60)}: kept "${before.slice(0, 80)}" (matches your profile)`);
              AAF.countKept(f);
              filledKeys.add(f.key);
              markFilled(f, t);
              continue;
            }
          }
          let ok = await setField(f, t.value);
          // A named rule's answer that no option matches (BlackRidge: the minors rule's "N/A" on a Yes / No list): that
          // rule is skipped and the rules asked again, so the next one can try; up to 3 times.
          let tt = t;
          for (let n = 0; !ok && f.ruleName && ["radio", "dropdown", "checkgroup"].includes(f.type) && n < 3; n++) {
            const was = f.ruleName;
            (f.skipRules ||= new Set()).add(was);
            const next = profileTarget(f);
            const nextOk = next && typeof next === "object" && next !== NEEDS && next !== SKIP && next !== ATTEST && !next.empty;
            dbg(`rule "${was}" answered ${show(tt.value)}, but no option matches; ${nextOk ? `the next rule${f.ruleName ? ` ("${f.ruleName}")` : ""} answers ${show(next.value)}` : "no other rule answers it"}: ${f.label.slice(0, 80)}`);
            if (!nextOk) break;
            tt = next;
            ok = await setField(f, tt.value);
          }
          if (ok) {
            filledKeys.add(f.key);
            // It held something else: say what changed, and outline it blue.
            const after = before && (isDate || A.isFilled(f)) ? (A.currentValue?.(f) || "") : "";
            if (before && after && norm(after) !== norm(before)) {
              dbg(`${f.label.slice(0, 60)}: replaced "${before.slice(0, 80)}" with "${after.slice(0, 80)}"`);
              markFilled(f, tt, true);
            } else markFilled(f, tt);
          }
          // Not filled yet: the retry pass below handles it (and marks it yellow if that fails too).
          continue;
        }
        // Unknown field: treat as an application question. One that already shows an answer (yours, or ours from an
        // earlier fill in this tab) is kept and counts as handled (Dodecal's rerun listed kept checkgroups as "unhandled").
        if (A.isFilled(f)) {
          // Ours from an earlier fill in this tab: the end of the fill says so ("kept (earlier draft)", a draft blue).
          if (!AAF.ours?.(f)) {
            dbg(`${f.label.slice(0, 60)}: kept "${String(A.currentValue?.(f) || "(filled)").slice(0, 60)}" (already answered)`);
            AAF.handled(f);
          }
          continue;
        }
        const isQuestion = f.required || f.label.length > 25 || ["radio", "dropdown", "textarea", "checkgroup"].includes(f.type);
        if (!isQuestion || !f.label) continue;
        const hit = AAF.findLearnedFor(f, learned);
        if (hit && (await setField(f, hit.a))) {
          // A relationship answer reused here (maybe learned at another company): blue, double-check it.
          const rel = AAF.isRelationshipQ(f.label);
          if (rel) dbg(`relationships: your learned answer "${hit.a}" (${AAF.learnedScope(hit) ? `for ${AAF.learnedScope(hit)}` : "general"}), blue so you double-check: ${f.label.slice(0, 80)}`);
          // One that can go stale ("previously applied", "how many companies"): blue too.
          const stale = !rel && globalThis.AAF_LEARN_RULES?.staleLearned(f.label);
          if (stale) dbg(`learned answer "${hit.a}" may be out of date (${AAF.learnedScope(hit) ? `for ${AAF.learnedScope(hit)}` : "general"}), blue so you double-check: ${f.label.slice(0, 80)}`);
          if (reviewAll || rel || stale) { mark(f, "review"); stats.review++; }
          continue;
        }
        // EEO / demographic, relationship and product-usage questions: never Claude or drafts; yours (the
        // last two are learned from your answer).
        const why = AAF.noClaudeWhy(f);
        // A fixed education label in the main pass: the education step didn't take it (no block / education section
        // found for it). Its value is asked of the education step here before it's left for you, and the log says why
        // (Steadfast: School, Degree and Major went yellow with no education line at all).
        if (why && /^education field/.test(why)) {
          const v = A.eduValueFor?.(f, p);
          if (v !== undefined && v !== SKIP && v !== NEEDS) {
            dbg(`education step: no block found for ${f.label.slice(0, 80)}; filled from your education entry 1`);
            if (await setField(f, v)) {
              markFilled(f, { value: v, hasReview: true }, true);
              continue;
            }
          }
          dbg(`education step: no block found for ${f.label.slice(0, 80)}; ${v === undefined ? "nothing in your education for it" : "it couldn't be filled"}, left for you (never the classifier or Claude)`);
          mark(f, "needs");
          stats.needs++;
          continue;
        }
        if (why) {
          dbg(`${why}: left for you, never sent to Claude: ${f.label.slice(0, 80)}`);
          mark(f, "needs");
          stats.needs++;
          continue;
        }
        // The form forbids AI-written answers here (Ashby section: "your own original, unassisted
        // writing ... will result in permanent disqualification"): never sent to Claude.
        if (f.noAI) {
          dbg(`own writing required, not sent to Claude, left for you: ${f.label.slice(0, 80)}`);
          mark(f, "needs");
          stats.needs++;
          continue;
        }
        // "Do you have experience with X?" (yes / no): its own Haiku check against your materials (`experienceRound`).
        if (["radio", "dropdown", "checkgroup"].includes(f.type) && globalThis.AAF_LEARN_RULES?.experienceYesNo(f.nl)) f.expCheck = true;
        questions.push(f);
      }
      };
      await runQueue();
      if (covered.size) {
        dbg(`learned answers covered by a rule (the rule is used; tagged in Options): ${show([...covered])}`);
        try {
          const { learned: all = [] } = await chrome.storage.local.get("learned");
          for (const x of all) if (covered.has(x.q)) x.coveredByRule = true;
          await chrome.storage.local.set({ learned: all });
        } catch {}
      }

      // Retry pass: fields that re-rendered or appeared after a dependent fill (e.g. State after Country).
      // Checkboxes count as done when they match the wanted state (unchecked can be the right answer).
      // Radios / toggles / checkbox groups: done = registered in the portal's own state, not just shown.
      const done = (f, v) => {
        if (f.type === "checkbox") return f.ctrl.checked === checkboxOn(v);
        if (["radio", "checkgroup"].includes(f.type) && A.registered?.(f) === false) return false;
        return A.isFilled(f);
      };
      AAF.setStep("Checking answers");
      for (const f of scan()) {
        if (skippable(f)) continue;
        const t = profileTarget(f);
        if (!t || t === SKIP || t === ATTEST || t === NEEDS || t.empty || done(f, t.value)) continue;
        // The first try saw the options and none matched (a location list of countries, a Yes / No list the school rule
        // was given): the same fill again would fail the same way (GlobeQuant's location was tried twice).
        if (AAF.run.noMatch?.has(`${f.type}|${f.nl}`)) {
          dbg(`not retried (no option matched on the first try, the same fill would fail again): ${f.label.slice(0, 80)}`);
          mark(f, "needs");
          stats.needs++;
          continue;
        }
        // The adapter gave up on this field safely (e.g. a category browse found nothing): no second try.
        if (f.c.dataset.wdafGaveUp) {
          mark(f, "needs");
          stats.needs++;
          continue;
        }
        if ((await setField(f, t.value)) && done(f, t.value)) {
          // Filled earlier in this run, then lost (a re-render: Vellum's survey reset a main-form answer).
          if (filledKeys.has(f.key)) {
            if (["radio", "checkgroup", "checkbox"].includes(f.type)) dbg(`re-registered: ${f.label.slice(0, 80)}`);
            continue;
          }
          markFilled(f, t);
        } else {
          mark(f, "needs");
          stats.needs++;
        }
      }

      // Optional adapter step after the main pass (Greenhouse: education, after the resume re-render).
      AAF.setStep("Education");
      if (A.fillLate) await A.fillLate(p, stats);

      const settings = state.settings;
      let aiError = "";
      // One Claude round for a list of questions: open-ended textareas get drafts (draft mode, below);
      // everything else goes to the Claude batch. Run for the main pass's questions, then for questions
      // revealed late.
      let aiPolicy = false;
      // Classification before Claude: every question no rule answered goes through one Haiku classifier (background.js
      // CLASSIFY_ASK) into a rule category. Only "other" is asked of Claude; "open-ended" is drafted; a category with
      // a profile setting uses it (work authorization, sponsorship, relocation, military / government history: the
      // value goes through the meaning mapper); every other category stays yellow, never Claude. Classifier
      // unavailable: every question goes to Claude as before. Returns the questions still to ask.
      const classifyAsks = async (asks, drafts) => {
        let res;
        try {
          res = await AAF.untilCancel(chrome.runtime.sendMessage({ type: "CLASSIFY_ASK", site: location.hostname, questions: asks.map((f, id) => ({ id, question: f.label, type: f.type })) }));
        } catch (e) {
          if (e instanceof AAF.Cancelled) throw e;
          res = { error: e.message };
        }
        if (!Array.isArray(res?.categories)) {
          dbg(`${/rejected the request/.test(res?.error || "") ? `question classifier: ERROR ${res.error} (fix this: every question goes to Claude until it works)` : `question classifier unavailable (${res?.error || "no categories in the reply"})`}; ${asks.length} question${asks.length === 1 ? "" : "s"} go to Claude`);
          return asks;
        }
        const cat = new Map(res.categories.map((x) => [x.id, x.category]));
        const a = p.answers || {};
        // Where every category goes (the rules run first with the category and options, then this setting):
        //   work authorization -> the work-authorization rules, then Options "Authorized to work" (meaning mapper)
        //   sponsorship -> the sponsorship rules, then Options "Need sponsorship"
        //   residence -> the residence rule (the place after in / out of / within / near / local to vs your address)
        //   relocation / office -> office preference / attendance, location, relocation rules; then Options "Willing to relocate"
        //   education status -> studying-now, school, graduation rules
        //   military / government history -> Options "Government / military history" (every named kind No = No)
        //   EEO -> the EEO rule the options point to (veteran / disability / gender / race / orientation), Options EEO settings
        //   referral -> the how-did-you-hear list when the options are sources; who-referred-you questions stay yours
        //   open-ended -> drafts; other -> Claude
        //   compensation, start date, attestation, disclosure -> no rule by design: always yours (CATEGORY_YELLOW)
        const settingFor = (c, f) => {
          if (c === "work authorization") return a.workAuth || "";
          if (c === "sponsorship") return a.sponsorship || "";
          if (c === "relocation / office") return /relocat/.test(f.nl) ? a.relocate || "" : "";
          if (c === "military / government history") {
            // Only employment / service wording (employed by, worked for, served in, a former official): willingness to
            // work on government projects is not history (Kestrel), it stays yellow.
            if (!(AAF.GOV_KINDS_RX || []).some((re) => re.test(f.nl))) return "";
            const need = [/\b(military|armed forces|veteran|served|service ?member|national guard|reserves?|army|navy|air force|marines?)\b/.test(f.nl) && a.armedForces, /\b(government|govt|federal|dod|public sector)\b/.test(f.nl) && a.govEmployee].filter((x) => x !== false);
            return need.length && need.every((x) => x === "No") ? "No" : "";
          }
          return "";
        };
        const ask = [];
        const counts = {};
        for (const [id, f] of asks.entries()) {
          const c = cat.get(id) || "other";
          counts[c] = (counts[c] || 0) + 1;
          if (c === "other") {
            ask.push(f);
            continue;
          }
          if (c === "open-ended" && !aiPolicy && ["text", "textarea"].includes(f.type) && !AAF.isLinkBox?.(f)) {
            dbg(`classified open-ended: drafted: ${f.label.slice(0, 80)}`);
            drafts.push(f);
            continue;
          }
          // The classifier routes, the rules answer (Flarewave: "Which office location(s) are you interested in?" was
          // classified relocation / office and left yellow): the rules run again with the category and the field's
          // options (the office rules then tell an office preference from attendance); a value = filled as that rule
          // fills it; the rules leaving it for you = yellow; no rule = the category's Options setting, else yellow.
          const options = A.readOptions && ["radio", "dropdown", "checkgroup"].includes(f.type) ? (await A.readOptions(f)) || [] : [];
          if (c === "relocation / office" && !ctx.job) ctx.job = await AAF.jobInfo();
          const t = profileTarget(f, { category: c, options });
          if (t && typeof t === "object" && !t.empty) {
            dbg(`classified ${c}: the ${c} rules decide: ${f.label.slice(0, 80)}`);
            if (await setField(f, t.value)) {
              f.done = true;
              markFilled(f, t, true);
              continue;
            }
            mark(f, "needs");
            stats.needs++;
            f.markedNeeds = true;
            continue;
          }
          if (t === NEEDS) {
            dbg(`classified ${c}: the ${c} rules leave it for you, never sent to Claude: ${f.label.slice(0, 80)}`);
            mark(f, "needs");
            stats.needs++;
            f.markedNeeds = true;
            continue;
          }
          const v = settingFor(c, f);
          if (v && ["radio", "dropdown", "checkgroup", "text"].includes(f.type)) {
            dbg(`classified ${c}: "${v}" from your profile (blue): ${f.label.slice(0, 80)}`);
            if (await setField(f, v)) {
              f.done = true;
              mark(f, "review");
              stats.review++;
              continue;
            }
          } else {
            // The reason says what was known: "no job location" only when none was found (Remedy AI's said so with
            // "New York; New York" read).
            const why = c === "relocation / office" && ctx.job?.location ? `no office / location / relocation rule took this question; job location "${ctx.job.location.slice(0, 100)}"` : CATEGORY_YELLOW[c] || "no rule or setting decided it";
            dbg(`classified ${c}: left for you (${why}), never sent to Claude: ${f.label.slice(0, 80)}`);
          }
          mark(f, "needs");
          stats.needs++;
          f.markedNeeds = true;
        }
        dbg(`question classifier (${res.model || "?"}): ${Object.entries(counts).map(([c, n]) => `${n} ${c}`).join(", ")}; ${ask.length} to Claude${res.cached ? ` (${res.cached} from the cache: classified the same as before)` : ""}`);
        return ask;
      };
      // Yes / no experience questions ("Do you have experience with Python?"): one Haiku call that may only answer Yes,
      // citing a verbatim quote from your resume, LinkedIn text, extra notes or skills; the quote must really be in that
      // source. Anything else, a "No", or a scale of levels instead of Yes / No stays yellow: an experience question is
      // never auto-answered No. Never the regular Claude batch, never drafted.
      const EXP_SOURCES = { resume: ["resume", p.resumeText], linkedin: ["LinkedIn text", p.linkedinText], notes: ["extra notes", p.extraNotes], skills: ["skills", p.skills] };
      const experienceRound = async (exp) => {
        const left = (f, why) => {
          dbg(`experience check: ${why}, left for you: ${f.label.slice(0, 80)}`);
          mark(f, "needs");
          stats.needs++;
          f.markedNeeds = true;
        };
        if (!settings.useAI || !p.api?.key) {
          for (const f of exp) left(f, settings.useAI ? "no API key in Options" : "AI is turned off");
          return;
        }
        const ask = [];
        for (const f of exp) {
          const opts = (await A.readOptions(f)) || [];
          const yes = opts.some((o) => /^(yes|i (do|have))\b/.test(norm(o))), no = opts.some((o) => /^(no|i (do not|dont|have not|havent))\b/.test(norm(o)));
          if (opts.length && !(yes && no && opts.length <= 4)) left(f, `the options are a scale, not Yes / No (${show(opts)})`);
          else ask.push(f);
        }
        if (!ask.length) return;
        AAF.setStep(`Checking experience (${ask.length})`);
        let res;
        try {
          res = await AAF.untilCancel(chrome.runtime.sendMessage({ type: "EXPERIENCE_CHECK", questions: ask.map((f, id) => ({ id, question: f.label })) }));
        } catch (e) {
          if (e instanceof AAF.Cancelled) throw e;
          res = { error: e.message };
        }
        if (AAF.cancel.reason) throw new AAF.Cancelled(AAF.cancel.reason);
        dbg(`experience check (${res?.model || "?"}): ${ask.length} question${ask.length === 1 ? "" : "s"} sent${res?.error ? `, ERROR ${res.error}` : ""}`);
        const byId = new Map((res?.answers || []).map((r) => [r.id, r]));
        for (const [id, f] of ask.entries()) {
          const r = byId.get(id);
          if (!r || res?.error) { left(f, res?.error ? "Haiku unavailable" : "no answer from Haiku"); continue; }
          if (r.answer !== "Yes") {
            left(f, r.answer == null ? `Haiku found no evidence${r.reason ? ` (${r.reason})` : ""}` : `Haiku answered "${r.answer}", but only a cited Yes is used`);
            continue;
          }
          const src = EXP_SOURCES[String(r.source || "").toLowerCase()];
          const quote = String(r.quote || "").trim();
          if (!src || !quote) { left(f, `Haiku said Yes without a source and quote (source ${JSON.stringify(r.source)})`); continue; }
          if (!norm(String(src[1] || "")).includes(norm(quote))) { left(f, `Haiku said Yes, but its quote "${quote.slice(0, 100)}" isn't in your ${src[0]}`); continue; }
          if (A.isFilled(f)) { dbg(`experience check: ${f.label.slice(0, 70)} was filled meanwhile, kept it`); continue; }
          if (await setField(f, "Yes")) {
            f.done = true;
            mark(f, "review");
            stats.review++;
            dbg(`experience check: ${f.label.slice(0, 70)} -> Yes (blue), from your ${src[0]}: "${quote.slice(0, 140)}"`);
          } else left(f, "Yes couldn't be selected");
        }
      };
      const askRound = async (list) => {
      const exp = list.filter((f) => f.expCheck && !f.done);
      if (exp.length) await experienceRound(exp);
      list = list.filter((f) => !f.expCheck);
      const drafts = aiPolicy ? [] : list.filter(draftable);
      for (const f of drafts) dbg(`draft: ${draftKind(f)}: ${f.label.slice(0, 80)}`);
      if (aiPolicy && list.some(draftable)) dbg(`AI-use policy: ${list.filter(draftable).length} open-ended question(s) left for you, not drafted`);
      list = aiPolicy ? list.filter((f) => !draftable(f)) : list;
      let asks = list.filter((f) => !drafts.includes(f));
      if (asks.length && settings.useAI && p.api?.key) asks = await classifyAsks(asks, drafts);
      if (!list.length) dbg("Claude: no unanswered questions to send");
      else if (!settings.useAI) dbg(`Claude: skipped, AI is turned off (${list.length} questions left for you)`);
      else if (!p.api?.key) dbg(`Claude: skipped, no API key in Options (${list.length} questions left for you)`);
      else if (asks.length) {
        toast(`Asking Claude about ${asks.length} question${asks.length > 1 ? "s" : ""}…`);
        AAF.setStep(`Asking Claude (${asks.length})`);
        const payload = [];
        for (const [i, f] of asks.entries()) {
          const options = await A.readOptions(f);
          payload.push({ id: i, question: f.label, type: f.type, options });
        }
        let res;
        try {
          res = await AAF.untilCancel(chrome.runtime.sendMessage({
            type: "ASK_AI",
            questions: payload,
            context: { company: location.hostname.split(".")[0], pageTitle: document.title },
          }));
        } catch (e) {
          if (e instanceof AAF.Cancelled) throw e; // stopped: the answer is discarded
          res = { error: `couldn't reach the background script: ${e.message}` };
        }
        if (AAF.cancel.reason) throw new AAF.Cancelled(AAF.cancel.reason);
        dbg(`Claude: ${asks.length} questions sent, model ${res?.model || "?"}, ${res?.error ? "ERROR " + res.error : (res?.answers?.length ?? 0) + " answers"}${res?.retried ? " (after asking again for JSON only)" : ""}`);
        if (res?.raw != null) dbg(`Claude: the reply started: ${JSON.stringify(res.raw)}`);
        if (res?.error) aiError = res.error;
        for (const r of res?.answers || []) {
          const f = asks[r.id];
          if (!f) continue;
          const conf = r.confidence ?? 0;
          const why = r.answer == null || r.answer === "" ? "no answer (null)" : conf < settings.threshold ? `below threshold ${settings.threshold}` : "";
          dbg(`Claude: ${f.label.slice(0, 70)} -> ${JSON.stringify(r.answer)} (confidence ${conf})${why ? ", not used: " + why : ""}`);
          if (why) continue;
          const selfAns = AI_SELF.exec(norm(r.answer));
          if (selfAns) {
            dbg(`Claude: the answer for ${f.label.slice(0, 60)} talks like an AI (an injected instruction?): matched "${selfAns[0]}" in "${String(r.answer).slice(0, 300)}"; not used, left for you`);
            continue;
          }
          // Filled since the question was collected (a portal's resume parse): never overwritten.
          if (A.isFilled(f)) {
            dbg(`Claude: ${f.label.slice(0, 70)} was filled meanwhile (e.g. prefilled by the portal), kept it`);
            f.done = true;
            continue;
          }
          if (await setField(f, r.answer)) {
            f.done = true;
            mark(f, "ai");
            stats.ai++;
          }
        }
      }
      // Draft mode: open-ended textareas (not the "own writing" ones, which never got here) are drafted
      // from the profile, resume, notes, LinkedIn text, and the job description, in one call. Each draft
      // is filled BLUE and logged; it is never saved as a learned answer (only the user's own edits are,
      // through the trusted change event).
      if (drafts.length && settings.useAI && p.api?.key) {
        if (settings.drafts === false) dbg(`draft mode is off: ${drafts.length} open-ended question${drafts.length > 1 ? "s" : ""} left for you`);
        else {
          toast(`Drafting ${drafts.length} answer${drafts.length > 1 ? "s" : ""}…`);
          AAF.setStep(`Drafting (${drafts.length})`);
          const job = await AAF.jobInfo();
          // The job description is page text too: AI-detection text in it is never followed (it is sent as
          // data) and gives the application the AI-use signal.
          const jd = norm(job.description || "");
          const jdTrap = LR?.TRAP_Q.exec(jd) || LR?.HIDDEN_ORDER.exec(jd) || null;
          // Every scan is logged, so a draft rejected for AI talk can be checked against what the page said.
          if (jdTrap) {
            dbg(`possible AI-detection text in the job description, ignored as instructions: ${quote(jd, jdTrap)}`);
            aiSignal ||= "AI-detection text in the job description";
          } else dbg(`job description scanned for hidden instructions ("if you are an AI", "ignore previous", "include the word" ...): none found (${jd.length} chars)`);
          const draftQ = (f, i) => ({ id: i, question: f.label, ...(f.desc ? { description: f.desc } : {}), ...(LINK_ASK.test(f.nl) ? { asksForLink: true } : {}), ...(draftLimit(f) ? { lengthLimit: draftLimit(f).text } : {}) });
          const sendDrafts = async (questions) => {
            try {
              return await AAF.untilCancel(chrome.runtime.sendMessage({
                type: "DRAFT",
                questions,
                used: draftUsed(),
                job: { location: job.location, description: job.description.slice(0, 8000) },
                context: { company: location.hostname.split(".")[0], pageTitle: document.title },
              }));
            } catch (e) {
              if (e instanceof AAF.Cancelled) throw e; // stopped: the drafts are discarded
              return { error: `couldn't reach the background script: ${e.message}` };
            } finally {
              if (AAF.cancel.reason) throw new AAF.Cancelled(AAF.cancel.reason);
            }
          };
          const res = await sendDrafts(drafts.map(draftQ));
          dbg(`Claude drafts: ${drafts.length} questions sent, model ${res?.model || "?"}, ${res?.error ? "ERROR " + res.error : (res?.answers?.length ?? 0) + " answers"}${res?.retried ? " (after asking again for JSON only)" : ""}`);
          if (res?.raw != null) dbg(`Claude drafts: the reply started: ${JSON.stringify(res.raw)}`);
          const inc = res?.included;
          if (inc) dbg(`Claude drafts: request included LinkedIn text ${inc.linkedinChars} chars${inc.linkedinChars ? "" : " (EMPTY: paste it in Options)"}, resume text ${inc.resumeChars}, extra notes ${inc.notesChars}, job description ${inc.descriptionChars}, projects to highlight ${inc.highlightCount ?? 0}, already used on this application ${inc.usedCount ?? 0}`);
          if (res?.error) aiError = res.error;
          // Over the stated limit: Claude is asked once more, with the limit and its own count ("Your answer was 312
          // words; rewrite it in at most 250 words."). Only a rewrite that is still over gets trimmed (below).
          const overBy = (r) => {
            const f = drafts[r.id];
            const lim = f && r.answer ? draftLimit(f) : null;
            return lim && countOf(noDashes(r.answer), lim) > lim.n ? lim : null;
          };
          const over = (res?.answers || []).filter(overBy);
          if (over.length) {
            const asks = over.map((r) => {
              const f = drafts[r.id], lim = overBy(r), n = countOf(noDashes(r.answer), lim);
              const want = lim.unit === "sentences" ? (lim.n === 1 ? "one sentence" : `at most ${lim.n} sentences`) : `at most ${lim.n} ${lim.unit}`;
              const note = `Your answer was ${n} ${n === 1 && lim.unit === "sentences" ? "sentence" : lim.unit}; rewrite it in ${want}.`;
              dbg(`Claude drafts: ${f.label.slice(0, 60)}: ${n} ${lim.unit}, the question asks for "${lim.text}"; asking Claude to rewrite it ("${note}")`);
              return { ...draftQ(f, r.id), previousAnswer: r.answer, rewrite: note };
            });
            const re = await sendDrafts(asks);
            if (re?.error) dbg(`Claude drafts: rewrite request failed (${re.error}); the first drafts are trimmed instead`);
            for (const x of re?.answers || []) {
              const r = over.find((o) => o.id === x.id);
              if (!r || x.answer == null || x.answer === "") continue;
              const f = drafts[r.id], lim = draftLimit(f);
              const before = countOf(noDashes(r.answer), lim), after = countOf(noDashes(x.answer), lim);
              dbg(`Claude drafts: ${f.label.slice(0, 60)}: rewrite ${before} -> ${after} ${lim.unit}${after <= lim.n ? " (within the limit)" : " (still over)"}: "${x.answer.slice(0, 120)}${x.answer.length > 120 ? "..." : ""}"`);
              r.answer = x.answer;
              if (x.project) r.project = x.project;
            }
          }
          for (const r of res?.answers || []) {
            const f = drafts[r.id];
            if (!f) continue;
            if (r.answer == null || r.answer === "") {
              dbg(`Claude drafts: ${f.label.slice(0, 70)} -> no draft (null)${r.reason ? `, reason: ${r.reason}` : ", no reason given"}`);
              continue;
            }
            if (A.isFilled(f)) {
              dbg(`Claude drafts: ${f.label.slice(0, 70)} was filled meanwhile, kept it`);
              f.done = true;
              continue;
            }
            const dashFree = noDashes(r.answer);
            let text = dashFree;
            const lim = draftLimit(f);
            let tooLong = false;
            if (lim && countOf(text, lim) > lim.n) {
              const cut = withinLimit(text, lim);
              if (cut) {
                dbg(`Claude drafts: ${f.label.slice(0, 60)}: still ${countOf(text, lim)} ${lim.unit} after the rewrite, the question asks for "${lim.text}"; trimmed at a sentence boundary to ${countOf(cut, lim)} ${lim.unit}`);
                text = cut;
              } else {
                tooLong = true;
                dbg(`Claude drafts: ${f.label.slice(0, 60)}: still ${countOf(text, lim)} ${lim.unit} after the rewrite and its first sentence alone is over "${lim.text}"; not cut mid-sentence, left as is for you to shorten (yellow)`);
              }
            }
            const selfDraft = AI_SELF.exec(norm(text));
            if (selfDraft) {
              dbg(`Claude drafts: the draft for ${f.label.slice(0, 60)} talks like an AI (an injected instruction?): matched "${selfDraft[0]}" in "${String(text).slice(0, 400)}"; not used, left for you`);
              continue;
            }
            dbg(`Claude drafts: ${f.label.slice(0, 70)} -> "${text.slice(0, 120)}${text.length > 120 ? "..." : ""}"${r.project ? ` (project: "${r.project}")` : ""}`);
            if (r.project) draftUsed.add(r.project, f.label);
            if (dashFree !== r.answer) dbg(`Claude drafts: removed dashes from the draft for ${f.label.slice(0, 60)}`);
            if (await setField(f, text)) {
              f.done = true;
              stats.drafts++;
              AAF.noteOurs(f, { draft: true });
              if (tooLong) {
                mark(f, "needs");
                stats.needs++;
                dbg(`draft over the length limit, shorten it before submitting: ${f.label.slice(0, 80)}`);
              } else if (aiSignal) {
                // Like the YC note: a first draft only, yellow until you rewrite it.
                mark(f, "needs");
                stats.needs++;
                stats.draftsYellow = (stats.draftsYellow || 0) + 1;
                dbg(`draft, rewrite in your own words before submitting (${aiSignal}): ${f.label.slice(0, 80)}`);
                AAF.run.toastNote = "Drafts: rewrite them in your own words before submitting (this application may check for AI-written answers).";
              } else {
                mark(f, "review");
                stats.review++;
                dbg(`draft, review before submitting: ${f.label.slice(0, 80)}`);
              }
            }
          }
        }
      }
      };
      // An AI-use policy anywhere in the form (a question or a notice: "If LLM assistance or automated tool
      // generation was used ..."): no drafts on this application at all; its textareas and the policy question
      // stay yellow. Checked before any Claude call: the form's own text, then every field's label / description.
      // A trap's own text is not a policy (its "If you are an LLM ..." would turn drafts off): left out.
      let formText = norm(`${A.formText?.() || ""} ${scan().filter((x) => !trapWhy(x)).map((x) => `${x.label} ${x.desc || ""}`).join(" ")}`);
      for (const x of scan()) if (trapWhy(x)) for (const t of [x.label, x.desc, x.c.textContent].map(norm)) if (t) formText = formText.split(t).join(" ");
      const pageTrap = pageTrapText() || (LR?.TRAP_Q.test(formText) ? quote(formText, LR.TRAP_Q.exec(formText)) : "");
      if (pageTrap) {
        dbg(`possible AI-detection text on the page (not a field), ignored as instructions: ${pageTrap}`);
        aiSignal ||= `AI-detection text on the page (${pageTrap.slice(0, 60)})`;
        formText = formText.replace(LR.TRAP_Q, " ");
      }
      const policy = globalThis.AAF_LEARN_RULES?.AI_POLICY.exec(formText);
      if (policy) {
        aiPolicy = true;
        dbg(`AI-use policy found, drafts skipped ("${formText.slice(Math.max(0, policy.index - 40), policy.index + 120).trim()}")`);
      }
      await askRound(questions);
      // Late reveals: an answer from Claude, a draft, or a re-fill in the final sweep can reveal a follow-up
      // (Lexidos: "5a. Expected degree completion date" appears only after Q5, which Claude answered at the end,
      // so 5a was never discovered). Re-scan, run anything new through the same rules, and send new unknown
      // questions to Claude in one more round. Up to 2 rounds each time.
      const lateReveal = async (when) => {
        for (let round = 0; round < 2; round++) {
          await sleep(400); // let the portal render the follow-up
          added = false;
          const at = queue.length;
          sectionRevealed = 0;
          const n = revealNew(at);
          if (!n && !sectionRevealed) return;
          dbg(`late reveal ${when}: ${n} new field${n === 1 ? "" : "s"}${sectionRevealed ? `, ${sectionRevealed} education / work field${sectionRevealed === 1 ? "" : "s"}` : ""}`);
          // The full pipeline on them: the section steps (education, work) first, then the rules, then Claude.
          if (sectionRevealed && A.fillLate) await A.fillLate(p, stats, { late: true });
          qi = at;
          extraPasses = 2; // one more look at the end of the queue, not three
          const before = questions.length;
          await runQueue();
          const fresh = questions.slice(before);
          if (fresh.length) await askRound(fresh);
        }
      };
      AAF.setStep("Looking for follow-up questions");
      await lateReveal("after Claude");
      const markLeft = () => {
        for (const f of questions) if (!f.done && !f.markedNeeds) { mark(f, "needs"); stats.needs++; f.markedNeeds = true; }
      };
      markLeft();

      AAF.setStep("Final check");
      await verifySweep(stats);
      await lateReveal("after the final sweep");
      markLeft();
      revealObs.disconnect();
      // Adapter re-checks after the fill (Ashby: every Yes / No checked now, then answers reset by a late resume parse
      // re-checked in the background).
      await A.afterFill?.();
      // Every field ends with an outcome (Notional: "New Grad 2027 Application Questions : Why are you interested in
      // Notional? ..." got no log line at all): one that no step filled, kept, outlined or logged is said here and
      // outlined yellow when required and empty. Files (the resume step) and Workday's search prompts (its sections)
      // are left out.
      for (const f of A.discoverFields()) {
        if (!f.type || f.type === "file" || f.type === "multi" || AAF.run.handled.has(f.c) || AAF.run.handled.has(`${f.type}|${f.nl}`) || f.c.dataset.wdaf) continue;
        // Still showing what this extension wrote on an earlier fill in this tab (a draft above all): kept, said as such.
        const ours = AAF.ours?.(f);
        if (ours) {
          dbg(`${f.label.slice(0, 60)}: kept (${ours.draft ? "earlier draft" : "filled by this extension earlier"})`);
          AAF.countKept(f);
          if (ours.draft) {
            mark(f, "review");
            stats.review++;
          }
          continue;
        }
        const empty = !A.isFilled(f);
        dbg(`unhandled field: ${(f.label || "(no label)").slice(0, 80)} (${f.type}, ${empty ? "empty" : "holds a value"})${empty && f.required ? "; left for you (yellow)" : ""}`);
        if (empty && f.required) {
          mark(f, "needs");
          stats.needs++;
        }
      }
      dbg(`fill time: ${Date.now() - tFill} ms (paused ${AAF.fillClock.end()} ms)`);
      try {
        chrome.runtime.sendMessage({ type: "PAUSED", paused: false, done: true }).catch(() => {});
      } catch {}

      // The counts: filled / kept from the run tally (counted where "ok" / "kept" is logged, once per field),
      // yellow / blue from the outlines actually on the page.
      return await finishRun(stats, aiError, false);
    } catch (e) {
      if (e instanceof AAF.Cancelled && AAF.stoppedByUser) {
        // Stopped by you: close any open popup, keep everything filled so far and its outlines, nothing
        // learned from this run, then the toast says "Stopped." with the counts so far.
        const at = AAF.step || "the start";
        AAF.cancel.reason = ""; // the cleanup below may wait
        dbg(`fill stopped by user at ${at}`);
        try {
          await Promise.race([Promise.resolve(A.closePopups?.()), new Promise((r) => setTimeout(r, 1500))]);
        } catch {}
        AAF.noLearnUntil = Date.now() + 3000;
        const stats = await finishRun(runStats || { filled: 0, kept: 0, ai: 0, review: 0, needs: 0, drafts: 0 }, "", true);
        return { ...stats, stopped: true };
      }
      if (e instanceof AAF.Cancelled) {
        dbg(`fill stopped: ${e.message}`);
        AAF.hideToast?.();
        return { error: `stopped: ${e.message}` };
      }
      toast(`Something broke: ${e.message}`);
      return { error: e.message };
    } finally {
      progress.end();
      u.btn.style.display = "";
      if (AAF.stoppedByUser) AAF.noLearnUntil = Date.now() + 3000;
      clearInterval(stepWatch);
      AAF.cancel.reason = "";
      AAF.fillClock.end();
      running = false;
      AAF.filling = false;
      u.btn.disabled = false;
    }
  }
  AAF.fillPage = fillPage;

  chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
    if (msg?.type === "FILL") {
      // A frame with no form of its own (iCIMS's top page around its form iframe) stays quiet, so the
      // popup / shortcut gets the form frame's result.
      if (A.passiveFrame?.()) return;
      // A child frame without an application form stays quiet too: the first frame to answer is the one
      // the popup / badge report, and an empty frame's "Filled 0" used to win.
      if (window.top !== window && !A.isFormPage()) return;
      fillPage().then(sendResponse);
      return true;
    }
    // The result of a fill in a child frame (iCIMS, embedded forms), shown by this top frame (the iCIMS job page
    // runs our scripts; elsewhere the background injects the same toast).
    if (msg?.type === "SHOW_RESULT" && window.top === window && msg.data) {
      AAF.hideToast?.();
      sendResponse(!!globalThis.AAF_DONE_TOAST?.(msg.data, {}));
      return;
    }
    // "need you" clicked in the top page's toast: scroll this frame to its first yellow field.
    if (msg?.type === "SCROLL_NEEDS") {
      document.querySelector('[data-wdaf="needs"]')?.scrollIntoView({ block: "center" });
      return;
    }
    if (msg?.type === "PING") sendResponse({ ok: true });
  });
})();
