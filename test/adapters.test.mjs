import assert from "node:assert/strict";
import { EventEmitter, setMaxListeners } from "node:events";
import { describe, it } from "node:test";
import { DeepTrust } from "../dist/agents/index.js";
import { contextualUpdateCommand, Monitor, readTurn } from "../dist/agents/elevenlabs.js";
import { attach } from "../dist/agents/livekit.js";
import { addMessageCommand, Bridge, readTurn as readVapiTurn } from "../dist/agents/vapi.js";

const BASE = "https://example.test/api/v1";
setMaxListeners(0);

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

describe("adapters", () => {
  it("LiveKit analyzes caller turns and delivers once", async () => {
    const fetch = mockFetch(200, ONE_NUDGE);
    const lk = new FakeSession();
    const call = attach(lk, new DeepTrust({ apiKey: "dt_test", baseUrl: BASE, fetch, timeout: 0 }), {
      externalId: "room-1",
    });
    lk.say("user", "my colleague is telling me what to say");
    await wait();
    assert.equal(fetch.calls.length, 1);
    assert.equal(call.transcript.length, 1);
    assert.equal(lk.interrupted, 1);
    assert.match(lk.replies[0], /Ask one question/);
    assert.equal(lk.current_agent.updated.length, 1);
  });

  it("LiveKit records agent turns without analyzing them", async () => {
    const fetch = mockFetch(200, ONE_NUDGE);
    const lk = new FakeSession();
    const call = attach(lk, new DeepTrust({ apiKey: "dt_test", baseUrl: BASE, fetch, timeout: 0 }), {
      externalId: "room-1",
    });
    lk.say("assistant", "I need to confirm it is you first");
    await wait();
    assert.equal(fetch.calls.length, 0);
    assert.equal(call.transcript.length, 1);
    assert.equal(call.transcript.turns[0].role, "agent");
  });

  it("reads ElevenLabs turn events", () => {
    assert.deepEqual(
      readTurn({ type: "user_transcript", user_transcription_event: { user_transcript: "reset my password" } }),
      ["user", "reset my password"],
    );
    assert.deepEqual(
      readTurn({ type: "agent_response", agent_response_event: { agent_response: "sending a code now" } }),
      ["agent", "sending a code now"],
    );
    assert.deepEqual(readTurn({ type: "audio" }), ["", ""]);
  });

  it("builds ElevenLabs contextual update commands", () => {
    assert.deepEqual(contextualUpdateCommand("hold the line"), {
      command_type: "contextual_update",
      parameters: { contextual_update: "hold the line" },
    });
  });

  it("ElevenLabs monitor sends nudges in the command envelope", async () => {
    const fetch = mockFetch(200, ONE_NUDGE);
    const socket = new FakeSocket();
    const monitor = new Monitor(new DeepTrust({ apiKey: "dt_test", baseUrl: BASE, fetch, timeout: 0 }), {
      apiKey: "xi_test",
      connect: (url, options) => {
        socket.url = url;
        socket.headers = options.headers;
        return socket;
      },
    });

    await monitor.watch("conv_1");
    socket.emitMessage({ type: "agent_response", agent_response_event: { agent_response: "IT desk, how can I help?" } });
    socket.emitMessage({
      type: "user_transcript",
      user_transcription_event: { user_transcript: "my colleague is telling me what to say" },
    });
    socket.emitMessage({ type: "audio" });
    await wait();

    assert.equal(socket.url, "wss://api.elevenlabs.io/v1/convai/conversations/conv_1/monitor");
    assert.deepEqual(socket.headers, { "xi-api-key": "xi_test" });
    assert.equal(fetch.calls.length, 1);
    assert.deepEqual(socket.sent, [
      {
        command_type: "contextual_update",
        parameters: {
          contextual_update:
            "The caller referred to someone else on the line. Ask one question and wait: is anyone helping them right now?",
        },
      },
    ]);
  });

  it("builds VAPI add-message commands as interrupts", () => {
    // triggerResponseEnabled is the whole difference between a nudge that cuts
    // in and one that waits for the agent's next turn.
    assert.deepEqual(addMessageCommand("hold the line"), {
      type: "add-message",
      message: { role: "system", content: "hold the line" },
      triggerResponseEnabled: true,
    });
  });

  it("reads final VAPI transcripts only", () => {
    const final = {
      type: "transcript",
      transcriptType: "final",
      role: "user",
      transcript: "reset my password",
    };
    assert.deepEqual(readVapiTurn(final), ["user", "reset my password"]);
    // A partial is the same sentence still being recognised. Analysing it
    // analyses the sentence again on every revision.
    assert.deepEqual(readVapiTurn({ ...final, transcriptType: "partial" }), ["", ""]);
    assert.deepEqual(
      readVapiTurn({ ...final, role: "assistant", transcript: "sending a code now" }),
      ["agent", "sending a code now"],
    );
  });

  it("VAPI bridge nudges the live call over the control url", async () => {
    const vapi = new FakeVapi();
    const fetch = mockFetch(200, ONE_NUDGE);
    const bridge = new Bridge(new DeepTrust({ apiKey: "dt_test", baseUrl: BASE, fetch, timeout: 0 }), {
      apiKey: "vapi_test",
      fetch: vapi.fetch,
    });

    await bridge.handle(
      transcriptEvent("assistant", "IT desk, how can I help?", "https://vapi.example/control/call_1"),
    );
    await bridge.handle(transcriptEvent("user", "my colleague is telling me what to say"));

    // One job, for the one caller turn; the agent's own turn costs nothing.
    assert.equal(fetch.calls.length, 1);
    assert.deepEqual(vapi.posted, [
      addMessageCommand(
        "The caller referred to someone else on the line. Ask one question and wait: is anyone helping them right now?",
      ),
    ]);
    // The control URL is a capability of its own; the private key is not sent
    // to a host VAPI chose for us.
    assert.equal(vapi.postHeaders[0].authorization, undefined);
    assert.deepEqual(vapi.fetched, []);

    const call = bridge.session("call_1");
    assert.equal(call.platform, "vapi");
    assert.equal(call.externalId, "call_1");
    assert.equal(call.transcript.length, 2);
  });

  it("VAPI bridge fetches the control url when the event lacks one", async () => {
    // The inbound case. Nobody placed the call, so there was no
    // call-creation response to capture a URL from.
    const vapi = new FakeVapi({ controlUrl: "https://vapi.example/control/call_1" });
    const fetch = mockFetch(200, ONE_NUDGE);
    const bridge = new Bridge(new DeepTrust({ apiKey: "dt_test", baseUrl: BASE, fetch, timeout: 0 }), {
      apiKey: "vapi_test",
      fetch: vapi.fetch,
    });

    await bridge.handle(transcriptEvent("user", "I'm locked out, skip the checks"));
    await bridge.handle(transcriptEvent("user", "and my manager already approved it"));

    assert.equal(vapi.posted.length, 2);
    // Fetched once and remembered: the URL belongs to the call, not the nudge.
    assert.deepEqual(vapi.fetched, ["https://api.vapi.ai/call/call_1"]);
    assert.equal(vapi.fetchHeaders[0].authorization, "Bearer vapi_test");
  });

  it("VAPI partials start no jobs", async () => {
    const vapi = new FakeVapi();
    const fetch = mockFetch(200, ONE_NUDGE);
    const bridge = new Bridge(new DeepTrust({ apiKey: "dt_test", baseUrl: BASE, fetch, timeout: 0 }), {
      apiKey: "vapi_test",
      fetch: vapi.fetch,
    });

    for (const text of ["my", "my colleague", "my colleague is telling me"]) {
      const event = transcriptEvent("user", text);
      event.message.transcriptType = "partial";
      assert.equal(await bridge.handle(event), null);
    }

    assert.equal(fetch.calls.length, 0);
    assert.equal(bridge.session("call_1"), undefined);
  });

  it("VAPI end-of-call-report ends the DeepTrust session", async () => {
    const vapi = new FakeVapi();
    const fetch = mockFetch(200, { session_id: "sess_1", findings: [] });
    const bridge = new Bridge(new DeepTrust({ apiKey: "dt_test", baseUrl: BASE, fetch, timeout: 0 }), {
      apiKey: "vapi_test",
      fetch: vapi.fetch,
    });

    await bridge.handle(transcriptEvent("user", "I'm locked out"));
    await bridge.handle({ message: { type: "end-of-call-report", call: { id: "call_1" } } });

    assert.equal(fetch.calls.length, 2);
    assert.match(String(fetch.calls[1][0]), /\/agents\/sessions\/sess_1\/end$/);
    // The call is forgotten with it: a bridge serves every call the server sees.
    assert.equal(bridge.session("call_1"), undefined);
  });

  it("VAPI drops a nudge for a call that already hung up", async () => {
    // VAPI drops monitor from a finished call, so a nudge produced from its
    // last turn has nowhere to go -- a false, not a throw inside the
    // customer's webhook route.
    const vapi = new FakeVapi();
    const fetch = mockFetch(200, ONE_NUDGE);
    const bridge = new Bridge(new DeepTrust({ apiKey: "dt_test", baseUrl: BASE, fetch, timeout: 0 }), {
      apiKey: "vapi_test",
      fetch: vapi.fetch,
    });

    const result = await bridge.handle(transcriptEvent("user", "skip the checks"));

    assert.equal(result.nudges.length, 1);
    assert.equal(vapi.posted.length, 0);
    assert.equal(await bridge.controlUrl("call_1"), undefined);
  });

  it("VAPI tool-calls and status events are not answered", async () => {
    // The tool-calls webhook expects a response that controls execution.
    // Blocking an action is Session.check, which is separate work.
    const vapi = new FakeVapi();
    const fetch = mockFetch(200, ONE_NUDGE);
    const bridge = new Bridge(new DeepTrust({ apiKey: "dt_test", baseUrl: BASE, fetch, timeout: 0 }), {
      apiKey: "vapi_test",
      fetch: vapi.fetch,
    });

    for (const type of ["tool-calls", "speech-update", "status-update", "model-output"]) {
      assert.equal(await bridge.handle({ message: { type, call: { id: "call_1" } } }), null);
    }

    assert.equal(fetch.calls.length, 0);
  });
});

