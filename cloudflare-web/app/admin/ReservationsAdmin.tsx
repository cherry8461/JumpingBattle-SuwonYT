"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  GAME_DURATION_MINUTES,
  OPERATING_SLOTS,
  ROOM_OPTIONS,
  SLOT_INTERVAL_MINUTES,
  dateInSeoul,
  getDifficulty,
  getDifficultyOptions,
  getRoom,
  resolveReservationDifficultyCode,
  naverSameDayCancellationFee,
  timeInSeoul,
  type ReservationRecord,
} from "../reservation-config";
import {
  sharedSalesUnitPrices,
  type PricingSettings,
  type SharedSalesCategory,
} from "../pricing-config";
import type { ControlAction, Room, StatusResponse } from "../types";
import { calculateNextGameAvailability } from "./availability";
import {
  correctedRemainingSeconds,
  databaseTimestamp,
} from "./controller-time";
import { currentOperatingSlot } from "./schedule-time";

const STATUS_LABELS: Record<string, string> = {
  booked: "예약",
  arrived: "입장",
  completed: "완료",
  cancelled: "취소",
};

const PAYMENT_LABELS: Record<string, string> = {
  card: "카드",
  cash: "현금",
  account: "계좌이체",
  coupon: "쿠폰",
  mixed: "복합결제",
};

const ROOM_STATUS_LABELS: Record<Room["status"], string> = {
  offline: "연결 없음",
  waiting: "대기",
  running: "게임 중",
  error: "확인 필요",
};

const SCHEDULE_ROOM_CODES = ["C2", "B1", "C1", "A1"];
const CONTROL_PIN_STORAGE_KEY = "jumping-admin-control-pinned";

type Mutation =
  | { action: "arrive" | "undo_arrive" | "cancel" | "manager_loaded" }
  | { action: "assign"; roomCode: string }
  | { action: "move"; scheduledDate: string; scheduledTime: string; roomCode: string }
  | {
      action: "details";
      scheduledDate: string;
      scheduledTime: string;
      roomCode: string;
      teamName: string;
      difficultyCode: string;
      adultCount: number;
      youthCount: number;
      vehicleLast4: string;
      memo: string;
    }
  | { action: "memo"; memo: string }
  | {
      action: "payment";
      addOnAmount: number;
      discountAmount: number;
      paymentAmount: number;
      paymentCardAmount: number;
      paymentCashAmount: number;
      paymentAccountAmount: number;
      paymentMethod: string;
    };

type BookingFilter = "all" | "unpaid" | "arrived" | "unassigned" | "cancelled";

type ScheduleSelection = {
  time: string;
  roomCode: string;
  reservation?: ReservationRecord;
};

type ReservationListChange =
  | { type: "upsert"; reservation: ReservationRecord }
  | { type: "remove"; id: string };

function applyReservationListChange(
  current: ReservationRecord[],
  change: ReservationListChange,
  listDate: string,
) {
  const changedId =
    change.type === "upsert" ? change.reservation.id : change.id;
  const next = current.filter((reservation) => reservation.id !== changedId);

  if (
    change.type === "upsert" &&
    change.reservation.scheduledDate === listDate
  ) {
    next.push(change.reservation);
  }

  return next.sort(
    (left, right) =>
      left.scheduledTime.localeCompare(right.scheduledTime) ||
      left.createdAt.localeCompare(right.createdAt),
  );
}

function sameReservationSnapshot(
  current: ReservationRecord[],
  next: ReservationRecord[],
) {
  return (
    current.length === next.length &&
    current.every(
      (reservation, index) =>
        reservation.id === next[index]?.id &&
        reservation.updatedAt === next[index]?.updatedAt,
    )
  );
}

type SharedPaymentMethod = "card" | "cash" | "account";
type PaymentSplit = Record<SharedPaymentMethod, number>;
type DailySharedSales = {
  date: string;
  slush: Record<SharedPaymentMethod, number>;
  beverage: Record<SharedPaymentMethod, number>;
  other: Record<SharedPaymentMethod, number>;
  youthPass10: Record<SharedPaymentMethod, number>;
  youthPass20: Record<SharedPaymentMethod, number>;
  adultPass10: Record<SharedPaymentMethod, number>;
  adultPass20: Record<SharedPaymentMethod, number>;
  updatedAt: string;
};

const SHARED_PAYMENT_METHODS: Array<{
  value: SharedPaymentMethod;
  label: string;
}> = [
  { value: "card", label: "카드" },
  { value: "cash", label: "현금" },
  { value: "account", label: "계좌" },
];

function emptySharedSales(date: string): DailySharedSales {
  return {
    date,
    slush: { card: 0, cash: 0, account: 0 },
    beverage: { card: 0, cash: 0, account: 0 },
    other: { card: 0, cash: 0, account: 0 },
    youthPass10: { card: 0, cash: 0, account: 0 },
    youthPass20: { card: 0, cash: 0, account: 0 },
    adultPass10: { card: 0, cash: 0, account: 0 },
    adultPass20: { card: 0, cash: 0, account: 0 },
    updatedAt: "",
  };
}

function paymentSplitTotal(split: PaymentSplit) {
  return split.card + split.cash + split.account;
}

function paymentSplitForSave(
  paymentMethod: string,
  paymentDue: number,
  mixedSplit: PaymentSplit,
): PaymentSplit {
  if (paymentMethod === "mixed") return mixedSplit;
  return {
    card: paymentMethod === "card" ? paymentDue : 0,
    cash: paymentMethod === "cash" ? paymentDue : 0,
    account: paymentMethod === "account" ? paymentDue : 0,
  };
}

function sharedSalesTotal(
  sales: DailySharedSales,
  unitPrices: Record<SharedSalesCategory, number>,
) {
  return (Object.keys(unitPrices) as SharedSalesCategory[]).reduce(
    (total, category) =>
      total +
      Object.values(sales[category]).reduce((sum, count) => sum + count, 0) *
        unitPrices[category],
    0,
  );
}

function sharedSalesCount(
  sales: DailySharedSales,
  unitPrices: Record<SharedSalesCategory, number>,
) {
  return (Object.keys(unitPrices) as SharedSalesCategory[]).reduce(
    (total, category) =>
      total + Object.values(sales[category]).reduce((sum, count) => sum + count, 0),
    0,
  );
}

function won(value: number) {
  return new Intl.NumberFormat("ko-KR").format(value);
}

function nextOperatingSlot(time: string) {
  const index = OPERATING_SLOTS.indexOf(time);
  return index >= 0 ? OPERATING_SLOTS[index + 1] ?? "" : "";
}

