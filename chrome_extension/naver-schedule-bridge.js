// Isolated-world bridge: only forwards schedule PATCH data emitted by the
// page hook. It does not read cookies or reservation content.
// This script can remain in a Naver tab for a moment after the unpacked
// extension is reloaded. In that state Chrome invalidates its old context;
// silently ignore it until the tab is refreshed and the current bridge loads.
function sendToCurrentExtension(message) {
  try {
    if (!chrome?.runtime?.id) return;
    Promise.resolve(chrome.runtime.sendMessage(message)).catch(() => {});
  } catch (_) {
    // Extension context invalidated during reload: harmless old page bridge.
  }
}

sendToCurrentExtension({ type: "naver-schedule-bridge-ready" });

window.addEventListener("message", event => {
  if (event.source !== window || event.origin !== window.location.origin) return;
  const data = event.data;
  if (!data || data.source !== "jumpingbattle-naver-schedule-hook") return;
  if (data.ready) {
    sendToCurrentExtension({ type: "naver-schedule-hook-ready" });
    return;
  }
  sendToCurrentExtension({
    type: "naver-staff-schedule-patch",
    url: data.url,
    payload: data.payload
  });
});
