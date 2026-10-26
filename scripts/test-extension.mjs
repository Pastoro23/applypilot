// Browser checks for the extension's page library (extension/page-lib.js). Needs Playwright and Chromium:
//   PLAYWRIGHT=/path/to/playwright/index.mjs CHROMIUM=/path/to/chromium node scripts/test-extension.mjs
// The synthetic fixture pages in scripts/fixtures/ are served at ATS-shaped URLs by request interception,
// so nothing is fetched from the network.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const { chromium } = await import(process.env.PLAYWRIGHT || "playwright");
const LIB = fileURLToPath(new URL("../extension/page-lib.js", import.meta.url));
const FIXTURES = new URL("./fixtures/", import.meta.url);
const fixture = (name) => readFile(new URL(name, FIXTURES), "utf8");
const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});

// ---- manual assistant (popup) ----------------------------------------------------------------------

async function run(html, profile, advance = false) {
  const page = await browser.newPage();
  await page.setContent(html);
  await page.addScriptTag({ path: LIB });
  const out = await page.evaluate(
    async ([profile, advance]) => {
      const clicked = [];
      let submitted = false;
      document.addEventListener("click", (e) => {
        const t = e.target.closest("button,input,a");
        if (t) clicked.push(t.id);
      }, true);
      document.querySelectorAll("form").forEach((f) => f.addEventListener("submit", (e) => {
        e.preventDefault();
        submitted = true;
      }));
      const res = await globalThis.__applypilot.assistant(profile, null, advance);
      const vals = {};
      document.querySelectorAll("input,select,textarea").forEach((f) => {
        if (f.id) vals[f.id] = ["checkbox", "radio"].includes(f.type) ? f.checked : f.value;
      });
      return { res, vals, clicked, submitted };
    },
    [profile, advance],
  );
  await page.close();
  return out;
}

const jobs = [
  { company: "Acme Health", title: "Help Desk Tech", startYear: "2022", current: true },
  { company: "Beta Corp", title: "IT Intern", startYear: "2020", endYear: "2021" },
];
const base = { firstName: "Test", lastName: "Person", email: "t@example.com", city: "Grayson", workHistory: jobs };
const radios = (name, legend) =>
  `<fieldset><legend>${legend}</legend><label><input type=radio name=${name} id=${name}y value=Yes>Yes</label><label><input type=radio name=${name} id=${name}n value=No>No</label></fieldset>`;
const tests = [];
const test = (name, f) => tests.push([name, f]);

test("work section never fills passwords or attestations", async () => {
  const r = await run(
    `<section><h2>Work Experience</h2>
     <label for=company>Company</label><input id=company>
     <label for=pw>Company portal password</label><input id=pw type=password name=company_password>
     <label><input id=attest type=checkbox> I certify that all information is current and accurate</label></section>`,
    base,
  );
  assert.equal(r.vals.company, "Acme Health");
  assert.equal(r.vals.pw, "");
  assert.equal(r.vals.attest, false);
});

test("a real current-job box is still ticked", async () => {
  const r = await run(
    `<section><h2>Work Experience</h2><label for=c>Company</label><input id=c>
     <label><input id=cur type=checkbox> I currently work here</label></section>`,
    base,
  );
  assert.equal(r.vals.cur, true);
});

test("job city is not filled with home city", async () => {
  const r = await run(
    `<section><h2>Work Experience</h2><label for=c>Company</label><input id=c><label for=jc>City</label><input id=jc></section>`,
    base,
  );
  assert.equal(r.vals.jc, "");
});

test("unsure authorization goes to the user", async () => {
  const r = await run(radios("a", "Are you legally authorized to work in the US?"), {
    ...base,
    workAuthorization: "I'm not sure whether I'm authorized",
  });
  assert.equal(r.vals.ay || r.vals.an, false);
  assert.ok(r.res.blockers.some((b) => /authorization/i.test(b)));
});

test("clear authorization answers Yes", async () => {
  const r = await run(radios("a", "Are you legally authorized to work in the US?"), { ...base, workAuthorized: true });
  assert.equal(r.vals.ay, true);
});

test("'without sponsorship' question is answered Yes when none is needed", async () => {
  const r = await run(radios("s", "Can you work without visa sponsorship?"), { ...base, sponsorship: "No sponsorship required" });
  assert.equal(r.vals.sy, true);
});

test("'will you require sponsorship' is answered No when none is needed", async () => {
  const r = await run(radios("s", "Will you now or in the future require visa sponsorship?"), { ...base, requiresSponsorship: false });
  assert.equal(r.vals.sn, true);
});

test("'will you require sponsorship' is answered Yes when needed", async () => {
  const r = await run(radios("s", "Will you now or in the future require visa sponsorship?"), { ...base, requiresSponsorship: true });
  assert.equal(r.vals.sy, true);
});

test("an unfamiliar visa question goes to the user", async () => {
  const r = await run(radios("s", "Which visa type do you hold?"), { ...base, requiresSponsorship: false });
  assert.equal(r.vals.sy || r.vals.sn, false);
  assert.ok(r.res.blockers.length);
});

test("dashboard 'confirm' placeholders are not used as answers", async () => {
  const r = await run(radios("s", "Will you require sponsorship?"), {
    ...base,
    sponsorship: "No sponsorship expected — confirm before first application",
  });
  assert.equal(r.vals.sy || r.vals.sn, false);
});

test("a Continue button that submits the form is never pressed", async () => {
  const r = await run(`<form action=/apply method=post><input id=x><button id=cont type=submit>Continue</button></form>`, base, true);
  assert.equal(r.submitted, false);
  assert.equal(r.res.advanced, false);
  assert.equal(r.res.canAdvance, false);
});

test("Next is not pressed on a final-step page", async () => {
  const r = await run(`<p>By clicking Next you certify your answers.</p><button id=n type=button>Next</button>`, base, true);
  assert.equal(r.res.advanced, false);
});

test("a plain Next button is pressed", async () => {
  const r = await run(`<input id=x><button id=n type=button>Next</button>`, base, true);
  assert.equal(r.res.advanced, true);
  assert.deepEqual(r.clicked, ["n"]);
});

test("two employers in one section get their own records", async () => {
  const r = await run(
    `<section><h2>Employment History</h2>
     <div><label for=c1>Company</label><input id=c1><label for=t1>Job title</label><input id=t1></div>
     <div><label for=c2>Company</label><input id=c2><label for=t2>Job title</label><input id=t2></div></section>`,
    base,
  );
  assert.deepEqual([r.vals.c1, r.vals.t1, r.vals.c2, r.vals.t2], ["Acme Health", "Help Desk Tech", "Beta Corp", "IT Intern"]);
});

test("separate employer sections still map one record each", async () => {
  const r = await run(
    `<section><h2>Work Experience 1</h2><label for=c1>Company</label><input id=c1></section>
     <section><h2>Work Experience 2</h2><label for=c2>Company</label><input id=c2></section>`,
    base,
  );
  assert.deepEqual([r.vals.c1, r.vals.c2], ["Acme Health", "Beta Corp"]);
});

// ---- batch functions on synthetic ATS fixtures -------------------------------------------------------

const URLS = {
  greenhouse: "https://job-boards.greenhouse.io/acme/jobs/4012345",
  lever: "https://jobs.lever.co/acme/0f6e1c2a-1111-4222-8333-944455556666/apply",
  ashby: "https://jobs.ashbyhq.com/acme/5b0c7d1e-2222-4333-8444-a55566667777/application",
};
const KEYS = {
  greenhouse: "greenhouse:acme:4012345",
  lever: "lever:acme:0f6e1c2a-1111-4222-8333-944455556666",
  ashby: "ashby:acme:5b0c7d1e-2222-4333-8444-a55566667777",
};
const PDF = Buffer.from("%PDF-1.4\n% synthetic fixture resume\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n");
const RESUME = {
  name: "Test_Person_Resume.pdf",
  type: "application/pdf",
  size: PDF.length,
  sha256: createHash("sha256").update(PDF).digest("hex"),
  b64: PDF.toString("base64"),
};
const PROFILE = {
  schemaVersion: 2,
  firstName: "Test",
  lastName: "Person",
  fullName: "Test Person",
  email: "t@example.com",
  phone: "555-010-0199",
  city: "Grayson",
  state: "GA",
  postalCode: "30017",
  country: "United States",
  linkedIn: "https://www.linkedin.com/in/test-person",
  workAuthorized: true,
  requiresSponsorship: false,
  skills: ["Windows", "Active Directory"],
  workHistory: [],
  education: [],
};
const COVER = "Dear hiring team, I would like to apply for the Help Desk Technician role.";
const job = (ats, extra = {}) => ({
  approvalId: "8a6c1f0e-3b2d-4c5e-9f70-112233445566",
  jobKey: KEYS[ats],
  ats,
  role: "Help Desk Technician",
  company: "Acme Example",
  profile: PROFILE,
  resume: { name: RESUME.name, type: RESUME.type, size: RESUME.size, sha256: RESUME.sha256 },
  ...extra,
});
const RESUME_FIELD = `<div class="field" id="resume_fieldset"><label id="upload-label-resume" for="resume">Resume/CV<span class="asterisk">*</span></label><input id="resume" name="resume" type="file" class="visually-hidden" aria-required="true"><div class="file-status" id="resume-status"></div></div>`;
const SUBMITS = {
  greenhouse: `<button id="submit" type="submit">Submit application</button>`,
  lever: `<button type="submit" class="template-btn-submit" id="btn-submit" data-qa="btn-submit">Submit application</button>`,
  ashby: `<button type="submit" id="submit" class="ashby-application-form-submit-button">Submit Application</button>`,
};
const field = (id, label, control) => `<div class="field"><label for="${id}">${label}</label>${control}</div>`;

const bundles = new Map();
// Bundles a React fixture with vite from the repo's own react and react-dom (bridge-hook.js also takes the
// dashboard's real extension-bridge.ts).
function bundle(name) {
  if (!bundles.has(name))
    bundles.set(
      name,
      (async () => {
        const { build } = await import("vite");
        const out = await build({
          configFile: false,
          logLevel: "silent",
          root: fileURLToPath(FIXTURES),
          define: { "process.env.NODE_ENV": '"production"' },
          build: {
            write: false,
            minify: true,
            rollupOptions: { input: fileURLToPath(new URL(name, FIXTURES)), output: { format: "iife", entryFileNames: name } },
          },
        });
        return (Array.isArray(out) ? out[0] : out).output[0].code;
      })(),
    );
  return bundles.get(name);
}
const ASSETS = {
  "/assets/combobox.js": () => fixture("combobox.js"),
  "/assets/greenhouse-remix.js": () => fixture("greenhouse-remix.js"),
  "/assets/react-form.js": () => bundle("react-form.js"),
  "/assets/bridge-hook.js": () => bundle("bridge-hook.js"),
};

async function page(ats, slots = {}) {
  let html = await fixture(`${ats}.html`);
  for (const k of ["head", "top", "fields", "after", "script"]) html = html.replace(`<!--slot:${k}-->`, () => slots[k] || "");
  return html.replace("{{resume}}", () => slots.resume ?? RESUME_FIELD).replace("{{submit}}", () => slots.submit ?? SUBMITS[ats]);
}

async function open(url, pages) {
  const p = await browser.newPage();
  await p.addInitScript(() => {
    window.__sent = [];
    window.chrome = window.chrome || {};
    window.chrome.runtime = { sendMessage: (m) => void window.__sent.push(m) };
  });
  await p.route("**/*", async (route) => {
    const u = route.request().url().split("#")[0];
    if (pages[u] !== undefined) return route.fulfill({ contentType: "text/html", body: pages[u] });
    const asset = ASSETS[new URL(u).pathname];
    if (asset) return route.fulfill({ contentType: "application/javascript", body: await asset() });
    if (/\.js(\?|$)/.test(u)) return route.fulfill({ contentType: "application/javascript", body: "" });
    return route.fulfill({ contentType: "text/html", body: "<!doctype html><title>frame</title>" });
  });
  await p.goto(url);
  await p.addScriptTag({ path: LIB });
  return p;
}

// The runner passes the approved job's company and whether its posting is in the U.S.; these fixtures are.
const findAndFill = (p, ats, { profile = PROFILE, resume = RESUME, coverLetter = COVER, company = "Acme Example", usPosting = true, allowPrivacyAck = false } = {}) =>
  p.evaluate(
    async ([ats, profile, resume, coverLetter, company, usPosting, allowPrivacyAck]) => {
      const ap = globalThis.__applypilot;
      const form = await ap.findForm({ ats, timeoutMs: 5000 });
      const filled = await ap.fill({ profile, resume, coverLetter, ats, company, usPosting, allowPrivacyAck });
      return { form, filled };
    },
    [ats, profile, resume, coverLetter, company, usPosting, allowPrivacyAck],
  );
const auditPage = (p, j, settings = {}) => p.evaluate(([j, settings]) => globalThis.__applypilot.audit({ job: j, settings }), [j, settings]);

async function prepare(ats, slots = {}, { settings = {}, jobExtra = {}, pages = {}, html, profile = PROFILE, fill = {} } = {}) {
  const p = await open(URLS[ats], { [URLS[ats]]: html ?? (await page(ats, slots)), ...pages });
  try {
    const { form, filled } = await findAndFill(p, ats, { profile, ...fill });
    const audit = await auditPage(p, job(ats, { profile, ...jobExtra }), settings);
    return { page: p, form, filled, audit };
  } catch (e) {
    await p.close();
    throw e;
  }
}
const codes = (a) => a.blockers.map((b) => b.code);
const values = (p) =>
  p.evaluate(() => {
    const v = {};
    document.querySelectorAll("input,select,textarea").forEach((f) => {
      const k = f.id || f.name;
      if (k) v[k] = ["checkbox", "radio"].includes(f.type) ? f.checked : f.type === "file" ? f.files.length : f.value;
    });
    return v;
  });
