import { sql } from "drizzle-orm";
import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

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
