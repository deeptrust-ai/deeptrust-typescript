import assert from "node:assert/strict";
import { EventEmitter, setMaxListeners } from "node:events";
import { describe, it } from "node:test";
import { DeepTrust } from "../dist/agents/index.js";
import { contextualUpdateCommand, Monitor, readTurn } from "../dist/agents/elevenlabs.js";
import { attach } from "../dist/agents/livekit.js";

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
