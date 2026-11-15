// Writes the fake PDFs the Options-page tests upload (a fictional person, fake data only), laid out like the real
// files pdftext.js must read:
//   tests/options/fake-resume.pdf    one column: a centered name and contact line, section headings, job titles with
//                                    right-aligned dates and locations on the same baseline, bullets that wrap onto
//                                    indented lines (one split into word-by-word pieces), a hyphenated word broken
//                                    at a line end, a "Page 1 of 1" footer; FlateDecode content.
//   tests/options/fake-linkedin.pdf  LinkedIn's "Save to PDF": a left sidebar (Contact with a profile link broken at
//                                    "-", Top Skills, Languages, Certifications) beside the main column (name,
//                                    headline, Summary, Experience), a second page with the main column only, and
//                                    "Page N of 2" footers.
// Run after changing the text: node tests/options/make-pdfs.js (prints how each paragraph wrapped).
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

// Helvetica widths (per 1000 em), ASCII 32-126, from the standard AFM; WinAnsi bullet / en dash / middle dot below.
const W = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
const EXTRA = { "•": [0x95, 350], "–": [0x96, 556], "·": [0xb7, 278] };
const width = (s, size, bold) => [...s].reduce((n, ch) => n + (EXTRA[ch]?.[1] ?? W[ch.charCodeAt(0) - 32] ?? 556), 0) * (size / 1000) * (bold ? 1.06 : 1);
const enc = (s) => Buffer.from([...s].map((ch) => EXTRA[ch]?.[0] ?? ch.charCodeAt(0)));

// Greedy wrap at spaces, and after a hyphen inside a word ("end-to-end" may break as "end-" / "to-end").
function wrap(text, max, size, bold) {
  const pieces = text.split(" ").flatMap((w) => w.split(/(?<=[a-z]-)(?=[a-z])/).map((p, i, a) => ({ p, glue: i < a.length - 1 })));
  const lines = [];
  let cur = "";
  let glued = false; // the last piece attaches to the next one without a space (it ended at a hyphen in a word)
  for (const { p, glue } of pieces) {
    const cand = cur ? cur + (glued ? "" : " ") + p : p;
    if (cur && width(cand, size, bold) > max) {
      lines.push(cur);
      cur = p;
    } else cur = cand;
    glued = glue;
  }
  if (cur) lines.push(cur);
  return lines;
}

function pdf(pages, { compress }) {
  const objs = [];
  const add = (body) => objs.push(body) && objs.length;
  const esc = (buf) => Buffer.concat([...buf].map((b) => (b === 0x28 || b === 0x29 || b === 0x5c ? Buffer.from([0x5c, b]) : Buffer.from([b]))));
  const catalog = add(null);
  const pagesObj = add(null);
  const fR = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  const fB = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
  const kids = [];
  for (const ops of pages) {
    const parts = [];
    for (const o of ops) parts.push(Buffer.from(`BT /${o.bold ? "F2" : "F1"} ${o.size} Tf 1 0 0 1 ${o.x.toFixed(2)} ${o.y.toFixed(2)} Tm (`), esc(enc(o.text)), Buffer.from(") Tj ET\n"));
    const raw = Buffer.concat(parts);
    const data = compress ? zlib.deflateSync(raw) : raw;
    const stream = add(Buffer.concat([Buffer.from(`<< /Length ${data.length}${compress ? " /Filter /FlateDecode" : ""} >>\nstream\n`), data, Buffer.from("\nendstream")]));
    kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fR} 0 R /F2 ${fB} 0 R >> >> /Contents ${stream} 0 R >>`));
  }
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;
  const out = [Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n", "latin1")];
  const offsets = [];
  let len = out[0].length;
  objs.forEach((body, i) => {
    const b = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), Buffer.isBuffer(body) ? body : Buffer.from(body, "latin1"), Buffer.from("\nendobj\n")]);
    offsets.push(len);
    out.push(b);
    len += b.length;
  });
  const xref = [`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`, ...offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`)].join("");
  out.push(Buffer.from(`${xref}trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${len}\n%%EOF\n`, "latin1"));
  return Buffer.concat(out);
}