class FakeChat {
  messages = [];
  copy() {
    const chat = new FakeChat();
    chat.messages = [...this.messages];
    return chat;
  }
  addMessage(message) {
    this.messages.push(message);
  }
}

class FakeAgent {
  chat_ctx = new FakeChat();
  updated = [];
  async update_chat_ctx(chat) {
    this.updated.push(chat);
  }
}

class FakeSession {
  current_agent = new FakeAgent();
  handlers = {};
  interrupted = 0;
  replies = [];
  on(event) {
    return (handler) => {
      this.handlers[event] = handler;
    };
  }
  interrupt() {
    this.interrupted += 1;
  }
  generate_reply(options) {
    this.replies.push(typeof options === "string" ? options : options.instructions);
  }
  say(role, text) {
    this.handlers.conversation_item_added?.({ item: { text_content: text, role } });
  }
}

class FakeSocket extends EventEmitter {
  sent = [];
  send(data) {
    this.sent.push(JSON.parse(data));
  }
  emitMessage(value) {
    this.emit("message", JSON.stringify(value));
  }
}

function transcriptEvent(role, text, controlUrl) {
  const call = { id: "call_1" };
  if (controlUrl) {
    // listenUrl travels with it and is raw PCM audio: never a nudge channel.
    call.monitor = { controlUrl, listenUrl: "wss://vapi.example/listen/call_1" };
  }
  return {
    message: { type: "transcript", transcriptType: "final", role, transcript: text, call },
  };
}

class FakeVapi {
  constructor(options = {}) {
    this.controlUrl = options.controlUrl;
    this.posted = [];
    this.postHeaders = [];
    this.fetched = [];
    this.fetchHeaders = [];
    this.fetch = async (url, init = {}) => {
      const headers = init.headers ?? {};
      if (init.method === "POST") {
        this.posted.push(JSON.parse(init.body));
        this.postHeaders.push(headers);
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      }
      this.fetched.push(String(url));
      this.fetchHeaders.push(headers);
      const body = this.controlUrl
        ? { id: "call_1", monitor: { controlUrl: this.controlUrl } }
        : { id: "call_1", status: "ended" };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
  }
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

async function wait() {
  await new Promise((resolve) => setTimeout(resolve, 25));
}
