attempts 44, started 2026-10-10T19:20:36.000Z to 2026-10-10T20:47:48.000Z

Per agent and model:
| group | attempts | USD/attempt | attempts/accepted | USD/accepted | min/accepted | model calls (median) | min/attempt (median) | sandbox s (median) | evals (median) | ended with nothing (why) | USD on nothing | candidates rejected (why) | in / out / cache read / cache write tokens per turn | cache hit | output share of USD |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 5iCWSo claude-opus-5-5 | 9 | 0.2907 | 9.00 | 2.6163 | 30.2 | 4 | 3.6 | 104 | 1 | 44% (4/9): cap_reached 3, gave_up 1 | 1.3051 | 80% (4/5): stale_conflict 3, stale 1 | 2 / 1301 / 10639 / 2565 (5 attempts) | 81% | 63% |
| 63JTud claude-opus-5-5 | 10 | 0.3348 | 10.00 | 3.3479 | 37.6 | 5 | 2.8 | 0 | 0 | 80% (8/10): cap_reached 5, gave_up 3 | 2.7344 | 50% (1/2): no_improvement 1 | 3 / 1924 / 11530 / 4747 (4 attempts) | 71% | 60% |
| 6C8N2z claude-opus-5-5 | 9 | 0.3029 | 4.50 | 1.3631 | 21.8 | 5 | 4.9 | 196 | 1 | 56% (5/9): cap_reached 2, gave_up 3 | 1.5579 | 50% (2/4): stale_conflict 2 | 3 / 1801 / 12914 / 2903 (5 attempts) | 82% | 68% |
| BFPxda claude-opus-5-5 | 8 | 0.3663 | n/a | n/a | n/a | 6 | 6.6 | 288.5 | 1 | 88% (7/8): gave_up 4, cap_reached 3 | 2.5818 | 100% (1/1): stale_conflict 1 | 2 / 2264 / 11947 / 4176 (4 attempts) | 74% | 66% |
| CLy55w claude-opus-5-5 | 8 | 0.3663 | 4.00 | 1.4653 | 16.9 | 4.5 | 4.4 | 85 | 1 | 50% (4/8): cap_reached 4 | 1.7607 | 50% (2/4): stale_conflict 2 | 2 / 4399 / 6475 / 2859 (4 attempts) | 69% | 85% |

Per model:
| group | attempts | USD/attempt | attempts/accepted | USD/accepted | min/accepted | model calls (median) | min/attempt (median) | sandbox s (median) | evals (median) | ended with nothing (why) | USD on nothing | candidates rejected (why) | in / out / cache read / cache write tokens per turn | cache hit | output share of USD |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| claude-opus-5-5 | 44 | 0.3307 | 7.33 | 2.4253 | 31.9 | 5 | 3.9 | 104.5 | 1 | 64% (28/44): cap_reached 17, gave_up 11 | 9.9399 | 63% (10/16): stale_conflict 8, stale 1, no_improvement 1 | 3 / 2482 / 10624 / 3672 (20 attempts) | 74% | 71% |

All:
| group | attempts | USD/attempt | attempts/accepted | USD/accepted | min/accepted | model calls (median) | min/attempt (median) | sandbox s (median) | evals (median) | ended with nothing (why) | USD on nothing | candidates rejected (why) | in / out / cache read / cache write tokens per turn | cache hit | output share of USD |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| all | 44 | 0.3307 | 7.33 | 2.4253 | 31.9 | 5 | 3.9 | 104.5 | 1 | 64% (28/44): cap_reached 17, gave_up 11 | 9.9399 | 63% (10/16): stale_conflict 8, stale 1, no_improvement 1 | 3 / 2482 / 10624 / 3672 (20 attempts) | 74% | 71% |

cap_reached attempts: 17; their caps 0.50, 0.50, 0.50, 0.50, 0.50, 0.50, 0.50, 0.50, 0.50, 0.50, 0.50, 0.50, 0.50, 0.50, 0.50, 0.50, 0.50; last turn before the stop cost 0.208, 0.245, 0.199, 0.222, 0.262, 0.206, 0.230, 0.130, 0.298, 0.388, 0.309, 0.160, 0.285, 0.310, 0.361, 0.243, 0.307 USD
