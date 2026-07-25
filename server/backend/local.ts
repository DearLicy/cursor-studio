/**
 * 本地 Backend：内置 Cursor 云端兼容面 + Agent forwarder。
 * 本地协议实现。
 *
 * 本地协议实现。
 *   POST /aiserver.v1.BidiService/BidiAppend  → Connect unary → local BidiAppend
 *   POST /agent.v1.AgentService/RunSSE       → Connect stream → local RunSSE
 *   其余常用 unary mock 防红字
 */
import http from "node:http";
import fs from "node:fs";
import type { AppConfig } from "../config/store";
import {
  CURSOR_AVATAR_ROUTE,
  cursorAvatarContentType,
  resolveCursorAvatarPath,
  resolveCursorAvatarUrl,
} from "../runtime/app-icon";
import {
  handleBidiAppend,
  handleOpenAIChat,
  handleRunSSE,
} from "./agent/engine";
import {
  buildAvailableModels,
  buildDashboardUsage,
  buildDefaultModelNudge,
  buildGetMe,
  buildPlanInfo,
  buildCursorUserProfile,
  resolveContextWindowTokensForModel,
} from "./forwarder/models";
import {
  encodeAvailableModelsProto,
  encodeBootstrapStatsigProto,
  encodeCurrentPeriodUsageProto,
  encodeDefaultModelNudgeProto,
  encodeFirstWindowStatsigDecisionProto,
  encodeGetServerConfigProto,
  encodeGetMeProto,
  encodeGetUserProfileProto,
  encodeGlassEarlyPreviewEnrollmentProto,
  encodeIsOnNewPricingProto,
  encodePlanInfoProto,
  encodeUsageLimitStatusProto,
  encodeUserPrivacyModeProto,
  encodeServerTimeProto,
} from "./forwarder/mock-proto";
import {
  InjectAuthToken,
  LocalUltraMembershipType,
  LocalUltraPaymentID,
  LocalUltraSubscriptionStatus,
} from "../runtime/defaults";
import { encodeConnectEndStream } from "./forwarder/stream-writer";
import {
  decodeFields,
  encodeInt32,
  firstBytes,
  firstString,
} from "./forwarder/protobuf-wire";
import { tryParseJson, unwrapRequestBody } from "./forwarder/connect-frame";

export interface BackendHandle {
  server: http.Server;
  listenAddr: string;
  close: () => Promise<void>;
}

function json(res: http.ServerResponse, status: number, body: unknown) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  });
  res.end(data);
}

function rawJson(res: http.ServerResponse, status: number, body: unknown) {
  const data = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  });
  res.end(data);
}

function proto(res: http.ServerResponse, status: number, body: Buffer) {
  res.writeHead(status, {
    "Content-Type": "application/proto",
    "Content-Length": body.length,
    "Access-Control-Allow-Origin": "*",
  });
  res.end(body);
}