// A page builder: a cursor moving down, text placed left / right / centered, paragraphs wrapped.
function page(left, right) {
  const ops = [];
  let y = 742;
  const api = {
    ops,
    down: (d) => (y -= d),
    at: (yy) => (y = yy),
    text: (text, { size = 10, bold = false, x = left } = {}) => ops.push({ text, size, bold, x, y }),
    right: (text, { size = 10, bold = false } = {}) => ops.push({ text, size, bold, x: right - width(text, size, bold), y }),
    center: (text, { size = 10, bold = false, from = 0, to = 612 } = {}) => ops.push({ text, size, bold, x: (from + to - width(text, size, bold)) / 2, y }),
    // Word by word, as many PDFs store text (the spaces are gaps, not characters).
    words: (text, { size = 10, x = left } = {}) => {
      let xx = x;
      for (const w of text.split(" ")) {
        ops.push({ text: w, size, bold: false, x: xx, y });
        xx += width(w + " ", size, false);
      }
    },
    // glue: a "word. " in the text whose space is not stored: the line is two pieces touching ("evals." + "Most").
    para: (text, { size = 10, x = left, lead = 12.5, bullet = null, wordsFirst = false, label = "", glue = "" } = {}) => {
      const lines = wrap(text, right - x, size, false);
      if (label) console.log(`${label}:\n  ${lines.map((l) => `${l}  [${Math.round((width(l, size) / (right - x)) * 100)}%]`).join("\n  ")}`);
      lines.forEach((l, i) => {
        if (i) y -= lead;
        if (bullet && !i) ops.push({ text: bullet, size, bold: false, x: x - 10, y });
        if (wordsFirst && !i) api.words(l, { size, x });
        else if (glue && l.includes(glue)) {
          const [a, b] = [l.slice(0, l.indexOf(glue) + glue.length - 1), l.slice(l.indexOf(glue) + glue.length)];
          ops.push({ text: a, size, bold: false, x, y }, { text: b, size, bold: false, x: x + width(a, size), y });
        } else ops.push({ text: l, size, bold: false, x, y });
      });
    },
    // A bold label piece, then the rest in the regular font ("Tools:" + " Docker, ...").
    labelLine: (lbl, rest, { size = 10, x = left } = {}) => {
      ops.push({ text: lbl, size, bold: true, x, y }, { text: rest, size, bold: false, x: x + width(lbl + " ", size, true), y });
      return Math.round(((width(lbl + " ", size, true) + width(rest, size)) / (right - x)) * 100);
    },
  };
  return api;
}

