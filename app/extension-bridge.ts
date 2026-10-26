import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Batch } from "./send-batch";
import type { ClaimResult, SubmissionRow } from "./submission-store";

// Talks to Application Assistant 3.2 through its content script on this page (window.postMessage, same origin only).
// The page makes every server call itself, so the extension never needs this site's cookies.

const CHANNEL = "applypilot";
const HELLO_TIMEOUT_MS = 2000;
const REQUEST_TIMEOUT_MS = 20_000;
const BATCH_TIMEOUT_MS = 90_000; // Chrome re-hashes every PDF before it accepts a batch
const RESULTS_CHUNK = 20;
const REFRESH_DELAY_MS = 1500;
const NOT_CONNECTED = "Application Assistant 3.2 isn't connected. Open this page in Chrome on your Mac with it installed.";
const NO_ANSWER = "Chrome didn't answer. Reload the extension and try again.";

type Envelope = {
  channel: typeof CHANNEL; v: 1; from: "dashboard" | "extension"; type: string; id: string; replyTo?: string; payload?: unknown;
};

export type BridgeStatus = "checking" | "connected" | "missing";
export type BridgeProgress = { approvalId: string; state: string; note: string };
export type BatchReply = { accepted: string[]; rejected: { approvalId: string; reason: string }[] };
export type ExtensionBridge = {
  status: BridgeStatus; version: string; held: string[]; running: boolean; resultsWaiting: number;
  sendBatch(batch: Batch): Promise<BatchReply>;
  cancel(approvalIds: string[]): Promise<{ cancelled: string[]; tooLate: string[] }>;
  stop(): Promise<void>; resume(): Promise<void>; focus(approvalId: string): Promise<{ ok: boolean; reason: string }>;
};

type Ready = { status: BridgeStatus; version: string; held: string[]; running: boolean; resultsWaiting: number };

const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const strings = (value: unknown) => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
const short = (value: unknown, max: number) => (typeof value === "string" ? value.slice(0, max) : "");
const finished = (state: string) => state.startsWith("done:") || state === "cancelled" || state === "paused";

function claimResultOf(body: unknown): ClaimResult {
  if (!isObject(body)) return { ok: false, reason: "network" };
  if (body.ok === true && (body.mode === "auto" || body.mode === "supervised")) return { ok: true, mode: body.mode };
  if (body.ok !== false || typeof body.reason !== "string") return { ok: false, reason: "network" };
  const out: ClaimResult = { ok: false, reason: body.reason.slice(0, 60) };
  if (typeof body.retryAfterSec === "number") out.retryAfterSec = body.retryAfterSec;
  if (typeof body.resetAt === "string") out.resetAt = body.resetAt;
  return out;
}

