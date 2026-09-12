import {
  AuthError,
  ConfigError,
  DeepTrustError,
  EntitlementError,
  RateLimited,
  ScopeError,
  ServiceError,
} from "./errors.js";
import { VERSION } from "./version.js";

export const DEFAULT_BASE_URL = "https://app.deeptrust.ai/api/v1";
export const API_KEY_HEADER = "X-DeepTrust-Api-Key";
export const USER_AGENT = `deeptrust-typescript/${VERSION}`;

export interface HttpOptions {
  apiKey?: string;
  baseUrl?: string;
  timeout?: number;
  maxRetries?: number;
  fetch?: typeof globalThis.fetch;
}

type JsonBody = Record<string, unknown>;

export class Http {
  readonly baseUrl: string;
  readonly maxRetries: number;
  private readonly key: string;
  private readonly timeout: number;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: HttpOptions = {}) {
    const key = options.apiKey ?? process.env.DEEPTRUST_API_KEY;
    if (!key) {
      throw new ConfigError(
        "no API key. Pass apiKey or set DEEPTRUST_API_KEY. Keys are created per organisation in the DeepTrust dashboard.",
      );
    }
    this.baseUrl = (options.baseUrl || process.env.DEEPTRUST_BASE_URL || DEFAULT_BASE_URL).replace(
      /\/+$/,
      "",
    );
    this.key = key;
    this.timeout = options.timeout ?? 30_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  async post(path: string, body?: JsonBody): Promise<JsonBody> {
    let last: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        const response = await this.request("POST", path, body);
        if (response.status >= 500 && attempt < this.maxRetries) {
          continue;
        }
        return await this.unwrap(response);
      } catch (error) {
        last = error;
        if (error instanceof DeepTrustError) {
          throw error;
        }
        if (attempt === this.maxRetries) {
          throw new ServiceError(error instanceof Error ? error.message : String(error), 0);
        }
      }
    }
    throw new ServiceError(last instanceof Error ? last.message : String(last), 0);
  }

  async get(path: string, params?: Record<string, unknown>): Promise<JsonBody> {
    const query = params ? `?${new URLSearchParams(toSearchParams(params)).toString()}` : "";
    return await this.unwrap(await this.request("GET", `${path}${query}`));
  }

  private async request(method: string, path: string, body?: JsonBody): Promise<Response> {
    const init: RequestInit = {
      method,
      headers: {
        [API_KEY_HEADER]: this.key,
        "content-type": "application/json",
        "user-agent": USER_AGENT,
      },
    };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }
    const controller = this.timeout > 0 ? new AbortController() : undefined;
    const timeout =
      controller !== undefined ? setTimeout(() => controller.abort(), this.timeout) : undefined;
    if (controller !== undefined) {
      init.signal = controller.signal;
    }
    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, init);
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    }
  }

  private async unwrap(response: Response): Promise<JsonBody> {
    const requestId = response.headers.get("x-request-id") ?? undefined;
    if (response.ok) {
      const value = (await response.json()) as unknown;
      return isObject(value) ? value : {};
    }

    const [detail, fields] = await readError(response);
    if (response.status === 401 || response.status === 403) {
      const code = typeof fields.code === "string" ? fields.code : "";
      if (code === "missing_scope") {
        const held = Array.isArray(fields.scopes) ? fields.scopes.map(String) : [];
        throw new ScopeError(String(fields.needed ?? "this operation"), held);
      }
      if (code === "not_entitled") {
        throw new EntitlementError(
          detail ||
            "this organisation is not set up for agent calls. Ask your DeepTrust contact to enable it.",
        );
      }
      throw new AuthError(detail || "the API key was rejected");
    }
    if (response.status === 429) {
      const retryAfter = response.headers.get("retry-after");
      throw new RateLimited(detail || "rate limited", retryAfter ? Number(retryAfter) : undefined);
    }
    throw new ServiceError(detail || "request failed", response.status, requestId);
  }
}

async function readError(response: Response): Promise<[string, Record<string, unknown>]> {
  const text = await response.text();
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return [text.slice(0, 300), {}];
  }
  if (!isObject(payload)) {
    return [String(payload).slice(0, 300), {}];
  }
  const fields = { ...payload };
  const detail = payload.detail;
  let message: unknown;
  if (isObject(detail)) {
    Object.assign(fields, detail);
    message = detail.message ?? detail.detail ?? detail.error;
  } else {
    message = detail ?? payload.message ?? payload.error;
  }
  return [String(message ?? ""), fields];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toSearchParams(params: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(params)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([key, value]) => [key, String(value)]),
  );
}
