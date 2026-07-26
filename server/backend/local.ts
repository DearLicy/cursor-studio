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
  encodeCountTokensProto,
  encodeCurrentPeriodUsageProto,
  encodeDefaultModelProto,
  encodeDefaultModelNudgeProto,
  encodeFirstWindowStatsigDecisionProto,
  encodeGetServerConfigProto,
  encodeGetMeProto,
  encodeGetUserProfileProto,
  encodeGlassEarlyPreviewEnrollmentProto,
  encodeIsOnNewPricingProto,
  encodePlanInfoProto,
  encodeTokenUsageProto,
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
  concatMessages,
  collectStrings,
  decodeFields,
  encodeInt32,
  encodeMessage,
  encodeString,
  firstBytes,
  firstString,
} from "./forwarder/protobuf-wire";
import { tryParseJson, unwrapRequestBody } from "./forwarder/connect-frame";
import { listRequestLogs } from "../metrics/usage-store";
import { relayCursorUpstream } from "./upstream-relay";
import { getThoughtAnnotation } from "./forwarder/thought-annotation";

export interface BackendHandle {
  server: http.Server;
  listenAddr: string;
  close: () => Promise<void>;
}

const AI_SERVICE = "/aiserver.v1.AiService";
const ANALYTICS_SERVICE = "/aiserver.v1.AnalyticsService";
const AUTH_SERVICE = "/aiserver.v1.AuthService";
const DASHBOARD_SERVICE = "/aiserver.v1.DashboardService";
const AGENT_SERVICE = "/agent.v1.AgentService";

const RELAY_PROCEDURES = new Set([
  `${DASHBOARD_SERVICE}/GetEffectiveUserPlugins`,
  `${DASHBOARD_SERVICE}/GetScmConnectionStatus`,
  `${DASHBOARD_SERVICE}/GetGlobalCommands`,
  `${DASHBOARD_SERVICE}/ClientAction`,
  "/aiserver.v1.ServerConfigService/GetServerConfig",
  `${AI_SERVICE}/StreamCpp`,
  `${AI_SERVICE}/StreamNextCursorPrediction`,
  `${AI_SERVICE}/GetCppEditClassification`,
  `${AI_SERVICE}/RefreshTabContext`,
  `${AI_SERVICE}/CppConfig`,
  `${AI_SERVICE}/CppAppend`,
  `${AI_SERVICE}/CppEditHistoryStatus`,
  `${AI_SERVICE}/CppEditHistoryAppend`,
  // These features have no local implementation yet. Preserve Cursor's real
  // behaviour through the validated original endpoint instead of pretending a
  // successful empty response was useful.
  `${AI_SERVICE}/WriteGitCommitMessage`,
  `${AI_SERVICE}/WriteGitBranchName`,
  `${AI_SERVICE}/NameTab`,
  `${AI_SERVICE}/CreateExperimentalIndex`,
  `${AI_SERVICE}/ListExperimentalIndexFiles`,
  `${AI_SERVICE}/ListenExperimentalIndex`,
  `${AI_SERVICE}/RegisterFileToIndex`,
  `${AI_SERVICE}/SetupIndexDependencies`,
  `${AI_SERVICE}/ComputeIndexTopoSort`,
  `${AI_SERVICE}/DocumentationQuery`,
  `${AI_SERVICE}/AvailableDocs`,
  `${AI_SERVICE}/KnowledgeBaseAdd`,
  `${AI_SERVICE}/KnowledgeBaseList`,
  `${AI_SERVICE}/KnowledgeBaseRemove`,
  `${AI_SERVICE}/KnowledgeBaseUpdate`,
  `${AI_SERVICE}/FetchRelevantKnowledgeForConversation`,
]);

const RELAY_PREFIXES = [
  "/aiserver.v1.BackgroundComposerService/",
  "/aiserver.v1.CppService/",
  "/aiserver.v1.FileSyncService/",
  "/aiserver.v1.NetworkService/",
  "/aiserver.v1.InAppAdService/",
  "/aiserver.v1.RepositoryService/",
  "/aiserver.v1.UploadService/",
];

const LOCAL_ACK_PROCEDURES = new Set([
  `${ANALYTICS_SERVICE}/Batch`,
  `${ANALYTICS_SERVICE}/TrackEvents`,
  `${ANALYTICS_SERVICE}/SubmitLogs`,
  `${ANALYTICS_SERVICE}/IngestConversation`,
  `${ANALYTICS_SERVICE}/UploadIssueTrace`,
  `${AI_SERVICE}/ReportAiCodeChangeMetrics`,
  `${AI_SERVICE}/ReportClientNumericMetrics`,
  `${AI_SERVICE}/ReportProcessMetrics`,
  `${AI_SERVICE}/ReportProcessMetricsV2`,
  `${AI_SERVICE}/ReportGenerationFeedback`,
  `${AI_SERVICE}/ReportAgentFeedback`,
  `${AI_SERVICE}/ReportAgentMessageFeedback`,
]);

