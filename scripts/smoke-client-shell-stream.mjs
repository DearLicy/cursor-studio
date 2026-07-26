/** Verify Cursor ShellStream terminal events and transport recovery. */
import assert from "node:assert/strict";
import {
  appendClientShellStream,
  closeClientShellStream,
  observeClientBackgroundShell,
  registerPending,
} from "../server/backend/forwarder/client-bridge.ts";
import { decodeAgentClientMessage } from "../server/backend/forwarder/agent-proto.ts";
import { extractInbound } from "../server/backend/forwarder/protocol.ts";
import {
  concatMessages,
  encodeMessage,
  encodeString,
  encodeUint32,
  encodeVarintFieldForce,
} from "../server/backend/forwarder/protobuf-wire.ts";

function shellStream(id, execId, event) {
  let body;
  if (event.type === "stdout") {
    body = encodeMessage(1, encodeString(1, event.data));
  } else if (event.type === "stderr") {
    body = encodeMessage(2, encodeString(1, event.data));
  } else {
    body = encodeMessage(
      3,
      concatMessages(
        encodeVarintFieldForce(1, event.code),
        encodeString(2, event.cwd || ""),
        event.aborted ? encodeUint32(4, 1) : Buffer.alloc(0),
      ),
    );
  }
  return encodeMessage(
    2,
    concatMessages(encodeUint32(1, id), encodeMessage(14, body), encodeString(15, execId)),
  );
}

function streamClose(id) {
  return encodeMessage(5, encodeMessage(1, encodeUint32(1, id)));
}

function backgroundSpawn(id, execId, shellId) {
  const success = concatMessages(
    encodeUint32(1, shellId),
    encodeString(2, "background-command"),
    encodeString(3, "C:\\workspace"),
    encodeUint32(4, 4321),
  );
  return encodeMessage(
    2,
    concatMessages(
      encodeUint32(1, id),
      encodeMessage(16, encodeMessage(1, success)),
      encodeString(15, execId),
    ),
  );
}

function inbound(requestId, data) {
  return extractInbound(
    Buffer.from(JSON.stringify({ request_id: requestId, data: data.toString("hex") })),
  );
}

