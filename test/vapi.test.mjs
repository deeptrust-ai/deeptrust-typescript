import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DeepTrust } from "../dist/agents/index.js";
import { addMessageCommand, readTurn, Webhook } from "../dist/agents/vapi.js";

const BASE = "https://example.test/api/v1";
const CONTROL_URL = "https://phone-call-websocket.aws-us-west-2-backend-production2.vapi.ai/call_1/control";
const NUDGE_TEXT =
  "The caller referred to someone else on the line. Ask one question and wait: is anyone helping them right now?";

const ONE_NUDGE = {
  session_id: "sess_1",
  job_id: "job_1",
  findings: [
    {
      kind: "coercion",
      detail: "third party instructing",
      nudge: {
        title: "Someone else may be coaching the caller",
        description: "The caller referred to someone else on the line.",
        details: "Ask one question and wait: is anyone helping them right now?",
      },
    },
  ],
};

function transcript(role, transcriptType, text, call = { id: "call_1" }) {
  return { message: { type: "transcript", role, transcriptType, transcript: text, call } };
}

describe("vapi", () => {
  it("reads final transcript messages only", () => {
    assert.deepEqual(readTurn({ type: "transcript", role: "user", transcriptType: "final", transcript: "hi " }), [
      "user",
      "hi",
    ]);
    assert.deepEqual(
      readTurn({ type: "transcript", role: "assistant", transcriptType: "final", transcript: "hello" }),
      ["agent", "hello"],
    );
    assert.deepEqual(readTurn({ type: "transcript", role: "user", transcriptType: "partial", transcript: "hi" }), [
      "",
      "",
    ]);
    assert.deepEqual(readTurn({ type: "speech-update", status: "started" }), ["", ""]);
  });

  it("builds add-message commands that trigger a response", () => {
    assert.deepEqual(addMessageCommand("hold the line"), {
      type: "add-message",
      message: { role: "system", content: "hold the line" },
      triggerResponseEnabled: true,
    });
  });

  it("analyzes final caller turns and posts nudges to the payload's controlUrl", async () => {
    const fetch = mockFetch(200, ONE_NUDGE);
    const vapi = fakeVapi();
    const webhook = new Webhook(new DeepTrust({ apiKey: "dt_test", baseUrl: BASE, fetch, timeout: 0 }), {
      fetch: vapi.fetch,
    });
    const call = { id: "call_1", monitor: { controlUrl: CONTROL_URL, listenUrl: "wss://ignored" } };

    await webhook.handle({ message: { type: "status-update", status: "in-progress", call } });
    await webhook.handle(transcript("assistant", "final", "IT desk, how can I help?", call));
    await webhook.handle(transcript("user", "partial", "my colleague is", call));
    await webhook.handle(transcript("user", "partial", "my colleague is telling me", call));
    const session = await webhook.handle(transcript("user", "final", "my colleague is telling me what to say", call));
    await webhook.handle(transcript("user", "final", "my colleague is telling me what to say", call));

    assert.equal(fetch.calls.length, 1);
    assert.equal(session.externalId, "call_1");
    assert.equal(session.platform, "vapi");
    assert.equal(session.transcript.length, 2);
    assert.deepEqual(
      session.transcript.turns.map((turn) => turn.role),
      ["agent", "user"],
    );
    assert.deepEqual(vapi.calls, [
      {
        url: CONTROL_URL,
        method: "POST",
        body: { type: "add-message", message: { role: "system", content: NUDGE_TEXT }, triggerResponseEnabled: true },
      },
    ]);
  });

  it("looks up controlUrl once when the payload does not carry it", async () => {
    const fetch = mockFetch(200, ONE_NUDGE);
    const vapi = fakeVapi();
    const webhook = new Webhook(new DeepTrust({ apiKey: "dt_test", baseUrl: BASE, fetch, timeout: 0 }), {
      apiKey: "vapi_test",
      fetch: vapi.fetch,
    });

    await webhook.handle(transcript("user", "final", "my colleague is telling me what to say"));
    await webhook.handle(transcript("user", "final", "he says to skip the ticket"));

    assert.equal(fetch.calls.length, 2);
    assert.equal(vapi.calls.length, 3);
    assert.deepEqual(vapi.calls[0], {
      url: "https://api.vapi.ai/call/call_1",
      method: "GET",
      headers: { authorization: "Bearer vapi_test" },
    });
    assert.equal(vapi.calls[1].url, CONTROL_URL);
    assert.equal(vapi.calls[2].url, CONTROL_URL);
  });

  it("does not analyze agent turns", async () => {
    const fetch = mockFetch(200, ONE_NUDGE);
    const vapi = fakeVapi();
    const webhook = new Webhook(new DeepTrust({ apiKey: "dt_test", baseUrl: BASE, fetch, timeout: 0 }), {
      fetch: vapi.fetch,
    });
    const session = await webhook.handle(transcript("assistant", "final", "I need to confirm it is you first"));
    assert.equal(fetch.calls.length, 0);
    assert.equal(vapi.calls.length, 0);
    assert.equal(session.transcript.length, 1);
    assert.equal(session.transcript.turns[0].role, "agent");
  });

  it("ends the session on end-of-call-report", async () => {
    const fetch = mockFetch(200, { ...ONE_NUDGE, ended: true });
    const webhook = new Webhook(new DeepTrust({ apiKey: "dt_test", baseUrl: BASE, fetch, timeout: 0 }), {
      fetch: fakeVapi().fetch,
    });
    const call = { id: "call_1", monitor: { controlUrl: CONTROL_URL } };
    await webhook.handle(transcript("user", "final", "my colleague is telling me what to say", call));
    assert.equal(webhook.isWatching("call_1"), true);
    await webhook.handle({ message: { type: "end-of-call-report", call } });
    assert.equal(webhook.isWatching("call_1"), false);
    assert.equal(fetch.calls.length, 2);
    assert.match(fetch.calls[1][0], /\/agents\/sessions\/sess_1\/end$/);
  });
});

function fakeVapi() {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const record = { url, method: init.method ?? "GET" };
    if (init.body) {
      record.body = JSON.parse(init.body);
    } else {
      record.headers = init.headers;
    }
    calls.push(record);
    const payload = init.method === "GET" ? { id: "call_1", monitor: { controlUrl: CONTROL_URL } } : {};
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { calls, fetch };
}

function mockFetch(status, payload) {
  const calls = [];
  const fetch = async (...args) => {
    calls.push(args);
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  fetch.calls = calls;
  return fetch;
}
