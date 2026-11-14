const $ = (id) => document.getElementById(id);
const status = (t) => ($("status").textContent = t);

(async () => {
  const { settings = {} } = await chrome.storage.local.get("settings");
  $("useAI").checked = settings.useAI !== false;
  $("learn").checked = settings.learn !== false;
  $("drafts").checked = settings.drafts !== false;
})();

async function saveSettings() {
  const { settings = {} } = await chrome.storage.local.get("settings");
  settings.useAI = $("useAI").checked;
  settings.learn = $("learn").checked;
  settings.drafts = $("drafts").checked;
  await chrome.storage.local.set({ settings });
}
$("useAI").addEventListener("change", saveSettings);
$("learn").addEventListener("change", saveSettings);
$("drafts").addEventListener("change", saveSettings);

$("opts").addEventListener("click", () => chrome.runtime.openOptionsPage());

// The keyboard shortcut as actually bound (the user can change it in chrome://extensions/shortcuts).
chrome.commands.getAll().then((cmds) => {
  const c = cmds.find((x) => x.name === "fill-page");
  $("shortcut").textContent = c?.shortcut ? `Shortcut: ${c.shortcut}` : "Shortcut: not set (chrome://extensions/shortcuts)";
});

// The footer: which build this is, the same line as the first [autofill] log line of every fill ("Application Autofill
// 1.0.2 (unpacked, main 7c4217e)" / "(store)"). The manifest gives the version and store / unpacked at once; the git
// commit comes from background.js (BUILD_INFO).
(async () => {
  const m = chrome.runtime.getManifest();
  $("build").textContent = `Application Autofill ${m.version} (${m.update_url ? "store" : "unpacked"})`;
  const r = await chrome.runtime.sendMessage({ type: "BUILD_INFO" }).catch(() => null);
  if (r?.line) $("build").textContent = r.line;
})();

// While a fill runs in this tab the button is "Stop autofill" (checked when the popup opens, then every 700 ms).
let runningHere = false;
const setRunning = (r) => {
  runningHere = r;
  $("fill").textContent = r ? "Stop autofill" : "Fill this page";
};
async function refreshRunning() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  const res = await chrome.runtime.sendMessage({ type: "FILL_STATUS", tabId: tab.id }).catch(() => null);
  setRunning(!!res?.running);
}
refreshRunning();
setInterval(refreshRunning, 700);

$("fill").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  if (runningHere) {
    status("Stopping…");
    const r = await chrome.runtime.sendMessage({ type: "STOP_TAB", tabId: tab.id }).catch(() => null);
    status(r?.stopped ? "Stopped. Fields filled so far stay as they are." : "Nothing to stop.");
    setRunning(false);
    return;
  }
  setRunning(true);
  status("Filling… (watch the page)");
  // Same path as the keyboard shortcut (background.js fillTab): ping, inject if needed, then FILL to
  // every frame, so an embedded Greenhouse or Ashby form on a company site works too.
  const res = await chrome.runtime.sendMessage({ type: "FILL_TAB", tabId: tab.id }).catch(() => null);
  setRunning(false);
  if (!res) return status("Filling in progress on the page.");
  if (res.stopped) return status(`Stopped. Filled ${res.filled}, kept ${res.kept ?? 0}. ${res.needs} need you.`);
  if (res.error) return status(res.error);
  if (res.done) return status("Done.");
  if (res.passive || res.delegated) return status("Filling the form in the page's frame…");
  status(`Filled ${res.filled}, kept ${res.kept ?? 0} (already correct). ${res.needs} need you, ${res.drafts ?? 0} drafts to review.`);
});
