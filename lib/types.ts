export type AgentStatus =
  | "idle"
  | "connecting"
  | "listening"
  | "thinking"
  | "calling_api"
  | "waiting_for_confirmation"
  | "done"
  | "error"
  | "stopped"
  | "disconnected";

export type ConversationMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: number;
  isPartial?: boolean;
};

export type ActionResult = {
  success: boolean;
  message: string;
  data?: Record<string, unknown>;
  errorCode?: string;
};

export type ClientEvent =
  | { type: "start_session"; sendGreeting?: boolean }
  | { type: "stop_session" }
  | { type: "audio_start" }
  | { type: "audio_chunk"; data: string }
  | { type: "audio_end" }
  | { type: "confirm_action"; confirmationId: string; approved?: boolean }
  | { type: "text_input"; text: string };

export type ServerEvent =
  | { type: "status"; status: AgentStatus; message?: string }
  | { type: "transcript"; role: "user" | "assistant"; text: string; isPartial?: boolean }
  | { type: "assistant_text"; text: string; isPartial?: boolean }
  | { type: "assistant_audio"; data: string }
  | { type: "assistant_audio_end"; reason: "interrupted" | "session_closed" }
  | { type: "tool_call"; name: string; args: Record<string, unknown>; confirmationId?: string }
  | { type: "tool_result"; name: string; result: ActionResult; confirmationId?: string }
  | { type: "error"; message: string; code?: string };

export type CurrentAction = {
  name: string;
  args?: Record<string, unknown>;
  result?: ActionResult;
  confirmationId?: string;
};
