// End-to-end check of Application Assistant 3.1: the unpacked extension in Chromium, a stub dashboard that keeps
// the page side of the bridge contract and answers with the real submission store (app/submission-store.ts on
// node:sqlite), and Greenhouse- and Lever-like forms that count every form POST.
//   PLAYWRIGHT=/path/to/playwright/index.mjs CHROMIUM=/path/to/chromium node scripts/test-extension-e2e.mjs
// HEADED=1 runs a visible browser, for a Chromium whose headless mode won't load extensions.
//
// The dashboard origin is served with context.route. Tabs the extension opens itself (chrome.tabs.create) are not
// seen by context.route, so the ATS hosts resolve to a local HTTPS server instead (--host-resolver-rules). Nothing
// leaves this machine.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import https from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { chromium } = await import(process.env.PLAYWRIGHT || "playwright");
const { testDatabase } = await import("../tests/sqlite-helper.ts");
const store = await import("../app/submission-store.ts");
const { buildBatch } = await import("../app/send-batch.ts");
const { autofillProfileFromRow } = await import("../app/profile-records.ts");

const EXTENSION = fileURLToPath(new URL("../extension/", import.meta.url));
const DASHBOARD = "https://applypilot-hub.amused-bream-5718.chatgpt.site";
const OWNER = "e2e@example.invalid";
const ROLE = "Help Desk Technician";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the server side: the real store on an in-memory database ----------------------------------------------

const { sqlite, db } = testDatabase();
sqlite.prepare(`INSERT INTO profiles (owner_email, first_name, last_name, profile_email, phone, city, state, postal_code, country,
  work_authorized, requires_sponsorship, identity_status, location_status, work_history_status)
  VALUES (?, 'Test', 'Person', 't@example.com', '404-555-0100', 'Grayson', 'GA', '30017', 'United States', 'yes', 'no',
  'confirmed', 'confirmed', 'confirmed')`).run(OWNER);
const TAILORED = {
  fitScore: 80, fitSummary: "Good fit.", requirements: [], changes: [], gaps: [], coverLetter: "Dear hiring team, I would like to apply.",
  resume: {
    name: "Test Person", contactLine: "t@example.com · 404-555-0100", headline: "IT Support Specialist", summary: "Support technician.",
    skills: ["Windows 11"], experience: [{ title: "IT Support", company: "Example Co", location: "Atlanta, GA", dates: "2023 – Present", bullets: ["Fixed things"] }],
    education: [], certifications: [],
  },
};
const TAILORED_AT = "2026-10-25T09:30:00.000Z";

function addApplication(id, url) {
  sqlite.prepare(`INSERT INTO applications (id, owner_email, company, role, url, status, tailored_json, tailored_at, tailored_revision)
    VALUES (?, ?, 'Acme Example', ?, ?, 'ready', ?, ?, 1)`).run(id, OWNER, ROLE, url, JSON.stringify(TAILORED), TAILORED_AT);
}
const row = (id) => sqlite.prepare("SELECT * FROM submissions WHERE id = ?").get(id);
const appStatus = (id) => sqlite.prepare("SELECT status FROM applications WHERE id = ?").get(id).status;
const events = (id) => sqlite.prepare("SELECT event FROM submission_events WHERE submission_id = ? ORDER BY rowid").all(id).map((e) => e.event);
const reasonCodes = (id) => JSON.parse(row(id).reasons_json).map((r) => r.code);
const savedProfile = () => autofillProfileFromRow(sqlite.prepare("SELECT * FROM profiles WHERE owner_email = ?").get(OWNER));
const claims = [];

// ---- ATS-like forms on a local HTTPS server ----------------------------------------------------------------

const pages = new Map(); // "host/path" -> html
const redirects = new Map(); // POST "host/path" -> where the site sends you next
const posts = new Map(); // "host/path" -> form POSTs received
const postsTo = (key) => posts.get(key) ?? 0;
const totalPosts = () => [...posts.values()].reduce((a, b) => a + b, 0);
const clickedByTest = new Set(); // forms the test submitted itself, acting as you

