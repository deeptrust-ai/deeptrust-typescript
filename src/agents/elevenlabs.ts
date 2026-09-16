import { WebSocket } from "ws";
import { ConfigError } from "../errors.js";
import type { User } from "../types.js";
import type { DeepTrust } from "./index.js";
import type { Session } from "./session.js";

export const MONITOR_URL = "wss://api.elevenlabs.io/v1/convai/conversations/{cid}/monitor";

export function contextualUpdateCommand(text: string) {
  return {
    command_type: "contextual_update",
    parameters: { contextual_update: text },
  };
}

export function contextual_update_command(text: string) {
  return contextualUpdateCommand(text);
}

export type MonitorConnect = (url: string, options: { headers: Record<string, string> }) => WebSocketLike;

export interface WebSocketLike {
  on(event: "message", handler: (data: unknown) => void): void;
  on(event: "close", handler: () => void): void;
  on(event: "error", handler: (error: Error) => void): void;
  send(data: string): void;
  close?: () => void;
}

export interface MonitorOptions {
  apiKey: string;
  deliver?: boolean;
  onAnalysis?: (analysis: unknown) => void;
  connect?: MonitorConnect;
}

interface Watched {
  ws: WebSocketLike;
  session: Session;
}

export class Monitor {
  private readonly dt: DeepTrust;
  private readonly key: string;
  private readonly deliver: boolean;
  private readonly onAnalysis: ((analysis: unknown) => void) | undefined;
  private readonly connect: MonitorConnect;
  // The session is held alongside the socket, not discarded after `watch`.
  // Ending the DeepTrust call is what runs post-processing on it -- the name,
  // the voice analysis, the findings -- so a session nobody can reach is a
  // call that stays open until the backend's stale-call sweep gets to it.
  private readonly watching = new Map<string, Watched>();

  constructor(dt: DeepTrust, options: MonitorOptions) {
    if (!options.apiKey) {
      throw new ConfigError(
        "Monitor needs an ElevenLabs API key with workspace access. It reads the conversation and sends contextual updates back.",
      );
    }
    this.dt = dt;
    this.key = options.apiKey;
    this.deliver = options.deliver ?? true;
    this.onAnalysis = options.onAnalysis;
    this.connect =
      options.connect ??
      ((url, connectOptions) => new WebSocket(url, { headers: connectOptions.headers }));
  }

  async watch(conversationId: string, options: { user?: User } = {}): Promise<void> {
    if (this.watching.has(conversationId)) {
      return;
    }
    const url = MONITOR_URL.replace("{cid}", conversationId);
    const ws = this.connect(url, { headers: { "xi-api-key": this.key } });
    const call = this.dt.session({
      externalId: conversationId,
      platform: "elevenlabs",
      ...(options.user !== undefined ? { user: options.user } : {}),
    });
    this.watching.set(conversationId, { ws, session: call });

    ws.on("message", (data) => {
      void (async () => {
        const event = readJson(data);
        const [role, text] = readTurn(event);
        if (!text) {
          return;
        }
        if (role !== "user" && role !== "agent") {
          return;
        }
        call.append(role, text);
        if (role !== "user") {
          return;
        }
        const result = await call.analyze();
        if (!result) {
          return;
        }
        this.onAnalysis?.(result);
        if (!this.deliver) {
          return;
        }
        for (const nudge of result.nudges) {
          ws.send(JSON.stringify(contextualUpdateCommand(nudge.render())));
        }
      })();
    });
    // A close is the conversation finishing: ElevenLabs closes the monitor
    // socket when the call ends, so this is the signal to end the DeepTrust
    // call too.
    ws.on("close", () => {
      void this.release(conversationId, true);
    });
    // An error is not. The socket may come back, and ending here would mean a
    // re-watch opens a *second* call for one conversation and splits the
    // transcript across both. Untracking without ending lets `watch` run
    // again and reattach to the same still-active call; the backend's
    // stale-call sweep remains the backstop if it never does.
    ws.on("error", () => {
      void this.release(conversationId, false);
    });
  }

  async stop(conversationId: string): Promise<void> {
    const watched = this.watching.get(conversationId);
    // Untracked first, so the socket's own close handler finds nothing and
    // this is the only end.
    this.watching.delete(conversationId);
    watched?.ws.close?.();
    if (watched) {
      await watched.session.end();
    }
  }

  isWatching(conversationId: string): boolean {
    return this.watching.has(conversationId);
  }

  /**
   * Drop a conversation, ending its DeepTrust call when `end` is set.
   *
   * Idempotent: whichever of close, error or `stop` arrives first takes the
   * entry, and the rest are no-ops. A failure to end is swallowed -- this runs
   * from a socket event with nowhere to throw, and the call still closes on
   * the backend's stale-call sweep.
   */
  private async release(conversationId: string, end: boolean): Promise<void> {
    const watched = this.watching.get(conversationId);
    if (!watched) {
      return;
    }
    this.watching.delete(conversationId);
    if (!end) {
      return;
    }
    try {
      await watched.session.end();
    } catch {
      // Intentionally ignored; see above.
    }
  }
}

export function readTurn(event: Record<string, unknown>): ["user" | "agent" | "", string] {
  if (event.type === "user_transcript") {
    const payload = objectValue(event.user_transcription_event);
    return ["user", String(payload.user_transcript ?? "").trim()];
  }
  if (event.type === "agent_response") {
    const payload = objectValue(event.agent_response_event);
    return ["agent", String(payload.agent_response ?? "").trim()];
  }
  return ["", ""];
}

export const _read_turn = readTurn;

function readJson(data: unknown): Record<string, unknown> {
  try {
    const value = JSON.parse(String(data));
    return objectValue(value);
  } catch {
    return {};
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
