/**
 * VAPI adapter. Mirrors `deeptrust.agents.vapi` in the Python SDK.
 *
 *     const bridge = new Bridge(new DeepTrust(), { apiKey: process.env.VAPI_API_KEY });
 *
 *     app.post("/vapi/webhook", async (req, res) => {   // your route, your server
 *       await bridge.handle(req.body, { user: caller });
 *       res.json({});
 *     });
 *
 * VAPI's transport is the mirror image of ElevenLabs'. There is no socket
 * anyone can hold open: VAPI posts its server-url events to *your* server, and
 * what goes back the other way goes to a per-call HTTPS endpoint VAPI mints for
 * that call and publishes on the call object as `monitor.controlUrl`. So the
 * adapter is a handler you call from inside your own webhook route rather than
 * a watcher with a loop of its own, and it needs no code inside your agent
 * either way.
 *
 * A nudge is delivered as `add-message` with `triggerResponseEnabled: true`,
 * which is an interrupt: VAPI hands the system message to the model and has it
 * respond immediately, cutting into what the agent is saying. That makes VAPI
 * behave like the LiveKit adapter rather than the ElevenLabs one, whose
 * contextual update is documented as non-interrupting and only shapes the turn
 * after the current one. A system message rather than a `say` because a `say`
 * would put our words in the agent's mouth verbatim, while a system message
 * lets the agent's own persona carry them.
 *
 * The control URL is read from the webhook payload when the event carries it,
 * and fetched with `GET /call/{id}` when it does not, then cached for the rest
 * of the call. Inbound calls are the case this exists for: nobody placed the
 * call, so there is no creation-time response to have captured a URL from, and
 * an adapter that assumed one would work for outbound calls only.
 *
 * `monitor.listenUrl` sits next to it and is deliberately ignored: it is a raw
 * PCM audio stream, not a channel anything can be sent on.
 *
 * Only final transcripts are read. VAPI emits a `transcript` event per partial
 * as the sentence is still being recognised, and analysing those re-analyses
 * the same sentence several times -- the same class of bug the LiveKit
 * adapter's `last` record guards against, arriving here by a different route.
 *
 * VAPI's `tool-calls` webhook is the one event whose response controls what the
 * agent does next, and this adapter does not answer it. Blocking a tool call is
 * `Session.check`, which is separate work; this is transcript in, nudge out.
 */

import { ConfigError } from "../errors.js";
import type { Analysis, Nudge, User } from "../types.js";
import type { DeepTrust } from "./index.js";
import type { Session } from "./session.js";

export const API_BASE_URL = "https://api.vapi.ai";

/**
 * The control-URL body that delivers a nudge as an interrupt.
 *
 * `triggerResponseEnabled` is what makes it one. Without it VAPI appends the
 * message and waits for the agent to reach its next turn on its own, which is
 * a different product: the caller is being worked on now.
 */
export function addMessageCommand(text: string) {
  return {
    type: "add-message",
    message: { role: "system", content: text },
    triggerResponseEnabled: true,
  };
}

export interface BridgeOptions {
  apiKey: string;
  deliver?: boolean;
  onAnalysis?: (analysis: unknown) => void;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
}

/**
 * Turns VAPI server-url events into DeepTrust calls, and nudges into messages
 * on the live call.
 *
 * One bridge serves every call your server receives; state is kept per VAPI
 * call id, and dropped when the call reports it ended.
 */
export class Bridge {
  private readonly dt: DeepTrust;
  private readonly key: string;
  private readonly deliver: boolean;
  private readonly onAnalysis: ((analysis: unknown) => void) | undefined;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly sessions = new Map<string, Session>();
  // Per call, because VAPI mints the URL per call. Cached because most events
  // carry it and the fetch is only for the ones that do not.
  private readonly control = new Map<string, string>();

