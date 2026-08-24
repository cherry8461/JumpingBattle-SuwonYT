import {
  GAME_DURATION_MINUTES,
  OPERATING_SLOTS,
  type ReservationRecord,
} from "@/app/reservation-config";
import { resolveImportedOperationalState } from "@/app/api/import/reservations/source-state";
import { getD1 } from "./control";
import { getPricingSettings } from "./pricing-settings";

type ReservationRow = {
  id: string;
  booking_code: string;
  source: string;
  source_booking_no: string | null;
  customer_name: string;
  customer_phone: string;
  scheduled_date: string;
  scheduled_time: string;
  room_code: string;
  schedule_overridden: number;
  details_overridden: number;
  team_name: string;
  difficulty_code: string;
  difficulty_label: string;
  map_index: number;
  adult_count: number;
  youth_count: number;
  total_count: number;
  vehicle_last4: string;
  game_minutes: number;
  base_amount: number;
  add_on_amount: number;
  discount_amount: number;
  payment_amount: number;
  payment_card_amount: number;
  payment_cash_amount: number;
  payment_account_amount: number;
  payment_method: string;
  payment_status: string;
  status: string;
  cancelled_at: string | null;
  memo: string;
  manager_loaded_at: string | null;
  created_at: string;
  updated_at: string;
};

const RESERVATION_SELECT = `
  SELECT id, booking_code, source, source_booking_no, customer_name, customer_phone,
    scheduled_date, scheduled_time, room_code, schedule_overridden, details_overridden, team_name, difficulty_code,
    difficulty_label, map_index, adult_count, youth_count, total_count,
    vehicle_last4, game_minutes, base_amount, add_on_amount, discount_amount,
    payment_amount, payment_card_amount, payment_cash_amount,
    payment_account_amount, payment_method, payment_status, status, cancelled_at, memo,
    manager_loaded_at, created_at, updated_at
  FROM reservations
`;

