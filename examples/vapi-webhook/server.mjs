/**
 * The VAPI path, from the customer's side, with everything logged.
 *
 * VAPI is the mirror image of ElevenLabs: nobody holds a socket. VAPI posts
 * server-url events to a URL the customer owns, and a nudge goes back on the
 * per-call HTTPS endpoint VAPI publishes as monitor.controlUrl. So this is a
 * webhook handler, and the DeepTrust Bridge decides what each event means.
 *
 *   node server.mjs
 *
 * Environment:
 *   DEEPTRUST_API_KEY   organization key, sent as X-DeepTrust-Api-Key
 *   DEEPTRUST_BASE_URL  https://app.dev.deeptrust.ai/api/v1 for dev
 *   VAPI_API_KEY        VAPI private key, read the call to find its control URL
 *   VAPI_WEBHOOK_SECRET the assistant's server.secret. Without it this route
 *                       trusts any POST, so set it on the assistant too.
 *   PORT                defaults to 8095
 *   DELIVER             "false" to let the DeepTrust backend deliver instead
 */

import http from "node:http";
import { DeepTrust, User } from "../../dist/agents/index.js";
import { Bridge, WebhookVerificationError } from "../../dist/agents/vapi.js";

const PORT = Number(process.env.PORT ?? 8095);
const DELIVER = process.env.DELIVER !== "false";

const stamp = () => new Date().toISOString().slice(11, 23);
const log = (tag, msg = "") => console.log(`${stamp()}  ${tag.padEnd(9)} ${msg}`);

/** Wraps fetch so every request the Bridge makes to VAPI is visible. */
const loggingFetch = async (url, init = {}) => {
  const method = init.method ?? "GET";
  const target = String(url);
  if (target.includes("/control")) {
    log("DELIVER", `POST control URL`);
    for (const line of JSON.parse(init.body ?? "{}").message?.content?.split("\n") ?? []) {
      log("", `    | ${line}`);
    }
  } else {
    log("VAPI", `${method} ${target.replace(/^https:\/\/api\.vapi\.ai/, "")}`);
  }
  const res = await globalThis.fetch(url, init);
  log(target.includes("/control") ? "DELIVER" : "VAPI", `-> ${res.status} ${res.ok ? "ok" : "FAILED"}`);
  return res;
};

const SECRET = process.env.VAPI_WEBHOOK_SECRET ?? "";

const bridge = new Bridge(new DeepTrust(), {
  apiKey: process.env.VAPI_API_KEY ?? "",
  ...(SECRET ? { secret: SECRET } : {}),
  deliver: DELIVER,
  fetch: loggingFetch,
  onAnalysis: (result) => {
    log(
      "ANALYSIS",
      `risk=${result.riskLevel} findings=${result.findings.length} ` +
        `nudges=${result.nudges.length} session=${result.sessionId}`,
    );
    for (const f of result.findings) log("FINDING", `${f.kind}: ${f.detail?.slice(0, 120) ?? ""}`);
    for (const n of result.nudges) log("NUDGE", n.title);
    if (!result.findings.length && !result.nudges.length) log("ANALYSIS", "nothing to say about this turn");
  },
});

const readBody = (req) =>
  new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => resolve(raw));
  });

const server = http.createServer(async (req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ ok: true, deliver: DELIVER }));
  }
  if (req.method !== "POST") {
    res.writeHead(404);
    return res.end();
  }

  const raw = await readBody(req);
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    log("WEBHOOK", `body is not JSON: ${raw.slice(0, 120)}`);
    res.writeHead(400);
    return res.end();
  }

  const m = payload.message ?? payload;
  const callId = m.call?.id ?? "(no call)";
  const kind = m.type ?? "(no type)";
  if (kind === "transcript") {
    log("WEBHOOK", `${kind} ${m.transcriptType} ${m.role}: ${String(m.transcript ?? "").slice(0, 90)}`);
  } else {
    log("WEBHOOK", `${kind}  call=${callId}`);
  }

  try {
    await bridge.handle(payload, {
      user: new User(m.customer?.number ?? "unknown", { role: "MEMBER" }),
      headers: req.headers,
    });
  } catch (err) {
    if (err instanceof WebhookVerificationError) {
      log("REFUSED", "the request did not carry the VAPI secret");
      res.writeHead(401, { "content-type": "application/json" });
      return res.end(JSON.stringify({}));
    }
    log("ERROR", `${err?.constructor?.name}: ${err?.message}`);
  }

  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({}));
});

server.listen(PORT, "0.0.0.0", () => {
  log(
    "READY",
    `listening on :${PORT}  deliver=${DELIVER}  verify=${SECRET ? "on" : "OFF, set VAPI_WEBHOOK_SECRET"}  ` +
      `base=${process.env.DEEPTRUST_BASE_URL ?? "default"}`,
  );
});
