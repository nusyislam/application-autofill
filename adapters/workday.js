// Application Autofill: Workday adapter (myworkdayjobs.com, myworkday.com, myworkdaysite.com).
// Field discovery (formField-*, fieldsets), setters for Workday widgets (listbox dropdowns with
// scrolling, multiselect search prompts, date sections, radios, file drop zone), repeatable sections
// (work experience, education, websites, languages, skills), resume upload, and Workday timing quirks.
//
// Adapter interface (used by shared/main.js and shared/learning.js):
//   detect()                      -> true on this portal's hosts
//   discoverFields()              -> described fields { c, id, label, nl, nid, type, ctrl, required }
//   isFilled(f), isSectionField(f)
//   setField(f, value)            -> fills one field (shared AAF.setField wraps it with logging)
//   readOptions(f)                -> option texts for Claude (dropdown / radio / checkbox group), or null
//   fillSections(profile, stats)  -> resume, repeatable sections, languages, skills, preferred name
//   isFormPage(), isApplicationFlow(), isApplicationQuestionsPage()   (page-type hints)
//   watchUserAnswers()            -> wires user answers on the page to AAF.learn

(() => {
  const AAF = globalThis.AAF;
  if (!AAF.once("adapter:workday")) return;
  const { norm, dbg, show, sleep, waitFor, visible, checkboxOn, parseDate, splitAlts, setField, timed } = AAF;
  const { click, key, typeInto, expandWants, bestOption, hasPhrase, matchAlts, mark, unmark, isPreferred, isOwnUI, toast } = AAF;
  const { choiceOptions, setChoice, setCheckbox, dataUrlToFile } = AAF; // shared/controls.js

  // ------------------------------------------------------- field discovery
  function fieldContainers(root = document) {
    const set = new Set();
    root.querySelectorAll('[data-automation-id^="formField"]').forEach((el) => set.add(el));
    root.querySelectorAll("fieldset").forEach((fs) => {
      if (!fs.closest('[data-automation-id^="formField"]')) set.add(fs);
    });
    const arr = [...set].filter(visible);
    return arr.filter((c) => !arr.some((o) => o !== c && c.contains(o)));
  }

  function getLabel(c) {
    const cands = [...c.querySelectorAll("legend, label")].filter((l) => {
      const f = l.getAttribute("for");
      const t = f && document.getElementById(f);
      return !(t && (t.type === "radio" || t.type === "checkbox")) && !l.querySelector('input[type="radio"],input[type="checkbox"]');
    });
    let t = cands[0]?.innerText || "";
    if (!t) {
      const ctrl = c.querySelector("input,textarea,button");
      const ids = ctrl?.getAttribute("aria-labelledby");
      if (ids) t = ids.split(/\s+/).map((i) => document.getElementById(i)?.innerText || "").join(" ");
      if (!t) t = ctrl?.getAttribute("aria-label") || "";
    }
    if (!t) t = c.querySelector("label")?.innerText || "";
    if (!t) t = c.querySelector('[data-automation-id="richText"]')?.innerText || "";
    return t.replace(/\s+/g, " ").trim();
  }

  function describe(c) {
    const id = c.getAttribute("data-automation-id") || "";
    const rawLabel = getLabel(c);
    const label = rawLabel.replace(/\*/g, "").trim();
    let type = null;
    let ctrl = null;
    if ((ctrl = c.querySelector('input[data-automation-id^="dateSection"]'))) type = "date";
    // Search prompts (skills, school, field of study): a multiselect container, or an input next to a prompt icon.
    else if ((ctrl =
      c.querySelector('[data-automation-id="multiselectInputContainer"] input, input[data-uxi-widget-type="selectinput"], input[data-automation-id="searchBox"]') ||
      (c.querySelector('[data-automation-id="promptIcon"], [data-automation-id="promptSearchButton"]') && c.querySelector('input:not([type="hidden"])'))))
      type = "multi";
    else if ((ctrl = c.querySelector('button[aria-haspopup="listbox"]'))) type = "dropdown";
    else if (c.querySelector('input[type="radio"]')) { type = "radio"; ctrl = c; }
    else if (c.querySelectorAll('input[type="checkbox"]').length > 1) { type = "checkgroup"; ctrl = c; }
    else if ((ctrl = c.querySelector('input[type="checkbox"]'))) type = "checkbox";
    else if ((ctrl = c.querySelector('input[type="file"]'))) type = "file";
    else if ((ctrl = c.querySelector("textarea"))) type = "textarea";
    else if ((ctrl = c.querySelector('input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"]):not([type="file"])'))) type = "text";
    const required =
      /\*/.test(rawLabel) ||
      !!c.querySelector('[aria-required="true"], [required]');
    return { c, id, label, nl: norm(label), nid: norm(id.replace(/^formField-?/, "")), type, ctrl, required };
  }

  // The value a field shows now, as text ("" when empty), for the kept / replaced comparison.
  function currentValue(f) {
    switch (f.type) {
      case "text":
      case "textarea":
        return (f.ctrl.value || "").trim();
      case "dropdown":
        return isFilled(f) ? f.ctrl.innerText.trim() : "";
      case "multi":
        return [...f.c.querySelectorAll('[data-automation-id="selectedItem"]')].map((e) => e.innerText.trim()).join(", ");
      case "radio":
        return choiceOptions(f.c, "radio").find((o) => o.el.checked)?.text || "";
      case "date":
        return [...f.c.querySelectorAll('input[data-automation-id^="dateSection"]')].map((i) => i.value).filter(Boolean).join("/");
      default:
        return "";
    }
  }

  // A date section (Month / Day / Year boxes) already holding the profile date `d` ({ month, day, year },
  // any part may be blank): every box the profile has a value for holds the same number ("05" = "5").
  // true / false, or null when the profile date is blank (nothing to compare).
  function dateMatches(f, d) {
    if (!d || typeof d !== "object") return null;
    let compared = 0;
    for (const [n, raw] of [["Month", d.month], ["Day", d.day], ["Year", d.year]]) {
      const el = f.c.querySelector(`input[data-automation-id="dateSection${n}-input"]`);
      if (!el || raw == null || raw === "") continue;
      if (!/\d/.test(el.value) || Number(el.value) !== Number(raw)) return false;
      compared++;
    }
    return compared ? true : null;
  }

  function isFilled(f) {
    switch (f.type) {
      case "text":
      case "textarea":
        return !!f.ctrl.value.trim();
      case "dropdown": {
        const t = norm(f.ctrl.innerText);
        return !!t && !/^select( one)?$/.test(t);
      }
      case "multi":
        return !!f.c.querySelector('[data-automation-id="selectedItem"]');
      case "radio":
        return !!f.c.querySelector('input[type="radio"]:checked');
      case "checkgroup":
        return !!f.c.querySelector('input[type="checkbox"]:checked');
      case "checkbox":
        return f.ctrl.checked;
      case "date":
        return [...f.c.querySelectorAll('input[data-automation-id^="dateSection"]')].every((i) => i.value && /\d/.test(i.value));
      default:
        return false;
    }
  }

  // ---------------------------------------------------------------- setters
  // Dropdowns use role=listbox/option; search prompt results (skills, school) may instead be
  // data-automation-id="activeListContainer" with promptOption / promptLeafNode items. Match both.
  const LISTBOX = '[role="listbox"], [data-automation-id="activeListContainer"]';
  const OPTION = '[role="option"], [data-automation-id="promptOption"], [data-automation-id="promptLeafNode"]';
  // A multiselect's selected chips are also a listbox of options inside the field. They never close,
  // so they must not count as an open popup.
  const isChipList = (l) => !!(l.closest('[data-automation-id="multiselectInputContainer"]') || l.querySelector('[data-automation-id="selectedItem"]'));
  const shown = (el) => visible(el) || [...el.children].some(visible); // display:contents rows have no rects
  const visibleListbox = () => {
    const ls = [...document.querySelectorAll(LISTBOX)].filter(
      (l) => visible(l) && !isChipList(l) && (l.querySelector(OPTION) || l.querySelector('input[type="checkbox"]'))
    );
    return ls[ls.length - 1] || null;
  };
  // Options are role=option / prompt items (innermost only, so a promptOption nested in a role=option
  // isn't listed twice). Search results can instead be checkbox rows: then each row carries its checkbox.
  const optsOf = (list) => {
    const els = [...list.querySelectorAll(OPTION)].filter(shown);
    const inner = els.filter((el) => !els.some((o) => o !== el && el.contains(o)));
    const rows = inner.length
      ? inner
      : [...list.querySelectorAll('input[type="checkbox"]')].map((cb) => cb.closest("li, label") || cb.parentElement).filter(shown);
    return rows.map((el) => {
      const cb = el.querySelector('input[type="checkbox"]') || el.closest(OPTION)?.querySelector('input[type="checkbox"]') || null;
      return { el, cb, text: (el.innerText.trim() || cb?.getAttribute("aria-label") || "").trim() };
    });
  };
  const listWithOptions = () => {
    const l = visibleListbox();
    return l && optsOf(l).length ? l : null;
  };

  // The listbox that belongs to this button (aria-controls/aria-owns), else the newest visible one that
  // was NOT already showing before the button was clicked (`stale`). BoFL: the previous question's
  // popup was still on screen, the next dropdown took it for its own, and "No" was clicked in the
  // previous question's list: PcC "filled twice", and the contractor question stayed "Select One"
  // while the log said ok.
  function listboxFor(btn, stale = null) {
    const id = btn.getAttribute("aria-controls") || btn.getAttribute("aria-owns");
    let own = id && document.getElementById(id);
    if (own && !own.matches(LISTBOX)) own = own.querySelector(LISTBOX);
    if (own && visible(own) && optsOf(own).length) return own;
    const l = listWithOptions();
    return l && !stale?.has(l) ? l : null;
  }
  const visibleListboxes = () => [...document.querySelectorAll(LISTBOX)].filter((l) => visible(l) && !isChipList(l));

  // Workday listboxes are virtualized: only options scrolled into view exist in the DOM.
  function scrollerOf(list) {
    const scrolls = (e) => e && e.scrollHeight > e.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(e).overflowY);
    return [list, ...list.querySelectorAll("*"), list.parentElement, list.parentElement?.parentElement].find(scrolls) || list;
  }
  // Scrolls from the top in steps, calling visit(options) at each position until it returns
  // something truthy (returned) or the bottom is reached (null).
  async function scrollListbox(list, visit, maxSteps = 300) {
    const sc = scrollerOf(list);
    if (sc.scrollTop) {
      sc.scrollTop = 0;
      await sleep(120);
    }
    for (let i = 0; i < maxSteps; i++) {
      const r = visit(optsOf(list));
      if (r) return r;
      const before = sc.scrollTop;
      sc.scrollTop += Math.max(sc.clientHeight * 0.8, 40);
      await sleep(120);
      if (sc.scrollTop === before) return null;
    }
    return null;
  }
  async function allOptions(list) {
    const seen = new Set();
    await scrollListbox(list, (opts) => void opts.forEach((o) => o.text && seen.add(o.text)));
    return [...seen];
  }
  const anyOpen = () => !!visibleListbox() || !!document.querySelector('button[aria-haspopup="listbox"][aria-expanded="true"]');

  async function openDropdown(btn) {
    await ensureAllClosed();
    // A popup that is still closing must not be mistaken for this button's popup.
    await waitFor(() => !visibleListbox(), 800);
    const stale = new Set(visibleListboxes());
    click(btn);
    return waitFor(() => listboxFor(btn, stale), 2500);
  }

  // A dropdown pick counts only when the button shows the chosen option. The live field is re-found
  // when the click re-rendered it (by automation id + label). Not shown: one more try with the exact
  // option text; still not: logged, and the field gives up (the retry pass marks it yellow).
  function liveDropdown(f) {
    if (f.ctrl?.isConnected) return f;
    return fieldContainers().map(describe).find((x) => x.type === "dropdown" && x.id === f.id && x.nl === f.nl) || f;
  }
  const shownText = (f) => (liveDropdown(f).ctrl?.innerText || "").trim();
  async function confirmPick(f, text, what) {
    const shows = () => norm(shownText(f)) === norm(text);
    if (await waitFor(shows, 1000)) {
      f.picked = text;
      return true;
    }
    dbg(`${what}: picked "${text}" but the button shows "${shownText(f)}"; trying once more`);
    const lf = liveDropdown(f);
    const list = await openWithOptions(lf, what);
    if (list) {
      try {
        const pick = await scrollListbox(list, (opts) => opts.find((o) => norm(o.text) === norm(text)));
        if (pick) {
          click(pick.el);
          await sleep(250);
        }
      } finally {
        await ensureClosed(lf.ctrl);
      }
    }
    if (await waitFor(shows, 1000)) {
      dbg(`${what}: "${text}" registered on the second try`);
      f.picked = text;
      return true;
    }
    dbg(`${what}: "${text}" didn't register (the button shows "${shownText(f)}"); left for you`);
    lf.c.dataset.wdafGaveUp = "1";
    return false;
  }

  // Workday ignores some synthetic events, so a picked option can leave the popup open.
  // Escalate: Escape on the focused element/listbox -> click outside -> toggle the button.
  async function ensureClosed(btn) {
    // A re-rendered field (State after Country) leaves us holding a detached button; use the live one.
    if (btn && !btn.isConnected) btn = document.querySelector('button[aria-haspopup="listbox"][aria-expanded="true"]');
    const open = () => (btn && btn.getAttribute("aria-expanded") === "true") || !!visibleListbox();
    if (!open()) return;
    for (const t of [document.activeElement, visibleListbox(), btn].filter(Boolean)) key(t, "Escape");
    await sleep(150);
    if (!open()) return;
    const o = { bubbles: true, cancelable: true, view: window };
    for (const t of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"])
      document.body.dispatchEvent(new (t.startsWith("pointer") ? PointerEvent : MouseEvent)(t, o));
    await sleep(150);
    // Toggle the button only when IT says it's open: a popup that is merely still fading out (or
    // belongs to another field) would otherwise make this click reopen a closed dropdown.
    if (btn && btn.getAttribute("aria-expanded") === "true") {
      click(btn);
      await sleep(150);
    }
    btn?.blur?.();
    // A closing animation keeps the popup visible for a moment.
    if (open()) await waitFor(() => !open(), 800);
    if (open()) dbg("popup still open after ensureClosed", btn);
  }
  async function ensureAllClosed() {
    if (!anyOpen()) return;
    const btn = document.querySelector('button[aria-haspopup="listbox"][aria-expanded="true"]');
    await ensureClosed(btn);
  }
  const closeDropdown = ensureClosed;

  // Opens a dropdown and waits until its listbox shows at least one real option (not just
  // "Select One"). Right after a search box, a stale popup can still be closing, or the listbox can
  // be read before it renders (PcC English language read 0 options). On failure: close all popups,
  // wait 400ms, reopen, up to 2 retries. Logs each failed attempt with the listbox id / aria-controls.
  // Returns the listbox, or null (the caller closes it).
  const realOption = (o) => o.text && !/^select one$/i.test(o.text);
  async function openWithOptions(f, what) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const list = await openDropdown(f.ctrl);
      const ok = list && (await waitFor(() => list.isConnected && optsOf(list).some(realOption), 1500));
      if (ok) {
        if (attempt > 1) dbg(`${what}: options appeared on attempt ${attempt}`);
        return list;
      }
      const ids = `listbox ${list ? list.id || list.getAttribute("data-automation-id") || "(no id)" : "none"}, aria-controls ${f.ctrl.getAttribute("aria-controls") || "none"}`;
      dbg(`${what}: attempt ${attempt} read 0 options (${ids})${attempt < 3 ? ", closing popups and retrying" : ", giving up"}`);
      if (attempt < 3) {
        await ensureAllClosed();
        await sleep(400);
      }
    }
    return null;
  }

  async function setDropdown(f, wanted) {
    const text = await pickDropdown(f, wanted);
    return !!text && (await confirmPick(f, text, f.label.slice(0, 60)));
  }
  // Opens the dropdown and clicks the best option; returns its text (not yet confirmed), or null.
  async function pickDropdown(f, wanted) {
    const list = await openWithOptions(f, f.label.slice(0, 60));
    if (!list) {
      await ensureClosed(f.ctrl);
      return null;
    }
    let picked = false;
    try {
      let pick = null;
      const ws = Array.isArray(wanted) ? wanted.filter(Boolean) : [];
      if (ws.length > 1) {
        // Ordered fallbacks: the first alternative with a strong match wins, then the first with a
        // weak one. Never the best-scoring alternative regardless of order.
        const all = await allOptions(list);
        const items = all.map((text) => ({ text }));
        const best = ws.map((w) => bestOption(items, w, 85)).find(Boolean) || ws.map((w) => bestOption(items, w)).find(Boolean);
        if (best) pick = await scrollListbox(list, (opts) => opts.find((o) => o.text === best.text));
        if (!pick) dbg("no dropdown match", f.label, show(ws), `${all.length} options seen:`, show(all.slice(0, 20)));
      } else {
        // Scroll for a strong match first, so a weak early match ("New Jersey") can't beat a later
        // exact one ("New York"). Short lists finish at the first position.
        pick = await scrollListbox(list, (opts) => bestOption(opts, wanted, 85));
        if (!pick) {
          const all = await allOptions(list);
          const best = bestOption(all.map((text) => ({ text })), wanted);
          if (best) pick = await scrollListbox(list, (opts) => opts.find((o) => o.text === best.text));
          if (!pick) dbg("no dropdown match", f.label, show(wanted), `${all.length} options seen:`, show(all.slice(0, 20)));
        }
      }
      if (!pick) return null;
      click(pick.el);
      await sleep(250);
      picked = true;
      return pick.text;
    } finally {
      // Always close, including the no-match path.
      await ensureClosed(f.ctrl);
      if (picked) await sleep(400); // dependent fields (Country -> State) re-render
    }
  }

  async function readDropdown(f) {
    const list = await openWithOptions(f, f.label.slice(0, 60));
    if (!list) {
      await closeDropdown(f.ctrl);
      return [];
    }
    try {
      return (await allOptions(list)).filter((t) => !/^select one$/i.test(t));
    } finally {
      await closeDropdown(f.ctrl);
    }
  }

  // Search prompt rows that aren't results: the "No Items." placeholder and browse categories
  // ("Partial List (First 500 Entries)", "All"), which carry a chevron side charm.
  const isPlaceholder = (o) => /^no items\.?$/i.test(o.text);
  const isCategory = (o) => !!o.el.closest('[data-uxi-multiselectlistitem-hassidecharm="true"]');
  // The visible popup's rows, tagged, for log lines.
  const popupRows = () => {
    const l = visibleListbox();
    return l ? optsOf(l).map((o) => (isPlaceholder(o) ? "(placeholder) " : isCategory(o) ? "(category) " : "") + o.text) : [];
  };
  const popupSig = () => {
    const l = visibleListbox();
    return l ? optsOf(l).map((o) => o.text).join("|") : "";
  };

  // Results load asynchronously, and until they arrive the popup still shows the previous
  // search's results (or "No Items." / the category view). "No Items." is also what a slow search
  // (School, >2.5s on Lexidos) shows while loading. Poll for a strong match; a list equal to
  // `stale` (pre-Enter) never counts as "no results". `chosen()` catches Workday auto-selecting a
  // single match itself. Gives up after 12s, or 6s of only "No Items.".
  // `slow` (School, Field of Study, skills) gets 12s overall / 6s of "No Items."; other search fields
  // (phone code, how did you hear, ...) answer fast, so 6s / 2s.
  // quitEarly (fast fields only): stop after 2s of a popup that is nothing but browse categories, or
  // 4s with no popup at all. That's a category prompt whose search box doesn't search (NVEXA How
  // Did You Hear); waiting longer never helps. The reason is returned so the caller can browse.
  // settleMs (skills): stop once this search's own results (changed since Enter, non-empty) have stayed
  // the same for settleMs without a strong match: they're the answer, and waiting the full 12 s for a
  // match that isn't coming made 89 skills take 365 s.
  async function waitForResult(wanted, stale, chosen, phrases, slow = true, quitEarly = false, settleMs = 0, rank = null) {
    // Skills (settleMs set) answer quickly: 2 s of an unchanged "No Items." means not found, not
    // "still loading" (School's slow search keeps the 6 s grace).
    const [total, emptyGrace] = slow ? [12000, settleMs ? 2000 : 6000] : [6000, 2000];
    const start = AAF.now();
    let emptySince = null;
    let lastSig = null;
    let sameSince = 0;
    let seen = [];
    let reason = "timeout";
    // For the no-match log: what the popup last showed (all rows, tagged), and whether it changed.
    let popup = { rows: [], changed: false, html: "" };
    while (AAF.now() - start < total) {
      if (chosen()) return { auto: true };
      const l = visibleListbox();
      const opts = l ? optsOf(l) : [];
      const sig = opts.map((o) => o.text).join("|");
      const results = opts.filter((o) => !isPlaceholder(o) && !isCategory(o));
      popup = {
        rows: opts.map((o) => (isPlaceholder(o) ? "(placeholder) " : isCategory(o) ? "(category) " : "") + o.text),
        changed: popup.changed || (!!l && sig !== stale),
        html: l ? l.outerHTML : "",
      };
      // A strong match is the wanted item whichever search produced the list, so take it. With
      // `phrases` (school only), a result containing one of them as a whole phrase also counts;
      // the shortest such result wins (closest to the name itself).
      // With `phrases` (school / language names): the FIRST result in the list's own order that strongly
      // matches the wanted name or contains one of the names as a whole phrase (not alias order).
      const ranked = rank && results.map((o) => ({ o, r: rank(o.text) })).filter((x) => x.r >= 0).sort((a, b) => a.r - b.r)[0];
      const pick = rank
        ? ranked?.o || null
        : phrases
        ? results.find((o) => bestOption([o], wanted, 85) || phrases.some((n) => hasPhrase(o.text, n)))
        : bestOption(results, wanted, 85);
      if (pick) return { pick };
      const elapsed = AAF.now() - start;
      if (quitEarly && !l && elapsed > 4000) {
        reason = "no popup";
        break;
      }
      if (quitEarly && l && opts.length && opts.every(isCategory) && elapsed > 2000) {
        reason = "categories";
        break;
      }
      // A popup showing only "No Items." is empty whether or not it changed since Enter. When the
      // previous search also ended on "No Items.", the popup looked "unchanged", so it never counted
      // and GIMP Retouching waited the full 12 s; every path now uses the same grace.
      const onlyPlaceholder = !!l && opts.length > 0 && opts.every(isPlaceholder);
      if (onlyPlaceholder && sig === stale) {
        if ((emptySince ??= AAF.now()) && AAF.now() - emptySince > emptyGrace) {
          reason = "no items";
          break;
        }
      }
      // Otherwise only a list that changed since Enter counts as this search's answer.
      else if (l && sig && sig !== stale) {
        seen = results.map((o) => o.text);
        if (sig !== lastSig) {
          lastSig = sig;
          sameSince = AAF.now();
        }
        if (settleMs && results.length && AAF.now() - sameSince > settleMs) {
          reason = "results without an exact match";
          break;
        }
        if (results.length) emptySince = null;
        else if ((emptySince ??= AAF.now()) && AAF.now() - emptySince > emptyGrace) {
          reason = "no items";
          break;
        }
      }
      await sleep(150);
    }
    return { pick: null, seen, popup, waited: AAF.now() - start, reason };
  }

  // Checkbox rows: clicking the row and the box would toggle twice. Click exactly one target,
  // never click an already-ticked box, and only fall back to the row if the box didn't take.
  async function clickResult(pick, isOn) {
    if (pick.cb?.checked) return true;
    click(pick.cb || pick.el);
    // Give the first click time to land: a fallback row click after a slow first click toggles it back off.
    if (await waitFor(isOn, 1500)) return true;
    if (pick.cb && !pick.cb.checked && pick.el.isConnected) {
      click(pick.el);
      await waitFor(isOn, 1500);
    }
    return isOn();
  }

  // Last resort for prompts with browse categories (Field of Study): clear the search, open
  // "All", and scroll the (virtualized) list for the value. Capped so huge lists don't stall.
  async function browseAll(f, target, wanted, isOn) {
    await typeInto(target, "", { blur: false });
    await ensureAllClosed();
    click(f.ctrl);
    const all = await waitFor(() => {
      const l = visibleListbox();
      return l && optsOf(l).find((o) => isCategory(o) && /^all$/i.test(o.text));
    }, 2500);
    if (!all) {
      dbg(`browse All for ${f.label}: no "All" category`);
      return false;
    }
    const stale = popupSig();
    click(all.el);
    await waitFor(() => popupSig() !== stale, 3000);
    const l = visibleListbox();
    const pick = l && (await scrollListbox(l, (opts) => bestOption(opts.filter((o) => !isPlaceholder(o) && !isCategory(o)), wanted, 85), 80));
    dbg(`browse All for ${f.label}: ${pick ? "found " + pick.text : "not found"}`);
    return pick ? clickResult(pick, isOn(pick)) : false;
  }

  // Category prompts (NVEXA How Did You Hear): the popup lists browse categories (Associations,
  // Event/Conference, Job Board, Social Media, University, Website), each opening a sub-list, and
  // the search box doesn't search. SAFETY: no back navigation and no document-wide lookups. For each
  // likely category: close the popup completely, reopen the field fresh, open the category, read its
  // options, then pick or close. Any failure closes the popup and returns false (field stays yellow).
  // Returns true / false, or null when the popup isn't a category list (caller keeps searching).
  // Which categories hold a source: tried first, in the fallbacks' order (LinkedIn: Job Board, then Social Media).
  const CATEGORY_HINTS = [
    [/linkedin|indeed|glassdoor|ziprecruiter|monster|dice|simplyhired|careerbuilder|wellfound|angellist/, ["job board", "social media"]],
    [/handshake/, ["university", "job board"]],
    [/facebook|instagram|twitter|\bx\b|tiktok|youtube|reddit|threads/, ["social media"]],
    [/career fair|university|college|campus|professor|school/, ["university", "event conference"]],
    [/conference|event|meetup|hackathon|expo/, ["event conference"]],
    [/company website|careers site|career site|careers page|website/, ["website"]],
  ];
  async function browseCategories(f, alts) {
    const closeAll = async () => {
      key(document.activeElement || f.ctrl, "Escape");
      await ensureAllClosed();
    };
    const atTop = () => {
      const l = visibleListbox();
      const opts = l ? optsOf(l) : [];
      return opts.length && opts.every(isCategory) ? opts : null;
    };
    // Close everything, reopen the field, and expect the top-level category list. Nothing else.
    const openFresh = async () => {
      await closeAll();
      if (visibleListbox()) return null;
      if (!click(f.ctrl)) return null;
      return waitFor(atTop, 3000);
    };
    const top = await openFresh();
    if (!top) {
      dbg(`${f.label}: not a category prompt (no category list on open)`);
      await closeAll();
      return null;
    }
    const cats = top.map((o) => o.text);
    await closeAll();
    // Likely categories only: ones a fallback names ("Social Media"), and ones a fallback is known to
    // live in (LinkedIn: Job Board, Social Media), in fallback order.
    const order = [];
    const add = (c) => c && !order.includes(c) && order.push(c);
    for (const a of alts) {
      add(bestOption(cats.map((text) => ({ text })), a, 85)?.text);
      for (const [rx, names] of CATEGORY_HINTS) if (rx.test(norm(a))) for (const n of names) add(cats.find((c) => norm(c) === n));
    }
    dbg(`${f.label}: category prompt ${show(cats)}; trying ${show(order)}`);
    const selected = () => [...f.c.querySelectorAll('[data-automation-id="selectedItem"]')];
    for (const cat of order) {
      // Fresh means the same top-level categories as the first open; a remembered sub-list whose rows
      // also carry chevrons would otherwise pass for it.
      let rows = await openFresh();
      if (rows && !cats.every((c) => rows.some((o) => o.text === c))) rows = null;
      if (!rows) {
        dbg(`${f.label}: category list didn't reopen fresh, stopping (field left for you); reopened popup rows: ${show(popupRows())}`);
        await closeAll();
        return false;
      }
      const row = rows.find((o) => o.text === cat);
      if (!row) {
        await closeAll();
        continue;
      }
      const stale = popupSig();
      if (!click(row.el)) {
        await closeAll();
        return false;
      }
      // Wait for the sub-list's options to load (NVEXA read [] when it was read right after the click):
      // any row that isn't the "No Items." placeholder or a top-level category name (a header row).
      // Rows with a chevron count too, in case the sub-list's options carry one; if such a row is a
      // nested category, clicking it selects nothing and the attempt ends safely.
      const isOptionRow = (o) => o.text && !isPlaceholder(o) && !cats.includes(o.text);
      const l = await waitFor(() => {
        const lb = visibleListbox();
        return lb && lb.isConnected && popupSig() !== stale && optsOf(lb).some(isOptionRow) ? lb : null;
      }, 6000);
      const texts = new Set();
      if (l) await scrollListbox(l, (opts) => void opts.forEach((o) => isOptionRow(o) && texts.add(o.text)), 40);
      if (texts.size) dbg(`${f.label}: "${cat}" options: ${show([...texts])}`);
      else {
        const lb = visibleListbox();
        dbg(`${f.label}: "${cat}" showed no options after 6 s; popup rows: ${show(popupRows())}`, lb ? lb.outerHTML.slice(0, 3000) : "(no popup)");
      }
      // The first alternative (fallback order) with a strong match in this category wins.
      let hit = null;
      let want = null;
      for (const a of alts) {
        hit = bestOption([...texts].map((text) => ({ text })), a, 85);
        if (hit) {
          want = a;
          break;
        }
      }
      if (!hit) {
        await closeAll();
        continue;
      }
      const before = selected().length;
      const pick = l && (await scrollListbox(l, (opts) => opts.find((o) => o.text === hit.text), 40));
      let ok = false;
      if (pick) {
        const isOn = () => (pick.cb?.isConnected && pick.cb.checked) || selected().length > before || selected().some((e) => norm(e.innerText) === norm(pick.text));
        ok = await clickResult(pick, isOn);
      }
      await closeAll();
      dbg(`${f.label}: ${ok ? "picked" : "couldn't select"} "${hit.text}" in ${cat} (for "${want}")`);
      return ok; // after a click attempt, never try anything else
    }
    dbg(`${f.label}: no matching option in ${show(order)} (field left for you)`);
    await closeAll();
    return false;
  }
  // phrases: school only. Names (primary + aliases) that also count when a result or chip merely
  // contains one as a whole phrase. Everything else (skills, field of study) stays exact/prefix-only.
  // Slow search lists (School, Field of Study, skills) get the long wait; only School / Field of
  // Study have browse categories worth trying.
  const isSlowSearch = (f) => /school|university|institution|field of study|major|skill/.test(f.nl + " " + f.nid);
  // A selected chip equals the wanted value: EXACT after normalization, ignoring a phone code suffix
  // ("United States of America (+1)" counts for "United States of America"). Never prefix/substring.
  const chipBase = (s) => norm(String(s).replace(/\s*\(\+\d+\)\s*$/, ""));
  const chipMatches = (f, wanted) => {
    const wants = new Set(expandWants(wanted).concat(expandWants(wanted).map(chipBase)));
    return [...f.c.querySelectorAll('[data-automation-id="selectedItem"]')].some((e) => wants.has(norm(e.innerText)) || wants.has(chipBase(e.innerText)));
  };

  // report: optional object; on failure gets `reason` ("categories", "no popup", "no items", "timeout").
  // search: the text to type when it differs from the wanted value (a "+" skill searched as "Microsoft
  // Visual Studio"); the result must still match `wanted`. settleMs: see waitForResult (skills).
  // retypeOnEmpty (skills): "No Items." can show briefly while the search is still loading, so a
  // "no items" answer clears the box and retypes the search once; only a second "No Items." is "not found".
  // rank (field of study): text -> step index (0 = best) or -1; the result with the lowest rank is picked,
  // and a chip with a rank counts as chosen.
  async function setMulti(f, wanted, { slow = isSlowSearch(f), browse = isSlowSearch(f) && !/skill/.test(f.nl + " " + f.nid), phrases = null, quitEarly = false, report = null, search = null, settleMs = 0, retypeOnEmpty = false, rank = null } = {}) {
    const input = f.ctrl;
    const selected = () => [...f.c.querySelectorAll('[data-automation-id="selectedItem"]')];
    // A chip is the wanted value only on an EXACT normalized match. Prefix/substring is wrong here:
    // an existing "Tableau" chip must not count as "Tableau Dashboards" being selected.
    const chosen = () => chipMatches(f, wanted) || (!!phrases && selected().some((e) => phrases.some((n) => hasPhrase(e.innerText, n)))) || (!!rank && selected().some((e) => rank(e.innerText) >= 0));
    if (chosen()) return true;
    const before = selected().length;
    // Our click worked if its checkbox is ticked, a chip was added, or the clicked option's text is
    // now a chip (single-select prompts replace the chip, so the count can stay the same). This is
    // about the click, not the wanted value: "LinkedIn Jobs" picked for "LinkedIn" is a success.
    const isOn = (pick) => () =>
      (pick.cb?.isConnected && pick.cb.checked) || selected().length > before || selected().some((e) => norm(e.innerText) === norm(pick.text));
    await ensureAllClosed();
    click(input);
    await sleep(300); // the popup, and its own search box if it has one, renders and may take focus
    const act = document.activeElement;
    const target = act && act !== input && act.tagName === "INPUT" && visible(act) && !isOwnUI(act) ? act : input;
    const text = search || String(wanted).split("|")[0];
    await typeInto(target, text, { blur: false });
    // The search box must hold exactly the text ("C++" once arrived as "C"): fix it with the native
    // setter + input event if the simulated typing lost characters.
    if (target.value !== text) {
      dbg(`"${text}" in ${f.label}: the search box held "${target.value}" after typing, set it directly`);
      AAF.nativeSet(target, text);
    }
    await sleep(300); // let Workday's state catch up before Enter triggers the search
    const stale = popupSig();
    key(target, "Enter");
    const where = target === input ? "field input" : `popup input ${target.getAttribute("data-automation-id") || target.id || ""}`;

    const tw = AAF.now();
    let res = await waitForResult(wanted, stale, chosen, phrases, slow, quitEarly, settleMs, rank);
    if (retypeOnEmpty && !res.pick && !res.auto && res.reason === "no items") {
      dbg(`"${text}" in ${f.label}: "No Items." after ${res.waited} ms; clearing and retyping the search once`);
      await typeInto(target, "", { blur: false });
      await sleep(300);
      await typeInto(target, text, { blur: false });
      if (target.value !== text) AAF.nativeSet(target, text);
      await sleep(300);
      const stale2 = popupSig();
      key(target, "Enter");
      res = await waitForResult(wanted, stale2, chosen, phrases, slow, quitEarly, settleMs, rank);
      dbg(`"${text}" in ${f.label}: retyped search ${res.pick || res.auto ? "found it" : `ended: ${res.reason}`}`);
    }
    const { pick, seen, auto, popup, waited, reason } = res;
    if (report) {
      report.reason = reason;
      // `shown`: real result rows the popup showed (a timeout while it showed results is not transient).
      const shown = (popup?.rows || []).filter((r) => !/^\((placeholder|category)\)/.test(String(r))).length;
      (report.tries ||= []).push({ text, ms: AAF.now() - tw, stop: auto || pick ? "found" : reason, shown, reason: auto ? "selected by Workday" : pick ? `matched "${pick.text}"` : `${reason}, ${(seen || []).length} results` });
    }
    let ok = !!auto;
    if (auto) {
      dbg(`"${text}" in ${f.label}: Workday selected it itself`);
      f.picked = text;
    } else if (pick) {
      ok = await clickResult(pick, isOn(pick));
      if (ok) f.picked = pick.text;
      if (!ok) dbg(`clicked "${pick.text}" in ${f.label} but it didn't register as selected`);
    } else {
      // Say what the popup actually showed (placeholders / categories included) and whether it ever
      // changed after Enter; with no usable rows, include its HTML so the selectors can be checked.
      const shown = popup.rows.length ? show(popup.rows.slice(0, 15)) : "no popup";
      dbg(
        `no match for "${text}" in ${f.label} (typed into ${where}, waited ${waited} ms, ${slow ? "long" : "short"} wait, stopped: ${reason}); results:`,
        show(seen.slice(0, 15)),
        `; popup showed ${shown}${popup.changed ? "" : " (unchanged since Enter)"}`,
        !seen.length && popup.html ? popup.html.slice(0, 3000) : ""
      );
    }
    if (!ok && browse) ok = await browseAll(f, target, wanted, isOn);

    if (!ok) await typeInto(target, "", { blur: false });
    key(document.activeElement || input, "Escape");
    key(input, "Escape");
    input.blur();
    await ensureAllClosed();
    // A late result can still land after we give up; count it only if it's the wanted value.
    if (!ok) ok = !!(await waitFor(chosen, 1000));
    return ok;
  }

  async function setDate(f, d) {
    let did = false;
    for (const [n, raw] of [["Month", d.month], ["Day", d.day], ["Year", d.year]]) {
      const el = f.c.querySelector(`input[data-automation-id="dateSection${n}-input"]`);
      if (!el || raw == null || raw === "") continue;
      const v = n === "Year" ? String(raw) : String(raw).padStart(2, "0");
      click(el);
      await typeInto(el, v);
      did = true;
      await sleep(80);
    }
    return did;
  }

  // The adapter's setField: no logging here (shared AAF.setField logs every call).
  async function setFieldRaw(f, v) {
    if (v == null || v === "") return false;
    // Field of study (`fieldOfStudyValue`): a search prompt is searched term by term and matched as word
    // sets; a text box gets your field; a dropdown goes through the steps below.
    if (v?.fos && f.type === "multi") return setFieldOfStudy(f, v);
    if (Array.isArray(v?.checkAll)) return f.type === "checkgroup" ? AAF.checkAllMatching(f, v.checkAll, v.what, v.match) : false;
    if (Array.isArray(v?.school)) return f.type === "multi" ? setSchool(f, v.school) : setFieldRaw(f, v.school[0]);
    if (v?.fos && (f.type === "text" || f.type === "textarea")) return setFieldRaw(f, v.steps[0][0]);
    // Ordered steps { steps: [[alts], ...], what, exclude } (e.g. Phone Device Type): the same chooser
    // as Degree, over the full option list, first matching step wins; `exclude` options never chosen.
    if (v && typeof v === "object" && Array.isArray(v.steps)) {
      const r = await chooseStep(f, v.steps, v.what || f.label, v.exclude, v.near);
      // The same-city fallback (shared place matching, AAF.inMetro): blue, like the form portals.
      if (r.near) {
        dbg(`${v.what || f.label}: "${r.text}" is the same city as an accepted name, marked blue`);
        mark(f, "review");
      }
      return r.step > 0;
    }
    // Ranked choice { choose(optionTexts) -> text | null, text, what } (willing to travel = highest option).
    if (v && typeof v === "object" && typeof v.choose === "function") {
      if (f.type === "text" || f.type === "textarea") return v.text ? setFieldRaw(f, v.text) : false;
      if (f.type === "checkbox") return setCheckbox(f, true);
      const texts = (await readOptions(f)) || [];
      const pick = v.choose(texts);
      dbg(`${v.what || f.label}: options ${show(texts)} -> ${pick ? `"${pick}"` : "none acceptable"}`);
      if (!pick) return false;
      if (f.type === "dropdown") return (await chooseStep(f, [[pick]], `${v.what || f.label}: selecting`)).step > 0;
      if (f.type === "radio" || f.type === "checkgroup") return setChoice(f, f.type === "radio" ? "radio" : "checkbox", pick);
      return false;
    }
    switch (f.type) {
      case "text":
      case "textarea": {
        const s = String(Array.isArray(v) ? v[0] : v).split("|")[0];
        f.picked = s;
        if (f.ctrl.value === s) return true;
        await typeInto(f.ctrl, s);
        return true;
      }
      case "dropdown":
        return setDropdown(f, v);
      case "multi": {
        // An array here is an ORDERED FALLBACK list ([p.source, "Social Media", "Job Board"]):
        // select the first one that works and stop. Real multi-value lists (skills) go through
        // fillSkills, one setMulti per skill.
        const alts = (Array.isArray(v) ? v : [v]).filter(Boolean);
        // Already selected under any of the alternatives (Workday often pre-fills Country Phone Code
        // from Country): nothing to search. These single-value fields also accept a chip that strongly
        // matches (an earlier "LinkedIn Jobs" pick for "LinkedIn"); only skills need the exact check.
        const chips = [...f.c.querySelectorAll('[data-automation-id="selectedItem"]')].map((e) => ({ text: e.innerText.trim() }));
        const have = alts.find((x) => chipMatches(f, x) || bestOption(chips, x, 85));
        if (have) {
          dbg(`${f.label}: already selected (${have}), skipped`);
          f.picked = have;
          return true;
        }
        // The first search on a field gets the long wait: its results can still be loading ("No Items.")
        // after 2s (NVEXA's How Did You Hear is the first field filled on the page). Later
        // alternatives use the field's normal wait.
        // Fast fields quit early when the popup is only browse categories (or never appears): that's a
        // category prompt, so browse its categories instead (once) and stop searching.
        const quitEarly = !isSlowSearch(f);
        let browsed = false;
        for (const [i, x] of alts.entries()) {
          const report = {};
          if (await setMulti(f, x, { ...(i === 0 ? { slow: true } : {}), quitEarly, report })) return true;
          if (quitEarly && !browsed && (report.reason === "categories" || report.reason === "no popup")) {
            browsed = true;
            const r = await browseCategories(f, alts);
            // false: gave up safely. Flag it so the retry pass doesn't browse again (field stays yellow).
            if (r === false) f.c.dataset.wdafGaveUp = "1";
            if (r !== null) return r; // null: not a category prompt after all, keep searching
          }
        }
        return false;
      }
      case "radio":
        return setChoice(f, "radio", v);
      case "checkgroup":
        return setChoice(f, "checkbox", v);
      case "checkbox":
        return setCheckbox(f, checkboxOn(v));
      case "date":
        return setDate(f, typeof v === "object" && !Array.isArray(v) ? v : parseDate(v));
    }
    return false;
  }

  // Option texts for Claude: dropdowns are scroll-collected; radios / checkbox groups read directly.
  async function readOptions(f) {
    if (f.type === "dropdown") return readDropdown(f);
    if (f.type === "radio") return choiceOptions(f.c, "radio").map((o) => o.text);
    if (f.type === "checkgroup") return choiceOptions(f.c, "checkbox").map((o) => o.text);
    return null;
  }

  // Fields that belong to repeatable sections (filled separately)
  const SECTION_LABEL = /^(job title|company|location|i currently work here|role description|description|from|to|start date|end date|school or university|school|university|degree|field of study|major|overall result( gpa)?|gpa|url|skills|type to add skills|language|i am fluent in this language|.*proficiency|comprehension|overall|reading|speaking|writing|written and spoken|spoken and written|fluency|proficiency level|level|certification|issued date|expiration date)$/;
  function isSectionField(f) {
    if (SECTION_LABEL.test(f.nl)) return true;
    return !!f.c.closest('[data-automation-id*="workExperience"],[data-automation-id*="education"],[data-automation-id*="websites"],[data-automation-id*="language"],[data-automation-id*="certification"],[data-automation-id*="skills"],[data-wdaf-lang]');
  }

  // ------------------------------------------------- repeatable sections
  const ADD_BTN = (b) => /^add( another)?$/i.test(b.innerText.trim()) || b.getAttribute("data-automation-id") === "add-button";

  function findSection(rx) {
    const heads = [...document.querySelectorAll("h2,h3,h4,h5,legend,[role='heading']")].filter((h) => {
      const t = norm(h.innerText);
      return visible(h) && rx.test(t) && t.length < 40 && !/\d$/.test(t);
    });
    for (const h of heads) {
      let el = h.parentElement;
      for (let i = 0; el && i < 8; i++, el = el.parentElement) {
        if ([...el.querySelectorAll("button")].some(ADD_BTN)) return el;
      }
    }
    return null;
  }

  // The Websites section, also when a tenant renames it (Fortuna: "LinkedIn Profile", "Add any relevant
  // websites. Please share your LinkedIn/ professional portfolio.", with a "LinkedIn Profile 1 > URL"
  // panel and "Add Another"): by heading first, else by its URL field: the nearest ancestor of a URL
  // field (label "URL", or a url / website automation id) that holds an Add button and no other kind
  // of field. Returns the section element, with `how` set for the log.
  // ---- Repeatable sections, found by STRUCTURE, never by heading text alone. Tenants rename them:
  // Fortuna's Websites is "LinkedIn Profile", DataPilot's Work Experience is "Professional
  // Experience", and a heading lookup filled and logged nothing. Every visible Add / Add Another
  // button marks a section: its smallest ancestor that holds fields or a heading, without reaching a
  // second Add button. Each section is classified by, in order:
  //   1. an automation id on it or just above it (workExperience, education, websites, language,
  //      certification);
  //   2. its fields: Job Title + Company = work experience; School = education; only URL fields =
  //      websites; Language = languages; Certification / License = certifications;
  //   3. its heading, as a fallback (a section with no panels yet has no fields to look at).
  // Unclassified sections are logged ("unrecognized section: ..."), never silently skipped.
  const SECTION_KINDS = [
    { kind: "work experience", id: /workexperience|employment/, head: /experience|employment|work history/,
      fields: (has) => has(/job title|jobtitle|position title/) && has(/^company|companyname|employer/) },
    { kind: "education", id: /education/, head: /education|academic/, fields: (has) => has(/school|university|institution/) },
    { kind: "websites", id: /website/, head: /^(websites?|links?|social|portfolio|linkedin)/,
      fields: (has, fs) => fs.length > 0 && fs.every((f) => /^url$/.test(f.nl) || /\b(url|website|websites)\b/.test(f.nid)) },
    { kind: "languages", id: /language/, head: /^(?!.*programming).*\blanguages?\b/, fields: (has) => has(/^language( name)?$/) },
    { kind: "certifications", id: /certification|license/, head: /certification|licen[cs]e/, fields: (has) => has(/certification|licen[cs]e/) },
  ];
  const HEADINGS = "h2,h3,h4,h5,legend,[role='heading']";
  // The section's own heading: the first one inside that isn't a panel title ("Professional Experience
  // 1"), else the nearest heading before it.
  function headingOf(sec) {
    const inside = [...sec.querySelectorAll(HEADINGS)].map((h) => h.innerText.trim()).find((t) => t && !/\d$/.test(t));
    if (inside) return inside;
    let last = "";
    for (const h of document.querySelectorAll(HEADINGS)) {
      if (h.compareDocumentPosition(sec) & Node.DOCUMENT_POSITION_FOLLOWING) last = h.innerText.trim() || last;
      else break;
    }
    return last;
  }
  function detectSections() {
    const out = [];
    const btns = [...document.querySelectorAll("button")].filter((b) => ADD_BTN(b) && visible(b) && !isOwnUI(b));
    for (const b of btns) {
      let sec = null;
      for (let el = b.parentElement, i = 0; el && el !== document.body && i < 10; i++, el = el.parentElement) {
        if ([...el.querySelectorAll("button")].filter(ADD_BTN).length > 1) break;
        if (fieldContainers(el).length || el.querySelector(HEADINGS)) {
          sec = el;
          break;
        }
      }
      if (!sec || out.some((o) => o.el === sec)) continue;
      const fs = fieldContainers(sec).map(describe).filter((f) => f.type);
      const has = (rx) => fs.some((f) => rx.test(f.nl) || rx.test(f.nid));
      const ids = [sec, sec.parentElement, sec.parentElement?.parentElement].map((e) => e?.getAttribute?.("data-automation-id") || "").join(" ").toLowerCase();
      const head = headingOf(sec);
      let hit = null;
      let how = "";
      if ((hit = SECTION_KINDS.find((k) => ids && k.id.test(ids)))) how = "automation id";
      else if ((hit = SECTION_KINDS.find((k) => fs.length && k.fields(has, fs)))) how = "fields";
      else if ((hit = SECTION_KINDS.find((k) => head && k.head.test(norm(head))))) how = "heading";
      out.push({ el: sec, kind: hit?.kind || null, how, head, labels: fs.map((f) => f.label).slice(0, 6) });
    }
    return out;
  }
  const sectionOf = (kind) => detectSections().find((s) => s.kind === kind)?.el || null;
  // One line per repeatable section, per fill.
  function logSections() {
    for (const s of detectSections()) {
      if (s.kind) dbg(`${s.kind}: detected by ${s.how}${s.head ? `, heading "${s.head.slice(0, 50)}"` : ""}`);
      else dbg(`unrecognized section: "${s.head.slice(0, 60) || "(no heading)"}"${s.labels.length ? ` (fields: ${show(s.labels)})` : ""}; not filled`);
    }
  }
  const websitesSection = () => sectionOf("websites");

  function panelFor(c, all, sec) {
    let el = c;
    while (el.parentElement && el.parentElement !== sec && !all.some((o) => o !== c && el.parentElement.contains(o))) {
      el = el.parentElement;
    }
    return el;
  }

  // Returns { filled, needs }. A mapped field that can't be set is left as is and marked yellow.
  // onlyEmpty: fill only panels whose anchor field is empty (adding panels as needed) and never
  // touch filled ones. Without it, entry i goes into panel i (work experience / education).
  // sectionRx: a heading regex, or a function returning the section (websites).
  async function fillRepeatable(sectionRx, anchorRx, entries, mapFn, { onlyEmpty = false } = {}) {
    const res = { filled: 0, needs: 0, review: 0 };
    if (!entries?.length) return res;
    const findSec = typeof sectionRx === "function" ? sectionRx : () => findSection(sectionRx);
    let sec = findSec();
    if (!sec) return res;
    const anchors = () => fieldContainers(sec).map(describe).filter((f) => anchorRx.test(f.nl));
    const slots = () => (onlyEmpty ? anchors().filter((a) => !isFilled(a)) : anchors());
    for (let tries = 0; slots().length < entries.length && tries < entries.length + 2; tries++) {
      const btn = [...sec.querySelectorAll("button")].filter(ADD_BTN).pop();
      if (!btn) break;
      const n = anchors().length;
      click(btn);
      await waitFor(() => anchors().length > n, 3000);
      sec = findSec() || sec;
    }
    const as = anchors();
    const targets = slots();
    for (let i = 0; i < Math.min(targets.length, entries.length); i++) {
      const panel = panelFor(targets[i].c, as.map((x) => x.c), sec);
      for (const f of fieldContainers(panel).map(describe)) {
        const v = mapFn(f, entries[i]);
        if (v === undefined) continue;
        // mapFn may return a special: { school: [names] } or { degreeSteps: [[alts], ...] }.
        let ok;
        if (v?.school) ok = await timed(`school: ${f.label}`, () => setSchool(f, v.school));
        else if (v?.degreeSteps) {
          const step = await timed(`degree: ${f.label}`, () => setDegree(f, v.degreeSteps));
          ok = step > 0;
          // Steps 3+ are substitutes for the real degree: fill, but ask for a double-check.
          if (step >= 3) {
            mark(f, "review");
            res.review++;
          }
        } else ok = await setField(f, v);
        if (ok && !f.keptOnly) AAF.countFill(f);
        // A search field that failed is flagged even if it holds a chip: the chip isn't the wanted value.
        else if (v !== "" && v != null && (f.type === "multi" || !isFilled(f))) {
          mark(f, "needs");
          res.needs++;
        }
      }
    }
    return res;
  }

  const workMap = (f, x) => {
    const L = f.nl;
    if (/job title/.test(L)) return x.title;
    if (/^company/.test(L)) return x.company;
    if (/^location/.test(L)) return x.location;
    if (/currently work/.test(L)) return !!x.current;
    if (/^from|start date/.test(L)) return { month: x.startMonth, year: x.startYear };
    if (/^to\b|end date/.test(L)) return x.current ? undefined : { month: x.endMonth, year: x.endYear };
    if (/description/.test(L)) return x.description;
    return undefined;
  };

  const eduMap = (f, x) => {
    const L = f.nl;
    if (/school|university|institution/.test(L)) {
      if (!x.school) return undefined;
      // Aliases: "|"-separated, or ","-separated when there's no "|" at all.
      const aliases = /\|/.test(x.schoolAliases || "") ? splitAlts(x.schoolAliases) : String(x.schoolAliases || "").split(",").map((t) => t.trim()).filter(Boolean);
      return { school: [x.school, ...aliases.filter((a) => norm(a) !== norm(x.school))] };
    }
    if (/^degree/.test(L)) {
      // One step per line, alternatives separated by "|". Old profiles only have a single `degree`.
      const steps = String(x.degreeOptions || x.degree || "").split("\n").map(splitAlts).filter((s) => s.length);
      return steps.length ? { degreeSteps: steps } : undefined;
    }
    if (/field of study|major/.test(L)) return AAF.fieldOfStudyValue(x);
    if (/gpa|overall result/.test(L)) return x.gpa;
    if (/^from|start/.test(L)) return { year: x.startYear };
    if (/^to\b|end|expected/.test(L)) return { year: x.endYear };
    return undefined;
  };

  // Field of study on a search prompt: each search term in turn ("Computer Engineering", "Computer",
  // "Engineering"); a result matching a step as a word set is picked (the earliest step among the
  // results). A fallback (step 2+) is marked blue. Logged which step matched.
  async function setFieldOfStudy(f, v) {
    const rank = (t) => v.steps.findIndex((alts) => !!matchAlts([t], alts));
    const chips = [...f.c.querySelectorAll('[data-automation-id="selectedItem"]')].map((e) => e.innerText.trim());
    const have = chips.find((t) => rank(t) >= 0);
    if (have) {
      dbg(`${v.what}: kept prefilled "${have}" (step ${rank(have) + 1}; chips aren't replaced)`);
      f.picked = have;
      f.keptOnly = true;
      return true;
    }
    for (const term of v.searches) {
      if (await setMulti(f, v.steps[0][0], { search: term, rank, settleMs: 2000 })) {
        const got = [...f.c.querySelectorAll('[data-automation-id="selectedItem"]')].map((e) => e.innerText.trim()).find((t) => rank(t) >= 0) || f.picked || "";
        const step = rank(got) + 1;
        dbg(`${v.what}: step ${step || "?"} (${step ? v.steps[step - 1].join(" | ") : "?"}) matched "${got}" (searched "${term}")`);
        if (step > 1) mark(f, "review");
        return true;
      }
    }
    dbg(`${v.what}: no step matched (searched ${show(v.searches)})`);
    return false;
  }

  // Work Experience / Education after a resume parse: panels are matched to profile entries by SCORE, never by
  // position (Workday's own "Autofill with Resume" creates panels in its own order, and filling by position
  // overwrote them field by field with other jobs). Mototron: the parse made 7 junk panels (empty companies,
  // "Contoso Remote" as a job title, a resume project as a company, "Bright Path AI at Bayfront Tech Remote");
  // matching by company alone missed the ones without a company, left the junk and added 3 more panels.
  //   - Every existing panel is scored against every entry first (`signals`: work = title, company, location, start
  //     date; education = school), each signal strong (2) or weak (1); `isMatch` says when a pair is the same entry
  //     (work: two strong signals, or title and company both at least weak); the best pairs are taken first. A panel
  //     with your title and start date but no company is that entry (its company is filled). Logged
  //     `<what>: "<company / title>" panel matches your entry N (title strong, dates strong)`.
  //   - A matched panel: fields that agree are kept; keep-if-matching is strict here (the same text, or for a company
  //     the same name with nothing extra, `exactCompany`); differing ones are replaced (blue, logged
  //     `replaced "old" with "new"`); empty ones are filled. A search field (field of study) holding a different chip
  //     is left yellow (chips aren't removed).
  //   - Panels matching no entry: resume-parse junk (`junkWhy`: a required field empty, a title / company that is
  //     really an entry's location or "<company> <location>", a project from your resume) is deleted with the
  //     panel's own Delete button (Options "Clean up resume-parsed work / education panels", default on), logged
  //     `deleted resume-parse panel: "..." (...)`; anything else (a real job not in your profile) is left as is,
  //     outlined yellow.
  //   - Only then do entries with no panel get one: an empty panel first, else Add. So no entry is added twice.
  async function fillByName(sectionRx, anchorRx, entries, mapFn, { what, nameRx, subRx, signals, isMatch, required = [], p = {} }) {
    const res = { filled: 0, needs: 0, review: 0 };
    if (!entries?.length) return res;
    const findSec = typeof sectionRx === "function" ? sectionRx : () => findSection(sectionRx);
    let sec = findSec();
    if (!sec) return res;
    // A panel is identified by its anchor field (Job Title / School), never by the panel element: with
    // one panel on the page, panelFor() climbs to the whole list, so the element changes after Add.
    const anchors = () => fieldContainers(sec).map(describe).filter((f) => anchorRx.test(f.nl)).map((f) => f.c);
    const panelEl = (a) => panelFor(a, anchors(), sec);
    const fieldsOf = (a) => fieldContainers(panelEl(a)).map(describe).filter((f) => f.type);
    const fieldIn = (a, rx) => fieldsOf(a).find((x) => rx.test(x.nl));
    const valueOf = (a, rx) => {
      const f = fieldIn(a, rx);
      return f && isFilled(f) ? currentValue(f) : "";
    };
    const infoOf = (a) => ({ a, name: valueOf(a, nameRx), sub: subRx ? valueOf(a, subRx) : "", empty: fieldsOf(a).every((f) => !isFilled(f)) });
    const nameOf = (o) => `${o.name || "(no name)"}${o.sub ? " / " + o.sub : ""}`;
    const scoreOf = (o, x) => {
      const by = {};
      for (const s of signals) {
        const f = fieldIn(o.a, s.rx);
        if (!f) continue;
        const n = s.date ? s.same(f, x) : isFilled(f) ? s.same(currentValue(f), x) : 0;
        if (n) by[s.what] = n;
      }
      const strong = Object.values(by).filter((n) => n >= 2).length;
      return { by, strong, total: Object.values(by).reduce((a, b) => a + b, 0) };
    };
    const why = (sc) => Object.entries(sc.by).map(([k, n]) => `${k} ${n >= 2 ? "strong" : "weak"}`).join(", ");
    let info = anchors().map(infoOf);
    const panelOf = new Map(); // entry index -> info
    const used = new Set();
    const pairs = [];
    for (const o of info) {
      if (o.empty) continue;
      for (const [i, x] of entries.entries()) {
        const sc = scoreOf(o, x);
        if (isMatch(sc)) pairs.push({ o, i, sc });
      }
    }
    pairs.sort((a, b) => b.sc.strong - a.sc.strong || b.sc.total - a.sc.total || a.i - b.i);
    for (const { o, i, sc } of pairs) {
      if (panelOf.has(i) || used.has(o)) continue;
      panelOf.set(i, o);
      used.add(o);
      dbg(`${what}: "${nameOf(o)}" panel matches your entry ${i + 1} (${why(sc)})`);
    }
    const fillPanel = async (i, o) => {
      const x = entries[i];
      for (const f of fieldContainers(panelEl(o.a)).map(describe)) {
        const v = mapFn(f, x);
        if (v === undefined) continue;
        // Dates count as holding a value once any box has digits (isFilled wants every box).
        const before = f.type === "date" ? (/\d/.test(currentValue(f)) ? currentValue(f) : "") : isFilled(f) ? currentValue(f) : "";
        if (before && f.type === "date") {
          if (dateMatches(f, v) === true) {
            dbg(`${what} ${i + 1}: ${f.label}: kept "${before}" (matches your profile)`);
            AAF.countKept(f);
            continue;
          }
        } else if (before && f.type !== "checkbox") {
          // Strict: the same text, or the same company with nothing extra (never containment).
          const same = typeof v === "string" ? norm(before) === norm(v) || (/^company/.test(f.nl) && AAF.exactCompany(before, v)) : AAF.matchesValue(before, v, f);
          if (same === true) {
            dbg(`${what} ${i + 1}: ${f.label}: kept "${before}" (matches your profile)`);
            AAF.countKept(f);
            continue;
          }
          if (f.type === "multi" && !v?.school) {
            dbg(`${what} ${i + 1}: ${f.label} holds "${before}", your profile says ${show(v)}; left for you (chips aren't removed)`);
            mark(f, "needs");
            res.needs++;
            continue;
          }
        }
        let ok;
        if (v?.school) ok = await timed(`school: ${f.label}`, () => setSchool(f, v.school));
        else if (v?.degreeSteps) {
          const step = await timed(`degree: ${f.label}`, () => setDegree(f, v.degreeSteps));
          ok = step > 0;
          if (step >= 3) {
            mark(f, "review");
            res.review++;
          }
        } else ok = await setField(f, v);
        if (ok && !f.keptOnly) AAF.countFill(f);
        else if (v !== "" && v != null && (f.type === "multi" || !isFilled(f))) {
          mark(f, "needs");
          res.needs++;
        }
        const after = f.type === "date" || isFilled(f) ? currentValue(f) : "";
        if (ok && before && after && norm(after) !== norm(before)) {
          dbg(`${what} ${i + 1}: ${f.label}: replaced "${before}" with "${after}"`);
          mark(f, "review");
          res.review++;
        }
      }
    };
    for (const [i, o] of [...panelOf].sort((a, b) => a[0] - b[0])) await fillPanel(i, o);
    // Panels that match no entry: parse junk is deleted (its own Delete button), the rest left yellow.
    const clean = AAF.state?.settings?.cleanParsedPanels !== false;
    for (const o of info) {
      if (used.has(o) || o.empty) continue;
      const junk = junkWhy(o, { fieldIn, valueOf, required, entries, p });
      if (junk && clean) {
        const panel = panelEl(o.a);
        const del = [...panel.querySelectorAll("button")].find((b) => /^(delete|remove)\b/i.test((b.innerText || b.getAttribute("aria-label") || "").trim()) || /delete/i.test(b.getAttribute("data-automation-id") || ""));
        if (del) {
          const n = anchors().length;
          click(del);
          if (await waitFor(() => !o.a.isConnected || anchors().length < n, 3000)) {
            dbg(`${what}: deleted resume-parse panel: "${nameOf(o)}" (${junk})`);
            sec = findSec() || sec;
            continue;
          }
          dbg(`${what}: clicked Delete on the "${nameOf(o)}" panel (${junk}), but it's still there; left for you`);
        } else dbg(`${what}: the "${nameOf(o)}" panel looks like resume-parse junk (${junk}), but it has no Delete button; left for you`);
      } else if (junk) dbg(`${what}: the "${nameOf(o)}" panel looks like resume-parse junk (${junk}); cleanup is off in Options, left for you`);
      else dbg(`${what}: the "${nameOf(o)}" panel matches none of your entries; left as is for you to review or delete`);
      mark({ c: panelEl(o.a) }, "needs");
      res.needs++;
    }
    // Entries without a panel, only now: an empty panel, else Add.
    info = anchors().map(infoOf).map((o) => [...used].find((u) => u.a === o.a) || o);
    for (const [i] of entries.entries()) {
      if (panelOf.has(i)) continue;
      let o = info.find((o) => !used.has(o) && o.empty);
      if (!o) {
        const btn = [...sec.querySelectorAll("button")].filter(ADD_BTN).pop();
        if (!btn) break;
        const known = new Set(info.map((x) => x.a));
        click(btn);
        await waitFor(() => anchors().some((a) => !known.has(a)), 3000);
        sec = findSec() || sec;
        const fresh = anchors().filter((a) => !known.has(a)).map(infoOf);
        info = [...info, ...fresh];
        o = fresh[0];
        if (!o) break;
      }
      panelOf.set(i, o);
      used.add(o);
      await fillPanel(i, o);
    }
    return res;
  }
  // Why an unmatched panel is resume-parse junk ("" = it isn't): a required field empty, a title / company that is
  // really one of your entries' locations, or "<an entry's company or title> <location / Remote>" ("Contoso Remote"),
  // or a project from your resume / Options "Projects to highlight" ("Microcontroller-Based Clock ...").
  function junkWhy(o, { fieldIn, valueOf, required, entries, p }) {
    for (const rx of required) {
      const f = fieldIn(o.a, rx);
      if (f && !isFilled(f)) return `${f.label} is empty`;
    }
    const names = new Set(entries.flatMap((x) => [x.company, x.title, x.school]).filter(Boolean).map(norm));
    const locs = [...new Set(entries.map((x) => x.location).filter(Boolean).map(norm)), "remote", "hybrid", "on site", "onsite"];
    const projects = projectNames(p);
    for (const rx of required) {
      const t = norm(valueOf(o.a, rx));
      if (!t || names.has(t)) continue;
      if (locs.includes(t)) return `"${valueOf(o.a, rx)}" is a location`;
      const loc = locs.find((l) => t.endsWith(" " + l) && names.has(t.slice(0, -l.length - 1)));
      if (loc) return `"${valueOf(o.a, rx)}" is one of your entries plus "${loc}"`;
      const pr = projects.find((n) => t.startsWith(n) || (t.length >= 8 && n.startsWith(t)));
      if (pr) return `"${valueOf(o.a, rx)}" is a project from your resume`;
    }
    return "";
  }
  // Project names: Options "Projects to highlight" ("Name: what it shows best"), and the lines of the resume
  // text's Projects section (the part before " | ", " - ", ":" or "(").
  function projectNames(p) {
    const out = String(p.projectsHighlight || "").split("\n").map((l) => l.split(":")[0]);
    const lines = String(p.resumeText || "").split("\n");
    let inProjects = false;
    for (const l of lines) {
      const t = l.trim();
      if (!t) continue;
      if (/^(personal |academic |selected |technical )?projects?\b:?$/i.test(t)) { inProjects = true; continue; }
      if (inProjects && /^[A-Z][A-Z &/]{3,}:?$/.test(t)) inProjects = false; // the next heading (EXPERIENCE, SKILLS)
      if (inProjects) out.push(t.split(/\s+[|–—-]\s+|:|\(/)[0]);
    }
    return [...new Set(out.map(norm).filter((n) => n.split(" ").length >= 2 && n.length >= 8))];
  }
  const sameTitle = (a, x) => !!a && !!x.title && (norm(a) === norm(x.title) || hasPhrase(a, x.title) || hasPhrase(x.title, a));
  const schoolNames = (x) => [x.school, ...(/\|/.test(x.schoolAliases || "") ? splitAlts(x.schoolAliases) : String(x.schoolAliases || "").split(",").map((t) => t.trim()))].filter(Boolean);
  const sameSchool = (name, x) => schoolNames(x).some((n) => norm(n) === norm(name) || hasPhrase(name, n) || hasPhrase(n, name));

  // Tries each step against the FULL option list (scroll-collected, since listboxes are virtualized)
  // and picks the first that matches. Non-dropdowns get each alternative typed/searched in turn.
  // Returns { step (1-based, 0 = none), text }. `what` labels the log lines.
  // exclude: a regex (on normalized option text) for options that must never be chosen.
  async function chooseStep(f, steps, what, exclude = null, near = "") {
    const r = await chooseStepOnce(f, steps, what, exclude, near);
    if (f.type !== "dropdown" || !r.step) return r;
    return (await confirmPick(f, r.text, what)) ? r : { step: 0 };
  }
  async function chooseStepOnce(f, steps, what, exclude = null, near = "") {
    if (f.type !== "dropdown") {
      for (const [i, alts] of steps.entries()) for (const a of alts) if (await setField(f, a)) return { step: i + 1, text: a };
      return { step: 0 };
    }
    const list = await openWithOptions(f, what);
    if (!list) {
      await ensureClosed(f.ctrl);
      return { step: 0 };
    }
    try {
      const all = (await allOptions(list)).filter((t) => !/^select one$/i.test(t) && !(exclude && exclude.test(norm(t))));
      for (const [i, alts] of steps.entries()) {
        const text = matchAlts(all, alts);
        if (!text) continue;
        const pick = await scrollListbox(list, (opts) => opts.find((o) => o.text === text));
        if (!pick) continue;
        click(pick.el);
        await sleep(250);
        dbg(`${what}: step ${i + 1} (${alts.join(" | ")}) matched "${text}"`);
        f.picked = text;
        return { step: i + 1, text };
      }
      // No step matched: an option for the same city as an accepted name ("New York (Manhattan)" for "New York, NY").
      const close = near && all.find((t) => AAF.inMetro(t, near));
      const pick = close && (await scrollListbox(list, (opts) => opts.find((o) => o.text === close)));
      if (pick) {
        click(pick.el);
        await sleep(250);
        dbg(`${what}: step ${steps.length + 1} (same city as an accepted name) matched "${close}"`);
        f.picked = close;
        return { step: steps.length + 1, text: close, near: true };
      }
      dbg(`${what}: no step matched; options were:`, show(all));
      return { step: 0 };
    } finally {
      await ensureClosed(f.ctrl);
    }
  }

  // Degree: steps 3+ are substitutes (the caller marks them blue). Returns the step, or 0.
  async function setDegree(f, steps) {
    const { step } = await chooseStep(f, steps, "degree");
    if (step >= 3) dbg("degree: substitute, marked blue");
    return step;
  }

  // Name fields (school, language): try the names in order. Search boxes accept a result or chip
  // that contains any of the names as a whole phrase ("LSU Lakeview University"); dropdowns use
  // the scroll-collected option list.
  async function setByNames(f, names, what) {
    if (f.type === "dropdown") return (await chooseStep(f, names.map((n) => [n]), what)).step > 0;
    if (f.type !== "multi") return setField(f, names[0]);
    for (const n of names) {
      if (await setMulti(f, n, { phrases: names, browse: false })) {
        dbg(`${what}: matched via "${n}"`);
        return true;
      }
    }
    dbg(`${what}: none of ${JSON.stringify(names)} matched`);
    return false;
  }
  const setSchool = (f, names) => setByNames(f, names, "school");

  // Languages: one panel per profile language. Unlike fillRepeatable, existing panels are never
  // overwritten: a language already listed (exact normalized match on its name or an alias) is
  // skipped, empty panels are reused, and the Add button supplies the rest.
  const PROFICIENCIES = ["comprehension", "overall", "reading", "speaking", "writing"];
  // A single combined proficiency (BoFL: "Written and Spoken" with Basic / Fluent / Intermediate).
  const GENERAL_PROFICIENCY = /written and spoken|spoken and written|proficiency|\blevel\b|fluency/;
  const proficiencyKind = (nl) => PROFICIENCIES.find((k) => nl.includes(k)) || (GENERAL_PROFICIENCY.test(nl) ? "general" : null);
  async function fillLanguages(p, stats) {
    let sec = sectionOf("languages");
    if (!sec) return;
    // Tag the section so the main pass never treats its fields as application questions (BoFL's
    // unmatched "Written and Spoken" was sent to Claude). Language fields are only filled here.
    const tag = () => {
      // Never tag a container that also holds other sections (that would hide their fields).
      const others = [...sec.querySelectorAll("h2,h3,h4,h5,[role='heading']")].some((h) => /work experience|education|skills|websites/.test(norm(h.innerText)));
      if (!others) sec.dataset.wdafLang = "1";
    };
    tag();
    const langs = (p.languages || []).filter((l) => l.name);
    if (!langs.length) return;
    const namesOf = (l) => [l.name, ...splitAlts(l.aliases)].filter((n, i, a) => a.findIndex((m) => norm(m) === norm(n)) === i);
    const isLangField = (f) => /^language( name)?$/.test(f.nl);
    const anchors = () => fieldContainers(sec).map(describe).filter(isLangField);
    const valuesOf = (f) =>
      f.type === "dropdown" ? [f.ctrl.innerText]
      : f.type === "multi" ? [...f.c.querySelectorAll('[data-automation-id="selectedItem"]')].map((e) => e.innerText)
      : [f.ctrl?.value || ""];
    const listed = anchors().flatMap(valuesOf).map(norm).filter(Boolean);
    const todo = langs.filter((l) => {
      const already = namesOf(l).some((n) => listed.includes(norm(n)));
      if (already) dbg(`language: ${l.name} already listed, skipped`);
      return !already;
    });
    if (!todo.length) return;

    const empty = () => anchors().filter((a) => !isFilled(a));
    for (let tries = 0; empty().length < todo.length && tries < todo.length + 2; tries++) {
      const btn = [...sec.querySelectorAll("button")].filter(ADD_BTN).pop();
      if (!btn) break;
      const n = anchors().length;
      click(btn);
      await waitFor(() => anchors().length > n, 3000);
      sec = sectionOf("languages") || sec;
      tag();
    }
    const slots = empty();
    for (let i = 0; i < Math.min(slots.length, todo.length); i++) {
      const l = todo[i];
      const panel = panelFor(slots[i].c, anchors().map((x) => x.c), sec);
      for (const f of fieldContainers(panel).map(describe)) {
        let ok;
        let review = false;
        if (isLangField(f)) ok = await timed(`language ${l.name}: name`, () => setByNames(f, namesOf(l), `language ${l.name}`));
        else if (f.type === "checkbox" && /fluent/.test(f.nl)) ok = await setCheckbox(f, !!l.fluent);
        else if (f.type === "dropdown") {
          // Any other dropdown here is a proficiency. Unknown ones are left for the user.
          const kind = proficiencyKind(f.nl);
          const levels = kind ? splitAlts(l[kind]) : [];
          if (!levels.length) {
            dbg(`language ${l.name}: ${kind ? "no levels set for" : "unknown proficiency field"} "${f.label}", left for you`);
            ok = false;
          } else {
            // Each level is its own step: the first one (in profile order) the dropdown offers wins.
            const { step } = await timed(`language ${l.name}: ${kind}`, () => chooseStep(f, levels.map((x) => [x]), `language ${l.name} ${kind}`));
            ok = step > 0;
            review = ok && !!l[kind + "Review"];
          }
        } else continue;
        if (ok) {
          AAF.countFill(f);
          if (review) {
            mark(f, "review");
            stats.review++;
          }
        } else {
          mark(f, "needs");
          stats.needs++;
        }
      }
    }
  }

  // Websites: LinkedIn is normally left out because many tenants have a dedicated LinkedIn field
  // (filled by profileValue). It goes into Websites only when this application has no such field,
  // neither on this page nor on one filled earlier this run (remembered per tenant in sessionStorage,
  // which survives Workday's page steps and reloads in the same tab). URLs already in a Websites
  // panel are skipped. Order: LinkedIn, GitHub, other website.
  const LINKEDIN_KEY = "wdaf-linkedin-field:" + location.hostname;
  const urlKey = (u) => String(u || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "");
  function websiteEntries(p) {
    const sec = websitesSection();
    if (!sec) return [];
    // A section that itself asks for LinkedIn ("LinkedIn Profile", "Please share your LinkedIn") always
    // gets it, first, even when a LinkedIn field was seen elsewhere.
    const asksLinkedIn = /linkedin/.test(norm((sec.innerText || "").slice(0, 400)));
    const here = fieldContainers()
      .map(describe)
      .some((f) => f.type && /linkedin/.test(f.nl + " " + f.nid) && !sec.contains(f.c));
    let before = false;
    try {
      if (here) sessionStorage.setItem(LINKEDIN_KEY, "1");
      before = sessionStorage.getItem(LINKEDIN_KEY) === "1";
    } catch {}
    const linkedinField = (here || before) && !asksLinkedIn;
    const present = fieldContainers(sec)
      .map(describe)
      .filter((f) => /^url$/.test(f.nl) && f.ctrl?.value)
      .map((f) => urlKey(f.ctrl.value));
    const wanted = [linkedinField ? null : p.linkedin, p.github, p.website].filter(Boolean);
    const urls = wanted.filter((u, i) => wanted.findIndex((x) => urlKey(x) === urlKey(u)) === i && !present.includes(urlKey(u)));
    const skipped = wanted.filter((u) => present.includes(urlKey(u)));
    const why = !p.linkedin
      ? "no LinkedIn in profile"
      : asksLinkedIn
        ? "LinkedIn included: the section asks for it"
        : linkedinField
        ? `LinkedIn left out: dedicated LinkedIn field ${here ? "on this page" : "seen earlier in this application"}`
        : "LinkedIn included: no LinkedIn field on this application";
    dbg(`websites: ${why}; adding ${show(urls)}${skipped.length ? "; already present: " + show(skipped) : ""}`);
    return urls.map((url) => ({ url }));
  }
  // Called on every fill, so a LinkedIn field on an earlier page (My Information) is remembered
  // when Websites appears later (My Experience).
  function noteLinkedInField() {
    const sec = websitesSection();
    const seen = fieldContainers().map(describe).some((f) => f.type && /linkedin/.test(f.nl + " " + f.nid) && !sec?.contains(f.c));
    if (seen) {
      try {
        sessionStorage.setItem(LINKEDIN_KEY, "1");
      } catch {}
    }
  }

  // Skills are comma-separated; each skill may list aliases separated by "|", tried in order
  // ("C++ Programming Language | C++ | C++ (Programming Language)"): the first that gets selected wins.
  // Each alias is still matched exact/prefix-only, like any skill.
  async function fillSkills(p) {
    const skills = (p.skills || "").split(",").map(splitAlts).filter((s) => s.length);
    if (!skills.length) return 0;
    const find = () => fieldContainers().map(describe).find((x) => x.type === "multi" && /skill/.test(x.nl + " " + x.nid));
    if (!find()) return 0; // no skills field on this step
    // Skills this site's list doesn't have, remembered per Workday tenant ("ex.wd5") for 7 days
    // (chrome.storage `skillMisses`, shown in Options with a Clear button): skipped with one log line.
    const tenant = location.hostname.replace(/\.myworkday(jobs|site)?\.com$/i, "");
    const site = tenant || "this site";
    const DAYS7 = 7 * 864e5;
    let misses = {};
    try {
      ({ skillMisses: misses = {} } = await chrome.storage.local.get("skillMisses"));
    } catch {}
    const known = misses[tenant] || {};
    const skipped = skills.filter((alts) => Date.now() - (known[norm(alts[0])]?.at || 0) < DAYS7);
    if (skipped.length) dbg(`skills: skipped ${skipped.length}, not in this site's list (not found on ${site} in the last 7 days; Options can clear it): ${skipped.map((a) => a[0]).join(", ")}`);
    let n = 0;
    const missed = [];
    const times = [];
    const tAll = AAF.now();
    // One skill: its names / aliases in order, then the "+" fallback searches. Returns true when selected.
    async function trySkill(alts, report) {
      let ok = false;
      for (const s of alts) {
        const f = find(); // re-find each time: adding a chip can re-render the field
        if (!f) break;
        if ((ok = await setMulti(f, s, { settleMs: 2000, report, retypeOnEmpty: true }))) {
          if (s !== alts[0]) dbg(`skill "${alts[0]}" selected via alias "${s}"`);
          break;
        }
      }
      // "+" skills: Workday's search treats "+" like a space ("C++ Programming Language" found only "C
      // Programming Language"). Search without the "+" word ("Microsoft Visual Studio", "Programming
      // Language"), then the "+" word alone ("C++"), and accept only an exact match of a skill name.
      if (!ok && alts.some((s) => s.includes("+"))) {
        const terms = [];
        for (const s of alts.filter((x) => x.includes("+"))) {
          const words = s.split(/\s+/);
          const rest = words.filter((w) => !w.includes("+")).join(" ");
          const plus = words.filter((w) => w.includes("+")).join(" ");
          for (const t of [rest, plus]) if (t && t.length > 1 && !terms.includes(t) && !alts.includes(t)) terms.push(t);
        }
        for (const t of terms) {
          const f = find();
          if (!f) break;
          if ((ok = await setMulti(f, alts.join("|"), { search: t, settleMs: 2000, report, retypeOnEmpty: true }))) {
            dbg(`skill "${alts[0]}" found by searching "${t}" (the search ignores "+")`);
            break;
          }
        }
      }
      return ok;
    }
    const missedAlts = [];
    const reports = new Map();
    for (const [si, alts] of skills.entries()) {
      AAF.setStep?.(`Skills ${si + 1}/${skills.length}`);
      if (skipped.includes(alts)) continue;
      const t0 = AAF.now();
      const report = { tries: [] };
      reports.set(alts, report);
      const ok = await trySkill(alts, report);
      // A slow skill says why: each search, how long it waited, and how it ended.
      const took = AAF.now() - t0;
      if (took > 10000) dbg(`skill "${alts[0]}" took ${Math.round(took / 1000)} s: ${report.tries.map((x) => `"${x.text}" ${x.ms} ms (${x.reason})`).join("; ")}`);
      if (ok) {
        n++;
        AAF.run.extra++;
      } else missedAlts.push(alts);
      times.push([alts[0], AAF.now() - t0]);
    }
    // Every skill not found gets one more full try (searches are flaky: different skills went missing
    // on two runs of the same DataPilot page, all of which exist) before the final not-found list. Only while
    // the skills field is still there (a retry from the previous step once ran for all 89 skills).
    if (missedAlts.length && !find()) {
      dbg(`skills: the skills field is gone (the page changed?), ${missedAlts.length} retries skipped`);
      return n;
    }
    // Only skills a search might still find get the retry: one that timed out, showed "No Items." or no
    // popup. When every search returned results with no exact match ("C++ Programming Language": Workday's
    // search drops "+", so it can never match), retrying repeats the same answer (6 searches, ~28 s).
    // A timeout while the popup showed real results (unchanged since the previous search, so Workday's list
    // never "arrived") is not transient either.
    const flaky = (t) => t.stop === "no items" || t.stop === "no popup" || (t.stop === "timeout" && !t.shown);
    const transient = (r) => (r?.tries || []).some(flaky);
    const noRetry = missedAlts.filter((alts) => !transient(reports.get(alts)));
    if (noRetry.length) dbg(`skills: no retry for ${noRetry.length} (every search returned results, none an exact match): ${noRetry.map((a) => a[0]).join(", ")}`);
    const definite = [...noRetry];
    for (const [ri, alts] of missedAlts.entries()) {
      AAF.setStep?.(`Skills: retry ${ri + 1}/${missedAlts.length}`);
      if (noRetry.includes(alts)) {
        missed.push(alts.join(" | "));
        continue;
      }
      if (!find()) {
        dbg(`skills: the skills field is gone (the page changed?), the remaining retries skipped`);
        break;
      }
      const report = { tries: [] };
      const ok = await trySkill(alts, report);
      dbg(`retry 1 for ${alts[0]}: ${ok ? "found" : "not found"}`);
      if (ok) {
        n++;
        AAF.run.extra++;
      }
      else {
        missed.push(alts.join(" | "));
        // Not found twice without a timeout: this site's list doesn't have it.
        const unsure = (t) => t.stop === "no popup" || (t.stop === "timeout" && !t.shown);
        if (![...(report.tries || []), ...(reports.get(alts)?.tries || [])].some(unsure)) definite.push(alts);
      }
    }
    if (definite.length && find()) {
      const now = Date.now();
      const mine = { ...(misses[tenant] || {}) };
      for (const k of Object.keys(mine)) if (now - (mine[k]?.at || 0) >= DAYS7) delete mine[k];
      for (const alts of definite) mine[norm(alts[0])] = { name: alts[0], at: now };
      try {
        await chrome.storage.local.set({ skillMisses: { ...misses, [tenant]: mine } });
      } catch {}
      dbg(`skills: remembered as not in this site's list (${site}, 7 days): ${definite.map((a) => a[0]).join(", ")}`);
    }
    if (find()) {
      // One summary line instead of 89 timing lines: total, plus the slowest few.
      const slowest = times.sort((a, b) => b[1] - a[1]).slice(0, 3).map(([s, ms]) => `${s} ${ms} ms`);
      dbg(`skills: ${n}/${skills.length} selected in ${AAF.now() - tAll} ms (slowest: ${slowest.join(", ")})${missed.length ? "; not found: " + show(missed) : ""}${skipped.length ? `; skipped (not in this site's list): ${skipped.length}` : ""}`);
    }
    return n;
  }

  // Steps that need the page in front (popups, search typing): paused while the tab is hidden or the
  // window unfocused, resumed automatically (shared/core.js focusStep). Text, checkbox, radio and
  // upload fills keep running.
  setDropdown = AAF.focused("dropdown", setDropdown);
  readDropdown = AAF.focused("dropdown", readDropdown);
  chooseStep = AAF.focused("dropdown", chooseStep, (f) => f.type === "dropdown");
  setMulti = AAF.focused("search box", setMulti);
  browseCategories = AAF.focused("category list", browseCategories);

  // ---------------------------------------------------------------- resume

  async function uploadResume() {
    const { resumeFile } = await chrome.storage.local.get("resumeFile");
    if (!resumeFile?.dataUrl) return false;
    const inputs = [...document.querySelectorAll('input[type="file"]')];
    if (!inputs.length && !document.querySelector('[data-automation-id*="drop" i]')) return false; // no upload on this page
    // Nearest labelled ancestor decides: Resume/CV wins, Cover Letter/Transcript loses.
    const purpose = (inp) => {
      let el = inp.parentElement;
      for (let i = 0; el && el !== document.body && i < 14; i++, el = el.parentElement) {
        const t = el.innerText || "";
        const r = /resume|\bcv\b/i.test(t);
        const o = /cover letter|transcript/i.test(t);
        if (r && !o) return "resume";
        if (o && !r) return "other";
        if (r && o) return null; // reached a container holding both sections
      }
      return null;
    };
    const input =
      inputs.find((inp) => purpose(inp) === "resume") ||
      inputs.find((inp) => inp.getAttribute("data-automation-id") === "file-upload-input-ref" && purpose(inp) !== "other") ||
      (inputs.length === 1 && purpose(inputs[0]) !== "other" ? inputs[0] : null);
    // The resume section: the nearest ancestor of the input / drop zone that mentions Resume / CV.
    const anchor = input || document.querySelector('[data-automation-id*="drop" i]');
    let section = null;
    for (let el = anchor?.parentElement, i = 0; el && el !== document.body && i < 14 && !section; i++, el = el.parentElement)
      if (/resume|\bcv\b/i.test(el.innerText || "") && !/cover letter|transcript/i.test(el.innerText || "")) section = el;
    // "Use my last application" leaves the earlier file: the same name is kept (logged), a different one is
    // deleted with its own delete button (inside the section only) and yours is uploaded.
    const prior = await AAF.clearOldUpload(section, resumeFile.name, dbg);
    if (prior.state === "kept") {
      AAF.countKept("resume");
      return false;
    }
    if (prior.state === "stuck") return false;
    const uploaded = () =>
      (section || document.body).innerText.includes(resumeFile.name) || (prior.state !== "deleted" && !prior.old && !!document.querySelector('[data-automation-id="file-upload-successful"]'));
    if (uploaded()) {
      dbg(`resume: already uploaded ("${resumeFile.name}")`);
      AAF.countKept("resume");
      return false;
    }
    const replaced = (ok) => ok && prior.old && dbg(`replaced resume "${prior.old}" with "${resumeFile.name}"`);
    const dt = new DataTransfer();
    dt.items.add(dataUrlToFile(resumeFile));
    if (input) {
      input.files = dt.files;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      if (await waitFor(uploaded, 3000)) {
        dbg("resume: uploaded via file input");
        replaced(true);
        return true;
      }
    } else {
      dbg(`resume: no resume file input (${inputs.length} file inputs on page)`, inputs.map((i) => i.getAttribute("data-automation-id")));
    }
    // Fallback: the section is a "Drop files here" zone; simulate dropping the file on it.
    let zone = input?.closest('[data-automation-id*="drop" i]');
    for (let el = input?.parentElement; !zone && el && el !== document.body; el = el.parentElement)
      zone = el.querySelector('[data-automation-id*="drop" i]');
    if (!zone) {
      const all = [...document.querySelectorAll('[data-automation-id*="drop" i]')].filter(visible);
      const zones = all.filter((z) => !all.some((o) => o !== z && o.contains(z))); // outermost only
      zone = zones.find((z) => purpose(z) === "resume") || (zones.length === 1 && purpose(zones[0]) !== "other" ? zones[0] : null);
    }
    if (!zone) {
      dbg("resume: no drop zone found", [...document.querySelectorAll('[data-automation-id*="drop" i], [data-automation-id*="file" i]')].map((e) => e.getAttribute("data-automation-id")));
      return false;
    }
    for (const t of ["dragenter", "dragover", "drop"])
      zone.dispatchEvent(new DragEvent(t, { bubbles: true, cancelable: true, dataTransfer: dt }));
    const ok = !!(await waitFor(uploaded, 3000));
    dbg(`resume: drop on ${zone.getAttribute("data-automation-id")} ${ok ? "uploaded" : "failed"}`);
    replaced(ok);
    return ok;
  }

  // ------------------------------------------------------ sections (in fillPage order)
  // Everything filled before the generic field pass: resume, work experience, education, websites,
  // languages, skills, and the "I have a preferred name" checkbox (so the preferred-name fields render).
  async function fillSections(p, stats) {
    if (await uploadResume()) {
      AAF.countFill("resume");
      toast("Uploaded resume, waiting for Workday…");
      await sleep(3000);
    }
    logSections();
    noteLinkedInField();
    const sites = websiteEntries(p);
    for (const r of [
      await fillByName(() => sectionOf("work experience"), /^job title/, p.experiences, workMap, {
        what: "work experience",
        nameRx: /^company/,
        subRx: /job title/,
        // Same text = strong; a phrase of it / the same company with more words = weak.
        signals: [
          { what: "title", rx: /job title/, same: (v, x) => (!x.title ? 0 : norm(v) === norm(x.title) ? 2 : sameTitle(v, x) ? 1 : 0) },
          { what: "company", rx: /^company/, same: (v, x) => (!x.company ? 0 : AAF.exactCompany(v, x.company) ? 2 : AAF.sameCompany(v, x.company) ? 1 : 0) },
          { what: "location", rx: /^location/, same: (v, x) => (!x.location ? 0 : norm(v) === norm(x.location) ? (/^remote$/.test(norm(v)) ? 1 : 2) : AAF.samePlace(v, x.location) ? 2 : 0) },
          { what: "dates", rx: /^from|start date/, date: true, same: (f, x) => (x.startYear && dateMatches(f, { month: x.startMonth, year: x.startYear }) === true ? 2 : 0) },
        ],
        // Two strong signals, or title and company both (at least a phrase of each).
        isMatch: (sc) => sc.strong >= 2 || ((sc.by.title || 0) >= 1 && (sc.by.company || 0) >= 1),
        required: [/job title/, /^company/],
        p,
      }),
      await fillByName(() => sectionOf("education"), /^(school|school or university|university)/, p.education, eduMap, {
        what: "education",
        nameRx: /school|university|institution/,
        signals: [{ what: "school", rx: /school|university|institution/, same: (v, x) => (sameSchool(v, x) ? 2 : 0) }],
        isMatch: (sc) => (sc.by.school || 0) >= 2,
        required: [/school|university|institution/],
        p,
      }),
      await fillRepeatable(websitesSection, /^url$/, sites, (f, x) => (/url/.test(f.nl) ? x.url : undefined), { onlyEmpty: true }),
    ]) {
      // r.filled is already in the run tally (AAF.countFill / countKept).
      stats.needs += r.needs;
      stats.review += r.review;
    }
    await fillLanguages(p, stats);
    await fillSkills(p); // counts one per skill chip as it's added (AAF.run.extra)

    if (p.preferredName) {
      const pf = fieldContainers().map(describe).find((x) => x.type === "checkbox" && /preferred name/.test(x.nl));
      if (pf && !pf.ctrl.checked) {
        click(pf.ctrl);
        await waitFor(() => fieldContainers().map(describe).some((x) => /first name/.test(x.nl) && isPreferred(x)), 2500);
      }
    }
  }

  // -------------------------------------------------------------- learning wiring
  // User answers on the page -> AAF.learn (which applies the sensitive / application-page rules).
  function watchUserAnswers() {
    const FIELD_SEL = '[data-automation-id^="formField"], fieldset';
    let lastDropdownField = null;
    document.addEventListener(
      "click",
      (e) => {
        if (!e.isTrusted) return;
        const btn = e.target.closest?.('button[aria-haspopup="listbox"]');
        if (btn) {
          const c = btn.closest(FIELD_SEL);
          lastDropdownField = c ? describe(c) : null;
          return;
        }
        const opt = e.target.closest?.('[role="option"]');
        if (opt && lastDropdownField) {
          AAF.learn(lastDropdownField, opt.innerText.trim());
          lastDropdownField = null;
        }
      },
      true
    );
    document.addEventListener(
      "change",
      (e) => {
        if (!e.isTrusted || AAF.isSecretInput(e.target)) return;
        const c = e.target.closest?.(FIELD_SEL);
        if (!c) return;
        const f = describe(c);
        let v;
        if (e.target.type === "radio") v = choiceOptions(c, "radio").find((o) => o.el.checked)?.text;
        else if (e.target.type === "checkbox") {
          if (c.dataset.wdaf) unmark(c);
          return;
        } else if (e.target.matches("textarea, input")) v = e.target.value;
        if (v) AAF.learn(f, v.trim());
      },
      true
    );
  }

  // ---------------------------------------------------------------- adapter
  // ----------------------------------------------------------- job posting
  // Location and description: the job page's own fields when they're on this page; on the application
  // pages, the location segment of the URL (/job/New-York-NY/Title_R123/apply -> "New York NY") and
  // the job page's JSON-LD (fetched same-origin).
  async function jobInfo() {
    const got = {
      location: [...document.querySelectorAll('[data-automation-id="locations"] dd, [data-automation-id="locations"]')].map((e) => e.innerText.trim()).find(Boolean) || "",
      description: document.querySelector('[data-automation-id="jobPostingDescription"]')?.innerText || "",
    };
    const m = location.pathname.match(/^(.*\/job\/([^/]+)\/[^/]+?)\/apply/i);
    if (m && !got.location) got.location = decodeURIComponent(m[2]).replace(/[-_]+/g, " ");
    if (m && !got.description) {
      const doc = await AAF.fetchDoc(location.origin + m[1]);
      const ld = doc ? AAF.jobFromLD(doc) : {};
      got.description = ld.description || "";
      if (ld.location) got.location = ld.location;
    }
    return got;
  }

  AAF.adapters.workday = {
    name: "workday",
    detect: () => /(^|\.)(myworkdayjobs|myworkday|myworkdaysite)\.com$/.test(location.hostname),
    discoverFields: () => fieldContainers().map(describe),
    isFilled,
    currentValue,
    dateMatches,
    isSectionField,
    setField: setFieldRaw,
    readOptions,
    fillSections,
    watchUserAnswers,
    jobInfo,
    closePopups: () => ensureAllClosed(), // on a stop
    // The current step (shared/main.js cancels a run when it changes): the URL plus the progress bar's active
    // step ("My Information", "My Experience", ...); Workday's steps can share a URL.
    stepKey: () => location.pathname + "|" + ((document.querySelector('[data-automation-id="progressBarActiveStep"]') || {}).innerText || "").trim(),
    // Page-type hints.
    isFormPage: () => !!document.querySelector('[data-automation-id^="formField"], [data-automation-id="progressBar"]'),
    isApplicationFlow: () => !!document.querySelector('[data-automation-id="progressBar"]') || /\/apply/i.test(location.pathname),
    isApplicationQuestionsPage: () =>
      [...document.querySelectorAll("h1,h2,h3,[role='heading']")].some((h) => visible(h) && /application questions|questionnaire/.test(norm(h.innerText))),
  };
})();