function toReservation(row: ReservationRow): ReservationRecord {
  return {
    id: row.id,
    bookingCode: row.booking_code,
    source: row.source,
    sourceBookingNo: row.source_booking_no ?? "",
    customerName: row.customer_name,
    customerPhone: row.customer_phone,
    scheduledDate: row.scheduled_date,
    scheduledTime: row.scheduled_time,
    roomCode: row.room_code,
    teamName: row.team_name,
    difficultyCode: row.difficulty_code,
    difficultyLabel: row.difficulty_label,
    mapIndex: row.map_index,
    adultCount: row.adult_count,
    youthCount: row.youth_count,
    totalCount: row.total_count,
    vehicleLast4: row.vehicle_last4,
    gameMinutes: row.game_minutes,
    baseAmount: row.base_amount,
    addOnAmount: row.add_on_amount,
    discountAmount: row.discount_amount,
    paymentAmount: row.payment_amount,
    paymentCardAmount: row.payment_card_amount,
    paymentCashAmount: row.payment_cash_amount,
    paymentAccountAmount: row.payment_account_amount,
    paymentMethod: row.payment_method,
    paymentStatus: row.payment_status,
    status: row.status,
    cancelledAt: row.cancelled_at ?? "",
    memo: row.memo,
    managerLoadedAt: row.manager_loaded_at ?? "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function ensureReservationSchema() {
  const db = getD1();
  await db.batch([
    db.prepare(`
      CREATE TABLE IF NOT EXISTS reservations (
        id TEXT PRIMARY KEY,
        booking_code TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'web_walkin',
        source_booking_no TEXT,
        source_product TEXT NOT NULL DEFAULT '',
        source_status TEXT NOT NULL DEFAULT '',
        source_link TEXT NOT NULL DEFAULT '',
        customer_name TEXT NOT NULL DEFAULT '',
        customer_phone TEXT NOT NULL DEFAULT '',
        scheduled_date TEXT NOT NULL DEFAULT '',
        scheduled_time TEXT NOT NULL DEFAULT '',
        room_code TEXT NOT NULL DEFAULT '',
        active_slot_key TEXT,
        schedule_overridden INTEGER NOT NULL DEFAULT 0,
        details_overridden INTEGER NOT NULL DEFAULT 0,
        team_name TEXT NOT NULL DEFAULT '',
        difficulty_code TEXT NOT NULL DEFAULT '',
        difficulty_label TEXT NOT NULL DEFAULT '',
        map_index INTEGER NOT NULL DEFAULT 0,
        adult_count INTEGER NOT NULL DEFAULT 0,
        youth_count INTEGER NOT NULL DEFAULT 0,
        total_count INTEGER NOT NULL DEFAULT 0,
        vehicle_last4 TEXT NOT NULL DEFAULT '',
        consent_text TEXT NOT NULL DEFAULT '',
        game_minutes INTEGER NOT NULL DEFAULT 16,
        base_amount INTEGER NOT NULL DEFAULT 0,
        add_on_amount INTEGER NOT NULL DEFAULT 0,
        discount_amount INTEGER NOT NULL DEFAULT 0,
        payment_amount INTEGER NOT NULL DEFAULT 0,
        payment_card_amount INTEGER NOT NULL DEFAULT 0,
        payment_cash_amount INTEGER NOT NULL DEFAULT 0,
        payment_account_amount INTEGER NOT NULL DEFAULT 0,
        payment_method TEXT NOT NULL DEFAULT '',
        payment_status TEXT NOT NULL DEFAULT 'unpaid',
        status TEXT NOT NULL DEFAULT 'booked',
        cancelled_at TEXT,
        memo TEXT NOT NULL DEFAULT '',
        idempotency_key TEXT,
        manager_loaded_at TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `),
    db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS reservations_booking_code_uidx ON reservations(booking_code)`),
    db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS reservations_source_booking_no_uidx ON reservations(source_booking_no)`),
    db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS reservations_active_slot_key_uidx ON reservations(active_slot_key)`),
    db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS reservations_idempotency_key_uidx ON reservations(idempotency_key)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS reservations_schedule_idx ON reservations(scheduled_date, scheduled_time)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS reservations_status_idx ON reservations(status, updated_at)`),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS reservation_events (
        id TEXT PRIMARY KEY,
        reservation_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        details_json TEXT NOT NULL DEFAULT '{}',
        created_by TEXT NOT NULL DEFAULT 'system',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `),
    db.prepare(`CREATE INDEX IF NOT EXISTS reservation_events_reservation_idx ON reservation_events(reservation_id, created_at)`),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS reservation_rate_limits (
        client_key TEXT PRIMARY KEY,
        request_count INTEGER NOT NULL DEFAULT 0,
        window_started INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL DEFAULT 0
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS daily_shared_sales (
        sales_date TEXT PRIMARY KEY,
        slush_card INTEGER NOT NULL DEFAULT 0,
        slush_cash INTEGER NOT NULL DEFAULT 0,
        slush_account INTEGER NOT NULL DEFAULT 0,
        beverage_card INTEGER NOT NULL DEFAULT 0,
        beverage_cash INTEGER NOT NULL DEFAULT 0,
        beverage_account INTEGER NOT NULL DEFAULT 0,
        slush_card_count INTEGER NOT NULL DEFAULT 0,
        slush_cash_count INTEGER NOT NULL DEFAULT 0,
        slush_account_count INTEGER NOT NULL DEFAULT 0,
        beverage_card_count INTEGER NOT NULL DEFAULT 0,
        beverage_cash_count INTEGER NOT NULL DEFAULT 0,
        beverage_account_count INTEGER NOT NULL DEFAULT 0,
        other_card_count INTEGER NOT NULL DEFAULT 0,
        other_cash_count INTEGER NOT NULL DEFAULT 0,
        other_account_count INTEGER NOT NULL DEFAULT 0,
        youth_pass_10_card_count INTEGER NOT NULL DEFAULT 0,
        youth_pass_10_cash_count INTEGER NOT NULL DEFAULT 0,
        youth_pass_10_account_count INTEGER NOT NULL DEFAULT 0,
        youth_pass_20_card_count INTEGER NOT NULL DEFAULT 0,
        youth_pass_20_cash_count INTEGER NOT NULL DEFAULT 0,
        youth_pass_20_account_count INTEGER NOT NULL DEFAULT 0,
        adult_pass_10_card_count INTEGER NOT NULL DEFAULT 0,
        adult_pass_10_cash_count INTEGER NOT NULL DEFAULT 0,
        adult_pass_10_account_count INTEGER NOT NULL DEFAULT 0,
        adult_pass_20_card_count INTEGER NOT NULL DEFAULT 0,
        adult_pass_20_cash_count INTEGER NOT NULL DEFAULT 0,
        adult_pass_20_account_count INTEGER NOT NULL DEFAULT 0,
        updated_by TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `),
  ]);
}

