/**
 * MITM HTTP/HTTPS 代理：白名单 *.cursor.sh 解密后转发到本地 backend。
 * 本地协议实现。
 * 纯 Node 实现，无 Go。
 *
 * 路径：
 * 1) 明文 absolute-form HTTP → 白名单直转 backend
 * 2) CONNECT 白名单 → TLS MITM → 解密 HTTP → backend（带 X-Server-Upstream-URL）
 * 3) 非白名单 CONNECT → 透明隧道
 * 4) CA 落盘 ~/.cursor-studio/data/certs（需客户端信任）
 */
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { X509Certificate } from "node:crypto";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import forge from "node-forge";
import { certsDir } from "../config/store";

export interface ProxyHandle {
  server: http.Server;
  listenAddr: string;
  caCertPath: string;
  close: () => Promise<void>;
  getStats: () => ProxyStats;
}

export type ProxyStats = {
  startedAt: string;
  httpRelay: number;
  mitmRelay: number;
  tunnelPass: number;
  errors: number;
  lastHost?: string;
  lastPath?: string;
  lastUpstream?: string;
  lastError?: string;
};

type CaMaterial = {
  certPath: string;
  keyPath: string;
  certPem: string;
  keyPem: string;
  cert: forge.pki.Certificate;
  key: forge.pki.rsa.PrivateKey;
};

type LeafMaterial = {
  certPem: string;
  keyPem: string;
};

const leafCache = new Map<string, LeafMaterial>();

const stats: ProxyStats = {
  startedAt: new Date().toISOString(),
  httpRelay: 0,
  mitmRelay: 0,
  tunnelPass: 0,
  errors: 0,
};

function bumpError(msg: string) {
  stats.errors += 1;
  stats.lastError = msg;
}

export function isCursorHost(host: string): boolean {
  const h = host.toLowerCase().replace(/:\d+$/, "").trim();
  if (!h) return false;
  return h === "api2.cursor.sh" || h === "api3.cursor.sh" || h.endsWith(".cursor.sh");
}

function normalizeHostPort(hostPort: string): { host: string; port: number } {
  const raw = (hostPort || "").trim().replace(/^\[|\]$/g, "");
  if (raw.includes("]:")) {
    // [ipv6]:port
    const idx = raw.lastIndexOf("]:");
    return { host: raw.slice(1, idx), port: Number(raw.slice(idx + 2) || 443) };
  }
  const [host, p] = raw.split(":");
  return { host: host || "", port: Number(p || 443) };
}

export async function ensureLocalCA(): Promise<CaMaterial> {
  const dir = certsDir();
  await fs.mkdir(dir, { recursive: true });
  const certPath = path.join(dir, "ca.crt");
  const keyPath = path.join(dir, "ca.key");

  if (existsSync(certPath) && existsSync(keyPath)) {
    const certPem = await fs.readFile(certPath, "utf8");
    const keyPem = await fs.readFile(keyPath, "utf8");
    // The CA may have been replaced while the control process stayed alive.
    // Never reuse leaf certificates minted under the previous CA material.
    leafCache.clear();
    return {
      certPath,
      keyPath,
      certPem,
      keyPem,
      cert: forge.pki.certificateFromPem(certPem),
      key: forge.pki.privateKeyFromPem(keyPem) as forge.pki.rsa.PrivateKey,
    };
  }

  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = Date.now().toString(16);
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 10);
  const attrs = [
    { name: "commonName", value: "Cursor Studio Local CA" },
    { name: "organizationName", value: "Cursor Studio" },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: "basicConstraints", cA: true, critical: true },
    {
      name: "keyUsage",
      keyCertSign: true,
      cRLSign: true,
      digitalSignature: true,
      critical: true,
    },
    { name: "subjectKeyIdentifier" },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  const certPem = forge.pki.certificateToPem(cert);
  const keyPem = forge.pki.privateKeyToPem(keys.privateKey);
  await fs.writeFile(certPath, certPem, "utf8");
  await fs.writeFile(keyPath, keyPem, "utf8");
  leafCache.clear();
  return {
    certPath,
    keyPath,
    certPem,
    keyPem,
    cert,
    key: keys.privateKey,
  };
}

