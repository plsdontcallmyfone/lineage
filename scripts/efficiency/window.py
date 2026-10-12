#!/usr/bin/env python3
"""Attempt window from the hosted runtime's journal (docs/plans/AGENT-EFFICIENCY.md section 5).

  ssh root@<site> 'journalctl -u units-runtime --no-pager -o short-iso' > runtime.log
  python3 scripts/efficiency/window.py runtime.log --since 2026-10-11T02:16 --until 2026-10-12T02:16 [--json out.json]

Reads only the log. One attempt per agent runs at a time, so an agent's lines from "attempt starts"
to "attempt done" are one attempt. Attempts with no model call (budget under the journal reserve,
before the minimum useful attempt existed) are counted apart and left out of every average.
Columns: attempts, how they ended, candidates committed, USD per attempt, tokens per call, cache hit
rate (cache read over all input), the first call's cache read (the static prefix, logged since the
agent productivity lane), evaluations, where the spend went by token class at the published
claude-opus-5-5 rates. Every figure is computed from the log lines; nothing is estimated.
"""
import collections, json, re, statistics as st, sys
from datetime import datetime

PRICE = dict(inp=4, out=20, cr=0.2, cw=5)  # USD per million tokens, claude-opus-5-5


def parse(path):
    cur, done = {}, []
    for line in open(path, errors="replace"):
        m = re.match(r"(\S+) \S+ \S+: \[\S+ runtime\] (\w{6}) (.*)", line)
        if not m:
            continue
        ts, ag, msg = m.groups()
        if msg.startswith("attempt starts"):
            cur[ag] = dict(agent=ag, start=ts, cap=float(re.search(r"cap (-?[\d.]+)", msg).group(1)), turns=[], evals=0, eval_at=[], notice=0, nudge=0, shared=None, stop=None, usage=None, journal=0.0, cand=None, guard=0, first=None, spread=None, why="")
            continue
        a = cur.get(ag)
        if not a:
            continue
        if r := re.match(r"shared findings: (\d+) items, about (\d+) tokens", msg):
            a["shared"] = (int(r[1]), int(r[2]))
        elif r := re.match(r"target spread: (\w+) (\S+)", msg):
            a["spread"] = f"{r[1]}:{r[2]}"
        elif r := re.match(r"anthropic: first call (\d+) cache read, (\d+) cache write, (\d+) in", msg):
            a["first"] = (int(r[1]), int(r[2]), int(r[3]))
        elif r := re.match(r"anthropic: turn (\d+), ([\d.]+) USD", msg):
            a["turns"].append((ts, float(r[2])))
        elif "anthropic: evaluating (" in msg:
            a["evals"] += 1
            a["eval_at"].append(len(a["turns"]))
        elif "wrap-up notice sent" in msg:
            a["notice"] += 1
        elif "budget nudge sent" in msg:
            a["nudge"] += 1
        elif "anthropic: guard regression" in msg:
            a["guard"] += 1
        elif r := re.match(r"anthropic: usage ([a-z ]+): (\d+) calls, (\d+) in, (\d+) out, (\d+) cache read, (\d+) cache write, ([\d.]+) USD", msg):
            a["stop"] = r[1]
            a["usage"] = dict(calls=int(r[2]), inp=int(r[3]), out=int(r[4]), cr=int(r[5]), cw=int(r[6]), usd=float(r[7]))
        elif msg.startswith("anthropic: spend cap reached"):
            a["why"] = "response cut at its allowance" if "response cut" in msg else "next call under the minimum"
        elif r := re.match(r"anthropic: journal call ([\d.]+)", msg):
            a["journal"] += float(r[1])
        elif r := re.match(r"attempt done: ([\d.]+) USD model spend, (\d+) sandbox s.*?, (no candidate|candidate \w+)", msg):
            a.update(end=ts, usd=float(r[1]), sandbox=int(r[2]), cand=None if r[3] == "no candidate" else r[3].split()[1])
            done.append(a)
            del cur[ag]
    return done


def secs(a, b):
    return (datetime.fromisoformat(b) - datetime.fromisoformat(a)).total_seconds()


