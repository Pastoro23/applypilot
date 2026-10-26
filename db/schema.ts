import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const profiles = sqliteTable("profiles", {
  ownerEmail: text("owner_email").primaryKey(),
  firstName: text("first_name").notNull().default(""),
  lastName: text("last_name").notNull().default(""),
  legalName: text("legal_name").notNull().default(""),
  profileEmail: text("profile_email").notNull().default(""),
  phone: text("phone").notNull().default(""),
  city: text("city").notNull().default(""),
  state: text("state").notNull().default(""),
  postalCode: text("postal_code").notNull().default(""),
  country: text("country").notNull().default("United States"),
  linkedIn: text("linkedin").notNull().default(""),
  workAuthorization: text("work_authorization").notNull().default(""),
  sponsorship: text("sponsorship").notNull().default(""),
  workAuthorized: text("work_authorized").notNull().default(""),
  requiresSponsorship: text("requires_sponsorship").notNull().default(""),
  skills: text("skills").notNull().default(""),
  workHistory: text("work_history_json").notNull().default("[]"),
  education: text("education_json").notNull().default("[]"),
  availability: text("availability").notNull().default(""),
  relocation: text("relocation").notNull().default(""),
  identityStatus: text("identity_status").notNull().default("needs_confirmation"),
  locationStatus: text("location_status").notNull().default("needs_confirmation"),
  workHistoryStatus: text("work_history_status").notNull().default("needs_confirmation"),
  applySettings: text("apply_settings_json").notNull().default("{}"),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const resumes = sqliteTable(
  "resumes",
  {
    id: text("id").primaryKey(),
    ownerEmail: text("owner_email").notNull(),
    slug: text("slug").notNull(),
    label: text("label").notNull(),
    category: text("category").notNull(),
    filename: text("filename").notNull(),
    fileKey: text("file_key"),
    status: text("status").notNull().default("reviewed"),
    pageCount: text("page_count").notNull().default("1"),
    recommendation: text("recommendation").notNull().default(""),
    note: text("note").notNull().default(""),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [uniqueIndex("resumes_owner_slug_unique").on(table.ownerEmail, table.slug)],
);

export const applications = sqliteTable("applications", {
  id: text("id").primaryKey(),
  ownerEmail: text("owner_email").notNull(),
  company: text("company").notNull(),
  role: text("role").notNull(),
  location: text("location").notNull().default(""),
  url: text("url").notNull().default(""),
  status: text("status").notNull().default("saved"),
  resumeId: text("resume_id"),
  notes: text("notes").notNull().default(""),
  jobDescription: text("job_description").notNull().default(""),
  tailoredJson: text("tailored_json"),
  tailoredAt: text("tailored_at"),
  tailoredRevision: integer("tailored_revision").notNull().default(0),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// The candidate's own resume as plain text: the only source of facts for tailoring.
export const masterResumes = sqliteTable("master_resumes", {
  ownerEmail: text("owner_email").primaryKey(),
  content: text("content").notNull().default(""),
  sourceFilename: text("source_filename").notNull().default(""),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const accounts = sqliteTable("accounts", {
  id: text("id").primaryKey(),
  ownerEmail: text("owner_email").notNull(),
  company: text("company").notNull(),
  loginEmail: text("login_email").notNull(),
  loginUrl: text("login_url").notNull().default(""),
  passwordManagerStatus: text("password_manager_status")
    .notNull()
    .default("save_in_apple_passwords"),
  verificationStatus: text("verification_status").notNull().default("pending"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const aiOperations = sqliteTable("ai_operations", {
  id: text("id").primaryKey(),
  ownerEmail: text("owner_email").notNull(),
  kind: text("kind").notNull(),
  inputHash: text("input_hash").notNull(),
  status: text("status").notNull(),
  resultJson: text("result_json"),
  createdAt: integer("created_at").notNull(),
});

export const tailoredVersions = sqliteTable("tailored_versions", {
  id: text("id").primaryKey(),
  ownerEmail: text("owner_email").notNull(),
  applicationId: text("application_id").notNull(),
  tailoredJson: text("tailored_json").notNull(),
  revision: integer("revision").notNull(),
  createdAt: text("created_at").notNull(),
});

// Job boards the user follows (a company's Greenhouse, Lever or Ashby board).
export const jobSources = sqliteTable(
  "job_sources",
  {
    id: text("id").primaryKey(),
    ownerEmail: text("owner_email").notNull(),
    kind: text("kind").notNull(),
    token: text("token").notNull(),
    label: text("label").notNull().default(""),
    lastCheckedAt: text("last_checked_at"),
    lastError: text("last_error").notNull().default(""),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [uniqueIndex("job_sources_owner_board_unique").on(table.ownerEmail, table.kind, table.token)],
);

// What counts as a match: words that must appear in the title, places, and words that rule a job out.
export const jobSearches = sqliteTable("job_searches", {
  ownerEmail: text("owner_email").primaryKey(),
  titleWords: text("title_words").notNull().default(""),
  locations: text("locations").notNull().default(""),
  excludeWords: text("exclude_words").notNull().default(""),
  remoteOk: text("remote_ok").notNull().default("yes"),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// Open jobs found on followed boards that match the search. status: new | queued | dismissed.
export const foundJobs = sqliteTable(
  "found_jobs",
  {
    id: text("id").primaryKey(),
    ownerEmail: text("owner_email").notNull(),
    sourceId: text("source_id").notNull(),
    kind: text("kind").notNull(),
    externalId: text("external_id").notNull(),
    company: text("company").notNull(),
    title: text("title").notNull(),
    location: text("location").notNull().default(""),
    url: text("url").notNull(),
    postedAt: text("posted_at").notNull().default(""),
    description: text("description").notNull().default(""),
    score: integer("score").notNull().default(0),
    status: text("status").notNull().default("new"),
    applicationId: text("application_id"),
    foundAt: text("found_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [uniqueIndex("found_jobs_owner_job_unique").on(table.ownerEmail, table.kind, table.externalId)],
);

// One row per approval to submit a job. state: approved | claimed | submitted | needs_you | check | not_sent | revoked | expired.
// The partial unique index keeps at most one live row per job; submitted is left out so a late result never hits a constraint.
export const submissions = sqliteTable(
  "submissions",
  {
    id: text("id").primaryKey(),
    ownerEmail: text("owner_email").notNull(),
    applicationId: text("application_id").notNull(),
    jobKey: text("job_key").notNull(),
    ats: text("ats").notNull(),
    applyUrl: text("apply_url").notNull(),
    tailoredRevision: integer("tailored_revision").notNull(),
    profileHash: text("profile_hash").notNull(),
    includeCoverLetter: integer("include_cover_letter").notNull().default(1),
    supersedesId: text("supersedes_id"),
    state: text("state").notNull().default("approved"),
    reason: text("reason").notNull().default(""),
    reasonsJson: text("reasons_json").notNull().default("[]"),
    approvedAt: text("approved_at").notNull(),
    expiresAt: text("expires_at").notNull(),
    attemptId: text("attempt_id"),
    claimMode: text("claim_mode").notNull().default(""),
    claimedAt: text("claimed_at"),
    relaxations: text("relaxations").notNull().default(""),
    clickedBy: text("clicked_by").notNull().default(""),
    resumeSha256: text("resume_sha256").notNull().default(""),
    resumeFilename: text("resume_filename").notNull().default(""),
    fillReportJson: text("fill_report_json").notNull().default("[]"),
    pageUrl: text("page_url").notNull().default(""),
    confirmationText: text("confirmation_text").notNull().default(""),
    finishedAt: text("finished_at"),
    extensionVersion: text("extension_version").notNull().default(""),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("submissions_one_live_job").on(table.ownerEmail, table.jobKey)
      .where(sql`state IN ('approved','claimed','check')`),
    index("submissions_owner_app").on(table.ownerEmail, table.applicationId),
    index("submissions_owner_claimed").on(table.ownerEmail, table.claimedAt),
  ],
);

// Append-only audit trail for submissions; kept when an application is deleted.
export const submissionEvents = sqliteTable(
  "submission_events",
  {
    id: text("id").primaryKey(),
    ownerEmail: text("owner_email").notNull(),
    submissionId: text("submission_id").notNull(),
    at: text("at").notNull(),
    actor: text("actor").notNull(),
    event: text("event").notNull(),
    detailJson: text("detail_json").notNull().default("{}"),
  },
  (table) => [index("submission_events_owner_sub").on(table.ownerEmail, table.submissionId)],
);
