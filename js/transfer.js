/**
 * Moving the ledger between browsers on the same phone (e.g. from
 * Messenger's in-app browser to Chrome) as plain text on the clipboard.
 * Storage is per browser, so this is the only way across without files.
 */

const IN_APP = [
  // WeChat first: its UA contains "MicroMessenger", which is not Facebook Messenger.
  { name: "WeChat", re: /MicroMessenger/i },
  { name: "Messenger", re: /FB_IAB\/MESSENGER|Orca-Android|FBAN\/Messenger|MessengerForiOS|MessengerLite|\bMessenger\b/i },
  { name: "Instagram", re: /Instagram/i },
  { name: "Facebook", re: /FBAN|FBAV|FB_IAB|FB4A|FBIOS|FBSS/i },
  { name: "LINE", re: /\bLine\//i },
  { name: "Snapchat", re: /Snapchat/i },
  { name: "TikTok", re: /musical_ly|BytedanceWebview|TikTok/i },
  { name: "X (Twitter)", re: /Twitter/i },
  { name: "LinkedIn", re: /LinkedInApp/i },
  { name: "Pinterest", re: /Pinterest/i },
  { name: "Telegram", re: /Telegram/i },
];

/** Returns { inApp, name } for a user-agent string. */
export function detectInAppBrowser(ua = globalThis.navigator?.userAgent || "") {
  for (const app of IN_APP) {
    if (app.re.test(ua)) return { inApp: true, name: app.name };
  }
  // Generic Android WebView (some other app's browser).
  if (/; wv\)/.test(ua) && /Android/.test(ua)) return { inApp: true, name: "" };
  return { inApp: false, name: "" };
}

/** "Messenger's browser" / "this app's browser". */
export function inAppLabel(info) {
  return info?.name ? `${info.name}\u2019s browser` : "this app\u2019s browser";
}

/** Copy with a hidden, readonly, auto-selected textarea (works where the Clipboard API is blocked). */
export function execCommandCopy(text, doc = globalThis.document) {
  const ta = doc.createElement("textarea");
  ta.value = text;
  ta.readOnly = true;
  ta.setAttribute("aria-hidden", "true");
  ta.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none;font-size:16px";
  // Inside an open modal <dialog> the rest of the page is inert, so put it there.
  const open = doc.querySelectorAll("dialog[open]");
  const host = open.length ? open[open.length - 1] : doc.body;
  host.appendChild(ta);
  const active = doc.activeElement;
  let ok = false;
  try {
    ta.focus({ preventScroll: true });
    ta.select();
    ta.setSelectionRange(0, text.length);
    ok = Boolean(doc.execCommand && doc.execCommand("copy"));
  } catch {
    ok = false;
  }
  ta.remove();
  try {
    active?.focus?.({ preventScroll: true });
  } catch {}
  return ok;
}

/**
 * Copy text to the clipboard. Returns "clipboard", "execCommand", or null
 * when both failed (caller then shows the text for manual select + copy).
 */
export async function copyText(text, { nav = globalThis.navigator, doc = globalThis.document } = {}) {
  if (nav?.clipboard && typeof nav.clipboard.writeText === "function") {
    try {
      await nav.clipboard.writeText(text);
      return "clipboard";
    } catch {
      // Blocked (permissions, in-app webview, lost tap): try the old way.
    }
  }
  return execCommandCopy(text, doc) ? "execCommand" : null;
}

/** Read the clipboard where allowed. Returns text, or throws. */
export async function readClipboard(nav = globalThis.navigator) {
  if (!nav?.clipboard || typeof nav.clipboard.readText !== "function") {
    throw new Error("unsupported");
  }
  return nav.clipboard.readText();
}

/**
 * Parse pasted backup text. Tolerates surrounding whitespace / text that a
 * messaging app may add around the JSON. Throws a friendly error.
 */
export function parseBackupText(text) {
  const raw = String(text || "").trim();
  if (!raw) throw new Error("The box is empty. Tap Paste from clipboard, or long-press the box and tap Paste.");
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first === -1 || last <= first) {
    throw new Error("That doesn\u2019t look like a Pay Ledger backup. Go back and tap Copy backup again.");
  }
  try {
    return JSON.parse(raw.slice(first, last + 1));
  } catch {
    throw new Error("The backup text is incomplete (it may have been cut off). Go back, tap Copy backup again, then paste.");
  }
}

export function kb(text) {
  return `${Math.max(1, Math.round(new Blob([text]).size / 1024))} KB`;
}

export function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}
