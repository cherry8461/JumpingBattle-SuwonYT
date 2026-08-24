import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const rooms = sqliteTable("rooms", {
  roomId: text("room_id").primaryKey(),
  name: text("name").notNull(),
  size: text("size").notNull(),
  status: text("status").notNull().default("offline"),
  teamName: text("team_name").notNull().default(""),
  mapName: text("map_name").notNull().default(""),
  mapIndex: integer("map_index").notNull().default(0),
  people: integer("people").notNull().default(0),
  remainingSeconds: integer("remaining_seconds").notNull().default(0),
  score: integer("score").notNull().default(0),
  level: text("level").notNull().default(""),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const agents = sqliteTable("agents", {
  agentId: text("agent_id").primaryKey(),
  version: text("version").notNull().default(""),
  lastSeen: text("last_seen").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const agentRuntime = sqliteTable("agent_runtime", {
  agentId: text("agent_id").primaryKey(),
  armed: integer("armed").notNull().default(0),
  simulate: integer("simulate").notNull().default(0),
  managerVisible: integer("manager_visible").notNull().default(0),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const roomMetadata = sqliteTable("room_metadata", {
  roomId: text("room_id").primaryKey(),
  mapOptionsJson: text("map_options_json").notNull().default("[]"),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const roomGameRuntime = sqliteTable("room_game_runtime", {
  roomId: text("room_id").primaryKey(),
  gameStartedAt: text("game_started_at"),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const commands = sqliteTable(
  "commands",
  {
    id: text("id").primaryKey(),
    roomId: text("room_id").notNull(),
    action: text("action").notNull(),
    payloadJson: text("payload_json").notNull().default("{}"),
    status: text("status").notNull().default("pending"),
    requestedBy: text("requested_by").notNull(),
    result: text("result").notNull().default(""),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    expiresAt: text("expires_at").notNull(),
    claimedAt: text("claimed_at"),
    completedAt: text("completed_at"),
  },
  (table) => [
    index("commands_status_created_idx").on(
      table.status,
      table.createdAt,
    ),
    index("commands_room_status_idx").on(table.roomId, table.status),
  ],
);

export const reservations = sqliteTable(
  "reservations",
  {
    id: text("id").primaryKey(),
    bookingCode: text("booking_code").notNull(),
    source: text("source").notNull().default("web_walkin"),
    sourceBookingNo: text("source_booking_no"),
    sourceProduct: text("source_product").notNull().default(""),
    sourceStatus: text("source_status").notNull().default(""),
    sourceLink: text("source_link").notNull().default(""),
    customerName: text("customer_name").notNull().default(""),
    customerPhone: text("customer_phone").notNull().default(""),
    scheduledDate: text("scheduled_date").notNull().default(""),
    scheduledTime: text("scheduled_time").notNull().default(""),
    roomCode: text("room_code").notNull().default(""),
    activeSlotKey: text("active_slot_key"),
    scheduleOverridden: integer("schedule_overridden").notNull().default(0),
    detailsOverridden: integer("details_overridden").notNull().default(0),
    teamName: text("team_name").notNull().default(""),
    difficultyCode: text("difficulty_code").notNull().default(""),
    difficultyLabel: text("difficulty_label").notNull().default(""),
    mapIndex: integer("map_index").notNull().default(0),
    adultCount: integer("adult_count").notNull().default(0),
    youthCount: integer("youth_count").notNull().default(0),
    totalCount: integer("total_count").notNull().default(0),
    vehicleLast4: text("vehicle_last4").notNull().default(""),
    consentText: text("consent_text").notNull().default(""),
    gameMinutes: integer("game_minutes").notNull().default(16),
    baseAmount: integer("base_amount").notNull().default(0),
    addOnAmount: integer("add_on_amount").notNull().default(0),
    discountAmount: integer("discount_amount").notNull().default(0),
    paymentAmount: integer("payment_amount").notNull().default(0),
    paymentCardAmount: integer("payment_card_amount").notNull().default(0),
    paymentCashAmount: integer("payment_cash_amount").notNull().default(0),
    paymentAccountAmount: integer("payment_account_amount").notNull().default(0),
    paymentMethod: text("payment_method").notNull().default(""),
    paymentStatus: text("payment_status").notNull().default("unpaid"),
    status: text("status").notNull().default("booked"),
    cancelledAt: text("cancelled_at"),
    memo: text("memo").notNull().default(""),
    idempotencyKey: text("idempotency_key"),
    managerLoadedAt: text("manager_loaded_at"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("reservations_booking_code_uidx").on(table.bookingCode),
    uniqueIndex("reservations_source_booking_no_uidx").on(table.sourceBookingNo),
    uniqueIndex("reservations_active_slot_key_uidx").on(table.activeSlotKey),
    uniqueIndex("reservations_idempotency_key_uidx").on(table.idempotencyKey),
    index("reservations_schedule_idx").on(table.scheduledDate, table.scheduledTime),
    index("reservations_status_idx").on(table.status, table.updatedAt),
  ],
);

export const reservationEvents = sqliteTable(
  "reservation_events",
  {
    id: text("id").primaryKey(),
    reservationId: text("reservation_id").notNull(),
    eventType: text("event_type").notNull(),
    detailsJson: text("details_json").notNull().default("{}"),
    createdBy: text("created_by").notNull().default("system"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("reservation_events_reservation_idx").on(table.reservationId, table.createdAt)],
);

export const reservationRateLimits = sqliteTable("reservation_rate_limits", {
  clientKey: text("client_key").primaryKey(),
  requestCount: integer("request_count").notNull().default(0),
  windowStarted: integer("window_started").notNull().default(0),
  updatedAt: integer("updated_at").notNull().default(0),
});

export const dailySharedSales = sqliteTable("daily_shared_sales", {
  salesDate: text("sales_date").primaryKey(),
  slushCard: integer("slush_card").notNull().default(0),
  slushCash: integer("slush_cash").notNull().default(0),
  slushAccount: integer("slush_account").notNull().default(0),
  beverageCard: integer("beverage_card").notNull().default(0),
  beverageCash: integer("beverage_cash").notNull().default(0),
  beverageAccount: integer("beverage_account").notNull().default(0),
  slushCardCount: integer("slush_card_count").notNull().default(0),
  slushCashCount: integer("slush_cash_count").notNull().default(0),
  slushAccountCount: integer("slush_account_count").notNull().default(0),
  beverageCardCount: integer("beverage_card_count").notNull().default(0),
  beverageCashCount: integer("beverage_cash_count").notNull().default(0),
  beverageAccountCount: integer("beverage_account_count").notNull().default(0),
  otherCardCount: integer("other_card_count").notNull().default(0),
  otherCashCount: integer("other_cash_count").notNull().default(0),
  otherAccountCount: integer("other_account_count").notNull().default(0),
  youthPass10CardCount: integer("youth_pass_10_card_count").notNull().default(0),
  youthPass10CashCount: integer("youth_pass_10_cash_count").notNull().default(0),
  youthPass10AccountCount: integer("youth_pass_10_account_count").notNull().default(0),
  youthPass20CardCount: integer("youth_pass_20_card_count").notNull().default(0),
  youthPass20CashCount: integer("youth_pass_20_cash_count").notNull().default(0),
  youthPass20AccountCount: integer("youth_pass_20_account_count").notNull().default(0),
  adultPass10CardCount: integer("adult_pass_10_card_count").notNull().default(0),
  adultPass10CashCount: integer("adult_pass_10_cash_count").notNull().default(0),
  adultPass10AccountCount: integer("adult_pass_10_account_count").notNull().default(0),
  adultPass20CardCount: integer("adult_pass_20_card_count").notNull().default(0),
  adultPass20CashCount: integer("adult_pass_20_cash_count").notNull().default(0),
  adultPass20AccountCount: integer("adult_pass_20_account_count").notNull().default(0),
  updatedBy: text("updated_by").notNull().default(""),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const pricingSettings = sqliteTable("pricing_settings", {
  id: integer("id").primaryKey(),
  adultPrice: integer("adult_price").notNull().default(7_000),
  youthPrice: integer("youth_price").notNull().default(5_000),
  naverDepositAmount: integer("naver_deposit_amount").notNull().default(5_000),
  naverCancellationFeeAmount: integer("naver_cancellation_fee_amount").notNull().default(5_000),
  slushPrice: integer("slush_price").notNull().default(1_500),
  beveragePrice: integer("beverage_price").notNull().default(1_000),
  otherPrice: integer("other_price").notNull().default(1_000),
  youthPass10Price: integer("youth_pass_10_price").notNull().default(45_000),
  youthPass20Price: integer("youth_pass_20_price").notNull().default(80_000),
  adultPass10Price: integer("adult_pass_10_price").notNull().default(60_000),
  adultPass20Price: integer("adult_pass_20_price").notNull().default(110_000),
  updatedBy: text("updated_by").notNull().default(""),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const naverStockManagedSlots = sqliteTable(
  "naver_stock_managed_slots",
  {
    slotKey: text("slot_key").primaryKey(),
    roomCode: text("room_code").notNull(),
    scheduledDate: text("scheduled_date").notNull(),
    scheduledTime: text("scheduled_time").notNull(),
    bizItemId: integer("biz_item_id").notNull(),
    originalStock: integer("original_stock").notNull().default(1),
    managedAt: text("managed_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("naver_stock_managed_schedule_idx").on(
      table.scheduledDate,
      table.scheduledTime,
    ),
  ],
);
