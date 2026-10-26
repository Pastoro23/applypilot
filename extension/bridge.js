// Content script on the ApplyPilot dashboard only. It passes messages between the page and the extension
// and holds nothing itself: no storage reads, no PDFs, only ids, states, short notes and results.
(() => {
  if (globalThis.__applypilotBridge) return;
  globalThis.__applypilotBridge = true;

  const CHANNEL = "applypilot";
  const FROM_PAGE = new Set(["AP_HELLO", "AP_BATCH", "AP_CANCEL", "AP_STOP", "AP_RESUME", "AP_FOCUS", "AP_PULL_RESULTS", "AP_RESULTS_ACK"]);
  const REPLY_TYPE = { AP_HELLO: "AP_READY", AP_BATCH: "AP_BATCH_ACCEPTED", AP_CANCEL: "AP_CANCEL_RESULT", AP_PULL_RESULTS: "AP_RESULTS" };
  const NOTICES = new Set(["AP_RESULTS_WAITING", "AP_PROGRESS"]);
  const CLAIM_TIMEOUT_MS = 20000;
  const waiting = new Map(); // message id -> reply handler, for runner requests the page must answer

  const post = (type, payload, replyTo) =>
    window.postMessage(
      { channel: CHANNEL, v: 1, from: "extension", type, id: crypto.randomUUID(), ...(replyTo ? { replyTo } : {}), payload },
      location.origin,
    );

  const ask = (type, payload) =>
    new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type, payload }, (reply) => {
          void chrome.runtime.lastError;
          resolve(reply && typeof reply === "object" ? reply : { error: "no_reply" });
        });
      } catch {
        resolve({ error: "extension_unavailable" });
      }
    });

  window.addEventListener("message", async (event) => {
    const d = event.data;
    if (event.source !== window || event.origin !== location.origin) return;
    if (!d || d.channel !== CHANNEL || d.v !== 1 || d.from !== "dashboard" || typeof d.type !== "string") return;
    if (typeof d.replyTo === "string") {
      const handle = waiting.get(d.replyTo);
      if (handle) {
        waiting.delete(d.replyTo);
        handle(d);
      }
      return;
    }
    if (!FROM_PAGE.has(d.type) || typeof d.id !== "string") return;
    const reply = await ask(d.type, d.payload && typeof d.payload === "object" ? d.payload : {});
    post(REPLY_TYPE[d.type] || "AP_OK", reply, d.id);
  });

  const claimResult = (d) => {
    const r = d.payload && typeof d.payload === "object" ? d.payload : d;
    const out = { ok: r.ok === true };
    if (typeof r.mode === "string") out.mode = r.mode;
    if (typeof r.reason === "string") out.reason = r.reason;
    if (typeof r.retryAfterSec === "number") out.retryAfterSec = r.retryAfterSec;
    if (typeof r.resetAt === "string") out.resetAt = r.resetAt;
    if (!out.ok && !out.reason) out.reason = "network";
    return out;
  };

  const notice = (type, p) => {
    const o = p && typeof p === "object" ? p : {};
    if (type === "AP_RESULTS_WAITING") return { n: Number(o.n) || 0 };
    return { approvalId: String(o.approvalId || ""), state: String(o.state || ""), note: String(o.note || "").slice(0, 200) };
  };

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || !String(sender.url || "").startsWith(chrome.runtime.getURL(""))) return false;
    if (!msg || typeof msg.type !== "string") return false;
    if (NOTICES.has(msg.type)) {
      post(msg.type, notice(msg.type, msg.payload));
      sendResponse({ ok: true });
      return false;
    }
    if (msg.type !== "AP_CLAIM") return false;
    const id = crypto.randomUUID();
    const timer = setTimeout(() => {
      waiting.delete(id);
      sendResponse({ ok: false, reason: "timeout" });
    }, CLAIM_TIMEOUT_MS);
    waiting.set(id, (d) => {
      clearTimeout(timer);
      sendResponse(claimResult(d));
    });
    window.postMessage({ channel: CHANNEL, v: 1, from: "extension", type: "AP_CLAIM", id, payload: msg.payload }, location.origin);
    return true;
  });

  ask("AP_HELLO").then((ready) => {
    if (typeof ready.version === "string") post("AP_READY", ready);
  });
})();