function formatRemaining(seconds: number) {
  const safe = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(safe / 60)).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}`;
}

type AvailabilityEstimate = {
  availableSeconds: number;
  availableAt: string;
  queuedReservations: number;
  nextReservationTime: string;
  basis: "controller" | "schedule" | "available";
};

function clockInSeoul(timestamp: number) {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(timestamp));
}

function currentReservationSlotStartsAt(now: number) {
  const slotTime = currentOperatingSlot(clockInSeoul(now), OPERATING_SLOTS);
  return new Date(
    `${dateInSeoul(new Date(now))}T${slotTime}:00+09:00`,
  ).getTime();
}

function runningGameStartedAt(room: Room | undefined, now: number) {
  if (room?.status !== "running") return null;

  const storedStartedAt = databaseTimestamp(room.gameStartedAt);
  if (Number.isFinite(storedStartedAt)) return storedStartedAt;

  const observedAt = databaseTimestamp(room.updatedAt);
  const syncedAt = Number.isFinite(observedAt) ? observedAt : now;
  const gameSeconds = GAME_DURATION_MINUTES * 60;
  const remainingSeconds = Math.min(
    gameSeconds,
    Math.max(0, room.remainingSeconds),
  );
  return syncedAt - (gameSeconds - remainingSeconds) * 1_000;
}

function estimateAvailability(
  room: Room | undefined,
  roomCode: string,
  reservations: ReservationRecord[],
  now = Date.now(),
): AvailabilityEstimate | null {
  const reservationSlots = reservations
    .filter((reservation) => reservation.roomCode === roomCode)
    .map((reservation) => ({
      startsAt: new Date(
        `${reservation.scheduledDate}T${reservation.scheduledTime}:00+09:00`,
      ).getTime(),
      status: reservation.status,
      scheduledTime: reservation.scheduledTime,
      teamName: reservation.teamName,
    }))
    .filter((item) => Number.isFinite(item.startsAt))
    .sort((left, right) => left.startsAt - right.startsAt);

  const availability = calculateNextGameAvailability({
    now,
    gameStartedAt: runningGameStartedAt(room, now),
    controllerRemainingSeconds:
      room?.status === "running" ? room.remainingSeconds : null,
    currentTeamName: room?.teamName ?? "",
    currentReservationStartsAt:
      room?.status === "running" ? currentReservationSlotStartsAt(now) : null,
    reservations: reservationSlots,
  });

  if (
    availability.basis === "available" &&
    (!room || room.status === "offline" || room.status === "error")
  ) {
    return null;
  }

  return {
    availableSeconds: availability.availableSeconds,
    availableAt: clockInSeoul(availability.availableAt),
    queuedReservations: availability.queuedReservations,
    nextReservationTime: availability.nextReservationTime,
    basis: availability.basis,
  };
}

function sourceLabel(source: string) {
  if (source === "naver") return "네이버 예약";
  if (source === "web_walkin") return "예약 접수 사이트";
  if (source === "admin_manual") return "직원 입력";
  if (source === "admin_repeat") return "한판 더";
  return source;
}

function reservationDeposit(
  source: string,
  grossAmount: number,
  depositAmount: number,
) {
  return source === "naver"
    ? Math.min(depositAmount, Math.max(0, grossAmount))
    : 0;
}

function scheduleRevenueAmount(
  reservation: ReservationRecord,
  cancellationFeeAmount: number,
) {
  return reservation.status === "cancelled"
    ? naverSameDayCancellationFee(reservation, cancellationFeeAmount)
    : expectedAmount(reservation);
}

function sharedSalesAmountByMethod(
  sales: DailySharedSales,
  method: SharedPaymentMethod,
  unitPrices: Record<SharedSalesCategory, number>,
) {
  return (Object.keys(unitPrices) as SharedSalesCategory[]).reduce(
    (total, category) =>
      total + sales[category][method] * unitPrices[category],
    0,
  );
}

function sharedSalesCategoryTotal(
  sales: DailySharedSales,
  category: SharedSalesCategory,
  unitPrices: Record<SharedSalesCategory, number>,
) {
  return (
    Object.values(sales[category]).reduce((sum, count) => sum + count, 0) *
    unitPrices[category]
  );
}

function SharedSalesPanel({
  sales,
  totalSales,
  editMode,
  loading,
  saving,
  notice,
  unitPrices,
  onChange,
  onSave,
  onStartEdit,
  onCancelEdit,
}: {
  sales: DailySharedSales;
  totalSales: DailySharedSales;
  editMode: boolean;
  loading: boolean;
  saving: boolean;
  notice: string;
  unitPrices: Record<SharedSalesCategory, number>;
  onChange: (
    category: SharedSalesCategory,
    method: SharedPaymentMethod,
    count: number,
  ) => void;
  onSave: () => Promise<void>;
  onStartEdit: () => void;
  onCancelEdit: () => void;
}) {
  const [passesOpen, setPassesOpen] = useState(false);
  const categoryRows: Array<{
    value: SharedSalesCategory;
    label: string;
  }> = [
    { value: "slush", label: "슬러시" },
    { value: "beverage", label: "음료" },
    { value: "other", label: "기타" },
    { value: "youthPass10", label: "청소년 10회" },
    { value: "youthPass20", label: "청소년 20회" },
    { value: "adultPass10", label: "성인 10회" },
    { value: "adultPass20", label: "성인 20회" },
  ];
  const regularRows = categoryRows.slice(0, 3);
  const passRows = categoryRows.slice(3);

  const renderCategoryRow = (category: (typeof categoryRows)[number]) => {
    const categoryCount = Object.values(sales[category.value]).reduce(
      (sum, count) => sum + count,
      0,
    );
    const categoryTotal =
      categoryCount * unitPrices[category.value];

    return (
      <div className="shared-sales-row" key={category.value}>
        <strong>
          {category.label}
          <small>{won(unitPrices[category.value])}원</small>
        </strong>
        {SHARED_PAYMENT_METHODS.map((method) => (
          <label key={method.value}>
            <span>{category.label} {method.label} 판매 개수</span>
            <input
              type="number"
              min="0"
              max="999"
              step="1"
              inputMode="numeric"
              disabled={loading || saving}
              value={sales[category.value][method.value] || ""}
              placeholder="0"
              onChange={(event) =>
                onChange(
                  category.value,
                  method.value,
                  Math.max(0, Math.min(999, Math.trunc(Number(event.target.value) || 0))),
                )
              }
            />
          </label>
        ))}
        <b>{won(categoryTotal)}원</b>
      </div>
    );
  };

  return (
    <aside className="shared-sales-panel" aria-labelledby="shared-sales-title">
      <div className="shared-sales-heading">
        <div>
          <h3 id="shared-sales-title">공용 부가매출 <small>오늘 누적 · {editMode ? "수정 중" : "빠른 추가"}</small></h3>
          <strong>{won(sharedSalesTotal(totalSales, unitPrices))}원</strong>
        </div>
        <button
          type="button"
          className={editMode ? "is-editing" : ""}
          disabled={loading || saving}
          onClick={editMode ? onCancelEdit : onStartEdit}
        >
          {editMode ? "수정 취소" : "누적 수정"}
        </button>
      </div>
      <div className={`shared-sales-table ${loading ? "is-loading" : ""}`}>
        <div className="shared-sales-row shared-sales-labels" aria-hidden="true">
          <strong>구분</strong>
          {SHARED_PAYMENT_METHODS.map((method) => (
            <strong key={method.value}>{method.label}</strong>
          ))}
          <strong>합계</strong>
        </div>
        {regularRows.map(renderCategoryRow)}
        <button
          type="button"
          className="shared-sales-group-toggle"
          aria-expanded={passesOpen}
          aria-controls="shared-sales-pass-rows"
          onClick={() => setPassesOpen((open) => !open)}
        >
          <strong>다회권</strong>
          <span>{passesOpen ? "접기 ▲" : "펼치기 ▼"}</span>
        </button>
        {passesOpen ? (
          <div id="shared-sales-pass-rows" className="shared-sales-pass-rows">
            {passRows.map(renderCategoryRow)}
          </div>
        ) : null}
      </div>
      <div
        className={`shared-sales-current-total ${editMode ? "is-editing" : ""}`}
        role="status"
        aria-live="polite"
      >
        <span>
          <small>
            {editMode ? "수정 후 오늘 누적 금액" : "지금 입력한 판매 금액"}
          </small>
          현재 합계
        </span>
        <strong>{won(sharedSalesTotal(sales, unitPrices))}원</strong>
      </div>
      <div
        className="shared-sales-payment-totals"
        aria-label="공용 부가매출 결제수단별 누적 합계"
      >
        {SHARED_PAYMENT_METHODS.map((method) => (
          <span key={method.value}>
            <small>{method.label} 합계</small>
            <strong>{won(sharedSalesAmountByMethod(totalSales, method.value, unitPrices))}원</strong>
          </span>
        ))}
      </div>
      <div className="shared-sales-footer">
        <span role="status">
          {notice || (editMode
            ? "현재 누적 개수를 고쳐 저장할 수 있습니다."
            : "새 판매 개수 입력 · 저장 후 0 초기화")}
        </span>
        <button type="button" disabled={loading || saving} onClick={() => void onSave()}>
          {saving ? "저장 중…" : editMode ? "수정 저장" : "추가 저장"}
        </button>
      </div>
    </aside>
  );
}

function QuickBookingModal({
  date,
  selection,
  status,
  manualStartMode,
  onClose,
  onSaved,
  onOpenCopied,
  onRefreshStatus,
  pricing,
}: {
  date: string;
  selection: ScheduleSelection;
  status: StatusResponse | null;
  manualStartMode: boolean;
  onClose: () => void;
  onSaved: (change: ReservationListChange) => Promise<void>;
  onOpenCopied: (reservation: ReservationRecord) => void;
  onRefreshStatus: () => Promise<void>;
  pricing: PricingSettings;
}) {
  const initialReservation = selection.reservation;
  const initialRoom = initialReservation?.roomCode ?? selection.roomCode;
  const [reservation, setReservation] = useState(initialReservation);
  const [roomCode, setRoomCode] = useState(initialRoom);
  const [teamName, setTeamName] = useState(initialReservation?.teamName ?? "");
  const [difficultyCode, setDifficultyCode] = useState(() =>
    initialReservation
      ? resolveReservationDifficultyCode(
          initialReservation.difficultyCode,
          initialReservation.difficultyLabel,
          initialRoom,
        )
      : "basic",
  );
  const [adultCount, setAdultCount] = useState(
    initialReservation?.adultCount ?? 2,
  );
  const [youthCount, setYouthCount] = useState(initialReservation?.youthCount ?? 0);
  const [vehicleLast4, setVehicleLast4] = useState(initialReservation?.vehicleLast4 ?? "");
  const [memo, setMemo] = useState(initialReservation?.memo ?? "");
  const [addOnAmount, setAddOnAmount] = useState(initialReservation?.addOnAmount ?? 0);
  const [discountAmount, setDiscountAmount] = useState(initialReservation?.discountAmount ?? 0);
  const [paymentMethod, setPaymentMethod] = useState(initialReservation?.paymentMethod || "card");
  const [mixedPayment, setMixedPayment] = useState<PaymentSplit>({
    card: initialReservation?.paymentCardAmount ?? 0,
    cash: initialReservation?.paymentCashAmount ?? 0,
    account: initialReservation?.paymentAccountAmount ?? 0,
  });
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const totalCount = adultCount + youthCount;
  const amount =
    adultCount * pricing.adultPrice + youthCount * pricing.youthPrice;
  const grossPaymentAmount = Math.max(0, amount + addOnAmount - discountAmount);
  const depositAmount = reservationDeposit(
    reservation?.source ?? "",
    grossPaymentAmount,
    pricing.naverDepositAmount,
  );
  const paymentDue = Math.max(0, grossPaymentAmount - depositAmount);
  const isCancelled = reservation?.status === "cancelled";
  const isClosed = reservation?.status === "cancelled" || reservation?.status === "completed";
  const roomConfig = getRoom(roomCode);
  const liveRoom = status?.rooms.find((room) => room.roomId === roomConfig?.roomId);
  const difficultyOptions = getDifficultyOptions(roomCode);
  const agentReady = Boolean(
    status?.store.agentOnline &&
      status.store.controlArmed &&
      status.store.managerVisible,
  );

  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  async function copyInputValue(value: string, label: string) {
    const normalized = value.trim();
    if (!normalized) return;
    setError("");
    try {
      await navigator.clipboard.writeText(normalized);
      setNotice(`${label}을(를) 복사했습니다.`);
    } catch {
      setNotice(`${label}을(를) 복사하지 못했습니다. 다시 눌러주세요.`);
    }
  }

  async function persistDetails() {
    const response = await fetch("/api/admin/reservations", {
      method: reservation ? "PATCH" : "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...(reservation ? { id: reservation.id, action: "details" } : {}),
        scheduledDate: date,
        scheduledTime: selection.time,
        roomCode,
        teamName: teamName.trim(),
        difficultyCode,
        adultCount,
        youthCount,
        vehicleLast4,
        memo,
      }),
    });
    const data = (await response.json()) as {
      reservation?: ReservationRecord;
      error?: string;
    };
    if (!response.ok || !data.reservation) {
      throw new Error(data.error ?? "예약 칸을 저장하지 못했습니다.");
    }
    setReservation(data.reservation);
    await onSaved({ type: "upsert", reservation: data.reservation });
    return data.reservation;
  }

  async function patchReservation(id: string, command: Mutation) {
    const response = await fetch("/api/admin/reservations", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, ...command }),
    });
    const data = (await response.json()) as {
      reservation?: ReservationRecord;
      error?: string;
    };
    if (!response.ok || !data.reservation) {
      throw new Error(data.error ?? "예약을 처리하지 못했습니다.");
    }
    setReservation(data.reservation);
    await onSaved({ type: "upsert", reservation: data.reservation });
    return data.reservation;
  }

  async function save() {
    setBusy("save");
    setError("");
    setNotice("");
    try {
      const wasExisting = Boolean(reservation);
      const saved = await persistDetails();
      setNotice(wasExisting ? "예약 내용을 저장했습니다." : "예약 칸을 추가했습니다. 아래에서 바로 운영할 수 있습니다.");
      setAddOnAmount(saved.addOnAmount);
      setDiscountAmount(saved.discountAmount);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "예약 칸을 저장하지 못했습니다.");
    } finally {
      setBusy("");
    }
  }

  async function mutate(command: Mutation, success: string) {
    if (!reservation) return;
    setBusy(command.action);
    setError("");
    setNotice("");
    try {
      await patchReservation(reservation.id, command);
      setNotice(success);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "예약을 처리하지 못했습니다.");
    } finally {
      setBusy("");
    }
  }

  async function sendManager(action: "set_info" | "start") {
    const difficulty = getDifficulty(difficultyCode);
    if (!roomConfig || !difficulty || !teamName.trim()) {
      setError("팀명, 방, 난이도를 먼저 확인해주세요.");
      return;
    }
    if (!agentReady) {
      setError("매장 관리자 프로그램이 연결되고 안전 잠금이 해제되어야 실행할 수 있습니다.");
      return;
    }
    const manualStartOnly = action === "start" && manualStartMode;
    const informationOnly = action === "set_info" || manualStartOnly;
    if (
      action === "start" &&
      !manualStartMode &&
      !window.confirm(`${roomConfig.name}에서 ${teamName.trim()} 팀 게임을 시작할까요?\n16:00부터 카운트다운됩니다.`)
    ) return;

    setBusy(action);
    setError("");
    setNotice("");
    try {
      const saved = await persistDetails();
      const response = await fetch("/api/commands", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          roomId: roomConfig.roomId,
          action: informationOnly ? "set_info" : "start",
          teamName: teamName.trim(),
          mapIndex: manualStartOnly ? 0 : difficulty.mapIndex,
          people: 0,
          skipPeople: true,
          durationMinutes: GAME_DURATION_MINUTES,
        }),
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(data.error ?? "관리자 프로그램 명령을 보내지 못했습니다.");
      if (informationOnly) {
        await patchReservation(saved.id, { action: "manager_loaded" });
        setNotice(
          manualStartMode && action === "start"
            ? "팀명만 빠르게 입력했습니다. 매장 관리자 프로그램에서 난이도를 선택하고 시작 버튼을 눌러주세요."
            : "관리자 프로그램에 팀명·난이도를 빠르게 입력했습니다. 인원은 변경하지 않았습니다.",
        );
      } else {
        setNotice(`${roomConfig.name} 게임 시작 명령을 보냈습니다.`);
      }
      window.setTimeout(() => void onRefreshStatus(), 650);
      window.setTimeout(() => void onRefreshStatus(), 1_500);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "관리자 프로그램 명령을 보내지 못했습니다.");
    } finally {
      setBusy("");
    }
  }

  async function stopGame() {
    if (!roomConfig || !liveRoom || liveRoom.status !== "running") return;
    if (!window.confirm(`${roomConfig.name} 게임을 정지할까요?`)) return;
    setBusy("stop");
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/commands", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ roomId: roomConfig.roomId, action: "stop" }),
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(data.error ?? "게임 정지 명령을 보내지 못했습니다.");
      setNotice(`${roomConfig.name} 게임 정지 명령을 보냈습니다.`);
      window.setTimeout(() => void onRefreshStatus(), 650);
      window.setTimeout(() => void onRefreshStatus(), 1_500);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "게임 정지 명령을 보내지 못했습니다.");
    } finally {
      setBusy("");
    }
  }

  async function savePayment() {
    const split = paymentSplitForSave(paymentMethod, paymentDue, mixedPayment);
    if (paymentMethod === "mixed" && paymentSplitTotal(split) !== paymentDue) {
      setError(
        `복합결제 합계가 현장 결제액과 같아야 합니다. 현재 ${won(paymentSplitTotal(split))}원 / 필요 ${won(paymentDue)}원`,
      );
      return;
    }
    setBusy("payment");
    setError("");
    setNotice("");
    try {
      const saved = await persistDetails();
      await patchReservation(saved.id, {
        action: "payment",
        addOnAmount,
        discountAmount,
        paymentAmount: grossPaymentAmount,
        paymentCardAmount: split.card,
        paymentCashAmount: split.cash,
        paymentAccountAmount: split.account,
        paymentMethod,
      });
      setNotice("결제 내역을 저장했습니다.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "결제 내역을 저장하지 못했습니다.");
    } finally {
      setBusy("");
    }
  }

  async function clearCell() {
    if (!reservation || !window.confirm("이 예약 칸을 비울까요? 예약은 취소 기록으로 보존됩니다.")) return;
    setBusy("cancel");
    setError("");
    try {
      const response = await fetch("/api/admin/reservations", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: reservation.id, action: "cancel" }),
      });
      const data = (await response.json()) as {
        reservation?: ReservationRecord;
        error?: string;
      };
      if (!response.ok || !data.reservation) {
        throw new Error(data.error ?? "예약 칸을 비우지 못했습니다.");
      }
      await onSaved({ type: "upsert", reservation: data.reservation });
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "예약 칸을 비우지 못했습니다.");
    } finally {
      setBusy("");
    }
  }

  async function copyNextGame() {
    if (!reservation) return;
    const nextTime = nextOperatingSlot(reservation.scheduledTime);
    if (!nextTime) {
      setError("마지막 운영 시간이라 다음 타임을 만들 수 없습니다.");
      return;
    }
    if (!window.confirm(
      `${reservation.teamName} 팀 정보를 ${nextTime} 같은 방에 복사할까요?\n새 예약은 미결제 상태로 만들어집니다.`,
    )) return;

    setBusy("copy");
    setError("");
    setNotice("");
    try {
      const saved = await persistDetails();
      const response = await fetch("/api/admin/reservations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ copyFromId: saved.id }),
      });
      const data = (await response.json()) as {
        reservation?: ReservationRecord;
        error?: string;
      };
      if (!response.ok || !data.reservation) {
        throw new Error(data.error ?? "다음 타임 예약을 만들지 못했습니다.");
      }
      setNotice(`${data.reservation.scheduledTime} 같은 방에 미결제 예약으로 복사했습니다.`);
      await onSaved({ type: "upsert", reservation: data.reservation });
      onOpenCopied(data.reservation);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "다음 타임 예약을 만들지 못했습니다.");
    } finally {
      setBusy("");
    }
  }

  async function deleteRecord() {
    if (!reservation || !isClosed) return;
    if (!window.confirm(
      `${reservation.teamName || "이 예약"}의 ${STATUS_LABELS[reservation.status] ?? reservation.status} 기록을 완전히 삭제할까요?\n삭제 후에는 되돌릴 수 없습니다.`,
    )) return;

    setBusy("delete");
    setError("");
    try {
      const response = await fetch("/api/admin/reservations", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: reservation.id }),
      });
      const data = (await response.json()) as { id?: string; error?: string };
      if (!response.ok || !data.id) {
        throw new Error(data.error ?? "예약 기록을 삭제하지 못했습니다.");
      }
      await onSaved({ type: "remove", id: data.id });
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "예약 기록을 삭제하지 못했습니다.");
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="quick-booking-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="quick-booking-modal" role="dialog" aria-modal="true" aria-labelledby="quick-booking-title">
        <div className="quick-booking-head">
          <div>
            <p className="eyebrow">QUICK SCHEDULE EDIT</p>
            <h2 id="quick-booking-title">{reservation ? "예약 칸 통합 관리" : "예약 칸 직접 입력"}</h2>
            <span>{date} · {selection.time} · {initialRoom ? getRoom(initialRoom)?.name : "추가·대기 칸"}</span>
          </div>
          <button type="button" aria-label="닫기" onClick={onClose}>×</button>
        </div>

        <div className="quick-booking-grid">
          <div className="wide-field quick-copy-control">
            <label htmlFor="quick-team-name">팀명</label>
            <div className="quick-copy-field">
              <input id="quick-team-name" autoFocus maxLength={10} disabled={isCancelled} value={teamName} onChange={(event) => setTeamName(event.target.value)} placeholder="최대 10자" />
              <button type="button" disabled={!teamName.trim()} onClick={() => void copyInputValue(teamName, "팀명")} aria-label="팀명 복사">복사</button>
            </div>
          </div>
          <label><span>방 배정</span><select disabled={isCancelled} value={roomCode} onChange={(event) => {
            const nextRoomCode = event.target.value;
            setRoomCode(nextRoomCode);
            if (!getDifficultyOptions(nextRoomCode).some((difficulty) => difficulty.code === difficultyCode)) {
              setDifficultyCode("basic");
            }
          }}><option value="">추가·대기(미배정)</option>{ROOM_OPTIONS.map((room) => <option key={room.code} value={room.code}>{room.name} · 권장 {room.min}~{room.max}명</option>)}</select></label>
          <label><span>난이도</span><select disabled={isCancelled} value={difficultyCode} onChange={(event) => setDifficultyCode(event.target.value)}>{difficultyOptions.map((difficulty) => <option key={difficulty.code} value={difficulty.code}>{difficulty.label} {difficulty.stars}</option>)}</select></label>
          <label><span>성인</span><input type="number" min="0" max="10" disabled={isCancelled} value={adultCount} onChange={(event) => setAdultCount(Math.max(0, Number(event.target.value) || 0))} /></label>
          <label><span>청소년·어린이</span><input type="number" min="0" max="10" disabled={isCancelled} value={youthCount} onChange={(event) => setYouthCount(Math.max(0, Number(event.target.value) || 0))} /></label>
          <div className="wide-field quick-copy-control">
            <label htmlFor="quick-vehicle-last4">차량번호 뒤 4자리</label>
            <div className="quick-copy-field">
              <input id="quick-vehicle-last4" inputMode="numeric" maxLength={4} disabled={isCancelled} value={vehicleLast4} onChange={(event) => setVehicleLast4(event.target.value.replace(/\D/g, "").slice(0, 4))} placeholder="선택 입력" />
              <button type="button" disabled={!vehicleLast4.trim()} onClick={() => void copyInputValue(vehicleLast4, "차량번호")} aria-label="차량번호 복사">복사</button>
            </div>
          </div>
          <label className="wide-field"><span>메모</span><textarea rows={2} maxLength={500} disabled={isCancelled} value={memo} onChange={(event) => setMemo(event.target.value)} placeholder="현장 메모" /></label>
        </div>

        <div className="quick-booking-summary">
          <span>총 {totalCount}명</span><strong>{won(amount)}원</strong>
          {reservation ? (
            <em className={`quick-source-badge source-${reservation.source}`}>
              {sourceLabel(reservation.source)}
            </em>
          ) : null}
          {!roomCode ? <em>추가·대기 칸은 나중에 방을 배정할 수 있습니다.</em> : null}
        </div>
        {reservation ? (
          <div className="quick-operation-panel">
            <div className="quick-operation-head">
              <div>
                <span className={`booking-status status-${reservation.status}`}>
                  {STATUS_LABELS[reservation.status] ?? reservation.status}
                </span>
                <strong>입장·게임 제어</strong>
              </div>
              <small>
                {roomConfig
                  ? `${roomConfig.name} · ${liveRoom ? ROOM_STATUS_LABELS[liveRoom.status] : "상태 불러오는 중"}`
                  : "방을 배정해주세요"}
              </small>
            </div>
            <div className="quick-game-controls">
              <button
                type="button"
                className={reservation.status === "arrived" ? "undo-arrive-button" : "arrive-button"}
                disabled={isClosed || Boolean(busy)}
                onClick={() =>
                  void mutate(
                    { action: reservation.status === "arrived" ? "undo_arrive" : "arrive" },
                    reservation.status === "arrived"
                      ? "입장 처리를 원복했습니다."
                      : "입장 처리했습니다.",
                  )
                }
              >
                {reservation.status === "arrived" ? "입장 원복" : "입장 처리"}
              </button>
              <button type="button" className="manager-load-button" disabled={isClosed || Boolean(busy) || !agentReady || !roomCode} onClick={() => void sendManager("set_info")}>관리자에 입력</button>
              <button type="button" className="game-start-button" disabled={isClosed || Boolean(busy) || !agentReady || !roomCode || liveRoom?.status === "running"} onClick={() => void sendManager("start")}>{manualStartMode ? "게임 시작 · 수동" : "게임 시작"}</button>
              <button type="button" className="quick-stop-button" disabled={Boolean(busy) || !agentReady || liveRoom?.status !== "running"} onClick={() => void stopGame()}>게임 정지</button>
            </div>
            {!agentReady ? <p className="quick-control-hint">매장 관리자 프로그램이 연결되면 게임 제어 버튼이 활성화됩니다.</p> : null}

            <div className="quick-payment-panel">
              <div className="quick-payment-head">
                <strong>결제 처리</strong>
                <span>{reservation.paymentStatus === "paid" ? `${PAYMENT_LABELS[reservation.paymentMethod] ?? "결제"} ${won(reservation.paymentAmount)}원 완료` : "미결제"}</span>
              </div>
              <div className="quick-payment-grid">
                <label><span>추가 금액</span><input type="number" min="0" step="500" disabled={isCancelled} value={addOnAmount} onChange={(event) => setAddOnAmount(Math.max(0, Number(event.target.value) || 0))} /></label>
                <label><span>할인 금액</span><input type="number" min="0" step="500" disabled={isCancelled} value={discountAmount} onChange={(event) => setDiscountAmount(Math.max(0, Number(event.target.value) || 0))} /></label>
                <label><span>결제 수단</span><select disabled={isCancelled} value={paymentMethod} onChange={(event) => setPaymentMethod(event.target.value)}>{Object.entries(PAYMENT_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
                {paymentMethod === "mixed" ? (
                  <div className="mixed-payment-grid">
                    {SHARED_PAYMENT_METHODS.map((method) => (
                      <label key={method.value}>
                        <span>{method.label} 금액</span>
                        <input
                          type="number"
                          min="0"
                          step="500"
                          disabled={isCancelled}
                          value={mixedPayment[method.value] || ""}
                          placeholder="0"
                          onChange={(event) =>
                            setMixedPayment((current) => ({
                              ...current,
                              [method.value]: Math.max(
                                0,
                                Math.trunc(Number(event.target.value) || 0),
                              ),
                            }))
                          }
                        />
                      </label>
                    ))}
                    <span className={paymentSplitTotal(mixedPayment) === paymentDue ? "is-balanced" : "is-unbalanced"}>
                      합계 {won(paymentSplitTotal(mixedPayment))}원 / 결제할 금액 {won(paymentDue)}원
                    </span>
                  </div>
                ) : null}
                {depositAmount ? <div className="quick-payment-deposit"><span>네이버 예약금</span><strong>{won(depositAmount)}원</strong></div> : null}
                <div className="quick-payment-total"><span>현장 결제할 금액</span><strong>{won(paymentDue)}원</strong></div>
              </div>
              <button type="button" className="quick-payment-save" disabled={Boolean(busy) || Boolean(isCancelled)} onClick={() => void savePayment()}>결제 저장</button>
            </div>
          </div>
        ) : (
          <p className="quick-control-hint">예약 칸을 저장하면 이 창에서 결제와 게임 제어를 바로 할 수 있습니다.</p>
        )}
        {error ? <p className="quick-booking-error" role="alert">{error}</p> : null}
        {notice ? <p className="quick-booking-notice" role="status">{notice}</p> : null}

        <div className="quick-booking-actions">
          {reservation && isClosed ? <button type="button" className="quick-delete-button" disabled={Boolean(busy)} onClick={() => void deleteRecord()}>{busy === "delete" ? "삭제 중…" : "완료·취소 기록 삭제"}</button> : null}
          {reservation && !isClosed ? <button type="button" className="quick-clear-button" disabled={Boolean(busy)} onClick={() => void clearCell()}>{busy === "cancel" ? "처리 중…" : "칸 비우기"}</button> : null}
          {reservation && reservation.status !== "cancelled" && nextOperatingSlot(reservation.scheduledTime) ? <button type="button" className="quick-copy-button" disabled={Boolean(busy)} onClick={() => void copyNextGame()}>{busy === "copy" ? "복사 중…" : `한판 더 · ${nextOperatingSlot(reservation.scheduledTime)}`}</button> : null}
          <button type="button" className="quick-cancel-button" disabled={Boolean(busy)} onClick={onClose}>닫기</button>
          <button type="button" className="quick-save-button" disabled={Boolean(busy) || Boolean(isCancelled)} onClick={() => void save()}>{busy === "save" ? "저장 중…" : reservation ? "예약 내용 저장" : "예약 칸 추가"}</button>
        </div>
      </section>
    </div>
  );
}

function expectedAmount(reservation: ReservationRecord) {
  return Math.max(
    0,
    reservation.baseAmount + reservation.addOnAmount - reservation.discountAmount,
  );
}

function isCurrentSlot(date: string, selectedDate: string, time: string) {
  if (date !== selectedDate) return false;
  return currentOperatingSlot(timeInSeoul(), OPERATING_SLOTS) === time;
}

function RemoteControlPanel({
  status,
  reservations,
  error,
  busy,
  notice,
  manualStartMode,
  controlPinned,
  serverClockOffsetMs,
  onCommand,
  onStartNeedsInfo,
  onRefresh,
  onTogglePin,
}: {
  status: StatusResponse | null;
  reservations: ReservationRecord[];
  error: string;
  busy: string;
  notice: string;
  manualStartMode: boolean;
  controlPinned: boolean;
  serverClockOffsetMs: number;
  onCommand: (room: Room | null, action: ControlAction) => Promise<void>;
  onStartNeedsInfo: (roomCode: string) => void;
  onRefresh: () => Promise<void>;
  onTogglePin: () => void;
}) {
  const [clientNow, setClientNow] = useState(() => Date.now());
  const hasRunningRoom = Boolean(
    status?.rooms.some((room) => room.status === "running"),
  );
  useEffect(() => {
    const updateClock = () => setClientNow(Date.now());
    updateClock();
    const interval = window.setInterval(
      updateClock,
      hasRunningRoom ? 1_000 : 30_000,
    );
    window.addEventListener("focus", updateClock);
    document.addEventListener("visibilitychange", updateClock);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", updateClock);
      document.removeEventListener("visibilitychange", updateClock);
    };
  }, [hasRunningRoom]);

  const serverNow = clientNow + serverClockOffsetMs;
  const runningCount = status?.rooms.filter((room) => room.status === "running").length ?? 0;
  const agentReady = Boolean(
    status?.store.agentOnline &&
      status.store.controlArmed &&
      status.store.managerVisible,
  );
  return (
    <section className="integrated-control-panel" id="live-control">
      <div className="integrated-section-heading">
        <div>
          <p className="eyebrow">LIVE CONTROL</p>
          <h2>매장 실시간 원격제어</h2>
          <p>현재 매장 상태가 표시됩니다. 00:00이 되어도 자동 종료되지 않으며 정지 버튼으로 종료합니다.</p>
        </div>
        <div className="control-heading-actions">
          <button
            type="button"
            className={`control-pin-toggle ${controlPinned ? "is-enabled" : ""}`}
            aria-pressed={controlPinned}
            onClick={onTogglePin}
          >
            {controlPinned ? "고정 해제" : "상단 고정"}
          </button>
          <span className={`connection-pill ${agentReady ? "is-online" : "is-offline"}`}>
            <span className="status-dot" />
            {!status?.store.agentOnline
              ? "매장 오프라인"
              : !status.store.managerVisible
                ? "관리자 창 없음"
                : status.store.controlArmed
                  ? `매장 연결 · ${runningCount}개 진행 중`
                  : "연결됨 · 안전 잠금"}
          </span>
          <button type="button" className="control-refresh" onClick={() => void onRefresh()}>
            상태 새로고침
          </button>
          <button
            type="button"
            className="integrated-all-stop"
            disabled={!agentReady || runningCount === 0 || Boolean(busy)}
            onClick={() => void onCommand(null, "all_stop")}
          >
            전체 정지
          </button>
        </div>
      </div>

      {error ? <div className="control-inline-error">{error}</div> : null}
      {notice ? <div className="control-inline-notice" role="status">{notice}</div> : null}

      <div className="integrated-room-grid">
        {SCHEDULE_ROOM_CODES.map((roomCode) => {
          const config = getRoom(roomCode);
          const room = status?.rooms.find((item) => item.roomId === config?.roomId);
          const roomBusy = Boolean(room && busy.startsWith(`${room.roomId}:`));
          const roomRunning = room?.status === "running";
          const roomProblem = !status
            ? ""
            : !status.store.agentOnline
              ? "매장 연결 문제"
              : !status.store.managerVisible
                ? "관리자 프로그램 확인 필요"
                : !room || room.status === "offline"
                  ? "방 연결 문제"
                  : room.status === "error"
                    ? "방 오류 발생"
                    : "";
          const liveRemainingSeconds = roomRunning && room
            ? correctedRemainingSeconds(room, serverNow)
            : 0;
          const liveRoom = room
            ? { ...room, remainingSeconds: liveRemainingSeconds }
            : undefined;
          const availability = roomProblem
            ? null
            : estimateAvailability(liveRoom, roomCode, reservations, serverNow);
          const availabilityMinutes = availability
            ? Math.ceil(availability.availableSeconds / 60)
            : 0;
          const queuedMinutes =
            (availability?.queuedReservations ?? 0) * GAME_DURATION_MINUTES;
          const missingStartInfo = Boolean(
            room && (
              manualStartMode
                ? !room.teamName
                : !room.teamName || !room.mapIndex || !room.people
            ),
          );
          return (
            <article className={`integrated-room-card room-${room?.status ?? "offline"}`} key={roomCode}>
              <div className="integrated-room-head">
                <div><small>{config?.size}</small><strong>{config?.name}</strong></div>
                <span>{room ? ROOM_STATUS_LABELS[room.status] : "불러오는 중"}</span>
              </div>
              <div className="integrated-room-timer">
                <span>실제 남은시간</span>
                <strong>{roomRunning ? formatRemaining(liveRemainingSeconds) : "00:00"}</strong>
              </div>
              <div className={`room-availability ${roomProblem ? "is-unknown" : !status ? "is-loading" : availabilityMinutes ? "is-later" : "is-now"}`}>
                <span>이용 가능 예상</span>
                <strong>
                  <span>
                    {roomProblem
                      ? roomProblem
                      : !status
                        ? "상태 확인 중"
                        : !availability
                          ? "이용 가능 확인 중"
                      : availabilityMinutes > 0
                        ? `${availabilityMinutes}분 후 이용 가능`
                        : "지금 이용 가능"}
                  </span>
                  {availability && availabilityMinutes > 0 ? (
                    <b>{availability.availableAt} 예상</b>
                  ) : null}
                </strong>
                {roomProblem ? (
                  <small>매장 연결과 관리자 프로그램 상태를 확인해주세요.</small>
                ) : availability ? (
                  <small>
                    {availabilityMinutes > 0
                      ? availability.basis === "schedule"
                        ? `다음 예약 ${availability.nextReservationTime} 반영`
                        : `실제 남은 ${Math.ceil(liveRemainingSeconds / 60)}분${queuedMinutes ? ` + 다음 예약 게임 ${queuedMinutes}분` : ""}`
                      : availability.nextReservationTime
                        ? `다음 예약 ${availability.nextReservationTime}`
                        : "이후 예약 없음"}
                  </small>
                ) : null}
              </div>
              <div className="integrated-room-info">
                <span><small>팀명</small><b>{room?.teamName || "—"}</b></span>
                <span><small>맵</small><b>{room?.mapName || room?.level || "—"}</b></span>
                <span><small>인원</small><b>{room?.people ? `${room.people}명` : "—"}</b></span>
              </div>
              <div className="integrated-room-actions">
                <button
                  type="button"
                  className="integrated-start"
                  disabled={
                    !agentReady ||
                    !room ||
                    room.status === "running" ||
                    roomBusy
                  }
                  onClick={() => {
                    if (!room) return;
                    if (missingStartInfo) onStartNeedsInfo(roomCode);
                    else void onCommand(room, "start");
                  }}
                  title={
                    missingStartInfo
                      ? `예약 칸을 열어 ${manualStartMode ? "팀명" : "팀명·난이도·인원"}을 입력합니다.`
                      : manualStartMode
                        ? "팀명만 빠르게 입력하고 매장에서 난이도를 선택해 수동으로 시작합니다."
                        : "게임 시작"
                  }
                >
                  {manualStartMode ? "게임 시작 · 수동" : "게임 시작"}
                </button>
                <button
                  type="button"
                  className="integrated-stop"
                  disabled={!agentReady || !room || room.status !== "running" || roomBusy}
                  onClick={() => room && void onCommand(room, "stop")}
                >
                  정지
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function ScheduleBoard({
  selectedDate,
  today,
  reservations,
  onSelect,
  onMove,
  onStatusChange,
  cancellationFeeAmount,
  standalone = false,
}: {
  selectedDate: string;
  today: string;
  reservations: ReservationRecord[];
  onSelect: (selection: ScheduleSelection) => void;
  onMove: (reservation: ReservationRecord, time: string, roomCode: string) => Promise<void>;
  onStatusChange: (
    reservation: ReservationRecord,
    action: "arrive" | "undo_arrive",
  ) => Promise<void>;
  cancellationFeeAmount: number;
  standalone?: boolean;
}) {
  const [dragTarget, setDragTarget] = useState("");
  const [movingId, setMovingId] = useState("");
  const [moveNotice, setMoveNotice] = useState("");
  const [statusBusyId, setStatusBusyId] = useState("");
  const [hidePastSlots, setHidePastSlots] = useState(true);
  const suppressSelectionUntil = useRef(0);
  const pointerDrag = useRef<{
    reservation: ReservationRecord;
    pointerId: number;
    targetKey: string;
  } | null>(null);
  const scheduleReservations = reservations.filter(
    (reservation) => reservation.status !== "cancelled" && reservation.roomCode,
  );
  const cellMap = new Map<string, ReservationRecord[]>();
  scheduleReservations.forEach((reservation) => {
    const key = `${reservation.scheduledTime}|${reservation.roomCode}`;
    const values = cellMap.get(key) ?? [];
    values.push(reservation);
    cellMap.set(key, values);
  });
  const unassignedByTime = new Map<string, ReservationRecord[]>();
  reservations
    .filter((reservation) => reservation.status !== "cancelled" && !reservation.roomCode)
    .forEach((reservation) => {
      const list = unassignedByTime.get(reservation.scheduledTime) ?? [];
      list.push(reservation);
      unassignedByTime.set(reservation.scheduledTime, list);
    });
  const currentSlot =
    selectedDate === today
      ? currentOperatingSlot(timeInSeoul(), OPERATING_SLOTS)
      : "";
  const currentSlotIndex = OPERATING_SLOTS.indexOf(currentSlot);
  const visibleOperatingSlots =
    hidePastSlots && currentSlotIndex >= 0
      ? OPERATING_SLOTS.slice(Math.max(0, currentSlotIndex - 1))
      : OPERATING_SLOTS;

  function finishPointerDrag() {
    suppressSelectionUntil.current = Date.now() + 350;
    pointerDrag.current = null;
    setMovingId("");
    setDragTarget("");
  }

  function beginPointerDrag(
    event: React.PointerEvent<HTMLElement>,
    reservation: ReservationRecord,
  ) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    suppressSelectionUntil.current = Date.now() + 5_000;
    pointerDrag.current = {
      reservation,
      pointerId: event.pointerId,
      targetKey: `${reservation.scheduledTime}|${reservation.roomCode}`,
    };
    setMovingId(reservation.id);
    setDragTarget(`${reservation.scheduledTime}|${reservation.roomCode}`);
    setMoveNotice("");
  }

  function trackPointerDrag(event: React.PointerEvent<HTMLElement>) {
    const active = pointerDrag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    event.preventDefault();
    const target = document
      .elementFromPoint(event.clientX, event.clientY)
      ?.closest<HTMLElement>("[data-schedule-drop-key]");
    const targetKey = target?.dataset.scheduleDropKey ?? "";
    active.targetKey = targetKey;
    setDragTarget(targetKey);
  }

  function selectReservation(
    event: React.MouseEvent<HTMLButtonElement>,
    selection: ScheduleSelection,
  ) {
    if (Date.now() < suppressSelectionUntil.current) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    onSelect(selection);
  }

  async function moveReservationTo(
    reservation: ReservationRecord,
    time: string,
    roomCode: string,
  ) {
    suppressSelectionUntil.current = Date.now() + 350;
    if (reservation.status === "completed" || reservation.status === "cancelled") return;
    if (reservation.scheduledTime === time && reservation.roomCode === roomCode) {
      setMoveNotice("이미 같은 칸에 있는 예약입니다.");
      return;
    }
    try {
      await onMove(reservation, time, roomCode);
      setMoveNotice(`${reservation.teamName || reservation.customerName || "예약"}을(를) ${time} ${getRoom(roomCode)?.name}으로 이동했습니다.`);
    } catch (reason) {
      setMoveNotice(reason instanceof Error ? reason.message : "예약을 이동하지 못했습니다.");
    }
  }

  function endPointerDrag(event: React.PointerEvent<HTMLElement>) {
    const active = pointerDrag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const { reservation, targetKey } = active;
    finishPointerDrag();
    if (!targetKey) return;
    const separator = targetKey.indexOf("|");
    const time = targetKey.slice(0, separator);
    const roomCode = targetKey.slice(separator + 1);
    if (separator > 0 && time && roomCode) {
      void moveReservationTo(reservation, time, roomCode);
    }
  }

  function cancelPointerDrag(event: React.PointerEvent<HTMLElement>) {
    if (pointerDrag.current?.pointerId !== event.pointerId) return;
    finishPointerDrag();
  }

  async function toggleArrival(reservation: ReservationRecord) {
    const action = reservation.status === "arrived" ? "undo_arrive" : "arrive";
    setStatusBusyId(reservation.id);
    setMoveNotice("");
    try {
      await onStatusChange(reservation, action);
      setMoveNotice(
        action === "arrive"
          ? `${reservation.teamName || reservation.customerName || "예약"}을(를) 입장 처리했습니다.`
          : `${reservation.teamName || reservation.customerName || "예약"}의 입장 처리를 원복했습니다.`,
      );
    } catch (reason) {
      setMoveNotice(reason instanceof Error ? reason.message : "입장 상태를 변경하지 못했습니다.");
    } finally {
      setStatusBusyId("");
    }
  }

  return (
    <section className="schedule-panel" id="full-schedule">
      <div className="integrated-section-heading schedule-heading">
        <div className="schedule-heading-copy">
          <p className="eyebrow">FULL DAY SCHEDULE</p>
          <h2>전체 시간대별 예약 현황</h2>
          <p>예약 카드의 ‘이동’ 손잡이를 끌어 원하는 시간·방으로 옮길 수 있습니다. 같은 칸에 여러 예약도 배치할 수 있습니다.</p>
        </div>
        <div className="schedule-heading-tools">
          {!standalone ? (
            <a
              className="schedule-expand-link"
              href={`/admin/schedule?date=${encodeURIComponent(selectedDate)}`}
              target="_blank"
              rel="noreferrer"
            >
              <span aria-hidden="true">↗</span> 크게 보기
            </a>
          ) : null}
          <label className={`schedule-past-toggle ${hidePastSlots ? "is-enabled" : ""}`}>
            <input
              type="checkbox"
              checked={hidePastSlots}
              disabled={selectedDate !== today}
              onChange={(event) => setHidePastSlots(event.target.checked)}
            />
            <span>지난 시간 숨김</span>
          </label>
          <div className="schedule-legend" aria-label="시간표 상태 안내">
            <span className="legend-booked">예약</span>
            <span className="legend-arrived">입장</span>
            <span className="legend-completed">완료</span>
            <span className="legend-paid">결제완료</span>
          </div>
        </div>
      </div>
      {moveNotice ? <p className="schedule-move-notice" role="status">{moveNotice}</p> : null}

      <div className="schedule-scroll">
        <table className="schedule-table">
          <thead>
            <tr>
              <th className="schedule-time-column">시간</th>
              {SCHEDULE_ROOM_CODES.map((code) => (
                <th key={code}>
                  <strong>{getRoom(code)?.name}</strong>
                  <small>{getRoom(code)?.min}~{getRoom(code)?.max}명</small>
                </th>
              ))}
              <th className="schedule-total-column">합계</th>
            </tr>
          </thead>
          <tbody>
            {visibleOperatingSlots.map((time) => {
              const rowReservations = SCHEDULE_ROOM_CODES.flatMap((roomCode) =>
                cellMap.get(`${time}|${roomCode}`) ?? [],
              );
              const unassigned = unassignedByTime.get(time) ?? [];
              const allAtTime = [...rowReservations, ...unassigned];
              const rowAmount = allAtTime.reduce(
                (sum, reservation) =>
                  sum + scheduleRevenueAmount(reservation, cancellationFeeAmount),
                0,
              );
              const current = isCurrentSlot(today, selectedDate, time);
              return (
                <tr className={current ? "is-current-slot" : ""} key={time}>
                  <th className="schedule-time-column">
                    <strong>{time}</strong>
                    {current ? <span>현재</span> : null}
                  </th>
                  {SCHEDULE_ROOM_CODES.map((roomCode) => {
                    const key = `${time}|${roomCode}`;
                    const cellReservations = cellMap.get(key) ?? [];
                    if (cellReservations.length === 0) {
                      return (
                        <td
                          className={`schedule-empty schedule-drop-zone ${dragTarget === key ? "is-drag-target" : ""}`}
                          key={roomCode}
                          data-schedule-drop-key={key}
                        >
                          <button type="button" onClick={() => onSelect({ time, roomCode })}>
                            <strong>＋</strong><span>직접 입력</span>
                          </button>
                        </td>
                      );
                    }
                    return (
                      <td
                        className={`schedule-filled schedule-drop-zone ${cellReservations.length > 1 ? "has-overlap" : ""} ${dragTarget === key ? "is-drag-target" : ""}`}
                        key={roomCode}
                        data-schedule-drop-key={key}
                      >
                        <div className="schedule-cell-stack">
                          {cellReservations.map((reservation) => {
                            const amount = scheduleRevenueAmount(
                              reservation,
                              cancellationFeeAmount,
                            );
                            return (
                              <article
                                className={`schedule-reservation-item cell-${reservation.status}`}
                                key={reservation.id}
                              >
                                <button
                                  type="button"
                                  className={`schedule-reservation-chip ${movingId === reservation.id ? "is-dragging" : ""}`}
                                  onClick={(event) =>
                                    selectReservation(event, {
                                      time,
                                      roomCode,
                                      reservation,
                                    })
                                  }
                                  title={reservation.status === "completed" ? "완료된 예약" : "클릭하여 상세 관리"}
                                >
                                  {reservation.status !== "completed" ? (
                                    <span
                                      className="schedule-drag-handle"
                                      onPointerDown={(event) => beginPointerDrag(event, reservation)}
                                      onPointerMove={trackPointerDrag}
                                      onPointerUp={endPointerDrag}
                                      onPointerCancel={cancelPointerDrag}
                                      onClick={(event) => {
                                        event.preventDefault();
                                        event.stopPropagation();
                                      }}
                                      title="끌어서 예약 이동"
                                    >
                                      <b aria-hidden="true">⠿</b>
                                      <small>이동</small>
                                    </span>
                                  ) : null}
                                  <span className="schedule-cell-top">
                                    <b>{reservation.teamName || reservation.customerName || "팀명 미정"}</b>
                                    <em>{reservation.totalCount ? `${reservation.totalCount}명` : "인원 미정"}</em>
                                  </span>
                                  <span className="schedule-source-row">
                                    <span className={`schedule-source source-${reservation.source}`}>
                                      {sourceLabel(reservation.source)}
                                    </span>
                                    {reservation.source === "naver" && reservation.customerName ? (
                                      <strong className="schedule-naver-customer">
                                        예약자 {reservation.customerName}
                                      </strong>
                                    ) : null}
                                    {naverSameDayCancellationFee(
                                      reservation,
                                      cancellationFeeAmount,
                                    ) ? (
                                      <strong className="schedule-cancellation-fee">
                                        당일 취소 수수료 {won(cancellationFeeAmount)}원
                                      </strong>
                                    ) : null}
                                  </span>
                                  {reservation.vehicleLast4 ? (
                                    <span className="schedule-vehicle-badge">
                                      차량 {reservation.vehicleLast4}
                                    </span>
                                  ) : null}
                                  <small>{reservation.difficultyLabel || "난이도 미정"}</small>
                                  <span className="schedule-cell-bottom">
                                    <b>{won(amount)}원</b>
                                    <em className={reservation.paymentStatus === "paid" ? "is-paid" : "is-unpaid"}>
                                      {reservation.paymentStatus === "paid" ? "결제" : "미결제"}
                                    </em>
                                  </span>
                                </button>
                                {reservation.status === "booked" || reservation.status === "arrived" ? (
                                  <button
                                    type="button"
                                    className={`schedule-arrival-toggle ${reservation.status === "arrived" ? "is-arrived" : ""}`}
                                    disabled={statusBusyId === reservation.id}
                                    onClick={(event) => {
                                      event.preventDefault();
                                      event.stopPropagation();
                                      void toggleArrival(reservation);
                                    }}
                                  >
                                    {statusBusyId === reservation.id
                                      ? "처리 중…"
                                      : reservation.status === "arrived"
                                        ? "● 입장 완료 · 원복"
                                        : "입장 처리"}
                                  </button>
                                ) : null}
                              </article>
                            );
                          })}
                          <button type="button" className="schedule-add-overlap" onClick={() => onSelect({ time, roomCode })}>＋ 같은 칸 추가</button>
                        </div>
                      </td>
                    );
                  })}
                  <td className="schedule-row-total">
                    <strong>{rowReservations.length}건</strong>
                    <small>{rowAmount ? `${won(rowAmount)}원` : "—"}</small>
                    <div className="overflow-cell-list">
                      {unassigned.map((reservation, index) => (
                        <button
                          type="button"
                          key={reservation.id}
                          onClick={(event) =>
                            selectReservation(event, {
                              time,
                              roomCode: "",
                              reservation,
                            })
                          }
                        >
                          {reservation.status !== "completed" ? (
                            <span
                              className="schedule-drag-handle schedule-drag-handle-compact"
                              onPointerDown={(event) => beginPointerDrag(event, reservation)}
                              onPointerMove={trackPointerDrag}
                              onPointerUp={endPointerDrag}
                              onPointerCancel={cancelPointerDrag}
                              onClick={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                              }}
                              title="끌어서 예약 이동"
                            >
                              <b aria-hidden="true">⠿</b>
                            </span>
                          ) : null}
                          대기 {index + 1}
                          {reservation.vehicleLast4
                            ? ` · 차량 ${reservation.vehicleLast4}`
                            : ""}
                        </button>
                      ))}
                      <button type="button" className="add-overflow-cell" onClick={() => onSelect({ time, roomCode: "" })}>
                        ＋ 추가·대기
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ReservationCard({
  reservation,
  manualStartMode,
  onChanged,
  onEdit,
  onOpenCopied,
  pricing,
}: {
  reservation: ReservationRecord;
  manualStartMode: boolean;
  onChanged: (change: ReservationListChange) => Promise<void>;
  onEdit: () => void;
  onOpenCopied: (reservation: ReservationRecord) => void;
  pricing: PricingSettings;
}) {
  const [addOnAmount, setAddOnAmount] = useState(reservation.addOnAmount);
  const [discountAmount, setDiscountAmount] = useState(reservation.discountAmount);
  const [paymentMethod, setPaymentMethod] = useState(reservation.paymentMethod || "card");
  const [mixedPayment, setMixedPayment] = useState<PaymentSplit>({
    card: reservation.paymentCardAmount,
    cash: reservation.paymentCashAmount,
    account: reservation.paymentAccountAmount,
  });
  const [memo, setMemo] = useState(reservation.memo);
  const [assignedRoom, setAssignedRoom] = useState(reservation.roomCode);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const room = getRoom(reservation.roomCode);
  const nextSlot = nextOperatingSlot(reservation.scheduledTime);
  const grossPaymentAmount = Math.max(
    0,
    reservation.baseAmount + addOnAmount - discountAmount,
  );
  const depositAmount = reservationDeposit(
    reservation.source,
    grossPaymentAmount,
    pricing.naverDepositAmount,
  );
  const paymentDue = Math.max(0, grossPaymentAmount - depositAmount);
  const isClosed = reservation.status === "cancelled" || reservation.status === "completed";

  useEffect(() => {
    setAssignedRoom(reservation.roomCode);
  }, [reservation.id, reservation.roomCode]);

  async function mutate(command: Mutation, success: string) {
    setBusy(command.action);
    setNotice("");
    try {
      const response = await fetch("/api/admin/reservations", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: reservation.id, ...command }),
      });
      const data = (await response.json()) as {
        reservation?: ReservationRecord;
        error?: string;
      };
      if (!response.ok || !data.reservation) {
        throw new Error(data.error ?? "처리하지 못했습니다.");
      }
      setNotice(success);
      await onChanged({ type: "upsert", reservation: data.reservation });
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : "처리하지 못했습니다.");
    } finally {
      setBusy("");
    }
  }

  async function saveSettlement() {
    const split = paymentSplitForSave(paymentMethod, paymentDue, mixedPayment);
    if (paymentMethod === "mixed" && paymentSplitTotal(split) !== paymentDue) {
      setNotice(
        `복합결제 합계가 맞지 않습니다. 현재 ${won(paymentSplitTotal(split))}원 / 필요 ${won(paymentDue)}원`,
      );
      return;
    }
    await mutate(
      {
        action: "payment",
        addOnAmount,
        discountAmount,
        paymentAmount: grossPaymentAmount,
        paymentCardAmount: split.card,
        paymentCashAmount: split.cash,
        paymentAccountAmount: split.account,
        paymentMethod,
      },
      "결제 내역을 저장했습니다.",
    );
  }

  async function copyNextGame() {
    if (!nextSlot || !window.confirm(
      `${reservation.teamName} 팀 정보를 ${nextSlot} 같은 방에 복사할까요?\n결제는 복사하지 않고 미결제로 만듭니다.`,
    )) return;
    setBusy("copy");
    setNotice("");
    try {
      const response = await fetch("/api/admin/reservations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ copyFromId: reservation.id }),
      });
      const data = (await response.json()) as {
        reservation?: ReservationRecord;
        error?: string;
      };
      if (!response.ok || !data.reservation) {
        throw new Error(data.error ?? "다음 타임 예약을 만들지 못했습니다.");
      }
      setNotice(`${data.reservation.scheduledTime} 같은 방에 미결제로 복사했습니다.`);
      await onChanged({ type: "upsert", reservation: data.reservation });
      onOpenCopied(data.reservation);
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : "다음 타임 예약을 만들지 못했습니다.");
    } finally {
      setBusy("");
    }
  }

  async function deleteRecord() {
    if (!isClosed || !window.confirm(
      `${reservation.teamName || "이 예약"}의 ${STATUS_LABELS[reservation.status] ?? reservation.status} 기록을 완전히 삭제할까요?`,
    )) return;
    setBusy("delete");
    setNotice("");
    try {
      const response = await fetch("/api/admin/reservations", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: reservation.id }),
      });
      const data = (await response.json()) as { id?: string; error?: string };
      if (!response.ok || !data.id) {
        throw new Error(data.error ?? "예약 기록을 삭제하지 못했습니다.");
      }
      await onChanged({ type: "remove", id: data.id });
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : "예약 기록을 삭제하지 못했습니다.");
    } finally {
      setBusy("");
    }
  }

  async function sendManager(action: "set_info" | "start") {
    if (!room || !reservation.mapIndex || !reservation.teamName.trim()) {
      setNotice("팀명, 방, 난이도 정보가 있어야 관리자 프로그램에 입력할 수 있습니다.");
      return;
    }
    const manualStartOnly = action === "start" && manualStartMode;
    const informationOnly = action === "set_info" || manualStartOnly;
    if (
      action === "start" &&
      !manualStartMode &&
      !window.confirm(
        `${room.name}에서 ${reservation.teamName} 팀 게임을 시작할까요?\n16:00부터 카운트다운됩니다.`,
      )
    ) return;

    setBusy(action);
    setNotice("");
    try {
      const response = await fetch("/api/commands", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          roomId: room.roomId,
          action: informationOnly ? "set_info" : "start",
          teamName: reservation.teamName,
          mapIndex: manualStartOnly ? 0 : reservation.mapIndex,
          people: 0,
          skipPeople: true,
          durationMinutes: GAME_DURATION_MINUTES,
        }),
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(data.error ?? "관리자 프로그램 명령을 보내지 못했습니다.");
      if (informationOnly) {
        await mutate(
          { action: "manager_loaded" },
          manualStartMode && action === "start"
            ? "팀명만 빠르게 입력했습니다. 매장에서 난이도를 선택하고 시작 버튼을 눌러주세요."
            : "관리자 프로그램에 팀명·난이도를 빠르게 입력했습니다. 인원은 변경하지 않았습니다.",
        );
      } else {
        setNotice(`${room.name} 게임 시작 명령을 보냈습니다.`);
      }
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : "관리자 프로그램 명령을 보내지 못했습니다.");
    } finally {
      if (action === "start") setBusy("");
    }
  }

  return (
    <article
      className={`booking-card booking-${reservation.status}`}
      id={`booking-${reservation.id}`}
    >
      <div className="booking-time-block">
        <strong>{reservation.scheduledTime || "시간 미정"}</strong>
        <span>{room?.name ?? (reservation.roomCode || "방 미정")}</span>
      </div>
      <div className="booking-main">
        <div className="booking-title-row">
          <div>
            <span className={`booking-status status-${reservation.status}`}>
              {STATUS_LABELS[reservation.status] ?? reservation.status}
            </span>
            <span className={`booking-source source-${reservation.source}`}>
              {sourceLabel(reservation.source)}
            </span>
            <h3>{reservation.teamName || reservation.customerName || "팀명 미입력"}</h3>
          </div>
          <strong className="booking-total">
            {reservation.totalCount ? `${reservation.totalCount}명` : "인원 미정"}
          </strong>
        </div>
        <div className="booking-facts">
          <span>난이도 <b>{reservation.difficultyLabel || "미정"}</b></span>
          <span>성인 {reservation.adultCount} · 청소년 {reservation.youthCount}</span>
          {reservation.vehicleLast4 ? <span>차량 {reservation.vehicleLast4}</span> : null}
          {reservation.customerName ? <span>예약자 {reservation.customerName}</span> : null}
          {reservation.customerPhone ? <span>연락처 {reservation.customerPhone}</span> : null}
          <span>예약번호 {reservation.bookingCode}</span>
        </div>
        <div className="booking-actions">
          <button
            type="button"
            className={reservation.status === "arrived" ? "undo-arrive-button" : "arrive-button"}
            disabled={isClosed || Boolean(busy)}
            onClick={() =>
              void mutate(
                { action: reservation.status === "arrived" ? "undo_arrive" : "arrive" },
                reservation.status === "arrived"
                  ? "입장 처리를 원복했습니다."
                  : "입장 처리했습니다.",
              )
            }
          >{reservation.status === "arrived" ? "입장 원복" : "입장 처리"}</button>
          <button
            className="manager-load-button"
            type="button"
            disabled={isClosed || Boolean(busy)}
            onClick={() => void sendManager("set_info")}
          >
            {busy === "set_info" || busy === "manager_loaded"
              ? "입력 중…"
              : reservation.managerLoadedAt
                ? "관리자에 다시 입력"
                : "관리자에 입력"}
          </button>
          <button
            className="game-start-button"
            type="button"
            disabled={isClosed || Boolean(busy)}
            onClick={() => void sendManager("start")}
          >{busy === "start" ? "전송 중…" : manualStartMode ? "게임 시작 · 수동" : "게임 시작"}</button>
          {reservation.status !== "cancelled" && nextSlot ? (
            <button
              className="repeat-booking-button"
              type="button"
              disabled={Boolean(busy)}
              onClick={() => void copyNextGame()}
            >{busy === "copy" ? "복사 중…" : `한판 더 · ${nextSlot}`}</button>
          ) : null}
        </div>
        <div className="room-assignment-row">
          <label>
            <span>방 배정</span>
            <select value={assignedRoom} onChange={(event) => setAssignedRoom(event.target.value)}>
              <option value="">선택</option>
              {ROOM_OPTIONS.map((option) => (
                <option key={option.code} value={option.code}>{option.name}</option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={!assignedRoom || Boolean(busy) || isClosed || assignedRoom === reservation.roomCode}
            onClick={() => void mutate({ action: "assign", roomCode: assignedRoom }, "방 배정을 저장했습니다.")}
          >배정 저장</button>
        </div>
        <details className="booking-settlement" open={reservation.paymentStatus === "unpaid" && !isClosed}>
          <summary>
            결제·메모
            <span>
              {reservation.paymentStatus === "paid"
                ? `${PAYMENT_LABELS[reservation.paymentMethod] ?? "결제"} ${won(reservation.paymentAmount)}원`
                : `미결제 · 기본 ${won(reservation.baseAmount)}원`}
            </span>
          </summary>
          <div className="settlement-grid">
            <label><span>추가 금액</span><input type="number" min="0" step="500" value={addOnAmount} onChange={(event) => setAddOnAmount(Math.max(0, Number(event.target.value) || 0))} /></label>
            <label><span>할인 금액</span><input type="number" min="0" step="500" value={discountAmount} onChange={(event) => setDiscountAmount(Math.max(0, Number(event.target.value) || 0))} /></label>
            <label><span>결제 수단</span><select value={paymentMethod} onChange={(event) => setPaymentMethod(event.target.value)}>{Object.entries(PAYMENT_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            {paymentMethod === "mixed" ? (
              <div className="mixed-payment-grid">
                {SHARED_PAYMENT_METHODS.map((method) => (
                  <label key={method.value}>
                    <span>{method.label} 금액</span>
                    <input
                      type="number"
                      min="0"
                      step="500"
                      value={mixedPayment[method.value] || ""}
                      placeholder="0"
                      onChange={(event) =>
                        setMixedPayment((current) => ({
                          ...current,
                          [method.value]: Math.max(
                            0,
                            Math.trunc(Number(event.target.value) || 0),
                          ),
                        }))
                      }
                    />
                  </label>
                ))}
                <span className={paymentSplitTotal(mixedPayment) === paymentDue ? "is-balanced" : "is-unbalanced"}>
                  합계 {won(paymentSplitTotal(mixedPayment))}원 / 결제할 금액 {won(paymentDue)}원
                </span>
              </div>
            ) : null}
          </div>
          <div className="settlement-total">
            {depositAmount ? <span className="settlement-deposit">네이버 예약금 <b>{won(depositAmount)}원</b></span> : null}
            <span>현장 결제할 금액</span><strong>{won(paymentDue)}원</strong>
            <button type="button" disabled={Boolean(busy)} onClick={() => void saveSettlement()}>결제 저장</button>
          </div>
          <div className="memo-row">
            <textarea rows={2} maxLength={500} value={memo} onChange={(event) => setMemo(event.target.value)} placeholder="메모" />
            <button type="button" disabled={Boolean(busy)} onClick={() => void mutate({ action: "memo", memo }, "메모를 저장했습니다.")}>메모 저장</button>
          </div>
        </details>
        <div className="booking-footer-row">
          {notice
            ? <p role="status">{notice}</p>
            : <span>{reservation.managerLoadedAt ? "관리자 프로그램 입력 완료" : "게임은 자동 시작되지 않습니다."}</span>}
          {isClosed ? (
            <div className="closed-booking-actions">
              {reservation.status === "completed" ? (
                <button
                  className="edit-completed-booking"
                  type="button"
                  disabled={Boolean(busy)}
                  onClick={onEdit}
                >완료 예약 수정</button>
              ) : null}
              <button
                className="delete-booking"
                type="button"
                disabled={Boolean(busy)}
                onClick={() => void deleteRecord()}
              >{busy === "delete" ? "삭제 중…" : "기록 삭제"}</button>
            </div>
          ) : (
            <button
              className="cancel-booking"
              type="button"
              disabled={Boolean(busy)}
              onClick={() => {
                if (window.confirm("이 예약을 취소할까요?")) {
                  void mutate({ action: "cancel" }, "예약을 취소했습니다.");
                }
              }}
            >예약 취소</button>
          )}
        </div>
      </div>
    </article>
  );
}

export default function ReservationsAdmin({
  operatorName,
  initialDate,
  initialSelectedDate,
  pricing,
  scheduleOnly = false,
}: {
  operatorName: string;
  initialDate: string;
  initialSelectedDate?: string;
  pricing: PricingSettings;
  scheduleOnly?: boolean;
}) {
  const startingDate = initialSelectedDate ?? initialDate;
  const unitPrices = useMemo(() => sharedSalesUnitPrices(pricing), [pricing]);
  const [date, setDate] = useState(startingDate);
  const [reservations, setReservations] = useState<ReservationRecord[]>([]);
  const [todayReservations, setTodayReservations] = useState<ReservationRecord[]>([]);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [statusError, setStatusError] = useState("");
  const [serverClockOffsetMs, setServerClockOffsetMs] = useState(0);
  const [controlBusy, setControlBusy] = useState("");
  const [controlNotice, setControlNotice] = useState("");
  const [filter, setFilter] = useState<BookingFilter>("all");
  const [scheduleSelection, setScheduleSelection] = useState<ScheduleSelection | null>(null);
  const [manualStartMode, setManualStartMode] = useState(true);
  const [controlPinned, setControlPinned] = useState(false);
  const [detailPanelOpen, setDetailPanelOpen] = useState(false);
  const [sharedSalesEditMode, setSharedSalesEditMode] = useState(false);
  const [sharedSales, setSharedSales] = useState<DailySharedSales>(() =>
    emptySharedSales(startingDate),
  );
  const [sharedSalesDraft, setSharedSalesDraft] = useState<DailySharedSales>(() =>
    emptySharedSales(startingDate),
  );
  const [sharedSalesLoading, setSharedSalesLoading] = useState(true);
  const [sharedSalesSaving, setSharedSalesSaving] = useState(false);
  const [sharedSalesNotice, setSharedSalesNotice] = useState("");
  const selectedDateRef = useRef(date);
  const reservationRefreshDatesInFlight = useRef(new Set<string>());
  const todayRefreshInFlight = useRef(false);
  const statusRefreshInFlight = useRef(false);
  useEffect(() => {
    selectedDateRef.current = date;
  }, [date]);
  useEffect(() => {
    const wideScreen = window.matchMedia("(min-width: 1400px)");
    const applySavedPreference = () => {
      if (!wideScreen.matches) {
        setControlPinned(false);
        return;
      }
      setControlPinned(
        window.localStorage.getItem(CONTROL_PIN_STORAGE_KEY) !== "false",
      );
    };
    applySavedPreference();
    wideScreen.addEventListener("change", applySavedPreference);
    return () => wideScreen.removeEventListener("change", applySavedPreference);
  }, []);

  const refreshReservations = useCallback(async (quiet = false) => {
    const requestedDate = date;
    if (reservationRefreshDatesInFlight.current.has(requestedDate)) return;
    reservationRefreshDatesInFlight.current.add(requestedDate);
    if (!quiet) setLoading(true);
    try {
      const response = await fetch(
        `/api/admin/reservations?date=${encodeURIComponent(requestedDate)}`,
        { cache: "no-store" },
      );
      const data = (await response.json()) as {
        reservations?: ReservationRecord[];
        error?: string;
      };
      if (!response.ok) throw new Error(data.error ?? "예약 목록을 불러오지 못했습니다.");
      const nextReservations = data.reservations ?? [];
      if (selectedDateRef.current === requestedDate) {
        setReservations((current) =>
          sameReservationSnapshot(current, nextReservations)
            ? current
            : nextReservations,
        );
      }
      if (requestedDate === initialDate) {
        setTodayReservations((current) =>
          sameReservationSnapshot(current, nextReservations)
            ? current
            : nextReservations,
        );
      }
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "예약 목록을 불러오지 못했습니다.");
    } finally {
      reservationRefreshDatesInFlight.current.delete(requestedDate);
      if (!quiet) setLoading(false);
    }
  }, [date, initialDate]);

  const refreshStatus = useCallback(async () => {
    if (statusRefreshInFlight.current) return;
    statusRefreshInFlight.current = true;
    try {
      const requestedAt = Date.now();
      const response = await fetch("/api/status", { cache: "no-store" });
      const data = (await response.json()) as StatusResponse & { error?: string };
      if (!response.ok) throw new Error(data.error ?? "매장 상태를 불러오지 못했습니다.");
      const receivedAt = Date.now();
      const generatedAt = Date.parse(data.generatedAt);
      if (Number.isFinite(generatedAt)) {
        const measuredOffset = generatedAt - (requestedAt + receivedAt) / 2;
        setServerClockOffsetMs(Math.round(measuredOffset));
      }
      setStatus(data);
      setStatusError("");
    } catch (reason) {
      setStatusError(reason instanceof Error ? reason.message : "매장 상태를 불러오지 못했습니다.");
    } finally {
      statusRefreshInFlight.current = false;
    }
  }, []);

  const refreshTodayReservations = useCallback(async () => {
    if (todayRefreshInFlight.current) return;
    todayRefreshInFlight.current = true;
    try {
      const response = await fetch(
        `/api/admin/reservations?date=${encodeURIComponent(initialDate)}`,
        { cache: "no-store" },
      );
      const data = (await response.json()) as {
        reservations?: ReservationRecord[];
        error?: string;
      };
      if (!response.ok) throw new Error(data.error ?? "오늘 예약을 불러오지 못했습니다.");
      const nextReservations = data.reservations ?? [];
      setTodayReservations((current) =>
        sameReservationSnapshot(current, nextReservations)
          ? current
          : nextReservations,
      );
    } catch {
      // 상세 예약 목록 오류와 중복 표시하지 않고 다음 주기에 다시 시도한다.
    } finally {
      todayRefreshInFlight.current = false;
    }
  }, [initialDate]);

  const refreshSharedSales = useCallback(async () => {
    setSharedSalesLoading(true);
    setSharedSalesNotice("");
    try {
      const response = await fetch(
        `/api/admin/daily-sales?date=${encodeURIComponent(date)}`,
        { cache: "no-store" },
      );
      const data = (await response.json()) as {
        sales?: DailySharedSales;
        error?: string;
      };
      if (!response.ok || !data.sales) {
        throw new Error(data.error ?? "공용 매출을 불러오지 못했습니다.");
      }
      setSharedSales(data.sales);
    } catch (reason) {
      setSharedSales(emptySharedSales(date));
      setSharedSalesNotice(
        reason instanceof Error ? reason.message : "공용 매출을 불러오지 못했습니다.",
      );
    } finally {
      setSharedSalesLoading(false);
    }
  }, [date]);

  useEffect(() => {
    const refreshVisibleReservations = () => {
      if (!document.hidden) void refreshReservations(true);
    };
    const initialRefresh = window.setTimeout(() => void refreshReservations(), 0);
    const interval = window.setInterval(refreshVisibleReservations, 3_000);
    window.addEventListener("focus", refreshVisibleReservations);
    document.addEventListener("visibilitychange", refreshVisibleReservations);
    return () => {
      window.clearTimeout(initialRefresh);
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshVisibleReservations);
      document.removeEventListener("visibilitychange", refreshVisibleReservations);
    };
  }, [refreshReservations]);
  useEffect(() => {
    const refreshVisibleStatus = () => {
      if (!document.hidden) void refreshStatus();
    };
    const initialRefresh = window.setTimeout(() => void refreshStatus(), 0);
    const interval = window.setInterval(refreshVisibleStatus, 1_000);
    window.addEventListener("focus", refreshVisibleStatus);
    document.addEventListener("visibilitychange", refreshVisibleStatus);
    return () => {
      window.clearTimeout(initialRefresh);
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshVisibleStatus);
      document.removeEventListener("visibilitychange", refreshVisibleStatus);
    };
  }, [refreshStatus]);
  useEffect(() => {
    if (date === initialDate) return;
    const refreshVisibleTodayReservations = () => {
      if (!document.hidden) void refreshTodayReservations();
    };
    const initialRefresh = window.setTimeout(
      () => void refreshTodayReservations(),
      0,
    );
    const interval = window.setInterval(refreshVisibleTodayReservations, 3_000);
    window.addEventListener("focus", refreshVisibleTodayReservations);
    document.addEventListener("visibilitychange", refreshVisibleTodayReservations);
    return () => {
      window.clearTimeout(initialRefresh);
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshVisibleTodayReservations);
      document.removeEventListener("visibilitychange", refreshVisibleTodayReservations);
    };
  }, [date, initialDate, refreshTodayReservations]);

  const commitReservationChange = useCallback(
    async (change: ReservationListChange) => {
      setReservations((current) =>
        applyReservationListChange(current, change, date),
      );
      setTodayReservations((current) =>
        applyReservationListChange(current, change, initialDate),
      );

      void refreshReservations(true);
      if (date !== initialDate) void refreshTodayReservations();
    },
    [date, initialDate, refreshReservations, refreshTodayReservations],
  );
  useEffect(() => {
    const task = window.setTimeout(() => {
      setSharedSales(emptySharedSales(date));
      setSharedSalesDraft(emptySharedSales(date));
      setSharedSalesEditMode(false);
      void refreshSharedSales();
    }, 0);
    return () => window.clearTimeout(task);
  }, [date, refreshSharedSales]);

  function changeManualStartMode(enabled: boolean) {
    setManualStartMode(enabled);
    setControlNotice(
      enabled
        ? "수동 시작 모드: 게임 시작 버튼은 팀명만 빠르게 입력합니다."
        : "원격 시작 모드: 게임 시작 버튼이 16분 카운트다운을 시작합니다.",
    );
  }

  function toggleControlPin() {
    setControlPinned((current) => {
      const next = !current;
      window.localStorage.setItem(CONTROL_PIN_STORAGE_KEY, String(next));
      return next;
    });
  }

  function changeSharedSales(
    category: SharedSalesCategory,
    method: SharedPaymentMethod,
    count: number,
  ) {
    setSharedSalesDraft((current) => ({
      ...current,
      [category]: { ...current[category], [method]: count },
    }));
    setSharedSalesNotice("");
  }

  async function saveSharedSales() {
    if (
      !sharedSalesEditMode &&
      sharedSalesCount(sharedSalesDraft, unitPrices) === 0
    ) {
      setSharedSalesNotice("판매 개수를 입력해주세요.");
      return;
    }
    setSharedSalesSaving(true);
    setSharedSalesNotice("");
    try {
      const response = await fetch("/api/admin/daily-sales", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...sharedSalesDraft,
          mode: sharedSalesEditMode ? "replace" : "add",
        }),
      });
      const data = (await response.json()) as {
        sales?: DailySharedSales;
        error?: string;
      };
      if (!response.ok || !data.sales) {
        throw new Error(data.error ?? "공용 매출을 저장하지 못했습니다.");
      }
      setSharedSales(data.sales);
      setSharedSalesDraft(emptySharedSales(date));
      setSharedSalesEditMode(false);
      setSharedSalesNotice(
        sharedSalesEditMode
          ? "누적 판매 내역을 수정했습니다."
          : "누적 저장 완료 · 입력값을 0으로 초기화했습니다.",
      );
    } catch (reason) {
      setSharedSalesNotice(
        reason instanceof Error ? reason.message : "공용 매출을 저장하지 못했습니다.",
      );
    } finally {
      setSharedSalesSaving(false);
    }
  }

  function startSharedSalesEdit() {
    setSharedSalesDraft({
      ...sharedSales,
      slush: { ...sharedSales.slush },
      beverage: { ...sharedSales.beverage },
      other: { ...sharedSales.other },
      youthPass10: { ...sharedSales.youthPass10 },
      youthPass20: { ...sharedSales.youthPass20 },
      adultPass10: { ...sharedSales.adultPass10 },
      adultPass20: { ...sharedSales.adultPass20 },
    });
    setSharedSalesEditMode(true);
    setSharedSalesNotice("");
  }

  function cancelSharedSalesEdit() {
    setSharedSalesDraft(emptySharedSales(date));
    setSharedSalesEditMode(false);
    setSharedSalesNotice("");
  }

  async function sendControl(room: Room | null, action: ControlAction) {
    const informationOnly = action === "start" && manualStartMode;
    if (action === "start" && room && !informationOnly) {
      if (!window.confirm(`${room.name}의 ${room.teamName} 팀 게임을 시작할까요?\n16:00부터 카운트다운됩니다.`)) return;
    }
    if (action === "stop" && room && !window.confirm(`${room.name} 게임을 정지할까요?`)) return;
    if (action === "all_stop" && !window.confirm("현재 진행 중인 모든 게임을 정지할까요?")) return;

    const roomId = action === "all_stop" ? "ALL" : room?.roomId ?? "";
    setControlBusy(`${roomId}:${action}`);
    setControlNotice("");
    try {
      const response = await fetch("/api/commands", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          roomId,
          action: informationOnly ? "set_info" : action,
          teamName: room?.teamName ?? "",
          mapIndex: informationOnly ? 0 : room?.mapIndex ?? 0,
          people: 0,
          skipPeople: true,
          durationMinutes: GAME_DURATION_MINUTES,
        }),
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(data.error ?? "원격 명령을 보내지 못했습니다.");
      setControlNotice(
        action === "all_stop"
          ? "전체 정지 명령을 보냈습니다."
          : informationOnly
            ? `${room?.name} 팀명만 빠르게 입력했습니다. 매장에서 난이도를 선택하고 시작 버튼을 눌러주세요.`
          : `${room?.name} ${action === "start" ? "시작" : "정지"} 명령을 보냈습니다.`,
      );
      window.setTimeout(() => void refreshStatus(), 650);
      window.setTimeout(() => void refreshStatus(), 1_500);
    } catch (reason) {
      setControlNotice(reason instanceof Error ? reason.message : "원격 명령을 보내지 못했습니다.");
    } finally {
      setControlBusy("");
    }
  }

  function openRoomReservation(roomCode: string) {
    const nowTime = timeInSeoul();
    const [nowHour, nowMinute] = nowTime.split(":").map(Number);
    const nowTotal = nowHour * 60 + nowMinute;
    const todayItems = (date === initialDate ? reservations : todayReservations)
      .filter(
        (reservation) =>
          reservation.roomCode === roomCode &&
          reservation.status !== "cancelled" &&
          reservation.status !== "completed",
      )
      .map((reservation) => {
        const [hour, minute] = reservation.scheduledTime.split(":").map(Number);
        return { reservation, startsAt: hour * 60 + minute };
      })
      .sort((left, right) => left.startsAt - right.startsAt);
    const selected =
      todayItems.find(
        (item) => item.startsAt <= nowTotal && nowTotal < item.startsAt + SLOT_INTERVAL_MINUTES,
      ) ??
      todayItems.find((item) => item.startsAt >= nowTotal) ??
      todayItems.at(-1);

    setDate(initialDate);
    if (selected) {
      setScheduleSelection({
        time: selected.reservation.scheduledTime,
        roomCode,
        reservation: selected.reservation,
      });
      setControlNotice(`${getRoom(roomCode)?.name ?? roomCode} 예약 관리창을 열었습니다. 정보 확인 후 바로 시작하세요.`);
      return;
    }

    const currentSlot = OPERATING_SLOTS.find((time, index) => {
      const [hour, minute] = time.split(":").map(Number);
      const startsAt = hour * 60 + minute;
      const next = OPERATING_SLOTS[index + 1];
      const nextStartsAt = next
        ? Number(next.slice(0, 2)) * 60 + Number(next.slice(3, 5))
        : startsAt + SLOT_INTERVAL_MINUTES;
      return startsAt <= nowTotal && nowTotal < nextStartsAt;
    }) ?? OPERATING_SLOTS.find((time) => {
      const [hour, minute] = time.split(":").map(Number);
      return hour * 60 + minute >= nowTotal;
    }) ?? OPERATING_SLOTS[0];
    setScheduleSelection({ time: currentSlot, roomCode });
    setControlNotice("등록된 예약이 없어 현재 시간의 새 예약 입력창을 열었습니다.");
  }

  function openCopiedReservation(reservation: ReservationRecord) {
    if (reservation.scheduledDate !== date) {
      setDate(reservation.scheduledDate);
    }
    setScheduleSelection({
      time: reservation.scheduledTime,
      roomCode: reservation.roomCode,
      reservation,
    });
  }

  async function moveReservation(
    reservation: ReservationRecord,
    scheduledTime: string,
    roomCode: string,
  ) {
    const response = await fetch("/api/admin/reservations", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: reservation.id,
        action: "move",
        scheduledDate: date,
        scheduledTime,
        roomCode,
      }),
    });
    const data = (await response.json()) as {
      reservation?: ReservationRecord;
      error?: string;
    };
    if (!response.ok || !data.reservation) {
      throw new Error(data.error ?? "예약을 이동하지 못했습니다.");
    }
    await commitReservationChange({
      type: "upsert",
      reservation: data.reservation,
    });
  }

  async function changeReservationArrival(
    reservation: ReservationRecord,
    action: "arrive" | "undo_arrive",
  ) {
    const response = await fetch("/api/admin/reservations", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: reservation.id, action }),
    });
    const data = (await response.json()) as {
      reservation?: ReservationRecord;
      error?: string;
    };
    if (!response.ok || !data.reservation) {
      throw new Error(data.error ?? "입장 상태를 변경하지 못했습니다.");
    }
    await commitReservationChange({
      type: "upsert",
      reservation: data.reservation,
    });
  }

  const summary = useMemo(() => {
    const notCancelled = reservations.filter((item) => item.status !== "cancelled");
    const cancellationFee = reservations.reduce(
      (sum, item) =>
        sum +
        naverSameDayCancellationFee(
          item,
          pricing.naverCancellationFeeAmount,
        ),
      0,
    );
    const expected = notCancelled.reduce((sum, item) => sum + expectedAmount(item), 0);
    const reservationSales = notCancelled.reduce(
      (totals, item) => {
        const deposit = reservationDeposit(
          item.source,
          expectedAmount(item),
          pricing.naverDepositAmount,
        );
        totals.deposit += deposit;
        if (item.paymentStatus === "paid") {
          totals.card += item.paymentCardAmount;
          totals.cash += item.paymentCashAmount;
          totals.account += item.paymentAccountAmount;
          totals.other += Math.max(
            0,
            item.paymentAmount -
              deposit -
              item.paymentCardAmount -
              item.paymentCashAmount -
              item.paymentAccountAmount,
          );
        }
        return totals;
      },
      { card: 0, cash: 0, account: 0, deposit: 0, other: 0 },
    );
    const slush = sharedSalesCategoryTotal(sharedSales, "slush", unitPrices);
    const beverage = sharedSalesCategoryTotal(sharedSales, "beverage", unitPrices);
    const sharedOther = sharedSalesCategoryTotal(sharedSales, "other", unitPrices);
    const passes =
      sharedSalesCategoryTotal(sharedSales, "youthPass10", unitPrices) +
      sharedSalesCategoryTotal(sharedSales, "youthPass20", unitPrices) +
      sharedSalesCategoryTotal(sharedSales, "adultPass10", unitPrices) +
      sharedSalesCategoryTotal(sharedSales, "adultPass20", unitPrices);
    const card =
      reservationSales.card +
      sharedSalesAmountByMethod(sharedSales, "card", unitPrices);
    const cash =
      reservationSales.cash +
      sharedSalesAmountByMethod(sharedSales, "cash", unitPrices);
    const account =
      reservationSales.account +
      sharedSalesAmountByMethod(sharedSales, "account", unitPrices);
    const paid =
      card +
      cash +
      account +
      reservationSales.deposit +
      reservationSales.other +
      cancellationFee;
    return {
      games: notCancelled.length,
      people: notCancelled.reduce((sum, item) => sum + item.totalCount, 0),
      occupiedPercent: Math.round((notCancelled.filter((item) => item.roomCode).length / (OPERATING_SLOTS.length * 4)) * 100),
      expected: expected + slush + beverage + sharedOther + passes + cancellationFee,
      paid,
      card,
      cash,
      account,
      deposit: reservationSales.deposit,
      cancellationFee,
      other: reservationSales.other,
      slush,
      beverage,
      sharedOther,
      passes,
      unpaid: notCancelled.filter((item) => item.paymentStatus !== "paid").length,
      unassigned: notCancelled.filter((item) => !item.roomCode).length,
    };
  }, [pricing, reservations, sharedSales, unitPrices]);

  const filteredReservations = useMemo(() => {
    if (filter === "unpaid") return reservations.filter((item) => item.status !== "cancelled" && item.paymentStatus !== "paid");
    if (filter === "arrived") return reservations.filter((item) => item.status === "arrived");
    if (filter === "unassigned") return reservations.filter((item) => item.status !== "cancelled" && !item.roomCode);
    if (filter === "cancelled") return reservations.filter((item) => item.status === "cancelled");
    return reservations;
  }, [filter, reservations]);

  if (scheduleOnly) {
    return (
      <main className="admin-shell admin-schedule-only-shell">
        <nav className="schedule-only-navigation" aria-label="예약 현황 크게 보기 메뉴">
          <a className="schedule-only-return" href="/admin">← 통합 운영 관리</a>
          <div className="schedule-only-actions">
            <label htmlFor="schedule-only-date">
              <span>운영 날짜</span>
              <input
                id="schedule-only-date"
                type="date"
                value={date}
                onChange={(event) => setDate(event.target.value)}
              />
            </label>
            <button
              type="button"
              onClick={() => void refreshReservations()}
              disabled={loading}
            >
              {loading ? "불러오는 중…" : "예약 새로고침"}
            </button>
          </div>
        </nav>

        <ScheduleBoard
          selectedDate={date}
          today={initialDate}
          reservations={reservations}
          onSelect={setScheduleSelection}
          onMove={moveReservation}
          onStatusChange={changeReservationArrival}
          cancellationFeeAmount={pricing.naverCancellationFeeAmount}
          standalone
        />

        {error ? <div className="alert error-alert">{error}</div> : null}
        {scheduleSelection ? (
          <QuickBookingModal
            key={`${scheduleSelection.time}|${scheduleSelection.roomCode}|${scheduleSelection.reservation?.id ?? "new"}`}
            date={date}
            selection={scheduleSelection}
            status={status}
            manualStartMode={manualStartMode}
            onClose={() => setScheduleSelection(null)}
            onSaved={commitReservationChange}
            onOpenCopied={openCopiedReservation}
            onRefreshStatus={refreshStatus}
            pricing={pricing}
          />
        ) : null}
      </main>
    );
  }

  return (
    <main className={`admin-shell admin-integrated-shell ${controlPinned ? "is-control-pinned" : ""}`}>
      <header className="topbar admin-topbar">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">JB</div>
          <div><p className="eyebrow">JUMPING BATTLE · CONTROL OFFICE</p><h1>통합 운영 관리</h1></div>
        </div>
        <div className="admin-topbar-right">
          <nav className="admin-nav" aria-label="운영 메뉴">
            <a href="/">상세 원격제어</a>
            <a href="/admin/analytics">매출 분석</a>
            <a href="/admin/settings">가격 설정</a>
            <a href="/reserve" target="_blank" rel="noreferrer">고객 예약 화면</a>
            <span>{operatorName}</span>
          </nav>
          <div className="admin-topbar-tools">
            <label className={`manual-start-toggle topbar-manual-start ${manualStartMode ? "is-enabled" : ""}`}>
              <input
                type="checkbox"
                checked={manualStartMode}
                onChange={(event) => changeManualStartMode(event.target.checked)}
              />
              <span className="manual-start-switch" aria-hidden="true"><i /></span>
              <span className="manual-start-copy">
                <strong>매장 수동 시작</strong>
                <small>{manualStartMode ? "팀명만 빠르게 전송" : "원격으로 즉시 시작"}</small>
              </span>
            </label>
            <button
              type="button"
              className="topbar-reservation-refresh"
              onClick={() => void refreshReservations()}
              disabled={loading}
            >
              {loading ? "불러오는 중…" : "예약 새로고침"}
            </button>
          </div>
        </div>
      </header>

      <div className="admin-workspace">
        <aside className="admin-side-rail" aria-label="운영 바로가기 및 공용 부가매출">
          <nav className="admin-side-nav" aria-label="관리자 화면 바로가기">
            <p className="eyebrow">QUICK NAVIGATION</p>
            <strong>운영 바로가기</strong>
            <a href="#admin-overview"><span>01</span>운영 KPI</a>
            <a href="#live-control"><span>02</span>매장 원격제어</a>
            <a href="#full-schedule"><span>03</span>전체 예약 현황</a>
            <a href="#reservation-details"><span>04</span>예약·결제 수정</a>
            <a href="/admin/analytics"><span>05</span>매출 분석</a>
            <a href="/admin/settings"><span>06</span>가격 설정</a>
          </nav>
          <SharedSalesPanel
            sales={sharedSalesDraft}
            totalSales={sharedSales}
            editMode={sharedSalesEditMode}
            loading={sharedSalesLoading}
            saving={sharedSalesSaving}
            notice={sharedSalesNotice}
            unitPrices={unitPrices}
            onChange={changeSharedSales}
            onSave={saveSharedSales}
            onStartEdit={startSharedSalesEdit}
            onCancelEdit={cancelSharedSalesEdit}
          />
          <p className="admin-side-help">
            예약 매출은 시간표의 예약 카드를 눌러 결제 내역을 다시 저장하면 수정됩니다.
            이용 완료된 예약도 수정할 수 있습니다.
          </p>
        </aside>

        <div className={`admin-main-column ${controlPinned ? "is-control-pinned" : ""}`}>
      <div className="admin-control-stack">
        <section className="admin-overview-strip" id="admin-overview" aria-label="운영 날짜 및 하루 운영 요약">
          <div className="admin-overview-date">
            <label htmlFor="admin-date">운영 날짜</label>
            <input id="admin-date" type="date" value={date} onChange={(event) => setDate(event.target.value)} />
          </div>
          <article><span>예약금</span><strong>{won(summary.deposit)}원</strong><small>네이버 선결제</small></article>
          <article><span>취소 수수료</span><strong>{won(summary.cancellationFee)}원</strong><small>네이버 당일 취소</small></article>
          <article><span>카드</span><strong>{won(summary.card)}원</strong><small>예약 + 부가매출</small></article>
          <article><span>현금</span><strong>{won(summary.cash)}원</strong><small>예약 + 부가매출</small></article>
          <article><span>계좌</span><strong>{won(summary.account)}원</strong><small>예약 + 부가매출</small></article>
          <article className="kpi-total"><span>총 매출</span><strong>{won(summary.paid)}원</strong><small>예상 매출 {won(summary.expected)}원</small></article>
          <article><span>게임건수</span><strong>{summary.games}건</strong><small>점유 {summary.occupiedPercent}%</small></article>
          <article><span>인원</span><strong>{summary.people}명</strong><small>총 이용 인원</small></article>
        </section>

        <RemoteControlPanel
        status={status}
        reservations={date === initialDate ? reservations : todayReservations}
        error={statusError}
        busy={controlBusy}
        notice={controlNotice}
        manualStartMode={manualStartMode}
        controlPinned={controlPinned}
        serverClockOffsetMs={serverClockOffsetMs}
        onCommand={sendControl}
        onStartNeedsInfo={openRoomReservation}
        onRefresh={refreshStatus}
        onTogglePin={toggleControlPin}
      />
      </div>

      <ScheduleBoard
        selectedDate={date}
        today={initialDate}
        reservations={reservations}
        onSelect={setScheduleSelection}
        onMove={moveReservation}
        onStatusChange={changeReservationArrival}
        cancellationFeeAmount={pricing.naverCancellationFeeAmount}
      />

      {error ? <div className="alert error-alert">{error}</div> : null}
      <section
        className={`reservation-detail-panel ${detailPanelOpen ? "" : "is-collapsed"}`}
        id="reservation-details"
      >
        <div className="integrated-section-heading">
          <div>
            <p className="eyebrow">RESERVATION DETAILS</p>
            <h2>예약·결제 상세 관리</h2>
            <p>시간표에서 예약을 누르면 해당 카드로 바로 이동합니다.</p>
          </div>
          <button
            type="button"
            className="reservation-detail-toggle"
            aria-expanded={detailPanelOpen}
            aria-controls="reservation-detail-content"
            onClick={() => setDetailPanelOpen((current) => !current)}
          >
            <span>{detailPanelOpen ? "상세 관리 접기" : "상세 관리 펼치기"}</span>
            <b aria-hidden="true">{detailPanelOpen ? "⌃" : "⌄"}</b>
          </button>
        </div>
        <div
          id="reservation-detail-content"
          className="reservation-detail-content"
          hidden={!detailPanelOpen}
        >
          <div className="booking-filter-row" role="group" aria-label="예약 필터">
            {([
              ["all", `전체 ${reservations.length}`],
              ["unpaid", `미결제 ${summary.unpaid}`],
              ["arrived", "입장"],
              ["unassigned", `미배정 ${summary.unassigned}`],
              ["cancelled", "취소"],
            ] as Array<[BookingFilter, string]>).map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={filter === value ? "is-active" : ""}
                onClick={() => setFilter(value)}
              >{label}</button>
            ))}
          </div>
          <div className="admin-safe-note">
            <strong>안전 운영</strong>
            <span>{manualStartMode ? "수동 시작 모드입니다. 게임 시작 버튼은 팀명만 입력하며, 직원이 매장 관리자 프로그램에서 난이도를 선택하고 시작 버튼을 직접 누릅니다." : "원격 시작 모드입니다. 게임 시작 버튼을 누르면 매장 관리자 프로그램에서 16분 카운트다운이 시작됩니다."}</span>
          </div>
          <div className="booking-list" aria-live="polite">
            {!loading && filteredReservations.length === 0 ? (
              <div className="admin-empty"><strong>조건에 맞는 예약이 없습니다.</strong><span>다른 필터나 날짜를 선택해주세요.</span></div>
            ) : null}
            {filteredReservations.map((reservation) => (
              <ReservationCard
                key={reservation.id}
                reservation={reservation}
                manualStartMode={manualStartMode}
                onChanged={commitReservationChange}
                onOpenCopied={openCopiedReservation}
                pricing={pricing}
                onEdit={() =>
                  setScheduleSelection({
                    time: reservation.scheduledTime,
                    roomCode: reservation.roomCode,
                    reservation,
                  })
                }
              />
            ))}
          </div>
        </div>
      </section>
        </div>
      </div>

      <footer>
        <span>구글시트와 기존 관리자 프로그램 원본은 변경하지 않습니다.</span>
        <form method="post" action="/api/pin-logout"><button type="submit">로그아웃</button></form>
      </footer>
      {scheduleSelection ? (
        <QuickBookingModal
          key={`${scheduleSelection.time}|${scheduleSelection.roomCode}|${scheduleSelection.reservation?.id ?? "new"}`}
          date={date}
          selection={scheduleSelection}
          status={status}
          manualStartMode={manualStartMode}
          onClose={() => setScheduleSelection(null)}
          onSaved={commitReservationChange}
          onOpenCopied={openCopiedReservation}
          onRefreshStatus={refreshStatus}
          pricing={pricing}
        />
      ) : null}
    </main>
  );
}
