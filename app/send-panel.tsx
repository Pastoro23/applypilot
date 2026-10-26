"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { isApplyTarget, type ApplyTarget, type Ats } from "./apply-target";
import type { ExtensionBridge } from "./extension-bridge";
import { buildAutofillProfile, profileHash, type ProfileForExport } from "./profile-records";
import { buildBatch, MAX_BATCH, resumeFilename, resumePdfFor, tailoredOf, type BatchApplication } from "./send-batch";
import {
  approvedItemFromRow, CALIBRATION_NEEDED,
  type ApprovedItem, type Calibration, type SkippedItem, type SubmissionRow, type SubmitSettings,
} from "./submission-store";
import { alreadySubmittedReason, checkText, isStaleClaim, pillLabel, resumeNotice, staleText } from "./submit-pill";

// "Ready to send": review the tailored jobs, approve them with one tap, and Chrome submits each with its own resume.
// Everything an employer wrote (reasons, confirmation text, labels) is rendered as plain React text.

export type SubmissionsData = {
  submissions: SubmissionRow[];
  targets: Record<string, ApplyTarget | { reason: string }>;
  settings: SubmitSettings;
  calibration: Calibration;
};
export type PanelApplication = BatchApplication & { location: string; url: string; status: string };
export type PanelProfile = ProfileForExport & { identityStatus: string; locationStatus: string; workHistoryStatus: string };
export type BridgeNotes = Record<string, { state: string; note: string }>;

const ATS_NAMES: Record<Ats, string> = { greenhouse: "Greenhouse", lever: "Lever", ashby: "Ashby" };
const ATS_LIST: Ats[] = ["greenhouse", "lever", "ashby"];
const LIVE = new Set(["approved", "claimed", "check"]);
const OPEN_STATUS = new Set(["saved", "ready"]);
const DAILY_LIMITS = [3, 5, 10, 15, 20, 25];
const RESUME_WAIT_MS = 6000;

const primaryButton = "rounded-xl bg-blue-600 px-5 py-3 text-sm font-semibold text-white transition hover:bg-blue-500 disabled:opacity-50";
const smallButton = "rounded-lg border border-slate-700 px-3 py-2 text-xs font-semibold text-slate-200 transition hover:bg-slate-800 disabled:opacity-50";
const linkButton = "text-xs font-semibold text-blue-300 hover:text-blue-200";
const inputClass =
  "w-full rounded-xl border border-slate-700/70 bg-[#0a1627] px-3.5 py-3 text-sm text-slate-100 outline-none transition placeholder:text-slate-600 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/15";

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const payload = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
  return payload;
}
const jsonBody = (method: string, body: unknown): RequestInit => ({
  method, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});
const messageOf = (reason: unknown, fallback: string) => (reason instanceof Error && reason.message ? reason.message : fallback);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const jobLabel = (app: { role: string; company: string } | undefined) => (app ? `${app.role} at ${app.company}` : "A job");