// Cursor accepts an omitted optional nudge for a new chat. Returning the
// generated default protobuf is intentional here; this is distinct from the
// old broad catch-all that hid unsupported procedures.
const LOCAL_EMPTY_RESPONSE_PROCEDURES = new Set([
  `${AGENT_SERVICE}/GetNewChatNudgeParameterizedModelPicker`,
  `${AGENT_SERVICE}/GetNewChatNudgeLegacyModelPicker`,
]);

function isProcedure(pathOnly: string, ...procedures: string[]): boolean {
  return procedures.includes(pathOnly);
}

function shouldRelayProcedure(pathOnly: string): boolean {
  return (
    RELAY_PROCEDURES.has(pathOnly) ||
    RELAY_PREFIXES.some((prefix) => pathOnly.startsWith(prefix))
  );
}

function isCursorRpcProcedure(pathOnly: string): boolean {
  return /^\/(?:aiserver|agent)\.v1\.[A-Za-z0-9_.]+\/[A-Za-z0-9_]+$/.test(
    pathOnly,
  );
}

function requestWantsConnect(req: http.IncomingMessage): "proto" | "json" | undefined {
  const contentType = String(req.headers["content-type"] || "").toLowerCase();
  const accept = String(req.headers.accept || "").toLowerCase();
  if (contentType.includes("connect+json") || accept.includes("connect+json")) {
    return "json";
  }
  if (contentType.includes("connect+proto") || accept.includes("connect+proto")) {
    return "proto";
  }
  return undefined;
}

function writeCursorRpcError(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  status: number,
  code: "unimplemented" | "unavailable" | "invalid_argument" | "internal",
  message: string,
): void {
  if (res.headersSent || res.writableEnded || res.destroyed) return;
  const connectWire = requestWantsConnect(req);
  if (connectWire) {
    const body = encodeConnectEndStream({ code, message });
    res.writeHead(status, {
      "Content-Type":
        connectWire === "json" ? "application/connect+json" : "application/connect+proto",
      "Content-Length": body.length,
      "Connect-Error-Code": code,
      "Cache-Control": "no-cache",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(body);
    return;
  }

  const body = Buffer.from(JSON.stringify({ code, message }), "utf8");
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "Access-Control-Allow-Origin": "*",
  });
  res.end(body);
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
function clampProtoInt32(value: number): number {
  return Math.max(0, Math.min(0x7fffffff, Math.round(Number(value) || 0)));
}

function estimateTextTokens(text: string): number {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes === 0) return 0;
  // A stable byte-based estimate is preferable to the old constant zero. It
  // intentionally errs slightly high so client-side context checks stay safe.
  return Math.max(1, Math.ceil(bytes / 3.6));
}

function countTokensFromRequest(body: Buffer): number {
  const payload = unwrapRequestBody(body);
  const json = tryParseJson(payload);
  if (json) {
    const items = json.contextItems ?? json.context_items;
    if (Array.isArray(items)) {
      return clampProtoInt32(
        items.reduce((total, item) => total + estimateTextTokens(JSON.stringify(item)), 0),
      );
    }
    return 0;
  }

  try {
    const contextItems = decodeFields(payload)
      .filter((field) => field.field === 1 && field.wire === 2 && field.bytes)
      .map((field) => field.bytes!);
    return clampProtoInt32(
      contextItems.reduce((total, item) => {
        const strings = collectStrings(item, 256);
        const text = strings.join("\n");
        return total + (text ? estimateTextTokens(text) : estimateTextTokens(item.toString("hex")));
      }, 0),
    );
  } catch {
    return 0;
  }
}

function usageUuidFromRequest(body: Buffer): string | undefined {
  const payload = unwrapRequestBody(body);
  const json = tryParseJson(payload);
  if (json) {
    const value = json.usageUuid ?? json.usage_uuid;
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  }
  try {
    return firstString(decodeFields(payload), 1)?.trim() || undefined;
  } catch {
    return undefined;
  }
}

