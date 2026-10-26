"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { useExtensionBridge, type ExtensionBridge } from "./extension-bridge";
import { FindJobsView } from "./find-jobs";
import { buildAutofillProfile, educationFields, workFields } from "./profile-records";
import {
  ReadyToSendPanel, SubmitPill, SubmitSettingsPanel, bridgeStatusText, classifyApplications, newestSubmission,
  type BridgeNotes, type SubmissionsData,
} from "./send-panel";
import type { SubmissionRow, SubmitSettings } from "./submission-store";
import { MasterResumePanel, TailorPanel, parseTailored, readJobLink } from "./tailoring";

type View = "overview" | "profile" | "resumes" | "jobs" | "applications" | "accounts" | "extension";

type User = { displayName: string; email: string };

type Profile = {
  ownerEmail: string;
  firstName: string;
  lastName: string;
  legalName: string;
  profileEmail: string;
  phone: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  linkedIn: string;
  workAuthorization: string;
  sponsorship: string;
  workAuthorized: string;
  requiresSponsorship: string;
  skills: string;
  workHistory: string;
  education: string;
  availability: string;
  relocation: string;
  identityStatus: string;
  locationStatus: string;
  workHistoryStatus: string;
  updatedAt: string;
};

type Resume = {
  id: string;
  slug: string;
  label: string;
  category: string;
  filename: string;
  status: string;
  pageCount: string;
  recommendation: string;
  note: string;
};

type Application = {
  id: string;
  company: string;
  role: string;
  location: string;
  url: string;
  status: string;
  resumeId: string | null;
  notes: string;
  jobDescription: string;
  tailoredJson: string | null;
  tailoredAt: string | null;
  tailoredRevision: number;
  createdAt: string;
  updatedAt: string;
};

type Account = {
  id: string;
  company: string;
  loginEmail: string;
  loginUrl: string;
  passwordManagerStatus: string;
  verificationStatus: string;
  createdAt: string;
};

type ApplicationForm = {
  company: string;
  role: string;
  location: string;
  url: string;
  status: string;
  resumeId: string;
  notes: string;
  jobDescription: string;
};

type OverviewData = {
  profile: Profile;
  resumes: Resume[];
  applications: Application[];
  accounts: Account[];
};

type SendProps = {
  submissions: SubmissionsData | null;
  submissionsError: string;
  savedProfile: Profile;
  bridge: ExtensionBridge;
  notes: BridgeNotes;
  now: number;
  rejected: Record<string, string>;
  onRejected: (update: Record<string, string | null>) => void;
  onReload: () => Promise<void>;
  onCancel: (id: string) => Promise<void>;
  onResolve: (id: string, outcome: "submitted" | "not_sent") => Promise<void>;
  onOpenProfile: () => void;
  onOpenExtension: () => void;
};

const navItems: { id: View; label: string; icon: IconName }[] = [
  { id: "overview", label: "Overview", icon: "grid" },
  { id: "profile", label: "Application profile", icon: "person" },
  { id: "resumes", label: "Resume matcher", icon: "file" },
  { id: "jobs", label: "Find jobs", icon: "search" },
  { id: "applications", label: "Applications", icon: "briefcase" },
  { id: "accounts", label: "Employer accounts", icon: "key" },
  { id: "extension", label: "Mac autofill", icon: "bolt" },
];

const inputClass =
  "w-full rounded-xl border border-slate-700/70 bg-[#0a1627] px-3.5 py-3 text-sm text-slate-100 outline-none transition placeholder:text-slate-600 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/15";

const statusOptions = ["saved", "ready", "applied", "interview", "rejected", "offer"];

const roleTargets = [
  ["Help Desk / Desktop Support", "Strong match", "Help Desk resume", "School districts, hospitals, MSPs, city/county IT"],
  ["Manual QA / UAT Tester", "Strong match", "QA Tester resume", "Healthcare software, banks, logistics, local SaaS"],
  ["Network / Field Technician", "Good match", "Network resume", "ISPs, data centers, low-voltage and security installers"],
  ["Data Center Technician", "Good match", "Help Desk or Network", "Hardware swaps, cabling, inventory, smart hands"],
  ["Printer / Copier Technician", "Good match", "Help Desk resume", "Field service companies and office equipment dealers"],
  ["Junior Developer / Apps Script", "Targeted", "Developer resume after fix", "Small businesses, consultancies, workflow automation"],
] as const;

export default function DashboardShell({
  user,
  signInPath,
}: {
  user: User | null;
  signInPath: string;
}) {
  if (!user) return <SignInScreen signInPath={signInPath} />;
  return <SignedInDashboard />;
}

