// Prefill from the resume and LinkedIn texts (Options; loaded after options.js, uses its $, addCard, readList, changed,
// schoolKeyword, DEFAULT_DEGREE_OPTIONS, settings, profile). `globalThis.AAF_PREFILL`.
//
//   1. Without a key: contact details from the texts themselves (name, email, phone, LinkedIn / GitHub / website,
//      city / state) and skills from a "Skills" / "Technical Skills" section ("Label: a, b, c" lines; LinkedIn's
//      "Top Skills" list too).
//   2. With a key (and Claude on): one call (background.js PREFILL, the draft model) returns each source's work history,
//      education, languages and certifications. Every value is checked against ITS source text (case, spacing,
//      punctuation and date formats aside); what isn't there is dropped and logged. The two are merged: the resume's
//      wording wins, LinkedIn fills gaps (a location, a start month), and dates that differ are flagged on the card,
//      never resolved silently.
//   3. Only these fields are ever filled: FIELDS below, and work experience / education / language cards. Never work
//      authorization, sponsorship, citizenship, clearance, relocation, pay, start dates, self-identification or the API
//      key. A field that already holds a value is never changed: "Replace" is offered instead; a job / school already in
//      the profile isn't added again.
//   4. Everything is a suggestion (outlined): Accept / Edit / Discard per field or card, Accept all / Discard all per
//      section. A suggestion is not saved until accepted (or the setup step's Next). Suggestions are kept in
//      chrome.storage.local `prefill` until each is accepted or discarded, so a reload shows them again.
(() => {
  const FIELDS = ["firstName", "lastName", "preferredName", "email", "phone", "linkedin", "github", "website", "city", "state", "skills", "certifications", "expectedGraduation"];
  const LABEL = { firstName: "First name", lastName: "Last name", preferredName: "Preferred first name", email: "Email", phone: "Phone", linkedin: "LinkedIn URL", github: "GitHub URL", website: "Website", city: "City", state: "State", skills: "Skills", certifications: "Certifications", expectedGraduation: "Expected graduation" };
  const STATES = { AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut", DE: "Delaware", DC: "District of Columbia", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming" };
  const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
  const $ = (s) => document.querySelector(s);
  const log = (...a) => console.info("[autofill] prefill:", ...a);

  // ---- text helpers
  const norm = (s) =>
    ` ${String(s ?? "")
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/&/g, " and ")
      .replace(/[^a-z0-9+#]+/g, " ")
      .trim()} `;
  const inText = (value, src) => !!String(value ?? "").trim() && src.includes(norm(value));
  const lines = (t) => String(t || "").split(/\r?\n/).map((l) => l.trim());

  // ---- 1. deterministic: { key: value } from the texts (resume first, LinkedIn for what the resume lacks)
  function deterministic(resume, linkedin) {
    const out = {};
    const both = `${resume}\n${linkedin}`;
    const first = (re, ...texts) => {
      for (const t of texts) {
        const m = String(t || "").match(re);
        if (m) return m;
      }
      return null;
    };
    // The name: the first line, "First Last" (up to four words), or "First (Nickname) Last" / First "Nickname" Last,
    // whose nickname is the preferred first name.
    const W = "[A-Z][A-Za-z'’.-]*";
    const NAME = new RegExp(`^${W}(?:\\s+${W}){1,3}$`);
    const NICK = new RegExp(`^(${W})\\s+[("“](${W})[)"”]\\s+((?:${W}\\s+){0,2}${W})$`);
    const nameLine = (t) => lines(t).find(Boolean) || "";
    for (const l of [nameLine(resume), nameLine(linkedin)]) {
      if (/\d|@/.test(l)) continue;
      const nick = l.match(NICK);
      if (nick) {
        out.firstName = nick[1];
        out.preferredName = nick[2];
        out.lastName = nick[3].split(/\s+/).pop();
        break;
      }
      if (NAME.test(l)) {
        const w = l.split(/\s+/);
        out.firstName = w[0];
        out.lastName = w[w.length - 1];
        break;
      }
    }
    const email = first(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/, resume, linkedin);
    if (email) out.email = email[0];
    const phone = first(/(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/, resume, linkedin);
    if (phone) out.phone = phone[0].replace(/\D/g, "").slice(-10);
    const li = first(/linkedin\.com\/in\/[A-Za-z0-9_-]+/i, resume, linkedin);
    if (li) out.linkedin = `https://www.${li[0].replace(/^www\./i, "")}`;
    const gh = first(/github\.com\/(?!orgs\/|topics\/)[A-Za-z0-9-]+/i, resume, linkedin);
    if (gh) out.github = `https://${gh[0]}`;
    const site = website(resume, linkedin);
    if (site) out.website = site;
    // City / state: "Springfield, NY" in the resume's first lines, else LinkedIn's "Springfield, New York, United States".
    const cs = first(/\b([A-Z][A-Za-z.' -]{1,30}?),\s*([A-Z]{2})\b/, lines(resume).slice(0, 6).join("\n"));
    if (cs && STATES[cs[2]]) {
      out.city = cs[1].trim();
      out.state = STATES[cs[2]];
    } else {
      const names = Object.values(STATES).join("|");
      const lm = lines(linkedin).map((l) => l.match(new RegExp(`^([A-Z][A-Za-z.' -]{1,30}),\\s*(${names}),\\s*United States$`))).find(Boolean);
      if (lm) {
        out.city = lm[1];
        out.state = lm[2];
      }
    }
    // Skills: the resume's list, and LinkedIn's Top Skills as a separate suggestion (only those the resume's list lacks),
    // so one can be taken without the other.
    const seen = new Set();
    const uniq = (xs) => xs.filter((s) => !seen.has(s.toLowerCase()) && seen.add(s.toLowerCase()));
    const mine = uniq(skillsFrom(resume));
    const top = uniq(topSkills(linkedin));
    if (mine.length) out.skills = mine.join(", ");
    if (top.length) out.skillsLinkedIn = top.join(", ");
    return out;
  }
  // A website, only from where a link is given as one (a real file suggested "fly.io", a tool in LinkedIn's Top Skills):
  //   - the resume's header (its lines before the first blank line), a token that looks like a link: http(s)://, www.,
  //     or a domain with a path ("testapplicant.dev/portfolio"); a bare domain there could be a tool or a company;
  //   - a labeled line anywhere ("Website: ...", "Portfolio: ...", "Personal site: ..."), a link or a bare domain;
  //   - LinkedIn's "Contact" section: a line LinkedIn tags as a site ("testapplicant.dev (Personal)" / Portfolio /
  //     Company / Blog / Other), or a token that looks like a link.
  // Never from Skills / Top Skills / tool lists or from sentences. LinkedIn / GitHub links and emails are not websites.
  const LINKY = /^(?:https?:\/\/\S+|www\.[a-z0-9-]+(?:\.[a-z0-9-]+)+\S*|(?:[a-z0-9-]+\.)+[a-z]{2,}\/\S+)$/i;
  const BARE = /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i;
  function website(resume, linkedin) {
    const ok = (tok, bareOk) => {
      tok = String(tok || "").replace(/[.,;:)]+$/, "");
      if (!tok || /@/.test(tok) || /linkedin\.com|github\.com/i.test(tok)) return null;
      if (!LINKY.test(tok) && !(bareOk && BARE.test(tok))) return null;
      return /^https?:/i.test(tok) ? tok : `https://${tok}`;
    };
    const rl = lines(resume);
    const blank = rl.findIndex((l) => !l);
    const header = rl.slice(0, Math.min(6, blank < 1 ? 6 : blank)); // up to the first blank line, 6 lines at most
    for (const l of header) for (const tok of l.split(/[\s|,•·]+/)) if (ok(tok, false)) return ok(tok, false);
    const LABELED = /^(?:website|portfolio|personal (?:site|website|page)|homepage|home page|blog)\s*:\s*(\S+)/i;
    for (const l of [...rl, ...lines(linkedin)]) {
      const m = l.match(LABELED);
      if (m && ok(m[1], true)) return ok(m[1], true);
    }
    const ll = lines(linkedin);
    const c = ll.findIndex((l) => /^contact$/i.test(l));
    if (c >= 0) {
      for (const l of ll.slice(c + 1)) {
        if (!l) break;
        const tagged = l.match(/^(\S+)\s+\((?:personal|portfolio|company|blog|other|website)\)$/i);
        if (tagged && ok(tagged[1], true)) return ok(tagged[1], true);
        for (const tok of l.split(/\s+/)) if (ok(tok, false)) return ok(tok, false);
      }
    }
    return null;
  }
  // Which text a deterministic value came from, for its "Suggested from your ..." note.
  function sourceOf(k, v, resume, linkedin) {
    const has = (t) => {
      const s = String(t || "").toLowerCase();
      if (k === "phone") return s.replace(/\D/g, "").includes(v);
      if (["linkedin", "github", "website"].includes(k)) return s.includes(v.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, ""));
      if (k === "skills") return v.split(", ").every((x) => s.includes(x.toLowerCase()));
      if (k === "state") return s.includes(v.toLowerCase()) || Object.entries(STATES).some(([ab, name]) => name === v && new RegExp(`\\b${ab}\\b`).test(String(t || "")));
      return s.includes(String(v).toLowerCase());
    };
    const r = has(resume);
    const l = has(linkedin);
    return r ? "resume" : l ? "LinkedIn profile" : "resume and LinkedIn profile";
  }
  // "SKILLS" / "Technical Skills" section: its "Label: a, b, c" lines (or plain comma lists) until a blank line.
  function skillsFrom(text) {
    const ls = lines(text);
    const i = ls.findIndex((l) => /^(technical\s+)?skills(\s*(&|and)\s*\w+)?:?$/i.test(l));
    if (i < 0) return [];
    const out = [];
    for (const l of ls.slice(i + 1)) {
      if (!l) break;
      const body = l.includes(":") ? l.slice(l.indexOf(":") + 1) : l;
      const items = body.split(/[,;·•]/).map((x) => x.trim()).filter((x) => x && !/@/.test(x));
      // "CSS and PostgreSQL" at the end of a comma list is two items.
      if (items.length > 1) items.push(...items.pop().split(/\s+and\s+/));
      out.push(...items.filter((x) => x.length <= 60));
    }
    return out;
  }
  // LinkedIn's sidebar "Top Skills": one per line until a blank line.
  function topSkills(text) {
    const ls = lines(text);
    const i = ls.findIndex((l) => /^top skills$/i.test(l));
    if (i < 0) return [];
    const out = [];
    for (const l of ls.slice(i + 1)) {
      if (!l) break;
      out.push(l);
    }
    return out;
  }

  // ---- 2. Claude's reply: schema validation (unknown keys dropped, wrong types = invalid)
  function validDate(d) {
    if (d == null) return null;
    if (typeof d !== "object") throw new Error("a date is not an object");
    const month = d.month == null ? null : Number(d.month);
    const year = d.year == null ? null : Number(d.year);
    if (month != null && !(Number.isInteger(month) && month >= 1 && month <= 12)) throw new Error(`bad month ${d.month}`);
    if (year != null && !(Number.isInteger(year) && year >= 1950 && year <= 2100)) throw new Error(`bad year ${d.year}`);
    return year == null ? null : { month, year };
  }
  const str = (v, what) => {
    if (v == null) return null;
    if (typeof v !== "string") throw new Error(`${what} is not text`);
    return v.trim() || null;
  };
  const list = (v, what) => {
    if (v == null) return [];
    if (!Array.isArray(v)) throw new Error(`${what} is not a list`);
    return v;
  };
  function validSource(s, name) {
    if (s == null) return { experience: [], education: [], languages: [], certifications: [] };
    if (typeof s !== "object" || Array.isArray(s)) throw new Error(`${name} is not an object`);
    return {
      experience: list(s.experience, "experience").map((e) => ({
        company: str(e?.company, "company"),
        title: str(e?.title, "title"),
        location: str(e?.location, "location"),
        start: validDate(e?.start),
        end: validDate(e?.end),
        current: e?.current === true,
        bullets: list(e?.bullets, "bullets").map((b) => str(b, "a bullet")).filter(Boolean),
      })),
      education: list(s.education, "education").map((e) => ({
        school: str(e?.school, "school"),
        degree: str(e?.degree, "degree"),
        field: str(e?.field, "field"),
        start: validDate(e?.start),
        end: validDate(e?.end),
        inProgress: e?.inProgress === true,
      })),
      languages: list(s.languages, "languages").map((l) => ({ name: str(l?.name, "language"), proficiency: str(l?.proficiency, "proficiency") })),
      certifications: list(s.certifications, "certifications").map((c) => str(c, "certification")).filter(Boolean),
    };
  }
  function validate(answer) {
    if (!answer || typeof answer !== "object" || Array.isArray(answer)) throw new Error("the reply is not an object");
    return { resume: validSource(answer.resume, "resume"), linkedin: validSource(answer.linkedin, "linkedin") };
  }

  // ---- 2c. verification against the source text
  const fmt = (d) => (d ? `${d.month ? MONTHS[d.month - 1].slice(0, 3).replace(/^./, (c) => c.toUpperCase()) + " " : ""}${d.year}` : "");
  function dateIn(d, src, what, dropped) {
    if (!d) return null;
    if (!src.includes(` ${d.year} `)) {
      dropped.push(`${what}: ${fmt(d)} (the year isn't in the text)`);
      return null;
    }
    if (d.month) {
      const m = MONTHS[d.month - 1];
      const mm = String(d.month).padStart(2, "0");
      const forms = [`${m} ${d.year}`, `${m.slice(0, 3)} ${d.year}`, `${m.slice(0, 4)} ${d.year}`, `${d.month} ${d.year}`, `${mm} ${d.year}`, `${d.year} ${mm}`];
      if (!forms.some((f) => src.includes(` ${f} `))) {
        dropped.push(`${what}: the month in ${fmt(d)} (only the year is in the text)`);
        return { month: null, year: d.year };
      }
    }
    return d;
  }
  function verify(data, text, from, dropped) {
    const src = norm(text);
    const keep = (v, what) => {
      if (v == null) return null;
      if (inText(v, src)) return v;
      dropped.push(`${what} "${v}" (${from}: not in the text)`);
      return null;
    };
    const experience = [];
    for (const e of data.experience) {
      const label = `job "${e.title || "?"} at ${e.company || "?"}"`;
      if (!e.company || !e.title || !inText(e.company, src) || !inText(e.title, src)) {
        dropped.push(`${label} (${from}: the ${!e.company || !inText(e.company, src) ? "company" : "title"} isn't in the text)`);
        continue;
      }
      const current = e.current && /\b(present|current|now)\b/.test(src) ? true : false;
      if (e.current && !current) dropped.push(`${label}: "current" (${from}: no Present / Current in the text)`);
      experience.push({
        company: e.company,
        title: e.title,
        location: keep(e.location, `${label} location`),
        start: dateIn(e.start, src, `${label} start`, dropped),
        end: current ? null : dateIn(e.end, src, `${label} end`, dropped),
        current,
        bullets: e.bullets.filter((b) => keep(b.replace(/^[•\-*–]\s*/, ""), `${label} bullet`) != null),
      });
    }
    const education = [];
    for (const e of data.education) {
      if (!e.school || !inText(e.school, src)) {
        dropped.push(`school "${e.school || "?"}" (${from}: not in the text)`);
        continue;
      }
      const end = dateIn(e.end, src, `${e.school} end`, dropped);
      education.push({
        school: e.school,
        degree: keep(e.degree, `${e.school} degree`),
        field: keep(e.field, `${e.school} field of study`),
        start: dateIn(e.start, src, `${e.school} start`, dropped),
        end,
        inProgress: !!(e.inProgress && end && /\b(expected|anticipated|present|current|candidate|pursuing)\b/.test(src)),
      });
    }
    const languages = data.languages.filter((l) => keep(l.name, "language") != null).map((l) => ({ name: l.name, proficiency: keep(l.proficiency, `${l.name} proficiency`) }));
    const certifications = data.certifications.filter((c) => keep(c, "certification") != null);
    return { experience, education, languages, certifications };
  }

  // ---- merge: the resume's wording wins, LinkedIn fills gaps, differing dates are flagged
  const coKey = (s) => norm(s).replace(/ (inc|llc|ltd|corp|corporation|co|company|gmbh|plc) /g, " ").trim();
  const same = (a, b) => {
    const x = coKey(a);
    const y = coKey(b);
    return !!x && !!y && (x === y || ` ${x} `.includes(` ${y} `) || ` ${y} `.includes(` ${x} `));
  };
  const dateDiff = (a, b) => !!a && !!b && (a.year !== b.year || (a.month && b.month && a.month !== b.month));
  const span = (e) => `${fmt(e.start) || "?"} – ${e.current ? "Present" : fmt(e.end) || "?"}`;
  function mergeDates(r, l) {
    const conflict = dateDiff(r.start, l.start) || dateDiff(r.end, l.end) || (r.current !== l.current && (r.end || l.end));
    const fill = (a, b) => (a && b && !a.month && b.month && a.year === b.year ? { ...a, month: b.month } : a || b);
    return { start: fill(r.start, l.start), end: r.current ? null : fill(r.end, l.end), conflict: conflict ? `LinkedIn says ${span(l)}; your resume says ${span(r)}. Check the dates (the resume's are filled in).` : null };
  }
  function merge(r, l) {
    const experience = r.experience.map((e) => ({ entry: e, from: "resume" }));
    for (const e of l.experience) {
      const m = experience.find((x) => same(x.entry.company, e.company) && same(x.entry.title, e.title));
      if (!m) {
        experience.push({ entry: e, from: "LinkedIn" });
        continue;
      }
      const d = mergeDates(m.entry, e);
      // Descriptions: the resume's bullets by default; when LinkedIn's text differs, both are kept (`alt`) for the card's
      // toggle. Never picked by length.
      const rText = m.entry.bullets.join("\n");
      const lText = e.bullets.join("\n");
      if (rText && lText && norm(rText) !== norm(lText)) m.alt = { resume: rText, linkedin: lText };
      m.entry = { ...m.entry, location: m.entry.location || e.location, start: d.start, end: d.end, bullets: m.entry.bullets.length ? m.entry.bullets : e.bullets };
      m.from = "resume and LinkedIn";
      if (d.conflict) m.conflict = d.conflict;
    }
    const education = r.education.map((e) => ({ entry: e, from: "resume" }));
    for (const e of l.education) {
      const m = education.find((x) => same(x.entry.school, e.school));
      if (!m) {
        education.push({ entry: e, from: "LinkedIn" });
        continue;
      }
      const d = mergeDates(m.entry, e);
      m.entry = { ...m.entry, degree: m.entry.degree || e.degree, field: m.entry.field || e.field, start: d.start, end: d.end, inProgress: m.entry.inProgress || e.inProgress };
      m.from = "resume and LinkedIn";
      if (d.conflict) m.conflict = d.conflict;
    }
    const languages = [...r.languages];
    for (const x of l.languages) {
      const m = languages.find((y) => norm(y.name) === norm(x.name));
      if (!m) languages.push(x);
      else if (!m.proficiency) m.proficiency = x.proficiency;
    }
    const certifications = [...r.certifications];
    for (const c of l.certifications) if (!certifications.some((x) => norm(x) === norm(c))) certifications.push(c);
    // Most recent first (the order Workday shows): current, then by end, then by start.
    const when = (e) => (e.current ? 9e5 : 0) + ((e.end || e.start)?.year || 0) * 13 + ((e.end || e.start)?.month || 0);
    experience.sort((a, b) => when(b.entry) - when(a.entry));
    return { experience, education, languages, certifications };
  }

  // ---- entries -> Options cards
  const mm = (d) => (d?.month ? String(d.month) : "");
  const yy = (d) => (d?.year ? String(d.year) : "");
  const expCard = (e) => ({ title: e.title, company: e.company, location: e.location || "", current: e.current, type: "", startMonth: mm(e.start), startYear: yy(e.start), endMonth: e.current ? "" : mm(e.end), endYear: e.current ? "" : yy(e.end), description: e.bullets.join("\n") });
  function degreeSteps(degree) {
    const defaults = DEFAULT_DEGREE_OPTIONS.split("\n");
    if (!degree) return DEFAULT_DEGREE_OPTIONS;
    const d = norm(degree);
    const hit = defaults.find((line) => line.split("|").some((alt) => d.includes(norm(alt)) || norm(alt) === d));
    return (hit ? [hit, ...defaults.filter((x) => x !== hit)] : [degree, ...defaults]).join("\n");
  }
  const eduCard = (e) => ({ school: e.school, schoolAliases: "", schoolSearch: schoolKeyword(e.school), degreeOptions: degreeSteps(e.degree), field: e.field || "", fieldFallbacks: e.field || "", gpa: "", startMonth: mm(e.start), startYear: yy(e.start), endYear: yy(e.end) });
  // One overall level (LinkedIn's "Native or Bilingual", "Elementary"): the Combined field only; never "I am fluent" or
  // the separate reading / writing / speaking / comprehension levels (the card says to set those yourself).
  const langCard = (l) => ({ name: l.name, aliases: "", fluent: false, general: l.proficiency || "" });
  const LANG_NOTE = "Only one overall level was given, so it fills Combined. Set reading/writing yourself if they differ.";

  // Education entries that are no degree (a certificate, "Online Certification in ...", a bootcamp, a fellowship) become
  // certification suggestions. A card needs a degree-like credential (bachelor / master / PhD / associate / BS / BA /
  // BE / MBA / high school ...) or, with no credential named, an expected graduation in the text and no non-degree word.
  const DEGREE = /\b(bachelor'?s?|master'?s?|ph\.?\s?d|doctor(ate)?|associate'?s?|mba|b\.?\s?s\.?c?|b\.?\s?a|b\.?\s?e(ng)?|m\.?\s?s\.?c?|m\.?\s?a|m\.?\s?eng|a\.?\s?a\.?s?|high school|secondary school|ged|degree)\b/i;
  const NON_DEGREE = /\b(certificat(e|ion)s?|bootcamp|boot camp|fellowships?|nanodegree|courses?|online program|professional program|micro-?credentials?|training)\b/i;
  function isDegree(e, sources) {
    const cred = e.degree || "";
    if (NON_DEGREE.test(cred) || (!cred && NON_DEGREE.test(e.school))) return false;
    if (DEGREE.test(cred)) return true;
    if (cred) return false;
    return !!(e.inProgress || /expected graduation/i.test(sources));
  }
  // Splits merged education into degree cards and certification names; a non-degree entry is skipped when it's
  // already a certification or its organization is a job (suggested or on the page).
  function splitEducation(education, experience, certs, sources) {
    const jobs = [...experience.map((x) => x.entry.company), ...[...document.querySelectorAll('#experiences .card:not(.suggested) [data-f="company"]')].map((el) => el.value)].filter(Boolean);
    const have = [...certs, ...splitLines($('[data-k="certifications"]').value)];
    const degrees = [];
    const moreCerts = [];
    for (const x of education) {
      if (isDegree(x.entry, sources)) {
        degrees.push(x);
        continue;
      }
      const name = x.entry.degree ? `${x.entry.degree}, ${x.entry.school}` : x.entry.school;
      if (jobs.some((co) => same(co, x.entry.school))) log(`education entry "${name}": not a degree, and ${x.entry.school} is already a job; not added`);
      else if (have.some((c) => norm(c).includes(norm(x.entry.degree || x.entry.school)))) log(`education entry "${name}": not a degree, already a certification; not added`);
      else {
        log(`education entry "${name}": not a degree; suggested as a certification`);
        moreCerts.push(name);
      }
    }
    return { degrees, moreCerts };
  }
  const splitLines = (s) => String(s || "").split("\n").map((x) => x.trim()).filter(Boolean);

  // ---- state (chrome.storage.local `prefill`): { at, fields: { key: { value, from } }, cards: [{ id, kind, item, from,
  // conflict }], summary, dropped: [], ranFor }
  let state = null;
  let descs = []; // [{ company, title, resume, linkedin }]: jobs whose two descriptions differ
  const persist = () => chrome.storage.local.set({ prefill: state });
  async function loadState() {
    ({ prefill: state = null, prefillDescs: descs = [] } = await chrome.storage.local.get(["prefill", "prefillDescs"]));
    if (state) state.extras ??= {};
    return state;
  }
  async function clearIfDone() {
    if (state && !Object.keys(state.fields).length && !state.cards.length && !Object.keys(state.extras || {}).length) {
      state = null;
      await chrome.storage.local.remove("prefill");
    }
  }

  // Runs the prefill. Returns the summary text.
  async function run({ resumeText, linkedinText, auto = false } = {}) {
    const resume = String(resumeText ?? $('[data-k="resumeText"]').value ?? "");
    const linkedin = String(linkedinText ?? $('[data-k="linkedinText"]').value ?? "");
    if (!resume.trim() && !linkedin.trim()) return setSummary("Nothing to read yet: upload a PDF resume or paste your resume / LinkedIn text first.");
    const ranFor = `${resume.length}:${linkedin.length}:${norm(resume + linkedin).slice(0, 200)}`;
    await loadState();
    // The setup guide runs it once per resume / LinkedIn text (`prefillRanFor`, kept after every suggestion is handled,
    // so going Back and Next again doesn't ask Claude a second time); the button always runs it.
    const { prefillRanFor } = await chrome.storage.local.get("prefillRanFor");
    if (auto && prefillRanFor === ranFor) {
      render();
      return setSummary("Already filled from this resume; upload a new one to get new suggestions.");
    }
    await chrome.storage.local.set({ prefillRanFor: ranFor });
    const fields = {};
    const det = deterministic(resume, linkedin);
    for (const [k, v] of Object.entries(det)) if (FIELDS.includes(k) && v) fields[k] = { value: v, from: sourceOf(k, v, resume, linkedin) };
    const extras = det.skillsLinkedIn ? { skillsLinkedIn: { value: det.skillsLinkedIn, from: "LinkedIn profile" } } : {};
    let newDescs = [];
    const dropped = [];
    const cards = [];
    let note = "";
    const key = $('[data-k="api.key"]').value.trim();
    if (!key) note = "Add a Claude API key (setup step 2) to also fill your work history, education and languages.";
    else if (settings?.useAI === false) note = "Claude is turned off (toolbar popup), so work history and education weren't read.";
    else {
      setSummary("Reading your resume into the form…");
      const res = await chrome.runtime.sendMessage({ type: "PREFILL", resumeText: resume, linkedinText: linkedin }).catch((e) => ({ error: e.message }));
      let data = null;
      try {
        if (res?.error) throw new Error(res.error);
        data = validate(res?.answers?.[0]?.answer);
      } catch (e) {
        note = `Couldn't read your work history with Claude (${e.message}); fill it in yourself.`;
        log("Claude reply not used:", e.message);
      }
      if (data) {
        const r = verify(data.resume, resume, "resume", dropped);
        const l = verify(data.linkedin, linkedin, "LinkedIn", dropped);
        const m = merge(r, l);
        m.experience.forEach((x, i) => cards.push({ id: `exp${i}`, kind: "experience", item: expCard(x.entry), from: x.from, conflict: x.conflict || null }));
        newDescs = m.experience.filter((x) => x.alt).map((x) => ({ company: x.entry.company, title: x.entry.title, ...x.alt }));
        const { degrees, moreCerts } = splitEducation(m.education, m.experience, m.certifications, `${resume}\n${linkedin}`);
        degrees.forEach((x, i) => cards.push({ id: `edu${i}`, kind: "education", item: eduCard(x.entry), from: x.from, conflict: x.conflict || null }));
        m.languages.forEach((x, i) => cards.push({ id: `lang${i}`, kind: "language", item: langCard(x), from: "resume / LinkedIn", note: LANG_NOTE }));
        const certs = [...m.certifications, ...moreCerts];
        if (certs.length) fields.certifications = { value: certs.join("\n"), from: "resume / LinkedIn" };
        const grad = degrees.find((x) => x.entry.inProgress && x.entry.end?.month);
        if (grad) fields.expectedGraduation = { value: `${String(grad.entry.end.month).padStart(2, "0")}/${grad.entry.end.year}`, from: grad.from };
        for (const d of dropped) log("dropped", d);
      }
    }
    state = { at: Date.now(), ranFor, fields, extras, cards, dropped, note };
    // Both descriptions of a job on the resume and LinkedIn, kept apart from the suggestions (the toggle stays after
    // Accept and after a reload): chrome.storage.local `prefillDescs`.
    descs = newDescs;
    await chrome.storage.local.set({ prefillDescs: descs });
    const counts = render();
    state.summary = summaryText(counts);
    await persist();
    await clearIfDone();
    return setSummary(state?.summary || summaryText(counts));
  }
  function summaryText(c) {
    const parts = [`Filled ${c.filled} field${c.filled === 1 ? "" : "s"} from your resume; review each step.`];
    if (c.replace) parts.push(`${c.replace} differ from what you already entered: "Replace" is offered beside them.`);
    if (c.skipped) parts.push(`${c.skipped} already in your profile, not added again.`);
    if (c.conflicts) parts.push(`${c.conflicts} with dates that differ between your resume and LinkedIn: check them.`);
    if (state?.dropped?.length) parts.push(`Left out ${state.dropped.length} item${state.dropped.length === 1 ? "" : "s"} not found in your text.`);
    if (state?.note) parts.push(state.note);
    return parts.join(" ");
  }
  function setSummary(text) {
    for (const id of ["#prefillStatus", "#prefillSummary"]) {
      const el = $(id);
      if (!el) continue;
      el.textContent = text || "";
      if (text && state?.dropped?.length) {
        const d = document.createElement("details");
        d.innerHTML = "<summary>Left out</summary>";
        const ul = document.createElement("ul");
        for (const x of state.dropped) ul.appendChild(Object.assign(document.createElement("li"), { textContent: x }));
        d.appendChild(ul);
        el.appendChild(d);
      }
    }
    return text;
  }

  // ---- rendering: suggestions into the real fields and cards
  const CONTAINER = { experience: ["#experiences", "#expTpl"], education: ["#education", "#eduTpl"], language: ["#languages", "#langTpl"] };
  function ctl(text, buttons) {
    const box = document.createElement("span");
    box.className = "sugg-ctl";
    box.append(text);
    for (const [label, fn, aria] of buttons) {
      const b = Object.assign(document.createElement("button"), { type: "button", className: "linkbtn", textContent: label });
      if (aria) b.setAttribute("aria-label", aria);
      b.addEventListener("click", (e) => {
        e.preventDefault();
        fn();
      });
      box.append(" ", b);
    }
    return box;
  }
  const cardBlank = (card) => [...card.querySelectorAll("[data-f]")].every((el) => (el.type === "checkbox" ? !el.checked : !el.value.trim() || el.dataset.f === "degreeOptions" || el.dataset.f === "schoolSearch" || el.dataset.f === "fieldFallbacks"));
  function cardMatches(kind, card, item) {
    const v = (f) => card.querySelector(`[data-f="${f}"]`)?.value || "";
    if (kind === "experience") return same(v("company"), item.company) && same(v("title"), item.title);
    if (kind === "education") return same(v("school"), item.school);
    return norm(v("name")) === norm(item.name);
  }

  // The value already there says the same: case / spacing / punctuation aside; links without https:// / www. / a
  // trailing slash; phones by their last 10 digits; dates by month and year ("05/21/2027" is "05/2027").
  function sameValue(k, a, b) {
    if (norm(a) === norm(b)) return true;
    if (["linkedin", "github", "website"].includes(k)) {
      const u = (x) => x.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "");
      return u(a) === u(b);
    }
    if (k === "phone") return a.replace(/\D/g, "").slice(-10) === b.replace(/\D/g, "").slice(-10);
    if (k === "expectedGraduation") {
      const my = (x) => {
        const m = x.match(/^(\d{1,2})\/(?:\d{1,2}\/)?(\d{4})$/);
        return m ? `${Number(m[1])}/${m[2]}` : x;
      };
      return my(a) === my(b);
    }
    return false;
  }

  // Puts the state on the page (after load() re-rendered it). Returns the counts for the summary.
  function render() {
    const counts = renderSuggestions();
    renderDescs();
    return counts;
  }
  function renderSuggestions() {
    document.querySelectorAll(".sugg-ctl, .sugg-bar").forEach((el) => el.remove());
    // A suggested field was empty before the suggestion went in: empty it again before placing the suggestions anew.
    document.querySelectorAll("[data-suggest]").forEach((el) => {
      el.value = "";
      el.classList.remove("suggested");
      delete el.dataset.suggest;
    });
    document.querySelectorAll(".card.suggested").forEach((c) => c.remove());
    const counts = { filled: 0, replace: 0, skipped: 0, conflicts: 0 };
    if (!state) return counts;
    for (const [k, s] of Object.entries(state.fields)) {
      const el = $(`[data-k="${k}"]`);
      if (!el || !FIELDS.includes(k)) continue;
      const cur = el.value.trim();
      if (cur && sameValue(k, cur, s.value)) {
        delete state.fields[k];
        continue;
      }
      if (!cur) {
        el.value = s.value;
        el.dataset.suggest = "1";
        el.classList.add("suggested");
        el.closest("label").append(ctl(`Suggested from your ${s.from}.`, [["Accept", () => acceptField(k)], ["Edit", () => el.focus()], ["Discard", () => discardField(k)]]));
        counts.filled++;
      } else {
        el.closest("label").append(ctl(`Your ${s.from} says "${s.value.length > 80 ? s.value.slice(0, 80) + "…" : s.value}".`, [["Replace", () => replaceField(k)], ["Dismiss", () => discardField(k)]]));
        counts.replace++;
      }
    }
    // LinkedIn's Top Skills: their own suggestion under Skills, only the ones the field (yours or the resume's
    // suggestion) doesn't list yet; "Add to skills" appends them.
    const xs = state.extras?.skillsLinkedIn;
    if (xs) {
      const el = $('[data-k="skills"]');
      const add = missingSkills(el.value, xs.value);
      if (!add.length) delete state.extras.skillsLinkedIn;
      else {
        const box = ctl(`Your LinkedIn Top Skills add: ${add.join(", ")}.`, [["Add to skills", () => addLinkedInSkills()], ["Discard", () => discardExtra("skillsLinkedIn")]]);
        box.dataset.extra = "skillsLinkedIn";
        el.closest("label").append(box);
        counts.filled++;
      }
    }
    const blanksRemoved = new Set();
    for (const c of state.cards) {
      const [boxSel, tpl] = CONTAINER[c.kind];
      const box = $(boxSel);
      const existing = [...box.querySelectorAll(".card:not(.suggested)")];
      if (existing.some((card) => !cardBlank(card) && cardMatches(c.kind, card, c.item))) {
        log(`${c.kind} "${c.item.title || c.item.school || c.item.name}" is already in your profile; not added`);
        counts.skipped++;
        c.skip = true;
        continue;
      }
      // An empty template card (Options starts with one blank job / school) makes room for the suggestions.
      if (!blanksRemoved.has(boxSel)) {
        existing.filter(cardBlank).forEach((card) => card.remove());
        blanksRemoved.add(boxSel);
      }
      const node = addCard(box, tpl, c.item);
      node.classList.add("suggested");
      node.dataset.sid = c.id;
      const what = c.kind === "experience" ? `${c.item.title} at ${c.item.company}` : c.kind === "education" ? c.item.school : c.item.name;
      const head = ctl(`Suggested from your ${c.from}.`, [["Accept", () => acceptCard(c.id), `Accept ${what}`], ["Discard", () => discardCard(c.id), `Discard ${what}`]]);
      if (c.conflict) {
        head.append(Object.assign(document.createElement("span"), { className: "sugg-conflict", textContent: ` ${c.conflict}` }));
        counts.conflicts++;
      }
      node.prepend(head);
      // A note that stays after Accept (a language with one overall level).
      if (c.note) node.querySelector(".grid").after(Object.assign(document.createElement("p"), { className: "hint card-note", textContent: c.note }));
      counts.filled++;
    }
    state.cards = state.cards.filter((c) => !c.skip);
    // Accept all / Discard all per section.
    for (const sec of document.querySelectorAll("main > section")) {
      const n = sec.querySelectorAll("[data-suggest], .card.suggested, [data-extra]").length;
      if (!n) continue;
      const bar = ctl(`${n} suggestion${n === 1 ? "" : "s"} from your resume.`, [["Accept all", () => acceptIn([sec])], ["Discard all", () => discardIn([sec])]]);
      bar.classList.replace("sugg-ctl", "sugg-bar");
      sec.querySelector("h2").after(bar);
    }
    return counts;
  }
  const splitSkills = (s) => String(s || "").split(",").map((x) => x.trim()).filter(Boolean);
  const missingSkills = (have, add) => {
    const h = new Set(splitSkills(have).map((x) => x.split("|")[0].trim().toLowerCase()));
    return splitSkills(add).filter((x) => !h.has(x.toLowerCase()));
  };
  async function addLinkedInSkills({ quiet = false } = {}) {
    const el = $('[data-k="skills"]');
    const add = missingSkills(el.value, state.extras.skillsLinkedIn?.value);
    // Adding to the field makes its whole content yours: a pending resume suggestion there is accepted with it.
    if (el.dataset.suggest) await acceptField("skills", { quiet: true });
    el.value = [...splitSkills(el.value), ...add].join(", ");
    delete state.extras.skillsLinkedIn;
    if (!quiet) {
      changed();
      await persist();
      await refreshBars();
    }
  }
  async function discardExtra(k) {
    delete state.extras[k];
    await persist();
    await refreshBars();
  }

  // ---- job descriptions: the resume's / LinkedIn's toggle (merged jobs whose texts differ) and the length warning
  const LIMIT = 2000; // a common Workday Role Description limit
  const chars = (n) => `${n.toLocaleString("en-US")} characters${n > LIMIT ? ` (over ${LIMIT.toLocaleString("en-US")})` : ""}`;
  const descOf = (card) => card.querySelector('[data-f="description"]');
  function renderDescs() {
    document.querySelectorAll("#experiences .desc-alt, #experiences .desc-warn").forEach((el) => el.remove());
    for (const card of document.querySelectorAll("#experiences .card")) {
      const ta = descOf(card);
      const label = ta.closest("label");
      const warn = Object.assign(document.createElement("div"), { className: "desc-warn full", hidden: true });
      label.after(warn);
      updateWarn(card);
      const co = card.querySelector('[data-f="company"]').value;
      const ti = card.querySelector('[data-f="title"]').value;
      const d = descs.find((x) => same(x.company, co) && same(x.title, ti));
      // The toggle only while the box holds one of the two texts: never over your own edit.
      const using = !d ? null : norm(ta.value) === norm(d.resume) ? "resume" : norm(ta.value) === norm(d.linkedin) ? "linkedin" : null;
      if (!using) continue;
      const other = using === "resume" ? "linkedin" : "resume";
      const box = ctl(`Description from your ${using === "resume" ? "resume" : "LinkedIn profile"}. Resume: ${chars(d.resume.length)}; LinkedIn: ${chars(d.linkedin.length)}.`, [[using === "resume" ? "Use LinkedIn description instead" : "Use resume description", () => useDesc(card, d[other])]]);
      box.className = "desc-alt full sugg-note";
      label.after(box);
    }
  }
  function updateWarn(card) {
    const warn = card.querySelector(".desc-warn");
    const n = descOf(card).value.length;
    if (!warn) return;
    warn.hidden = n <= LIMIT;
    warn.textContent = n > LIMIT ? `This description is ${n.toLocaleString("en-US")} characters, over ${LIMIT.toLocaleString("en-US")}: Workday's Role Description field may not take it all.` : "";
  }
  async function useDesc(card, text) {
    descOf(card).value = text;
    if (card.classList.contains("suggested")) {
      const c = state?.cards.find((x) => x.id === card.dataset.sid);
      if (c) c.item.description = text;
      await persist();
    } else changed();
    renderDescs();
  }
  $("#experiences").addEventListener("input", (e) => {
    const card = e.target.closest?.(".card");
    if (!card || e.target.dataset.f !== "description") return;
    updateWarn(card);
    // An edit that matches neither text hides the toggle (and one that matches again brings it back).
    const had = !!card.querySelector(".desc-alt");
    const d = descs.find((x) => same(x.company, card.querySelector('[data-f="company"]').value) && same(x.title, card.querySelector('[data-f="title"]').value));
    const now = !!d && [d.resume, d.linkedin].some((t) => norm(t) === norm(e.target.value));
    if (had !== now) renderDescs();
  });

  const refreshBars = async () => {
    await clearIfDone();
    const keepSummary = $("#prefillStatus")?.textContent;
    render();
    if (!state) setSummary(keepSummary ? "All suggestions reviewed." : "");
  };
  async function acceptField(k, { quiet = false } = {}) {
    const el = $(`[data-k="${k}"]`);
    if (el) {
      el.classList.remove("suggested");
      delete el.dataset.suggest;
    }
    delete state.fields[k];
    if (!quiet) {
      changed();
      await persist();
      await refreshBars();
    }
  }
  async function discardField(k) {
    const el = $(`[data-k="${k}"]`);
    if (el?.dataset.suggest) el.value = "";
    if (el) {
      el.classList.remove("suggested");
      delete el.dataset.suggest;
    }
    delete state.fields[k];
    await persist();
    await refreshBars();
  }
  async function replaceField(k) {
    const el = $(`[data-k="${k}"]`);
    el.value = state.fields[k].value;
    delete state.fields[k];
    changed();
    await persist();
    await refreshBars();
  }
  async function acceptCard(id, { quiet = false } = {}) {
    const node = document.querySelector(`.card.suggested[data-sid="${id}"]`);
    if (node) {
      node.classList.remove("suggested");
      delete node.dataset.sid;
      node.querySelector(".sugg-ctl")?.remove();
    }
    state.cards = state.cards.filter((c) => c.id !== id);
    if (!quiet) {
      changed();
      await persist();
      await refreshBars();
    }
  }
  async function discardCard(id) {
    document.querySelector(`.card.suggested[data-sid="${id}"]`)?.remove();
    state.cards = state.cards.filter((c) => c.id !== id);
    await persist();
    await refreshBars();
  }
  // Accept / discard everything suggested inside these sections (the setup step's Next accepts its step's).
  async function acceptIn(sections) {
    if (!state) return 0;
    let n = 0;
    for (const sec of sections) {
      for (const el of sec.querySelectorAll("[data-suggest]")) await acceptField(el.dataset.k, { quiet: true }), n++;
      for (const card of sec.querySelectorAll(".card.suggested")) await acceptCard(card.dataset.sid, { quiet: true }), n++;
      if (sec.querySelector('[data-extra="skillsLinkedIn"]')) await addLinkedInSkills({ quiet: true }), n++;
    }
    if (n) {
      changed();
      await persist();
      await refreshBars();
    }
    return n;
  }
  async function discardIn(sections) {
    for (const sec of sections) {
      for (const el of sec.querySelectorAll("[data-suggest]")) await discardField(el.dataset.k);
      for (const card of sec.querySelectorAll(".card.suggested")) await discardCard(card.dataset.sid);
      if (sec.querySelector('[data-extra="skillsLinkedIn"]')) await discardExtra("skillsLinkedIn");
    }
  }
  // Editing a suggested field or card makes it yours (accepted).
  $("main").addEventListener("input", (e) => {
    if (!state) return;
    const el = e.target;
    if (el.dataset?.suggest) acceptField(el.dataset.k);
    const card = el.closest?.(".card.suggested");
    if (card) acceptCard(card.dataset.sid);
  });

  async function show() {
    await loadState();
    render();
    if (state?.summary) setSummary(state.summary);
  }
  $("#prefillBtn")?.addEventListener("click", async () => {
    const b = $("#prefillBtn");
    b.disabled = true;
    try {
      await run();
    } finally {
      b.disabled = false;
    }
  });

  // Options' Clear fields: the suggestions go with the profile.
  async function reset() {
    state = null;
    descs = [];
    await chrome.storage.local.remove(["prefill", "prefillDescs", "prefillRanFor"]);
    render();
    setSummary("");
  }

  globalThis.AAF_PREFILL = { run, show, render, reset, acceptIn, discardIn, discardCard, deterministic, validate, verify, merge, FIELDS };
  // The setup guide calls this after the API key step (onboarding.js `hooks.afterMaterials`).
  if (globalThis.AAF_ONBOARDING) AAF_ONBOARDING.hooks.afterMaterials = (t) => run({ ...t, auto: true });
  // The first load() may finish before this file has loaded (load() calls show() too, for later loads): draw the
  // pending suggestions once it's done.
  optionsReady.then(show);
})();
