// Runs in the Naver page's own JavaScript world so it can observe the JSON
// body the page sends when a staff member changes schedule stock.
(() => {
  if (window.__jumpingBattleNaverScheduleHookInstalled) return;
  window.__jumpingBattleNaverScheduleHookInstalled = true;
  window.postMessage({ source: "jumpingbattle-naver-schedule-hook", ready: true }, window.location.origin);

  const isSchedulePatch = (url, method) => String(method || "GET").toUpperCase() === "PATCH"
    && /https:\/\/api-partner\.booking\.naver\.com\/v3\.1\/businesses\/\d+\/biz-items\/\d+\/schedules(?:\?|$)/.test(String(url || ""));

  const parseBody = body => {
    if (typeof body !== "string") return null;
    try { return JSON.parse(body); } catch { return null; }
  };

  const emit = (url, method, body) => {
    if (!isSchedulePatch(url, method)) return;
    const payload = parseBody(body);
    if (!payload || typeof payload !== "object") return;
    window.postMessage({
      source: "jumpingbattle-naver-schedule-hook",
      url: String(url),
      payload
    }, window.location.origin);
  };

  const originalFetch = window.fetch;
  window.fetch = function(input, init = {}) {
    const url = typeof input === "string" ? input : input?.url;
    const method = init?.method || (typeof input === "object" ? input?.method : "GET");
    emit(url, method, init?.body);
    return originalFetch.apply(this, arguments);
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url) {
    this.__jumpingBattleRequestMethod = method;
    this.__jumpingBattleRequestUrl = url;
    return originalOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function(body) {
    emit(this.__jumpingBattleRequestUrl, this.__jumpingBattleRequestMethod, body);
    return originalSend.apply(this, arguments);
  };
})();
