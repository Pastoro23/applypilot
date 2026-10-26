const $ = (s) => document.querySelector(s);
let profile = null,
  resume = null;
chrome.storage.local.get(["applypilotProfile", "applypilotResume"], (s) => {
  profile = s.applypilotProfile || null;
  resume = s.applypilotResume || null;
  refresh();
});
chrome.tabs.query(
  { active: true, currentWindow: true },
  ([t]) => ($("#platform").textContent = platform(t?.url || "")),
);
$("#profile-file").onchange = async (e) => {
  try {
    const p = JSON.parse(await e.target.files[0].text());
    if (!p.firstName || !p.lastName || !p.email)
      throw Error("Profile needs first name, last name, and email.");
    profile = p;
    await chrome.storage.local.set({ applypilotProfile: p });
    $("#result").textContent = "Profile imported.";
    refresh();
  } catch (x) {
    $("#result").textContent = x.message || "Could not import profile.";
  }
};
$("#resume-file").onchange = async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  if (f.size > 5 * 1024 * 1024) {
    $("#result").textContent = "Use a resume smaller than 5 MB.";
    return;
  }
  resume = { name: f.name, type: f.type || "application/octet-stream", dataUrl: await dataUrl(f) };
  await chrome.storage.local.set({ applypilotResume: resume });
  $("#result").textContent = "Resume saved for applications.";
  refresh();
};
$("#run").onclick = () => run(false);
$("#next").onclick = () => run(true);
$("#open-runner").onclick = async () => {
  try {
    await chrome.runtime.sendMessage({ type: "AP_OPEN_RUNNER" });
    window.close();
  } catch {
    $("#result").textContent = "Couldn't open the runner. Reload the extension and try again.";
  }
};
$("#stop-runner").onclick = async () => {
  await chrome.storage.local.set({ apHalt: true });
  $("#result").textContent = "Stopped. Nothing more is sent until you press Resume in the runner.";
};
$("#snapshot").onclick = saveSnapshot;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && Object.keys(changes).some((k) => k.startsWith("apJob:") || k === "apHalt" || k === "apRun")) runnerStatus();
});
runnerStatus();
function refresh() {
  if (profile) {
    $("#dot").classList.add("ready");
    $("#profile-status").textContent = "Profile ready";
    $("#profile-detail").textContent = `${profile.firstName} ${profile.lastName} · ${profile.email}`;
    $("#run").disabled = false;
  }
  $("#resume-label").textContent = resume ? resume.name : "Add resume";
}
async function run(advance) {
  $("#run").disabled = true;
  $("#next").disabled = true;
  $("#result").textContent = advance
    ? "Checking for a safe Next button…"
    : "Scanning and filling approved fields…";
  try {
    const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!t?.id || !/^https?:/.test(t.url || "")) throw Error("Open an employer application first.");
    $("#platform").textContent = platform(t.url);
    await chrome.scripting.executeScript({ target: { tabId: t.id }, files: ["page-lib.js"] });
    const out = await chrome.scripting.executeScript({
      target: { tabId: t.id },
      func: (p, r, a) => globalThis.__applypilot.assistant(p, r, a),
      args: [profile, resume, advance],
    });
    const s = out[0]?.result;
    if (!s) throw Error("This page could not be read.");
    show(s);
    $("#result").textContent = s.advanced
      ? "Moved to the next step. Open ApplyPilot again after it loads."
      : s.blockers.length
        ? `Filled ${s.filled} fields. Answer the highlighted questions.`
        : `Filled ${s.filled} fields. ${s.nextNote || "Review, then continue safely."}`;
    $("#next").disabled = !!s.blockers.length || s.final || !s.canAdvance;
  } catch (e) {
    $("#result").textContent = e.message || "This page could not be processed.";
  } finally {
    $("#run").disabled = !profile;
  }
}
function show(s) {
  $("#report").hidden = false;
  $("#filled").textContent = s.filled;
  $("#blocked").textContent = s.blockers.length;
  $("#uploaded").textContent = s.resumeAttached ? "Yes" : resume ? "Waiting" : "None";
  $("#blockers").hidden = !s.blockers.length;
  $("#blocker-list").replaceChildren(
    ...s.blockers.slice(0, 8).map((x) => {
      const li = document.createElement("li");
      li.textContent = x;
      return li;
    }),
  );
}
function dataUrl(f) {
  return new Promise((ok, no) => {
    const r = new FileReader();
    r.onload = () => ok(r.result);
    r.onerror = no;
    r.readAsDataURL(f);
  });
}
function platform(u) {
  let h = "";
  try {
    h = new URL(u).hostname.toLowerCase();
  } catch {}
  if (/myworkdayjobs|workday/.test(h)) return "Workday";
  if (/greenhouse/.test(h)) return "Greenhouse";
  if (/lever\.co/.test(h)) return "Lever";
  if (/icims/.test(h)) return "iCIMS";
  if (/smartrecruiters/.test(h)) return "SmartRecruiters";
  if (/jobvite/.test(h)) return "Jobvite";
  if (/taleo/.test(h)) return "Taleo";
  return h ? "Employer site" : "Open a job";
}
// The batch runner's queue, read straight from its records.
async function runnerStatus() {
  const all = await chrome.storage.local.get(null);
  const busy = new Set(["queued", "paused", "opening", "filling", "auditing", "claiming", "submitting", "waiting_for_you", "observing"]);
  const n = Object.entries(all).filter(([k, v]) => k.startsWith("apJob:") && busy.has(v?.state)).length;
  const halted = all.apHalt === true;
  $("#runner-status").textContent = n
    ? `Batch runner: ${n} queued${halted ? " · stopped" : ""}`
    : "Batch runner: nothing queued";
  $("#stop-runner").hidden = !n || halted;
}
// Structure only (labels, required flags, options, buttons), no answers: used to calibrate ApplyPilot on real forms.
async function saveSnapshot() {
  try {
    const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!t?.id || !/^https?:/.test(t.url || "")) throw Error("Open an employer application first.");
    await chrome.scripting.executeScript({ target: { tabId: t.id }, files: ["page-lib.js"] });
    const [out] = await chrome.scripting.executeScript({ target: { tabId: t.id }, func: () => globalThis.__applypilot.snapshot() });
    if (!out?.result) throw Error("This page could not be read.");
    let host = "page";
    try {
      host = new URL(t.url).hostname.replace(/[^a-z0-9.-]/gi, "");
    } catch {}
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(out.result, null, 2)], { type: "application/json" }));
    a.download = `applypilot-snapshot-${host}-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    $("#result").textContent = "Form snapshot saved to your Downloads folder. It has no answers in it.";
  } catch (e) {
    $("#result").textContent = e.message || "Couldn't save a snapshot of this page.";
  }
}
