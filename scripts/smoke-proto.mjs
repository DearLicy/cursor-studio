/**
 * protobuf AgentClientMessage / ExecServerMessage 编解码冒烟（不依赖模型）。
 */
import {
  decodeAgentClientMessage,
  encodeAgentClientRun,
  encodeAgentClientExecResult,
  encodeAgentClientInteractionResponse,
  encodeAgentServerExec,
  buildExecServerMessageJson,
  decodeAgentServerMessage,
  decodeMcpArgs,
  modeNumberToName,
} from "../server/backend/forwarder/agent-proto.ts";
import {
  encodeStringValueMap,
  decodeStringValueMap,
  decodeFields,
  encodeProtoValue,
  decodeProtoValue,
  encodeString,
  encodeBytes,
  encodeMessage,
  encodeInt64,
  concatMessages,
} from "../server/backend/forwarder/protobuf-wire.ts";
import { extractInbound } from "../server/backend/forwarder/protocol.ts";
import {
  encodeConnectJson,
  encodeConnectFrame,
} from "../server/backend/forwarder/connect-frame.ts";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function main() {
  // run_request encode → decode
  const runBin = encodeAgentClientRun({
    text: "hello-proto-run",
    mode: 3, // plan
    conversationId: "conv-1",
    modelName: "gpt-4o-mini",
  });
  const runDec = decodeAgentClientMessage(runBin);
  assert(runDec.kind === "run_request", `kind=${runDec.kind}`);
  assert(runDec.texts.some((t) => t.includes("hello-proto-run")), "text missing");
  assert(modeNumberToName(runDec.mode) === "plan", `mode=${runDec.mode}`);
  console.log("run_request ok", {
    mode: runDec.mode,
    model: runDec.modelHint,
    texts: runDec.texts,
  });

  // BidiAppend JSON + hex(data)
  const bidi = {
    request_id: "rid-proto-1",
    data: runBin.toString("hex"),
  };
  const extracted = extractInbound(Buffer.from(JSON.stringify(bidi), "utf8"));
  assert(extracted.kind === "user_run", `extracted.kind=${extracted.kind}`);
  assert(
    extracted.texts.some((t) => t.includes("hello-proto-run")),
    "extracted text",
  );
  assert(extracted.mode === "plan", `extracted.mode=${extracted.mode}`);
  assert(extracted.protobufDecoded, "protobufDecoded");
  console.log("bidi hex data ok", {
    mode: extracted.mode,
    model: extracted.modelHint,
  });

  // Connect envelope wrapping bidi JSON
  const framed = encodeConnectJson(bidi);
  const fromFrame = extractInbound(framed);
  assert(fromFrame.texts.some((t) => t.includes("hello-proto-run")), "frame text");
  console.log("connect+json ok");

  // ★ Cursor 真机主路径：Connect + protobuf BidiAppendRequest
  // aiserver.v1.BidiAppendRequest { data=1 hex, request_id=2, append_seqno=3 }
  const rid = "44a91135-d0e1-4fdb-9210-b15650cc3a20";
  const bidiReqBin = concatMessages(
    encodeString(1, runBin.toString("hex")),
    encodeMessage(2, encodeString(1, rid)),
    encodeInt64(3, 1),
  );
  const bidiConnect = encodeConnectFrame(bidiReqBin, 0);
  const fromProtoBidi = extractInbound(bidiConnect);
  assert(fromProtoBidi.requestId === rid, `rid=${fromProtoBidi.requestId}`);
  assert(
    fromProtoBidi.texts.some((t) => t.includes("hello-proto-run")),
    `proto bidi texts=${JSON.stringify(fromProtoBidi.texts)}`,
  );
  assert(fromProtoBidi.protobufDecoded, "proto bidi decoded");
  assert(fromProtoBidi.kind === "user_run", `kind=${fromProtoBidi.kind}`);
  // 绝不能把 hex/乱码当用户文本
  assert(
    !fromProtoBidi.texts.some((t) => /^[0-9a-f]{16,}$/i.test(t)),
    "no hex garbage as user text",
  );
  console.log("connect+proto BidiAppendRequest ok", {
    rid: fromProtoBidi.requestId,
    texts: fromProtoBidi.texts,
    mode: fromProtoBidi.mode,
  });

  // Cursor image attachments live in UserMessage.selected_context.selected_images.
  const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const selectedImage = concatMessages(
    encodeBytes(8, imageBytes), // SelectedImage.data
    encodeString(3, "C:\\tmp\\cursor-image.png"),
    encodeString(7, "image/png"),
  );
  const selectedContext = encodeMessage(1, selectedImage); // selected_images
  const imageUserMessage = concatMessages(
    encodeString(1, "describe this image"),
    encodeMessage(3, selectedContext),
  );
  const imageAction = encodeMessage(1, encodeMessage(1, imageUserMessage));
  const imageRun = encodeMessage(
    1,
    concatMessages(encodeMessage(2, imageAction), encodeString(5, "conv-image")),
  );
  const imageInbound = extractInbound(
    Buffer.from(
      JSON.stringify({ request_id: "rid-image-1", data: imageRun.toString("hex") }),
      "utf8",
    ),
  );
  const imagePart = imageInbound.contentParts?.find((part) => part.type === "image");
  assert(imageInbound.kind === "user_run", `image kind=${imageInbound.kind}`);
  assert(imageInbound.hasImageAttachment, "image attachment marker missing");
  assert(imagePart, "selected image missing from inbound content parts");
  assert(imagePart.mimeType === "image/png", `image mime=${imagePart.mimeType}`);
  assert(imagePart.dataBase64 === imageBytes.toString("base64"), "image bytes changed");
  assert(imagePart.path === "C:\\tmp\\cursor-image.png", `image path=${imagePart.path}`);
  console.log("selected image content part ok", {
    mimeType: imagePart.mimeType,
    bytes: Buffer.from(imagePart.dataBase64, "base64").length,
  });

  // Cursor also sends selected images by blob reference with RunRequest.pre_fetched_blobs.
  const blobId = Buffer.from("cursor-image-blob");
  const blobSelectedImage = concatMessages(
    encodeBytes(1, blobId), // SelectedImage.blob_id
    encodeString(7, "image/png"),
  );
  const blobSelectedContext = encodeMessage(1, blobSelectedImage);
  const blobUserMessage = encodeMessage(3, blobSelectedContext);
  const blobAction = encodeMessage(1, encodeMessage(1, blobUserMessage));
  const preFetchedBlob = concatMessages(
    encodeBytes(1, blobId),
    encodeBytes(2, imageBytes),
  );
  const blobImageRun = encodeMessage(
    1,
    concatMessages(encodeMessage(2, blobAction), encodeMessage(17, preFetchedBlob)),
  );
  const blobInbound = extractInbound(
    Buffer.from(
      JSON.stringify({ request_id: "rid-image-blob", data: blobImageRun.toString("hex") }),
      "utf8",
    ),
  );
  const blobImagePart = blobInbound.contentParts?.find((part) => part.type === "image");
  assert(blobInbound.hasImageAttachment, "prefetched attachment marker missing");
  assert(blobImagePart, "prefetched blob image missing from inbound content parts");
  assert(blobImagePart.dataBase64 === imageBytes.toString("base64"), "prefetched image bytes changed");
  console.log("prefetched image content part ok");

  // RunSSE body: BidiRequestId only
  const ridOnly = encodeString(1, rid);
  const fromRid = extractInbound(encodeConnectFrame(ridOnly, 0));
  assert(fromRid.requestId === rid, `runsse rid=${fromRid.requestId}`);
  assert(fromRid.texts.length === 0, "runsse should not invent texts");
  console.log("connect+proto BidiRequestId ok");

  // exec result encode → decode（默认 Shell success oneof）
  const execBin = encodeAgentClientExecResult({
    messageId: 42,
    execId: "exec-42",
    resultText: "client-result-ok",
    toolName: "Shell",
    ok: true,
    args: { command: "echo hi" },
  });
  const execDec = decodeAgentClientMessage(execBin);
  assert(execDec.kind === "exec_client_message", `exec kind=${execDec.kind}`);
  assert(execDec.execId === "exec-42", `execId=${execDec.execId}`);
  assert(
    String(execDec.resultText || "").includes("client-result-ok"),
    "result text",
  );
  console.log("exec_client_message ok", {
    execId: execDec.execId,
    messageId: execDec.messageId,
  });

  // 按工具类型的 ExecClientMessage result oneof
  for (const t of [
    { toolName: "Read", text: "file-content", args: { path: "a.ts" } },
    { toolName: "Write", text: "wrote-ok", args: { path: "b.ts" } },
    { toolName: "CallMcpTool", text: "mcp-text", args: { server: "s", toolName: "t" } },
    { toolName: "Delete", text: "deleted", args: { path: "c.ts" } },
  ]) {
    const bin = encodeAgentClientExecResult({
      messageId: 50,
      execId: `e-${t.toolName}`,
      resultText: t.text,
      toolName: t.toolName,
      ok: true,
      args: t.args,
    });
    const dec = decodeAgentClientMessage(bin);
    assert(dec.kind === "exec_client_message", `${t.toolName} kind`);
    assert(dec.execId === `e-${t.toolName}`, `${t.toolName} execId`);
    assert(String(dec.resultText || "").includes(t.text), `${t.toolName} text`);
  }
  console.log("exec_client result oneof by tool ok");

  const execExtract = extractInbound(
    Buffer.from(
      JSON.stringify({
        request_id: "rid-exec-pb",
        data: execBin.toString("hex"),
      }),
      "utf8",
    ),
  );
  assert(execExtract.kind === "exec_result", `kind=${execExtract.kind}`);
  assert(execExtract.execResult?.execId === "exec-42", "execResult.execId");
  console.log("exec_result via hex ok");

  // ExecServerMessage json shape
  const readJson = buildExecServerMessageJson({
    messageId: 1,
    execId: "e1",
    toolName: "Read",
    toolCallId: "c1",
    args: { path: "/tmp/a.ts", offset: 1 },
  });
  assert(readJson.execServerMessage?.readArgs?.path === "/tmp/a.ts", "readArgs");
  const shellJson = buildExecServerMessageJson({
    messageId: 2,
    execId: "e2",
    toolName: "Shell",
    toolCallId: "c2",
    args: { command: "echo hi", block_until_ms: 0 },
  });
  assert(
    shellJson.execServerMessage?.shellStreamArgs?.command === "echo hi",
    "shellStreamArgs",
  );
  console.log("execServerMessage json ok");

  // binary exec server encode round-size
  const serverBin = encodeAgentServerExec({
    messageId: 9,
    execId: "e9",
    toolName: "Read",
    args: { path: "x.ts", toolCallId: "c9" },
  });
  assert(serverBin.length > 8, "server bin empty");
  console.log("execServerMessage binary ok", serverBin.length);

  // ── map<string, Value> / McpArgs.args 往返 ──
  const mapSrc = {
    s: "hello",
    n: 3.5,
    b: true,
    z: null,
    arr: [1, "x"],
    obj: { nested: "y" },
  };
  const mapBin = encodeStringValueMap(2, mapSrc);
  const mapBack = decodeStringValueMap(decodeFields(mapBin), 2);
  assert(mapBack.s === "hello", `map.s=${mapBack.s}`);
  assert(mapBack.n === 3.5, `map.n=${mapBack.n}`);
  assert(mapBack.b === true, `map.b=${mapBack.b}`);
  assert(mapBack.z === null, `map.z=${mapBack.z}`);
  assert(Array.isArray(mapBack.arr) && mapBack.arr[1] === "x", "map.arr");
  assert(
    mapBack.obj && typeof mapBack.obj === "object" && mapBack.obj.nested === "y",
    "map.obj",
  );
  assert(decodeProtoValue(encodeProtoValue("t")) === "t", "proto value str");
  assert(decodeProtoValue(encodeProtoValue(false)) === false, "proto value bool");
  console.log("string-value map roundtrip ok");

  const mcpBin = encodeAgentServerExec({
    messageId: 77,
    execId: "e-mcp-map",
    toolName: "CallMcpTool",
    args: {
      server: "demo",
      toolName: "search",
      toolCallId: "c-mcp-map",
      arguments: {
        query: "flag",
        limit: 2,
        deep: false,
        tags: ["a", "b"],
      },
    },
  });
  const mcpDec = decodeAgentServerMessage(mcpBin);
  assert(mcpDec.kind === "exec_server_message", `mcp kind=${mcpDec.kind}`);
  assert(mcpDec.execId === "e-mcp-map", `execId=${mcpDec.execId}`);
  assert(mcpDec.mcpArgs, "mcpArgs missing");
  assert(
    mcpDec.mcpArgs.providerIdentifier === "demo" ||
      mcpDec.mcpArgs.name?.includes("demo"),
    "server",
  );
  assert(mcpDec.mcpArgs.toolName === "search", `tool=${mcpDec.mcpArgs.toolName}`);
  assert(mcpDec.mcpArgs.args?.query === "flag", `args.query=${mcpDec.mcpArgs.args?.query}`);
  assert(mcpDec.mcpArgs.args?.limit === 2, `args.limit=${mcpDec.mcpArgs.args?.limit}`);
  assert(mcpDec.mcpArgs.args?.deep === false, `args.deep=${mcpDec.mcpArgs.args?.deep}`);
  assert(
    Array.isArray(mcpDec.mcpArgs.args?.tags) && mcpDec.mcpArgs.args.tags[0] === "a",
    "args.tags",
  );
  const mcpBody = (() => {
    const top = decodeFields(mcpBin);
    const exec = top.find((f) => f.field === 2 && f.bytes)?.bytes;
    assert(exec, "exec body");
    const ef = decodeFields(exec);
    const mcp = ef.find((f) => f.field === 11 && f.bytes)?.bytes;
    assert(mcp, "mcp body");
    return mcp;
  })();
  const direct = decodeMcpArgs(mcpBody);
  assert(direct.args.query === "flag", "direct decodeMcpArgs");
  console.log("McpArgs map encode/decode ok", {
    args: mcpDec.mcpArgs.args,
    tool: mcpDec.mcpArgs.toolName,
  });

  // ── InteractionResponse 客户端编码往返 ──
  const askBin = encodeAgentClientInteractionResponse({
    messageId: 88,
    toolName: "AskQuestion",
    ok: true,
    result: {
      answers: [
        {
          questionId: "q1",
          selectedOptionIds: ["a", "b"],
          freeformText: "note",
        },
      ],
    },
  });
  const askDec = decodeAgentClientMessage(askBin);
  assert(askDec.kind === "interaction_response", `ask kind=${askDec.kind}`);
  assert(askDec.messageId === 88, `ask mid=${askDec.messageId}`);
  assert(
    String(askDec.resultText || "").includes("q1") ||
      String(askDec.texts?.join(" ") || "").includes("q1"),
    "ask answer strings",
  );
  const askExtract = extractInbound(
    Buffer.from(
      JSON.stringify({
        request_id: "rid-ir-pb",
        data: askBin.toString("hex"),
      }),
      "utf8",
    ),
  );
  assert(askExtract.kind === "interaction_response", `askExtract=${askExtract.kind}`);
  assert(askExtract.interactionResult?.messageId === 88, "ir messageId");
  console.log("interaction_response AskQuestion ok");

  const switchBin = encodeAgentClientInteractionResponse({
    messageId: 89,
    toolName: "SwitchMode",
    ok: true,
  });
  assert(
    decodeAgentClientMessage(switchBin).kind === "interaction_response",
    "switch",
  );
  const planBin = encodeAgentClientInteractionResponse({
    messageId: 90,
    toolName: "CreatePlan",
    ok: true,
    result: { plan_uri: "file:///plan.md" },
  });
  const planDec = decodeAgentClientMessage(planBin);
  assert(planDec.kind === "interaction_response", "plan kind");
  assert(
    String(planDec.resultText || "").includes("plan.md") || planDec.messageId === 90,
    "plan uri",
  );
  const searchBin = encodeAgentClientInteractionResponse({
    messageId: 91,
    toolName: "WebSearch",
    ok: false,
    result: { reason: "denied" },
  });
  assert(
    decodeAgentClientMessage(searchBin).kind === "interaction_response",
    "websearch",
  );
  console.log("interaction_response variants ok");

  console.log("PASS smoke-proto");
}

main();
