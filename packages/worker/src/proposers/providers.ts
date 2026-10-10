import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// Provider endpoints and keys (plan M). Base URLs and key names live here in code, never in Core's
// registry: Core only says which models exist and what they cost, so a registry edit can never point
// a provider key at another host. Keys come from ~/.config/lineage/providers.env (the owner fills it;
// mode 600) and, for Anthropic, also from ~/.config/lineage/model.env. Keys are never printed.

export interface ProviderSpec {
  id: string;
  adapter: "anthropic" | "openai";
  /** chat completions base: the adapter POSTs `${base_url}/chat/completions` */
  base_url: string;
  key_env: string;
  /** optional providers.env variable that overrides base_url (https only) */
  base_env?: string;
  /** "max_completion_tokens" where the provider refuses max_tokens (OpenAI reasoning models) */
  token_param?: "max_tokens" | "max_completion_tokens";
  /** send reasoning_content back on assistant turns in a tool loop (the provider requires it) */
  echo_reasoning?: boolean;
  /** extra request fields the provider documents for this use */
  extra_body?: Record<string, unknown>;
  /** extra request headers (OpenRouter's app identification) */
  headers?: Record<string, string>;
  /** assistant message fields sent back verbatim on the next turn of a tool loop (OpenRouter's reasoning_details) */
  echo_fields?: string[];
  /** the response's usage.cost is what was charged (USD credits): meter that, times the route's funding fee */
  reported_cost?: boolean;
  /** a router in front of other providers (OpenRouter): never a model's own provider */
  router?: boolean;
  max_tokens?: number;
  /** what the provider's API documentation says that shaped the settings above */
  docs: string;
}

export const PROVIDERS: Record<string, ProviderSpec> = {
  anthropic: { id: "anthropic", adapter: "anthropic", base_url: "https://api.anthropic.com", key_env: "ANTHROPIC_API_KEY", docs: "https://platform.claude.com/docs/en/api/messages" },
  openai: {
    id: "openai",
    adapter: "openai",
    base_url: "https://api.openai.com/v1",
    key_env: "OPENAI_API_KEY",
    token_param: "max_completion_tokens",
    docs: "https://platform.openai.com/docs/api-reference/chat/create",
  },
  google: {
    id: "google",
    adapter: "openai",
    base_url: "https://generativelanguage.googleapis.com/v1beta/openai",
    key_env: "GEMINI_API_KEY",
    // thinking cannot be turned off on Gemini 3; thought signatures ride on tool_calls, which go back verbatim
    docs: "https://ai.google.dev/gemini-api/docs/openai",
  },
  deepseek: {
    id: "deepseek",
    adapter: "openai",
    base_url: "https://api.deepseek.com",
    key_env: "DEEPSEEK_API_KEY",
    // with tools, the reasoning_content of every earlier turn must be sent back or the API answers 400;
    // tool_choice required or named is a 400 in thinking mode (thinking is on by default): auto only
    echo_reasoning: true,
    docs: "https://api-docs.deepseek.com/guides/function_calling",
  },
  alibaba: {
    id: "alibaba",
    adapter: "openai",
    base_url: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    key_env: "DASHSCOPE_API_KEY",
    // the docs now give a per-workspace host ({WorkspaceId}.ap-southeast-1.maas.aliyuncs.com) and ask to
    // migrate from dashscope-intl: DASHSCOPE_BASE_URL in providers.env overrides. preserve_thinking is on
    // by default for qwen3.8, so history carries reasoning_content; tool_choice "required" is unsupported
    base_env: "DASHSCOPE_BASE_URL",
    echo_reasoning: true,
    docs: "https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope",
  },
  moonshot: {
    id: "moonshot",
    adapter: "openai",
    base_url: "https://api.moonshot.ai/v1",
    key_env: "MOONSHOT_API_KEY",
    // max_tokens is deprecated; temperature is fixed by model (never sent); kimi-k3 wants the full
    // assistant message back including reasoning_content; tool_choice auto only (required errors on k2.6)
    token_param: "max_completion_tokens",
    echo_reasoning: true,
    docs: "https://platform.moonshot.ai/docs/api/chat",
  },
  zhipu: {
    id: "zhipu",
    adapter: "openai",
    base_url: "https://api.z.ai/api/paas/v4",
    key_env: "ZAI_API_KEY",
    // tool_choice: only auto; thinking cannot be disabled on GLM-5.3; the thinking guide returns
    // reasoning_content alongside tool results
    echo_reasoning: true,
    docs: "https://docs.z.ai/api-reference/llm/chat-completion",
  },
  minimax: {
    id: "minimax",
    adapter: "openai",
    base_url: "https://api.minimax.io/v1",
    key_env: "MINIMAX_API_KEY",
    // max_tokens is legacy; reasoning_split stays false, so <think> stays inside content, and the full
    // assistant message (content verbatim) goes back as MiniMax requires; errors arrive in base_resp
    token_param: "max_completion_tokens",
    docs: "https://platform.minimax.io/docs/api-reference/text-openai-api",
  },
  openrouter: {
    id: "openrouter",
    adapter: "openai",
    base_url: "https://openrouter.ai/api/v1",
    key_env: "OPENROUTER_API_KEY",
    // read 2026-10-10: POST /api/v1/chat/completions, bearer key, OpenAI tool calls; usage.cost is the
    // credits charged (Usage Accounting); reasoning goes back unmodified in reasoning_details on assistant
    // turns of a tool loop; HTTP-Referer and X-OpenRouter-Title identify the app; a 200 may carry only
    // an error object; 402 means the credits cannot cover the request
    headers: { "HTTP-Referer": "https://github.com/plsdontcallmyfone/lineage", "X-OpenRouter-Title": "Lineage" },
    echo_fields: ["reasoning_details"],
    reported_cost: true,
    router: true,
    docs: "https://openrouter.ai/docs/api/api-reference/chat/create-a-chat-completion",
  },
};

