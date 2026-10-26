import type { TailoredResume } from "./ai";
import type { Ats } from "./apply-target.ts";
import { buildAutofillProfile, profileHash, sha256Hex, type ProfileForExport } from "./profile-records.ts";
import type { ApprovedItem, SubmitSettings } from "./submission-store.ts";

// Builds what Chrome needs to send approved jobs: each job's own resume PDF (the same bytes every time for one
// revision), its hash, and the saved profile the approval was made with. Runs in the dashboard tab.

export const MAX_BATCH = 20;
export const MAX_PDF_BYTES = 2 * 1024 * 1024; // the extension refuses anything larger
const MAX_COVER_LETTER = 4000;
const B64_CHUNK = 0x8000;

export type AutofillProfile = ReturnType<typeof buildAutofillProfile>;
export type BatchResume = { name: string; type: "application/pdf"; size: number; sha256: string; b64: string };
export type BatchJob = {
  approvalId: string; applicationId: string; jobKey: string; ats: Ats; applyUrls: string[]; company: string; role: string;
  revision: number; approvedAt: string; expiresAt: string; supersedesId: string | null;
  profile: AutofillProfile; profileHash: string; resume: BatchResume; coverLetter: string;
};
export type Batch = {
  batchId: string; createdAt: string;
  // Informational only: the server decides at claim time.
  settings: { allowInvisibleCaptcha: boolean; allowOptionalSensitiveBlank: boolean; dailyCap: number; auto: Record<Ats, boolean> };
  jobs: BatchJob[];
};
export type BatchApplication = {
  id: string; company: string; role: string; tailoredJson: string | null; tailoredAt: string | null; tailoredRevision: number;
};
export type BatchSkip = { applicationId: string; code: string; reason: string };

export function bytesToBase64(bytes: Uint8Array): string {
  // btoa needs one binary string; building it in chunks keeps fromCharCode under the argument limit.
  let binary = "";
  for (let i = 0; i < bytes.length; i += B64_CHUNK) binary += String.fromCharCode(...bytes.subarray(i, i + B64_CHUNK));
  return btoa(binary);
}

// Only the person's name, never the company, so an employer never sees another employer's name.
// NFC and trim, like pdfSafe(): its other changes swap one non-word character for another, which this collapses anyway.
// That keeps pdf-lib out of the dashboard's first load.
export function resumeFilename(name: string): string {
  const base = (name ?? "").normalize("NFC").trim().replace(/[^\w]+/g, "_").replace(/^_|_$/g, "").slice(0, 120).replace(/_$/, "");
  return base ? `${base}_Resume.pdf` : "Resume.pdf";
}

export function tailoredOf(app: Pick<BatchApplication, "tailoredJson">): TailoredResume | null {
  if (!app.tailoredJson) return null;
  try {
    const parsed = JSON.parse(app.tailoredJson) as TailoredResume;
    return parsed && typeof parsed === "object" && parsed.resume && typeof parsed.resume.name === "string" ? parsed : null;
  } catch {
    return null;
  }
}

