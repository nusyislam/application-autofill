// Application Autofill: shared option matching (scored best match, phrase and abbreviation
// matching, and the ordered-step matcher used for degree / language / proficiency).

(() => {
  const AAF = globalThis.AAF;
  if (!AAF.once("matching")) return;
  const { norm } = AAF;

  // `phrase` appears in `text` as whole words ("Lakeview University" in "LSU Lakeview University",
  // but "Bachelor" not in "Bachelors"). Only for school and degree matching, never skills.
  const hasPhrase = (text, phrase) => {
    const p = norm(phrase);
    return !!p && (" " + norm(text) + " ").includes(" " + p + " ");
  };
  // Like hasPhrase, but not when negated: "Native" doesn't count in "Non-Native", "Fluent" not in "Not Fluent".
  const hasPosPhrase = (text, phrase) => {
    const t = " " + norm(text) + " ";
    const p = norm(phrase);
    return !!p && t.includes(" " + p + " ") && !["non", "not", "no"].some((n) => t.includes(" " + n + " " + p + " "));
  };
  // Abbreviations (BE, B.E., BS, BSc, BEng: at most 4 letters, at least 2 capitals) match only as a
  // case-sensitive token with optional dots, so "BE" can't match the word "be" in "To Be Determined".
  const isAbbrev = (alt) => {
    const letters = alt.replace(/[^A-Za-z]/g, "");
    return letters.length <= 4 && (letters.match(/[A-Z]/g) || []).length >= 2 && !/\s/.test(alt.trim());
  };
  const abbrevIn = (text, alt) => {
    const letters = alt.replace(/[^A-Za-z]/g, "");
    const rx = new RegExp("(^|[^A-Za-z])" + letters.split("").map((ch) => ch + "\\.?").join("") + "(?![A-Za-z])");
    return rx.test(text);
  };

  // ------------------------------------------------------- option matching
  // norm() drops apostrophes, so "I don't wish to answer" is "i dont wish to answer": list both forms.
  const DECLINE = ["i do not wish", "i dont wish", "decline", "not declared", "prefer not", "do not want to answer", "dont want to answer", "choose not", "not specified"];
  const SYNONYMS = {
    female: ["female", "woman"],
    woman: ["woman", "female"],
    male: ["male", "man"],
    man: ["man", "male"],
    "united states of america": ["united states of america", "united states", "usa"],
  };

  function expandWants(wanted) {
    return []
      .concat(wanted)
      .filter((w) => w != null && w !== "")
      .flatMap((w) => String(w).split("|"))
      .flatMap((w) => {
        const n = norm(w);
        if (/^(decline|prefer not)/.test(n)) return DECLINE;
        return SYNONYMS[n] || [w];
      })
      .map(norm)
      .filter(Boolean);
  }

  function scoreOpt(t, w) {
    if (t === w) return 100;
    if (t.startsWith(w + " ") || w.startsWith(t + " ")) return 85;
    if ((" " + t + " ").includes(" " + w + " ")) return 70;
    if (w.length > 3 && t.includes(w)) return 55;
    if (t.length > 3 && w.includes(t)) return 50;
    const a = new Set(w.split(" "));
    const b = new Set(t.split(" "));
    let inter = 0;
    b.forEach((x) => a.has(x) && inter++);
    return (inter / Math.max(a.size, b.size)) * 60;
  }

  function bestOption(options, wanted, minScore = 35) {
    const wants = expandWants(wanted);
    let best = null;
    let bestScore = 0;
    for (const o of options) {
      const t = norm(o.text);
      if (!t) continue;
      for (const w of wants) {
        const s = scoreOpt(t, w);
        if (s > bestScore) {
          best = o;
          bestScore = s;
        }
      }
    }
    return bestScore >= minScore ? best : null;
  }

  // Ordered-step matching for dropdowns whose wording varies by tenant (degree, language, proficiency).
  // An alternative matches an option exactly or as a whole, non-negated phrase ("Native" never
  // matches "Non-Native"); abbreviations match only as case-sensitive tokens. Within a step, exact
  // beats phrase, then the shortest option.
  // "Bachelor's Degree" = "Bachelor Degree" (iCIMS HMSY's Degree Type list): a possessive degree level
  // is the same word. Exact comparison only; "Bachelor" still never matches "Bachelor of Laws".
  const canon = (s) => norm(s).replace(/\b(bachelor|master|associate)s\b/g, "$1");
  // Field-of-study style names compared as word sets (iCIMS HMSY lists majors as "Engineering,Computer",
  // "Electrical & Computer Engring", "Computer Science & Info System"): order and punctuation ignored,
  // "and / of / in / the" dropped, common abbreviations expanded. Equal word sets only, never a subset.
  const FIELD_ABBR = { engring: "engineering", engrg: "engineering", engr: "engineering", engg: "engineering", eng: "engineering", sci: "science", sciences: "science", tech: "technology", techn: "technology", technol: "technology", info: "information", sys: "systems", system: "systems", mgmt: "management", admin: "administration",
    // Steadfast majors: "Computer Eng.", "Comp. Eng.", "CompE".
    comp: "computer", compsci: "computer science", compe: "computer engineering", cmpe: "computer engineering", elec: "electrical", elect: "electrical", mech: "mechanical", math: "mathematics", maths: "mathematics", econ: "economics" };
  const FIELD_STOP = new Set(["and", "of", "in", "the"]);
  const fieldKey = (s) => canon(s).split(" ").filter(Boolean).flatMap((w) => (FIELD_ABBR[w] || w).split(" ")).filter((w) => !FIELD_STOP.has(w)).sort().join(" ");
  const sameField = (a, b) => !!fieldKey(a) && fieldKey(a) === fieldKey(b);
  function matchAlts(options, alts) {
    const exact = options.find((t) => alts.some((a) => canon(t) === canon(a))) || options.find((t) => alts.some((a) => sameField(t, a)));
    if (exact) return exact;
    const hits = options.filter((t) => alts.some((a) => (isAbbrev(a) ? abbrevIn(t, a) : hasPosPhrase(t, a))));
    return hits.sort((x, y) => x.length - y.length)[0] || null;
  }

  Object.assign(AAF, { hasPhrase, hasPosPhrase, isAbbrev, abbrevIn, expandWants, scoreOpt, bestOption, matchAlts, fieldKey, sameField });
})();