async function using(pending, f) {
  const prepared = await pending;
  try {
    return await f(prepared);
  } finally {
    await prepared.page.close();
  }
}
const press = (p, fp) =>
  p.evaluate((fp) => {
    const r = globalThis.__applypilot.pressSubmit(fp);
    return { r, submits: window.__submits, clicks: window.__clicks.slice() };
  }, fp);

test("clean Greenhouse-like form: every rule passes and pressSubmit clicks exactly once", () =>
  using(prepare("greenhouse"), async ({ page: p, form, filled, audit }) => {
    assert.equal(form.ok, true);
    assert.equal(form.multiStep, false);
    assert.deepEqual(codes(audit), []);
    assert.deepEqual(audit.relaxations, []);
    assert.equal(audit.submit.label, "Submit application");
    assert.equal(audit.resumeVerifiedBy, "file");
    const src = Object.fromEntries(filled.filled.map((x) => [x.label, x.source]));
    assert.deepEqual(src, { "Resume/CV": "resume", "First Name": "profile", "Last Name": "profile", Email: "profile", Phone: "profile", "LinkedIn Profile": "profile" });
    const v = await values(p);
    assert.deepEqual([v.first_name, v.last_name, v.email, v.phone, v.question_1001, v.resume], ["Test", "Person", "t@example.com", "555-010-0199", PROFILE.linkedIn, 1]);
    assert.ok(audit.report.some((r) => r.label === "Email" && r.required && r.source === "profile"));
    const out = await p.evaluate((fp) => {
      const ap = globalThis.__applypilot;
      const first = ap.pressSubmit(fp);
      const second = ap.pressSubmit(fp);
      return { first, second, submits: window.__submits, clicks: window.__clicks.filter((x) => x === "submit").length, flag: document.documentElement.dataset.applypilotSubmitted };
    }, audit.fingerprint);
    assert.deepEqual(out.first, { clicked: true });
    assert.equal(out.second.clicked, false);
    assert.equal(out.second.reason, "already_clicked");
    assert.equal(out.submits, 1);
    assert.equal(out.clicks, 1);
    assert.ok(out.flag);
  }));

test("clean Lever-like form: full name and LinkedIn filled, comments and company left alone", () =>
  using(prepare("lever"), async ({ page: p, audit }) => {
    assert.deepEqual(codes(audit), []);
    const v = await values(p);
    assert.deepEqual([v.name, v.email, v.phone, v["urls[LinkedIn]"], v.org, v.comments], ["Test Person", "t@example.com", "555-010-0199", PROFILE.linkedIn, "", ""]);
  }));

test("client-rendered Ashby-like form is found; Yes/No buttons answered and verified", () =>
  using(prepare("ashby"), async ({ page: p, form, filled, audit }) => {
    assert.equal(form.ok, true);
    assert.deepEqual(codes(audit), []);
    const s = await p.evaluate(() => ({
      auth: [...document.querySelectorAll("#q-auth button")].map((b) => b.getAttribute("aria-pressed")),
      spon: [...document.querySelectorAll("#q-spon button")].map((b) => b.getAttribute("aria-pressed")),
      autofill: document.getElementById("autofill-upload").files.length,
      resume: document.getElementById("_systemfield_resume").files.length,
    }));
    assert.deepEqual(s, { auth: ["true", "false"], spon: ["false", "true"], autofill: 0, resume: 1 });
    assert.equal(filled.filled.filter((x) => x.source === "eligibility").length, 2);
  }));

test("a password field blocks", () =>
  using(prepare("greenhouse", { fields: field("pw", "Create a password", `<input id="pw" type="password">`) }), async ({ page: p, audit }) => {
    assert.ok(codes(audit).includes("password_field"));
    assert.equal((await values(p)).pw, "");
  }));

test("a visible reCAPTCHA challenge blocks even with invisible CAPTCHAs allowed", () =>
  using(
    prepare("greenhouse", {
      after: `<div style="position:absolute;top:120px;left:40px"><iframe title="recaptcha challenge expires in two minutes" src="https://www.google.com/recaptcha/api2/bframe?hl=en&k=abc" width="400" height="580"></iframe></div>`,
    }),
    async ({ audit }) => assert.deepEqual(codes(audit), ["captcha"]),
  ));

test("a visible hCaptcha checkbox blocks", () =>
  using(
    prepare("greenhouse", {
      fields: `<iframe src="https://newassets.hcaptcha.com/captcha/v1/abc/static/hcaptcha.html#frame=checkbox&id=0abc" width="303" height="78"></iframe>`,
    }),
    async ({ audit }) => assert.deepEqual(codes(audit), ["captcha"]),
  ));

test("'I'm not a robot' wording counts as a visible challenge", () =>
  using(prepare("greenhouse", { fields: `<div class="captcha-box"><span>I'm not a robot</span></div>` }), async ({ audit }) => assert.deepEqual(codes(audit), ["captcha"])));

test("an invisible reCAPTCHA (badge, script, hidden challenge frame) passes by default, recorded; blocks with the setting off", () =>
  using(
    prepare("greenhouse", {
      head: `<script src="https://www.google.com/recaptcha/api.js?render=abc"></script>`,
      after: `<div class="grecaptcha-badge" style="width:256px;height:60px;position:fixed;bottom:14px;right:-186px"></div><div style="visibility:hidden;position:absolute;top:-10000px"><iframe src="https://www.google.com/recaptcha/api2/bframe?hl=en&k=abc" width="400" height="580"></iframe></div>`,
    }),
    async ({ page: p, audit }) => {
      assert.deepEqual(codes(audit), []);
      assert.deepEqual(audit.relaxations, ["invisible_captcha"]);
      const strict = await auditPage(p, job("greenhouse"), { allowInvisibleCaptcha: false });
      assert.deepEqual(codes(strict), ["captcha"]);
    },
  ));

test("a sign-in wall blocks", () =>
  using(prepare("greenhouse", { top: `<div class="notice"><p>Sign in to apply for this job.</p></div>` }), async ({ audit }) =>
    assert.deepEqual(codes(audit), ["account_required"]),
  ));

test("a required attestation checkbox blocks and is never ticked", () =>
  using(
    prepare("greenhouse", {
      fields: `<div class="field"><label><input type="checkbox" id="certify" name="certify" required> I certify that the information in this application is true and complete.</label></div>`,
    }),
    async ({ page: p, audit }) => {
      assert.ok(codes(audit).includes("attestation"));
      assert.equal((await values(p)).certify, false);
    },
  ));

test("a typed-name signature is never filled with your name and blocks", () =>
  using(
    prepare("lever", {
      fields: `<li class="application-question"><label><div class="application-label">Type your full name as your signature</div><div class="application-field"><input type="text" name="cards[sig][field0]" id="sig"></div></label></li>`,
    }),
    async ({ page: p, audit }) => {
      assert.deepEqual(codes(audit), ["attestation"]);
      assert.equal((await values(p)).sig, "");
    },
  ));

test("'by submitting you certify' wording blocks", () =>
  using(prepare("greenhouse", { fields: `<p>By submitting this application, you certify that everything in it is accurate.</p>` }), async ({ audit }) =>
    assert.deepEqual(codes(audit), ["attestation"]),
  ));

test("an optional consent box stays unticked and a privacy notice is only recorded", () =>
  using(
    prepare("greenhouse", {
      fields: `<div class="field"><label><input type="checkbox" id="marketing" name="marketing"> I agree to receive emails about future openings</label></div><p>We use your personal data as described in our privacy notice.</p>`,
    }),
    async ({ page: p, audit }) => {
      assert.deepEqual(codes(audit), []);
      assert.equal((await values(p)).marketing, false);
      assert.ok(audit.report.some((r) => r.type === "notice" && /privacy notice/.test(r.value)));
    },
  ));

const GENDER = (req) =>
  field("gender", `Gender${req ? '<span class="asterisk">*</span>' : ""}`, `<select id="gender" name="gender"${req ? ' aria-required="true"' : ""}><option value="">Please select</option><option value="1">Male</option><option value="2">Female</option><option value="3">Decline to self-identify</option></select>`);

test("an optional EEO select is left blank and passes by default; blocks with the setting off", () =>
  using(prepare("greenhouse", { fields: GENDER(false) }), async ({ page: p, audit }) => {
    assert.deepEqual(codes(audit), []);
    assert.deepEqual(audit.relaxations, ["optional_sensitive_blank"]);
    assert.equal((await values(p)).gender, "");
    assert.ok(audit.report.some((r) => r.label === "Gender" && r.value === "" && r.source === ""));
    const strict = await auditPage(p, job("greenhouse"), { allowOptionalSensitiveBlank: false });
    assert.deepEqual(codes(strict), ["demographic"]);
  }));

test("a required EEO select always blocks", () =>
  using(prepare("greenhouse", { fields: GENDER(true) }), async ({ page: p, audit }) => {
    assert.deepEqual(codes(audit), ["demographic"]);
    assert.equal((await values(p)).gender, "");
  }));

test("a required salary question blocks and stays empty", () =>
  using(
    prepare("greenhouse", { fields: field("question_2001", 'What are your salary expectations?<span class="asterisk">*</span>', `<input id="question_2001" name="question_2001" type="text" aria-required="true">`) }),
    async ({ page: p, audit }) => {
      assert.deepEqual(codes(audit), ["sensitive_question"]);
      assert.equal((await values(p)).question_2001, "");
    },
  ));

test("an unknown required select and an asterisk-only required field block", () =>
  using(
    prepare("greenhouse", {
      fields:
        field("question_3001", 'How did you hear about us?<span class="asterisk">*</span>', `<select id="question_3001" name="question_3001"><option value="">Select</option><option>Job board</option><option>Friend</option></select>`) +
        field("question_3002", "Portfolio URL*", `<input id="question_3002" name="question_3002" type="text">`),
    }),
    async ({ audit }) => {
      assert.deepEqual(codes(audit), ["unanswered_required", "unanswered_required"]);
      assert.match(audit.blockers[0].text, /How did you hear about us\?/);
      assert.match(audit.blockers[1].text, /Portfolio URL/);
    },
  ));

test("a Next button means a multi-page form", () =>
  using(prepare("greenhouse", { fields: `<button type="button" id="next">Next</button>` }), async ({ form, audit }) => {
    assert.equal(form.multiStep, true);
    assert.deepEqual(codes(audit), ["multi_step"]);
  }));

test("zero, two, or an outside decoy Submit button all block, and pressSubmit refuses", async () => {
  const cases = [
    { submit: "" },
    { submit: `${SUBMITS.greenhouse}<button id="submit2" type="submit">Submit</button>` },
    { after: `<form id="newsletter"><label for="nl">Email me news</label><input id="nl" type="email"><button id="nl-submit" type="submit">Submit</button></form>` },
  ];
  await Promise.all(
    cases.map((slots) =>
      using(prepare("greenhouse", slots), async ({ page: p, audit }) => {
        assert.ok(codes(audit).includes("no_or_ambiguous_submit"), JSON.stringify(audit.blockers));
        assert.equal(audit.submit, null);
        const out = await press(p, audit.fingerprint);
        assert.equal(out.r.clicked, false);
        assert.equal(out.submits, 0);
      }),
    ),
  );
});

test("'Apply with LinkedIn', 'Autofill with MyGreenhouse' and the autofill uploader are never used", () =>
  using(
    prepare("greenhouse", {
      fields: `<div class="autofill"><button type="button" id="mygh">Autofill with MyGreenhouse</button><button type="button" id="apply-linkedin">Apply with LinkedIn</button><label for="autofill_resume">Autofill from resume</label><input type="file" id="autofill_resume"></div>`,
    }),
    async ({ page: p, audit }) => {
      assert.deepEqual(codes(audit), []);
      const v = await values(p);
      assert.equal(v.autofill_resume, 0);
      assert.equal(v.resume, 1);
      const clicks = await p.evaluate(() => window.__clicks);
      assert.ok(!clicks.includes("mygh") && !clicks.includes("apply-linkedin"));
    },
  ));

test("a wrong file name, size or hash is not this job's resume", () =>
  using(prepare("greenhouse"), async ({ page: p, audit }) => {
    assert.deepEqual(codes(audit), []);
    for (const resume of [
      { ...job("greenhouse").resume, name: "Other_Resume.pdf" },
      { ...job("greenhouse").resume, size: RESUME.size + 1 },
      { ...job("greenhouse").resume, sha256: "0".repeat(64) },
    ]) {
      const a = await auditPage(p, job("greenhouse", { resume }));
      assert.deepEqual(codes(a), ["resume_mismatch"]);
      assert.equal((await press(p, a.fingerprint)).r.clicked, false);
    }
  }));

test("a required cover-letter file blocks", () =>
  using(
    prepare("greenhouse", { fields: field("cover_letter", 'Cover Letter<span class="asterisk">*</span>', `<input id="cover_letter" name="cover_letter" type="file" aria-required="true">`) }),
    async ({ filled, audit }) => {
      assert.ok(filled.blockers.some((b) => b.code === "cover_letter_file_required"));
      assert.deepEqual(codes(audit), ["cover_letter_file_required"]);
    },
  ));

