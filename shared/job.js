// Application Autofill: the job posting itself (not the form). `AAF.jobInfo()` returns
// { location, description, from } for the posting this application belongs to, read once per page
// URL and logged. Used by the office-attendance rule (job location) and draft mode (job description).
//
// Sources, in order: the adapter's own `jobInfo()` (page DOM, inline data, a same-origin fetch of the
// job page, a public posting API), then schema.org JobPosting JSON-LD on this page. Each value keeps
// the first source that had it.

(() => {
  const AAF = globalThis.AAF;
  if (!AAF.once("job")) return;
  const { dbg, norm } = AAF;

  const clean = (s) => String(s || "").replace(/ /g, " ").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  // HTML (possibly entity-escaped, as in Greenhouse's API) -> plain text.
  function htmlToText(html) {
    if (!html) return "";
    let doc = new DOMParser().parseFromString(String(html), "text/html");
    if (/<\w/.test(doc.body.textContent || "") && !doc.body.querySelector("p, li, div, br")) doc = new DOMParser().parseFromString(doc.body.textContent, "text/html");
    doc.querySelectorAll("br").forEach((b) => b.replaceWith("\n"));
    doc.querySelectorAll("p, li, div, h1, h2, h3, h4").forEach((b) => b.append("\n"));
    return clean(doc.body.textContent);
  }

  // schema.org JobPosting in <script type="application/ld+json"> (Workday, Ashby and many career sites
  // ship one for search engines). `root` is a Document (this page or a fetched one).
  function fromLD(root = document) {
    const out = {};
    for (const s of root.querySelectorAll('script[type="application/ld+json"]')) {
      let data;
      try {
        data = JSON.parse(s.textContent);
      } catch {
        continue;
      }
      const items = [data, ...(Array.isArray(data) ? data : []), ...(data?.["@graph"] || [])].flat();
      const job = items.find((x) => x && /JobPosting/.test([].concat(x["@type"] || "").join(" ")));
      if (!job) continue;
      const locs = [].concat(job.jobLocation || []).map((l) => {
        const a = l?.address || {};
        return [a.addressLocality, a.addressRegion, typeof a.addressCountry === "object" ? a.addressCountry?.name : a.addressCountry].filter(Boolean).join(", ");
      }).filter(Boolean);
      if (/TELECOMMUTE/i.test(job.jobLocationType || "")) locs.push("Remote");
      if (locs.length) out.location = locs.join("; ");
      if (job.description) out.description = htmlToText(job.description);
      break;
    }
    return out;
  }

  // Fetch a same-origin (or CORS-enabled) page and parse it; null on any failure.
  async function fetchDoc(url) {
    try {
      const r = await fetch(url, { credentials: "include" });
      if (!r.ok) return null;
      return new DOMParser().parseFromString(await r.text(), "text/html");
    } catch {
      return null;
    }
  }
  async function fetchJSON(url) {
    try {
      const r = await fetch(url);
      return r.ok ? await r.json() : null;
    } catch {
      return null;
    }
  }

  let cache = null;
  async function jobInfo() {
    if (cache?.url === location.href) return cache.info;
    const info = { location: "", description: "", from: {} };
    const take = (got, src) => {
      for (const k of ["location", "description"]) {
        let v = clean(got?.[k]);
        // A location listed twice ("New York; New York", Remedy AI's sidebar + app data) is one location.
        if (k === "location" && v) {
          const seen = new Set();
          v = v.split(/\s*;\s*/).filter((x) => x && !seen.has(norm(x)) && seen.add(norm(x))).join("; ");
        }
        if (v && !info[k]) {
          info[k] = v;
          info.from[k] = src;
        }
      }
    };
    try {
      take(await AAF.adapter?.jobInfo?.(), AAF.adapter?.name || "adapter");
    } catch (e) {
      dbg(`job posting: the adapter's reader failed: ${e.message}`);
    }
    if (!info.location || !info.description) take(fromLD(document), "JSON-LD on this page");
    dbg(
      `job location: ${info.location ? `"${info.location.slice(0, 120)}" (from ${info.from.location})` : "not found"}; ` +
        `job description: ${info.description ? `${info.description.length} chars (from ${info.from.description})` : "not found"}`
    );
    cache = { url: location.href, info };
    return info;
  }

  Object.assign(AAF, { jobInfo, jobFromLD: fromLD, htmlToText, fetchDoc, fetchJSON });
})();
