export type RoomStatus = "offline" | "waiting" | "running" | "error";

export type Room = {
  roomId: string;
  name: string;
  size: string;
  status: RoomStatus;
  teamName: string;
  mapName: string;
  mapIndex: number;
  mapOptions: string[];
  people: number;
  remainingSeconds: number;
  gameStartedAt: string;
  score: number;
  level: string;
  updatedAt: string;
};

export type RecentCommand = {
  id: string;
  roomId: string;
  action: string;
  status: string;
  result: string;
  createdAt: string;
};

export type StatusResponse = {
  generatedAt: string;
  store: {
    name: string;
    agentOnline: boolean;
    lastSeen: string | null;
    agentVersion: string | null;
    controlArmed: boolean;
    managerVisible: boolean;
    simulate: boolean;
  };
  rooms: Room[];
  recentCommands: RecentCommand[];
};

export type ControlAction = "set_info" | "start" | "stop" | "all_stop";

export type ControlPayload = {
  roomId: string;
  action: ControlAction;
  teamName?: string;
  mapIndex?: number;
  people?: number;
  skipPeople?: boolean;
  durationMinutes?: number;
};
