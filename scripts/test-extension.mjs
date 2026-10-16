// Browser checks for the extension's page assistant. Needs Playwright and Chromium:
//   PLAYWRIGHT=/path/to/playwright/index.mjs CHROMIUM=/path/to/chromium node scripts/test-extension.mjs
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const { chromium } = await import(process.env.PLAYWRIGHT || "playwright");
const src = await readFile(new URL("../extension/popup.js", import.meta.url), "utf8");
const fn = src.slice(src.indexOf("async function assistant"));
const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});

async function run(html, profile, advance = false) {
  const page = await browser.newPage();
  await page.setContent(html);
  const out = await page.evaluate(
    async ([fn, profile, advance]) => {
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
      const assistant = (0, eval)("(" + fn + ")");
      const res = await assistant(profile, null, advance);
      const vals = {};
      document.querySelectorAll("input,select,textarea").forEach((f) => {
        if (f.id) vals[f.id] = ["checkbox", "radio"].includes(f.type) ? f.checked : f.value;
      });
      return { res, vals, clicked, submitted };
    },
    [fn, profile, advance],
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

let failed = 0;
for (const [name, f] of tests) {
  try {
    await f();
    console.log(`ok - ${name}`);
  } catch (e) {
    failed++;
    console.log(`not ok - ${name}\n  ${e.message.split("\n").join("\n  ")}`);
  }
}
await browser.close();
console.log(`${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
