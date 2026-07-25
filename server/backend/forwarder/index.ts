export {
  handleBidiAppend,
  handleRunSSE,
  streamEventToMessage,
} from "./service";
export {
  extractInbound,
  normalizeRequestId,
  parseBidiAppendInbound,
  parseRunSSEInbound,
  decodeBidiAppendRequestProto,
  decodeBidiRequestIdProto,
  decodeAgentClientMessageFromHex,
} from "./protocol";
export {
  buildAvailableModels,
  buildDefaultModelNudge,
  buildDashboardUsage,
  buildGetMe,
  buildPlanInfo,
  buildCursorUserProfile,
} from "./models";
export * from "./events";
export {
  appendHistory,
  appendHistoryMessage,
  appendAssistantWithTools,
  appendToolResult,
  historyAsChatMessages,
  loadHistory,
} from "./history";
export {
  registerPending,
  registerPendingInteraction,
  resolveClientExec,
  resolveClientInteraction,
  shouldUseClientBridge,
  bridgeKindForTool,
  buildExecServerMessage,
  buildInteractionQueryMessage,
  newExecId,
  newInteractionId,
  nextMessageId,
  defaultBridgeTimeoutMs,
} from "./client-bridge";
export {
  decodeAgentClientMessage,
  decodeAgentServerMessage,
  encodeAgentClientRun,
  encodeAgentClientExecResult,
  encodeAgentClientInteractionResponse,
  encodeAgentServerExec,
  encodeAgentServerInteractionQuery,
  encodeTextDelta,
  encodeHeartbeatUpdate,
  encodeThinkingDelta,
  encodeTurnEnded,
  encodeToolCallStarted,
  encodeToolCallCompleted,
  buildExecServerMessageJson,
  buildInteractionQueryJson,
  decodeMcpArgs,
  peekToolCall,
  modeNumberToName,
} from "./agent-proto";
export {
  encodeConnectFrame,
  encodeConnectJson,
  decodeConnectFrame,
  decodeConnectFrames,
  unwrapRequestBody,
  CONNECT_FLAG_END_STREAM,
} from "./connect-frame";
export {
  detectStreamWireMode,
  streamEventToProto,
  encodeConnectEndStream,
  createRunSseWriter,
} from "./stream-writer";
export {
  encodeVarint,
  decodeFields,
  encodeString,
  encodeStringValueMap,
  decodeStringValueMap,
  encodeProtoValue,
  decodeProtoValue,
} from "./protobuf-wire";
export {
  AGENT_TOOLS,
  EXECUTABLE_TOOLS,
  CLIENT_BRIDGE_TOOLS,
  INTERACTION_TOOLS,
  EXEC_BRIDGE_TOOLS,
  toolsForMode,
  normalizeAgentMode,
  toAnthropicTools,
  isInteractionTool,
  isExecBridgeTool,
  isClientBridgeTool,
} from "./tool-catalog";
export { executeTool, executeTools, executeCallMcpLocal, resolveWorkspaceRoot } from "./tool-exec";
