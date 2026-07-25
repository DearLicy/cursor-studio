const ctrl = "http://127.0.0.1:28191";

async function j(m, p, b) {
  const r = await fetch(ctrl + p, {
    method: m,
    headers: b ? { "Content-Type": "application/json" } : undefined,
    body: b ? JSON.stringify(b) : undefined,
  });
  const t = await r.text();
  let d;
  try {
    d = JSON.parse(t);
  } catch {
    d = { raw: t };
  }
  if (!r.ok) throw new Error(`${m} ${p} ${r.status} ${t.slice(0, 200)}`);
  return d;
}

async function main() {
  await j("GET", "/health");
  let st = await j("GET", "/service/state");
  if (!st.running) st = await j("POST", "/service/start");
  console.log("service", {
    running: st.running,
    backend: st.backendListenAddr,
    proxy: st.proxyListenAddr,
  });

  const backend = "http://" + (st.backendListenAddr || "127.0.0.1:28190");
  const h = await fetch(backend + "/health");
  console.log("backend_health", h.status, await h.text());

  for (const p of [
    "/aiserver.v1.DashboardService/GetTokenUsage",
    "/aiserver.v1.AiService/CountTokens",
    "/aiserver.v1.AiService/AvailableModels",
  ]) {
    const r = await fetch(backend + p, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    console.log("stub", p.split("/").pop(), r.status);
  }

  const chat = await fetch(backend + "/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "grok-4.5",
      messages: [{ role: "user", content: "Reply with exactly: pong" }],
      stream: false,
    }),
  });
  const chatText = await chat.text();
  console.log("chat_status", chat.status);
  console.log("chat_snip", chatText.slice(0, 240).replace(/\n/g, " "));

  const m = await j("GET", "/metrics/home");
  const logs = await j("GET", "/metrics/logs");
  console.log("metrics", {
    turns: m.turnsTotal,
    valid: m.validTurnsTotal,
    invalid: m.invalidTurnsTotal,
    tokens: m.requestTokensTotal,
    cost: m.estimatedCostUsd,
    logs: (logs.logs || []).length,
  });
  if (logs.logs?.[0]) {
    console.log("last_log", {
      model: logs.logs[0].modelID,
      tokens: logs.logs[0].requestTokens,
      valid: logs.logs[0].valid,
      err: logs.logs[0].error,
    });
  }

  const rid = "test-sse-" + Date.now();
  const bidi = await fetch(backend + "/aiserver.v1.BidiService/BidiAppend", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ request_id: rid, text: "Say hi in 3 words" }),
  });
  console.log("bidi", bidi.status, await bidi.text());

  const sseRes = await fetch(backend + "/agent.v1.AgentService/RunSSE?wire=json", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ request_id: rid }),
  });
  console.log("sse_headers", sseRes.status, sseRes.headers.get("content-type"));

  const reader = sseRes.body.getReader();
  const dec = new TextDecoder();
  let acc = "";
  let n = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < 30000 && n < 80) {
    const { done, value } = await reader.read();
    if (done) break;
    acc += dec.decode(value, { stream: true });
    n++;
    if (acc.includes('"type":"done"') || acc.includes('"type":"error"')) break;
  }
  console.log("sse_events_snip", acc.slice(0, 600).replace(/\n/g, " | "));
  const hasTurnEnded =
    acc.includes("turnEnded") || acc.includes("turn_ended") || acc.includes('"type":"done"');
  console.log("sse_has_turn_or_done", hasTurnEnded);
  const m2 = await j("GET", "/metrics/home");
  console.log("metrics_after", {
    turns: m2.turnsTotal,
    tokens: m2.requestTokensTotal,
    valid: m2.validTurnsTotal,
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});