// The PDF's date is the revision's tailoredAt, so rebuilding a revision gives the same file.
export function tailoredDate(value: string | null): Date | null {
  if (!value) return null;
  const date = new Date(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

export async function resumePdfFor(app: BatchApplication): Promise<{ bytes: Uint8Array; name: string } | null> {
  const tailored = tailoredOf(app);
  const date = tailoredDate(app.tailoredAt);
  if (!tailored || !date) return null;
  const { buildResumePdf } = await import("./resume-pdf.ts");
  return { bytes: await buildResumePdf(tailored.resume, { date }), name: resumeFilename(tailored.resume.name) };
}

// Why an approved item can't go into the batch, or null when it can. Cheap checks only; the PDF comes after.
export function batchSkip(
  item: ApprovedItem, app: BatchApplication | undefined, currentProfileHash: string, now: number,
): { code: string; reason: string } | null {
  if (!app) return { code: "not_found", reason: "This job is no longer in your list." };
  if (app.tailoredRevision !== item.revision) return { code: "resume_changed", reason: "The resume changed. Review it again." };
  if (!tailoredOf(app) || !tailoredDate(app.tailoredAt)) return { code: "not_tailored", reason: "Make the tailored resume first" };
  if (currentProfileHash !== item.profileHash) {
    return { code: "profile_changed", reason: "Your profile changed after you approved. Approve again." };
  }
  const expires = Date.parse(item.expiresAt);
  if (!Number.isFinite(expires) || expires <= now) return { code: "expired", reason: "Approval expired" };
  return null;
}

export async function buildBatch(
  input: { approved: ApprovedItem[]; applications: BatchApplication[]; savedProfile: ProfileForExport; settings: SubmitSettings },
  opts: { now?: number } = {},
): Promise<{ batch: Batch; skipped: BatchSkip[] }> {
  const now = opts.now ?? Date.now();
  // The saved profile, never unsaved edits: the server hashed what it has stored.
  const profile = buildAutofillProfile(input.savedProfile);
  const hash = await profileHash(profile);
  const skipped: BatchSkip[] = [];
  const jobs: BatchJob[] = [];
  for (const item of input.approved.slice(0, MAX_BATCH)) {
    const app = input.applications.find((candidate) => candidate.id === item.applicationId);
    const skip = batchSkip(item, app, hash, now);
    if (skip || !app) {
      skipped.push({ applicationId: item.applicationId, ...(skip ?? { code: "not_found", reason: "This job is no longer in your list." }) });
      continue;
    }
    let pdf: { bytes: Uint8Array; name: string } | null = null;
    try {
      pdf = await resumePdfFor(app);
    } catch {
      pdf = null;
    }
    if (!pdf) {
      skipped.push({ applicationId: item.applicationId, code: "resume_failed", reason: "Couldn't make the resume PDF. Open the resume and try again." });
      continue;
    }
    if (pdf.bytes.length > MAX_PDF_BYTES) {
      skipped.push({ applicationId: item.applicationId, code: "resume_too_big", reason: "The resume PDF is too large to attach. Shorten it and approve again." });
      continue;
    }
    const tailored = tailoredOf(app)!;
    const letter = typeof tailored.coverLetter === "string" ? tailored.coverLetter : "";
    jobs.push({
      approvalId: item.approvalId,
      applicationId: item.applicationId,
      jobKey: item.jobKey,
      ats: item.ats,
      applyUrls: [...item.applyUrls],
      company: app.company.slice(0, 300),
      role: app.role.slice(0, 300),
      revision: item.revision,
      approvedAt: item.approvedAt,
      expiresAt: item.expiresAt,
      supersedesId: item.supersedesId,
      profile,
      profileHash: item.profileHash,
      resume: { name: pdf.name, type: "application/pdf", size: pdf.bytes.length, sha256: await sha256Hex(pdf.bytes), b64: bytesToBase64(pdf.bytes) },
      coverLetter: item.includeCoverLetter ? letter.trim().slice(0, MAX_COVER_LETTER) : "",
    });
  }
  for (const item of input.approved.slice(MAX_BATCH)) {
    skipped.push({ applicationId: item.applicationId, code: "too_many", reason: `Chrome takes ${MAX_BATCH} at a time. Send the rest next.` });
  }
  const { settings } = input;
  return {
    batch: {
      batchId: crypto.randomUUID(),
      createdAt: new Date(now).toISOString(),
      settings: {
        allowInvisibleCaptcha: settings.allowInvisibleCaptcha,
        allowOptionalSensitiveBlank: settings.allowOptionalSensitiveBlank,
        dailyCap: settings.dailyCap,
        auto: { greenhouse: settings.auto.greenhouse, lever: settings.auto.lever, ashby: settings.auto.ashby },
      },
      jobs,
    },
    skipped,
  };
}
