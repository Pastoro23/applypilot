// Message router. The dashboard reaches it only through bridge.js on the dashboard origin; the runner page
// does the work itself, so nothing here waits on a page or clicks anything.

import { DASHBOARD_ORIGIN, KEYS, acceptBatch, ackResults, cancelJobs, cleanup, focusJobTab, forgetTabs, heldSummary, pullResults } from "./runner-core.js";

const local = chrome.storage.local;
const session = chrome.storage.session;
const VERSION = chrome.runtime.getManifest().version;
const RUNNER_URL = chrome.runtime.getURL("runner.html");
const DASHBOARD_TYPES = new Set(["AP_HELLO", "AP_BATCH", "AP_CANCEL", "AP_STOP", "AP_RESUME", "AP_FOCUS", "AP_PULL_RESULTS", "AP_RESULTS_ACK"]);
const POPUP_TYPES = new Set(["AP_OPEN_RUNNER"]);

async function sha256(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== "string" || sender.id !== chrome.runtime.id) return false;
  let work;
  if (DASHBOARD_TYPES.has(msg.type) && sender.tab && sender.origin === DASHBOARD_ORIGIN) work = fromDashboard(msg, sender);
  else if (POPUP_TYPES.has(msg.type) && !sender.tab && String(sender.url || "").startsWith(chrome.runtime.getURL(""))) work = ensureRunner().then(() => ({ ok: true }));
  else return false; // AP_PAGE_EVENT and anything else belongs to the runner page
  work.then(sendResponse, (e) => sendResponse({ error: String((e && e.message) || e) }));
  return true;
});

async function fromDashboard(msg, sender) {
  const payload = msg.payload && typeof msg.payload === "object" ? msg.payload : {};
  switch (msg.type) {
    case "AP_HELLO":
      // bridge.js says hello on load as well; only the page's own hello makes a frame one that can take claims.
      await rememberFrame(sender, payload.passive !== true);
      return { version: VERSION, ...(await heldSummary(local, { runnerOpen: Boolean(await runnerContext()) })) };
    case "AP_BATCH": {
      const result = await acceptBatch(local, payload.batch, { now: Date.now(), sha256, tabUrl });
      if (result.accepted.length) await ensureRunner();
      return result;
    }
    case "AP_CANCEL":
      return cancelJobs(local, payload.approvalIds, Date.now());
    case "AP_STOP":
      await local.set({ [KEYS.halt]: true });
      return { ok: true };
    case "AP_RESUME": {
      // apWake changes every time, so the runner hears it even when apHalt was already false.
      await local.set({ [KEYS.halt]: false, apWake: Date.now() });
      const { held } = await heldSummary(local, { runnerOpen: false });
      if (held.length) await ensureRunner();
      return { ok: true };
    }
    case "AP_FOCUS":
      return focusJobTab(local, chrome, payload.approvalId);
    case "AP_PULL_RESULTS":
      return { results: await pullResults(local) };
    case "AP_RESULTS_ACK":
      return ackResults(local, payload.resultIds, Date.now());
  }
  return { error: "unknown_type" };
}

async function dashFrames() {
  const { apDash } = await session.get("apDash");
  return Array.isArray(apDash) ? apDash : [];
}

async function rememberFrame(sender, ready) {
  const tabId = sender.tab.id;
  const frameId = typeof sender.frameId === "number" ? sender.frameId : 0;
  const frames = await dashFrames();
  const before = frames.find((f) => f.tabId === tabId && f.frameId === frameId);
  const rest = frames.filter((f) => f !== before);
  // A passive hello from a page that already said hello itself keeps it ready, unless the page reloaded.
  const keep = !ready && before?.ready === true && before.documentId && before.documentId === sender.documentId;
  const top = frameId === 0 && String(sender.tab.url || "").startsWith(`${DASHBOARD_ORIGIN}/`);
  const entry = { tabId, frameId, documentId: sender.documentId || "", ready: ready || keep, top, at: Date.now() };
  await session.set({ apDash: [...rest, entry].slice(-10) });
}

async function tabUrl(tabId) {
  try {
    return (await chrome.tabs.get(tabId))?.url ?? "";
  } catch {
    return null;
  }
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const frames = await dashFrames();
  if (frames.some((f) => f.tabId === tabId)) await session.set({ apDash: frames.filter((f) => f.tabId !== tabId) });
  // A watch for a tab closed while the runner page wasn't open would otherwise refuse that job's next approval.
  await local.remove(KEYS.watch(tabId));
});

async function runnerContext() {
  if (chrome.runtime.getContexts) {
    const found = await chrome.runtime.getContexts({ contextTypes: ["TAB"], documentUrls: [RUNNER_URL] });
    return found[0] || null;
  }
  const { apRunnerWindowId: windowId } = await session.get("apRunnerWindowId");
  if (typeof windowId !== "number") return null;
  try {
    await chrome.windows.get(windowId);
    return { windowId };
  } catch {
    return null;
  }
}

async function ensureRunner() {
  const ctx = await runnerContext();
  if (ctx && typeof ctx.windowId === "number") {
    try {
      await chrome.windows.update(ctx.windowId, { focused: true });
      return;
    } catch {}
  }
  const win = await chrome.windows.create({ url: RUNNER_URL, type: "normal", focused: true, width: 1280, height: 900 });
  await session.set({ apRunnerWindowId: win.id });
}

// Tab ids from before Chrome restarted belong to other tabs now.
chrome.runtime.onStartup.addListener(() => forgetTabs(local).then(() => cleanup(local, Date.now())));
