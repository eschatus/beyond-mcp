// Minimal MCP text-result helper (same shape roll20-dm-mcp's combatHelpers.text produced).
export const text = (s: string): { content: Array<{ type: "text"; text: string }> } => ({
  content: [{ type: "text", text: s }],
});

// The one convention for picking a <select> option across every homebrew tool: the builder's
// label, or { value: "<option id>" } where labels repeat (the ambiguity error lists the ids).
// Never a bare number: some labels ARE numbers (CR label "5" is option value "9").
import { z } from "zod";
export const optionChoice = z.union([z.string(), z.object({ value: z.string().describe("The builder option's id, for a label that repeats.") })]);
