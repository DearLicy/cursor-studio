/**
 * 本地协议实现。
 * 本文件保留 OpenAI 兼容自测入口 + 向后兼容 re-export。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AppConfig } from "../../config/store";
import { recordTurnUsage } from "../../metrics/usage-store";
import {
  isProviderRequestError,
  orderProviderCandidates,
  runProviderChat,
} from "./provider-chat";
import {
  handleBidiAppend as forwarderBidiAppend,
  handleRunSSE as forwarderRunSSE,
} from "../forwarder";

export { extractInbound as extractIdsAndText } from "../forwarder";

export async function handleBidiAppend(
  req: IncomingMessage,
  res: ServerResponse,
  getConfig: () => Promise<AppConfig>,
): Promise<void> {
  return forwarderBidiAppend(req, res, getConfig);
}

export async function handleRunSSE(
  req: IncomingMessage,
  res: ServerResponse,
  getConfig: () => Promise<AppConfig>,
): Promise<void> {
  return forwarderRunSSE(req, res, getConfig);
}

function writeJson(res: ServerResponse, status: number, body: unknown) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(data);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function openAIRequestId(req: IncomingMessage, completionId: string): string {
  const incoming = req.headers["x-request-id"];
  const value = Array.isArray(incoming) ? incoming[0] : incoming;
  return String(value || "").trim().slice(0, 256) || completionId;
}

function failedProviderRoute(
  error: unknown,
  providers: AppConfig["providers"],
  modelHint?: string,
): { providerId?: string; modelID?: string } {
  if (isProviderRequestError(error)) {
    return { providerId: error.providerId, modelID: error.modelID };
  }
  const preferred = orderProviderCandidates(providers, modelHint)[0];
  return preferred
    ? { providerId: preferred.id, modelID: preferred.modelID }
    : {};
}

/** OpenAI 兼容 chat：方便自测与部分客户端 */
export async function handleOpenAIChat(
  req: IncomingMessage,
  res: ServerResponse,
  getConfig: () => Promise<AppConfig>,
): Promise<void> {
  const completionId = `chatcmpl_${Date.now()}`;
  const requestId = openAIRequestId(req, completionId);
  let providers: AppConfig["providers"] = [];
  let requestedModel: string | undefined;
  try {
    const buf = await readBody(req);
    const body = JSON.parse(buf.toString("utf8") || "{}") as {
      model?: string;
      messages?: {
        role: string;
        content: string | Array<{ type?: string; text?: string }>;
      }[];
      stream?: boolean;
    };
    requestedModel = body.model;
    const cfg = await getConfig();
    providers = cfg.providers;
    const userTexts = (body.messages || [])
      .filter((m) => m.role === "user")
      .map((m) => {
        if (typeof m.content === "string") return m.content;
        if (Array.isArray(m.content)) {
          return m.content
            .map((c) => (typeof c === "string" ? c : c.text || ""))
            .join("");
        }
        return "";
      })
      .filter(Boolean);

    if (body.stream) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      const id = completionId;
      let full = "";
      let usage = {
        promptTokens: 0,
        completionTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      };
      let providerId = "";
      let modelID = body.model || "";

      try {
        const result = await runProviderChat(
          cfg.providers,
          userTexts,
          body.model,
          {
            onText: (delta) => {
              full += delta;
              res.write(
                `data: ${JSON.stringify({
                  id,
                  object: "chat.completion.chunk",
                  choices: [
                    {
                      index: 0,
                      delta: { content: delta },
                      finish_reason: null,
                    },
                  ],
                })}\n\n`,
              );
            },
          },
          {
            globalContextWindowTokens: cfg.cursorIntegration.defaultContextWindowTokens,
          },
        );
        usage = result.usage;
        providerId = result.providerId;
        modelID = result.modelID;
        if (!full && result.text) {
          full = result.text;
          res.write(
            `data: ${JSON.stringify({
              id,
              object: "chat.completion.chunk",
              choices: [
                {
                  index: 0,
                  delta: { role: "assistant", content: result.text },
                  finish_reason: null,
                },
              ],
            })}\n\n`,
          );
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const route = failedProviderRoute(e, providers, requestedModel);
        res.write(
          `data: ${JSON.stringify({
            id,
            object: "chat.completion.chunk",
            choices: [
              {
                index: 0,
                delta: { content: `Error: ${msg}` },
                finish_reason: "stop",
              },
            ],
            error: msg,
          })}\n\n`,
        );
        res.write("data: [DONE]\n\n");
        res.end();
        await recordTurnUsage({
          valid: false,
          error: msg,
          providerId: route.providerId,
          modelID: route.modelID,
          source: "agent",
          requestId,
        }).catch(() => undefined);
        return;
      }

      const promptTotal = Math.max(
        usage.promptTokens,
        usage.cacheReadTokens + usage.cacheWriteTokens,
      );
      await recordTurnUsage({
        valid: true,
        requestTokens: promptTotal + usage.completionTokens,
        promptTokens: promptTotal,
        cacheReadTokens: usage.cacheReadTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
        providerId,
        modelID,
        source: "agent",
        requestId,
      });

      res.write(
        `data: ${JSON.stringify({
          id,
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: {
            prompt_tokens: usage.promptTokens,
            completion_tokens: usage.completionTokens,
            total_tokens: usage.promptTokens + usage.completionTokens,
          },
        })}\n\n`,
      );
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    const result = await runProviderChat(
      cfg.providers,
      userTexts,
      body.model,
      undefined,
      { globalContextWindowTokens: cfg.cursorIntegration.defaultContextWindowTokens },
    );
    const promptTotal = Math.max(
      result.usage.promptTokens,
      result.usage.cacheReadTokens + result.usage.cacheWriteTokens,
    );
    await recordTurnUsage({
      valid: true,
      requestTokens: promptTotal + result.usage.completionTokens,
      promptTokens: promptTotal,
      cacheReadTokens: result.usage.cacheReadTokens,
      cacheWriteTokens: result.usage.cacheWriteTokens,
      providerId: result.providerId,
      modelID: result.modelID,
      source: "agent",
      requestId,
    });

    writeJson(res, 200, {
      id: completionId,
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: result.text },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: result.usage.promptTokens,
        completion_tokens: result.usage.completionTokens,
        total_tokens:
          result.usage.promptTokens + result.usage.completionTokens,
      },
      model: result.modelID,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const route = failedProviderRoute(e, providers, requestedModel);
    await recordTurnUsage({
      valid: false,
      error: msg,
      providerId: route.providerId,
      modelID: route.modelID,
      source: "agent",
      requestId,
    }).catch(() => undefined);
    writeJson(res, 500, { error: msg });
  }
}
