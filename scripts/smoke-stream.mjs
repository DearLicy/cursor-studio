/**
 * RunSSE 二进制 Connect 流编解码冒烟（不依赖模型 / 服务进程）。
 */
import {
  decodeAgentServerMessage,
  encodeTextDelta,
  encodeThinkingDelta,
  encodeThinkingCompleted,
  encodeToolCallStarted,
  encodeToolCallCompleted,
  encodeTurnEnded,
  encodeHeartbeatUpdate,
  encodeTokenDelta,
  encodeAgentServerExec,
  encodeConversationCheckpoint,
} from "../server/backend/forwarder/agent-proto.ts";
import {
  CONNECT_FLAG_END_STREAM,
  decodeConnectFrames,
  encodeConnectFrame,
} from "../server/backend/forwarder/connect-frame.ts";
import {
  encodeConnectEndStream,
  streamEventToProto,
  streamEventToMessage,
} from "../server/backend/forwarder/stream-writer.ts";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function main() {
  // 1) 单事件 protobuf round-trip
  const samples = [
    { name: "text", bin: encodeTextDelta("hello-binary"), expect: "text_delta" },
    {
      name: "thinking",
      bin: encodeThinkingDelta("reason…"),
      expect: "thinking_delta",
    },
    {
      name: "thinking_done",
      bin: encodeThinkingCompleted(120),
      expect: "thinking_completed",
    },
    {
      name: "hb",
      bin: encodeHeartbeatUpdate(),
      expect: "heartbeat",
    },
    {
      name: "token",
      bin: encodeTokenDelta(42),
      expect: "token_delta",
    },
    {
      name: "checkpoint",
      bin: encodeConversationCheckpoint({ usedTokens: 123_456, maxTokens: 500_000 }),
      expect: "conversation_checkpoint",
    },
    {
      name: "turn",
      bin: encodeTurnEnded({
        inputTokens: 10,
        outputTokens: 20,
        cacheReadTokens: 1,
        cacheWriteTokens: 2,
      }),
      expect: "turn_ended",
    },
    {
      name: "tool_start",
      bin: encodeToolCallStarted({
        callId: "c1",
        name: "Read",
        args: { path: "a.ts" },
      }),
      expect: "tool_call_started",
    },
    {
      name: "tool_done",
      bin: encodeToolCallCompleted({
        callId: "c1",
        name: "Read",
        result: "file-body",
        ok: true,
        args: { path: "a.ts" },
      }),
      expect: "tool_call_completed",
    },
    {
      name: "exec",
      bin: encodeAgentServerExec({
        messageId: 3,
        execId: "e3",
        toolName: "Shell",
        args: { command: "echo x", toolCallId: "c3" },
      }),
      expect: "exec_server_message",
    },
  ];

  for (const s of samples) {
    assert(s.bin.length > 0, `${s.name} empty bin`);
    const dec = decodeAgentServerMessage(s.bin);
    assert(dec.kind === s.expect, `${s.name}: kind=${dec.kind} want=${s.expect}`);
    console.log("proto", s.name, "ok", { len: s.bin.length, kind: dec.kind });
  }

  const turnDec = decodeAgentServerMessage(samples.find((x) => x.name === "turn").bin);
  assert(turnDec.inputTokens === 10, `inputTokens=${turnDec.inputTokens}`);
  assert(turnDec.outputTokens === 20, `outputTokens=${turnDec.outputTokens}`);
  console.log("turn_ended tokens ok");

  const checkpointDec = decodeAgentServerMessage(
    samples.find((x) => x.name === "checkpoint").bin,
  );
  assert(checkpointDec.usedTokens === 123_456, `usedTokens=${checkpointDec.usedTokens}`);
  assert(checkpointDec.maxTokens === 500_000, `maxTokens=${checkpointDec.maxTokens}`);
  console.log("conversation checkpoint tokens ok");

  // tool_completed result oneof
  const doneDec = decodeAgentServerMessage(
    samples.find((x) => x.name === "tool_done").bin,
  );
  assert(doneDec.toolCall?.hasResult, "tool done hasResult");
  assert(doneDec.toolCall?.resultOk === true, `resultOk=${doneDec.toolCall?.resultOk}`);
  assert(
    String(doneDec.toolCall?.resultText || doneDec.text || "").includes("file-body"),
    "result text body",
  );
  assert(
    doneDec.toolCall?.toolField === 8 /* read_tool_call */,
    `toolField=${doneDec.toolCall?.toolField}`,
  );
  console.log("tool_completed result oneof ok", doneDec.toolCall);

  // 多工具 result oneof 形状
  const resultCases = [
    {
      name: "Shell",
      result: "stdout-ok",
      toolField: 1,
    },
    {
      name: "Write",
      result: "wrote",
      args: { path: "w.ts" },
      toolField: 12,
    },
    {
      name: "CallMcpTool",
      result: "mcp-out",
      args: { server: "s", toolName: "t" },
      toolField: 15,
    },
    {
      name: "WebFetch",
      result: "md-body",
      args: { url: "https://x" },
      toolField: 37,
    },
  ];
  for (const c of resultCases) {
    const bin = encodeToolCallCompleted({
      callId: `c-${c.name}`,
      name: c.name,
      result: c.result,
      ok: true,
      args: c.args || {},
    });
    const dec = decodeAgentServerMessage(bin);
    assert(dec.kind === "tool_call_completed", `${c.name} kind`);
    assert(dec.toolCall?.hasResult, `${c.name} hasResult`);
    assert(dec.toolCall?.resultOk === true, `${c.name} resultOk`);
    assert(dec.toolCall?.toolField === c.toolField, `${c.name} field=${dec.toolCall?.toolField}`);
    assert(
      String(dec.toolCall?.resultText || dec.text || "").includes(c.result),
      `${c.name} text`,
    );
  }
  // error oneof
  const errBin = encodeToolCallCompleted({
    callId: "c-err",
    name: "Read",
    result: "no such file",
    ok: false,
    args: { path: "missing.ts" },
  });
  const errDec = decodeAgentServerMessage(errBin);
  assert(errDec.toolCall?.hasResult, "err hasResult");
  assert(errDec.toolCall?.resultOk === false, `err ok=${errDec.toolCall?.resultOk}`);
  console.log("multi-tool result oneof ok");

  // 2) StreamEvent → proto
  const evs = [
    { type: "text", text: "hi" },
    { type: "thinking", text: "t" },
    { type: "checkpoint", usedTokens: 1_234, maxTokens: 500_000 },
    { type: "tool_started", callId: "x", name: "Shell", args: { command: "ls" } },
    {
      type: "tool_completed",
      callId: "x",
      name: "Shell",
      result: "out",
      ok: true,
    },
    {
      type: "turn_ended",
      inputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
    { type: "heartbeat" },
  ];
  for (const ev of evs) {
    const p = streamEventToProto(ev);
    assert(p && p.length > 0, `streamEventToProto ${ev.type}`);
    const j = streamEventToMessage(ev);
    assert(j, `streamEventToMessage ${ev.type}`);
  }
  const checkpointJson = streamEventToMessage({
    type: "checkpoint",
    usedTokens: 1_234,
    maxTokens: 500_000,
  });
  assert(
    checkpointJson?.conversationCheckpointUpdate?.tokenDetails?.maxTokens === 500_000,
    "checkpoint JSON maxTokens",
  );
  console.log("streamEvent mapping ok", evs.length);

  // 3) 拼一条 Connect 二进制流：text + tool + turn + end
  const frames = [
    encodeConnectFrame(encodeTextDelta("chunk-1"), 0),
    encodeConnectFrame(
      encodeToolCallStarted({
        callId: "call-9",
        name: "Read",
        args: { path: "z.ts" },
      }),
      0,
    ),
    encodeConnectFrame(
      encodeTurnEnded({
        inputTokens: 5,
        outputTokens: 6,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
      0,
    ),
    encodeConnectEndStream(),
  ];
  const stream = Buffer.concat(frames);
  const { frames: decoded, rest } = decodeConnectFrames(stream);
  assert(rest.length === 0, `rest=${rest.length}`);
  assert(decoded.length === 4, `frames=${decoded.length}`);
  assert(!decoded[0].endStream, "frame0 not end");
  assert(decoded[3].endStream, "last is end-stream");
  assert((decoded[3].flags & CONNECT_FLAG_END_STREAM) !== 0, "flag end");
  assert(decoded[3].payload.toString("utf8") === "{}", "end body");

  const d0 = decodeAgentServerMessage(decoded[0].payload);
  assert(d0.kind === "text_delta" && d0.text === "chunk-1", "frame0 text");
  const d1 = decodeAgentServerMessage(decoded[1].payload);
  assert(d1.kind === "tool_call_started" && d1.callId === "call-9", "frame1 tool");
  const d2 = decodeAgentServerMessage(decoded[2].payload);
  assert(d2.kind === "turn_ended" && d2.outputTokens === 6, "frame2 turn");
  console.log("connect stream sequence ok", {
    totalBytes: stream.length,
    frames: decoded.length,
  });

  // 4) end-stream with error trailer
  const errEnd = encodeConnectEndStream({
    code: "internal",
    message: "boom",
  });
  const errFrame = decodeConnectFrames(errEnd).frames[0];
  assert(errFrame.endStream, "err end");
  const trailer = JSON.parse(errFrame.payload.toString("utf8"));
  assert(trailer.error?.message === "boom", "err trailer");
  console.log("end-stream error trailer ok");

  console.log("PASS smoke-stream");
}

main();
