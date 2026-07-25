/**
 * MITM / 控制面 / Cursor 联调探测（不自动写 Cursor settings）。
 *
 * 覆盖：
 * 1) 控制面 health + service start
 * 2) Backend 直连 health / AvailableModels
 * 3) 代理 absolute-form HTTP → *.cursor.sh 白名单中继
 * 4) CONNECT + TLS MITM → backend
 * 5) 经 MITM 的 BidiAppend + RunSSE（json_sse，短读）
 * 6) Cursor settings / CA / 代理统计 readiness 报告
 *
 * 环境变量：
 *   STUDIO_CONTROL=http://127.0.0.1:28191
 *   SMOKE_MITM_CHAT=1  额外经 MITM 打 /v1/chat/completions（需已配置供应商）
 */
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const CTRL = process.env.STUDIO_CONTROL || "http://127.0.0.1:28191";
const CURSOR_HOST = "api2.cursor.sh";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function log(step, data) {
  if (data === undefined) console.log(step);
  else console.log(step, typeof data === "string" ? data : JSON.stringify(data));
}

async function ctrl(method, p, body) {
  const r = await fetch(CTRL + p, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await r.text();
  let d;
  try {
    d = JSON.parse(t);
  } catch {
    d = { raw: t };
  }
  if (!r.ok) throw new Error(`${method} ${p} ${r.status} ${t.slice(0, 240)}`);
  return d;
}

function parseAddr(addr) {
  const cleaned = String(addr || "").replace(/^https?:\/\//, "");
  const [host, p] = cleaned.split(":");
  return { host: host || "127.0.0.1", port: Number(p || 0) };
}

/** absolute-form HTTP via proxy（不走 TLS） */
function proxyHttpAbsolute({
  proxyHost,
  proxyPort,
  targetHost,
  method,
  path: reqPath,
  headers = {},
  body,
  timeoutMs = 20_000,
}) {
  const payload = body == null ? null : Buffer.from(body);
  const url = `http://${targetHost}${reqPath}`;
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: proxyHost,
        port: proxyPort,
        method,
        path: url,
        headers: {
          Host: targetHost,
          Connection: "close",
          ...(payload
            ? {
                "Content-Type": headers["Content-Type"] || "application/json",
                "Content-Length": payload.length,
              }
            : {}),
          ...headers,
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          resolve({
            status: res.statusCode || 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("proxy http timeout")));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** CONNECT + TLS MITM via proxy，再发 HTTP/1.1 */
function proxyConnectMitm({
  proxyHost,
  proxyPort,
  targetHost,
  targetPort = 443,
  method,
  path: reqPath,
  headers = {},
  body,
  caPem,
  timeoutMs = 25_000,
  maxBytes = 256_000,
  stopWhen,
}) {
  const payload = body == null ? null : Buffer.from(body);
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (err, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(val);
    };
    const timer = setTimeout(
      () => done(new Error("proxy connect mitm timeout")),
      timeoutMs,
    );

    const sock = net.connect(proxyPort, proxyHost);
    sock.once("error", (e) => done(e));
    sock.once("connect", () => {
      sock.write(
        `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\nProxy-Connection: keep-alive\r\n\r\n`,
      );
    });

    let buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const idx = buf.indexOf("\r\n\r\n");
      if (idx < 0) return;
      sock.off("data", onData);
      const head = buf.slice(0, idx).toString("utf8");
      const rest = buf.slice(idx + 4);
      if (!/^HTTP\/1\.[01] 200/i.test(head)) {
        done(new Error(`CONNECT failed: ${head.split("\r\n")[0]}`));
        sock.destroy();
        return;
      }

      const tlsSock = tls.connect({
        socket: sock,
        servername: targetHost,
        ALPNProtocols: ["http/1.1"],
        // 必须严格验证本地 CA，避免 smoke 掩盖真实 Cursor 的证书错误。
        ca: caPem ? [caPem] : undefined,
        rejectUnauthorized: true,
      });
      tlsSock.once("error", (e) => done(e));
      tlsSock.once("secureConnect", () => {
        const hdrLines = [
          `${method} ${reqPath} HTTP/1.1`,
          `Host: ${targetHost}`,
          "Connection: close",
        ];
        for (const [k, v] of Object.entries(headers)) {
          if (v == null) continue;
          if (/^(host|connection|content-length)$/i.test(k)) continue;
          hdrLines.push(`${k}: ${v}`);
        }
        if (payload) {
          if (!Object.keys(headers).some((k) => /^content-type$/i.test(k))) {
            hdrLines.push("Content-Type: application/json");
          }
          hdrLines.push(`Content-Length: ${payload.length}`);
        }
        tlsSock.write(hdrLines.join("\r\n") + "\r\n\r\n");
        if (payload) tlsSock.write(payload);

        let raw = Buffer.alloc(0);
        if (rest.length) raw = Buffer.concat([raw, rest]);
        tlsSock.on("data", (c) => {
          raw = Buffer.concat([raw, c]);
          const text = raw.toString("utf8");
          if (stopWhen && stopWhen(text)) {
            try {
              tlsSock.destroy();
            } catch {
              /* ignore */
            }
            const parsed = splitHttp(raw);
            done(null, parsed);
          } else if (raw.length > maxBytes) {
            try {
              tlsSock.destroy();
            } catch {
              /* ignore */
            }
            done(null, splitHttp(raw));
          }
        });
        tlsSock.on("end", () => done(null, splitHttp(raw)));
        tlsSock.on("close", () => {
          if (!settled) done(null, splitHttp(raw));
        });
      });
      // CONNECT 响应后可能已有 TLS ClientHello 前置数据；TLSSocket 接管 socket
      if (rest.length) {
        // 不应把明文 rest 当 TLS 喂入；CONNECT 200 后 head 通常为空
      }
    };
    sock.on("data", onData);
  });
}

function splitHttp(raw) {
  const s = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw || "");
  const idx = s.indexOf("\r\n\r\n");
  if (idx < 0) {
    return { status: 0, headers: {}, body: s, raw: s };
  }
  const head = s.slice(0, idx);
  const body = s.slice(idx + 4);
  const lines = head.split("\r\n");
  const status = Number((lines[0].match(/\s(\d{3})\s/) || [])[1] || 0);
  const headers = {};
  for (const line of lines.slice(1)) {
    const c = line.indexOf(":");
    if (c > 0) headers[line.slice(0, c).toLowerCase()] = line.slice(c + 1).trim();
  }
  return { status, headers, body, raw: s };
}

