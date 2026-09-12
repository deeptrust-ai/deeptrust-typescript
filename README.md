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

## VAPI webhook

VAPI posts server messages to your own webhook route, so nothing is held open.
Call `handle` with the parsed body; nudges go back out over the call's
`monitor.controlUrl` as an `add-message` with `triggerResponseEnabled`, so the
agent responds to them straight away.

```ts
import { DeepTrust } from "deeptrust-ai/agents";
import { Webhook } from "deeptrust-ai/agents/vapi";

const webhook = new Webhook(new DeepTrust(), {
  apiKey: process.env.VAPI_API_KEY!,
});

app.post("/vapi", async (req, res) => {
  await webhook.handle(req.body, { user: caller });
  res.status(200).end();
});
```

Only final `transcript` messages are read, and only caller turns are analyzed.
The VAPI key is used to fetch `controlUrl` when a payload does not carry it,
which is the usual case for inbound calls; a `controlUrl` in the payload is only
used when it is an https URL on a `vapi.ai` host. The session is ended on
`end-of-call-report`.

`handle` trusts what it is given. Verify the request is from VAPI before calling
it, e.g. by checking the `x-vapi-secret` header against the server URL secret
you configured in VAPI.

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