function getLeafCert(hostname: string, ca: CaMaterial): LeafMaterial {
  const cn = hostname.toLowerCase();
  const cached = leafCache.get(cn);
  if (cached) return cached;

  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = `${Date.now().toString(16)}${Math.floor(Math.random() * 1e6).toString(16)}`;
  cert.validity.notBefore = new Date(Date.now() - 60_000);
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 2);
  const attrs = [
    { name: "commonName", value: cn },
    { name: "organizationName", value: "Cursor Studio MITM" },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(ca.cert.subject.attributes);
  const caSubjectKeyIdentifier = ca.cert.generateSubjectKeyIdentifier().getBytes();
  cert.setExtensions([
    { name: "basicConstraints", cA: false, critical: true },
    {
      name: "keyUsage",
      digitalSignature: true,
      keyEncipherment: true,
      critical: true,
    },
    { name: "extKeyUsage", serverAuth: true, clientAuth: true },
    {
      name: "subjectAltName",
      altNames: [{ type: 2, value: cn }],
    },
    { name: "subjectKeyIdentifier" },
    {
      name: "authorityKeyIdentifier",
      // Forge's `true` form hashes the leaf key. The AKI must identify the CA.
      keyIdentifier: caSubjectKeyIdentifier,
    },
  ]);
  cert.sign(ca.key, forge.md.sha256.create());

  const material: LeafMaterial = {
    certPem: forge.pki.certificateToPem(cert),
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
  };
  leafCache.set(cn, material);
  // 控制缓存大小
  if (leafCache.size > 64) {
    const first = leafCache.keys().next().value;
    if (first) leafCache.delete(first);
  }
  return material;
}

function parseListen(listenAddr: string): { host: string; port: number } {
  const cleaned = listenAddr.replace(/^https?:\/\//, "");
  const [host, p] = cleaned.split(":");
  return { host: host || "127.0.0.1", port: Number(p || 18080) };
}

const HOP_BY_HOP = new Set([
  "connection",
  "proxy-connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
]);

function scrubHeaders(
  src: http.IncomingHttpHeaders,
  extra?: Record<string, string>,
): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(src)) {
    if (v == null) continue;
    if (HOP_BY_HOP.has(k.toLowerCase())) continue;
    out[k] = v;
  }
  if (extra) Object.assign(out, extra);
  return out;
}

function forwardToBackend(
  clientReq: http.IncomingMessage,
  clientRes: http.ServerResponse,
  originalHost: string,
  backend: string,
  kind: "http" | "mitm",
): void {
  try {
    const target = new URL(clientReq.url || "/", backend);
    const headers = scrubHeaders(clientReq.headers, {
      "x-server-upstream-url": `https://${originalHost}${clientReq.url || "/"}`,
      host: target.host,
    });

    stats.lastHost = originalHost;
    stats.lastPath = clientReq.url || "/";
    stats.lastUpstream = `https://${originalHost}${clientReq.url || "/"}`;
    if (kind === "http") stats.httpRelay += 1;
    else stats.mitmRelay += 1;

    const lib = backend.startsWith("https") ? https : http;
    const upstream = lib.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === "https:" ? 443 : 80),
        path: target.pathname + target.search,
        method: clientReq.method,
        headers,
        timeout: 120_000,
      },
      (upRes) => {
        const resHeaders = scrubHeaders(upRes.headers as http.IncomingHttpHeaders);
        // SSE / 长连接
        clientRes.writeHead(upRes.statusCode || 502, resHeaders);
        upRes.pipe(clientRes);
      },
    );
    upstream.on("timeout", () => {
      upstream.destroy(new Error("backend timeout"));
    });
    upstream.on("error", (err) => {
      bumpError(err.message);
      if (!clientRes.headersSent) {
        clientRes.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
      }
      clientRes.end(`bad gateway: ${err.message}`);
    });
    clientReq.pipe(upstream);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    bumpError(msg);
    if (!clientRes.headersSent) {
      clientRes.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
    }
    clientRes.end(`bad gateway: ${msg}`);
  }
}

function tunnelConnect(
  clientSocket: net.Socket,
  head: Buffer,
  hostname: string,
  port: number,
): void {
  stats.tunnelPass += 1;
  stats.lastHost = hostname;
  const serverSocket = net.connect(port, hostname, () => {
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head?.length) serverSocket.write(head);
    serverSocket.pipe(clientSocket);
    clientSocket.pipe(serverSocket);
  });
  serverSocket.on("error", (err) => {
    bumpError(`tunnel ${hostname}: ${err.message}`);
    try {
      clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    } catch {
      /* ignore */
    }
    clientSocket.end();
  });
  clientSocket.on("error", () => serverSocket.end());
}

