// Public surface of the MCP integration: the manager starts configured stdio
// servers and exposes their tools; the agent and tool registry only need
// these few functions.

export { McpClient } from "./client";
export type { McpCallResult, McpContentPart, McpToolInfo } from "./client";
export {
  callMcpTool,
  ensureMcpStarted,
  isMcpTool,
  mcpNeedsStart,
  mcpSpecsFor,
  shutdownMcp,
  takeMcpNotes,
} from "./manager";
export type { McpNote, McpToolOutput } from "./manager";
