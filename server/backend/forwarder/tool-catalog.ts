/**
 * 本地协议实现。
 * 本地可执行集 + 客户端桥工具（AskQuestion / Task / MCP / SwitchMode…）。
 */

export type ToolDefinition = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type AgentMode = "agent" | "ask" | "plan" | "debug" | "multitask";

/** 当前支持本地执行的工具名 */
export const EXECUTABLE_TOOLS = new Set([
  "Read",
  "ReadLints",
  "Write",
  "PatchEdit",
  "Delete",
  "Glob",
  "Grep",
  "Ls",
  "Shell",
  "AwaitShell",
  "WriteShellStdin",
  "ForceBackgroundShell",
  "WebFetch",
  "TodoWrite",
]);

/**
 * 交互桥工具：经 InteractionQuery 下发，客户端 InteractionResponse 回传。
 * 本地协议实现。
 */
export const INTERACTION_TOOLS = new Set([
  "AskQuestion",
  "CreatePlan",
  "SwitchMode",
  "WebSearch",
]);

/**
 * 执行桥-only 工具：必须经 ExecServerMessage 走客户端（本地不执行）。
 * 本地协议实现。
 */
export const EXEC_BRIDGE_TOOLS = new Set([
  "CallMcpTool",
  "Task",
  "ListMcpResources",
  "FetchMcpResource",
]);

/** 所有需要客户端参与的工具 */
export const CLIENT_BRIDGE_TOOLS = new Set([
  ...INTERACTION_TOOLS,
  ...EXEC_BRIDGE_TOOLS,
]);

/**
 * 各 mode 允许暴露的工具（在已实现目录上再过滤）。
 * plan/ask：只读 + shell 探测 + todo + 交互提问；agent/debug/multitask：全量。
 */
const MODE_ALLOW: Record<AgentMode, ReadonlySet<string>> = {
  agent: new Set([...EXECUTABLE_TOOLS, ...CLIENT_BRIDGE_TOOLS]),
  debug: new Set([...EXECUTABLE_TOOLS, ...CLIENT_BRIDGE_TOOLS]),
  multitask: new Set([...EXECUTABLE_TOOLS, ...CLIENT_BRIDGE_TOOLS]),
  ask: new Set([
    "Read",
    "ReadLints",
    "PatchEdit",
    "Glob",
    "Grep",
    "Ls",
    "Shell",
    "AwaitShell",
    "WriteShellStdin",
    "ForceBackgroundShell",
    "WebFetch",
    "TodoWrite",
    "AskQuestion",
    "WebSearch",
    "CallMcpTool",
    "ListMcpResources",
    "FetchMcpResource",
  ]),
  plan: new Set([
    "Read",
    "ReadLints",
    "Glob",
    "Grep",
    "Ls",
    "Shell",
    "AwaitShell",
    "WriteShellStdin",
    "ForceBackgroundShell",
    "WebFetch",
    "TodoWrite",
    "AskQuestion",
    "CreatePlan",
    "WebSearch",
    "CallMcpTool",
    "ListMcpResources",
    "FetchMcpResource",
  ]),
};

export function normalizeAgentMode(raw?: string | null): AgentMode {
  const s = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
  if (!s) return "agent";
  if (s.includes("ask") || s === "agentmodeask") return "ask";
  if (s.includes("plan") || s === "agentmodeplan") return "plan";
  if (s.includes("debug") || s === "agentmodedebug") return "debug";
  if (s.includes("multitask") || s.includes("multi")) return "multitask";
  if (s.includes("agent")) return "agent";
  return "agent";
}

