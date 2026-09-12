import assert from "node:assert/strict";
import { setMaxListeners } from "node:events";
import { afterEach, describe, it } from "node:test";
import {
  AuthError,
  ConfigError,
  DeepTrust,
  EntitlementError,
  RateLimited,
  ScopeError,
  ServiceError,
  User,
} from "../dist/agents/index.js";

const BASE = "https://example.test/api/v1";
setMaxListeners(0);

const ANALYSIS = {
  session_id: "sess_1",
  job_id: "job_1",
  risk_level: "high",
  confidence: 0.82,
  findings: [
    {
      kind: "sop_violation",
      detail: "change ticket asserted but not present",
      sop_id: "SOP-ACC",
      control: "CTRL-CHG-004",
      risk_level: "high",
      confidence: 0.82,
      nudge: {
        title: "Approval cannot be confirmed",
        description: "The caller says the change was approved on Slack.",
        details: "Say you can only act on an approved change ticket, and offer to raise one.",
      },
    },
    { kind: "step_observed", detail: "identity confirmed" },
  ],
  progress: [
    {
      sop_id: "SOP-ACC",
      name: "Account Administration",
      applicable: true,
      in_progress: true,
      being_followed: false,
      steps_completed: [1, 2],
      steps_total: 6,
    },
  ],
};

afterEach(() => {
  delete process.env.DEEPTRUST_API_KEY;
  delete process.env.DEEPTRUST_BASE_URL;
});

