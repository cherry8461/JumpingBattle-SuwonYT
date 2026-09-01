/* Naver Booking collector for the Suwon Yeongtong local operation server. */
importScripts("local-config.js");

const CONFIG = globalThis.NAVER_RESERVATION_CONFIG || {};
const NAVER_API_BASE = "https://partner.booking.naver.com/api";
const BUSINESS_TYPE_ID = 12;
const CONFIRMED_STATUS_CODE = "RC03";
const RESERVATION_ALARM_NAME = "suwonyeongtong-naver-poll";
const STOCK_ALARM_NAME = "suwonyeongtong-naver-stock-poll";
const DELIVERY_STATE_KEY = "delivery-state";
const STOCK_STATE_KEY = "naver-stock-closed-by-extension";
const NAVER_WRITE_AUTH_KEY = "naver-write-auth";
const EXPECTED_STOCK_WRITE_KEY = "expected-extension-stock-writes";
const KST_TIME_ZONE = "Asia/Seoul";
const EXTENSION_BUILD = "suwonyt-manual-stock-reconcile-20260901-02";
let roomItemIdsCache = null;
let roomItemIdsCacheAt = 0;
let stockEventWatcherRunning = false;
let emailHintWatcherRunning = false;
let stockSyncInFlight = null;

function requireConfig() {
  if (!Number.isFinite(Number(CONFIG.businessId)) || !String(CONFIG.endpoint || "").startsWith("http")) {
    throw new Error("local-config.js의 businessId와 endpoint를 확인하세요.");
  }
  if (String(CONFIG.agentToken || "").length < 24) {
    throw new Error("local-config.js의 agentToken을 설정하세요.");
  }
}

function kstDateKey(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: KST_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit"
  }).format(date);
}