function thoughtAnnotationRequestId(body: Buffer): string | undefined {
  const payload = unwrapRequestBody(body);
  const json = tryParseJson(payload);
  if (json) {
    const value = json.requestId ?? json.request_id;
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  }
  try {
    return firstString(decodeFields(payload), 1)?.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** GetThoughtAnnotationResponse { thought_annotation = 1 { request_id = 1; thought = 4; } }. */
function encodeThoughtAnnotationProto(requestId: string, thought: string): Buffer {
  return encodeMessage(1, concatMessages(
    encodeString(1, requestId),
    encodeString(4, thought),
  ));
}

async function tokenUsageForUuid(usageUuid: string | undefined): Promise<{
  inputTokens: number;
  outputTokens: number;
}> {
  if (!usageUuid) return { inputTokens: 0, outputTokens: 0 };
  const { logs } = await listRequestLogs(500);
  const item = logs.find((log) => log.requestId === usageUuid || log.id === usageUuid);
  if (!item) return { inputTokens: 0, outputTokens: 0 };
  return {
    inputTokens: clampProtoInt32(
      item.promptTokens + item.cacheReadTokens + item.cacheWriteTokens,
    ),
    outputTokens: clampProtoInt32(item.completionTokens),
  };
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
      if (isProcedure(pathOnly, "/aiserver.v1.BidiService/BidiAppend")) {
        await handleBidiAppend(req, res, getConfig);
        return;
      }
      if (
        isProcedure(
          pathOnly,
          `${AGENT_SERVICE}/Run`,
          `${AGENT_SERVICE}/RunSSE`,
        )
      ) {
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

      if (isProcedure(pathOnly, `${AI_SERVICE}/AvailableModels`)) {
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
      if (isProcedure(pathOnly, `${AI_SERVICE}/GetEffectiveTokenLimit`)) {
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

      if (isProcedure(pathOnly, `${AI_SERVICE}/GetDefaultModelNudgeData`)) {
        const cfg = await getConfig();
        const nudge = buildDefaultModelNudge(cfg.providers);
        if (url.includes("format=json")) {
          json(res, 200, nudge);
          return;
        }
        proto(
          res,
          200,
          encodeDefaultModelNudgeProto(
            nudge.modelsWithNoDefaultSwitch,
            nudge.nudgeDate,
          ),
        );
        return;
      }

      if (isProcedure(pathOnly, `${AI_SERVICE}/GetDefaultModel`)) {
        const cfg = await getConfig();
        const { modelNames } = buildAvailableModels(
          cfg.providers,
          cfg.cursorIntegration,
        );
        const model = modelNames[0] || "";
        if (url.includes("format=json")) {
          json(res, 200, { model, thinkingModel: model, maxMode: false });
        } else {
          proto(res, 200, encodeDefaultModelProto(model));
        }
        return;
      }

      if (isProcedure(pathOnly, `${AI_SERVICE}/ServerTime`)) {
        if (url.includes("format=json")) json(res, 200, { serverTime: Date.now() });
        else proto(res, 200, encodeServerTimeProto());
        return;
      }

      if (isProcedure(pathOnly, `${AI_SERVICE}/GetServerConfig`)) {
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

      if (isProcedure(pathOnly, `${DASHBOARD_SERVICE}/GetTokenUsage`)) {
        const usage = await tokenUsageForUuid(usageUuidFromRequest(await readBody(req)));
        if (url.includes("format=json")) {
          json(res, 200, usage);
        } else {
          proto(res, 200, encodeTokenUsageProto(usage.inputTokens, usage.outputTokens));
        }
        return;
      }
      if (isProcedure(pathOnly, `${DASHBOARD_SERVICE}/GetCurrentPeriodUsage`)) {
        const cfg = await getConfig();
        if (url.includes("format=json")) {
          json(res, 200, buildDashboardUsage(cfg.cursorIntegration));
        } else {
          proto(res, 200, encodeCurrentPeriodUsageProto(cfg.cursorIntegration));
        }
        return;
      }
      if (isProcedure(pathOnly, `${DASHBOARD_SERVICE}/GetMe`)) {
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
      if (isProcedure(pathOnly, `${DASHBOARD_SERVICE}/GetUserProfile`)) {
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
      if (isProcedure(pathOnly, `${DASHBOARD_SERVICE}/GetPlanInfo`)) {
        if (url.includes("format=json")) {
          const cfg = await getConfig();
          json(res, 200, buildPlanInfo(cfg.cursorIntegration));
          return;
        }
        const cfg = await getConfig();
        proto(res, 200, encodePlanInfoProto(cfg.cursorIntegration));
        return;
      }
      if (isProcedure(pathOnly, `${DASHBOARD_SERVICE}/GetTeams`)) {
        if (url.includes("format=json")) json(res, 200, { teams: [] });
        else proto(res, 200, Buffer.alloc(0));
        return;
      }
      if (isProcedure(pathOnly, `${DASHBOARD_SERVICE}/GetManagedSkills`)) {
        if (url.includes("format=json")) json(res, 200, { skills: [] });
        else proto(res, 200, Buffer.alloc(0));
        return;
      }
      if (isProcedure(pathOnly, `${DASHBOARD_SERVICE}/GetUserPrivacyMode`)) {
        if (url.includes("format=json")) json(res, 200, { privacyMode: "PRIVACY_MODE_NO_STORAGE" });
        else proto(res, 200, encodeUserPrivacyModeProto());
        return;
      }
      if (
        isProcedure(
          pathOnly,
          `${DASHBOARD_SERVICE}/GetUsageLimitStatusAndActiveGrants`,
        )
      ) {
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
      if (isProcedure(pathOnly, `${DASHBOARD_SERVICE}/IsOnNewPricing`)) {
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
      if (
        isProcedure(
          pathOnly,
          `${DASHBOARD_SERVICE}/GetGlassEarlyPreviewEnrollment`,
        )
      ) {
        if (url.includes("format=json")) {
          json(res, 200, {
            enabled: true,
            enterpriseGlassSelfEnrollEligible: true,
            glassAccessGranted: true,
          });
        } else proto(res, 200, encodeGlassEarlyPreviewEnrollmentProto());
        return;
      }

      if (isProcedure(pathOnly, `${ANALYTICS_SERVICE}/BootstrapStatsig`)) {
        if (url.includes("format=json")) {
          json(res, 200, { config: "{}", generatedAtMs: Date.now() });
        } else {
          const cfg = await getConfig();
          proto(res, 200, encodeBootstrapStatsigProto(cfg.cursorIntegration));
        }
        return;
      }
      if (
        isProcedure(
          pathOnly,
          `${ANALYTICS_SERVICE}/GetFirstWindowStatsigDecision`,
        )
      ) {
        if (url.includes("format=json")) json(res, 200, { variant: "control", reason: "local_default" });
        else proto(res, 200, encodeFirstWindowStatsigDecisionProto());
        return;
      }

      // GetEmail：proto 响应，展示标识 www.akucb.com（无需邮箱格式）
      if (isProcedure(pathOnly, `${AUTH_SERVICE}/GetEmail`)) {
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

      if (isProcedure(pathOnly, `${AI_SERVICE}/CountTokens`)) {
        const count = countTokensFromRequest(await readBody(req));
        if (url.includes("format=json")) json(res, 200, { count });
        else proto(res, 200, encodeCountTokensProto(count));
        return;
      }
      if (isProcedure(pathOnly, `${AI_SERVICE}/GetThoughtAnnotation`)) {
        const annotation = await getThoughtAnnotation(
          thoughtAnnotationRequestId(await readBody(req)) || "",
        );
        // A thought annotation is optional. Keep the typed empty response for
        // requests that have no completed compaction yet.
        if (url.includes("format=json")) {
          json(res, 200, annotation
            ? { thoughtAnnotation: { requestId: annotation.requestId, thought: annotation.thought } }
            : {});
        } else {
          proto(
            res,
            200,
            annotation
              ? encodeThoughtAnnotationProto(annotation.requestId, annotation.thought)
              : Buffer.alloc(0),
          );
        }
        return;
      }
      if (
        isProcedure(
          pathOnly,
          `${AI_SERVICE}/CheckQueuePosition`,
          `${AI_SERVICE}/GetUsageLimitPolicyStatus`,
          `${AI_SERVICE}/IsCursorPing`,
          `${AI_SERVICE}/HealthCheck`,
        )
      ) {
        if (url.includes("format=json")) json(res, 200, {});
        else proto(res, 200, Buffer.alloc(0));
        return;
      }

      // 知识库 / 索引 / 提交信息：空成功，防止红字
      // These are the only intentional empty local RPC responses: optional
      // model nudges and fire-and-forget telemetry acknowledgements.
      if (
        LOCAL_EMPTY_RESPONSE_PROCEDURES.has(pathOnly) ||
        LOCAL_ACK_PROCEDURES.has(pathOnly)
      ) {
        if (url.includes("format=json")) json(res, 200, {});
        else proto(res, 200, Buffer.alloc(0));
        return;
      }

      // Tab / CPP 类：本地无补全服务时返回空，避免 404 噪声
      // Ancillary Cursor services retain their native implementation through a
      // constrained relay. Unsupported local procedures are handled below.
      if (shouldRelayProcedure(pathOnly)) {
        const result = await relayCursorUpstream(req, res);
        if (result.relayed) return;
        writeCursorRpcError(
          req,
          res,
          502,
          "unavailable",
          "暂时无法连接到所需服务。",
        );
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

      if (isCursorRpcProcedure(pathOnly)) {
        writeCursorRpcError(
          req,
          res,
          501,
          "unimplemented",
          "当前服务暂不支持此项操作。",
        );
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
      if (isCursorRpcProcedure(pathOnly)) {
        writeCursorRpcError(req, res, 500, "internal", "服务处理请求时发生错误。");
        return;
      }
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
