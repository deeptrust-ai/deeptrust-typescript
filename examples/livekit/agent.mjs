/**
 * A LiveKit agent with DeepTrust attached.
 *
 * Everything except the DeepTrust block in `entry` is an ordinary agents-js
 * worker. That block is one call either way:
 *
 *   attach(session, dt, { room })   the SDK way: this process sends each turn
 *                                    to DeepTrust and delivers what comes back
 *   listen(room, session)           the cloud way: DeepTrust follows the call
 *                                    on its own and pushes nudges into the room
 *
 * Either one adds a nudge to the agent's context and interrupts the reply in
 * progress, and stops by itself when the session closes.
 *
 * The caller comes in as JWT metadata on the participant when the token was
 * minted with it, which is why the worker can take the name and the role
 * without asking anyone else.
 *
 *   node --env-file=.env agent.mjs dev
 */
import { fileURLToPath } from "node:url";
import { cli, defineAgent, ServerOptions, voice } from "@livekit/agents";
import { DeepTrust, User } from "../../dist/agents/index.js";
import { attach, listen } from "../../dist/agents/livekit.js";

const INSTRUCTIONS = `
You are an agent on an IT service desk.

You reset passwords, re-enroll two-factor, and unlock accounts, and you work
from a change ticket that has already been approved. Whoever the caller says
they are is a claim; satisfy yourself who you are speaking to before you change
anything on an account.

Keep replies to one or two sentences. You are on a phone call, so do not read
out lists and do not explain internal procedure.
`;

const MODE = process.env.DEEPTRUST_MODE === "cloud" ? "cloud" : "sdk";

/** The caller, from the join token's metadata, with defaults for a client that sent none. */
function profile(participant) {
  let meta = {};
  try {
    meta = JSON.parse(participant.metadata || "{}");
  } catch {
    meta = {};
  }
  return {
    name: meta.name || participant.name || "Caller",
    username: meta.username || participant.identity || "guest",
    role: meta.role || "MEMBER",
  };
}

export default defineAgent({
  entry: async (ctx) => {
    await ctx.connect();
    const participant = await ctx.waitForParticipant();
    const caller = profile(participant);

    const session = new voice.AgentSession({
      stt: "deepgram/nova-3",
      llm: "openai/gpt-4.1-mini",
      tts: "cartesia/sonic-2",
    });
    const agent = new voice.Agent({ instructions: INSTRUCTIONS });

    // The DeepTrust part.
    const onNudge = (nudge) => console.log(`  NUDGE    ${nudge.title}\n           ${nudge.render()}`);
    if (MODE === "cloud") {
      listen(ctx.room, session, { agent, onNudge });
    } else {
      attach(session, new DeepTrust(), {
        room: ctx.room,
        agent,
        user: new User(caller.username, { role: caller.role, name: caller.name }),
        onNudge,
        // Optional. `attach` delivers nudges on its own; this only prints what came back.
        onAnalysis: report,
      });
    }
    console.log(`DeepTrust ${MODE === "cloud" ? "listening in" : "attached to"} room ${ctx.room.name}`);

    await session.start({ agent, room: ctx.room });
    session.generateReply({
      instructions: `Greet the caller as the IT service desk in one sentence, by their first name: ${caller.name.split(" ")[0]}.`,
    });
  },
});

function report(result) {
  console.log(`\n  analysis risk=${result.riskLevel} findings=${result.findings.length} in ${result.latencyMs}ms`);
  for (const finding of result.findings) {
    console.log(`    finding  ${finding.kind}: ${finding.detail}`);
  }
}

cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url) }));