function bookingRange() {
  const startDate = kstDateKey();
  const start = new Date(`${startDate}T00:00:00+09:00`);
  const end = new Date(start.getTime() + 14 * 24 * 60 * 60 * 1000 + 86_399_999);
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

function whenInKst(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: KST_TIME_ZONE,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}`;
}

async function fetchJson(url, label) {
  let response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: { accept: "application/json" },
      credentials: "include",
      cache: "no-store"
    });
  } catch (error) {
    throw new Error(`${label} 연결 실패: ${error?.message || error}`);
  }
  const text = await response.text();
  if (response.status === 401 || response.status === 403 || /nidlogin\.login/i.test(response.url || "")) {
    throw new Error("Chrome에서 네이버 예약 파트너 로그인이 필요합니다.");
  }
  if (!response.ok) throw new Error(`${label} HTTP ${response.status}: ${text.slice(0, 160)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} 응답이 JSON이 아닙니다.`);
  }
}

async function discoverItemIds(startIso, endIso) {
  const url = new URL(`${NAVER_API_BASE}/businesses/${CONFIG.businessId}/booking-status`);
  url.searchParams.set("businessTypeId", String(BUSINESS_TYPE_ID));
  url.searchParams.set("startDate", startIso);
  url.searchParams.set("endDate", endIso);
  url.searchParams.set("includeTodaySchedule", "false");
  url.searchParams.set("includeTotal", "false");
  url.searchParams.set("interval", "30");
  url.searchParams.set("schedules", "business,bizItems");
  const body = await fetchJson(url.href, "상품 목록");
  const ids = Array.isArray(body?.bizItems)
    ? body.bizItems.map(item => Number(item?.bizItemId)).filter(Number.isFinite)
    : [];
  if (!ids.length) throw new Error("네이버 예약 상품을 찾지 못했습니다.");
  return [...new Set(ids)];
}

async function fetchBookings(itemId, startIso, endIso) {
  const url = new URL(`${NAVER_API_BASE}/businesses/${CONFIG.businessId}/bookings`);
  url.searchParams.set("bizItemIds", String(itemId));
  url.searchParams.set("dateFilter", "USEDATE");
  url.searchParams.set("startDateTime", startIso);
  url.searchParams.set("endDateTime", endIso);
  url.searchParams.set("excludeCheckoutDate", "true");
  url.searchParams.set("isShowBookingCount", "1");
  url.searchParams.set("page", "0");
  url.searchParams.set("size", "1000");
  const body = await fetchJson(url.href, `예약 목록(${itemId})`);
  return Array.isArray(body) ? body : (body?.content || body?.bookings || []);
}

function customAnswer(booking, pattern) {
  const forms = booking?.snapshotJson?.customFormInputJson;
  if (!Array.isArray(forms)) return "";
  const match = forms.find(form => pattern.test(String(form?.title || form?.originalTitle || "")));
  return String(match?.value || "").trim();
}

function mapBooking(booking) {
  const bookNo = String(booking?.bookingId || "").trim();
  const statusText = [booking?.bookingStatusName, booking?.bookingStatusCodeName, booking?.statusName, booking?.status]
    .map(value => String(value || "")).join(" ");
  const completed = booking?.isCompleted === true || /사용완료|이용완료|COMPLETED|USED|DONE/i.test(statusText);
  // Naver's cancelledCount can be populated even for an active booking.
  // Only the explicit status label/code is reliable for cancellation handling.
  const cancelled = !completed && /취소|환불|CANCEL|REFUND/i.test(statusText);
  // A newly placed booking can still be in a request/approval status instead
  // of RC03. Forward every non-cancelled active booking immediately so the
  // dashboard reacts at reservation time, not only after confirmation.
  if (!bookNo) return null;
  const people = [booking?.bookingCount, booking?.personCount, booking?.totalPersonCount,
    booking?.snapshotJson?.bookingCount, booking?.snapshotJson?.personCount]
    .map(value => Number(value || 0)).find(value => Number.isInteger(value) && value > 0 && value <= 30) || 0;
  return {
    bookNo,
    when: whenInKst(booking?.snapshotJson?.startDateTime || booking?.startDateTime || booking?.startDate),
    product: String(booking?.bizItemName || booking?.snapshotJson?.bizItemName || "").trim(),
    status: cancelled ? "취소" : (completed ? "사용완료" : "확정"),
    name: String(booking?.name || booking?.snapshotJson?.name || "").trim(),
    phone: String(booking?.phone || booking?.snapshotJson?.phone || "").trim(),
    teamName: customAnswer(booking, /팀\s*명/i),
    difficulty: customAnswer(booking, /난이도/),
    totalCount: people
  };
}

function fingerprint(item) {
  return JSON.stringify([item.status, item.when, item.product, item.name, item.phone, item.teamName, item.difficulty, item.totalCount]);
}

async function sendChangedBookings(items, force = false) {
  const stored = await chrome.storage.local.get(DELIVERY_STATE_KEY);
  const previous = stored[DELIVERY_STATE_KEY] || {};
  const changed = force ? items : items.filter(item => previous[item.bookNo] !== fingerprint(item));
  if (!changed.length) return { sent: 0 };
  const response = await fetch(CONFIG.endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-jumping-agent-token": CONFIG.agentToken
    },
    body: JSON.stringify({ items: changed })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.success === false) {
    throw new Error(body.message || `수원영통 서버 HTTP ${response.status}`);
  }
  changed.forEach(item => { previous[item.bookNo] = fingerprint(item); });
  await chrome.storage.local.set({ [DELIVERY_STATE_KEY]: previous });
  return {
    sent: changed.length,
    accepted: Number(body.accepted || 0),
    ignored: Number(body.ignored || 0),
    sameDayCancellations: Number(body.same_day_cancellations || 0)
  };
}

async function syncReservations(force = false) {
  requireConfig();
  const { startIso, endIso } = bookingRange();
  const itemIds = await discoverItemIds(startIso, endIso);
  const groups = await Promise.all(itemIds.map(id => fetchBookings(id, startIso, endIso)));
  const byId = new Map();
  groups.flat().map(mapBooking).filter(Boolean).forEach(item => byId.set(item.bookNo, item));
  console.info("[SuwonYT Naver] reservation summary", [...byId.values()].map(item => ({
    when: item.when,
    status: item.status,
    product: item.product
  })));
  const delivery = await sendChangedBookings([...byId.values()], force);
  console.info("[SuwonYT Naver] synchronized", {
    build: EXTENSION_BUILD,
    force,
    bookings: byId.size,
    ...delivery
  });
  return { bookings: byId.size, ...delivery };
}

async function syncAll(force = false) {
  requireConfig();
  // Start stock reconciliation immediately instead of waiting for every
  // booking-list request to finish. Each branch remains isolated so a stock
  // error can never interrupt reservation collection.
  const stockTask = syncLocalStockToNaver().catch(error => {
    console.warn("[SuwonYT Naver] stock sync skipped", error.message || error);
  });
  const reservationResult = await syncReservations(force);
  await stockTask;
  return reservationResult;
}

function roomCodeFromItem(item) {
  const label = [item?.bizItemName, item?.name, item?.productName, item?.title]
    .map(value => String(value || "")).join(" ").toUpperCase();
  const match = label.match(/\b(C1|C2|B1|B2)\b/);
  return match ? match[1] : "";
}

async function discoverRoomItemIds() {
  if (roomItemIdsCache && Date.now() - roomItemIdsCacheAt < 10 * 60 * 1000) return roomItemIdsCache;
  const { startIso, endIso } = bookingRange();
  const url = new URL(`${NAVER_API_BASE}/businesses/${CONFIG.businessId}/booking-status`);
  url.searchParams.set("businessTypeId", String(BUSINESS_TYPE_ID));
  url.searchParams.set("startDate", startIso);
  url.searchParams.set("endDate", endIso);
  url.searchParams.set("includeTodaySchedule", "false");
  url.searchParams.set("includeTotal", "false");
  url.searchParams.set("interval", "30");
  url.searchParams.set("schedules", "business,bizItems");
  const body = await fetchJson(url.href, "상품 목록");
  const configured = CONFIG.roomBizItemIds || {};
  const mapped = { ...configured };
  (Array.isArray(body?.bizItems) ? body.bizItems : []).forEach(item => {
    const room = roomCodeFromItem(item);
    const itemId = Number(item?.bizItemId);
    if (room && Number.isFinite(itemId) && !mapped[room]) mapped[room] = itemId;
  });
  roomItemIdsCache = mapped;
  roomItemIdsCacheAt = Date.now();
  return mapped;
}

async function getNaverCsrfToken() {
  const stored = await chrome.storage.local.get(NAVER_WRITE_AUTH_KEY);
  const captured = stored[NAVER_WRITE_AUTH_KEY];
  if (captured?.csrfToken && Date.now() - Number(captured.capturedAt || 0) < 8 * 60 * 60 * 1000) {
    return captured;
  }
  const url = "https://api-partner.booking.naver.com/v3.1/csrf-token";
  const response = await fetch(url, {
    method: "POST",
    headers: { accept: "application/json", "x-booking-naver-role": "OWNER" },
    credentials: "include",
    cache: "no-store"
  });
  const body = await response.json().catch(() => ({}));
  const token = body?.csrfToken || body?.token || "";
  if (!response.ok || !token) throw new Error("Naver write authorization is unavailable; open the booking calendar once after login.");
  return { csrfToken: token, role: "OWNER" };
}

async function patchNaverStock(roomItemId, slot, writeAuth, stock = 0) {
  const startedAt = performance.now();
  const url = `https://api-partner.booking.naver.com/v3.1/businesses/${CONFIG.businessId}/biz-items/${roomItemId}/schedules`;
  const [tab] = await chrome.tabs.query({ url: "https://partner.booking.naver.com/*" });
  if (!tab?.id) throw new Error("Open the Naver booking calendar in Chrome before stock sync.");
  const payload = { startTime: slot.time, startDate: slot.date, endDate: slot.date, status: "ON", stock };
  markExpectedStockWrite(payload);
  console.info("[SuwonYT Naver] stock patch request", { roomItemId, payload });
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: "MAIN",
    args: [url, payload, writeAuth.csrfToken, writeAuth.role || "OWNER"],
    func: async (requestUrl, requestBody, csrfToken, role) => {
      const response = await fetch(requestUrl, {
        method: "PATCH",
        headers: {
          accept: "application/json",
          "content-type": "application/json;charset=UTF-8",
          "x-booking-naver-role": role,
          "x-csrf-token": csrfToken
        },
        credentials: "include",
        body: JSON.stringify(requestBody)
      });
      return { ok: response.ok, status: response.status, text: (await response.text()).slice(0, 160) };
    }
  });
  const elapsedMs = Math.round(performance.now() - startedAt);
  if (!result?.ok) throw new Error(`Naver stock PATCH HTTP ${result?.status || "failed"}: ${result?.text || "no response"}`);
  console.info("[SuwonYT Naver] stock patch completed", { roomItemId, slot, stock, elapsedMs });
}

