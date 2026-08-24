/**
 * settle_core.js
 * 정산 및 대시보드 공통 계산 로직
 */

const ROOM_ORDER = ['C1', 'C2', 'B1', 'B2']; 

function isValidYmd(ymd) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(ymd || ''));
}

function todayYmd() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

function toNumber(v) {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : 0;
}

function formatMoney(v) {
    return toNumber(v).toLocaleString();
}

function formatSupplyItemDisplay(item, etcText) {
    const baseItem = String(item || '').trim();
    const extra = String(etcText || '').trim();
    const normalized = baseItem.replace(/\s+/g, '');
    if (normalized === '기타' && extra) {
        return `${baseItem}(${extra})`;
    }
    return baseItem;
}

function parseSupplyItemInput(rawItem) {
    const itemText = String(rawItem || '').trim();
    const match = itemText.match(/^기타\s*\((.*)\)$/);
    if (match) {
        return {
            item: '기타',
            etcText: String(match[1] || '').trim(),
        };
    }
    return {
        item: itemText,
        etcText: '',
    };
}

function getPassCounts(paymentData) {
    const pd = paymentData || {};
    return {
        adult: toNumber(pd.adultPass),
        child: toNumber(pd.childPass),
    };
}

function getCouponCount(paymentData) {
    const pd = paymentData || {};
    return toNumber(pd.couponAdult) + toNumber(pd.couponChild);
}

function formatPassSummary(paymentData) {
    const pass = getPassCounts(paymentData);
    if (!pass.adult && !pass.child) return '';
    return `${pass.adult}/${pass.child}`;
}

function addDays(ymd, delta) {
    const d = new Date(`${ymd}T00:00:00`);
    d.setDate(d.getDate() + delta);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

function timeKeyToHHMM(timeKey) {
    const parts = String(timeKey || '').split('-');
    if (parts.length !== 2) return '';
    const h = String(parseInt(parts[0], 10) || 0).padStart(2, '0');
    const m = String(parseInt(parts[1], 10) || 0).padStart(2, '0');
    return `${h}:${m}`;
}

function hhmmToTimeKey(hhmm) {
    const parts = String(hhmm || '').split(':');
    if (parts.length !== 2) return '00-00';
    const h = String(parseInt(parts[0], 10) || 0).padStart(2, '0');
    const m = String(parseInt(parts[1], 10) || 0).padStart(2, '0');
    return `${h}-${m}`;
}

function getRoomRank(room) {
    const idx = ROOM_ORDER.indexOf(String(room || '').trim().toUpperCase());
    return idx >= 0 ? idx : ROOM_ORDER.length;
}

function getTimeRank(timeKey) {
    const parts = String(timeKey || '').split('-');
    if (parts.length !== 2) return 9999;
    const h = parseInt(parts[0], 10) || 0;
    const m = parseInt(parts[1], 10) || 0;
    return (h * 60) + m;
}

window.isValidYmd = isValidYmd;
window.toNumber = toNumber;
window.todayYmd = todayYmd;