export const PROVIDERS_ENV = join(homedir(), ".config/lineage/providers.env");
export const MODEL_ENV = join(homedir(), ".config/lineage/model.env");

const TEMPLATE = `# Lineage provider keys (plan M). Fill the ones you have; an empty value means that provider is
# unavailable in the launch form. Mode 600. Never commit this file. Anthropic's key may stay in
# model.env (ANTHROPIC_API_KEY there is read too).
${Object.values(PROVIDERS)
  .map((p) => `${p.key_env}=`)
  .join("\n")}
# Optional: OpenRouter management key (balance check via GET /api/v1/credits); without it the
# runtime reads the inference key's own limit (GET /api/v1/key), unknown when the key has no limit
OPENROUTER_MANAGEMENT_KEY=
# Optional: Alibaba's per-workspace endpoint, https://<WorkspaceId>.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1
DASHSCOPE_BASE_URL=
`;

function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && m[2]) out[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
  return out;
}

/**
 * Reads provider keys from providers.env (creating it with empty placeholders, mode 600, when it does
 * not exist) and Anthropic's from model.env. Returns key per provider id; absent means no key.
 */
export function loadProviderKeys(opts: { path?: string; modelEnv?: string; create?: boolean } = {}): Record<string, string> {
  const path = opts.path ?? PROVIDERS_ENV;
  if (!existsSync(path) && opts.create !== false) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, TEMPLATE, { mode: 0o600, flag: "wx" });
    chmodSync(path, 0o600);
  }
  const env = { ...(existsSync(opts.modelEnv ?? MODEL_ENV) ? parseEnv(readFileSync(opts.modelEnv ?? MODEL_ENV, "utf8")) : {}), ...(existsSync(path) ? parseEnv(readFileSync(path, "utf8")) : {}) };
  const keys: Record<string, string> = {};
  for (const p of Object.values(PROVIDERS)) if (env[p.key_env]) keys[p.id] = env[p.key_env]!;
  // not a provider: only the balance monitor reads it (plan MODELS-AND-SELF-FUNDING)
  if (env.OPENROUTER_MANAGEMENT_KEY) keys["openrouter-management"] = env.OPENROUTER_MANAGEMENT_KEY;
  return keys;
}

/** PROVIDERS with base URL overrides from providers.env (`base_env`, https only; never from Core). */
export function loadProviderSpecs(opts: { path?: string } = {}): Record<string, ProviderSpec> {
  const path = opts.path ?? PROVIDERS_ENV;
  const env = existsSync(path) ? parseEnv(readFileSync(path, "utf8")) : {};
  const out: Record<string, ProviderSpec> = {};
  for (const p of Object.values(PROVIDERS)) {
    const o = p.base_env ? env[p.base_env] : undefined;
    if (o && !/^https:\/\/[A-Za-z0-9.-]+(:\d+)?(\/[\w./-]*)?$/.test(o)) throw new Error(`${p.base_env} in providers.env must be an https URL`);
    out[p.id] = o ? { ...p, base_url: o.replace(/\/+$/, "") } : p;
  }
  return out;
}

/** Which providers have a key (what the runtime reports to Core; never the keys). */
export const availabilityOf = (keys: Record<string, string>): Record<string, boolean> => Object.fromEntries(Object.keys(PROVIDERS).map((id) => [id, !!keys[id]]));
