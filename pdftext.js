// PDF text extraction for the Options page, entirely in this browser: the bundled pdf.js (lib/pdfjs, Apache-2.0,
// pdfjs-dist 5.7.284, its LEGACY build: legacy/build/pdf.min.mjs and pdf.worker.min.mjs, unmodified) reads the file the
// user picked. The legacy build carries core-js polyfills for the newer built-ins the modern build calls directly:
// 1.1.0 shipped the modern build, and an older Chrome failed with "a.toHex is not a function". Its targets are
// Chrome >= 118 (pdf.js gulpfile ENV_TARGETS), which is the manifest's minimum_chrome_version. Nothing is fetched
// from the network and no remote code runs: the library is files of the extension. Used for the resume (when it's a PDF) and the LinkedIn profile PDF
// (LinkedIn's "More > Save to PDF"); the text goes into the Options text boxes for review.
//
//   const text = await AAF_PDFTEXT.extract(arrayBuffer)   // "" for a PDF without a text layer (a scan)
//   AAF_PDFTEXT.layout(pages)                             // the text from positioned items (see below), for tests
//
// The text is rebuilt from where pdf.js places each piece of text, never from its end-of-line marks (which gave a
// blank line after every line):
//   1. Items on the same baseline are one line, left to right; a space where the gap is a space or more, " | " where
//      it's a wide gap (a right-aligned date or location beside a title).
//   2. Page footers / headers ("Page 2 of 3", "2 / 3") are dropped.
//   3. Two columns (LinkedIn's sidebar): an empty vertical band that no item crosses, with text on both sides, splits
//      the page; the column with more text is the main one. All main columns come first, then the sidebars.
//   4. A wrapped line joins the one before it when the spacing is the normal line spacing, the line before reaches
//      the column's right side, the font size is the same, and it doesn't start a bullet. A larger gap is a blank line
//      (a new paragraph); anything else is a new line.
//   5. Joined lines get a space ("evals." + "Most" -> "evals. Most"); a word ending in a hyphen is joined without one,
//      keeping the hyphen ("test-" + "applicant"), and a link split at "-" or "/" is rejoined even on a short line.
(() => {
  const LIB = "lib/pdfjs/pdf.min.mjs";
  const WORKER = "lib/pdfjs/pdf.worker.min.mjs";
  const url = (p) => new URL(p, document.baseURI).href;
  let lib;
  const load = async () => {
    if (!lib) {
      // The parser runs on this page's thread (pdf.js uses globalThis.pdfjsWorker instead of starting a Worker):
      // a resume or a LinkedIn PDF is a few pages, and no worker has to be scheduled.
      globalThis.pdfjsWorker ??= await import(url(WORKER));
      lib = await import(url(LIB));
      lib.GlobalWorkerOptions.workerSrc = url(WORKER);
    }
    return lib;
  };

  const BULLET = /^[•◦▪▫‣●○■□·∙*\-–—]\s*/;
  const FOOTER = /^(page\s+)?\d{1,3}\s*(of|\/)\s*\d{1,3}$|^page\s+\d{1,3}$|^-\s*\d{1,3}\s*-$/i;
  const URLISH = /(https?:|www\.|\.(com|org|net|io|dev|ai|edu|me|co)\b|\/)/i;
  // "evals.Most" (pieces with no gap between them) -> "evals. Most": a period between a word of 2+ lowercase letters
  // and a capitalized word. Not in links / emails ("@", "/", "www."), decimals ("3.8"), "e.g." / "U.S." (one letter
  // before the period) or "ASP.NET" (capitals).
  const spaceSentences = (s) => s.split(" ").map((tok) => (/@|\/|www\./i.test(tok) ? tok : tok.replace(/([a-z]{2,})\.([A-Z][a-z])/g, "$1. $2"))).join(" ");
  // A short label ending in ":" (up to four words) starts its own line ("Frameworks: Node.js, React").
  const LABEL = /^[A-Z][\w+#&/().'-]*(\s[\w+#&/().'-]+){0,3}:(\s|$)/;
  const median = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length ? s[Math.floor(s.length / 2)] : 0;
  };

  // Items -> lines on the same baseline. Each line: { y, h, x, right, text, wide (a wide gap inside), font (the first
  // piece's font: pdf.js gives each font, e.g. a bold one, its own name), lastFont (the last piece's) }.
  function toLines(items) {
    const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
    const groups = [];
    for (const it of sorted) {
      const g = groups.find((g) => Math.abs(g.y - it.y) <= Math.max(1.5, 0.35 * Math.min(g.h, it.h)));
      if (g) {
        g.items.push(it);
        g.h = Math.max(g.h, it.h);
      } else groups.push({ y: it.y, h: it.h, items: [it] });
    }
    return groups
      .map((g) => {
        const its = g.items.sort((a, b) => a.x - b.x);
        let text = "";
        let right = null;
        let wide = false;
        for (const it of its) {
          if (right != null) {
            const gap = it.x - right;
            if (gap > Math.max(3 * g.h, 30)) {
              text = text.trimEnd() + " | ";
              wide = true;
            } else if (gap > 0.12 * g.h && !/\s$/.test(text)) text += " ";
          }
          text += it.str;
          right = Math.max(right ?? -Infinity, it.x + it.w);
        }
        return { y: g.y, h: g.h, x: its[0].x, right, text: spaceSentences(text.replace(/\s+/g, " ").trim()), wide, font: its[0].font, lastFont: its.at(-1).font };
      })
      .filter((l) => l.text)
      .sort((a, b) => b.y - a.y);
  }

  // The x of an empty vertical band splitting the page into two columns, or null. Bands are the gaps in the x
  // coverage of all items; a band counts when it is 15 pt or wider, inside the middle 70% of the page, and both
  // sides hold 3+ lines whose heights overlap.
  function columnSplit(items, pageWidth) {
    const iv = items.map((i) => [i.x, i.x + i.w]).sort((a, b) => a[0] - b[0]);
    const gaps = [];
    let end = -Infinity;
    for (const [a, b] of iv) {
      if (end > -Infinity && a - end >= 15) gaps.push([end, a]);
      end = Math.max(end, b);
    }
    let best = null;
    for (const [a, b] of gaps) {
      const mid = (a + b) / 2;
      if (mid < pageWidth * 0.15 || mid > pageWidth * 0.85) continue;
      const left = toLines(items.filter((i) => i.x + i.w <= mid));
      const right = toLines(items.filter((i) => i.x >= mid));
      if (left.length < 3 || right.length < 3) continue;
      const span = (ls) => [ls.at(-1).y, ls[0].y];
      const [l0, l1] = span(left);
      const [r0, r1] = span(right);
      const overlap = Math.min(l1, r1) - Math.max(l0, r0);
      if (overlap < 0.3 * Math.min(l1 - l0, r1 - r0)) continue;
      if (!best || b - a > best.width) best = { x: mid, width: b - a };
    }
    return best?.x ?? null;
  }

  // Lines of one column -> text with wrapped lines joined and paragraphs separated by a blank line.
  // `wraps` false (a sidebar: lists of short items, where the longest item would look like a wrapped line): only split
  // links and hyphenated words are rejoined.
  function columnText(lines, { wraps = true } = {}) {
    if (!lines.length) return "";
    const left = Math.min(...lines.map((l) => l.x));
    const right = Math.max(...lines.map((l) => l.right));
    const width = right - left || 1;
    const deltas = [];
    for (let i = 1; i < lines.length; i++) {
      const d = lines[i - 1].y - lines[i].y;
      if (d > 0 && d < 3 * lines[i].h && Math.abs(lines[i].h - lines[i - 1].h) <= 0.15 * lines[i].h) deltas.push(d);
    }
    const body = median(lines.map((l) => l.h)) || 10;
    const normal = median(deltas) || 1.2 * body;
    const out = [lines[0].text];
    let inBullet = BULLET.test(lines[0].text); // the output line being built started with a bullet
    for (let i = 1; i < lines.length; i++) {
      const prev = lines[i - 1];
      const cur = lines[i];
      const gap = prev.y - cur.y;
      // Bigger type sits further apart: the allowance grows with the larger of the two lines' size.
      if (gap > Math.max(normal * 1.3, normal + 2) * Math.max(1, Math.max(prev.h, cur.h) / body)) {
        out.push("", cur.text);
        inBullet = BULLET.test(cur.text);
        continue;
      }
      const last = out.at(-1);
      const sameSize = Math.abs(cur.h - prev.h) <= 0.15 * cur.h;
      const lastWord = last.split(" ").pop();
      const splitLink = /[-/]$/.test(last) && URLISH.test(lastWord);
      const full = prev.right >= right - Math.max(0.15 * width, 2 * prev.h);
      const continues = cur.x <= left + 0.5 * width && !BULLET.test(cur.text) && !prev.wide;
      // An email / link on its own line, or a line starting with a link, is an item of its own.
      const standalone = /@|^(https?:|www\.)/i.test(lastWord) || /^(https?:|www\.)\S/i.test(cur.text);
      const hyphenWord = /[^\s-]-$/.test(last);
      // A new block, never a continuation: a right-aligned piece on the line (a title with its date), a font (a bold
      // title or label) that differs from both fonts of the line before, a "Label:" line, or, after an indented
      // bullet continuation, a line starting further left (back at the margin).
      const newBlock =
        cur.wide ||
        (cur.font && prev.lastFont && cur.font !== prev.lastFont && cur.font !== prev.font) ||
        LABEL.test(cur.text) ||
        (inBullet && cur.x < prev.x - 0.5 * cur.h);
      if (sameSize && continues && !newBlock && (splitLink || (!standalone && (wraps ? full : full && hyphenWord)))) {
        const hyphen = /[^\s-]-$/.test(last) || /\/$/.test(last);
        out[out.length - 1] = hyphen ? last + cur.text : `${last} ${cur.text}`;
      } else {
        out.push(cur.text);
        inBullet = BULLET.test(cur.text);
      }
    }
    return out.join("\n");
  }

  // pages: [{ width, items: [{ str, x, y, w, h }] }] -> the text.
  function layout(pages) {
    const mains = [];
    const sides = [];
    for (const page of pages) {
      let items = page.items.filter((i) => i.str && i.str.trim());
      // Footers / headers: a whole baseline that reads "Page N of M" (or "N / M", "- N -").
      const drop = new Set();
      for (const line of toLines(items)) if (FOOTER.test(line.text)) for (const i of items) if (Math.abs(i.y - line.y) <= Math.max(1.5, 0.35 * line.h)) drop.add(i);
      items = items.filter((i) => !drop.has(i));
      const split = columnSplit(items, page.width);
      if (split == null) {
        mains.push(columnText(toLines(items)));
        continue;
      }
      const cols = [items.filter((i) => i.x + i.w <= split), items.filter((i) => !(i.x + i.w <= split))];
      const chars = (c) => c.reduce((n, i) => n + i.str.length, 0);
      const [main, side] = chars(cols[0]) >= chars(cols[1]) ? cols : [cols[1], cols[0]];
      mains.push(columnText(toLines(main)));
      sides.push(columnText(toLines(side), { wraps: false }));
    }
    // A list that runs across a page break stays one list: no blank line when the page ended on a bullet and the next
    // one starts with one.
    let text = "";
    for (const m of mains.filter(Boolean)) {
      const lastLine = text.split("\n").pop();
      text += !text ? m : BULLET.test(lastLine) && BULLET.test(m) ? "\n" + m : "\n\n" + m;
    }
    return [text, ...sides].filter(Boolean).join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  async function extract(data) {
    const pdfjs = await load();
    const doc = await pdfjs.getDocument({
      data: new Uint8Array(data),
      // Text only: no eval, no font loading, no fetching of fonts / cmaps / wasm from anywhere.
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
      useWorkerFetch: false,
      stopAtErrors: false,
      // Errors only: the standard-font warning (font data isn't needed for text) would only add console noise.
      verbosity: pdfjs.VerbosityLevel?.ERRORS ?? 0,
    }).promise;
    const pages = [];
    try {
      for (let n = 1; n <= doc.numPages; n++) {
        const page = await doc.getPage(n);
        const { items } = await page.getTextContent();
        const items2 = [];
        for (const it of items) {
          if (typeof it.str !== "string" || !it.transform) continue;
          const [a, b, c, d, x, y] = it.transform;
          // Horizontal text only (rotated stamps / watermarks are left out).
          if (Math.abs(b) > 0.01 * Math.abs(a) + 0.01) continue;
          items2.push({ str: it.str, x, y, w: it.width || 0, h: it.height || Math.hypot(c, d) || 10, font: it.fontName });
        }
        pages.push({ width: page.view[2] - page.view[0], items: items2 });
        page.cleanup();
      }
    } finally {
      doc.destroy();
    }
    return layout(pages);
  }

  const isPdf = (file) => !!file && (/\.pdf$/i.test(file.name || "") || file.type === "application/pdf");
  globalThis.AAF_PDFTEXT = { extract, isPdf, layout };
})();
