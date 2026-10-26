"use client";

import { useEffect, useState, type ReactNode } from "react";
import type { TailoredResume } from "./ai";
import { tailorWithLatestDescription } from "./tailoring-actions";

export type TailorableApplication = {
  id: string;
  company: string;
  role: string;
  jobDescription: string;
  tailoredJson: string | null;
  tailoredAt: string | null;
  tailoredRevision: number;
};

type MasterResume = { content: string; sourceFilename: string; updatedAt: string };

const inputClass =
  "w-full rounded-xl border border-slate-700/70 bg-[#0a1627] px-3.5 py-3 text-sm text-slate-100 outline-none transition placeholder:text-slate-600 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/15";
const primaryButton =
  "rounded-xl bg-blue-600 px-5 py-3 text-sm font-semibold text-white transition hover:bg-blue-500 disabled:opacity-50";
const secondaryButton =
  "rounded-xl border border-slate-600 bg-slate-900/30 px-4 py-2.5 text-sm font-semibold text-slate-200 transition hover:bg-slate-800/70 disabled:opacity-50";

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const payload = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
  return payload;
}

export function parseTailored(application: TailorableApplication): TailoredResume | null {
  if (!application.tailoredJson) return null;
  try {
    return JSON.parse(application.tailoredJson) as TailoredResume;
  } catch {
    return null;
  }
}

/* ---------- Your resume (source of facts) ---------- */

export function MasterResumePanel() {
  const [resume, setResume] = useState<MasterResume | null>(null);
  const [draft, setDraft] = useState("");
  const [sourceFilename, setSourceFilename] = useState("");
  const [needsReview, setNeedsReview] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"" | "saving" | "reading">("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    requestJson<{ resume: MasterResume | null }>("/api/master-resume")
      .then((result) => {
        setResume(result.resume);
        setDraft(result.resume?.content ?? "");
        setSourceFilename(result.resume?.sourceFilename ?? "");
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Could not load your resume."))
      .finally(() => setLoading(false));
  }, []);

  async function save() {
    setBusy("saving");
    setError("");
    try {
      const result = await requestJson<{ resume: MasterResume }>("/api/master-resume", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: draft, sourceFilename }),
      });
      setResume(result.resume);
      setNeedsReview(false);
      setReviewed(false);
      setNote("Resume saved. Review all generated facts before using a tailored version.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not save your resume.");
    } finally {
      setBusy("");
    }
  }

  async function upload(file: File) {
    setBusy("reading");
    setError("");
    try {
      const body = new FormData();
      body.append("file", file);
      const result = await requestJson<{ extraction: { content: string; sourceFilename: string } }>("/api/master-resume", { method: "POST", body });
      setDraft(result.extraction.content);
      setSourceFilename(result.extraction.sourceFilename);
      setNeedsReview(true);
      setReviewed(false);
      setNote("PDF preview ready. Your saved resume is unchanged. Review the text, confirm below, then save it.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not read that PDF.");
    } finally {
      setBusy("");
    }
  }

  return (
    <section className="rounded-[24px] border border-blue-500/25 bg-gradient-to-br from-[#0f2240] to-[#0d1a2c] p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-2xl">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-blue-300">Source of truth for tailoring</p>
          <h2 className="mt-1.5 text-lg font-semibold text-white">Your resume</h2>
          <p className="mt-1.5 text-sm leading-6 text-slate-400">
            Upload your best, most complete resume as a PDF or paste its text. ApplyPilot uses this as its factual source. AI can make mistakes, so review extracted text and every generated resume before using them.
          </p>
        </div>
        <label className={`${secondaryButton} cursor-pointer`}>
          {busy === "reading" ? "Reading PDF…" : "Upload PDF"}
          <input
            type="file"
            accept="application/pdf,.pdf"
            className="hidden"
            disabled={loading || busy !== ""}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void upload(file);
            }}
          />
        </label>
      </div>
      {loading ? (
        <p className="mt-5 text-sm text-slate-500">Loading…</p>
      ) : (
        <>
          <textarea
            aria-label="Resume text"
            className={`${inputClass} mt-5 min-h-[260px] font-mono text-xs leading-5`}
            placeholder="Paste your full resume here: contact details, summary, every job with dates and bullets, education, certifications and skills."
            value={draft}
            disabled={busy !== ""}
            onChange={(event) => setDraft(event.target.value)}
          />
          {needsReview && (
            <label className="mt-3 flex items-start gap-3 text-sm text-amber-100">
              <input type="checkbox" checked={reviewed} onChange={(event) => setReviewed(event.target.checked)} className="mt-1" />
              I reviewed the extracted text and want to use it as my saved resume.
            </label>
          )}
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-slate-500">
              {resume
                ? `Saved ${formatWhen(resume.updatedAt)}${resume.sourceFilename ? ` from ${resume.sourceFilename}` : ""} · ${resume.content.length.toLocaleString()} characters`
                : "Not saved yet"}
            </p>
            <button
              onClick={() => void save()}
              disabled={busy !== "" || (needsReview && !reviewed) || (draft.trim() === (resume?.content ?? "") && sourceFilename === (resume?.sourceFilename ?? "")) || draft.trim().length < 200 || draft.trim().length > 30000}
              className={primaryButton}
            >
              {busy === "saving" ? "Saving…" : "Save resume"}
            </button>
          </div>
        </>
      )}
      {note && !error && <p className="mt-3 text-sm text-emerald-300">{note}</p>}
      {error && <p className="mt-3 text-sm text-rose-300">{error}</p>}
    </section>
  );
}

