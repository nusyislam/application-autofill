// Application Autofill: shared profile mapping. Turns a described field ({ c, id, label, nl, nid,
// type, ctrl, required }, produced by the adapter) into a value from the saved profile: contact
// fields, fixed answers, the government attestation guard, named-employer questions, EEO,
// expected graduation.

(() => {
  const AAF = globalThis.AAF;
  if (!AAF.once("profile")) return;
  const { norm, visible, dbg, show, SKIP, parseDate, splitAlts, hasPhrase, hasPosPhrase } = AAF;
  // Code defaults used when a setting is blank. Keep in sync with DEFAULT_PROFILE in options.js.
  const DEFAULT_PHONE_TYPES = "Mobile | Cell | Cellular | Cell Phone | Mobile Phone | Home Cellular | Personal Cell | Personal Mobile";
  // Application location and office locations have no default (Options "Application location" / "Office locations"):
  // blank = the location / office-preference questions are left for you, never sent to Claude; office attendance is
  // then decided only by where you live. Keep in sync with options.js.
  const DEFAULT_LOCATION = { search: "", matches: "" };
  const DEFAULT_OFFICE_METRO = "";
  // The accepted application locations: the list, else the search term; "" when neither is set.
  const appLocation = (p) => {
    const search = p.applicationLocation?.search?.trim() || DEFAULT_LOCATION.search;
    const list = p.applicationLocation?.matches?.trim() || search || DEFAULT_LOCATION.matches;
    return { search: search || splitAlts(list)[0] || "", list };
  };
  // Returned by a rule that must leave the field yellow (no learned answer, no Claude).
  const NEEDS = Symbol("needs");
  // Default school search keyword: the school name without generic words ("Lakeview University" -> "Lakeview").
  // Keep in sync with options.js.
  const schoolKeyword = (school) =>
    String(school || "").replace(/\b(the|university|college|of|at|suny|cuny|state|institute|school)\b/gi, " ").replace(/[()]/g, " ").replace(/\s+/g, " ").trim() || String(school || "");

  // ------------------------------------------------------ profile mapping
  function today() {
    // A fixed "today" for the headless fixtures (a page can't set it in the extension's isolated world).
    const d = globalThis.AAF_TEST_TODAY ? new Date(globalThis.AAF_TEST_TODAY) : new Date();
    return { month: d.getMonth() + 1, day: d.getDate(), year: d.getFullYear() };
  }

  // ---- Class year ("What year are you currently in?" [Sophomore, Junior, Senior, 1st-year Master's, 2nd-year Master's];
  // Ridgeway: classified "education status" and left yellow): from the expected graduation date and the degree level. The
  // academic year runs August - July; graduating in this academic year = the final year (Senior / 4th year / Final year;
  // a master's: 2nd-year Master's), one year out = Junior (1st-year Master's), and so on; "Class of <year>" / "Graduating
  // in <year>" by the graduation year. "Rising <level>" options only from May to August. Returns null (no expected
  // graduation date), { none } (graduated, too far out) or { what, left, choose }.
  function classYearChoice(p) {
    const g = parseDate(p.expectedGraduation);
    if (!g.year) return null;
    const t = today();
    const ay = (y, m) => (m >= 8 ? y : y - 1); // the academic year a month falls in (by its starting year)
    const left = ay(+g.year, +g.month || 5) - ay(t.year, t.month);
    const entry = (p.education || [])[0] || {};
    const deg = norm(String(entry.degreeOptions || entry.degree || "").split("\n")[0]);
    const master = /\b(master|masters|m s|ms|msc|meng|m eng|mba|ma)\b/.test(deg) && !/\bbachelor/.test(deg);
    const BACH = [
      ["Senior", "4th year", "Fourth year", "Year 4", "Final year", "Last year"],
      ["Junior", "3rd year", "Third year", "Year 3"],
      ["Sophomore", "2nd year", "Second year", "Year 2"],
      ["Freshman", "1st year", "First year", "Year 1"],
    ];
    const MAST = [
      ["2nd-year Master's", "Second-year Master's", "2nd year Master's", "Master's Year 2", "Graduate Year 2", "Final year"],
      ["1st-year Master's", "First-year Master's", "1st year Master's", "Master's Year 1", "Graduate Year 1"],
    ];
    const levels = master ? MAST : BACH;
    if (left < 0 || left >= levels.length) return { none: left < 0 ? "you have graduated" : "more than " + levels.length + " years out", left };
    const rising = t.month >= 5 && t.month <= 8;
    const what = (master ? "master's" : "bachelor's") + ", graduating " + (g.month ? MONTH_NAMES[+g.month - 1] + " " : "") + g.year + ", " +
      (left === 0 ? "this academic year (final year)" : left + " academic year" + (left > 1 ? "s" : "") + " out");
    return {
      what,
      left,
      choose: (texts) => {
        const opts = (texts || []).map((o) => ({ o, n: norm(o) }));
        const isMasterOpt = (n) => /\bmaster|\bgraduate\b|\bgrad\b|\bms\b|\bmba\b/.test(n);
        const fits = (n) => !/\brising\b/.test(n) && (master ? isMasterOpt(n) || /\bfinal year\b/.test(n) : !isMasterOpt(n));
        // In May - August, "Rising Senior" = the year about to start (May - July: the next one; August: this one).
        if (rising) {
          const next = t.month === 8 ? left : left - 1;
          const word = next >= 0 && next < levels.length ? levels[next][0] : "";
          const hit = word && opts.find(({ n }) => /\brising\b/.test(n) && hasPhrase(n, norm(word)));
          if (hit) {
            dbg("class year: " + MONTH_NAMES[t.month - 1] + ", between May and August: \"" + hit.o + "\"");
            return hit.o;
          }
        }
        for (const w of levels[left]) {
          const hit = opts.find(({ n }) => fits(n) && (n === norm(w) || hasPhrase(n, norm(w))));
          if (hit) return hit.o;
        }
        const y = String(g.year);
        for (const w of ["Class of " + y, "Graduating in " + y, "Graduating " + y, "Expected " + y]) {
          const hit = opts.find(({ n }) => n === norm(w) || hasPhrase(n, norm(w)));
          if (hit) return hit.o;
        }
        return null;
      },
    };
  }
  const CLASS_YEAR_Q = /^(what|which) (year|class|grade) (are you|of (school|college|university|study) are you) (currently )?in\b|^(what|which) (year|class) (of (school|college|university|study) )?are you\b|^(what is your )?(current )?(year (in|of) (school|college|university|study|your (degree|program))|class (standing|year|level)|academic (standing|year|level|class)|year of study|school year|grade level)$|^(which|what) class are you in\b|^current year (in|of) (school|college|university|study)\b/;
  // Age from Options "Birth month / year" (MM/YYYY), the 1st of the month assumed: one age, or, in the birth
  // month itself (the real birthday may still be ahead), both possible ages. null = not set / malformed.
  function ageCandidates(birth) {
    const m = String(birth || "").trim().match(/^(\d{1,2})\/(\d{4})$/);
    if (!m || +m[1] < 1 || +m[1] > 12) return null;
    const t = today();
    const age = t.year - +m[2] - (t.month < +m[1] ? 1 : 0);
    return t.month === +m[1] ? [age - 1, age] : [age];
  }
  // An age option as [low, high]: "Under 30", "30-39", "18 to 24", "25+", "60 or older", "Over 40" (41 up),
  // "40 and above", "24 and under", "25". null = not an age range ("I prefer not to answer").
  function ageRange(text) {
    const s = String(text || "").toLowerCase().replace(/[\u2013\u2014]/g, "-");
    if (/prefer|decline|not to (say|answer)|wish|self[- ]?identify/.test(s)) return null;
    let m;
    if ((m = s.match(/(\d{1,3})\s*(?:-|to|through|thru)\s*(\d{1,3})\b/))) return [+m[1], +m[2]];
    if ((m = s.match(/(\d{1,3})\s*(?:\+|(?:years?(?: old)?\s*)?(?:or|and)\s*(?:older|over|above|up|more))/))) return [+m[1], Infinity];
    if ((m = s.match(/(\d{1,3})\s*(?:years?(?: old)?\s*)?(?:or|and)\s*(?:under|younger|below|less)/))) return [0, +m[1]];
    if ((m = s.match(/\b(?:under|younger than|less than|below)\s*(\d{1,3})/))) return [0, +m[1] - 1];
    if ((m = s.match(/^\s*<\s*(\d{1,3})/))) return [0, +m[1] - 1];
    if ((m = s.match(/^\s*>\s*(\d{1,3})/))) return [+m[1] + 1, Infinity];
    if ((m = s.match(/\b(?:over|older than|more than|above)\s*(\d{1,3})/))) return [+m[1] + 1, Infinity];
    if ((m = s.match(/^\s*(\d{1,3})\s*(?:years?(?: old)?)?\s*$/))) return [+m[1], +m[1]];
    return null;
  }
  // The option whose range holds every possible age (the narrowest when ranges overlap); null when the
  // possible ages fall in different options (a range edge in the birth month) or none holds them.
  const ageChoice = (ages) => (texts) => {
    const ok = texts.map((t) => [t, ageRange(t)]).filter(([, r]) => r && ages.every((x) => x >= r[0] && x <= r[1]));
    return ok.length ? ok.sort((a, b) => a[1][1] - a[1][0] - (b[1][1] - b[1][0]))[0][0] : null;
  };

  // A count among options ("0", "1", "2", "3+", "1-2", "3 or more", "None", "One internship", "More than 3"): the
  // option whose range holds n (the narrowest), via ageRange after words become digits; null = none holds it.
  const WORD_NUM = { none: 0, zero: 0, no: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
  const countText = (t) =>
    String(t).toLowerCase().replace(/\b(none|zero|no|one|two|three|four|five|six)\b/g, (w) => String(WORD_NUM[w])).replace(/\b(prior |previous |past )?internships?\b/g, " ").replace(/\s+/g, " ").trim();
  const countChoice = (n) => (texts) => {
    const clean = texts.map(countText);
    const pick = ageChoice([n])(clean);
    return pick == null ? null : texts[clean.indexOf(pick)];
  };

  // Never served in the armed forces, as option wordings (military status, and veteran status derived from
  // it): exact or whole-phrase steps, so "Not a veteran" never picks "I identify as a non-protected veteran".
  // Sherwood: "I have never served in the military".
  // The acknowledging option of a notice ("I acknowledge", "Yes", "I have read ..."), never a declining one.
  const ackOption = (texts) =>
    (texts || []).find((t) => /^(yes\b|i (hereby )?(acknowledge|agree|accept|confirm|consent|understand|have (read|reviewed|received))|acknowledged?\b|agreed?\b|accept(ed)?\b|confirm(ed)?\b)/.test(norm(t)) && !/\b(not|dont|do not|decline|disagree|no)\b/.test(norm(t))) || null;
  // Hiring notices about work-eligibility paperwork (I-9, E-Verify, proof of the right to work).
  const HIRE_NOTICE = /\b(i 9|i9|e verify|everify|employment eligibility verification)\b|\b(proof|documentation|evidence|verification) of (your )?(legal )?(right|eligibility|authori[sz]ation) to (work|be employed)\b/;
  // Countries a citizenship / nationality / residence question can name ("Are you a citizen, national or permanent
  // resident of Iran, Cuba, North Korea or Syria?"). SANCTIONED: the U.S. export-control (embargoed) list.
  const SANCTIONED = /^(iran|cuba|north korea|dprk|syria|crimea|sudan|venezuela|belarus|russia|donetsk|luhansk)$/;
  const US_NAME = /^(u s a|u s|usa|the us|united states of america|united states)$/;
  // Longest names first, so "united states of america" wins over "united states" and "north korea" over "korea".
  const COUNTRIES = ["iran", "cuba", "north korea", "dprk", "syria", "crimea", "sudan", "venezuela", "belarus", "russia", "donetsk", "luhansk", "china", "india", "canada", "mexico",
    "united kingdom", "england", "ireland", "france", "germany", "italy", "spain", "portugal", "netherlands", "belgium", "switzerland", "austria", "sweden", "norway",
    "denmark", "finland", "poland", "ukraine", "turkey", "israel", "egypt", "saudi arabia", "united arab emirates", "qatar", "pakistan", "bangladesh", "sri lanka",
    "nepal", "japan", "south korea", "taiwan", "hong kong", "singapore", "malaysia", "indonesia", "philippines", "vietnam", "thailand", "australia", "new zealand",
    "brazil", "argentina", "chile", "colombia", "peru", "nigeria", "kenya", "south africa", "ghana", "ethiopia", "afghanistan", "iraq", "lebanon", "libya", "yemen", "myanmar",
    "united states of america", "united states", "u s a", "u s", "usa", "the us"].sort((a, b) => b.length - a.length);
  const COUNTRY_RX = new RegExp(`\\b(${COUNTRIES.join("|")})\\b`, "g");
  // The countries a citizenship question names ("citizen, national or permanent resident of Iran, Cuba, North Korea
  // or Syria", "citizen of Canada"), from the words after "citizen / national / resident / citizenship ... of / from /
  // in" up to the end of that sentence; [] when it names none (or isn't such a question: "Are you a U.S. citizen?").
  function namedCountries(L) {
    const m = L.match(/\b(citizens?|nationals?|nationality|citizenship|residents?|residency)\b(?: \w+){0,6}? (?:of|from|in) (.*)$/);
    if (!m) return [];
    return [...new Set(m[2].match(COUNTRY_RX) || [])];
  }
  const NEVER_SERVED = [["I have never served in the military", "Never served", "I have not served"], ["Not a veteran"], ["I am not a protected veteran"], ["No military service"], ["None"], ["Civilian"], ["Not applicable"]];

  // "Still Student?", "Currently attending", "I currently study here" (a checkbox in an education entry, every
  // portal): checked while the expected graduation date is ahead, unchecked after; null = no date in the profile.
  const STUDENT_NOW = /\bstill (a )?student\b|\bstill studying\b|\bcurrently (attending|enrolled|studying)\b|\bi (currently|still) (study|attend) (here|this school)\b|\bcurrently study here\b|\bcurrent(ly)? (a )?student\b/;
  function studentNow(p) {
    const d = parseDate(p.expectedGraduation || "");
    if (!d.year) return null;
    const t = today();
    const m = Number(d.month || 12);
    return Number(d.year) > t.year || (Number(d.year) === t.year && m >= t.month);
  }

  function companyText() {
    return norm(location.hostname.split(".")[0] + " " + document.title).replace(/ /g, "");
  }

  function workedHereBefore(p) {
    const names = (p.answers?.previousEmployers || "").split(",").map((s) => norm(s).replace(/ /g, "")).filter(Boolean);
    const here = companyText();
    return names.some((n) => here.includes(n));
  }

  // Legal agreements (never acknowledged for you): arbitration, waivers, non-competes, releases, indemnification,
  // "agree to be bound".
  const LEGAL_AGREEMENT = /\barbitration\b|\bwaive(r|rs|s|d)?\b|\bwaiving\b|\bnon ?compete\b|\bagree(ing|s|d)? to be bound\b|\bbound by (the|its|these|this|all|such) (terms|agreement|provisions)\b|\bclass (action|or collective action)\b|\brelease (of )?(all )?(claims|liability)\b|\bindemnif\w*\b|\bjury trial\b/;
  // The text right above a field on the page (what "I have read the above" refers to): the nearest previous sibling(s)
  // with text, of the field or, when it has none, of its closest ancestor that has (up to three levels); one or two
  // blocks, never text further up (an earlier section's agreement is not "the above").
  function textAbove(c) {
    for (let el = c, lvl = 0; el && lvl < 4; el = el.parentElement, lvl++) {
      let out = "";
      for (let s = el.previousElementSibling, n = 0; s && n < 2; s = s.previousElementSibling) {
        const t = (s.innerText || "").trim();
        if (!t) continue;
        out = `${t} ${out}`;
        n++;
        if (out.length > 200) break;
      }
      if (out.trim()) return out.slice(-1500);
    }
    return "";
  }
  // Closest section heading that comes before this field in the page ("Legal Name", "Preferred Name", ...)
  function headingBefore(c) {
    const hs = [...document.querySelectorAll("h2,h3,h4,h5,legend,[role='heading']")].filter(visible);
    let last = null;
    for (const h of hs) {
      if (h.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING) last = h;
      else break;
    }
    return last ? norm(last.innerText) : "";
  }
  // A preferred-name field: by ids, the section heading (Workday's "Preferred Name" block), or the
  // label itself ("What is your preferred first name?", "Name you go by", "Nickname").
  function isPreferred(f) {
    const ids = [f.id, f.ctrl?.id, f.ctrl?.getAttribute?.("data-automation-id"), f.ctrl?.name].filter(Boolean).join(" ").toLowerCase();
    return /preferred/.test(ids) || /\bpreferred\b|name you go by|go by|nickname/.test(f.nl || "") || /preferred name/.test(headingBefore(f.c));
  }

  // Government / defense attestations: government, DoD or military official/employee, post-government
  // employment, ethics opinions, foreign government officials, conflicts of interest, debarment.
  // Answering these wrong is a false statement to an employer (often a defense contractor), so they
  // never get rule or Claude answers, only an exact learned answer; otherwise they're left yellow.
  const GOV_ATTEST = new RegExp(
    [
      "post government employment",
      "ethics opinion",
      "section 847",
      "\\b(official|officer|employee)s? (or (employee|official|officer)s? )?of (the |any )?(u s |us |united states |federal |foreign |non u s )?(government|dod|department of defense|armed forces|military)",
      "\\b(government|public|foreign|dod|federal) officials?\\b",
      "(employed by|employee of|work(ed)? for|serv(e|ed|ing) (in|with)) (the |a )?(u s |us |united states |federal |foreign |non u s )?(government|armed forces|military|dod|department of defense)",
      // iCIMS HMSY: "Are you an active member of the United States Armed Forces ... or currently an employee of the United States Government?"
      "\\bmember of (the )?(u s |us |united states )?(armed forces|military|national guard|reserves?)\\b",
      "conflicts? of interest",
      "debar",
      "suspended or excluded|excluded from (federal|government)",
    ].join("|")
  );
  const ATTEST = Symbol("attest");

  // ---- Government / military history ("Have you ever been employed by the U.S. Government?", "Are you a current
  // or former DoD employee?", "Have you ever served in the armed forces?", "Are you a military spouse?", "Are you
  // a current or former non-US government official?"): facts from Options "Government / military history"
  // (`answers.govEmployee`, `armedForces`, `militarySpouse`, `foreignOfficial`: Yes / No / blank). Checked before
  // GOV_ATTEST. Statements to agree to, signatures, post-government employment / ethics opinions / Section 847,
  // conflicts of interest, debarment and relatives' questions stay attestations (yellow).
  const GOV_KINDS = [
    ["militarySpouse", "military spouse / partner", /\b(military|armed forces|service ?members?)\b.{0,20}\b(spouses?|partners?|wife|husband)\b|\b(spouses?|partners?|wife|husband) (or \w+ )?of (an? |the )?((active duty|current|former|u s|us) )*(military|armed forces|service ?member)/],
    ["foreignOfficial", "non-US government official", /\b(foreign|non u s|non us|non united states)\b.{0,30}\b(government|public) officials?\b|\bofficials? (of|for) (an? |any )?(foreign|non u s|non us|non united states) government\b|\bforeign government (employee|official)s?\b/],
    ["armedForces", "armed forces service", /\b(served?|serving|service|member|enlisted|active duty|veteran)\b.{0,40}\b(armed forces|military|national guard|reserves?|army|navy|air force|marine corps|marines|coast guard|space force)\b|\b(military|armed forces) (service|member)\b|\bactive duty\b/],
    ["govEmployee", "US government employment", /\b(employed (by|with|at)|employee (of|with|at)|employment (with|by|at)|work(ed|ing)? (for|at)|served? (in|with|for)|position (with|in))\b.{0,60}\b(government|govt|dod|department of defense|federal agency)\b|\b(government|govt|dod|federal|civil service) (employee|employment|civilian)s?\b|\bcivil servant\b/],
  ];
  // "veteran" alone is EEO veteran status ("Are you a protected veteran?"), not this rule; but a yes / no about service
  // ("Are you a veteran or active member of the United States Armed Forces?") is: a veteran has served (below).
  const GOV_NOT_HISTORY = /post government employment|ethics opinion|section 847|conflicts? of interest|debar|suspended or excluded|excluded from|\b(relatives?|family|related to|household|immediate)\b|\bveteran\b(?!.{0,60}\b(armed forces|military|national guard|reserves?|army|navy|air force|marines?|coast guard|space force)\b)|\bprotected veteran\b|\bclearance\b|\bcontract(or|ors|ing)\b(?!.{0,40}\bemployee)|\bprocurement\b|^i (hereby )?(certify|agree|acknowledge|attest|affirm|understand|confirm|verify)\b/;
  // Willingness to work on government / defense / public-sector projects or clients (a preference, never history).
  const GOV_PROJECTS = /\b(open|willing|interested|comfortable|excited|able|happy|keen)\b.{0,60}\b(work(ing)?|contribut\w*|support\w*|build\w*|engag\w*|partner\w*)\b.{0,80}\b(government|govt|federal|public sector|defen[cs]e|dod|military|national security|intelligence community)\b|\b(government|federal|public sector|defen[cs]e|dod|military|national security)\b (projects?|clients?|customers?|contracts?|programs?|missions?|work|agencies)\b.{0,60}\b(open|willing|interested|comfortable)\b/;
  const GOV_ANSWERS = { No: [["No"], ["I have never been", "I have not been", "Never Employed", "Never Served", "I have never", "I have not", "Never"]], Yes: [["Yes"]] };
  function govHistoryAnswer(f, p) {
    const L = f.nl;
    if (!["radio", "dropdown", "checkgroup", "text", "textarea"].includes(f.type) || GOV_NOT_HISTORY.test(L)) return undefined;
    // A foreign official question also says "government"; a spouse question also says "military".
    const kinds = [];
    for (const [k, what, re] of GOV_KINDS) {
      if (!re.test(L)) continue;
      if (k === "armedForces" && kinds.some((x) => x.k === "militarySpouse") && !/\bor (have you|are you|you)\b/.test(L)) continue;
      if (k === "govEmployee" && kinds.some((x) => x.k === "foreignOfficial") && !/\bu s\b|\bus\b|\bunited states\b|\bfederal\b|\bstate\b|\blocal\b/.test(L)) continue;
      kinds.push({ k, what, v: String(p.answers?.[k] || "").trim() });
    }
    if (!kinds.length) return undefined;
    // An answer of Yes ("ever") can't tell "currently" apart, nor which government: only an "ever / current or
    // former / have you been" question about government in general takes it. No answers every form.
    const onlyNow = /\b(currently|active|presently|now)\b/.test(L) && !/\b(ever|former|formerly|previously|past|have you (been|served|worked))\b/.test(L);
    const narrow = (k) => k === "govEmployee" && /\b(federal|dod|department of defense|state|local)\b/.test(L);
    let ans;
    if (kinds.some((x) => !x.v)) ans = undefined;
    else if (kinds.every((x) => x.v === "No")) ans = "No";
    else if (!onlyNow && !kinds.some((x) => x.v === "Yes" && narrow(x.k))) ans = "Yes";
    const desc = kinds.map((x) => `${x.what}: ${x.v || "blank"}`).join(", ");
    if (!namedLogged.has("gov|" + f.label)) {
      namedLogged.add("gov|" + f.label);
      dbg(`government / military history: ${desc} -> ${ans ? `${ans} (blue)` : "left for you (never Claude)"}: ${f.label.slice(0, 80)}`);
    }
    if (!ans) return NEEDS;
    if (f.type === "text" || f.type === "textarea") return { value: ans, review: true };
    return { value: { steps: GOV_ANSWERS[ans], what: "government / military history" }, review: true };
  }

  // ---- Named-employer questions ("Do you currently or have you worked at Pinecrest Coopers LLP
  // (PcC), the bank's independent auditor, since July 2002?"). The answer is a fact from the work
  // history, so: none of the named companies in the history -> "No" (blue); any of them -> yellow
  // (dates and wording matter). Matching errs toward "in history" (containment, acronyms, aliases),
  // because a false match only costs a yellow field while a missed one would be a false "No".
  const CO_SUFFIX = /\b(llp|llc|inc|incorporated|corp|corporation|co|company|ltd|limited|plc|group|holdings|the)\b/g;
  const CO_ALIASES = [
    ["pwc", "pricewaterhousecoopers", "pricewaterhouse coopers", "price waterhouse coopers"],
    ["ey", "ernst young", "ernst and young"],
    ["bofa", "boa", "bank of america"],
    ["jpmorgan", "jp morgan", "jpmorgan chase", "jpmc", "chase"],
    ["ibm", "international business machines"],
    ["ge", "general electric"],
    ["hp", "hewlett packard"],
    ["aws", "amazon web services", "amazon"],
    ["meta", "facebook"],
    ["alphabet", "google"],
  ];
  const compact = (s) => norm(s).replace(CO_SUFFIX, " ").replace(/\s+/g, "");
  function companyVariants(name) {
    const v = new Set();
    const main = name.replace(/\([^)]*\)/g, " ");
    const base = norm(main).replace(CO_SUFFIX, " ").replace(/\s+/g, " ").trim();
    if (base) v.add(base.replace(/ /g, ""));
    for (const m of name.matchAll(/\(([^)]+)\)/g)) if (compact(m[1])) v.add(compact(m[1])); // "(PcC)"
    const words = base.split(" ").filter((w) => !["of", "and", "for"].includes(w));
    if (words.length >= 2) v.add(words.map((w) => w[0]).join("")); // initials: "ibm"
    for (const group of CO_ALIASES) if (group.some((g) => v.has(compact(g)))) group.forEach((g) => v.add(compact(g)));
    return v;
  }
  function sameCompany(a, b) {
    const va = companyVariants(a);
    const vb = companyVariants(b);
    for (const x of va) for (const y of vb) {
      if (x === y) return true;
      if (Math.min(x.length, y.length) >= 4 && (x.includes(y) || y.includes(x))) return true;
    }
    return false;
  }
  // The same company with nothing extra: a variant (corporate suffixes dropped, initials, aliases) equal, never
  // containment. For keep-if-matching in section panels: "Bright Path AI at Bayfront Tech Remote" is not
  // "Bright Path AI at Bayfront Tech" (sameCompany's containment called it kept, Mototron).
  function exactCompany(a, b) {
    const vb = companyVariants(b);
    return [...companyVariants(a)].some((x) => vb.has(x));
  }
  // Company names named in an "employed at X" question, or null if this isn't one (or no name found).
  // "worked with" is a tool or a team, not an employer ("Have you ever worked with Kubernetes?" was a named-employer No):
  // "with" counts only after employed / an employee / contractor ("employed with Acme", "a contractor with Acme").
  const EMPLOYED_AT = /\b(?:work(?:ed|ing)?\s+(?:at|for|by)|contracted\s+(?:with|by|for|to)|(?:employed|an? (?:employee|contractor|consultant|intern))(?: or (?:an? )?(?:employee|contractor|consultant|intern))?\s+(?:at|for|by|with))\s+(.+)/i;
  // "us" / "we" / "you" only as the whole name: "UX Trust" is a company.
  const NOT_A_COMPANY = /^(any|its|their|our|this|that)\b|^(us|we|you|them)$|affiliat|subsidiar|related compan|predecessor|organization|^the company$|^company$/i;
  function namedCompanies(label) {
    const m = label.match(EMPLOYED_AT);
    if (!m) return null;
    // Also cut at "as an employee or contractor" ("Have you previously worked for NVEXA as an
    // employee or contractor?" once gave "NVEXA as an employee", "contractor").
    let seg = m[1].split(/[?;]|\s+(?:since|during|within|before|after|from)\s+|\s+in the (?:past|last)\b|\s+at any time|,\s+the\s+|,?\s+\(?including\b|\s+as\s+(?:an?\s+)?(?:employee|contractor|consultant|intern|worker)\b/i)[0];
    const names = seg.split(/\s*,\s*|\s+or\s+|\s*\/\s*/);
    // Predecessors listed in parentheses: "(including but not limited to NationsTrust, Fleet, ... and Merrow Lynde)".
    // [^()] so the match can't start at an earlier "including ... (" and swallow the first name.
    const inc = label.match(/including(?: but not limited to)?\s+([^()]+)\)/i);
    if (inc) names.push(...inc[1].split(/\s*,\s*|\s+and\s+|\s+or\s+/));
    const out = names.map((s) => s.trim().replace(/^(the|a|an)\s+/i, "").replace(/[.,]+$/, "")).filter((s) => s.length >= 2 && s.length <= 60 && !NOT_A_COMPANY.test(s));
    return out.length ? out : null;
  }
  const namedLogged = new Set();
  // The question must ask whether you work / have worked somewhere ("have you worked at", "are you
  // currently employed by", "do you currently or have you worked at"), not merely mention working
  // there: "Why do you want to work at Acme?" once got "No" from this rule.
  const ASKS_EMPLOYMENT = /\b(have|did|were|are|do) you (currently |ever |previously |formerly |now |at any time |or have you )*(been )?(directly )?(work(ed|ing)?|employed|an? (employee|contractor|consultant|intern))\b/;
  // "Are you a current or former HM Employee?", "Are you a current or former Vendor at Harbor Shipyard?" (iCIMS
  // HMSY): the company is the word(s) before the role, or after "at / of / for / with".
  const CURRENT_OR_FORMER = /^(?:are|were) you (?:an? )?(?:current or former|former or current|current|former|past|previous) (.{0,40}?) ?(?:employee|vendor|contractor|supplier|consultant|intern)s?(?: (?:at|of|for|with) (.+?))?$/;
  function namedEmployerAnswer(f, p) {
    const L = f.nl;
    // Only yes/no-style choice fields; free text (textarea / text) is never answered by this rule.
    if (!["radio", "dropdown", "checkgroup"].includes(f.type)) return undefined;
    const pe = L.match(/\b(?:a |an )?(?:previous|former|past|ex) ((?:[a-z0-9]+ ){1,3}?)(?:employee|contractor|intern|consultant|worker)s?\b/);
    const cf = L.match(CURRENT_OR_FORMER) || (pe && !NOT_A_COMPANY.test(pe[1].trim()) && !/^(work|full time|part time|summer|software|engineering)\b/.test(pe[1]) ? [pe[0], pe[1].trim(), ""] : null);
    if (cf && !GOV_ATTEST.test(L) && !/government|military|armed forces|\bdod\b|federal/.test(L)) {
      const named = [cf[1], cf[2]].map((s) => (s || "").replace(/^(the|a|an)\s+/, "").trim()).filter((s) => s.length >= 2);
      if (named.length) {
        const history = [...(p.experiences || []).map((x) => x.company), ...String(p.answers?.previousEmployers || "").split(",")].map((s) => (s || "").trim()).filter(Boolean);
        const hits = named.filter((n) => history.some((h) => sameCompany(n, h)));
        if (!namedLogged.has(f.label)) {
          namedLogged.add(f.label);
          dbg(`named-employer question: companies ${show(named)}; ${hits.length ? `in your history (${show(hits)})` : "none in your history, answering No / Never (blue)"}`);
        }
        if (hits.length) return inHistory(f, p, hits);
        // Options like "Never Employed at Harbor Marine" / "Former" / "Current".
        return { value: { steps: [["No"], ["Never Employed", "Never"], ["I have not", "I have never", "Not a"]], what: "named employer" }, review: true };
      }
    }
    if (!ASKS_EMPLOYMENT.test(L)) return undefined;
    // Government / DoD / military employment stays with the attestation guard.
    if (GOV_ATTEST.test(L) || /government|military|armed forces|\bdod\b|department of defense|federal|public official/.test(L)) return undefined;
    const named = namedCompanies(f.label);
    if (!named) return undefined;
    const history = [...(p.experiences || []).map((x) => x.company), ...String(p.answers?.previousEmployers || "").split(",")]
      .map((s) => (s || "").trim())
      .filter(Boolean);
    const hits = named.filter((n) => history.some((h) => sameCompany(n, h)));
    if (!namedLogged.has(f.label)) {
      namedLogged.add(f.label);
      dbg(`named-employer question: companies ${show(named)}; ${hits.length ? `in your history (${show(hits)})` : "none in your history, answering No (blue)"}`);
    }
    if (hits.length) return inHistory(f, p, hits);
    return { value: ["No", "I have not", "I have never", "Never"], review: true };
  }
  // A named company in your work history (learned-answers review: "Were you previously employed by Northwind?" must be
  // Yes from your history, never a learned answer): Yes, or the Current / Former option, blue. A question with a time
  // window ("since July 2002", "within the last 24 months", "on or after January ...") is yours: the dates matter.
  const TIME_WINDOW = /\b(since|within the (last|past)|in the (last|past)|during the (last|past)|on or (after|before)|last \d+ (years?|months?)|past \d+ (years?|months?)|\d+ (years?|months?) ago)\b/;
  // Current vs former: an experience is current when "I currently work here" is ticked or its end date is still ahead;
  // otherwise (an end date passed, or none given) it has ended. Previous employers (Options) have ended.
  function jobIsCurrent(x) {
    if (x.current) return true;
    const y = Number(x.endYear);
    if (!y) return false;
    const m = /^\d+$/.test(String(x.endMonth || "").trim()) ? Number(x.endMonth) : MONTH_NAMES.findIndex((n) => norm(n).slice(0, 3) === norm(x.endMonth || "").slice(0, 3)) + 1 || 12;
    const now = new Date();
    return y > now.getFullYear() || (y === now.getFullYear() && m >= now.getMonth() + 1);
  }
  function historyJobs(p) {
    return [...(p.experiences || []).map((x) => ({ company: (x.company || "").trim(), current: jobIsCurrent(x) })),
      ...String(p.answers?.previousEmployers || "").split(",").map((s) => ({ company: s.trim(), current: false }))].filter((x) => x.company);
  }
  // Which time the question asks about: "Are you currently employed by X?" = now only; "Were you previously employed
  // by X?" / "a former X employee" = the past only; "Have you ever worked for X?", "current or former" = either.
  function employmentTense(L) {
    const cur = /\b(currently|presently|now|current)\b|\b(are|is) you (employed|working)\b|\bdo you (work|consult)\b/.test(L);
    const past = /\b(previously|formerly|former|past|previous|ex)\b|\bwere you\b/.test(L);
    const ever = /\bever\b|\bhave you (also )?(been )?(work|employ|an? )|\bat any time\b|\bdid you work\b/.test(L);
    if (cur) return past || ever ? "either" : "current";
    if (past && !ever) return "former";
    return "either";
  }
  function inHistory(f, p, hits) {
    const once = !namedLogged.has("hist|" + f.label) && namedLogged.add("hist|" + f.label);
    if (TIME_WINDOW.test(f.nl)) {
      if (once) dbg(`named employer: ${show(hits)} is in your work history, but the question has a time window; left for you`);
      return ATTEST;
    }
    const jobs = historyJobs(p).filter((x) => hits.some((h) => sameCompany(h, x.company)));
    const current = jobs.some((x) => x.current);
    const ended = jobs.some((x) => !x.current);
    const tense = employmentTense(f.nl);
    const status = `${show(hits)} is in your work history (${current ? "current job" : "ended"}${current && ended ? ", and an earlier one ended" : ""})`;
    const CUR = ["Current", "Currently employed", "I am currently employed"];
    const FORMER = ["Former", "Previously employed", "I have previously worked"];
    if (tense === "current" && !current) {
      if (once) dbg(`named employer: ${status}; the question asks about now -> No (blue)`);
      return { value: { steps: [["No"], ["Former", "Previously employed", "Not currently"], ["I am not", "I do not"]], what: "named employer" }, review: true };
    }
    if (tense === "former" && !ended) {
      if (once) dbg(`named employer: ${status}; the question asks about a past job there, and yours is current: left for you`);
      return ATTEST;
    }
    const asCurrent = tense === "current" || (tense === "either" && current);
    if (once) dbg(`named employer: ${status}; the question asks about ${tense === "either" ? "now or the past" : tense === "current" ? "now" : "the past"} -> Yes (blue)`);
    return { value: { steps: [["Yes"], asCurrent ? CUR : FORMER, ["I have", "I am"]], what: "named employer" }, review: true };
  }

  // ---- Field of study (every portal): the entry's field, then its "Field of study fallbacks" (Options,
  // "|"-ordered; blank = the field alone), as ordered steps (steps after the first are blue). Matched as
  // word sets (matchAlts / sameField: "Engineering,Computer" = "Computer Engineering"). Searchable lists
  // are searched with the full field, then its longer words ("Computer", "Engineering").
  function fieldOfStudyValue(x) {
    if (!x?.field) return undefined;
    const names = [x.field, ...splitAlts(x.fieldFallbacks || "")].filter((n, i, a) => a.findIndex((m) => AAF.fieldKey(m) === AAF.fieldKey(n)) === i);
    const words = norm(x.field).split(" ").filter((w) => w.length >= 4);
    const searches = [x.field, ...words].filter((t, i, a) => a.findIndex((u) => norm(u) === norm(t)) === i);
    return { steps: names.map((n) => [n]), searches, fos: true, what: "field of study" };
  }
  // ---- Highest education level ("Highest Education Level", "What is the highest level of education you
  // have completed?"): from the expected graduation date. Before it: some college; on / after it: a
  // bachelor's. Ordered steps, blue, never Claude. (The degree you're pursuing is the education step's.)
  const HIGHEST_EDU = /\bhighest (degree|diploma)( or (degree|diploma))?\b.{0,20}\b(received|completed|earned|obtained|attained|awarded)\b|\bhighest (level of |levels of )?(education|schooling)\b|\bhighest (education|educational) (level|attainment)\b|\bhighest level (of education )?(completed|attained|achieved)\b|\blevel of education (completed|attained|achieved)\b|\bhighest (completed|attained|achieved) (level of )?(education|schooling|degree)\b|\beducation level (completed|attained|achieved)\b|\bhighest level of (completed )?education\b/;
  // `received`: the question asks what you have RECEIVED / completed / earned ("Highest degree or diploma
  // received"): before graduation that's your high school diploma (then Some College when the list has no
  // high-school option); a plain "highest education level" is Some College.
  function highestEducation(p, received = false) {
    const g = parseDate(p.expectedGraduation);
    if (!g.year) return null;
    const grad = new Date(Number(g.year), Number(g.month || 5) - 1, Number(g.day || 1));
    const done = Date.now() >= grad.getTime();
    const steps = done
      ? [["Bachelor's Level Degree"], ["Bachelor's Degree"], ["Bachelor Degree"], ["Bachelor's"]]
      : received
        ? [["High School Diploma", "High School"], ["High School Graduate or Equivalent", "HS Graduate or Equivalent", "High School Graduate", "High School Diploma or Equivalent"], ["Some College"]]
        : [["Some College"], ["Currently Enrolled in College"], ["Some College, No Degree"], ["High School Graduate or Equivalent"]];
    return { done, received, steps };
  }

  // ---- Country (choice fields, every portal): a US profile country becomes an ordered alias list, tried
  // against the listed options first; an async menu is searched alias by alias, then with "United" (whose
  // results must still match an alias, never "United Kingdom"). Stitchly's Greenhouse Country said "No
  // options" for a typed "United States of America". `what` logs which alias matched.
  // The option that means "Yes" for a fixed answer when the options have no Yes (AAF.setField's fallback):
  //   work authorization: your country ([United States, Singapore, No, N.A.] -> "United States");
  //   U.S. person: "I am a U.S. person", then "U.S. citizen" / "I am a citizen" ("I am a citizen of Cuba ..."
  //   and "None of the above" never count).
  // Returns { text, why } or null (nothing clearly means yes: left for you).
  //   a "No" (sponsorship): the option meaning no visa is needed ("None", "N/A", "Not applicable", "I do not
  //   require sponsorship"); never a visa type or "Other".
  function yesOption(kind, texts, p, answer = "Yes") {
    // You already live where they ask you to relocate: an "I am local / already live there" option, then a plain yes,
    // then "open to relocating"; never a negated one.
    if (kind === "relocation local") {
      const ok = texts.filter((t) => t && !/\b(not|unable|cannot|can t|no|unwilling)\b/.test(norm(t)));
      const t = ok.find((x) => /\b(local|already (live|living|based|reside|residing|located)|currently (live|living|based|reside|residing|located)|i live in|i am based in|based in|reside in)\b/.test(norm(x))) ||
        ok.find((x) => /^yes\b/.test(norm(x))) ||
        ok.find((x) => /\b(open to|willing to|able to|happy to) relocat/.test(norm(x)));
      return t ? { text: t, why: "you live there" } : null;
    }
    if (answer === "No") {
      const t = texts.find((x) => /^no\b/.test(norm(x)) && !/\b(but|however|will need|will require|in the future)\b/.test(norm(x))) ||
        texts.find((x) => /^(none|none of (the|these) above|none needed|n a|na|not applicable|does not apply|not required|no sponsorship( needed| required)?|i (do not|dont|will not|wont) (need|require)\b.*|i am a u s citizen|u s citizen|us citizen)$/.test(norm(x)));
      return t ? { text: t, why: `you don't need sponsorship (Options: ${kind} "No")` } : null;
    }
    const NEG = /\b(no|not|non|none|neither|n a|na|outside|other)\b/;
    const ok = texts.filter((t) => t && !NEG.test(norm(t)));
    const yes = ok.find((t) => norm(t) === "yes") || ok.find((t) => /^yes\b/.test(norm(t)));
    if (yes) return { text: yes, why: "a yes option" };
    if (kind === "work authorization") {
      const alts = [].concat(countryAlts(p) || []).map(String).filter(Boolean);
      for (const c of alts) {
        const t = ok.find((x) => norm(x) === norm(c)) || ok.find((x) => c.length >= 5 && hasPhrase(x, c) && norm(x).split(" ").length <= norm(c).split(" ").length + 3);
        if (t) return { text: t, why: `your country (${p.country})` };
      }
      return null;
    }
    if (kind === "U.S. person") {
      const US = "(u s|us|united states|american)";
      const other = (t) => /\bcitizen (of|from)\b/.test(norm(t)) && !new RegExp(`\\bcitizen (of|from) (the )?${US}\\b`).test(norm(t));
      const person = ok.find((t) => new RegExp(`\\b${US} person\\b`).test(norm(t)) && !other(t));
      if (person) return { text: person, why: "you are a U.S. person (Options)" };
      const citizen = ok.find((t) => (new RegExp(`\\b${US} citizen\\b|\\bcitizen (of )?(the )?${US}\\b`).test(norm(t)) || /^i am a citizen$/.test(norm(t))) && !other(t));
      if (citizen) return { text: citizen, why: "you are a U.S. person (Options): the citizen option" };
      return null;
    }
    return null;
  }
  function countryAlts(p) {
    const c = String(p.country || "").trim();
    if (!c) return c;
    if (!/^(united states( of america)?|usa|us|u\.?\s?s\.?(\s?a\.?)?|america)$/i.test(c)) return [c];
    const list = ["United States", "United States of America", "USA", "US", "U.S."];
    list.what = "country";
    list.searches = ["United"];
    return list;
  }
  // "If your school isn't listed, please enter it here" / "we are always aiming to keep our school list
  // inclusive": decided after the education step (shared/form.js fillLate), never Claude.
  // Only a box that asks you to ENTER it ("please enter it here", "type / write / provide / specify"), never the school
  // question itself ("Which institution do you attend? If your institution is not listed, please select 'Other'"
  // (2Password) was taken for the box: the box then got your school while the dropdown stayed empty).
  const NOT_LISTED_RX = /\bschool list\b|\b(school|institution|university|college)\b.*\b(isnt|is not|not|wasnt|was not) (listed|in (the|our) list|available)\b|\b(isnt|is not|not|wasnt|was not) (listed|in (the|our) list)\b.*\b(school|institution|university|college)\b/;
  const SCHOOL_NOT_LISTED = { test: (l) => NOT_LISTED_RX.test(l) && /\b(enter|type|write|provide|specify|add|fill in|tell us)\b/.test(l) && !/\bselect\b.{0,20}\bother\b/.test(l) };
  // Ranked location / office preferences ("First location preference", "Second choice office", "Location
  // preference 3"): the rank, or 0.
  const RANK_WORDS = { first: 1, "1st": 1, second: 2, "2nd": 2, third: 3, "3rd": 3, fourth: 4, "4th": 4, fifth: 5, "5th": 5 };
  function rankedPreference(first) {
    if (!/\b(location|office)s?\b/.test(first) || !/\b(preference|choice)\b/.test(first)) return 0;
    const w = first.match(/\b(first|1st|second|2nd|third|3rd|fourth|4th|fifth|5th)\b/);
    if (w) return RANK_WORDS[w[1]];
    const n = first.match(/\b(?:preference|choice) (?:no |number )?([1-5])\b/);
    return n ? Number(n[1]) : 0;
  }

  // ---- Today's date in the format a field asks for: its placeholder or label ("MM/DD/YYYY", "dd/mm/yyyy",
  // "YYYY-MM-DD"); MM/DD/YYYY by default.
  // The expected graduation date for a text box: the full date (05/21/2027) in the format the placeholder or label
  // asks for; just the year when the box is year-only ("YYYY", "Graduation year"); month / year when it asks MM/YYYY.
  function gradText(f, p) {
    const d = parseDate(p.expectedGraduation || "");
    if (!d.year) return p.expectedGraduation || undefined;
    const hint = `${f.ctrl?.getAttribute?.("placeholder") || ""} ${f.label || ""}`;
    if (/^\s*yyyy\s*$/i.test(f.ctrl?.getAttribute?.("placeholder") || "") || (/\byear\b/i.test(f.label || "") && !/\b(date|month|day)\b/i.test(f.label || ""))) return String(d.year);
    if (/\bmm\s*[\/.\- ]\s*yyyy\b/i.test(hint) && !/\bdd\b/i.test(hint)) return `${String(d.month).padStart(2, "0")}/${d.year}`;
    if (!d.day || !d.month) return p.expectedGraduation;
    return dateInFormat(f, d);
  }
  function dateInFormat(f, d) {
    const hint = `${f.ctrl?.getAttribute?.("placeholder") || ""} ${f.label || ""}`;
    const m = hint.match(/\b(mm|dd|yyyy|yy)([\/.\- ])(mm|dd)\2(yyyy|yy|mm|dd)\b|\b(yyyy)([\/.\- ])(mm)\6(dd)\b/i);
    const fmt = m ? m[0] : "MM/DD/YYYY";
    const two = (n) => String(n).padStart(2, "0");
    return fmt.replace(/yyyy/i, String(d.year)).replace(/yy/i, String(d.year).slice(2)).replace(/mm/i, two(d.month)).replace(/dd/i, two(d.day));
  }

  // ---- Phone numbers in the format a label asks for ("Number (Format: 123-456-7890)", "(123) 456-7890"):
  // 10 US digits rewritten that way; anything else as saved.
  const PHONE_FORMAT = /\(?\b123\)?[-. ]?456[-. ]7890\b/;
  function phoneInFormat(phone, label) {
    const m = String(label || "").match(/(\(?)123(\)?)([-. ]?)456([-. ])7890/);
    const d = String(phone || "").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
    if (!m || d.length !== 10) return phone;
    return `${m[1]}${d.slice(0, 3)}${m[2]}${m[3]}${d.slice(3, 6)}${m[4]}${d.slice(6)}`;
  }

  // ---- Single-field address ("Current Mailing Address"): "1 Test Street, Springfield, NY 10001".
  const STATE_ABBR = {
    alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO", connecticut: "CT", delaware: "DE",
    "district of columbia": "DC", florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA",
    kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI", minnesota: "MN",
    mississippi: "MS", missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV", "new hampshire": "NH", "new jersey": "NJ",
    "new mexico": "NM", "new york": "NY", "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK", oregon: "OR",
    pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC", "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT",
    vermont: "VT", virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI", wyoming: "WY", "puerto rico": "PR",
  };
  // What level of place a location list offers (GlobeQuant: "Where are you currently located?" listed countries, and the
  // location rule typed "New York" into it, options [] twice): "countries" (2+ options are country names and they're at
  // least half the list), "states" (3+ US state names), "regions" (Americas / EMEA / APAC / North America / LATAM ...),
  // else null. Returns { level, steps } with your country's names, your state (name, then abbreviation), or the region
  // holding your country; the location chooser (shared/form.js) uses it when no accepted name is listed.
  const REGION = /^(the )?(americas|north america|na|amer|emea|apac|asia pacific|latam|latin america|europe|asia|africa|middle east|oceania|us (and|&) canada|united states (and|&) canada|north and south america)$/;
  function placeLevel(texts, p) {
    const ts = (texts || []).map((t) => norm(String(t || ""))).filter((t) => t && !/^(other|none|prefer not|select)/.test(t));
    if (ts.length < 2) return null;
    const country = ts.filter((t) => (t.match(COUNTRY_RX) || [])[0] === t || US_NAME.test(t)).length;
    if (country >= 2 && country * 2 >= ts.length) return p.country ? { level: "countries", steps: countryAlts(p).map((x) => [String(x)]) } : null;
    const states = ts.filter((t) => STATE_ABBR[t]).length;
    if (states >= 3 && states * 2 >= ts.length) return p.state ? { level: "states", steps: [[p.state], [STATE_ABBR[norm(p.state)] || p.state]] } : null;
    const regions = ts.filter((t) => REGION.test(t)).length;
    if (regions >= 2 && regions * 2 >= ts.length && /^united states/i.test(String(p.country || "").trim())) return { level: "regions", steps: [["North America"], ["Americas"], ["AMER"], ["NA"], ["US & Canada", "US and Canada"]] };
    return null;
  }
  // "Have you been a student with GlobeQuant University within the past 12 months?", "Have you attended Lakeview
  // University?", "Are you a graduate of X College?": like a named employer. The school named against your education
  // entries (names and aliases, a whole phrase either way): none = No, yours = Yes, blue, never Claude; logged `named
  // school: "<X>" ...`. Only yes / no questions (choice fields), never a school picker.
  const NAMED_SCHOOL = /^(have|are|were|did|do) you\b.*?\b(been a student|been a graduate|studied|attended|attend|enrolled|been enrolled|graduated|a graduate|an alumn\w*|taken (?:a )?course\w*)\b(?: \w+){0,2}?(?: (?:with|at|from|of|in))? (?:the )?(?<school>(?:[a-z0-9&]+ ){0,6}?(?:university|college|institute|school|academy)(?: of (?:[a-z]+ ){0,3}[a-z]+)?)\b/;
  function namedSchoolAnswer(f, p, L) {
    if (!["radio", "dropdown", "checkgroup"].includes(f.type)) return undefined;
    const m = L.match(NAMED_SCHOOL);
    if (!m) return undefined;
    const name = (m.groups?.school || "").trim();
    if (!name) return undefined;
    const mine = (p.education || []).flatMap((x) => [x.school, ...splitAlts(String(x.schoolAliases || "").replace(/,/g, "|"))]).filter(Boolean).map(norm);
    const yes = mine.some((n) => n === name || (` ${n} `.includes(` ${name} `) && name.split(" ").length >= 2) || ` ${name} `.includes(` ${n} `));
    if (!namedLogged.has("namedschool|" + f.label)) {
      namedLogged.add("namedschool|" + f.label);
      dbg(`named school: "${name}" ${yes ? "is your school -> Yes" : "is not in your education -> No"} (blue, never Claude): ${f.label.slice(0, 80)}`);
    }
    return { value: yes ? "Yes" : "No", review: true };
  }
  function fullAddress(p) {
    if (!p.address1 || !p.city) return "";
    const st = STATE_ABBR[norm(p.state)] || p.state || "";
    return [p.address1, p.address2, p.city, [st, p.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  }

  // ---- Graduation date on a choice field: an ordered list built from the expected graduation date
  // (05/21/2027 -> "May 2027" | "05/2027" | "5/2027" | "Spring 2027" | "Class of 2027" | "2027").
  // Terms: Jan-May Spring, Jun-Aug Summer, Sep-Dec Fall (Winter also accepted for Dec / Jan). Each
  // step matches an option exactly or as a whole phrase ("Spring 2027 (January - May)"), so a term or
  // month that contradicts the date (Summer / Fall 2027) never matches; the bare year matches only an
  // option that is just the year. Returns a chooser for the adapters' ranked-choice path.
  const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  function graduationChoice(d) {
    const y = String(d.year || "");
    const m = Number(d.month || 0);
    const steps = [];
    if (m) {
      const term = m <= 5 ? "Spring" : m <= 8 ? "Summer" : "Fall";
      steps.push(`${MONTH_NAMES[m - 1]} ${y}`, `${String(m).padStart(2, "0")}/${y}`, `${m}/${y}`, `${term} ${y}`);
      if (m === 12 || m === 1) steps.push(`Winter ${y}`);
    }
    steps.push(`Class of ${y}`, y);
    // Options naming months ("Spring 2027 (January-May)", "Summer 2027 (June or later)", "Fall 2026 (September-
    // December)"; Dodecal): the one whose year and month range hold the date, before the term-name steps.
    const MON = (w) => MONTH_NAMES.findIndex((n) => n.slice(0, 3).toLowerCase() === String(w || "").slice(0, 3).toLowerCase()) + 1;
    const monRx = "(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*";
    const inRange = (t) => {
      const s = String(t).toLowerCase();
      if (!m || !new RegExp(`\\b${y}\\b`).test(s) || /\b(later|after|before|earlier) than\b/.test(s)) return false;
      const r = s.match(new RegExp(`\\b${monRx}\\s*(?:-|–|—|to|through|thru)\\s*${monRx}\\b`));
      if (r) return m >= MON(r[1]) && m <= MON(r[2]);
      const later = s.match(new RegExp(`\\b${monRx}\\s+(?:or|and)\\s+(?:later|after)\\b`));
      if (later) return m >= MON(later[1]);
      return false;
    };
    return (texts) => {
      const ranged = (texts || []).filter(inRange);
      if (ranged.length === 1) {
        dbg(`graduation date: ${MONTH_NAMES[m - 1]} ${y} falls in "${ranged[0]}" (by its date range)`);
        return ranged[0];
      }
      for (const [i, s] of steps.entries()) {
        const bareYear = s === y;
        const hit = (texts || []).find((t) => norm(t) === norm(s) || (!bareYear && hasPhrase(t, s)));
        if (hit) {
          dbg(`graduation date: step ${i + 1} (${s}) matched "${hit}"`);
          return hit;
        }
      }
      dbg(`graduation date: no option matches ${steps.join(" | ")}; options:`, show(texts || []));
      return null;
    };
  }

  // ---- Willing to travel = the highest option offered. Ranks percentages numerically and words
  // (100% / extensive / frequent / any > moderate > occasional > minimal); never "No travel" / "0%" / "None".
  // On a yes/no list it picks "Yes". Returns the option text or null.
  function travelChoice(texts) {
    const NO = /^(no|none|0 ?%|0 percent)\b|no travel|not willing|unable|cannot|^0$/;
    const score = (t) => {
      const n = norm(t);
      if (NO.test(n)) return -1;
      const pct = [...String(t).matchAll(/(\d{1,3})\s*%/g)].map((m) => Number(m[1]));
      if (pct.length) return Math.max(...pct);
      if (/\b(100|extensive|frequent|any|unlimited|always|as needed|whatever)\b/.test(n)) return 100;
      if (/\b(heavy|significant|most)\b/.test(n)) return 80;
      if (/\b(moderate|some|regular)\b/.test(n)) return 50;
      if (/\b(occasional|limited|light)\b/.test(n)) return 25;
      if (/\b(minimal|rare|rarely|little)\b/.test(n)) return 10;
      if (/^yes\b/.test(n)) return 1;
      return 0;
    };
    let best = null;
    let bestScore = 0;
    for (const t of texts || []) {
      const s = score(t);
      if (s > bestScore) {
        best = t;
        bestScore = s;
      }
    }
    return best;
  }
  // A total professional experience question ("years of professional / work / industry / full-time experience", not with a
  // skill or field after it); null when it isn't one. excludesInterns: it leaves internships out.
  function proYears(L) {
    const m = L.match(/\byears? of (total |overall )?(professional|work|working|industry|full ?time|paid|post ?graduate)( work)? experience\b(.*)$/) ||
      L.match(/\b(professional|work|industry|full ?time) experience\b.{0,30}\b(in |how many )?years\b(.*)$/);
    if (!m) return null;
    const rest = m[m.length - 1] || "";
    if (/^\s*(with|in|using|on|doing|as|of|programming|developing|building|working with|related to)\b/.test(rest)) return null;
    return { excludesInterns: /\bnon ?internships?\b|\bexclud\w* (any |all )?intern|\bnot (including|counting) (any )?intern|\bwithout (any )?intern|\bnon ?intern\b|\b(other than|besides) intern/.test(L) };
  }
  // A work-history entry's type: Options (`type`: full-time / part-time / internship / fellowship / academic), else its title.
  function jobType(x) {
    const t = String(x.type || "").trim().toLowerCase();
    if (t) return t;
    const ti = norm(x.title || "");
    if (/\bintern(ship)?\b|\bco ?op\b/.test(ti)) return "internship";
    if (/\bfellow(ship)?\b/.test(ti)) return "fellowship";
    if (/\b(teaching|research|graduate|undergraduate) assistant\b|\b(ta|ra)\b|\btutor\b|\bgrader\b|\binstructor\b|\blecturer\b/.test(ti)) return "academic";
    return "full-time";
  }
  // Whole years of full-time work (overlaps counted once), with the entries counted and left out, for the log.
  function fullTimeYears(p) {
    const t = today();
    const spans = [];
    const counted = [];
    const left = [];
    for (const x of p.experiences || []) {
      const ty = jobType(x);
      const name = (x.title || "?") + " at " + (x.company || "?") + " (" + ty + (x.type ? "" : ", from the title") + ")";
      const sy = +x.startYear;
      if (ty !== "full-time") { left.push(name); continue; }
      if (!sy) { left.push(name + ", no start year"); continue; }
      const s = sy * 12 + ((+x.startMonth || 1) - 1);
      const e = x.current || !+x.endYear ? t.year * 12 + (t.month - 1) : +x.endYear * 12 + ((+x.endMonth || 12) - 1);
      if (e >= s) { spans.push([s, e]); counted.push(name); }
    }
    spans.sort((a, b) => a[0] - b[0]);
    let months = 0, cur = null;
    for (const [s, e] of spans) {
      if (!cur || s > cur[1] + 1) { if (cur) months += cur[1] - cur[0] + 1; cur = [s, e]; }
      else cur[1] = Math.max(cur[1], e);
    }
    if (cur) months += cur[1] - cur[0] + 1;
    return { years: Math.floor(months / 12), counted, left };
  }
  // Non-disclosure / confidentiality agreements, or restrictive agreements named together with one ("non-disclosure
  // agreement, non-solicitation agreement").
  const NDA_Q = /\bnon ?disclosure\b|\bnda\b|\bconfidentiality (agreement|obligation)s?\b|\brestrictive agreements?\b/;
  // The exact reply a question asks for: "(please) reply / answer / enter / type / respond / write / put / select N/A",
  // "None", "0" (quotes allowed); "" when it names none.
  function exactReply(label) {
    const m = String(label || "").match(/\b(?:reply|answer|enter|type|respond|write|put|select|mark|indicate|state)(?: with| as)?\s*[:"'“‘]?\s*(n\/?a|none|not applicable|0|zero)\b/i);
    if (!m) return "";
    const t = m[1].toLowerCase();
    return /^n\/?a$/.test(t) ? "N/A" : t === "none" ? "None" : t === "not applicable" ? "Not applicable" : "0";
  }
  // FINRA / SIE / Series exams, securities licenses or registrations (Steadfast).
  const SECURITIES_Q = /\bfinra\b|\bsie\b|securities industry essentials|\bseries (\d+|exams?|licen[cs]es?|registrations?)\b|\bsecurities (licen[cs]es?|registrations?|exams?)\b|\bregistered (representative|rep)\b/;
  // "Are you able to come into the office four days per week?", "able to work on-site / hybrid ...".
  // Tested on the normalized label ("on-site" -> "on site", "in-person" -> "in person").
  // Up to three words may name the office ("work from our New York office 3 days a week", Lever).
  // Also "within commuting distance of our Stamford office" (a commute to a named office; a bare place isn't this rule).
  // Also "This role is based out of our San Francisco or New York office and is required to be onsite. Will you be able
  // to accommodate this?" (Remedy AI: it matched only through the description, then was skipped without a word).
  const OFFICE_Q = /\b(commuting|commutable|driving|reasonable) distance (of|to|from) (the |our |an |a |one of our |either of our )?(\w+ ){0,6}(office|offices)\b|\b(come|commute|commuting|report|work|be|go) (in ?to|into|in|to|at|from) (the |our |an |a |one of our |either of our |one of the )?(office|offices|on site|site)\b|\b(come|commute|commuting|report|work|be|go) (in ?to|into|in|to|at|from) (the |our |an |a |one of our |either of our |one of the )?(\w+ ){1,6}(office|offices)\b|\bin (the )?office\b.*\b(days?|week|times)\b|\b(days?|times) (per|a|each|every) week\b.*\b(offices?|onsite|on site|in person)\b|\b(offices?|onsite|on site|in person)\b.*\b(days?|times) (per|a|each|every) week\b|\b(operates?|operating|works?|working|is|are)\b (fully |entirely |primarily |mostly )?(onsite|on site|in office|in person|in the office)\b|\b(offices?|onsite|on site|in person)\b.*\b(mondays?|tuesdays?|wednesdays?|thursdays?|fridays?)\b|\banchor days?\b|\bin office (days?|schedule|requirements?|policy|expectations?|attendance|presence|culture)\b|\bwe work (from|in|at) (our|the) offices?\b|\b(able|willing|comfortable|open|available)\b.*\b(on site|onsite|in person|hybrid|in office|in the office)\b|\bwork(ing)? (on site|onsite|in person|hybrid|in (the )?office)\b|\b(able|willing) to commute\b|\b(onsite|on site|hybrid) (role|position|requirement|schedule|arrangement|work)\b|\brequired to be (onsite|on site|in person|in (the )?office)\b|\bbased (out of|in|at|from) (our|the|one of our|either of our) (\w+ ){0,8}offices?\b/;
  // Is the job in one of the accepted metro locations? The job location can list several ("San
  // Francisco, CA; New York, NY"); any one is enough. An entry matches a location part when the part
  // contains it as a whole phrase, or when both start with the same city ("New York, NY" vs "New
  // York, United States"; "Albany, New York" starts with Albany, so it doesn't). A state named in the
  // job location must be the entry's state, or one of the metro's states when the entry names none:
  // "Newark, CA" is not "Newark".
  const METRO_STATES = ["NY", "NJ", "CT"];
  // NYC's boroughs and names count as New York (City) when comparing cities ("Brooklyn, NY" office vs "New
  // York, NY"; Oriel). "<city> metropolitan area / metro area / area / region" and "Greater <city>" are that
  // city (Empirica: "New York City metropolitan area").
  // Also neighborhoods and parentheticals (Crateworks: "our New York (Flatiron) office"; "NYC - Hudson Yards", "Manhattan
  // (SoHo)", "SoHo"): an NYC name followed by a neighborhood, or a neighborhood alone, is New York. Only neighborhoods
  // no other U.S. city is better known by ("Chelsea", "Williamsburg", "Astoria" stay as they are), and only a
  // neighborhood after the NYC name ("New York Mills" is not New York).
  const NYC_HOOD = /^(flatiron( district)?|soho|noho|nolita|tribeca|midtown( manhattan| east| west)?|hudson yards|financial district|fidi|lower manhattan|downtown manhattan|union square|nomad|gramercy( park)?|east village|west village|greenwich village|upper (east|west) side|lower east side|dumbo|long island city|park slope|downtown brooklyn|brooklyn navy yard|meatpacking( district)?|hell s kitchen|hells kitchen|times square|battery park( city)?|wall street|world trade center|rockefeller center|bryant park|grand central|penn station|chelsea|harlem|williamsburg|astoria|bushwick)$/;
  const NYC_HOOD_ALONE = /^(flatiron( district)?|soho|noho|nolita|tribeca|midtown manhattan|hudson yards|financial district|fidi|lower manhattan|downtown manhattan|greenwich village|upper (east|west) side|lower east side|dumbo|long island city|park slope|downtown brooklyn|brooklyn navy yard|meatpacking district|hell s kitchen|hells kitchen|times square|battery park city|world trade center|rockefeller center)$/;
  // ---- Places: ONE comparison for every rule that compares places (office attendance / preference / hubs, additional
  // offices, residence, relocation, commute, location dropdowns' same-city fallback, prefilled locations, Workday panel
  // locations). WRENLY: "New York (Manhattan)" among office hubs was "no step matched": the neighborhood handling lived
  // in the office attendance rule only, and a borough after the city name wasn't read as New York.
  // placeKeys(s): the city keys a place text stands for. The part outside parentheses, before " - " and the first comma,
  // and (when the part outside isn't a place: "Remote (New York)", "HQ (San Francisco)") the parenthetical; "Greater X",
  // "X metro / metropolitan area / area / region" = X; aliases (NYC, SF, Bay Area, LA, DC); NYC's boroughs, "New York
  // City", and NYC neighborhoods (after an NYC name, or alone when no other U.S. city is better known by them) = "new york".
  const PLACE_ALIASES = { nyc: "new york", "new york city": "new york", "new york ny": "new york", sf: "san francisco", "sf bay": "san francisco", "bay area": "san francisco", "sf bay area": "san francisco", "san francisco bay": "san francisco", "silicon valley": "san jose", la: "los angeles", dc: "washington", "d c": "washington", "washington dc": "washington", "washington d c": "washington" };
  const NYC_NAME = /^(new york city|nyc|new york|manhattan|brooklyn|queens|bronx|the bronx|staten island)$/;
  const NOT_PLACE_WORD = /^(remote|hybrid|on ?site|in office|in person|office|offices|hq|headquarters|anywhere|global|worldwide|flexible|tbd|multiple locations|various)?$/;
  const keyOf = (txt) => {
    const c = norm(String(txt).split(",")[0]).replace(/^(the )?(greater )?/, "").replace(/ (metropolitan|metro)( area| region)?$| (area|region)$/, "").trim();
    if (PLACE_ALIASES[c]) return PLACE_ALIASES[c];
    if (NYC_NAME.test(c) || NYC_HOOD_ALONE.test(c)) return "new york";
    // "New York Flatiron", "NYC Hudson Yards", "New York Manhattan": an NYC name followed by a neighborhood / borough.
    const m = c.match(/^(new york city|nyc|new york|manhattan|brooklyn|queens|bronx|staten island) (.+)$/);
    if (m && m[2].split(/ (?=ny$|new york$)/).every((x) => NYC_HOOD.test(x) || NYC_NAME.test(x) || /^(ny|new york|nyc|city)$/.test(x))) return "new york";
    return c;
  };
  function placeKeys(s) {
    const raw = String(s || "");
    const outside = raw.replace(/\([^)]*\)/g, " ").split(/\s[-–—|]\s/)[0];
    const inside = [...raw.matchAll(/\(([^)]*)\)/g)].map((m) => m[1]);
    const keys = new Set();
    const k = keyOf(outside);
    if (!NOT_PLACE_WORD.test(k)) {
      keys.add(k);
      // The whole text as one ("New York (Flatiron)" read without its parentheses) still counts.
      const whole = keyOf(raw.replace(/[()]/g, " "));
      if (!NOT_PLACE_WORD.test(whole)) keys.add(whole);
    } else for (const x of inside) if (!NOT_PLACE_WORD.test(keyOf(x))) keys.add(keyOf(x));
    return keys;
  }
  // The main city key of a place text ("" when it isn't one).
  const cityKey = (s) => [...placeKeys(s)][0] || "";
  // Two place texts name the same city: a shared key, and no conflicting states ("Newark, CA" is not "Newark, NJ").
  function samePlace(a, b) {
    const ka = placeKeys(a);
    if (![...placeKeys(b)].some((k) => ka.has(k))) return false;
    const sa = stateOf(a);
    const sb = stateOf(b);
    return !(sa && sb && sa !== sb);
  }
  // Your address is in New York City: the city is a borough / NYC name, or (a neighborhood: "Bayside",
  // "Astoria") a New York zip in an NYC range (Manhattan, Staten Island, Bronx 100-104; Queens / Brooklyn
  // 111-114, 116).
  function homeInNYC(p) {
    if (p.city && placeKeys(p.city).has("new york")) return true;
    const st = STATE_ABBR[norm(p.state || "")] || String(p.state || "").toUpperCase();
    return st === "NY" && /^(10[0-4]|11[1-4]|116)\d\d$/.test(String(p.zip || "").trim().slice(0, 5));
  }
  // Where you live, as a city key (New York City for any NYC address), and whether a place text is it.
  const homeKey = (p) => (homeInNYC(p) ? "new york" : p.city ? cityKey(p.city) : "");
  const isHome = (place, p) => !!homeKey(p) && placeKeys(place).has(homeKey(p));
  const homeName = (p) => (homeInNYC(p) ? "New York City" : p.city || "");
  // The words in a longer text that name where you live ("I live in or commute to NYC today" -> "nyc"), "" when none.
  function mentionsHome(text, p) {
    const k = homeKey(p);
    if (!k) return "";
    const w = norm(text).split(" ").filter(Boolean);
    for (let n = Math.min(4, w.length); n >= 1; n--) for (let i = 0; i + n <= w.length; i++) {
      const g = w.slice(i, i + n).join(" ");
      if (placeKeys(g).has(k)) return g;
    }
    return "";
  }
  // The specific meaning "you live in / commute to <your city>" as an option chooser (Kestrel, Ashby: "Are you based in
  // New York City or Washington, DC? If not, would you relocate?" [I live in or commute to NYC today, I live in or
  // commute to DC today, I'd relocate to NYC, ...]: the residence rule decided you live in NYC and passed a bare "Yes";
  // the Claude mapping picked "I'd relocate to either city"). The option naming your city with live / commute / based
  // wording, never a relocation or negated one, with no Claude call; `not` = options that contradict the meaning (a
  // relocation option), rejected if the meaning mapper ever picks one.
  const LIVE_WORDING = /\b(live|lives|living|reside|resides|residing|based|located|local|commute|commuting|currently in|i m in|i am in|already in|already there)\b/;
  const RELOC_WORDING = /\b(relocat\w*|move|moving|willing to)\b/;
  const NEG_WORDING = /\b(not|never|no|neither|none)\b/;
  function livesHereAlt(p) {
    return {
      for: "Yes",
      what: "residence (you live there)",
      detail: `the applicant lives in ${homeName(p)} today (not relocating)`,
      not: new RegExp(`${RELOC_WORDING.source}|^(no|neither|none)\\b`),
      choose: (texts) => {
        const hit = texts.find((t) => mentionsHome(t, p) && LIVE_WORDING.test(norm(t)) && !RELOC_WORDING.test(norm(t)) && !NEG_WORDING.test(norm(t)));
        return hit ? { text: hit, why: `names where you live ("${mentionsHome(hit, p)}") with live / commute wording` } : null;
      },
    };
  }
  // A place the question asks you to be in, without the word "office" (HCT: "I understand that this role is based in
  // NYC."; UniApp: "Are you able to be in New York City for the full duration of the summer program?"; "this role
  // requires being in Manhattan (SoHo)"). On the normalized label; the place must be capitalized in the label itself
  // ("able to be in person" is no place), and a country / region is no place here ("able to work in the US" is work
  // authorization). Returns the place (normalized, cut at for / during / N days ...) or "".
  const PLACE_ASK = [
    /\b(?:role|position|job|internship|program|team|opportunity)\b (?:is |will be |would be )?(?:based|located|onsite|on site|in person) (?:in|at|out of) (.+)$/,
    /\brequires? (?:you to be |that you be |being |candidates to be |employees to be )(?:based |located |onsite |on site |in person )?(?:in|at) (.+)$/,
    /\b(?:able|willing|available|planning|plan|expected) to (?:be|live|stay|spend the summer) (?:physically |based |located |onsite |on site |in person )?in (.+)$/,
  ];
  const NOT_PLACE = /^(the )?(us|u s|usa|united states( of america)?|america|north america|uk|united kingdom|canada|europe|emea|apac|latam|person|office|the office|our office|a hybrid.*|hybrid|remote.*)$/;
  function placeAsked(L, raw) {
    for (const rx of PLACE_ASK) {
      const m = String(L).match(rx);
      if (!m) continue;
      const place = m[1].replace(/\b(for|during|throughout|over|this|from|starting|by|on|at least|every|each|per|full time|five|four|three|two|one|\d+|days?|office|offices|area|metro|region|and (are|will|can)|if|when|while)\b.*$/, "").replace(/\b(the|our)\b /g, "").trim();
      if (!place || NOT_PLACE.test(place)) continue;
      const first = place.split(" ")[0];
      const shown = String(raw).match(new RegExp(`\\b${first.replace(/[^a-z0-9]/gi, "")}`, "i"));
      if (!shown || !/^[A-Z]/.test(shown[0])) continue;
      return place;
    }
    return "";
  }
  // Open-ended prompts (drafted, shared/main.js), on the normalized label: "Tell me / us about ...", "Describe a
  // project ...", "Walk us through ...", "a side / personal project you worked on".
  // A single-line box whose label asks for a link, not for prose ("Link to something you built", "Project URL",
  // "Portfolio link"; not "Tell us about a project and share a link", not textareas). Used by the link rule and by
  // draft routing (never drafted) and learning (never learned).
  const LINK_WORDS = /\b(link|links|url|urls|portfolio|website|github|git hub|repo|repository|demo)\b/;
  const PROSE_ASK = /^(please )?(tell|describe|explain|walk|talk|share (your|a|some|more)|why|how|what (is|are|was|were|did|do|does|would|excites)|in (a few|one|two|\d+) (sentences|words))\b|\b(in|with) (a few|one|two|\d+) sentences\b/;
  const isLinkBox = (f) => (f.type === "text" || f.ctrl?.type === "url") && f.type !== "textarea" && LINK_WORDS.test(norm(f.label || "")) && !PROSE_ASK.test(norm(f.label || "")) && norm(f.label || "").length <= 120;
  // Not "Share your LinkedIn URL" (a link field).
  const OPEN_PROMPT = /^(please )?(tell (me|us) about|describe|walk (me|us) through|talk (to us )?about)\b|\b(side|personal|hobby|passion) projects?\b|\ba project (you|that you|youve|you ve)\b|\bprojects? you (worked on|built|are proud of|re proud of|have built|created|made)\b|\bsomething you (built|made|created|shipped)\b/;
  // A how-did-you-hear answer that is only a category (its "Please specify" follow-up gets the free text).
  const HEAR_CATEGORY = /^(job boards?|job board other|social (media|networks?)|websites?|company website|internet|internet job boards?|online|other|search engines?)$/;
  function stateOf(s) {
    for (const seg of String(s).split(",").slice(1)) {
      const n = norm(seg);
      if (STATE_ABBR[n]) return STATE_ABBR[n];
      if (/^[a-z]{2}$/.test(n) && Object.values(STATE_ABBR).includes(n.toUpperCase())) return n.toUpperCase();
    }
    return "";
  }
  // Race preference list -> a ranked choice over the options: an exact option first (in preference
  // order), then an option containing a preference as a whole phrase, but never a more specific
  // subgroup the list doesn't name ("East Asian", "Southeast Asian", "Central Asian" for "Asian").
  const SUBGROUP = /\b(east|eastern|southeast|south east|southeastern|central|west|western|north|northern|south|southern)\s+(asian|asia)\b|\b(asian|asia)\s+(east|southeast|central|west|western|north|northern|south|southern)\b/;
  function raceChoice(prefs) {
    return (texts) => {
      for (const p of prefs) {
        const t = texts.find((x) => norm(x) === norm(p));
        if (t) return t;
      }
      for (const p of prefs) {
        const ok = texts.filter((x) => hasPosPhrase(x, p) && (!SUBGROUP.test(norm(x)) || SUBGROUP.test(norm(p))));
        if (ok.length) return ok.sort((a, b) => a.length - b.length)[0];
      }
      return null;
    };
  }
  function inMetro(jobLoc, list) {
    // "San Francisco and New York City" (an office list in the question, Chartwell Health) splits on and / & too.
    const parts = String(jobLoc || "").split(/\s*(?:;|\||\n|\u2022|\s\/\s| or | and | & )\s*/).filter(Boolean);
    for (const part of parts) {
      const pk = placeKeys(part);
      for (const e of splitAlts(list)) {
        if (!hasPhrase(part, e) && ![...placeKeys(e)].some((k) => pk.has(k))) continue;
        const ps = stateOf(part);
        const es = stateOf(e);
        if (ps && (es ? ps !== es : !METRO_STATES.includes(ps))) continue;
        return { part, e };
      }
    }
    return null;
  }
  const TRAVEL_Q = /willing to travel|able to travel|ability to travel|open to travel|comfortable (with )?travel|travel requirement|requires? (up to \d+ )?travel|percent(age)? of (your )?(time )?travel|how much travel|travel up to|travel \d+ ?%|travel for (work|business)/;
  const RESTRICTION_Q = /non ?compete|non ?solicit|restrictive covenant|employment restriction|restrictions? (on|that would (limit|restrict)) (your )?(ability|employment)|bound by (any|an) (agreement|contract)|agreement that (would )?(restrict|limit|prevent)/;
  // Returns: value | {value, review:true} | SKIP | ATTEST | undefined (unknown -> treat as a question)
  // ctx (optional, from the main pass): { splitAddress } = the form has separate address line / city / zip fields.
  // A leading question number ("5. Are you ...", "5a. Expected degree completion date", "Q5:"; followed by . ) or :
  // in the label, so "18 or older" keeps its 18), dropped before the rules run: Lexidos numbers its questions,
  // and rules anchored on "are you ..." missed them.
  const unnumbered = (f) => (/^\s*(q(uestion)?\s*)?\d{1,2}[a-z]?\s*[.):]\s+/i.test(f.label || "") ? norm(String(f.label).replace(/^\s*(q(uestion)?\s*)?\d{1,2}[a-z]?\s*[.):]\s+/i, "")) : f.nl);
  function profileValue(f, p, ctx = {}) {
    // Which named rule answered (`f.ruleName`), and the rules to skip (`f.skipRules`): when a rule's answer has no
    // matching option, main.js skips it and asks the rules again, so the next rule can try (BlackRidge).
    f.ruleName = "";
    const off = (n) => !!f.skipRules?.has(n);
    const ruled = (n, v) => {
      f.ruleName = n;
      return v;
    };
    const L = unnumbered(f);
    const both = `${L} | ${f.nid}`;
    const T = (rx) => rx.test(both);
    const a = p.answers || {};
    const e = p.eeo || {};
    // Contact/address rules only apply to short labels, so "Please state your salary..." doesn't get "New York".
    const S = (rx) => L.length <= 40 && T(rx);
    // The label with its parenthetical hint set aside ("Email (Please do not use an .edu email address)", Steadfast: over
    // 40 characters, so the email rule missed it and it went to Claude). Contact fields only (name, email, phone).
    const LP = norm(String(f.label || "").replace(/\([^)]*\)/g, " ").replace(/[*✱]/g, " "));
    const SC = (rx) => S(rx) || (LP.length <= 40 && LP.length < L.length && rx.test(LP));
    const M = (rx) => L.length <= 70 && f.type !== "radio" && f.type !== "dropdown" && T(rx);
    // Fixed answers (previous worker, work auth, sponsorship, 18+, relocate, citizen, US person,
    // clearance) always get the blue double-check outline, on every page. Blank stays blank.
    const FIX = (v) => (v == null || v === "" ? v : { value: v, review: true });
    // A fixed "Yes" on a choice field whose options may not include Yes (Similis: work authorization as
    // [United States, Singapore, No, N.A.]): the field carries a chooser that AAF.setField asks only when
    // "Yes" itself can't be selected (shared/core.js).
    // Also a fixed "No" (sponsorship as visa types [J1, F1, None, Other]: "None").
    const FIXYES = (v, kind) => {
      if ((v === "Yes" || v === "No") && ["radio", "dropdown", "checkgroup"].includes(f.type)) f.yesAlt = { what: kind, for: v, choose: (texts) => yesOption(kind, texts, p, v) };
      return FIX(v);
    };

    // Conditional follow-ups ("If yes, when did you graduate?", "If you graduated, enter the year",
    // "Select HM Business Unit if actively or formerly employed", fields of an "If Yes, please provide level
    // and issuer" group, the military / government service details group, an employee badge number, the
    // vendor company): only for someone whose answer above was yes. Never filled, never sent to Claude or
    // drafted; yellow only when required. First, because they never fill anything (iCIMS HMSY: "If Yes,
    // when did you graduate?" would otherwise get the expected graduation date).
    const sec = norm(f.section || "");
    // "If 'other' above, please specify city and state" (Empirica), "If you selected Other, ...": the same,
    // except a how-did-you-hear "If other, please specify" after a generic category (the hear rule below).
    const FOLLOW = /^if (yes|so|other|you (graduated|answered yes|selected yes|(selected|chose|picked|answered|responded) (with )?other))\b|\bif (actively|formerly|currently|previously)( or (actively|formerly|currently|previously))? employed\b/;
    // "If you responded 'other' to the question above, please specify" (2Password: it got LinkedIn while the question
    // above said LinkedIn): decided by the field right above. Its answer is Other (or a generic how-did-you-hear
    // category) and it's a how-did-you-hear question = the free-text answer; anything else = the follow-up rule (blank).
    const OTHER_FOLLOW = /^if (you (selected|chose|picked|answered|responded) (with )?)?other\b/;
    let hearOther = false;
    if (OTHER_FOLLOW.test(L) && !/\b(city|state|location|country|where|based|live|reside)\b/.test(L)) {
      const all = ctx.fieldValues?.() || [];
      const i = all.findIndex((x) => x.c === f.c);
      const above = i > 0 ? all[i - 1] : null;
      const parentV = above ? above.v : ctx.hearValue?.() || "";
      const parentIsHear = above ? /\bhow did you (hear|learn|find)|\bwhere did you (hear|find|learn)|\bwhat brought you\b|\bsource\b/.test(norm(above.label)) : true;
      hearOther = parentIsHear && (/^other\b/.test(norm(parentV)) || HEAR_CATEGORY.test(norm(parentV)));
      if (!namedLogged.has("otherf|" + f.label)) {
        namedLogged.add("otherf|" + f.label);
        dbg(`"other" follow-up: the ${above ? `question above ("${above.label.slice(0, 50)}")` : "how did you hear answer"} is "${parentV || "(empty)"}" -> ${hearOther ? "the free-text answer" : "left blank (it isn't Other)"}: ${f.label.slice(0, 80)}`);
      }
    }
    if ((!hearOther && (FOLLOW.test(L) || FOLLOW.test(sec))) || /\b(armed forces|military|government agency)\b/.test(sec) || /\bbadge (number|no|id)\b|\bname of the vendor\b|\bvendor company\b/.test(L)) {
      if (!namedLogged.has("follow|" + f.label + "|" + sec)) {
        namedLogged.add("follow|" + f.label + "|" + sec);
        dbg(`follow-up to an earlier yes answer, left ${f.required ? "for you" : "blank"}: ${(sec ? sec + ": " : "") + f.label.slice(0, 80)}`);
      }
      return f.required ? NEEDS : SKIP;
    }
    // Referral follow-ups ("If you were referred to this role by a Vellum employee, please write their name",
    // "Who referred you?", "Name of the employee who referred you"): blank (yellow when required), never
    // Claude. Vellum's went to Claude.
    if (/^if you (were|have been|are being|was) referred\b|\breferr(ed|al|er)\b.{0,80}\b(their|employees?|referrers?|persons?) (full )?name\b|\bname of (the |your )?(referrer|employee|person) who referred\b|\bwho referred you\b/.test(L)) {
      if (!namedLogged.has("referral|" + f.label)) {
        namedLogged.add("referral|" + f.label);
        dbg(`referral follow-up: left ${f.required ? "for you" : "blank"}, never sent to Claude: ${f.label.slice(0, 80)}`);
      }
      return f.required ? NEEDS : SKIP;
    }
    // Named-employer questions first: a fact from the work history, not an attestation.
    const school = namedSchoolAnswer(f, p, L);
    if (school !== undefined) return school;
    // "Have you previously applied to X?" is not employment: no rule here; your learned answer for that company, else
    // yellow, never Claude (learning.js `noClaudeWhy`, "previous application").
    if (globalThis.AAF_LEARN_RULES?.APPLIED_BEFORE.test(L)) return undefined;
    // Class year (Ridgeway: "What year are you currently in?"): computed, blue, never the classifier or Claude.
    if (CLASS_YEAR_Q.test(L) && ["radio", "dropdown", "checkgroup", "text"].includes(f.type)) {
      const c = classYearChoice(p);
      if (!namedLogged.has("classyear|" + f.label)) {
        namedLogged.add("classyear|" + f.label);
        dbg("class year: " + (!c ? "no expected graduation date in Options, left for you" : c.none ? c.none + ", left for you" : c.what + " (blue)") + ": " + f.label.slice(0, 80));
      }
      if (!c || c.none) return NEEDS;
      if (f.type === "text") return FIX(["Senior", "Junior", "Sophomore", "Freshman"][c.left] || "");
      return FIX({ choose: c.choose, text: "Senior", what: "class year" });
    }
    // The exact reply a question asks for ("If you are 18 years of age or older, please reply N/A", "If not, please reply
    // N/A", "enter None", "type 0"): used as is, never a sentence (Steadfast: "No, I have no employment restrictions.").
    const exact = exactReply(f.label);
    // Work permits for minors ("If you are under 18 years of age, can you furnish a work permit if required? If you are
    // 18 years of age or older, please reply N/A."; Steadfast: the work-authorization rule answered Yes): never work
    // authorization. The condition first: 18 or older (Options) = the reply it names (N/A); under 18 or not set = yours.
    // Only minor wording counts (under 18 / the age of, a minor, "if you are 18 or older, reply N/A"): "work permit"
    // alone is no minors question (BlackRidge: "Will you need to obtain, renew, extend or transfer a visa or work permit
    // ..." got N/A, which matched no option; it's sponsorship).
    const MINOR_Q = /\b(under|younger than) (the age of )?(18|eighteen)\b|\bunder the age of\b|\b(if you are|are you|as) a minor\b|\bminors\b|\bif you are (18|eighteen)( years( of age)?)? or older\b.{0,40}\b(reply|enter|type|select|answer|write|put)\b/;
    if (!off("minors") && MINOR_Q.test(L)) {
      const adult = a.over18 === "Yes";
      if (!namedLogged.has("minor|" + f.label)) {
        namedLogged.add("minor|" + f.label);
        dbg("question for minors (" + (/work permit|working papers/.test(L) ? "work permit" : "under 18") + ", not work authorization): " + (adult ? "you are 18 or older (Options) -> " + (exact ? '"' + exact + '", the reply it asks for' : "N/A") + " (blue)" : "18 or older is not Yes in Options, left for you") + ": " + f.label.slice(0, 80));
      }
      if (!adult) return NEEDS;
      return ruled("minors", FIX(exact || "N/A"));
    }
    // Non-disclosure / confidentiality / non-solicitation / non-compete agreements to explain ("If you are subject to a
    // non-disclosure agreement, non-solicitation agreement ... please explain. If not, please reply N/A."): yours, from
    // Options "Restrictive agreements (NDA, non-compete, non-solicit)" (`answers.restrictiveAgreements`, blank by default =
    // left for you). "None" = the reply the question names (N/A), else "No"; anything else = your text (a yes / no: Yes).
    if (NDA_Q.test(L) && ["text", "textarea", "radio", "dropdown", "checkgroup"].includes(f.type)) {
      const v = String(a.restrictiveAgreements || "").trim();
      const none = /^(none|no|n ?a|not applicable)$/i.test(norm(v));
      const text = ["text", "textarea"].includes(f.type);
      const ans = !v ? null : none ? (exact || (text ? "None" : "No")) : text ? v : "Yes";
      if (!namedLogged.has("nda|" + f.label)) {
        namedLogged.add("nda|" + f.label);
        dbg("restrictive agreements (NDA / non-solicit / non-compete): " + (!v ? "not set in Options, left for you (never Claude)" : (none ? "none in Options" : '"' + v.slice(0, 60) + '" in Options') + ' -> "' + String(ans).slice(0, 60) + '"' + (none && exact ? " (the reply the question asks for)" : "") + " (blue)") + ": " + f.label.slice(0, 80));
      }
      return ans ? FIX(ans) : NEEDS;
    }
    // "How many companies / employers have you worked for?": the distinct employers in your work history (experiences +
    // previous employers, the same company once), blue, never learned. A qualified count ("since graduating", "in the
    // past 5 years", "full-time", "excluding internships") is never computed: your learned answer for that exact
    // qualifier (learning.js `findLearnedFor`), else yellow, never Claude.
    const LRC = globalThis.AAF_LEARN_RULES;
    if (LRC?.COUNT_EMPLOYERS.test(L) && ["radio", "dropdown", "checkgroup", "text"].includes(f.type)) {
      if (LRC.countQualifier(L)) return undefined;
      const seen = [];
      for (const x of historyJobs(p)) if (!seen.some((s) => sameCompany(s, x.company))) seen.push(x.company);
      if (!namedLogged.has("empcount|" + f.label)) {
        namedLogged.add("empcount|" + f.label);
        dbg(`employer count: ${seen.length} distinct employers in your work history (${seen.join(", ") || "none"}) (blue): ${f.label.slice(0, 80)}`);
      }
      if (f.type === "text") return FIX(String(seen.length));
      return FIX({ choose: countChoice(seen.length), text: String(seen.length), what: "employer count" });
    }
    const named = namedEmployerAnswer(f, p);
    if (named !== undefined) return named;
    // Willingness to work on government / defense projects (Kestrel: "Are you open to contributing to projects across all
    // levels of government, including federal?" was classified military / government history and got your "never
    // employed by government" No): a preference, not employment history. Options "Open to government / defense
    // projects" (`answers.govProjects`, Yes / No / blank); blank = yellow, never Claude, never learned.
    if (GOV_PROJECTS.test(L) && !GOV_KINDS.some(([, , re]) => re.test(L))) {
      const v = String(a.govProjects || "").trim();
      if (!namedLogged.has("govproj|" + f.label)) {
        namedLogged.add("govproj|" + f.label);
        dbg(`government / defense projects (willingness, not employment history): ${v ? `Options "${v}" (blue)` : "not set in Options, left for you (never Claude)"}: ${f.label.slice(0, 80)}`);
      }
      return v ? FIX(f.type === "checkbox" ? v === "Yes" : v) : NEEDS;
    }
    const gov = govHistoryAnswer(f, p);
    if (gov !== undefined) return gov;
    if (GOV_ATTEST.test(L)) return ATTEST;
    // Notice period for the current employer ("What is your notice period?", "How much notice do you need to
    // give?"): Options "Notice period for current employer" (blank = left for you), blue, never Claude, never learned.
    if (globalThis.AAF_LEARN_RULES?.NOTICE_Q.test(L) && !/^if\b/.test(L)) {
      const np = a.noticePeriod?.trim();
      if (!namedLogged.has("notice|" + f.label)) {
        namedLogged.add("notice|" + f.label);
        dbg(`notice period: ${np ? `"${np}" from Options (blue)` : "not set in Options, left for you"}: ${f.label.slice(0, 80)}`);
      }
      if (!np) return NEEDS;
      return FIX(f.type === "checkbox" ? undefined : np);
    }
    // Start date / availability ("desired start date", "when can you start", "earliest start date", notice period): always
    // yellow, never a learned answer or Claude (dates go stale; only the user knows). AVAILABILITY_Q is in
    // shared/learning.js (and background.js, for the learned-answer purge).
    if (AAF.AVAILABILITY_Q?.test(L)) {
      if (!namedLogged.has("avail|" + f.label)) {
        namedLogged.add("avail|" + f.label);
        dbg(`start date / availability: left for you, never sent to Claude: ${f.label.slice(0, 80)}`);
      }
      return NEEDS;
    }
    // Compensation ("salary expectations", "desired / expected salary / pay / compensation", "hourly rate", "salary
    // range"): always yours, like the start date: yellow, never a learned answer, Claude or a draft. Not single
    // checkboxes or notices ("I have read the pay transparency notice": the notice rule's).
    if (globalThis.AAF_LEARN_RULES?.COMPENSATION_Q.test(L) && f.type !== "checkbox" && !(/\b(notice|transparency|policy|disclosure)\b/.test(L) && /\b(acknowledge|have read|i understand|i agree|i confirm|have reviewed)\b/.test(L))) {
      if (!namedLogged.has("comp|" + f.label)) {
        namedLogged.add("comp|" + f.label);
        dbg(`compensation: left for you, never sent to Claude: ${f.label.slice(0, 80)}`);
      }
      return NEEDS;
    }

    // Gating questions that reveal the education / work blocks (Melodex: "Do you have a university degree, or are you
    // studying for one?", "Do you have work experience, including internships?"): profile facts, answered in the first
    // pass so the blocks appear before the main fill. Yes when the profile has an entry (a plain "Do you have a degree?"
    // only once you've graduated); otherwise left for you. Blue, never Claude.
    const choiceType = ["radio", "dropdown", "checkbox", "checkgroup"].includes(f.type);
    if (choiceType && /^(do you have|have you (got|completed|earned|obtained))( a| any)? (university |college |undergraduate |bachelor s |higher education |academic )?degree\b(?! in\b)/.test(L)) {
      const edu = (p.education || []).filter((x) => x.school);
      const orStudying = /\bstudying for (one|a degree)\b|\bor (are you )?(currently )?(studying|pursuing|enrolled|working towards?)\b/.test(L);
      const now = studentNow(p);
      const yes = edu.length && (orStudying || now === false);
      if (!namedLogged.has("hasdeg|" + f.label)) {
        namedLogged.add("hasdeg|" + f.label);
        dbg(`degree question: ${edu.length} education entr${edu.length === 1 ? "y" : "ies"} in your profile${orStudying ? " (the question includes studying for one)" : now ? ", still studying" : ""} -> ${yes ? "Yes (blue)" : "left for you"}: ${f.label.slice(0, 80)}`);
      }
      return yes ? FIX(f.type === "checkbox" ? true : "Yes") : NEEDS;
    }
    if (choiceType && /^(do you have|have you had)( any)? (prior |previous |professional |relevant |paid |industry )?(work|professional|industry|job) experience\b/.test(L)) {
      const n = (p.experiences || []).filter((x) => x.company || x.title).length;
      if (!namedLogged.has("haswork|" + f.label)) {
        namedLogged.add("haswork|" + f.label);
        dbg(`work experience question: ${n} experience entr${n === 1 ? "y" : "ies"} in your profile -> ${n ? "Yes (blue)" : "left for you"}: ${f.label.slice(0, 80)}`);
      }
      return n ? FIX(f.type === "checkbox" ? true : "Yes") : NEEDS;
    }
    // "Add another company?", "Would you like to add a second degree?": Yes only when the profile has more entries than
    // the form shows blocks for (the revealed block is then filled from the next entry); otherwise No. Blue, never Claude.
    const addMore = choiceType && L.match(/^(do you want to |would you like to |do you have |)?(add|include)? ?(another|a second|an additional|more|a 2nd) (company|employer|job|role|position|work experience|experience|internship|degree|school|education|university|qualification)\b/);
    if (addMore) {
      const isEdu = /degree|school|education|university|qualification/.test(addMore[4]);
      const entries = isEdu ? (p.education || []).filter((x) => x.school).length : (p.experiences || []).filter((x) => x.company || x.title).length;
      const anchor = isEdu ? /\b(school|university|college|institution)\b/ : /^(most recent |current |previous |last |latest )?(company|employer|organi[sz]ation)( name)?$/;
      const shown = (ctx.fieldValues?.() || []).filter((x) => anchor.test(norm(x.label || "")) && !/\?$/.test(String(x.label || "").trim())).length;
      const yes = entries > shown;
      if (!namedLogged.has("addmore|" + f.label)) {
        namedLogged.add("addmore|" + f.label);
        dbg(`add another ${isEdu ? "degree" : "company"}: ${entries} in your profile, ${shown} block${shown === 1 ? "" : "s"} on the form -> ${yes ? "Yes" : "No"} (blue): ${f.label.slice(0, 80)}`);
      }
      return FIX(f.type === "checkbox" ? yes : yes ? "Yes" : "No");
    }
    // Employment type ("Employment type", "Are you looking for a full-time role or an internship?", "Type of position":
    // Full-time / Internship / Contract / Open to both): Options "Employment type preference" (`answers.employmentType`),
    // with its usual wordings as ordered steps. Blank = left for you; never Claude.
    if ((choiceType || f.type === "text") && L.length <= 160 && (/\b(employment|job|position|contract|engagement) type\b|\btype of (employment|position|contract|engagement|job|opportunity|role you are looking for)\b/.test(L) || /\b(full time|part time|internship|contract|freelance)\b.{0,50}\b(or|vs)\b.{0,50}\b(full time|part time|internship|contract|freelance)\b/.test(L))) {
      const pref = (a.employmentType || "").trim();
      if (!namedLogged.has("emptype|" + f.label)) {
        namedLogged.add("emptype|" + f.label);
        dbg(`employment type: ${pref ? `"${pref}" from Options (blue)` : "Employment type preference not set in Options, left for you (never Claude)"}: ${f.label.slice(0, 80)}`);
      }
      if (!pref) return NEEDS;
      const WORDS = {
        "Full-time": [["Full-time", "Full time", "Fulltime", "Full-time role", "Permanent", "Full-time employment"]],
        Internship: [["Internship", "Intern", "Internship role", "Summer internship"]],
        Contract: [["Contract", "Contractor", "Freelance", "Contract role"]],
        "Open to both": [["Open to both", "Both", "Either", "Open to either", "Open to all", "Any", "No preference"]],
      };
      const steps = WORDS[pref] || [[pref]];
      return FIX(f.type === "text" ? pref : { steps, what: "employment type" });
    }
    // Outside activities to disclose ("Are you currently engaged in side businesses, board positions, ... academic
    // commitments ... while employed? If yes, provide details"; Claude answered Yes): yours, never Claude, never a
    // guess. Left for you. Not a relationships question that also lists outside interests (BlackRidge: "Do you have a
    // Personal Relationship with a current BlackRidge employee ..." was logged as an outside activity): relationships
    // take it (your learned answer for that company, else yellow; never Claude).
    if (!globalThis.AAF_LEARN_RULES?.RELATIONSHIP_Q.test(L) && /\b(side (business(es)?|hustles?|projects? for (pay|compensation))|outside (business(es)?|employment|activities|interests|work)|board (positions?|seats?|memberships?|of directors)|other (employment|business(es)?|commitments|jobs?)|second(ary)? (job|employment)|moonlighting|consulting (engagements?|work|arrangements?)|academic commitments?|advisory (roles?|positions?)|financial interests?)\b/.test(L) &&
      /\b(currently|while|during|engaged|involved|hold|have|any|disclose|provide details)\b/.test(L)) {
      if (!namedLogged.has("disclose|" + f.label)) {
        namedLogged.add("disclose|" + f.label);
        dbg(`disclosure (outside activities): left for you, never sent to Claude: ${f.label.slice(0, 80)}`);
      }
      return NEEDS;
    }
    // "How many prior internships have you had / completed?" (Nimbus): your experiences whose title says Intern /
    // Internship, the current one included unless Options "Count a current internship as prior" is No. Choice
    // fields: the option whose count / range holds it (0 / 1 / 2 / 3+, "None", "1-2", "3 or more"); text: the
    // number. Blue, never Claude.
    if (/\bhow many\b( \w+){0,3} internships?\b|\bnumber of( \w+){0,2} internships?\b/.test(L) && ["radio", "dropdown", "checkgroup", "text"].includes(f.type)) {
      const withCurrent = a.countCurrentIntern !== "No";
      const ints = (p.experiences || []).filter((x) => /\bintern(ship)?\b/i.test(x.title || "") && (withCurrent || !x.current));
      if (!namedLogged.has("interns|" + f.label)) {
        namedLogged.add("interns|" + f.label);
        dbg(`internships: ${ints.length} (${ints.map((x) => `${x.title} at ${x.company}${x.current ? ", current" : ""}`).join("; ") || "no Intern titles in your experiences"}${withCurrent ? "" : "; a current one not counted (Options)"}) (blue): ${f.label.slice(0, 80)}`);
      }
      if (f.type === "text") return FIX(String(ints.length));
      return FIX({ choose: countChoice(ints.length), text: String(ints.length), what: "internships" });
    }
    // Role / team interests ("What type of engineering role are you interested in?", "Which teams interest you?";
    // choice fields): the areas checked in Options "Role interests", mapped onto this form's options (shared/
    // prefmap.js: the synonym map, then Haiku for options it can't place). Blue; nothing checked = left for you.
    // Never learned, never the regular Claude call.
    if (globalThis.AAF_LEARN_RULES?.ROLE_INTEREST_Q?.test(L) && !/\b(office|location|city|shift|schedule)\b/.test(L) && ["checkgroup", "radio", "dropdown"].includes(f.type)) {
      const areas = (Array.isArray(p.roleInterests) ? p.roleInterests : []).filter(Boolean);
      if (!namedLogged.has("roles|" + f.label)) {
        namedLogged.add("roles|" + f.label);
        dbg(`role interests: ${areas.length ? `your areas ${show(areas)} (Options), blue` : "nothing checked in Options, left for you (never Claude)"}: ${f.label.slice(0, 80)}`);
      }
      if (!areas.length) return NEEDS;
      return FIX({ prefMap: { areas, what: "role interests" } });
    }
    // Citizenship of OTHER countries (Saleshub, export control: "Are you a citizen, national or permanent resident of
    // Iran, Cuba, North Korea or Syria?" went to Claude, which said Yes; with "export control" in the label the
    // U.S.-person rule said Yes). Checked before every citizenship / work-authorization / U.S.-person rule, which may
    // only say Yes when the named country is yours: a question naming countries, none of them the United States, is
    // decided here. Any embargoed country named (Iran, Cuba, North Korea, Syria, Crimea, ...) and Options "US citizen"
    // = Yes with a U.S. address: No (blue), never Claude. Other countries only ("Are you a citizen of Canada?"): left
    // for you (you might hold a second citizenship), never Claude. Naming the United States: the usual rules.
    const otherCountries = ["radio", "dropdown", "checkgroup", "text"].includes(f.type) ? namedCountries(L) : [];
    // Not when the question itself is about U.S. status ("Are you a U.S. person (not a citizen of Iran ...)?").
    if (otherCountries.length && !otherCountries.some((c) => US_NAME.test(c)) && !/\b(u s|us) (person|citizen)s?\b|\bcitizens? of the (united states|u s)\b/.test(L)) {
      const embargo = otherCountries.filter((c) => SANCTIONED.test(c));
      const homeUS = US_NAME.test(norm(p.country || "").replace(/^the /, "")) || /^united states/.test(norm(p.country || ""));
      const no = embargo.length && a.citizen === "Yes" && homeUS;
      if (!namedLogged.has("othercountry|" + f.label)) {
        namedLogged.add("othercountry|" + f.label);
        dbg(`citizenship of other countries: asks about [${otherCountries.join(", ")}]${embargo.length ? " (embargoed)" : ""}; ${no ? "you are a U.S. citizen with a U.S. address (Options) -> No (blue)" : embargo.length ? `US citizen "${a.citizen || "not set"}", country "${p.country || "not set"}" in Options: left for you` : "not your country; left for you (never the U.S. citizenship answer, never Claude)"}: ${f.label.slice(0, 80)}`);
      }
      return no ? FIX("No") : NEEDS;
    }
    // Informational notices about hiring to acknowledge (Saleshub: "I understand that upon employment, proof of
    // legal right to work in the US and completion of an I-9 form will be required." was left yellow as an
    // attestation): like a candidate notice, the acknowledging option (checkbox checked), blue, never Claude. Only
    // statements ("I understand / acknowledge ...", "Please note ...", "Upon employment ...") about I-9 / E-Verify /
    // proof of the right to work; true attestations (your answers are truthful, debarment, post-government
    // restrictions) stay yellow.
    if (["radio", "dropdown", "checkgroup", "checkbox"].includes(f.type) && HIRE_NOTICE.test(L) && /^(i (hereby )?(understand|acknowledge|am aware)|please note|note|upon (employment|hire)|if (hired|offered))\b/.test(L) && !/\btruthful|\b(true|accurate|complete|correct)\b|\bdebar|\bpost government|\bfalsif|\bmisrepresent/.test(L)) {
      if (!namedLogged.has("ack|" + f.label)) {
        namedLogged.add("ack|" + f.label);
        dbg(`notice acknowledgment (employment eligibility notice, not an attestation): ${f.label.slice(0, 80)} (blue, never Claude)`);
      }
      if (f.type === "checkbox") return { value: true, review: true };
      return FIX({ choose: ackOption, text: "I acknowledge", what: "notice acknowledgment" });
    }
    // Years of experience ("How many years of experience do you have with Python?") and attestation questions
    // asked as a choice or in text ("Do you verify your responses are true and complete?", "I agree that ...";
    // single consent checkboxes keep the consent rule): yours every time, never learned, never Claude.
    const LR = globalThis.AAF_LEARN_RULES;
    // Total professional experience ("How many years of professional experience (non-internship and non-academic)?",
    // Agentix): computed from the work history when the question leaves internships out: full-time roles only (each
    // entry's type: Options, else from its title: Intern = internship, Fellow = fellowship, Teaching / Research
    // Assistant, Tutor, Grader = academic; else full-time), overlapping spans counted once, whole years; choice fields
    // by range ("< 1" for 0), blue, logged with the entries counted and left out. The plain question (internships not
    // excluded) is yours: whether they count is your call. Skill-specific years ("with Python") stay yellow.
    const pro = proYears(L);
    if (pro && ["text", "radio", "dropdown", "checkgroup"].includes(f.type)) {
      if (!pro.excludesInterns) {
        if (!namedLogged.has("proyears|" + f.label)) {
          namedLogged.add("proyears|" + f.label);
          dbg("professional experience (internships not excluded): whether they count is yours, left for you (never Claude): " + f.label.slice(0, 80));
        }
        return NEEDS;
      }
      const r = fullTimeYears(p);
      if (!namedLogged.has("proyears|" + f.label)) {
        namedLogged.add("proyears|" + f.label);
        dbg("professional experience (non-internship, non-academic): " + r.years + " year" + (r.years === 1 ? "" : "s") + " from " + (r.counted.length ? r.counted.join("; ") : "no full-time roles") + (r.left.length ? "; not counted: " + r.left.join("; ") : "") + " (blue): " + f.label.slice(0, 80));
      }
      if (f.type === "text") return FIX(String(r.years));
      return FIX({ choose: countChoice(r.years), text: String(r.years), what: "years of professional experience" });
    }
    // An "acknowledgment" about where you'd work ("I acknowledge that Perceptix has an in-office culture, and that I am
    // willing and able to work in the location listed on the job description"): not a legal attestation; the office
    // attendance rule decides it from the job location (below). True attestations (accurate information, background
    // checks, ...) stay here.
    // Also a statement naming where the role is ("I understand that this role is based in NYC.", HCT; "I acknowledge
    // this role is located in <place>", "this role requires being in <place>"): where you'd work, not an attestation.
    const placeQ = ["radio", "dropdown", "checkbox", "checkgroup", "text"].includes(f.type) ? placeAsked(L, f.label) : "";
    const officeAck = LR && LR.ATTEST_Q.test(L) && !LR.YEARS_Q.test(L) && (OFFICE_Q.test(L) || !!placeQ || /\b(in ?office|on ?site|in person) (culture|work|presence|requirement|policy|role|environment)\b|\b(work|working|be based|live) (in|from|at) the location (listed|stated|posted|described|shown)\b|\blocation (listed|stated|posted) (on|in) the (job description|posting|job posting)\b/.test(L));
    if (officeAck && !namedLogged.has("officeack|" + f.label)) {
      namedLogged.add("officeack|" + f.label);
      dbg(`office acknowledgment (where you'd work, not a legal attestation): the office attendance rule decides: ${f.label.slice(0, 80)}`);
    }
    if (LR && !officeAck && f.type !== "checkbox" && (LR.YEARS_Q.test(L) || LR.ATTEST_Q.test(L)) && !/\bsignature\b|\btyp(e|ing) (in )?(my|your) (full |legal )?name\b/.test(L)) {
      if (!namedLogged.has("yours|" + f.label)) {
        namedLogged.add("yours|" + f.label);
        dbg(`${LR.YEARS_Q.test(L) ? "years of experience" : "attestation"}: left for you, never Claude: ${f.label.slice(0, 80)}`);
      }
      return NEEDS;
    }
    // Highest education level: some college until the expected graduation date, a bachelor's after it.
    if (HIGHEST_EDU.test(L) && !/^(are|do|have|will|is|did) you\b/.test(L) && ["dropdown", "radio", "checkgroup", "text"].includes(f.type)) {
      const h = highestEducation(p, /\b(received|completed|earned|obtained|attained|awarded|achieved)\b/.test(L));
      if (!namedLogged.has("highedu|" + f.label)) {
        namedLogged.add("highedu|" + f.label);
        dbg(`highest education level${h?.received ? " (received / completed)" : ""}: ${h ? `expected graduation ${p.expectedGraduation} is ${h.done ? "past" : "ahead"} -> ${h.steps.map((s) => s[0]).join(" | ")} (blue)` : "no expected graduation date in your profile, left for you"}`);
      }
      if (!h) return NEEDS;
      return FIX(f.type === "text" ? h.steps[0][0] : { steps: h.steps, what: "highest education level" });
    }
    // Your own local / technical / vocational high school (iCIMS HMSY: "Name of Local Technical High School
    // Attended", "Did you graduate from a Technical School?"): facts about your history that aren't in the
    // profile. Left for you, never Claude.
    if (/\blocal (technical )?high school\b|\btechnical (high )?school\b|\bvocational\b/.test(L)) {
      if (!namedLogged.has("hs|" + f.label)) {
        namedLogged.add("hs|" + f.label);
        dbg(`high school / technical school question: about your own schooling, left for you (never sent to Claude): ${f.label.slice(0, 80)}`);
      }
      return f.required ? NEEDS : SKIP;
    }
    // "Are you graduating from a bachelor's or master's degree program in 2027?" (Gem / Nuvix): a yes / no
    // fact. Yes when a year in the question is the expected graduation year and, if the question names
    // degree levels, one of them is yours (from the first education entry's degree; bachelor's when it
    // can't be told). No otherwise. Blue, never Claude.
    if (["radio", "dropdown", "checkbox"].includes(f.type) && /^(are|will) you (be )?(graduating|completing|finishing)\b/.test(L) && /\b20\d\d\b/.test(L) && p.expectedGraduation) {
      const gy = String(parseDate(p.expectedGraduation).year || "");
      const years = L.match(/\b20\d\d\b/g);
      const levels = [/bachelor|undergrad/.test(L) && "bachelor", /master|mba/.test(L) && "master", /ph ?d|doctor/.test(L) && "phd"].filter(Boolean);
      const deg = norm(String((p.education || [])[0]?.degreeOptions || (p.education || [])[0]?.degree || "").split("\n")[0]);
      const mine = /master|mba/.test(deg) ? "master" : /ph ?d|doctor/.test(deg) ? "phd" : "bachelor";
      const yes = years.includes(gy) && (!levels.length || levels.includes(mine));
      if (!namedLogged.has("grady|" + f.label)) {
        namedLogged.add("grady|" + f.label);
        dbg(`graduation question: asks ${show(years)}${levels.length ? " " + show(levels) : ""}; you graduate ${gy} (${mine}) -> ${yes ? "Yes" : "No"} (blue)`);
      }
      return FIX(f.type === "checkbox" ? yes : yes ? "Yes" : "No");
    }
    // "Is your degree in Computer Science?", "Is your major Computer Science, Computer Engineering, or a
    // related field?", "Are you majoring in X?": X against the field of study (first education entry),
    // Yes / No, blue, never Claude. A list matches any of its fields (whole phrases either way:
    // "Engineering" covers "Computer Engineering"). Broad wording only ("a related field", "a STEM
    // field", "a technical field") can't be judged: left for you, never Claude.
    const degQ = L.match(/^(?:is|was) your (?:degree|major|field of study|area of study)(?: program)?(?: in| a| an)? (.+)$|^are you (?:majoring|studying|pursuing a (?:degree|major)) in (.+)$/);
    if (degQ && ["radio", "dropdown", "checkbox", "text"].includes(f.type) && (p.education || [])[0]?.field) {
      const field = p.education[0].field;
      const asked = (degQ[1] || degQ[2]).split(/,| or | and /).map((x) => x.replace(/^(a|an|the) /, "").trim()).filter(Boolean);
      const BROAD = /\b(stem|technical|quantitative|related|similar|equivalent|relevant|other)\b/;
      const real = asked.filter((x) => !BROAD.test(x));
      const hit = real.find((x) => norm(x) === norm(field) || hasPhrase(field, x) || hasPhrase(x, field));
      const answer = hit ? "Yes" : real.length < asked.length ? null : "No";
      if (!namedLogged.has("degq|" + f.label)) {
        namedLogged.add("degq|" + f.label);
        dbg(`degree field question: asks ${show(asked)}; your field is "${field}" -> ${answer ? `${answer} (blue)` : "broad wording, left for you"}`);
      }
      if (!answer) return NEEDS;
      return FIX(f.type === "checkbox" ? answer === "Yes" : answer);
    }
    // "Do you have a bachelor's degree in Computer Science, Computer Engineering, or closely related STEM
    // field?" (Empirica; went to Claude, "No"): the listed fields against the field of study (as above).
    // A match before the expected graduation: an in-progress option ("In progress", "Currently pursuing",
    // "Expected 2027") when there is one (blue), else Yes outlined YELLOW for you to confirm; after it, Yes
    // (blue). No match: No (blue), or yellow when the list also says "related / STEM field". A degree level
    // the question names that isn't yours: yellow. Never Claude.
    const haveDeg = /^(do|will) you (currently )?(have|hold|possess)\b|^have you (earned|completed|obtained|received)\b/.test(L) &&
      String(f.label || "").match(/\b(?:degree|diploma)s?\s+(?:in|of)\s+(.+?)\s*\??\s*$/i);
    if (haveDeg && (p.education || [])[0]?.field) {
      const field = p.education[0].field;
      const asked = haveDeg[1].split(/,|\bor\b|\band\b|\//i).map((x) => norm(x).replace(/^(a|an|the|any|other) /, "")).filter(Boolean);
      const BROAD = /\b(stem|technical|quantitative|related|similar|equivalent|relevant|other)\b/;
      const real = asked.filter((x) => !BROAD.test(x));
      const hit = real.some((x) => x === norm(field) || hasPhrase(field, x) || hasPhrase(x, field) || AAF.sameField?.(x, field));
      const levels = [/bachelor|undergrad|\bbs\b|\bba\b/.test(L) && "bachelor", /master|mba|\bms\b/.test(L) && "master", /ph ?d|doctor/.test(L) && "phd", /associate/.test(L) && "associate"].filter(Boolean);
      const deg = norm(String(p.education[0].degreeOptions || p.education[0].degree || "").split("\n")[0]);
      const mine = /master|mba/.test(deg) ? "master" : /ph ?d|doctor/.test(deg) ? "phd" : /associate/.test(deg) ? "associate" : "bachelor";
      const now = studentNow(p);
      const gy = String(parseDate(p.expectedGraduation || "").year || "");
      const say = (m) => {
        if (namedLogged.has("havedeg|" + f.label)) return;
        namedLogged.add("havedeg|" + f.label);
        dbg(`degree-in-field question: asks ${show(asked)}${levels.length ? " " + show(levels) : ""}; your field is "${field}" (${mine}) -> ${m}`);
      };
      if (levels.length && !levels.includes(mine)) { say("not your degree level, left for you"); return NEEDS; }
      if (!hit) {
        if (real.length < asked.length) { say("no listed field matches and the list says related / STEM, left for you"); return NEEDS; }
        say("No (blue)");
        return FIX(f.type === "checkbox" ? false : "No");
      }
      if (now === null) { say("no expected graduation date in your profile, left for you"); return NEEDS; }
      if (!["radio", "dropdown", "checkgroup", "checkbox"].includes(f.type)) { say("not a choice field, left for you"); return NEEDS; }
      if (!now) { say(`graduated ${p.expectedGraduation} -> Yes (blue)`); return FIX(f.type === "checkbox" ? true : "Yes"); }
      if (f.type === "checkbox") { say(`expected graduation ${p.expectedGraduation} is ahead -> checked, yellow so you confirm`); return { value: true, review: true, confirm: true }; }
      const IN_PROGRESS = /\b(in progress|currently (pursuing|enrolled|working towards?|studying|completing)|pursuing|in the process|anticipated|expected|will (graduate|complete|have|receive|earn)|working towards?|currently a student|enrolled)\b/;
      let inProgress = false;
      const choose = (texts) => {
        const pos = texts.filter((t) => !/\b(no|not|never|none)\b/.test(norm(t)));
        const ip = pos.filter((t) => IN_PROGRESS.test(norm(t)) && (!/\b20\d\d\b/.test(t) || (gy && new RegExp(`\\b${gy}\\b`).test(t))));
        if (ip.length) { inProgress = true; return ip.find((t) => gy && t.includes(gy)) || ip[0]; }
        inProgress = false;
        return pos.find((t) => norm(t) === "yes") || pos.find((t) => /^yes\b/.test(norm(t))) || null;
      };
      say(`expected graduation ${p.expectedGraduation} is ahead -> an in-progress option (blue), else Yes (yellow so you confirm)`);
      return { value: { choose, text: "Yes", what: "degree-in-field" }, review: true, confirm: () => !inProgress };
    }

    // "Still Student?" / "Currently attending" / "I currently study here" checkbox (any portal; Ashby's education
    // block handles its own in the education step): checked while the expected graduation is ahead, blue.
    if (f.type === "checkbox" && STUDENT_NOW.test(`${L} ${norm(f.optionText || "")}`)) {
      const now = studentNow(p);
      if (!namedLogged.has("student|" + f.label)) {
        namedLogged.add("student|" + f.label);
        dbg(`currently a student: ${now === null ? "no expected graduation date in your profile, left for you" : `expected graduation ${p.expectedGraduation} is ${now ? "ahead -> checked" : "past -> unchecked"} (blue)`}: ${f.label.slice(0, 80)}`);
      }
      return now === null ? NEEDS : FIX(now);
    }
    // E-signature ("Signature", "Electronic signature", "Type your full name to certify", "By typing my
    // name below I certify ..."): an attestation in the candidate's own hand. Never filled (no learned
    // answer, no Claude), left yellow, on every portal. ("Signature" used to get the full name.)
    // "Signature date" / "Date signed" fields are not this rule.
    // Checkboxes too (iCIMS Perimeter: a "Signature" checkbox, "checking the checkbox above is equivalent to a
    // handwritten signature", went to Claude): the label, the box's own text and its card.
    const sigText = f.type === "checkbox" ? norm(`${f.label} ${f.optionText || ""} ${f.cardText || ""}`) : L;
    if (!/\bdate\b/.test(L) && f.type !== "date" && f.type !== "file" &&
      (f.type === "text" || f.type === "textarea" || f.type === "checkbox" ? true : /^(e ?signature|electronic signature|signature)$/.test(L)) &&
      /\b(e ?signature|electronic(ally)? sign(ature|ed)?|digital signature|signature)\b|\btype (in )?your (full |legal )?name\b|\bby typing (in )?(my|your) name\b|\btyping (my|your) (full )?name\b|\b(equivalent to|serves? as|constitutes?) (a |an |my |your )?(legal |legally binding )?(handwritten |written )?signature\b/.test(sigText)) {
      if (!namedLogged.has("sig|" + f.label)) {
        namedLogged.add("sig|" + f.label);
        dbg(`e-signature: left for you, never filled: ${f.label.slice(0, 80)}`);
      }
      return NEEDS;
    }

    // SMS / text-message consent as a dropdown or radio ("Do you agree to HMSY communicating to you via SMS
    // Text Message ...?"): an opt-in, never answered for you (checkboxes: the consent rule skips them too).
    if (f.type !== "checkbox" && /\b(sms|text messages?|texting)\b/.test(L) && /\b(agree|consent|opt|communicat|receive|contact)/.test(L)) {
      if (!namedLogged.has("sms|" + f.label)) {
        namedLogged.add("sms|" + f.label);
        dbg(`SMS / text-message consent: left ${f.required ? "for you" : "blank"}: ${f.label.slice(0, 80)}`);
      }
      return f.required ? NEEDS : SKIP;
    }
    // Consent to be contacted by EMAIL about this or other opportunities (Lexidos: "Do you consent to being
    // contacted by email about this or other opportunities?" went to Claude): Yes, blue. A question that also
    // names SMS / text stays with the SMS rule above (left for you); newsletters / marketing / job alerts are
    // not this rule.
    if (/\b(consent|agree|opt ?in|permission|willing)\b/.test(L) && /\be ?mail(s|ed)?\b/.test(L) && /\b(contact(ed)?|reach(ed)? out|communicat\w*|notif\w*)\b/.test(L) && !/\b(newsletter|marketing|promotional|job alerts?|talent (community|network)|sms|text)\b/.test(L) && ["radio", "dropdown", "checkgroup", "checkbox"].includes(f.type)) {
      if (!namedLogged.has("emailconsent|" + f.label)) {
        namedLogged.add("emailconsent|" + f.label);
        dbg(`email contact consent: Yes (blue): ${f.label.slice(0, 80)}`);
      }
      return FIX(f.type === "checkbox" ? true : { steps: [["Yes"], ["I consent", "I agree", "I do consent"]], exclude: /\b(no|not|decline|do not|don t)\b/, what: "email contact consent" });
    }
    // An account login / user name (iCIMS's combined page: "Login", autocomplete=username): the email.
    if (f.type === "text" && (/^(login|log in|user ?name|user id|login (name|id|e ?mail))$/.test(L) || f.ctrl?.getAttribute?.("autocomplete") === "username")) return p.email;
    // Former / other names ("Former Last Name"): none in the profile, left blank (not the last-name rule).
    if (S(/\b(former|previous|prior|other|birth) (last |family |first )?(name|surname)s?\b|\balias(es)?\b|\bnames? used\b/)) return SKIP;
    if (S(/^address type$/)) return ["Home"];
    if (["text", "textarea"].includes(f.type) && SCHOOL_NOT_LISTED.test(L)) {
      if (!namedLogged.has("schoolnl|" + f.label)) {
        namedLogged.add("schoolnl|" + f.label);
        dbg(`school not listed: decided after the School field (education step), never Claude: ${f.label.slice(0, 80)}`);
      }
      return SKIP;
    }
    if (f.type === "checkbox" && /preferred name/.test(L)) return p.preferredName ? true : SKIP;
    // A plain preferred-name text field (Greenhouse). Workday's preferred-name fields are "First Name"
    // under a Preferred Name heading, handled below.
    // A plain preferred-name text field ("Preferred Name", "What is your preferred first name?", "What
    // name do you go by?"). "Preferred last name" is not this: it falls to the last-name rule.
    if (f.type === "text" && /\bpreferred (first )?name\b|name (do )?you go by|\bnickname\b/.test(L) && !/last name|surname|family name/.test(L))
      return p.preferredName || SKIP;
    if (S(/preferred name|middle name|suffix|prefix|salutation|phone extension|employee id|address line 3|\bcounty\b/)) return SKIP;
    // Someone else's name (an emergency contact, a reference, the employee who referred you, a manager): never yours.
    if (/\bname\b/.test(LP || L) && /\b(emergency|reference|references|referee|referr\w*|manager|supervisor|parent|guardian|spouse|partner s|recruiter|contact person|employee who|interviewer|signatory)\b/.test(LP || L) && L.length <= 80) {
      if (!namedLogged.has("othername|" + f.label)) {
        namedLogged.add("othername|" + f.label);
        dbg(`name field for someone else, not your name: left for you: ${f.label.slice(0, 80)}`);
      }
      return f.required ? NEEDS : SKIP;
    }
    // First AND last name in one box ("First and Last Name", "First & Last Name", "Full name (first and last)"; Dodecal:
    // the last-name rule matched "Last Name" inside the label and typed only the last name): the full name, checked
    // before the first / last rules. A preferred one gets the preferred first name.
    if (f.type === "text" && LP.length <= 60 && /\bfirst (and |or |\/ )?(last|family|sur) ?names?\b|\bfirst (and |\/ )?last\b|\bfull (legal )?name\b|\bcomplete name\b|\bname (first and last|first last)\b|\b(given|first) (and )?(family|sur) ?name\b/.test(norm(String(f.label || "").replace(/&/g, " and ")))) {
      const first = isPreferred(f) ? p.preferredName || p.firstName : p.firstName;
      if (!namedLogged.has("fullname|" + f.label)) {
        namedLogged.add("fullname|" + f.label);
        dbg(`full name: the label asks for first and last name -> "${`${first || ""} ${p.lastName || ""}`.trim()}"${isPreferred(f) ? " (your preferred first name)" : ""}: ${f.label.slice(0, 80)}`);
      }
      return `${first || ""} ${p.lastName || ""}`.trim() || undefined;
    }
    if (SC(/first name|given name|firstname/)) return isPreferred(f) ? p.preferredName || p.firstName : p.firstName;
    if (SC(/last name|family name|surname|lastname/)) return p.lastName;
    if (/^(full |legal )?name$|^your name$/.test(L)) return `${p.firstName || ""} ${p.lastName || ""}`.trim();
    if (SC(/e ?mail/)) return p.email;
    // Current / most recent employer (Lever "Current company", input name "org"): the experience marked
    // current, else the first (most recent) entry.
    // Also "Current or previous employer" / "Current or previous job title" (Stitchly): the most recent
    // experience's company / title, blue, never Claude (no experience in the profile: left for you).
    const recentJob = () => (p.experiences || []).find((x) => x.current) || (p.experiences || [])[0];
    const factLog = (v) => {
      if (!namedLogged.has("fact|" + f.label)) {
        namedLogged.add("fact|" + f.label);
        dbg(`profile fact: ${f.label.slice(0, 60)} -> ${v ? `"${v}" (most recent experience, blue)` : "no experience in your profile, left for you"}`);
      }
    };
    const NOW_OR_BEFORE = "^(your )?(current|most recent|present|latest)( or (previous|most recent|last|former|past|prior))? ";
    // Also longer wordings ("name of the company where you are currently or most recently employed", "What is your
    // current or most recent role title?"): from the work history, current job first, never Claude.
    const essay = /^(describe|tell us|explain|why|how)\b/.test(L);
    const companyNow = !essay && L.length <= 160 && /\b(company|employer|organi[sz]ation)\b.{0,40}\b(currently|most recently|presently)( or most recently)? (employed|working|work)\b|\b(name of )?(your )?(current|most recent|present)( or (most recent|previous|last|former|past))? (company|employer|organi[sz]ation)( name)?\b/.test(L);
    const titleNow = !essay && L.length <= 160 && /\b(current|most recent|present)( or (most recent|previous|last|former|past))? (job |role |position )?title\b|\btitle (of|for|at) (your )?(current|most recent) (role|job|position)\b|\b(current|most recent)( or most recent)? (role|position) title\b/.test(L);
    if (f.type === "text" && companyNow && !titleNow && !new RegExp(NOW_OR_BEFORE + "(company|employer|organi[sz]ation)( name)?$").test(L)) {
      const v = recentJob()?.company;
      factLog(v);
      return v ? FIX(v) : NEEDS;
    }
    if (f.type === "text" && titleNow && !new RegExp(NOW_OR_BEFORE + "(job )?(title|position|role)( title)?$").test(L)) {
      const v = recentJob()?.title;
      factLog(v);
      return v ? FIX(v) : NEEDS;
    }
    if (f.type === "text" && (f.nid === "org" || new RegExp(NOW_OR_BEFORE + "(company|employer|organi[sz]ation)( name)?$").test(L))) {
      const v = recentJob()?.company;
      factLog(v);
      return v ? FIX(v) : NEEDS;
    }
    if (f.type === "text" && new RegExp(NOW_OR_BEFORE + "(job )?(title|position|role)( title)?$").test(L)) {
      const v = recentJob()?.title;
      factLog(v);
      return v ? FIX(v) : NEEDS;
    }
    if (S(/phone device|device type|^phone type$/)) {
      // Ordered fallback list, tried like Degree against the full option list (NVEXA only offers
      // "Home" / "Home Cellular"). Plain Home / Landline / Work / Business are never chosen.
      // A profile saved before the list existed holds just "Mobile": use the default list then.
      const raw = !p.phoneType || /^mobile$/i.test(p.phoneType.trim()) ? DEFAULT_PHONE_TYPES : p.phoneType;
      const alts = splitAlts(raw);
      return { steps: alts.map((x) => [x]), what: "phone device type", exclude: /^(home|landline|work|business)$/ };
    }
    if (S(/country phone code|phone (country )?code|countryphonecode|^country code$/)) {
      // Workday's own name carries the code ("United States of America (+1)"), so try that first;
      // the bare country name is the fallback. Rippling's list reads "+1 US".
      const pc = p.phoneCountry || "United States of America";
      const us = /^united states( of america)?$/i.test(pc.trim());
      const withCode = /\(\+\d+\)/.test(pc) ? pc : us ? "United States of America (+1)" : null;
      return [withCode, pc, ...(us ? ["+1 US", "US +1", "+1"] : [])].filter((x, i, a) => x && a.indexOf(x) === i);
    }
    // ^...$ is tested on the label alone: T() sees "label | automation id", so ^phone$ never matched it.
    // "Contact Number" (Ashby), "Mobile", "Cell", "Telephone", "Contact no.": the phone too (it went to Claude).
    if (SC(/phone number|phonenumber|mobile number|cell number|telephone number|contact number|contact phone|contact no\b|mobile no\b|phone no\b/) ||
      /^(mobile|cell|cellphone|cell phone|mobile phone|telephone|tel|phone|primary phone|personal phone|home phone)( (number|no|num|#))?$|^contact (number|no|num|#)$/.test(L)) return phoneInFormat(p.phone, f.label);
    if (S(/address line 1|addressline1|street address/)) return p.address1;
    if (S(/address line 2|addressline2/)) return p.address2;
    // Location fields ("Location", "Location (City)", "Current Location", any portal) belong ONLY to
    // the application location; the home-city rules never fill them ("Location (City)" once got
    // the home city from the city rule, and a city search picked the same-named city in Michigan).
    //   autocomplete / dropdown: type the search term, pick only an EXACT match from the ordered list;
    //   plain text: the first accepted name; not set in Options: blank (left for the user).
    // Office / location preference ("Which office are you primarily interested in?", "Preferred office",
    // "Which location would you like to be considered for?"): the application-location rule, blue.
    // "Additional offices you are open to": only same-city options are selected; none = yellow.
    // Matched on the label's FIRST sentence (HCT: "Which HCT office are you primarily interested in being
    // considered for? Please consider the location this job is posted in ..." was 170 characters, over
    // the length cap), with up to three words naming the company between "which / what / preferred"
    // and "office / location" ("Which HCT office", "Which of our offices", "What Harbor Creek Trading
    // location").
    // Office hubs near you (WRENLY: "Are you located within 50 miles of one of the following office hubs?" [San Francisco
    // (Union Square), New York (Manhattan), Austin, Texas, ..., No, but willing to relocate, No, and not willing to
    // relocate] was "office preference: no step matched"). A choice field asking whether you're within N miles of / near /
    // within commuting distance of one of a list of hubs / offices / locations: the option that is where you live
    // (samePlace with your address; NYC addresses = New York City), blue; none = the relocation option your Options
    // relocate setting names ("No, but willing to relocate" / "No, and not willing to relocate", else a plain "No" for
    // No), blue; relocate blank, or no such option = left for you, never Claude.
    const HUB_NEAR = /\bwithin (\d+|a few|an?) ?(miles?|mi|km|kilometers?|minutes?|hours?|hour|mile radius)\b|\b(located|live|living|based|reside|residing) (near|close to|in or near|in or around|around)\b|\b(commut\w*|driving|reasonable) distance\b|\bcommutable\b|\bnear(by)? (one of|any of|either of|the following|our)\b/;
    const HUB_LIST = /\b(one of|any of|either of|the following|which of)\b( \w+){0,4} (hubs?|offices|locations|cities|sites|campuses|metros?)\b|\bhubs?\b|\b(which|what) (\w+ ){0,3}(office|offices|location|locations|city|cities|site|sites)\b/;
    if (["radio", "dropdown", "checkgroup"].includes(f.type) && L.length <= 250 && HUB_NEAR.test(L) && HUB_LIST.test(L)) {
      const once = (k, msg) => {
        if (!namedLogged.has(k + "|" + f.label)) {
          namedLogged.add(k + "|" + f.label);
          dbg(msg);
        }
      };
      const RELOC = /\b(relocat\w*|move|moving)\b/;
      const NOT_HUB = /^(no|none|other|yes|n a|not applicable|prefer not|i prefer|decline|i don t|i do not)\b|\bnone of\b/;
      const negated = (t) => /\b(not|unwilling|unable|cannot|can t|won t|wont|never)\b/.test(norm(t).replace(/^no\b\s*/, ""));
      once("hubrule", `office hubs near you: "${L.slice(0, 90)}" (${f.type}); the hub where you live, else your relocate setting`);
      const choose = (texts) => {
        const hubs = texts.filter((t) => !NOT_HUB.test(norm(t)) && !RELOC.test(norm(t)));
        const mine = hubs.find((t) => isHome(t, p));
        if (mine) {
          once("hub", `office hubs: "${mine}" is where you live (${homeName(p)}), blue`);
          return mine;
        }
        const where = homeKey(p) ? `none of [${hubs.join(", ")}] is where you live (${homeName(p)})` : "your address has no city";
        const reloc = texts.filter((t) => RELOC.test(norm(t)));
        const rel = a.relocate || "";
        const pick = rel === "Yes" ? reloc.find((t) => !negated(t)) : rel === "No" ? reloc.find((t) => negated(t)) || texts.find((t) => norm(t) === "no") : null;
        once("hub", `office hubs: ${where}; ${!rel ? "no relocate setting in Options, left for you (never sent to Claude)" : pick ? `relocate ${rel} in Options -> "${pick}" (blue)` : `relocate ${rel} in Options, but no option says so, left for you`}`);
        return pick || null;
      };
      return FIX({ choose, text: "", what: "office hubs" });
    }
    const first = norm(String(f.label || "").split(/[?.!](?:\s|$)/)[0]);
    const yesNoQ = /^(are|do|have|will|is|would|can|could) you\b/.test(first);
    // The classifier's category (main.js classifyAsks: a question no rule matched, classified "relocation / office"):
    // the office rules decide from the field's options. A list of places (2+ options that aren't yes / no / other)
    // is an office preference; a Yes / No question is office attendance (decided from the office it names or the
    // job location, as usual); relocation questions keep the relocation rule.
    const forcedOffice = ctx.category === "relocation / office";
    const fOpts = (ctx.options || []).map(norm).filter(Boolean);
    const optYesNo = forcedOffice && fOpts.length > 0 && fOpts.every((t) => /^(yes|no)\b/.test(t));
    const optPlaces = forcedOffice && !optYesNo && fOpts.filter((t) => !/^(yes|no|other|none|n a|not applicable|prefer not)\b/.test(t)).length >= 2;
    // "(s)" and plurals: "Which office location(s) are you interested in?" (Flarewave; norm makes it "location s").
    const officePref = (forcedOffice && optPlaces && !/relocat/.test(L)) || !yesNoQ && first.length <= 120 &&
      /\b(which|what) (\w+ ){0,3}(office|location|city)(?: ?s)? (are you|would you|do you)\b.*\b(interested|prefer|like|considered|apply|applying|want)|\b(preferred|primary) (\w+ ){0,3}(office|work location|location)\b|\b(office|location) preference\b|\bgeographic(al)? (location |area |region )?preferences?\b|\bwhere would you (prefer|like) to (work|be based|be located)\b|\bconsidered for\b.*\b(office|location)\b|\b(office|location)\b.*\bconsidered for\b/.test(first);
    // "Which additional HCT offices are you open to ...", "Which office locations are you open to?".
    const extraOffices = !yesNoQ && first.length <= 120 &&
      (/\b(additional|other|secondary)\b.*\b(offices?|locations?)\b.*\b(open to|consider|interested)\b/.test(first) || /\b(which|what) (\w+ ){0,3}(offices?|office locations?)\b.*\bopen to\b/.test(first));
    // The office rule's decision, once per label: what it matched, or that a question about an office
    // didn't match (so a miss that falls through to Claude is visible).
    if (/\boffices?\b/.test(first) && !namedLogged.has("officerule|" + f.label)) {
      namedLogged.add("officerule|" + f.label);
      const kind = extraOffices ? "additional offices" : officePref ? "office preference" : OFFICE_Q.test(L) ? "office attendance" : f.desc && L.length <= 150 && OFFICE_Q.test(f.desc) ? "office attendance, from the description" : "";
      dbg(`office rule: "${first.slice(0, 100)}" ${kind ? `-> ${kind} (${f.type})` : "-> no match (normal rules, then Claude)"}`);
    }
    // Ranked preferences ("First / Second / Third location preference"): the first is the office preference
    // rule; later ones take Options "Additional office preference" (blank = left for you). An option is never
    // chosen twice across the set: options already chosen in another preference field are excluded.
    const rank = !yesNoQ ? rankedPreference(first) : 0;
    if (rank >= 2 && ["dropdown", "radio", "checkgroup", "text"].includes(f.type)) {
      const extra = a.extraOfficePref?.trim();
      const taken = (ctx.fieldValues?.() || []).filter((x) => x.c !== f.c && x.v && rankedPreference(norm(String(x.label).split(/[?.!](?:\s|$)/)[0]))).map((x) => x.v);
      const dup = extra && taken.some((t) => norm(t) === norm(extra));
      if (!namedLogged.has("rank|" + f.label)) {
        namedLogged.add("rank|" + f.label);
        dbg(`location preference ${rank}: ${!extra ? "Additional office preference not set in Options, left for you" : dup ? `"${extra}" is already chosen in another preference, ${f.required ? "left for you" : "left blank"}` : `"${extra}" (Options, blue)`}${taken.length ? `; already chosen: ${show(taken)}` : ""}`);
      }
      if (!extra) return NEEDS;
      if (dup) return f.required ? NEEDS : SKIP;
      if (f.type === "text") return FIX(extra);
      const esc = (t) => norm(t).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return FIX({ steps: splitAlts(extra).map((x) => [x]), what: `location preference ${rank}`, exclude: taken.length ? new RegExp(`^(${taken.map(esc).join("|")})$`) : null });
    }
    if (rank === 1 && !namedLogged.has("rank|" + f.label)) {
      namedLogged.add("rank|" + f.label);
      dbg(`location preference 1: the office preference rule`);
    }
    if (officePref || extraOffices) {
      const { search, list } = appLocation(p);
      const names = splitAlts(list);
      const what = extraOffices ? "additional offices" : "office preference";
      if (!names.length) {
        if (!namedLogged.has("noloc|" + f.label)) {
          namedLogged.add("noloc|" + f.label);
          dbg(`${what}: application location not set in Options, left for you (never sent to Claude): ${f.label.slice(0, 80)}`);
        }
        return NEEDS;
      }
      if (["dropdown", "radio", "checkgroup"].includes(f.type) || f.kind === "autocomplete")
        return FIX({ steps: names.map((m) => [m]), search, exact: true, near: list, what });
      // Text (Saleshub: "What is your preferred geographic location?" went to Claude): your first accepted location
      // ("New York, NY"), nothing added (never "open to relocating"), blue, never Claude.
      if (["text", "textarea"].includes(f.type) && !extraOffices) {
        if (!namedLogged.has("locpref|" + f.label)) {
          namedLogged.add("locpref|" + f.label);
          dbg(`location preference: "${names[0] || search}" (your first accepted location in Options, blue, never Claude): ${f.label.slice(0, 80)}`);
        }
        return FIX(names[0] || search);
      }
      if (["text", "textarea"].includes(f.type)) return undefined;
    }
    // Also "Where are you based?", "Which city are you currently located in?", "Current city".
    // A label that STARTS with the question is the location question whatever follows it: "Location (where you will be
    // based while working)" (Tessera, 47 characters) missed the 40-character cap, was classified relocation / office and
    // left yellow. The parenthetical / first sentence is set aside; "Location", "Current location", "Your location",
    // "Where are you (currently) based / located", "Where will you be based / working from".
    const L0 = norm(String(f.label || "").replace(/\([^)]*\)/g, " ").split(/[?.!:](?:\s|$)/)[0]);
    // The classifier said relocation / office about a search box with no options yet (Ashby's location
    // autocomplete) whose label names a place to be: the location rule too.
    const classifiedPlace = forcedOffice && !fOpts.length && ["dropdown", "text"].includes(f.type) && /\b(location|based|located|city|metro|home base|where (will|would|do) you (be )?(work|live|based|located))\b/.test(L);
    const asksLocation =
      classifiedPlace ||
      (L0.length <= 40 && /^(current |your |primary |preferred work )?location\b|^where (are|will|would) you (be )?(currently )?(based|located|working from|work from)\b/.test(L0) && !/^(are|do|have|will|is|would|can|could) you\b/.test(L0)) ||
      (/\blocation\b/.test(L) && L.length <= 40) ||
      // Not a first-person statement ("I am currently based in the USA." with Yes / No: the residence rule).
      (L.length <= 90 && !/^(are|do|have|will|is|would|can|could) you\b/.test(L) && !/^i (am |currently |presently )/.test(L) &&
        /\bwhere (are|do) you (currently )?(based|located|live|living|reside)|\b(which|what) (city|location|metro|area)\b.*\b(based|located|live|living|reside)\b|\bcurrent (city|location)\b|\bcurrently based\b/.test(L));
    if (asksLocation) {
      // A search term with a blank list accepts the search term itself; neither set = left for you (never Claude).
      const { search, list } = appLocation(p);
      const names = splitAlts(list);
      if (!names.length) {
        if (!namedLogged.has("noloc|" + f.label)) {
          namedLogged.add("noloc|" + f.label);
          dbg(`location: application location not set in Options, left for you (never sent to Claude): ${f.label.slice(0, 80)}`);
        }
        return NEEDS;
      }
      // near: with no exact match, an option for the same city counts (blue).
      if (["dropdown", "radio", "checkgroup"].includes(f.type) || f.kind === "autocomplete") return { steps: names.map((m) => [m]), search, exact: true, near: list, what: "location" };
      return names[0];
    }
    // One field for the whole address, only when the form doesn't split it into line / city / zip.
    if (/^(current |home |permanent |residential )?(mailing |street |home )?address$/.test(L) && ["text", "textarea"].includes(f.type) && !ctx.splitAddress)
      return fullAddress(p) || undefined;
    // iCIMS: "Address" / "Address 2" next to City / Zip fields.
    if (f.type === "text" && ctx.splitAddress && /^(street )?address( 1)?$/.test(L)) return p.address1;
    if (f.type === "text" && /^address 2$/.test(L)) return p.address2 || "";
    // Not a yes / no question that names a city ("Do you currently live in New York City?" got the home city).
    if (S(/\bcity\b|municipality/) && !/^(do|are|have|will|is|would|can|could) you\b/.test(L)) return p.city;
    if (S(/postal|\bzip\b/)) return p.zip;
    // "Do you currently reside in the United States?" / "... in New York?" (Stackline AV): Yes when the place is
    // your address country (any of its names), state or city; anything else is left for you. Never Claude.
    // Only pure residence questions: one that also mentions an office, in-office days or relocation (Garnet
    // Health: "Are you currently based in or planning to relocate to the NYC area and willing to work in our
    // NYC office 3 days a week?") belongs to the office-attendance / relocation rule below.
    // Also "based out of / located near / living within / in or around" ("Are you based out of the New York City Metro
    // area?" was classified residence and left yellow), and any yes / no question the classifier calls residence (the
    // place after its last in / out of / within / near / around).
    const RESIDE_RX = /^(?:(do|are) you|i(?: am)?) (currently |presently )?(reside|live|living|residing|based|located|work(?:ing)?)(?: out of| in or (?:near|around)| near| around| within| in) (the )?(.+)$/;
    const resideIn = ["radio", "dropdown", "checkgroup", "checkbox", "text"].includes(f.type) && (L.match(RESIDE_RX) ||
      (ctx.category === "residence" && /^(do|are|have|is|will) you\b|^i (am |currently |presently )/.test(L) && (() => {
        const m = L.match(/^.*\b(?:in|out of|within|near|around|local to|close to)\s+(the\s+)?(.+)$/);
        return m ? [m[0], "", "", "", m[1] || "", m[2]] : null;
      })()));
    const officeQ = OFFICE_Q.test(L) || /\boffices?\b|\bdays? (a|per|each|every) week\b/.test(L);
    // Commuting is not living there ("Are you within commuting distance of Jersey City?"): never the residence rule.
    // Naming an office ("... of our Stamford office") = the office-attendance rule below; otherwise left for you.
    const commuteQ = /\bcommut\w*\b|\b(driving|reasonable|travel(l?ing)?) distance\b|\bwithin \d+ (miles?|minutes?|km)\b/.test(L) && /^(are|do|can|could|would|will|is) you\b/.test(L);
    if (commuteQ && !officeQ) {
      if (!namedLogged.has("commute|" + f.label)) {
        namedLogged.add("commute|" + f.label);
        dbg(`commute question (no office named; commuting is not living there, so not the residence rule): left for you, never sent to Claude: ${f.label.slice(0, 80)}`);
      }
      return NEEDS;
    }
    // Naming an office only counts when the office attendance rule reads the question; otherwise it's yours (WRENLY's hub
    // question logged "the office attendance rule decides", which then didn't match it).
    if (commuteQ && !OFFICE_Q.test(L) && !placeAsked(L, f.label)) {
      if (!namedLogged.has("commute|" + f.label)) {
        namedLogged.add("commute|" + f.label);
        dbg(`commute question mentioning an office, but not one the office attendance rule reads: left for you, never sent to Claude: ${f.label.slice(0, 80)}`);
      }
      return NEEDS;
    }
    if (commuteQ && !namedLogged.has("commute|" + f.label)) {
      namedLogged.add("commute|" + f.label);
      dbg(`commute question naming an office: the office attendance rule decides: ${f.label.slice(0, 80)}`);
    }
    // Each place a question names, checked on its own against your address (Deepwave: "either the san francisco bay or
    // new york city area" was matched as one phrase): split on or / and / commas / slashes; "the", "either", "area",
    // "metro", "region", "bay", "tri-state" set aside; SF / Bay Area = San Francisco. Per part: your country, state or
    // city (NYC's boroughs and NYC zips count as New York City); a borough against YOUR borough (your city, else your
    // zip: Queens 110-111 / 113-114 / 116, Brooklyn 112, Manhattan 100-102, Staten Island 103, Bronx 104; unknown =
    // can't tell); a time zone against your state's (only states wholly in one zone; else can't tell, never No);
    // "the tri-state area" for a NY / NJ / CT address. Yes = a part is yours (logged which and how); No = every part is
    // a plain place and none is yours; anything else (can't tell, not a place: "a time zone compatible with EST") = yours.
    const homes = [...(p.country ? countryAlts(p).map(String) : []), p.country, p.state, STATE_ABBR[norm(p.state || "")], p.city].filter(Boolean).map((x) => norm(x));
    const stAbbr = (STATE_ABBR[norm(p.state || "")] || String(p.state || "")).toUpperCase();
    const BOROUGHS = { manhattan: "manhattan", "new york county": "manhattan", brooklyn: "brooklyn", "kings county": "brooklyn", queens: "queens", "queens county": "queens", bronx: "bronx", "the bronx": "bronx", "staten island": "staten island", "richmond county": "staten island" };
    const homeBorough = (() => {
      if (BOROUGHS[norm(p.city || "")]) return BOROUGHS[norm(p.city || "")];
      if (!homeInNYC(p)) return "";
      const z = String(p.zip || "").slice(0, 3);
      return { 100: "manhattan", 101: "manhattan", 102: "manhattan", 103: "staten island", 104: "bronx", 112: "brooklyn", 110: "queens", 111: "queens", 113: "queens", 114: "queens", 116: "queens" }[z] || "?";
    })();
    const ZONE_OF = {
      eastern: "CT DE DC GA ME MD MA NH NJ NY NC OH PA RI SC VT VA WV", central: "AL AR IL IA LA MN MS MO OK WI",
      mountain: "AZ CO MT NM UT WY", pacific: "CA NV WA", alaska: "AK", hawaii: "HI",
    };
    const ZONE_NAMES = { eastern: "eastern", et: "eastern", est: "eastern", edt: "eastern", central: "central", ct: "central", cst: "central", cdt: "central", mountain: "mountain", mt: "mountain", mst: "mountain", mdt: "mountain", pacific: "pacific", pt: "pacific", pst: "pacific", pdt: "pacific" };
    const PLACE_ALIAS = { sf: "san francisco", "sf bay": "san francisco", "bay area": "san francisco", bay: "san francisco", "silicon valley": "san jose", la: "los angeles", dc: "washington", "d c": "washington" };
    // true = yours, false = not yours, null = can't tell; `how` says which branch decided.
    function placePart(x) {
      const tz = x.match(/^(eastern|central|mountain|pacific|et|ct|mt|pt|est|edt|cst|cdt|mst|mdt|pst|pdt)( standard)?( time)?( zone)?$/);
      if (tz && (tz[3] || tz[4] || x.length <= 3)) {
        const zone = ZONE_NAMES[tz[1]];
        const mine = Object.entries(ZONE_OF).find(([, sts]) => sts.split(" ").includes(stAbbr))?.[0];
        return { home: mine ? (mine === zone ? true : null) : null, how: `time zone (${mine ? `your state ${stAbbr} is ${mine}` : `can't tell your time zone from ${stAbbr || "your address"}`})` };
      }
      if (/^tri ?state$/.test(x)) return { home: /^(NY|NJ|CT)$/.test(stAbbr) ? true : false, how: `tri-state area (your state ${stAbbr || "?"})` };
      if (BOROUGHS[x]) {
        if (!homeInNYC(p)) return { home: false, how: "borough (your address isn't in New York City)" };
        if (homeBorough === "?") return { home: null, how: "borough (can't tell yours from your address)" };
        return { home: BOROUGHS[x] === homeBorough, how: `borough (yours is ${homeBorough})` };
      }
      const v = PLACE_ALIAS[x] || x;
      const home = homes.some((h) => h === v || h === x) || isHome(v, p) || isHome(x, p);
      return { home, how: "country / state / city" };
    }
    const placeLike = (x) => /^[a-z][a-z .'-]*$/.test(x) && x.split(" ").length <= 4 && !/\b(distance|commut\w*|time ?zones?|hours?|miles?|minutes?|radius|reasonable|driving|travel|office|offices|our|your|you|any|which|where|same|compatible|timezone|location|following|authorized|legally|eligible|willing|relocate|relocating)\b/.test(x);
    function checkPlaces(placeText) {
      const place = norm(placeText).replace(/\b(currently|today|at this time|right now)\b/g, "").replace(/\s+/g, " ").trim();
      // "one of the following countries: United States, Canada" (2Password): the list, read from the label itself, where
      // its commas still separate the places (the normalized text has lost them).
      const listed = /\bthe following (countries|states|cities|locations|places|areas|regions)\b/.test(place) &&
        (f.label.match(/\bthe following (?:countries|states|cities|locations|places|areas|regions)\b\s*:?\s*(.+?)\??$/i) || [])[1];
      const raw = listed ? norm(listed.replace(/[,;/]+/g, " or ")) : place;
      const clean = (x) => {
        let y = x;
        for (let i = 0; i < 4; i++) y = y.replace(/^(the|either|greater)\s+/, "").replace(/\s+(metropolitan area|metro area|metro|area|region|bay area|bay)$/, "").replace(/\s+tri ?state$/, "").trim();
        return y;
      };
      const parts = raw.replace(/^(either|any of|one of)\s+/, "").split(/\s*(?:,|\/|&|\bor\b|\band\b)\s*/).map(clean).filter(Boolean);
      const checks = parts.map((x) => ({ part: x, ...placePart(x) }));
      const hit = checks.find((c) => c.home === true);
      const unsure = checks.find((c) => c.home === null);
      const decision = hit ? "yes" : !unsure && checks.length && parts.every((x) => placeLike(x) || BOROUGHS[x]) ? "no" : "yours";
      return { place, parts, checks, hit, unsure, decision };
    }
    const resideLog = (r, branch) => `${branch}: asks about ${show(r.parts)}; ${r.decision === "yes" ? `"${r.hit.part}" is where you live (${r.hit.how}), Yes (blue)` : r.decision === "no" ? `none is where you live (${[...new Set(r.checks.map((c) => c.how))].join("; ")}), No (blue)` : r.unsure ? `"${r.unsure.part}": ${r.unsure.how}, left for you` : `"${r.place}" isn't only places, left for you`}`;
    // "Are you located in or willing to relocate to Seattle?": Yes when you live in a place it names; otherwise the
    // relocation rule (your relocate setting) decides, never a plain No from the residence rule.
    const relocToo = resideIn && !officeQ && /\brelocat/.test(L);
    if (relocToo) {
      const placeText = (L.match(/\brelocat\w* (?:to|in|near) (?:the )?(.+)$/) || [])[1] || resideIn[5];
      const r = checkPlaces(placeText);
      if (r.decision === "yes") {
        if (!namedLogged.has("reside|" + f.label)) {
          namedLogged.add("reside|" + f.label);
          dbg(`${resideLog(r, "residence or relocation (you live there)")}: ${f.label.slice(0, 80)}`);
        }
        if (["radio", "dropdown", "checkgroup"].includes(f.type)) f.yesAlt = livesHereAlt(p);
        return FIX(f.type === "checkbox" ? true : "Yes");
      }
      if (!namedLogged.has("reside|" + f.label)) {
        namedLogged.add("reside|" + f.label);
        dbg(`residence or relocation: you don't live in ${show(r.parts)}; the relocation rule (your relocate setting) decides, never a plain No: ${f.label.slice(0, 80)}`);
      }
    }
    const officeToo = resideIn && officeQ;
    if (officeToo && !namedLogged.has("reside|" + f.label)) {
      namedLogged.add("reside|" + f.label);
      dbg(`residence and office attendance rules both match; the office attendance rule decides: ${f.label.slice(0, 80)}`);
    }
    if (resideIn && !officeToo && !relocToo) {
      const r = checkPlaces(resideIn[5]);
      if (!namedLogged.has("reside|" + f.label)) {
        namedLogged.add("reside|" + f.label);
        dbg(`${resideLog(r, "residence")}: ${f.label.slice(0, 80)}`);
      }
      if (r.decision === "yes" && ["radio", "dropdown", "checkgroup"].includes(f.type)) f.yesAlt = livesHereAlt(p);
      if (r.decision === "yes") return FIX(f.type === "checkbox" ? true : "Yes");
      if (r.decision === "no") return FIX(f.type === "checkbox" ? false : "No");
      return NEEDS;
    }
    // "Please select the country where you currently reside" (Stitchly): a profile fact, blue, never Claude.
    if (/\bcountry (where|in which) you (currently )?(reside|live)\b|\bcountry of (current )?residence\b|\bcountry you (currently )?(live|reside) in\b|^current country( of residence)?$/.test(L)) {
      if (!namedLogged.has("fact|" + f.label)) {
        namedLogged.add("fact|" + f.label);
        dbg(`profile fact: ${f.label.slice(0, 60)} -> your country (blue)`);
      }
      return p.country ? FIX(f.type === "text" ? p.country : countryAlts(p)) : NEEDS;
    }
    if (/^country( region)?$/.test(L) || /countrydropdown/.test(f.nid)) return f.type === "text" ? p.country : countryAlts(p);
    if (S(/\bstate\b|province|countryregion/) && !/united states|statement/.test(L)) return p.state;
    // Free-text "How / where did you hear about this role / us?" (text or textarea, any portal): a fixed
    // answer from Options ("How did you hear (free text)", default LinkedIn), blue, never Claude or a
    // draft (Ashby / Tenfold: "Where did you hear about this role?" went to drafts and came back null).
    // A referral follow-up in the same label ("If referred, who referred you?", "the name of the
    // employee") is left blank. Dropdowns / search boxes keep the rule below.
    if ((f.type === "text" || f.type === "textarea") && /\b(how|where) did you (first )?(hear|learn|find out|find|come across)\b|\bhow you (first )?(heard|learned|found out|found)\b|\bwhere did you find (this|the|our)\b|^(application |referral |candidate )?source$/.test(L)) {
      if (/referr|who (referred|told)|name of (the |your )?(employee|person|referrer|recruiter)|employee name/.test(L)) return SKIP;
      return FIX(p.hearText?.trim() || "LinkedIn");
    }
    // "Please specify" (iCIMS HMSY, revealed after "How did you hear about us?" = Job Board): when the
    // how-did-you-hear dropdown holds a generic category (Job Board, Social Media, Website, Internet,
    // Other), the follow-up gets the free-text answer (`hearText`, default LinkedIn), blue, never Claude.
    if (L.length <= 90 && /^(please )?(specify|explain)\b|^(which|what) (one|site|website|job board|board|social (media|network)|source)\b|^(source|referral source) (details?|name)$|^(please )?(specify|enter|name) (the |your )?source\b|^other( source)?$|^if (you (selected|chose|picked|answered|responded) (with )?)?other\b.*\b(specify|explain|which|source)\b/.test(L)) {
      const hear = ctx.hearValue?.() || "";
      if (OTHER_FOLLOW.test(L) ? hearOther : HEAR_CATEGORY.test(norm(hear))) {
        const t = p.hearText?.trim() || "LinkedIn";
        if (!namedLogged.has("hearspec|" + f.label)) {
          namedLogged.add("hearspec|" + f.label);
          dbg(`how did you hear: "${hear}" is a category, so "${f.label.slice(0, 60)}" gets "${t}" (blue)`);
        }
        return FIX(f.type === "text" || f.type === "textarea" ? t : { steps: [[t]], what: "how did you hear: specify" });
      }
    }
    // Dropdowns / search boxes: Options "How did you hear about us", an ordered "|" list (an old single
    // value gets the former fallbacks Social Media | Job Board). `what` makes the setters log which one matched.
    // Also "What brought you to this job posting?" (2Password; classified "referral" and left yellow), and a question
    // the classifier calls referral whose options are sources (LinkedIn, Indeed, a job board, the company website).
    const sourceOpts = (ctx.options || []).some((t) => /\b(linkedin|indeed|glassdoor|handshake|job board|company website|careers? (page|site)|social media)\b/i.test(t));
    if (T(/how did you (hear|learn|find)|^(application |referral |candidate |lead |job )?source$|\b(referral|candidate|application|lead|job) source\b|\bsource of (application|referral)\b|\bhow you (first )?(heard|learned|found)\b|\bwhere did you find (this|the|our)\b|\bwhere did you (first )?(hear|learn|find out) (about )?(this|the|our|us)\b|\bwhat brought you (to )?(this|our|us|the)\b/) ||
      (ctx.category === "referral" && sourceOpts && ["dropdown", "radio", "checkgroup"].includes(f.type))) {
      const list = (/\|/.test(p.source || "") ? splitAlts(p.source) : [p.source, "Social Media", "Job Board"]).filter(Boolean);
      list.what = "how did you hear";
      return list;
    }
    // Not an open-ended prompt that also asks for a link ("Tell us about a side project (GitHub link)"): a draft.
    // Link boxes (Melodex: "Link to something you built" got a paragraph): a single-line box whose label asks for a
    // link gets one URL, never prose. LinkedIn / GitHub / portfolio / website labels keep the rules below; any other
    // ("Link to something you built", "Project URL", "Link to your best work", "GitHub link to a project you built")
    // gets your best project link: the first URL in Options "Projects to highlight", else GitHub, else the website.
    // Blue; no link in the profile = yellow (never a draft or Claude).
    // Not a link to something the company sent ("Exercise Submission (Shared URL)" on Parallax: their take-home).
    // Social profiles ("X (formerly Twitter) URL", Instagram, Facebook, TikTok, ...; 2Password's X box got your GitHub):
    // only a link to that network (a profile field for it, or your website when it's on that network); otherwise left
    // blank (yellow when required), never another link, never Claude.
    const SOCIAL = [["x", /\b(x|twitter)\b/, /(^|\/\/|\.)(x|twitter)\.com\//], ["instagram", /\binstagram\b/, /instagram\.com\//], ["facebook", /\bfacebook\b/, /facebook\.com\//], ["tiktok", /\btik ?tok\b/, /tiktok\.com\//], ["threads", /\bthreads\b/, /threads\.net\//], ["mastodon", /\bmastodon\b/, /mastodon/], ["bluesky", /\bbluesky\b/, /bsky\.app\//], ["youtube", /\byoutube\b/, /youtube\.com\//]];
    const social = L.length <= 60 && !/\b(linkedin|git ?hub)\b/.test(L) && /\b(url|profile|handle|link|account|username)\b/.test(L) ? SOCIAL.find(([, rx]) => rx.test(L)) : null;
    if (social && ["text", "textarea"].includes(f.type)) {
      const [net, , dom] = social;
      const own = [p[net], net === "x" ? p.twitter : ""].map((x) => String(x || "").trim()).find(Boolean);
      const v = own || (dom.test(String(p.website || "")) ? p.website.trim() : "");
      if (!namedLogged.has("social|" + f.label)) {
        namedLogged.add("social|" + f.label);
        dbg(`social profile (${net}): ${v ? `"${v}" (blue)` : `no ${net} link in your profile, left blank${f.required ? " (yellow, required)" : ""}; never another link`}: ${f.label.slice(0, 80)}`);
      }
      return v ? FIX(v) : f.required ? NEEDS : SKIP;
    }
    // Generic link fields (Mapleforge, Greenhouse: "Additional links (optional)" with the helper text "Share any relevant
    // links ... such as your GitHub, personal website, online portfolio, or other professional profiles" was "link field:
    // no link in your profile", which offered only the website): additional / other / any relevant links, "Links",
    // "Website / Portfolio", or a link box whose helper text asks for any relevant links / profiles. Your profile links
    // not already used on this form, in order: GitHub, your website / portfolio, LinkedIn. "Used" = another field shows
    // that URL, or the form has a field of its own for it (a LinkedIn / GitHub / website box). A single-line box gets the
    // first unused one; a textarea gets them all, one per line. None left = yellow, never Claude.
    const GENERIC_LINK = /^(additional|other|any|relevant|more|extra|supporting|optional|personal)( (relevant|professional|online|personal))? (links?|urls?)\b|^(links?|urls?)( optional)?$|\b(additional|other|any|more|extra) (relevant |professional |online |personal )?(links|urls|websites|profiles)\b|^(personal )?(website|portfolio)( url| link)? ?(\/|or|and) ?(personal )?(portfolio|website)\b/;
    const descGeneric = !!f.desc && /\b(any|other|additional) (relevant |professional |online )?(links|urls|profiles)\b|\bsuch as your (github|git hub|website|personal website|portfolio)\b/.test(norm(f.desc));
    if (["text", "textarea"].includes(f.type) && !/\blinkedin\b/.test(L) && !LR?.ESSAY_PROMPT?.test(L) && L.length <= 120 &&
      (GENERIC_LINK.test(L) || (isLinkBox(f) && descGeneric))) {
      const url = (x) => String(x || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "");
      const others = (ctx.fieldValues?.() || []).filter((x) => x.c !== f.c);
      const shown = new Set(others.flatMap((x) => String(x.v || "").split(/\s+/)).map(url).filter(Boolean));
      const ownField = (rx) => others.some((x) => {
        const n = norm(x.label || "");
        return n.length <= 60 && rx.test(n) && !GENERIC_LINK.test(n);
      });
      const cands = [
        ["GitHub", p.github, /\bgit ?hub\b/],
        ["your website", p.website, /\b(personal )?(website|portfolio)\b/],
        ["LinkedIn", p.linkedin, /\blinkedin\b/],
      ].filter(([, v]) => String(v || "").trim());
      const why = [];
      const free = cands.filter(([name, v, rx]) => {
        if (shown.has(url(v))) return why.push(`${name} (already on this form)`), false;
        if (ownField(rx)) return why.push(`${name} (has its own field)`), false;
        return true;
      });
      const use = f.type === "textarea" ? free : free.slice(0, 1);
      if (!namedLogged.has("genlink|" + f.label)) {
        namedLogged.add("genlink|" + f.label);
        dbg(`generic link field: ${use.length ? `${use.map(([n, v]) => `${n} "${v.trim()}"`).join(", ")} (blue)` : "no unused link in your profile, left for you (never Claude)"}${why.length ? `; not used: ${why.join(", ")}` : ""}: ${f.label.slice(0, 80)}`);
      }
      return use.length ? FIX(use.map(([, v]) => v.trim()).join("\n")) : NEEDS;
    }
    if (isLinkBox(f) && !/\blinkedin\b/.test(L) && !(/\b(git ?hub|portfolio|personal website|website)\b/.test(L) && !/\b(project|built|made|created|work|demo)\b/.test(L)) &&
      !/\b(exercise|assignment|take home|submission|case study|coding (test|challenge)|homework|document|doc|drive|sheet|slides|video|loom|recording|calendar|scheduling)\b/.test(L)) {
      const urls = String(p.projectsHighlight || "").match(/https?:\/\/[^\s)>\]]+/g) || [];
      // GitHub only for a link to code / a project; any other link box gets the website or is left for you.
      const projecty = /\b(project|built|made|created|work|demo|code|repo|repository|something)\b/.test(L);
      const v = projecty ? urls[0] || p.github || p.website || "" : p.website || "";
      const from = !v ? "" : v === urls[0] ? "the first link in Projects to highlight" : v === p.github ? "GitHub" : "your website";
      if (!namedLogged.has("link|" + f.label)) {
        namedLogged.add("link|" + f.label);
        dbg(`link field: ${v ? `"${v}" (${from}, blue)` : "no link in your profile, left for you"}: ${f.label.slice(0, 80)}`);
      }
      return v ? FIX(v) : NEEDS;
    }
    const openP = OPEN_PROMPT.test(L);
    // A question that names the site isn't a link box ("Have you used GitHub Actions?" got your GitHub URL): a yes / no or
    // essay opening, unless it asks for the URL / profile itself.
    const notLinkAsk = /^(do|does|did|have|has|are|is|were|was|will|would|can|could|how|what|which|why|when|describe|tell|explain)\b/.test(L) && !/\b(url|link|profile|handle|username|page)\b/.test(L);
    if (!openP && !notLinkAsk && M(/linkedin/)) return p.linkedin;
    if (!openP && !notLinkAsk && M(/github/)) return p.github;
    if (!openP && !notLinkAsk && (M(/portfolio|personal website/) || /^(other |personal )?website( url| link)?$/.test(L))) return p.website || p.github;

    // Previous worker
    // "ever worked with / on / in / using ..." is experience, not employment ("Have you ever worked with Kubernetes?" got
    // the previous-worker No); "worked with us / our team" still is.
    if (T(/(previously|ever|formerly) (been )?(worked|employed)(?! (with|on|in|using)\b(?! (us|our company|our team)\b))|former (employee|worker)|previous worker|previousworker|candidateispreviousworker/))
      return FIX(workedHereBefore(p) ? "Yes" : "No");

    // Conditional visa questions ("If on F-1 visa, ...", "If you are on OPT / CPT / H-1B, ...", "If you require
    // sponsorship, ..."; Similis's got the work-authorization "Yes"): they don't apply to a U.S. citizen. N/A
    // ("Not applicable", "I am not on a visa") when offered, else No; blue, never Claude. Before the
    // work-authorization / sponsorship rules, which must never answer them.
    const VISA_IF = /^if (you are |you re |youre |currently )?(currently )?(on|holding|in|hold|have) (an? |the )?(f ?1|j ?1|h ?1 ?b|h ?4|l ?1|l ?2|o ?1|tn|e ?3|opt|cpt|stem opt|student|work|non ?immigrant)\b|^if you (will |would |do |currently )?(now or in the future )?(require|need)( \w+){0,3} (sponsorship|visa)\b|^if (sponsorship|a visa) (is )?(required|needed)\b/;
    if (VISA_IF.test(L) && a.citizen === "Yes") {
      if (!namedLogged.has("visaif|" + f.label)) {
        namedLogged.add("visaif|" + f.label);
        dbg(`visa follow-up: doesn't apply to a U.S. citizen (Options) -> N/A if offered, else No (blue): ${f.label.slice(0, 80)}`);
      }
      if (f.type === "text" || f.type === "textarea") return FIX("N/A");
      if (f.type === "checkbox") return FIX(false);
      return FIX({ steps: [["N/A", "NA", "N.A.", "Not applicable", "Not Applicable", "Does not apply", "I am not on a visa", "Not on a visa", "I am a U.S. citizen", "U.S. citizen"], ["None"], ["No"]], what: "visa follow-up" });
    }
    if (VISA_IF.test(L)) {
      if (!namedLogged.has("visaif|" + f.label)) {
        namedLogged.add("visaif|" + f.label);
        dbg(`visa follow-up: not a U.S. citizen in Options, left for you (never the work-authorization answer, never Claude): ${f.label.slice(0, 80)}`);
      }
      return NEEDS;
    }

    // Work authorization / sponsorship
    if (T(/without (any |the need for |requiring )?(visa |employer |company )?sponsorship/)) return FIXYES(a.workAuth, "work authorization");
    // "If hired, can you provide proof of eligibility?", "Can you provide documentation of your work
    // authorization upon hire?": the work-authorization answer (DataPilot; a follow-up revealed by
    // "Are you legally permitted to work..."). Before the sponsorship rule: "...proof of eligibility to
    // work without sponsorship" is still this question.
    const asksYesNoProof = ["radio", "dropdown", "checkbox"].includes(f.type) || (f.type === "text" && /^(if hired,? )?(can|will|would|are) you\b/.test(L));
    if (asksYesNoProof && T(/\b(proof|documentation|documents|evidence) of (your )?(eligibility|employment eligibility|work authori[sz]ation|authori[sz]ation to work|right to work|identity and (employment )?eligibility)|\b(provide|furnish|submit|present) (proof|documentation|documents|evidence)\b.*\b(eligib|authori[sz]|right to work)/))
      return FIX(a.workAuth);
    // Work authorization / sponsorship naming only other countries ("Are you legally authorized to work in Canada?" got
    // your U.S. Yes: neither rule read the country): your Options answers are about the United States; a question naming
    // countries, none of them the U.S. (with or without "the": the U.S., USA, US), is yours, never Claude. Statements too.
    const workIn = (L.match(/\b(?:work|employment|employed|sponsorship|sponsor|visa)\b(?: \w+){0,4}? (?:in|within|for) (.*)$/) || [])[1] || "";
    const workCountries = workIn ? [...new Set(workIn.match(COUNTRY_RX) || [])] : [];
    const homeIsUS = !p.country || US_NAME.test(norm(p.country).replace(/^the /, "")) || /^united states/.test(norm(p.country));
    if (workCountries.length && homeIsUS && !workCountries.some((c) => US_NAME.test(c)) &&
      /authori[sz]ed to work|legally (authorized|eligible|permitted)|eligible to work|right to work|work authori[sz]ation|sponsor/.test(L)) {
      if (!namedLogged.has("workcountry|" + f.label)) {
        namedLogged.add("workcountry|" + f.label);
        dbg(`work authorization / sponsorship for other countries: asks about [${workCountries.join(", ")}]; your Options answers are for the United States, left for you (never Claude): ${f.label.slice(0, 80)}`);
      }
      return NEEDS;
    }
    // Visa / employment sponsorship only ("Have you secured a sponsorship for your hackathon?" got the sponsorship No):
    // sponsorship tied to a visa / work / status / now or future, needing / requiring a sponsor, or a field named for it.
    // Also needing to obtain / renew / extend / transfer a visa or work permit (BlackRidge: "Will you need to obtain, renew,
    // extend or transfer a visa or work permit in order to commence work ... now or in the future?").
    if (!off("sponsorship") && T(/\b(visa|immigration|employment|work) sponsorship\b|\bsponsorship\b.{0,40}\b(visa|h ?1 ?b|employment|status|immigration|now|future|require|requires|required|need|needs)\b|\b(require|requires|need|needs)\b.{0,50}\bsponsor(ship)?\b|\bsponsor(ed|ing)? (you|your|an? (visa|h ?1 ?b|employment))\b|\bh ?1 ?b\b|\bvisa status\b|^(visa )?sponsorship( required)?$|\| \S*sponsor|\b(need|needs|require|requires)( \w+){0,2} (to )?(obtain|renew|extend|transfer)\b.{0,60}\b(visa|work permit)s?\b/)) return ruled("sponsorship", FIXYES(a.sponsorship, "sponsorship"));
    // Also "presently authorized under U.S. immigration laws to work", "legally authorized ... under immigration
    // law" (Stackline AV), the words in any order.
    if (!off("work authorization") && T(/authori[sz]ed to work|legally (authorized|eligible|permitted)|eligible to work|right to work|work authori[sz]ation|\bauthori[sz]ed\b.{0,60}\bto work\b|\bauthori[sz]ed\b.{0,40}\bimmigration laws?\b|\bimmigration laws?\b.{0,40}\bauthori[sz]ed\b/)) return ruled("work authorization", FIXYES(a.workAuth, "work authorization"));
    if (!off("18 or older") && T(/18 years|at least 18|age of 18|over 18|older than 18|legal working age/)) return ruled("18 or older", FIX(a.over18));
    // "Are you a current DataPilot customer?", "...a prospective customer or partner?": No (blue).
    if (["radio", "dropdown", "checkbox", "text"].includes(f.type) && /^(are|is) (you|your (company|employer|organi[sz]ation)) (currently )?(an? )?((current|existing|former|prospective|active) )*(\w+ ){0,3}(customer|client|partner|reseller|vendor)s?\b/.test(L) && !/domestic partner|life partner|partner of an? (current )?employee/.test(L) &&
      // "Are you a Sherwood customer?" alone is product usage (yours, never Claude): only a business
      // relationship (client, partner, reseller, vendor, a prospective customer, your company) is this rule.
      (/\b(client|partner|reseller|vendor)s?\b|\bprospective\b/.test(L) || /^is your\b/.test(L)))
      return FIX(f.type === "checkbox" ? false : "No");
    // Willing to travel (fixed answer, overrides learned answers): the highest option, Yes, or text.
    if (TRAVEL_Q.test(L) && !/relocat|commut/.test(L) && a.travel) {
      const isText = f.type === "text" || f.type === "textarea";
      if (a.travel === "No") return FIX(isText ? "No" : ["No", "No travel", "0%", "None"]);
      if (isText) return FIX("Yes, up to 100%");
      if (f.type === "checkbox") return FIX(true);
      return FIX({ choose: travelChoice, text: "Yes, up to 100%", what: "willing to travel" });
    }
    // Employment restrictions / non-compete (fixed answer: none).
    if (RESTRICTION_Q.test(L) && a.restrictions === "None") return FIX(exact || (f.type === "text" || f.type === "textarea" ? "No, I have no employment restrictions." : "No"));
    // Relocation, unless it's also an office question ("open to commuting to our NYC or San Francisco office,
    // or willing to relocate to either location?"): then the office rule below decides.
    // "Which locations would you be interested in relocating to?" as checkboxes (Nimbus: [New York, NY, San Francisco,
    // CA]): the options in your accepted locations (office locations + application locations, same city), blue;
    // none = yellow. Not the yes / no relocation answer.
    if (f.type === "checkgroup" && /relocat/.test(L) && /\b(locations?|cities|city|offices?|where|which)\b/.test(L)) {
      const accepted = [a.officeMetro?.trim() || DEFAULT_OFFICE_METRO, appLocation(p).list].filter(Boolean).join(" | ");
      if (!namedLogged.has("reloccities|" + f.label)) {
        namedLogged.add("reloccities|" + f.label);
        dbg(`relocation locations: checking the options in your accepted locations (blue): ${f.label.slice(0, 80)}`);
      }
      return FIX({ checkAll: [], match: (t) => !!inMetro(t, accepted), what: "relocation locations" });
    }
    // Relocating to a place you already live in ("Are you able to relocate to NYC?" with a New York City address):
    // the meaning is "yes, I'm local", whatever the relocate setting says; the option mapper prefers a "local"
    // option ("I am local to the NYC area"), then a yes. Elsewhere the relocate setting's meaning.
    // Not an essay about a past move ("Tell us about a time you relocated for a project" got the relocate Yes).
    if (T(/relocat/) && !OFFICE_Q.test(L) && !LR?.ESSAY_PROMPT.test(L) && !(/\brelocated\b/.test(L) && !/\b(be|get|being) relocated\b/.test(L))) {
      const to = L.match(/\brelocat\w* (?:to|in|near) (?:the )?((?:[a-z]+ ){0,3}[a-z]+)/)?.[1]?.replace(/\b(area|region|metro|office|offices|for|if|this|role|position|or|and)\b.*$/, "").trim() || "";
      const local = !!to && isHome(to, p);
      if (local && ["radio", "dropdown", "checkgroup"].includes(f.type)) {
        if (!namedLogged.has("reloclocal|" + f.label)) {
          namedLogged.add("reloclocal|" + f.label);
          dbg(`relocation: "${to}" is where you live (your address), so the meaning is "yes, local" (blue): ${f.label.slice(0, 80)}`);
        }
        return FIX({ choose: (texts) => yesOption("relocation local", texts, p)?.text || null, text: "Yes", what: "relocation (local)" });
      }
      // Your setting, or yours to answer: a blank relocate setting is yellow, never Claude.
      if (!a.relocate) {
        if (!namedLogged.has("relocblank|" + f.label)) {
          namedLogged.add("relocblank|" + f.label);
          dbg(`relocation: no relocate setting in Options, left for you, never sent to Claude: ${f.label.slice(0, 80)}`);
        }
        return NEEDS;
      }
      return FIXYES(a.relocate, "relocation");
    }
    if (/relocat/.test(L) && OFFICE_Q.test(L) && !namedLogged.has("reloc|" + f.label)) {
      namedLogged.add("reloc|" + f.label);
      dbg(`relocation and office attendance rules both match; the office attendance rule decides: ${f.label.slice(0, 80)}`);
    }
    // Office attendance: Yes (blue) when the JOB is in the accepted metro list (Options, default NYC
    // metro), otherwise left yellow (never learned / Claude). ctx.job = shared/job.js jobInfo().
    // Office attendance mentioning remote ("Are you open to hybrid or remote work?"): yours, never Claude.
    // A short title label ("In-Office Work") whose description asks the question: the description counts.
    // Only the part of the description about the office (f.desc is normalized, so no sentences: the words around the
    // match), not the whole helper text: a long one made label + description too long for the branch below, which
    // then returned nothing without a word (Remedy AI).
    // Its question first ("are / will / can you ..." up to 200 characters, when that's about the office), else 200
    // characters from where the office wording starts.
    const descPart = () => {
      const d = String(f.desc);
      const cut = (i) => {
        const to = d.indexOf(" ", i + 200);
        return d.slice(i, to < 0 ? d.length : to).trim();
      };
      const q = d.search(/\b(are|will|can|could|would|do) you\b/);
      if (q >= 0 && OFFICE_Q.test(cut(q))) return cut(q);
      const m = OFFICE_Q.exec(d);
      return m ? cut(m.index) : d;
    };
    const LQ = f.desc && L.length <= 150 && !OFFICE_Q.test(L) && OFFICE_Q.test(f.desc) ? `${L} ${descPart()}` : L;
    // Classified "relocation / office" with Yes / No options (no relocation in it): office attendance.
    const officeAsk = OFFICE_Q.test(LQ) || !!placeQ || (forcedOffice && optYesNo && !/relocat/.test(L));
    if (officeAsk && /remote/.test(LQ) && LQ.length <= 260 && ["radio", "dropdown", "checkbox", "checkgroup", "text", "textarea"].includes(f.type)) {
      if (!namedLogged.has("office|" + f.label)) {
        namedLogged.add("office|" + f.label);
        dbg(`office attendance: mentions remote, left for you (never Claude): ${f.label.slice(0, 80)}`);
      }
      return NEEDS;
    }
    // Checkbox groups too (Ashby, Cascade Research: "Are you able to work onsite in NYC?" as Yes / No boxes).
    if (officeAsk && LQ.length <= 260 && ["radio", "dropdown", "checkbox", "checkgroup", "text", "textarea"].includes(f.type)) {
      // Your office locations (Options, default NYC metro) plus your accepted application locations.
      const accepted = [a.officeMetro?.trim() || DEFAULT_OFFICE_METRO, appLocation(p).list].filter(Boolean).join(" | ");
      // The office the question names ("work from our Brooklyn, NY office five days a week") decides;
      // otherwise the job's location.
      // Up to three words right before "office", stopping at a preposition / determiner / verb ("able to come
      // into the office" names none; "work from our Brooklyn, NY office" names "brooklyn ny").
      const OFFICE_STOP = /^(our|the|a|an|your|this|that|any|one|of|from|at|in|to|into|come|work|working|be|go|report|commute|able|willing|on|onsite|site|main|local|nearest|closest|hq|headquarters|home|corporate|company|physical|nearby|their|its|my)$/;
      const words = LQ.split(" ");
      // A place the question names without "office" ("be in New York City", "this role is based in NYC") comes first.
      let namedPlace = placeQ;
      // "work onsite / in person / hybrid in NYC", "on-site at our Brooklyn location": the place after it.
      const onsiteIn = !namedPlace && LQ.match(/\b(?:on ?site|in person|in office|hybrid)\b (?:in|at|from) (?:our |the )?((?:[a-z]+ ){0,2}[a-z]+)/);
      if (onsiteIn) namedPlace = onsiteIn[1].replace(/\b(office|offices|location|locations|area|metro|area office)\b.*$/, "").trim();
      if (/^(the|our|an?|one|your|this|that|any|home|least|most|person)$/.test(namedPlace)) namedPlace = "";
      for (let oi = 1; oi < words.length && !namedPlace; oi++) {
        if (!/^offices?$/.test(words[oi])) continue;
        const got = [];
        for (let i = oi - 1; i >= 0 && got.length < 8 && !OFFICE_STOP.test(words[i]); i--) got.unshift(words[i]);
        namedPlace = got.join(" ");
      }
      // A country is no office name ("work from our US office", "our U.S. offices"; Orbital AI: "the question names the
      // "us" office; not in your office locations"): the job location decides.
      if (/^(the )?(us|u s|usa|u s a|united states( of america)?|america|american|uk|u k|united kingdom|britain|great britain|england|canada|india|germany|france|ireland|australia|mexico|japan|singapore|china|brazil|spain|netherlands|israel|poland|sweden|switzerland|europe|european|emea|apac|latam|north america|domestic|international|global|regional)$/.test(namedPlace)) {
        if (!namedLogged.has("officecountry|" + f.label)) {
          namedLogged.add("officecountry|" + f.label);
          dbg(`office attendance: "${namedPlace}" is a country or region, not an office; the job location decides: ${f.label.slice(0, 80)}`);
        }
        namedPlace = "";
      }
      // Several offices named ("based out of our San Francisco or New York office", Remedy AI): the job location says
      // which one this role is in; Yes when that one is in your office locations. No job location (or one naming none
      // of them): Yes when any named office is yours. One office named: it decides, as before.
      const offices = namedPlace.split(/\s*(?: or | and | & |\/|,)\s*/).filter(Boolean);
      // Where you live always counts, even when it isn't in your office locations: a place that is your city (NYC's
      // boroughs, neighborhoods and NYC zips as New York City).
      const homeHit = (places) => {
        const x = places.find((pl) => isHome(pl, p));
        return x ? { part: x, e: `where you live (${homeName(p)})` } : null;
      };
      const jobAt = ctx.job?.location || "";
      let hit = null;
      let why = "";
      if (offices.length > 1) {
        const jobParts = jobAt.split(/\s*(?:;|\||\n|•|\s\/\s| or | and | & )\s*/).filter(Boolean);
        const theOne = offices.filter((o) => jobParts.some((j) => hasPhrase(norm(j), o) || samePlace(j, o)));
        const pool = theOne.length ? theOne : offices;
        hit = inMetro(pool.join(" or "), accepted) || homeHit(pool);
        why = `the question names ${offices.length} offices [${offices.join(", ")}]; ` +
          (theOne.length ? `the job location "${jobAt.slice(0, 100)}" is ${theOne.join(" / ")}` : jobAt ? `the job location "${jobAt.slice(0, 100)}" names none of them, so any of them counts` : "no job location found, so any of them counts");
      } else {
        // The place the question names decides; the job location only when it names none (a "Remote" job location never
        // blocks a named place).
        const jobLoc = namedPlace || jobAt;
        hit = jobLoc ? inMetro(jobLoc, accepted) || homeHit(jobLoc.split(/\s*(?:;|\||\n|•|\s\/\s| or | and | & )\s*/)) : null;
        why = placeQ ? `the question names the place "${namedPlace}" (it decides, not the job location${jobAt ? ` "${jobAt.slice(0, 60)}"` : ""})` : namedPlace ? `the question names the "${namedPlace}" office` :`job location ${jobLoc ? `"${jobLoc.slice(0, 100)}"` : "not found"}`;
      }
      if (!namedLogged.has("office|" + f.label)) {
        namedLogged.add("office|" + f.label);
        dbg(`office attendance${LQ !== L ? " (from the description)" : ""}: ${why}; ` +
          (hit ? `"${hit.part}" matches "${hit.e}", answering Yes (blue)` : placeQ ? "not in your office locations and not where you live, left for you (never sent to Claude)" : "not in your office locations, left for you"));
      }
      return hit ? FIX(f.type === "checkbox" ? true : "Yes") : NEEDS;
    }
    // Matched but not decided above (a field type it doesn't fill, or a question over 260 characters): every office
    // question the rule matches ends with an answer or a reason. A choice field is left for you, never Claude; a long
    // text / textarea is an essay prompt that mentions the office, left to the normal rules (drafts).
    if (officeAsk) {
      const essay = ["text", "textarea"].includes(f.type);
      if (!namedLogged.has("office|" + f.label)) {
        namedLogged.add("office|" + f.label);
        dbg(`office attendance: matched, but ${LQ.length > 260 ? `the question is too long to read as one (${LQ.length} characters)` : `a ${f.type} field isn't one it fills`}; ` +
          `${essay ? "left to the normal rules" : "left for you, never sent to Claude"}: ${f.label.slice(0, 80)}`);
      }
      if (!essay) return NEEDS;
    }
    if (T(/(are you|is your).*(u s|us|united states) citizen|citizen of the united states/)) return FIX(a.citizen);
    // \b around itar: unbounded, it matched inside "mil-itar-y" and answered DoD/military questions "Yes".
    // ITAR / export control as your status, not experience with it ("Do you have experience with export control compliance?").
    if (T(/u s person|\bus person\b/) || (T(/\bitar\b|export control|export regulation/) && !/\b(experience|familiar|familiarity|knowledge|worked (with|on)|exposure|background in)\b/.test(L))) return FIXYES(a.usPerson, "U.S. person");
    // Clearance questions with worded options (Notional: "Do you presently hold an active U.S. security clearance, or are
    // you eligible to obtain one?" [Yes, I hold an active clearance | Yes, I'm eligible | No]: the eligibility setting's
    // "Yes" picked the first "Yes ..." option, which says you hold one). Each option is read for what it CLAIMS: "hold /
    // held / have / active / current" = holding one (Options "Currently hold a clearance", `answers.clearance`),
    // "eligible / able / willing / obtain" = eligibility (`answers.clearanceEligible`), a leading No / not = the claim
    // denied; a bare "No" denies what the question asks. The option whose claims are all true for you is chosen, the
    // one claiming most first; a needed answer blank in Options, or no true option, = yellow. Never "starts with Yes".
    // Also past clearances ("If you have held a U.S. security clearance in the past, what level?"): never held = the
    // "N/A / never held / none" option only, no level; held one = yellow (the level is yours).
    if (/\bclearance\b/.test(L) && ["radio", "dropdown", "checkgroup"].includes(f.type)) {
      const asksHold = /\b(hold|possess|maintain)\b( \S+){0,9} clearance\b|\b(active|current) (\S+ ){0,4}clearance\b|\bhave (an? |any )?(active |current )?(\S+ ){0,3}clearance\b/.test(L) && !/\bif you have held\b|\bin the past\b|\bpreviously held\b/.test(L);
      const asksElig = /\b(eligible|eligibility|able to obtain|willing to obtain|obtain)\b/.test(L);
      const past = /\b(have|had) (you )?(ever )?held\b|\bin the past\b|\bpreviously held\b/.test(L) && /\b(level|which|what|type)\b/.test(L);
      const facts = { hold: a.clearance?.trim() || "", elig: a.clearanceEligible?.trim() || "" };
      if (past) {
        const never = facts.hold === "No";
        if (!namedLogged.has("clrpast|" + f.label)) {
          namedLogged.add("clrpast|" + f.label);
          dbg(`past clearance level: ${never ? "never held one (Options: currently hold a clearance No) -> the N/A / never held option (blue)" : `clearance "${facts.hold || "not set"}" in Options, left for you`}: ${f.label.slice(0, 80)}`);
        }
        if (!never) return NEEDS;
        const NONE = /\b(n ?a|not applicable|never held|have never|have not held|none)\b/;
        if (f.type === "checkgroup") return FIX({ checkAll: [], match: (t) => NONE.test(norm(t)), what: "past clearance level" });
        return FIX({ choose: (texts) => (texts || []).find((t) => NONE.test(norm(t))) || null, text: "N/A", what: "past clearance level" });
      }
      if (asksHold || asksElig) {
        const truth = { hold: facts.hold === "Yes" ? true : facts.hold === "No" ? false : null, elig: facts.elig === "Yes" ? true : facts.elig === "No" ? false : null };
        // A holder is eligible too.
        if (truth.hold === true && truth.elig === null) truth.elig = true;
        const claims = (t) => {
          const n = norm(t);
          const neg = /^(no|not|none|neither)\b|\b(do not|dont|am not|have not|havent|not currently|not eligible)\b/.test(n);
          const c = {};
          if (/\b(hold|held|have|possess|active|current(ly)?)\b/.test(n) && !/\beligible\b.*\bnot\b/.test(n)) c.hold = !/^(no|not)\b.*\bbut\b/.test(n) ? !neg : false;
          if (/\b(eligible|eligibility|able|willing|obtain)\b/.test(n)) c.elig = /\bnot (eligible|able|willing)\b|\bineligible\b|\bunable\b/.test(n) ? false : true;
          // "No, but I'm eligible": the hold claim denied, eligibility claimed.
          if (/^no\b.*\bbut\b/.test(n)) {
            c.hold = false;
            if (c.elig === undefined) c.elig = true;
          }
          if (!Object.keys(c).length && /^(no|none|neither)\b/.test(n)) {
            if (asksHold) c.hold = false;
            if (asksElig) c.elig = false;
          }
          if (!Object.keys(c).length && /^yes\b/.test(n) && asksHold !== asksElig) c[asksHold ? "hold" : "elig"] = true;
          return c;
        };
        const choose = (texts) => {
          const ok = (texts || [])
            .map((t) => ({ t, c: claims(t) }))
            .filter(({ c }) => Object.keys(c).length && Object.entries(c).every(([k, v]) => truth[k] !== null && truth[k] === v));
          ok.sort((x, y) => Object.values(y.c).filter(Boolean).length - Object.values(x.c).filter(Boolean).length || Object.keys(y.c).length - Object.keys(x.c).length);
          return ok[0]?.t || null;
        };
        if (!namedLogged.has("clrmeaning|" + f.label)) {
          namedLogged.add("clrmeaning|" + f.label);
          dbg(`clearance options by meaning: hold a clearance "${facts.hold || "not set"}", eligible "${facts.elig || "not set"}" (Options); the option whose claims are true (blue): ${f.label.slice(0, 80)}`);
        }
        return FIX({ choose, text: "", what: "clearance (by meaning)" });
      }
    }
    // "What is your preferred programming language for interviews?" (Notional, went to Claude): Options "Preferred
    // interview language" (`answers.interviewLanguage`, e.g. Python), blue; blank = yellow; never Claude.
    if (/\b(programming|coding) language\b.{0,40}\b(interview|technical (screen|assessment)|coding (challenge|assessment|exercise))s?\b|\blanguage (for|in|during) (the |your |our )?(technical |coding )?interviews?\b|\binterview(ing)? language\b/.test(L) && ["text", "textarea", "radio", "dropdown", "checkgroup"].includes(f.type)) {
      // A textarea too (Notional's second run: the classifier called it open-ended and Sonnet wrote a paragraph): just the value.
      const v = a.interviewLanguage?.trim();
      if (!namedLogged.has("ilang|" + f.label)) {
        namedLogged.add("ilang|" + f.label);
        dbg(`interview language: ${v ? `"${v}" from Options (blue)` : "Preferred interview language not set in Options, left for you (never Claude)"}: ${f.label.slice(0, 80)}`);
      }
      if (!v) return NEEDS;
      return FIX(["text", "textarea"].includes(f.type) ? splitAlts(v)[0] || v : splitAlts(v));
    }
    // Securities licenses / registrations (Steadfast: four FINRA questions went to Claude, which said Yes): Options
    // "Securities licenses / registrations" (`answers.securitiesLicenses`, default None; e.g. "SIE, Series 7"). None =
    // No on every yes / no ("Are you currently FINRA registered?", the SIE exam, Series licenses), "None" in a text box.
    // Listed: a text box gets the list; the SIE question Yes when SIE is listed; Series / registered Yes when a Series
    // is listed, else No; anything else yellow. Blue, never Claude, never learned.
    if (SECURITIES_Q.test(L) && ["text", "textarea", "radio", "dropdown", "checkgroup"].includes(f.type)) {
      const v = String(a.securitiesLicenses || "").trim();
      const none = !v || /^(none|no|n ?a|not applicable)$/i.test(norm(v));
      const has = norm(v);
      const series = /\bseries \d+\b/.test(has);
      const sie = /\bsie\b|securities industry essentials/.test(has);
      let ans;
      if (["text", "textarea"].includes(f.type)) ans = none ? "None" : v;
      else if (none) ans = "No";
      else if (/\bsie\b|securities industry essentials/.test(L)) ans = sie ? "Yes" : "No";
      // The SIE is neither a Series license nor a registration: only a listed Series makes these Yes.
      else if (/\bseries\b|\bregistered\b|\bregistrations?\b|\blicen[cs]ed?\b|\blicen[cs]es\b/.test(L)) ans = series ? "Yes" : "No";
      if (!namedLogged.has("sec|" + f.label)) {
        namedLogged.add("sec|" + f.label);
        dbg(`securities licenses: ${none ? "none" : `"${v}"`} in Options${ans ? ` -> ${ans} (blue)` : ", can't tell for this question; left for you (never Claude)"}: ${f.label.slice(0, 80)}`);
      }
      return ans ? FIX(ans) : NEEDS;
    }
    // "Did You Graduate?" (Steadfast, prefilled Yes): from your education, not the form: the expected graduation ahead = No,
    // passed = Yes; blue, never Claude. A question naming a technical / high school stays with that rule (yours).
    if (/^(did|have) you graduate(d)?\??$|^graduated\??$|^(did|have) you graduate(d)? (from )?(college|university|your (degree|program))\??$/.test(L) && ["radio", "dropdown", "checkgroup"].includes(f.type)) {
      const now = studentNow(p);
      if (!namedLogged.has("grad?|" + f.label)) {
        namedLogged.add("grad?|" + f.label);
        dbg(`did you graduate: ${now === null ? "no expected graduation date in Options, left for you" : `expected graduation ${p.expectedGraduation} is ${now ? "ahead -> No" : "past -> Yes"} (blue)`}: ${f.label.slice(0, 80)}`);
      }
      return now === null ? NEEDS : FIX(now ? "No" : "Yes");
    }
    // "Are you eligible to obtain a U.S. security clearance?", "able / willing to obtain a clearance": Options
    // "Eligible to obtain a US security clearance" (`answers.clearanceEligible`), blue; blank = yellow; never
    // Claude. Holding one now stays with the clearance answer below.
    if (/\b(eligible|able|willing)\b.{0,30}\b(obtain|get|receive|be granted|apply for)\b.{0,60}\bclearance\b|\bclearance eligib|\beligib\w* (for|to obtain) (a |an )?(\w+ ){0,5}clearance\b/.test(L) && !/\b(currently|now) (hold|have|possess)\b/.test(L)) {
      const v = a.clearanceEligible?.trim();
      if (!namedLogged.has("clrelig|" + f.label)) {
        namedLogged.add("clrelig|" + f.label);
        dbg(`clearance eligibility: ${v ? `"${v}" from Options (blue)` : "not set in Options, left for you"}: ${f.label.slice(0, 80)}`);
      }
      if (!v) return NEEDS;
      return FIX(f.type === "checkbox" ? v === "Yes" : v);
    }
    // "Do you hold an active U.S. Government Security Clearance?" has words between "hold" and "clearance".
    if (T(/\b(have|hold|possess|maintain)\b( \S+){0,9} clearance\b/) && !/obtain|willing|able to|eligib/.test(L)) return FIX(a.clearance);

    // Languages you speak as a checkbox group ("Language Skill(s) (Check all that apply)"): every profile
    // language (name or alias) listed is checked, a code in parentheses ignored ("English (ENG)"). Blue; none
    // listed = yellow; never Claude.
    if (f.type === "checkgroup" && /\blanguages?\b/.test(L) && !/programming|coding|computer|software/.test(L)) {
      const names = (p.languages || []).flatMap((l) => [l.name, ...(Array.isArray(l.aliases) ? l.aliases : splitAlts(String(l.aliases || "").replace(/,/g, "|")))]).filter(Boolean);
      if (!namedLogged.has("langs|" + f.label)) {
        namedLogged.add("langs|" + f.label);
        dbg(`languages: checking ${names.length ? show([...new Set(names)]) : "nothing (no languages in your profile)"}: ${f.label.slice(0, 80)}`);
      }
      return names.length ? FIX({ checkAll: [...new Set(names)], what: "languages" }) : NEEDS;
    }
    // "Which university are you currently attending / did you last attend?": the school rule (names, aliases,
    // search keyword), blue, never Claude. (Ashby / Lever send whole-label school questions to the education
    // step first: AAF.EDU_LABEL.)
    // Also "Which institution do you attend?" (2Password; classified education status and left yellow).
    if (/\b(which|what) (school|university|college|institution|educational institution) (are you (currently )?attending|do you (currently )?attend|did you (last )?attend|are you (currently )?enrolled|do you (currently )?go to)\b/.test(L) ||
      (ctx.category === "education status" && ["text", "dropdown", "multi"].includes(f.type) && /\b(school|university|college|institution)\b/.test(L) && !SCHOOL_NOT_LISTED.test(L))) {
      const x = (p.education || [])[0];
      if (!namedLogged.has("schoolq|" + f.label)) {
        namedLogged.add("schoolq|" + f.label);
        dbg(`school question: ${x?.school ? `"${x.school}" (school rule, blue)` : "no school in your profile, left for you"}: ${f.label.slice(0, 80)}`);
      }
      if (!x?.school) return NEEDS;
      const aliases = /\|/.test(x.schoolAliases || "") ? splitAlts(x.schoolAliases) : String(x.schoolAliases || "").split(",").map((t) => t.trim()).filter(Boolean);
      return FIX(f.type === "dropdown" || f.type === "multi" ? { school: [x.school, ...aliases.filter((n) => norm(n) !== norm(x.school))], search: x.schoolSearch?.trim() || schoolKeyword(x.school) } : x.school);
    }
    // "Intended graduation year", "Graduation year", "Year of graduation": the year of the expected graduation
    // date, blue, never Claude.
    if (/\b(intended|expected|anticipated|projected) (graduation|grad) year\b|^(graduation|grad) year$|\byear of (expected |anticipated )?graduation\b|\bwhat year (will|do) you (expect to )?graduate\b/.test(L) && p.expectedGraduation && !["checkbox", "checkgroup", "date"].includes(f.type)) {
      const y = String(parseDate(p.expectedGraduation).year || "");
      if (y) {
        if (!namedLogged.has("grady2|" + f.label)) {
          namedLogged.add("grady2|" + f.label);
          dbg(`graduation year: ${y} (expected graduation ${p.expectedGraduation}, blue)`);
        }
        return FIX(f.type === "text" || f.type === "textarea" ? y : { steps: [[y], [`Class of ${y}`]], what: "graduation year" });
      }
    }
    // Today's date on a self-ID / EEO / signature section ("Date" under Lever's CC-305 disability form,
    // "Date signed", "Today's date"): in the format the field asks for (MM/DD/YYYY by default), blue.
    const SIGN_CTX = /eeo|disab|self ?ident|signature|signed|veteran|cc ?305|voluntary/;
    if (["text", "date"].includes(f.type) && /^(todays |current )?date( signed)?$|^date of signature$|^signature date$|^today(s date)?$/.test(L) &&
      (f.type === "date" || /sign/.test(L) || SIGN_CTX.test(`${f.nid} ${norm(f.section || "")} ${headingBefore(f.c)}`))) {
      const t = today();
      if (!namedLogged.has("today|" + f.label + f.nid)) {
        namedLogged.add("today|" + f.label + f.nid);
        dbg(`today's date: ${f.label.slice(0, 60)} (${f.type === "date" ? "date field" : `"${dateInFormat(f, t)}"`}, blue)`);
      }
      return FIX(f.type === "date" ? t : dateInFormat(f, t));
    }
    // Classified EEO whose label didn't name the attribute: the options say which (veteran / disability / gender / race /
    // orientation wordings), and the question goes to that rule (Options settings; blank = yellow).
    if (ctx.category === "EEO" && (ctx.options || []).length && !ctx.eeoAs) {
      const o = ctx.options.map(norm).join(" | ");
      const kind = /\bveteran\b/.test(o) ? "Veteran status" : /\bdisabilit/.test(o) ? "Disability status" : /\b(heterosexual|straight|lesbian|gay|bisexual|queer)\b/.test(o) ? "Sexual orientation" :
        /\b(asian|white|black|african american|native american|pacific islander|two or more races)\b/.test(o) ? "Race" : /\b(male|female|woman|man|non ?binary)\b/.test(o) ? "Gender" : "";
      if (kind) {
        if (!namedLogged.has("eeoas|" + f.label)) {
          namedLogged.add("eeoas|" + f.label);
          dbg(`classified EEO: the options are ${kind.toLowerCase()} options -> the ${kind.toLowerCase()} rule: ${f.label.slice(0, 80)}`);
        }
        return profileValue({ ...f, label: kind, nl: norm(kind) }, p, { ...ctx, eeoAs: kind });
      }
    }
    // Accommodation requests ("Is there anything you'd like to share with us ... that would help us accommodate you during
    // the interview process?", "Do you require any accommodations?"): yours, left yellow, never Claude or a draft. Not the
    // essential-functions question ("... with or without reasonable accommodation").
    // A request for one ("help us accommodate you", "need an accommodation", "accommodations ... interview"), not
    // "accommodating a stakeholder's request".
    if ((/\baccommodate you\b|\b(need|require|request)\w* (an? |any )?(reasonable )?accommodations?\b/.test(L) || /\baccommodations?\b.{0,60}\b(interview|hiring|recruit\w*|application|process|disabilit\w*|need|require|request)/.test(L)) && !/\bwith or without\b/.test(L)) {
      if (!namedLogged.has("accom|" + f.label)) {
        namedLogged.add("accom|" + f.label);
        dbg(`accommodations: left for you, never sent to Claude: ${f.label.slice(0, 80)}`);
      }
      return NEEDS;
    }
    // Voluntary disclosures / self-identify. On text fields only the LABEL counts, never the field's name:
    // Lever's CC-305 "Date" is named eeo[disabilitySignatureDate] and got "No, I do not have a disability".
    // EEO / demographic questions never go to Claude or drafts: an Options setting, else yellow (`NEEDS`).
    // A text box only when the question asks for the attribute itself (a short label, not "Is there anything you'd like
    // to share ... such as your pronouns or gender identity ... help us accommodate you?", which got "Female" on 2Password).
    const EE = (rx) => (["text", "textarea"].includes(f.type) ? L.length <= 80 && !/\b(anything|share|tell us|describe|explain)\b/.test(L) && rx.test(L) : T(rx));
    const eeoOut = (what, v) => {
      const blank = v == null || v === "" || (Array.isArray(v) && !v.length);
      if (blank && !namedLogged.has("eeo|" + f.label)) {
        namedLogged.add("eeo|" + f.label);
        dbg(`EEO (${what}): not set in Options, left for you, never sent to Claude: ${f.label.slice(0, 80)}`);
      }
      return blank ? NEEDS : v;
    };
    // Exact option first, then an option containing the answer as a whole phrase (like race).
    const eeoChoice = (what, raw) => {
      const prefs = splitAlts(raw || "");
      return eeoOut(what, prefs.length ? (["text", "textarea"].includes(f.type) ? prefs[0] : { choose: raceChoice(prefs), text: prefs[0], what }) : "");
    };
    // Before gender: "transgender" contains "gender". Not a community-membership question that lists transgender
    // ("Do you identify as a member of the LGBTQ2S+ community (... transgender, queer, two-spirit)?", 2Password: the
    // transgender "No" answered it): that's the LGBTQ+ membership rule below.
    const LGBTQ_MEMBER = /\b(identify|identifies|consider yourself|self identify)\b.{0,40}\blgbt|\blgbt\S* (community|member)/;
    if (/\btransgender\b|\btrans\b|\bassigned at birth\b|\bgender identity (is )?(the same|different|differs?)\b/.test(L) && !LGBTQ_MEMBER.test(L)) return eeoChoice("transgender", e.transgender);
    // LGBTQ+ membership ("Do you identify as part of the LGBTQ+ community?": Yes / No / Questioning / I don't
    // wish to answer): a yes / no, not an orientation. Options "Identify as LGBTQ+" when set; otherwise derived:
    // Yes when the orientation setting's first value is an LGBTQ+ identity or transgender is Yes; No when the
    // orientation is heterosexual / straight (or No) and transgender is No; the decline option when the
    // orientation setting itself is a prefer-not answer; anything else yellow. Never "Questioning".
    if (LGBTQ_MEMBER.test(L) && !/\bsexual orientation\b/.test(L)) {
      const DECL = ["I don't wish to answer", "I do not wish to answer", "I prefer not to answer", "Prefer not to say", "Prefer not to answer", "Decline to self-identify", "Decline"];
      const first = (v) => splitAlts(v || "")[0] || "";
      const o = norm(first(e.lgbtq));
      const tr = norm(first(e.transgender));
      const decline = (v) => /\b(prefer not|not to (say|answer)|decline|dont wish|do not wish)\b/.test(v);
      const over = norm(e.lgbtqMember || "");
      let ans = "";
      let why = "";
      if (over) {
        ans = /^yes/.test(over) ? "Yes" : /^no\b/.test(over) ? "No" : decline(over) ? "decline" : "";
        why = `"Identify as LGBTQ+" = ${e.lgbtqMember} in Options`;
      } else if (/\b(lesbian|gay|bisexual|bi|queer|pansexual|asexual|aromantic|demisexual|homosexual|two spirit|lgbt\S*)\b/.test(o) || /^yes\b|^transgender\b/.test(tr)) {
        ans = "Yes";
        why = `orientation "${first(e.lgbtq)}", transgender "${first(e.transgender) || "not set"}"`;
      } else if ((/\b(heterosexual|straight)\b/.test(o) || o === "no") && /^no\b/.test(tr)) {
        ans = "No";
        why = `orientation "${first(e.lgbtq)}", transgender "${first(e.transgender)}"`;
      } else if (decline(o)) {
        ans = "decline";
        why = `orientation setting "${first(e.lgbtq)}"`;
      } else why = `orientation "${first(e.lgbtq) || "not set"}", transgender "${first(e.transgender) || "not set"}": can't tell`;
      if (!namedLogged.has("lgbtqm|" + f.label)) {
        namedLogged.add("lgbtqm|" + f.label);
        dbg(`LGBTQ+ membership: ${why} -> ${ans ? (ans === "decline" ? "the decline option" : ans) + (over ? "" : " (blue)") : "left for you, never sent to Claude"}: ${f.label.slice(0, 80)}`);
      }
      if (!ans) return NEEDS;
      const v = ["text", "textarea"].includes(f.type)
        ? (ans === "decline" ? DECL[0] : ans)
        : { steps: ans === "decline" ? [DECL] : [[ans]], exclude: /questioning/, what: "LGBTQ+ membership" };
      return over ? v : FIX(v);
    }
    if (/\bsexual orientation\b|\blgbt\w*|\bqueer\b|\b(gay|lesbian|bisexual)\b/.test(L)) return eeoChoice("LGBTQ+ / sexual orientation", e.lgbtq);
    // Age ("What is your current age?" with ranges, "Age range", "What is your age?"): computed from Options
    // "Birth month / year", blue. Ranges: the option holding the age; exact-age fields: the age. In the
    // birth month the age is one of two; a range edge between them, or an exact-age field, is left yellow.
    // "Are you at least 18 years of age?" is the over-18 fixed answer (above).
    if ((/\b(age range|age group|current age|your age|how old)\b|^age$/.test(L)) && !/\b18\b|legal (working )?age/.test(L)) {
      const ages = ageCandidates(e.birthMonth);
      const isText = ["text", "textarea", "number"].includes(f.type);
      if (!namedLogged.has("age|" + f.label)) {
        namedLogged.add("age|" + f.label);
        dbg(`age: ${ages ? `born ${e.birthMonth} -> ${ages.join(" or ")}${ages.length > 1 ? " (your birth month: the birthday may still be ahead)" : ""}` : "Birth month / year not set in Options"}${!ages || (isText && ages.length > 1) ? ", left for you, never sent to Claude" : ""}: ${f.label.slice(0, 80)}`);
      }
      if (!ages || (isText && ages.length > 1)) return NEEDS;
      return FIX(isText ? String(ages[0]) : { choose: ageChoice(ages), text: String(ages[0]), what: "age" });
    }
    // "Which of the following communities do you belong to? Please select all that apply.": Options
    // "Communities" (every listed option is checked).
    if (/\bcommunit(y|ies)\b.{0,30}\b(belong|identify|part of|member)/.test(L)) {
      const names = splitAlts(e.communities || "");
      if (!names.length || f.type !== "checkgroup") return eeoChoice("communities", e.communities);
      return { checkAll: names, what: "communities" };
    }
    // Gender ("Gender": Male / Female; "What is your gender identity?": Man / Woman / Non-Binary): the
    // setting, then its gender-identity word, exact or as a whole phrase ("Man" never matches "Woman").
    if (EE(/gender|\bsex\b/)) {
      const g = splitAlts(e.gender || "");
      if (!g.length || g.some((x) => /^decline/i.test(x))) return eeoOut("gender", e.gender);
      const SYN = { female: ["Woman"], male: ["Man"], "non binary": ["Nonbinary", "Non-Binary"], nonbinary: ["Non-binary", "Non binary"] };
      const prefs = [...g];
      for (const x of g) for (const y of SYN[norm(x)] || []) if (!prefs.includes(y)) prefs.push(y);
      return eeoOut("gender", ["text", "textarea"].includes(f.type) ? g[0] : { choose: raceChoice(prefs), text: g[0], what: "gender" });
    }
    if (EE(/hispanic|latino/)) return eeoOut("Hispanic / Latino", e.hispanic);
    if (EE(/\brace\b(?! conditions?)|ethnic/)) {
      // Race preference list (Options; overrides Race when set): exact options first, then the broad
      // category, never a different subgroup (HCT: "Asian" picked "East Asian").
      const prefs = splitAlts(e.racePrefs || "");
      return eeoOut("race", prefs.length ? { choose: raceChoice(prefs), text: prefs[0], what: "race" } : e.race);
    }
    // "What is your military status?", "Military / veteran status", "Service status": from Options
    // "Ever served in the US Armed Forces". Never served = the first "not a veteran" option, blue.
    if (["dropdown", "radio", "checkgroup", "text"].includes(f.type) && /\bmilitary (or )?(veteran )?status\b|\bservice status\b|\bmilitary service status\b/.test(L)) {
      const served = String(a.armedForces || "").trim();
      if (!namedLogged.has("milstatus|" + f.label)) {
        namedLogged.add("milstatus|" + f.label);
        dbg(`military status: armed forces service ${served || "not set"} in Options -> ${served === "No" ? "not a veteran (blue)" : "left for you, never sent to Claude"}: ${f.label.slice(0, 80)}`);
      }
      if (served !== "No") return NEEDS;
      if (f.type === "text") return FIX("Not a veteran");
      return FIX({ steps: NEVER_SERVED, exclude: /none of the above/, what: "military status" });
    }
    if (EE(/veteran/)) {
      // Veteran status not set, but "Ever served in the US Armed Forces" = No: not a protected veteran (blue).
      if (!splitAlts(e.veteran || "").length && String(a.armedForces || "").trim() === "No") {
        if (!namedLogged.has("vet|" + f.label)) {
          namedLogged.add("vet|" + f.label);
          dbg(`veteran status: not set in Options; armed forces service No -> not a protected veteran (blue): ${f.label.slice(0, 80)}`);
        }
        return FIX(["text", "textarea"].includes(f.type) ? "I am not a protected veteran" : { steps: [["I am not a protected veteran"], ["I am not a veteran"], ...NEVER_SERVED, ["No"]], exclude: /none of the above/, what: "veteran status" });
      }
      // Ordered fallbacks; a "not a veteran" answer also accepts a plain "No" ("Are you a veteran?"
      // with Yes / No options failed on HCT).
      const v = splitAlts(e.veteran);
      // Never served (Options: armed forces No): the never-served wordings too, before the plain "No".
      if (v.some((x) => /not a (protected )?veteran/i.test(x)) && String(a.armedForces || "").trim() === "No") for (const x of NEVER_SERVED.flat()) if (!v.includes(x) && !/^(none|civilian)$/i.test(x)) v.push(x);
      if (v.some((x) => /not a (protected )?veteran/i.test(x)) && !v.some((x) => /^no$/i.test(x))) v.push("No");
      return eeoOut("veteran", v.length > 1 ? v : e.veteran);
    }
    if (EE(/disabilit/)) return eeoOut("disability", e.disability);
    // Pronouns ("Pronouns", "What are your pronouns?"; Rippling's dropdown: She/her/hers, He/him/his, ...): Options
    // "Pronouns" (`eeo.pronouns`, "|"-ordered, e.g. "She/her/hers | she/her"), an exact option first, then a whole phrase;
    // blank = yellow, never Claude. Not "Enter my pronouns" / free entry options.
    if (EE(/\bpronouns?\b/) && L.length <= 80) return eeoChoice("pronouns", e.pronouns);
    // Any other demographic question (age range, ...): no setting, so yours.
    if (globalThis.AAF_LEARN_RULES && EE(globalThis.AAF_LEARN_RULES.EEO_Q)) return eeoOut("no setting for this question", "");
    // Expected graduation: a date field about graduation/completion, or any field that explicitly asks
    // for the EXPECTED/anticipated date. Never a "highest level of education" question, whose label
    // can mention "most recent graduation date" (Lexidos Q4).
    // "Are you currently enrolled in a graduate program (Master's or Ph.D.) ...?": a profile fact. No
    // graduate degree in the education entries = "No" (blue); otherwise it's left for Claude / you.
    // "Are you currently working towards / pursuing a Bachelor's or Master's degree?", "... enrolled in a degree
    // program?" (Lexidos): Yes while the expected graduation date is ahead, No after, blue, never Claude. Only
    // when the question names a bachelor's / undergraduate degree or a degree in general; graduate-only
    // questions keep the rule below.
    // Also "Are you currently enrolled at an educational institution?" / "... a student?" (2Password; classified
    // education status and left yellow), and any yes / no the classifier calls education status that asks it.
    const enrolledAny = /^(are|is) you\b/.test(L) && /\b(currently|presently|now)\b.{0,20}\b(enrolled (at|in) (an? )?(educational institution|school|university|college)|(a )?(college |university )?student)\b/.test(L) && !/\b(graduate|masters?|ph ?d|doctoral|doctorate|mba)\b/.test(L);
    const classifiedEnrolled = ctx.category === "education status" && /\b(enrolled|student|studying|attending)\b/.test(L) && !/\b(graduate|masters?|ph ?d|doctoral|doctorate|mba)\b/.test(L);
    if ((enrolledAny || classifiedEnrolled || (/^(are|is) you\b/.test(L) && /\b(currently|presently|now)\b.{0,20}\b(working (towards?|on)|pursuing|enrolled in|studying (for|towards?))\b/.test(L) &&
      (/\b(bachelors?|undergrad\w*|associates?)\b/.test(L) || (/\b(a|any) (college |university )?degree\b|\bdegree program\b/.test(L) && !/\b(graduate|masters?|ph ?d|doctoral|doctorate|mba)\b/.test(L))))) &&
      ["radio", "dropdown", "checkgroup", "text"].includes(f.type)) {
      const now = studentNow(p);
      if (!namedLogged.has("pursuing|" + f.label)) {
        namedLogged.add("pursuing|" + f.label);
        dbg(`currently pursuing a degree: ${now === null ? "no expected graduation date in your profile, left for you" : `expected graduation ${p.expectedGraduation} is ${now ? "ahead -> Yes" : "past -> No"} (blue)`}: ${f.label.slice(0, 80)}`);
      }
      if (now === null) return NEEDS;
      return FIX(now ? "Yes" : "No");
    }
    // Also "Are you expected to complete a master's or PhD program in Fall 2027 or Spring 2028?" (complete / finish /
    // graduate from a graduate program): the same fact.
    const gradProgQ = /\b(enrolled|currently studying|pursuing)\b.*\b(graduate|masters?|ph ?d|doctoral|doctorate|mba)\b.*\b(program|degree|school)\b/.test(L) ||
      (/^(are|will|do) you\b/.test(L) && /\b(expected|going|planning|plan|scheduled|set) to (complete|finish|graduate from|earn|receive)\b.*\b(masters?|ph ?d|doctoral|doctorate|mba|graduate)\b.*\b(program|degree)\b/.test(L) && !/\bbachelors?\b/.test(L));
    if (gradProgQ && !/undergrad/.test(L) && ["radio", "dropdown", "checkgroup", "checkbox", "text"].includes(f.type)) {
      const grad = (p.education || []).some((x) => /master|ph ?d|doctor|(?<!under)graduate|mba|\bm\.?s\.?\b|\bm\.?eng\b/i.test(`${x.degreeOptions || ""} ${x.degree || ""}`.split("\n")[0]));
      if (!namedLogged.has("gradprog|" + f.label)) {
        namedLogged.add("gradprog|" + f.label);
        dbg(`graduate program question: ${grad ? "you have a graduate program in your education, left for you (never sent to Claude)" : "no graduate (master's / PhD / MBA) program in your education -> No (blue)"}: ${f.label.slice(0, 80)}`);
      }
      if (!grad) return FIX(f.type === "checkbox" ? false : "No");
      return NEEDS;
    }
    // Expected graduation: date inputs, or a field that ASKS for the expected / anticipated date.
    // Never a yes/no question that merely mentions one ("Are you enrolled in a graduate program ...
    // with an anticipated graduation date around May 2028?" once got "2027"), and never "highest level
    // of education" (Lexidos Q4).
    const gradDate = f.type === "date" && /graduat|degree completion|(expected|anticipated) completion/.test(L);
    const asksYesNo = /^(are|do|have|will|is|did|were|would|can|could) you\b/.test(L);
    // A plain "Graduation Date" label (Nimbus) asks for it too.
    const gradAsked = !asksYesNo && (/(expected|anticipated) (graduation|degree completion|completion|grad)/.test(L) || (L.length <= 40 && /^(expected |anticipated )?(graduation|grad) date\b/.test(L))) && !/highest|level of education/.test(L);
    // "When do you graduate?" (2Password, a textarea: it was drafted): the date in words ("May 2027"), blue.
    const whenGrad = /^when (do|will) you (expect to )?(graduate|finish (your )?(degree|studies)|complete (your )?degree)\b|^when is your (expected |anticipated )?graduation\b/.test(L);
    if (whenGrad && ["text", "textarea"].includes(f.type) && !/\b(mm|yyyy|dd)\b/.test(norm(f.ctrl?.placeholder || ""))) {
      const d = parseDate(p.expectedGraduation || "");
      const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
      const v = d.year ? `${d.month ? MONTHS[Number(d.month) - 1] + " " : ""}${d.year}` : "";
      if (!namedLogged.has("whengrad|" + f.label)) {
        namedLogged.add("whengrad|" + f.label);
        dbg(`graduation date: ${v ? `"${v}" (expected graduation ${p.expectedGraduation}, blue)` : "no expected graduation date in your profile, left for you"}: ${f.label.slice(0, 80)}`);
      }
      return v ? FIX(v) : NEEDS;
    }
    if (gradDate || gradAsked || (whenGrad && ["dropdown", "radio", "date"].includes(f.type))) {
      if (!p.expectedGraduation) return undefined;
      const d = parseDate(p.expectedGraduation);
      if (f.type === "date") return d;
      // Choice fields: the option matching the full date (not just the first one containing the year).
      if (["dropdown", "radio"].includes(f.type)) return { choose: graduationChoice(d), what: "graduation date" };
      return gradText(f, p);
    }

    // Consent / certification checkboxes: the label, or (a card heading like "Confirmation of
    // Information Provided" over the real statement) the checkbox's own text or the card's text.
    // Never marketing / job-alert opt-ins.
    // Candidate / applicant / privacy notices ("I have read the candidate privacy notice", "I acknowledge the
    // applicant notice", "I have reviewed the CCPA notice"): like consent, never Claude. Choice fields pick
    // the acknowledging option ("I acknowledge", "Yes", "I have read ..."), never a declining one.
    // Legal agreements are never acknowledged for you (Orbital AI: "I acknowledge that I have opened, read, and understood
    // the Arbitration Agreement ... agreeing to be bound by the terms" was checked): arbitration, waivers, non-competes,
    // releases of claims, indemnification, "agree to be bound". Read in the field's own text, and for "I (confirm I)
    // have read the above" in the text right above it. Yellow, logged with the phrase; plain notices (privacy notice,
    // data transfer) keep the acknowledgment rule below.
    const ackLike = f.type === "checkbox" || /^(i |by )|\b(acknowledge|agree|consent|confirm|accept|understand)\b/.test(L);
    if (ackLike && ["checkbox", "radio", "dropdown", "checkgroup"].includes(f.type)) {
      const own = norm(`${f.label} ${f.optionText || ""} ${f.cardText || ""} ${f.desc || ""}`);
      const refersAbove = /\b(the above|above (text|agreement|terms|notice|information|policy)|the foregoing|this agreement)\b/.test(own);
      const above = refersAbove ? norm(textAbove(f.c)) : "";
      const m = LEGAL_AGREEMENT.exec(own) || LEGAL_AGREEMENT.exec(above);
      if (m) {
        if (!namedLogged.has("legal|" + f.label)) {
          namedLogged.add("legal|" + f.label);
          dbg(`legal agreement ("${m[0]}"${LEGAL_AGREEMENT.test(own) ? "" : " in the text above it"}): never acknowledged for you, left for you: ${f.label.slice(0, 80)}`);
        }
        return NEEDS;
      }
    }
    const NOTICE_ACK = /\b(privacy|applicant|candidate|ccpa|cpra|gdpr|data (privacy|protection)|recruit(ment|ing)|personal (data|information)|california)\b.{0,40}\b(notice|policy|statement|disclosure)s?\b/;
    const optIn = /newsletter|marketing|promotional|subscribe|job alerts?|text messages?|\bsms\b|talent (community|network)/;
    // Acknowledgments / consents on this form (learned-answers review: data transfer, retaining your application for
    // future roles, interview recording / AI notes): the option meaning acknowledge / consent, never learned. A heading-only
    // label ("Point of Data Transfer") counts when the text under it is the notice.
    const LRA = globalThis.AAF_LEARN_RULES;
    const ackQ = NOTICE_ACK.test(L) || !!LRA?.ackQuestion(f.label) || (!!LRA?.headingOnly(f.label) && !!LRA?.ackQuestion(f.desc || ""));
    if (["radio", "dropdown", "checkgroup"].includes(f.type) && ackQ && !optIn.test(`${L} ${norm(f.desc || "")}`)) {
      if (!namedLogged.has("ack|" + f.label)) {
        namedLogged.add("ack|" + f.label);
        dbg(`notice acknowledgment: ${f.label.slice(0, 80)} (blue, never Claude)`);
      }
      return FIX({ choose: ackOption, text: "I acknowledge", what: "notice acknowledgment" });
    }
    if (f.type === "checkbox") {
      const STRONG = /\bi (hereby )?(have read|have reviewed|have received|consent|agree|acknowledge|understand|certify|confirm|declare|attest)\b|\bhereby (confirm|certify|declare)\b/;
      const extra = norm(`${f.optionText || ""} ${f.cardText || ""}`);
      const marketing = /newsletter|marketing|promotional|subscribe|job alerts?|text messages|\bsms\b|talent (community|network)/.test(`${L} ${extra}`);
      if (!marketing && (T(/i (have read|have reviewed|have received|consent|agree|acknowledge|understand|certify|confirm)|terms and conditions|privacy (policy|notice|statement|terms|practices)|^privacy$/) || NOTICE_ACK.test(L) || ackQ || STRONG.test(extra)))
        return { value: true, review: true };
    }

    return undefined;
  }

  // ---- Prefilled values (a portal's resume parse, or the user) vs the profile value.
  // Same text ignoring case / spacing / punctuation, same phone digits (a leading US 1 ignored), same
  // URL (protocol / www / trailing slash ignored), or the same company for company fields (suffixes
  // like Inc. / LLC, initials, aliases: sameCompany). Started as Lever's keep-if-matching check.
  // ALL CAPS ("APPLICANT", "TEST@EXAMPLE.COM"): iCIMS HMSY says "Do not enter information in all capitals".
  const shouting = (s) => /[A-Z].*[A-Z]/.test(s) && s === s.toUpperCase() && /[A-Z]{2}/.test(s);
  function samePrefill(a, b, f = {}) {
    a = String(a);
    b = String(b);
    // A prefill in capitals that your profile doesn't use is replaced (same text otherwise).
    if (norm(a) === norm(b) && shouting(a) && !shouting(b)) return false;
    if (norm(a) === norm(b)) return true;
    const digits = (x) => String(x).replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
    // The label asks for a format ("Number (Format: 123-456-7890)"): the same digits in another format don't count.
    if (digits(a).length >= 7 && digits(a) === digits(b) && !/[a-z]{3}/i.test(a + b)) return !(PHONE_FORMAT.test(f.label || "") && a.trim() !== b.trim());
    const url = (x) => String(x).trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "");
    if (/\.[a-z]{2,}/i.test(b) && url(a) === url(b)) return true;
    if (/company|employer|organi[sz]ation|^org$/.test(`${f.nl || ""} ${f.nid || ""}`) && sameCompany(a, b)) return true;
    return false;
  }
  // Does a field's current value already satisfy the profile value `v` (whatever shape a rule returned)?
  // true / false, or null when it can't be told from the value alone (dates, booleans).
  //   text / textarea: samePrefill only (never a prefix match: "Test" is not "Test Applicant");
  //   choice fields: samePrefill or a strong option match (score >= 85, "Decline" synonyms);
  //   steps (location, degree): an alternative exactly or as a whole phrase, or the same city (near);
  //   school: the name or an alias as a whole phrase; ranked choice: choose([current]) keeps it.
  function matchesValue(cur, v, f = {}) {
    const c = String(cur || "").trim();
    if (!c || v == null || v === "" || typeof v === "boolean") return null;
    if (Array.isArray(v)) return v.filter(Boolean).some((x) => matchesValue(c, x, f) === true);
    if (typeof v === "object") {
      if (Array.isArray(v.school)) return v.school.some((n) => norm(n) === norm(c) || hasPhrase(c, n)) || (!!v.search && hasPhrase(c, v.search));
      // Field of study: the prefill on step 1 matches; on a later step it depends on whether an earlier
      // step is in the list (the adapter's setField decides: form.js setFieldOnce, Workday chips); on none
      // of the steps it differs.
      if (v.fos) {
        const k = v.steps.findIndex((alts) => !!AAF.matchAlts([c], alts));
        return k === 0 ? true : k > 0 ? null : false;
      }
      const steps = v.steps || v.degreeSteps;
      if (steps) return steps.flat().some((a) => norm(a) === norm(c) || hasPosPhrase(c, a) || AAF.sameField(c, a)) || (!!v.near && !!inMetro(c, v.near));
      if (typeof v.choose === "function") return v.choose([c]) === c;
      return null; // dates and other shapes
    }
    const isText = f.type === "text" || f.type === "textarea";
    return String(v).split("|").map((x) => x.trim()).filter(Boolean).some((a) => samePrefill(c, a, f) || (!isText && !!AAF.bestOption([{ text: c }], a, 85)));
  }

  // A company's known aliases (PwC, EY, BofA, ...) for learning.js's company names.
  const companyAliases = (name) => {
    const c = compact(name);
    return (CO_ALIASES.find((g) => g.some((x) => compact(x) === c)) || []).filter((x) => compact(x) !== c);
  };
  Object.assign(AAF, { CLASS_YEAR_Q, classYearChoice, STATE_ABBR, SECURITIES_Q, OPEN_PROMPT, isLinkBox, dateInFormat, gradText, graduationChoice, companyAliases, STUDENT_NOW, studentNow, ageCandidates, ageRange, ageChoice, countryAlts, SCHOOL_NOT_LISTED, rankedPreference, fieldOfStudyValue, highestEducation, HIGHEST_EDU, samePrefill, matchesValue, today, isPreferred, headingBefore, GOV_ATTEST, ATTEST, namedLogged, sameCompany, exactCompany, namedCompanies, placeLevel, namedSchoolAnswer, profileValue, placeKeys, samePlace, mentionsHome, GOV_PROJECTS, GOV_KINDS_RX: GOV_KINDS.map(([, , re]) => re), travelChoice, fullAddress, TRAVEL_Q, RESTRICTION_Q, OFFICE_Q, NEEDS, inMetro, raceChoice, schoolKeyword, DEFAULT_LOCATION, DEFAULT_OFFICE_METRO });
})();