// ---- One-column resume
const r = page(54, 558);
r.center("Test (Tess) Applicant", { size: 18, bold: true });
r.down(18);
r.center("test@example.com | 646-555-0100 | Springfield, NY | github.com/test-applicant | testapplicant.dev/portfolio", { size: 9.5 });
r.down(28);
r.text("EXPERIENCE", { size: 11, bold: true });
r.down(17);
r.text("Software Engineer Intern", { bold: true });
r.right("Jun 2026 – Aug 2026");
r.down(12.5);
r.text("Contoso");
r.right("New York, NY");
r.down(13);
r.para("Built an internal deploy CLI used by three teams to ship services, cutting release time from two hours to fifteen minutes across staging and production.", { x: 72, bullet: "•", wordsFirst: true, label: "resume bullet 1" });
r.down(12.5);
r.para("Wrote retrieval quality checks, labeling guidelines and the first set of offline ranking evals. Most regressions were then caught before code review, and the shared test suite now runs end-to-end on every pull request.", { x: 72, bullet: "•", glue: "evals. ", label: "resume bullet 2" });
// A bold title with its date right after a full-width bullet line, at the normal line spacing (no extra gap).
r.down(12.5);
r.text("AI Engineer Intern", { bold: true });
r.right("Jun 2025 – Aug 2025");
r.down(12.5);
r.text("Northwind");
r.right("Riverton, NJ");
r.down(13);
r.para("Built a retrieval evaluation harness and a citation checker for the support pilot, so that every generated answer quoted its sources and followed the strict evidence rules that the compliance reviewers set.", { x: 72, bullet: "•", label: "resume bullet 3" });
// A bold title without a date, then a plain line back at the left margin, each after a full-width bullet line.
r.down(12.5);
r.text("Research Assistant", { bold: true });
r.down(12.5);
r.para("Ran ablations on chunk size and reranking for a campus search prototype, and wrote the weekly summaries the lab used to plan the next round of experiments and the quarterly grant reports to the department.", { x: 72, bullet: "•", label: "resume bullet 4" });
r.down(12.5);
r.text("Lakeview Research Group, part-time during the spring semester");
r.down(19);
r.text("Teaching Assistant", { bold: true });
r.right("Sep 2025 – Present");
r.down(12.5);
r.text("Lakeview University");
r.right("Springfield, NY");
r.down(13);
r.para("Held weekly office hours for an introductory programming course and graded labs.", { x: 72, bullet: "•" });
r.down(28);
r.text("EDUCATION", { size: 11, bold: true });
r.down(17);
r.text("Lakeview University", { bold: true });
r.right("Expected May 2027");
r.down(12.5);
r.text("B.E. Computer Engineering, GPA 3.8");
// Not degrees: a certificate (suggested as a certification) and a fellowship at an organization that is also a job.
r.down(12.5);
r.text("Litware Online Academy", { bold: true });
r.right("Mar 2024 – Jun 2024");
r.down(12.5);
r.text("Online Certification in Data Analytics");
r.down(12.5);
r.text("Lakeview Research Group", { bold: true });
r.right("2025");
r.down(12.5);
r.text("Summer Research Fellowship");
// "Label: list" lines, each reaching the right edge; the third has a bold label; the last tests the sentence-spacing
// fix's exceptions (a decimal, "e.g.", a link and an email with capitals).
r.down(28);
r.text("SKILLS", { size: 11, bold: true });
r.down(17);
r.para("Languages: Python, TypeScript, JavaScript, Go, Rust, Java, Kotlin, SQL, Bash, HTML, CSS and PostgreSQL", { label: "resume skills 1" });
r.down(12.5);
r.para("Frameworks: Node.js, React, Next.js, Express, FastAPI, Flask, Django, PyTorch, scikit-learn, pandas and NumPy", { label: "resume skills 2" });
r.down(12.5);
console.log(`resume skills 3 (bold label): [${r.labelLine("Tools:", "Docker, Kubernetes, Terraform, GitHub Actions, Grafana, Prometheus, Postman, Linux")}%]`);
// The same certification as LinkedIn's "Machine Learning Foundations", worded differently.
r.down(28);
r.text("CERTIFICATIONS", { size: 11, bold: true });
r.down(17);
r.text("Online Certification in Machine Learning Foundations");
r.down(28);
r.text("ADDITIONAL", { size: 11, bold: true });
r.down(17);
r.text("Notes: version 2.5, e.g.Docker, example.com/Guide, Tess.Applicant@example.com");
r.at(30);
r.center("Page 1 of 1", { size: 8 });