/* ---------- Reading a job link ---------- */

export type JobPosting = { company: string; role: string; location: string; description: string; source: string };

export async function readJobLink(url: string) {
  const result = await requestJson<{ posting: JobPosting }>("/api/job-details", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url }),
  });
  return result.posting;
}

/* ---------- Tailoring one application ---------- */

export function TailorPanel({
  application,
  onUpdated,
}: {
  application: TailorableApplication;
  onUpdated: (application: TailorableApplication) => void;
}) {
  const saved = parseTailored(application);
  const [description, setDescription] = useState(application.jobDescription);
  const [instructions, setInstructions] = useState("");
  const [draft, setDraft] = useState<TailoredResume | null>(saved);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<"" | "description" | "tailoring" | "saving">("");
  const [error, setError] = useState("");
  const [history, setHistory] = useState<{ id: string; revision: number; tailoredJson: string; createdAt: string }[]>([]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);

  async function saveDescription() {
    setBusy("description");
    setError("");
    try {
      const result = await requestJson<{ application: TailorableApplication }>("/api/applications", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: application.id, jobDescription: description }),
      });
      onUpdated(result.application);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not save the description.");
    } finally {
      setBusy("");
    }
  }

  async function tailor() {
    if (saved && !window.confirm("Create a new tailored version? The current saved version will remain available in version history.")) return;
    setBusy("tailoring");
    setError("");
    try {
      const result = await tailorWithLatestDescription(requestJson, application, description, instructions, onUpdated);
      setDraft(parseTailored(result.application));
      setEditing(false);
      onUpdated(result.application);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not tailor the resume.");
    } finally {
      setBusy("");
    }
  }

  async function saveEdits() {
    if (!draft) return;
    setBusy("saving");
    setError("");
    try {
      const result = await requestJson<{ application: TailorableApplication }>("/api/tailor", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ applicationId: application.id, tailored: draft, revision: application.tailoredRevision }),
      });
      setEditing(false);
      onUpdated(result.application);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not save your edits.");
    } finally {
      setBusy("");
    }
  }

  async function loadHistory() {
    try {
      const result = await requestJson<{ versions: typeof history }>(`/api/tailor?applicationId=${encodeURIComponent(application.id)}`);
      setHistory(result.versions);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not load version history."); }
  }
  const hasDescription = description.trim().length >= 100;

  return (
    <div className="mt-1 space-y-4 rounded-2xl border border-blue-500/20 bg-[#0b182b] p-4 sm:p-5">
      <details open={application.jobDescription.trim().length < 100} className="group">
        <summary className="cursor-pointer text-xs font-semibold uppercase tracking-[0.15em] text-slate-400">
          Job description {hasDescription ? `· ${description.length.toLocaleString()} characters` : "· needed"}
        </summary>
        <textarea
          aria-label="Job description"
          className={`${inputClass} mt-3 min-h-[160px] text-xs leading-5`}
          placeholder="Paste the full posting: responsibilities, requirements, nice-to-haves."
          value={description}
          disabled={busy !== ""}
          onChange={(event) => setDescription(event.target.value)}
        />
        <div className="mt-2 flex justify-end">
          <button
            onClick={() => void saveDescription()}
            disabled={busy !== "" || description.trim() === application.jobDescription.trim()}
            className={secondaryButton}
          >
            {busy === "description" ? "Saving…" : "Save description"}
          </button>
        </div>
      </details>

      <div className="grid gap-3 md:grid-cols-[1fr_auto] md:items-end">
        <label className="block">
          <span className="mb-2 block text-xs font-semibold text-slate-400">Anything to emphasize? (optional)</span>
          <input
            className={inputClass}
            placeholder="e.g. lead with my CompTIA A+ and hospital IT work"
            value={instructions}
            disabled={busy !== ""}
            onChange={(event) => setInstructions(event.target.value)}
          />
        </label>
        <button onClick={() => void tailor()} disabled={busy !== "" || !hasDescription} className={primaryButton}>
          {busy === "tailoring" ? "Tailoring… (about a minute)" : saved ? "Re-tailor" : "Tailor my resume"}
        </button>
      </div>
      {error && <p className="text-sm text-rose-300">{error}</p>}
      <p className="text-xs leading-5 text-slate-400">Your latest description is saved before tailoring. AI fit scores are estimates; check every fact before applying. Identical requests reuse a recent result. AI limit: 30 requests per hour and 80 per day.</p>
      {saved && (
        <details onToggle={(event) => { if (event.currentTarget.open) void loadHistory(); }} className="text-xs text-slate-400">
          <summary className="cursor-pointer">Previous saved versions</summary>
          {history.length === 0 ? <p className="mt-2">No earlier versions loaded.</p> : history.map((version) => (
            <button key={version.id} className={`${secondaryButton} mr-2 mt-2`} disabled={busy !== ""} onClick={() => {
              const prior = parseTailored({ ...application, tailoredJson: version.tailoredJson });
              if (prior) { setDraft(prior); setEditing(true); }
            }}>Review version {version.revision} · {formatWhen(version.createdAt)}</button>
          ))}
        </details>
      )}

      {draft && (
        <TailoredView
          tailored={draft}
          editing={editing}
          onChange={setDraft}
          application={application}
          actions={
            <>
              {editing ? (
                <>
                  <button onClick={() => { setDraft(saved); setEditing(false); }} className={secondaryButton}>Cancel</button>
                  <button onClick={() => void saveEdits()} disabled={busy !== "" || !dirty} className={primaryButton}>
                    {busy === "saving" ? "Saving…" : "Save edits"}
                  </button>
                </>
              ) : (
                <>
                  <button onClick={() => setEditing(true)} disabled={busy !== ""} className={secondaryButton}>Edit</button>
                  <button onClick={() => void downloadResumePdf(draft, application)} className={secondaryButton}>Resume (.pdf)</button>
                  <button onClick={() => void downloadResumeDocx(draft, application)} className={secondaryButton}>Resume (.docx)</button>
                  <button onClick={() => void downloadCoverLetterDocx(draft, application)} className={secondaryButton}>Cover letter (.docx)</button>
                </>
              )}
            </>
          }
        />
      )}
    </div>
  );
}