export function useExtensionBridge(opts: {
  onResultsSaved(rows: SubmissionRow[]): void;
  onProgress(p: BridgeProgress): void;
}): ExtensionBridge {
  const [ready, setReady] = useState<Ready>({ status: "checking", version: "", held: [], running: false, resultsWaiting: 0 });
  const optsRef = useRef(opts);
  useEffect(() => {
    optsRef.current = opts;
  });
  const statusRef = useRef<BridgeStatus>("checking");
  const pending = useRef(new Map<string, (payload: unknown) => void>());
  const syncing = useRef({ running: false, again: false });
  const refreshTimer = useRef<number | undefined>(undefined);
  const readyCount = useRef(0);

  const post = useCallback((type: string, payload: unknown, replyTo?: string) => {
    const id = crypto.randomUUID();
    const message: Envelope = { channel: CHANNEL, v: 1, from: "dashboard", type, id, ...(replyTo ? { replyTo } : {}), payload };
    window.postMessage(message, location.origin);
    return id;
  }, []);

  const request = useCallback(<T>(type: string, payload: unknown = {}, timeoutMs = REQUEST_TIMEOUT_MS) =>
    new Promise<T>((resolve, reject) => {
      const id = crypto.randomUUID();
      const timer = window.setTimeout(() => {
        pending.current.delete(id);
        reject(new Error(NO_ANSWER));
      }, timeoutMs);
      pending.current.set(id, (reply) => {
        window.clearTimeout(timer);
        resolve(reply as T);
      });
      const message: Envelope = { channel: CHANNEL, v: 1, from: "dashboard", type, id, payload };
      window.postMessage(message, location.origin);
    }), []);

  const syncResults = useCallback(async () => {
    const sync = syncing.current;
    if (sync.running) {
      sync.again = true;
      return;
    }
    sync.running = true;
    try {
      do {
        sync.again = false;
        const reply = await request<unknown>("AP_PULL_RESULTS");
        const results = isObject(reply) && Array.isArray(reply.results) ? reply.results : [];
        for (let i = 0; i < results.length; i += RESULTS_CHUNK) {
          const response = await fetch("/api/submissions/results", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ results: results.slice(i, i + RESULTS_CHUNK) }),
          });
          // Not acked, so Chrome keeps them and they go again on the next pull.
          if (!response.ok) return;
          const body = (await response.json()) as unknown;
          // A result the server refused as malformed would be refused on every pull, so it is let go too.
          const refused = isObject(body) && Array.isArray(body.rejected)
            ? body.rejected.filter(isObject).map((item) => item.resultId).filter((id): id is string => typeof id === "string" && id !== "")
            : [];
          const acked = [...(isObject(body) ? strings(body.acked) : []), ...refused];
          if (acked.length) await request("AP_RESULTS_ACK", { resultIds: acked });
          const rows = isObject(body) && Array.isArray(body.submissions) ? (body.submissions as SubmissionRow[]) : [];
          optsRef.current.onResultsSaved(rows);
        }
      } while (sync.again);
    } catch {
      // Tried again on the next notice from Chrome or the next time this tab is shown.
    } finally {
      sync.running = false;
    }
  }, [request]);

  const markMissing = useCallback(() => {
    statusRef.current = "missing";
    setReady((current) => ({ ...current, status: "missing", running: false }));
  }, []);

  const applyReady = useCallback((payload: unknown) => {
    // An extension that was reloaded leaves its old content script without a background to ask.
    if (!isObject(payload) || typeof payload.version !== "string" || !payload.version) {
      markMissing();
      return;
    }
    readyCount.current += 1;
    const wasConnected = statusRef.current === "connected";
    statusRef.current = "connected";
    setReady({
      status: "connected",
      version: payload.version.slice(0, 20),
      held: strings(payload.held),
      running: payload.running === true,
      resultsWaiting: typeof payload.resultsWaiting === "number" ? payload.resultsWaiting : 0,
    });
    if (!wasConnected) void syncResults();
  }, [markMissing, syncResults]);

  const hello = useCallback(() => {
    // A hello sent before Chrome injected bridge.js is never answered; the AP_READY bridge.js sends on load
    // already said the extension is here, so that hello timing out doesn't make it missing.
    const seen = readyCount.current;
    return request<unknown>("AP_HELLO", {}, HELLO_TIMEOUT_MS).then(applyReady, () => {
      if (readyCount.current === seen) markMissing();
    });
  }, [applyReady, markMissing, request]);

  const refreshSoon = useCallback(() => {
    window.clearTimeout(refreshTimer.current);
    refreshTimer.current = window.setTimeout(() => void hello(), REFRESH_DELAY_MS);
  }, [hello]);

  const answerClaim = useCallback(async (claimId: string, payload: unknown) => {
    let result: ClaimResult;
    try {
      const response = await fetch("/api/submissions/claim", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(isObject(payload) ? payload : {}),
      });
      result = response.ok ? claimResultOf(await response.json()) : { ok: false, reason: "network" };
    } catch {
      result = { ok: false, reason: "network" };
    }
    post("AP_CLAIM_RESULT", result, claimId);
  }, [post]);

  useEffect(() => {
    const waiting = pending.current;
    function onMessage(event: MessageEvent) {
      if (event.source !== window || event.origin !== location.origin) return;
      const data = event.data as Partial<Envelope> | null;
      if (!isObject(data) || data.channel !== CHANNEL || data.v !== 1 || data.from !== "extension" || typeof data.type !== "string") return;
      if (typeof data.replyTo === "string") {
        const handle = waiting.get(data.replyTo);
        if (handle) {
          waiting.delete(data.replyTo);
          handle(data.payload);
        }
        return;
      }
      if (data.type === "AP_READY") {
        applyReady(data.payload);
        // bridge.js's own hello doesn't let this tab take claims; this page's hello does.
        if (statusRef.current === "connected") void hello();
      } else if (data.type === "AP_CLAIM" && typeof data.id === "string") void answerClaim(data.id, data.payload);
      else if (data.type === "AP_RESULTS_WAITING") void syncResults();
      else if (data.type === "AP_PROGRESS" && isObject(data.payload)) {
        const p = data.payload;
        const progress = { approvalId: short(p.approvalId, 40), state: short(p.state, 40), note: short(p.note, 200) };
        if (!progress.approvalId) return;
        optsRef.current.onProgress(progress);
        if (!finished(progress.state)) setReady((current) => (current.running ? current : { ...current, running: true }));
        refreshSoon();
      }
    }
    function onVisible() {
      if (document.visibilityState !== "visible") return;
      void hello();
      if (statusRef.current === "connected") void syncResults();
    }
    window.addEventListener("message", onMessage);
    document.addEventListener("visibilitychange", onVisible);
    void hello();
    return () => {
      window.removeEventListener("message", onMessage);
      document.removeEventListener("visibilitychange", onVisible);
      window.clearTimeout(refreshTimer.current);
      waiting.clear();
    };
  }, [answerClaim, applyReady, hello, refreshSoon, syncResults]);

  const connected = useCallback(() => {
    if (statusRef.current !== "connected") throw new Error(NOT_CONNECTED);
  }, []);

  const sendBatch = useCallback(async (batch: Batch): Promise<BatchReply> => {
    connected();
    const reply = await request<unknown>("AP_BATCH", { batch }, BATCH_TIMEOUT_MS);
    if (!isObject(reply) || !Array.isArray(reply.accepted)) throw new Error("Chrome couldn't take these jobs. Reload the extension and try again.");
    const rejected = (Array.isArray(reply.rejected) ? reply.rejected : []).filter(isObject)
      .map((item) => ({ approvalId: short(item.approvalId, 40), reason: short(item.reason, 200) }));
    refreshSoon();
    return { accepted: strings(reply.accepted), rejected };
  }, [connected, refreshSoon, request]);

  const cancel = useCallback(async (approvalIds: string[]) => {
    connected();
    const reply = await request<unknown>("AP_CANCEL", { approvalIds });
    refreshSoon();
    return { cancelled: isObject(reply) ? strings(reply.cancelled) : [], tooLate: isObject(reply) ? strings(reply.tooLate) : [] };
  }, [connected, refreshSoon, request]);

  const stop = useCallback(async () => {
    connected();
    await request("AP_STOP");
    setReady((current) => ({ ...current, running: false }));
    refreshSoon();
  }, [connected, refreshSoon, request]);

  const resume = useCallback(async () => {
    connected();
    await request("AP_RESUME");
    refreshSoon();
  }, [connected, refreshSoon, request]);

  const focus = useCallback(async (approvalId: string) => {
    connected();
    const reply = await request<unknown>("AP_FOCUS", { approvalId });
    const ok = isObject(reply) && reply.ok === true;
    return { ok, reason: ok ? "" : isObject(reply) && reply.reason === "elsewhere" ? "elsewhere" : "gone" };
  }, [connected, request]);

  return useMemo(
    () => ({ ...ready, sendBatch, cancel, stop, resume, focus }),
    [ready, sendBatch, cancel, stop, resume, focus],
  );
}