function stockWriteFingerprint(payload) {
  return [payload?.startDate, payload?.endDate || payload?.startDate, payload?.startTime, Number(payload?.stock)].join("|");
}

function markExpectedStockWrite(payload) {
  const key = stockWriteFingerprint(payload);
  globalThis[EXPECTED_STOCK_WRITE_KEY] ||= new Map();
  globalThis[EXPECTED_STOCK_WRITE_KEY].set(key, Date.now() + 15000);
}

function consumeExpectedStockWrite(payload) {
  const writes = globalThis[EXPECTED_STOCK_WRITE_KEY];
  if (!writes) return false;
  const now = Date.now();
  for (const [key, expiresAt] of writes.entries()) if (expiresAt <= now) writes.delete(key);
  const key = stockWriteFingerprint(payload);
  if (!writes.has(key)) return false;
  writes.delete(key);
  return true;
}

function requestPayload(details) {
  const raw = details.requestBody?.raw?.[0]?.bytes;
  if (!raw) return null;
  try {
    return JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return null;
  }
}

async function reportManualStockChange(details, payload) {
  if (!payload || consumeExpectedStockWrite(payload)) return;
  const itemMatch = String(details.url || "").match(/biz-items\/(\d+)\/schedules/);
  if (!itemMatch) return;
  const roomItemIds = await discoverRoomItemIds();
  const room = Object.entries(roomItemIds).find(([, itemId]) => Number(itemId) === Number(itemMatch[1]))?.[0];
  const date = String(payload.startDate || "");
  const time = String(payload.startTime || "");
  const stock = Number(payload.stock);
  if (!room || !/^20\d{2}-\d{2}-\d{2}$/.test(date) || !/^\d{1,2}:\d{2}$/.test(time) || !Number.isFinite(stock)) return;
  const endpoint = CONFIG.manualStockEndpoint || String(CONFIG.endpoint || "").replace("/reservations", "/manual-stock");
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", "x-jumping-agent-token": CONFIG.agentToken },
    body: JSON.stringify({ source: "staff-schedule-patch", items: [{ room, date, time, blocked: stock <= 0 }] })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.success === false) throw new Error(body.message || `manual stock HTTP ${response.status}`);
  console.info("[SuwonYT Naver] manual stock reflected", { room, date, time, blocked: stock <= 0, applied: body.applied });
}

