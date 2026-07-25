/**
 * 工具循环冒烟：Bidi 触发 → 期望 tool_started/tool_completed 或正常文本完成。
 * 依赖控制面 :28191 已启动。
 */
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
  const backend = "http://" + (st.backendListenAddr || "127.0.0.1:28190");

  // 直接测 tool-exec 路径：要求模型调用 Shell/Glob
  const rid = "tool-loop-" + Date.now();
  const prompt =
    "Use the Shell tool exactly once with command `echo studio-tool-ok` " +
    "and then reply with the tool output only.";

  const bidi = await fetch(backend + "/aiserver.v1.BidiService/BidiAppend", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ request_id: rid, text: prompt }),
  });
  console.log("bidi", bidi.status);

  const sseRes = await fetch(backend + "/agent.v1.AgentService/RunSSE?wire=json", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ request_id: rid }),
  });
  console.log("sse", sseRes.status, sseRes.headers.get("content-type"));

  const reader = sseRes.body.getReader();
  const dec = new TextDecoder();
  let acc = "";
  const t0 = Date.now();
  while (Date.now() - t0 < 90000) {
    const { done, value } = await reader.read();
    if (done) break;
    acc += dec.decode(value, { stream: true });
    if (acc.includes('"type":"done"') || acc.includes('"type":"error"')) break;
  }

  const hasToolStart =
    acc.includes("tool_started") || acc.includes("toolCallStarted");
  const hasToolDone =
    acc.includes("tool_completed") || acc.includes("toolCallCompleted");
  const hasOk = /studio-tool-ok/i.test(acc);
  const hasTurn =
    acc.includes("turnEnded") ||
    acc.includes("turn_ended") ||
    acc.includes('"type":"done"');

  console.log({
    hasToolStart,
    hasToolDone,
    hasOk,
    hasTurn,
    snip: acc.slice(0, 700).replace(/\n/g, " | "),
  });

  if (!hasTurn) {
    console.error("FAIL: no turn end");
    process.exit(1);
  }
  // 工具是否触发取决于模型是否听话；至少链路要结束
  console.log(
    hasToolStart || hasToolDone
      ? "PASS: tool events observed"
      : "WARN: no tool events (model may have answered without tools)",
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});