# Provider sessions (plan M)

Real authoring attempts through the runtime's provider routing, one per provider with a key. Spend is the registry price of the tokens the API reported.

| at (UTC) | model | recipe | outcome | USD | tokens in / out / cache read | sandbox s | provenance |
|---|---|---|---|---|---|---|---|
| 2026-10-09 23:31 | anthropic/claude-haiku-4-5 | fixture-b58 | error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"adaptive thinking is not supported on this | 0.0000 | 0 / 0 / 0 | 0 | anthropic: claude-haiku-4-5, anthropic anthropic/1 |
| 2026-10-09 23:32 | anthropic/claude-haiku-4-5 | fixture-b58 | anthropic: spend cap reached (0.2764 USD spent, cap 0.3000) | 0.2764 | 8614 / 2430 / 5283 | 0 | anthropic: claude-haiku-4-5-20251001, anthropic anthropic/1 |
| 2026-10-09 23:33 | anthropic/claude-haiku-4-5 | fixture-b58 | anthropic: turn limit reached | 0.0698 | 11474 / 7054 / 72242 | 4 | anthropic: claude-haiku-4-5-20251001, anthropic anthropic/1 |

Notes:
- 23:31: the native proposer sent adaptive thinking and effort to Haiku 4.5, which answers 400 to both; fixed (anthropic.ts `NO_ADAPTIVE`). No tokens billed.
- 23:32: the API reports the dated snapshot `claude-haiku-4-5-20251001`, which the meter did not match to the requested model and priced at the ceiling (Fable 5.1). The 0.2764 USD shown is that overcount; at Haiku 4.5's registry rate the same tokens (8614 in, 2430 out, 5283 cache read, 5395 cache write) cost 0.0280 USD. Fixed (snapshot ids price as their model), with a test.
- 23:33: a full session after both fixes: 14 turns, one sandbox evaluation, 0.0698 USD.
- Real spend of this lane on 2026-10-09: 0.0978 USD (Anthropic only; no other provider key exists).
| 2026-10-10 18:48 | openai/gpt-5-mini | fixture-b58 | submitted | 0.0095 | 4256 / 3612 / 29952 | 10 | openrouter: openai/gpt-5-mini, openai-compat openai-compat/1; route openrouter (OpenAI); OpenRouter credits used 0.006058 |
| 2026-10-10 18:49 | google/gemini-3.5-flash-lite | fixture-b58 | submitted | 0.0091 | 24109 / 541 / 0 | 18 | openrouter: google/gemini-3.5-flash-lite, openai-compat openai-compat/1; route openrouter (Google); OpenRouter credits used 0.002978 |
| 2026-10-10 18:53 | deepseek/deepseek-flash | fixture-b58 | submitted | 0.0150 | 37809 / 22777 / 103680 | 5 | openrouter: deepseek/deepseek-v4.1-flash, openai-compat openai-compat/1; route openrouter (Relace); OpenRouter credits used 0.022845 |
| 2026-10-10 19:01 | alibaba/qwen3.8-flash | fixture-b58 | submitted | 0.0196 | 31040 / 26201 / 97792 | 16 | openrouter: qwen/qwen3.8-flash, openai-compat openai-compat/1; route openrouter (Alibaba); OpenRouter credits used 0.018978 |
| 2026-10-10 19:04 | moonshot/kimi-k2.6 | fixture-b58 | openrouter: ended without submit | 0.0631 | 2048 / 32121 / 3426 | 0 | openrouter: moonshotai/kimi-k2.6, openai-compat openai-compat/1; route openrouter (Baidu); OpenRouter credits used 0.007031 |
| 2026-10-10 19:05 | zhipu/glm-5.3-flash | fixture-b58 | submitted | 0.0104 | 39085 / 7944 / 0 | 9 | openrouter: z-ai/glm-5.3-flash, openai-compat openai-compat/1; route openrouter (Venice); OpenRouter credits used 0.062911 |
| 2026-10-10 19:08 | minimax/MiniMax-M2.7 | fixture-b58 | openrouter: turn limit reached | 0.0159 | 24552 / 8005 / 76553 | 15 | openrouter: minimax/minimax-m2.7, openai-compat openai-compat/1; route openrouter (GMICloud); OpenRouter credits used 0.018503 |
| 2026-10-10 19:08 | meta/llama-4-maverick | fixture-b58 | openrouter: ended without submit | 0.0005 | 1982 / 96 / 0 | 0 | openrouter: meta-llama/llama-4-maverick, openai-compat openai-compat/1; route openrouter (DigitalOcean); OpenRouter credits used 0.003041 |

Notes on the 2026-10-10 OpenRouter runs (plan MODELS-AND-SELF-FUNDING; only the OpenRouter key existed besides Anthropic, so every non-Anthropic family ran via OpenRouter at a 0.10 USD cap each):
- USD is what the agent is metered: OpenRouter's `usage.cost` per response times 1.055 (the 5.5% card credit fee).
- The "OpenRouter credits used" figures per row are the change in `total_usage` (GET /api/v1/credits) around each session; OpenRouter's counter lagged by up to a session, so per row they do not line up. The totals do: `total_usage` went from 0.151205 to 0.286771714 (0.135567 credits) over the eight sessions, and the metered USD sum 0.143024 / 1.055 = 0.135568 credits. The script now waits for two equal readings.
- Upstream hosts OpenRouter picked (in provenance `route.upstream`): OpenAI, Google, Relace, Alibaba, Baidu, Venice, GMICloud, DigitalOcean.
