"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { spreadByCompany } from "./match-order";

// Find jobs: follow companies' Greenhouse, Lever and Ashby boards, list matching openings, add them to
// Applications, and make a tailored resume for each added job automatically.

type Search = { titleWords: string; locations: string; excludeWords: string; remoteOk: string };
type Source = { id: string; kind: string; token: string; label: string; url: string; lastCheckedAt: string | null; lastError: string };
type FoundJob = {
  id: string; company: string; title: string; location: string; url: string; postedAt: string;
  score: number; status: "new" | "queued"; applicationId: string | null;
};
export type TailorTarget = {
  id: string; company: string; role: string; jobDescription: string;
  tailoredJson: string | null; tailoredAt: string | null; tailoredRevision: number;
};

const inputClass =
  "w-full rounded-xl border border-slate-700/70 bg-[#0a1627] px-3.5 py-3 text-sm text-slate-100 outline-none transition placeholder:text-slate-600 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/15";
const primaryButton =
  "rounded-xl bg-blue-600 px-5 py-3 text-sm font-semibold text-white transition hover:bg-blue-500 disabled:opacity-50";
const secondaryButton =
  "rounded-xl border border-slate-600 bg-slate-900/30 px-4 py-2.5 text-sm font-semibold text-slate-200 transition hover:bg-slate-800/70 disabled:opacity-50";
const STALE_MS = 12 * 3_600_000;

class RequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const payload = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new RequestError(payload.error || `Request failed (${response.status})`, response.status);
  return payload;
}
const jsonBody = (method: string, body: unknown): RequestInit => ({
  method, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});

