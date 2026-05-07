# HCI Voice Assistant

A real-time voice interface for HCI's AI-powered room management system. Users tap "Start" to connect via WebSocket to a voice backend, speak naturally to control room devices, and see confirmation cards for sensitive actions.

## Run & Operate

- `pnpm --filter @workspace/hci-voice-assistant run dev` — run the frontend (port assigned by workflow)
- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- Required env: `DATABASE_URL` — Postgres connection string
- Optional env: `VITE_BACKEND_WS_URL` — WebSocket server URL override (defaults to `wss://<host>/ws`)

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- Frontend: React 19 + Vite (artifact: `hci-voice-assistant`)
- API: Express 5 (artifact: `api-server`)
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- Build: esbuild (CJS bundle)
- Routing: wouter

## Where things live

- `artifacts/hci-voice-assistant/src/components/VoiceAgent.tsx` — main voice UI component (source of truth for all state + WebSocket logic)
- `artifacts/hci-voice-assistant/src/components/ActionStatus.tsx` — toast notifications and confirmation cards
- `artifacts/hci-voice-assistant/src/components/ConversationPanel.tsx` — transcript panel
- `artifacts/hci-voice-assistant/src/lib/audio.ts` — MicrophoneStreamer (AudioWorklet PCM capture) and PcmPlayer
- `artifacts/hci-voice-assistant/src/lib/websocket.ts` — AgentSocket, WS URL resolution
- `artifacts/hci-voice-assistant/src/lib/types.ts` — shared TypeScript types (AgentStatus, ServerEvent, ClientEvent, etc.)
- `artifacts/hci-voice-assistant/src/index.css` — all app styles (no Tailwind utility classes; pure CSS with custom properties)

## Architecture decisions

- **Pure CSS styling**: The original app uses hand-crafted CSS with CSS custom properties (`--voice-level`, `--display-font`, etc.) rather than Tailwind utilities. This is preserved intentionally — the visual design depends on it.
- **WebSocket-first**: The app communicates entirely via WebSocket. The WS URL defaults to `wss://<host>/ws` but can be overridden via `VITE_BACKEND_WS_URL` env var or a hidden settings modal (triple-click the title).
- **Client-side audio pipeline**: MicrophoneStreamer uses AudioWorklet for low-latency PCM capture at 16kHz; PcmPlayer plays 24kHz PCM audio from the assistant.
- **Migrated from Next.js**: Converted from Next.js 16 to Vite + React. Removed `"use client"` directives, replaced `process.env.NEXT_PUBLIC_*` with `import.meta.env.VITE_*`.

## Product

HCI Voice Assistant lets clinical staff control room devices by speaking naturally. It connects to a Gemini-powered voice backend over WebSocket, streams microphone audio, plays back assistant audio, and shows tool call confirmations before executing sensitive room actions (setting patient status, controlling Jeron calls, managing device alerts, etc.).

## User preferences

_Populate as you build._

## Gotchas

- The app has no backend API routes — it's purely a WebSocket client frontend. The api-server artifact exists in the scaffold but is not used by this app.
- The WebSocket backend is external (not included). The app will show "error" state until a backend is connected.
- Triple-click the "HCI Voice Assistant" title to open hidden connection settings.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
