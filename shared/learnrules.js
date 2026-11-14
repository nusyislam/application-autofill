// Application Autofill: what may be learned. One file for the content scripts (shared/learning.js,
// shared/main.js), the background service worker (the purge, via importScripts) and Options (each
// learned entry's category), so they can't drift apart. No dependencies: it defines
// globalThis.AAF_LEARN_RULES.
//
// A learned answer is the user's own answer to a question the extension left for them, reused on the
// next application. Some answers must never be reused, because they change per role or per moment, or
// because storing them is unsafe:
//   sensitive      passwords, SSN, date of birth, bank / card / passport / license numbers, security answers
//   compensation   expected / desired salary, pay, compensation, rate, salary range
//   notice period  notice to the current employer (an Options setting answers it instead)
//   file upload    resume / cover letter / transcript / any upload question; never a file path
//   location / attendance   onsite, in office, hybrid, remote, relocation, commuting, days per week in office
//   availability   start date / when available (always left yellow)
//   fixed answer   willing to travel, non-compete (answered from Options)
//   date           Month / Day / Year boxes (a change event only sees one box)

(() => {
  if (globalThis.AAF_LEARN_RULES) return;
  const norm = (s) =>
    (s || "")
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[\u200B-\u200D\u2060\uFEFF\u00AD]/g, "")
      .replace(/[’']/g, "")
      .replace(/[^a-z0-9+#]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  // Credentials and identity numbers: never learned, never sent to Claude, never filled.
  // Whole words only: "password" inside a company name (2Password: its work-authorization and former-employee
  // questions were "sensitive field skipped") is not a password field.
  const SENSITIVE = /\b(passwords?|passcodes?|passphrases?)\b|\bssn\b|social security|date of birth|\bdob\b|birth ?date|bank (account|routing)|routing (number|no)|account (number|no)|credit card (number|no)|card number|\bcvv\b|passport (number|no)|driv(er|ers) licen[cs]e (number|no)|security (question|answer)|secret (question|answer)|maiden name/;
  // "When are you available...", start dates. Not "Are you available to work on-site?". (Notice periods
  // are their own rule now: NOTICE_Q.)
  const AVAILABILITY_Q = /\b(which|what|preferred|start|join|intake|available|desired) (\w+ ){0,2}cohorts?\b|\b(prefer|preference)\b.{0,30}\bcohorts?\b|\bcohorts?\b.{0,30}\b(start|begin|join|prefer|apply|available|interested)\b|\b(start|intake) (term|session|cohort|class)\b|when (are|will) you (be )?available|availability date|date (you are|youre) available|available (to |for )?(start|begin)|start date|earliest (possible )?start|when (can|could|would) you (start|begin|join)|desired start|^(what is your )?availability$|\bearliest\b.{0,40}\b(begin|start|join)\b|\b(start|join|joining|commencement) date\b|\bwhen (could|can|would) you (join|commence|be on ?board)\b|\bhow soon (can|could|would) you (start|begin|join)\b/;
  // Notice to the current employer ("What is your notice period?", "How much notice do you need to give?").
  const NOTICE_Q = /notice period|how much notice|(weeks?|days?|months?) (of )?notice|notice (do you|would you|you need|to (give|provide))|\bgive notice\b|\bnotice to (your )?(current|present) employer|\bnotice\b.*\b(current|present) (employer|job|role)\b/;
  const COMPENSATION_Q = /\b(salary|salaries|compensation|wage|wages|remuneration)\b|\b(your|expected|desired|target|requested|minimum|base|what) pay\b|\bpay (expectations?|requirements?|range|rate|scale|band|grade)\b|^pay\b|\bpay\??$|\b(hourly|daily|day|desired|expected|target|minimum|bill|billing|pay) rates?\b|\brates? (expectation|requirement)s?\b|\bwhat (is |are |would be )?(your )?((hourly|daily|day|pay|bill|billing|contract|desired|expected) )?rates?\b(?! of)|\brate (are|do|would|will) you\b|\bctc\b/;
  const FILE_Q = /\bupload\b|\battach(ment|ed)?\b|^(your )?(resume|cv|cover letter|transcript|portfolio file)( cv)?$|\b(resume|cv|cover letter|transcript)s? (file|upload|attachment)\b/;
  // Learned-answers review: "If you do not live in NYC or Chicago, are you open to moving ..." and "This role requires 3
  // days/week in our NYC office ..." were learned: "moving", "days/week" (norm: "days week"), "in our NYC office" and
  // where you live / are based count too.
  const LOCATION_Q = /\b(open|willing|able|plan(ning)?|prepared|consider(ing)?)\b.{0,20}\b(mov(e|ing)|relocat\w*)\b|\bmov(e|ing) (to|for|there|here|closer)\b|\bdays? ?(a |per |each |every |\/ ?)?week\b|\bin (our|the|one of our) (\w+ ){0,3}offices?\b|\boffices?\b.{0,40}\b(days?|weekly|onsite|on site|in person)\b|\byou( do not| dont| don t| currently| now)? (live|reside|are (currently )?(based|located))\b|\bwhere (do|are) you (currently )?(live|living|reside|based|located)\b|\boffices?\b.{0,40}\b(closest|nearest|near|close to)\b|\b(closest|nearest) (office|location)\b|\b(your |current )?residence\b|\bon ?site\b|\bin (the )?office\b|\bin office\b|\bhybrid\b|\bremote(ly)?\b|\brelocat|\bcommut|\bdays? (per|a|each|every) week\b|\bin person\b|\bwork from (home|the office)\b/;
  const TRAVEL_Q = /willing to travel|able to travel|ability to travel|open to travel|comfortable (with )?travel|travel requirement|requires? (up to \d+ )?travel|percent(age)? of (your )?(time )?travel|how much travel|travel up to|travel \d+ ?%|travel for (work|business)/;
  const RESTRICTION_Q = /non ?compete|non ?solicit|restrictive covenant|employment restriction|restrictions? (on|that would (limit|restrict)) (your )?(ability|employment)|bound by (any|an) (agreement|contract)|agreement that (would )?(restrict|limit|prevent)/;
  // Attestations / certifications: truthfulness and conflict statements ("Do you verify your responses are
  // true and complete?", "I agree / certify / acknowledge that ...", a close relationship with people
  // responsible for hiring). Left yellow every time.
  const ATTEST_Q = /\b(verify|certify|attest|acknowledge|affirm|confirm)\b.{0,40}\b(responses?|answers?|information|statements?|application)\b.{0,40}\b(true|complete|accurate|correct|truthful)\b|\bi (hereby )?(agree|certify|acknowledge|attest|affirm|understand) (that|to)\b|\bto the best of my knowledge\b|\btruthful(ly)?\b|^i (hereby )?(certify|acknowledge|agree|attest|affirm|confirm)\b|\bcompleting the application\b.{0,80}\bcertification\b|\banti ?corruption\b.{0,40}\bcertification\b/;
  // Relationship / conflict-of-interest QUESTIONS ("Are you a family member of / do you have a close personal
  // relationship with a government official / an Acme employee or partner?"): facts, learnable (stored for
  // the company when one is named). Statements to agree to stay attestations (checked first).
  // Intent, not a keyword (Lunex: "What is your edge with AI relative to others in your field?" was taken for a
  // relatives question): a relative / family member is a noun ("relatives", "a / any relative", "a relative of"),
  // never "relative to" / "relatively"; "related to" only as "are you related to" or "related to an employee";
  // a personal / close relationship only with someone at the company (employees, officials, people hiring).
  const RELATIONSHIP_Q = /\b(relatives\b(?! to)|(a|any|your|no|other) relatives?\b(?! to)|relatives? (of|who|that|employed|working|currently)\b|(family|household) members?\b(?!.{0,40}\b(inspired|taught|influenced|motivated|shaped)\b)|immediate family|(are you|is anyone|anyone you know|you are) related to|related to (any|an?|someone|anyone)( current| former)? (\w+ ){0,3}(employees?|staff|officials?|directors?|officers?|members?|individuals?|people|persons?)|(familial|romantic) relationships?|(close|personal)( personal| family)?( or (familial|family|romantic))? relationships? with (any |an? |the )?(current |former )?(\w+ ){0,4}(employees?|staff|officials?|directors?|officers?|partners?|individuals?|people|persons?|anyone|someone|members?)|relationships? with (any |an? )?(current )?(\w+ ){0,3}(employees?|partners?)|conflicts? of interest|\b(know|knows|acquainted with) (anyone|someone|any(one)? (person|people|employees?|individuals?))\b.{0,40}\b(works?|working|employed|currently)\b)\b/;
  // EEO / demographic questions (gender, race, ethnicity, veteran / military status, disability, sexual
  // orientation, LGBTQ+, transgender, pronouns, age range): Options settings only. Never learned, never Claude.
  const EEO_Q = /\b(gender|sex|sexual orientation|lgbt\w*|queer|transgender|hispanic|latin[oaxe]|race(?! conditions?)|racial|ethnicity|ethnic|veterans?|military status|service status|disability|disabilities|disabled|pronouns?|age range|age group|current age|your age|how old|^age$|communit(y|ies)\b.{0,30}\b(belong|identify|part of|member))\b/;
  // Keyword collisions (2Password: "password" inside the company name; an accommodations question naming "gender
  // identity"; Lunex: "relative to others"): a word inside an essay prompt is not the question. An open-ended prompt
  // ("Describe / Tell us about / Explain / How would you ...", or a box label over 80 characters) asks for an attribute
  // only when it asks for YOURS ("Please describe your gender identity").
  const ESSAY_PROMPT = /^(please )?(describe|tell (me|us)|explain|walk (me|us)|share|talk (to us )?about|how (would|do|did|have|will) you|what (is|was|are|were) (the|a|an|your) (hardest|biggest|most|best|proudest)|give (me |us )?an example|why\b)/;
  const essayPrompt = (n, type) => (type === "textarea" || type === "text") && (ESSAY_PROMPT.test(n) || n.length > 80);
  const eeoAsks = (n, type) => EEO_Q.test(n) && !(essayPrompt(n, type) && !/\b(your|you identify|do you (have|identify|consider))\b.{0,40}\b(gender|sex|race|ethnicity|veteran|disabilit\w*|orientation|pronouns|age)\b/.test(n));
  // A sensitive word inside an essay prompt ("Explain how you would design a password manager") isn't a request for
  // the secret; one that asks for yours ("Enter your SSN", "Create a password") still is.
  const ASKS_SECRET = /\b(your|enter|create|choose|confirm|re ?enter|provide|type|set)\b.{0,25}\b(passwords?|passcodes?|passphrases?|ssn|social security|date of birth|dob|bank|routing|account number|card number|cvv|passport|licen[cs]e|security (question|answer)|secret|maiden)\b/;
  // How / where did you hear about this job ("How did you hear about us?", "Where did you hear about this role?",
  // "How did you find us?", "Source", "Referral source"): only Options' how-did-you-hear settings answer them
  // (the dropdown fallback list and the free-text value). Never learned. Not "open source".
  const SOURCE_Q = /\b(how|where) did you (first )?(hear|learn|find out|find|come across|discover)\b|\bhow you (first )?(heard|learned|found out|found)\b|\bwhere did you find (this|the|our|us)\b|\bhow did you find us\b|\bwhat brought you (to )?(this|our|us|the)\b|(?<!open )\bsource\b/;
  // Product usage ("Have you used Sherwood?", "Are you a Sherwood customer / user?"): yours, learnable for
  // that company only, never Claude. The "have you used" form only counts when it names the company or "our
  // app / product" (shared/learning.js `isProductUsage`); "Have you used Python?" is a skills question.
  const PRODUCT_Q = /^(are|were) you an? ((current|existing|active|former|regular) )*(\w+ ){0,3}(customer|user)s?\b|\bhave you (ever )?(used|tried)\b|\bdo you (currently )?use\b/;
  // Consent to be contacted by email / text / phone ("Do you consent to being contacted by email or text about
  // this or other opportunities?"): the consent rule's, never learned (and not "recruiting status").
  const CONSENT_Q = /\b(consent|agree|opt ?in)\b.{0,40}\b(contact(ed)?|e ?mail(s|ed)?|text(s|ed)?|sms|messages?|calls?|communications?|communicat)\b|\b(contact(ed)?|e ?mails?|texts?|sms) (me |you )?about (this|other|future|new) (and |or )?(other |future )?(opportunit|role|position|job)/;
  // Recruiting status: offer deadlines, other interviews / processes, referrals.
  // "Have you previously applied to X?", "Have you interviewed with us before?": not employment and not in the profile;
  // learnable, for that company only (learning.js), never Claude.
  const APPLIED_BEFORE = /\b(have|did) you (ever |previously |already |recently |formerly )*(applied|submitted (an |a job )?applications?|interviewed)\b|\b(previously|already|ever) (applied|interviewed)\b|\bprevious(ly)? (applications?|applied)\b|\bapplied (here|to us|with us|for a (role|position|job)) (before|previously)\b/;
  // "How many companies have you worked for?": a count about you, not a named employer; learnable (general).
  const COUNT_EMPLOYERS = /\b(how many|number of|count of)\b.{0,30}\b(companies|employers|organizations|organisations|jobs|positions|roles)\b/;
  // Learned answers that can go stale (you may have applied / interviewed / changed jobs since): reused, but outlined
  // blue to double-check (main.js), unlike other learned fills.
  const staleLearned = (q) => { const n = norm(q || ""); return APPLIED_BEFORE.test(n) || (COUNT_EMPLOYERS.test(n) && !!countQualifier(n)); };
  // What qualifies an employer count ("since graduating", "in the past 5 years", "full-time", "excluding internships"):
  // the question's words minus the plain question's ("how many companies have you worked for (in total / so far)"),
  // lightly stemmed and sorted; "" = the plain count (computed from the work history, profile.js). A learned qualified
  // count is reused only for the same key: "since graduating" is not "since you graduated your first undergraduate degree".
  const COUNT_STEM = new Set("how many number of count the a an different distinct total in overall so far ever prior previous previously companies company employers employer organizations organisations organization jobs job positions roles have has had you your worked work working for at with been employed by held what is are do did".split(" "));
  function countQualifier(q) {
    const n = norm(q || "");
    if (!COUNT_EMPLOYERS.test(n)) return "";
    return [...new Set(n.replace(/\bpast (?=employers?|companies|jobs|roles|positions)/g, "").split(" ").filter((w) => w && !COUNT_STEM.has(w)).map((w) => (w.length > 4 ? w.replace(/(ing|ed|es|s)$/, "") : w)))].sort().join(" ");
  }
  const RECRUITING_Q = /\boffer deadlines?\b|\bdeadlines?\b|\btimelines?\b|\btime ?sensitive\b|\bother (interviews?|offers?|processes|opportunities|companies)\b|\b(interviewing|in process(es)?) (with|elsewhere|at other)\b|\binterviewing\b.{0,30}\belsewhere\b|\bcompeting offers?\b|\bwere you referred\b|\breferred by\b|\breferral\b/;
  // A label that only says to pick ("Please select one of the below options", "Select one"): the question is
  // elsewhere, so the label alone can't be learned.
  const GENERIC_PROMPT = /^(please )?(select|choose|pick)( one| an option| all that apply| one of the (below|following)( options?)?| one option| from the (below|following)( options?)?| the (option|answer) that applies( to you)?)?$/;
  // The company names in a question, replaced with "[company]": only the names given (this application's
  // company, from the posting / site, and its known aliases), with a corporate suffix ("Inc.", "LLP") and a
  // repeated "(PcC)" folded in. Never other capitalized words: "Relative", "Official", "Chief", "State"
  // used to become "[company]" too.
  function companyOut(label, names) {
    let s = String(label || "");
    const SUFFIX = "(?:,?\\s+(?:inc|incorporated|corp|corporation|llc|llp|ltd|limited|co|company|plc|group|holdings|lp)\\b\\.?)*";
    const list = [...new Set((names || []).map((x) => String(x || "").trim()).filter((x) => x.length >= 3))].sort((a, b) => b.length - a.length);
    for (const c of list) {
      const words = c.split(/[\s\W]+/).filter(Boolean).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      if (!words.length) continue;
      s = s.replace(new RegExp(`\\b${words.join("[\\s\\W]{0,3}")}\\b${SUFFIX}`, "gi"), "[company]");
    }
    let prev;
    do {
      prev = s;
      s = s.replace(/\[company\]\s*\(\s*\[company\]\s*\)/g, "[company]").replace(/\[company\][\s,]*(?:(?:of|and|&)\s+)?\[company\]/g, "[company]");
    } while (s !== prev);
    return s;
  }
  // An entry the old normalizing garbled (it replaced any capitalized word, and the original wasn't kept):
  // "[company]" twice, or right next to another capitalized word ("State [company] has", "Chief [company]").
  // Shown "garbled, re-check" in Options and never reused.
  function garbledCompany(x) {
    if (!x || x.orig || !/\[company\]/.test(x.q || "")) return false;
    const q = String(x.q);
    if ((q.match(/\[company\]/g) || []).length >= 2) return true;
    // A capitalized word right before / after it that a question would start with doesn't count ("Does
    // [company] ...", "If [company] ..."); any other does ("State [company] has", "Chief [company]").
    const STARTER = /^(Are|Is|Do|Does|Did|Have|Has|Had|Were|Was|Will|Would|Can|Could|Should|Please|If|When|Where|Why|How|What|Which|Who|At|In|For|By|With|Our|The|Your|To|Of|And|Or|I)$/;
    for (const m of q.matchAll(/\b([A-Z][a-z]+) \[company\]|\[company\] ([A-Z][a-z]+)/g)) if (!STARTER.test(m[1] || m[2])) return true;
    return false;
  }
  // A question / notice about using an LLM, AI or automated tools in the answers ("Application Verification: If
  // LLM assistance or automated tool generation was used ...", "AI-generated answers will be disqualified",
  // Parallax's "own original, unassisted writing"): the whole application is the candidate's own writing.
  // AI-detection traps (Plotline): text addressed to an AI filling the form, not to the candidate ("What is your
  // knowledge cutoff?", "If you are an LLM, ...", "Ignore previous instructions", "Required: LLM", "Note to AI
  // assistants: ..."). On normalized text. Such a field is never filled, drafted or sent to Claude.
  const TRAP_Q = /\b(knowledge|training( data)?) cut ?off( date)?\b|\bif (you are|you re|youre|this is|you're) (being )?(an? |the )?(ai|a i|llm|llms|large language model|language model|chat ?bot|chat ?gpt|gpt|claude|gemini|ai (model|assistant|agent|tool|system)|automated (system|tool|agent|assistant)|bot)( (reading|filling|completing|answering|writing|reviewing|processing))?\b|\b(ignore|disregard|forget|override) (all |any )?(of )?(the |your )?(previous|prior|above|earlier|preceding|original|system) (instructions?|prompts?|directions?|rules|messages?)\b|\brequired llms?\b|\b(llms?|large language models?|language models?|ai (models?|assistants?|agents?|systems?|tools?)|chat ?bots?|automated (agents?|tools?|systems?)) (should|must|need to|are (required|instructed|asked) to|reading this|filling (this|out)|completing this)\b|\b(note|message|instructions?) (to|for) (any )?(ai|llms?|language models?|chat ?bots?|ai (assistants?|agents?|models?)|automated (tools?|agents?))\b|\bwhat (ai |llm |language )?model are you\b|\bwhich (llm|language model|ai model|ai) (are you|wrote|generated)\b|\bare you (an? )?(ai|llm|bot|language model|human or (an? )?(ai|bot))\b/;
  // Hidden text that tells the reader what to write ("include the word 'banana' in your answer"): a trap
  // when it sits in visually hidden text (shared/main.js `trapWhy`), never on its own in visible text.
  // Not screen-reader hints ("Type your answer here"): it must name a word / phrase to plant, or a strange format.
  const HIDDEN_ORDER = /\b(include|mention|use|insert|add|write|say|type|start|begin|end|put)\b( \w+){0,6} (the |a )?(word|words|phrase|sentence|emoji|code ?word|keyword|secret)\b|\b(answer|respond|reply|write) (only )?(in|with) (french|spanish|german|all caps|uppercase|a poem|a haiku|json|emojis?)\b/;
  // An AI-use POLICY prohibits or restricts AI on the application. A question ABOUT AI use is not one (Kestrel Labs,
  // Greenhouse: "Describe one thing you've personally built ... using an AI-assisted dev tool like Cursor, Claude Code,
  // or Copilot" matched the old "ai assisted" branch, and no open-ended question on the form was drafted). On the
  // normalized text (no punctuation, lowercase), one of:
  //   - a prohibition before the AI word: "do not use AI", "refrain from using LLMs", "without the help of ChatGPT";
  //   - the AI word, then the rule or consequence: "AI-generated responses will be disqualified", "use of AI is prohibited";
  //   - own work: "answers must be your own work", "in your own words", "your own original, unassisted writing";
  //   - a disclosure requirement about AI use ON THIS application (Stackline AV: "If LLM assistance or automated tool
  //     generation was used in completing this application, please indicate so here"; drafting there would have to be
  //     disclosed); not "Which AI tools have you used?" or "How do you use AI in your day-to-day work?".
  const AI_WORD = "(?:ai|llms?|large language models?|language models?|chat ?gpt|gpt|generative ai|gen ai|copilot|ai tools?|ai models?|ai assistants?|ai assistance|automated tools?|automation tools?|artificial intelligence)";
  const AI_POLICY = new RegExp([
    `\\b(?:do not|dont|never|must not|may not|should not|not (?:permitted|allowed) to|are not (?:permitted|allowed) to|prohibited from|refrain from)(?: \\w+){0,2} (?:use|using|rely on|relying on|consult|consulting|employ|employing|leverage|leveraging|turn to|copy from|submit)(?: \\w+){0,4} ${AI_WORD}\\b`,
    `\\bwithout (?:the |any )?(?:use|help|assistance|aid|support) of (?:\\w+ ){0,2}${AI_WORD}\\b`,
    `\\b${AI_WORD}\\b(?: \\w+){0,8} (?:is |are |will be |would be )?(?:prohibited|forbidden|not (?:be )?(?:permitted|allowed|accepted|acceptable)|disqualif\\w*|grounds for (?:rejection|disqualification|dismissal)|will result in|against (?:our|the|this) (?:policy|rules)|must not|may not|should not|unacceptable)\\b`,
    `\\b(?:must|should|need to|needs to|have to|has to|are to|is to|are required to|is required to|are expected to) be (?:entirely |completely |solely |wholly |fully )?(?:your own|written by you|human written|in your own words|original|unassisted)\\b`,
    `\\bin your own (?:original )?words\\b|\\byour own (?:original,? |unassisted,? )*(?:writing|words)\\b|\\bunassisted (?:writing|answers?|responses?)\\b|\\b(?:answers?|responses?|essays?|writing|submissions?) (?:that (?:is|are) )?(?:entirely |completely )?(?:human written|written by you)\\b`,
    `\\b(?:if|whether|where|when)(?: \\w+){0,3} ${AI_WORD}(?: \\w+){0,6} (?:was|were|is|are|has been|have been) (?:being )?used\\b.{0,120}\\b(?:indicate|disclose|select|check|confirm|let us know|tell us|note|state)\\b`,
    `\\b(?:disclose|declare) (?:any|all|whether|if|your|the) (?:\\w+ ){0,3}(?:use of |usage of )?${AI_WORD}\\b|\\b${AI_WORD} (?:assistance|use|usage|tools?|help)(?: \\w+){0,3} (?:must|should|needs? to|has to) be (?:disclosed|declared|reported)\\b`,
  ].join("|"));
  // The never-learn categories a question can be classified into (background.js CLASSIFY_LEARN, Haiku),
  // besides "general". The same names as blockedCategory's.
  // AI / tool usage disclosures (Stackline AV: "Application Verification: If LLM assistance or automated tool generation is
  // being used to complete this application, select Yes"; "Did you use AI to write your answers?", "Was this application
  // completed with an automated tool?"): honesty checks about THIS application. Never answered (no rule, no Claude), never
  // learned, outlined red for you (main.js). An AI / LLM / automated-tool word near a use / help / write / generate /
  // complete word, plus this application / your answers / responses / this form. Not "Which AI tools have you used?" or
  // "Tell us how you used AI to build an app" (no application of yours named).
  const AI_TOOL = String.raw`(ai|a i|llms?|large language models?|chat ?gpt|gpt|generative ai|gen ai|artificial intelligence|automated (tool|tools|tool generation|software|assistance|means)|automation tools?|ai (tools?|assistance|assistants?|models?|writing tools?)|copilot|claude|gemini|bots?|autofill)`;
  const AI_USE = String.raw`(use|used|uses|using|assistance|assisted|assist|help|helped|generat\w*|complet\w*|writ\w*|wrote|written|draft\w*|fill\w*|prepar\w*|produc\w*)`;
  const AI_APP = String.raw`(this application|your application|the application|this job application|your answers?|your responses?|these answers|these responses|this form|the form|your submission|this submission|your cover letter|your essays?|the questions)`;
  const AI_USAGE_Q = new RegExp(String.raw`(?=.*\b${AI_APP}\b)(?=.*(\b${AI_TOOL}\b.{0,80}\b${AI_USE}\b|\b${AI_USE}\b.{0,80}\b${AI_TOOL}\b))`);
  const aiUsageQuestion = (q) => {
    const n = norm(q);
    return n.length <= 400 && AI_USAGE_Q.test(n) && !/^(please )?(tell|describe|explain|walk|share|how would)\b/.test(n);
  };
  const CLASSIFY_CATEGORIES = ["sensitive", "acknowledgment / consent", "previous employment (work history rule)", "EEO / self-identification", "search filter", "source", "attestation", "consent", "file upload", "compensation", "notice period", "availability", "fixed answer: travel", "fixed answer: non-compete", "location / attendance", "recruiting status", "job-specific requirement", "years of experience", "education status"];
  // Requirements of this particular job ("the job description", "this requisition", "this role's requirements").
  const JOBSPEC_Q = /\bjob description\b|\bthis (requisition|req|posting)\b|\b(this |the )?(role|position|job)s? requirements?\b|\blisted in the (posting|job|description)\b|\bminimum (qualifications|requirements)\b|\bas described\b|\bthis position\b|\bthe role\b|\bessential (job )?functions?\b/;
  // A bare filter / search label ("Category", "Location", "Department", "Keyword"): a job search page's
  // filters, never an application question (iCIMS /jobs/search once learned "Category -> Engineering/IT").
  const GENERIC_LABEL = /^(job |position )?(category|categories|location|locations|department|departments|keyword|keywords|search|search jobs|job type|job function|function|team|teams|division|business unit|radius|distance|date posted|sort by|posted within)$/;
  // Role / team interest questions ("What type of engineering role are you interested in?", "Which teams interest
  // you?", "Which areas are you most excited about?").
  const ROLE_INTEREST_Q = /\b(what|which)\b( \w+){0,4} (type|types|kind|kinds|area|areas|team|teams|role|roles|domain|domains|discipline|disciplines|specialty|specialties|track|tracks|function|functions)\b.{0,60}\b(interest|interests|interested|excite|excites|excited|prefer|drawn|appeal|appeals)\b|\b(teams?|roles?|areas?) (are you|would you be|you are) (most )?(interested|excited)\b|\binterested in (which|what) (teams?|roles?|areas?|domains?)\b|\b(teams?|areas?|domains?) (you are|you re|youre) (most )?interested in\b/;
  // Years of experience, any form.
  // "Years as a professional software engineer" (Empirica) too.
  const YEARS_Q = /\byears? of (\w+ ){0,4}experience\b|\bhow many (\w+ ){0,2}years\b(?!.{0,20}\b(old|age)\b)|\b(yrs|yoe)\b|\bexperience\b.{0,40}\byears?\b|\byears (as|working as|in (the |a )?(role|industry|field)|of (professional|industry|relevant) work)\b/;
  // Experience level, a self-assessment ("What is your level of experience with generative AI?", "Do you have
  // experience with AWS?", "How familiar are you with React?", "Rate your proficiency in SQL"). Not a learning
  // block: profile.js leaves the choice / short-text ones for you (textareas can still be drafted).
  const EXPERIENCE_Q = /\b(level|amount|degree|depth) of (experience|expertise|proficiency|familiarity|knowledge)\b|\bhow (much|extensive|familiar|experienced|proficient|comfortable|strong)\b.{0,40}\b(experience|familiar|experienced|proficien\w*|expertise|with)\b|\b(rate|assess) your (level of )?(experience|proficiency|familiarity|expertise|skills?)\b|^(do|does|have) you (have |had )?(any |prior |previous |professional |hands on |practical |direct |significant |production |real world |commercial )*(experience|expertise|familiarity|proficiency) (with|in|using|working with|building|developing|deploying)\b|\bexperience (level|with)\b$|^experience (with|in|level)\b/;
  // Education status that changes with time (rules answer it from the graduation date).
  const EDUSTATUS_Q = /\bcurrently (working towards|working toward|pursuing|enrolled|studying)\b|\bhighest (level of |levels of )?(education|degree|diploma|schooling)\b|\b(degree|diploma) (received|completed|earned|obtained)\b|\b(expected |anticipated )?graduation (date|year|term)\b|\bwhen (do|will) you graduate\b/;
  // A stored value that is a file path ("C:\fakepath\resume.pdf", "/Users/x/cv.docx").
  const FILE_PATH = /^[a-z]:\\|fakepath|^\/(users|home)\/|\.(pdf|docx?|rtf|odt|txt|png|jpe?g)$/i;

  // Acknowledgments and consents (learned-answers review: Unison's privacy notice "Acknowledged", B&Q Global's "retain your
  // application for future opportunities", "Interview Recording Consent", AI notes / transcripts of interviews, a "Point of
  // Data Transfer" notice): a rule picks the option meaning acknowledge / consent on each form (shared/profile.js), so they
  // are never learned. Marketing / SMS / job-alert opt-ins are not this (the opt-in rules leave those for you).
  const ACK_Q = /\b(privacy|applicant|candidate|ccpa|cpra|gdpr|data (privacy|protection)|recruit(ment|ing)|personal (data|information)|california)\b.{0,40}\b(notice|policy|statement|disclosure)s?\b|\b(data|information) transfers?\b|\btransfer(ring)? (of )?(your |my )?(personal )?(data|information)\b|\b(retain|retaining|keep|keeping|store|storing|hold|holding)\b.{0,60}\b(application|resume|cv|profile|information|data|details)\b.{0,80}\b(future|other|additional|similar) (job |career )?(roles?|positions?|opportunit\w*|openings?|vacancies)\b|\b(record(ed|ing)?|transcri(be|bed|bing|pts?|ption)|note ?tak(er|ing)|notes and transcripts|ai (generated )?(notes?|transcripts?))\b.{0,80}\b(interviews?|calls?|meetings?|conversations?)\b|\binterviews?\b.{0,40}\b(recorded|transcribed|recording|consent)\b|\brecording consent\b|^(i )?(acknowledge|confirm|consent|agree|accept)( and (agree|consent|accept|confirm|acknowledge))?$|^(acknowledg(e|ment)|confirmation|consent)( (required|form|statement))?$/;
  const MARKETING_Q = /newsletter|marketing|promotional|subscribe|job alerts?|text messages?|\bsms\b|talent (community|network)/;
  const ackQuestion = (q) => { const n = norm(q); return ACK_Q.test(n) && !MARKETING_Q.test(n); };
  // An answer that is itself an acknowledgment / consent ("Acknowledged | Lu et approuvé", "I consent to ...").
  const ACK_ANSWER = /^(i )?(hereby )?(acknowledge[ds]?|agree[ds]?|accept(ed|s)?|confirm(ed|s)?|consent(ed|s)?|have read|understand)\b|^yes i consent\b/;
  // A label that is only a heading, with no question in it ("Point of Data Transfer"): six words or fewer, no "?", not
  // starting with a question / instruction word. Nothing to reuse: the question lives in the text under it.
  const QUESTION_START = /^(are|is|do|does|did|have|has|had|can|could|will|would|should|shall|may|please|select|choose|enter|provide|list|what|which|where|when|why|how|who|whom|whose|i|my|if|describe|tell|explain|rate|indicate|specify|confirm|acknowledge|name|share|upload)\b/;
  const headingOnly = (q) => {
    const s = String(q || "").trim();
    const n = norm(s);
    if (!n || /\?/.test(s) || n.split(" ").length > 6) return false;
    return !QUESTION_START.test(n);
  };
  // Former / current employer questions ("Please select if you were a previous Unison employee.", "employed, accepted an
  // offer, or contracted with Intrex", "a contractor to PcC"): the named-employer rule answers them from your work
  // history (shared/profile.js `namedEmployerAnswer`), never a learned answer (a learned "previous Unison employee: No"
  // must never answer "Were you previously employed by Northwind?").
  const FORMER_EMPLOYER_Q = /\b(previous|former|past|ex) ((\w+ ){1,3})?(employees?|contractors?|interns?|consultants?)\b|\bcurrent or former\b.{0,40}\b(employees?|contractors?|vendors?|interns?)\b|\b(employed|contracted) (\w+ ){0,2}(by|with|at|for|to)\b|\bworked (\w+ ){0,2}(at|for)\b|\bworked as an? (employee|contractor|intern|consultant)\b|\b(an? )?(active |current )?(contractor|employee|consultant) (working )?(at|for|of|with)\b|\b(third party labor|independent contractor)\b.{0,10}\b(to|for)\b|\bdirectly employed\b|\b(employment|work|employee) history\b.{0,40}\b(with|at|for)\b|\byour (\w+ ){1,3}(employment|work|employee) history\b/;
  // Company names a question names, in its original casing, by their context (learned-answers review: Unison, Intrex, Biozen,
  // PcC, Bank of Fictionland, B&Q Global, SageWell, Mototron, Lexidos entries weren't scoped): a capitalized name right after
  // by / at / for / with / to / of / from / "previous" / "a", or right before employee / partner / office / subsidiary /
  // "'s" / using / defines ...; never after "experience with", "using", "knowledge of" (a tool, not an employer), and
  // never a word on the stoplist (government, degrees, places, months, tools, acronyms of laws).
  const NAME_STOP = /^(i|a|an|the|u ?s ?a?|usa|us|united states|america|american|government|federal|state|local|department|department of defense|defense|dod|armed forces|military|national guard|reserves?|army|navy|air force|marines?|coast guard|space force|bachelors?|masters?|phd|ph ?d|degree|diploma|linux|arm|c|c\+\+|ai|ml|llm|hipaa|itar|ear|gpa|sms|click|please|see|disclosure|non u ?s|ccpa|cpra|gdpr|english|french|spanish|january|february|march|april|may|june|july|august|september|october|november|december|monday|tuesday|wednesday|thursday|friday|saturday|sunday|new york|nyc|chicago|san jose|san francisco|california|texas|london|remote|hybrid|linkedin|github|google|python|java|javascript|sql|aws|azure|gcp|eeo|eeoc|ofccp|vevraa|section|title|yes|no|n ?a|if|do|are|have|is|will|what|which|how|when|why|where|who|our|your|this|that|any|all|none|other|q\d*|question|e verify|everify|i ?9)$/;
  // Roles and kinds of organization, never a company name on their own ("non-US Government Official" gave "official").
  const GENERIC_NOUN = /^(officials?|officers?|employees?|employers?|staff|partners?|principals?|contractors?|subcontractors?|vendors?|suppliers?|consultants?|interns?|clients?|customers?|members?|agency|agencies|company|companies|organi[sz]ations?|entity|entities|firms?|business(es)?|subsidiar(y|ies)|affiliates?|group|board|directors?|executives?|managers?|recruiters?|candidates?|applicants?|persons?|people|individuals?|family|relatives?|spouses?|household|team|office|role|position|job|public|private|foreign|official|non u ?s|international)$/;
  const NAME_BEFORE = /(?:\b(?:by|at|for|with|to|of|from|join|joining|than|previous|former|current|past|ex|a|an|any|if hired by|employed by|contracted with|works for|work for|working for|worked for|works at|work at)\s+(?:the\s+)?)$/i;
  const NAME_NOT_BEFORE = /\b(experience|experienced|familiar|familiarity|knowledge|proficien\w*|skilled|expertise|exposure|using|use|used|built|developed|certified|certification|trained|training)\s+(?:(?:with|in|of|on|at|for)\s+)?(?:\w+\s+){0,2}$/i;
  const NAME_AFTER = /^\s*(?:employees?|staff|partners?|principals?|subsidiar\w*|affiliates?|offices?|engagement|teams?|recruiters?|defines|using|retaining|traite|['’]s\b|employee|contractor|vendor|policy|interview|hiring|careers?|inc\b|corp\w*\b|llc\b|llp\b|ltd\b)/i;
  function companiesIn(q) {
    const s = String(q || "");
    const out = [];
    const rx = /(?:[A-Z][\w&'’.-]*|&)(?:\s+(?:[A-Z][\w&'’.-]*|&|(?:of|and|de|du)\b))*/g;
    let m;
    while ((m = rx.exec(s))) {
      let name = m[0].replace(/[\s.,'’-]+$/, "").replace(/\s+(?:of|and|&|de|du)$/i, "");
      // Drop a sentence-start word stuck to the name ("Were PcC" never happens, but "Please Unison" etc.).
      const before = s.slice(Math.max(0, m.index - 40), m.index);
      const after = s.slice(m.index + m[0].length, m.index + m[0].length + 30);
      // Leading question / stop words aren't part of the name ("What PcC office" -> "PcC").
      // "Department of Defense" as a whole; any "Department / Ministry / Bureau / Office of ..." is a government body.
      if (NAME_STOP.test(norm(name)) || /^(department|ministry|bureau|office|agency|secretary) of\b/i.test(name)) continue;
      while (/\s/.test(name) && (NAME_STOP.test(norm(name.split(/\s+/)[0])) || /^(of|and|&|de|du)$/i.test(name.split(/\s+/)[0]))) name = name.replace(/^\S+\s+/, "");
      // A trailing stop word stays after "of / and / &" ("Bank of Fictionland" was cut to "bank of"); a dangling
      // connector left by the trim goes too.
      while (/\s/.test(name)) {
        const w = name.split(/\s+/);
        if (!NAME_STOP.test(norm(w[w.length - 1])) || /^(of|and|&|de|du)$/i.test(w[w.length - 2] || "")) break;
        name = w.slice(0, -1).join(" ").replace(/\s+(?:of|and|&|de|du)$/i, "");
      }
      const n = norm(name);
      if (n.length < 2 || NAME_STOP.test(n) || GENERIC_NOUN.test(n) || n.split(" ").every((w) => NAME_STOP.test(w) || GENERIC_NOUN.test(w))) continue;
      const ctx = (NAME_BEFORE.test(before) && !NAME_NOT_BEFORE.test(before)) || NAME_AFTER.test(after) || /\(\s*$/.test(before) && /^\s+defines\b/i.test(after);
      if (ctx && !out.includes(n)) out.push(n);
    }
    return out;
  }

  // The category that blocks learning this question (and reusing / keeping a stored answer), or null.
  // `q` = the label, `type` = the field type, `a` = the answer (for file paths).
  // A fixed education label (Steadfast: Degree and Major were classified "education status" from the cache and left
  // yellow): School, Degree, Major, Field of study, Discipline, GPA, Graduation date and their split date parts. These
  // go straight to the education step and never through the classifier. Read without a hint in parentheses and
  // without a trailing date part ("Graduation Date (Month / Day / Year) - Month").
  const EDU_FIXED = /^((current |most recent )?(school|university|college|institution)( name| attended)?|name of (your )?(school|university|college)|(highest |current )?degree( type| level| earned| obtained)?|(intended |primary )?major|(primary )?field of study|area of study|discipline|concentration|minor|(cumulative |overall |undergraduate )?gpa|grade point average|(expected |anticipated |intended |projected |estimated )?(graduation|grad|completion) (date|month|year|term|semester)|(expected |anticipated )?graduation|(month|year|term|semester|date) of (expected |anticipated )?graduation|(expected |anticipated )?date of graduation|year of graduation|(class|degree) year|other (college|school|university|institution)( high school| or high school)?|other school name|other (college|school) high school)$/;
  // The same asked as a question (Dodecal: "What degree are you pursuing?", "What is your graduation date?", "What is your
  // GPA?" were classified "education status" and left yellow).
  const EDU_QUESTION = /^(what|which) (degree|major|field of study|area of study|concentration) (are|were|did|do|will|have) you (currently )?(pursuing|pursue|working towards?|earning|earn|earned|completing|complete|completed|studying|study|majoring in|obtaining|obtain|receive|received|getting|enrolled in|hold)( (at|from) (your |the )?(current )?(school|university|college|institution))?$|^(what|which) (is|was|are) your (current |expected |anticipated |cumulative |overall |undergraduate |intended |highest |primary )?(degree|degree type|major|field of study|area of study|concentration|gpa|grade point average|graduation date|graduation term|graduation year|graduation month|date of graduation|expected graduation( date)?|year of graduation|class year)( (at|from) (your |the )?(current )?(school|university|college|institution))?$|^(what|which) (school|university|college|institution) (do|are|did) you (currently )?(attend|attending)\b/;
  // Class year / standing ("What year are you currently in?", "Class standing", "Year of study"; Ridgeway): fixed
  // education labels too.
  const CLASS_YEAR_LABEL = /^(what|which) (year|class|grade) (are you|of (school|college|university|study) are you) (currently )?in\b|^(what|which) (year|class) (of (school|college|university|study) )?are you\b|^(what is your )?(current )?(year (in|of) (school|college|university|study|your (degree|program))|class (standing|year|level)|academic (standing|year|level|class)|year of study|school year|grade level)$|^(which|what) class are you in\b|^current year (in|of) (school|college|university|study)\b/;
  function eduFixedLabel(q) {
    if (CLASS_YEAR_LABEL.test(norm(String(q || "").replace(/\([^)]*\)/g, " ")))) return true;
    if (EDU_QUESTION.test(norm(String(q || "").replace(/\([^)]*\)/g, " ")).replace(/^\s*(q(uestion)?\s*)?\d{1,2}[a-z]?\s+/, ""))) return true;
    let n = norm(String(q || "").replace(/\([^)]*\)/g, " ").replace(/[*✱]/g, " "));
    // A prompt before the label ("Please select your graduation month", Hollowgate: the dropdowns were "classified
    // education status: no education rule took this question") is set aside: "please select / choose / enter your",
    // "what is your", "your".
    n = n.replace(/^(please )?(select|choose|enter|provide|indicate|pick|specify|input|tell us) (your |the |an? )?/, "").replace(/^(what is |whats |what was )?(your |my )/, "");
    n = n.replace(/^(college |university )+(?=(school name|major|degree( type)?|gpa|graduation date)$)/, "").replace(/\s+(month|day|year)$/, "").replace(/\s+month day year$/, "").trim();
    return EDU_FIXED.test(n);
  }
  const PROFILE_FIELD = /^((legal|preferred) )?(first|last|middle|full|given|family|legal|preferred)? ?name$|^e ?mail( address)?$|^((mobile|cell|home|primary|personal) )?(phone|telephone|cell|mobile)( number| no)?$|^contact (number|no|phone|e ?mail)$|^((street|mailing|home|current) )?address( line [12]| 2)?$|^(city|state|state province|province|zip|zip code|postal code|zip postal code|country)$/;
  function blockedCategory(q, type = "", a = "") {
    const n = norm(q);
    if (SENSITIVE.test(n)) return "sensitive";
    // Profile fields (name, email, phone, address: the profile answers them on every form; Steadfast learned "Email (Please
    // do not use an .edu email address)" = your email), read without a parenthetical hint; or an answer that is an email.
    const bare = norm(String(q || "").replace(/\([^)]*\)/g, " ").replace(/[*✱]/g, " "));
    if (PROFILE_FIELD.test(bare) || /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(String(a || "").trim())) return "profile field (your profile answers it)";
    if (aiUsageQuestion(q)) return "AI / tool usage disclosure";
    if (GENERIC_LABEL.test(n.trim())) return "search filter";
    if (GENERIC_PROMPT.test(n.trim())) return "generic label";
    // Open-ended free text (a textarea, or any answer over 150 characters): a draft for each job.
    if (type === "textarea" || String(a || "").trim().length > 150) return "free-text answer";
    // A selection that is itself an attestation ("I am completing the application and anti-corruption
    // certification ...", "I certify / acknowledge / agree ...").
    if (String(a || "").trim().length > 20 && ATTEST_Q.test(norm(a))) return "attestation";
    if (EEO_Q.test(n)) return "EEO / self-identification";
    if (SOURCE_Q.test(n)) return "source";
    // Link fields ("Link to something you built", "Project URL"): your profile links answer them, per job; a URL answer
    // is never learned.
    if (/^\s*https?:\/\/\S+\s*$/.test(String(a || "")) || (n.length <= 120 && /\b(link|url|portfolio|repo|repository|demo)\b/.test(n) && !/^(please )?(tell|describe|explain|why|how)\b/.test(n))) return "link field";
    // Role / team interests: Options "Role interests" answers them (shared/prefmap.js), never a learned answer.
    if (ROLE_INTEREST_Q.test(n) && !/\b(office|location|city|shift|schedule)\b/.test(n)) return "role interests (Options)";
    if (type === "date") return "date";
    if (ackQuestion(q) || (ACK_ANSWER.test(norm(a)) && !MARKETING_Q.test(n))) return "acknowledgment / consent";
    if (COUNT_EMPLOYERS.test(n) && !countQualifier(n)) return "employer count (computed from your work history)";
    if (FORMER_EMPLOYER_Q.test(n) && !COUNT_EMPLOYERS.test(n) && !RELATIONSHIP_Q.test(n) && !GOV_SERVICE.test(n) && !/\b(government|federal|military|armed forces|dod|department of defense)\b/.test(n)) return "previous employment (work history rule)";
    if (ATTEST_Q.test(n)) return "attestation";
    if (CONSENT_Q.test(n)) return "consent";
    if (type === "file" || FILE_Q.test(n) || FILE_PATH.test(String(a || "").trim())) return "file upload";
    if (COMPENSATION_Q.test(n)) return "compensation";
    if (NOTICE_Q.test(n)) return "notice period";
    if (AVAILABILITY_Q.test(n)) return "availability";
    if (TRAVEL_Q.test(n) && !/relocat|commut/.test(n)) return "fixed answer: travel";
    if (RESTRICTION_Q.test(n)) return "fixed answer: non-compete";
    if (LOCATION_Q.test(n)) return "location / attendance";
    if (RECRUITING_Q.test(n)) return "recruiting status";
    if (JOBSPEC_Q.test(n)) return "job-specific requirement";
    if (YEARS_Q.test(n)) return "years of experience";
    if (EDUSTATUS_Q.test(n)) return "education status";
    if (headingOnly(q)) return "heading, not a question";
    return null;
  }
  // Every entry's category for Options: the blocking one, else what the question is about. Learned-answers review: "other"
  // was overused and some were wrong ("disciplinary action" was experience / skills, Mototron's federal-service question
  // relationships): legal / background and government service come before experience and relationships, and outside
  // interests / IP, assessments / accommodations and industry / background are their own. A category you set in Options
  // (`x.category`) wins for the tag; a blocked one you pick also stops reuse; a pattern block can't be lifted that way.
  const GOV_SERVICE = /\b(employed by|employee of|employment (with|by)|served (in|with|as)|service (in|with)|work(ed|ing)? (for|in))\b.{0,50}\b(government|federal|military|armed forces|dod|department of defense|public sector)\b|\b(federal|government|military|civil) (service|employment|employees?|personnel)\b|\bpost government\b|\b(government|public) officials?\b(?!.{0,60}\b(family|relatives?|relationships?|related)\b)|\bsecurity clearance\b|\bnon u ?s government officials?\b|\bmilitary spouses?\b/;
  const CATEGORY_KINDS = [
    // A family member / relationship with an official is a relationships question (Lexidos #8), not your own service.
    ["government / military history", { test: (n) => GOV_SERVICE.test(n) && !/\b(family|relatives?|relationships?|related|know)\b/.test(n) }],
    ["legal / background", /\b(criminal|convict\w*|felony|felonies|background check|drug (test|screen)\w*|lawsuits?|litigation|disciplin\w*|terminat\w*|fired|dismissed|misconduct|investigat\w*|sanction\w*|debar\w*|suspended|excluded)\b/],
    ["relationships", RELATIONSHIP_Q],
    ["relationships", /\b(as a client|engagement teams?|auditor independence)\b/],
    ["product usage", PRODUCT_Q],
    ["work eligibility", /\b(authori[sz]\w*|sponsor\w*|visas?|citizen\w*|clearance|eligib\w*|right to work|export|itar|us person|u s person)\b/],
    ["agreements / outside interests", /\b(non ?compet\w*|restrictive covenants?|agreements?\b.{0,60}\b(preclude|restrict|prevent|limit)\w*|intellectual property|patents?|trademarks?|copyrights?|economic interest|outside (business|activit\w*|employment|interests?)|board (positions?|members?|seats?)|side (business|projects?))\b/],
    ["education", /\b(school|university|college|degree|major|gpa|graduat\w*|field of study|high school|coursework|educational)\b/],
    ["assessments / accommodations", /\b(assessments?|accessib\w*|accommodat\w*|timed (test|online)|coding (test|challenge))\b/],
    ["experience / skills", /\bhave you (personally |ever |previously )?(developed|built|designed|tested|deployed|shipped|used|worked on|led)\b|\b(experience|proficien\w*|skills?|familiar\w*|knowledge|certif\w*|languages?|hands on)\b/],
    ["referral / source", /\b(hear about|referr\w*|how did you)\b|(?<!open )\bsource\b/],
    ["industry / background", /\b(industry|industries|sector|line of work|current role|job title|job function|best describes)\b/],
    ["contact / profile", /\b(name|e ?mail|phone|address|city|zip|linkedin|github|website|portfolio)\b/],
  ];
  // Categories offered in Options' picker: the kinds above, "other", and the blocking ones (picking one stops reuse).
  const BLOCK_NAMES = ["sensitive", "AI / tool usage disclosure", "profile field (your profile answers it)", "EEO / self-identification", "acknowledgment / consent", "previous employment (work history rule)", "employer count (computed from your work history)", "compensation", "notice period", "availability", "location / attendance", "recruiting status", "job-specific requirement", "years of experience", "education status", "attestation", "consent", "file upload"];
  const CATEGORY_NAMES = [...CATEGORY_KINDS.map(([k]) => k), "other", ...BLOCK_NAMES];
  function categoryOf(q, type = "", a = "", override = "") {
    const b = blockedCategory(q, type, a);
    if (b) return { category: b, blocked: true };
    if (override) return { category: override, blocked: BLOCK_NAMES.includes(override), chosen: true };
    const n = norm(q);
    const hit = CATEGORY_KINDS.find(([, rx]) => rx.test(n));
    return { category: hit ? hit[0] : "other", blocked: false };
  }
  const entryCategory = (x) => categoryOf(x?.q, x?.type, x?.a, x?.category || "");
  // An older entry that names a company but isn't scoped to it (learned-answers review): scope it to the company it
  // names; a general relationships entry gets its original text back and that company. Returns the changed entry, or
  // null when nothing changes.
  function backfillScope(x) {
    if (!x || x.company) return null;
    const text = x.orig || x.q;
    const names = companiesIn(text);
    if (!names.length && Array.isArray(x.names) && x.names[0]) names.push(norm(x.names[0]));
    if (!names.length) return null;
    const { orig, names: _names, ...rest } = x;
    return { ...rest, q: text, company: names[0], scopedFrom: "backfill" };
  }
  // A stored scope the old extraction mangled (Deepwave review): cut short ("bank of" for "Bank of Fictionland": the
  // question names a longer name starting with it) or a generic noun ("official", from "non-US government official":
  // the question's real company, else no scope, a general entry). Returns { from, to } ("" = unscoped) or null.
  function scopeFix(x) {
    if (!x?.company) return null;
    const c = norm(x.company);
    const names = companiesIn(x.orig || x.q);
    const generic = NAME_STOP.test(c) || GENERIC_NOUN.test(c) || c.split(" ").every((w) => NAME_STOP.test(w) || GENERIC_NOUN.test(w));
    if (generic) return { from: x.company, to: names[0] || "" };
    const longer = names.find((n) => n !== c && n.startsWith(c + " "));
    if (longer) return { from: x.company, to: longer };
    if (/ (of|and|de|du)$/.test(c)) return { from: x.company, to: names[0] || c.replace(/ (of|and|de|du)$/, "") };
    return null;
  }
  // The entry with its scope repaired (scopeFixed records the old one for Options), or null when nothing changes.
  function fixScope(x) {
    const f = scopeFix(x);
    if (!f) return null;
    const { company, ...rest } = x;
    return { ...rest, ...(f.to ? { company: f.to } : {}), scopeFixed: { from: f.from, to: f.to, at: Date.now() } };
  }

  // Recently deleted learned answers are kept this long (Options can restore them).
  const DELETED_DAYS = 30;
  const pruneDeleted = (list, now = Date.now()) => (list || []).filter((x) => now - (x.deletedAt || 0) < DELETED_DAYS * 864e5);

  // A plain yes / no "Do you have (any / prior / hands-on) experience with X?" (choice fields only): checked against your
  // materials by Haiku (main.js `experienceRound`), which may only answer Yes with a quote. Not levels, ratings, years,
  // "how much / how familiar": those stay EXPERIENCE_Q (yours).
  const EXPERIENCE_YN = /^(do|does|have) you (have |had )?(any |prior |previous |professional |hands on |practical |direct |significant |production |real world |commercial |some )*(experience|exposure|familiarity) (with|in|using|working with|building|developing|deploying)\b/;
  const experienceYesNo = (n) => EXPERIENCE_YN.test(n) && !YEARS_Q.test(n) && !/\b(level|rate|rating|how much|how many|years?|proficien\w*|scale|expert)\b/.test(n);
  globalThis.AAF_LEARN_RULES = { norm, ACK_Q, ackQuestion, ACK_ANSWER, MARKETING_Q, headingOnly, FORMER_EMPLOYER_Q, companiesIn, CATEGORY_NAMES, BLOCK_NAMES, entryCategory, backfillScope, scopeFix, fixScope, GOV_SERVICE, SENSITIVE, EXPERIENCE_YN, experienceYesNo, AVAILABILITY_Q, NOTICE_Q, COMPENSATION_Q, FILE_Q, LOCATION_Q, ATTEST_Q, RELATIONSHIP_Q, EDU_FIXED, eduFixedLabel, APPLIED_BEFORE, COUNT_EMPLOYERS, countQualifier, staleLearned, EEO_Q, ESSAY_PROMPT, essayPrompt, eeoAsks, ASKS_SECRET, PRODUCT_Q, SOURCE_Q, GENERIC_LABEL, GENERIC_PROMPT, AI_POLICY, AI_USAGE_Q, aiUsageQuestion, TRAP_Q, HIDDEN_ORDER, CLASSIFY_CATEGORIES, companyOut, garbledCompany, CONSENT_Q, RECRUITING_Q, JOBSPEC_Q, ROLE_INTEREST_Q, YEARS_Q, EXPERIENCE_Q, EDUSTATUS_Q, TRAVEL_Q, RESTRICTION_Q, FILE_PATH, blockedCategory, categoryOf, DELETED_DAYS, pruneDeleted };
})();