function getSlotAvailability(item, date, time) {
  // Naver's response shape differs by product type. Find a stock record by
  // traversing the item's status tree, using its date/time path as the key.
  let matched = null;
  const wantedDate = String(date).replace(/[^0-9]/g, "");
  const wantedTime = String(time).replace(/[^0-9]/g, "");
  const visit = (value, path = "") => {
    if (!value || typeof value !== "object" || matched) return;
    if (Object.prototype.hasOwnProperty.call(value, "stock")) {
      // Depending on the Naver response, a schedule is identified either by
      // its JSON tree key or by fields on the schedule itself.  The previous
      // version only used the tree key, so a closed slot could fail to be
      // found after a dashboard card was deleted and therefore could not be
      // safely reopened.
      const directDate = String(value.startDate || value.useDate || value.bookingDate || value.date || "").replace(/[^0-9]/g, "");
      const directTime = String(value.startTime || value.useTime || value.bookingTime || value.time || "").replace(/[^0-9]/g, "");
      const directDateTime = String(value.startDateTime || value.useDateTime || value.dateTime || "").replace(/[^0-9]/g, "");
      const normalizedPath = path.replace(/[^0-9]/g, "");
      const matchedByFields = directDate === wantedDate && directTime === wantedTime;
      const matchedByDateTime = directDateTime.includes(wantedDate) && directDateTime.includes(wantedTime);
      const matchedByPath = normalizedPath.includes(wantedDate) && normalizedPath.includes(wantedTime);
      if (matchedByFields || matchedByDateTime || matchedByPath) matched = value;
    }
    Object.entries(value).forEach(([key, child]) => visit(child, `${path}|${key}`));
  };
  visit(item?.status || item?.schedules || item);
  return matched;
}

function hasNativeBooking(slotStatus) {
  if (!slotStatus || typeof slotStatus !== "object") return false;
  return ["requestedBookingCount", "confirmedBookingCount", "completedBookingCount", "noShowBookingCount"]
    .some(key => Number(slotStatus[key] || 0) > 0);
}

