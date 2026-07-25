/**
 * Connect 帧 + 客户端 exec/interaction bridge + protocol intent 确定性冒烟。
 */
import {
  encodeConnectJson,
  unwrapRequestBody,
  decodeConnectFrame,
} from "../server/backend/forwarder/connect-frame.ts";
import { extractInbound } from "../server/backend/forwarder/protocol.ts";
import {
  newExecId,
  newInteractionId,
  nextMessageId,
  registerPending,
  registerPendingInteraction,
  resolveClientExec,
  resolveClientInteraction,
  shouldUseClientBridge,
  bridgeKindForTool,
  buildInteractionQueryMessage,
  buildExecServerMessage,
  defaultBridgeTimeoutMs,
} from "../server/backend/forwarder/client-bridge.ts";
import {
  buildExecServerMessageJson,
  buildInteractionQueryJson,
  encodeAgentServerInteractionQuery,
  encodeAgentServerExec,
  decodeAgentServerMessage,
} from "../server/backend/forwarder/agent-proto.ts";
import {
  toolsForMode,
  isInteractionTool,
  isExecBridgeTool,
  INTERACTION_TOOLS,
  EXEC_BRIDGE_TOOLS,
} from "../server/backend/forwarder/tool-catalog.ts";
import { streamEventToMessage, streamEventToProto } from "../server/backend/forwarder/stream-writer.ts";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function main() {
  // Connect envelope
  const inner = { request_id: "rid-connect-1", text: "hello-connect" };
  const framed = encodeConnectJson(inner);
  const frame = decodeConnectFrame(framed);
  assert(frame && frame.payload.length > 0, "decodeConnectFrame failed");
  const unwrapped = unwrapRequestBody(framed);
  const again = extractInbound(unwrapped);
  assert(again.requestId === "rid-connect-1", `requestId=${again.requestId}`);
  assert(again.texts.some((t) => t.includes("hello-connect")), "text lost");
  console.log("connect frame ok");

  // 直接从 framed body 解析
  const fromFrame = extractInbound(framed);
  assert(fromFrame.requestId === "rid-connect-1", "framed requestId");
  console.log("protocol unwrap ok");

  // exec_result intent
  const execBody = Buffer.from(
    JSON.stringify({
      request_id: "rid-exec-1",
      kind: "exec_result",
      exec_id: "exec-9",
      tool_call_id: "call-9",
      result: "client-ok",
      ok: true,
    }),
    "utf8",
  );
  const ex = extractInbound(execBody);
  assert(ex.kind === "exec_result", `kind=${ex.kind}`);
  assert(ex.execResult?.result === "client-ok", "exec result missing");
  console.log("exec_result intent ok");

  // interaction_response intent
  const irBody = Buffer.from(
    JSON.stringify({
      request_id: "rid-ir-1",
      kind: "interaction_response",
      interaction_id: "42",
      messageId: 42,
      tool_call_id: "call-ask",
      result: JSON.stringify({ answers: [{ id: "q1", selected: ["a"] }] }),
      ok: true,
    }),
    "utf8",
  );
  const ir = extractInbound(irBody);
  assert(ir.kind === "interaction_response", `ir.kind=${ir.kind}`);
  assert(ir.interactionResult?.result.includes("answers"), "ir result");
  console.log("interaction_response intent ok");

  // catalog: bridge tools present by mode
  const agentTools = toolsForMode("agent").map((t) => t.function.name);
  for (const n of ["AskQuestion", "CallMcpTool", "Task", "SwitchMode", "CreatePlan", "WebSearch"]) {
    assert(agentTools.includes(n), `agent missing ${n}`);
  }
  const planTools = toolsForMode("plan").map((t) => t.function.name);
  assert(planTools.includes("CreatePlan"), "plan CreatePlan");
  assert(planTools.includes("AskQuestion"), "plan AskQuestion");
  assert(!planTools.includes("Task"), "plan should not expose Task");
  assert(isInteractionTool("AskQuestion"), "AskQuestion interaction");
  assert(isExecBridgeTool("CallMcpTool"), "CallMcpTool exec bridge");
  assert(bridgeKindForTool("AskQuestion") === "interaction", "bridge kind ask");
  assert(bridgeKindForTool("CallMcpTool") === "exec", "bridge kind mcp");
  assert(shouldUseClientBridge("Task"), "Task should bridge");
  console.log("catalog/mode ok", {
    agent: agentTools.length,
    interaction: INTERACTION_TOOLS.size,
    execBridge: EXEC_BRIDGE_TOOLS.size,
  });

  // exec bridge wait/resolve
  const rid = "rid-bridge-1";
  const execId = newExecId("call-bridge");
  const pending = {
    kind: "exec",
    execId,
    messageId: 1,
    toolCallId: "call-bridge",
    name: "CallMcpTool",
    argsJson: JSON.stringify({ server: "demo", toolName: "search", arguments: {} }),
    createdAt: Date.now(),
  };
  assert(shouldUseClientBridge("CallMcpTool"), "CallMcpTool should bridge");
  const p = registerPending(rid, pending, 5000);
  setTimeout(() => {
    const hit = resolveClientExec(rid, {
      execId,
      result: "mcp-from-client",
      ok: true,
    });
    assert(hit, "resolve should hit");
  }, 30);
  const r = await p;
  assert(r.result === "mcp-from-client", `bridge result=${r.result}`);
  console.log("exec client bridge ok");

  // interaction bridge wait/resolve
  const rid2 = "rid-bridge-2";
  const mid = nextMessageId();
  const iid = newInteractionId(mid);
  const ipending = {
    kind: "interaction",
    interactionId: iid,
    messageId: mid,
    toolCallId: "call-ask-1",
    name: "AskQuestion",
    argsJson: JSON.stringify({
      questions: [
        {
          id: "q1",
          prompt: "Pick",
          options: [
            { id: "a", label: "A" },
            { id: "b", label: "B" },
          ],
        },
      ],
    }),
    createdAt: Date.now(),
    interactionKind: "ask_question",
  };
  const ip = registerPendingInteraction(rid2, ipending, 5000);
  setTimeout(() => {
    const hit = resolveClientInteraction(rid2, {
      interactionId: iid,
      result: "selected:a",
      ok: true,
    });
    assert(hit, "interaction resolve should hit");
  }, 30);
  const ir2 = await ip;
  assert(ir2.result === "selected:a", `interaction result=${ir2.result}`);
  console.log("interaction bridge ok");

  // JSON shapes
  const askJson = buildInteractionQueryJson({
    messageId: 7,
    toolCallId: "c-ask",
    toolName: "AskQuestion",
    args: {
      title: "T",
      questions: [
        {
          id: "q1",
          prompt: "P",
          options: [
            { id: "a", label: "A" },
            { id: "b", label: "B" },
          ],
        },
      ],
    },
  });
  assert(
    askJson.interactionQuery?.askQuestionInteractionQuery?.toolCallId === "c-ask",
    "ask json shape",
  );
  const mcpJson = buildExecServerMessageJson({
    messageId: 8,
    execId: "e-mcp",
    toolName: "CallMcpTool",
    toolCallId: "c-mcp",
    args: { server: "s1", toolName: "t1", arguments: { x: 1 } },
  });
  assert(mcpJson.execServerMessage?.mcpArgs?.toolName === "t1", "mcp json");
  const taskJson = buildExecServerMessageJson({
    messageId: 9,
    execId: "e-task",
    toolName: "Task",
    toolCallId: "c-task",
    args: { description: "explore", prompt: "find X", subagent_type: "explore" },
  });
  assert(taskJson.execServerMessage?.subagentArgs?.prompt === "find X", "task json");
  console.log("json shapes ok");

  // binary InteractionQuery / MCP exec
  const askBin = encodeAgentServerInteractionQuery({
    messageId: 11,
    toolCallId: "c11",
    toolName: "AskQuestion",
    args: {
      questions: [
        {
          id: "q1",
          prompt: "Hi",
          options: [
            { id: "a", label: "A" },
            { id: "b", label: "B" },
          ],
        },
      ],
    },
  });
  assert(askBin.length > 8, "ask bin");
  // AgentServerMessage.interaction_query = field 7 (key = 7<<3|2 = 0x3a)
  assert(askBin[0] === 0x3a, `ask field key=${askBin[0]}`);

  const mcpBin = encodeAgentServerExec({
    messageId: 12,
    execId: "e12",
    toolName: "CallMcpTool",
    args: {
      server: "srv",
      toolName: "tool",
      toolCallId: "c12",
      arguments: { q: "x", n: 1 },
    },
  });
  assert(mcpBin.length > 8, "mcp bin");
  const mcpDec = decodeAgentServerMessage(mcpBin);
  assert(mcpDec.kind === "exec_server_message", `mcpDec=${mcpDec.kind}`);
  assert(mcpDec.mcpArgs?.toolName === "tool", `mcp tool=${mcpDec.mcpArgs?.toolName}`);
  assert(mcpDec.mcpArgs?.args?.q === "x", `mcp map q=${mcpDec.mcpArgs?.args?.q}`);
  assert(mcpDec.mcpArgs?.args?.n === 1, `mcp map n=${mcpDec.mcpArgs?.args?.n}`);
  console.log("binary query/exec ok", {
    ask: askBin.length,
    mcp: mcpBin.length,
    mcpArgs: mcpDec.mcpArgs?.args,
  });

  // stream event mapping
  const iqEv = {
    type: "interaction_query",
    interactionId: "3",
    callId: "c3",
    name: "AskQuestion",
    messageId: 3,
    args: { questions: [] },
  };
  const iqMsg = streamEventToMessage(iqEv);
  assert(iqMsg?.interactionQuery, "stream json interactionQuery");
  const iqProto = streamEventToProto(iqEv);
  assert(iqProto && iqProto.length > 4, "stream proto interactionQuery");

  const mcpEv = {
    type: "exec_request",
    execId: "e4",
    callId: "c4",
    name: "CallMcpTool",
    messageId: 4,
    args: { server: "s", toolName: "t" },
  };
  const mcpMsg = streamEventToMessage(mcpEv);
  assert(mcpMsg?.execServerMessage?.mcpArgs, "stream json mcpArgs");
  console.log("stream event mapping ok");

  // pending message builders
  const built = buildInteractionQueryMessage(ipending);
  assert(built.interactionQuery, "buildInteractionQueryMessage");
  const builtExec = buildExecServerMessage(pending);
  assert(builtExec.execServerMessage?.mcpArgs, "buildExecServerMessage mcp");
  assert(defaultBridgeTimeoutMs("AskQuestion") >= 300_000, "ask timeout");
  assert(defaultBridgeTimeoutMs("Task") >= 600_000, "task timeout");
  console.log("builders/timeouts ok");

  console.log("PASS smoke-bridge");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});