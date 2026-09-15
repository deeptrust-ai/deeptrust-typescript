# VAPI, from your own webhook

VAPI posts its server-url events to a URL you own, so this is a handler, not a
watcher. The `Bridge` turns those events into a DeepTrust call and sends each
nudge back on the per-call control URL, which on VAPI **interrupts** the agent.

Everything runs in your process. DeepTrust never talks to VAPI.

## 1. Build the client and set your keys

```bash
npm install && npm run build     # from the repo root; the example imports dist/
cp .env.example .env             # then fill it in
```

| | |
|---|---|
| `DEEPTRUST_API_KEY` | organization key, from Settings then API Keys |
| `DEEPTRUST_BASE_URL` | only for a non-production workspace |
| `VAPI_API_KEY` | VAPI **private** key, used to look up a call's control URL |
| `VAPI_WEBHOOK_SECRET` | the assistant's `server.secret`, see step 3 |

## 2. Run it, and give it a public URL

```bash
node server.mjs                      # :8095
cloudflared tunnel --url http://localhost:8095
```

## 3. Point the assistant at it, with a secret

In the assistant's **Webhook Server** settings set the Server URL to
`https://<your-host>/vapi`, set `serverMessages` to at least `transcript` and
`end-of-call-report`, and set a **secret** under Authorization.

Do not skip the secret. Your route is a public URL, and without one anyone who
learns it can post a transcript that was never said and have it become a real
call and a real finding in your organization. With it set here and in `.env`,
an unverified request is refused with 401 before anything is recorded.

```bash
curl -X PATCH "https://api.vapi.ai/assistant/$ASSISTANT_ID" \
  -H "authorization: Bearer $VAPI_API_KEY" -H "content-type: application/json" \
  -d '{"server":{"url":"https://<your-host>/vapi","secret":"<your-secret>"},
       "serverMessages":["transcript","end-of-call-report","status-update"]}'
```

## 4. Call the number

```
19:24:32  WEBHOOK   transcript final user: I'm locked out of my account...
19:24:33  ANALYSIS  risk=high findings=2 nudges=1 session=c9d84bfc...
19:24:33  NUDGE     Verify Caller Identity Before Reset
19:24:33  DELIVER   POST control URL -> 200 ok
```

Partials are ignored, agent turns are recorded without starting a job, and only
caller turns start one. `DELIVER=false` hands delivery to the DeepTrust backend
instead, which needs the org's VAPI key connected in the dashboard.

## Replaying without a phone

`replay.mjs` posts a scripted call at the handler with a fake control endpoint,
so the whole path can be exercised with no VAPI account:

```bash
node replay.mjs
```
