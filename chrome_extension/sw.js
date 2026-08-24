/* Naver Booking collector for the Suwon Yeongtong local operation server. */
importScripts("local-config.js");

const CONFIG = globalThis.NAVER_RESERVATION_CONFIG || {};
const NAVER_API_BASE = "https://partner.booking.naver.com/api";
const BUSINESS_TYPE_ID = 12;
const CONFIRMED_STATUS_CODE = "RC03";
const ALARM_NAME = "suwonyeongtong-naver-poll";
const DELIVERY_STATE_KEY = "delivery-state";
const KST_TIME_ZONE = "Asia/Seoul";
const EXTENSION_BUILD = "suwonyt-force-sync-20260824-01";

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
  const response = await fetch(url, {
    method: "GET",
    headers: { accept: "application/json" },
    credentials: "include",
    cache: "no-store"
  });
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

async function ensureAlarm() {
  const periodInMinutes = Math.max(Number(CONFIG.pollMinutes) || 1, 1);
  await chrome.alarms.create(ALARM_NAME, { periodInMinutes });
}

chrome.runtime.onInstalled.addListener(() => ensureAlarm().then(syncReservations).catch(error => console.error("[SuwonYT Naver]", error)));
chrome.runtime.onStartup.addListener(() => ensureAlarm().catch(error => console.error("[SuwonYT Naver]", error)));
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === ALARM_NAME) syncReservations().catch(error => console.error("[SuwonYT Naver]", error));
});
chrome.action.onClicked.addListener(() => {
  console.info("[SuwonYT Naver] manual sync requested", { build: EXTENSION_BUILD });
  syncReservations(true).catch(error => console.error("[SuwonYT Naver]", error));
});
