import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import { Mic, Sparkles, Square, Volume2, Waves, Wifi } from "lucide-react";
import { MicrophoneStreamer, PcmPlayer } from "@/lib/audio";
import { AgentSocket, clearStoredWsUrl, getStoredWsUrl, resolveWsUrl, setStoredWsUrl } from "@/lib/websocket";
import type { AgentStatus, ConversationMessage, CurrentAction, ServerEvent } from "@/lib/types";
import { ActionStatus, type ActionToast, getToolLabel } from "./ActionStatus";

const USER_SPEECH_LEVEL_THRESHOLD = 0.005;
const TOAST_LIFETIME_MS = 6000;
const SPEECH_VISUAL_LEVEL_DIVISOR = 0.07;
const ASSISTANT_SIGNAL_STALL_MS = 5000;
const MAX_USER_TALK_MS = 10_000;
const HOLD_TAIL_MS = 450;
const SPEECH_END_GRACE_MS = 700;
const TURN_REOPEN_COOLDOWN_MS = 700;
const PREROLL_CHUNK_COUNT = 4;

type ExperienceTone =
  | "idle"
  | "connecting"
  | "ready"
  | "listening"
  | "thinking"
  | "speaking"
  | "confirm"
  | "error";

type StageCopy = {
  tone: ExperienceTone;
  badge: string;
  title: string;
  detail: string;
};

function newMessage(role: ConversationMessage["role"], text: string): ConversationMessage {
  return {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    role,
    text,
    createdAt: Date.now()
  };
}

function upsertConversationMessage(
  current: ConversationMessage[],
  role: ConversationMessage["role"],
  text: string,
  isPartial = false
) {
  if (!text.trim()) {
    return current;
  }

  const next = [...current];
  const last = next.at(-1);

  if (last?.role === role && last.isPartial) {
    next[next.length - 1] = {
      ...last,
      text,
      isPartial
    };
    return next;
  }

  next.push({
    ...newMessage(role, text),
    isPartial
  });
  return next;
}

function getStageCopy({
  status,
  connected,
  conversationEnabled,
  isRecording,
  isAssistantSpeaking,
  awaitingGreeting,
  error
}: {
  status: AgentStatus;
  connected: boolean;
  conversationEnabled: boolean;
  isRecording: boolean;
  isAssistantSpeaking: boolean;
  awaitingGreeting: boolean;
  error?: string;
}): StageCopy {
  if (error || status === "error" || status === "disconnected") {
    return {
      tone: "error",
      badge: "Needs attention",
      title: "Reset voice session",
      detail: error ?? "Reconnect and try again."
    };
  }

  if (status === "connecting") {
    return {
      tone: "connecting",
      badge: "Connecting",
      title: "Joining room",
      detail: "Checking mic and speaker."
    };
  }

  if (!connected) {
    return {
      tone: "idle",
      badge: "Ready",
      title: "Start session",
      detail: "HCI says hello first."
    };
  }

  if (isAssistantSpeaking || status === "speaking") {
    return {
      tone: "speaking",
      badge: "HCI speaking",
      title: awaitingGreeting ? "Saying hello" : "Replying now",
      detail: awaitingGreeting
        ? "Listening starts right after."
        : "Please hold on a moment."
    };
  }

  if (awaitingGreeting) {
    return {
      tone: "connecting",
      badge: "Preparing",
      title: "Getting ready",
      detail: "HCI greets you first."
    };
  }

  if (status === "waiting_for_confirmation") {
    return {
      tone: "confirm",
      badge: "Confirmation needed",
      title: "Need approval",
      detail: "Use the buttons below."
    };
  }

  if (isRecording) {
    return {
      tone: "listening",
      badge: "Listening",
      title: "Listening",
      detail: "Go ahead. I'm listening."
    };
  }

  if (status === "calling_api") {
    return {
      tone: "thinking",
      badge: "Working",
      title: "Updating room",
      detail: "One moment. Updating the room now."
    };
  }

  if (status === "thinking") {
    return {
      tone: "thinking",
      badge: "Thinking",
      title: "Thinking",
      detail: "Processing your request."
    };
  }

  if (conversationEnabled) {
    return {
      tone: "ready",
      badge: "Ready",
      title: "Ready for you",
      detail: "Speak when you are ready."
    };
  }

  return {
    tone: "ready",
    badge: "Connected",
    title: "Opening microphone",
    detail: "Almost ready."
  };
}