const LEVER_HOST = "jobs.lever.co";
const GH_HOST = "job-boards.greenhouse.io";
function leverJob(id, extra = "") {
  const base = `${LEVER_HOST}/acme/${id}`;
  pages.set(`${base}/apply`, `<!doctype html><html><head><meta charset="utf-8"><title>Acme Example - ${ROLE}</title></head><body>
<div class="posting-headline"><h2>${ROLE}</h2><div>Atlanta, GA</div></div>
<form id="application-form" action="/acme/${id}/apply" method="POST" enctype="multipart/form-data">
  <ul>
    <li><label><div>Resume/CV<span class="required">✱</span></div><input type="file" name="resume" id="resume-upload-input" required></label></li>
    <li><label><div>Full name<span class="required">✱</span></div><input type="text" name="name" required></label></li>
    <li><label><div>Email<span class="required">✱</span></div><input type="email" name="email" required></label></li>
    <li><label><div>Phone</div><input type="text" name="phone"></label></li>
    ${extra}
  </ul>
  <button type="submit" id="btn-submit" data-qa="btn-submit">Submit application</button>
</form></body></html>`);
  pages.set(`${base}/thanks`, `<!doctype html><html><head><meta charset="utf-8"><title>Acme Example</title></head><body>
<h3>Application submitted!</h3><p>Thanks for applying to Acme Example. Our team will review it soon.</p></body></html>`);
  redirects.set(`${base}/apply`, `/acme/${id}/thanks`);
  return { url: `https://${base}`, post: `${base}/apply`, path: `/acme/${id}/apply` };
}
function greenhouseJob(id) {
  const base = `${GH_HOST}/acme/jobs/${id}`;
  const field = (name, label, type = "text") =>
    `<div class="field"><label for="${name}">${label}<span class="asterisk">*</span></label><input id="${name}" name="${name}" type="${type}" aria-required="true"></div>`;
  pages.set(base, `<!doctype html><html><head><meta charset="utf-8"><title>Job Application for ${ROLE} at Acme Example</title></head><body>
<main><h1>${ROLE}</h1><p>Atlanta, GA</p>
<form id="application-form" action="/acme/jobs/${id}/applications" method="post" enctype="multipart/form-data">
  ${field("first_name", "First Name")}${field("last_name", "Last Name")}${field("email", "Email")}
  <div class="field"><label for="phone">Phone</label><input id="phone" name="phone" type="tel"></div>
  <div class="field" id="resume_fieldset"><label for="resume">Resume/CV<span class="asterisk">*</span></label><input id="resume" name="resume" type="file" aria-required="true"></div>
  <button id="submit" type="submit">Submit application</button>
</form></main></body></html>`);
  pages.set(`${base}/confirmation`, `<!doctype html><html><head><meta charset="utf-8"><title>Application received</title></head><body>
<main><h1>Thank you for applying.</h1><p>Your application has been received.</p></main></body></html>`);
  redirects.set(`${base}/applications`, `/acme/jobs/${id}/confirmation`);
  return { url: `https://${base}`, post: `${base}/applications`, path: `/acme/jobs/${id}` };
}

