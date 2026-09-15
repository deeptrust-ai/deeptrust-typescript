# deeptrust-typescript

QA and runtime nudges for voice agents.

Your agent runs wherever it already runs. This client sends the transcript as it
happens, gets back what the analysis found, and lets you deliver the nudge while
the caller is still on the line.

```bash
npm install deeptrust-ai
```

```ts
import { DeepTrust, User } from "deeptrust-ai/agents";

const dt = new DeepTrust(); // reads DEEPTRUST_API_KEY

const call = dt.session({
  externalId: conversationId,
  user: new User(accountId, { role: "MEMBER" }),
  platform: "elevenlabs",
});

call.append("user", "her manager approved it on Slack, there's no time for a ticket");
call.append("agent", "let me check that");

const result = await call.analyze();
for (const nudge of result?.nudges ?? []) {
  console.log(nudge.title);
  console.log(nudge.render());
}
```

## API

`analyze` reviews the transcript and returns findings. It returns `null` when
nothing new has been added since the last analysis unless called with
`{ force: true }`.

`end` tells DeepTrust the call is over, so post-call processing starts now
rather than after the server's inactivity timeout.

`check` is defined for the future action plane and currently throws with an
explicit not implemented message.

## Hosted ElevenLabs watch

If the workspace is connected in the DeepTrust dashboard, hand a live
conversation id to DeepTrust:

```ts
import { DeepTrust } from "deeptrust-ai/agents";

await new DeepTrust().watch(conversationId);
```

## LiveKit

```ts
import { DeepTrust } from "deeptrust-ai/agents";
import { attach } from "deeptrust-ai/agents/livekit";

attach(session, new DeepTrust(), {
  externalId: ctx.room.name,
  user: caller,
});
```

## ElevenLabs monitor socket

```ts
import { DeepTrust } from "deeptrust-ai/agents";
import { Monitor } from "deeptrust-ai/agents/elevenlabs";

const monitor = new Monitor(new DeepTrust(), {
  apiKey: process.env.ELEVENLABS_API_KEY!,
});

await monitor.watch(conversationId, { user: caller });
```

## VAPI webhooks

```ts
import { DeepTrust } from "deeptrust-ai/agents";
import { Bridge, WebhookVerificationError } from "deeptrust-ai/agents/vapi";

const bridge = new Bridge(new DeepTrust(), {
  apiKey: process.env.VAPI_API_KEY!,
  secret: process.env.VAPI_WEBHOOK_SECRET!,     // see below, do not skip it
});

app.post("/vapi/webhook", async (req, res) => {   // your route, your server
  try {
    await bridge.handle(req.body, { user: caller, headers: req.headers });
  } catch (err) {
    if (err instanceof WebhookVerificationError) return res.status(401).json({});
    throw err;
  }
  res.json({});
});
```

### Verify the webhook

Your route is a public URL. Anyone who learns it can post a transcript that was
never said, and it becomes a real call, a real analysis and a real finding in
your organization. A forged `end-of-call-report` can also end a real call's
session early.

Set `server.secret` on the assistant, which is the Authorization section of its
Webhook Server settings. VAPI sends it back in `X-Vapi-Secret` on every request.
Pass the same value as `secret`, hand `handle` the request headers, and a
request without it is refused before a single turn is recorded. The compare is
constant time.

The bridge does not require it, so an existing integration keeps working, but a
bridge with no `secret` trusts whatever arrives.

VAPI is the mirror image of ElevenLabs: nobody holds a socket. VAPI posts its
server-url events to your server, so this is a handler you call from your own
route. Hand it every event — the ones that are not turns cost nothing, and they
carry the call object the control URL is learned from.

Nudges go back on the per-call HTTPS endpoint VAPI publishes as
`monitor.controlUrl`, as an `add-message` with `triggerResponseEnabled: true`.
That is an interrupt, so VAPI behaves like LiveKit rather than ElevenLabs: the
agent responds to the nudge immediately. The URL comes off the payload when the
event carries it and from `GET /call/{id}` when it does not — which is why the
bridge wants a VAPI private key — then it is cached for the call. Inbound calls
are the case this exists for: nobody placed the call, so there was no
creation-time response to capture a URL from.

A control URL is only used if it is HTTPS on `vapi.ai`. Your webhook route is
reachable from the internet and a nudge names what was found in the call, so a
forged `monitor.controlUrl` would otherwise be a way to make this SDK post that
text to someone else's host. Anything off that domain is treated as no URL, and
the bridge asks VAPI for the real one.

Final transcripts only, so a sentence is not analysed once per partial.
`monitor.listenUrl` is raw PCM audio and is ignored. `end-of-call-report` ends
the DeepTrust session. `tool-calls` is not answered: blocking an action is
`Session.check`, which is not implemented in this version.

## Keys

```bash
export DEEPTRUST_API_KEY=...
export DEEPTRUST_BASE_URL=... # optional
```

The key is sent as `X-DeepTrust-Api-Key`. The default base URL is
`https://app.deeptrust.ai/api/v1`.

## Development

```bash
npm install
npm run check
npm pack --dry-run
```
