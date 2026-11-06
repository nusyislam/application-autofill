// Loads background.js in a Node vm with a stubbed `chrome` (storage backed by `store`) and the given `fetch`, so the
// worker's Claude functions (askAI, draftAI, classifyAsk, ...) can be called outside the browser. Used by
// tests/bg-request.js-style checks and by the hand-run scripts tests/live-smoke.js and tests/reclassify-learned.js.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function loadBackground({ store, fetch, quiet = true }) {
  const root = path.join(__dirname, "..");
  const any = () => new Proxy(function () {}, { get: (t, k) => (k === "then" ? undefined : any()), apply: () => Promise.resolve(undefined) });
  const chrome = new Proxy({
    storage: { local: {
      get: async (keys) => {
        const ks = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys || {});
        const out = {};
        for (const k of ks) if (store[k] !== undefined) out[k] = JSON.parse(JSON.stringify(store[k]));
        return out;
      },
      set: async (o) => Object.assign(store, o),
    }, onChanged: any() },
  }, { get: (t, k) => (k in t ? t[k] : any()) });
  const log = quiet ? () => {} : console.log;
  const ctx = { chrome, console: { log, warn: log, error: log }, setTimeout, clearTimeout, AbortController, URL, TextEncoder, fetch };
  ctx.globalThis = ctx;
  ctx.self = ctx;
  ctx.importScripts = (...files) => { for (const f of files) vm.runInContext(fs.readFileSync(path.join(root, f), "utf8"), ctx, { filename: f }); };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(root, "background.js"), "utf8"), ctx, { filename: "background.js" });
  return ctx;
}

module.exports = { loadBackground };
