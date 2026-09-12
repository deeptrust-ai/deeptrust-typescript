export class DeepTrustError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class ConfigError extends DeepTrustError {}

export class AuthError extends DeepTrustError {}

export class EntitlementError extends DeepTrustError {}

export class ScopeError extends DeepTrustError {
  readonly needed: string;
  readonly held: string[];

  constructor(needed: string, held: string[] = []) {
    const heldText = held.length > 0 ? held.join(", ") : "none";
    super(
      `this key cannot ${needed}. It holds: ${heldText}. Add the ${needed} scope to the key, or use one that has it.`,
    );
    this.needed = needed;
    this.held = held;
  }
}

export class RateLimited extends DeepTrustError {
  readonly retryAfter: number | undefined;

  constructor(message: string, retryAfter?: number) {
    super(message);
    this.retryAfter = retryAfter;
  }
}

export class ServiceError extends DeepTrustError {
  readonly status: number;
  readonly requestId: string | undefined;

  constructor(message: string, status: number, requestId?: string) {
    super(`${message} (status ${status}, request ${requestId ?? "unknown"})`);
    this.status = status;
    this.requestId = requestId;
  }
}
