# ApplyPilot

A private job application workspace built with React, TypeScript, Tailwind,
Vinext/Vite, Cloudflare Workers, D1 and Drizzle. It includes a Chrome Manifest V3
application assistant.

The dashboard stores an application profile, job queue and employer account
metadata. Tailoring accepts reviewed master-resume text, reads supported job
postings and generates an editable resume and cover letter with Word downloads.

## Corrections in this source

- PDF uploads return a preview. Only an explicit save changes the master resume.
- Tailoring saves the current description before generating and rejects stale inputs.
- Automatic job reading uses approved HTTPS job-board domains, checks every redirect,
  and caps response size at 2 MiB with a 12-second deadline. Other sites use pasted text.
- AI work is owner-scoped, limited to 6 attempts per rolling hour and 20 per rolling
  day, and runs at most one operation per owner at a time. Identical successful
  inputs reuse a result for 24 hours. SDK automatic retries are disabled.
- Optimistic revisions prevent late responses from overwriting newer edits.
  Prior tailored versions can be reviewed and saved again from the UI.
- The extension download contains only current v2 files. Builds regenerate it.
- AI output is described as requiring factual review; it is not guaranteed correct.

## Runtime and configuration

Use Node.js 24 for the included test suite (which uses the experimental built-in
SQLite adapter). The original install/build wrappers require Linux, Bash,
`flock`, `curl`, `sha256sum` and GNU `timeout`.

`npm run install:ci` installs the lockfile; `npm run dev` runs development;
`npm run build` builds the Worker/client and extension. `npm run typecheck`
checks TypeScript. `npm run test:unit` runs the regression tests. `npm test`
builds, runs unit tests and exercises the built Worker in process with synthetic
identity and a temporary database. These test adapters are not application routes.

The existing Site identity and bindings are in `.openai/hosting.json`.
D1 uses `DB`; `BUCKET` is retained but the original PDF is not stored in R2.
Migrations are under `drizzle/`; Sites applies pending migrations on deployment.
`npm run db:generate` generates a migration after a schema change.

Configure `ANTHROPIC_API_KEY` as a hosted runtime secret to enable PDF extraction
and AI generation. The optional `ANTHROPIC_BASE_URL` is server-side only. Never
put secret values in source or browser code. No API key is included in this repo.
Pasted-resume saving and the tracker do not require an AI key.

Hosted identity comes from Sites-controlled ChatGPT identity headers. Outside
Sites, use a verified authentication provider and trusted gateway; do not accept
public identity-header spoofing. Existing data ownership remains email scoped.

## Scope and verification

Automatic reading supports Greenhouse, Lever, Ashby, Workday, iCIMS,
SmartRecruiters, Jobvite and Taleo domains. This is job-description import,
not a job-discovery feed. Parsing a job board does not prove that the separate
Chrome form-filling assistant works on every page of that platform.

The source includes migrations, metadata seeds and the extension, but does not
contain production database rows, original personal resume documents, secrets
or browser extension storage. The extension still requires manual profile and
resume import and manual final submission.

Regression coverage includes extraction preview versus save, failed-save handling,
latest-description sequencing, URL/redirect restrictions, time/size bounds,
AI limits/cache/concurrency, owner isolation, preserved versions and the compiled
Worker's unsigned/signed API behavior. Live paid AI calls and browser/ATS flows
require separate testing with the configured service and a real browser.
