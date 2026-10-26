// Mounts the dashboard's own useExtensionBridge hook for scripts/test-extension.mjs, bundled there with vite, and
// writes each status it reports into window.__statuses.
import { createElement as h, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { useExtensionBridge } from "../../app/extension-bridge.ts";

function App() {
  const bridge = useExtensionBridge({ onResultsSaved() {}, onProgress() {} });
  useEffect(() => {
    (globalThis.__statuses ||= []).push([Math.round(performance.now()), bridge.status]);
  }, [bridge.status]);
  return h("p", { id: "status" }, bridge.status);
}

// Mounted at once, before the stand-in bridge has loaded, like a dashboard that hydrates before Chrome injects bridge.js.
createRoot(document.getElementById("app")).render(h(App));