export type NewWebReservation = {
  scheduledDate: string;
  scheduledTime: string;
  roomCode: string;
  teamName: string;
  difficultyCode: string;
  difficultyLabel: string;
  mapIndex: number;
  adultCount: number;
  youthCount: number;
  totalCount: number;
  vehicleLast4: string;
  consentText: string;
  baseAmount: number;
  idempotencyKey: string;
};

export type NewAdminReservation = {
  scheduledDate: string;
  scheduledTime: string;
  roomCode: string;
  teamName: string;
  difficultyCode: string;
  difficultyLabel: string;
  mapIndex: number;
  adultCount: number;
  youthCount: number;
  totalCount: number;
  vehicleLast4: string;
  baseAmount: number;
  memo: string;
};

function bookingCode(date: string) {
  const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase();
  return `JB-${date.replace(/-/g, "").slice(2)}-${suffix}`;
}

async function adminActiveSlotKey(
  reservationId: string,
  scheduledDate: string,
  scheduledTime: string,
  roomCode: string,
) {
  if (!scheduledDate || !scheduledTime || !roomCode) return null;
  const existing = await getD1()
    .prepare(`
      SELECT id FROM reservations
      WHERE scheduled_date = ? AND scheduled_time = ? AND room_code = ?
        AND status NOT IN ('cancelled', 'completed') AND id <> ?
      LIMIT 1
    `)
    .bind(scheduledDate, scheduledTime, roomCode, reservationId)
    .first<{ id: string }>();
  const canonical = `${scheduledDate}|${scheduledTime}|${roomCode}`;
  return existing ? `${canonical}|admin|${reservationId}` : canonical;
}

function updatedScheduleOverride(
  current: ReservationRow,
  scheduledDate: string,
  scheduledTime: string,
  roomCode: string,
) {
  if (current.source !== "naver") return current.schedule_overridden;
  return current.schedule_overridden === 1 ||
    current.scheduled_date !== scheduledDate ||
    current.scheduled_time !== scheduledTime ||
    current.room_code !== roomCode
    ? 1
    : 0;
}

function updatedDetailsOverride(
  current: ReservationRow,
  command: Extract<ReservationAdminAction, { action: "details" }>,
) {
  if (current.source !== "naver") return current.details_overridden;
  return current.details_overridden === 1 ||
    current.team_name !== command.teamName ||
    current.difficulty_code !== command.difficultyCode ||
    current.difficulty_label !== command.difficultyLabel ||
    current.map_index !== command.mapIndex ||
    current.adult_count !== command.adultCount ||
    current.youth_count !== command.youthCount ||
    current.total_count !== command.totalCount ||
    current.vehicle_last4 !== command.vehicleLast4 ||
    current.base_amount !== command.baseAmount
    ? 1
    : 0;
}

