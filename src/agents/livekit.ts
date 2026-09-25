/**
 * LiveKit adapter, for agents built on `@livekit/agents` (agents-js).
 *
 * Two ways in:
 *
 * - `listen(room, session)` is the cloud way. The LiveKit project is connected
 *   in the DeepTrust dashboard, DeepTrust follows the call on its own, and
 *   nudges arrive in the room as data packets on topic `deeptrust.nudge`. This
 *   side only hands them to the agent. It never calls the DeepTrust API.
 * - `attach(session, dt, { room })` is the SDK way. Turns are sent from here
 *   and analyzed on each caller turn, and nudges come back on the analysis. Pass
 *   `room` as well and pushed nudges are taken too; a nudge that arrives both
 *   ways is delivered once.
 *
 * A nudge is added to the agent's chat context as a system message. By default
 * it also interrupts: the agent runs in this process, so a nudge can land while
 * it is still speaking and stop that reply, and the next reply is generated
 * with the nudge in context. Pass `interrupt: false` to add it to the context
 * and let the current reply finish.
 *
 * The LiveKit packages are optional peer dependencies. Only their types are
 * imported here, so nothing from them is loaded at runtime.
 */
import type { voice } from "@livekit/agents";
import type { DataPacketKind, RemoteParticipant, Room, RoomEvent } from "@livekit/rtc-node";
import type { DeepTrust, Session } from "./index.js";
import { type Analysis, Nudge, type User } from "../types.js";

/** The data topic DeepTrust pushes nudges on. */
export const NUDGE_TOPIC = "deeptrust.nudge";

// The event names as the real enums spell them. Written out rather than read
// off the enums because the enums are runtime values, and importing them would
// make `@livekit/agents` a hard dependency of this module.
const CONVERSATION_ITEM_ADDED = "conversation_item_added" as voice.AgentSessionEventTypes.ConversationItemAdded;
const SESSION_CLOSE = "close" as voice.AgentSessionEventTypes.Close;
const DATA_RECEIVED = "dataReceived" as RoomEvent.DataReceived;

export interface DeliveryOptions {
  /** The agent to deliver to. Defaults to `session.currentAgent`. */
  agent?: voice.Agent;
  /** Interrupt the reply in progress and reply again with the nudge. Default true. */
  interrupt?: boolean;
  /** Called once for each nudge that is delivered, after dedupe. */
  onNudge?: (nudge: Nudge) => void;
  /**
   * Called when analysis, delivery or ending the call fails. None of these
   * throw into LiveKit's event loop. Defaults to `console.error`.
   */
  onError?: (error: unknown) => void;
}

export interface ListenOptions extends DeliveryOptions {}

export interface AttachOptions extends DeliveryOptions {
  /** Take pushed nudges from this room as well as from analysis. */
  room?: Room;
  /** The call's id on your side. Defaults to `room.name`. */
  externalId?: string;
  user?: User;
  onAnalysis?: (analysis: Analysis) => void;
}

/** Stops listening. Calling it more than once is harmless. */
export type Detach = () => void;

/** What `attach` returns: a detach function that also carries the DeepTrust session. */
export interface Attached extends Detach {
  readonly session: Session;
}

/**
 * Deliver nudges pushed into `room` to the agent in `session`.
 *
 * For a LiveKit project connected in the DeepTrust dashboard. DeepTrust
 * follows the call without any help from this process, so this makes no
 * DeepTrust API call and needs no DeepTrust key. It stops by itself when the
 * session closes.
 */
export function listen(room: Room, session: voice.AgentSession, options: ListenOptions = {}): Detach {
  const inbox = createInbox(session, options);
  const stopPush = subscribeToPushes(room, inbox);
  let stopped = false;

  const stop: Detach = () => {
    if (stopped) {
      return;
    }
    stopped = true;
    stopPush();
    inbox.close();
    session.off(SESSION_CLOSE, stop);
  };
  session.on(SESSION_CLOSE, stop);
  return stop;
}

/**
 * Wire a LiveKit AgentSession to DeepTrust through the API.
 *
 * Every conversation item is appended to the DeepTrust session, and each
 * caller turn is analyzed. Agent turns are recorded without being analyzed:
 * feeding an agent's own replies back in doubles the work and lets its answers
 * reclassify the call.
 *
 * When the LiveKit session closes, the DeepTrust session is ended, so
 * post-call processing starts then rather than at the server's inactivity
 * timeout. Detaching early stops listening and leaves the call open; end it
 * with `attached.session.end()` when you are done.
 */