// ---- LinkedIn "Save to PDF": sidebar 36-186, main 226-576
const SIDE = [36, 186];
const p1 = page(226, 576);
const side = (text, opts = {}) => p1.ops.push({ text, size: opts.size || 10, bold: !!opts.bold, x: SIDE[0], y: opts.y });
let sy = 742;
const s = (text, opts = {}, d = 13) => (side(text, { ...opts, y: sy }), (sy -= d));
s("Contact", { size: 13, bold: true }, 18);
s("test@example.com");
s("www.linkedin.com/in/test-");
s("applicant-0a1b2c (LinkedIn)");
s("testapplicant.dev (Personal)", {}, 22);
s("Top Skills", { size: 13, bold: true }, 18);
s("Retrieval-Augmented Generation");
s("Python");
s("Docker");
s("deployhub.io", {}, 22);
s("Languages", { size: 13, bold: true }, 18);
s("Italian (Elementary)");
s("Spanish (Native or Bilingual)", {}, 22);
s("Certifications", { size: 13, bold: true }, 18);
s("Fake Cloud Practitioner");
s("Machine Learning Foundations");
p1.text("Test Applicant", { size: 26 });
p1.down(22);
p1.text("Computer Engineering Student at Lakeview University", { size: 12 });
p1.down(16);
p1.text("Springfield, New York, United States");
p1.down(32);
p1.text("Summary", { size: 15, bold: true });
p1.down(20);
p1.para("Computer engineering student who builds tools other engineers use. I care about measuring what actually ships, so my projects start with offline evals. Most of them end with a dashboard the whole team actually opens.", { size: 10.5, lead: 13, label: "linkedin summary" });
p1.down(32);
p1.text("Experience", { size: 15, bold: true });
p1.down(20);
p1.text("Northwind", { size: 12 });
p1.down(15);
p1.text("AI Engineer Intern", { size: 11 });
p1.down(14);
p1.text("June 2025 - August 2025 (3 months)");
p1.down(13);
p1.text("Riverton, New Jersey, United States");
p1.down(17);
p1.para("Built an evaluation harness for a retrieval pipeline and replaced the weekly manual spot checks and ad hoc queries with one shared, nightly end-to-end regression report that the search team reviewed every morning.", { size: 10.5, lead: 13, label: "linkedin northwind" });
// A list that runs across the page break.
p1.down(13);
p1.para("Cut the nightly report runtime from forty minutes to six.", { size: 10.5, lead: 13, x: 236, bullet: "•" });
p1.down(13);
p1.para("Wrote the on-call runbook for the evaluation jobs.", { size: 10.5, lead: 13, x: 236, bullet: "•" });
p1.at(20);
p1.center("Page 1 of 2", { size: 9 });

const p2 = page(226, 576);
p2.para("Presented the results to the search team leads.", { size: 10.5, lead: 13, x: 236, bullet: "•" });
p2.down(32);
p2.text("Contoso", { size: 12 });
p2.down(15);
p2.text("Software Engineer Intern", { size: 11 });
p2.down(14);
p2.text("May 2026 - August 2026 (4 months)");
p2.down(13);
p2.text("New York, New York, United States");
// A job only LinkedIn lists (its text is the card's description).
p2.down(28);
p2.text("Fabrikam", { size: 12 });
p2.down(15);
p2.text("Volunteer Tutor", { size: 11 });
p2.down(14);
p2.text("January 2024 - May 2024 (5 months)");
p2.down(13);
p2.text("Springfield, New York, United States");
p2.down(17);
p2.para("Tutored first-year students in introductory programming twice a week.", { size: 10.5, lead: 13 });
p2.down(32);
p2.text("Education", { size: 15, bold: true });
p2.down(20);
p2.text("Lakeview University", { size: 12 });
p2.down(15);
p2.text("Bachelor of Engineering - BE, Computer Engineering · (August 2023 - May 2027)");
p2.at(20);
p2.center("Page 2 of 2", { size: 9 });

const dir = __dirname;
fs.writeFileSync(path.join(dir, "fake-resume.pdf"), pdf([r.ops], { compress: true }));
fs.writeFileSync(path.join(dir, "fake-linkedin.pdf"), pdf([p1.ops, p2.ops], { compress: false }));
console.log("wrote fake-resume.pdf and fake-linkedin.pdf");