test("React 19 controlled form: the setter reaches React state and the values hold", async () => {
  const html = await fixture("react.html");
  const p = await open(URLS.greenhouse, { [URLS.greenhouse]: html });
  try {
    await p.waitForSelector("#first_name");
    await findAndFill(p, "greenhouse");
    const a = await auditPage(p, job("greenhouse"));
    assert.deepEqual(codes(a), []);
    const st = await p.evaluate(() => window.__reactState);
    assert.deepEqual(st, { first_name: "Test", last_name: "Person", email: "t@example.com", phone: "555-010-0199" });
  } finally {
    await p.close();
  }
});

test("a value reset by a React re-render after filling blocks", async () => {
  const html = await fixture("react.html");
  const p = await open(URLS.greenhouse, { [URLS.greenhouse]: html });
  try {
    await p.waitForSelector("#first_name");
    await findAndFill(p, "greenhouse");
    await p.evaluate(() => window.__rerenderPhone());
    const a = await auditPage(p, job("greenhouse"));
    assert.deepEqual(codes(a), ["value_reset"]);
    assert.match(a.blockers[0].text, /Phone/);
  } finally {
    await p.close();
  }
});

test("a field added between the two audits makes the form unstable", async () => {
  const html = await page("greenhouse", {
    script: `<script>window.__startAdding = () => { let n = 0; const t = setInterval(() => { if (++n > 30) return clearInterval(t); const d = document.createElement("div"); d.className = "field"; d.innerHTML = '<label for="extra' + n + '">Extra ' + n + '</label><input id="extra' + n + '">'; document.getElementById("submit").before(d); }, 700); };</script>`,
  });
  const p = await open(URLS.greenhouse, { [URLS.greenhouse]: html });
  try {
    await findAndFill(p, "greenhouse");
    await p.evaluate(() => window.__startAdding());
    const a = await auditPage(p, job("greenhouse"));
    assert.deepEqual(codes(a), ["unstable_form"]);
  } finally {
    await p.close();
  }
});

test("wrong role, wrong job, closed posting, framed form and visible errors are caught", async () => {
  await using(prepare("greenhouse", {}, { jobExtra: { role: "Network Engineer" } }), async ({ audit }) => assert.deepEqual(codes(audit), ["wrong_page"]));
  await using(prepare("greenhouse", {}, { jobExtra: { jobKey: "greenhouse:acme:999" } }), async ({ audit }) => assert.deepEqual(codes(audit), ["wrong_page"]));
  await using(prepare("greenhouse", { fields: `<div class="field-error" role="alert">Please enter a valid phone number</div>` }), async ({ audit }) =>
    assert.deepEqual(codes(audit), ["validation_errors"]),
  );
  const closed = await open(URLS.greenhouse, { [URLS.greenhouse]: `<!doctype html><title>Acme Example</title><h1>Help Desk Technician</h1><p>This job is no longer accepting applications.</p>` });
  try {
    const f = await closed.evaluate(() => globalThis.__applypilot.findForm({ ats: "greenhouse", timeoutMs: 3000 }));
    assert.equal(f.ok, false);
    assert.equal(f.reason, "closed");
  } finally {
    await closed.close();
  }
  const framed = await open(URLS.greenhouse, {
    [URLS.greenhouse]: `<!doctype html><title>Careers</title><iframe id="grnhse_iframe" src="https://job-boards.greenhouse.io/embed/job_app?for=acme&token=4012345" width="800" height="600"></iframe>`,
  });
  try {
    const f = await framed.evaluate(() => globalThis.__applypilot.findForm({ ats: "greenhouse", timeoutMs: 1500 }));
    assert.deepEqual([f.ok, f.reason, f.inIframe], [false, "form_in_iframe", true]);
  } finally {
    await framed.close();
  }
});

const combo = ([id, label, opts, filter = ""]) =>
  `<div class="field" data-combobox='${JSON.stringify(opts)}'${filter ? ` data-filter="${filter}"` : ""}><label for="${id}">${label}<span class="asterisk">*</span></label><div class="select__control"><div class="select__value-container"><div class="select__placeholder">Select...</div><div class="select__input-container"><input id="${id}" role="combobox" aria-haspopup="true" aria-expanded="false" aria-required="true" autocomplete="off"></div></div></div><input type="hidden" name="${id}" value=""></div>`;
const COMBOS = [
  ["country", "Country", ["United States", "United States Minor Outlying Islands", "Canada", "United Kingdom"]],
  ["question_4001", "Are you legally authorized to work in the United States?", ["Yes", "No"]],
  ["question_4002", "Will you now or in the future require visa sponsorship?", ["Yes", "No"]],
]
  .map(combo)
  .join("");

test("react-select-like comboboxes with a portal listbox are chosen exactly and read back", () =>
  using(prepare("greenhouse", { fields: COMBOS, script: `<script src="/assets/combobox.js"></script>` }), async ({ page: p, filled, audit }) => {
    assert.deepEqual(codes(audit), []);
    const shown = await p.evaluate(() => [...document.querySelectorAll(".select__single-value")].map((x) => x.textContent));
    assert.deepEqual(shown, ["United States", "Yes", "No"]);
    const hidden = await p.evaluate(() => [...document.querySelectorAll("input[type=hidden]")].map((x) => x.value));
    assert.deepEqual(hidden, ["United States", "Yes", "No"]);
    assert.deepEqual(
      filled.filled.filter((x) => x.type === "combobox").map((x) => [x.value, x.source]),
      [["United States", "profile"], ["Yes", "eligibility"], ["No", "eligibility"]],
    );
  }));

test("a required location autocomplete takes the one option for your city and state", () =>
  using(
    prepare("greenhouse", {
      fields: combo(["candidate-location", "Location (City)", ["Grayson, Georgia, United States", "Grayson, Kentucky, United States", "Graysonia, Arkansas, United States"], "city"]),
      script: `<script src="/assets/combobox.js"></script>`,
    }),
    async ({ page: p, filled, audit }) => {
      assert.deepEqual(codes(audit), []);
      assert.equal(await p.evaluate(() => document.querySelector(".select__single-value")?.textContent), "Grayson, Georgia, United States");
      assert.ok(filled.filled.some((x) => x.label === "Location (City)" && x.source === "profile"));
    },
  ));

// Greenhouse's newer form: react-select dropdowns for the phone country, location, education and screening
// questions, each with a hidden required input, and a Privacy Policy box that stays with you.
const EDU_PROFILE = {
  ...PROFILE,
  education: [{ school: "Georgia Piedmont Technical College", degree: "A.A.S. Information Technology", field: "", startYear: "2019", endYear: "2021" }],
};
const remix = (profile = EDU_PROFILE, opts = {}) => fixture("greenhouse-remix.html").then((html) => prepare("greenhouse", {}, { html, profile, ...opts }));
const PRIVACY_BOX = "question_9601409101[]_71316806101";
const singles = (p) =>
  p.evaluate(() => Object.fromEntries([...document.querySelectorAll("input.select__input")].map((i) => [i.id, i.closest(".select-shell").querySelector(".select__single-value")?.textContent || ""])));

test("Greenhouse's newer form: profile dropdowns, location and education are filled; only the privacy box is left", () =>
  using(remix(), async ({ page: p, filled, audit }) => {
    assert.deepEqual(await singles(p), {
      country: "United States +1",
      "candidate-location": "Grayson, Georgia, United States",
      "school--0": "Georgia Piedmont Technical College",
      "degree--0": "Associate's Degree",
      "discipline--0": "Information Technology",
      question_9601406101: "United States",
      question_9601407101: "Georgia",
    });
    const v = await values(p);
    assert.deepEqual([v.first_name, v.last_name, v.email, v.phone, v["start-year--0"], v["end-year--0"], v.question_9601408101], ["Test", "Person", "t@example.com", "555-010-0199", "2019", "2021", PROFILE.linkedIn]);
    assert.deepEqual(codes(audit), ["attestation"]);
    assert.equal(filled.blockers.length, 0, JSON.stringify(filled.blockers));
  }));

test("Greenhouse's newer form: what can't be answered is named by its own label, never the hidden input or the result count", () =>
  using(remix({ ...PROFILE, city: "Nowhere", education: [{ school: "Unknown School", degree: "Certificate in Welding", field: "", startYear: "", endYear: "" }] }), async ({ page: p, audit }) => {
    const texts = audit.blockers.map((b) => b.text);
    for (const t of texts) assert.doesNotMatch(t, /results found|: text$/i);
    for (const label of ["Location (City)", "Degree", "Discipline", "Start date year"]) assert.ok(texts.some((t) => t.endsWith(`: ${label}`)), `${label} in ${texts}`);
    assert.ok(!texts.some((t) => /School$/.test(t)));
    assert.equal((await singles(p))["degree--0"], "");
  }));

test("Greenhouse's newer form: outside the U.S. the state question gets the not-in-the-U.S. answer", () =>
  using(remix({ ...EDU_PROFILE, country: "Canada", state: "", city: "" }), async ({ page: p }) => {
    const s = await singles(p);
    assert.equal(s.question_9601406101, "Canada");
    assert.equal(s.question_9601407101, "I am not located in the United States");
    assert.equal(s.country, "Canada +1");
  }));

test("Greenhouse's newer form: names cleared by a late re-render are typed again before the check", () =>
  using(
    fixture("greenhouse-remix.html").then((html) =>
      prepare("greenhouse", {}, {
        profile: EDU_PROFILE,
        // Like a page whose own state was still empty: the first re-render after the location is chosen wipes the names.
        html: html.replace(
          "<!--slot:script-->",
          `<script>
            new MutationObserver((_, mo) => {
              if (!document.querySelector("#react-select-candidate-location-placeholder")?.isConnected) {
                mo.disconnect();
                setTimeout(() => ["first_name", "last_name", "email"].forEach((id) => (document.getElementById(id).value = "")), 1800);
              }
            }).observe(document.body, { subtree: true, childList: true });
          </script>`,
        ),
      }),
    ),
    async ({ page: p, audit }) => {
      const v = await values(p);
      assert.deepEqual([v.first_name, v.last_name, v.email], ["Test", "Person", "t@example.com"]);
      assert.ok(!codes(audit).includes("unanswered_required"), JSON.stringify(audit.blockers));
    },
  ));

// The page reads the resume and resets the form a few seconds after the file is taken, the way Greenhouse's
// autofill from a resume does; every answer must still be there when the form is checked.
const remixWith = (cfg, opts = {}) =>
  fixture("greenhouse-remix.html").then((html) =>
    prepare("greenhouse", {}, {
      profile: EDU_PROFILE,
      settings: { allowPrivacyAck: true },
      fill: { allowPrivacyAck: true },
      ...opts,
      html: html.replace("<!--slot:script-->", () => `<script>window.__remix = ${JSON.stringify(cfg)};</script>`),
    }),
  );
const ALL_FILLED = {
  country: "United States +1",
  "candidate-location": "Grayson, Georgia, United States",
  "school--0": "Georgia Piedmont Technical College",
  "degree--0": "Associate's Degree",
  "discipline--0": "Information Technology",
  question_9601406101: "United States",
  question_9601407101: "Georgia",
};
for (const [name, cfg] of [
  ["in place, soon after the upload", { parseAfterMs: 2500, parsedFirstName: "PASTOR" }],
  ["in place, while the dropdowns are being chosen", { parseAfterMs: 6000 }],
  ["with new elements (a re-mount)", { parseAfterMs: 3000, remount: true, parsedFirstName: "PASTOR" }],
])
  test(`Greenhouse's newer form: a page that resets the form after reading the resume ${name} gets every answer again`, () =>
    using(remixWith(cfg), async ({ page: p, filled, audit }) => {
      assert.equal(await p.evaluate(() => window.__parsed), 1);
      assert.deepEqual(await singles(p), ALL_FILLED);
      const v = await values(p);
      assert.deepEqual([v.first_name, v.last_name, v.email, v.phone, v["start-year--0"], v["end-year--0"], v[PRIVACY_BOX]], ["Test", "Person", "t@example.com", "555-010-0199", "2019", "2021", true]);
      assert.deepEqual(codes(audit), [], JSON.stringify(audit.blockers));
      // A re-mounted input may or may not keep the file; either way the widget must show it.
      assert.ok(["file", "chip"].includes(audit.resumeVerifiedBy), audit.resumeVerifiedBy);
      assert.equal(filled.blockers.length, 0, JSON.stringify(filled.blockers));
    }));

test("Greenhouse's newer form: a resume the page never took is not counted as attached", () =>
  using(remixWith({ ignoreChange: true }), async ({ page: p, filled, audit }) => {
    assert.equal(await p.evaluate(() => window.__resumeTaken || 0), 0);
    assert.ok(filled.blockers.some((b) => b.code === "resume_not_attached"), JSON.stringify(filled.blockers));
    assert.ok(codes(audit).includes("resume_not_attached"), JSON.stringify(audit.blockers));
  }));

test("Greenhouse's newer form: when the hidden input ignores the file, dropping it on the upload box works", () =>
  using(remixWith({ ignoreChange: true, acceptDrop: true }), async ({ page: p, audit }) => {
    assert.equal(await p.evaluate(() => window.__resumeTaken || 0), 1);
    assert.deepEqual(codes(audit), [], JSON.stringify(audit.blockers));
  }));

test("privacy-policy box: ticked under the setting and listed with the submission", () =>
  using(remix(EDU_PROFILE, { settings: { allowPrivacyAck: true }, fill: { allowPrivacyAck: true } }), async ({ page: p, filled, audit }) => {
    assert.deepEqual(codes(audit), []);
    assert.deepEqual(audit.relaxations, ["privacy_ack"]);
    assert.equal((await values(p))[PRIVACY_BOX], true);
    assert.ok(filled.filled.some((x) => x.source === "privacy_ack" && x.type === "checkbox"));
  }));

