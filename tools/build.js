// Builds the Chrome Web Store package: dist/application-autofill-<version>.zip, holding only the files the
// extension needs, with manifest.json at the root of the zip.
//
//   node tools/build.js            build the zip (and run the privacy check on what goes in, plus store/)
//   node tools/build.js --list     only print the files that would go in
//
// Which files: the manifest, every script it names (the content scripts, the service worker and the files it
// importScripts), the popup and options pages with the scripts they load, and the icons (the manifest's plus any
// "icons/..." path a script uses, e.g. the desktop notification's). Nothing else: no tests/, docs/, store/, README,
// CLAUDE.md or LICENSE. A referenced file that doesn't exist fails the build; a .js under shared/ or adapters/ that
// nothing references is reported (it wouldn't be loaded anyway). No dependencies: the zip is written here (deflate
// through zlib) and read back to verify it. The privacy check (tests/privacy-check.js --paths) must pass on the
// files going in and on store/ before the zip is written; a hit stops the build.
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { execFileSync, spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const rel = (p) => path.relative(root, p).split(path.sep).join("/");
const exists = (f) => fs.existsSync(path.join(root, f));
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");
const listOnly = process.argv.includes("--list");

const manifest = JSON.parse(read("manifest.json"));
const files = new Set(["manifest.json"]);
const missing = [];
const add = (f, from) => {
  f = String(f).replace(/^\.?\//, "");
  if (!exists(f)) missing.push(`${f} (named by ${from})`);
  files.add(f);
};
// Scripts a page loads: <script src="..."> (relative to the page's folder).
const pageScripts = (page) => {
  const dir = path.posix.dirname(page);
  const out = [];
  for (const m of read(page).matchAll(/<script[^>]*\ssrc="([^"]+)"/g)) out.push(path.posix.normalize(path.posix.join(dir, m[1])));
  return out;
};
// Files a script pulls in: importScripts("...") (the service worker), and icon paths it uses.
const scriptRefs = (js) => {
  const s = read(js);
  const out = [];
  for (const m of s.matchAll(/importScripts\(\s*["']([^"']+)["']\s*\)/g)) out.push(m[1]);
  for (const m of s.matchAll(/["'`](icons\/[^"'`\s]+)["'`]/g)) out.push(m[1]);
  return out;
};

if (manifest.background?.service_worker) {
  add(manifest.background.service_worker, "background.service_worker");
  for (const r of scriptRefs(manifest.background.service_worker)) add(r, manifest.background.service_worker);
}
for (const cs of manifest.content_scripts || []) for (const js of cs.js || []) add(js, "content_scripts");
for (const page of [manifest.action?.default_popup, manifest.options_page, manifest.options_ui?.page].filter(Boolean)) {
  add(page, "manifest");
  if (exists(page)) for (const js of pageScripts(page)) add(js, page);
}
for (const icon of Object.values(manifest.icons || {})) add(icon, "icons");
for (const icon of Object.values(manifest.action?.default_icon || {})) add(icon, "action.default_icon");
for (const f of [...files]) if (/\.js$/.test(f) && exists(f)) for (const r of scriptRefs(f)) add(r, f);
for (const w of manifest.web_accessible_resources || []) for (const r of w.resources || []) if (!/[*]/.test(r)) add(r, "web_accessible_resources");

if (missing.length) {
  console.error("BUILD FAILED: the manifest or a script names files that don't exist:\n  " + missing.join("\n  "));
  process.exit(1);
}
// Modules nothing loads (a new file not yet added to the manifest's content_scripts lists, or a leftover).
const walk = (dir) => (fs.existsSync(path.join(root, dir)) ? fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(`${dir}/${d.name}`) : [`${dir}/${d.name}`])) : []);
const unreferenced = [...walk("shared"), ...walk("adapters")].filter((f) => /\.js$/.test(f) && !files.has(f));
if (unreferenced.length) console.warn("note: not referenced by the manifest or a script, so not packaged: " + unreferenced.join(", "));

const sorted = [...files].sort((a, b) => (a === "manifest.json" ? -1 : b === "manifest.json" ? 1 : a.localeCompare(b)));
const sizes = Object.fromEntries(sorted.map((f) => [f, fs.statSync(path.join(root, f)).size]));
const total = Object.values(sizes).reduce((a, b) => a + b, 0);
console.log(`${sorted.length} files, ${(total / 1024).toFixed(0)} KB uncompressed:`);
for (const f of sorted) console.log(`  ${f}  ${sizes[f]}`);
if (listOnly) process.exit(0);

// The privacy check on exactly these files, and on store/ (the listing and the screenshot sources) when it exists,
// without store/.build (the screenshot build pages, git-ignored).
const storePaths = exists("store") ? fs.readdirSync(path.join(root, "store")).filter((n) => n !== ".build").map((n) => `store/${n}`) : [];
const checkPaths = [...sorted, ...storePaths];
const pc = spawnSync(process.execPath, [path.join(root, "tests", "privacy-check.js"), "--paths", ...checkPaths], { cwd: root, stdio: "inherit" });
if (pc.status !== 0) {
  console.error("BUILD FAILED: the privacy check found personal data (above); nothing was written.");
  process.exit(1);
}

// ---- zip (local headers + central directory; deflate when it helps, else stored; UTF-8 names, forward slashes)
const crc32 = zlib.crc32
  ? (buf) => zlib.crc32(buf) >>> 0
  : (() => {
      const T = new Int32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        T[n] = c;
      }
      return (buf) => {
        let c = -1;
        for (const b of buf) c = T[(c ^ b) & 0xff] ^ (c >>> 8);
        return (c ^ -1) >>> 0;
      };
    })();
const dosTime = (d) => ({
  time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
  date: ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
});
function zip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const deflated = zlib.deflateRawSync(e.data, { level: 9 });
    const stored = deflated.length >= e.data.length;
    const body = stored ? e.data : deflated;
    const method = stored ? 0 : 8;
    const name = Buffer.from(e.name, "utf8");
    const crc = crc32(e.data);
    const { time, date } = dosTime(e.mtime);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4); // version needed: 2.0 (deflate)
    lh.writeUInt16LE(0x0800, 6); // UTF-8 names
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);
    parts.push(lh, name, body);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4); // made by: 2.0, MS-DOS attributes
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(time, 12);
    ch.writeUInt16LE(date, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(e.data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt16LE(0, 30); // extra
    ch.writeUInt16LE(0, 32); // comment
    ch.writeUInt16LE(0, 34); // disk
    ch.writeUInt16LE(0, 36); // internal attributes
    ch.writeUInt32LE(0, 38); // external attributes
    ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += lh.length + name.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...parts, cd, end]);
}
// Reads a zip's central directory back: the entry names (to verify what was written).
function zipNames(buf) {
  let p = buf.length - 22;
  while (p >= 0 && buf.readUInt32LE(p) !== 0x06054b50) p--;
  if (p < 0) throw new Error("no end-of-central-directory record");
  const count = buf.readUInt16LE(p + 10);
  let q = buf.readUInt32LE(p + 16);
  const names = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(q) !== 0x02014b50) throw new Error("bad central directory entry");
    const n = buf.readUInt16LE(q + 28);
    const x = buf.readUInt16LE(q + 30);
    const c = buf.readUInt16LE(q + 32);
    names.push(buf.toString("utf8", q + 46, q + 46 + n));
    q += 46 + n + x + c;
  }
  return names;
}

const entries = sorted.map((f) => ({ name: f, data: fs.readFileSync(path.join(root, f)), mtime: fs.statSync(path.join(root, f)).mtime }));
const out = path.join(root, "dist", `application-autofill-${manifest.version}.zip`);
fs.mkdirSync(path.dirname(out), { recursive: true });
const buf = zip(entries);
fs.writeFileSync(out, buf);

// Verify: the same names back, manifest.json at the root, nothing from tests/ or store/, and `tar -tf` agrees when
// Windows' tar is there (it lists zips).
const back = zipNames(fs.readFileSync(out));
const problems = [];
if (back.length !== sorted.length || back.some((n, i) => n !== sorted[i])) problems.push("the entries read back differ from the file list");
if (!back.includes("manifest.json")) problems.push("manifest.json is not at the root of the zip");
if (back.some((n) => /^(tests|store|docs|dist|\.git)\//.test(n) || /\\/.test(n))) problems.push("a tests/ store/ docs/ dist/ entry or a backslash in a name");
try {
  const listed = execFileSync("tar", ["-tf", out], { encoding: "utf8" }).split(/\r?\n/).filter(Boolean).sort();
  const want = [...sorted].sort();
  if (listed.length !== want.length || listed.some((n, i) => n !== want[i])) problems.push("tar -tf lists different entries");
  else console.log(`verified with tar -tf: ${listed.length} entries`);
} catch {
  console.log("(tar not available; verified from the zip's central directory only)");
}
if (problems.length) {
  console.error("BUILD FAILED: " + problems.join("; "));
  process.exit(1);
}
console.log(`wrote ${rel(out)} (${(buf.length / 1024).toFixed(0)} KB, ${back.length} entries, version ${manifest.version})`);
