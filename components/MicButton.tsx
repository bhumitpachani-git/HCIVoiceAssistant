"use client";

import { Mic, MicOff } from "lucide-react";

type MicButtonProps = {
  active: boolean;
  recording: boolean;
  assistantSpeaking: boolean;
  disabled: boolean;
  onToggle: () => void;
};

export function MicButton({ active, recording, assistantSpeaking, disabled, onToggle }: MicButtonProps) {
  const Icon = active ? Mic : MicOff;
  const label = !active
    ? "Turn Mic On"
    : recording
      ? "Listening"
      : assistantSpeaking
        ? "Assistant Speaking"
        : "Mic Ready";

  return (
    <button
      className={`mic-button ${active ? "active" : ""}${recording ? " recording" : ""}`}
      disabled={disabled}
      onClick={onToggle}
      aria-pressed={active}
      title={active ? "Turn off microphone" : "Turn on microphone"}
      type="button"
    >
      <Icon size={54} strokeWidth={1.8} />
      <span>{label}</span>
    </button>
  );
}