async function main() {
  const requestId = "rid-client-shell-stream";
  const execId = "exec-client-shell-stream";
  const messageId = 73;
  const pending = registerPending(requestId, {
    kind: "exec",
    execId,
    messageId,
    toolCallId: "call-client-shell-stream",
    name: "Shell",
    argsJson: "{}",
    createdAt: Date.now(),
  }, 5_000);
  let settled = false;
  void pending.then(() => { settled = true; });

  const stdout = inbound(requestId, shellStream(messageId, execId, {
    type: "stdout",
    data: "stdout-1\n",
  }));
  assert.equal(stdout.kind, "exec_result");
  assert.equal(stdout.execResult?.shellStream?.stdout, "stdout-1\n");
  assert.equal(stdout.execResult?.messageId, messageId);
  assert.equal(appendClientShellStream(requestId, {
    execId: stdout.execResult?.execId,
    messageId: stdout.execResult?.messageId,
    ...stdout.execResult?.shellStream,
  }), true);

  const stderrPayload = shellStream(messageId, execId, {
    type: "stderr",
    data: "stderr-1\n",
  });
  const decodedStderr = decodeAgentClientMessage(stderrPayload);
  assert.equal(decodedStderr.shellStream?.stderr, "stderr-1\n");
  const stderr = inbound(requestId, stderrPayload);
  assert.equal(appendClientShellStream(requestId, {
    execId: stderr.execResult?.execId,
    messageId: stderr.execResult?.messageId,
    ...stderr.execResult?.shellStream,
  }), true);

  const exit = inbound(requestId, shellStream(messageId, execId, {
    type: "exit",
    code: 0,
    cwd: "C:\\workspace",
  }));
  assert.equal(exit.execResult?.shellStream?.exitCode, 0);
  assert.equal(appendClientShellStream(requestId, {
    execId: exit.execResult?.execId,
    messageId: exit.execResult?.messageId,
    ...exit.execResult?.shellStream,
  }), true);
  const result = await pending;
  settled = true;
  assert.equal(result.ok, true);
  assert.match(result.result, /stdout-1/);
  assert.match(result.result, /stderr-1/);
  assert.equal(settled, true, "Shell exit is terminal without waiting for stream_close");

  const close = inbound(requestId, streamClose(messageId));
  assert.equal(close.kind, "exec_control");
  assert.equal(close.execControl?.kind, "stream_close");
  assert.equal(closeClientShellStream(requestId, {
    messageId: close.execControl?.messageId,
  }), false, "late stream_close does not settle an already terminal shell");
  console.log("client ShellStream exit lifecycle ok", { messageId, result: result.result });

  const recoveryRequestId = "rid-client-shell-recovery";
  const recoveryMessageId = 74;
  const recovery = registerPending(recoveryRequestId, {
    kind: "exec",
    execId: "exec-client-shell-recovery",
    messageId: recoveryMessageId,
    toolCallId: "call-client-shell-recovery",
    name: "Shell",
    argsJson: "{}",
    createdAt: Date.now(),
  }, 5_000);
  assert.equal(appendClientShellStream(recoveryRequestId, {
    execId: "exec-client-shell-recovery",
    messageId: recoveryMessageId,
    event: "stdout",
    stdout: "partial-output\n",
  }), true);
  const recoveryStartedAt = Date.now();
  assert.equal(closeClientShellStream(recoveryRequestId, {
    messageId: recoveryMessageId,
  }), true);
  const recovered = await recovery;
  assert.ok(Date.now() - recoveryStartedAt >= 1_400, "stream_close uses the 1.5s grace window");
  assert.match(recovered.result, /partial-output/);
  assert.match(recovered.result, /shell-incomplete/);

  const backgroundRequestId = "rid-client-shell-background";
  const backgroundMessageId = 75;
  const backgroundExecId = "exec-client-shell-background";
  const background = registerPending(backgroundRequestId, {
    kind: "exec",
    execId: backgroundExecId,
    messageId: backgroundMessageId,
    toolCallId: "call-client-shell-background",
    name: "Shell",
    argsJson: "{}",
    createdAt: Date.now(),
  }, 5_000);
  assert.equal(appendClientShellStream(backgroundRequestId, {
    execId: backgroundExecId,
    messageId: backgroundMessageId,
    event: "backgrounded",
    shellId: "991",
    command: "long-running-command",
  }), true);
  assert.match((await background).result, /backgrounded: 991/);
  assert.equal(appendClientShellStream(backgroundRequestId, {
    execId: backgroundExecId,
    messageId: backgroundMessageId,
    event: "stdout",
    stdout: "late-background-output\n",
  }), true, "late background stdout remains consumable");
  assert.equal(appendClientShellStream(backgroundRequestId, {
    execId: backgroundExecId,
    messageId: backgroundMessageId,
    event: "exit",
    exitCode: 0,
  }), true, "late background exit remains consumable");

  const spawnRequestId = "rid-client-background-spawn";
  const spawnMessageId = 76;
  const spawnExecId = "exec-client-background-spawn";
  const spawnPending = registerPending(spawnRequestId, {
    kind: "exec",
    execId: spawnExecId,
    messageId: spawnMessageId,
    toolCallId: "call-client-background-spawn",
    name: "Shell",
    argsJson: "{}",
    createdAt: Date.now(),
  }, 5_000);
  const spawnInbound = inbound(
    spawnRequestId,
    backgroundSpawn(spawnMessageId, spawnExecId, 992),
  );
  assert.equal(spawnInbound.execResult?.backgroundShell?.status, "backgrounded");
  assert.equal(spawnInbound.execResult?.backgroundShell?.shellId, "992");
  assert.equal(spawnInbound.execResult?.backgroundShell?.command, "background-command");
  assert.equal(spawnInbound.execResult?.backgroundShell?.workingDirectory, "C:\\workspace");
  assert.equal(observeClientBackgroundShell(
    spawnRequestId,
    { execId: spawnExecId, messageId: spawnMessageId },
    spawnInbound.execResult.backgroundShell,
  ), true);
  assert.match((await spawnPending).result, /id=992/);
  console.log("shell recovery and background lifecycle ok");

  const unsupported = inbound("rid-unsupported-agent", encodeMessage(99, Buffer.alloc(0)));
  assert.equal(unsupported.kind, "unknown");
  assert.equal(unsupported.hasDataField, true);
  assert.equal(unsupported.protobufDecoded, true);
  console.log("unsupported AgentClientMessage preserved for invalid_argument");
  console.log("PASS smoke-client-shell-stream");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