function resolveCursorSettingsPath() {
  if (process.platform === "win32") {
    return path.join(
      process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
      "Cursor",
      "User",
      "settings.json",
    );
  }
  if (process.platform === "darwin") {
    return path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "Cursor",
      "User",
      "settings.json",
    );
  }
  return path.join(os.homedir(), ".config", "Cursor", "User", "settings.json");
}

function readCursorProxy() {
  const p = resolveCursorSettingsPath();
  if (!fs.existsSync(p)) {
    return { path: p, exists: false, proxy: null, proxySupport: null };
  }
  const raw = fs.readFileSync(p, "utf8");
  // 简易 JSONC：去注释
  const stripped = raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  let settings = {};
  try {
    settings = JSON.parse(stripped);
  } catch {
    /* ignore */
  }
  return {
    path: p,
    exists: true,
    proxy: settings["http.proxy"] ?? null,
    proxySupport: settings["http.proxySupport"] ?? null,
    disableHttp2: settings["cursor.general.disableHttp2"] ?? null,
  };
}

async function main() {
  const report = {
    control: false,
    service: false,
    backendDirect: false,
    httpRelay: false,
    mitmRelay: false,
    bidiMitm: false,
    sseMitm: false,
    cursorPointsStudio: false,
    caExists: false,
  };

  log("== smoke-mitm ==");
  const health = await ctrl("GET", "/health");
  assert(health.ok, "control health not ok");
  report.control = true;
  log("control", health);

  let st = await ctrl("GET", "/service/state");
  if (!st.running) {
    log("service.start", "not running → start");
    st = await ctrl("POST", "/service/start");
  }
  assert(st.running, "service not running after start");
  report.service = true;
  log("service", {
    running: st.running,
    proxy: st.proxyListenAddr,
    backend: st.backendListenAddr,
    injectIntent: st.injectCursorProxy,
    cursorAppliedSession: st.cursorSettingsApplied,
    ca: st.caCertPath,
  });

  const backendAddr = st.backendListenAddr || "127.0.0.1:28190";
  const proxyAddr = st.proxyListenAddr || "127.0.0.1:28180";
  const { host: proxyHost, port: proxyPort } = parseAddr(proxyAddr);
  const backendBase = `http://${backendAddr}`;

  // Backend 直连
  const bh = await fetch(backendBase + "/health");
  const bt = await bh.text();
  assert(bh.ok && bt.includes("ok"), `backend health ${bh.status} ${bt}`);
  report.backendDirect = true;
  log("backend_direct_health", { status: bh.status, body: bt });

  const modelsDirect = await fetch(
    backendBase + "/aiserver.v1.AiService/AvailableModels",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    },
  );
  const modelsText = await modelsDirect.text();
  assert(modelsDirect.ok, `AvailableModels direct ${modelsDirect.status}`);
  log("backend_models", {
    status: modelsDirect.status,
    snip: modelsText.slice(0, 160).replace(/\n/g, " "),
  });

  // CA
  const caInfo = await ctrl("GET", "/proxy/ca");
  report.caExists = Boolean(caInfo.exists);
  let caPem = null;
  if (caInfo.certPath && fs.existsSync(caInfo.certPath)) {
    caPem = fs.readFileSync(caInfo.certPath, "utf8");
  }
  log("ca", {
    exists: caInfo.exists,
    running: caInfo.running,
    path: caInfo.certPath,
  });

  // 1) absolute-form HTTP relay
  const httpRelay = await proxyHttpAbsolute({
    proxyHost,
    proxyPort,
    targetHost: CURSOR_HOST,
    method: "GET",
    path: "/health",
  });
  assert(httpRelay.status === 200, `httpRelay health status=${httpRelay.status}`);
  assert(httpRelay.body.includes("ok"), `httpRelay body=${httpRelay.body}`);
  report.httpRelay = true;
  log("http_relay_health", { status: httpRelay.status, body: httpRelay.body });

  const httpModels = await proxyHttpAbsolute({
    proxyHost,
    proxyPort,
    targetHost: CURSOR_HOST,
    method: "POST",
    path: "/aiserver.v1.AiService/AvailableModels",
    body: "{}",
  });
  assert(httpModels.status === 200, `http models status=${httpModels.status}`);
  log("http_relay_models", {
    status: httpModels.status,
    snip: httpModels.body.slice(0, 160).replace(/\n/g, " "),
  });

  // 2) CONNECT MITM
  const mitmHealth = await proxyConnectMitm({
    proxyHost,
    proxyPort,
    targetHost: CURSOR_HOST,
    method: "GET",
    path: "/health",
    caPem,
  });
  assert(mitmHealth.status === 200, `mitm health status=${mitmHealth.status}`);
  assert(
    String(mitmHealth.body || "").includes("ok"),
    `mitm health body=${mitmHealth.body}`,
  );
  report.mitmRelay = true;
  log("mitm_health", { status: mitmHealth.status, body: mitmHealth.body.slice(0, 80) });

  const mitmModels = await proxyConnectMitm({
    proxyHost,
    proxyPort,
    targetHost: CURSOR_HOST,
    method: "POST",
    path: "/aiserver.v1.AiService/AvailableModels",
    headers: { "Content-Type": "application/json" },
    body: "{}",
    caPem,
  });
  assert(mitmModels.status === 200, `mitm models status=${mitmModels.status}`);
  log("mitm_models", {
    status: mitmModels.status,
    snip: mitmModels.body.slice(0, 160).replace(/\n/g, " "),
  });

  // 3) Bidi + RunSSE through MITM
  const rid = `mitm-e2e-${Date.now()}`;
  const bidi = await proxyConnectMitm({
    proxyHost,
    proxyPort,
    targetHost: CURSOR_HOST,
    method: "POST",
    path: "/aiserver.v1.BidiService/BidiAppend",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      request_id: rid,
      text: "Reply with exactly: mitm-pong",
    }),
    caPem,
  });
  assert(bidi.status === 200 || bidi.status === 204, `bidi status=${bidi.status}`);
  report.bidiMitm = true;
  log("mitm_bidi", { status: bidi.status, body: bidi.body.slice(0, 120) });

  const sse = await proxyConnectMitm({
    proxyHost,
    proxyPort,
    targetHost: CURSOR_HOST,
    method: "POST",
    path: "/agent.v1.AgentService/RunSSE?wire=json",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify({ request_id: rid }),
    caPem,
    timeoutMs: 45_000,
    maxBytes: 512_000,
    stopWhen: (t) =>
      t.includes('"type":"done"') ||
      t.includes("turnEnded") ||
      t.includes("turn_ended") ||
      t.includes('"type":"error"') ||
      t.includes("mitm-pong"),
  });
  assert(sse.status === 200, `sse status=${sse.status}`);
  const sseBody = sse.body || sse.raw || "";
  const hasProgress =
    sseBody.includes("textDelta") ||
    sseBody.includes("text_delta") ||
    sseBody.includes("turnEnded") ||
    sseBody.includes("turn_ended") ||
    sseBody.includes('"type":"done"') ||
    sseBody.includes("thinking") ||
    sseBody.includes("mitm-pong") ||
    sseBody.includes("error");
  assert(hasProgress, `sse empty/unexpected: ${sseBody.slice(0, 300)}`);
  report.sseMitm = true;
  log("mitm_sse", {
    status: sse.status,
    contentType: sse.headers["content-type"],
    snip: sseBody.slice(0, 400).replace(/\n/g, " | "),
  });

  if (process.env.SMOKE_MITM_CHAT === "1") {
    const chat = await proxyConnectMitm({
      proxyHost,
      proxyPort,
      targetHost: CURSOR_HOST,
      method: "POST",
      path: "/v1/chat/completions",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "default",
        messages: [{ role: "user", content: "Reply with exactly: chat-pong" }],
        stream: false,
      }),
      caPem,
      timeoutMs: 60_000,
    });
    log("mitm_chat", {
      status: chat.status,
      snip: (chat.body || "").slice(0, 200).replace(/\n/g, " "),
    });
  }

  // stats + cursor readiness
  const st2 = await ctrl("GET", "/service/state");
  const stats = st2.proxyStats || {};
  log("proxy_stats", {
    httpRelay: stats.httpRelay,
    mitmRelay: stats.mitmRelay,
    tunnelPass: stats.tunnelPass,
    errors: stats.errors,
    lastHost: stats.lastHost,
    lastPath: stats.lastPath,
    lastError: stats.lastError,
  });
  assert(Number(stats.httpRelay || 0) > 0, "httpRelay counter still 0");
  assert(Number(stats.mitmRelay || 0) > 0, "mitmRelay counter still 0");

  const cursor = readCursorProxy();
  const studioNeedle = proxyAddr.replace(/^https?:\/\//, "");
  const proxyStr = String(cursor.proxy || "");
  report.cursorPointsStudio =
    Boolean(proxyStr) && proxyStr.includes(studioNeedle);

  let cursorStatus = null;
  try {
    cursorStatus = await ctrl("GET", "/cursor/status");
  } catch {
    /* optional */
  }

  log("cursor_settings", {
    path: cursor.path,
    proxy: cursor.proxy,
    proxySupport: cursor.proxySupport,
    pointsStudio: report.cursorPointsStudio,
    studioProxy: `http://${studioNeedle}`,
    controlCursor: cursorStatus,
  });

  log("readiness", {
    ...report,
    note: report.cursorPointsStudio
      ? "Cursor 已指向 Studio 代理；新开 Agent 对话应走 :28180"
      : `Cursor 当前代理为 ${cursor.proxy || "空"}，未指向 Studio ${studioNeedle}。本脚本不会自动注入。请在 Studio「配置」手动注入，或先释放 :18080 上已有的本地服务。注入后建议完全重启 Cursor。`,
  });

  const critical = [
    report.control,
    report.service,
    report.backendDirect,
    report.httpRelay,
    report.mitmRelay,
    report.bidiMitm,
    report.sseMitm,
    report.caExists,
  ];
  assert(critical.every(Boolean), "critical mitm path failed");
  log("OK", "MITM path green (inject is manual / separate)");
}

main().catch((e) => {
  console.error("FAIL", e);
  process.exit(1);
});