export async function createWebReservation(input: NewWebReservation) {
  await ensureReservationSchema();
  const db = getD1();

  const existing = await db
    .prepare(`${RESERVATION_SELECT} WHERE idempotency_key = ? LIMIT 1`)
    .bind(input.idempotencyKey)
    .first<ReservationRow>();
  if (existing) return { reservation: toReservation(existing), created: false };

  const id = crypto.randomUUID();
  const code = bookingCode(input.scheduledDate);
  const activeSlotKey = `${input.scheduledDate}|${input.scheduledTime}|${input.roomCode}`;
  const eventId = crypto.randomUUID();

  await db.batch([
    db
      .prepare(`
        INSERT INTO reservations (
          id, booking_code, source, scheduled_date, scheduled_time, room_code,
          active_slot_key, team_name, difficulty_code, difficulty_label, map_index,
          adult_count, youth_count, total_count, vehicle_last4, consent_text,
          game_minutes, base_amount, idempotency_key
        ) VALUES (?, ?, 'web_walkin', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .bind(
        id,
        code,
        input.scheduledDate,
        input.scheduledTime,
        input.roomCode,
        activeSlotKey,
        input.teamName,
        input.difficultyCode,
        input.difficultyLabel,
        input.mapIndex,
        input.adultCount,
        input.youthCount,
        input.totalCount,
        input.vehicleLast4,
        input.consentText,
        GAME_DURATION_MINUTES,
        input.baseAmount,
        input.idempotencyKey,
      ),
    db
      .prepare(`
        INSERT INTO reservation_events
          (id, reservation_id, event_type, details_json, created_by)
        VALUES (?, ?, 'created', ?, 'customer-web')
      `)
      .bind(eventId, id, JSON.stringify({ source: "web_walkin" })),
  ]);

  const row = await db
    .prepare(`${RESERVATION_SELECT} WHERE id = ? LIMIT 1`)
    .bind(id)
    .first<ReservationRow>();
  if (!row) throw new Error("예약을 저장한 뒤 다시 불러오지 못했습니다.");
  return { reservation: toReservation(row), created: true };
}

export async function createAdminReservation(
  input: NewAdminReservation,
  operator: string,
) {
  await ensureReservationSchema();
  const db = getD1();
  const id = crypto.randomUUID();
  const code = bookingCode(input.scheduledDate);
  const activeSlotKey = await adminActiveSlotKey(
    id,
    input.scheduledDate,
    input.scheduledTime,
    input.roomCode,
  );

  await db.batch([
    db
      .prepare(`
        INSERT INTO reservations (
          id, booking_code, source, scheduled_date, scheduled_time, room_code,
          active_slot_key, team_name, difficulty_code, difficulty_label, map_index,
          adult_count, youth_count, total_count, vehicle_last4, consent_text,
          game_minutes, base_amount, memo
        ) VALUES (?, ?, 'admin_manual', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .bind(
        id,
        code,
        input.scheduledDate,
        input.scheduledTime,
        input.roomCode,
        activeSlotKey,
        input.teamName,
        input.difficultyCode,
        input.difficultyLabel,
        input.mapIndex,
        input.adultCount,
        input.youthCount,
        input.totalCount,
        input.vehicleLast4,
        "직원 직접 입력",
        GAME_DURATION_MINUTES,
        input.baseAmount,
        input.memo,
      ),
    db
      .prepare(`
        INSERT INTO reservation_events
          (id, reservation_id, event_type, details_json, created_by)
        VALUES (?, ?, 'admin_created', ?, ?)
      `)
      .bind(
        crypto.randomUUID(),
        id,
        JSON.stringify({ roomCode: input.roomCode, scheduledTime: input.scheduledTime }),
        operator,
      ),
  ]);

  const row = await db
    .prepare(`${RESERVATION_SELECT} WHERE id = ? LIMIT 1`)
    .bind(id)
    .first<ReservationRow>();
  if (!row) throw new Error("직접 입력한 예약을 다시 불러오지 못했습니다.");
  return toReservation(row);
}

export async function copyReservationToNextSlot(
  sourceId: string,
  operator: string,
) {
  await ensureReservationSchema();
  const db = getD1();
  const current = await db
    .prepare(`${RESERVATION_SELECT} WHERE id = ? LIMIT 1`)
    .bind(sourceId)
    .first<ReservationRow>();
  if (!current) return null;
  if (current.status === "cancelled") {
    throw new Error("CANCELLED_RESERVATION");
  }

  const slotIndex = OPERATING_SLOTS.indexOf(current.scheduled_time);
  const nextTime = OPERATING_SLOTS[slotIndex + 1];
  if (slotIndex < 0 || !nextTime) {
    throw new Error("NO_NEXT_SLOT");
  }

  const id = crypto.randomUUID();
  const code = bookingCode(current.scheduled_date);
  const activeSlotKey = await adminActiveSlotKey(
    id,
    current.scheduled_date,
    nextTime,
    current.room_code,
  );

  await db.batch([
    db
      .prepare(`
        INSERT INTO reservations (
          id, booking_code, source, customer_name, customer_phone,
          scheduled_date, scheduled_time, room_code, active_slot_key,
          team_name, difficulty_code, difficulty_label, map_index,
          adult_count, youth_count, total_count, vehicle_last4, consent_text,
          game_minutes, base_amount, memo
        ) VALUES (?, ?, 'admin_repeat', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .bind(
        id,
        code,
        current.customer_name,
        current.customer_phone,
        current.scheduled_date,
        nextTime,
        current.room_code,
        activeSlotKey,
        current.team_name,
        current.difficulty_code,
        current.difficulty_label,
        current.map_index,
        current.adult_count,
        current.youth_count,
        current.total_count,
        current.vehicle_last4,
        "직원 한판 더 복사",
        GAME_DURATION_MINUTES,
        current.base_amount,
        current.memo,
      ),
    db
      .prepare(`
        INSERT INTO reservation_events
          (id, reservation_id, event_type, details_json, created_by)
        VALUES (?, ?, 'repeat_copied', ?, ?)
      `)
      .bind(
        crypto.randomUUID(),
        id,
        JSON.stringify({ copiedFrom: sourceId, scheduledTime: nextTime }),
        operator,
      ),
  ]);

  const copied = await db
    .prepare(`${RESERVATION_SELECT} WHERE id = ? LIMIT 1`)
    .bind(id)
    .first<ReservationRow>();
  if (!copied) throw new Error("한판 더 예약을 저장한 뒤 다시 불러오지 못했습니다.");
  return toReservation(copied);
}

export async function deleteClosedReservation(id: string) {
  await ensureReservationSchema();
  const db = getD1();
  const current = await db
    .prepare(`SELECT status FROM reservations WHERE id = ? LIMIT 1`)
    .bind(id)
    .first<{ status: string }>();
  if (!current) return false;
  if (current.status !== "completed" && current.status !== "cancelled") {
    throw new Error("ACTIVE_RESERVATION");
  }

  await db.batch([
    db.prepare(`DELETE FROM reservation_events WHERE reservation_id = ?`).bind(id),
    db
      .prepare(`DELETE FROM reservations WHERE id = ? AND status IN ('completed', 'cancelled')`)
      .bind(id),
  ]);
  return true;
}

export async function listOccupiedSlots(date: string) {
  await ensureReservationSchema();
  const result = await getD1()
    .prepare(`
      SELECT scheduled_time, room_code
      FROM reservations
      WHERE scheduled_date = ?
        AND active_slot_key IS NOT NULL
        AND status NOT IN ('cancelled', 'completed')
      ORDER BY scheduled_time, room_code
    `)
    .bind(date)
    .all<{ scheduled_time: string; room_code: string }>();
  return result.results.map((row) => ({
    time: row.scheduled_time,
    roomCode: row.room_code,
  }));
}

export async function listReservations(date: string) {
  await ensureReservationSchema();
  const result = await getD1()
    .prepare(`${RESERVATION_SELECT} WHERE scheduled_date = ? ORDER BY scheduled_time, room_code, created_at`)
    .bind(date)
    .all<ReservationRow>();
  return result.results.map(toReservation);
}

export async function consumeReservationRateLimit(clientKey: string) {
  await ensureReservationSchema();
  const db = getD1();
  const now = Math.floor(Date.now() / 1000);
  const windowSeconds = 10 * 60;
  const limit = 8;
  const current = await db
    .prepare(`SELECT request_count, window_started FROM reservation_rate_limits WHERE client_key = ?`)
    .bind(clientKey)
    .first<{ request_count: number; window_started: number }>();
  const inWindow = Boolean(current && now - current.window_started < windowSeconds);
  const requestCount = inWindow ? (current?.request_count ?? 0) + 1 : 1;
  const windowStarted = inWindow ? (current?.window_started ?? now) : now;
  await db
    .prepare(`
      INSERT INTO reservation_rate_limits (client_key, request_count, window_started, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(client_key) DO UPDATE SET
        request_count = excluded.request_count,
        window_started = excluded.window_started,
        updated_at = excluded.updated_at
    `)
    .bind(clientKey, requestCount, windowStarted, now)
    .run();
  return { allowed: requestCount <= limit, retryAfter: windowStarted + windowSeconds - now };
}

async function appendEvent(
  reservationId: string,
  eventType: string,
  details: Record<string, unknown>,
  createdBy: string,
) {
  await getD1()
    .prepare(`
      INSERT INTO reservation_events
        (id, reservation_id, event_type, details_json, created_by)
      VALUES (?, ?, ?, ?, ?)
    `)
    .bind(crypto.randomUUID(), reservationId, eventType, JSON.stringify(details), createdBy)
    .run();
}

export type ReservationAdminAction =
  | { action: "arrive" }
  | { action: "undo_arrive" }
  | { action: "complete" }
  | { action: "cancel" }
  | { action: "manager_loaded" }
  | { action: "assign"; roomCode: string }
  | { action: "move"; scheduledDate: string; scheduledTime: string; roomCode: string }
  | {
      action: "details";
      scheduledDate: string;
      scheduledTime: string;
      roomCode: string;
      teamName: string;
      difficultyCode: string;
      difficultyLabel: string;
      mapIndex: number;
      adultCount: number;
      youthCount: number;
      totalCount: number;
      vehicleLast4: string;
      baseAmount: number;
      memo: string;
    }
  | {
      action: "payment";
      addOnAmount: number;
      discountAmount: number;
      paymentAmount: number;
      paymentCardAmount: number;
      paymentCashAmount: number;
      paymentAccountAmount: number;
      paymentMethod: string;
    }
  | { action: "memo"; memo: string };

export async function updateReservation(
  id: string,
  command: ReservationAdminAction,
  operator: string,
) {
  await ensureReservationSchema();
  const db = getD1();
  const current = await db
    .prepare(`${RESERVATION_SELECT} WHERE id = ? LIMIT 1`)
    .bind(id)
    .first<ReservationRow>();
  if (!current) return null;

  if (command.action === "arrive") {
    await db.prepare(`UPDATE reservations SET status = 'arrived', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'booked'`).bind(id).run();
  } else if (command.action === "undo_arrive") {
    await db.prepare(`UPDATE reservations SET status = 'booked', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'arrived'`).bind(id).run();
  } else if (command.action === "complete") {
    await db.prepare(`UPDATE reservations SET status = 'completed', active_slot_key = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status <> 'cancelled'`).bind(id).run();
  } else if (command.action === "cancel") {
    await db.prepare(`UPDATE reservations SET status = 'cancelled', active_slot_key = NULL, cancelled_at = COALESCE(cancelled_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status <> 'completed'`).bind(id).run();
  } else if (command.action === "manager_loaded") {
    await db.prepare(`UPDATE reservations SET manager_loaded_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(id).run();
  } else if (command.action === "assign") {
    const activeSlotKey =
      current.status !== "cancelled" && current.status !== "completed" && current.scheduled_date && current.scheduled_time
        ? await adminActiveSlotKey(id, current.scheduled_date, current.scheduled_time, command.roomCode)
        : null;
    const scheduleOverridden = updatedScheduleOverride(
      current,
      current.scheduled_date,
      current.scheduled_time,
      command.roomCode,
    );
    await db.prepare(`UPDATE reservations SET room_code = ?, active_slot_key = ?, schedule_overridden = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(command.roomCode, activeSlotKey, scheduleOverridden, id).run();
  } else if (command.action === "move") {
    const activeSlotKey =
      current.status !== "cancelled" && current.status !== "completed"
        ? await adminActiveSlotKey(
            id,
            command.scheduledDate,
            command.scheduledTime,
            command.roomCode,
          )
        : null;
    const scheduleOverridden = updatedScheduleOverride(
      current,
      command.scheduledDate,
      command.scheduledTime,
      command.roomCode,
    );
    await db
      .prepare(`
        UPDATE reservations SET scheduled_date = ?, scheduled_time = ?, room_code = ?,
          active_slot_key = ?, schedule_overridden = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status NOT IN ('cancelled', 'completed')
      `)
      .bind(
        command.scheduledDate,
        command.scheduledTime,
        command.roomCode,
        activeSlotKey,
        scheduleOverridden,
        id,
      )
      .run();
  } else if (command.action === "details") {
    const activeSlotKey =
      current.status !== "cancelled" && current.status !== "completed" && command.roomCode
        ? await adminActiveSlotKey(
            id,
            command.scheduledDate,
            command.scheduledTime,
            command.roomCode,
          )
        : null;
    const scheduleOverridden = updatedScheduleOverride(
      current,
      command.scheduledDate,
      command.scheduledTime,
      command.roomCode,
    );
    const detailsOverridden = updatedDetailsOverride(current, command);
    await db
      .prepare(`
        UPDATE reservations SET scheduled_date = ?, scheduled_time = ?, room_code = ?,
          active_slot_key = ?, schedule_overridden = ?, details_overridden = ?, team_name = ?,
          difficulty_code = ?, difficulty_label = ?, map_index = ?, adult_count = ?,
          youth_count = ?, total_count = ?, vehicle_last4 = ?, base_amount = ?,
          memo = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status <> 'cancelled'
      `)
      .bind(
        command.scheduledDate,
        command.scheduledTime,
        command.roomCode,
        activeSlotKey,
        scheduleOverridden,
        detailsOverridden,
        command.teamName,
        command.difficultyCode,
        command.difficultyLabel,
        command.mapIndex,
        command.adultCount,
        command.youthCount,
        command.totalCount,
        command.vehicleLast4,
        command.baseAmount,
        command.memo,
        id,
      )
      .run();
  } else if (command.action === "memo") {
    await db.prepare(`UPDATE reservations SET memo = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(command.memo, id).run();
  } else if (command.action === "payment") {
    const pricing = await getPricingSettings();
    const depositAmount =
      current.source === "naver"
        ? Math.min(pricing.naverDepositAmount, Math.max(0, command.paymentAmount))
        : 0;
    const paymentDue = Math.max(0, command.paymentAmount - depositAmount);
    let paymentCardAmount = 0;
    let paymentCashAmount = 0;
    let paymentAccountAmount = 0;

    if (command.paymentMethod === "mixed") {
      paymentCardAmount = command.paymentCardAmount;
      paymentCashAmount = command.paymentCashAmount;
      paymentAccountAmount = command.paymentAccountAmount;
      if (
        paymentCardAmount + paymentCashAmount + paymentAccountAmount !==
        paymentDue
      ) {
        throw new Error("PAYMENT_SPLIT_MISMATCH");
      }
    } else if (command.paymentMethod === "card") {
      paymentCardAmount = paymentDue;
    } else if (command.paymentMethod === "cash") {
      paymentCashAmount = paymentDue;
    } else if (command.paymentMethod === "account") {
      paymentAccountAmount = paymentDue;
    }

    // Saving a payment is an explicit settlement action. A fully discounted
    // reservation (for example, a multi-use pass) is complete even when the
    // amount due is zero.
    const paymentStatus = "paid";
    await db
      .prepare(`
        UPDATE reservations SET add_on_amount = ?, discount_amount = ?,
          payment_amount = ?, payment_card_amount = ?, payment_cash_amount = ?,
          payment_account_amount = ?, payment_method = ?, payment_status = ?,
          updated_at = CURRENT_TIMESTAMP WHERE id = ?
      `)
      .bind(
        command.addOnAmount,
        command.discountAmount,
        command.paymentAmount,
        paymentCardAmount,
        paymentCashAmount,
        paymentAccountAmount,
        command.paymentMethod,
        paymentStatus,
        id,
      )
      .run();
  }

  await appendEvent(id, command.action, command, operator);
  const updated = await db
    .prepare(`${RESERVATION_SELECT} WHERE id = ? LIMIT 1`)
    .bind(id)
    .first<ReservationRow>();
  return updated ? toReservation(updated) : null;
}

export async function completeArrivedReservationForRoom(
  roomCode: string,
  teamName: string,
  createdBy = "agent-auto-complete",
) {
  const normalizedTeamName = teamName.trim();
  if (!roomCode || !normalizedTeamName) return null;
  await ensureReservationSchema();
  const db = getD1();
  const current = await db
    .prepare(`
      SELECT id
      FROM reservations
      WHERE room_code = ?
        AND status = 'arrived'
        AND lower(trim(team_name)) = lower(trim(?))
      ORDER BY
        CASE WHEN scheduled_date = date('now', '+9 hours') THEN 0 ELSE 1 END,
        scheduled_date DESC,
        scheduled_time DESC,
        updated_at DESC
      LIMIT 1
    `)
    .bind(roomCode, normalizedTeamName)
    .first<{ id: string }>();
  if (!current) return null;

  const completed = await db
    .prepare(`
      UPDATE reservations
      SET status = 'completed', active_slot_key = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'arrived'
    `)
    .bind(current.id)
    .run();
  if (Number(completed.meta.changes ?? 0) !== 1) return null;
  await appendEvent(
    current.id,
    "auto_complete_game_stopped",
    { roomCode, teamName: normalizedTeamName },
    createdBy,
  );
  return current.id;
}

export type ImportedReservation = {
  sourceBookingNo: string;
  customerName: string;
  customerPhone: string;
  scheduledDate: string;
  scheduledTime: string;
  roomCode: string;
  teamName: string;
  difficultyCode: string;
  difficultyLabel: string;
  mapIndex: number;
  totalCount: number;
  sourceProduct: string;
  sourceStatus: string;
  sourceLink: string;
  sourceState: "booked" | "completed" | "cancelled";
};

export async function upsertImportedReservation(
  input: ImportedReservation,
  adultPrice: number,
) {
  await ensureReservationSchema();
  const db = getD1();
  const existing = await db
    .prepare(`
      SELECT id, scheduled_date, scheduled_time, room_code, active_slot_key,
        schedule_overridden, details_overridden, status,
        EXISTS (
          SELECT 1 FROM reservation_events
          WHERE reservation_id = reservations.id
            AND event_type IN ('complete', 'auto_complete_game_stopped')
        ) AS locally_completed
      FROM reservations
      WHERE source_booking_no = ?
      LIMIT 1
    `)
    .bind(input.sourceBookingNo)
    .first<{
      id: string;
      scheduled_date: string;
      scheduled_time: string;
      room_code: string;
      active_slot_key: string | null;
      schedule_overridden: number;
      details_overridden: number;
      status: "booked" | "arrived" | "completed" | "cancelled";
      locally_completed: number;
    }>();
  const baseAmount = input.totalCount * adultPrice;

  if (existing) {
    const operationalState = resolveImportedOperationalState(
      input.sourceState,
      existing.status,
      existing.locally_completed === 1,
    );
    const effectiveDate = existing.schedule_overridden === 1
      ? existing.scheduled_date
      : input.scheduledDate;
    const effectiveTime = existing.schedule_overridden === 1
      ? existing.scheduled_time
      : input.scheduledTime;
    const effectiveRoom = existing.schedule_overridden === 1
      ? existing.room_code
      : input.roomCode;
    const activeSlotKey =
      operationalState === "booked" || operationalState === "arrived"
        ? await adminActiveSlotKey(
            existing.id,
            effectiveDate,
            effectiveTime,
            effectiveRoom,
          )
        : null;

    await db
      .prepare(`
        UPDATE reservations SET customer_name = ?, customer_phone = ?,
          scheduled_date = CASE WHEN schedule_overridden = 1 THEN scheduled_date ELSE ? END,
          scheduled_time = CASE WHEN schedule_overridden = 1 THEN scheduled_time ELSE ? END,
          room_code = CASE WHEN schedule_overridden = 1 THEN room_code ELSE ? END,
          active_slot_key = ?,
          team_name = CASE WHEN details_overridden = 1 THEN team_name ELSE ? END,
          difficulty_code = CASE WHEN details_overridden = 1 THEN difficulty_code ELSE ? END,
          difficulty_label = CASE WHEN details_overridden = 1 THEN difficulty_label ELSE ? END,
          map_index = CASE WHEN details_overridden = 1 THEN map_index ELSE ? END,
          adult_count = CASE WHEN details_overridden = 1 THEN adult_count ELSE ? END,
          total_count = CASE WHEN details_overridden = 1 THEN total_count ELSE ? END,
          base_amount = CASE WHEN details_overridden = 1 THEN base_amount ELSE ? END,
          source_product = ?, source_status = ?, source_link = ?,
          cancelled_at = CASE WHEN ? = 'cancelled'
            THEN COALESCE(cancelled_at, CURRENT_TIMESTAMP) ELSE NULL END,
          status = ?,
          updated_at = CURRENT_TIMESTAMP WHERE id = ?
      `)
      .bind(
        input.customerName,
        input.customerPhone,
        input.scheduledDate,
        input.scheduledTime,
        input.roomCode,
        activeSlotKey,
        input.teamName,
        input.difficultyCode,
        input.difficultyLabel,
        input.mapIndex,
        input.totalCount,
        input.totalCount,
        baseAmount,
        input.sourceProduct,
        input.sourceStatus,
        input.sourceLink,
        input.sourceState,
        operationalState,
        existing.id,
      )
      .run();
    const eventType = input.sourceState === "cancelled"
      ? "import_cancelled"
      : input.sourceState === "completed"
        ? "import_completed"
        : "import_updated";
    await appendEvent(existing.id, eventType, { sourceStatus: input.sourceStatus }, "naver-import");
    return "updated" as const;
  }

  const id = crypto.randomUUID();
  const operationalState = resolveImportedOperationalState(
    input.sourceState,
    null,
    false,
  );
  const activeSlotKey =
    operationalState === "booked" && input.scheduledDate && input.scheduledTime && input.roomCode
      ? `${input.scheduledDate}|${input.scheduledTime}|${input.roomCode}`
      : null;
  await db
    .prepare(`
      INSERT INTO reservations (
        id, booking_code, source, source_booking_no, source_product, source_status,
        source_link, customer_name, customer_phone, scheduled_date, scheduled_time,
        room_code, active_slot_key, team_name, difficulty_code, difficulty_label,
        map_index, adult_count, total_count, game_minutes, base_amount, status,
        cancelled_at
      ) VALUES (?, ?, 'naver', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE NULL END)
    `)
    .bind(
      id,
      bookingCode(input.scheduledDate || "0000-00-00"),
      input.sourceBookingNo,
      input.sourceProduct,
      input.sourceStatus,
      input.sourceLink,
      input.customerName,
      input.customerPhone,
      input.scheduledDate,
      input.scheduledTime,
      input.roomCode,
      activeSlotKey,
      input.teamName,
      input.difficultyCode,
      input.difficultyLabel,
      input.mapIndex,
      input.totalCount,
      input.totalCount,
      GAME_DURATION_MINUTES,
      baseAmount,
      operationalState,
      input.sourceState === "cancelled" ? 1 : 0,
    )
    .run();
  await appendEvent(id, "import_created", { sourceStatus: input.sourceStatus }, "naver-import");
  return "inserted" as const;
}
