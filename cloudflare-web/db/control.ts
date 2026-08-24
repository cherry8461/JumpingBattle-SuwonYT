import { env } from "cloudflare:workers";
import { GAME_MINUTES } from "@/app/admin/availability";

type ControlEnv = {
  DB?: D1Database;
  JUMPING_AGENT_TOKEN?: string;
};

// 매장별 상의: 지점의 실제 방 구성과 관리자 프로그램 순서에 맞춰 변경합니다.
const INITIAL_ROOMS = [
  ["0", "A1(중)", "중형"],
  ["1", "C1(소)", "소형"],
  ["2", "B1(대)", "대형"],
  ["3", "C2(소2)", "소형"],
] as const;

export type RoomUpdate = {
  roomId: string;
  status?: string;
  teamName?: string;
  mapName?: string;
  mapIndex?: number;
  mapOptions?: string[];
  people?: number;
  remainingSeconds?: number;
  score?: number;
  level?: string;
};

export type RoomTransition = {
  roomId: string;
  previousStatus: string;
  nextStatus: string;
  previousTeamName: string;
  nextTeamName: string;
  nextRemainingSeconds: number;
};

export function getControlEnv(): ControlEnv {
  return env as unknown as ControlEnv;
}

export function getD1(): D1Database {
  const database = getControlEnv().DB;
  if (!database) {
    throw new Error("점핑배틀 제어 데이터베이스 연결이 준비되지 않았습니다.");
  }
  return database;
}

export async function ensureControlSchema() {
  const db = getD1();
  await db.batch([
    db.prepare(`
      CREATE TABLE IF NOT EXISTS rooms (
        room_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        size TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'offline',
        team_name TEXT NOT NULL DEFAULT '',
        map_name TEXT NOT NULL DEFAULT '',
        map_index INTEGER NOT NULL DEFAULT 0,
        people INTEGER NOT NULL DEFAULT 0,
        remaining_seconds INTEGER NOT NULL DEFAULT 0,
        score INTEGER NOT NULL DEFAULT 0,
        level TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS agents (
        agent_id TEXT PRIMARY KEY,
        version TEXT NOT NULL DEFAULT '',
        last_seen TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS agent_runtime (
        agent_id TEXT PRIMARY KEY,
        armed INTEGER NOT NULL DEFAULT 0,
        simulate INTEGER NOT NULL DEFAULT 0,
        manager_visible INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS room_game_runtime (
        room_id TEXT PRIMARY KEY,
        game_started_at TEXT,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS room_metadata (
        room_id TEXT PRIMARY KEY,
        map_options_json TEXT NOT NULL DEFAULT '[]',
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS commands (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL,
        action TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'pending',
        requested_by TEXT NOT NULL,
        result TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        expires_at TEXT NOT NULL,
        claimed_at TEXT,
        completed_at TEXT
      )
    `),
    db.prepare(`
      CREATE INDEX IF NOT EXISTS commands_status_created_idx
      ON commands(status, created_at)
    `),
    db.prepare(`
      CREATE INDEX IF NOT EXISTS commands_room_status_idx
      ON commands(room_id, status)
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS pin_attempts (
        client_key TEXT PRIMARY KEY,
        failures INTEGER NOT NULL DEFAULT 0,
        window_started INTEGER NOT NULL DEFAULT 0,
        blocked_until INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL DEFAULT 0
      )
    `),
  ]);

  await db.batch(
    INITIAL_ROOMS.map(([roomId, name, size]) =>
      db
        .prepare(
          `INSERT OR IGNORE INTO rooms (room_id, name, size) VALUES (?, ?, ?)`,
        )
        .bind(roomId, name, size),
    ),
  );
}

export async function upsertRoom(update: RoomUpdate) {
  const db = getD1();
  const [current, currentRuntime] = await Promise.all([
    db
      .prepare(`SELECT * FROM rooms WHERE room_id = ?`)
      .bind(update.roomId)
      .first<Record<string, unknown>>(),
    db
      .prepare(`SELECT game_started_at FROM room_game_runtime WHERE room_id = ?`)
      .bind(update.roomId)
      .first<{ game_started_at: string | null }>(),
  ]);

  if (!current) return null;

  const nextStatus = String(update.status ?? current.status ?? "offline");
  const nextTeamName = String(update.teamName ?? current.team_name ?? "");
  const nextRemainingSeconds = Math.max(
    0,
    update.remainingSeconds ?? Number(current.remaining_seconds) ?? 0,
  );
  const previousRemainingSeconds = Math.max(
    0,
    Number(current.remaining_seconds) || 0,
  );

  await db
    .prepare(`
      UPDATE rooms SET
        status = ?,
        team_name = ?,
        map_name = ?,
        map_index = ?,
        people = ?,
        remaining_seconds = ?,
        score = ?,
        level = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE room_id = ?
    `)
    .bind(
      nextStatus,
      nextTeamName,
      update.mapName ?? current.map_name ?? "",
      update.mapIndex ?? current.map_index ?? 0,
      update.people ?? current.people ?? 0,
      nextRemainingSeconds,
      Math.max(0, update.score ?? Number(current.score) ?? 0),
      update.level ?? current.level ?? "",
      update.roomId,
    )
    .run();

  const gameRestarted =
    nextStatus === "running" &&
    (String(current.status ?? "offline") !== "running" ||
      !currentRuntime?.game_started_at ||
      nextRemainingSeconds > previousRemainingSeconds + 30);
  let gameStartedAt = currentRuntime?.game_started_at ?? null;

  if (gameRestarted) {
    const gameSeconds = GAME_MINUTES * 60;
    const elapsedSeconds = Math.max(
      0,
      gameSeconds - Math.min(gameSeconds, nextRemainingSeconds),
    );
    gameStartedAt = new Date(Date.now() - elapsedSeconds * 1_000).toISOString();
  } else if (nextStatus !== "running") {
    gameStartedAt = null;
  }

  await db
    .prepare(`
      INSERT INTO room_game_runtime (room_id, game_started_at, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(room_id) DO UPDATE SET
        game_started_at = excluded.game_started_at,
        updated_at = CURRENT_TIMESTAMP
    `)
    .bind(update.roomId, gameStartedAt)
    .run();

  if (Array.isArray(update.mapOptions)) {
    const mapOptions = update.mapOptions
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim().slice(0, 80))
      .filter(Boolean)
      .slice(0, 50);
    await db
      .prepare(`
        INSERT INTO room_metadata (room_id, map_options_json, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(room_id) DO UPDATE SET
          map_options_json = excluded.map_options_json,
          updated_at = CURRENT_TIMESTAMP
      `)
      .bind(update.roomId, JSON.stringify(mapOptions))
      .run();
  }

  return {
    roomId: update.roomId,
    previousStatus: String(current.status ?? "offline"),
    nextStatus,
    previousTeamName: String(current.team_name ?? ""),
    nextTeamName,
    nextRemainingSeconds,
  } satisfies RoomTransition;
}

export function isAgentAuthorized(request: Request) {
  const expected = getControlEnv().JUMPING_AGENT_TOKEN ?? "";
  const supplied = request.headers.get("x-jumping-agent-token") ?? "";
  if (!expected || expected.length !== supplied.length) return false;

  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= expected.charCodeAt(index) ^ supplied.charCodeAt(index);
  }
  return difference === 0;
}