export function attach(session: voice.AgentSession, dt: DeepTrust, options: AttachOptions = {}): Attached {
  const externalId = options.externalId ?? options.room?.name;
  if (!externalId) {
    throw new TypeError("attach needs an externalId, or a connected room to take the name from");
  }
  const call = dt.session({
    externalId,
    platform: "livekit",
    ...(options.user !== undefined ? { user: options.user } : {}),
  });
  const inbox = createInbox(session, options);
  const stopPush = options.room ? subscribeToPushes(options.room, inbox) : () => {};
  const running = new Set<Promise<void>>();
  let stopped = false;

  // The last turn taken per role, so a repeat of it can be recognised. LiveKit
  // can emit a conversation item more than once for the same speech, and a
  // transcript that carries the same sentence twice is analysed twice.
  // Compared against the previous turn only: a caller who says the same thing
  // again later in the call means it.
  const last: Record<string, string> = {};

  async function run(role: "user" | "agent", text: string): Promise<void> {
    call.append(role, text);
    if (role !== "user") {
      return;
    }
    const result = await call.analyze();
    if (!result) {
      return;
    }
    options.onAnalysis?.(result);
    for (const nudge of result.nudges) {
      inbox.offer(nudge);
    }
  }

  const onItem = (event: voice.ConversationItemAddedEvent): void => {
    const item = event.item;
    if (item.type !== "message" || (item.role !== "user" && item.role !== "assistant")) {
      return;
    }
    const text = item.textContent ?? "";
    if (!text) {
      return;
    }
    const role = item.role === "user" ? "user" : "agent";
    if (last[role] === text) {
      return;
    }
    last[role] = text;
    const task = run(role, text).catch(inbox.report);
    running.add(task);
    void task.finally(() => running.delete(task));
  };

  const detach: Detach = () => {
    if (stopped) {
      return;
    }
    stopped = true;
    session.off(CONVERSATION_ITEM_ADDED, onItem);
    session.off(SESSION_CLOSE, onClose);
    stopPush();
    inbox.close();
  };

  function onClose(): void {
    detach();
    // An analysis still in flight is what gives the call its id, and a call
    // with no id cannot be ended, so it is waited for first.
    void Promise.allSettled([...running])
      .then(() => call.end())
      .catch(inbox.report);
  }

  session.on(CONVERSATION_ITEM_ADDED, onItem);
  session.on(SESSION_CLOSE, onClose);
  return Object.assign(detach, { session: call });
}

/**
 * Read a pushed nudge packet. Returns undefined for anything that is not one,
 * so a malformed packet is dropped rather than thrown into the room's event
 * loop.
 */
export function readNudgePacket(payload: Uint8Array): Nudge | undefined {
  let data: unknown;
  try {
    data = JSON.parse(new TextDecoder().decode(payload));
  } catch {
    return undefined;
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return undefined;
  }
  const packet = data as Record<string, unknown>;
  if (packet.type !== NUDGE_TOPIC) {
    return undefined;
  }
  const field = (key: string) => (typeof packet[key] === "string" ? (packet[key] as string) : "");
  const id = field("id") || undefined;
  const nudge = new Nudge(field("title"), field("description"), field("details"), id);
  if (nudge.render()) {
    return nudge;
  }
  // A packet that carries only the rendered sentence is still a nudge.
  const text = field("text");
  return text ? new Nudge(field("title"), text, "", id) : undefined;
}

interface Inbox {
  offer(nudge: Nudge): void;
  report(error: unknown): void;
  close(): void;
}

function createInbox(session: voice.AgentSession, options: DeliveryOptions): Inbox {
  const interrupt = options.interrupt ?? true;
  const report = options.onError ?? ((error: unknown) => console.error("deeptrust: livekit", error));
  const ids = new Set<string>();
  const texts = new Set<string>();
  // Deliveries run one at a time. Each copies the chat context, adds to it and
  // writes it back, so two at once would each drop the other's message.
  let queue: Promise<void> = Promise.resolve();
  let closed = false;

  async function inject(text: string): Promise<void> {
    const target = options.agent ?? session.currentAgent;
    const chat = target.chatCtx.copy();
    chat.addMessage({ role: "system", content: text });
    await target.updateChatCtx(chat);
    if (!interrupt) {
      return;
    }
    try {
      session.interrupt();
    } catch (error) {
      // The reply in progress may refuse interruption. The nudge still gets a
      // reply of its own, after that one.
      report(error);
    }
    // No instructions: the nudge is already in the context, and repeating it
    // here would hand the model the same text twice.
    session.generateReply();
  }

  return {
    offer(nudge: Nudge): void {
      const text = nudge.render();
      if (closed || !text) {
        return;
      }
      // By id when the backend sends one. By text as well, which is the only
      // key an older backend gives, and a nudge whose text was already
      // delivered adds nothing the second time.
      if ((nudge.id !== undefined && ids.has(nudge.id)) || texts.has(text)) {
        return;
      }
      if (nudge.id !== undefined) {
        ids.add(nudge.id);
      }
      texts.add(text);
      queue = queue
        .then(async () => {
          if (closed) {
            return;
          }
          await inject(text);
          options.onNudge?.(nudge);
        })
        .catch(report);
    },
    report,
    close(): void {
      closed = true;
    },
  };
}

function subscribeToPushes(room: Room, inbox: Inbox): Detach {
  const onData = (
    payload: Uint8Array,
    participant?: RemoteParticipant,
    _kind?: DataPacketKind,
    topic?: string,
  ): void => {
    if (topic !== NUDGE_TOPIC) {
      return;
    }
    // DeepTrust sends from the server API, which has no participant, so a
    // nudge that names a sender came from someone in the room. The other
    // person in the room is the one being screened, and a packet from them is
    // not a nudge: it is text they want the agent to treat as instructions.
    if (participant !== undefined) {
      return;
    }
    const nudge = readNudgePacket(payload);
    if (nudge) {
      inbox.offer(nudge);
    }
  };
  room.on(DATA_RECEIVED, onData);
  return () => {
    room.off(DATA_RECEIVED, onData);
  };
}
