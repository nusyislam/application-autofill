// Application Autofill: shared DOM event simulation for React forms (clicks, keys, typing).

(() => {
  const AAF = globalThis.AAF;
  if (!AAF.once("dom")) return;
  const { sleep, dbg, norm } = AAF;

  // HARD RULE: the extension never navigates pages. click() refuses page-navigation and submit
  // controls (a "back" lookup once found Workday's footer Back button and closed the application).
  // Only controls inside an open popup / listbox are exempt (e.g. a list's own "Back" row).
  // iCIMS adds Previous / Save / Finish / Submit Profile and account-step buttons (Login, Create Account).
  const NAV_TEXT = /^(back|previous|next|continue|save|save draft|save and exit|save and continue|save continue|finish|submit|submit application|submit your application|submit profile|apply|apply now|apply for this job|apply for this job online|apply for this position|send|send message|send note|close|cancel|exit|sign in|sign out|log in|login|log out|logout|create account|create an account|register|review|review and submit)$/;
  const NAV_IDS = /pagefooter|bottom-navigation|bottomnavigation|navigation(next|back)|(back|next|submit|continue|apply|cancel|exit|signout|logout|review)-?button/i;
  function navBlockReason(el) {
    if (!el?.closest) return null;
    if (el.closest('[role="listbox"], [data-automation-id="activeListContainer"]')) return null;
    const link = el.closest("a[href]");
    if (link && !/^(#|javascript:)/i.test(link.getAttribute("href") || "")) return `link to ${link.getAttribute("href")}`;
    // An open date-picker calendar the date setter identified (shared/form.js `findCalendar`: a "<Month> <year>"
    // header and day cells): its "Previous" / "Next" month arrows move the calendar, not the page.
    if (el.closest("[data-aaf-calendar]")) return null;
    const ctl = el.closest('button, [role="button"], input[type="submit"], input[type="button"], a');
    const ids = [el, ctl, el.closest("[data-automation-id]")].filter(Boolean).map((x) => x.getAttribute("data-automation-id") || "").filter(Boolean);
    const navId = ids.find((id) => NAV_IDS.test(id));
    if (navId) return `automation id "${navId}"`;
    // Dropdown buttons show their current value as text, so they're never judged by text.
    if (ctl && !ctl.hasAttribute("aria-haspopup")) {
      const text = norm(ctl.innerText || ctl.value || ctl.getAttribute("aria-label") || "");
      if (NAV_TEXT.test(text)) return `"${text}" control`;
    }
    return null;
  }

  function nativeSet(el, value) {
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function click(el) {
    const blocked = navBlockReason(el);
    if (blocked) {
      dbg(`BLOCKED click on ${blocked} (the extension never navigates pages)`);
      return false;
    }
    el.scrollIntoView({ block: "center" });
    const o = { bubbles: true, cancelable: true, view: window };
    el.dispatchEvent(new PointerEvent("pointerdown", o));
    el.dispatchEvent(new MouseEvent("mousedown", o));
    el.dispatchEvent(new PointerEvent("pointerup", o));
    el.dispatchEvent(new MouseEvent("mouseup", o));
    el.dispatchEvent(new MouseEvent("click", o));
    return true;
  }

  // The KeyboardEvent constructor ignores keyCode/which (they read 0), and Workday checks them,
  // so define them on the event instance.
  function kbd(el, type, k, code) {
    const e = new KeyboardEvent(type, { key: k, code: k.length === 1 ? undefined : k, bubbles: true, cancelable: true, view: window });
    Object.defineProperty(e, "keyCode", { get: () => code });
    Object.defineProperty(e, "which", { get: () => code });
    if (type === "keypress") Object.defineProperty(e, "charCode", { get: () => code });
    el.dispatchEvent(e);
  }
  function key(el, k) {
    const code = { Enter: 13, Escape: 27 }[k];
    kbd(el, "keydown", k, code);
    if (k === "Enter") kbd(el, "keypress", k, code);
    kbd(el, "keyup", k, code);
  }

  // Workday only commits React state on real typing + focusout, and el.focus()/el.blur() fire no
  // events when the page itself isn't focused, so simulate the whole sequence explicitly.
  // blur: false keeps focus (multiselect search boxes, which close/clear on blur).
  // `respectCancel` (masked date inputs): a key whose beforeinput the page cancels is left to the page's own
  // handler (an input mask writes the digit itself); setting it as well doubled every digit ("01/01/20005").
  async function typeInto(el, value, { blur = true, respectCancel = false } = {}) {
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setVal = (v) => Object.getOwnPropertyDescriptor(proto, "value").set.call(el, v);
    el.scrollIntoView({ block: "center" });
    el.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    el.focus();
    el.dispatchEvent(new FocusEvent("focus"));
    setVal("");
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
    for (const ch of String(value ?? "")) {
      const code = ch.toUpperCase().charCodeAt(0);
      kbd(el, "keydown", ch, code);
      kbd(el, "keypress", ch, ch.charCodeAt(0));
      const go = el.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: ch }));
      if (go || !respectCancel) {
        setVal(el.value + ch);
        el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: ch }));
      }
      kbd(el, "keyup", ch, code);
    }
    if (blur) {
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.blur();
      el.dispatchEvent(new FocusEvent("blur"));
      el.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    }
    await sleep(50);
  }

  Object.assign(AAF, { nativeSet, click, kbd, key, typeInto, navBlockReason });
})();
