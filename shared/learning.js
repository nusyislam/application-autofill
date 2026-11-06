// Application Autofill: shared settings/profile state, learned answers, and the sensitive-field and
// application-page rules. The adapter supplies the DOM wiring (adapter.watchUserAnswers calls learn).

(() => {
  const AAF = globalThis.AAF;
  if (!AAF.once("learning")) return;
  const { norm, visible, profileValue, ATTEST, unmark } = AAF;

  // -------------------------------------------------------------- learning
  // Live state, read by every file through AAF.state (loadState replaces the values in place).
  const state = { profile: {}, settings: { useAI: true, learn: true, drafts: true, threshold: 0.75 } };
  async function loadState() {
    if (!AAF.alive()) return;
    const s = await chrome.storage.local.get(["profile", "settings"]);
    state.profile = s.profile || {};
    state.settings = { ...state.settings, ...(s.settings || {}) };
  }
  chrome.storage.onChanged.addListener(loadState);
  loadState();

  const tokens = (s) => new Set(norm(s).split(" ").filter((w) => w.length > 2));
  function findLearned(label, list) {
    const n = norm(label);
    let hit = list.find((x) => norm(x.q) === n);
    if (hit) return hit;
    const a = tokens(label);
    let best = null;
    let bestJ = 0;
    for (const x of list) {
      const b = tokens(x.q);
      let inter = 0;
      a.forEach((t) => b.has(t) && inter++);
      const j = inter / (a.size + b.size - inter || 1);
      if (j > bestJ) {
        bestJ = j;
        best = x;
      }
    }
    return bestJ >= 0.85 ? best : null;
  }

  // What may be learned lives in shared/learnrules.js (also used by the background purge and Options).
  const RULES = globalThis.AAF_LEARN_RULES;
  // Credentials and identity numbers: never learned, never sent to Claude, never filled.
  const SENSITIVE = RULES.SENSITIVE;
  const isSecretInput = (el) => el?.type === "password" || /current-password|new-password/.test(el?.getAttribute?.("autocomplete") || "");
  // The application's company names are taken out first ("2Password", "LastPass": a name, not a field).
  const isSensitive = (f) => {
    let l = ` ${f.nl} `;
    for (const c of pageCompanies()) l = l.split(` ${c} `).join(" ");
    if (isSecretInput(f.ctrl)) return true;
    if (!SENSITIVE.test(l)) return false;
    return !(RULES.essayPrompt(l.trim(), f.type) && !RULES.ASKS_SECRET.test(l));
  };
  // "When are you available...", start dates. Not "Are you available to work on-site?".
  const AVAILABILITY_Q = RULES.AVAILABILITY_Q;
  // A learned entry that must never be used (or a question that must never be learned): its category.
  const learnBlock = (q, type, a) => RULES.blockedCategory(q, type, a);
  // Learning only happens inside the application flow, never on sign-in / create-account pages.
  // The adapter says what "inside the application flow" looks like on its portal.
  function onApplicationPage() {
    if (document.querySelector('input[type="password"], input[autocomplete="current-password"], input[autocomplete="new-password"]')) return false;
    if (jobSearchPage()) return false;
    const heads = [...document.querySelectorAll("h1,h2,h3,[role='heading']")].filter(visible).map((h) => norm(h.innerText)).join(" | ");
    if (/sign ?in|log ?in|create (an )?account|forgot password|verify (your )?(email|account)/.test(heads)) return false;
    return AAF.adapter.isApplicationFlow();
  }
  // A job search / listing page (iCIMS /jobs/search, ?searchKeyword=, "Search Jobs" headings): its filters
  // ("Category", "Location") are never application answers.
  function jobSearchPage() {
    const path = location.pathname || "";
    if (/\/(jobs\/)?search\b|\/jobs\/intro\b|\/jobs\/?$|\/job-search\b|\/careers\/?$/i.test(path)) return true;
    if (/[?&](searchKeyword|searchCategory|searchLocation|searchRelation|keywords?|ss)=/i.test(location.search || "")) return true;
    const heads = [...document.querySelectorAll("h1, [role='heading'][aria-level='1']")].filter(visible).map((h) => norm(h.innerText)).join(" | ");
    return /\b(search (jobs|openings|positions|results)|job search|find (a )?jobs?|job listings|current openings|open positions)\b/.test(heads);
  }

  // The company this application is for, as normalized names: the title's "... at Acme", the host
  // (nvexa.wd5.myworkdayjobs.com, careers-hmsy.icims.com) and the board path (jobs.lever.co/palisade,
  // job-boards.greenhouse.io/stripe). A learned question that names one of them is company-specific.
  const GENERIC_HOST = /^(www|jobs?|careers?|boards?|job-boards|apply|wd\d+|myworkdayjobs|myworkday|myworkdaysite|icims|lever|greenhouse|ashbyhq|gem|eu|io|com|co|net|org)$/;
  function pageCompanies() {
    const out = new Set();
    const t = (document.title || "").match(/\bat ([A-Z][\w&.' -]{1,40}?)(?:\s*[-|–(:]|\s*$)/);
    if (t) out.add(t[1]);
    for (const h of (location.hostname || "").split(".")) {
      const x = h.replace(/^careers?-|-careers?$/i, "");
      if (x.length >= 3 && !GENERIC_HOST.test(x)) out.add(x);
    }
    const seg = (location.pathname || "").split("/").filter(Boolean)[0];
    if (seg && /(lever\.co|ashbyhq\.com|gem\.com|greenhouse\.io)$/.test(location.hostname || "") && !/^(embed|jobs?|job_app|apply)$/.test(seg)) out.add(seg);
    return [...out].map(norm).filter((x) => x.length >= 3);
  }
  // The company a question names (one of this application's companies, as a whole phrase), or "".
  function companyIn(label) {
    const l = ` ${norm(label)} `;
    return pageCompanies().find((c) => l.includes(` ${c} `)) || "";
  }
  // Relationship questions ("any personal or familial relationships with current Sherwood employees?", "Do you know
  // anyone who works at SageWell?"): always stored for one company, Yes or No (learned-answers review; they used to be
  // stored once as a general No with the name taken out and reused everywhere).
  const isRelationship = (q) => RULES.RELATIONSHIP_Q.test(norm(q));
  // The label with company names replaced by "[company]": this application's names, then capitalized
  // words that don't start a sentence ("Sherwood Markets, Inc." -> "[company]").
  // The company names to take out: this application's (title, site, board path) plus their known aliases, and
  // any given (an older entry's own company).
  const companyNames = (extra = []) => {
    const base = [...pageCompanies(), ...extra].filter(Boolean);
    return [...base, ...base.flatMap((c) => AAF.companyAliases?.(c) || [])];
  };
  function genericLabel(label, extra = []) {
    return RULES.companyOut(label, companyNames(extra));
  }
  // Product usage ("Have you used Sherwood?", "Are you a Sherwood customer?"): company-specific.
  function isProductUsage(f) {
    const n = f.nl;
    if (!RULES.PRODUCT_Q.test(n)) return false;
    if (/^(are|were) you\b/.test(n) && /\b(customer|user)s?\b/.test(n)) return true;
    return !!companyIn(f.label) || /\bour (app|apps|product|products|platform|service|services|tools?)\b/.test(n);
  }
  // "Have you previously applied to X?": your answer, for that company only.
  const isApplied = (label) => RULES.APPLIED_BEFORE.test(norm(label)) && !/^if\b/.test(norm(label));
  // Questions that never go to Claude or drafts (yellow until you answer; some are learnable).
  function noClaudeWhy(f) {
    if (RULES.eeoAsks(f.nl, f.type)) return "EEO / demographic";
    // The AI-use / verification question itself ("If LLM assistance ... was used, ..."): yours.
    if (RULES.AI_POLICY.test(`${f.nl} ${f.desc || ""}`)) return "AI-use policy";
    // A bare filter label ("Category", "Location") on a job search page isn't a question for Claude.
    if (RULES.GENERIC_LABEL.test(f.nl.trim())) return "search filter";
    if (/\b(e ?signature|electronic signature|signature)\b/.test(f.nl) && !/\bdate\b/.test(f.nl)) return "e-signature";
    if (isRelationship(f.label)) return "relationships";
    if (isProductUsage(f)) return "product usage";
    if (isApplied(f.label)) return "previous application (applying is not employment)";
    // School / Degree / Major / Field of study / GPA / Graduation date: the education step fills them; one that reaches
    // here (no education step on this portal, or it couldn't decide) is yours, never the classifier or Claude (Steadfast:
    // Degree and Major were classified "education status" and left yellow by the graduation rule).
    if (RULES.eduFixedLabel(f.label)) return "education field (the education step fills it; never the classifier or Claude)";
    if (RULES.countQualifier(f.label)) return "employer count with a qualifier (not computed; your answer for this wording)";
    // Experience level ("experience with generative AI / AWS", "How familiar are you with React?"): a
    // self-assessment (Empirica: Claude answered them). Choice fields and short text; an open textarea can
    // still be drafted. Your own learned answer is reused (checked before this).
    // A plain yes / no experience question is checked against your materials instead (main.js `experienceRound`).
    if (["radio", "dropdown", "checkgroup"].includes(f.type) && RULES.experienceYesNo(f.nl)) return "";
    if (["radio", "dropdown", "checkgroup", "text"].includes(f.type) && RULES.EXPERIENCE_Q.test(f.nl)) return "experience level (a self-assessment)";
    return "";
  }
  // Is a company-scoped entry's company this application's (learned-answers review: every question naming a company is
  // scoped to it)? The page's names (title, host, board path), compared as names (spacing, aliases), or the page's own text
  // naming it (a Workday host like "ghr.wd1" doesn't say "Bank of Fictionland"; the page does).
  function companyHere(c) {
    const n = norm(c);
    if (!n) return true;
    const flat = (x) => x.replace(/\s+/g, "");
    if (pageCompanies().some((pc) => pc === n || flat(pc) === flat(n) || !!AAF.sameCompany?.(pc, n))) return true;
    return ` ${norm(document.title)} `.includes(` ${n} `);
  }
  // May this learned entry be reused on this page? Not blocked (by a rule, or a blocking category you picked in Options),
  // approved (or review is off), not missing its company name, and general or for this company.
  function usable(x) {
    if (learnBlock(x.q, x.type, x.a)) return false;
    if (RULES.entryCategory(x).blocked) return false;
    if (RULES.garbledCompany(x)) return false; // "garbled, re-check" in Options
    if (x.pending && !state.settings.learnNoReview) return false;
    // An older general relationships entry whose company name was taken out and not kept: nothing to scope it to.
    if (!x.company && /\[company\]/.test(x.q || "")) return false;
    const company = scopeOf(x);
    if (!company && isApplied(x.q || "")) return false; // a previous application is always for one company
    if (company && !companyHere(company) && !` ${norm(document.body?.innerText || "")} `.includes(` ${norm(company)} `)) return false;
    return true;
  }
  // The company an entry is for: its own, or (an older unscoped entry, before the background backfill has run) the one
  // its question names.
  // A mangled stored scope ("bank of", "official") is read as repaired at once (the purge stores it on the next start).
  const scopeOf = (x) => { const f = RULES.scopeFix(x); return f ? f.to : x.company || RULES.backfillScope(x)?.company || ""; };
  // findLearned, scoped: an entry for a company is used only when this page is that company's application or the
  // question itself names it (no more general relationship answers reused at other companies).
  function findLearnedFor(f, list) {
    const named = RULES.companiesIn(f.label);
    const ok = (x) => { const c = scopeOf(x); return !c || companyHere(c) || named.includes(norm(c)); };
    // An employer count is reused only for the same qualifier ("since graduating" never takes the answer to "since you
    // graduated your first undergraduate degree"; the plain count is computed, never learned).
    const qual = RULES.COUNT_EMPLOYERS.test(norm(f.label)) ? RULES.countQualifier(f.label) : null;
    const sameQual = (x) => qual === null || (!!qual && RULES.COUNT_EMPLOYERS.test(norm(x.q || "")) && RULES.countQualifier(x.q) === qual);
    return findLearned(f.label, (list || []).filter((x) => ok(x) && sameQual(x)));
  }

  // Classify questions for learn(), in one batch per page: questions answered within 1.5 s of each other go in
  // one CLASSIFY_LEARN call (the background caches by question). Resolves to the category, "general", or ""
  // when the classifier isn't available (Claude off, no key, an error): then the patterns alone decide, logged
  // once per page.
  const classifyWait = [];
  let classifyTimer = null;
  let classifierDown = "";
  function classifyQueued(q) {
    return new Promise((resolve) => {
      classifyWait.push({ q, resolve });
      clearTimeout(classifyTimer);
      classifyTimer = setTimeout(flushClassify, 1500);
    });
  }
  async function flushClassify() {
    const batch = classifyWait.splice(0);
    if (!batch.length) return;
    let res;
    try {
      res = await chrome.runtime.sendMessage({ type: "CLASSIFY_LEARN", questions: batch.map((x) => x.q) });
    } catch (e) {
      res = { error: e.message };
    }
    if (!res?.categories) {
      const why = res?.error || "no answer";
      if (classifierDown !== why) AAF.dbg(/rejected the request/.test(why) ? `learning: the question classifier failed: ERROR ${why}; the patterns alone decide` : `learning: the question classifier is unavailable (${why}); the patterns alone decide`);
      classifierDown = why;
    }
    for (const x of batch) x.resolve(res?.categories?.[String(x.q).trim()] || "");
  }

  async function learn(f, value) {
    // Orphaned after an extension reload: chrome.storage would throw "Extension context invalidated".
    if (!AAF.alive()) return;
    if (!state.settings.learn || !value || f.nl.length < 8) return;
    // Never while a fill runs (Chrome marks the change event from our own label click as trusted), nor just
    // after a stopped one (its last clicks' events can arrive late).
    if (AAF.filling || Date.now() < (AAF.noLearnUntil || 0)) return;
    // Never learned: sensitive fields, dates (a change event only sees one box, "2027"), compensation,
    // notice periods, file uploads (never a file path), location / attendance, availability, fixed answers
    // (shared/learnrules.js). Availability answers go stale ("When are you available?" was once learned as
    // 10/21/2026).
    if (isSecretInput(f.ctrl) || isSensitive(f)) {
      AAF.dbg(`not learned (sensitive): ${f.label.slice(0, 80)}`);
      return;
    }
    if (!onApplicationPage()) {
      if (!AAF.filling && jobSearchPage()) AAF.dbg(`not learned (job search page): ${f.label.slice(0, 80)}`);
      return;
    }
    // A bare filter label ("Category", "Location", "Department", "Keyword"): never an application answer.
    if (RULES.GENERIC_LABEL.test(f.nl.trim())) {
      if (!AAF.filling) AAF.dbg(`not learned (search filter): ${f.label.slice(0, 80)}`);
      return;
    }
    // Open-ended free text (a textarea, or an answer over 150 characters): a draft for each job, never learned.
    if (f.type === "textarea" || String(value).trim().length > 150) {
      AAF.dbg(`not learned (free-text answer): ${f.label.slice(0, 80)}`);
      return;
    }
    // A label that only says to pick ("Please select one of the below options"): the chosen option's own text
    // is the question when it's a full statement; otherwise there's nothing to learn.
    let qText = f.label;
    if (RULES.GENERIC_PROMPT.test(f.nl.trim())) {
      if (String(value).trim().length >= 25) qText = String(value).trim();
      else {
        AAF.dbg(`not learned (generic label): ${f.label.slice(0, 80)}`);
        return;
      }
    }
    // How / where did you hear: only Options answers it (said even though a rule fills it). Not logged while a
    // fill runs: Chrome marks the change event from our own label click as trusted.
    if (learnBlock(qText, f.type, value) === "source") {
      if (!AAF.filling) AAF.dbg(`not learned (source): ${f.label.slice(0, 80)}`);
      return;
    }
    const pv = profileValue(f, state.profile);
    // A rule answers it (profile, fixed answer, office rule, ...): nothing to learn. Attestations may only
    // ever be filled from an exact learned answer, so those are learned.
    if (AAF.adapter.isSectionField(f) || (pv !== undefined && pv !== ATTEST && pv !== AAF.NEEDS)) return;
    const cat = learnBlock(qText, f.type, value);
    if (cat) {
      AAF.dbg(`not learned (${cat}): ${qText.slice(0, 80)}`);
      return;
    }
    // A rule leaves it for you every time (e-signature, office attendance elsewhere, ...): never learned.
    if (pv === AAF.NEEDS) return;
    if (f.c.dataset.wdaf) unmark(f.c);
    // The backstop: the question is classified (Haiku, background.js) before it's saved; answers given close
    // together on a page go in one batch.
    const kind = await classifyQueued(qText);
    if (kind && kind !== "general") {
      AAF.dbg(`not learned (${kind}, classified): ${qText.slice(0, 80)}`);
      return;
    }
    let learned;
    try {
      ({ learned = [] } = await chrome.storage.local.get("learned"));
    } catch {
      return; // the context went away mid-call
    }
    // New answers wait in "Pending review" (Options) unless "Reuse learned answers without review" is on; the
    // same answer to an approved entry stays approved.
    // Every question that names a company is stored for that company only (learned-answers review): this application's
    // company when the question names it, else the company it names (shared/learnrules.js `companiesIn`); relationship
    // and product-usage questions always (this application's company when none is named), Yes or No alike.
    const q = qText;
    const rel = isRelationship(qText);
    let company = companyIn(qText) || RULES.companiesIn(qText)[0] || "";
    if ((rel || isProductUsage(f) || isApplied(qText)) && !company) company = pageCompanies()[0] || "";
    const n = norm(q);
    const i = learned.findIndex((x) => norm(x.q) === n);
    const same = i >= 0 && learned[i].a === value && !learned[i].pending;
    const entry = { q, a: value, type: f.type, updated: Date.now(), ...(kind ? { classified: kind } : {}), ...(company ? { company } : {}), ...(same || state.settings.learnNoReview ? {} : { pending: true }) };
    AAF.dbg(`learned${company ? ` (only for ${company})` : ""}${entry.pending ? ", pending your review in Options" : ""}: ${f.label.slice(0, 80)}`);
    if (i >= 0) learned[i] = entry;
    else learned.push(entry);
    try {
      await chrome.storage.local.set({ learned });
    } catch {}
  }

  Object.assign(AAF, { state, loadState, findLearned, learnedScope: scopeOf, learnBlock, pageCompanies, companyIn, usableLearned: usable, jobSearchPage, findLearnedFor, genericLabel, isProductUsage, noClaudeWhy, isRelationshipQ: isRelationship, SENSITIVE, AVAILABILITY_Q, isSecretInput, isSensitive, onApplicationPage, learn });
})();