export function VoiceAgent() {
  const socketRef = useRef<AgentSocket | undefined>(undefined);
  const micRef = useRef<MicrophoneStreamer | undefined>(undefined);
  const playerRef = useRef(new PcmPlayer());
  const orbStageRef = useRef<HTMLDivElement | null>(null);
  const manuallyStoppedRef = useRef(false);
  const speechDetectedRef = useRef(false);
  const speakingDecayTimerRef = useRef<number | undefined>(undefined);
  const connectedRef = useRef(false);
  const conversationEnabledRef = useRef(false);
  const isHoldingRef = useRef(false);
  const assistantSpeakingRef = useRef(false);
  const lastSpeechAtRef = useRef(0);
  const assistantSpeechStartedAtRef = useRef(0);
  const lastAssistantAudioAtRef = useRef(0);
  const lastAssistantSignalAtRef = useRef(0);
  const assistantAudioEndedRef = useRef(false);
  const awaitingGreetingRef = useRef(false);
  const toastTimersRef = useRef<number[]>([]);
  const visualLevelTargetRef = useRef(0);
  const visualLevelCurrentRef = useRef(0);
  const audioStreamOpenRef = useRef(false);
  const closingAudioTurnRef = useRef(false);
  const holdTailUntilRef = useRef(0);
  const noiseFloorRef = useRef(0.006);
  const lastAudioEndAtRef = useRef(0);
  const prerollChunksRef = useRef<string[]>([]);
  const shouldFlushPrerollRef = useRef(false);
  const titleClickStateRef = useRef({ count: 0, lastAt: 0 });
  const [status, setStatus] = useState<AgentStatus>("idle");
  const statusRef = useRef<AgentStatus>("idle");
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [currentAction, setCurrentAction] = useState<CurrentAction>();
  const [toasts, setToasts] = useState<ActionToast[]>([]);
  const [isHolding, setIsHolding] = useState(false);
  const [connected, setConnected] = useState(false);
  const [conversationEnabled, setConversationEnabled] = useState(false);
  const [assistantSpeaking, setAssistantSpeaking] = useState(false);
  const [awaitingGreeting, setAwaitingGreeting] = useState(false);
  const [error, setError] = useState<string>();
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [configuredWsUrl, setConfiguredWsUrl] = useState(() => resolveWsUrl());
  const [wsUrlDraft, setWsUrlDraft] = useState(() => getStoredWsUrl() ?? resolveWsUrl());

  const setConnectedState = useCallback((next: boolean) => {
    connectedRef.current = next;
    setConnected(next);
  }, []);

  const setConversationEnabledState = useCallback((next: boolean) => {
    conversationEnabledRef.current = next;
    setConversationEnabled(next);
  }, []);

  const setRecordingState = useCallback((next: boolean) => {
    isHoldingRef.current = next;
    setIsHolding(next);
  }, []);

  const setAssistantSpeakingState = useCallback((next: boolean) => {
    assistantSpeakingRef.current = next;
    setAssistantSpeaking(next);
  }, []);

  const setAwaitingGreetingState = useCallback((next: boolean) => {
    awaitingGreetingRef.current = next;
    setAwaitingGreeting(next);
  }, []);

  const openSettings = useCallback(() => {
    const resolvedUrl = resolveWsUrl();
    setConfiguredWsUrl(resolvedUrl);
    setWsUrlDraft(getStoredWsUrl() ?? resolvedUrl);
    setIsSettingsOpen(true);
  }, []);

  const closeSettings = useCallback(() => {
    setIsSettingsOpen(false);
  }, []);

  const clearToasts = useCallback(() => {
    for (const timer of toastTimersRef.current) {
      window.clearTimeout(timer);
    }

    toastTimersRef.current = [];
    setToasts([]);
  }, []);

  const pushToast = useCallback((toast: Omit<ActionToast, "id">) => {
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

    setToasts((current) => [{ id, ...toast }, ...current].slice(0, 4));

    const timer = window.setTimeout(() => {
      toastTimersRef.current = toastTimersRef.current.filter((entry) => entry !== timer);
      setToasts((current) => current.filter((entry) => entry.id !== id));
    }, TOAST_LIFETIME_MS);

    toastTimersRef.current.push(timer);
  }, []);

  const handleTitleClick = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>) => {
      const now = Date.now();
      const previous = titleClickStateRef.current;
      const count = now - previous.lastAt <= 700 ? previous.count + 1 : 1;

      titleClickStateRef.current = {
        count,
        lastAt: now
      };

      if (count >= 3 || event.detail >= 3) {
        titleClickStateRef.current = { count: 0, lastAt: 0 };
        openSettings();
      }
    },
    [openSettings]
  );

  const handleTitleMouseDown = useCallback((event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
  }, []);

  const handleTitleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>) => {
      if (event.key !== "Enter" && event.key !== " ") {
        return;
      }

      event.preventDefault();
      openSettings();
    },
    [openSettings]
  );

  const saveWsUrl = useCallback(() => {
    const nextUrl = setStoredWsUrl(wsUrlDraft);

    if (!nextUrl) {
      pushToast({
        tone: "error",
        title: "URL required",
        message: "Enter a valid ws:// or wss:// URL before saving."
      });
      return;
    }

    setConfiguredWsUrl(nextUrl);
    setWsUrlDraft(nextUrl);
    setIsSettingsOpen(false);
    pushToast({
      tone: "success",
      title: "Server URL saved",
      message: connectedRef.current
        ? "Saved to this browser. Restart the session to reconnect with the new server."
        : "Saved to this browser. New sessions will use this server automatically."
    });
  }, [pushToast, wsUrlDraft]);

  const resetWsUrl = useCallback(() => {
    clearStoredWsUrl();
    const nextUrl = resolveWsUrl();

    setConfiguredWsUrl(nextUrl);
    setWsUrlDraft(nextUrl);
    setIsSettingsOpen(false);
    pushToast({
      tone: "info",
      title: "Default server restored",
      message: connectedRef.current
        ? "The saved override was removed. Restart the session to use the default server."
        : "The saved override was removed. New sessions will use the default server."
    });
  }, [pushToast]);

  const resetDetectionState = useCallback(() => {
    speechDetectedRef.current = false;
    visualLevelTargetRef.current = 0;
    lastSpeechAtRef.current = 0;
    audioStreamOpenRef.current = false;
    closingAudioTurnRef.current = false;
    holdTailUntilRef.current = 0;
    lastAudioEndAtRef.current = 0;
    prerollChunksRef.current = [];
    shouldFlushPrerollRef.current = false;
    if (speakingDecayTimerRef.current) {
      window.clearTimeout(speakingDecayTimerRef.current);
      speakingDecayTimerRef.current = undefined;
    }
    setRecordingState(false);
  }, [setRecordingState]);

  const pushVisualLevel = useCallback((level: number) => {
    const nextLevel = Math.max(0, Math.min(1, level));
    visualLevelTargetRef.current = Math.max(visualLevelTargetRef.current, nextLevel);
  }, []);

  const shutdownMicrophone = useCallback(async () => {
    resetDetectionState();
    await micRef.current?.stop().catch(() => undefined);
    micRef.current = undefined;
  }, [resetDetectionState]);

  const closeUserAudioTurn = useCallback(async () => {
    if (!audioStreamOpenRef.current || closingAudioTurnRef.current) {
      return;
    }

    closingAudioTurnRef.current = true;

    try {
      await micRef.current?.flush().catch(() => undefined);

      if (socketRef.current?.isOpen && audioStreamOpenRef.current) {
        socketRef.current.send({ type: "audio_end" });
      }
    } finally {
      audioStreamOpenRef.current = false;
      lastAudioEndAtRef.current = Date.now();
      closingAudioTurnRef.current = false;
    }
  }, []);

  const activateConversationMode = useCallback(() => {
    setAwaitingGreetingState(false);

    if (conversationEnabledRef.current) {
      if (!assistantSpeakingRef.current && !isHoldingRef.current) {
        setStatus("listening");
      }
      return;
    }

    setConversationEnabledState(true);

    if (!assistantSpeakingRef.current && !isHoldingRef.current) {
      setStatus("listening");
    }
  }, [setAwaitingGreetingState, setConversationEnabledState]);

  const handleMicLevel = useCallback(
    (level: number) => {
      const normalizedLevel = Math.max(0, Math.min(1, level / SPEECH_VISUAL_LEVEL_DIVISOR));

      pushVisualLevel(normalizedLevel);

      if (!conversationEnabledRef.current) {
        return;
      }

      if (statusRef.current !== "listening" && statusRef.current !== "done") {
        return;
      }

      // Only evaluate mic speech when we expect the user to speak.
      // This prevents false "user input" events while the assistant is processing.
      if (assistantSpeakingRef.current) {
        return;
      }

      if (isHoldingRef.current && lastSpeechAtRef.current && Date.now() - lastSpeechAtRef.current > MAX_USER_TALK_MS) {
        // Safety end: avoid staying in an open user turn forever.
        setRecordingState(false);
        holdTailUntilRef.current = Date.now() + HOLD_TAIL_MS;
        void closeUserAudioTurn();
        return;
      }

      // Adaptive threshold: calibrate to ambient noise so we don't miss quiet voices
      // or trigger on constant fan/noise.
      if (!isHoldingRef.current) {
        const nf = noiseFloorRef.current;
        const next = nf * 0.95 + level * 0.05;
        noiseFloorRef.current = Math.max(0.001, Math.min(0.03, next));
      }

      const startThreshold = Math.max(USER_SPEECH_LEVEL_THRESHOLD, noiseFloorRef.current * 2);
      const endThreshold = Math.max(USER_SPEECH_LEVEL_THRESHOLD * 0.6, noiseFloorRef.current * 1.35);

      if (level >= startThreshold || (isHoldingRef.current && level >= endThreshold)) {
        if (speakingDecayTimerRef.current) {
          window.clearTimeout(speakingDecayTimerRef.current);
          speakingDecayTimerRef.current = undefined;
        }

        if (!isHoldingRef.current) {
          if (Date.now() - lastAudioEndAtRef.current < TURN_REOPEN_COOLDOWN_MS) {
            return;
          }

          setRecordingState(true);
          holdTailUntilRef.current = Date.now() + HOLD_TAIL_MS;
          // Open a fresh user audio turn for Gemini when speech begins.
          if (socketRef.current?.isOpen && !audioStreamOpenRef.current) {
            socketRef.current.send({ type: "audio_start" });
            audioStreamOpenRef.current = true;
            shouldFlushPrerollRef.current = true;
          }
        }

        speechDetectedRef.current = true;
        lastSpeechAtRef.current = Date.now();
        holdTailUntilRef.current = Date.now() + HOLD_TAIL_MS;

        return;
      }

      if (!isHoldingRef.current || speakingDecayTimerRef.current) {
        return;
      }

      // Slightly delay end-of-speech so short pauses don't prematurely close the turn.
      speakingDecayTimerRef.current = window.setTimeout(() => {
        speakingDecayTimerRef.current = undefined;
        setRecordingState(false);
        holdTailUntilRef.current = Date.now() + HOLD_TAIL_MS;
        // Close the user audio turn once speech stops.
        void closeUserAudioTurn();
      }, SPEECH_END_GRACE_MS);
    },
    [closeUserAudioTurn, pushVisualLevel, setRecordingState]
  );

  const handleMicChunk = useCallback(
    (data: string) => {
      if (!conversationEnabledRef.current) {
        return;
      }

      if (statusRef.current !== "listening" && statusRef.current !== "done") {
        return;
      }

      const socket = socketRef.current;
      if (!socket?.isOpen) {
        return;
      }

      // Only stream mic audio during the user-listening phase.
      // This reduces Gemini "interrupted" behavior that can cut off speech / cancel tool calls.
      if (assistantSpeakingRef.current) {
        return;
      }

      const priorPreroll = prerollChunksRef.current;
      prerollChunksRef.current = [...priorPreroll, data].slice(-PREROLL_CHUNK_COUNT);

      // Only stream audio while we are actively holding a user turn.
      // This prevents continuous background-noise streaming that causes delays/ignored turns.
      if (!isHoldingRef.current && Date.now() > holdTailUntilRef.current) {
        return;
      }

      // Only open a new turn on chunks while actively speaking.
      // Tail chunks are allowed only for an already-open turn.
      if (!audioStreamOpenRef.current && !isHoldingRef.current) {
        return;
      }

      // Race-safety: ensure Gemini has an open user audio turn before the first chunk.
      if (!audioStreamOpenRef.current) {
        if (Date.now() - lastAudioEndAtRef.current < TURN_REOPEN_COOLDOWN_MS) {
          return;
        }
        socket.send({ type: "audio_start" });
        audioStreamOpenRef.current = true;
        shouldFlushPrerollRef.current = true;
      }

      if (shouldFlushPrerollRef.current) {
        shouldFlushPrerollRef.current = false;
        for (const bufferedChunk of priorPreroll) {
          socket.send({ type: "audio_chunk", data: bufferedChunk });
        }
      }

      socket.send({ type: "audio_chunk", data });
    },
    []
  );

  const ensureMicrophoneStarted = useCallback(async () => {
    if (micRef.current) {
      return;
    }

    const mic = new MicrophoneStreamer();
    micRef.current = mic;

    try {
      await mic.start(handleMicChunk, handleMicLevel);
    } catch (micError) {
      micRef.current = undefined;
      setConversationEnabledState(false);
      setRecordingState(false);
      setAwaitingGreetingState(false);
      setStatus("error");
      setError(micError instanceof Error ? micError.message : "Microphone could not start.");
      throw micError;
    }
  }, [handleMicChunk, handleMicLevel, setAwaitingGreetingState, setConversationEnabledState, setRecordingState]);

  const handleServerEvent = useCallback(
    (event: ServerEvent) => {
      switch (event.type) {
        case "status": {
          const nextStatus =
            event.status === "done" && connectedRef.current && !awaitingGreetingRef.current ? "listening" : event.status;

          setStatus(nextStatus);

          if (event.status === "done") {
            // Treat Gemini's `done` as the end of the assistant's turn even
            // when the backend does not emit a separate `assistant_audio_end`.
            assistantAudioEndedRef.current = true;
          }

          if (
            event.status === "thinking" ||
            event.status === "speaking" ||
            event.status === "calling_api" ||
            event.status === "waiting_for_confirmation"
          ) {
            setRecordingState(false);
            void closeUserAudioTurn();
          }

          if (event.status === "speaking") {
            lastAssistantSignalAtRef.current = Date.now();
          }

          if (event.status === "done" && awaitingGreetingRef.current && !assistantSpeakingRef.current) {
            activateConversationMode();
          }

          if (event.status === "disconnected" || event.status === "stopped") {
            setConnectedState(false);
            setConversationEnabledState(false);
            setRecordingState(false);
            setAssistantSpeakingState(false);
            setAwaitingGreetingState(false);
            assistantSpeechStartedAtRef.current = 0;
            lastAssistantAudioAtRef.current = 0;
            lastAssistantSignalAtRef.current = 0;
            void shutdownMicrophone();
          }

          if (event.message) {
            setError(event.status === "error" || event.status === "disconnected" ? event.message : undefined);
            if (event.status === "done") {
              pushToast({
                tone: "info",
                title: "No response captured",
                message: event.message
              });
            }
            if (event.status === "disconnected") {
              pushToast({
                tone: "error",
                title: "Voice session disconnected",
                message: event.message
              });
            }
          }

          break;
        }
        case "transcript":
          setMessages((current) =>
            upsertConversationMessage(current, event.role, event.text, event.isPartial ?? false)
          );
          break;
        case "assistant_text":
          lastAssistantSignalAtRef.current = Date.now();
          setMessages((current) =>
            upsertConversationMessage(current, "assistant", event.text, event.isPartial ?? false)
          );
          break;
        case "assistant_audio":
          if (!assistantSpeakingRef.current) {
            assistantSpeechStartedAtRef.current = Date.now();
          }

          lastAssistantAudioAtRef.current = Date.now();
          lastAssistantSignalAtRef.current = lastAssistantAudioAtRef.current;
          assistantAudioEndedRef.current = false;
          setAssistantSpeakingState(true);
          // End any ongoing user audio turn before assistant playback.
          void closeUserAudioTurn();
          pushVisualLevel(0.42 + Math.random() * 0.24);
          void playerRef.current.playBase64Pcm(event.data);
          break;
        case "assistant_audio_end":
          assistantAudioEndedRef.current = true;
          if (event.reason !== "completed") {
            setAssistantSpeakingState(false);
            assistantSpeechStartedAtRef.current = 0;
            lastAssistantAudioAtRef.current = 0;
            lastAssistantSignalAtRef.current = 0;
            playerRef.current.interrupt();
          }
          break;
        case "tool_call":
          setCurrentAction({
            name: event.name,
            args: event.args,
            confirmationId: event.confirmationId
          });

          if (event.confirmationId) {
            pushToast({
              tone: "info",
              title: "Approval needed",
              message: `${getToolLabel(event.name)} is waiting for confirmation.`,
              detail: "Review the card on screen before sending the change."
            });
          }

          break;
        case "tool_result":
          setCurrentAction((current) =>
            current?.name === event.name && current.confirmationId === event.confirmationId ? undefined : current
          );
          pushToast({
            tone: event.result.success ? "success" : "error",
            title: event.result.success
              ? `${getToolLabel(event.name)} completed`
              : `${getToolLabel(event.name)} failed`,
            message: event.result.message
          });
          break;
        case "error":
          setAwaitingGreetingState(false);
          setError(event.message);
          setStatus("error");
          pushToast({
            tone: "error",
            title: "Voice session issue",
            message: event.message
          });
          break;
        default:
          break;
      }
    },
    [
      activateConversationMode,
      closeUserAudioTurn,
      pushVisualLevel,
      pushToast,
      setAssistantSpeakingState,
      setAwaitingGreetingState,
      setConnectedState,
      setConversationEnabledState,
      setRecordingState,
      shutdownMicrophone
    ]
  );

  const connect = useCallback(async () => {
    if (socketRef.current?.isOpen) {
      setConnectedState(true);
      socketRef.current.send({ type: "start_session" });
      return;
    }

    setError(undefined);
    setStatus("connecting");
    manuallyStoppedRef.current = false;

    const socket = new AgentSocket(handleServerEvent, () => {
      socketRef.current = undefined;
      setConnectedState(false);
      setConversationEnabledState(false);
      setRecordingState(false);
      setAssistantSpeakingState(false);
      setAwaitingGreetingState(false);
      assistantSpeechStartedAtRef.current = 0;
      lastAssistantAudioAtRef.current = 0;
      lastAssistantSignalAtRef.current = 0;
      void shutdownMicrophone();
      void playerRef.current.stop();

      if (!manuallyStoppedRef.current) {
        setStatus("disconnected");
        setError("Voice backend disconnected. Start a new session to reconnect.");
      }
    });

    try {
      await socket.connect();
      socketRef.current = socket;
      setConnectedState(true);
      socket.send({ type: "start_session" });
    } catch (connectError) {
      manuallyStoppedRef.current = true;
      socket.close();
      setStatus("error");
      setError(connectError instanceof Error ? connectError.message : "Connection failed.");
    }
  }, [
    handleServerEvent,
    setAssistantSpeakingState,
    setAwaitingGreetingState,
    setConnectedState,
    setConversationEnabledState,
    setRecordingState,
    shutdownMicrophone
  ]);

  const startSession = useCallback(async () => {
    if (status === "connecting" || connectedRef.current) {
      return;
    }

    clearToasts();
    setMessages([]);
    setCurrentAction(undefined);
    setError(undefined);
    setAwaitingGreetingState(true);
    setConversationEnabledState(false);
    setRecordingState(false);

    try {
      await playerRef.current.resume().catch(() => undefined);
      await ensureMicrophoneStarted();
      await connect();
      if (!socketRef.current?.isOpen) {
        setAwaitingGreetingState(false);
        await shutdownMicrophone();
      }
    } catch {
      setAwaitingGreetingState(false);
      await shutdownMicrophone();
    }
  }, [
    clearToasts,
    connect,
    ensureMicrophoneStarted,
    setAwaitingGreetingState,
    setConversationEnabledState,
    setRecordingState,
    shutdownMicrophone,
    status
  ]);

  const stopSession = useCallback(async () => {
    manuallyStoppedRef.current = true;
    setAwaitingGreetingState(false);
    setConversationEnabledState(false);
    setRecordingState(false);
    setAssistantSpeakingState(false);
    setCurrentAction(undefined);
    assistantSpeechStartedAtRef.current = 0;
    lastAssistantAudioAtRef.current = 0;
    lastAssistantSignalAtRef.current = 0;
    assistantAudioEndedRef.current = false;
    audioStreamOpenRef.current = false;
    await shutdownMicrophone();
    socketRef.current?.send({ type: "audio_end" });
    socketRef.current?.send({ type: "stop_session" });
    socketRef.current?.close();
    socketRef.current = undefined;
    setConnectedState(false);
    await playerRef.current.stop();
    setStatus("stopped");
  }, [
    setAssistantSpeakingState,
    setAwaitingGreetingState,
    setConnectedState,
    setConversationEnabledState,
    setRecordingState,
    shutdownMicrophone
  ]);

  const confirmAction = useCallback((confirmationId: string, approved: boolean) => {
    socketRef.current?.send({ type: "confirm_action", confirmationId, approved });
  }, []);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    if (!isSettingsOpen) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsSettingsOpen(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isSettingsOpen]);

  useEffect(() => {
    let animationFrame = 0;

    const animateVoiceSurface = () => {
      const target = visualLevelTargetRef.current;
      const current = visualLevelCurrentRef.current;
      const easing = target > current ? 0.34 : 0.12;
      const next = current + (target - current) * easing;

      visualLevelCurrentRef.current = next < 0.004 ? 0 : next;
      visualLevelTargetRef.current = Math.max(0, target - 0.018);
      orbStageRef.current?.style.setProperty("--voice-level", visualLevelCurrentRef.current.toFixed(3));

      animationFrame = window.requestAnimationFrame(animateVoiceSurface);
    };

    animationFrame = window.requestAnimationFrame(animateVoiceSurface);

    return () => {
      window.cancelAnimationFrame(animationFrame);
    };
  }, []);

  useEffect(() => {
    const player = playerRef.current;

    player.setOnIdle(() => {
      // The AudioBufferSource(s) can go idle briefly between streamed chunks.
      // Do not mark the assistant as finished until we also receive
      // the explicit `assistant_audio_end` event from the backend.
      if (!assistantAudioEndedRef.current) {
        return;
      }

      setAssistantSpeakingState(false);
      assistantSpeechStartedAtRef.current = 0;
      lastAssistantAudioAtRef.current = 0;
      lastAssistantSignalAtRef.current = 0;

      if (awaitingGreetingRef.current) {
        activateConversationMode();
        return;
      }

      if (!connectedRef.current || isHoldingRef.current) {
        return;
      }

      setStatus((current) =>
        current === "error" || current === "disconnected" || current === "stopped" ? current : "listening"
      );
    });

    return () => {
      player.setOnIdle(undefined);
    };
  }, [activateConversationMode, setAssistantSpeakingState]);

  useEffect(() => {
    const player = playerRef.current;

    return () => {
      manuallyStoppedRef.current = true;
      clearToasts();
      setAwaitingGreetingState(false);
      setConversationEnabledState(false);
      setRecordingState(false);
      setAssistantSpeakingState(false);
      assistantSpeechStartedAtRef.current = 0;
      lastAssistantAudioAtRef.current = 0;
      lastAssistantSignalAtRef.current = 0;
      assistantAudioEndedRef.current = false;
      socketRef.current?.close();
      socketRef.current = undefined;
      void shutdownMicrophone();
      void player.stop();
    };
  }, [
    clearToasts,
    setAssistantSpeakingState,
    setAwaitingGreetingState,
    setConversationEnabledState,
    setRecordingState,
    shutdownMicrophone
  ]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!connectedRef.current || !assistantSpeakingRef.current || assistantAudioEndedRef.current) {
        return;
      }

      const lastSignalAt = lastAssistantSignalAtRef.current;
      if (!lastSignalAt) {
        return;
      }

      if (Date.now() - lastSignalAt < ASSISTANT_SIGNAL_STALL_MS) {
        return;
      }

      // Self-recovery: if assistant audio stream stalls unexpectedly,
      // unlock mic/listening state so conversation can continue.
      assistantAudioEndedRef.current = true;
      setAssistantSpeakingState(false);
      assistantSpeechStartedAtRef.current = 0;
      lastAssistantAudioAtRef.current = 0;
      lastAssistantSignalAtRef.current = 0;

      if (!isHoldingRef.current) {
        setStatus((current) =>
          current === "error" || current === "disconnected" || current === "stopped" ? current : "listening"
        );
      }
    }, 500);

    return () => {
      window.clearInterval(timer);
    };
  }, [setAssistantSpeakingState]);

  const stageCopy = getStageCopy({
    status,
    connected,
    conversationEnabled,
    isRecording: isHolding,
    isAssistantSpeaking: assistantSpeaking,
    awaitingGreeting,
    error
  });
  const orbStyle = { "--voice-level": "0" } as CSSProperties;
  const startDisabled = status === "connecting";
  const startButtonLabel = error ? "Reconnect" : startDisabled ? "Connecting" : "Start voice";
  const showEndSession = connected || status === "connecting";
  const footerCopy = connected ? stageCopy.detail : error ? "Tap to reconnect" : "Tap to speak";
  const StartIcon = error ? Wifi : startDisabled ? Waves : Mic;

  return (
    <main className={`experience-shell ${stageCopy.tone}`}>
      <div className="ambient-glow ambient-left" />
      <div className="ambient-glow ambient-right" />

      <ActionStatus action={currentAction} toasts={toasts} onConfirm={confirmAction} />

      {isSettingsOpen ? (
        <div className="settings-overlay" onClick={closeSettings}>
          <section
            aria-labelledby="ws-settings-title"
            aria-modal="true"
            className="settings-modal"
            onClick={(event) => event.stopPropagation()}
            role="dialog"
          >
            <div className="settings-modal-header">
              <span className="settings-kicker">Connection settings</span>
              <button className="settings-close-button" onClick={closeSettings} type="button">
                Close
              </button>
            </div>
            <h2 id="ws-settings-title">WebSocket server URL</h2>
            <p className="settings-copy">
              Save a custom <code>ws://</code> or <code>wss://</code> URL here. This browser will keep using the saved
              URL for every new voice session until you change it again.
            </p>

            <label className="settings-field">
              <span>Saved URL</span>
              <input
                autoComplete="off"
                className="settings-input"
                onChange={(event) => setWsUrlDraft(event.target.value)}
                placeholder="wss://example.com/ws"
                spellCheck={false}
                type="text"
                value={wsUrlDraft}
              />
            </label>

            <div className="settings-note">
              <strong>Current active URL</strong>
              <code>{configuredWsUrl}</code>
            </div>

            <div className="confirm-row settings-actions">
              <button className="primary-button" onClick={saveWsUrl} type="button">
                Save URL
              </button>
              <button className="session-end-button" onClick={resetWsUrl} type="button">
                Use default
              </button>
            </div>
          </section>
        </div>
      ) : null}

      <section className="voice-stage reference-stage">
        <header className="reference-header">
          <h1 className="reference-title">
            <button
              aria-label="HCI Voice Assistant"
              className="reference-title-button"
              onClick={handleTitleClick}
              onKeyDown={handleTitleKeyDown}
              onMouseDown={handleTitleMouseDown}
              style={{ cursor: "pointer" }}
              title="Triple-click to open hidden connection settings"
              type="button"
            >
              HCI Voice Assistant
            </button>
          </h1>
        </header>

        <div className="reference-hero">
          <div className="voice-console-shell">
            <div className={`voice-console ${stageCopy.tone}`} ref={orbStageRef} style={orbStyle}>
              <div className="voice-console-shadow" />
              <div className="voice-console-ring voice-console-ring-ticks" />
              <div className="voice-console-ring voice-console-ring-outer" />
              <div className="voice-console-ring voice-console-ring-mid" />
              <div className="voice-console-core" aria-live="polite">
                <div className="voice-console-inner">
                  {!connected ? (
                    <button
                      className="voice-console-button voice-console-start"
                      disabled={startDisabled}
                      onClick={() => void startSession()}
                      type="button"
                    >
                      <span className="voice-console-icon">
                        <StartIcon size={32} strokeWidth={1.4} />
                      </span>
                      <span className="voice-console-title">{startButtonLabel}</span>
                    </button>
                  ) : (
                    <div className="voice-console-live voice-console-active">
                      <div className="voice-console-icon">
                        {assistantSpeaking || status === "speaking" ? (
                          <Volume2 size={34} strokeWidth={1.4} />
                        ) : isHolding ? (
                          <Waves size={34} strokeWidth={1.4} />
                        ) : (
                          <Sparkles size={34} strokeWidth={1.4} />
                        )}
                      </div>
                      <span className="voice-console-title">{stageCopy.title}</span>
                      <div className="voice-console-meter" aria-hidden="true">
                        <span />
                        <span />
                        <span />
                        <span />
                        <span />
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
            <p className="voice-console-footer">
              {footerCopy}
              {status === "calling_api" ? (
                <span className="thinking-dots" aria-hidden="true">
                  <span className="dot" />
                  <span className="dot" />
                  <span className="dot" />
                </span>
              ) : null}
            </p>
          </div>
        </div>

        {showEndSession ? (
          <footer className="reference-footer">
            <button className="session-end-button" onClick={() => void stopSession()} type="button">
              <Square size={18} />
              End Session
            </button>
          </footer>
        ) : null}
      </section>
    </main>
  );
}

