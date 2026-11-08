// Privacy check: no file in the repository may hold your personal data.
//   node tests/privacy-check.js            every tracked file plus untracked, not ignored ones (the working tree)
//   node tests/privacy-check.js --staged   the staged content only (the pre-commit hook, tests/hooks/pre-commit)
//   node tests/privacy-check.js --paths <file or folder>...   exactly these files (folders recursively), whether or not
//                                           git knows them: tools/build.js runs it on the files going into the store zip
//                                           and on store/ (the listing and the screenshot sources)
// The strings to look for live in tests/private-patterns.txt (git-ignored, one per line; "#" starts a comment), so the
// check itself never publishes them, and a hit is reported by file, line and pattern NUMBER, never the text.
// Matched as whole words, case-insensitive; a line starting with "=" is matched case-sensitively (company names that are
// also ordinary words: "=Acme" never matches "acme"). A phone number (7+ digits) also matches with any spaces /
// dashes / dots / parentheses between its digits.
// tests/privacy-allowlist.txt (tracked) lists allowed lines, "<file> :: <text the line contains>": a hit on such a
// line in that file is not one (the code's functional company-alias table, your name in LICENSE).
// Exit 1 on a hit; no patterns file = a warning and exit 0.
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const git = (args) => execFileSync("git", args, { cwd: root, maxBuffer: 1 << 28 });
const patFile = path.join(__dirname, "private-patterns.txt");
if (!fs.existsSync(patFile)) {
  console.log("privacy check skipped: no tests/private-patterns.txt (one personal string per line; git-ignored)");
  process.exit(0);
}
const pats = fs.readFileSync(patFile, "utf8").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const rxs = pats.map((p) => {
  const cs = p.startsWith("=");
  const q = cs ? p.slice(1) : p;
  const digits = q.replace(/\D/g, "");
  if (digits.length >= 7 && /^[\d\s().+-]+$/.test(q)) return new RegExp(`(?<!\\d)${digits.split("").map(esc).join("[\\s().-]*")}(?!\\d)`);
  return new RegExp(`(?<![\\w@])${esc(q)}(?![\\w@])`, cs ? "" : "i");
});
const allowFile = path.join(__dirname, "privacy-allowlist.txt");
const allow = fs.existsSync(allowFile)
  ? fs.readFileSync(allowFile, "utf8").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).map((l) => {
    const [file, text] = l.split(" :: ");
    return { file: file.trim(), text: (text || "").trim() };
  }).filter((a) => a.file && a.text)
  : [];
// A copy of an allowlisted file elsewhere (the extracted store zip, checked with --paths) is the same file: the
// allowlist entry applies when the path ends with the listed file, and the line still has to hold the listed text.
const allowed = (f, line) => allow.some((a) => (a.file === f || f.endsWith("/" + a.file)) && line.includes(a.text));

const staged = process.argv.includes("--staged");
const pathsAt = process.argv.indexOf("--paths");
const givenPaths = pathsAt >= 0 ? process.argv.slice(pathsAt + 1) : null;
const SELF = new Set(["tests/private-patterns.txt", "tests/privacy-allowlist.txt"]);
const BINARY = /.(png|jpe?g|gif|ico|pdf|zip|crx|woff2?)$/i;
// --paths: the given files, and every file under the given folders (never .git), as repo-relative names.
function walk(p) {
  const abs = path.isAbsolute(p) ? p : path.join(root, p);
  if (!fs.existsSync(abs)) throw new Error(`--paths: ${p} doesn't exist`);
  if (fs.statSync(abs).isFile()) return [path.relative(root, abs).split(path.sep).join("/")];
  return fs.readdirSync(abs, { withFileTypes: true }).filter((d) => d.name !== ".git").flatMap((d) => walk(path.join(abs, d.name)));
}
const files = (givenPaths
  ? givenPaths.flatMap(walk)
  : staged
    ? git(["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"]).toString("utf8").split("\0")
    : git(["ls-files", "-c", "-o", "--exclude-standard", "-z"]).toString("utf8").split("\0")
).filter((f) => f && !SELF.has(f) && !BINARY.test(f));

const hits = [];
let allowedHits = 0;
for (const f of files) {
  let text;
  try {
    text = staged ? git(["show", `:${f}`]).toString("utf8") : fs.readFileSync(path.join(root, f), "utf8");
  } catch {
    continue; // deleted / unreadable
  }
  const lines = text.split(/\r?\n/);
  rxs.forEach((rx, i) => {
    lines.forEach((line, n) => {
      if (!rx.test(line)) return;
      if (allowed(f, line)) allowedHits++;
      else hits.push(`  ${f}:${n + 1}: matches pattern ${i + 1} of private-patterns.txt`);
    });
  });
}
const where = givenPaths ? (givenPaths.length > 6 ? `the ${givenPaths.length} given paths` : givenPaths.join(", ")) : staged ? "the staged files" : "the working tree";
if (hits.length) {
  console.log(`PRIVACY CHECK FAILED: personal data in ${where} (${hits.length} line${hits.length === 1 ? "" : "s"}; replace it with fake data):`);
  for (const h of hits) console.log(h);
  process.exit(1);
}
console.log(`privacy check: ${pats.length} personal strings, none found in ${where} (${files.length} files${allowedHits ? `; ${allowedHits} allowlisted` : ""})`);