function mitmConnect(
  clientSocket: net.Socket,
  head: Buffer,
  hostname: string,
  backend: string,
  ca: CaMaterial,
): void {
  try {
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
  } catch (e) {
    bumpError(e instanceof Error ? e.message : String(e));
    clientSocket.destroy();
    return;
  }

  const leaf = getLeafCert(hostname, ca);
  // 链式证书：leaf + CA，便于部分校验路径
  const certChain = `${leaf.certPem}\n${ca.certPem}`;
  let tlsSocket: tls.TLSSocket;
  try {
    tlsSocket = new tls.TLSSocket(clientSocket, {
      isServer: true,
      key: leaf.keyPem,
      cert: certChain,
      // 只做 HTTP/1.1 MITM（Node http 不走 h2）
      ALPNProtocols: ["http/1.1"],
    });
  } catch (e) {
    bumpError(e instanceof Error ? e.message : String(e));
    clientSocket.destroy();
    return;
  }

  // CONNECT 后的 head 若有残留，TLS 层会自行处理；不主动 unshift 明文
  void head;

  const localHttp = http.createServer((req, res) => {
    forwardToBackend(req, res, hostname, backend, "mitm");
  });
  localHttp.on("clientError", (err, socket) => {
    bumpError(`clientError ${hostname}: ${err.message}`);
    try {
      socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    } catch {
      /* ignore */
    }
  });

  let attached = false;
  const attach = () => {
    if (attached) return;
    attached = true;
    try {
      localHttp.emit("connection", tlsSocket);
    } catch (e) {
      bumpError(e instanceof Error ? e.message : String(e));
      tlsSocket.destroy();
    }
  };

  // 握手完成后再挂 HTTP 解析；若已 secure 则立即挂
  tlsSocket.on("secure", attach);
  if (tlsSocket.encrypted && (tlsSocket as tls.TLSSocket & { authorized?: boolean })) {
    // secure 可能已触发，下一 tick 兜底 attach
    setImmediate(attach);
  }
  tlsSocket.on("error", (err) => {
    bumpError(`tls ${hostname}: ${err.message}`);
    try {
      clientSocket.destroy();
    } catch {
      /* ignore */
    }
  });
  clientSocket.on("error", () => {
    try {
      tlsSocket.destroy();
    } catch {
      /* ignore */
    }
  });
}

