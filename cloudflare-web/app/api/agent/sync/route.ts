import {
  ensureControlSchema,
  getD1,
  isAgentAuthorized,
  upsertRoom,
  type RoomUpdate,
} from "@/db/control";
import { autoCompleteStoppedRoom } from "../auto-complete";

type SyncBody = {
  agentId?: string;
  version?: string;
  armed?: boolean;
  simulate?: boolean;
  managerVisible?: boolean;
  rooms?: RoomUpdate[];
};

type CommandRow = {
  id: string;
  room_id: string;
  action: string;
  payload_json: string;
  expires_at: string;
};

export async function POST(request: Request) {
  if (!isAgentAuthorized(request)) {
    return Response.json({ error: "제어 모듈 인증 실패" }, { status: 401 });
  }

  try {
    const body = (await request.json()) as SyncBody;
    const agentId = String(body.agentId ?? "").trim().slice(0, 80);
    const version = String(body.version ?? "").trim().slice(0, 40);
    if (!agentId) {
      return Response.json({ error: "agentId가 필요합니다." }, { status: 400 });
    }

    await ensureControlSchema();
    const db = getD1();
    await db
      .prepare(
        `INSERT INTO agents (agent_id, version, last_seen)
         VALUES (?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(agent_id) DO UPDATE SET
           version = excluded.version,
           last_seen = CURRENT_TIMESTAMP`,
      )
      .bind(agentId, version)
      .run();
    await db
      .prepare(
        `INSERT INTO agent_runtime
         (agent_id, armed, simulate, manager_visible, updated_at)
         VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(agent_id) DO UPDATE SET
           armed = excluded.armed,
           simulate = excluded.simulate,
           manager_visible = excluded.manager_visible,
           updated_at = CURRENT_TIMESTAMP`,
      )
      .bind(
        agentId,
        body.armed === true ? 1 : 0,
        body.simulate === true ? 1 : 0,
        body.managerVisible === true ? 1 : 0,
      )
      .run();

    for (const room of (body.rooms ?? []).slice(0, 4)) {
      if (["0", "1", "2", "3"].includes(String(room.roomId))) {
        const transition = await upsertRoom({
          ...room,
          roomId: String(room.roomId),
        });
        await autoCompleteStoppedRoom(transition);
      }
    }

    const now = new Date().toISOString();
    await db
      .prepare(
        `UPDATE commands SET
           status = 'failed',
           result = '명령 유효시간 초과',
           completed_at = CURRENT_TIMESTAMP
         WHERE status IN ('pending', 'claimed') AND expires_at <= ?`,
      )
      .bind(now)
      .run();

    await db
      .prepare(
        `UPDATE commands SET status = 'pending', claimed_at = NULL
         WHERE status = 'claimed'
           AND expires_at > ?
           AND claimed_at < datetime('now', '-30 seconds')`,
      )
      .bind(now)
      .run();

    const claimed = await db
      .prepare(
        `UPDATE commands SET status = 'claimed', claimed_at = CURRENT_TIMESTAMP
         WHERE id IN (
           SELECT id FROM commands
           WHERE status = 'pending' AND expires_at > ?
           ORDER BY created_at ASC LIMIT 8
         )
         RETURNING id, room_id, action, payload_json, expires_at`,
      )
      .bind(now)
      .all<CommandRow>();

    return Response.json({
      commands: claimed.results.map((command) => ({
        id: command.id,
        roomId: command.room_id,
        action: command.action,
        payload: JSON.parse(command.payload_json),
        expiresAt: command.expires_at,
      })),
    });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : "동기화에 실패했습니다.",
      },
      { status: 500 },
    );
  }
}
