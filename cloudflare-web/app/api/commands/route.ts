import { getOperator } from "@/app/operator";
import { ensureControlSchema, getD1 } from "@/db/control";
import type { ControlAction, ControlPayload } from "@/app/types";

const ACTIONS = new Set<ControlAction>([
  "set_info",
  "start",
  "stop",
  "all_stop",
]);
const ROOM_IDS = new Set(["0", "1", "2", "3", "ALL"]);

type AgentControlRow = {
  online: number;
  armed: number;
  manager_visible: number;
};

function cleanPayload(value: unknown): ControlPayload | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  const roomId = String(input.roomId ?? "");
  const action = String(input.action ?? "") as ControlAction;
  if (!ROOM_IDS.has(roomId) || !ACTIONS.has(action)) return null;
  if (action === "all_stop" && roomId !== "ALL") return null;
  if (action !== "all_stop" && roomId === "ALL") return null;

  const teamName = String(input.teamName ?? "").trim().slice(0, 10);
  const mapIndex = Math.max(
    0,
    Math.min(50, Math.trunc(Number(input.mapIndex) || 0)),
  );
  const people = Math.max(
    0,
    Math.min(10, Math.trunc(Number(input.people) || 0)),
  );
  const skipPeople = input.skipPeople === true;
  const durationMinutes = 16;

  return {
    roomId,
    action,
    teamName,
    mapIndex,
    people,
    skipPeople,
    durationMinutes,
  };
}

export async function POST(request: Request) {
  const operator = await getOperator();
  if (!operator) {
    return Response.json({ error: "로그인이 필요합니다." }, { status: 401 });
  }

  try {
    const payload = cleanPayload(await request.json());
    if (!payload) {
      return Response.json(
        { error: "올바르지 않은 제어 요청입니다." },
        { status: 400 },
      );
    }

    await ensureControlSchema();
    const db = getD1();
    const agentControl = await db
      .prepare(`
        SELECT
          CASE WHEN agents.last_seen > datetime('now', '-25 seconds') THEN 1 ELSE 0 END AS online,
          COALESCE(agent_runtime.armed, 0) AS armed,
          COALESCE(agent_runtime.manager_visible, 0) AS manager_visible
        FROM agents
        LEFT JOIN agent_runtime ON agent_runtime.agent_id = agents.agent_id
        ORDER BY agents.last_seen DESC LIMIT 1
      `)
      .first<AgentControlRow>();

    if (agentControl?.online !== 1) {
      return Response.json(
        { error: "매장 제어 모듈이 오프라인입니다." },
        { status: 409 },
      );
    }
    if (agentControl.manager_visible !== 1) {
      return Response.json(
        { error: "매장 PC에서 관리자 창을 찾지 못했습니다." },
        { status: 409 },
      );
    }
    if (agentControl.armed !== 1) {
      return Response.json(
        { error: "매장 제어 모듈이 안전 잠금 상태입니다." },
        { status: 423 },
      );
    }

    const duplicate =
      payload.action === "all_stop"
        ? await db
            .prepare(
              `SELECT id FROM commands
               WHERE status IN ('pending', 'claimed')
               LIMIT 1`,
            )
            .first<{ id: string }>()
        : await db
            .prepare(
              `SELECT id FROM commands
               WHERE status IN ('pending', 'claimed')
                 AND (room_id = ? OR room_id = 'ALL')
               LIMIT 1`,
            )
            .bind(payload.roomId)
            .first<{ id: string }>();

    if (duplicate) {
      return Response.json(
        { error: "해당 게임존의 다른 명령이 이미 처리 중입니다." },
        { status: 409 },
      );
    }

    const id = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 90_000).toISOString();
    await db
      .prepare(
        `INSERT INTO commands
         (id, room_id, action, payload_json, status, requested_by, expires_at)
         VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .bind(
        id,
        payload.roomId,
        payload.action,
        JSON.stringify(payload),
        operator.email,
        expiresAt,
      )
      .run();

    return Response.json({ id, status: "pending" }, { status: 201 });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : "명령 저장에 실패했습니다.",
      },
      { status: 500 },
    );
  }
}
