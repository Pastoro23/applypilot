// Wires chrome APIs into the runner core and draws the queue. All decisions live in runner-core.js.
import { HOST_PATTERNS } from "./ats.js";
import { DASHBOARD_URL, PAUSE_TEXT, createRunner } from "./runner-core.js";

const $ = (s) => document.querySelector(s);
const local = chrome.storage.local;
const session = chrome.storage.session;
const VERSION = chrome.runtime.getManifest().version;
const DASH_WAIT_MS = 20000;

let runner = null;
let windowId = null;
let openedDashboard = false;
let resumeTimer = null;
let latest = null;

async function sha256(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

// ---- the dashboard frames bridge.js registered ----

async function dashFrames() {
  const { apDash } = await session.get("apDash");
  return (Array.isArray(apDash) ? apDash : []).slice().sort((a, b) => b.at - a.at);
}

async function dropFrame(frame) {
  const { apDash } = await session.get("apDash");
  const rest = (Array.isArray(apDash) ? apDash : []).filter((f) => !(f.tabId === frame.tabId && f.frameId === frame.frameId));
  await session.set({ apDash: rest });
}

async function waitForFrames(ms) {
  const until = Date.now() + ms;
  for (;;) {
    const frames = await dashFrames();
    if (frames.length || Date.now() >= until) return frames;
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function claim(payload) {
  let frames = await dashFrames();
  if (!frames.length && !openedDashboard) {
    openedDashboard = true;
    try {
      await chrome.tabs.create({ url: DASHBOARD_URL, active: false, ...(typeof windowId === "number" ? { windowId } : {}) });
    } catch {}
    frames = await waitForFrames(DASH_WAIT_MS);
  }
  for (const frame of frames) {
    let reply;
    try {
      reply = await chrome.tabs.sendMessage(frame.tabId, { type: "AP_CLAIM", payload }, { frameId: frame.frameId });
    } catch {
      // Not delivered: that frame is gone, so the claim never left this browser. Try the next one.
      await dropFrame(frame);
      continue;
    }
    return reply && typeof reply === "object" ? reply : { ok: false, reason: "network" };
  }
  return { ok: false, reason: "no_dashboard" };
}

async function notify(type, payload) {
  for (const frame of await dashFrames()) {
    try {
      await chrome.tabs.sendMessage(frame.tabId, { type, payload }, { frameId: frame.frameId });
    } catch {
      await dropFrame(frame);
    }
  }
}

const deps = {
  storage: { get: (k) => local.get(k), set: (o) => local.set(o), remove: (k) => local.remove(k) },
  tabs: {
    create: (p) => chrome.tabs.create(p),
    get: (id) => chrome.tabs.get(id),
    update: (id, p) => chrome.tabs.update(id, p),
    remove: (id) => chrome.tabs.remove(id),
    onUpdated: chrome.tabs.onUpdated,
    onRemoved: chrome.tabs.onRemoved,
  },
  windows: { update: (id, p) => chrome.windows.update(id, p) },
  scripting: { executeScript: (o) => chrome.scripting.executeScript(o) },
  permissions: { contains: (p) => chrome.permissions.contains(p) },
  bridge: { claim, notify },
  sha256,
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms))),
  uuid: () => crypto.randomUUID(),
};

// ---- drawing ----

const ATS_NAMES = { greenhouse: "Greenhouse", lever: "Lever", ashby: "Ashby" };

