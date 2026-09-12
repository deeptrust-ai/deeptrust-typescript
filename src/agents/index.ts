import { Http, type HttpOptions } from "../http.js";
import type { JsonObject, User } from "../types.js";
import { Session } from "./session.js";

export * from "../errors.js";
export * from "../types.js";
export { Http, type HttpOptions } from "../http.js";
export { Session } from "./session.js";

export interface DeepTrustOptions extends HttpOptions {}

export interface SessionCreateOptions {
  externalId: string;
  user?: User;
  platform?: string;
  metadata?: JsonObject;
}

export class DeepTrust {
  readonly http: Http;

  constructor(apiKeyOrOptions?: string | DeepTrustOptions, options: DeepTrustOptions = {}) {
    const merged =
      typeof apiKeyOrOptions === "string"
        ? { ...options, apiKey: apiKeyOrOptions }
        : { ...apiKeyOrOptions };
    this.http = new Http(merged);
  }

  session(options: SessionCreateOptions): Session {
    const sessionOptions = {
      http: this.http,
      externalId: options.externalId,
      platform: options.platform ?? "custom",
      metadata: options.metadata ?? {},
      ...(options.user !== undefined ? { user: options.user } : {}),
    };
    return new Session(sessionOptions);
  }

  async watch(
    conversationId: string,
    options: { platform?: string; agentId?: string | null } = {},
  ): Promise<boolean> {
    const data = await this.http.post(`/agents/conversations/${conversationId}/watch`, {
      platform: options.platform ?? "elevenlabs",
      agent_id: options.agentId ?? null,
    });
    return Boolean(data.started);
  }
}
