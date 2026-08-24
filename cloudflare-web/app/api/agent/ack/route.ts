import {
  ensureControlSchema,
  getD1,
  isAgentAuthorized,
  upsertRoom,
  type RoomUpdate,
} from "@/db/control";
import { autoCompleteStoppedRoom } from "../auto-complete";

type AckBody = {
  commandId?: string;
  status?: "completed" | "failed";
  result?: string;
  room?: RoomUpdate;
};

export async function POST(request: Request) {
  if (!isAgentAuthorized(request)) {
    return Response.json({ error: "제어 모듈 인증 실패" }, { status: 401 });
  }

  try {
    const body = (await request.json()) as AckBody;
    const commandId = String(body.commandId ?? "").trim();
    const status = body.status;
    const result = String(body.result ?? "").trim().slice(0, 500);
    if (!commandId || !status || !["completed", "failed"].includes(status)) {
      return Response.json(
        { error: "올바르지 않은 완료 응답입니다." },
        { status: 400 },
      );
    }

    await ensureControlSchema();
    const db = getD1();
    await db
      .prepare(
        `UPDATE commands SET status = ?, result = ?, completed_at = CURRENT_TIMESTAMP
         WHERE id = ? AND status = 'claimed'`,
      )
      .bind(status, result, commandId)
      .run();

    if (body.room && ["0", "1", "2", "3"].includes(String(body.room.roomId))) {
      const transition = await upsertRoom({
        ...body.room,
        roomId: String(body.room.roomId),
      });
      await autoCompleteStoppedRoom(transition);
    }

    return Response.json({ ok: true });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : "완료 응답 저장에 실패했습니다.",
      },
      { status: 500 },
    );
  }
}
