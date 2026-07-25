/**
 * Stage 0 protocol fixture regression.
 * Loads fixtures/protocol/manifest.json and validates each case.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildAvailableModels } from "../server/backend/forwarder/models.ts";
import { extractInbound } from "../server/backend/forwarder/protocol.ts";
import {
  encodeAgentClientRun,
} from "../server/backend/forwarder/agent-proto.ts";
import {
  encodeConnectJson,
  encodeConnectFrame,
  decodeConnectFrames,
} from "../server/backend/forwarder/connect-frame.ts";
import {
  encodeString,
  encodeMessage,
  decodeFields,
} from "../server/backend/forwarder/protobuf-wire.ts";
import {
  encodeTextDelta,
  decodeAgentServerMessage,
  encodeTurnEnded,
} from "../server/backend/forwarder/agent-proto.ts";
import { streamEventToProto } from "../server/backend/forwarder/stream-writer.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const fixtureDir = path.join(root, "fixtures", "protocol");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function readJson(name) {
  const p = path.join(fixtureDir, name);
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function runAvailableModels(caseDef) {
  const input = readJson(caseDef.input);
  const expect = readJson(caseDef.expect);
  const payload = buildAvailableModels(input.providers);
  assert(Array.isArray(payload.modelNames), "modelNames array");
  assert(
    payload.modelNames.length >= (expect.minModelCount || 0),
    `minModelCount got ${payload.modelNames.length}`,
  );
  const joined = payload.modelNames.join("\n");
  for (const sub of expect.mustIncludeModelSubstrings || []) {
    assert(joined.includes(sub), `missing model substring: ${sub}`);
  }
  for (const sub of expect.mustExcludeModelSubstrings || []) {
    assert(!joined.includes(sub), `excluded model present: ${sub}`);
  }
  if (expect.defaultModelMustInclude) {
    assert(
      String(payload.composerModelConfig?.defaultModel || "").includes(
        expect.defaultModelMustInclude,
      ) ||
        payload.modelNames.some((n) =>
          n.includes(expect.defaultModelMustInclude),
        ),
      "default model missing",
    );
  }
  const goldenPath = path.join(fixtureDir, "available-models.golden.json");
  if (fs.existsSync(goldenPath)) {
    const golden = JSON.parse(fs.readFileSync(goldenPath, "utf8"));
    assert(
      JSON.stringify(payload.modelNames) === JSON.stringify(golden.modelNames),
      "golden modelNames drift",
    );
    assert(
      String(payload.composerModelConfig?.defaultModel || "") ===
        String(golden.defaultModel || ""),
      "golden defaultModel drift",
    );
    console.log("golden snapshot ok");
  }
  console.log("ok available_models", {
    count: payload.modelNames.length,
    names: payload.modelNames,
  });
}

function runExtractInbound(caseDef) {
  const input = readJson(caseDef.input);
  const expect = readJson(caseDef.expect);

  // Path A: plain JSON bidi-like body
  const raw = Buffer.from(JSON.stringify(input), "utf8");
  const extracted = extractInbound(raw);
  console.log("extractInbound plain", {
    kind: extracted.kind,
    requestId: extracted.requestId,
    texts: extracted.texts,
  });

  // Path B: hex-wrapped AgentClientRun (Cursor-like)
  const runBin = encodeAgentClientRun({
    text: "hello-fixture-run",
    mode: 1,
    conversationId: "conv-fixture",
    modelName: "gpt-4o-mini",
  });
  const bidi = {
    request_id: input.request_id || "fixture-rid-001",
    data: runBin.toString("hex"),
  };
  const extractedHex = extractInbound(Buffer.from(JSON.stringify(bidi), "utf8"));
  assert(
    extractedHex.texts?.some((t) => t.includes("hello-fixture-run")),
    "hex path text missing",
  );

  // Path C: connect+json envelope
  const framed = encodeConnectJson(bidi);
  const fromFrame = extractInbound(framed);
  assert(
    fromFrame.texts?.some((t) => t.includes("hello-fixture-run")),
    "connect+json text missing",
  );

  if (expect.mustHaveRequestIdSubstring) {
    const rid = String(
      extractedHex.requestId || extracted.requestId || bidi.request_id || "",
    );
    assert(
      rid.includes(expect.mustHaveRequestIdSubstring),
      `requestId missing ${expect.mustHaveRequestIdSubstring}`,
    );
  }
  console.log("ok extract_inbound");
}

function runStaticJson(caseDef) {
  const input = readJson(caseDef.input);
  const expect = readJson(caseDef.expect);
  assert(
    JSON.stringify(input) === JSON.stringify(expect),
    `static fixture drift: ${caseDef.id}`,
  );

  if (caseDef.id === "openai-chat-stream-events") {
    // Ensure stream event names can be encoded when present in writer
    for (const ev of input.events || []) {
      if (ev.type === "text_delta") {
        const bin = encodeTextDelta(ev.text || "");
        const dec = decodeAgentServerMessage(bin);
        assert(dec.kind === "text_delta", `text_delta kind=${dec.kind}`);
      }
      if (ev.type === "turn_ended") {
        const bin = encodeTurnEnded(ev.usage || {});
        const dec = decodeAgentServerMessage(bin);
        assert(dec.kind === "turn_ended", `turn_ended kind=${dec.kind}`);
      }
    }
    // Connect framing sanity
    const frame = encodeConnectFrame(encodeTextDelta("x"));
    const frames = decodeConnectFrames(frame);
    assert(frames.frames.length >= 1, "connect frame empty");
  }

  if (caseDef.id === "connect-paths") {
    assert(input.streamCore.includes("BidiAppend"), "BidiAppend inventory");
    assert(input.unaryOrMock.includes("AvailableModels"), "AvailableModels inventory");
    assert(input.httpCompat.includes("/v1/chat/completions"), "chat path");
  }

  if (caseDef.id === "error-mapping") {
    assert(Array.isArray(input.map) && input.map.length >= 5, "error map size");
    const codes = new Set(input.map.map((m) => m.code));
    assert(codes.has("UPSTREAM_UNAUTHORIZED"), "401 mapping");
    assert(codes.has("PROVIDER_COOLDOWN"), "cooldown mapping");
  }

  // wire smoke for protobuf primitives used by ServerTime etc.
  if (caseDef.id === "connect-paths") {
    const msg = encodeMessage(1, encodeString(1, "fixture"));
    const fields = decodeFields(msg);
    assert(fields.length >= 1, "proto fields");
  }

  console.log("ok static_json", caseDef.id);
}

async function main() {
  const manifest = readJson("manifest.json");
  assert(manifest.cases?.length, "manifest.cases empty");
  let passed = 0;
  for (const c of manifest.cases) {
    if (c.kind === "available_models") runAvailableModels(c);
    else if (c.kind === "extract_inbound") runExtractInbound(c);
    else if (c.kind === "static_json") runStaticJson(c);
    else throw new Error(`unknown kind ${c.kind}`);
    passed += 1;
  }

  // streamEventToProto optional sanity if exported shape allows
  try {
    const proto = streamEventToProto?.({ type: "text_delta", text: "a" });
    if (proto) console.log("streamEventToProto optional ok", typeof proto);
  } catch {
    // optional
  }

  console.log(`\nsmoke-protocol-fixtures: ${passed}/${manifest.cases.length} passed`);
}

main().catch((err) => {
  console.error("FAIL", err);
  process.exit(1);
});
