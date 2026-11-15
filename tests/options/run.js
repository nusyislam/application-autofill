// Options-page tests in headless Edge: the real options.html with a chrome.* stub (stub.js, seeded per scenario) and
// a driver (driver.js) that clicks through the setup guide, the PDF uploads and the Clear fields dialog, and reports
// PASS / FAIL lines. Run by tests/run.ps1; by hand:
//
//   node tests/options/run.js                       the working tree
//   node tests/options/run.js --tree <folder>       another tree's options page (e.g. tests/.out/before, HEAD)
//   node tests/options/run.js --only clear          scenarios whose name starts with "clear"
//
// The page is served over http://127.0.0.1 (a loopback-only server for the test, closed at the end), not file://:
// pdf.js is an ES module, and module scripts don't load from file:// (origin null), while an extension page has a
// real origin. stub.js, driver.js and the fake PDFs always come from this folder. Exit 1 on any FAIL.
const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const here = __dirname;
const repo = path.resolve(here, "..", "..");
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : null;
};
const tree = path.resolve(arg("--tree") || repo);
const only = arg("--only") || "";
// --dump <pdf under the repo>: print the text pdftext.js extracts from that file (e.g. your own resume saved as
// tests/options/<name>-raw.pdf, git-ignored), nothing else.
const dump = arg("--dump");
const SCENARIOS = dump ? ["dump"] : ["empty", "api-only", "filled", "resume", "skipped", "pdf", "next", "done", "clear-default", "clear-ticked", "clear-cancel", "clear-export", "reload-setup", "reload-outside", "leave-warns", "prefill-setup", "prefill-nokey", "prefill-existing", "prefill-links"].filter((s) => s.startsWith(only));
const query = (s) => `s=${encodeURIComponent(s)}` + (s === "dump" ? `&f=${encodeURIComponent(path.relative(repo, path.resolve(dump)).split(path.sep).join("/"))}` : "");
const edge = [path.join(process.env["ProgramFiles(x86)"] || "", "Microsoft/Edge/Application/msedge.exe"), path.join(process.env.ProgramFiles || "", "Microsoft/Edge/Application/msedge.exe")].find((p) => fs.existsSync(p));
if (!edge) {
  console.error("Microsoft Edge not found");
  process.exit(1);
}
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".pdf": "application/pdf", ".css": "text/css", ".json": "application/json", ".png": "image/png" };

// The test page: the tree's options.html with the stub before its first script and the driver after its last.
function testPage() {
  let html = fs.readFileSync(path.join(tree, "options.html"), "utf8");
  html = html.replace(/<script/, '<script src="/tests/options/stub.js"></script>\n<script');
  return html.replace(/<\/body>/, '<script src="/tests/options/driver.js"></script>\n</body>');
}
function serve(req, res) {
  const url = decodeURIComponent(req.url.split("?")[0]);
  if (req.method !== "GET") return res.writeHead(405).end();
  if (url === "/options.html") return res.writeHead(200, { "content-type": "text/html" }).end(testPage());
  const base = url.startsWith("/tests/options/") ? repo : tree;
  const file = path.resolve(base, "." + url);
  if (!file.startsWith(base + path.sep)) return res.writeHead(403).end();
  fs.readFile(file, (err, data) => {
    if (err) return res.writeHead(404).end();
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" }).end(data);
  });
}
const decode = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");

function runEdge(url, profileDir) {
  return new Promise((resolve) => {
    const p = spawn(edge, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", `--user-data-dir=${profileDir}`, "--virtual-time-budget=60000", "--dump-dom", url]);
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", () => {});
    p.on("close", () => resolve(out));
  });
}

(async () => {
  const server = http.createServer(serve);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const outDir = path.join(repo, "tests", ".out");
  fs.mkdirSync(outDir, { recursive: true });
  let pass = 0;
  let fail = 0;
  console.log(`Options-page tests (${path.relative(repo, tree) || "working tree"}):`);
  for (const s of SCENARIOS) {
    const dom = await runEdge(`http://127.0.0.1:${port}/options.html?${query(s)}`, path.join(outDir, `edge-options-${s}`));
    const m = dom.match(/@@BEGIN\r?\n([\s\S]*?)\r?\n?@@END/);
    const lines = m ? decode(m[1]).split(/\r?\n/).filter(Boolean) : ["FAIL no report (the page never finished; a script error?)"];
    // A dump holds your own data: printed only, never written to tests/.out.
    if (s !== "dump") fs.writeFileSync(path.join(outDir, `options-${s}.txt`), lines.join("\n") + "\n");
    // INFO lines (the extracted texts) are printed for a dump, or when the scenario failed.
    const failed = lines.some((l) => !l.startsWith("PASS") && !l.startsWith("INFO"));
    for (const l of lines) {
      if (l.startsWith("PASS")) pass++;
      else if (!l.startsWith("INFO")) fail++;
      if (!l.startsWith("INFO") || failed || s === "dump") console.log(`  ${s}: ${l}`);
    }
  }
  server.close();
  console.log(fail ? `Options-page tests: ${fail} failed, ${pass} passed` : `Options-page tests: all ${pass} passed`);
  process.exit(fail ? 1 : 0);
})();