function formatWhen(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function profileConfirmed(p: PanelProfile) {
  return p.identityStatus === "confirmed" && p.locationStatus === "confirmed" && p.workHistoryStatus === "confirmed" &&
    Boolean(p.firstName.trim() && p.lastName.trim() && p.profileEmail.trim());
}

// A submitted row outranks everything, then the newest live row, then the newest of the rest.
export function newestSubmission(rows: SubmissionRow[], applicationId: string): SubmissionRow | null {
  const mine = rows.filter((row) => row.applicationId === applicationId);
  const newest = (list: SubmissionRow[]) => [...list].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  return mine.find((row) => row.state === "submitted") ?? newest(mine.filter((row) => LIVE.has(row.state))) ?? newest(mine) ?? null;
}

export type SendRow = { app: PanelApplication; target: ApplyTarget; fit: number | null; filename: string; replaces: boolean };
export type Classified = { eligible: SendRow[]; waiting: SubmissionRow[]; blocked: { app: PanelApplication; reason: string }[] };

// currentHash null means "not known yet": an approved row then counts as waiting if its resume revision still matches.
export function classifyApplications(
  applications: PanelApplication[], data: SubmissionsData, now: number, currentHash: string | null,
): Classified {
  const out: Classified = { eligible: [], waiting: [], blocked: [] };
  for (const app of applications) {
    if (!OPEN_STATUS.has(app.status)) continue;
    const target = data.targets[app.id];
    const jobKey = isApplyTarget(target) ? target.jobKey : null;
    const related = data.submissions.filter((row) => row.applicationId === app.id || (jobKey !== null && row.jobKey === jobKey));
    const submitted = related.find((row) => row.state === "submitted");
    if (submitted) {
      out.blocked.push({ app, reason: alreadySubmittedReason(submitted.clickedBy) });
      continue;
    }
    if (related.some((row) => row.state === "claimed")) {
      out.blocked.push({ app, reason: "ApplyPilot is sending this one" });
      continue;
    }
    if (related.some((row) => row.state === "check")) {
      out.blocked.push({ app, reason: "Say whether this one went through first" });
      continue;
    }
    const approved = related.filter((row) => row.state === "approved");
    const fresh = approved.find((row) => row.applicationId === app.id && row.tailoredRevision === app.tailoredRevision &&
      Date.parse(row.expiresAt) > now && (currentHash === null || row.profileHash === currentHash));
    if (fresh) {
      out.waiting.push(fresh);
      continue;
    }
    const tailored = tailoredOf(app);
    if (!tailored) out.blocked.push({ app, reason: "Not tailored yet" });
    else if (!target) out.blocked.push({ app, reason: "Reload the page to check this job" });
    else if (!isApplyTarget(target)) out.blocked.push({ app, reason: target.reason });
    else {
      const fit = Number.isFinite(tailored.fitScore) ? Math.round(tailored.fitScore) : null;
      out.eligible.push({ app, target, fit, filename: resumeFilename(tailored.resume.name), replaces: approved.length > 0 });
    }
  }
  return out;
}

function describe(list: { applicationId: string; reason: string }[], apps: PanelApplication[]) {
  const shown = list.slice(0, 3).map((item) => `${jobLabel(apps.find((app) => app.id === item.applicationId))} (${item.reason})`);
  return shown.join("; ") + (list.length > 3 ? `; and ${list.length - 3} more` : "");
}

export function ReadyToSendPanel({
  applications, data, loadError, savedProfile, bridge, now, rejected, onRejected, onReload, onViewResume, onOpenProfile, onOpenExtension,
}: {
  applications: PanelApplication[];
  data: SubmissionsData | null;
  loadError: string;
  savedProfile: PanelProfile;
  bridge: ExtensionBridge;
  now: number;
  rejected: Record<string, string>;
  onRejected: (update: Record<string, string | null>) => void;
  onReload: () => Promise<void>;
  onViewResume: (applicationId: string) => void;
  onOpenProfile: () => void;
  onOpenExtension: () => void;
}) {
  const [hash, setHash] = useState<{ of: PanelProfile; value: string } | null>(null);
  const [ticks, setTicks] = useState<Record<string, boolean>>({});
  const [includeCoverLetter, setIncludeCoverLetter] = useState(true);
  const [busy, setBusy] = useState<"" | "approve" | "send" | "stop" | "resume">("");
  const [pdfBusy, setPdfBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  // Taken by Chrome in this visit, so they count as held before the bridge's next status arrives.
  const [sentIds, setSentIds] = useState<string[]>([]);
  const [resumeAsked, setResumeAsked] = useState(false);

  // "Resume sending" reports what Chrome did, once its status says so or after a few seconds.
  useEffect(() => {
    if (!resumeAsked) return;
    const timer = window.setTimeout(() => {
      setResumeAsked(false);
      setNotice(resumeNotice(bridge.running));
    }, bridge.running ? 0 : RESUME_WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [resumeAsked, bridge.running]);

  useEffect(() => {
    let active = true;
    void profileHash(buildAutofillProfile(savedProfile)).then((value) => {
      if (active) setHash({ of: savedProfile, value });
    });
    return () => {
      active = false;
    };
  }, [savedProfile]);
  const currentHash = hash && hash.of === savedProfile ? hash.value : null;

  const view = useMemo(() => (data ? classifyApplications(applications, data, now, currentHash) : null), [applications, data, now, currentHash]);
  const answers = useMemo(() => buildAutofillProfile(savedProfile), [savedProfile]);
  const eligible = view?.eligible ?? [];
  const ticked = (id: string, index: number) => ticks[id] ?? index < MAX_BATCH;
  const selected = eligible.filter((row, index) => ticked(row.app.id, index));
  const ready = profileConfirmed(savedProfile);
  const connected = bridge.status === "connected";
  const held = new Set([...bridge.held, ...sentIds]);
  const waiting = (view?.waiting ?? []).filter((row) => !rejected[row.id]);
  const refused = connected ? (view?.waiting ?? []).filter((row) => rejected[row.id] && !held.has(row.id)) : [];
  const notHeld = connected ? waiting.filter((row) => !held.has(row.id)) : [];
  const queued = connected && !bridge.running ? waiting.filter((row) => held.has(row.id)) : [];
  const atsShown = ATS_LIST.filter((ats) => selected.some((row) => row.target.ats === ats));

  async function sendApproved(approved: ApprovedItem[], intro: string[]) {
    if (!data) return;
    const { batch, skipped } = await buildBatch({ approved, applications, savedProfile, settings: data.settings });
    const notTaken: Record<string, string | null> = {};
    const notTakenList: { applicationId: string; reason: string }[] = [];
    for (const skip of skipped) {
      const item = approved.find((candidate) => candidate.applicationId === skip.applicationId);
      if (item) notTaken[item.approvalId] = skip.reason;
      notTakenList.push(skip);
    }
    let accepted: string[] = [];
    if (batch.jobs.length) {
      const reply = await bridge.sendBatch(batch);
      accepted = reply.accepted;
      for (const reject of reply.rejected) {
        const item = approved.find((candidate) => candidate.approvalId === reject.approvalId);
        // An empty approvalId means Chrome refused the whole batch.
        if (!item && !reject.approvalId && reject.reason) intro.push(`Chrome didn't take them: ${reject.reason}`);
        if (!item) continue;
        const reason = reject.reason || "Chrome didn't take it.";
        notTaken[item.approvalId] = reason;
        notTakenList.push({ applicationId: item.applicationId, reason });
      }
      for (const id of accepted) notTaken[id] = null;
      setSentIds((current) => [...current, ...accepted]);
      // Your tap is the go-ahead, so a queue you stopped earlier starts again for these.
      if (accepted.length) await bridge.resume().catch(() => undefined);
    }
    if (Object.keys(notTaken).length) onRejected(notTaken);
    const lines = [accepted.length ? `Sending ${accepted.length} in Chrome.` : "Nothing went to Chrome.", ...intro];
    if (notTakenList.length) lines.push(`${plural(notTakenList.length, "wasn't", "weren't")} sent: ${describe(notTakenList, applications)}.`);
    setNotice(lines.join(" "));
  }

  async function approve() {
    if (!data || !selected.length) return;
    setBusy("approve");
    setError("");
    setNotice("");
    try {
      const result = await requestJson<{ approved: ApprovedItem[]; skipped: SkippedItem[]; replaced?: string[] }>("/api/submissions/approve", jsonBody("POST", {
        items: selected.map((row) => ({ applicationId: row.app.id, revision: row.app.tailoredRevision })),
        includeCoverLetter,
      }));
      // An approval this one replaced may still sit in Chrome's queue, which would refuse the new one as a duplicate.
      if (connected && result.replaced?.length) await bridge.cancel(result.replaced).catch(() => undefined);
      setTicks({});
      await onReload();
      const intro = result.skipped.length ? [`${result.skipped.length} couldn't be approved: ${describe(result.skipped, applications)}.`] : [];
      if (!result.approved.length) {
        setNotice(["Nothing was approved.", ...intro].join(" "));
        return;
      }
      if (!connected) {
        setNotice(["Approved. Open this page in Chrome on your Mac with Application Assistant 3.0 to send.", ...intro].join(" "));
        return;
      }
      try {
        await sendApproved(result.approved, intro);
      } catch (reason) {
        setError(`Approved, but Chrome didn't take them: ${messageOf(reason, "try again")} They stay approved for 24 hours; use Start sending.`);
      }
    } catch (reason) {
      setError(messageOf(reason, "Couldn't approve these jobs."));
    } finally {
      setBusy("");
    }
  }

  async function startSending(rows: SubmissionRow[]) {
    setBusy("send");
    setError("");
    setNotice("");
    try {
      await sendApproved(rows.slice(0, MAX_BATCH).map(approvedItemFromRow), []);
    } catch (reason) {
      setError(messageOf(reason, "Chrome didn't take these jobs."));
    } finally {
      setBusy("");
    }
  }

  async function resumeSending() {
    setBusy("resume");
    setError("");
    setNotice("");
    try {
      await bridge.resume();
      setResumeAsked(true);
    } catch (reason) {
      setError(messageOf(reason, "Chrome didn't answer."));
    } finally {
      setBusy("");
    }
  }

  async function stopEverything() {
    setBusy("stop");
    setError("");
    setNotice("");
    // Chrome stops first, before its next check with ApplyPilot; then the approvals not yet claimed are taken back.
    const [chrome, server] = await Promise.allSettled([
      connected ? bridge.stop() : Promise.resolve(),
      requestJson<{ revoked: string[]; tooLate: string[] }>("/api/submissions", jsonBody("PATCH", { action: "cancelAll" })),
    ]);
    if (server.status === "fulfilled" && server.value.revoked.length && connected) {
      await bridge.cancel(server.value.revoked).catch(() => undefined);
    }
    await onReload();
    if (server.status === "rejected") {
      setError(`Chrome ${chrome.status === "fulfilled" ? "stopped" : "may still be sending"}, but the approvals couldn't be cancelled: ${messageOf(server.reason, "try again")}`);
    } else {
      const { revoked, tooLate } = server.value;
      setNotice(`Stopped. ${plural(revoked.length, "approval")} cancelled.` +
        (tooLate.length ? ` ${plural(tooLate.length, "job was", "jobs were")} already at the final check; ApplyPilot will report what happened.` : ""));
    }
    setBusy("");
  }

  async function viewPdf(app: PanelApplication) {
    // Opened before the await so the browser treats it as part of your click.
    const win = window.open("", "_blank");
    setPdfBusy(app.id);
    try {
      const pdf = await resumePdfFor(app);
      if (!pdf) throw new Error("Make the tailored resume first.");
      const url = URL.createObjectURL(new Blob([pdf.bytes as BlobPart], { type: "application/pdf" }));
      if (win) {
        win.opener = null;
        win.location.href = url;
      } else {
        const link = document.createElement("a");
        link.href = url;
        link.download = pdf.name;
        link.click();
      }
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (reason) {
      win?.close();
      setError(messageOf(reason, "Couldn't make the PDF."));
    } finally {
      setPdfBusy("");
    }
  }

  const stopsFor = data?.settings ?? { allowInvisibleCaptcha: true, allowOptionalSensitiveBlank: true };

  return (
    <section id="ready-to-send" className="rounded-[24px] border border-blue-500/25 bg-[#0d1a2c] p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Approve once, Chrome sends</p>
          <h2 className="mt-1.5 text-lg font-semibold text-white">Ready to send</h2>
        </div>
        <BridgeLine bridge={bridge} onOpenExtension={onOpenExtension} />
      </div>

      <div className="mt-4 space-y-2">
        {bridge.running && (
          <Banner tone="blue" action={<button disabled={busy !== ""} onClick={() => void stopEverything()} className="rounded-lg bg-rose-500/90 px-3 py-2 text-xs font-semibold text-white hover:bg-rose-500 disabled:opacity-50">{busy === "stop" ? "Stopping…" : "Stop everything"}</button>}>
            Sending in Chrome. Keep this tab open so ApplyPilot can confirm each one.
          </Banner>
        )}
        {notHeld.length > 0 && (
          <Banner tone="amber" action={<button disabled={busy !== ""} onClick={() => void startSending(notHeld)} className="rounded-lg bg-blue-600 px-3 py-2 text-xs font-semibold text-white hover:bg-blue-500 disabled:opacity-50">{busy === "send" ? "Sending…" : "Start sending"}</button>}>
            {plural(notHeld.length, "approved application is", "approved applications are")} waiting
          </Banner>
        )}
        {refused.length > 0 && (
          <Banner tone="slate" action={<button disabled={busy !== ""} onClick={() => void startSending(refused)} className={smallButton}>Try again</button>}>
            Chrome didn&apos;t take {plural(refused.length, "approved application")}. The reason is on each job below.
          </Banner>
        )}
        {queued.length > 0 && (
          <Banner tone="slate" action={<button disabled={busy !== ""} onClick={() => void resumeSending()} className={smallButton}>{busy === "resume" ? "Opening…" : "Resume sending"}</button>}>
            {plural(queued.length, "approved application is", "approved applications are")} in Chrome&apos;s queue but not sending right now.
          </Banner>
        )}
        {bridge.status === "missing" && waiting.length > 0 && (
          <Banner tone="amber" action={<button onClick={onOpenExtension} className={smallButton}>Set up</button>}>
            {plural(waiting.length, "application is", "applications are")} approved. Open this page in Chrome on your Mac with Application Assistant 3.0 to send.
          </Banner>
        )}
      </div>

      {!data ? (
        <div className="mt-5 rounded-2xl border border-dashed border-slate-700 bg-[#0a1627] px-5 py-6 text-sm text-slate-400">
          {loadError ? (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span>{loadError}</span>
              <button onClick={() => void onReload()} className={smallButton}>Try again</button>
            </div>
          ) : "Checking which jobs can be sent…"}
        </div>
      ) : (
        <>
          {eligible.length === 0 ? (
            <p className="mt-5 rounded-2xl border border-dashed border-slate-700 bg-[#0a1627] px-5 py-6 text-sm leading-6 text-slate-400">
              Nothing is ready to send. Jobs show up here once their resume is tailored and they&apos;re on Greenhouse, Lever or Ashby.
            </p>
          ) : (
            <ul className="mt-5 space-y-2.5">
              {eligible.map((row, index) => (
                <li key={row.app.id} className="grid gap-3 rounded-2xl border border-slate-800 bg-[#0a1627] p-4 lg:grid-cols-[auto_1fr_auto] lg:items-center">
                  <input
                    type="checkbox"
                    aria-label={`Send ${jobLabel(row.app)}`}
                    className="h-4 w-4 accent-blue-500"
                    checked={ticked(row.app.id, index)}
                    onChange={(event) => setTicks({ ...ticks, [row.app.id]: event.target.checked })}
                  />
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-white">
                      {row.app.role}
                      <span className="font-normal text-slate-400"> · {row.app.company}{row.app.location ? ` · ${row.app.location}` : ""}</span>
                    </p>
                    <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                      <span className="rounded-full bg-violet-400/10 px-2.5 py-1 text-[11px] font-bold text-violet-300">{ATS_NAMES[row.target.ats]}</span>
                      {row.fit !== null && <span className="rounded-full bg-blue-400/10 px-2.5 py-1 text-[11px] font-bold text-blue-300">{row.fit}% fit</span>}
                      <span>Will attach {row.filename}</span>
                      {row.replaces && <span className="text-amber-300/80">Replaces your earlier approval</span>}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 lg:justify-end">
                    <button onClick={() => void viewPdf(row.app)} disabled={pdfBusy === row.app.id} className={smallButton}>{pdfBusy === row.app.id ? "Making…" : "View PDF"}</button>
                    <button onClick={() => onViewResume(row.app.id)} className={smallButton}>View resume</button>
                    {/^https:\/\//i.test(row.app.url) && <a href={row.app.url} target="_blank" rel="noreferrer" className={`${smallButton} text-blue-300`}>Open posting</a>}
                  </div>
                </li>
              ))}
            </ul>
          )}

          <div className="mt-5 grid gap-4 xl:grid-cols-[1.3fr_1fr]">
            <div className="rounded-2xl border border-slate-800 bg-[#0a1627] p-4">
              <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.15em] text-slate-500">What ApplyPilot will answer</p>
              <dl className="grid gap-x-6 gap-y-2.5 text-xs sm:grid-cols-2">
                <Answer label="Name">{answers.fullName}</Answer>
                <Answer label="Email">{answers.email}</Answer>
                <Answer label="Phone">{answers.phone || "Left blank"}</Answer>
                <Answer label="Location">{[answers.city, [answers.state, answers.postalCode].filter(Boolean).join(" "), answers.country].filter(Boolean).join(", ") || "Left blank"}</Answer>
                <Answer label="LinkedIn">{answers.linkedIn || "Left blank"}</Answer>
                <Answer label="Authorized to work in the U.S.">{yesNo(answers.workAuthorized)}</Answer>
                <Answer label="Needs sponsorship">{yesNo(answers.requiresSponsorship)}</Answer>
                <Answer label="Resume">Each job&apos;s own tailored resume PDF</Answer>
                <Answer label="Work history">
                  {answers.workHistory.length ? answers.workHistory.slice(0, 4).map((job, i) => <span key={i} className="block">{[job.title, job.company].filter(Boolean).join(", ")}</span>) : "None"}
                  {answers.workHistory.length > 4 && <span className="block text-slate-500">and {answers.workHistory.length - 4} more</span>}
                </Answer>
                <Answer label="Education">
                  {answers.education.length ? answers.education.slice(0, 3).map((school, i) => <span key={i} className="block">{[school.degree, school.school].filter(Boolean).join(", ")}</span>) : "None"}
                  {answers.education.length > 3 && <span className="block text-slate-500">and {answers.education.length - 3} more</span>}
                </Answer>
              </dl>
              <label className="mt-4 flex items-start gap-3 rounded-xl border border-slate-800 bg-[#091523] p-3">
                <input type="checkbox" className="mt-0.5 h-4 w-4 accent-blue-500" checked={includeCoverLetter} onChange={(event) => setIncludeCoverLetter(event.target.checked)} />
                <span>
                  <span className="block text-[11px] font-semibold uppercase tracking-[0.15em] text-slate-400">Cover letter</span>
                  <span className="mt-1 block text-xs leading-5 text-slate-400">Paste each job&apos;s own cover letter into a cover letter box when the form has one.</span>
                </span>
              </label>
            </div>
            <div className="space-y-3 rounded-2xl border border-slate-800 bg-[#0a1627] p-4 text-xs leading-5 text-slate-400">
              <p>
                <span className="font-semibold text-slate-200">Stops and leaves it for you: </span>
                {stopsFor.allowInvisibleCaptcha ? "a CAPTCHA you'd have to solve" : "any CAPTCHA"}, sign-in or account, password, legal certification,{" "}
                {stopsFor.allowOptionalSensitiveBlank ? "a required demographic or other sensitive question" : "any demographic or other sensitive question"}, a required question it can&apos;t answer, a multi-page form.
                {stopsFor.allowOptionalSensitiveBlank && " Optional demographic and sensitive questions are left blank."}
              </p>
              {data && (
                <p>
                  {(atsShown.length ? atsShown : ATS_LIST).map((ats) => modeText(ats, data)).join(" · ")}{" "}
                  <button onClick={onOpenExtension} className={linkButton}>Change</button>
                </p>
              )}
              <p>Anything that stops stays open in its own tab, already filled, and shows here as Needs you.</p>
            </div>
          </div>

          <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="text-xs leading-5 text-slate-500">
              {!ready ? (
                <span className="text-amber-200">
                  Confirm your name, location and work history on your profile first.{" "}
                  <button onClick={onOpenProfile} className={linkButton}>Open profile</button>
                </span>
              ) : selected.length > MAX_BATCH ? (
                <span className="text-amber-200">Choose up to {MAX_BATCH} at a time.</span>
              ) : (
                "Tapping approves these jobs for 24 hours. There's no second step."
              )}
            </div>
            <button
              onClick={() => void approve()}
              disabled={busy !== "" || !ready || selected.length === 0 || selected.length > MAX_BATCH}
              className={primaryButton}
            >
              {busy === "approve" ? "Approving…" : `Approve & send ${selected.length}`}
            </button>
          </div>
        </>
      )}

      {notice && <p className="mt-4 rounded-xl border border-emerald-400/20 bg-emerald-400/5 px-4 py-3 text-sm text-emerald-100">{notice}</p>}
      {error && <p className="mt-4 rounded-xl border border-rose-400/20 bg-rose-500/8 px-4 py-3 text-sm text-rose-100">{error}</p>}

      {view && view.blocked.length > 0 && (
        <div className="mt-5 border-t border-slate-800 pt-4">
          <p className="text-[11px] font-semibold uppercase tracking-[0.15em] text-slate-500">Not ready to send · {view.blocked.length}</p>
          <ul className="mt-2 divide-y divide-slate-800/80">
            {view.blocked.map(({ app, reason }) => (
              <li key={app.id} className="flex flex-col gap-1 py-2.5 text-xs sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                <span className="text-slate-300">{app.role} <span className="text-slate-500">· {app.company}</span></span>
                <span className="text-slate-500">{reason}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function modeText(ats: Ats, data: SubmissionsData) {
  if (data.settings.auto[ats]) return `${ATS_NAMES[ats]}: ApplyPilot clicks Submit`;
  const done = Math.min(data.calibration[ats] ?? 0, CALIBRATION_NEEDED);
  return `${ATS_NAMES[ats]}: you click Submit (${done} of ${CALIBRATION_NEEDED} checks done)`;
}

function yesNo(value: boolean | undefined) {
  return value === true ? "Yes" : value === false ? "No" : "Ask me";
}

function Answer({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-semibold text-slate-500">{label}</dt>
      <dd className="mt-0.5 break-words text-slate-200">{children}</dd>
    </div>
  );
}

function Banner({ tone, action, children }: { tone: "blue" | "amber" | "slate"; action: ReactNode; children: ReactNode }) {
  const styles = {
    blue: "border-blue-400/25 bg-blue-500/8 text-blue-100",
    amber: "border-amber-400/25 bg-amber-400/8 text-amber-100",
    slate: "border-slate-700 bg-slate-900/40 text-slate-200",
  };
  return (
    <div className={`flex flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-3 text-sm ${styles[tone]}`}>
      <span>{children}</span>
      {action}
    </div>
  );
}

export function bridgeStatusText(bridge: Pick<ExtensionBridge, "status" | "version" | "held">, waiting = 0) {
  if (bridge.status === "checking") return "Looking for Application Assistant 3.0…";
  if (bridge.status === "missing") return "Not detected: install or reload the extension";
  return `Connected · ${bridge.version}${waiting ? ` · ${waiting} waiting` : ""}`;
}

function BridgeLine({ bridge, onOpenExtension }: { bridge: ExtensionBridge; onOpenExtension: () => void }) {
  const dot = bridge.status === "connected" ? "bg-emerald-400" : bridge.status === "missing" ? "bg-amber-400" : "bg-slate-500";
  return (
    <button onClick={onOpenExtension} className="flex items-center gap-2 rounded-full border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:border-slate-600">
      <span className={`h-2 w-2 rounded-full ${dot}`} />
      {bridgeStatusText(bridge)}
    </button>
  );
}

/* ---------- One application's submission state ---------- */

const PILL_STYLES: Record<string, string> = {
  approved: "bg-blue-400/10 text-blue-300",
  claimed: "bg-blue-400/10 text-blue-300",
  submitted: "bg-emerald-400/10 text-emerald-300",
  needs_you: "bg-amber-400/10 text-amber-300",
  check: "bg-amber-400/10 text-amber-300",
};

export function SubmitPill({
  row, note, rejectedReason, bridge, now, onCancel, onResolve,
}: {
  row: SubmissionRow;
  note?: { state: string; note: string };
  rejectedReason?: string;
  bridge: ExtensionBridge;
  now: number;
  onCancel: (id: string) => Promise<void>;
  onResolve: (id: string, outcome: "submitted" | "not_sent") => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [record, setRecord] = useState(false);

  async function act(work: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (reason) {
      setError(messageOf(reason, "That didn't work. Try again."));
    } finally {
      setBusy(false);
    }
  }

  const staleClaim = isStaleClaim(row, now);
  const label = pillLabel(row, now, note, rejectedReason);

  const reasons = row.reasons.length ? row.reasons.map((reason) => reason.text || reason.code) : row.reason ? [row.reason] : [];
  const resolveButtons = (
    <>
      <button disabled={busy} onClick={() => void act(() => onResolve(row.id, "submitted"))} className={smallButton}>It went through</button>
      <button disabled={busy} onClick={() => void act(() => onResolve(row.id, "not_sent"))} className={smallButton}>It didn&apos;t go through</button>
    </>
  );

  return (
    <div className="mt-2 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${PILL_STYLES[row.state] ?? "bg-slate-500/10 text-slate-400"}`}>{label}</span>
        {row.state === "approved" && <button disabled={busy} onClick={() => void act(() => onCancel(row.id))} className={smallButton}>Cancel</button>}
        {row.state === "submitted" && <button onClick={() => setRecord(!record)} className={smallButton}>{record ? "Hide record" : "Submission record"}</button>}
        {(row.state === "needs_you" || row.state === "check") && bridge.status === "connected" && (
          <button disabled={busy} onClick={() => void act(() => bridge.focus(row.id))} className={smallButton}>Show tab</button>
        )}
        {row.state === "needs_you" && /^https:\/\//i.test(row.applyUrl) && (
          <a href={row.applyUrl} target="_blank" rel="noreferrer" className={`${smallButton} text-blue-300`}>Open application</a>
        )}
        {(row.state === "check" || staleClaim) && resolveButtons}
      </div>
      {row.state === "approved" && rejectedReason && <p className="text-xs text-amber-200/90">{rejectedReason}</p>}
      {row.state === "check" && <p className="text-xs leading-5 text-amber-200/90">{checkText(row)}</p>}
      {staleClaim && <p className="text-xs leading-5 text-amber-200/90">{staleText(row)}</p>}
      {row.state === "submitted" && row.ats === "ashby" && (
        <p className="text-xs leading-5 text-slate-400">Applied — watch for the confirmation email. Ashby only confirms on the page.</p>
      )}
      {row.state === "needs_you" && (
        <p className="text-xs leading-5 text-slate-500">The tab stays open, already filled. Finish it there, or approve it again from Ready to send.</p>
      )}
      {(row.state === "needs_you" || row.state === "not_sent" || row.state === "check") && reasons.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-4 text-xs leading-5 text-amber-200/80">
          {reasons.map((reason, index) => <li key={index}>{reason}</li>)}
        </ul>
      )}
      {error && <p className="text-xs text-rose-300">{error}</p>}
      {record && <SubmissionRecord id={row.id} />}
    </div>
  );
}

const RELAXATION_TEXT: Record<string, string> = {
  invisible_captcha: "Submitted with an invisible CAPTCHA check on the page",
  optional_sensitive_blank: "Optional demographic or sensitive questions left blank",
};

function SubmissionRecord({ id }: { id: string }) {
  const [row, setRow] = useState<SubmissionRow | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    requestJson<{ submissions: SubmissionRow[] }>(`/api/submissions?id=${encodeURIComponent(id)}`)
      .then((result) => {
        if (!active) return;
        if (result.submissions[0]) setRow(result.submissions[0]);
        else setError("This record isn't available.");
      })
      .catch((reason: unknown) => {
        if (active) setError(messageOf(reason, "Couldn't load the record."));
      });
    return () => {
      active = false;
    };
  }, [id]);

  if (error) return <p className="text-xs text-rose-300">{error}</p>;
  if (!row) return <p className="text-xs text-slate-500">Loading the record…</p>;
  const facts: [string, string][] = [
    ["Clicked Submit", row.clickedBy === "you" ? "You" : row.clickedBy === "applypilot" ? "ApplyPilot" : "Not recorded"],
    ["Approved", formatWhen(row.approvedAt)],
    ["Checked with ApplyPilot", formatWhen(row.claimedAt)],
    ["Finished", formatWhen(row.finishedAt)],
    ["Resume file", row.resumeFilename],
    ["Resume SHA-256", row.resumeSha256],
    ["Page", row.pageUrl],
    ["Extension version", row.extensionVersion],
  ];
  return (
    <div className="space-y-3 rounded-xl border border-slate-800 bg-[#091523] p-3.5 text-xs">
      <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
        {facts.filter(([, value]) => value).map(([label, value]) => (
          <div key={label} className="min-w-0">
            <dt className="text-[11px] font-semibold text-slate-500">{label}</dt>
            <dd className="mt-0.5 break-all text-slate-200">{value}</dd>
          </div>
        ))}
      </dl>
      {row.confirmationText && (
        <div>
          <p className="text-[11px] font-semibold text-slate-500">Confirmation shown</p>
          <p className="mt-0.5 whitespace-pre-line text-slate-300">{row.confirmationText}</p>
        </div>
      )}
      {row.relaxations.length > 0 && (
        <ul className="list-disc pl-4 text-slate-400">
          {row.relaxations.map((name) => <li key={name}>{RELAXATION_TEXT[name] ?? name}</li>)}
        </ul>
      )}
      {row.fillReport && row.fillReport.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[520px] text-left">
            <thead className="text-[11px] uppercase tracking-wide text-slate-500">
              <tr><th className="pb-2 pr-3">Question</th><th className="pb-2 pr-3">Answer</th><th className="pb-2">From</th></tr>
            </thead>
            <tbody className="divide-y divide-slate-800 text-slate-300">
              {row.fillReport.map((entry, index) => (
                <tr key={index}>
                  <td className="py-1.5 pr-3">{entry.label}{entry.required ? " *" : ""}</td>
                  <td className="break-all py-1.5 pr-3">{entry.value}</td>
                  <td className="py-1.5 text-slate-500">{entry.source}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ---------- Automatic submitting settings (Extension view) ---------- */

export function SubmitSettingsPanel({ data, onSaved }: { data: SubmissionsData | null; onSaved: (settings: SubmitSettings) => void }) {
  // While a save is in flight the toggle shows what you asked for; afterwards, whatever the server kept.
  const [pending, setPending] = useState<SubmitSettings | null>(null);
  const [error, setError] = useState("");
  if (!data) return <p className="mt-5 text-sm text-slate-500">Loading your settings…</p>;
  const { calibration } = data;
  const settings = pending ?? data.settings;
  const busy = pending !== null;

  async function save(next: SubmitSettings) {
    setPending(next);
    setError("");
    try {
      const result = await requestJson<{ settings: SubmitSettings }>("/api/submissions", jsonBody("PATCH", { action: "settings", settings: next }));
      onSaved(result.settings);
    } catch (reason) {
      setError(messageOf(reason, "Couldn't save the setting."));
    } finally {
      setPending(null);
    }
  }

  const limits = DAILY_LIMITS.includes(settings.dailyCap) ? DAILY_LIMITS : [...DAILY_LIMITS, settings.dailyCap].sort((a, b) => a - b);
  return (
    <div className="mt-5 space-y-3">
      {ATS_LIST.map((ats) => {
        const done = calibration[ats] ?? 0;
        const unlocked = done >= CALIBRATION_NEEDED;
        return (
          <Toggle
            key={ats}
            checked={settings.auto[ats]}
            disabled={busy || (!unlocked && !settings.auto[ats])}
            onChange={(on) => void save({ ...settings, auto: { ...settings.auto, [ats]: on } })}
            title={`Let ApplyPilot click Submit on ${ATS_NAMES[ats]}`}
            badge={`${Math.min(done, CALIBRATION_NEEDED)}/${CALIBRATION_NEEDED}`}
          >
            {unlocked
              ? `When on, ApplyPilot clicks Submit once a ${ATS_NAMES[ats]} form matches what you approved; when off, you click it.`
              : `Unlocks after ${CALIBRATION_NEEDED} of your own ${ATS_NAMES[ats]} submissions are confirmed. Until then you click Submit yourself.`}
          </Toggle>
        );
      })}
      <label className="flex flex-col gap-3 rounded-xl border border-slate-800 bg-[#0a1627] p-3.5 sm:flex-row sm:items-center sm:justify-between">
        <span>
          <span className="block text-sm font-semibold text-slate-200">Daily limit</span>
          <span className="mt-1 block text-xs leading-5 text-slate-500">The most applications ApplyPilot submits on its own in any 24 hours.</span>
        </span>
        <select
          className={`${inputClass} py-2.5 sm:w-32`}
          disabled={busy}
          value={settings.dailyCap}
          onChange={(event) => void save({ ...settings, dailyCap: Number(event.target.value) })}
        >
          {limits.map((n) => <option key={n} value={n}>{n} a day</option>)}
        </select>
      </label>
      <Toggle
        checked={settings.allowInvisibleCaptcha}
        disabled={busy}
        onChange={(on) => void save({ ...settings, allowInvisibleCaptcha: on })}
        title="Submit when the only CAPTCHA is an invisible background check (stop if any challenge appears)"
      >
        Lets ApplyPilot submit forms that run a hidden robot check; a puzzle or &quot;I&apos;m not a robot&quot; box still stops it for you.
      </Toggle>
      <Toggle
        checked={settings.allowOptionalSensitiveBlank}
        disabled={busy}
        onChange={(on) => void save({ ...settings, allowOptionalSensitiveBlank: on })}
        title="Leave optional demographic and other sensitive questions blank and still submit"
      >
        ApplyPilot never answers these; this lets it submit when they&apos;re optional. A required one still stops it for you.
      </Toggle>
      {error && <p className="text-sm text-rose-300">{error}</p>}
    </div>
  );
}

function Toggle({
  checked, disabled, onChange, title, badge, children,
}: { checked: boolean; disabled: boolean; onChange: (on: boolean) => void; title: string; badge?: string; children: ReactNode }) {
  return (
    <label className={`flex items-start gap-3 rounded-xl border border-slate-800 bg-[#0a1627] p-3.5 ${disabled ? "opacity-70" : "cursor-pointer"}`}>
      <input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0 accent-blue-500" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      <span className="min-w-0 flex-1">
        <span className="flex items-start justify-between gap-3">
          <span className="text-sm font-semibold text-slate-200">{title}</span>
          {badge && <span className="shrink-0 rounded-full bg-slate-700/60 px-2 py-0.5 text-[11px] font-bold text-slate-300">{badge}</span>}
        </span>
        <span className="mt-1 block text-xs leading-5 text-slate-500">{children}</span>
      </span>
    </label>
  );
}