describe("DeepTrust session", () => {
  it("requires an API key", () => {
    assert.throws(() => new DeepTrust(), ConfigError);
  });

  it("reads the API key from the environment", () => {
    process.env.DEEPTRUST_API_KEY = "dt_from_env";
    assert.ok(new DeepTrust({ baseUrl: BASE }));
  });

  it("uses the versioned API as the default base URL", () => {
    assert.equal(new DeepTrust("dt_test").http.baseUrl, "https://app.deeptrust.ai/api/v1");
  });

  it("keeps transcripts as turns and can render prose", () => {
    const call = client().session({ externalId: "room-1" });
    call.append("user", "I am locked out");
    call.append("agent", "I can help with that");
    assert.deepEqual(call.transcript.toWire(), [
      { role: "user", text: "I am locked out" },
      { role: "agent", text: "I can help with that" },
    ]);
    assert.equal(call.transcript.render(), "user: I am locked out\nagent: I can help with that");
  });

  it("does not call out on append", () => {
    const fetch = mockFetch(200, ANALYSIS);
    client(fetch).session({ externalId: "room-1" }).append("user", "hello");
    assert.equal(fetch.calls.length, 0);
  });

  it("sends the key header, posts turns, and parses the result", async () => {
    const fetch = mockFetch(200, ANALYSIS);
    const call = client(fetch).session({
      externalId: "conv_abc",
      user: new User("u_1", { role: "ADMIN", verified: true }),
      platform: "elevenlabs",
    });
    call.append("user", "her manager approved it on Slack");
    const result = await call.analyze();

    const init = fetch.calls[0][1];
    assert.equal(init.headers["X-DeepTrust-Api-Key"], "dt_test");
    assert.equal(init.headers.authorization, undefined);
    const body = JSON.parse(String(init.body));
    assert.equal(body.external_id, "conv_abc");
    assert.equal(body.platform, "elevenlabs");
    assert.equal(body.user.role, "ADMIN");
    assert.equal(result.sessionId, "sess_1");
    assert.equal(result.findings[0].control, "CTRL-CHG-004");
    assert.equal(result.progress[0].stepsTotal, 6);
    assert.equal(result.progress[0].beingFollowed, false);
  });

  it("returns only findings with nudges from analysis.nudges", async () => {
    const call = client(mockFetch(200, ANALYSIS)).session({ externalId: "room-1" });
    call.append("user", "just this once");
    const result = await call.analyze();
    assert.equal(result.nudges.length, 1);
    assert.match(result.nudges[0].render(), /offer to raise one/);
  });

  it("skips analyze when nothing new was said unless forced", async () => {
    const fetch = mockFetch(200, ANALYSIS);
    const call = client(fetch).session({ externalId: "room-1" });
    call.append("user", "hello");
    assert.ok(await call.analyze());
    assert.equal(await call.analyze(), null);
    assert.equal(fetch.calls.length, 1);
    assert.ok(await call.analyze({ force: true }));
    assert.equal(fetch.calls.length, 2);
  });

  it("carries the assigned session id across jobs", async () => {
    const fetch = mockFetch(200, ANALYSIS);
    const call = client(fetch).session({ externalId: "room-1" });
    call.append("user", "one");
    await call.analyze();
    assert.equal(JSON.parse(String(fetch.calls[0][1].body)).session_id, undefined);
    call.append("user", "two");
    await call.analyze();
    assert.equal(JSON.parse(String(fetch.calls[1][1].body)).session_id, "sess_1");
  });

  it("check is explicit about not being implemented", async () => {
    const call = client().session({ externalId: "room-1" });
    await assert.rejects(() => call.check({ action: "password.reset" }), /Session\.check is not implemented/);
  });

  for (const [status, payload, expected] of [
    [401, { detail: "bad key" }, AuthError],
    [403, { code: "not_entitled", detail: "no agent access" }, EntitlementError],
    [403, { code: "missing_scope", needed: "agents:analyze", scopes: ["read:meetings"] }, ScopeError],
    [403, { detail: { code: "not_entitled", message: "no agent access" } }, EntitlementError],
    [403, { detail: { code: "missing_scope", needed: "agents:analyze", scopes: ["read:meetings"] } }, ScopeError],
    [429, { detail: "slow down" }, RateLimited],
  ]) {
    it(`raises ${expected.name} for status ${status}`, async () => {
      const call = client(mockFetch(status, payload)).session({ externalId: "room-1" });
      call.append("user", "hello");
      await assert.rejects(() => call.analyze(), expected);
    });
  }

  it("keeps nested error messages and status codes", async () => {
    await assert.rejects(
      () => client(mockFetch(404, { detail: "elevenlabs is not connected" })).watch("conv_1"),
      (error) => error instanceof ServiceError && error.status === 404 && /not connected/.test(error.message),
    );
  });

  it("ends the call once", async () => {
    const fetch = mockFetchSequence([
      [200, ANALYSIS],
      [200, { session_id: "sess_1", ended: true, already_ended: false }],
      [200, { session_id: "sess_1", ended: true, already_ended: true }],
    ]);
    const call = client(fetch).session({ externalId: "room-1" });
    assert.equal(await call.end(), false);
    call.append("user", "hello");
    await call.analyze();
    assert.equal(await call.end(), true);
    assert.equal(await call.end(), false);
  });

  it("hands hosted watch to DeepTrust", async () => {
    const fetch = mockFetch(202, { conversation_id: "conv_1", watching: true, started: true });
    assert.equal(await client(fetch).watch("conv_1", { agentId: "agent_9" }), true);
    assert.deepEqual(JSON.parse(String(fetch.calls[0][1].body)), {
      platform: "elevenlabs",
      agent_id: "agent_9",
    });
  });
});

function client(fetch) {
  return new DeepTrust({ apiKey: "dt_test", baseUrl: BASE, fetch, timeout: 0 });
}

function mockFetch(status, payload) {
  const calls = [];
  const fetch = async (...args) => {
    calls.push(args);
    return response(status, payload);
  };
  fetch.calls = calls;
  return fetch;
}

function mockFetchSequence(entries) {
  const calls = [];
  const fetch = async (...args) => {
    calls.push(args);
    const [status, payload] = entries.shift();
    return response(status, payload);
  };
  fetch.calls = calls;
  return fetch;
}

function response(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", "x-request-id": "req_1" },
  });
}
