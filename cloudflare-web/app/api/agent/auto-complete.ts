import { ROOM_OPTIONS } from "@/app/reservation-config";
import type { RoomTransition } from "@/db/control";
import { completeArrivedReservationForRoom } from "@/db/reservations";

export async function autoCompleteStoppedRoom(
  transition: RoomTransition | null,
) {
  if (
    !transition ||
    transition.previousStatus !== "running" ||
    transition.nextStatus !== "waiting" ||
    transition.nextRemainingSeconds !== 0
  ) {
    return null;
  }
  const roomCode = ROOM_OPTIONS.find(
    (room) => room.roomId === transition.roomId,
  )?.code;
  if (!roomCode) return null;
  return completeArrivedReservationForRoom(
    roomCode,
    transition.previousTeamName || transition.nextTeamName,
  );
}
