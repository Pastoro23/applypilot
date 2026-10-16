// Run with: node --experimental-strip-types --test tests/job-posting.test.ts
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { htmlToText, parseJobUrl, readJobPosting } from "../app/job-posting.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(routes: Record<string, unknown>) {
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL) => {
    const url = String(input);
    calls.push(url);
    const body = routes[url];
    if (body === undefined) return new Response("not found", { status: 404 });
    return typeof body === "string"
      ? new Response(body, { headers: { "content-type": "text/html" } })
      : Response.json(body);
  }) as typeof fetch;
  return calls;
}

test("recognizes job board links", () => {
  assert.deepEqual(parseJobUrl("https://boards.greenhouse.io/acme/jobs/4012345"), { kind: "greenhouse", board: "acme", id: "4012345" });
  assert.deepEqual(parseJobUrl("https://job-boards.greenhouse.io/acme/jobs/4012345?gh_src=x"), { kind: "greenhouse", board: "acme", id: "4012345" });
  assert.deepEqual(parseJobUrl("https://boards.greenhouse.io/embed/job_app?for=acme&token=777"), { kind: "greenhouse", board: "acme", id: "777" });
  assert.deepEqual(parseJobUrl("https://jobs.lever.co/acme/5a1b-22/apply"), { kind: "lever", company: "acme", id: "5a1b-22", eu: false });
  assert.deepEqual(parseJobUrl("https://jobs.ashbyhq.com/acme/0f9e"), { kind: "ashby", org: "acme", id: "0f9e" });
  assert.deepEqual(parseJobUrl("https://jobs.smartrecruiters.com/jobs/1"), { kind: "page" });
});

test("turns posting HTML into readable text", () => {
  assert.equal(
    htmlToText("<p>Do things &amp; stuff .</p><ul><li>One</li><li>Two</li></ul><script>x()</script>"),
    "Do things & stuff.\n- One\n- Two",
  );
});

test("reads a Greenhouse posting", async () => {
  const calls = stubFetch({
    "https://boards-api.greenhouse.io/v1/boards/acme/jobs/42": {
      title: "Help Desk Analyst",
      company_name: "Acme Health",
      location: { name: "Atlanta, GA" },
      content: "&lt;p&gt;Resolve &lt;strong&gt;tier 1&lt;/strong&gt; tickets&lt;/p&gt;&lt;ul&gt;&lt;li&gt;Active Directory&lt;/li&gt;&lt;/ul&gt;",
    },
  });
  const posting = await readJobPosting("https://boards.greenhouse.io/acme/jobs/42");
  assert.equal(calls.length, 1);
  assert.equal(posting.role, "Help Desk Analyst");
  assert.equal(posting.company, "Acme Health");
  assert.equal(posting.location, "Atlanta, GA");
  assert.equal(posting.description, "Resolve tier 1 tickets\n- Active Directory");
});

test("reads a Lever posting", async () => {
  stubFetch({
    "https://api.lever.co/v0/postings/acme-co/abc": {
      text: "QA Tester",
      categories: { location: "Remote" },
      descriptionPlain: "Test our apps.",
      lists: [{ text: "Requirements", content: "<li>Regression testing</li><li>Jira</li>" }],
      additionalPlain: "",
    },
  });
  const posting = await readJobPosting("https://jobs.lever.co/acme-co/abc");
  assert.equal(posting.company, "Acme Co");
  assert.equal(posting.role, "QA Tester");
  assert.match(posting.description, /Test our apps\.\n\nRequirements\n- Regression testing\n- Jira/);
});

test("reads an Ashby posting", async () => {
  stubFetch({
    "https://api.ashbyhq.com/posting-api/job-board/acme": {
      jobs: [
        { id: "other", title: "Nope" },
        { id: "0f9e", title: "Field Technician", location: "Decatur, GA", descriptionPlain: "Install network gear." },
      ],
    },
  });
  const posting = await readJobPosting("https://jobs.ashbyhq.com/acme/0f9e");
  assert.equal(posting.role, "Field Technician");
  assert.equal(posting.description, "Install network gear.");
});

test("falls back to JobPosting structured data on other career sites", async () => {
  stubFetch({
    "https://jobs.smartrecruiters.com/jobs/1": `<html><script type="application/ld+json">{"@graph":[{"@type":"Organization"},{"@type":"JobPosting","title":"Data Center Tech","hiringOrganization":{"name":"Example"},"jobLocation":[{"address":{"addressLocality":"Atlanta","addressRegion":"GA"}}],"description":"&lt;p&gt;Swap hardware&lt;/p&gt;"}]}</script></html>`,
  });
  const posting = await readJobPosting("https://jobs.smartrecruiters.com/jobs/1");
  assert.deepEqual(posting, {
    company: "Example",
    role: "Data Center Tech",
    location: "Atlanta, GA",
    description: "Swap hardware",
    source: "structured-data",
  });
});

test("explains script-only pages and missing jobs instead of failing silently", async () => {
  stubFetch({ "https://jobs.smartrecruiters.com/spa": "<html><body><div id=root></div></body></html>" });
  await assert.rejects(readJobPosting("https://jobs.smartrecruiters.com/spa"), /Paste the description instead/);
  await assert.rejects(readJobPosting("https://boards.greenhouse.io/acme/jobs/999"), /no longer posted/);
});