export async function startProxy(opts: {
  listenAddr: string;
  backendBaseURL: string;
}): Promise<ProxyHandle> {
  const ca = await ensureLocalCA();
  const { host, port } = parseListen(opts.listenAddr);
  const backend = opts.backendBaseURL.replace(/\/$/, "");

  stats.startedAt = new Date().toISOString();
  stats.httpRelay = 0;
  stats.mitmRelay = 0;
  stats.tunnelPass = 0;
  stats.errors = 0;
  stats.lastError = undefined;

  const server = http.createServer((clientReq, clientRes) => {
    // absolute-form 或 Host 头
    let hostHeader = (clientReq.headers.host || "").toLowerCase();
    const url = clientReq.url || "/";
    if (url.startsWith("http://") || url.startsWith("https://")) {
      try {
        const u = new URL(url);
        hostHeader = u.host.toLowerCase();
        // 重写为 path-form 便于转发
        (clientReq as { url?: string }).url = u.pathname + u.search;
      } catch {
        /* keep */
      }
    }

    const hostOnly = hostHeader.replace(/:\d+$/, "");
    if (isCursorHost(hostOnly) || isCursorHost(hostHeader)) {
      forwardToBackend(clientReq, clientRes, hostOnly || hostHeader, backend, "http");
      return;
    }

    // 非白名单：直连 HTTP absolute URL
    try {
      const u = new URL(url);
      const upstream = http.request(
        {
          hostname: u.hostname,
          port: u.port || 80,
          path: u.pathname + u.search,
          method: clientReq.method,
          headers: scrubHeaders(clientReq.headers, { host: u.host }),
        },
        (upRes) => {
          clientRes.writeHead(upRes.statusCode || 502, upRes.headers);
          upRes.pipe(clientRes);
        },
      );
      upstream.on("error", (err) => {
        bumpError(err.message);
        clientRes.writeHead(502);
        clientRes.end(String(err));
      });
      clientReq.pipe(upstream);
    } catch {
      clientRes.writeHead(400);
      clientRes.end("bad request");
    }
  });

  server.on("connect", (req, clientSocket, head) => {
    const { host: hostname, port: targetPort } = normalizeHostPort(req.url || "");
    if (!hostname) {
      clientSocket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      clientSocket.end();
      return;
    }

    if (isCursorHost(hostname)) {
      mitmConnect(clientSocket as net.Socket, head, hostname, backend, ca);
      return;
    }
    tunnelConnect(clientSocket as net.Socket, head, hostname, targetPort);
  });

  server.on("error", (err) => {
    bumpError(err.message);
    console.error("[proxy]", err);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });

  console.log(
    `[studio-proxy] http://${host}:${port} → backend ${backend} (MITM *.cursor.sh, CA ${ca.certPath})`,
  );

  return {
    server,
    listenAddr: `${host}:${port}`,
    caCertPath: ca.certPath,
    getStats: () => ({ ...stats }),
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

export async function installCaToWindowsUserStore(): Promise<{
  ok: boolean;
  message: string;
  certPath: string;
}> {
  const ca = await ensureLocalCA();
  if (process.platform !== "win32") {
    return {
      ok: false,
      message: "仅 Windows 支持一键导入；请手动信任 ca.crt",
      certPath: ca.certPath,
    };
  }
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  const thumbprint = new X509Certificate(ca.certPem).fingerprint.replace(
    /:/g,
    "",
  );

  const alreadyInStore = async (scope: "user" | "machine"): Promise<boolean> => {
    try {
      const args =
        scope === "user"
          ? ["-user", "-verifystore", "Root", thumbprint]
          : ["-verifystore", "Root", thumbprint];
      await execFileAsync("certutil", args, {
        windowsHide: true,
        encoding: "utf8",
      });
      return true;
    } catch {
      return false;
    }
  };

  if ((await alreadyInStore("user")) || (await alreadyInStore("machine"))) {
    return {
      ok: true,
      message: "CA 已在信任存储中",
      certPath: ca.certPath,
    };
  }

  try {
    await execFileAsync(
      "certutil",
      ["-user", "-addstore", "Root", ca.certPath],
      { windowsHide: true },
    );
    if (await alreadyInStore("user")) {
      return {
        ok: true,
        message:
          "已导入当前用户「受信任的根证书颁发机构」。请完全退出并重启 Cursor。",
        certPath: ca.certPath,
      };
    }
  } catch (e) {
    console.warn(
      "[proxy] user Root install failed",
      e instanceof Error ? e.message : e,
    );
  }

  try {
    const ps = [
      "$p = Start-Process -FilePath 'certutil.exe'",
      `-ArgumentList @('-addstore','Root',${JSON.stringify(ca.certPath)})`,
      "-Verb RunAs -WindowStyle Hidden -Wait -PassThru;",
      "exit $p.ExitCode",
    ].join(" ");
    await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ps],
      { windowsHide: true },
    );
    if ((await alreadyInStore("machine")) || (await alreadyInStore("user"))) {
      return {
        ok: true,
        message: "已导入系统信任根（可能已弹 UAC）。请完全退出并重启 Cursor。",
        certPath: ca.certPath,
      };
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      message: `导入失败: ${msg}。请手动双击 ${ca.certPath} 安装到「受信任的根证书颁发机构」，然后重启 Cursor。`,
      certPath: ca.certPath,
    };
  }

  return {
    ok: false,
    message: `证书命令已执行，但信任存储未确认成功。请手动安装: ${ca.certPath}`,
    certPath: ca.certPath,
  };
}

export function getProxyCaPath(): string {
  return path.join(certsDir(), "ca.crt");
}

/** 同步探测：证书文件是否存在 */
export function caFilesExist(): boolean {
  const dir = certsDir();
  return existsSync(path.join(dir, "ca.crt")) && existsSync(path.join(dir, "ca.key"));
}

export function getProxyStatsSnapshot(): ProxyStats {
  return { ...stats };
}
