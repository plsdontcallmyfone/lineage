A/B 2026-10-10T20:13:19.140Z: recipes minbpe at tip height 16, 3 rounds, cap 0.5 USD per attempt with 0.08 kept back, total 2.4173 USD

| arm | attempts | USD/attempt | submitted | accepted by replay | USD per accepted | author s per accepted | calls (mean) | output tokens (mean) | cache read share of input | ended with nothing (why) |
|---|---|---|---|---|---|---|---|---|---|---|
| A (high, projected) | 3 | 0.2653 | 1 | 1 | 0.7958 | 406 | 6.0 | 9189.3 | 88% | gave up 2 |
| B (high, bounded) | 3 | 0.3163 | 0 | 0 | n/a | n/a | 5.7 | 12075.3 | 87% | gave up 1, cap reached 2 |
| C (medium, bounded) | 3 | 0.2242 | 3 | 3 | 0.2242 | 118 | 6.3 | 6935.7 | 87% | none |
