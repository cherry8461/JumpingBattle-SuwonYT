// Isolated-world bridge: only forwards schedule PATCH data emitted by the
// page hook. It does not read cookies or reservation content.
chrome.runtime.sendMessage({ type: "naver-schedule-bridge-ready" }).catch(() => {});

window.addEventListener("message", event => {
  if (event.source !== window || event.origin !== window.location.origin) return;
  const data = event.data;
  if (!data || data.source !== "jumpingbattle-naver-schedule-hook") return;
  if (data.ready) {
    chrome.runtime.sendMessage({ type: "naver-schedule-hook-ready" }).catch(() => {});
    return;
  }
  chrome.runtime.sendMessage({
    type: "naver-staff-schedule-patch",
    url: data.url,
    payload: data.payload
  }).catch(() => {});
});
