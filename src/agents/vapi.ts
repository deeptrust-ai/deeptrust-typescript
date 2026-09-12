/**
 * VAPI adapter.
 *
 *     import { DeepTrust } from "deeptrust-ai/agents";
 *     import { Webhook } from "deeptrust-ai/agents/vapi";
 *
 *     const webhook = new Webhook(new DeepTrust(), { apiKey: process.env.VAPI_API_KEY! });
 *
 *     app.post("/vapi", async (req, res) => {
 *       await webhook.handle(req.body);
 *       res.status(200).end();
 *     });
 *
 * VAPI POSTs server messages to the customer's own webhook route, so unlike the
 * ElevenLabs monitor there is no connection to hold. `handle` reads the call's
 * final `transcript` messages, analyzes the transcript when the caller has said
 * something new, and delivers any nudge back out over the call's
 * `monitor.controlUrl`.
 *
 * A nudge is sent as an `add-message` with `triggerResponseEnabled: true`, so
 * the agent responds to it immediately rather than folding it into its next
 * turn. VAPI nudges therefore behave like LiveKit's interrupt, not like the
 * ElevenLabs contextual update.
 *
 * `controlUrl` is taken from the webhook payload when VAPI includes it and it
 * points at a VAPI host, and otherwise fetched once per call from
 * `GET /call/{id}` with the VAPI API key. `monitor.listenUrl` carries raw
 * audio and is ignored.
 *
 * `handle` trusts the payload it is given. Verify the request first, for
 * example by checking the `x-vapi-secret` header against the server URL
 * secret configured in VAPI, and only then pass the body in.
 */

import { ConfigError } from "../errors.js";
import type { Nudge, User } from "../types.js";
import type { DeepTrust } from "./index.js";
import type { Session } from "./session.js";

export const API_URL = "https://api.vapi.ai";
export const CONTROL_URL_HOST = "vapi.ai";

export function addMessageCommand(text: string) {
  return {
    type: "add-message",
    message: { role: "system", content: text },
    triggerResponseEnabled: true,
  };
}

export function add_message_command(text: string) {
  return addMessageCommand(text);
}

export interface WebhookOptions {
  apiKey?: string;
  deliver?: boolean;
  onAnalysis?: (analysis: unknown) => void;
  fetch?: typeof globalThis.fetch;
  apiUrl?: string;
}

export class Webhook {
  private readonly dt: DeepTrust;
  private readonly key: string | undefined;
  private readonly deliver: boolean;
  private readonly onAnalysis: ((analysis: unknown) => void) | undefined;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly apiUrl: string;
  private readonly sessions = new Map<string, Session>();
  private readonly controlUrls = new Map<string, string>();
  private readonly last = new Map<string, Record<string, string>>();

  constructor(dt: DeepTrust, options: WebhookOptions = {}) {
    this.dt = dt;
    this.key = options.apiKey;
    this.deliver = options.deliver ?? true;
    this.onAnalysis = options.onAnalysis;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.apiUrl = trimSlashes(options.apiUrl ?? API_URL);
  }

  /**
   * Feed one VAPI server message. Call this from the webhook route with the
   * parsed request body. Returns the DeepTrust session for the call, or null
   * when the payload does not belong to a call.
   */
  async handle(payload: unknown, options: { user?: User } = {}): Promise<Session | null> {
    const message = readMessage(payload);
    const callInfo = objectValue(message.call);
    const callId = typeof callInfo.id === "string" ? callInfo.id : "";
    if (!callId) {
      return null;
    }

    const monitor = objectValue(callInfo.monitor);
    if (typeof monitor.controlUrl === "string" && isControlUrl(monitor.controlUrl)) {
      this.controlUrls.set(callId, monitor.controlUrl);
    }

    const call = this.session(callId, options.user);

    if (message.type === "end-of-call-report") {
      this.forget(callId);
      await call.end();
      return call;
    }

    const [role, text] = readTurn(message);
    if (!text || (role !== "user" && role !== "agent")) {
      return call;
    }
    const last = this.last.get(callId) ?? {};
    if (last[role] === text) {
      return call;
    }
    last[role] = text;
    this.last.set(callId, last);

    call.append(role, text);
    if (role !== "user") {
      return call;
    }
    const result = await call.analyze();
    if (!result) {
      return call;
    }
    this.onAnalysis?.(result);
    if (!this.deliver) {
      return call;
    }
    const controlUrl = await this.controlUrl(callId);
    await Promise.all(result.nudges.map((nudge) => this.send(controlUrl, nudge)));
    return call;
  }

  /** The DeepTrust session for a call, if one has been seen. */
  sessionFor(callId: string): Session | undefined {
    return this.sessions.get(callId);
  }

  isWatching(callId: string): boolean {
    return this.sessions.has(callId);
  }

  private session(callId: string, user: User | undefined): Session {
    let call = this.sessions.get(callId);
    if (!call) {
      call = this.dt.session({
        externalId: callId,
        platform: "vapi",
        ...(user !== undefined ? { user } : {}),
      });
      this.sessions.set(callId, call);
    }
    return call;
  }

  private forget(callId: string): void {
    this.sessions.delete(callId);
    this.controlUrls.delete(callId);
    this.last.delete(callId);
  }

  private async controlUrl(callId: string): Promise<string> {
    const cached = this.controlUrls.get(callId);
    if (cached) {
      return cached;
    }
    if (!this.key) {
      throw new ConfigError(
        "Webhook needs a VAPI API key to look up the call's controlUrl when the webhook payload does not carry monitor.controlUrl.",
      );
    }
    const response = await this.fetchImpl(`${this.apiUrl}/call/${callId}`, {
      method: "GET",
      headers: { authorization: `Bearer ${this.key}` },
    });
    if (!response.ok) {
      throw new ConfigError(`VAPI GET /call/${callId} failed with ${response.status}`);
    }
    const data = objectValue(await response.json());
    const url = objectValue(data.monitor).controlUrl;
    if (typeof url !== "string" || !url) {
      throw new ConfigError(`VAPI call ${callId} has no monitor.controlUrl`);
    }
    this.controlUrls.set(callId, url);
    return url;
  }

  private async send(controlUrl: string, nudge: Nudge): Promise<void> {
    await this.fetchImpl(controlUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(addMessageCommand(nudge.render())),
    });
  }
}

/**
 * Read a turn from a VAPI `transcript` server message. Only final transcripts
 * count: partials repeat the same sentence as it is being recognised and
 * would be analyzed over and over.
 */
export function readTurn(message: Record<string, unknown>): ["user" | "agent" | "", string] {
  if (message.type !== "transcript" || message.transcriptType !== "final") {
    return ["", ""];
  }
  const text = String(message.transcript ?? "").trim();
  if (message.role === "user") {
    return ["user", text];
  }
  if (message.role === "assistant") {
    return ["agent", text];
  }
  return ["", ""];
}

export const _read_turn = readTurn;

/** True for an https URL on a VAPI host. Anything else in a payload is ignored. */
export function isControlUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const host = url.hostname;
  return url.protocol === "https:" && (host === CONTROL_URL_HOST || host.endsWith(`.${CONTROL_URL_HOST}`));
}

function trimSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") {
    end -= 1;
  }
  return value.slice(0, end);
}

function readMessage(payload: unknown): Record<string, unknown> {
  const body = objectValue(payload);
  return "message" in body ? objectValue(body.message) : body;
}

function objectValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
