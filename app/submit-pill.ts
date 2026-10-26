import { staleAfterMs, type SubmissionRow } from "./submission-store.ts";

// What one application's submission pill says. Plain functions, so the wording is tested without React.

export type PillNote = { state: string; note: string };
type PillRow = Pick<SubmissionRow, "state" | "claimMode" | "claimedAt" | "clickedBy">;

const MOVING = new Set(["opening", "filling", "auditing", "claiming", "submitting", "observing"]);

// A claim with no result for longer than Chrome can take on it. A supervised claim waits up to 30 minutes for your
// click, so it goes stale later than an automatic one.
export function isStaleClaim(row: PillRow, now: number) {
  return row.state === "claimed" && row.claimedAt !== null && now - Date.parse(row.claimedAt) > staleAfterMs(row.claimMode);
}

const liveNote = (note?: PillNote) =>
  note && note.note && !note.state.startsWith("done:") && note.state !== "cancelled" ? (MOVING.has(note.state) ? `${note.note}…` : note.note) : "";

export function submittedLabel(clickedBy: SubmissionRow["clickedBy"]) {
  if (clickedBy === "you") return "Sent by you";
  if (clickedBy === "applypilot") return "Sent by ApplyPilot";
  return "Sent · you said it went through";
}

export function pillLabel(row: PillRow, now: number, note?: PillNote, rejectedReason?: string) {
  switch (row.state) {
    case "approved":
      return rejectedReason ? "Approved · Chrome didn't take it" : liveNote(note) || "Approved · waiting for Chrome";
    case "claimed":
      // Chrome's own progress ("Waiting for you to click Submit") says more than "Sending…".
      return isStaleClaim(row, now) ? "Check this" : liveNote(note) || "Sending…";
    case "submitted":
      return submittedLabel(row.clickedBy);
    case "needs_you":
      return "Needs you";
    case "check":
      return "Check this";
    case "not_sent":
      return "Not sent";
    case "expired":
      return "Approval expired";
    default:
      return "Not sent · cancelled";
  }
}

export function checkText(row: Pick<SubmissionRow, "clickedBy">) {
  return row.clickedBy === "you"
    ? "You clicked Submit but ApplyPilot couldn't confirm it went through. Look for a confirmation email."
    : "ApplyPilot clicked Submit but couldn't confirm it. Look for a confirmation email.";
}

export function staleText(row: Pick<SubmissionRow, "claimMode">) {
  return `No result from Chrome for over ${Math.round(staleAfterMs(row.claimMode) / 60_000)} minutes. Look for a confirmation email.`;
}

// Shown under "Not ready to send" for a job that already went.
export function alreadySubmittedReason(clickedBy: SubmissionRow["clickedBy"]) {
  if (clickedBy === "you") return "Already submitted by you";
  if (clickedBy === "applypilot") return "Already submitted by ApplyPilot";
  return "Already submitted (you said it went through)";
}

// After "Resume sending": say Chrome is sending only once Chrome reports it is.
export function resumeNotice(running: boolean) {
  return running ? "Sending again in Chrome." : "Chrome hasn't started sending. Open the ApplyPilot window in Chrome to see why.";
}