  /**
   * `apiKey` is a VAPI private key: it reads the call object to find the
   * control URL when an event does not carry one.
   */
  constructor(dt: DeepTrust, options: BridgeOptions) {
    if (!options.apiKey) {
      throw new ConfigError(
        "Bridge needs a VAPI private API key. It reads the call to find monitor.controlUrl, which is where a nudge is sent.",
      );
    }
    this.dt = dt;
    this.key = options.apiKey;
    this.deliver = options.deliver ?? true;
    this.onAnalysis = options.onAnalysis;
    this.baseUrl = (options.baseUrl ?? API_BASE_URL).replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  /**
   * Process one server-url event. Resolves to the analysis it caused, if any.
   *
   * Call it for every event and let it decide: events that are not turns cost
   * nothing, and the ones that are not transcripts still carry the call object
   * the control URL is learned from.
   *
   * Resolves to null for an event that started no job, which is most of them.
   */
  async handle(payload: unknown, options: { user?: User } = {}): Promise<Analysis | null> {
    const message = readMessage(payload);
    const call = objectValue(message.call);
    const callId = String(call.id ?? "");
    if (!callId) {
      return null;
    }

    const url = monitorControlUrl(call);
    if (url) {
      this.control.set(callId, url);
    }

    if (message.type === "end-of-call-report") {
      await this.finish(callId);
      return null;
    }
    if (message.type !== "transcript") {
      return null;
    }

    const [role, text] = readTurn(message);
    if (!text || !role) {
      return null;
    }

    const dtCall = this.callSession(callId, options.user);
    dtCall.append(role, text);

    // Caller turns only. Feeding the agent's own replies back in doubles the
    // work and lets its answers reclassify the call.
    if (role !== "user") {
      return null;
    }

    const result = await dtCall.analyze();
    if (!result) {
      return null;
    }
    this.onAnalysis?.(result);
    if (this.deliver) {
      for (const nudge of result.nudges) {
        await this.sendNudge(callId, nudge);
      }
    }
    return result;
  }

  /**
   * Send one nudge into a live call. Resolves to whether VAPI took it.
   *
   * A call that has already ended publishes no control URL, so a nudge
   * produced from its last turn resolves false rather than throwing: the call
   * it was for is over, and the finding is already recorded.
   */
  async sendNudge(callId: string, nudge: Nudge): Promise<boolean> {
    const url = await this.controlUrl(callId);
    if (!url) {
      return false;
    }
    // No credential on this request. The control URL carries its own
    // authority and VAPI does not accept the private key here.
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(addMessageCommand(nudge.render())),
    });
    return response.ok;
  }

  /** The call's `monitor.controlUrl`, from cache or from VAPI. */
  async controlUrl(callId: string): Promise<string | undefined> {
    const cached = this.control.get(callId);
    if (cached) {
      return cached;
    }

    const response = await this.fetchImpl(`${this.baseUrl}/call/${callId}`, {
      headers: { authorization: `Bearer ${this.key}` },
    });
    if (!response.ok) {
      return undefined;
    }

    const body = (await response.json()) as unknown;
    const url = monitorControlUrl(objectValue(body));
    if (url) {
      this.control.set(callId, url);
    }
    return url;
  }

  /** The DeepTrust session for a call, so its transcript stays reachable. */
  session(callId: string): Session | undefined {
    return this.sessions.get(callId);
  }

  private callSession(callId: string, user: User | undefined): Session {
    const existing = this.sessions.get(callId);
    if (existing) {
      return existing;
    }
    const created = this.dt.session({
      externalId: callId,
      platform: "vapi",
      ...(user !== undefined ? { user } : {}),
    });
    this.sessions.set(callId, created);
    return created;
  }

  private async finish(callId: string): Promise<void> {
    this.control.delete(callId);
    const session = this.sessions.get(callId);
    this.sessions.delete(callId);
    await session?.end();
  }
}

/**
 * A turn from a transcript event, or ["", ""] if it is not one yet.
 *
 * Partials are not turns. VAPI sends one event per revision of the sentence
 * being recognised, all with the same `transcriptType: "partial"`, and only
 * the final one is the sentence the caller actually said.
 */
export function readTurn(message: Record<string, unknown>): ["user" | "agent" | "", string] {
  if (message.transcriptType !== "final") {
    return ["", ""];
  }
  const role = String(message.role ?? "") === "user" ? "user" : "agent";
  return [role, String(message.transcript ?? "").trim()];
}

/**
 * The event itself, out of the request body.
 *
 * VAPI wraps a server-url event in `{"message": {...}}`. A bare event is
 * accepted too, so a payload already unwrapped by your own framework still
 * works.
 */
export function readMessage(payload: unknown): Record<string, unknown> {
  const body = objectValue(payload);
  const message = body.message;
  return isObject(message) ? message : body;
}

/**
 * `monitor.controlUrl` off a call object, or undefined.
 *
 * Defensive about the shape rather than trusting it: this runs on the webhook
 * path, and a missing or renamed field has to read as "no control URL yet" --
 * which a fetch may still answer -- instead of as a throw inside your webhook
 * route.
 */
function monitorControlUrl(call: Record<string, unknown>): string | undefined {
  const monitor = objectValue(call.monitor);
  const url = monitor.controlUrl;
  return typeof url === "string" && url ? url : undefined;
}

function objectValue(value: unknown): Record<string, unknown> {
  return isObject(value) ? value : {};
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