async function fetchAvailabilityByItem() {
  const { startIso, endIso } = bookingRange();
  const url = new URL(`${NAVER_API_BASE}/businesses/${CONFIG.businessId}/booking-status`);
  url.searchParams.set("businessTypeId", String(BUSINESS_TYPE_ID));
  url.searchParams.set("startDate", startIso);
  url.searchParams.set("endDate", endIso);
  url.searchParams.set("includeTodaySchedule", "false");
  url.searchParams.set("includeTotal", "false");
  url.searchParams.set("interval", "30");
  url.searchParams.set("schedules", "business,bizItems");
  const body = await fetchJson(url.href, "Naver availability");
  return new Map((Array.isArray(body?.bizItems) ? body.bizItems : [])
    .map(item => [Number(item?.bizItemId), item])
    .filter(([itemId]) => Number.isFinite(itemId)));
}

function stockCheckDates() {
  const today = kstDateKey();
  const first = new Date(`${today}T00:00:00+09:00`);
  return Array.from({ length: 15 }, (_, offset) => kstDateKey(new Date(first.getTime() + offset * 24 * 60 * 60 * 1000)));
}

function stockCheckTimes() {
  const times = [];
  for (let minutes = 10 * 60; minutes <= 23 * 60; minutes += 20) {
    times.push(`${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`);
  }
  return times;
}

async function mirrorManualNaverBlocks(availabilityByItem, roomItemIds, desired, closed) {
  // Naver's calendar sometimes hides a staff edit's PATCH body from Chrome.
  // Its availability response is still authoritative: stock 0 without a
  // native booking means the staff manually closed that slot.
  const items = [];
  const dates = stockCheckDates();
  const times = stockCheckTimes();
  for (const [room, rawItemId] of Object.entries(roomItemIds)) {
    const item = availabilityByItem.get(Number(rawItemId));
    if (!item) continue;
    for (const date of dates) {
      for (const time of times) {
        const key = `${room}|${date}|${time}`;
        if (desired.has(key) || closed[key]) continue;
        const slotStatus = getSlotAvailability(item, date, time);
        if (slotStatus && Number(slotStatus.stock) <= 0 && !hasNativeBooking(slotStatus)) {
          items.push({ room, date, time, blocked: true });
        }
      }
    }
  }
  // The local endpoint is intentionally add-only here. It never deletes a
  // card during a background availability read.
  for (let index = 0; index < items.length; index += 30) {
    const batch = items.slice(index, index + 30);
    const endpoint = CONFIG.manualStockEndpoint || String(CONFIG.endpoint || "").replace("/reservations", "/manual-stock");
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", "x-jumping-agent-token": CONFIG.agentToken },
      body: JSON.stringify({ items: batch })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.success === false) throw new Error(body.message || `manual stock mirror HTTP ${response.status}`);
    if (Number(body.applied || 0) > 0) {
      console.info("[SuwonYT Naver] manual stock mirrored", { applied: body.applied, blocked: batch.length });
    }
  }
}

async function syncLocalStockToNaver() {
  if (stockSyncInFlight) {
    console.info("[SuwonYT Naver] stock reconciliation already running");
    return stockSyncInFlight;
  }
  stockSyncInFlight = syncLocalStockToNaverInternal();
  try {
    return await stockSyncInFlight;
  } finally {
    stockSyncInFlight = null;
  }
}

