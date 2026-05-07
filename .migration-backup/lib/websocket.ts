import type { ClientEvent, ServerEvent } from "./types";

type EventHandler = (event: ServerEvent) => void;
type CloseHandler = () => void;

const LOCAL_FALLBACK_WS_URL = "ws://localhost:4000/ws";

export const WS_URL_STORAGE_KEY = "voice-agent.ws-url";

export function defaultWsUrl() {
  return browserDefaultWsUrl() ?? LOCAL_FALLBACK_WS_URL;
}

function browserDefaultWsUrl() {
  if (typeof window === "undefined") {
    return undefined;
  }

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws`;
}

function getBrowserStorage() {
  if (typeof window === "undefined") {
    return undefined;
  }

  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export function normalizeWsUrl(value: string) {
  const trimmed = value.trim();

  if (!trimmed) {
    return "";
  }

  if (trimmed.startsWith("https://")) {
    return `wss://${trimmed.slice("https://".length)}`;
  }

  if (trimmed.startsWith("http://")) {
    return `ws://${trimmed.slice("http://".length)}`;
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
      return "";
    }

    return parsed.toString();
  } catch {
    return "";
  }
}

export function getStoredWsUrl(storage = getBrowserStorage()) {
  const stored = storage?.getItem(WS_URL_STORAGE_KEY);
  const normalized = stored ? normalizeWsUrl(stored) : "";
  return normalized || undefined;
}

export function setStoredWsUrl(value: string, storage = getBrowserStorage()) {
  const normalized = normalizeWsUrl(value);

  if (!normalized) {
    storage?.removeItem(WS_URL_STORAGE_KEY);
    return undefined;
  }

  storage?.setItem(WS_URL_STORAGE_KEY, normalized);
  return normalized;
}

export function clearStoredWsUrl(storage = getBrowserStorage()) {
  storage?.removeItem(WS_URL_STORAGE_KEY);
}

export function resolveWsUrl() {
  const envUrl = normalizeWsUrl(process.env.NEXT_PUBLIC_BACKEND_WS_URL ?? "");

  return getStoredWsUrl() ?? envUrl ?? defaultWsUrl();
}

export class AgentSocket {
  private socket?: WebSocket;

  constructor(
    private readonly onEvent: EventHandler,
    private readonly onClose: CloseHandler
  ) {}

  connect(): Promise<void> {
    const url = resolveWsUrl();

    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      let settled = false;
      this.socket = socket;

      socket.onopen = () => {
        settled = true;
        resolve();
      };
      socket.onerror = () => {
        if (!settled) {
          settled = true;
          reject(new Error("Could not connect to voice backend."));
          return;
        }

        this.onEvent({ type: "error", message: "Voice backend connection error." });
      };
      socket.onclose = () => {
        if (!settled) {
          settled = true;
          reject(new Error("Voice backend closed the connection before the session started."));
        }
        this.onClose();
      };
      socket.onmessage = (message) => {
        try {
          this.onEvent(JSON.parse(message.data) as ServerEvent);
        } catch {
          this.onEvent({ type: "error", message: "Received an unreadable server event." });
        }
      };
    });
  }

  send(event: ClientEvent) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(event));
    }
  }

  close() {
    this.socket?.close();
    this.socket = undefined;
  }

  get isOpen() {
    return this.socket?.readyState === WebSocket.OPEN;
  }
}
