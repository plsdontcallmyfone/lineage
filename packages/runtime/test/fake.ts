import type Anthropic from "@anthropic-ai/sdk";

// A fake model client for tests: scripted turns with fixed usage, no network.

export type Turn = { tools?: { name: string; input: Record<string, unknown> }[]; usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }; model?: string; stop?: string; fail?: boolean };

export function fakeClient(turns: Turn[]): { client: Anthropic; calls: number[] } {
  const calls: number[] = [];
  let i = 0;
  const client = {
    beta: {
      messages: {
        stream: () => {
          const t = turns[Math.min(i, turns.length - 1)]!;
          calls.push(i++);
          const content = (t.tools ?? []).map((x, k) => ({ type: "tool_use", id: `tu_${i}_${k}`, name: x.name, input: x.input }));
          return {
            finalMessage: async () => (t.fail ? Promise.reject(new Error("unparseable tool input")) : {
              id: `msg_${i}`,
              type: "message",
              role: "assistant",
              model: t.model ?? "claude-opus-5-5",
              content,
              stop_reason: t.stop ?? (content.length ? "tool_use" : "end_turn"),
              stop_details: null,
              usage: { cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...t.usage },
            }),
          };
        },
      },
    },
  } as unknown as Anthropic;
  return { client, calls };
}
