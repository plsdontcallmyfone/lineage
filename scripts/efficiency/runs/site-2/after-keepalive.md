attempts 52, started 2026-10-10T21:56:45.000Z to 2026-10-10T23:09:51.000Z

Per agent and model:
| group | attempts | USD/attempt | attempts/accepted | USD/accepted | min/accepted | model calls (median) | min/attempt (median) | sandbox s (median) | evals (median) | ended with nothing (why) | USD on nothing | candidates rejected (why) | in / out / cache read / cache write tokens per turn | cache hit | output share of USD |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 5iCWSo claude-opus-5-5 | 6 | 0.1226 | n/a | n/a | n/a | 2.5 | 1.4 | 40.5 | 0.5 | 50% (3/6): failed 3 | 0.0000 | 100% (3/3): stale_conflict 2, dependency_failed 1 | 2 / 1209 / 9420 / 2529 (3 attempts) | 79% | 62% |
| 5t9wKL claude-opus-5-5 | 4 | 0.3966 | 4.00 | 1.5865 | 22.3 | 5 | 5.3 | 186 | 1 | 50% (2/4): gave_up 1, cap_reached 1 | 0.8172 | 50% (1/2): no_improvement 1 | 3 / 1862 / 17179 / 4555 (4 attempts) | 79% | 59% |
| 63JTud claude-opus-5-5 | 7 | 0.1464 | n/a | n/a | n/a | 1 | 0.0 | 0 | 0 | 71% (5/7): failed 4, cap_reached 1 | 0.4981 | 100% (2/2): stale_conflict 2 | 2 / 1409 / 16031 / 3970 (3 attempts) | 80% | 55% |
| 6C8N2z claude-opus-5-5 | 11 | 0.2196 | 11.00 | 2.4157 | 46.7 | 5 | 5.1 | 221 | 1 | 55% (6/11): failed 4, gave_up 1, cap_reached 1 | 0.8045 | 40% (2/5): stale_conflict 2 | 3 / 1161 / 18579 / 3557 (7 attempts) | 84% | 52% |
| BFPxda claude-opus-5-5 | 13 | 0.2396 | 13.00 | 3.1146 | 48.6 | 5 | 2.8 | 0 | 0 | 69% (9/13): gave_up 2, failed 5, cap_reached 2 | 1.6212 | 25% (1/4): apply_conflict 1 | 3 / 1596 / 17061 / 4913 (8 attempts) | 78% | 53% |
| CLy55w claude-opus-5-5 | 7 | 0.0788 | 3.50 | 0.2759 | 4.5 | 1 | 0.0 | 0 | 0 | 57% (4/7): failed 4 | 0.0000 | 33% (1/3): apply_conflict 1 | 2 / 1124 / 6858 / 2583 (3 attempts) | 73% | 61% |
| CvREmf claude-opus-5-5 | 1 | 0.2687 | n/a | n/a | n/a | 5 | 3.8 | 109 | 1 | 0% (0/1) | 0.0000 | 0% (0/1) | 2 / 1406 / 9071 / 2969 (1 attempts) | 75% | 63% |
| CvREmf unknown | 1 | 0.4258 | n/a | n/a | n/a | 6 | 3.8 | 50 | 1 | 100% (1/1): cap_reached 1 | 0.4258 | n/a | 2 / 2588 / 7634 / 3536 (1 attempts) | 68% | n/a |
| FCYKkF claude-opus-5-5 | 1 | 0.4424 | n/a | n/a | n/a | 4 | 3.1 | 0 | 0 | 100% (1/1): cap_reached 1 | 0.4424 | n/a | 3 / 3962 / 4843 / 6076 (1 attempts) | 44% | 72% |
| FCYKkF unknown | 1 | 0.4027 | n/a | n/a | n/a | 6 | 3.8 | 48 | 1 | 100% (1/1): cap_reached 1 | 0.4027 | n/a | 2 / 2310 / 9785 / 3791 (1 attempts) | 72% | n/a |

Per model:
| group | attempts | USD/attempt | attempts/accepted | USD/accepted | min/accepted | model calls (median) | min/attempt (median) | sandbox s (median) | evals (median) | ended with nothing (why) | USD on nothing | candidates rejected (why) | in / out / cache read / cache write tokens per turn | cache hit | output share of USD |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| claude-opus-5-5 | 50 | 0.2028 | 10.00 | 2.0280 | 33.5 | 4 | 3.0 | 81.5 | 1 | 60% (30/50): gave_up 4, failed 20, cap_reached 6 | 4.1834 | 50% (10/20): stale_conflict 6, apply_conflict 2, dependency_failed 1, no_improvement 1; 5 pending | 3 / 1459 / 15365 / 3947 (30 attempts) | 80% | 56% |
| unknown | 2 | 0.4143 | n/a | n/a | n/a | 6 | 3.8 | 49 | 1 | 100% (2/2): cap_reached 2 | 0.8285 | n/a | 2 / 2449 / 8709 / 3663 (2 attempts) | 70% | n/a |

All:
| group | attempts | USD/attempt | attempts/accepted | USD/accepted | min/accepted | model calls (median) | min/attempt (median) | sandbox s (median) | evals (median) | ended with nothing (why) | USD on nothing | candidates rejected (why) | in / out / cache read / cache write tokens per turn | cache hit | output share of USD |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| all | 52 | 0.2109 | 10.40 | 2.1937 | 35.0 | 4 | 3.1 | 65.5 | 1 | 62% (32/52): gave_up 4, failed 20, cap_reached 8 | 5.0119 | 50% (10/20): stale_conflict 6, apply_conflict 2, dependency_failed 1, no_improvement 1; 5 pending | 3 / 1516 / 14979 / 3931 (32 attempts) | 79% | 57% |

cap_reached attempts: 8; their caps 0.50, 0.50, 0.50, 0.50, 0.50, 0.50, 0.50, 0.50; last turn before the stop cost 0.015, 0.091, 0.311, 0.074, 0.055, 0.130, 0.100, 0.070 USD
