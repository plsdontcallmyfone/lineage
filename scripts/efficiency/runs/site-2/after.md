attempts 62, started 2026-10-10T20:57:15.000Z to 2026-10-10T23:09:51.000Z

Per agent and model:
| group | attempts | USD/attempt | attempts/accepted | USD/accepted | min/accepted | model calls (median) | min/attempt (median) | sandbox s (median) | evals (median) | ended with nothing (why) | USD on nothing | candidates rejected (why) | in / out / cache read / cache write tokens per turn | cache hit | output share of USD |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 5iCWSo claude-opus-5-5 | 8 | 0.1626 | 8.00 | 1.3005 | 27.8 | 4 | 3.0 | 84 | 1 | 38% (3/8): failed 3 | 0.0000 | 80% (4/5): stale_conflict 3, dependency_failed 1 | 2 / 1237 / 9931 / 2536 (5 attempts) | 80% | 63% |
| 5t9wKL claude-opus-5-5 | 4 | 0.3966 | 4.00 | 1.5865 | 22.3 | 5 | 5.3 | 186 | 1 | 50% (2/4): gave_up 1, cap_reached 1 | 0.8172 | 50% (1/2): no_improvement 1 | 3 / 1862 / 17179 / 4555 (4 attempts) | 79% | 59% |
| 63JTud claude-opus-5-5 | 9 | 0.1975 | 9.00 | 1.7778 | 33.2 | 3 | 5.4 | 218 | 1 | 67% (6/9): cap_reached 2, failed 4 | 0.8463 | 67% (2/3): stale_conflict 2 | 2 / 1423 / 16013 / 4123 (5 attempts) | 80% | 54% |
| 6C8N2z claude-opus-5-5 | 13 | 0.2505 | 13.00 | 3.2559 | 62.2 | 6 | 5.9 | 238 | 1 | 62% (8/13): cap_reached 2, gave_up 2, failed 4 | 1.6447 | 40% (2/5): stale_conflict 2 | 3 / 1189 / 17273 / 3990 (9 attempts) | 81% | 50% |
| BFPxda claude-opus-5-5 | 15 | 0.2536 | 7.50 | 1.9019 | 31.5 | 5 | 5.1 | 184 | 1 | 67% (10/15): cap_reached 3, gave_up 2, failed 5 | 2.0661 | 20% (1/5): apply_conflict 1 | 3 / 1529 / 15769 / 5136 (10 attempts) | 75% | 51% |
| CLy55w claude-opus-5-5 | 9 | 0.1294 | 4.50 | 0.5823 | 9.6 | 3 | 2.8 | 82 | 1 | 56% (5/9): cap_reached 1, failed 4 | 0.4209 | 50% (2/4): no_improvement 1, apply_conflict 1 | 2 / 1476 / 7307 / 2758 (5 attempts) | 73% | 66% |
| CvREmf claude-opus-5-5 | 1 | 0.2687 | n/a | n/a | n/a | 5 | 3.8 | 109 | 1 | 0% (0/1) | 0.0000 | 0% (0/1) | 2 / 1406 / 9071 / 2969 (1 attempts) | 75% | 63% |
| CvREmf unknown | 1 | 0.4258 | n/a | n/a | n/a | 6 | 3.8 | 50 | 1 | 100% (1/1): cap_reached 1 | 0.4258 | n/a | 2 / 2588 / 7634 / 3536 (1 attempts) | 68% | n/a |
| FCYKkF claude-opus-5-5 | 1 | 0.4424 | n/a | n/a | n/a | 4 | 3.1 | 0 | 0 | 100% (1/1): cap_reached 1 | 0.4424 | n/a | 3 / 3962 / 4843 / 6076 (1 attempts) | 44% | 72% |
| FCYKkF unknown | 1 | 0.4027 | n/a | n/a | n/a | 6 | 3.8 | 48 | 1 | 100% (1/1): cap_reached 1 | 0.4027 | n/a | 2 / 2310 / 9785 / 3791 (1 attempts) | 72% | n/a |

Per model:
| group | attempts | USD/attempt | attempts/accepted | USD/accepted | min/accepted | model calls (median) | min/attempt (median) | sandbox s (median) | evals (median) | ended with nothing (why) | USD on nothing | candidates rejected (why) | in / out / cache read / cache write tokens per turn | cache hit | output share of USD |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| claude-opus-5-5 | 60 | 0.2267 | 7.50 | 1.7000 | 29.3 | 4.5 | 4.0 | 116.5 | 1 | 58% (35/60): cap_reached 10, gave_up 5, failed 20 | 6.2376 | 48% (12/25): no_improvement 2, stale_conflict 7, apply_conflict 2, dependency_failed 1; 5 pending | 2 / 1449 / 14431 / 4044 (40 attempts) | 78% | 56% |
| unknown | 2 | 0.4143 | n/a | n/a | n/a | 6 | 3.8 | 49 | 1 | 100% (2/2): cap_reached 2 | 0.8285 | n/a | 2 / 2449 / 8709 / 3663 (2 attempts) | 70% | n/a |

All:
| group | attempts | USD/attempt | attempts/accepted | USD/accepted | min/accepted | model calls (median) | min/attempt (median) | sandbox s (median) | evals (median) | ended with nothing (why) | USD on nothing | candidates rejected (why) | in / out / cache read / cache write tokens per turn | cache hit | output share of USD |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| all | 62 | 0.2327 | 7.75 | 1.8036 | 30.3 | 5 | 3.8 | 102 | 1 | 60% (37/62): cap_reached 12, gave_up 5, failed 20 | 7.0661 | 48% (12/25): no_improvement 2, stale_conflict 7, apply_conflict 2, dependency_failed 1; 5 pending | 2 / 1493 / 14179 / 4028 (42 attempts) | 78% | 57% |

cap_reached attempts: 12; their caps 0.50, 0.50, 0.50, 0.50, 0.50, 0.50, 0.50, 0.50, 0.50, 0.50, 0.50, 0.50; last turn before the stop cost 0.142, 0.013, 0.244, 0.211, 0.015, 0.091, 0.311, 0.074, 0.055, 0.130, 0.100, 0.070 USD