const certDir = mkdtempSync(path.join(tmpdir(), "ap-e2e-cert-"));
try {
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", path.join(certDir, "key.pem"), "-out",
    path.join(certDir, "cert.pem"), "-days", "1", "-subj", "/CN=localhost", "-addext", `subjectAltName=DNS:${LEVER_HOST},DNS:${GH_HOST}`],
  { stdio: "ignore" });
} catch {
  console.error("This test needs openssl to make a throwaway certificate for the local ATS server.");
  process.exit(2);
}
const server = https.createServer({ key: readFileSync(path.join(certDir, "key.pem")), cert: readFileSync(path.join(certDir, "cert.pem")) }, (req, res) => {
  const key = `${(req.headers.host || "").split(":")[0]}${req.url.split("?")[0]}`;
  if (req.method === "POST") {
    posts.set(key, postsTo(key) + 1);
    req.resume();
    req.on("end", () => {
      res.writeHead(redirects.has(key) ? 303 : 404, redirects.has(key) ? { location: redirects.get(key) } : {});
      res.end();
    });
    return;
  }
  const html = pages.get(key);
  res.writeHead(html ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
  res.end(html ?? "Not found");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

// ---- the dashboard page: the bridge contract from app/extension-bridge.ts, without React ---------------------

const DASHBOARD_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>ApplyPilot</title></head><body><h1>ApplyPilot (test)</h1>
<script>
(() => {
  const CHANNEL = "applypilot";
  const waiting = new Map();
  window.__log = [];
  const post = (type, payload, replyTo) => {
    const id = crypto.randomUUID();
    window.postMessage({ channel: CHANNEL, v: 1, from: "dashboard", type, id, ...(replyTo ? { replyTo } : {}), payload }, location.origin);
    return id;
  };
  const ask = (type, payload = {}, ms = 90000) => new Promise((resolve, reject) => {
    const id = post(type, payload);
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error(type + " got no answer")); }, ms);
    waiting.set(id, (reply) => { clearTimeout(timer); resolve(reply); });
  });
  const postJson = (url, body) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  let syncing = false, again = false;
  async function sync() {
    if (syncing) { again = true; return; }
    syncing = true;
    try {
      do {
        again = false;
        const { results = [] } = await ask("AP_PULL_RESULTS");
        for (let i = 0; i < results.length; i += 20) {
          const response = await postJson("/api/submissions/results", { results: results.slice(i, i + 20) });
          if (!response.ok) return; // not acked, so Chrome keeps them
          const body = await response.json();
          const ids = [...body.acked, ...body.rejected.map((r) => r.resultId).filter(Boolean)];
          if (ids.length) await ask("AP_RESULTS_ACK", { resultIds: ids });
        }
      } while (again);
    } finally { syncing = false; }
  }
  window.addEventListener("message", async (event) => {
    const d = event.data;
    if (event.source !== window || event.origin !== location.origin) return;
    if (!d || d.channel !== CHANNEL || d.v !== 1 || d.from !== "extension" || typeof d.type !== "string") return;
    window.__log.push(d.type);
    if (typeof d.replyTo === "string") {
      const handle = waiting.get(d.replyTo);
      if (handle) { waiting.delete(d.replyTo); handle(d.payload); }
      return;
    }
    if (d.type === "AP_READY" || d.type === "AP_RESULTS_WAITING") sync().catch(() => {});
    if (d.type === "AP_CLAIM") {
      let result;
      try {
        const response = await postJson("/api/submissions/claim", d.payload);
        result = response.ok ? await response.json() : { ok: false, reason: "network" };
      } catch { result = { ok: false, reason: "network" }; }
      post("AP_CLAIM_RESULT", result, d.id);
    }
  });
  window.__hello = () => ask("AP_HELLO", {}, 5000);
  window.__send = (batch) => ask("AP_BATCH", { batch });
  window.__resume = () => ask("AP_RESUME");
})();
</script></body></html>`;

// Another page on the dashboard's origin without the page hook (an API response, a page still loading). bridge.js
// runs there too, but no claim may go to it: nothing there would answer.
const STRAY_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>ApplyPilot</title></head><body><pre>{"error":"Not found"}</pre>
<script>
  window.__claims = 0;
  window.addEventListener("message", (e) => {
    const d = e.data;
    if (d && d.channel === "applypilot" && d.from === "extension" && d.type === "AP_CLAIM") window.__claims++;
  });
</script></body></html>`;

// ---- the browser -------------------------------------------------------------------------------------------