async function syncLocalStockToNaverInternal() {
  const startedAt = performance.now();
  const dryRun = CONFIG.stockSyncEnabled === "dry-run";
  if (CONFIG.stockSyncEnabled !== true && !dryRun) return;
  const planEndpoint = CONFIG.stockPlanEndpoint || String(CONFIG.endpoint || "").replace("/reservations", "/stock-plan");
  const response = await fetch(planEndpoint, {
    headers: { "x-jumping-agent-token": CONFIG.agentToken }, cache: "no-store"
  });
  const plan = await response.json().catch(() => ({}));
  if (!response.ok || plan.success === false || !Array.isArray(plan.slots)) throw new Error("Local stock plan unavailable");
  const planMs = Math.round(performance.now() - startedAt);
  const roomItemIds = await discoverRoomItemIds();
  const roomDiscoveryMs = Math.round(performance.now() - startedAt);
  const stored = await chrome.storage.local.get(STOCK_STATE_KEY);
  const closed = stored[STOCK_STATE_KEY] || {};
  const desired = new Map();
  plan.slots.forEach(slot => {
    desired.set(`${slot.room}|${slot.date}|${slot.time}`, { ...slot, stock: Number(slot.stock || 0) });
  });
  (Array.isArray(plan.adjustments) ? plan.adjustments : []).forEach(slot => {
    desired.set(`${slot.room}|${slot.date}|${slot.time}`, { ...slot, stock: Number(slot.stock || 0) });
  });
  const today = kstDateKey();
  // A past schedule can no longer be reserved. Clear only our local tracking
  // record; never send a write request for a date that has already passed.
  Object.keys(closed).forEach(key => {
    const [, date] = key.split("|");
    if (date && date < today) {
      delete closed[key];
      console.info("[SuwonYT Naver] expired stock record cleared", { date });
    }
  });
  let availabilityByItem = new Map();
  try {
    availabilityByItem = await fetchAvailabilityByItem();
  } catch (error) {
    // Closing still works without this optional read. Reopening requires it,
    // so an unverified slot is deliberately left unchanged.
    console.warn("[SuwonYT Naver] availability check skipped", error.message || error);
  }
  const availabilityMs = Math.round(performance.now() - startedAt);
  let writeAuth = null;

  // A moved/deleted dashboard card no longer appears in the desired plan.
  // Reopen only slots this extension closed and only when the original stock
  // is known and Naver has no native booking in that time slot.
  for (const [key, managed] of Object.entries(closed)) {
    if (desired.has(key)) continue;
    const [room, date, time] = key.split("|");
    const roomItemId = Number(managed?.roomItemId);
    const originalStock = Number(managed?.originalStock);
    const item = availabilityByItem.get(roomItemId);
    const slotStatus = getSlotAvailability(item, date, time);
    if (!Number.isFinite(roomItemId)) {
      console.warn("[SuwonYT Naver] stock release skipped: room mapping is unknown", { room, date, time });
      continue;
    }
    if (managed?.kind === "time_change_source") {
      // The override ended (returned to the original time or cancelled).
      // Restore the product's normal one-seat setting; Naver's own booking
      // count then determines whether it is immediately available.
      if (dryRun) {
        console.info("[SuwonYT Naver] time-change source restore dry-run", { room, date, time, roomItemId });
        delete closed[key];
        continue;
      }
      if (!writeAuth) writeAuth = await getNaverCsrfToken();
      await patchNaverStock(roomItemId, { date, time }, writeAuth, 1);
      console.info("[SuwonYT Naver] time-change source restored", { room, date, time, roomItemId });
      delete closed[key];
      continue;
    }
    if (!slotStatus) {
      console.warn("[SuwonYT Naver] stock release skipped: availability cannot be verified", { room, date, time });
      continue;
    }
    if (hasNativeBooking(slotStatus)) {
      // A Naver booking now owns the slot. Leave it closed, but stop claiming
      // ownership so it can never be reopened by this extension later.
      delete closed[key];
      continue;
    }
    if (Number(slotStatus.stock) > 0) {
      delete closed[key];
      continue;
    }
    // Records created before version 1.1.1 did not preserve the original
    // stock. These slots were still closed by this extension. Naver products
    // here use one seat per room, so restore one only after verifying there
    // is no Naver booking at that exact slot.
    const releaseStock = Number.isFinite(originalStock) && originalStock > 0 ? originalStock : 1;
    if (dryRun) {
      console.info("[SuwonYT Naver] stock release dry-run", { room, date, time, roomItemId, releaseStock });
      delete closed[key];
      continue;
    }
    if (!writeAuth) writeAuth = await getNaverCsrfToken();
    await patchNaverStock(roomItemId, { date, time }, writeAuth, releaseStock);
    console.info("[SuwonYT Naver] stock released", { room, date, time, roomItemId, releaseStock });
    delete closed[key];
  }

  for (const [key, slot] of desired.entries()) {
    const roomItemId = Number(roomItemIds[slot.room]);
    const desiredStock = Math.max(0, Number(slot.stock || 0));
    if (!Number.isFinite(roomItemId)) continue;
    const slotStatus = getSlotAvailability(availabilityByItem.get(roomItemId), slot.date, slot.time);
    if (slot.kind === "time_change_source") {
      // The original Naver booking remains at this time. This is an explicit
      // capacity compensation, so native bookings are expected and do not
      // prevent the requested stock adjustment.
      if (slotStatus && Number(slotStatus.stock) === desiredStock) continue;
      if (dryRun) {
        console.info("[SuwonYT Naver] time-change stock dry-run", { slot, roomItemId, desiredStock });
        continue;
      }
      if (!writeAuth) writeAuth = await getNaverCsrfToken();
      await patchNaverStock(roomItemId, slot, writeAuth, desiredStock);
      console.info("[SuwonYT Naver] time-change source adjusted", { slot, roomItemId, desiredStock });
      closed[key] = { roomItemId, originalStock: 1, kind: "time_change_source", closedAt: new Date().toISOString() };
      continue;
    }
    if (closed[key]) continue;
    // A slot already closed by Naver or occupied by a Naver reservation is
    // not ours to manage. Do not overwrite or later reopen it.
    if (slotStatus && (Number(slotStatus.stock) <= 0 || hasNativeBooking(slotStatus))) continue;
    if (dryRun) {
      console.info("[SuwonYT Naver] stock dry-run", { slot, roomItemId });
      continue;
    }
    if (!writeAuth) writeAuth = await getNaverCsrfToken();
    await patchNaverStock(roomItemId, slot, writeAuth, desiredStock);
      closed[key] = {
      roomItemId,
      originalStock: Number.isFinite(Number(slotStatus?.stock)) ? Number(slotStatus.stock) : null,
      kind: slot.kind || "local_card",
      closedAt: new Date().toISOString()
      };
  }
  await chrome.storage.local.set({ [STOCK_STATE_KEY]: closed });
  console.info("[SuwonYT Naver] stock reconciliation completed", {
    totalMs: Math.round(performance.now() - startedAt),
    planMs,
    roomDiscoveryMs,
    availabilityMs,
    desiredSlots: desired.size
  });
}