function TailoredView({
  tailored,
  editing,
  onChange,
  application,
  actions,
}: {
  tailored: TailoredResume;
  editing: boolean;
  onChange: (next: TailoredResume) => void;
  application: TailorableApplication;
  actions: ReactNode;
}) {
  const resume = tailored.resume;
  const setResume = (patch: Partial<TailoredResume["resume"]>) => onChange({ ...tailored, resume: { ...resume, ...patch } });
  const covered = tailored.requirements.filter((item) => item.covered).length;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-[auto_1fr] sm:items-center">
        <div className="grid h-16 w-16 place-items-center rounded-2xl border border-blue-500/30 bg-blue-500/10">
          <span className="text-xl font-semibold text-white">{Math.round(tailored.fitScore)}</span>
        </div>
        <div>
          <p className="text-sm font-semibold text-white">
            Fit for {application.role} at {application.company} · {covered} of {tailored.requirements.length} requirements covered
          </p>
          {typeof tailored.originalScore === "number" && (
            <p className="mt-1 text-xs text-slate-400">Match score: {Math.round(tailored.originalScore)} before tailoring → {Math.round(tailored.fitScore)} after</p>
          )}
          <p className="mt-1 text-sm leading-6 text-slate-400">{tailored.fitSummary}</p>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_1.4fr]">
        <div className="space-y-4">
          <Box title="What the job asks for">
            <ul className="space-y-2">
              {tailored.requirements.map((item) => (
                <li key={item.requirement} className="flex gap-2.5 text-xs leading-5">
                  <span className={`mt-0.5 shrink-0 font-bold ${item.covered ? "text-emerald-400" : "text-amber-400"}`}>{item.covered ? "✓" : "!"}</span>
                  <span>
                    <span className="text-slate-200">{item.requirement}</span>
                    {item.evidence && <span className="block text-slate-500">{item.evidence}</span>}
                  </span>
                </li>
              ))}
            </ul>
          </Box>
          {(tailored.missingKeywords?.length ?? 0) > 0 && (
            <Box title="Top missing keywords">
              <ul className="space-y-2">
                {tailored.missingKeywords!.map((item) => (
                  <li key={item.keyword} className="text-xs leading-5">
                    <span className="text-slate-200">{item.keyword}</span>
                    <span className={`ml-2 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${item.kind === "wording" ? "bg-emerald-500/15 text-emerald-300" : "bg-amber-500/15 text-amber-300"}`}>
                      {item.kind === "wording" ? "Added" : "You don't show this"}
                    </span>
                    {item.note && <span className="block text-slate-500">{item.note}</span>}
                  </li>
                ))}
              </ul>
            </Box>
          )}
          {(tailored.questions?.length ?? 0) > 0 && (
            <Box title="Questions that would make it stronger">
              <ul className="list-disc space-y-1 pl-4 text-xs leading-5 text-blue-200/80">
                {tailored.questions!.map((question) => <li key={question}>{question}</li>)}
              </ul>
              <p className="mt-2 text-[11px] text-slate-500">Add the answers to your notes or your saved resume, then tailor again.</p>
            </Box>
          )}
          {tailored.gaps.length > 0 && (
            <Box title="Gaps (not added to your resume)">
              <ul className="list-disc space-y-1 pl-4 text-xs leading-5 text-amber-200/80">
                {tailored.gaps.map((gap) => <li key={gap}>{gap}</li>)}
              </ul>
            </Box>
          )}
          {(tailored.atsNotes?.length ?? 0) > 0 && (
            <Box title="ATS readability">
              <ul className="list-disc space-y-1 pl-4 text-xs leading-5 text-slate-400">
                {tailored.atsNotes!.map((note) => <li key={note}>{note}</li>)}
              </ul>
            </Box>
          )}
          <Box title="What changed">
            <ul className="list-disc space-y-1 pl-4 text-xs leading-5 text-slate-400">
              {tailored.changes.map((change) => <li key={change}>{change}</li>)}
            </ul>
          </Box>
        </div>

        <div className="space-y-4">
          <div className="rounded-2xl bg-white p-5 text-slate-900 sm:p-7">
            <h3 className="text-xl font-bold">{resume.name}</h3>
            <p className="mt-0.5 text-xs text-slate-600">{resume.contactLine}</p>
            {editing ? (
              <input className="mt-3 w-full rounded border border-slate-300 px-2 py-1 text-sm font-semibold" value={resume.headline} onChange={(event) => setResume({ headline: event.target.value })} />
            ) : (
              <p className="mt-3 text-sm font-semibold text-blue-800">{resume.headline}</p>
            )}
            <ResumeSection title="Summary">
              {editing ? (
                <textarea className="min-h-[90px] w-full rounded border border-slate-300 p-2 text-xs leading-5" value={resume.summary} onChange={(event) => setResume({ summary: event.target.value })} />
              ) : (
                <p className="text-xs leading-5">{resume.summary}</p>
              )}
            </ResumeSection>
            <ResumeSection title="Skills">
              {editing ? (
                <textarea className="w-full rounded border border-slate-300 p-2 text-xs leading-5" value={resume.skills.join(", ")} onChange={(event) => setResume({ skills: event.target.value.split(",").map((skill) => skill.trim()).filter(Boolean) })} />
              ) : (
                <p className="text-xs leading-5">{resume.skills.join(" · ")}</p>
              )}
            </ResumeSection>
            <ResumeSection title="Experience">
              <div className="space-y-3">
                {resume.experience.map((job, jobIndex) => (
                  <div key={`${job.company}-${job.dates}-${jobIndex}`}>
                    <p className="text-xs font-semibold">{job.title} · {job.company}</p>
                    <p className="text-[11px] text-slate-500">{[job.location, job.dates].filter(Boolean).join(" · ")}</p>
                    {editing ? (
                      <textarea
                        aria-label={`Bullets for ${job.title}`}
                        className="mt-1 min-h-[80px] w-full rounded border border-slate-300 p-2 text-xs leading-5"
                        value={job.bullets.join("\n")}
                        onChange={(event) =>
                          setResume({
                            experience: resume.experience.map((item, index) =>
                              index === jobIndex ? { ...item, bullets: event.target.value.split("\n").map((line) => line.replace(/^[-•]\s*/, "")).filter((line) => line.trim()) } : item,
                            ),
                          })
                        }
                      />
                    ) : (
                      <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs leading-5">
                        {job.bullets.map((bullet) => <li key={bullet}>{bullet}</li>)}
                      </ul>
                    )}
                  </div>
                ))}
              </div>
            </ResumeSection>
            {resume.education.length > 0 && (
              <ResumeSection title="Education">
                {resume.education.map((item) => (
                  <p key={`${item.credential}-${item.school}`} className="text-xs leading-5">{[item.credential, item.school, item.dates].filter(Boolean).join(" · ")}</p>
                ))}
              </ResumeSection>
            )}
            {resume.certifications.length > 0 && (
              <ResumeSection title="Certifications">
                <p className="text-xs leading-5">{resume.certifications.join(" · ")}</p>
              </ResumeSection>
            )}
          </div>

          <Box title="Cover letter">
            {editing ? (
              <textarea className={`${inputClass} min-h-[220px] text-xs leading-5`} value={tailored.coverLetter} onChange={(event) => onChange({ ...tailored, coverLetter: event.target.value })} />
            ) : (
              <p className="whitespace-pre-line text-xs leading-5 text-slate-300">{tailored.coverLetter}</p>
            )}
          </Box>
          <div className="flex flex-wrap justify-end gap-2">{actions}</div>
        </div>
      </div>
    </div>
  );
}