const userDir = mkdtempSync(path.join(tmpdir(), "ap-e2e-profile-"));
const context = await chromium.launchPersistentContext(userDir, {
  ...(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {}),
  headless: !process.env.HEADED,
  ignoreHTTPSErrors: true,
  args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`, "--no-proxy-server", "--ignore-certificate-errors",
    `--host-resolver-rules=MAP ${LEVER_HOST} 127.0.0.1:${port}, MAP ${GH_HOST} 127.0.0.1:${port}, EXCLUDE localhost`],
});
const pageErrors = [];
context.on("page", (p) => p.on("pageerror", (e) => pageErrors.push(`${p.url()}: ${e.message}`)));

await context.route(`${DASHBOARD}/**`, async (route) => {
  const req = route.request();
  const url = new URL(req.url());
  if (req.method() === "GET" && url.pathname === "/") return route.fulfill({ contentType: "text/html", body: DASHBOARD_HTML });
  if (req.method() === "GET" && url.pathname === "/stray") return route.fulfill({ contentType: "text/html", body: STRAY_HTML });
  if (req.method() !== "POST" || !url.pathname.startsWith("/api/submissions/")) return route.fulfill({ status: 404, body: "Not found" });
  if (!/^application\/json\s*(;|$)/i.test(req.headers()["content-type"] ?? "")) return route.fulfill({ status: 415, json: { error: "Send JSON." } });
  try {
    const body = req.postDataJSON();
    if (url.pathname === "/api/submissions/claim") {
      const result = await store.claimSubmission(db, OWNER, body);
      claims.push({ approvalId: body.approvalId, result });
      return route.fulfill({ json: result });
    }
    if (url.pathname === "/api/submissions/results") return route.fulfill({ json: await store.recordResults(db, OWNER, body.results) });
    return route.fulfill({ status: 404, body: "Not found" });
  } catch (e) {
    return route.fulfill({ status: e?.status ?? 500, json: { error: String(e?.message ?? e) } });
  }
});

let worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker", { timeout: 15000 }).catch(() => null));
if (!worker) {
  console.error("The extension didn't load in this Chromium. Run it headed: HEADED=1 node scripts/test-extension-e2e.mjs");
  await context.close();
  server.close();
  process.exit(2);
}
const extensionId = new URL(worker.url()).host;
async function extStorage() {
  try {
    return await worker.evaluate(() => chrome.storage.local.get(null));
  } catch {
    worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
    return worker.evaluate(() => chrome.storage.local.get(null));
  }
}
const jobState = async (approvalId) => (await extStorage())[`apJob:${approvalId}`]?.state;

const dash = await context.newPage();
await dash.goto(`${DASHBOARD}/`);
const hello = await dash.evaluate(() => window.__hello());
assert.equal(hello.version, "3.1.1", "the bridge answers on the dashboard origin");

async function until(check, what, ms = 150000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(250);
  }
}

async function approve(appIds) {
  const result = await store.approveForSubmit(db, OWNER, appIds.map((applicationId) => ({ applicationId, revision: 1 })), { includeCoverLetter: true });
  assert.deepEqual(result.skipped, []);
  return result.approved;
}
async function batchFor(approved) {
  const applications = approved.map(({ applicationId }) => {
    const a = sqlite.prepare("SELECT * FROM applications WHERE id = ?").get(applicationId);
    return { id: a.id, company: a.company, role: a.role, tailoredJson: a.tailored_json, tailoredAt: a.tailored_at, tailoredRevision: a.tailored_revision };
  });
  const { batch, skipped } = await buildBatch({ approved, applications, savedProfile: savedProfile(), settings: await store.loadSettings(db, OWNER) });
  assert.deepEqual(skipped, []);
  return batch;
}
const send = (batch) => dash.evaluate((b) => window.__send(b), batch);

function findPage(urlPart) {
  return context.pages().find((p) => !p.isClosed() && p.url().includes(urlPart)) ?? null;
}

// ---- scenarios ---------------------------------------------------------------------------------------------

const steps = [];
const step = (name, f) => steps.push([name, f]);

let stray = null;
step("supervised: nothing is sent until you click Submit, then it's recorded as yours", async () => {
  // Opened after the dashboard, so it is the newest dashboard-origin tab; the claim still goes to the dashboard.
  stray = await context.newPage();
  await stray.goto(`${DASHBOARD}/stray`);
  await dash.bringToFront();
  const job = greenhouseJob("4012345");
  addApplication("app-gh", job.url);
  const [item] = await approve(["app-gh"]);
  const reply = await send(await batchFor([item]));
  assert.deepEqual(reply, { accepted: [item.approvalId], rejected: [] });
  const form = await until(async () => {
    const p = findPage(job.path);
    const outline = p ? await p.evaluate(() => document.querySelector("#submit")?.style.outline || "").catch(() => "") : "";
    return outline.includes("solid") ? p : null;
  }, "the highlighted Submit button");
  await sleep(2500);
  assert.equal(postsTo(job.post), 0, "no POST before you click");
  assert.equal(row(item.approvalId).state, "claimed");
  assert.equal(row(item.approvalId).claim_mode, "supervised");
  clickedByTest.add(job.post);
  await form.click("#submit");
  await until(() => row(item.approvalId).state === "submitted", "the submission to be recorded");
  assert.equal(postsTo(job.post), 1);
  assert.equal(row(item.approvalId).clicked_by, "you");
  assert.equal(appStatus("app-gh"), "applied");
  // Your click is in Chrome's ledger too, so no re-approval of this job can be clicked before the server hears of it.
  const ledger = (await extStorage())[`apLedger:${item.jobKey}`];
  assert.deepEqual([ledger?.approvalId, ledger?.mode, ledger?.outcome], [item.approvalId, "you", "submitted"]);
  assert.ok(events(item.approvalId).includes("calibrated"), "your click on the checked form, confirmed: it counts toward automatic clicks");
  assert.equal(await stray.evaluate(() => window.__claims), 0, "the tab without the page hook never got the claim");
});

let autoJob = null;
step("auto enabled after 3 confirmed supervised submissions: a clean job gets exactly 1 POST and is submitted", async () => {
  // Two earlier supervised Lever submissions you clicked yourself, plus one more below, unlock automatic clicks there.
  for (let i = 0; i < 3; i++) {
    const id = randomUUID();
    sqlite.prepare(`INSERT INTO submissions (id, owner_email, application_id, job_key, ats, apply_url, tailored_revision, profile_hash,
      state, approved_at, expires_at, claim_mode, clicked_by, updated_at) VALUES (?, ?, ?, ?, 'lever', '', 1, '', 'submitted', ?, ?, 'supervised', 'you', ?)`)
      .run(id, OWNER, `old-${i}`, `lever:old:${i}`, "2026-09-01T00:00:00.000Z", "2026-09-02T00:00:00.000Z", "2026-09-01T00:00:00.000Z");
    sqlite.prepare(`INSERT INTO submission_events (id, owner_email, submission_id, at, actor, event, detail_json)
      VALUES (?, ?, ?, ?, 'server', 'calibrated', '{}')`).run(`${id}:calibrated`, OWNER, id, "2026-09-01T00:00:00.000Z");
  }
  await store.saveSettings(db, OWNER, { auto: { greenhouse: false, lever: true, ashby: false }, dailyCap: 10, allowInvisibleCaptcha: true, allowOptionalSensitiveBlank: true });
  const job = leverJob(randomUUID());
  addApplication("app-auto", job.url);
  const [item] = await approve(["app-auto"]);
  const batch = await batchFor([item]);
  assert.deepEqual(await send(batch), { accepted: [item.approvalId], rejected: [] });
  assert.deepEqual(await send(batch), { accepted: [item.approvalId], rejected: [] }, "the same batch again, while queued, is a no-op");
  await until(() => row(item.approvalId).state === "submitted", "the automatic submission");
  assert.equal(postsTo(job.post), 1);
  assert.equal(row(item.approvalId).claim_mode, "auto");
  assert.equal(row(item.approvalId).clicked_by, "applypilot");
  assert.equal(appStatus("app-auto"), "applied");
  assert.equal(claims.filter((c) => c.approvalId === item.approvalId).length, 1);
  assert.equal((await extStorage())[`apLedger:${item.jobKey}`]?.approvalId, item.approvalId);
  autoJob = { job, item, batch };
});

step("re-sending the same batch after it was submitted adds no POST and no new result", async () => {
  assert.ok(autoJob, "needs the automatic submission above");
  const before = events(autoJob.item.approvalId).length;
  assert.deepEqual(await send(autoJob.batch), { accepted: [autoJob.item.approvalId], rejected: [] });
  await sleep(13000); // longer than the runner's start countdown
  assert.equal(postsTo(autoJob.job.post), 1);
  assert.equal(events(autoJob.item.approvalId).length, before);
  assert.equal(await jobState(autoJob.item.approvalId), "done:submitted");
});

step("a new approval for a job ApplyPilot already clicked is refused by the server and by Chrome", async () => {
  assert.ok(autoJob, "needs the automatic submission above");
  const again = await store.approveForSubmit(db, OWNER, [{ applicationId: "app-auto", revision: 1 }], { includeCoverLetter: true });
  assert.equal(again.approved.length, 0);
  // Chrome's own ledger refuses it even if a forged item gets past the server.
  const forged = { ...autoJob.batch, batchId: randomUUID(), jobs: [{ ...autoJob.batch.jobs[0], approvalId: randomUUID() }] };
  const reply = await send(forged);
  assert.deepEqual(reply.accepted, []);
  assert.match(reply.rejected[0].reason, /already pressed Submit/);
  assert.equal(postsTo(autoJob.job.post), 1);
});

let passwordJob = null;
step("blocked forms get 0 POSTs, no claim, and the right reason; the tab stays open for you", async () => {
  const blocked = [
    ["app-pw", leverJob(randomUUID(), `<li><label><div>Create a password</div><input type="password" name="password"></label></li>`), "password_field"],
    ["app-eeo", leverJob(randomUUID(), `<li><label><div>Gender<span class="required">✱</span></div><select name="eeo[gender]" required>
      <option value="">Select…</option><option>Female</option><option>Male</option><option>Decline to self-identify</option></select></label></li>`), "demographic"],
    ["app-robot", leverJob(randomUUID(), `<li><p>Before you apply, confirm: I'm not a robot</p></li>`), "captcha"],
  ];
  for (const [id, job] of blocked) addApplication(id, job.url);
  const items = await approve(blocked.map(([id]) => id));
  const reply = await send(await batchFor(items));
  assert.deepEqual(reply.accepted.sort(), items.map((i) => i.approvalId).sort());
  for (const [index, [, job, code]] of blocked.entries()) {
    const id = items[index].approvalId;
    await until(() => row(id).state === "needs_you", `needs you on ${code}`);
    assert.ok(reasonCodes(id).includes(code), `${code} in ${reasonCodes(id)}`);
    assert.equal(postsTo(job.post), 0);
    assert.equal(claims.filter((c) => c.approvalId === id).length, 0);
    assert.ok(findPage(job.path), "the filled tab stays open");
  }
  passwordJob = { job: blocked[0][1], item: items[0] };
});

step("you finish a needs-you tab yourself: a second result records it as submitted by you", async () => {
  assert.ok(passwordJob, "needs the blocked forms above");
  const p = findPage(passwordJob.job.path);
  await p.fill("input[name=password]", "a-password-you-chose");
  clickedByTest.add(passwordJob.job.post);
  await p.click("#btn-submit");
  await until(() => row(passwordJob.item.approvalId).state === "submitted", "your own submission to be recorded");
  assert.equal(postsTo(passwordJob.job.post), 1, "only your click");
  assert.equal(row(passwordJob.item.approvalId).clicked_by, "you");
  assert.equal(row(passwordJob.item.approvalId).claim_mode, "", "never claimed, so it doesn't count toward unlocking automatic clicks");
  // Your click is recorded at once (check, by you), so the job is held even if no confirmation is ever seen.
  assert.deepEqual(events(passwordJob.item.approvalId).filter((e) => e.startsWith("result:")), ["result:needs_you", "result:check", "result:submitted"]);
});

step("an approval you revoke before the claim gets 0 POSTs and its tab is closed", async () => {
  const job = leverJob(randomUUID());
  addApplication("app-revoke", job.url);
  const [item] = await approve(["app-revoke"]);
  assert.deepEqual((await store.cancelSubmissions(db, OWNER, [item.approvalId])).revoked, [item.approvalId]);
  assert.deepEqual(await send(await batchFor([item])), { accepted: [item.approvalId], rejected: [] });
  await until(async () => (await jobState(item.approvalId)) === "done:cancelled", "the cancelled job", 200000);
  assert.equal(postsTo(job.post), 0);
  assert.deepEqual(claims.filter((c) => c.approvalId === item.approvalId).map((c) => c.result), [{ ok: false, reason: "revoked" }]);
  assert.equal(row(item.approvalId).state, "revoked");
  await until(() => !findPage(job.path), "the tab to close", 10000);
});

step("Pause in the countdown, then Resume sending on the dashboard: the run starts again and waits for your click", async () => {
  const job = greenhouseJob("4012399");
  addApplication("app-resume", job.url);
  const [item] = await approve(["app-resume"]);
  assert.deepEqual(await send(await batchFor([item])), { accepted: [item.approvalId], rejected: [] });
  const runner = await until(() => findPage(`chrome-extension://${extensionId}/runner.html`), "the runner page", 20000);
  await runner.locator("#pause").click({ timeout: 15000 });
  await until(async () => (await extStorage()).apRun?.pausedReason === "countdown", "the countdown pause", 20000);
  await sleep(1500);
  assert.equal(claims.filter((c) => c.approvalId === item.approvalId).length, 0, "nothing claimed while paused");
  assert.notEqual((await extStorage()).apHalt, true, "Stop was never pressed, so resuming changes nothing in apHalt");
  await dash.evaluate(() => window.__resume());
  const form = await until(async () => {
    const p = findPage(job.path);
    const outline = p ? await p.evaluate(() => document.querySelector("#submit")?.style.outline || "").catch(() => "") : "";
    return outline.includes("solid") ? p : null;
  }, "the highlighted Submit button after resuming");
  clickedByTest.add(job.post);
  await form.click("#submit");
  await until(() => row(item.approvalId).state === "submitted", "the resumed submission");
  assert.equal(postsTo(job.post), 1);
  assert.equal(row(item.approvalId).clicked_by, "you");
});

step("closing the runner while it submits gives check on reopening, at most 1 POST, never a second click", async () => {
  const job = leverJob(randomUUID());
  addApplication("app-crash", job.url);
  const [item] = await approve(["app-crash"]);
  assert.deepEqual(await send(await batchFor([item])), { accepted: [item.approvalId], rejected: [] });
  // The automatic claim waits a minute after the last one, then the ledger is written before the click.
  await until(async () => ["submitting", "observing"].includes(await jobState(item.approvalId)), "the submit step", 200000);
  const runnerUrl = `chrome-extension://${extensionId}/runner.html`;
  for (const p of context.pages().filter((p) => p.url() === runnerUrl)) await p.close();
  const reopened = await context.newPage();
  await reopened.goto(runnerUrl);
  await until(() => events(item.approvalId).some((e) => e.startsWith("result:")), "the recovered result", 60000);
  assert.equal(events(item.approvalId).find((e) => e.startsWith("result:")), "result:check");
  assert.ok(postsTo(job.post) <= 1, `at most one POST (got ${postsTo(job.post)})`);
  assert.equal((await extStorage())[`apLedger:${item.jobKey}`]?.approvalId, item.approvalId, "the ledger outlives the crash");
  await sleep(3000);
  assert.ok(postsTo(job.post) <= 1);
  assert.equal(claims.filter((c) => c.approvalId === item.approvalId).length, 1, "claimed once, never again");
});

// ---- run ---------------------------------------------------------------------------------------------------

let failed = 0;
for (const [name, f] of steps) {
  try {
    await f();
    console.log(`ok - ${name}`);
  } catch (e) {
    failed++;
    console.log(`not ok - ${name}\n  ${String(e?.stack || e).split("\n").slice(0, 6).join("\n  ")}`);
  }
}
const byTest = [...clickedByTest].reduce((n, key) => n + postsTo(key), 0);
console.log(`form POSTs: ${totalPosts()}, ${byTest} of them from the test clicking Submit as you`);
if (pageErrors.length) console.log(`page errors:\n  ${pageErrors.join("\n  ")}`);
await context.close();
server.close();
rmSync(userDir, { recursive: true, force: true });
rmSync(certDir, { recursive: true, force: true });
console.log(`${steps.length - failed}/${steps.length} passed`);
process.exit(failed ? 1 : 0);
