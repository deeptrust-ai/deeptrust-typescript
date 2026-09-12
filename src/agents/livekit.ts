import type { DeepTrust } from "./index.js";
import type { Nudge, User } from "../types.js";

export interface LiveKitChatContext {
  copy(): LiveKitChatContext;
  addMessage(message: { role: string; content: string }): void;
}

export interface LiveKitAgent {
  chat_ctx: LiveKitChatContext;
  update_chat_ctx(chat: LiveKitChatContext): Promise<void>;
}

export interface LiveKitAgentSession {
  current_agent?: LiveKitAgent;
  on(event: "conversation_item_added"): (handler: (event: unknown) => void) => void;
  interrupt(): void;
  generate_reply(options: { instructions: string } | string): void;
}

export interface AttachOptions {
  externalId: string;
  agent?: LiveKitAgent;
  user?: User;
  interrupt?: boolean;
  onAnalysis?: (analysis: unknown) => void;
}

export function attach(agentSession: LiveKitAgentSession, dt: DeepTrust, options: AttachOptions) {
  const call = dt.session({
    externalId: options.externalId,
    platform: "livekit",
    ...(options.user !== undefined ? { user: options.user } : {}),
  });
  const interrupt = options.interrupt ?? true;
  const last: Record<string, string> = {};

  async function deliver(nudge: Nudge): Promise<void> {
    const text = nudge.render();
    const target = options.agent ?? agentSession.current_agent;
    if (!target) {
      return;
    }
    const chat = target.chat_ctx.copy();
    chat.addMessage({ role: "system", content: text });
    await target.update_chat_ctx(chat);
    if (interrupt) {
      agentSession.interrupt();
      agentSession.generate_reply({ instructions: text });
    }
  }

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
    await Promise.all(result.nudges.map((nudge) => deliver(nudge)));
  }

  agentSession.on("conversation_item_added")((event: unknown) => {
    const item = getObject(event, "item");
    const text = typeof item.text_content === "string" ? item.text_content : "";
    if (!text) {
      return;
    }
    const role = item.role === "user" ? "user" : "agent";
    if (last[role] === text) {
      return;
    }
    last[role] = text;
    void run(role, text);
  });

  return call;
}

function getObject(value: unknown, key: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return {};
  }
  const child = (value as Record<string, unknown>)[key];
  return typeof child === "object" && child !== null ? (child as Record<string, unknown>) : {};
}
