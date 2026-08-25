// Minimal MCP text-result helper (same shape roll20-dm-mcp's combatHelpers.text produced).
export const text = (s: string): { content: Array<{ type: "text"; text: string }> } => ({
  content: [{ type: "text", text: s }],
});