test("privacy-policy box: with the setting off it stays unticked and goes to you", () =>
  using(remix(EDU_PROFILE, { settings: { allowPrivacyAck: false }, fill: { allowPrivacyAck: false } }), async ({ page: p, audit }) => {
    assert.deepEqual(codes(audit), ["attestation"]);
    assert.equal((await values(p))[PRIVACY_BOX], false);
  }));

test("privacy-policy box: a dashboard that never offered the setting leaves it to you, and says why", () =>
  using(remix(EDU_PROFILE, { settings: {}, fill: {} }), async ({ page: p, audit }) => {
    assert.deepEqual(codes(audit), ["attestation"]);
    assert.match(audit.blockers[0].text, /^The privacy-policy box is left for you \(ApplyPilot's privacy-box setting is off\): /);
    assert.equal((await values(p))[PRIVACY_BOX], false);
    assert.deepEqual(audit.relaxations, []);
  }));

test("privacy-policy box: ticked under a setting that was then turned off still goes to you", () =>
  using(remix(EDU_PROFILE, { settings: { allowPrivacyAck: false }, fill: { allowPrivacyAck: true } }), async ({ audit }) => {
    assert.deepEqual(codes(audit), ["attestation"]);
    assert.deepEqual(audit.relaxations, []);
  }));

for (const [name, legend] of [
  ["certify", "I certify the above is true and agree to the Privacy Policy."],
  ["terms", "I have read and agree to the Privacy Policy and Terms of Service."],
  ["contact", "I agree to the Privacy Policy and consent to be contacted by SMS."],
  ["sharing", "I acknowledge the Privacy Policy and agree that my data may be shared with third parties."],
])
  test(`privacy-policy box: one that also covers ${name} still goes to you`, () =>
    using(
      prepare(
        "greenhouse",
        {
          fields: `<fieldset class="checkbox" id="q[]" aria-required="true"><legend>${legend} <span class="required">*</span></legend><input type="checkbox" required id="ack" name="q[]" value="1"><label for="ack">Yes</label></fieldset>`,
        },
        { fill: { allowPrivacyAck: true } },
      ),
      async ({ page: p, audit }) => {
        assert.ok(codes(audit).includes("attestation"));
        assert.ok(!audit.relaxations.includes("privacy_ack"));
        assert.equal((await values(p)).ack, false);
      },
    ));

test("a required plain-text location with no suggestions is left empty for you", () =>
  using(prepare("greenhouse", { fields: field("location", 'Location<span class="asterisk">*</span>', `<input id="location" name="location" type="text" aria-required="true">`) }), async ({ page: p, filled, audit }) => {
    assert.ok(filled.blockers.some((b) => b.code === "unanswered_required"));
    assert.deepEqual(codes(audit), ["unanswered_required"]);
    assert.equal((await values(p)).location, "");
  }));

test("Lever-like radios are answered from your Yes/No choices; optional EEO questions stay blank", () =>
  using(
    prepare("lever", {
      fields: `<li class="application-question"><fieldset><legend>Are you legally authorized to work in the United States?<span class="required">✱</span></legend><label><input type="radio" name="cards[abc][field0]" id="auth-yes" value="Yes" required>Yes</label><label><input type="radio" name="cards[abc][field0]" id="auth-no" value="No">No</label></fieldset></li>
        <li class="application-question"><label><div class="application-label">Gender</div><div class="application-field"><select name="eeo[gender]" id="eeo-gender"><option value="">Select ...</option><option>Female</option><option>Male</option><option>Decline to self-identify</option></select></div></label></li>
        <li class="application-question"><fieldset><legend>Veteran status</legend><label><input type="radio" name="eeo[veteran]" id="vet-yes" value="yes">I am a veteran</label><label><input type="radio" name="eeo[veteran]" id="vet-no" value="no">I am not a veteran</label></fieldset></li>`,
    }),
    async ({ page: p, audit }) => {
      assert.deepEqual(codes(audit), []);
      assert.deepEqual(audit.relaxations, ["optional_sensitive_blank"]);
      const v = await values(p);
      assert.deepEqual([v["auth-yes"], v["auth-no"], v["eeo-gender"], v["vet-yes"], v["vet-no"]], [true, false, "", false, false]);
    },
  ));

test("the cover letter box and work history are filled from approved sources", () =>
  using(
    prepare(
      "greenhouse",
      {
        fields:
          field("cover_letter_text", "Cover Letter", `<textarea id="cover_letter_text" name="cover_letter_text"></textarea>`) +
          `<div class="employment"><h3>Employment</h3>${field("company_0", 'Company name<span class="asterisk">*</span>', `<input id="company_0" aria-required="true">`)}${field("title_0", "Title", `<input id="title_0">`)}</div>`,
      },
      { profile: { ...PROFILE, workHistory: jobs } },
    ),
    async ({ page: p, filled, audit }) => {
      assert.deepEqual(codes(audit), []);
      const v = await values(p);
      assert.deepEqual([v.cover_letter_text, v.company_0, v.title_0], [COVER, "Acme Health", "Help Desk Tech"]);
      const src = Object.fromEntries(filled.filled.map((x) => [x.label, x.source]));
      assert.deepEqual([src["Cover Letter"], src["Company name"], src.Title], ["cover_letter", "record", "record"]);
    },
  ));

test("a personal question inside the work history section is never filled as a record", () =>
  using(
    prepare(
      "greenhouse",
      {
        fields: `<div class="employment"><h3>Employment</h3>${field("company_0", "Company name", `<input id="company_0">`)}${field("org_0", "Organization you self-identify with", `<input id="org_0">`)}</div>`,
      },
      { profile: { ...PROFILE, workHistory: jobs } },
    ),
    async ({ page: p, filled, audit }) => {
      assert.deepEqual(codes(audit), []);
      const v = await values(p);
      assert.deepEqual([v.company_0, v.org_0], ["Acme Health", ""]);
      assert.ok(!filled.filled.some((x) => /self-identify/.test(x.label)));
    },
  ));

test("a disabled Submit is waited on; one that stays disabled blocks", async () => {
  await using(prepare("greenhouse", { script: `<script>document.getElementById("submit").disabled = true;</script>` }), async ({ audit }) =>
    assert.deepEqual(codes(audit), ["submit_disabled"]),
  );
  const html = await page("greenhouse", { script: `<script>const s = document.getElementById("submit"); s.disabled = true; window.__enableLater = () => setTimeout(() => (s.disabled = false), 3000);</script>` });
  const p = await open(URLS.greenhouse, { [URLS.greenhouse]: html });
  try {
    await findAndFill(p, "greenhouse");
    await p.evaluate(() => window.__enableLater());
    assert.deepEqual(codes(await auditPage(p, job("greenhouse"))), []);
  } finally {
    await p.close();
  }
});

test("an adapter hint that disagrees with the generic Submit detection blocks", () =>
  using(prepare("greenhouse", { fields: `<button type="submit" id="upload-btn">Upload</button>` }), async ({ audit }) => assert.deepEqual(codes(audit), ["adapter_mismatch"])));

test("already-applied text, another required file and a site-chosen required answer block", () =>
  Promise.all([
    using(prepare("greenhouse", { top: `<p class="flash">You have already applied for this job.</p>` }), async ({ audit }) => assert.deepEqual(codes(audit), ["already_applied"])),
    using(prepare("greenhouse", { fields: field("portfolio_file", 'Portfolio<span class="asterisk">*</span>', `<input id="portfolio_file" type="file" aria-required="true">`) }), async ({ audit }) =>
      assert.deepEqual(codes(audit), ["other_file_required"]),
    ),
    using(
      prepare("greenhouse", {
        fields: field("question_5001", 'How did you hear about us?<span class="asterisk">*</span>', `<select id="question_5001" aria-required="true"><option value="referral" selected>Referral</option><option value="board">Job board</option></select>`),
      }),
      async ({ audit }) => assert.deepEqual(codes(audit), ["site_value_on_required"]),
    ),
  ]));

test("Yes/No buttons without a pressed state are never clicked and block", () =>
  using(
    prepare("ashby", {
      fields: `<div class="field-entry" id="q-right"><label>Do you have the legal right to work in the United States?*</label><div class="plain-pair"><button type="button" id="ry">Yes</button><button type="button" id="rn">No</button></div></div>`,
    }),
    async ({ page: p, filled, audit }) => {
      assert.ok(filled.blockers.some((b) => b.code === "unverifiable_choice"));
      assert.deepEqual(codes(audit), ["unverifiable_choice"]);
      const clicks = await p.evaluate(() => window.__clicks);
      assert.ok(!clicks.includes("ry") && !clicks.includes("rn"), clicks.join(","));
    },
  ));

const DROP_RESUME = `<div class="field" id="resume_fieldset"><label for="resume">Resume/CV<span class="asterisk">*</span></label><div class="drop-zone" id="resume-drop"><p>Drag and drop your file here</p><input id="resume" name="resume" type="file" class="visually-hidden" data-upload="drop" aria-required="true"></div><div id="resume-chip"></div></div>`;
const DROP_SCRIPT = `<script>
  const zone = document.getElementById("resume-drop"), input = document.getElementById("resume"), chip = document.getElementById("resume-chip");
  window.__dropped = 0;
  zone.addEventListener("dragover", (e) => e.preventDefault());
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    window.__dropped++;
    input.value = "";
    chip.innerHTML = '<span class="spinner">Uploading…</span>';
    setTimeout(() => { chip.textContent = ""; const s = document.createElement("span"); s.className = "chip"; s.textContent = f.name; chip.append(s); }, 400);
  });
</script>`;

test("a drop zone gets the file once and the chip proves the upload", () =>
  using(prepare("greenhouse", { resume: DROP_RESUME, script: DROP_SCRIPT }), async ({ page: p, audit }) => {
    assert.deepEqual(codes(audit), []);
    assert.equal(audit.resumeVerifiedBy, "chip");
    assert.equal(await p.evaluate(() => window.__dropped), 1);
  }));

test("a Lever-style parser that rewrites name and email is corrected by the identity pass", () =>
  using(
    prepare("lever", {
      script: `<script>document.querySelector("input[name=resume]").addEventListener("change", () => setTimeout(() => {
        document.querySelector("input[name=name]").value = "Parsed Name";
        document.querySelector("input[name=email]").value = "parsed@example.org";
      }, 1000));</script>`,
    }),
    async ({ page: p, filled, audit }) => {
      assert.deepEqual(codes(audit), []);
      const v = await values(p);
      assert.deepEqual([v.name, v.email], ["Test Person", "t@example.com"]);
      const src = Object.fromEntries(filled.filled.map((x) => [x.label, x.source]));
      assert.deepEqual([src["Full name"], src.Email], ["profile", "profile"]);
    },
  ));

test("pressSubmit refuses a stale fingerprint or a blocker that appeared after the audit", () =>
  using(prepare("greenhouse"), async ({ page: p, audit }) => {
    assert.deepEqual(codes(audit), []);
    const stale = await press(p, "00000000");
    assert.deepEqual([stale.r.clicked, stale.r.reason], [false, "fingerprint_changed"]);
    await p.evaluate(() => document.getElementById("submit").before(Object.assign(document.createElement("input"), { type: "password", id: "late-pw" })));
    const late = await press(p, audit.fingerprint);
    assert.deepEqual([late.r.clicked, late.r.reason], [false, "password_field"]);
    assert.equal(late.submits, 0);
    assert.ok(!late.clicks.includes("submit"));
  }));

test("supervised mode highlights Submit, reports your own click and never clicks itself", () =>
  using(prepare("greenhouse"), async ({ page: p, audit }) => {
    const armed = await p.evaluate((fp) => globalThis.__applypilot.armSupervised(fp), audit.fingerprint);
    assert.equal(armed.armed, true);
    assert.equal(armed.submit.label, "Submit application");
    assert.ok(await p.evaluate(() => !!document.getElementById("applypilot-banner")));
    await p.waitForTimeout(300);
    assert.equal(await p.evaluate(() => window.__submits), 0);
    await p.click("#submit");
    const after = await p.evaluate((fp) => ({
      sent: window.__sent,
      submits: window.__submits,
      clicked: globalThis.__applypilot.clicked,
      again: globalThis.__applypilot.pressSubmit(fp),
    }), audit.fingerprint);
    const ev = after.sent.find((m) => m.type === "AP_PAGE_EVENT" && m.kind === "peter_click");
    assert.ok(ev, JSON.stringify(after.sent));
    assert.equal(ev.fingerprint, audit.fingerprint);
    assert.equal(ev.matches, true);
    assert.equal(after.submits, 1);
    assert.equal(after.clicked, false);
    assert.deepEqual([after.again.clicked, after.again.reason], [false, "already_clicked"]);
  }));

const outcome = (p, ats, waitMs = 8000) => p.evaluate(([ats, waitMs]) => globalThis.__applypilot.readOutcome({ ats, waitMs }), [ats, waitMs]);
async function pressThrough(p, fp) {
  // A click that navigates may tear down the page's context before the call returns; that still counts as clicked.
  try {
    return (await press(p, fp)).r;
  } catch {
    return { clicked: true };
  }
}

test("readOutcome: a /confirmation URL with thank-you text is submitted", async () => {
  const confirm = `${URLS.greenhouse}/confirmation`;
  await using(
    prepare("greenhouse", { script: `<script>window.addEventListener("fixture-submit", () => { location.href = "/acme/jobs/4012345/confirmation"; });</script>` }, {
      pages: { [confirm]: await fixture("greenhouse-confirmation.html") },
    }),
    async ({ page: p, audit }) => {
      assert.deepEqual(codes(audit), []);
      assert.equal((await pressThrough(p, audit.fingerprint)).clicked, true);
      await p.waitForURL(confirm);
      await p.addScriptTag({ path: LIB });
      const r = await outcome(p, "greenhouse");
      assert.deepEqual([r.outcome, r.confirmationKind, r.url], ["submitted", "url", confirm]);
      assert.match(r.confirmationText, /Thank you for applying/);
    },
  );
});

test("readOutcome: a Lever /thanks URL is submitted", async () => {
  const thanks = URLS.lever.replace(/\/apply$/, "/thanks");
  const p = await open(thanks, { [thanks]: await fixture("lever-thanks.html") });
  try {
    const r = await outcome(p, "lever");
    assert.deepEqual([r.outcome, r.confirmationKind], ["submitted", "url"]);
    assert.match(r.confirmationText, /Application submitted/);
  } finally {
    await p.close();
  }
});

test("readOutcome: Ashby-style in-page success is submitted, marked in-page only", () =>
  using(prepare("ashby"), async ({ page: p, audit }) => {
    assert.deepEqual(codes(audit), []);
    assert.deepEqual((await press(p, audit.fingerprint)).r, { clicked: true });
    const r = await outcome(p, "ashby");
    assert.deepEqual([r.outcome, r.confirmationKind], ["submitted", "in_page_only"]);
    assert.match(r.confirmationText, /Thank you for applying/);
  }));

test("readOutcome: errors after Submit, a code step, and silence are each 'check'", async () => {
  const cases = [
    [
      `<script>window.addEventListener("fixture-submit", () => { const ph = document.getElementById("phone"); ph.setAttribute("aria-invalid", "true"); const e = document.createElement("div"); e.className = "field-error"; e.textContent = "Please enter a valid phone number"; ph.after(e); });</script>`,
      "form_errors",
      8000,
    ],
    [
      `<script>window.addEventListener("fixture-submit", () => { document.querySelector("main").innerHTML = '<h2>Check your email</h2><p>Enter the verification code we sent to your email address.</p><input id="code">'; });</script>`,
      "challenge",
      8000,
    ],
    ["", "no_confirmation", 2500],
  ];
  await Promise.all(
    cases.map(([script, code, waitMs]) =>
      using(prepare("greenhouse", { script }), async ({ page: p, audit }) => {
        assert.deepEqual((await press(p, audit.fingerprint)).r, { clicked: true });
        const r = await outcome(p, "greenhouse", waitMs);
        assert.deepEqual([r.outcome, r.code], ["check", code]);
        assert.ok(r.reason);
      }),
    ),
  );
});

test("watchForConfirmation reports when you submit a needs-you tab yourself", () =>
  using(prepare("greenhouse", { fields: GENDER(true) }), async ({ page: p, audit }) => {
    assert.deepEqual(codes(audit), ["demographic"]);
    await p.evaluate(() => globalThis.__applypilot.watchForConfirmation());
    await p.click("#submit");
    await p.evaluate(() => {
      document.querySelector("main").innerHTML = "<h1>Thank you for applying.</h1><p>Your application has been received.</p>";
    });
    await p.waitForFunction(() => window.__sent.some((m) => m.kind === "confirmed"), null, { timeout: 5000 });
    const ev = await p.evaluate(() => window.__sent.find((m) => m.kind === "confirmed"));
    assert.equal(ev.type, "AP_PAGE_EVENT");
    assert.match(ev.text, /Thank you for applying/);
  }));

test("bannerNeedsYou shows reasons as plain text and outlines the fields", () =>
  using(
    prepare("greenhouse", { fields: field("question_2001", 'What are your salary expectations?<span class="asterisk">*</span>', `<input id="question_2001" type="text" aria-required="true">`) }),
    async ({ page: p, audit }) => {
      const r = await p.evaluate(
        (reasons) => globalThis.__applypilot.bannerNeedsYou(reasons),
        [...audit.blockers, { code: "x", text: `<img src=x onerror="window.__xss=1">` }],
      );
      assert.deepEqual(r, { shown: true, count: 2 });
      await p.waitForTimeout(300);
      const s = await p.evaluate(() => ({
        host: !!document.getElementById("applypilot-banner"),
        xss: window.__xss,
        outline: getComputedStyle(document.getElementById("question_2001")).outlineColor,
      }));
      assert.deepEqual(s, { host: true, xss: undefined, outline: "rgb(245, 184, 75)" });
    },
  ));

test("snapshot keeps structure and leaves out every value", () =>
  using(prepare("greenhouse", { fields: GENDER(false) }), async ({ page: p }) => {
    const snap = await p.evaluate(() => globalThis.__applypilot.snapshot());
    const json = JSON.stringify(snap);
    for (const v of [PROFILE.email, PROFILE.phone, PROFILE.linkedIn, RESUME.name, "Test"]) assert.ok(!json.includes(v), v);
    assert.equal(snap.rootFound, true);
    assert.ok(snap.controls.some((c) => c.label === "First Name" && c.required));
    assert.ok(snap.controls.some((c) => c.id === "gender" && c.options.includes("Decline to self-identify")));
    assert.ok(snap.buttons.some((b) => b.label === "Submit application"));
  }));

test("installing twice keeps one library and its clicked flag", () =>
  using(prepare("greenhouse"), async ({ page: p, audit }) => {
    const first = await p.evaluate(() => (window.__first = globalThis.__applypilot, globalThis.__applypilot.version));
    assert.equal(first, "3.1.1");
    assert.deepEqual((await press(p, audit.fingerprint)).r, { clicked: true });
    await p.addScriptTag({ path: LIB });
    const s = await p.evaluate((fp) => ({ same: window.__first === globalThis.__applypilot, again: globalThis.__applypilot.pressSubmit(fp), submits: window.__submits }), audit.fingerprint);
    assert.deepEqual([s.same, s.again.clicked, s.submits], [true, false, 1]);
  }));

// ---- step 3 fixes: CAPTCHA in shadow roots, eligibility scope, group-level required, ARIA widgets ----------

const REQ = '<span class="asterisk">*</span>';
const reqRadios = (name, question, opts = ["Yes", "No"]) =>
  `<div class="field"><fieldset><legend>${question}${REQ}</legend>${opts
    .map((o, i) => `<label><input type="radio" name="${name}" id="${name}-${i}" value="${o}" required>${o}</label>`)
    .join("")}</fieldset></div>`;
const checkedIn = (p, name) => p.evaluate((name) => [...document.querySelectorAll(`input[name="${name}"]`)].filter((x) => x.checked).length, name);

test("a visible CAPTCHA inside an open shadow root blocks, and pressSubmit refuses", () =>
  using(
    prepare("greenhouse", {
      fields: `<captcha-box id="cb"></captcha-box>`,
      script: `<script>document.getElementById("cb").attachShadow({ mode: "open" }).innerHTML = '<iframe src="https://newassets.hcaptcha.com/captcha/v1/abc/static/hcaptcha.html#frame=checkbox&id=0abc" width="303" height="78"></iframe>';</script>`,
    }),
    async ({ page: p, audit }) => {
      assert.deepEqual(codes(audit), ["captcha"]);
      assert.deepEqual(audit.relaxations, []);
      const out = await press(p, audit.fingerprint);
      assert.equal(out.r.clicked, false);
      assert.equal(out.submits, 0);
    },
  ));

test("a Turnstile box shown on the page blocks even when its frame is in a closed shadow root", () =>
  using(
    prepare("greenhouse", {
      fields: `<div class="cf-turnstile" id="ts" data-sitekey="0x4AAA" style="width:300px;height:65px"></div>`,
      script: `<script>document.getElementById("ts").attachShadow({ mode: "closed" }).innerHTML = '<iframe src="https://challenges.cloudflare.com/cdn-cgi/challenge-platform/turnstile/if/ov2/av0/abc" width="300" height="65"></iframe>';</script>`,
    }),
    async ({ audit }) => {
      assert.deepEqual(codes(audit), ["captcha"]);
      assert.deepEqual(audit.relaxations, []);
    },
  ));

test("work authorization is answered only for working in the US, never other countries or other conditions", () =>
  using(
    prepare("greenhouse", {
      fields:
        reqRadios("q_us", "Are you legally authorized to work in the United States?") +
        reqRadios("q_ca", "Are you legally authorized to work in Canada?") +
        reqRadios("q_uk", "Do you have the right to work in the UK?") +
        reqRadios("q_bg", "Do you authorize us to conduct a background check?") +
        reqRadios("q_we", "Are you legally able to work weekends and overtime?") +
        reqRadios("q_dr", "Are you authorized to drive a company vehicle?") +
        field("q_sel", `Are you eligible to work in Mexico?${REQ}`, `<select id="q_sel" name="q_sel" aria-required="true"><option value="">Select</option><option>Yes</option><option>No</option></select>`),
    }),
    async ({ page: p, audit }) => {
      const v = await values(p);
      assert.equal(v["q_us-0"], true);
      for (const name of ["q_ca", "q_uk", "q_bg", "q_we", "q_dr"]) assert.equal(await checkedIn(p, name), 0, name);
      assert.equal(v.q_sel, "");
      assert.ok(codes(audit).includes("unanswered_required"));
      assert.equal(audit.blockers.filter((b) => b.code === "unanswered_required").length >= 6, true, JSON.stringify(audit.blockers));
    },
  ));

test("required checkbox groups block: a demographic group, a starred acknowledgement and an aria-required group", async () => {
  const cases = [
    [
      `<div class="field"><fieldset><legend>Race / Ethnicity${REQ}</legend><label><input type="checkbox" name="race" value="a">Asian</label><label><input type="checkbox" name="race" value="b">Black or African American</label><label><input type="checkbox" name="race" value="w">White</label></fieldset></div>`,
      "demographic",
    ],
    [
      `<div class="field"><fieldset><legend>Acknowledgement${REQ}</legend><label><input type="checkbox" name="ack" id="ack" value="1">I have read and agree to the candidate privacy notice</label></fieldset></div>`,
      null,
    ],
    [
      `<div class="field" role="group" aria-required="true" aria-labelledby="tools-l"><span id="tools-l">Which of these tools have you used?</span><label><input type="checkbox" name="tools" value="j">Jira</label><label><input type="checkbox" name="tools" value="s">ServiceNow</label></div>`,
      "unanswered_required",
    ],
  ];
  await Promise.all(
    cases.map(([fields, code]) =>
      using(prepare("greenhouse", { fields }), async ({ page: p, audit }) => {
        assert.ok(audit.blockers.length, `${fields.slice(0, 60)} did not block`);
        if (code) assert.ok(codes(audit).includes(code), JSON.stringify(codes(audit)));
        assert.equal(await p.evaluate(() => document.querySelectorAll("input[type=checkbox]:checked").length), 0);
      }),
    ),
  );
});

test("a Lever card with a starred label and one checkbox blocks; a group-level required cover letter file blocks", async () => {
  await using(
    prepare("lever", {
      fields: `<li class="application-question"><div class="application-label">Please confirm you have read the job requirements<span class="required">✱</span></div><div class="application-field"><label><input type="checkbox" name="cards[c1][field0]" value="Yes">I confirm</label></div></li>`,
    }),
    async ({ page: p, audit }) => {
      assert.ok(audit.blockers.length, "the starred card did not block");
      assert.equal(await p.evaluate(() => document.querySelector("input[type=checkbox]").checked), false);
    },
  );
  await using(
    prepare("greenhouse", {
      fields: `<div class="field" role="group" aria-labelledby="cl-l"><span id="cl-l">Cover Letter*</span><input id="cover_letter" name="cover_letter" type="file"></div>`,
    }),
    async ({ audit }) => assert.ok(codes(audit).includes("other_required_file") || audit.blockers.length, JSON.stringify(codes(audit))),
  );
});

test("required ARIA widgets block: a radiogroup, a contenteditable box and a popup button", async () => {
  const cases = [
    [
      `<div class="field"><span id="g-l">Gender${REQ}</span><div role="radiogroup" aria-labelledby="g-l"><div role="radio" aria-checked="false" tabindex="0">Male</div><div role="radio" aria-checked="false" tabindex="-1">Female</div></div></div>`,
      "demographic",
    ],
    [
      `<div class="field"><span id="s-l">Preferred shift</span><div role="radiogroup" aria-required="true" aria-labelledby="s-l"><div role="radio" aria-checked="false" tabindex="0">Mornings</div><div role="radio" aria-checked="false" tabindex="-1">Evenings</div></div></div>`,
      "unanswered_required",
    ],
    [`<div class="field"><div role="textbox" contenteditable="true" aria-required="true" aria-label="Why do you want to work here?" style="min-height:40px;border:1px solid #999"></div></div>`, "unanswered_required"],
    [
      `<div class="field"><span id="st-l">Earliest start date${REQ}</span><button type="button" aria-haspopup="listbox" aria-labelledby="st-l" aria-required="true">Select…</button></div>`,
      "unanswered_required",
    ],
  ];
  await Promise.all(
    cases.map(([fields, code]) =>
      using(prepare("greenhouse", { fields }), async ({ audit }) => assert.ok(codes(audit).includes(code), `${fields.slice(0, 70)}: ${JSON.stringify(codes(audit))}`)),
    ),
  );
});

test("native selects take only an exact option: no 'Yes, I am a U.S. citizen', no Minor Outlying Islands, no 'Not in the US'", () =>
  using(
    prepare(
      "greenhouse",
      {
        fields:
          field("q_auth", `Are you legally authorized to work in the United States?${REQ}`, `<select id="q_auth" aria-required="true"><option value="">Select</option><option>Yes, I am a U.S. citizen</option><option>Yes, I have a work visa</option><option>No</option></select>`) +
          field("country", `Country${REQ}`, `<select id="country" aria-required="true"><option value="">Select</option><option value="UM">United States Minor Outlying Islands</option><option value="US">United States of America</option><option value="CA">Canada</option></select>`) +
          field("state", "State", `<select id="state"><option value="">Select</option><option value="xx">Not in the US</option><option value="IN">Indiana</option><option value="GA">Georgia</option></select>`),
      },
      { profile: { ...PROFILE, state: "IN" } },
    ),
    async ({ page: p, filled, audit }) => {
      const v = await values(p);
      assert.equal(v.q_auth, "");
      assert.equal(v.country, "US");
      assert.equal(v.state, "IN");
      assert.ok(codes(audit).includes("unanswered_required"));
      assert.ok(!filled.filled.some((x) => /citizen/.test(x.value)));
    },
  ));

test("questions that only mention a profile word are not answered from the profile", () =>
  using(
    prepare("greenhouse", {
      fields:
        field("q_mdm", `Which mobile device management tools have you used?${REQ}`, `<input id="q_mdm" type="text" aria-required="true">`) +
        field("q_region", `Which region would you like to work in?${REQ}`, `<input id="q_region" type="text" aria-required="true">`) +
        field("q_story", `Describe a time you resolved a ticket by email${REQ}`, `<textarea id="q_story" aria-required="true"></textarea>`) +
        field("q_email2", "Email address", `<textarea id="q_email2"></textarea>`) +
        field("mobile", "Mobile phone", `<input id="mobile" type="tel">`),
    }),
    async ({ page: p, audit }) => {
      const v = await values(p);
      assert.deepEqual([v.q_mdm, v.q_region, v.q_story, v.q_email2], ["", "", "", ""]);
      assert.equal(v.mobile, PROFILE.phone, "a real phone field is still filled");
      assert.equal(audit.blockers.filter((b) => b.code === "unanswered_required").length, 3, JSON.stringify(audit.blockers));
    },
  ));

test("batch fill ticks only a box that says this is your current job in work history", async () => {
  const fields = `<div class="employment"><h3>Employment</h3>${field("company_0", "Company name", `<input id="company_0">`)}
    <label><input type="checkbox" id="contact_ok"> You may contact my current employer</label>
    <label><input type="checkbox" id="noncompete"> I am currently subject to a non-compete with my present employer</label>
    <label><input type="checkbox" id="current_0"> I currently work here</label></div>`;
  await using(prepare("greenhouse", { fields }, { profile: { ...PROFILE, workHistory: jobs } }), async ({ page: p }) => {
    const v = await values(p);
    assert.deepEqual([v.company_0, v.contact_ok, v.noncompete, v.current_0], ["Acme Health", false, false, true]);
  });
});

test("real Lever cards (no fieldset) answer the US work-authorization radios", () =>
  using(
    prepare("lever", {
      fields: `<li class="application-question custom-question"><div class="application-label"><div class="text">Are you legally authorized to work in the United States?<span class="required">✱</span></div></div>
        <div class="application-field"><ul data-qa="multiple-choice"><li><label><input type="radio" name="cards[abc][field0]" id="lv-yes" value="Yes" required><span class="application-answer-alternative">Yes</span></label></li>
        <li><label><input type="radio" name="cards[abc][field0]" id="lv-no" value="No" required><span class="application-answer-alternative">No</span></label></li></ul></div></li>`,
    }),
    async ({ page: p, audit }) => {
      const v = await values(p);
      assert.deepEqual([v["lv-yes"], v["lv-no"]], [true, false]);
      assert.deepEqual(codes(audit), []);
    },
  ));

test("a page with no form never reads as confirmed, even with success wording in the job description", async () => {
  const posting = URLS.lever.replace(/\/apply$/, "");
  const html = `<!doctype html><title>Acme Example - Help Desk Technician</title><div class="posting-headline"><h2>Help Desk Technician</h2></div>
    <div class="section"><p>Thank you for applying to Acme! Once your application has been received, we review it within a week.</p></div>`;
  const p = await open(posting, { [posting]: html });
  try {
    const form = await p.evaluate(() => globalThis.__applypilot.findForm({ ats: "lever", timeoutMs: 1000 }));
    assert.equal(form.ok, false);
    await p.evaluate(() => globalThis.__applypilot.watchForConfirmation({ ats: "lever" }));
    const r = await outcome(p, "lever", 2000);
    assert.notEqual(r.outcome, "submitted");
    await p.waitForTimeout(500);
    assert.equal(await p.evaluate(() => window.__sent.filter((m) => m.kind === "confirmed").length), 0);
  } finally {
    await p.close();
  }
});

test("success wording on the page before Submit doesn't confirm a form that just went away", () =>
  using(
    prepare("greenhouse", {
      top: `<p class="intro">Thank you for your application interest. Application received notices go out by email.</p><p>We have received your application questions? Email us.</p>`,
      script: `<script>window.addEventListener("fixture-submit", () => { document.getElementById("application-form").remove(); });</script>`,
    }),
    async ({ page: p, audit }) => {
      assert.deepEqual(codes(audit), []);
      assert.deepEqual((await press(p, audit.fingerprint)).r, { clicked: true });
      const r = await outcome(p, "greenhouse", 2500);
      assert.equal(r.outcome, "check");
    },
  ));

test("your own Submit click in a watched tab is reported, so a later confirmation is yours", () =>
  using(prepare("greenhouse", { fields: GENDER(true) }), async ({ page: p, audit }) => {
    assert.deepEqual(codes(audit), ["demographic"]);
    await p.evaluate(() => globalThis.__applypilot.watchForConfirmation({ ats: "greenhouse" }));
    await p.click("#submit");
    await p.waitForFunction(() => window.__sent.some((m) => m.kind === "peter_click"), null, { timeout: 5000 });
    const ev = await p.evaluate(() => window.__sent.find((m) => m.kind === "peter_click"));
    assert.equal(ev.type, "AP_PAGE_EVENT");
    assert.equal(ev.matches, false);
    // A click the page script made itself is not yours.
    await p.evaluate(() => {
      window.__sent.length = 0;
      document.getElementById("submit").click();
    });
    await p.waitForTimeout(200);
    assert.equal(await p.evaluate(() => window.__sent.filter((m) => m.kind === "peter_click").length), 0);
  }));

// ---- step 3 round 2: eligibility scope, group required marks, someone else's details, routes ----------

const leverRadios = (name, question) =>
  `<li class="application-question custom-question"><div class="application-label"><div class="text">${question}<span class="required">✱</span></div></div>
    <div class="application-field"><ul data-qa="multiple-choice">${["Yes", "No"]
      .map((o, i) => `<li><label><input type="radio" name="cards[${name}][field0]" id="${name}-${i}" value="${o}" required><span class="application-answer-alternative">${o}</span></label></li>`)
      .join("")}</ul></div></li>`;
const SUBMITTED = (p, fp) => p.evaluate((fp) => ({ r: globalThis.__applypilot.pressSubmit(fp), submits: window.__submits }), fp);

test("work authorization: other places and other conditions are never answered, on Greenhouse or Lever; plain US phrasings are", async () => {
  const notUs = {
    on: "Are you legally authorized to work in Ontario?",
    lu: "Are you legally authorized to work in Luxembourg?",
    to: "Do you have work authorization for Toronto?",
    ld: "Are you eligible to work in London?",
    lt: "Will you require visa sponsorship to work in Lithuania?",
    rc: "Are you legally authorized to work in the country where this role is based?",
    fd: "Are you eligible to work for the U.S. federal government?",
    cl: "Are you authorized to work in a classified environment?",
    it: "Are you authorized to work with ITAR-controlled technical data as a U.S. person?",
    ch: "Are you legally authorized to work with children in a school setting?",
    os: "Are you legally able to work on-site in our Atlanta office five days a week?",
    rs: "Are you eligible to work remotely from your current state of residence?",
    hz: "Are you legally permitted to work with hazardous materials?",
  };
  const us = {
    az: "Do you have authorization to work in the United States?",
    cn: "Can you legally work in the United States?",
    al: "Are you legally allowed to work in the United States?",
    af: "Are you authorized for employment in the United States?",
  };
  // An audit lists at most ten blockers, so the questions go on two pages.
  const keys = Object.keys(notUs);
  const pages = [
    [keys.slice(0, 7), Object.keys(us)],
    [keys.slice(7), []],
  ];
  for (const [ats, wrap] of [
    ["greenhouse", reqRadios],
    ["lever", leverRadios],
  ])
    for (const [no, yes] of pages)
      await using(prepare(ats, { fields: [...no, ...yes].map((k) => wrap(`q_${k}`, notUs[k] || us[k])).join("") }), async ({ page: p, audit }) => {
        const v = await values(p);
        for (const k of no) assert.equal(await checkedIn(p, ats === "lever" ? `cards[q_${k}][field0]` : `q_${k}`), 0, `${ats}: ${notUs[k]}`);
        for (const k of yes) assert.deepEqual([v[`q_${k}-0`], v[`q_${k}-1`]], [true, false], `${ats}: ${us[k]}`);
        const asked = audit.blockers.filter((b) => b.code === "unanswered_required").map((b) => b.text);
        assert.equal(asked.length, no.length, `${ats}:\n${asked.join("\n")}`);
        for (const k of no) assert.ok(asked.some((t) => t.includes(notUs[k])), `${ats}: ${notUs[k]} is not among the blockers`);
        assert.equal((await SUBMITTED(p, audit.fingerprint)).submits, 0);
      });
});

test("a native select never takes an answer with more in parentheses: 'Yes (U.S. citizen)', 'No (I am a U.S. citizen)'", () =>
  using(
    prepare("greenhouse", {
      fields:
        field("q_auth", `Are you legally authorized to work in the United States?${REQ}`, `<select id="q_auth" name="q_auth" required><option value="">Select...</option><option value="c">Yes (U.S. citizen)</option><option value="n">No (I will need sponsorship)</option></select>`) +
        field("q_sp", `Will you now or in the future require sponsorship?${REQ}`, `<select id="q_sp" name="q_sp" required><option value="">Select...</option><option value="y">Yes (H-1B or other visa)</option><option value="n">No (I am a U.S. citizen)</option></select>`),
    }),
    async ({ page: p, filled, audit }) => {
      const v = await values(p);
      assert.deepEqual([v.q_auth, v.q_sp], ["", ""]);
      assert.equal(audit.blockers.filter((b) => b.code === "unanswered_required").length, 2, JSON.stringify(audit.blockers));
      assert.ok(!filled.filled.some((x) => /citizen|sponsorship|visa/.test(x.value)));
    },
  ));

test("required checkbox and radio groups block wherever the star sits, with an Other box, a hidden id or ARIA boxes", async () => {
  const cases = {
    demoSelfDescribe: [
      `<fieldset class="field" aria-required="true"><legend>Race / Ethnicity (select all that apply)*</legend><label><input type="checkbox" name="race[]" value="w" id="r1">White</label><label><input type="checkbox" name="race[]" value="b" id="r2">Black or African American</label><label for="race_other">Prefer to self-describe</label><input type="text" id="race_other" name="race_other"></fieldset>`,
      "demographic",
    ],
    hearOther: [
      `<fieldset class="field"><legend>How did you hear about us?*</legend><label><input type="checkbox" name="hear[]" value="li" id="h1">LinkedIn</label><label><input type="checkbox" name="hear[]" value="fr" id="h2">Friend</label><label for="hear_other">Other</label><input type="text" id="hear_other" name="hear_other"></fieldset>`,
      "unanswered_required",
    ],
    ackWithText: [
      `<fieldset class="field"><legend>Acknowledgement*</legend><label><input type="checkbox" name="ack" value="1" id="ack">I have read the candidate notice</label><input type="text" name="ack_note" id="ack_note" placeholder="Notes"></fieldset>`,
      null,
    ],
    divShifts: [
      `<div class="field"><label>Which shifts can you work?${REQ}</label><label><input type="checkbox" name="shift[]" value="d" id="s1">Day</label><label><input type="checkbox" name="shift[]" value="n" id="s2">Night</label></div>`,
      "unanswered_required",
    ],
    divRace: [
      `<div class="field"><label>Race${REQ}</label><label><input type="checkbox" name="race[]" value="w" id="r1">White</label><label><input type="checkbox" name="race[]" value="b" id="r2">Black or African American</label></div>`,
      "demographic",
    ],
    divRelocate: [
      `<div class="field"><label>Are you willing to relocate?${REQ}</label><label><input type="radio" name="reloc" value="Yes" id="rl_y">Yes</label><label><input type="radio" name="reloc" value="No" id="rl_n">No</label></div>`,
      "unanswered_required",
    ],
    ariaGender: [
      `<div class="field"><div id="gl">Gender*</div><div role="group" aria-required="true" aria-labelledby="gl"><div role="checkbox" aria-checked="false" tabindex="0">Male</div><div role="checkbox" aria-checked="false" tabindex="0">Female</div></div></div>`,
      "demographic",
    ],
    ariaShifts: [
      `<div class="field"><div id="sl">Which shifts can you work?*</div><div role="group" aria-labelledby="sl"><div role="checkbox" aria-checked="false" tabindex="0">Day</div><div role="checkbox" aria-checked="false" tabindex="0">Night</div></div></div>`,
      "unanswered_required",
    ],
    ghClassicAck: [
      `<div class="field"><label>Background check acknowledgement ${REQ}</label><input type="hidden" name="job_application[answers_attributes][4][question_id]" value="555"><label><input type="checkbox" id="ack" name="job_application[answers_attributes][4][boolean_value]" value="1"> I acknowledge that an offer is contingent on a background check</label></div>`,
      null,
    ],
    ghClassicMulti: [
      `<div class="field"><label>Which certifications do you hold? ${REQ}</label><input type="hidden" name="job_application[answers_attributes][5][question_id]" value="556"><label><input type="checkbox" id="c0" name="job_application[answers_attributes][5][answer_selected_options_attributes][0][question_option_id]" value="1"> CompTIA A+</label><label><input type="checkbox" id="c1" name="job_application[answers_attributes][5][answer_selected_options_attributes][1][question_option_id]" value="2"> Network+</label></div>`,
      "unanswered_required",
    ],
  };
  await Promise.all(
    Object.entries(cases).map(([name, [fields, code]]) =>
      using(prepare("greenhouse", { fields }), async ({ page: p, audit }) => {
        assert.ok(audit.blockers.length, `${name} did not block`);
        if (code) assert.ok(codes(audit).includes(code), `${name}: ${JSON.stringify(codes(audit))}`);
        assert.ok(!audit.relaxations.includes("optional_sensitive_blank"), `${name}: a required group was relaxed as optional`);
        assert.equal(await p.evaluate(() => document.querySelectorAll("input:checked,[aria-checked=true]").length), 0, name);
        assert.equal((await SUBMITTED(p, audit.fingerprint)).submits, 0, name);
      }),
    ),
  );
});

test("a required popup button made from a div blocks, for a demographic question and an ordinary one", async () => {
  const cases = [
    [`<div class="field"><div id="gl2">Gender*</div><div role="button" aria-haspopup="listbox" aria-labelledby="gl2" tabindex="0">Select...</div></div>`, "demographic"],
    [`<div class="field"><div id="yl2">Years of experience*</div><div role="button" aria-haspopup="listbox" aria-labelledby="yl2" tabindex="0">Select...</div></div>`, "unanswered_required"],
  ];
  await Promise.all(
    cases.map(([fields, code]) =>
      using(prepare("greenhouse", { fields }), async ({ page: p, audit }) => {
        assert.ok(codes(audit).includes(code), `${fields.slice(0, 60)}: ${JSON.stringify(codes(audit))}`);
        assert.equal((await SUBMITTED(p, audit.fingerprint)).submits, 0);
      }),
    ),
  );
});

test("a reference's or emergency contact's name, email and phone are never filled with yours", () =>
  using(
    prepare("greenhouse", {
      fields: `<fieldset class="field"><legend>Professional reference*</legend>
          ${field("ref_name", "Full name*", `<input id="ref_name" name="question_3001" type="text" required>`)}
          ${field("ref_email", "Email*", `<input id="ref_email" name="question_3002" type="text" required>`)}
          ${field("ref_phone", "Phone*", `<input id="ref_phone" name="question_3003" type="tel" required>`)}</fieldset>
        <section><h3>Emergency contact</h3>
          ${field("em_name", "Name*", `<input id="em_name" name="question_3101" type="text" required>`)}
          ${field("em_phone", "Phone number*", `<input id="em_phone" name="question_3102" type="tel" required>`)}</section>`,
    }),
    async ({ page: p, filled, audit }) => {
      const v = await values(p);
      assert.deepEqual([v.ref_name, v.ref_email, v.ref_phone, v.em_name, v.em_phone], ["", "", "", "", ""]);
      assert.deepEqual([v.first_name, v.email, v.phone], [PROFILE.firstName, PROFILE.email, PROFILE.phone], "your own fields are still filled");
      assert.equal(audit.blockers.filter((b) => b.code === "unanswered_required").length, 5, JSON.stringify(audit.blockers));
      for (const mine of [PROFILE.email, PROFILE.phone, PROFILE.fullName]) assert.ok(filled.filled.filter((x) => x.value === mine).length <= 1, mine);
    },
  ));

test("education and work-history selects take your degree and month in the site's wording", () =>
  using(
    prepare(
      "greenhouse",
      {
        fields: `<section class="education"><h3>Education</h3>
          ${field("school", `School${REQ}`, `<input id="school" name="school" type="text" aria-required="true">`)}
          ${field("degree", `Degree${REQ}`, `<select id="degree" name="degree" required><option value="">Select...</option><option value="1">High School</option><option value="2">Associate's Degree</option><option value="3">Bachelor's Degree</option><option value="4">Master's Degree</option></select>`)}
          ${field("end_year", `End year${REQ}`, `<select id="end_year" name="end_year" required><option value="">Year</option><option value="2018">2018</option><option value="2019">2019</option><option value="2020">2020</option></select>`)}</section>
        <section class="work"><h3>Work Experience</h3>
          ${field("company", `Company${REQ}`, `<input id="company" name="company" type="text" aria-required="true">`)}
          ${field("title", `Title${REQ}`, `<input id="title" name="title" type="text" aria-required="true">`)}
          ${field("start_month", `Start month${REQ}`, `<select id="start_month" name="start_month" required><option value="">Month</option><option value="1">January</option><option value="2">February</option><option value="3">March</option><option value="4">April</option></select>`)}
          ${field("start_year", `Start year${REQ}`, `<input id="start_year" name="start_year" type="text" aria-required="true">`)}
          <div class="field"><label><input type="checkbox" id="current" name="current">I currently work here</label></div></section>`,
      },
      {
        profile: {
          ...PROFILE,
          education: [{ school: "Georgia State University", degree: "Bachelor’s", field: "Information Technology", endYear: "2019" }],
          workHistory: [{ company: "Globex", title: "IT Support", startMonth: "3", startYear: "2021", current: true }],
        },
      },
    ),
    async ({ page: p, audit }) => {
      const v = await values(p);
      assert.deepEqual([v.school, v.degree, v.end_year, v.company, v.title, v.start_month, v.start_year, v.current], ["Georgia State University", "3", "2019", "Globex", "IT Support", "3", "2021", true]);
      assert.deepEqual(codes(audit), []);
    },
  ));

test("a watched Ashby tab that moves to the job's Overview is never read as sent; your own Submit click and the success screen are", async () => {
  const fields = `<div class="field-entry"><label for="q_why">Why do you want to work here?<span class="req">*</span></label><textarea id="q_why" name="q_why" required></textarea></div>`;
  await using(prepare("ashby", { fields }), async ({ page: p, audit }) => {
    assert.ok(codes(audit).includes("unanswered_required"));
    await p.evaluate(() => {
      globalThis.__applypilot.watchForConfirmation({ ats: "ashby" });
      setTimeout(() => {
        history.pushState({}, "", location.pathname.replace(/\/application$/, ""));
        document.getElementById("app").innerHTML = `<h1>Help Desk Technician</h1><nav><a href="#">Overview</a> <a href="#">Application</a></nav>
          <section><h2>About the role</h2><p>You will support 300 staff on Windows and Active Directory.</p><p>Thank you for your application and your interest in Acme! Every application received will be reviewed.</p></section>`;
      }, 300);
    });
    await p.waitForTimeout(3000);
    assert.equal(await p.evaluate(() => window.__sent.filter((m) => m.kind === "confirmed").length), 0);
  });
  await using(prepare("ashby", { fields }), async ({ page: p }) => {
    await p.evaluate(() => globalThis.__applypilot.watchForConfirmation({ ats: "ashby" }));
    await p.fill("#q_why", "I like the team.");
    await p.click("#submit");
    await p.waitForFunction(() => window.__sent.some((m) => m.kind === "confirmed"), null, { timeout: 6000 });
    const ev = await p.evaluate(() => window.__sent.find((m) => m.kind === "confirmed"));
    assert.equal(ev.confirmationKind, "in_page_only");
    assert.match(ev.text, /Thank you for applying/);
  });
});

test("dashboard hook: a hello sent before the bridge loaded doesn't turn a connected bridge into missing", async () => {
  const url = "https://applypilot.example/applications";
  const html = `<!doctype html><title>ApplyPilot</title><div id="app"></div>
    <script>
      // Stands in for bridge.js, which Chrome injects at document_idle: here 300 ms after the page's first hello,
      // which nothing answers.
      window.__hellos = 0;
      let loaded = false, loading = false;
      const reply = (type, payload, replyTo) => window.postMessage({ channel: "applypilot", v: 1, from: "extension", type, id: crypto.randomUUID(), replyTo, payload }, location.origin);
      const READY = { version: "3.1.1", held: [], running: false, resultsWaiting: 0 };
      window.addEventListener("message", (e) => {
        const d = e.data;
        if (!d || d.channel !== "applypilot" || d.from !== "dashboard") return;
        if (!loaded) {
          if (!loading) setTimeout(() => { loaded = true; reply("AP_READY", READY); }, 300);
          loading = true;
          return;
        }
        if (d.type === "AP_HELLO") { window.__hellos++; reply("AP_READY", READY, d.id); }
        else if (d.type === "AP_PULL_RESULTS") reply("AP_RESULTS", { results: [] }, d.id);
      });
    </script>
    <script src="/assets/bridge-hook.js"></script>`;
  const p = await open(url, { [url]: html });
  try {
    await p.waitForFunction(() => document.getElementById("status")?.textContent === "connected", null, { timeout: 5000 });
    await p.waitForTimeout(2600);
    const s = await p.evaluate(() => ({ status: document.getElementById("status").textContent, seen: window.__statuses, hellos: window.__hellos }));
    assert.equal(s.status, "connected", JSON.stringify(s.seen));
    assert.ok(!s.seen.some(([, st]) => st === "missing"), JSON.stringify(s.seen));
    assert.ok(s.hellos >= 1, "the page says hello itself once the bridge is there, so its tab can take claims");
  } finally {
    await p.close();
  }
});

// ---- runner ---------------------------------------------------------------------------------------

// ---- step 3, third round: answers only for what you approved, and every click of yours seen ----------

const selectQ = (id, q) =>
  field(id, `${q}${REQ}`, `<select id="${id}" name="${id}" required><option value="">Select...</option><option value="1">Yes</option><option value="0">No</option></select>`);
const pairQ = (id, q) =>
  `<div class="field-entry" id="${id}"><label>${q}*</label><div class="yesno"><button type="button" aria-pressed="false" id="${id}-0">Yes</button><button type="button" aria-pressed="false" id="${id}-1">No</button></div></div>`;
// Which option is chosen on any of the four layouts: 0 for Yes, 1 for No, -1 for none.
const chosen = (p, id) =>
  p.evaluate((id) => {
    const s = document.getElementById(id);
    if (s?.tagName === "SELECT") return s.value === "" ? -1 : s.value === "1" ? 0 : 1;
    return [0, 1].findIndex((i) => {
      const x = document.getElementById(`${id}-${i}`);
      return x.tagName === "BUTTON" ? x.getAttribute("aria-pressed") === "true" : x.checked;
    });
  }, id);
const LAYOUTS = [
  ["greenhouse", reqRadios],
  ["lever", leverRadios],
  ["greenhouse", selectQ],
  ["ashby", pairQ],
];

test("a question about needing authorization, or about a visa status, is never answered from 'authorized' on any layout", async () => {
  const asks = {
    req: "Do you require work authorization to work in the United States?",
    need: "Will you need employment authorization to work in the US?",
    isreq: "Is work authorization required?",
    opt: "Are you authorized to work in the US on OPT?",
    h1b: "Are you currently authorized to work in the US on an H-1B?",
    two: "Do you require sponsorship to work in the US, or are you authorized to work without sponsorship?",
  };
  const plain = "Are you legally authorized to work in the United States? (Yes/No)";
  await Promise.all(
    LAYOUTS.map(([ats, wrap]) =>
      using(prepare(ats, { fields: Object.entries(asks).map(([k, q]) => wrap(`q_${k}`, q)).join("") + wrap("q_plain", plain) }), async ({ page: p, audit }) => {
        for (const [k, q] of Object.entries(asks)) assert.equal(await chosen(p, `q_${k}`), -1, `${ats} ${wrap.name}: ${q}`);
        assert.equal(await chosen(p, "q_plain"), 0, `${ats} ${wrap.name}: ${plain}`);
        const asked = audit.blockers.filter((b) => b.code === "unanswered_required").map((b) => b.text);
        for (const q of Object.values(asks)) assert.ok(asked.some((t) => t.includes(q.slice(0, 40))), `${ats} ${wrap.name}: ${q} is not among the blockers`);
        assert.equal((await SUBMITTED(p, audit.fingerprint)).submits, 0);
      }),
    ),
  );
});

test("on a posting outside the U.S., a question that names no country waits for you; one about the U.S. is still answered", async () => {
  const fields = [
    ["sp", "Will you now or in the future require sponsorship for employment visa status?"],
    ["au", "Are you legally authorized to work for any employer?"],
    ["us", "Do you require us to sponsor your visa?"],
    ["named", "Are you legally authorized to work in the United States?"],
  ];
  const html = fields.map(([k, q]) => leverRadios(`q_${k}`, q)).join("");
  await using(prepare("lever", { fields: html }, { fill: { usPosting: false } }), async ({ page: p, audit }) => {
    for (const k of ["sp", "au", "us"]) assert.equal(await chosen(p, `q_${k}`), -1, k);
    assert.equal(await chosen(p, "q_named"), 0);
    assert.equal(audit.blockers.filter((b) => b.code === "unanswered_required").length, 3, JSON.stringify(audit.blockers));
  });
  await using(prepare("lever", { fields: html }, { fill: { usPosting: true } }), async ({ page: p, audit }) => {
    assert.deepEqual(await Promise.all(fields.map(([k]) => chosen(p, `q_${k}`))), [1, 0, 1, 0]);
    assert.deepEqual(codes(audit), []);
  });
});

test("common sponsorship wordings and the company's own name are answered; your flags decide", () =>
  using(
    prepare(
      "greenhouse",
      {
        fields: [
          ["order", "Will you require visa sponsorship in order to work in the US?", 1],
          ["requiring", "Are you authorized to work in the U.S. without requiring sponsorship?", 0],
          ["company", "Will you now or in the future require Acme to sponsor your visa?", 1],
          ["continue", "Do you require sponsorship to continue working in the US?", 1],
          ["point", "Will you now or at any point in the future require sponsorship?", 1],
          ["either", "Will you require sponsorship to work in the US either now or in the future?", 1],
          ["from", "Will you now or in the future require visa sponsorship from an employer?", 1],
          ["needing", "Would you be able to work in the US without needing sponsorship?", 0],
          ["for", "Are you authorized to work in the United States for Acme?", 0],
          ["commence", "Will you require sponsorship to commence employment?", 1],
        ]
          .map(([k, q]) => reqRadios(`q_${k}`, q))
          .join(""),
      },
      { fill: { company: "Acme Inc." } },
    ),
    async ({ page: p, audit }) => {
      const want = { order: 1, requiring: 0, company: 1, continue: 1, point: 1, either: 1, from: 1, needing: 0, for: 0, commence: 1 };
      for (const [k, i] of Object.entries(want)) assert.equal(await chosen(p, `q_${k}`), i, k);
      assert.deepEqual(codes(audit), []);
    },
  ));

test("radio options whose wording sits beside them, not in a label, never change how the question reads", async () => {
  const opts = (yes, no) => `<div class="field"><label>Will you now or in the future require visa sponsorship?${REQ}</label>
    <div><input type="radio" name="sp" value="Yes" id="sp-0" required><span>${yes}</span></div>
    <div><input type="radio" name="sp" value="No" id="sp-1" required><span>${no}</span></div></div>`;
  await using(prepare("greenhouse", { fields: opts("Yes, I will require sponsorship", "No, I do not require sponsorship") }), async ({ page: p, audit }) => {
    assert.equal(await chosen(p, "sp"), -1);
    assert.ok(codes(audit).includes("unanswered_required"), JSON.stringify(codes(audit)));
    assert.equal((await SUBMITTED(p, audit.fingerprint)).submits, 0);
  });
  await using(prepare("greenhouse", { fields: opts("Yes", "No") }), async ({ page: p, audit }) => {
    assert.equal(await chosen(p, "sp"), 1);
    assert.deepEqual(codes(audit), []);
  });
});

test("a supervisor's, a manager's or an alternate contact's name, email and phone are never filled with yours", async () => {
  const group = (head) => `<section><h3>${head}</h3>
    ${field("o_name", "Name*", `<input id="o_name" name="question_3101" type="text" required>`)}
    ${field("o_email", "Email*", `<input id="o_email" name="question_3102" type="email" required>`)}
    ${field("o_phone", "Phone*", `<input id="o_phone" name="question_3103" type="tel" required>`)}</section>`;
  await Promise.all(
    ["Supervisor", "Most recent supervisor", "Current manager", "Hiring manager you spoke with", "Alternate contact"].map((head) =>
      using(prepare("greenhouse", { fields: group(head) }), async ({ page: p, audit }) => {
        const v = await values(p);
        assert.deepEqual([v.o_name, v.o_email, v.o_phone], ["", "", ""], head);
        assert.equal(audit.blockers.filter((b) => b.code === "unanswered_required").length, 3, head);
        assert.equal(v.email, PROFILE.email, `${head}: your own email is still filled`);
      }),
    ),
  );
  // A job title over your own details is not someone else's.
  await using(prepare("greenhouse", { fields: group("IT Support Manager application") }), async ({ page: p }) => {
    const v = await values(p);
    assert.deepEqual([v.o_email, v.o_phone], [PROFILE.email, PROFILE.phone]);
  });
});

test("a profile field beside a required radio or checkbox question is never taken as its answer", async () => {
  const cases = {
    radio: `<div class="field"><label>Are you willing to work on-site in Atlanta three days a week?${REQ}</label>
      <label><input type="radio" name="onsite" id="on_y" value="Yes">Yes</label><label><input type="radio" name="onsite" id="on_n" value="No">No</label>
      <label for="li">LinkedIn URL</label><input type="text" id="li" name="li"></div>`,
    checks: `<div class="field"><label>Which shifts can you work?${REQ}</label>
      <label><input type="checkbox" name="shift[]" value="d" id="sh1">Days</label><label><input type="checkbox" name="shift[]" value="n" id="sh2">Nights</label>
      <label for="li">LinkedIn</label><input type="text" id="li" name="li"></div>`,
  };
  await Promise.all(
    Object.entries(cases).map(([name, fields]) =>
      using(prepare("greenhouse", { fields }), async ({ page: p, audit }) => {
        assert.equal((await values(p)).li, PROFILE.linkedIn, name);
        assert.ok(codes(audit).includes("unanswered_required"), `${name}: ${JSON.stringify(codes(audit))}`);
        assert.equal((await SUBMITTED(p, audit.fingerprint)).submits, 0, name);
      }),
    ),
  );
  // An "Other" box you typed in still answers its question.
  await using(
    prepare("greenhouse", {
      fields: `<fieldset class="field"><legend>How did you hear about us?*</legend><label><input type="checkbox" name="hear[]" value="li" id="h1">LinkedIn</label><label for="hear_other">Other (please specify)</label><input type="text" id="hear_other" name="hear_other"></fieldset>`,
    }),
    async ({ page: p, audit }) => {
      assert.ok(codes(audit).includes("unanswered_required"));
      await p.fill("#hear_other", "A friend at a meetup");
      const again = await auditPage(p, job("greenhouse"));
      assert.ok(!codes(again).includes("unanswered_required"), JSON.stringify(codes(again)));
    },
  );
});

test("a location question that isn't your own location (an office, a city of birth) is never filled with your city", () =>
  using(
    prepare("greenhouse", {
      fields:
        combo(["office", "Which office location are you applying for?", ["Grayson, Georgia, United States", "Austin, Texas, United States"], "city"]) +
        combo(["birth_city", "City of birth", ["Grayson, Georgia, United States", "Lagos, Nigeria"], "city"]),
      script: `<script src="/assets/combobox.js"></script>`,
    }),
    async ({ page: p, filled, audit }) => {
      assert.equal(await p.evaluate(() => document.querySelectorAll(".select__single-value").length), 0);
      assert.ok(!filled.filled.some((x) => /office|birth/i.test(x.label)), JSON.stringify(filled.filled));
      assert.equal(audit.blockers.filter((b) => b.code === "unanswered_required").length, 2, JSON.stringify(audit.blockers));
    },
  ));

test("a watched Ashby tab: a Submit click that didn't send, then the Overview drawn after the route change, is never read as sent", () =>
  using(
    prepare("ashby", { fields: `<div class="field-entry"><label for="q_why">Why do you want to work here?<span class="req">*</span></label><textarea id="q_why" name="q_why" required></textarea></div>` }),
    async ({ page: p, audit }) => {
      assert.ok(codes(audit).includes("unanswered_required"));
      await p.evaluate(() => globalThis.__applypilot.watchForConfirmation({ ats: "ashby" }));
      // The empty required answer stops the browser from sending it.
      await p.click("#submit");
      assert.equal(await p.evaluate(() => window.__submits), 0);
      await p.waitForTimeout(1200);
      await p.evaluate(() => {
        history.pushState({}, "", location.pathname.replace(/\/application$/, ""));
        const app = document.getElementById("app");
        app.innerHTML = `<h1>Help Desk Technician</h1><nav><a href="#">Overview</a> <a href="#">Application</a></nav><div class="spinner">Loading…</div>`;
        setTimeout(() => {
          app.innerHTML = `<h1>Help Desk Technician</h1><nav><a href="#">Overview</a> <a href="#">Application</a></nav><section><h2>About the role</h2><p>You will support 300 staff.</p><p>Every application received will be reviewed by our hiring team within two weeks.</p></section>`;
        }, 600);
      });
      await p.waitForTimeout(3500);
      const sent = await p.evaluate(() => window.__sent.map((m) => m.kind));
      assert.ok(sent.includes("peter_click"), JSON.stringify(sent));
      assert.ok(!sent.includes("confirmed"), JSON.stringify(sent));
    },
  ));

// A shadow root the banner opens, kept so a test can read it.
const keepShadows = (p) =>
  p.evaluate(() => {
    const attach = Element.prototype.attachShadow;
    window.__shadows = [];
    Element.prototype.attachShadow = function (o) {
      const r = attach.call(this, o);
      window.__shadows.push(r);
      return r;
    };
  });

test("supervised: your click on Submit after the form re-renders still counts, and matches when nothing you approved changed", () =>
  using(prepare("ashby"), async ({ page: p, audit }) => {
    assert.deepEqual(codes(audit), []);
    assert.equal((await p.evaluate((fp) => globalThis.__applypilot.armSupervised(fp), audit.fingerprint)).armed, true);
    // The site mounts the form again: every element is new except the attached resume, which it keeps.
    await p.evaluate(() => {
      const old = document.querySelector("form");
      const neu = old.cloneNode(true);
      neu.querySelector("#_systemfield_resume").replaceWith(old.querySelector("#_systemfield_resume"));
      old.replaceWith(neu);
    });
    await p.click("#submit");
    const ev = await p.evaluate(() => window.__sent.find((m) => m.kind === "peter_click"));
    assert.ok(ev, "the click was recorded");
    assert.equal(ev.matches, true);
    const state = await p.evaluate(() => globalThis.__applypilot.clickState());
    assert.deepEqual([state.clicked, state.matches], [true, true]);
  }));

test("your own Submit click before ApplyPilot highlights or presses anything is recorded, and nothing is pressed after it", () =>
  using(prepare("greenhouse"), async ({ page: p, audit }) => {
    assert.deepEqual(codes(audit), []);
    await p.click("#submit");
    const ev = await p.evaluate(() => window.__sent.find((m) => m.kind === "peter_click"));
    assert.ok(ev, "the click was recorded");
    assert.equal(ev.matches, false, "ApplyPilot hadn't said everything matched");
    assert.deepEqual(await p.evaluate(() => globalThis.__applypilot.clickState().clicked), true);
    const again = await auditPage(p, job("greenhouse"));
    assert.ok(codes(again).includes("you_clicked"), JSON.stringify(codes(again)));
    const out = await press(p, audit.fingerprint);
    assert.equal(out.r.clicked, false);
    assert.equal(out.submits, 1, "only your own click");
    assert.equal((await p.evaluate((fp) => globalThis.__applypilot.armSupervised(fp), audit.fingerprint)).armed, false);
  }));

test("supervised: when ApplyPilot stops waiting, the green outline and 'everything matches' banner go", () =>
  using(prepare("greenhouse"), async ({ page: p, audit }) => {
    await keepShadows(p);
    assert.equal((await p.evaluate((fp) => globalThis.__applypilot.armSupervised(fp), audit.fingerprint)).armed, true);
    assert.match(await p.evaluate(() => document.getElementById("submit").style.outline), /solid/);
    const r = await p.evaluate(() => globalThis.__applypilot.disarm([{ code: "stopped", text: "Stopped before you submitted." }]));
    assert.deepEqual(r, { disarmed: true });
    const s = await p.evaluate(() => {
      const root = window.__shadows[window.__shadows.length - 1];
      return { outline: document.getElementById("submit").style.outline, text: root.textContent, banners: document.querySelectorAll("#applypilot-banner").length };
    });
    assert.equal(s.outline, "");
    assert.equal(s.banners, 1);
    assert.match(s.text, /no longer an approved send/);
    assert.match(s.text, /Stopped before you submitted/);
    assert.doesNotMatch(s.text, /Everything matches/);
    // A click after that is yours alone, never one on the form ApplyPilot vouched for.
    await p.click("#submit");
    assert.equal(await p.evaluate(() => window.__sent.find((m) => m.kind === "peter_click")?.matches), false);
  }));

// TEST_GREP=text runs only the tests whose name contains that text.
if (process.env.TEST_GREP) tests.splice(0, tests.length, ...tests.filter(([name]) => name.includes(process.env.TEST_GREP)));
const CONCURRENCY = 6;
const TIMEOUT_MS = 90000;
const settled = tests.map(() => {
  let done;
  const p = new Promise((r) => (done = r));
  return { p, done };
});
let next = 0;
const worker = async () => {
  while (next < tests.length) {
    const i = next++;
    let timer;
    try {
      await Promise.race([tests[i][1](), new Promise((_, no) => (timer = setTimeout(() => no(new Error("timed out")), TIMEOUT_MS)))]);
      settled[i].done(null);
    } catch (e) {
      settled[i].done(e);
    } finally {
      clearTimeout(timer);
    }
  }
};
const workers = Array.from({ length: CONCURRENCY }, worker);
let failed = 0;
for (let i = 0; i < tests.length; i++) {
  const e = await settled[i].p;
  if (!e) console.log(`ok - ${tests[i][0]}`);
  else {
    failed++;
    console.log(`not ok - ${tests[i][0]}\n  ${String(e.message || e).split("\n").join("\n  ")}`);
  }
}
await Promise.all(workers);
await browser.close();
console.log(`${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