async function startStockEventWatcher() {
  if (stockEventWatcherRunning || CONFIG.stockSyncEnabled !== true) return;
  stockEventWatcherRunning = true;
  const eventEndpoint = CONFIG.stockEventEndpoint || String(CONFIG.endpoint || "").replace("/reservations", "/stock-events");
  let revision = 0;
  try {
    while (true) {
      const url = new URL(eventEndpoint);
      url.searchParams.set("after", String(revision));
      const response = await fetch(url.href, {
        headers: { "x-jumping-agent-token": CONFIG.agentToken }, cache: "no-store"
      });
      const event = await response.json().catch(() => ({}));
      if (!response.ok || event.success === false) throw new Error("Local stock event stream unavailable");
      revision = Number(event.revision || revision);
      if (event.changed) {
        console.info("[SuwonYT Naver] stock event received", {
          revision,
          signalDelayMs: event.emittedAt ? Math.max(0, Date.now() - Number(event.emittedAt)) : null
        });
        try {
          await syncLocalStockToNaver();
        } catch (error) {
          // A temporary Naver/tab failure must not stop the live event
          // listener. The next dashboard event and the safety alarm retry it.
          console.warn("[SuwonYT Naver] stock event sync failed; listener remains active", error.message || error);
        }
      }
    }
  } catch (error) {
    console.warn("[SuwonYT Naver] stock event listener stopped", error.message || error);
  } finally {
    stockEventWatcherRunning = false;
  }
}

async function startEmailHintWatcher() {
  if (emailHintWatcherRunning) return;
  emailHintWatcherRunning = true;
  const eventEndpoint = CONFIG.emailHintEventEndpoint || String(CONFIG.endpoint || "").replace("/reservations", "/email-events");
  let revision = 0;
  try {
    while (true) {
      const url = new URL(eventEndpoint);
      url.searchParams.set("after", String(revision));
      const response = await fetch(url.href, {
        headers: { "x-jumping-agent-token": CONFIG.agentToken }, cache: "no-store"
      });
      const event = await response.json().catch(() => ({}));
      if (!response.ok || event.success === false) throw new Error("Local email event stream unavailable");
      revision = Number(event.revision || revision);
      if (event.changed) {
        // Mail reached us first.  Fetch Naver's authoritative detail now;
        // server-side booking-ID upsert prevents duplicate dashboard cards.
        console.info("[SuwonYT Naver] mail hint received; requesting Naver details");
        // Naver can deliver the email a few seconds before its booking list
        // reflects the new record. Retry only for this mail-triggered event;
        // the regular collection cadence stays at one minute.
        for (const delayMs of [0, 5000, 12000, 20000]) {
          if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
          try {
            await syncReservations();
          } catch (error) {
            console.warn("[SuwonYT Naver] mail-triggered detail retry failed", error.message || error);
          }
        }
      }
    }
  } catch (error) {
    console.warn("[SuwonYT Naver] mail hint listener stopped", error.message || error);
  } finally {
    emailHintWatcherRunning = false;
  }
}