function SignedInDashboard() {
  const [view, setView] = useState<View>("overview");
  const [data, setData] = useState<OverviewData | null>(null);
  const [profileForm, setProfileForm] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [applicationForm, setApplicationForm] = useState<ApplicationForm>({
    company: "",
    role: "",
    location: "Atlanta, GA",
    url: "",
    status: "saved",
    resumeId: "",
    notes: "",
    jobDescription: "",
  });
  const [accountForm, setAccountForm] = useState({
    company: "",
    loginEmail: "pastorolatunde13@gmail.com",
    loginUrl: "",
  });

  async function refresh() {
    setLoading(true);
    setError("");
    try {
      const next = await requestJson<OverviewData>("/api/overview");
      setData(next);
      setProfileForm(next.profile);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load ApplyPilot.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let active = true;
    requestJson<OverviewData>("/api/overview")
      .then((next) => {
        if (!active) return;
        setData(next);
        setProfileForm(next.profile);
      })
      .catch((reason: unknown) => {
        if (!active) return;
        setError(reason instanceof Error ? reason.message : "Could not load ApplyPilot.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const readiness = useMemo(() => calculateReadiness(profileForm), [profileForm]);

  // Approvals and what Chrome reported, from /api/submissions. Kept apart from the overview so a failure here
  // never stops the rest of the dashboard from loading.
  const [submissions, setSubmissions] = useState<SubmissionsData | null>(null);
  const [submissionsError, setSubmissionsError] = useState("");
  const [notes, setNotes] = useState<BridgeNotes>({});
  const [rejected, setRejected] = useState<Record<string, string>>({});
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const loadSubmissions = useCallback(
    () =>
      requestJson<SubmissionsData>("/api/submissions").then(
        (next) => {
          setSubmissions(next);
          setSubmissionsError("");
        },
        (reason: unknown) => setSubmissionsError(reason instanceof Error ? reason.message : "Couldn't load your approvals."),
      ),
    [],
  );

  // Fresh on every view change, so targets, calibration and states match what the server has now.
  useEffect(() => {
    void loadSubmissions();
  }, [view, loadSubmissions]);

  const mergeSubmissions = useCallback((rows: SubmissionRow[]) => {
    if (!rows.length) return;
    const ids = new Set(rows.map((row) => row.id));
    setSubmissions((current) => (current ? { ...current, submissions: [...rows, ...current.submissions.filter((row) => !ids.has(row.id))] } : current));
    // The server already marked these applied; show it without a reload.
    const sent = new Set(rows.filter((row) => row.state === "submitted").map((row) => row.applicationId));
    if (sent.size) {
      setData((current) =>
        current
          ? {
              ...current,
              applications: current.applications.map((item) =>
                sent.has(item.id) && (item.status === "saved" || item.status === "ready") ? { ...item, status: "applied" } : item,
              ),
            }
          : current,
      );
    }
  }, []);

  const bridge = useExtensionBridge({
    onResultsSaved: (rows) => {
      mergeSubmissions(rows);
      void loadSubmissions();
    },
    onProgress: (p) => setNotes((current) => ({ ...current, [p.approvalId]: { state: p.state, note: p.note } })),
  });

  async function cancelSubmission(id: string) {
    const result = await requestJson<{ revoked: string[]; tooLate: string[] }>("/api/submissions", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "cancel", ids: [id] }),
    });
    if (bridge.status === "connected") await bridge.cancel([id]).catch(() => undefined);
    await loadSubmissions();
    notify(result.revoked.includes(id) ? "Approval cancelled." : "Too late to cancel: ApplyPilot is already sending it.");
  }

  async function resolveSubmission(id: string, outcome: "submitted" | "not_sent") {
    const result = await requestJson<{ submission: SubmissionRow | null }>("/api/submissions", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "resolve", id, outcome }),
    });
    if (result.submission) mergeSubmissions([result.submission]);
    void loadSubmissions();
    notify(outcome === "submitted" ? "Marked as sent." : "Marked as not sent. You can approve it again.");
  }

  function settingsSaved(settings: SubmitSettings) {
    setSubmissions((current) => (current ? { ...current, settings } : current));
    notify("Setting saved.");
  }

  function notify(text: string) {
    setMessage(text);
    window.setTimeout(() => setMessage(""), 3000);
  }

  async function saveProfile(event: FormEvent) {
    event.preventDefault();
    if (!profileForm) return;
    setSaving(true);
    setError("");
    try {
      const result = await requestJson<{ profile: Profile }>("/api/profile", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(profileForm),
      });
      setProfileForm(result.profile);
      setData((current) => (current ? { ...current, profile: result.profile } : current));
      notify("Application profile saved.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not save the profile.");
    } finally {
      setSaving(false);
    }
  }

  async function addApplication(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      const result = await requestJson<{ application: Application }>("/api/applications", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(applicationForm),
      });
      setData((current) =>
        current ? { ...current, applications: [result.application, ...current.applications] } : current,
      );
      setApplicationForm({
        company: "",
        role: "",
        location: "Atlanta, GA",
        url: "",
        status: "saved",
        resumeId: "",
        notes: "",
        jobDescription: "",
      });
      notify("Job added to your application queue.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not add the job.");
    } finally {
      setSaving(false);
    }
  }

  async function changeApplicationStatus(id: string, status: string) {
    setError("");
    try {
      const result = await requestJson<{ application: Application }>("/api/applications", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, status }),
      });
      setData((current) =>
        current
          ? {
              ...current,
              applications: current.applications.map((item) =>
                item.id === id ? result.application : item,
              ),
            }
          : current,
      );
      notify("Application status updated.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not update the application.");
    }
  }

  async function removeApplication(id: string) {
    if (!window.confirm("Remove this application from the tracker?")) return;
    try {
      await requestJson<{ ok: true }>(`/api/applications?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      setData((current) =>
        current
          ? { ...current, applications: current.applications.filter((item) => item.id !== id) }
          : current,
      );
      notify("Application removed.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not remove the application.");
    }
  }

  async function addAccount(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      const result = await requestJson<{ account: Account }>("/api/accounts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(accountForm),
      });
      setData((current) =>
        current ? { ...current, accounts: [result.account, ...current.accounts] } : current,
      );
      setAccountForm({
        company: "",
        loginEmail: profileForm?.profileEmail || "pastorolatunde13@gmail.com",
        loginUrl: "",
      });
      notify("Employer account recorded. Save its password in Apple Passwords.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not record the account.");
    } finally {
      setSaving(false);
    }
  }

  function downloadProfile() {
    if (!profileForm) return;
    const payload = buildAutofillProfile(profileForm);
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "applypilot-profile.json";
    link.click();
    URL.revokeObjectURL(url);
    notify("Autofill profile downloaded.");
  }

  return (
    <main className="min-h-screen bg-[#07111f] text-slate-100">
      <div className="mx-auto flex min-h-screen max-w-[1600px]">
        <aside className="fixed inset-y-0 left-0 z-30 hidden w-72 border-r border-slate-800/80 bg-[#081422] px-5 py-6 lg:flex lg:flex-col">
          <Brand />
          <nav className="mt-9 space-y-1.5" aria-label="Main navigation">
            {navItems.map((item) => (
              <NavButton key={item.id} item={item} active={view === item.id} onClick={() => setView(item.id)} />
            ))}
          </nav>
          <div className="mt-auto rounded-2xl border border-blue-500/20 bg-blue-500/8 p-4">
            <div className="flex items-center gap-2 text-sm font-semibold text-blue-100">
              <Icon name="shield" className="h-4 w-4 text-blue-400" />
              Human review stays on
            </div>
            <p className="mt-2 text-xs leading-5 text-slate-400">
              ApplyPilot fills and organizes. You approve every final application, legal answer, and submission.
            </p>
          </div>
          <div className="mt-4 flex items-center gap-3 border-t border-slate-800 pt-4">
            <div className="grid h-9 w-9 place-items-center rounded-full bg-gradient-to-br from-blue-500 to-cyan-400 text-sm font-bold text-white">
              PO
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">{profileForm?.firstName || "Pastor"} Olatunde</p>
              <p className="truncate text-xs text-slate-500">Private workspace</p>
            </div>
          </div>
        </aside>

        <section className="min-w-0 flex-1 lg:ml-72">
          <header className="sticky top-0 z-20 border-b border-slate-800/70 bg-[#07111f]/90 px-4 py-4 backdrop-blur-xl sm:px-7 lg:px-10">
            <div className="flex items-center justify-between gap-4">
              <div className="lg:hidden"><Brand compact /></div>
              <div className="hidden lg:block">
                <p className="text-xs font-medium uppercase tracking-[0.2em] text-slate-500">Job search command center</p>
                <h1 className="mt-1 text-xl font-semibold text-white">{navItems.find((item) => item.id === view)?.label}</h1>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setView("profile")}
                  className="hidden rounded-xl border border-slate-700 bg-slate-900/70 px-3.5 py-2.5 text-xs font-semibold text-slate-200 transition hover:border-slate-600 hover:bg-slate-800 sm:block"
                >
                  Profile {readiness}% ready
                </button>
                <button
                  onClick={() => setView("applications")}
                  className="rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white shadow-lg shadow-blue-950/40 transition hover:bg-blue-500"
                >
                  + Add a job
                </button>
              </div>
            </div>
            <nav className="mt-4 flex gap-2 overflow-x-auto pb-1 lg:hidden" aria-label="Mobile navigation">
              {navItems.map((item) => (
                <button
                  key={item.id}
                  onClick={() => setView(item.id)}
                  className={`shrink-0 rounded-lg px-3 py-2 text-xs font-semibold transition ${
                    view === item.id ? "bg-blue-600 text-white" : "bg-slate-900 text-slate-400"
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </nav>
          </header>

          <div className="px-4 py-6 sm:px-7 lg:px-10 lg:py-9">
            {message && (
              <div className="fixed right-5 top-5 z-50 flex max-w-sm items-center gap-3 rounded-2xl border border-emerald-400/20 bg-[#10251f] px-4 py-3 text-sm text-emerald-100 shadow-2xl">
                <Icon name="check" className="h-5 w-5 text-emerald-400" />
                {message}
              </div>
            )}
            {error && (
              <div className="mb-5 flex items-start justify-between gap-4 rounded-2xl border border-rose-400/20 bg-rose-500/8 px-4 py-3 text-sm text-rose-100">
                <span>{error}</span>
                <button onClick={() => setError("")} className="text-rose-300">Dismiss</button>
              </div>
            )}
            {loading ? (
              <LoadingState />
            ) : !data || !profileForm ? (
              <EmptyLoad onRetry={() => void refresh()} />
            ) : (
              <>
                {view === "overview" && (
                  <Overview
                    data={data}
                    profile={profileForm}
                    readiness={readiness}
                    onNavigate={setView}
                    submissions={submissions}
                    bridge={bridge}
                    now={now}
                  />
                )}
                {view === "profile" && (
                  <ProfileView
                    profile={profileForm}
                    setProfile={setProfileForm}
                    readiness={readiness}
                    saving={saving}
                    onSave={saveProfile}
                  />
                )}
                {view === "resumes" && <ResumesView resumes={data.resumes} />}
                {view === "jobs" && (
                  <FindJobsView
                    applications={data.applications}
                    onAdded={(application) =>
                      setData((current) =>
                        current ? { ...current, applications: [application, ...current.applications.filter((item) => item.id !== application.id)] } : current,
                      )
                    }
                    onUpdated={(application) =>
                      setData((current) =>
                        current
                          ? { ...current, applications: current.applications.map((item) => (item.id === application.id ? { ...item, ...application } : item)) }
                          : current,
                      )
                    }
                  />
                )}
                {view === "applications" && (
                  <ApplicationsView
                    applications={data.applications}
                    resumes={data.resumes}
                    form={applicationForm}
                    setForm={setApplicationForm}
                    saving={saving}
                    onAdd={addApplication}
                    onStatus={changeApplicationStatus}
                    onRemove={removeApplication}
                    onUpdated={(application) =>
                      setData((current) =>
                        current
                          ? {
                              ...current,
                              applications: current.applications.map((item) =>
                                item.id === application.id ? { ...item, ...application } : item,
                              ),
                            }
                          : current,
                      )
                    }
                    send={{
                      submissions,
                      submissionsError,
                      savedProfile: data.profile,
                      bridge,
                      notes,
                      now,
                      rejected,
                      onRejected: (update) =>
                        setRejected((current) => {
                          const next = { ...current };
                          for (const [id, reason] of Object.entries(update)) {
                            if (reason === null) delete next[id];
                            else next[id] = reason;
                          }
                          return next;
                        }),
                      onReload: loadSubmissions,
                      onCancel: cancelSubmission,
                      onResolve: resolveSubmission,
                      onOpenProfile: () => setView("profile"),
                      onOpenExtension: () => setView("extension"),
                    }}
                  />
                )}
                {view === "accounts" && (
                  <AccountsView
                    accounts={data.accounts}
                    form={accountForm}
                    setForm={setAccountForm}
                    saving={saving}
                    onAdd={addAccount}
                  />
                )}
                {view === "extension" && (
                  <ExtensionView
                    onDownloadProfile={downloadProfile}
                    readiness={readiness}
                    bridge={bridge}
                    submissions={submissions}
                    onSettingsSaved={settingsSaved}
                  />
                )}
              </>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}

function Overview({
  data,
  profile,
  readiness,
  onNavigate,
  submissions,
  bridge,
  now,
}: {
  data: OverviewData;
  profile: Profile;
  readiness: number;
  onNavigate: (view: View) => void;
  submissions: SubmissionsData | null;
  bridge: ExtensionBridge;
  now: number;
}) {
  const sendable = submissions ? classifyApplications(data.applications, submissions, now, null) : null;
  const openIds = new Set(data.applications.filter((item) => item.status === "saved" || item.status === "ready").map((item) => item.id));
  const needsYou = submissions
    ? data.applications.filter((item) => openIds.has(item.id) && ["needs_you", "check"].includes(newestSubmission(submissions.submissions, item.id)?.state ?? "")).length
    : 0;
  const applied = data.applications.filter((item) => item.status === "applied").length;
  const active = data.applications.filter((item) => ["ready", "applied", "interview"].includes(item.status)).length;
  const readyResumes = data.resumes.filter((item) => item.status === "ready").length;
  const confirmations = [
    ["Legal application name", profile.identityStatus],
    ["Home location", profile.locationStatus],
    ["Current job title and dates", profile.workHistoryStatus],
    ["Start date / availability", profile.availability ? "confirmed" : "needs_confirmation"],
  ];
  const pendingConfirmations = confirmations.filter(([, status]) => status !== "confirmed").length;
  const nextSteps = [
    {
      title: "Finish your application profile",
      copy: pendingConfirmations
        ? `${pendingConfirmations} confirmation${pendingConfirmations === 1 ? " is" : "s are"} still needed before autofill is dependable.`
        : "Your identity, location, work history, and availability are confirmed.",
      done: pendingConfirmations === 0,
      action: "Review profile",
      view: "profile" as View,
    },
    {
      title: "Choose only application-ready resumes",
      copy: readyResumes === data.resumes.length
        ? "Every reviewed resume is marked ready for matching."
        : `${data.resumes.length - readyResumes} resume${data.resumes.length - readyResumes === 1 ? " needs" : "s need"} a final correction before use.`,
      done: readyResumes === data.resumes.length,
      action: "Check resumes",
      view: "resumes" as View,
    },
    {
      title: "Add direct job postings",
      copy: data.applications.length
        ? `${data.applications.length} job${data.applications.length === 1 ? " is" : "s are"} in your queue. Keep adding only strong matches.`
        : "Paste your first direct employer link so ApplyPilot can track the role and resume choice.",
      done: data.applications.length > 0,
      action: "Add a job",
      view: "applications" as View,
    },
    {
      title: "Install Application Assistant 3.0",
      copy: bridge.status === "connected"
        ? "Chrome is connected and ready to send the jobs you approve."
        : "Add it to Chrome on your Mac so the jobs you approve can be sent.",
      done: bridge.status === "connected",
      action: "Open setup",
      view: "extension" as View,
    },
  ];

  return (
    <div className="space-y-7">
      <section className="overflow-hidden rounded-[28px] border border-blue-500/20 bg-[radial-gradient(circle_at_90%_10%,rgba(47,125,246,.22),transparent_35%),linear-gradient(135deg,#10233d,#0a1728_65%)] p-6 sm:p-8">
        <div className="grid gap-7 lg:grid-cols-[1.5fr_.8fr] lg:items-center">
          <div>
            <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-emerald-300/20 bg-emerald-400/8 px-3 py-1.5 text-xs font-semibold text-emerald-200">
              <span className="h-2 w-2 rounded-full bg-emerald-400" />
              Resume review complete
            </div>
            <h2 className="max-w-3xl text-3xl font-semibold tracking-tight text-white sm:text-4xl">
              Turn the job search into a queue, not a guessing game.
            </h2>
            <p className="mt-4 max-w-2xl text-sm leading-6 text-slate-300 sm:text-base">
              Start with Help Desk, QA, network/field technician, and data-center roles. ApplyPilot will match the right resume and keep every account and status organized.
            </p>
            <div className="mt-6 flex flex-wrap gap-3">
              <button onClick={() => onNavigate("applications")} className="rounded-xl bg-blue-600 px-5 py-3 text-sm font-semibold text-white transition hover:bg-blue-500">
                Add your first job
              </button>
              <button onClick={() => onNavigate("resumes")} className="rounded-xl border border-slate-600 bg-slate-900/30 px-5 py-3 text-sm font-semibold text-slate-200 transition hover:bg-slate-800/70">
                See resume matches
              </button>
            </div>
          </div>
          <div className="rounded-2xl border border-slate-600/50 bg-[#081523]/75 p-5 backdrop-blur">
            <div className="flex items-end justify-between">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Application readiness</p>
                <p className="mt-2 text-4xl font-semibold text-white">{readiness}%</p>
              </div>
              <Icon name="gauge" className="h-9 w-9 text-blue-400" />
            </div>
            <div className="mt-4 h-2 overflow-hidden rounded-full bg-slate-800">
              <div className="h-full rounded-full bg-gradient-to-r from-blue-600 to-cyan-400" style={{ width: `${readiness}%` }} />
            </div>
            <p className="mt-3 text-xs leading-5 text-slate-400">Confirm four profile details before any application is submitted.</p>
          </div>
        </div>
      </section>

      <button
        onClick={() => onNavigate("applications")}
        className="flex w-full flex-col gap-3 rounded-[22px] border border-blue-500/25 bg-[#0d1a2c] p-5 text-left transition hover:border-blue-500/50 hover:bg-[#0f1f35] sm:flex-row sm:items-center sm:justify-between"
      >
        <span className="flex items-center gap-4">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-blue-500/10 text-blue-300"><Icon name="send" className="h-5 w-5" /></span>
          <span>
            <span className="block text-lg font-semibold text-white">Ready to send: {sendable ? sendable.eligible.length : "…"}</span>
            <span className="mt-0.5 block text-xs text-slate-500">
              {[
                sendable && sendable.waiting.length ? `${sendable.waiting.length} approved, waiting for Chrome` : "",
                needsYou ? `${needsYou} need${needsYou === 1 ? "s" : ""} you` : "",
              ].filter(Boolean).join(" · ") || "Tailored Greenhouse, Lever and Ashby jobs you haven't approved yet"}
            </span>
          </span>
        </span>
        <span className="text-xs font-semibold text-blue-300">Review and approve →</span>
      </button>

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Jobs in queue" value={data.applications.length} note={`${active} active`} icon="briefcase" />
        <Stat label="Applications sent" value={applied} note="Tracked submissions" icon="send" />
        <Stat label="Ready resumes" value={readyResumes} note={`${data.resumes.length} files reviewed`} icon="file" />
        <Stat label="Employer accounts" value={data.accounts.length} note="Passwords stay in Apple" icon="key" />
      </section>

      <section className="grid gap-6 xl:grid-cols-[1.15fr_.85fr]">
        <Panel>
          <PanelHeader title="Best next searches" eyebrow="Where to apply besides construction" action="Resume matcher" onAction={() => onNavigate("resumes")} />
          <div className="mt-2 divide-y divide-slate-800/80">
            {roleTargets.slice(0, 5).map(([role, match, resume, employers]) => (
              <div key={role} className="grid gap-2 py-4 sm:grid-cols-[1.15fr_.65fr_1.5fr] sm:items-center">
                <div>
                  <p className="text-sm font-semibold text-slate-100">{role}</p>
                  <p className="mt-1 text-xs text-slate-500">{resume}</p>
                </div>
                <span className={`w-fit rounded-full px-2.5 py-1 text-[11px] font-bold ${match === "Strong match" ? "bg-emerald-400/10 text-emerald-300" : "bg-blue-400/10 text-blue-300"}`}>
                  {match}
                </span>
                <p className="text-xs leading-5 text-slate-400">{employers}</p>
              </div>
            ))}
          </div>
        </Panel>

        <Panel>
          <PanelHeader title="Confirm before applying" eyebrow="No guessing on legal forms" action="Open profile" onAction={() => onNavigate("profile")} />
          <div className="mt-4 space-y-3">
            {confirmations.map(([label, status]) => (
              <div key={label} className="flex items-center justify-between gap-4 rounded-xl border border-slate-800 bg-[#0a1627] px-4 py-3">
                <div className="flex items-center gap-3">
                  <span className={`grid h-7 w-7 place-items-center rounded-full ${status === "confirmed" ? "bg-emerald-400/10 text-emerald-300" : "bg-amber-400/10 text-amber-300"}`}>
                    <Icon name={status === "confirmed" ? "check" : "alert"} className="h-4 w-4" />
                  </span>
                  <span className="text-sm text-slate-200">{label}</span>
                </div>
                <span className={`text-[11px] font-bold uppercase tracking-wide ${status === "confirmed" ? "text-emerald-300" : "text-amber-300"}`}>
                  {status === "confirmed" ? "Confirmed" : "Needed"}
                </span>
              </div>
            ))}
          </div>
          <div className="mt-5 rounded-xl border border-blue-400/15 bg-blue-500/7 p-4">
            <p className="text-sm font-semibold text-blue-100">Why the pause?</p>
            <p className="mt-1.5 text-xs leading-5 text-slate-400">Your resumes disagree on Peter vs. Pastor, Grayson vs. Pooler, and your current Modern Technology title. One confirmation prevents inconsistent applications.</p>
          </div>
        </Panel>
      </section>

      <Panel>
        <PanelHeader title="What’s needed next" eyebrow="Your launch checklist" />
        <div className="mt-5 grid gap-3 lg:grid-cols-2">
          {nextSteps.map((step, index) => (
            <button
              key={step.title}
              onClick={() => onNavigate(step.view)}
              className="group flex items-start gap-4 rounded-2xl border border-slate-800 bg-[#0a1627] p-4 text-left transition hover:border-blue-500/40 hover:bg-[#0c1a2e]"
            >
              <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-xl text-sm font-bold ${step.done ? "bg-emerald-400/10 text-emerald-300" : "bg-blue-500/12 text-blue-300"}`}>
                {step.done ? <Icon name="check" className="h-4 w-4" /> : index + 1}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center justify-between gap-3">
                  <span className="text-sm font-semibold text-white">{step.title}</span>
                  <span className={`shrink-0 text-[11px] font-bold uppercase tracking-wide ${step.done ? "text-emerald-300" : "text-blue-300"}`}>
                    {step.done ? "Done" : step.action}
                  </span>
                </span>
                <span className="mt-1.5 block text-xs leading-5 text-slate-500">{step.copy}</span>
              </span>
            </button>
          ))}
        </div>
      </Panel>

      <Panel>
        <PanelHeader title="Your application flow" eyebrow="Fast, controlled, and honest" />
        <div className="mt-5 grid gap-4 md:grid-cols-4">
          {[
            ["1", "Save the job", "Paste the company, role, and job link into your queue."],
            ["2", "Match the resume", "Use the targeted version instead of one resume for everything."],
            ["3", "Approve and send", "Approve the day's jobs; Chrome submits each with its own resume."],
            ["4", "Finish what needs you", "Anything ApplyPilot can't answer stays open for you, already filled."],
          ].map(([number, title, copy]) => (
            <div key={number} className="rounded-2xl border border-slate-800 bg-[#0a1627] p-4">
              <span className="grid h-8 w-8 place-items-center rounded-lg bg-blue-600/15 text-sm font-bold text-blue-300">{number}</span>
              <h3 className="mt-4 text-sm font-semibold text-white">{title}</h3>
              <p className="mt-2 text-xs leading-5 text-slate-500">{copy}</p>
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
}

function ProfileView({
  profile,
  setProfile,
  readiness,
  saving,
  onSave,
}: {
  profile: Profile;
  setProfile: (profile: Profile) => void;
  readiness: number;
  saving: boolean;
  onSave: (event: FormEvent) => void;
}) {
  function update(field: keyof Profile, value: string) {
    setProfile({ ...profile, [field]: value });
  }

  return (
    <form onSubmit={onSave} className="space-y-6">
      <section className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-blue-400">One source of truth</p>
          <h2 className="mt-2 text-3xl font-semibold tracking-tight text-white">Your application profile</h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-400">These answers feed the Mac autofill helper. Mark each disputed section confirmed only after checking it.</p>
        </div>
        <div className="min-w-44 rounded-2xl border border-slate-800 bg-[#0d1a2c] px-4 py-3">
          <div className="flex justify-between text-xs"><span className="text-slate-500">Readiness</span><span className="font-bold text-blue-300">{readiness}%</span></div>
          <div className="mt-2 h-1.5 rounded-full bg-slate-800"><div className="h-full rounded-full bg-blue-500" style={{ width: `${readiness}%` }} /></div>
        </div>
      </section>

      <Panel>
        <SectionTitle title="Identity" note="Your legal name must match the name you use on employment forms." />
        <div className="mt-5 grid gap-4 md:grid-cols-2">
          <Field label="First name"><input className={inputClass} value={profile.firstName} onChange={(event) => update("firstName", event.target.value)} /></Field>
          <Field label="Last name"><input className={inputClass} value={profile.lastName} onChange={(event) => update("lastName", event.target.value)} /></Field>
          <Field label="Legal full name" hint="Confirm Peter vs. Pastor"><input className={inputClass} placeholder="Enter exactly as shown on legal documents" value={profile.legalName} onChange={(event) => update("legalName", event.target.value)} /></Field>
          <Field label="Identity status"><ConfirmationSelect value={profile.identityStatus} onChange={(value) => update("identityStatus", value)} /></Field>
        </div>
      </Panel>

      <Panel>
        <SectionTitle title="Contact and location" note="Two resumes show different cities, so confirm the address you want employers to use." />
        <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <Field label="Application email"><input type="email" className={inputClass} value={profile.profileEmail} onChange={(event) => update("profileEmail", event.target.value)} /></Field>
          <Field label="Phone"><input className={inputClass} value={profile.phone} onChange={(event) => update("phone", event.target.value)} /></Field>
          <Field label="LinkedIn"><input type="url" className={inputClass} value={profile.linkedIn} onChange={(event) => update("linkedIn", event.target.value)} /></Field>
          <Field label="City"><input className={inputClass} value={profile.city} onChange={(event) => update("city", event.target.value)} /></Field>
          <Field label="State"><input className={inputClass} value={profile.state} onChange={(event) => update("state", event.target.value)} /></Field>
          <Field label="ZIP code"><input className={inputClass} value={profile.postalCode} onChange={(event) => update("postalCode", event.target.value)} /></Field>
          <Field label="Country"><input className={inputClass} value={profile.country} onChange={(event) => update("country", event.target.value)} /></Field>
          <Field label="Location status"><ConfirmationSelect value={profile.locationStatus} onChange={(value) => update("locationStatus", value)} /></Field>
          <Field label="Relocation / commute"><input className={inputClass} placeholder="Example: Atlanta metro, up to 45 miles" value={profile.relocation} onChange={(event) => update("relocation", event.target.value)} /></Field>
        </div>
      </Panel>

      <Panel>
        <SectionTitle title="Eligibility and availability" note="Review these answers for every job; the employer's wording can differ." />
        <div className="mt-5 grid gap-4 md:grid-cols-2">
          <Field label="Authorized to work in the U.S.?" hint="The assistant answers only Yes or No"><YesNoSelect value={profile.workAuthorized} onChange={(value) => update("workAuthorized", value)} /></Field>
          <Field label="Need visa sponsorship, now or later?"><YesNoSelect value={profile.requiresSponsorship} onChange={(value) => update("requiresSponsorship", value)} /></Field>
          <Field label="Work authorization wording"><input className={inputClass} value={profile.workAuthorization} onChange={(event) => update("workAuthorization", event.target.value)} /></Field>
          <Field label="Sponsorship wording"><input className={inputClass} value={profile.sponsorship} onChange={(event) => update("sponsorship", event.target.value)} /></Field>
          <Field label="Available start date"><input className={inputClass} placeholder="Example: Immediately or September 1, 2026" value={profile.availability} onChange={(event) => update("availability", event.target.value)} /></Field>
          <Field label="Work history status" hint="Confirms Modern Technology title and dates"><ConfirmationSelect value={profile.workHistoryStatus} onChange={(value) => update("workHistoryStatus", value)} /></Field>
        </div>
      </Panel>

      <RecordsEditor
        title="Work history"
        note="Most recent first. The assistant copies these into employer forms exactly as written."
        fields={workFields}
        value={profile.workHistory}
        onChange={(value) => update("workHistory", value)}
        currentLabel="I currently work here"
        addLabel="Add work experience"
      />

      <RecordsEditor
        title="Education"
        note="Schools, degrees and certificate programs."
        fields={educationFields}
        value={profile.education}
        onChange={(value) => update("education", value)}
        currentLabel="Still studying here"
        addLabel="Add education"
      />

      <Panel>
        <SectionTitle title="Skills" note="Used for skills boxes on application forms. Separate with commas." />
        <div className="mt-5"><textarea className={inputClass} rows={3} placeholder="Example: Active Directory, Windows 11, ServiceNow, TCP/IP" value={profile.skills} onChange={(event) => update("skills", event.target.value)} /></div>
      </Panel>

      <div className="sticky bottom-4 z-10 flex items-center justify-between gap-4 rounded-2xl border border-slate-700 bg-[#0d1a2c]/95 p-4 shadow-2xl backdrop-blur-xl">
        <p className="hidden text-xs text-slate-500 sm:block">Nothing is submitted until you approve it.</p>
        <button disabled={saving} className="ml-auto rounded-xl bg-blue-600 px-6 py-3 text-sm font-semibold text-white transition hover:bg-blue-500 disabled:opacity-50">
          {saving ? "Saving…" : "Save application profile"}
        </button>
      </div>
    </form>
  );
}

function ResumesView({ resumes }: { resumes: Resume[] }) {
  return (
    <div className="space-y-6">
      <MasterResumePanel />
      <section>
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-blue-400">Six files reviewed</p>
        <h2 className="mt-2 text-3xl font-semibold tracking-tight text-white">Use a different resume for each lane</h2>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-400">Employers scan for relevance. These mappings keep the strongest evidence near the top instead of sending the same broad resume everywhere.</p>
      </section>

      <div className="grid gap-5 xl:grid-cols-2">
        {resumes.map((resume) => (
          <article key={resume.id} className="rounded-[24px] border border-slate-800 bg-[#0d1a2c] p-5 transition hover:border-slate-700">
            <div className="flex items-start justify-between gap-4">
              <div className="flex min-w-0 gap-3.5">
                <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-blue-500/10 text-blue-300"><Icon name="file" className="h-5 w-5" /></span>
                <div className="min-w-0">
                  <p className="text-xs font-semibold uppercase tracking-[0.15em] text-slate-500">{resume.category}</p>
                  <h3 className="mt-1 text-lg font-semibold text-white">{resume.label}</h3>
                </div>
              </div>
              <ResumeStatus status={resume.status} />
            </div>
            <p className="mt-5 text-sm leading-6 text-slate-300">{resume.recommendation}</p>
            <div className="mt-4 rounded-xl border border-slate-800 bg-[#091523] p-3.5">
              <div className="flex items-start gap-2.5">
                <Icon name={resume.status === "ready" ? "check" : "alert"} className={`mt-0.5 h-4 w-4 shrink-0 ${resume.status === "ready" ? "text-emerald-400" : "text-amber-400"}`} />
                <p className="text-xs leading-5 text-slate-400">{resume.note}</p>
              </div>
            </div>
            <div className="mt-4 flex items-center justify-between gap-3 border-t border-slate-800 pt-4 text-xs text-slate-500">
              <span className="truncate" title={resume.filename}>{resume.filename}</span>
              <span className="shrink-0">{resume.pageCount} {resume.pageCount === "1" ? "page" : "pages"}</span>
            </div>
          </article>
        ))}
      </div>

      <Panel>
        <PanelHeader title="Resume decision rule" eyebrow="Simple matching" />
        <div className="mt-5 overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead className="text-xs uppercase tracking-wide text-slate-500"><tr><th className="pb-3 pr-4">Job posting mentions</th><th className="pb-3 pr-4">Choose</th><th className="pb-3">Before sending</th></tr></thead>
            <tbody className="divide-y divide-slate-800 text-slate-300">
              <tr><td className="py-3 pr-4">Tickets, Active Directory, desktop, users, troubleshooting</td><td className="py-3 pr-4 font-semibold text-white">Help Desk</td><td className="py-3">Confirm city</td></tr>
              <tr><td className="py-3 pr-4">Test cases, regression, UAT, defects, Jira</td><td className="py-3 pr-4 font-semibold text-white">QA Tester</td><td className="py-3">Tailor skills to the posting</td></tr>
              <tr><td className="py-3 pr-4">Routers, switches, cabling, VLAN, field service, data center</td><td className="py-3 pr-4 font-semibold text-white">Network</td><td className="py-3">Confirm title and dates</td></tr>
              <tr><td className="py-3 pr-4">JavaScript, Apps Script, React, automation, prompts</td><td className="py-3 pr-4 font-semibold text-white">Developer / Prompt</td><td className="py-3">Remove blank page 3</td></tr>
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}

function ApplicationsView({
  applications,
  resumes,
  form,
  setForm,
  saving,
  onAdd,
  onStatus,
  onRemove,
  onUpdated,
  send,
}: {
  applications: Application[];
  resumes: Resume[];
  form: ApplicationForm;
  setForm: (form: ApplicationForm) => void;
  saving: boolean;
  onAdd: (event: FormEvent) => void;
  onStatus: (id: string, status: string) => void;
  onRemove: (id: string) => void;
  onUpdated: (application: Application) => void;
  send: SendProps;
}) {
  const [openTailor, setOpenTailor] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [readNote, setReadNote] = useState("");

  function viewResume(id: string) {
    setOpenTailor(id);
    window.requestAnimationFrame(() => document.getElementById(`application-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }

  async function readPosting() {
    setReading(true);
    setReadNote("");
    try {
      const posting = await readJobLink(form.url);
      setForm({
        ...form,
        company: posting.company || form.company,
        role: posting.role || form.role,
        location: posting.location || form.location,
        jobDescription: posting.description,
      });
      setReadNote(`Read ${posting.description.length.toLocaleString()} characters of job details. Check the company and role, then add it.`);
    } catch (reason) {
      setReadNote(reason instanceof Error ? reason.message : "Couldn't read that link. Paste the description instead.");
    } finally {
      setReading(false);
    }
  }

  return (
    <div className="space-y-6">
      <section>
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-blue-400">Application queue</p>
        <h2 className="mt-2 text-3xl font-semibold tracking-tight text-white">Track every job from saved to offer</h2>
        <p className="mt-2 text-sm leading-6 text-slate-400">Read a supported job-board link, or paste the description from another employer site. Then tailor and review your resume and cover letter.</p>
      </section>

      <ReadyToSendPanel
        applications={applications}
        data={send.submissions}
        loadError={send.submissionsError}
        savedProfile={send.savedProfile}
        bridge={send.bridge}
        now={send.now}
        rejected={send.rejected}
        onRejected={send.onRejected}
        onReload={send.onReload}
        onViewResume={viewResume}
        onOpenProfile={send.onOpenProfile}
        onOpenExtension={send.onOpenExtension}
      />

      <Panel>
        <PanelHeader title="Add a job" eyebrow="Paste the link first" />
        <form onSubmit={onAdd} className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <div className="md:col-span-2 xl:col-span-4">
            <Field label="Job link">
              <div className="flex flex-col gap-2 sm:flex-row">
                <input type="url" className={inputClass} placeholder="https://boards.greenhouse.io/company/jobs/123" value={form.url} onChange={(event) => setForm({ ...form, url: event.target.value })} />
                <button type="button" onClick={() => void readPosting()} disabled={reading || !form.url} className="shrink-0 rounded-xl border border-blue-500/40 bg-blue-500/10 px-4 py-3 text-sm font-semibold text-blue-200 transition hover:bg-blue-500/20 disabled:opacity-50">{reading ? "Reading…" : "Read posting"}</button>
              </div>
            </Field>
            {readNote && <p className="mt-2 text-xs text-slate-400">{readNote}</p>}
          </div>
          <Field label="Company"><input required className={inputClass} placeholder="Company name" value={form.company} onChange={(event) => setForm({ ...form, company: event.target.value })} /></Field>
          <Field label="Role"><input required className={inputClass} placeholder="Job title" value={form.role} onChange={(event) => setForm({ ...form, role: event.target.value })} /></Field>
          <Field label="Location"><input className={inputClass} placeholder="Atlanta, GA or Remote" value={form.location} onChange={(event) => setForm({ ...form, location: event.target.value })} /></Field>
          <Field label="Resume"><select className={inputClass} value={form.resumeId} onChange={(event) => setForm({ ...form, resumeId: event.target.value })}><option value="">Choose later</option>{resumes.filter((resume) => resume.category !== "Cover Letter").map((resume) => <option key={resume.id} value={resume.id}>{resume.label}</option>)}</select></Field>
          <Field label="Starting status"><select className={inputClass} value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value })}>{statusOptions.slice(0, 3).map((status) => <option key={status} value={status}>{statusLabel(status)}</option>)}</select></Field>
          <div className="md:col-span-2"><Field label="Notes"><input className={inputClass} placeholder="Referral, deadline, salary, or follow-up note" value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} /></Field></div>
          <div className="md:col-span-2 xl:col-span-4"><Field label="Job description" hint={form.jobDescription ? "" : "Read from the link, or paste it"}><textarea className={`${inputClass} min-h-[120px] text-xs leading-5`} placeholder="Responsibilities, requirements and nice-to-haves. The AI tailors your resume to this." value={form.jobDescription} onChange={(event) => setForm({ ...form, jobDescription: event.target.value })} /></Field></div>
          <div className="md:col-span-2 xl:col-span-4 flex justify-end"><button disabled={saving} className="rounded-xl bg-blue-600 px-5 py-3 text-sm font-semibold text-white transition hover:bg-blue-500 disabled:opacity-50">{saving ? "Adding…" : "Add to queue"}</button></div>
        </form>
      </Panel>

      <Panel>
        <PanelHeader title="Your applications" eyebrow={`${applications.length} tracked`} />
        {applications.length === 0 ? (
          <div className="mt-5 grid place-items-center rounded-2xl border border-dashed border-slate-700 bg-[#0a1627] px-6 py-12 text-center">
            <span className="grid h-12 w-12 place-items-center rounded-2xl bg-blue-500/10 text-blue-300"><Icon name="briefcase" className="h-6 w-6" /></span>
            <h3 className="mt-4 font-semibold text-white">No jobs in the queue yet</h3>
            <p className="mt-2 max-w-md text-sm leading-6 text-slate-500">Start with a direct posting for Help Desk, QA, network technician, data center technician, or field service work.</p>
          </div>
        ) : (
          <div className="mt-4 space-y-3">
            {applications.map((application) => {
              const resume = resumes.find((item) => item.id === application.resumeId);
              const tailored = parseTailored(application);
              const submission = send.submissions ? newestSubmission(send.submissions.submissions, application.id) : null;
              return (
                <div key={application.id} id={`application-${application.id}`} className="scroll-mt-28">
                <article className="grid gap-4 rounded-2xl border border-slate-800 bg-[#0a1627] p-4 lg:grid-cols-[1.3fr_.8fr_.65fr_auto] lg:items-center">
                  <div>
                    <div className="flex flex-wrap items-center gap-2"><h3 className="font-semibold text-white">{application.role}</h3><StatusPill status={application.status} /></div>
                    <p className="mt-1 text-sm text-slate-400">{application.company}{application.location ? ` · ${application.location}` : ""}</p>
                    {application.notes && <p className="mt-2 text-xs text-slate-500">{application.notes}</p>}
                    {submission && (
                      <SubmitPill
                        row={submission}
                        note={send.notes[submission.id]}
                        rejectedReason={send.rejected[submission.id]}
                        bridge={send.bridge}
                        now={send.now}
                        onCancel={send.onCancel}
                        onResolve={send.onResolve}
                      />
                    )}
                  </div>
                  <div><p className="text-[11px] font-semibold uppercase tracking-wide text-slate-600">Resume</p><p className="mt-1 text-xs text-slate-300">{tailored ? `Tailored · ${Math.round(tailored.fitScore)}% fit` : resume?.label || "Not tailored yet"}</p></div>
                  <select aria-label={`Status for ${application.role}`} className={`${inputClass} py-2.5`} value={application.status} onChange={(event) => void onStatus(application.id, event.target.value)}>{statusOptions.map((status) => <option key={status} value={status}>{statusLabel(status)}</option>)}</select>
                  <div className="flex items-center justify-end gap-2">
                    <button onClick={() => setOpenTailor(openTailor === application.id ? null : application.id)} className="rounded-lg bg-blue-600 px-3 py-2 text-xs font-semibold text-white hover:bg-blue-500">{openTailor === application.id ? "Close" : tailored ? "View resume" : "Tailor resume"}</button>
                    {application.url && <a href={application.url} target="_blank" rel="noreferrer" className="rounded-lg border border-slate-700 px-3 py-2 text-xs font-semibold text-blue-300 hover:bg-slate-800">Open job</a>}
                    <button onClick={() => onRemove(application.id)} className="rounded-lg border border-slate-800 px-3 py-2 text-xs text-slate-500 hover:border-rose-500/30 hover:text-rose-300">Remove</button>
                  </div>
                </article>
                {openTailor === application.id && (
                  <TailorPanel application={application} onUpdated={(next) => onUpdated({ ...application, ...next })} />
                )}
                </div>
              );
            })}
          </div>
        )}
      </Panel>
    </div>
  );
}

function AccountsView({
  accounts,
  form,
  setForm,
  saving,
  onAdd,
}: {
  accounts: Account[];
  form: { company: string; loginEmail: string; loginUrl: string };
  setForm: (form: { company: string; loginEmail: string; loginUrl: string }) => void;
  saving: boolean;
  onAdd: (event: FormEvent) => void;
}) {
  return (
    <div className="space-y-6">
      <section>
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-blue-400">Safer sign-ins</p>
        <h2 className="mt-2 text-3xl font-semibold tracking-tight text-white">Employer accounts without a password spreadsheet</h2>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-400">This page records where an account exists and which email you used. The actual password stays encrypted in Apple Passwords on your Mac.</p>
      </section>

      <div className="grid gap-6 xl:grid-cols-[.8fr_1.2fr]">
        <Panel>
          <PanelHeader title="Record an account" eyebrow="No password field by design" />
          <form onSubmit={onAdd} className="mt-5 space-y-4">
            <Field label="Company"><input required className={inputClass} placeholder="Example: Cox Automotive" value={form.company} onChange={(event) => setForm({ ...form, company: event.target.value })} /></Field>
            <Field label="Login email"><input required type="email" className={inputClass} value={form.loginEmail} onChange={(event) => setForm({ ...form, loginEmail: event.target.value })} /></Field>
            <Field label="Sign-in page"><input type="url" className={inputClass} placeholder="https://..." value={form.loginUrl} onChange={(event) => setForm({ ...form, loginUrl: event.target.value })} /></Field>
            <div className="rounded-xl border border-emerald-400/15 bg-emerald-400/7 p-4">
              <div className="flex items-start gap-3"><Icon name="shield" className="mt-0.5 h-5 w-5 shrink-0 text-emerald-400" /><p className="text-xs leading-5 text-slate-300"><strong className="text-emerald-200">When the company asks for a password:</strong> let Safari or Chrome create a strong unique password, then save it to Apple Passwords. Do not paste it into chat or this dashboard.</p></div>
            </div>
            <button disabled={saving} className="w-full rounded-xl bg-blue-600 px-5 py-3 text-sm font-semibold text-white transition hover:bg-blue-500 disabled:opacity-50">{saving ? "Recording…" : "Record employer account"}</button>
          </form>
        </Panel>

        <Panel>
          <PanelHeader title="Account register" eyebrow={`${accounts.length} companies`} />
          {accounts.length === 0 ? (
            <div className="mt-5 grid place-items-center rounded-2xl border border-dashed border-slate-700 bg-[#0a1627] px-6 py-12 text-center"><Icon name="key" className="h-7 w-7 text-slate-600" /><p className="mt-3 text-sm text-slate-500">Employer accounts will appear here.</p></div>
          ) : (
            <div className="mt-4 space-y-3">
              {accounts.map((account) => (
                <article key={account.id} className="flex flex-col gap-4 rounded-2xl border border-slate-800 bg-[#0a1627] p-4 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <h3 className="font-semibold text-white">{account.company}</h3>
                    <p className="mt-1 text-xs text-slate-500">{account.loginEmail}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded-full bg-emerald-400/10 px-2.5 py-1 text-[11px] font-bold text-emerald-300">Use Apple Passwords</span>
                    <span className="rounded-full bg-amber-400/10 px-2.5 py-1 text-[11px] font-bold text-amber-300">Email verification pending</span>
                    {account.loginUrl && <a href={account.loginUrl} target="_blank" rel="noreferrer" className="rounded-lg border border-slate-700 px-3 py-2 text-xs font-semibold text-blue-300">Sign in</a>}
                  </div>
                </article>
              ))}
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}

function ExtensionView({
  onDownloadProfile,
  readiness,
  bridge,
  submissions,
  onSettingsSaved,
}: {
  onDownloadProfile: () => void;
  readiness: number;
  bridge: ExtensionBridge;
  submissions: SubmissionsData | null;
  onSettingsSaved: (settings: SubmitSettings) => void;
}) {
  const inChrome = submissions ? submissions.submissions.filter((row) => row.state === "approved" && bridge.held.includes(row.id)).length : 0;
  const dot = bridge.status === "connected" ? "bg-emerald-400" : bridge.status === "missing" ? "bg-amber-400" : "bg-slate-500";
  return (
    <div className="space-y-6">
      <section className="overflow-hidden rounded-[28px] border border-blue-500/20 bg-[radial-gradient(circle_at_85%_10%,rgba(34,211,238,.16),transparent_35%),linear-gradient(135deg,#10233d,#0a1728_65%)] p-6 sm:p-8">
        <div className="grid gap-7 lg:grid-cols-[1.2fr_.8fr] lg:items-center">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full border border-blue-300/20 bg-blue-400/8 px-3 py-1.5 text-xs font-semibold text-blue-200"><Icon name="bolt" className="h-4 w-4" />Application Assistant 3.0</div>
            <h2 className="mt-5 text-3xl font-semibold tracking-tight text-white sm:text-4xl">Send the jobs you approve, each with its own resume.</h2>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-300">It opens each job you approved, fills it from your saved profile, attaches that job&apos;s tailored resume and submits only when every check passes. Anything it can&apos;t answer stays open for you, already filled.</p>
            <div className="mt-6 flex flex-wrap items-center gap-4">
              <a href="/applypilot-extension.zip" download className="rounded-xl bg-blue-600 px-5 py-3 text-sm font-semibold text-white transition hover:bg-blue-500">Download Application Assistant 3.0</a>
              <button onClick={onDownloadProfile} className="text-xs font-semibold text-slate-400 underline-offset-4 hover:text-slate-200 hover:underline">Profile file for the popup&apos;s manual mode</button>
            </div>
          </div>
          <div className="rounded-2xl border border-slate-600/50 bg-[#081523]/75 p-5">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Extension status</p>
            <p className="mt-3 flex items-center gap-2.5 text-base font-semibold text-white"><span className={`h-2.5 w-2.5 shrink-0 rounded-full ${dot}`} />{bridgeStatusText(bridge, inChrome)}</p>
            <p className="mt-3 text-xs leading-5 text-slate-400">Profile {readiness}% ready. Each approved job is sent with your saved profile.</p>
          </div>
        </div>
      </section>

      <div className="grid gap-6 xl:grid-cols-[1.1fr_.9fr]">
        <Panel>
          <PanelHeader title="Install on your Mac" eyebrow="About two minutes" />
          <ol className="mt-5 space-y-4">
            {[
              ["1", "Download and unzip", "Double-click applypilot-extension.zip in Downloads."],
              ["2", "Open Chrome extensions", "Go to chrome://extensions and turn on Developer mode."],
              ["3", "Load the assistant", "Click Load unpacked and choose the unzipped ApplyPilot folder. If an older version is listed, remove it first."],
              ["4", "Come back here", "Reload this page in the same Chrome. The status above should say Connected."],
              ["5", "Approve and send", "Under Applications, approve the jobs you want. Chrome opens a window and works through them one at a time."],
            ].map(([number, title, copy]) => (
              <li key={number} className="flex gap-4 rounded-2xl border border-slate-800 bg-[#0a1627] p-4">
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-blue-500/12 text-sm font-bold text-blue-300">{number}</span>
                <div><h3 className="text-sm font-semibold text-white">{title}</h3><p className="mt-1 text-xs leading-5 text-slate-500">{copy}</p></div>
              </li>
            ))}
          </ol>
        </Panel>
        <Panel>
          <PanelHeader title="Safety limits" eyebrow="Built into the assistant" />
          <div className="mt-5 space-y-3">
            {[
              ["Submits only jobs you approved, once each, with that job's own resume", "Each approval lasts 24 hours and is checked with ApplyPilot right before Submit."],
              ["Stops for CAPTCHAs, sign-ups, passwords, legal certifications, demographic and other sensitive questions", "It never solves a CAPTCHA or answers a demographic question. The two settings below say when it may still submit."],
              ["Answers only from your profile, your Yes/No choices, your resume and cover letter", "Any other required question stays for you."],
              ["You click Submit on each site until 3 of your own submissions there are confirmed", "After that you can let ApplyPilot click it, one site at a time."],
              ["The popup's manual assistant still never clicks Submit", "It fills the page you're on and leaves the rest to you."],
              ["Sends on Greenhouse, Lever and Ashby", "Other sites, like Workday, stay manual: the popup fills them and you submit."],
              ["No password storage", "Use Apple Passwords for every employer."],
            ].map(([title, copy]) => (
              <div key={title} className="flex items-start gap-3 rounded-xl border border-slate-800 bg-[#0a1627] p-3.5"><span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-emerald-400/10 text-emerald-300"><Icon name="check" className="h-3.5 w-3.5" /></span><div><p className="text-sm font-semibold text-slate-200">{title}</p><p className="mt-1 text-xs text-slate-500">{copy}</p></div></div>
            ))}
          </div>
        </Panel>
      </div>

      <Panel>
        <PanelHeader title="Automatic submitting" eyebrow="Your rules, checked again before every Submit" />
        <SubmitSettingsPanel data={submissions} onSaved={onSettingsSaved} />
      </Panel>
    </div>
  );
}

function SignInScreen({ signInPath }: { signInPath: string }) {
  return (
    <main className="relative grid min-h-screen place-items-center overflow-hidden bg-[#07111f] px-5 py-12 text-slate-100">
      <div className="pointer-events-none absolute -left-40 -top-40 h-96 w-96 rounded-full bg-blue-600/20 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-48 -right-32 h-[32rem] w-[32rem] rounded-full bg-cyan-500/10 blur-3xl" />
      <section className="relative w-full max-w-3xl overflow-hidden rounded-[32px] border border-slate-700/70 bg-[#0d1a2c]/95 p-7 shadow-2xl shadow-black/40 sm:p-10">
        <Brand />
        <div className="mt-10 grid gap-8 md:grid-cols-[1.2fr_.8fr] md:items-center">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.2em] text-blue-400">Private job search workspace</p>
            <h1 className="mt-3 text-4xl font-semibold tracking-tight text-white sm:text-5xl">Apply smarter. Keep control.</h1>
            <p className="mt-4 text-sm leading-6 text-slate-400 sm:text-base">Match the right resume, autofill repetitive fields on your Mac, and track every employer account without putting passwords in chat.</p>
            <a href={signInPath} className="mt-7 inline-flex items-center gap-2 rounded-xl bg-blue-600 px-5 py-3 text-sm font-semibold text-white transition hover:bg-blue-500">Sign in with ChatGPT <Icon name="arrow" className="h-4 w-4" /></a>
          </div>
          <div className="space-y-3">
            {["Six resumes already mapped", "Mac Chrome autofill helper", "Apple Passwords workflow", "You approve every submission"].map((item) => <div key={item} className="flex items-center gap-3 rounded-xl border border-slate-800 bg-[#091523] px-4 py-3 text-sm text-slate-300"><Icon name="check" className="h-4 w-4 text-emerald-400" />{item}</div>)}
          </div>
        </div>
      </section>
    </main>
  );
}

function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-3">
      <span className={`${compact ? "h-9 w-9" : "h-11 w-11"} grid place-items-center rounded-xl bg-gradient-to-br from-blue-600 to-cyan-400 shadow-lg shadow-blue-950/50`}><Icon name="plane" className={`${compact ? "h-4 w-4" : "h-5 w-5"} text-white`} /></span>
      <div><p className={`${compact ? "text-base" : "text-lg"} font-bold tracking-tight text-white`}>ApplyPilot</p>{!compact && <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-500">Job search OS</p>}</div>
    </div>
  );
}

function NavButton({ item, active, onClick }: { item: (typeof navItems)[number]; active: boolean; onClick: () => void }) {
  return <button onClick={onClick} className={`flex w-full items-center gap-3 rounded-xl px-3.5 py-3 text-left text-sm font-medium transition ${active ? "bg-blue-600 text-white shadow-lg shadow-blue-950/30" : "text-slate-400 hover:bg-slate-800/60 hover:text-slate-200"}`}><Icon name={item.icon} className="h-4.5 w-4.5" />{item.label}</button>;
}

function Panel({ children }: { children: ReactNode }) {
  return <section className="rounded-[24px] border border-slate-800 bg-[#0d1a2c] p-5 sm:p-6">{children}</section>;
}

function PanelHeader({ title, eyebrow, action, onAction }: { title: string; eyebrow: string; action?: string; onAction?: () => void }) {
  return <div className="flex items-start justify-between gap-4"><div><p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">{eyebrow}</p><h2 className="mt-1.5 text-lg font-semibold text-white">{title}</h2></div>{action && <button onClick={onAction} className="text-xs font-semibold text-blue-300 hover:text-blue-200">{action} →</button>}</div>;
}

function SectionTitle({ title, note }: { title: string; note: string }) {
  return <div><h2 className="text-lg font-semibold text-white">{title}</h2><p className="mt-1 text-xs leading-5 text-slate-500">{note}</p></div>;
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <label className="block"><span className="mb-2 flex items-center justify-between gap-2 text-xs font-semibold text-slate-400"><span>{label}</span>{hint && <span className="font-normal text-amber-300/80">{hint}</span>}</span>{children}</label>;
}

function YesNoSelect({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return <select className={inputClass} value={value} onChange={(event) => onChange(event.target.value)}><option value="">Ask me on each form</option><option value="yes">Yes</option><option value="no">No</option></select>;
}

type EditableRecord = Record<string, string | boolean | undefined>;

function parseRows(value: string): EditableRecord[] {
  try {
    const rows: unknown = JSON.parse(value || "[]");
    return Array.isArray(rows) ? rows.filter((row): row is EditableRecord => Boolean(row) && typeof row === "object") : [];
  } catch {
    return [];
  }
}

function RecordsEditor({ title, note, fields, value, onChange, currentLabel, addLabel }: { title: string; note: string; fields: readonly (readonly [string, string])[]; value: string; onChange: (value: string) => void; currentLabel: string; addLabel: string }) {
  const rows = parseRows(value);
  const write = (next: EditableRecord[]) => onChange(JSON.stringify(next));
  const change = (index: number, key: string, next: string | boolean) => write(rows.map((row, i) => (i === index ? { ...row, [key]: next } : row)));
  return (
    <Panel>
      <SectionTitle title={title} note={note} />
      <div className="mt-5 space-y-4">
        {rows.map((row, index) => (
          <div key={index} className="rounded-2xl border border-slate-800 bg-[#0a1627]/50 p-4">
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              {fields.map(([key, label]) => (
                <div key={key} className={key === "description" ? "md:col-span-2 xl:col-span-4" : undefined}>
                  <Field label={label}>
                    {key === "description"
                      ? <textarea className={inputClass} rows={3} value={String(row[key] ?? "")} onChange={(event) => change(index, key, event.target.value)} />
                      : <input className={inputClass} disabled={row.current === true && key.startsWith("end")} value={String(row[key] ?? "")} onChange={(event) => change(index, key, event.target.value)} />}
                  </Field>
                </div>
              ))}
            </div>
            <div className="mt-3 flex items-center justify-between gap-4">
              <label className="flex items-center gap-2 text-xs text-slate-400"><input type="checkbox" checked={row.current === true} onChange={(event) => change(index, "current", event.target.checked)} />{currentLabel}</label>
              <button type="button" onClick={() => write(rows.filter((_, i) => i !== index))} className="text-xs font-semibold text-rose-300 hover:text-rose-200">Remove</button>
            </div>
          </div>
        ))}
        <button type="button" onClick={() => write([...rows, {}])} className="rounded-xl border border-slate-600 bg-slate-900/30 px-4 py-2.5 text-sm font-semibold text-slate-200 transition hover:bg-slate-800/70">{addLabel}</button>
      </div>
    </Panel>
  );
}

function ConfirmationSelect({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return <select className={inputClass} value={value} onChange={(event) => onChange(event.target.value)}><option value="needs_confirmation">Needs confirmation</option><option value="confirmed">Confirmed by me</option></select>;
}

function Stat({ label, value, note, icon }: { label: string; value: number; note: string; icon: IconName }) {
  return <article className="rounded-[22px] border border-slate-800 bg-[#0d1a2c] p-5"><div className="flex items-start justify-between"><div><p className="text-xs font-medium text-slate-500">{label}</p><p className="mt-2 text-3xl font-semibold text-white">{value}</p></div><span className="grid h-10 w-10 place-items-center rounded-xl bg-blue-500/10 text-blue-300"><Icon name={icon} className="h-5 w-5" /></span></div><p className="mt-3 text-xs text-slate-500">{note}</p></article>;
}

function ResumeStatus({ status }: { status: string }) {
  const styles: Record<string, string> = { ready: "bg-emerald-400/10 text-emerald-300", review: "bg-amber-400/10 text-amber-300", fix_first: "bg-rose-400/10 text-rose-300", company_specific: "bg-violet-400/10 text-violet-300" };
  const labels: Record<string, string> = { ready: "Ready", review: "Review", fix_first: "Fix first", company_specific: "Company only" };
  return <span className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-bold ${styles[status] || "bg-slate-700 text-slate-300"}`}>{labels[status] || status}</span>;
}

function StatusPill({ status }: { status: string }) {
  const styles: Record<string, string> = { saved: "bg-slate-500/10 text-slate-400", ready: "bg-blue-400/10 text-blue-300", applied: "bg-cyan-400/10 text-cyan-300", interview: "bg-amber-400/10 text-amber-300", rejected: "bg-rose-400/10 text-rose-300", offer: "bg-emerald-400/10 text-emerald-300" };
  return <span className={`rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide ${styles[status] || styles.saved}`}>{statusLabel(status)}</span>;
}

function LoadingState() {
  return <div className="space-y-5"><div className="h-72 animate-pulse rounded-[28px] bg-slate-800/50" /><div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{[1,2,3,4].map((item) => <div key={item} className="h-32 animate-pulse rounded-[22px] bg-slate-800/40" />)}</div></div>;
}

function EmptyLoad({ onRetry }: { onRetry: () => void }) {
  return <div className="grid min-h-[55vh] place-items-center text-center"><div><Icon name="alert" className="mx-auto h-8 w-8 text-amber-400" /><h2 className="mt-4 text-xl font-semibold text-white">ApplyPilot could not load</h2><button onClick={onRetry} className="mt-5 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white">Try again</button></div></div>;
}

function calculateReadiness(profile: Profile | null) {
  if (!profile) return 0;
  const checks = [
    Boolean(profile.firstName && profile.lastName && profile.profileEmail && profile.phone),
    Boolean(profile.city && profile.state && profile.postalCode),
    profile.identityStatus === "confirmed",
    profile.locationStatus === "confirmed",
    profile.workHistoryStatus === "confirmed",
    Boolean(profile.workAuthorized),
    Boolean(profile.requiresSponsorship),
    profile.workHistory.trim().length > 2,
    Boolean(profile.availability),
  ];
  return Math.round((checks.filter(Boolean).length / checks.length) * 100);
}

function statusLabel(status: string) {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const payload = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
  return payload;
}

type IconName = "grid" | "person" | "file" | "briefcase" | "key" | "bolt" | "shield" | "check" | "alert" | "gauge" | "send" | "plane" | "arrow" | "search";

function Icon({ name, className = "h-5 w-5" }: { name: IconName; className?: string }) {
  const paths: Record<IconName, ReactNode> = {
    grid: <><rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/></>,
    person: <><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></>,
    file: <><path d="M6 2h8l4 4v16H6z"/><path d="M14 2v5h5M9 13h6M9 17h6"/></>,
    briefcase: <><rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V4h6v3M3 12h18M10 12v2h4v-2"/></>,
    key: <><circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M15 8l3 3M17 6l3 3"/></>,
    bolt: <path d="m13 2-8 12h7l-1 8 8-12h-7z"/>,
    shield: <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/>,
    check: <path d="m5 12 4 4L19 6"/>,
    alert: <><path d="M12 3 2.8 20h18.4L12 3Z"/><path d="M12 9v4M12 17h.01"/></>,
    gauge: <><path d="M4 18a8 8 0 1 1 16 0"/><path d="m12 14 4-4M6 18h12"/></>,
    send: <><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></>,
    plane: <><path d="M2 16.5 22 3l-6 18-5-6-9 1.5Z"/><path d="m11 15 4-4"/></>,
    arrow: <><path d="M5 12h14M13 6l6 6-6 6"/></>,
    search: <><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></>,
  };
  return <svg aria-hidden="true" className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}
