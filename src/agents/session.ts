import { Http } from "../http.js";
import {
  Analysis,
  type Finding,
  type JsonObject,
  Nudge,
  type Role,
  type SopProgress,
  Transcript,
  type User,
  type Verdict,
} from "../types.js";

export interface SessionOptions {
  http: Http;
  externalId: string;
  user?: User;
  platform: string;
  metadata: JsonObject;
}

export class Session {
  readonly externalId: string;
  readonly user: User | undefined;
  readonly platform: string;
  readonly metadata: JsonObject;
  readonly transcript = new Transcript();
  id?: string;
  private readonly http: Http;
  private analyzedUpto = 0;

  constructor(options: SessionOptions) {
    this.http = options.http;
    this.externalId = options.externalId;
    this.user = options.user;
    this.platform = options.platform;
    this.metadata = options.metadata;
  }

  append(role: Role, text: string, options: { at?: number; speaker?: string } = {}) {
    return this.transcript.append(role, text, options);
  }

  get pending(): number {
    return this.transcript.length - this.analyzedUpto;
  }

  async analyze(options: { force?: boolean } = {}): Promise<Analysis | null> {
    if (!options.force && this.pending === 0) {
      return null;
    }

    const started = performance.now();
    const body: JsonObject = {
      external_id: this.externalId,
      platform: this.platform,
      turns: this.transcript.toWire(),
      metadata: this.metadata,
    };
    if (this.id) {
      body.session_id = this.id;
    }
    if (this.user) {
      body.user = this.user.toWire();
    }

    const data = await this.http.post("/agents/analyze", body);
    this.id = String(data.session_id ?? this.id ?? "");
    this.analyzedUpto = this.transcript.length;

    const riskLevel = toRiskLevel(data.risk_level);
    const confidence = toNumber(data.confidence);
    const analysisOptions = {
      sessionId: this.id,
      jobId: String(data.job_id ?? ""),
      findings: asArray(data.findings).map(toFinding),
      progress: asArray(data.progress).map(toProgress),
      latencyMs: Math.round((performance.now() - started) * 100) / 100,
      raw: data,
      ...(riskLevel !== undefined ? { riskLevel } : {}),
      ...(confidence !== undefined ? { confidence } : {}),
      ...(typeof data.reasoning === "string" ? { reasoning: data.reasoning } : {}),
    };
    return new Analysis(analysisOptions);
  }

  async end(): Promise<boolean> {
    if (!this.id) {
      return false;
    }
    const data = await this.http.post(`/agents/sessions/${this.id}/end`);
    return Boolean(data.ended) && !Boolean(data.already_ended);
  }

  async check(_options: {
    action: string;
    args?: Record<string, unknown>;
    facts?: Record<string, unknown>;
  }): Promise<Verdict> {
    throw new Error(
      "Session.check is not implemented in this version. This release covers analysis and nudge delivery.",
    );
  }
}

function toFinding(value: unknown): Finding {
  const data = isObject(value) ? value : {};
  const finding: Finding = {
    kind: String(data.kind ?? "finding"),
    detail: String(data.detail ?? ""),
    raw: data,
  };
  if (typeof data.sop_id === "string") finding.sopId = data.sop_id;
  if (typeof data.control === "string") finding.control = data.control;
  const riskLevel = toRiskLevel(data.risk_level);
  if (riskLevel !== undefined) finding.riskLevel = riskLevel;
  const confidence = toNumber(data.confidence);
  if (confidence !== undefined) finding.confidence = confidence;
  const nudge = toNudge(data.nudge);
  if (nudge !== undefined) finding.nudge = nudge;
  return finding;
}

function toNudge(value: unknown): Nudge | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  const id = typeof value.id === "string" && value.id ? value.id : undefined;
  return new Nudge(
    String(value.title ?? ""),
    String(value.description ?? ""),
    String(value.details ?? ""),
    id,
  );
}

function toProgress(value: unknown): SopProgress {
  const data = isObject(value) ? value : {};
  return {
    sopId: String(data.sop_id ?? ""),
    name: String(data.name ?? ""),
    applicable: Boolean(data.applicable),
    inProgress: Boolean(data.in_progress),
    beingFollowed: data.being_followed === undefined ? true : Boolean(data.being_followed),
    stepsCompleted: asArray(data.steps_completed).map(Number),
    stepsTotal: Number(data.steps_total ?? 0),
  };
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function toNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function toRiskLevel(value: unknown): "low" | "medium" | "high" | undefined {
  return value === "low" || value === "medium" || value === "high" ? value : undefined;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