// Capture only the short-lived CSRF header that Chrome already sends for a
// staff-initiated schedule edit.  It is kept in extension storage briefly,
// never sent to the local server, logged, or committed to Git.
chrome.webRequest.onBeforeSendHeaders.addListener(details => {
  if (details.method !== "PATCH" || !/\/schedules(?:\?|$)/.test(details.url)) return;
  const headers = Object.fromEntries((details.requestHeaders || []).map(header => [String(header.name || "").toLowerCase(), header.value || ""]));
  const csrfToken = headers["x-csrf-token"];
  if (!csrfToken) return;
  chrome.storage.local.set({
    [NAVER_WRITE_AUTH_KEY]: {
      csrfToken,
      role: headers["x-booking-naver-role"] || "OWNER",
      capturedAt: Date.now()
    }
  }).then(() => console.info("[SuwonYT Naver] write authorization captured"));
}, { urls: ["https://api-partner.booking.naver.com/*"] }, ["requestHeaders"]);

// The Naver page hook forwards the exact PATCH JSON before it is sent.  This
// is more reliable than webRequest.requestBody, which Chrome can omit for
// cross-origin page requests.
chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type === "naver-schedule-bridge-ready") {
    console.info("[SuwonYT Naver] schedule bridge ready", { frameId: sender.frameId, url: sender.url });
    return;
  }
  if (message?.type === "naver-schedule-hook-ready") {
    console.info("[SuwonYT Naver] schedule page hook ready", { frameId: sender.frameId, url: sender.url });
    return;
  }
  if (message?.type !== "naver-staff-schedule-patch") return;
  const url = String(message.url || "");
  const payload = message.payload;
  if (!/https:\/\/api-partner\.booking\.naver\.com\/v3\.1\/businesses\//.test(url)) return;
  console.info("[SuwonYT Naver] staff schedule patch captured", { url, payload });
  reportManualStockChange({ url }, payload).catch(error => {
    console.warn("[SuwonYT Naver] manual stock reflection skipped", error.message || error);
  });
});

async function ensureAlarm() {
  const reservationPeriod = Math.max(Number(CONFIG.pollMinutes) || 1, 1);
  // Chrome 120+ supports a stable minimum alarm interval of 30 seconds.
  // Stock is small and time-sensitive, so it runs independently of collection.
  const stockPeriod = Math.max(Number(CONFIG.stockPollMinutes) || 0.5, 0.5);
  // Chrome creates the alarm synchronously; awaiting it can throw an
  // implementation-specific "Failed to fetch" during extension reload.
  chrome.alarms.create(RESERVATION_ALARM_NAME, { periodInMinutes: reservationPeriod });
  chrome.alarms.create(STOCK_ALARM_NAME, { periodInMinutes: stockPeriod });
}

chrome.runtime.onInstalled.addListener(() => ensureAlarm().then(() => { startStockEventWatcher(); startEmailHintWatcher(); return syncAll(); }).catch(error => console.error("[SuwonYT Naver]", error)));
chrome.runtime.onStartup.addListener(() => ensureAlarm().then(() => { startStockEventWatcher(); startEmailHintWatcher(); }).catch(error => console.error("[SuwonYT Naver]", error)));
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === RESERVATION_ALARM_NAME) syncReservations().catch(error => console.error("[SuwonYT Naver]", error));
  if (alarm.name === STOCK_ALARM_NAME) {
    syncLocalStockToNaver().catch(error => console.warn("[SuwonYT Naver] stock sync skipped", error.message || error));
  }
});
chrome.action.onClicked.addListener(() => {
  console.info("[SuwonYT Naver] manual sync requested", { build: EXTENSION_BUILD });
  startStockEventWatcher();
  startEmailHintWatcher();
  syncAll(true).catch(error => console.error("[SuwonYT Naver]", error));
});