function connectStreamEmpty(res: http.ServerResponse, status = 200) {
  const body = encodeConnectEndStream();
  res.writeHead(status, {
    "Content-Type": "application/connect+proto",
    "Content-Length": body.length,
    "Cache-Control": "no-cache",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(body);
}

function isStreamMethod(pathOnly: string): boolean {
  return /(?:^|\/)(?:Stream|Watch|Attach|Subscribe|RunSSE)/i.test(pathOnly);
}

function encodeAuthGetEmailResponse(email: string): Buffer {
  const emailBuf = Buffer.from(email, "utf8");
  const out: number[] = [];
  out.push(0x0a);
  let len = emailBuf.length;
  while (len >= 0x80) {
    out.push((len & 0x7f) | 0x80);
    len >>>= 7;
  }
  out.push(len);
  for (const b of emailBuf) out.push(b);
  out.push(0x10, 0x03);
  return Buffer.from(out);
}

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/** GetEffectiveTokenLimitRequest { model_details = 1 { model_name = 1 } }. */
function modelHintFromEffectiveTokenLimitRequest(body: Buffer): string | undefined {
  const unwrapped = unwrapRequestBody(body);
  const json = tryParseJson(unwrapped);
  if (json) {
    const details =
      (json.modelDetails as Record<string, unknown> | undefined) ||
      (json.model_details as Record<string, unknown> | undefined);
    const jsonModel = details?.modelName ?? details?.model_name;
    if (typeof jsonModel === "string" && jsonModel.trim()) return jsonModel.trim();
  }

  try {
    const requestFields = decodeFields(unwrapped);
    const modelDetails = firstBytes(requestFields, 1);
    if (!modelDetails) return undefined;
    return firstString(decodeFields(modelDetails), 1)?.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** 路径匹配：Connect 风格 /aiserver.v1.X/Y */
function match(pathOnly: string, ...needles: string[]): boolean {
  return needles.some((n) => pathOnly.includes(n));
}

function serveCursorAvatar(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  configuredAvatarUrl?: string,
): void {
  const avatarPath = resolveCursorAvatarPath(configuredAvatarUrl);
  try {
    const stat = fs.statSync(avatarPath);
    if (!stat.isFile()) throw new Error("avatar is not a file");

    res.writeHead(200, {
      "Content-Type": cursorAvatarContentType(avatarPath),
      "Content-Length": stat.size,
      "Cache-Control": "no-store, max-age=0",
      "Access-Control-Allow-Origin": "*",
      "Cross-Origin-Resource-Policy": "cross-origin",
      "X-Content-Type-Options": "nosniff",
    });
    if (req.method === "HEAD") {
      res.end();
      return;
    }

    const stream = fs.createReadStream(avatarPath);
    stream.once("error", () => {
      if (!res.writableEnded) res.destroy();
    });
    stream.pipe(res);
  } catch {
    json(res, 404, { error: "avatar_not_found" });
  }
}

export async function startBackend(
  listenAddr: string,
  getConfig: () => Promise<AppConfig>,
): Promise<BackendHandle> {
  const hostPort = listenAddr.includes("://")
    ? new URL(listenAddr).host
    : listenAddr;
  const [host, portStr] = hostPort.split(":");
  const port = Number(portStr || 18090);
  let publicListenAddr = `127.0.0.1:${port}`;

  const server = http.createServer(async (req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "*",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      });
      res.end();
      return;
    }

    const url = req.url || "/";
    const pathOnly = url.split("?")[0];

    try {
      if (
        (req.method === "GET" || req.method === "HEAD") &&
        pathOnly === CURSOR_AVATAR_ROUTE
      ) {
        const cfg = await getConfig();
        serveCursorAvatar(req, res, cfg.cursorIntegration.avatarUrl);
        return;
      }

      if (pathOnly === "/healthz" || pathOnly === "/health") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("ok");
        return;
      }

      if (pathOnly === "/studio/config") {
        const cfg = await getConfig();
        json(res, 200, {
          engine: "embedded-ts",
          language: "typescript",
          providers: cfg.providers.map((p) => ({
            id: p.id,
            displayName: p.displayName,
            type: p.type,
            modelID: p.modelID,
            models: p.models || [],
            enabled: p.enabled,
          })),
        });
        return;
      }

      // —— 核心 Agent 链路（forwarder）——
      if (match(pathOnly, "BidiAppend")) {
        await handleBidiAppend(req, res, getConfig);
        return;
      }
      if (match(pathOnly, "RunSSE", "agent.v1.AgentService/Run")) {
        await handleRunSSE(req, res, getConfig);
        return;
      }

      if (
        pathOnly === "/v1/chat/completions" ||
        pathOnly.endsWith("/chat/completions")
      ) {
        await handleOpenAIChat(req, res, getConfig);
        return;
      }

      if (match(pathOnly, "AvailableModels") || pathOnly.endsWith("/models")) {
        const cfg = await getConfig();
        const payload = buildAvailableModels(cfg.providers, cfg.cursorIntegration);
        // Cursor 真机要 proto；保留 ?format=json 方便调试
        if (url.includes("format=json")) {
          json(res, 200, payload);
          return;
        }
        proto(res, 200, encodeAvailableModelsProto(payload));
        return;
      }

      // Cursor uses this unary RPC for the active conversation's effective
      // context budget. Returning an empty proto here made the desktop client
      // fall back to its built-in 200K value even after Studio saved 500K.
      if (match(pathOnly, "GetEffectiveTokenLimit")) {
        const cfg = await getConfig();
        const body = await readBody(req);
        const modelHint = modelHintFromEffectiveTokenLimitRequest(body);
        const tokenLimit = resolveContextWindowTokensForModel(
          cfg.providers,
          modelHint,
          cfg.cursorIntegration,
        );
        if (url.includes("format=json")) {
          json(res, 200, { tokenLimit });
        } else {
          // GetEffectiveTokenLimitResponse { int32 token_limit = 1 }
          proto(res, 200, encodeInt32(1, tokenLimit));
        }
        return;
      }

      if (match(pathOnly, "GetDefaultModelNudgeData")) {
        const cfg = await getConfig();
        const nudge = buildDefaultModelNudge(cfg.providers);
        if (url.includes("format=json")) {
          json(res, 200, nudge);
          return;
        }
        proto(
          res,
          200,
          encodeDefaultModelNudgeProto(nudge.modelsWithNoDefaultSwitch),
        );
        return;
      }

      if (match(pathOnly, "ServerTime")) {
        if (url.includes("format=json")) json(res, 200, { serverTime: Date.now() });
        else proto(res, 200, encodeServerTimeProto());
        return;
      }

      if (match(pathOnly, "GetServerConfig")) {
        if (url.includes("format=json")) {
          json(res, 200, {
            isLocalAssistant: true,
            product: "cursor-studio",
            engine: "embedded-ts",
            message: "Cursor Studio pure TypeScript agent engine",
          });
        } else proto(res, 200, encodeGetServerConfigProto());
        return;
      }

      if (match(pathOnly, "GetTokenUsage")) {
        json(res, 200, { inputTokens: 0, outputTokens: 0 });
        return;
      }
      if (match(pathOnly, "GetCurrentPeriodUsage")) {
        const cfg = await getConfig();
        if (url.includes("format=json")) {
          json(res, 200, buildDashboardUsage(cfg.cursorIntegration));
        } else {
          proto(res, 200, encodeCurrentPeriodUsageProto(cfg.cursorIntegration));
        }
        return;
      }
      if (match(pathOnly, "GetMe")) {
        const cfg = await getConfig();
        const avatarUrl = resolveCursorAvatarUrl(
          cfg.cursorIntegration.avatarUrl,
          publicListenAddr,
        );
        if (url.includes("format=json")) {
          json(res, 200, buildGetMe(cfg.cursorIntegration, avatarUrl));
          return;
        }
        proto(res, 200, encodeGetMeProto(cfg.cursorIntegration, avatarUrl));
        return;
      }
      if (match(pathOnly, "GetUserProfile")) {
        const cfg = await getConfig();
        const avatarUrl = resolveCursorAvatarUrl(
          cfg.cursorIntegration.avatarUrl,
          publicListenAddr,
        );
        if (url.includes("format=json")) {
          json(res, 200, buildCursorUserProfile(cfg.cursorIntegration, avatarUrl));
          return;
        }
        proto(res, 200, encodeGetUserProfileProto(cfg.cursorIntegration, avatarUrl));
        return;
      }
      if (match(pathOnly, "GetPlanInfo")) {
        if (url.includes("format=json")) {
          const cfg = await getConfig();
          json(res, 200, buildPlanInfo(cfg.cursorIntegration));
          return;
        }
        const cfg = await getConfig();
        proto(res, 200, encodePlanInfoProto(cfg.cursorIntegration));
        return;
      }
      if (match(pathOnly, "GetTeams")) {
        if (url.includes("format=json")) json(res, 200, { teams: [] });
        else proto(res, 200, Buffer.alloc(0));
        return;
      }
      if (match(pathOnly, "GetManagedSkills")) {
        if (url.includes("format=json")) json(res, 200, { skills: [] });
        else proto(res, 200, Buffer.alloc(0));
        return;
      }
      if (match(pathOnly, "GetUserPrivacyMode")) {
        if (url.includes("format=json")) json(res, 200, { privacyMode: "PRIVACY_MODE_NO_STORAGE" });
        else proto(res, 200, encodeUserPrivacyModeProto());
        return;
      }
      if (match(pathOnly, "GetUsageLimitStatusAndActiveGrants")) {
        if (url.includes("format=json")) {
          json(res, 200, {
            usageLimitPolicyStatus: {
              isInSlowPool: false,
              features: {},
              canConfigureSpendLimit: true,
              hasPendingRequest: false,
              allowedModelIds: [],
              allowedModelTags: [],
            },
            activeGrants: [],
          });
        } else proto(res, 200, encodeUsageLimitStatusProto());
        return;
      }
      if (match(pathOnly, "IsOnNewPricing")) {
        if (url.includes("format=json")) {
          json(res, 200, {
            isOnNewPricing: true,
            isOptedOut: false,
            hasAutoSpillover: true,
            dashboardUserId: 1,
          });
        } else proto(res, 200, encodeIsOnNewPricingProto());
        return;
      }
      if (match(pathOnly, "GetGlassEarlyPreviewEnrollment")) {
        if (url.includes("format=json")) {
          json(res, 200, {
            enabled: true,
            enterpriseGlassSelfEnrollEligible: true,
            glassAccessGranted: true,
          });
        } else proto(res, 200, encodeGlassEarlyPreviewEnrollmentProto());
        return;
      }

      if (match(pathOnly, "BootstrapStatsig")) {
        if (url.includes("format=json")) {
          json(res, 200, { config: "{}", generatedAtMs: Date.now() });
        } else {
          const cfg = await getConfig();
          proto(res, 200, encodeBootstrapStatsigProto(cfg.cursorIntegration));
        }
        return;
      }
      if (match(pathOnly, "GetFirstWindowStatsigDecision")) {
        if (url.includes("format=json")) json(res, 200, { variant: "control", reason: "local_default" });
        else proto(res, 200, encodeFirstWindowStatsigDecisionProto());
        return;
      }

      // GetEmail：proto 响应，展示标识 www.akucb.com（无需邮箱格式）
      if (match(pathOnly, "AuthService/GetEmail", "GetEmail")) {
        const cfg = await getConfig();
        proto(res, 200, encodeAuthGetEmailResponse(cfg.cursorIntegration.contactEmail));
        return;
      }

      if (pathOnly === "/oauth/token") {
        let refresh = InjectAuthToken;
        try {
          const body = await readBody(req);
          const parsed = JSON.parse(body.toString("utf8") || "{}") as {
            refresh_token?: string;
          };
          if (parsed.refresh_token?.trim()) refresh = parsed.refresh_token.trim();
        } catch {
          /* use default */
        }
        json(res, 200, {
          access_token: refresh,
          id_token: refresh,
          shouldLogout: false,
        });
        return;
      }

      // Stripe / poll —— Settings 页 Studio Ultra 与会话刷新依赖这些
      if (pathOnly === "/auth/full_stripe_profile") {
        json(res, 200, {
          membershipType: LocalUltraMembershipType,
          subscriptionStatus: LocalUltraSubscriptionStatus,
          lastPaymentFailed: false,
          pendingCancellationDate: "",
          daysRemainingOnTrial: 0,
          paymentId: LocalUltraPaymentID,
        });
        return;
      }
      if (pathOnly === "/auth/stripe_profile") {
        rawJson(res, 200, JSON.stringify(LocalUltraPaymentID));
        return;
      }
      if (pathOnly === "/auth/has_valid_payment_method") {
        json(res, 200, { hasValidPaymentMethod: true });
        return;
      }
      if (pathOnly === "/auth/poll" || pathOnly.startsWith("/auth/poll")) {
        json(res, 200, {
          accessToken: InjectAuthToken,
          refreshToken: InjectAuthToken,
          authId: "local_auth",
        });
        return;
      }
      if (pathOnly === "/auth/logout") {
        res.writeHead(204, {
          "Access-Control-Allow-Origin": "*",
        });
        res.end();
        return;
      }
      if (pathOnly.startsWith("/auth/")) {
        json(res, 404, { error: "not_found", path: pathOnly });
        return;
      }

      if (match(pathOnly, "CountTokens")) {
        if (url.includes("format=json")) json(res, 200, { tokenCount: 0, totalTokens: 0 });
        else proto(res, 200, Buffer.alloc(0));
        return;
      }
      if (match(pathOnly, "GetThoughtAnnotation")) {
        if (url.includes("format=json")) json(res, 200, {});
        else proto(res, 200, Buffer.alloc(0));
        return;
      }
      if (
        match(
          pathOnly,
          "CheckQueuePosition",
          "GetUsageLimitPolicyStatus",
          "IsCursorPing",
          "HealthCheck",
        )
      ) {
        if (url.includes("format=json")) json(res, 200, { ok: true });
        else proto(res, 200, Buffer.alloc(0));
        return;
      }

      // 知识库 / 索引 / 提交信息：空成功，防止红字
      if (
        match(
          pathOnly,
          "KnowledgeBase",
          "ExperimentalIndex",
          "DocumentationQuery",
          "AvailableDocs",
          "NameTab",
          "ReportClientNumericMetrics",
          "WriteGitCommitMessage",
          "WriteGitBranchName",
          "RegisterFileToIndex",
          "SetupIndexDependencies",
          "ComputeIndexTopoSort",
          "FetchRelevantKnowledge",
        )
      ) {
        if (url.includes("format=json")) json(res, 200, {});
        else proto(res, 200, Buffer.alloc(0));
        return;
      }

      // Tab / CPP 类：本地无补全服务时返回空，避免 404 噪声
      if (
        match(
          pathOnly,
          "StreamCpp",
          "StreamNextCursorPrediction",
          "CppConfig",
          "CppAppend",
          "CppEditHistory",
          "RefreshTabContext",
          "GetCppEditClassification",
          "ReportAiCodeChangeMetrics",
        )
      ) {
        if (url.includes("format=json")) json(res, 200, {});
        else if (isStreamMethod(pathOnly)) connectStreamEmpty(res);
        else proto(res, 200, Buffer.alloc(0));
        return;
      }

      if (pathOnly === "/v1/models") {
        const cfg = await getConfig();
        const { modelNames, models } = buildAvailableModels(
          cfg.providers,
          cfg.cursorIntegration,
        );
        json(res, 200, {
          object: "list",
          data: modelNames.map((id, i) => ({
            id,
            object: "model",
            owned_by: "cursor-studio",
            name: models[i]?.clientDisplayName,
          })),
        });
        return;
      }

      if (pathOnly.includes("aiserver.v1.") || pathOnly.includes("agent.v1.")) {
        if (url.includes("format=json")) json(res, 200, { ok: true, engine: "embedded-ts" });
        else if (isStreamMethod(pathOnly)) connectStreamEmpty(res);
        else proto(res, 200, Buffer.alloc(0));
        return;
      }

      json(res, 404, {
        error: "not_found",
        path: pathOnly,
        engine: "embedded-ts",
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[backend]", pathOnly, msg);
      json(res, 500, { error: msg });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host === "0.0.0.0" ? undefined : host, () => resolve());
  });

  const bound = server.address();
  const actualPort = typeof bound === "object" && bound ? bound.port : port;
  publicListenAddr = `127.0.0.1:${actualPort}`;
  console.log(`[studio-backend] http://${publicListenAddr} engine=embedded-ts`);
  return {
    server,
    listenAddr: publicListenAddr,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