function render(v) {
  latest = v;
  const run = v.run;
  const pending = v.jobs.filter((j) => ["queued", "paused"].includes(j.state)).length;
  const done = v.jobs.filter((j) => String(j.state).startsWith("done:") || j.state === "cancelled").length;
  let title = "Nothing to send";
  let detail = "";
  let calm = run.state === "running";
  if (v.countdown > 0) {
    title = `Starting in ${v.countdown} s`;
    detail = `${pending} approved ${pending === 1 ? "application" : "applications"} to send. Pause if you want to look first.`;
  } else if (run.state === "running") {
    const cur = v.jobs.find((j) => j.approvalId === run.current);
    title = cur ? `${cur.label}: ${cur.role} at ${cur.company}` : "Sending";
    detail = `${done} of ${v.jobs.length} finished.`;
  } else if (run.state === "paused") {
    title = "Paused";
    detail = run.pausedText || PAUSE_TEXT[run.pausedReason] || "";
    if (run.resumeAt) detail += ` Sending resumes at ${new Date(run.resumeAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.`;
  } else if (pending) {
    title = `${pending} waiting`;
  } else if (v.jobs.length) {
    const count = (state) => v.jobs.filter((j) => j.state === state).length;
    const sent = count("done:submitted");
    const needs = count("done:needs_you") + count("done:check");
    title = "All done for now";
    calm = needs === 0;
    detail = [sent && `${sent} sent`, needs && `${needs} ${needs === 1 ? "needs" : "need"} you in the open tabs`].filter(Boolean).join(" · ");
  }
  $("#run-title").textContent = title;
  $("#run-detail").textContent = detail;
  $("#dot").classList.toggle("running", calm);
  $("#pause").hidden = !(v.countdown > 0);
  $("#stop").hidden = !(run.state === "running" || v.countdown > 0 || pending > 0) || run.state === "paused";
  $("#resume").hidden = run.state !== "paused";
  $("#allow").hidden = !(run.state === "paused" && run.pausedReason === "permission");
  $("#open-dashboard").hidden = !(run.state === "paused" && run.pausedReason === "dashboard");

  $("#waiting").hidden = !v.waiting;
  if (v.waiting) $("#waiting-title").textContent = `Waiting for you to click Submit on ${v.waiting.role} at ${v.waiting.company}`;

  const items = v.jobs.slice().reverse().map((j) => {
    const li = document.createElement("li");
    const name = document.createElement("div");
    name.className = "job";
    name.textContent = `${j.role} · ${j.company}`;
    const small = document.createElement("small");
    small.textContent = ATS_NAMES[j.ats] || j.ats;
    name.append(small);
    const state = document.createElement("span");
    state.className = "state" + (j.state === "done:submitted" ? " sent" : ["done:needs_you", "done:check"].includes(j.state) ? " needs" : "");
    state.textContent = j.label;
    li.append(name, state);
    if (j.reasons.length) {
      const ul = document.createElement("ul");
      ul.className = "reasons";
      for (const r of j.reasons) {
        const item = document.createElement("li");
        item.textContent = r.text || r.code;
        ul.append(item);
      }
      li.append(ul);
    }
    return li;
  });
  $("#queue").replaceChildren(...items);
  $("#empty").hidden = items.length > 0;

  clearTimeout(resumeTimer);
  if (run.state === "paused" && run.resumeAt) {
    resumeTimer = setTimeout(() => runner?.resume(), Math.max(1000, run.resumeAt - Date.now()));
  }
}

async function renderBridge() {
  const n = (await dashFrames()).length;
  const el = $("#bridge");
  el.textContent = n ? "ApplyPilot connected" : "ApplyPilot not open";
  el.classList.toggle("missing", !n);
}

// ---- start-up ----

async function main() {
  const win = await chrome.windows.getCurrent();
  windowId = win.id;
  await session.set({ apRunnerWindowId: win.id });
  runner = createRunner(deps, { windowId: win.id, version: VERSION });

  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (msg && msg.type === "AP_PAGE_EVENT" && sender.id === chrome.runtime.id) runner.onPageEvent(msg, sender);
    return false;
  });
  chrome.tabs.onUpdated.addListener((tabId, info) => runner.onTabUpdated(tabId, info));
  chrome.tabs.onRemoved.addListener((tabId) => runner.onTabRemoved(tabId));
  local.onChanged.addListener((changes) => {
    if (changes.apHalt) runner.onHaltChanged(changes.apHalt.newValue === true);
    let added = false;
    for (const [key, change] of Object.entries(changes)) {
      if (key.startsWith("apCancel:") && change.newValue) runner.onCancelMarked(key.slice("apCancel:".length));
      if (key.startsWith("apJob:") && !change.oldValue && change.newValue?.state === "queued") added = true;
    }
    if (added) runner.wake();
  });
  session.onChanged.addListener((changes) => {
    if (!changes.apDash) return;
    renderBridge();
    if (Array.isArray(changes.apDash.newValue) && changes.apDash.newValue.length) {
      openedDashboard = false;
      runner.onDashboardConnected();
    }
  });

  $("#pause").onclick = () => runner.pauseCountdown();
  $("#stop").onclick = () => runner.stop();
  $("#resume").onclick = () => {
    openedDashboard = false;
    runner.resume();
  };
  $("#skip").onclick = () => latest?.waiting && runner.skip(latest.waiting.approvalId);
  $("#show-tab").onclick = async () => {
    const tabId = latest?.waiting?.tabId;
    if (typeof tabId !== "number") return;
    try {
      const tab = await chrome.tabs.update(tabId, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
    } catch {}
  };
  $("#open-dashboard").onclick = () => chrome.tabs.create({ url: DASHBOARD_URL, active: true });
  // Must run from the click itself: Chrome only shows the permission prompt for a user gesture.
  $("#allow").onclick = () =>
    chrome.permissions.request({ origins: HOST_PATTERNS }, (granted) => {
      void chrome.runtime.lastError;
      if (granted) runner.resume();
    });

  runner.subscribe(render);
  await renderBridge();
  await runner.recover();
  await runner.start();
}

function duplicate() {
  $("#duplicate").hidden = false;
  $("#status").hidden = true;
}

if (navigator.locks) {
  navigator.locks.request("applypilot-runner", { ifAvailable: true }, async (lock) => {
    if (!lock) return duplicate();
    await main();
    await new Promise(() => {}); // hold the lock for as long as this page is open
  });
} else {
  main();
}
