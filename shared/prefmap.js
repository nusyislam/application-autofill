// Application Autofill: preference mapping. The candidate's own choices (an Options checklist, e.g. "Role
// interests") onto a form's option labels, for preference questions ("What type of engineering role are you
// interested in?", "Which teams interest you?"):
//   1. a built-in synonym map from each standard area to common option wordings ("Infrastructure" = Infra =
//      Platform; "AI/ML" = AI = ML = Machine Learning = Applied AI);
//   2. options the map can't place at all: one small Haiku call (background.js MAP_PREFS) that may only map the
//      areas the candidate checked onto THIS form's options. No profile facts are sent, and it can never add an
//      area the candidate didn't check.
// The lists below have no dependencies (Options loads this file too: `globalThis.AAF_PREFMAP`). The content-script
// part (`AAF.mapPreferences`) is added only when the AAF namespace exists. Other preference questions can reuse
// it: give `mapPreferences` their own areas and synonym map.

(() => {
  const norm = (s) =>
    String(s || "")
      .normalize("NFKC")
      .replace(/[​-‍⁠﻿­]/g, "")
      .toLowerCase()
      .replace(/[’']/g, "")
      .replace(/[^a-z0-9+#]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  // Role interests: the standard areas Options offers (a fixed checklist, empty by default) and the option
  // wordings each one covers. Generic words (engineering, engineer, developer, software, team, role) are ignored
  // on both sides, so "Infrastructure Engineering" and "Infra team" are both "infrastructure" / "infra".
  const ROLE_AREAS = ["Frontend", "Backend", "Full-stack", "Mobile", "AI/ML", "Data", "Infrastructure/Platform", "DevOps/SRE", "Security", "Embedded/Hardware", "Product engineering", "Growth", "Forward-deployed/Solutions"];
  const ROLE_SYNONYMS = {
    Frontend: ["frontend", "front end", "ui", "web frontend", "client side", "web ui", "web"],
    Backend: ["backend", "back end", "server", "server side", "api", "apis"],
    "Full-stack": ["full stack", "fullstack"],
    Mobile: ["mobile", "ios", "android", "react native", "mobile apps"],
    "AI/ML": ["ai", "ml", "ai ml", "machine learning", "applied ai", "artificial intelligence", "applied ml", "deep learning", "llm", "llms", "genai", "generative ai"],
    Data: ["data", "data engineering", "data infrastructure", "data platform", "analytics", "analytics engineering"],
    "Infrastructure/Platform": ["infrastructure", "infra", "platform", "cloud infrastructure", "cloud", "distributed systems", "core infrastructure"],
    "DevOps/SRE": ["devops", "sre", "site reliability", "reliability", "production engineering"],
    Security: ["security", "appsec", "application security", "infosec", "product security"],
    "Embedded/Hardware": ["embedded", "hardware", "firmware", "embedded systems", "robotics"],
    "Product engineering": ["product", "product engineering"],
    Growth: ["growth"],
    "Forward-deployed/Solutions": ["forward deployed", "fde", "solutions", "solutions engineering", "customer engineering", "field engineering", "implementation", "deployment strategist"],
  };
  const GENERIC = /\b(engineering|engineer|engineers|developer|developers|development|software|team|teams|role|roles|position|positions|focused|focus|work)\b/g;
  const core = (s) => norm(s).replace(GENERIC, " ").replace(/\s+/g, " ").trim();

  // The areas an option covers (several for "Data / ML" or "Product (Full-stack)"). A synonym counts when it is the
  // option's whole core or a whole phrase inside it.
  function areasOf(option, synonyms) {
    const c = core(option);
    if (!c) return [];
    const out = [];
    for (const [area, words] of Object.entries(synonyms))
      if ([area, ...words].some((w) => {
        const k = core(w);
        return k && (c === k || (" " + c + " ").includes(" " + k + " "));
      }))
        out.push(area);
    return out;
  }
  // { picks: options for a checked area (checked-area order, then page order), unmapped: options the map can't
  // place at all, byOption: option -> areas }.
  function mapLocal(options, checked, synonyms = ROLE_SYNONYMS) {
    const order = new Map(checked.map((a, i) => [a, i]));
    const byOption = new Map();
    const unmapped = [];
    for (const o of options) {
      const as = areasOf(o, synonyms);
      byOption.set(o, as);
      if (!as.length) unmapped.push(o);
    }
    const rank = (o) => Math.min(...byOption.get(o).filter((a) => order.has(a)).map((a) => order.get(a)));
    const picks = options.filter((o) => byOption.get(o).some((a) => order.has(a))).sort((a, b) => rank(a) - rank(b));
    return { picks, unmapped, byOption };
  }

  globalThis.AAF_PREFMAP = { norm, ROLE_AREAS, ROLE_SYNONYMS, areasOf, mapLocal };

  const AAF = globalThis.AAF;
  if (!AAF || !AAF.once("prefmap")) return;
  const { dbg, show } = AAF;

  // The options to select for a preference question: the synonym map, then the MAP_PREFS call for the options it
  // can't place. `what` names it in the log. Returns the option texts to select (best first); [] = none (left for you).
  async function mapPreferences(f, { areas, what = "preference", synonyms = ROLE_SYNONYMS }, options) {
    const checked = (areas || []).filter(Boolean);
    const opts = [...new Set((options || []).map((o) => String(o).trim()).filter(Boolean))];
    if (!checked.length || !opts.length) return [];
    const { picks, unmapped } = mapLocal(opts, checked, synonyms);
    dbg(`${what}: your areas ${show(checked)}; options ${show(opts)} -> ${picks.length ? show(picks) : "none by the synonym map"}${unmapped.length ? `; not in the map: ${show(unmapped)}` : ""}`);
    if (!unmapped.length) return picks;
    let res;
    try {
      res = await AAF.untilCancel(chrome.runtime.sendMessage({ type: "MAP_PREFS", question: f.label, options: unmapped, prefs: checked }));
    } catch (e) {
      if (e instanceof AAF.Cancelled) throw e;
      res = { error: e.message };
    }
    if (res?.error) {
      dbg(`${what}: Claude mapping unavailable (${res.error}); the synonym map's picks only`);
      return picks;
    }
    // Only options that were sent, only for areas the candidate checked.
    const extra = (res?.picks || []).filter((x) => unmapped.includes(x.option) && checked.includes(x.area));
    dbg(`${what}: Claude (${res?.model || "?"}) mapped ${extra.length ? extra.map((x) => `"${x.option}" -> ${x.area}`).join(", ") : "none of them"}`);
    const all = [...picks, ...extra.map((x) => x.option).filter((o) => !picks.includes(o))];
    return all;
  }

  // ---- Meaning -> option (all portals). A rule's answer is a meaning ("Yes", "No", "None", "N/A"), not an option
  // string. When the form has no option with that literal text, this picks the one that expresses it:
  //   1. exact (case / punctuation ignored);
  //   2. synonyms: yes = "I am / I can / I do / I have / I will / Correct ...", no = "I am not / I do not / I have never
  //      / I cannot / Never ...", none / not applicable = "None", "N/A", "Not applicable", "Does not apply"; never a
  //      negated option for yes, never "Other" / "Prefer not to say" for anything;
  //   3. one small Haiku call (background.js MAP_MEANING) that may only choose among the given options to express the
  //      given meaning (no facts added; the page text goes as data).
  // Returns { text, why } or null (nothing clearly expresses it: left for you).
  const NEGATED = /\b(not|no|never|cannot|can t|cant|don t|dont|do not|won t|wont|unable|unwilling|haven t|havent|isn t|aren t)\b/;
  const EVASIVE = /\b(other|prefer not|decline|rather not|don t wish|dont wish|not sure|unsure|maybe)\b/;
  const MEANINGS = {
    yes: [/^(yes|y|yeah|yep|correct|true|affirmative|absolutely|definitely|of course|sure)\b/, /^(i am|i m|im|i can|i do|i have|i will|i would|i agree|we can|i currently|i understand|understood|i acknowledge|acknowledged)\b/],
    no: [/^(no|n|nope|false|never|negative)\b/, /^(i am not|i m not|i do not|i don t|i dont|i have not|i haven t|i have never|i ve never|i cannot|i can t|i will not|i won t|not (at this time|currently|applicable to me))\b/],
    none: [/^(none|none of (the|these) above|n a|na|not applicable|does not apply|no )\b/],
    na: [/^(n a|na|not applicable|does not apply|none)\b/],
  };
  async function mapMeaning(f, { meaning, what = "", question = "", detail = "" }, options) {
    const m = String(meaning || "").toLowerCase().replace(/^n\/?a$/, "na");
    const opts = [...new Set((options || []).map((o) => String(o).trim()).filter(Boolean))];
    if (!opts.length || !MEANINGS[m]) return null;
    const exact = opts.find((o) => norm(o) === norm(meaning));
    if (exact) return { text: exact, why: "exact" };
    const [strong, weak = null] = MEANINGS[m];
    const fits = (o) => !EVASIVE.test(norm(o)) && (m !== "yes" || !NEGATED.test(norm(o)));
    const syn = opts.find((o) => fits(o) && strong.test(norm(o))) || (weak && opts.find((o) => fits(o) && weak.test(norm(o))));
    if (syn) return { text: syn, why: "same meaning" };
    let res;
    try {
      res = await AAF.untilCancel(chrome.runtime.sendMessage({ type: "MAP_MEANING", question: question || f.label, meaning: m, detail, options: opts }));
    } catch (e) {
      if (e instanceof AAF.Cancelled) throw e;
      res = { error: e.message };
    }
    if (res?.error || !res?.option) {
      if (res?.error) dbg(`${what || "meaning"}: Claude mapping unavailable (${res.error})`);
      return null;
    }
    return opts.includes(res.option) ? { text: res.option, why: `Claude (${res.model || "?"}) chose it among the options` } : null;
  }

  Object.assign(AAF, { mapPreferences, mapMeaning, ROLE_AREAS, ROLE_SYNONYMS });
})();