export function FindJobsView<T extends TailorTarget>({
  applications, onAdded, onUpdated,
}: {
  applications: T[];
  onAdded: (application: T) => void;
  onUpdated: (application: T) => void;
}) {
  const [search, setSearch] = useState<Search>({ titleWords: "", locations: "", excludeWords: "", remoteOk: "yes" });
  const [sources, setSources] = useState<Source[]>([]);
  const [jobs, setJobs] = useState<FoundJob[]>([]);
  const [board, setBoard] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState<"" | "loading" | "search" | "follow" | "refresh" | "adding">("loading");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [tailorNote, setTailorNote] = useState("");
  const [tailoringId, setTailoringId] = useState("");

  // The tailoring loop reads the latest applications through a ref, so it never works from a stale copy.
  const appsRef = useRef(applications);
  useEffect(() => { appsRef.current = applications; }, [applications]);
  const onUpdatedRef = useRef(onUpdated);
  useEffect(() => { onUpdatedRef.current = onUpdated; }, [onUpdated]);
  const queueRef = useRef<string[]>([]);
  const runningRef = useRef(false);

  const runTailoring = useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    setTailorNote("");
    try {
      while (queueRef.current.length) {
        const id = queueRef.current[0];
        const application = appsRef.current.find((item) => item.id === id);
        if (!application || application.tailoredJson || application.jobDescription.trim().length < 100) {
          queueRef.current.shift();
          continue;
        }
        setTailoringId(id);
        try {
          const result = await requestJson<{ application: T }>("/api/tailor", jsonBody("POST", {
            applicationId: id, instructions: "", revision: application.tailoredRevision, jobDescription: application.jobDescription,
          }));
          onUpdatedRef.current(result.application);
          appsRef.current = appsRef.current.map((item) => (item.id === id ? result.application : item));
          queueRef.current.shift();
        } catch (reason) {
          const text = reason instanceof Error ? reason.message : "Resume tailoring stopped.";
          // Limits, a missing source resume or a missing key stop the run; the rest wait for the next visit.
          if (reason instanceof RequestError && [400, 409, 429, 503].includes(reason.status)) {
            setTailorNote(`Paused making resumes: ${text} The rest will be made the next time you open this page.`);
            return;
          }
          setTailorNote(`Couldn't make the resume for ${application.role} at ${application.company}: ${text}`);
          queueRef.current.shift();
        }
      }
    } finally {
      runningRef.current = false;
      setTailoringId("");
    }
  }, []);

  const enqueue = useCallback((ids: string[]) => {
    for (const id of ids) if (!queueRef.current.includes(id)) queueRef.current.push(id);
    void runTailoring();
  }, [runTailoring]);

  const load = useCallback(async () => {
    const data = await requestJson<{ search: Search; sources: Source[]; jobs: FoundJob[] }>("/api/discovery");
    setSearch(data.search);
    setSources(data.sources);
    setJobs(data.jobs);
    return data;
  }, []);

  const refreshBoards = useCallback(async () => {
    setBusy("refresh");
    setError("");
    try {
      let added = 0, failed = 0;
      for (let round = 0; round < 5; round++) {
        const result = await requestJson<{ remaining: number; added: number; failed: number }>("/api/discovery/refresh", { method: "POST" });
        added += result.added;
        failed += result.failed;
        if (!result.remaining) break;
      }
      await load();
      setMessage(`${added} new ${added === 1 ? "match" : "matches"}.${failed ? ` ${failed} ${failed === 1 ? "board" : "boards"} couldn't be read.` : ""}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Couldn't check the job boards.");
    } finally {
      setBusy("");
    }
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await load();
        if (cancelled) return;
        setBusy("");
        // Pick up resumes that weren't finished last time.
        const pending = data.jobs.filter((job) => job.status === "queued" && job.applicationId).map((job) => job.applicationId as string);
        enqueue(pending);
        // Re-check boards automatically when the list is more than 12 hours old.
        const stale = data.sources.some((source) => !source.lastCheckedAt || Date.now() - new Date(source.lastCheckedAt).getTime() > STALE_MS);
        if (stale) await refreshBoards();
      } catch (reason) {
        if (!cancelled) {
          setBusy("");
          setError(reason instanceof Error ? reason.message : "Couldn't load your job search.");
        }
      }
    })();
    return () => { cancelled = true; };
  }, [load, enqueue, refreshBoards]);

  async function saveSearch(event: FormEvent) {
    event.preventDefault();
    setBusy("search");
    setError("");
    try {
      await requestJson("/api/discovery", jsonBody("PUT", search));
      setBusy("");
      await refreshBoards();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Couldn't save your search.");
      setBusy("");
    }
  }

  async function follow(event: FormEvent) {
    event.preventDefault();
    setBusy("follow");
    setError("");
    // Several links can be pasted at once, separated by spaces, commas or new lines.
    const links = [...new Set(board.split(/[\s,]+/).filter(Boolean))];
    const failed: string[] = [];
    let followed = 0;
    for (const link of links) {
      try {
        await requestJson("/api/discovery", jsonBody("POST", { board: link, label: links.length === 1 ? label : "" }));
        followed++;
      } catch (reason) {
        failed.push(`${link}: ${reason instanceof Error ? reason.message : "couldn't follow it"}`);
        if (reason instanceof Error && /up to \d+ companies/.test(reason.message)) break;
      }
    }
    setBoard(failed.length ? failed.map((line) => line.split(": ")[0]).join("\n") : "");
    if (!failed.length) setLabel("");
    setBusy("");
    if (followed) await refreshBoards();
    if (failed.length) setError(`Not followed:\n${failed.join("\n")}`);
  }

  async function unfollow(id: string) {
    setError("");
    try {
      await requestJson(`/api/discovery?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Couldn't remove that company.");
    }
  }

  async function add(selected: FoundJob[]) {
    setBusy("adding");
    setError("");
    const missing: string[] = [];
    try {
      for (const job of selected) {
        const result = await requestJson<{ application: T; descriptionMissing: boolean }>("/api/discovery/jobs", jsonBody("PATCH", { id: job.id, action: "add" }));
        if (!appsRef.current.some((item) => item.id === result.application.id)) onAdded(result.application);
        appsRef.current = [result.application, ...appsRef.current.filter((item) => item.id !== result.application.id)];
        setJobs((current) => current.map((item) => item.id === job.id ? { ...item, status: "queued", applicationId: result.application.id } : item));
        if (result.descriptionMissing) missing.push(`${job.title} at ${job.company}`);
        else enqueue([result.application.id]);
      }
      setMessage(`Added ${selected.length} to Applications.${missing.length ? ` Paste the description under Applications for: ${missing.join("; ")}.` : ""}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Couldn't add that job.");
    } finally {
      setBusy("");
    }
  }

  async function hide(job: FoundJob) {
    try {
      await requestJson("/api/discovery/jobs", jsonBody("PATCH", { id: job.id, action: "dismiss" }));
      setJobs((current) => current.filter((item) => item.id !== job.id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Couldn't hide that job.");
    }
  }

  const fresh = spreadByCompany(jobs.filter((job) => job.status === "new"));
  const added = jobs.filter((job) => job.status === "queued");
  const resumeState = (job: FoundJob) => {
    const application = applications.find((item) => item.id === job.applicationId);
    if (!application) return "In Applications";
    if (application.tailoredJson) return "Resume ready";
    if (tailoringId === application.id) return "Making resume…";
    if (application.jobDescription.trim().length < 100) return "Needs description";
    return "Resume waiting";
  };

  return (
    <div className="space-y-6">
      <section>
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-blue-400">Find jobs</p>
        <h2 className="mt-2 text-3xl font-semibold tracking-tight text-white">Openings from companies you follow</h2>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-400">ApplyPilot checks each company&apos;s job board when you open this page (at most every 12 hours) and lists the openings that match. Add the ones you want; each gets its own tailored resume.</p>
      </section>

      {(error || message || tailorNote) && (
        <div className="space-y-2" role="status">
          {error && <p className="whitespace-pre-line rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">{error}</p>}
          {tailorNote && <p className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">{tailorNote}</p>}
          {message && <p className="rounded-xl border border-blue-500/30 bg-blue-500/10 px-4 py-3 text-sm text-blue-100">{message}</p>}
        </div>
      )}

      <div className="grid gap-6 xl:grid-cols-2">
        <Panel title="What you're looking for" note="Separate choices with commas. A job matches when its title contains one of your titles.">
          <form onSubmit={saveSearch} className="mt-5 grid gap-4">
            <Field label="Job titles"><input className={inputClass} placeholder="Help desk, IT support, desktop support" value={search.titleWords} onChange={(e) => setSearch({ ...search, titleWords: e.target.value })} /></Field>
            <Field label="Places"><input className={inputClass} placeholder="Atlanta, GA, Lawrenceville" value={search.locations} onChange={(e) => setSearch({ ...search, locations: e.target.value })} /></Field>
            <Field label="Leave out titles with"><input className={inputClass} placeholder="Senior, Manager, Director" value={search.excludeWords} onChange={(e) => setSearch({ ...search, excludeWords: e.target.value })} /></Field>
            <Field label="Include remote jobs (U.S.)">
              <select className={inputClass} value={search.remoteOk} onChange={(e) => setSearch({ ...search, remoteOk: e.target.value })}><option value="yes">Yes</option><option value="no">No</option></select>
            </Field>
            <div><button disabled={busy !== ""} className={primaryButton}>{busy === "search" ? "Saving…" : "Save search"}</button></div>
          </form>
        </Panel>

        <Panel title="Companies you follow" note="Paste one or more companies' jobs pages on Greenhouse, Lever or Ashby, like jobs.lever.co/company, one per line.">
          <form onSubmit={follow} className="mt-5 grid gap-3 sm:grid-cols-[1fr_.6fr_auto]">
            <textarea aria-label="Jobs page links" rows={2} className={inputClass} placeholder="https://job-boards.greenhouse.io/company (paste one or many)" value={board} onChange={(e) => setBoard(e.target.value)} />
            <input aria-label="Company name" className={inputClass} placeholder="Name (optional)" value={label} onChange={(e) => setLabel(e.target.value)} />
            <button disabled={busy !== "" || !board.trim()} className={primaryButton}>{busy === "follow" ? "Adding…" : "Follow"}</button>
          </form>
          <ul className="mt-4 divide-y divide-slate-800">
            {sources.map((source) => (
              <li key={source.id} className="flex items-center justify-between gap-3 py-3 text-sm">
                <div className="min-w-0">
                  <a href={source.url} target="_blank" rel="noreferrer" className="font-semibold text-slate-100 hover:text-blue-300">{source.label || source.token}</a>
                  <p className="truncate text-xs text-slate-500">{source.kind} · {source.lastError ? <span className="text-amber-300">{source.lastError}</span> : source.lastCheckedAt ? `checked ${new Date(source.lastCheckedAt).toLocaleString()}` : "not checked yet"}</p>
                </div>
                <button type="button" onClick={() => void unfollow(source.id)} className="text-xs font-semibold text-rose-300 hover:text-rose-200">Remove</button>
              </li>
            ))}
            {!sources.length && busy !== "loading" && <li className="py-3 text-sm text-slate-500">No companies yet.</li>}
          </ul>
        </Panel>
      </div>

      <Panel
        title={`Matches${fresh.length ? ` (${fresh.length})` : ""}`}
        note="Best matches first: title, then place, then how recently it was posted."
        action={<div className="flex gap-2">
          <button type="button" disabled={busy !== "" || !sources.length} onClick={() => void refreshBoards()} className={secondaryButton}>{busy === "refresh" ? "Checking boards…" : "Check now"}</button>
          <button type="button" disabled={busy !== "" || !fresh.length} onClick={() => void add(fresh.slice(0, 10))} className={primaryButton}>{busy === "adding" ? "Adding…" : fresh.length ? `Add top ${Math.min(10, fresh.length)}` : "Add matches"}</button>
        </div>}
      >
        <ul className="mt-4 divide-y divide-slate-800">
          {fresh.map((job) => (
            <JobRow key={job.id} job={job}>
              <button type="button" disabled={busy !== ""} onClick={() => void add([job])} className={secondaryButton}>Add</button>
              <button type="button" onClick={() => void hide(job)} className="px-2 text-xs font-semibold text-slate-400 hover:text-slate-200">Hide</button>
            </JobRow>
          ))}
          {!fresh.length && busy !== "loading" && <li className="py-3 text-sm text-slate-500">{sources.length ? "No new matches. Try more titles or places." : "Follow a company to see its openings."}</li>}
        </ul>
      </Panel>

      {added.length > 0 && (
        <Panel title={`Added (${added.length})`} note="These are in Applications. Each gets its own tailored resume, within your AI limit of 6 an hour and 20 a day.">
          <ul className="mt-4 divide-y divide-slate-800">
            {added.map((job) => (
              <JobRow key={job.id} job={job}>
                <span className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${resumeState(job) === "Resume ready" ? "bg-emerald-400/10 text-emerald-300" : "bg-amber-400/10 text-amber-300"}`}>{resumeState(job)}</span>
              </JobRow>
            ))}
          </ul>
        </Panel>
      )}
    </div>
  );
}

function JobRow({ job, children }: { job: FoundJob; children: ReactNode }) {
  return (
    <li className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <a href={job.url} target="_blank" rel="noreferrer" className="font-semibold text-slate-100 hover:text-blue-300">{job.title}</a>
        <p className="text-xs text-slate-500">{[job.company, job.location, job.postedAt ? `posted ${new Date(job.postedAt).toLocaleDateString()}` : ""].filter(Boolean).join(" · ")}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <span className="rounded-full bg-blue-400/10 px-2.5 py-1 text-[11px] font-bold text-blue-300" title="Match score">{job.score}</span>
        {children}
      </div>
    </li>
  );
}

function Panel({ title, note, action, children }: { title: string; note: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-[24px] border border-slate-800 bg-[#0d1a2c] p-5 sm:p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div><h2 className="text-lg font-semibold text-white">{title}</h2><p className="mt-1 text-xs leading-5 text-slate-500">{note}</p></div>
        {action}
      </div>
      {children}
    </section>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="block"><span className="mb-2 block text-xs font-semibold text-slate-400">{label}</span>{children}</label>;
}