function Box({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-2xl border border-slate-800 bg-[#0a1627] p-4">
      <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.15em] text-slate-500">{title}</p>
      {children}
    </div>
  );
}

function ResumeSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mt-4">
      <p className="mb-1.5 border-b border-slate-300 pb-0.5 text-[11px] font-bold uppercase tracking-[0.12em] text-slate-700">{title}</p>
      {children}
    </div>
  );
}

function formatWhen(value: string) {
  const date = new Date(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/* ---------- Word downloads ---------- */

function fileBase(tailored: TailoredResume, application: TailorableApplication) {
  return `${tailored.resume.name} ${application.company}`.replace(/[^\w]+/g, "_").replace(/^_|_$/g, "");
}

async function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

async function downloadResumePdf(tailored: TailoredResume, application: TailorableApplication) {
  const { buildResumePdf } = await import("./resume-pdf");
  const bytes = await buildResumePdf(tailored.resume);
  await saveBlob(new Blob([bytes as BlobPart], { type: "application/pdf" }), `${fileBase(tailored, application)}_Resume.pdf`);
}

async function downloadResumeDocx(tailored: TailoredResume, application: TailorableApplication) {
  const { Document, Packer, Paragraph, TextRun, BorderStyle } = await import("docx");
  const resume = tailored.resume;
  const heading = (text: string) =>
    new Paragraph({
      spacing: { before: 200, after: 80 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "999999", space: 1 } },
      children: [new TextRun({ text: text.toUpperCase(), bold: true, size: 20 })],
    });
  const body = (text: string, options: { bold?: boolean; italics?: boolean } = {}) =>
    new Paragraph({ spacing: { after: 40 }, children: [new TextRun({ text, size: 20, ...options })] });

  const children = [
    new Paragraph({ children: [new TextRun({ text: resume.name, bold: true, size: 32 })] }),
    body(resume.contactLine),
    new Paragraph({ spacing: { before: 120 }, children: [new TextRun({ text: resume.headline, bold: true, size: 22 })] }),
    heading("Summary"),
    body(resume.summary),
    heading("Skills"),
    body(resume.skills.join(" • ")),
    heading("Experience"),
    ...resume.experience.flatMap((job) => [
      new Paragraph({
        spacing: { before: 120 },
        children: [new TextRun({ text: `${job.title}, ${job.company}`, bold: true, size: 20 })],
      }),
      body([job.location, job.dates].filter(Boolean).join(" | "), { italics: true }),
      ...job.bullets.map((bullet) => new Paragraph({ bullet: { level: 0 }, children: [new TextRun({ text: bullet, size: 20 })] })),
    ]),
    ...(resume.education.length
      ? [heading("Education"), ...resume.education.map((item) => body([item.credential, item.school, item.dates].filter(Boolean).join(", ")))]
      : []),
    ...(resume.certifications.length ? [heading("Certifications"), body(resume.certifications.join(" • "))] : []),
  ];

  const document = new Document({
    styles: { default: { document: { run: { font: "Calibri" } } } },
    sections: [{ properties: { page: { margin: { top: 720, bottom: 720, left: 900, right: 900 } } }, children }],
  });
  await saveBlob(await Packer.toBlob(document), `${fileBase(tailored, application)}_Resume.docx`);
}

async function downloadCoverLetterDocx(tailored: TailoredResume, application: TailorableApplication) {
  const { Document, Packer, Paragraph, TextRun } = await import("docx");
  const paragraphs = tailored.coverLetter.split(/\n\s*\n/).map(
    (text) =>
      new Paragraph({
        spacing: { after: 200 },
        children: text.trim().split("\n").map((line, index) => new TextRun({ text: line, size: 22, break: index ? 1 : 0 })),
      }),
  );
  const document = new Document({
    styles: { default: { document: { run: { font: "Calibri" } } } },
    sections: [
      {
        children: [
          new Paragraph({ children: [new TextRun({ text: tailored.resume.name, bold: true, size: 28 })] }),
          new Paragraph({ spacing: { after: 300 }, children: [new TextRun({ text: tailored.resume.contactLine, size: 20 })] }),
          ...paragraphs,
        ],
      },
    ],
  });
  await saveBlob(await Packer.toBlob(document), `${fileBase(tailored, application)}_Cover_Letter.docx`);
}