def summarize(done):
    model = [a for a in done if a["usage"] and a["usage"]["calls"] > 0]
    out = dict(attempts_started=len(done), zero_call_attempts=len(done) - len(model), attempts=len(model))
    if not model:
        return out
    tot = {k: sum(a["usage"][k] for a in model) for k in ("calls", "inp", "out", "cr", "cw", "usd")}
    usd_all = sum(a["usd"] for a in model)
    cands = [a for a in model if a["cand"]]
    first = [a["first"] for a in model if a["first"]]
    before_eval = [a["turns"][a["eval_at"][0] - 1][1] if a["eval_at"][0] > 0 else 0.0 for a in model if a["eval_at"]]
    with_result = [a["turns"][a["eval_at"][0]][1] for a in model if a["eval_at"] and len(a["turns"]) > a["eval_at"][0]]
    out.update(
        by_agent=dict(collections.Counter(a["agent"] for a in model)),
        ended=dict(collections.Counter(a["stop"] for a in model)),
        cap_stop_kinds=dict(collections.Counter(a["why"] for a in model if a["stop"] == "cap reached")),
        candidates=len(cands),
        candidates_by_agent=dict(collections.Counter(a["agent"] for a in cands)),
        usd_total=round(usd_all, 4),
        usd_per_attempt=round(usd_all / len(model), 4),
        usd_per_candidate=round(usd_all / len(cands), 4) if cands else None,
        usd_loop_median=round(st.median(a["usage"]["usd"] for a in model), 4),
        calls_median=st.median(a["usage"]["calls"] for a in model),
        tokens_per_call=dict(input=round(tot["inp"] / tot["calls"]), output=round(tot["out"] / tot["calls"]), cache_read=round(tot["cr"] / tot["calls"]), cache_write=round(tot["cw"] / tot["calls"])),
        output_tokens_per_attempt=round(tot["out"] / len(model)),
        cache_hit_pct=round(100 * tot["cr"] / (tot["cr"] + tot["cw"] + tot["inp"]), 1),
        usd_share_pct={k: round(100 * tot[k] * PRICE[k] / 1e6 / tot["usd"], 1) for k in PRICE},
        first_call=dict(n=len(first), with_cache_read=sum(1 for f in first if f[0] > 0), cache_read_median=st.median(f[0] for f in first) if first else None, cache_write_median=st.median(f[1] for f in first) if first else None),
        first_turn_usd_median=round(st.median(a["turns"][0][1] for a in model if a["turns"]), 4) if any(a["turns"] for a in model) else None,
        attempts_with_evaluation=sum(1 for a in model if a["evals"]),
        evaluations=sum(a["evals"] for a in model),
        usd_before_first_evaluate_call_median=round(st.median(before_eval), 4) if before_eval else None,
        usd_at_first_evaluation_result_median=round(st.median(with_result), 4) if with_result else None,
        usd_at_first_evaluation_result_p75=round(sorted(with_result)[int(len(with_result) * 0.75)], 4) if with_result else None,
        guard_regressions=sum(a["guard"] for a in model),
        notices=sum(a["notice"] for a in model),
        nudges=sum(a["nudge"] for a in model),
        spread_targets=dict(collections.Counter(a["spread"] for a in model if a["spread"])),
        minutes_per_attempt_median=round(st.median(secs(a["start"], a["end"]) for a in model) / 60, 1),
        sandbox_s_median=st.median(a["sandbox"] for a in model),
        shared_block_tokens_median=st.median(a["shared"][1] for a in model if a["shared"]) if any(a["shared"] for a in model) else None,
    )
    return out


if __name__ == "__main__":
    args = sys.argv[1:]
    opt = lambda k, d=None: args[args.index(k) + 1] if k in args else d
    since, until = opt("--since", "0"), opt("--until", "9")
    done = [a for a in parse(args[0]) if since <= a["start"] < until]
    s = summarize(done)
    print(json.dumps(s, indent=1))
    if opt("--json"):
        json.dump(s, open(opt("--json"), "w"), indent=1)