export const AGENT_TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "Read",
      description:
        "Read a file from the local filesystem. Supports optional offset/limit for large files.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute or workspace-relative path" },
          offset: { type: "integer", description: "1-indexed start line" },
          limit: { type: "integer", description: "Max lines to read" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "PatchEdit",
      description:
        "Replace exact text in an existing workspace file. The old text must match exactly; use replace_all only when every occurrence should change.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative or absolute path inside the workspace" },
          old_string: { type: "string", description: "Exact existing text to replace" },
          new_string: { type: "string", description: "Replacement text; may be empty" },
          replace_all: { type: "boolean", description: "Replace every exact occurrence" },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ReadLints",
      description:
        "Read diagnostics produced by the workspace's installed linter or TypeScript compiler. Limit paths to files you are working on when possible.",
      parameters: {
        type: "object",
        properties: {
          paths: {
            type: "array",
            items: { type: "string" },
            description: "Optional workspace-relative or absolute paths inside the workspace",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "Write",
      description: "Write contents to a file (create or overwrite).",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          contents: { type: "string" },
        },
        required: ["path", "contents"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "WriteShellStdin",
      description:
        "Write literal characters to an existing background shell. Include a newline when submitting a command or response.",
      parameters: {
        type: "object",
        properties: {
          shell_id: { type: "string", description: "The shell_id returned by Shell" },
          chars: { type: "string", description: "Literal text to write to standard input" },
        },
        required: ["shell_id", "chars"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ForceBackgroundShell",
      description:
        "Move a running Shell call to the background so work can continue. Pass the original Shell tool call id.",
      parameters: {
        type: "object",
        properties: {
          tool_call_id: { type: "string", description: "The original Shell tool call id" },
        },
        required: ["tool_call_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "Delete",
      description: "Delete a file. Fails gracefully if missing.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "Glob",
      description: "Find files matching a glob pattern under target_directory.",
      parameters: {
        type: "object",
        properties: {
          glob_pattern: { type: "string" },
          target_directory: { type: "string" },
        },
        required: ["glob_pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "Grep",
      description: "Search file contents with a regex pattern (ripgrep-like).",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string" },
          path: { type: "string" },
          glob: { type: "string" },
          case_insensitive: { type: "boolean" },
          head_limit: { type: "integer" },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "Ls",
      description: "List files and directories under a path.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          ignore: { type: "array", items: { type: "string" } },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "Shell",
      description:
        "Execute a shell command. Prefer non-interactive commands. Working directory defaults to workspace. Set block_until_ms=0 to background and get shell_id for AwaitShell.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          working_directory: { type: "string" },
          description: { type: "string" },
          block_until_ms: { type: "number" },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "AwaitShell",
      description:
        "Wait for a background shell (from Shell with block_until_ms=0). Poll by shell_id; optional regex pattern on combined output.",
      parameters: {
        type: "object",
        properties: {
          shell_id: { type: "string" },
          task_id: { type: "string", description: "Alias of shell_id" },
          block_until_ms: {
            type: "number",
            description: "Max wait ms; 0 = snapshot only",
          },
          pattern: {
            type: "string",
            description: "Optional regex; return early on match",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "WebFetch",
      description: "Fetch a public URL and return text/markdown content.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string" },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "WebSearch",
      description:
        "Search the web for real-time information. Prefer for up-to-date facts; results come from the Cursor client bridge.",
      parameters: {
        type: "object",
        properties: {
          search_term: {
            type: "string",
            description: "Search query",
          },
        },
        required: ["search_term"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "TodoWrite",
      description: "Update the shared todo list for the current agent session.",
      parameters: {
        type: "object",
        properties: {
          merge: { type: "boolean" },
          todos: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                content: { type: "string" },
                status: {
                  type: "string",
                  enum: ["pending", "in_progress", "completed", "cancelled"],
                },
              },
              required: ["id"],
            },
          },
        },
        required: ["todos", "merge"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "AskQuestion",
      description:
        "Collect structured multiple-choice answers from the user. Present questions with options; wait for client InteractionResponse.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          questions: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                prompt: { type: "string" },
                allow_multiple: { type: "boolean" },
                options: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      id: { type: "string" },
                      label: { type: "string" },
                    },
                    required: ["id", "label"],
                  },
                  minItems: 2,
                },
              },
              required: ["id", "prompt", "options"],
            },
            minItems: 1,
          },
        },
        required: ["questions"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "CallMcpTool",
      description:
        "Call a tool on an MCP server configured in ~/.cursor/mcp.json. Executed via client bridge.",
      parameters: {
        type: "object",
        properties: {
          server: {
            type: "string",
            description: "MCP server identifier",
          },
          toolName: {
            type: "string",
            description: "Tool name on that server",
          },
          arguments: {
            type: "object",
            description: "Arguments for the MCP tool",
          },
        },
        required: ["server", "toolName"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "Task",
      description:
        "Launch a specialized subagent for multi-step exploration. Runs on the Cursor client (subagent bridge).",
      parameters: {
        type: "object",
        properties: {
          description: {
            type: "string",
            description: "Short (3-5 word) task summary",
          },
          prompt: {
            type: "string",
            description: "Full task instructions for the subagent",
          },
          subagent_type: {
            type: "string",
            description: "explore | generalPurpose | shell | browser-use",
          },
          model: { type: "string" },
          resume: { type: "string" },
          attachments: {
            type: "array",
            items: { type: "string" },
          },
        },
        required: ["description", "prompt"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "SwitchMode",
      description:
        "Request switching the agent UI mode (e.g. to plan). Client confirms via InteractionResponse.",
      parameters: {
        type: "object",
        properties: {
          target_mode_id: {
            type: "string",
            description: "Target mode id, e.g. plan",
          },
          explanation: { type: "string" },
        },
        required: ["target_mode_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "CreatePlan",
      description:
        "Create a structured plan for the user to review/accept (client interaction).",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          overview: { type: "string" },
          plan: { type: "string" },
          is_project: { type: "boolean" },
          todos: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                content: { type: "string" },
              },
            },
          },
        },
        required: ["plan"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ListMcpResources",
      description: "List resources from an MCP server (client bridge).",
      parameters: {
        type: "object",
        properties: {
          server: { type: "string" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "FetchMcpResource",
      description: "Read a resource from an MCP server (client bridge).",
      parameters: {
        type: "object",
        properties: {
          server: { type: "string" },
          uri: { type: "string" },
        },
        required: ["server", "uri"],
      },
    },
  },
];

/** 按 mode 过滤后的工具列表 */
export function toolsForMode(mode?: string | AgentMode | null): ToolDefinition[] {
  const m = normalizeAgentMode(mode);
  const allow = MODE_ALLOW[m] || MODE_ALLOW.agent;
  return AGENT_TOOLS.filter((t) => allow.has(t.function.name));
}

/** Anthropic tools 形态 */
export function toAnthropicTools(tools: ToolDefinition[] = AGENT_TOOLS) {
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
  }));
}

export function toolNames(tools: ToolDefinition[] = AGENT_TOOLS): string[] {
  return tools.map((t) => t.function.name);
}

export function isInteractionTool(name: string): boolean {
  return INTERACTION_TOOLS.has(name);
}

export function isExecBridgeTool(name: string): boolean {
  return EXEC_BRIDGE_TOOLS.has(name);
}

export function isClientBridgeTool(name: string): boolean {
  return CLIENT_BRIDGE_TOOLS.has(name);
}
