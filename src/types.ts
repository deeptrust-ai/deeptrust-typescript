export type Role = "user" | "agent" | "system";
export type RiskLevel = "low" | "medium" | "high";
export type Decision = "allow" | "warn" | "deny" | "hold";
export type Resolution = "resolve_on_call" | "ticket" | "handover" | "none";
export type JsonObject = Record<string, unknown>;

export interface TurnWire {
  role: Role;
  text: string;
  at?: number;
  speaker?: string;
}

export interface UserWire {
  id: string;
  role: string;
  name?: string | null;
  verified: boolean;
  verified_via?: string | null;
}

export class Turn {
  readonly role: Role;
  readonly text: string;
  readonly at: number | undefined;
  readonly speaker: string | undefined;

  constructor(role: Role, text: string, options: { at?: number; speaker?: string } = {}) {
    this.role = role;
    this.text = text;
    this.at = options.at;
    this.speaker = options.speaker;
  }

  render(): string {
    return `${this.speaker ?? this.role}: ${this.text}`;
  }

  toWire(): TurnWire {
    return {
      role: this.role,
      text: this.text,
      ...(this.at !== undefined ? { at: this.at } : {}),
      ...(this.speaker !== undefined ? { speaker: this.speaker } : {}),
    };
  }
}

export class Transcript {
  readonly turns: Turn[];

  constructor(turns: Turn[] = []) {
    this.turns = turns;
  }

  append(role: Role, text: string, options: { at?: number; speaker?: string } = {}): Turn {
    const turn = new Turn(role, text, options);
    this.turns.push(turn);
    return turn;
  }

  toWire(): TurnWire[] {
    return this.turns.map((turn) => turn.toWire());
  }

  render(): string {
    return this.turns.map((turn) => turn.render()).join("\n");
  }

  get length(): number {
    return this.turns.length;
  }
}

export class User {
  readonly id: string;
  readonly role: string;
  readonly name: string | null | undefined;
  readonly verified: boolean;
  readonly verifiedVia: string | null | undefined;

  constructor(
    id: string,
    options: {
      role?: string;
      name?: string | null;
      verified?: boolean;
      verifiedVia?: string | null;
      verified_via?: string | null;
    } = {},
  ) {
    this.id = id;
    this.role = options.role ?? "MEMBER";
    this.name = options.name;
    this.verified = options.verified ?? false;
    this.verifiedVia = options.verifiedVia ?? options.verified_via;
  }

  toWire(): UserWire {
    return {
      id: this.id,
      role: this.role,
      name: this.name ?? null,
      verified: this.verified,
      verified_via: this.verifiedVia ?? null,
    };
  }
}

export class Nudge {
  readonly title: string;
  readonly description: string;
  readonly details: string;
  /**
   * Stable for the same nudge wherever it arrives: on an analysis and on a
   * pushed LiveKit packet alike, so a receiver that gets it both ways acts on
   * it once. Older backends do not send it.
   */
  readonly id: string | undefined;

  constructor(title: string, description: string, details: string, id?: string) {
    this.title = title;
    this.description = description;
    this.details = details;
    this.id = id;
  }

  render(): string {
    return [this.description, this.details].filter(Boolean).join(" ").trim();
  }
}

export interface Finding {
  kind: string;
  detail: string;
  sopId?: string;
  control?: string;
  riskLevel?: RiskLevel;
  confidence?: number;
  nudge?: Nudge;
  raw: JsonObject;
}

export interface SopProgress {
  sopId: string;
  name: string;
  applicable: boolean;
  inProgress: boolean;
  beingFollowed: boolean;
  stepsCompleted: number[];
  stepsTotal: number;
}

export class Analysis {
  readonly sessionId: string;
  readonly jobId: string;
  readonly findings: Finding[];
  readonly progress: SopProgress[];
  readonly riskLevel: RiskLevel | undefined;
  readonly confidence: number | undefined;
  readonly reasoning: string | undefined;
  readonly latencyMs: number;
  readonly raw: JsonObject;

  constructor(options: {
    sessionId: string;
    jobId: string;
    findings?: Finding[];
    progress?: SopProgress[];
    riskLevel?: RiskLevel;
    confidence?: number;
    reasoning?: string;
    latencyMs?: number;
    raw?: JsonObject;
  }) {
    this.sessionId = options.sessionId;
    this.jobId = options.jobId;
    this.findings = options.findings ?? [];
    this.progress = options.progress ?? [];
    this.riskLevel = options.riskLevel;
    this.confidence = options.confidence;
    this.reasoning = options.reasoning;
    this.latencyMs = options.latencyMs ?? 0;
    this.raw = options.raw ?? {};
  }

  get nudges(): Nudge[] {
    return this.findings.flatMap((finding) => (finding.nudge ? [finding.nudge] : []));
  }
}

export interface Verdict {
  decision: Decision;
  blocked: boolean;
  reason: string;
  resolution: Resolution;
  instruction: string;
  control?: string;
  message?: string;
  latencyMs: number;
  raw: JsonObject;
}
