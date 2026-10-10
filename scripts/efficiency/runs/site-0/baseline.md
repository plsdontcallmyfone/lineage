attempts 49, started 2026-10-09T22:23:56.000Z to 2026-10-10T19:14:44.000Z

Per agent and model:
| group | attempts | USD/attempt | attempts/accepted | USD/accepted | min/accepted | model calls (median) | min/attempt (median) | sandbox s (median) | evals (median) | ended with nothing (why) | USD on nothing | candidates rejected (why) | in / out / cache read / cache write tokens per turn | cache hit | output share of USD |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 5iCWSo claude-opus-5-5 | 6 | 0.2747 | 1.20 | 0.3296 | 3.4 | 5 | 3.0 | 69.5 | 1 | 17% (1/6): cap_reached 1 | 0.2361 | 0% (0/5) | 2 / 1420 / 9700 / 3344 (5 attempts) | 74% | 60% |
| 5t9wKL claude-opus-5-5 | 2 | 0.3899 | 2.00 | 0.7798 | 9.4 | 6 | 4.7 | 125.5 | 1 | 50% (1/2): cap_reached 1 | 0.3761 | 0% (0/1) | 2 / 1867 / 18949 / 1866 (1 attempts) | 91% | 74% |
| 5t9wKL unknown | 1 | 0.4690 | n/a | n/a | n/a | 10 | 6.6 | 253 | 2 | 100% (1/1): cap_reached 1 | 0.4690 | n/a | n/a | n/a | n/a |
| 63JTud claude-opus-5-5 | 5 | 0.3565 | 5.00 | 1.7823 | 18.4 | 6 | 3.7 | 122 | 1 | 60% (3/5): cap_reached 3 | 1.1786 | 50% (1/2): stale_conflict 1 | 2 / 872 / 15792 / 3926 (2 attempts) | 80% | 43% |
| 63JTud unknown | 1 | 0.4041 | n/a | n/a | n/a | 7 | 5.0 | 125 | 1 | 100% (1/1): cap_reached 1 | 0.4041 | n/a | n/a | n/a | n/a |
| 6C8N2z claude-opus-5-5 | 23 | 0.3151 | 2.56 | 0.8053 | 10.2 | 5 | 3.6 | 152 | 1 | 35% (8/23): cap_reached 8 | 3.7798 | 40% (6/15): stale_conflict 6 | 2 / 988 / 10597 / 3002 (15 attempts) | 78% | 54% |
| 6C8N2z unknown | 4 | 0.2584 | n/a | n/a | n/a | 3 | 1.7 | 0 | 0 | 100% (4/4): cap_reached 4 | 1.0335 | n/a | n/a | n/a | n/a |
| BFPxda claude-opus-5-5 | 4 | 0.4329 | 4.00 | 1.7317 | 18.4 | 6.5 | 4.9 | 153.5 | 1 | 75% (3/4): cap_reached 2, gave_up 1 | 1.3492 | 0% (0/1) | 3 / 1446 / 14732 / 4552 (1 attempts) | 76% | 53% |
| BFPxda unknown | 1 | 0.5437 | n/a | n/a | n/a | 6 | 5.6 | 128 | 1 | 100% (1/1): cap_reached 1 | 0.5437 | n/a | n/a | n/a | n/a |
| CLy55w claude-opus-5-5 | 2 | 0.2817 | 2.00 | 0.5633 | 6.9 | 3.5 | 3.5 | 92 | 1 | 0% (0/2) | 0.0000 | 50% (1/2): stale_conflict 1 | 3 / 2105 / 5904 / 3859 (2 attempts) | 60% | 67% |

Per model:
| group | attempts | USD/attempt | attempts/accepted | USD/accepted | min/accepted | model calls (median) | min/attempt (median) | sandbox s (median) | evals (median) | ended with nothing (why) | USD on nothing | candidates rejected (why) | in / out / cache read / cache write tokens per turn | cache hit | output share of USD |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| claude-opus-5-5 | 42 | 0.3275 | 2.33 | 0.7641 | 9.0 | 5.5 | 3.6 | 135 | 1 | 38% (16/42): cap_reached 15, gave_up 1 | 6.9198 | 31% (8/26): stale_conflict 8 | 2 / 1181 / 11238 / 3208 (26 attempts) | 78% | 56% |
| unknown | 7 | 0.3500 | n/a | n/a | n/a | 4 | 2.3 | 0 | 0 | 100% (7/7): cap_reached 7 | 2.4503 | n/a | n/a | n/a | n/a |

All:
| group | attempts | USD/attempt | attempts/accepted | USD/accepted | min/accepted | model calls (median) | min/attempt (median) | sandbox s (median) | evals (median) | ended with nothing (why) | USD on nothing | candidates rejected (why) | in / out / cache read / cache write tokens per turn | cache hit | output share of USD |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| all | 49 | 0.3307 | 2.72 | 0.9002 | 10.4 | 5 | 3.6 | 128 | 1 | 47% (23/49): cap_reached 22, gave_up 1 | 9.3701 | 31% (8/26): stale_conflict 8 | 2 / 1181 / 11238 / 3208 (26 attempts) | 78% | 56% |

cap_reached attempts: 22; their caps 0.36, 0.14, 0.17, 0.50, 0.50, 0.50, 0.50, 0.50, 0.50, 0.50, 0.50, 0.50, 0.50, 0.50, 0.50, 0.50, 0.50, 0.50, 0.27, 0.50, 0.50, 0.50; last turn before the stop cost 0.207, 0.117, 0.262, 0.138, 0.263, 0.300, 0.026, 0.292, 0.199, 0.050, 0.309, 0.172, 0.198, 0.144, 0.191, 0.100, 0.287, 0.318, 0.088, 0.151, 0.126, 0.293 USD
