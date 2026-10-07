# Devnet record

| Program | Id | Deployed | ProgramData bytes | Rent locked (SOL) | Upgrade authority |
|---|---|---|---|---|---|
| lineage_registry | `2vhj9aBZkuoCpmJxm5BcA3CYkvBJgY6VHTax8FpFmxuY` | 2026-10-07, sig `2eBTNxyf6MHEpvaJnbbttbDfTiBK6rRCCViAUee46DCbQ6MkPd6A27UjP7KfbQYWkrkFSgoqhWJqa3tyrGE78Rft` | 516,936 (exact) | 2.62691372 | `CVEZWyUBoNb6Zkte3qa7JDu5TBV4wTH6wMw4pLodnDih` |
| lineage_launch | `8eHzm1XtNtbxJujrMAci4VdhCJvQttFUBukmkFaUwsAT` | 2026-10-07, sig `21Xm2YztSGUhq38p3tmBSNMsWAzrCqLqRXF6XHQoAtMHSq9MrSQHEfoyNphcaaWBwNrrBGSRQmxMAJ9nYiU2hYMy` | 526,224 (exact) | 2.67409676 | `CVEZWyUBoNb6Zkte3qa7JDu5TBV4wTH6wMw4pLodnDih` |

- Binaries deployed: `lineage_registry.so` sha256 `14b534cc2165e9888426b8a9de0c4d3c7bd69cbe704715cfc7c9af086407c2b4`, `lineage_launch.so` sha256 `fae228465be7b037156e9efb960a009c4cb53db7b3fb53ba6b239a6a1b25a86b`; the registry dump from devnet hashes the same. 16/16 onchain tests passed against these exact files before deploy.
- Funding: 8.5 devnet SOL from the Instance devnet deployer `HzGbDTD7CR8pS2jDXadzwNxpAg2eM5sPfvFU8mtkacHB` (owner instruction, 2026-10-07), sig `3qQRaMbZCEgfQZnQuJV3R36sG8qu5XdStpTTUUCFFn1DfEqXGzBAqNSkKDnuDa16Pc58zH1qQEN9u9PpEr6xCSGQ`. Deployer balance after both deploys: 3.19212828 SOL.
- Exact `--max-len`: any upgrade that grows a program needs `solana program extend` first.
- Initialized 2026-10-07 by the devnet wiring lane (`scripts/devnet/setup.ts`), see below.

## Wiring (2026-10-07, devnet wiring lane)

Scripts: `scripts/devnet/setup.ts` (steps a to f, each idempotent and read back), `scripts/devnet/e2e-devnet.ts` (a short network with Core in chain mode), `scripts/devnet/record-fixtures.ts` (RPC fixtures for the Core tests). Public addresses: `scripts/devnet/devnet.json`. Keys: `~/.config/lineage/devnet/*.json` (mode 600), never in the repo. Nothing touched `solana config` or `~/.config/solana/id.json`.

| What | Address |
|---|---|
| TEST `$LINE` mint "Lineage Test LINE (TEST)", symbol tLINE, Token-2022 with metadata pointer and metadata, 6 decimals, 1,000,000,000 supply, mint authority revoked, no freeze authority | `3PLqpwWokAbpxZgBVLAzMAeLSvzfoDvjkhH9YydwVXmU` |
| Registry admin and launch admin (the deployer, for now) | `CVEZWyUBoNb6Zkte3qa7JDu5TBV4wTH6wMw4pLodnDih` |
| Core authority | `CjNUnQ3v2FRQJiMr16CfaFWCdzJ3nqq1VvY2zAgsc4j9` |
| Runtime authority / compute sink (its tLINE ATA) | `DCmdy5MoAfnN6fn3nVW27db62ZwtjoksqSqdjAc8VPk4` / `8fFdkfzJDMCBzhnfKUfdNeUimgr8QEBUYGoTPg5CYn44` |
| DBC config (fee claimer and leftover receiver = launch authority PDA; the suite's standard curve, TEST values) | `AEcaMdhK3PSqPDq2rrXZMoKsCPCTVTMdqJXaT34mWWGw` |
| TEST agent on https://github.com/karpathy/minbpe (hosted, identity app): agent / mint / launcher | `BFPxdave7NVSXztGEZA5iZ7FiBDKRsuZmS9wZn2J1WBV` / `3AvZ77ZdVPx7yxtqA4UP11DoaPdjdgP3AUbkSnidsmY4` / `9vsruXazhbaehi3DAF3sPk7SD2Wh26SXmj8Sp3HwJNnh` |
| Test trader | `4UwBL8x8sDsBKsZGDSAU1J2ed63UgsNG92bQonLSe1au` |
| Verifier owner (owns every test verifier) | `PsMbwtjM9Sh7A8VwYk1WuB4owg5Djr7EkL6aDiuqpvy` |
| Verifiers: test (setup step f), ref (reference runner, no bond), v1, v2 (bonded 5 tLINE each) | `FeGKtFj8U4ZnCRTuMBDMbhNqzsH3vZebuM1sisJFvfZ7`, `GiSibEMYzg3Y4EGG4QKx9drpTGC36du3XJE2dPZsHXuA`, `FRx89QoUEavL1mVMcroDH4QYUhdTbA66EthkX7uZrGSD`, `DEHFFWt2uzVGn43nzU1EvEyo17G1x74gvn3C6usU43hj` |

Registry parameters are `paramsFromNetworkJson(config/network.json, 6)`: register_burn 1 tLINE, min_bond 5, bond_cap 50, rebate_per_class 0.001, reserve/pool 8000/2000 bps. Launch: agent_compute_bps 7000, protocol_bps 3000, sleep 1 tLINE, wake 2 tLINE. All TEST values.

Fee split, read back from chain (exact):

| Crank | Partner fees claimed | Compute vault | Treasury | Check |
|---|---|---|---|---|
| setup step e, sig `4bVskzMW...` | 5,369,496,032 | +3,758,647,222 | +1,610,848,810 | floor(5,369,496,032 x 7000 / 10,000) = 3,758,647,222 |
| e2e run 1 | 1,034,009,525 | +723,806,667 | +310,202,858 | exact |
| e2e run 2 | 1,011,355,317 | +707,948,721 | +303,406,596 | exact |

Every `split` moved exactly floor(treasury x 8000 / 10,000) to the reserve and the rest to the pool.

Epochs posted and claimed (every leaf claimed, claimed = payable):

| Epoch | Posted by | Pool | Rebate | Leaves |
|---|---|---|---|---|
| 0 | setup step f (Core-format leaves built with `@lineage/protocol`) | 322,169,762 | 3,000 | verifier wallet 138,075,755; minbpe compute 184,097,007 |
| 1 | Core chain-mode bridge (e2e run 1) | 62,040,572 | 2,000 | minbpe compute 53,652,584; v1 and v2 wallets 4,194,994 each |
| 2 | Core chain-mode bridge (e2e run 2, 24/24 checks) | 60,681,320 | 2,000 | minbpe compute 51,749,337; v2 4,466,992; v1 4,466,991 |

SOL: the deployer went from 3.19212828 to 2.7353066 SOL (0.45682168 spent or moved: 0.1 to the launcher, 0.15 to the verifier owner, 0.1 to the Core authority, 0.05 to the trader, small top-ups, rent and fees). No SOL was taken from the Instance devnet deployer.

## Transactions (devnet wiring lane)

Every devnet transaction the scripts in `scripts/devnet/` sent, in order. Fee is the network fee in lamports as returned by the RPC.

| When (UTC) | Step | What | Fee | Signature |
|---|---|---|---|---|
| 2026-10-07 21:43:53 | a | create TEST $LINE mint 3PLqpwWokAbpxZgBVLAzMAeLSvzfoDvjkhH9YydwVXmU (Token-2022, metadata pointer + metadata, 6 decimals) | 10000 | `ph3VFq8emhaWy9756y5T9ffyUE6Fp3d6sUe5eedf52efEMdRgEetbkFka11WrjxFyQ55FsbPKKbMJQhcw1ngt9k` |
| 2026-10-07 21:43:55 | a | mint the full TEST supply 1000000000 tLINE to the deployer's ATA GRb3V2j6yBraHf39a7STArgGjVxBQ2c6WbvaHEYQMTPe | 5000 | `62ZaYP8a7p5enRUMQnueWgiMjEfcof3yv3uQWF19W2ecd3a3BxGbvBKJ4NJ2LE5A1dntvaZXxy2Cd4xQGcze2a5c` |
| 2026-10-07 21:43:56 | a | revoke the tLINE mint authority (fixed supply, as Pump.fun mints) | 5000 | `2EcjeBSMDuPxo7zMeCnpJhPbui51R344KaugBi8FYr9QFByb5iKouthU5TWPgqahe13nyVp5aVKdp9a3GN24jrXs` |
| 2026-10-07 21:44:06 | b | lineage_registry::initialize (admin = deployer, Core authority, params from config/network.json) | 5000 | `4TGRL9ayA2JVrVfbMyKQ8chy9rEqr6cxWLvsKS5gvRbdLorepY2mfuZiG8EZk6MKEH3NMapRmbSFtxK4rRhazf3` |
| 2026-10-07 21:44:08 | c | Meteora DBC create_config AEcaMdhK3PSqPDq2rrXZMoKsCPCTVTMdqJXaT34mWWGw (quote tLINE, fee claimer and leftover receiver = launch authority PDA, TEST curve) | 10000 | `2aJzpiFJUQhgei4pSWBJL5AXCKmNAPE8wk5vYMPnEg2aV4PehuVkWJ3iCapB54bkDNRZrK1qhLJ7YQtRqJ3sMwCu` |
| 2026-10-07 21:44:10 | d | create the compute sink 8fFdkfzJDMCBzhnfKUfdNeUimgr8QEBUYGoTPg5CYn44 (runtime authority's tLINE ATA) | 5000 | `3wabpRsbv5xEK21JGzFcUxKsNQVstXDsCSHPG9X6UvjAXZKBhCqkXS4cdbLUrKNYqmhwUKKMucNaK93BeEnkJ2jk` |
| 2026-10-07 21:44:12 | d | lineage_launch::initialize_launch (admin = deployer, runtime authority, 7000/3000 split, sleep/wake from network.json) | 5000 | `2w2o8p2WJr2TPefNKw92jMBb1nwfG3cqjT5SmW9pwWcw4pgFysyVPpHYxMAX5gokj35zQjjrtfLHYzebMcx7BEvg` |
| 2026-10-07 21:44:18 | e | fund launcher 9vsruXazhbaehi3DAF3sPk7SD2Wh26SXmj8Sp3HwJNnh with 0.100000000 SOL | 5000 | `kBHVp9QALCmQA5qNZssZ4ihi3RsMe4QqSD6qbJqg6yqrfzuRXJgU56LPFfjafH6MxVyBXPPFdTrGQ6HiZq1zm2o` |
| 2026-10-07 21:44:20 | e | launch_agent: TEST agent BFPxdave7NVSXztGEZA5iZ7FiBDKRsuZmS9wZn2J1WBV on https://github.com/karpathy/minbpe, agent mint 3AvZ77ZdVPx7yxtqA4UP11DoaPdjdgP3AUbkSnidsmY4 | 15000 | `m6i7TWPRyteP74E9EgikqYJ3fDNbeFHYwzCB9EA3EysyuAkzMA2naZAJVnZNB2CvBsonakNAX3Qvm6fYZHDy8Te` |
| 2026-10-07 21:44:23 | e | create the launch authority's agent-token ATA (crank prerequisite) | 5000 | `5BnUoBKrZ3sj9qUCSpHKsgQpLtqFHmSMcv4xTAY2JGiTJ4et49CW1LMKpBDT1QXGMbU7aKcnpXqTGUtW3NhvFecn` |
| 2026-10-07 21:44:25 | e | fund trader 4UwBL8x8sDsBKsZGDSAU1J2ed63UgsNG92bQonLSe1au with 0.050000000 SOL | 5000 | `DGYqf5ezK9PdksWsXpBHvyQYEDRogLz7sXi96RkAnUs6Xj153wP6zsWWRdFP22bpJDGJrHTVDdhybkN979Tb234` |
| 2026-10-07 21:44:27 | e | send 1000000 tLINE to trader 4UwBL8x8sDsBKsZGDSAU1J2ed63UgsNG92bQonLSe1au | 5000 | `2hjT5ZMEFfmvZf269sjawSTAWdi2wsjLPaDg81Z8RnhaMaLEhqndnx3gUpdQWmVz24YExLWy555g3JiXTCA5CzpA` |
| 2026-10-07 21:44:32 | e | create the trader's agent-token ATA | 5000 | `3BrWpNyWxj46sDaBzYqWnzwPWv6DFekbfx6Wjjb3ae2khxS9uZZsAN6vJWWieWYUJ2C3PiaKHXZGwkK41jHAKE2M` |
| 2026-10-07 21:44:34 | e | trade 1: trader buys with 100,000 tLINE on the DBC curve | 5000 | `22t5VJqUFFotAMBi2MqNyHeT9MGgWvAReRvGQgAnfXyQsMjVTJun1YzrG3pK7GBwAQcQfCKbfKpKvcBgrZmrVMpb` |
| 2026-10-07 21:44:36 | e | trade 2: trader buys with 50,000 tLINE | 5000 | `2sqnrJFfGaUwDi7ZnFwETzgZQfjrQVjUbGZtttKkwCtcuRngPkvt1KkRbFHr7oPLZ8WswjURgUuvGadcwBo1gsMT` |
| 2026-10-07 21:44:37 | e | trade 3: trader sells 1416359930641 agent-token base units (half) | 5000 | `pemem7Vi8A9bwKbDFTyZ2RqSjrJzuKj3uJwHUK9tL22wTVhMYiQfR58Smzf6fBkNZX8WGga3a6mVGSaoBTdx6Mw` |
| 2026-10-07 21:44:39 | e | crank_fees: claim 5369496032 partner fee base units and split them | 5000 | `4bVskzMWx4gR8A5f78T8rnktA3sA95mYgV1hMydw3vAHzaYtbv4WD7cXuB3YweZ1xiy9d2rLFpk2DYdwyLZsR6tn` |
| 2026-10-07 21:44:42 | e | split: treasury 1610848810 to reserve (8000 bps) and pool | 5000 | `3JBNFvTDymxvUBA2uRn39wVhZTPP16adjaPfKBuuQEfCMfMdEH2bLJcpNF8ZfuWkNif1Yvj24Y1fFrqvaBHXK44y` |
| 2026-10-07 21:44:50 | f | fund verifier owner PsMbwtjM9Sh7A8VwYk1WuB4owg5Djr7EkL6aDiuqpvy with 0.150000000 SOL | 5000 | `5K2zdP98SB3AUcEPjeJa262qwYcJgJkX8EmbdxomYsKHgabCDjbGqCd4ykrSyhNEKWTp4bjQ2nuE6aztesmBA8CA` |
| 2026-10-07 21:44:52 | f | fund Core authority CjNUnQ3v2FRQJiMr16CfaFWCdzJ3nqq1VvY2zAgsc4j9 with 0.100000000 SOL | 5000 | `rPYkGjhY1BgDgTc5TKWi4pMxEQkvxSRrVhYZvZZRxa4ZQYHZkFLi1w9XqJze2SBfzq9UL59GTu16erSqp6njEXn` |
| 2026-10-07 21:44:53 | f | send 6 tLINE to verifier owner PsMbwtjM9Sh7A8VwYk1WuB4owg5Djr7EkL6aDiuqpvy | 5000 | `5C5Eqz3RiJNbmxZZhBw1XWL7NbxndWG13Tzghu7Uqr48YkKxXTx51JQZ8HM76PeLPyLm26PsEQF74XmFvLEQ1UZp` |
| 2026-10-07 21:44:55 | f | register verifier FeGKtFj8U4ZnCRTuMBDMbhNqzsH3vZebuM1sisJFvfZ7 (owner PsMbwtjM9Sh7A8VwYk1WuB4owg5Djr7EkL6aDiuqpvy, burns 1000000 base units) | 10000 | `4JqQPxjpwcDDh1Er4UZ1FrcN3SDwLD5VjZ6dAVk1QCbQX21bnJ53F7tEr33Xd2QKCpHn8o43Q2qg3UokPqpvBZQP` |
| 2026-10-07 21:44:57 | f | bond 5000000 base units for FeGKtFj8U4ZnCRTuMBDMbhNqzsH3vZebuM1sisJFvfZ7 | 5000 | `35fS2MBU2Y2iueKRFdpR4M9XascUiDPzLso2u7KqyzgoZXhkEv7rby4FqWc7QwQh39jxVW1ygLTE27RUi5DpUcc1` |
| 2026-10-07 21:45:00 | f | post_epoch 0: payout root 16e4a836a76e7cde..., pool 322169762, rebate 3000 (2 leaves, Core format) | 5000 | `3wxq9uAjEB5ENH1UTLicikuaYWoXVyKHm7CZWknmAkPH5Mt77tq1Q3xm13LQyDYD5SDCj8Sxs5cDgHq5FVZcHjLb` |
| 2026-10-07 21:45:02 | f | claim epoch 0 leaf agent:BFPxdave7NVSXztGEZA5iZ7FiBDKRsuZmS9wZn2J1WBV:compute amount 184097007 | 5000 | `4D2BeXHbdg5bxEDNd4kHgrNXK1ekD5bwEPP6YqGAJfExsBmzGFM1wL4GA4oajA3RVwtXrFbQViRqq5m7QUgtbP8v` |
| 2026-10-07 21:45:04 | f | claim epoch 0 leaf agent:FeGKtFj8U4ZnCRTuMBDMbhNqzsH3vZebuM1sisJFvfZ7:wallet amount 138075755 | 5000 | `2J5vh3y9M1vA2PH8FopckXczgfbEzWrgizrvYWa167dTKWjFEuWCV8YtsFY8AUYaWbVkeBf2CcpTvAVyPuQ5hSHC` |
| 2026-10-07 21:45:12 | e | fund launcher 9vsruXazhbaehi3DAF3sPk7SD2Wh26SXmj8Sp3HwJNnh with 0.015315960 SOL | 5000 | `RG9qGcCH1mmofFsR4QVQs56UxCBcuZkJAUYFvE9kwWedCRLTCFNDANUetyLwAg51YwkDAgjEyRDKdzfNvdus6go` |
| 2026-10-07 21:45:21 | f | fund verifier owner PsMbwtjM9Sh7A8VwYk1WuB4owg5Djr7EkL6aDiuqpvy with 0.001930160 SOL | 5000 | `2jNeXYb5Er8gVS3aGE3v84kK26NuiKcWpjU897NDUcbKmkjT4VXqVghLEbqpDEdn2ETzBGfZE3BWsFLBiurRxPSD` |
| 2026-10-07 21:45:23 | f | fund Core authority CjNUnQ3v2FRQJiMr16CfaFWCdzJ3nqq1VvY2zAgsc4j9 with 0.001330880 SOL | 5000 | `27Hy5bUh5T25uzTAph3bVeidNzhzbroiJUYHK1MyAh6djLYtWaVEbNefNbTzqAEw9yQ7YnQRmGWds7YwAFFDhTWA` |
| 2026-10-07 21:54:32 | e2e | register verifier GiSibEMYzg3Y4EGG4QKx9drpTGC36du3XJE2dPZsHXuA (caps digest 820a82c1aabb...) | 10000 | `5px4uezH5XjUoD7rWoYmUEc5SHycdY1Eo8B4U7RRdaauwefvHAJjTobj9F6dm1S5vwpBqiZQfutLkE7VTHxc2K8o` |
| 2026-10-07 21:54:35 | e2e | register verifier FRx89QoUEavL1mVMcroDH4QYUhdTbA66EthkX7uZrGSD (caps digest 820a82c1aabb...) | 10000 | `2CP88ZihrfbeARcSKqBdYSN5uxNPdshKNanZ255eomUpHXUGyDbK4NWzGkSy5r4zNFYUhij2UKVK2qD6iz8Z3Q76` |
| 2026-10-07 21:54:37 | e2e | bond 5000000 base units for FRx89QoUEavL1mVMcroDH4QYUhdTbA66EthkX7uZrGSD | 5000 | `2ewBv3T7Uapic47ThkSnRzeK1EMXu92jcqEHNSDBmaNcMJHtUxuB8sgmb2DFYPTUoxfbC7hokHJ3usxNFBmugh19` |
| 2026-10-07 21:54:40 | e2e | register verifier DEHFFWt2uzVGn43nzU1EvEyo17G1x74gvn3C6usU43hj (caps digest 820a82c1aabb...) | 10000 | `3byED9YcrpNFQWRpGMi9g3HkPuVEJU4pZ8JKyAUtEHR1wWS4PuyY7wMDcyr7FdDGwRqzXR1w8f6ogvSYSkEQN6US` |
| 2026-10-07 21:54:42 | e2e | bond 5000000 base units for DEHFFWt2uzVGn43nzU1EvEyo17G1x74gvn3C6usU43hj | 5000 | `5mEPK5eoASAwc8N5ThMkpYRYuVw8a83KZj5JjzQJs7FaL4a9A7SLqhaeU7RhvfiJao6Rs3yyL5yn3hrNRhzr6vEd` |
| 2026-10-07 21:54:44 | e2e | trade: trader buys with 20,000 tLINE | 5000 | `4MP9Zv5AMYoMzeaFMAuSaegT8dp4a4bFpn3EXJLrewHwNuRN3aA3CKfhRcs6g74ruYtGd1zy9F1En7AqM5mp3RXa` |
| 2026-10-07 21:54:46 | e2e | trade: trader sells 448193324905 agent-token base units | 5000 | `CMFZncB2WHmqvk7PvXPx1M17Foh4gxX6kTVHMECbxNaoesseHcjiKYUC8rx9hCWYJQgHyqc6PXHXUNb3soW3USs` |
| 2026-10-07 21:54:48 | e2e | crank_fees: 1034009525 partner fee base units | 5000 | `2uUBPPhWu29nAwSPVi7ot46UJM7CK2EPjdBCbgQuYxQEXv7iYLmVzJxaYd71H47S8bA7jXFxbrLd66ytPg1b4igK` |
| 2026-10-07 21:54:50 | e2e | split: treasury 310202858 to reserve and pool | 5000 | `zWiFaBobG8Z5QV5JXxEqcfscez6cdwYBgkRN6c5EquZCbE6pQKxgLc1TXc9xeLLtnD7hJrbruCvLiwWfNcqi3he` |
| 2026-10-07 21:58:52 | e2e | Core bridge post_epoch 1 (root 0cd50b55cf04324a...) | 5000 | `4hSyRu7uwvevqvVxtHAY52VMF1648S97y3JjuG4vKGwYQ2D2HfyvuTEK93oSU4jLxKkcESLLShioh9KD7GBfiKtr` |
| 2026-10-07 21:58:54 | e2e | claim epoch 1 agent:BFPxdave7NVSXztGEZA5iZ7FiBDKRsuZmS9wZn2J1WBV:compute 53652584 | 5000 | `4s1UR3konA3mvmm2b66NNbWbaqqGesa7XmbJ4Q3bK8EKRV1VK1bLB8iNVGs3F1NcxvNSawob5ozzsaoiX52dRy7m` |
| 2026-10-07 21:58:56 | e2e | claim epoch 1 agent:DEHFFWt2uzVGn43nzU1EvEyo17G1x74gvn3C6usU43hj:wallet 4194994 | 5000 | `5L8HttMh2nPdbYyJPzkmpZpDgS4fcpzbJxx2xGX6ZnCR7Fow7K5i5DKT15oaCdJVYzuE3CuUzPWATx1siBCNxFB3` |
| 2026-10-07 21:59:02 | e2e | claim epoch 1 agent:FRx89QoUEavL1mVMcroDH4QYUhdTbA66EthkX7uZrGSD:wallet 4194994 | 5000 | `3xukmQfM1XoBaRgethz6ETehbBCnFEgxEEqtK3pP4dyoKfz1KQ25rzwPWcocWU73SpZwfebTPNHNu3MtNefRBnYR` |
| 2026-10-07 21:59:25 | e2e | trade: trader buys with 20,000 tLINE | 5000 | `2YbH2WTqZSCSckZZUciLMsDyQoERFwd6igdHC93GB4kiiMh6Rxy8zAbhjm8bAbCXAW7LjxmkU1S5iAsXa7DBBpD8` |
| 2026-10-07 21:59:27 | e2e | trade: trader sells 430376505469 agent-token base units | 5000 | `666Au5Z5f6Xuf3R6cBxPsDYhSkdkyN9sFc8cieXp79W8zKpypWY25ZXgjD3e2TsWgossmgEBRFjn9dWdNpPFhcm9` |
| 2026-10-07 21:59:28 | e2e | crank_fees: 1011355317 partner fee base units | 5000 | `4wDG77tgWLdcpjdqWqSQeAw4FaMMW3kQ9P5ScH9vmpNFf14KGX39zkUKzbcUkrEP5jpjFCno2wDiH587izQGGRdU` |
| 2026-10-07 21:59:30 | e2e | split: treasury 303406596 to reserve and pool | 5000 | `49fVm3LkPD1qvdjKqJFwgsPJxTurfxre4yYhcyoeWiiJJsEBUbYUfL4wKp4fUnsANCsAT7w3BXai6mDTNXCZVjXQ` |
| 2026-10-07 22:03:46 | e2e | Core bridge post_epoch 2 (root 7b03830a208adcb1...) | 5000 | `3LmNt6qe14uYp8zBf4LbQ3A2Utj17hj7XiGy6x35Kkr9UmxLhW3g3uhUHg4FwaL9UjgCCZrbrhn4zcRgkvcS2oUW` |
| 2026-10-07 22:03:48 | e2e | claim epoch 2 agent:BFPxdave7NVSXztGEZA5iZ7FiBDKRsuZmS9wZn2J1WBV:compute 51749337 | 5000 | `5q6L4H22NtGCPpme94QsDywa6d5mv6stHR2wCXLM6KarQ5BxQBkqyX3CuLLPinENxM4LvNa1DVRJruKc9Bixr4Bc` |
| 2026-10-07 22:03:58 | e2e | claim epoch 2 agent:DEHFFWt2uzVGn43nzU1EvEyo17G1x74gvn3C6usU43hj:wallet 4466992 | 5000 | `T7H8YKx3oYwR5oMJLGTafk3CqERrYokEH6kVBHWhNdMhwhkeHXnRCLvWK9Kp5T6tWXzfn2dnfJGee2MoQK8rTrj` |
| 2026-10-07 22:04:00 | e2e | claim epoch 2 agent:FRx89QoUEavL1mVMcroDH4QYUhdTbA66EthkX7uZrGSD:wallet 4466991 | 5000 | `5Cz9mCYsi6q2avx3GmrtecP6z6SDov2tRT6M2pt8NHXvcwb2DeaL86Sj5y3Y3CPFLUGka5cRs9B3N5CXBitG3oYk` |

## Transactions (wallet UI lane)

Devnet transactions sent by the Wallet page (apps/web/wallet) and its tooling: the faucet funding, the faucet's drips, and the headless browser check (apps/web/scripts/wallet-e2e.ts) driving the page with a mock Wallet Standard wallet that signs with a local devnet test key. Fee in lamports as returned by the RPC.

| When (UTC) | Step | What | Fee | Signature |
|---|---|---|---|---|
| 2026-10-07 22:21:50 | faucet | fund faucet FX4UjRbmbLHJ6K6RTvYcV4bFA9Yai2qntnPNex31GiH6 with 0.2 SOL from the deployer | 5000 | `2CpYyfSRnK73Pih2a8xoYdTeV2nocxfbBSDMkk4Nsm4pQ9JoZy6PsaKtsKyiVN97XV55VpdFGpKxaMRnAvoS8CQc` |
| 2026-10-07 22:21:52 | faucet | send 100000 tLINE from the supply holder GRb3V2j6yBraHf39a7STArgGjVxBQ2c6WbvaHEYQMTPe to the faucet's account BbVHisiXiCgKBh1K3gmDj7fKWc6H8Nm72rVxWpyzvVrb | 5000 | `3sWzW5hUmpSkKREZYexPipJvjwpsZYyvxaZVmApur9iDTMdmnoGU3thZF9hmynGsc691Vt4TXT4tFvjsn353Fv8k` |
| 2026-10-07 22:24:27 | e2e | fund the test wallet 8juHDv3a67114S8JTjCwUGQkrZqjkw9Mac5fneSBsQi2 with 0.15 SOL from the deployer | 5000 | `6391kWYbYMuwc952JaAhBKWNc8Ykbk1c54ZAFwf9C2Qr26q7oS3GksZXMN7xhzYWZR3Phefs8sfK1b72mvy5BPSr` |
| 2026-10-07 22:25:46 | e2e | page: faucet: 1,000 tLINE to you | 5000 | `s1BuDJeyYdmNexAdGA7bbKicm8qrfYaQzWKXZgFyNv4LywnCotAxqtK22Qt3bdtc2wLQEPqYNGjQiewCmnTXTVX` |
| 2026-10-07 22:25:46 | e2e | page: launch_agent TUICHECK10 (mint 9BaWSDCs3Hqz6hjEcrVWQyPgsQ4onTMG29wLLsdrtW6S) | 15001 | `3vYwNvgh3gKs5R99reb4BjECTc8GG25NDEYXxAncpKbpqVDS1D1qfCERYAVbFjo17TsZYh6bnSkDcWFbpnnFFWcT` |
| 2026-10-07 22:25:46 | e2e | page: buy TUICHECK10 on DBC | 5001 | `281pV1T21oZHWSUoX1mphv8JbjHbeyBhnxVyUew7JUZrepkVtJJmc529RJdHmJop2S6pZKD5aYo8uFbcHJMppSVc` |
| 2026-10-07 22:25:46 | e2e | page: crank_fees TUICHECK10 | 5001 | `3bHGbWaDW9bnXWSnnJywYh4KNnJZ3JCvv7yd8fzEoVi7egQho59wvM75LTbV5pQFk4JyT8iSSnKBqiwNMSdsasXs` |
| 2026-10-07 22:25:47 | e2e | page: bond 5 tLINE | 5001 | `4HP13honwrd1aXqih8DFWBpfKoY6rTCFomdU3MN5iiAShFvdf7viujHA15gnP1wrhNRqh9AxZiZWkR6opiiXExPB` |
| 2026-10-07 22:25:47 | e2e | page: request_unbond 1 tLINE | 5001 | `4YV7gfE3vG1a323hD3H7wqzjFVwr2omPaPSuamvo8ybXgASLxhP94WBKPr85im3Pxe2pcNGYq1hGoHcw9h9UvUZ4` |
| 2026-10-07 22:25:47 | e2e | register verifier H9AKH5K79DWfwBQLRe8xv83u4pXgLdRfnzDjpkj3ihvk (owner = test wallet; agent key co-signed by lineage-worker cosign) | 10001 | `2gzu6ALzD6ojvtTJdrajYYv9eG1DJzmjk9Zeo38vq7ZzG41pcFyqfU7ahe63zXs5dcevDDujT744j14wvvEitfKo` |
| 2026-10-07 22:29:55 | e2e | page: launch_agent TUICHECK10 (mint CzfBa9Wme8BhF3d3HAP5gnNCFKjjvfFcHt4Pkh49E8Dy) | 15001 | `4w7r7i87jHjLk12nCnXzepERqVXyWEzyZ2nWW4Sv5oFhX4wYhnuBUUoB3ynfKHA6N7cMwBWVwYRtGudwAgxep1yD` |
| 2026-10-07 22:29:55 | e2e | page: buy TUICHECK10 on DBC | 5001 | `izsAFrSYMdcaqCp85EKmmBc8Hx4eqbjc67Rf8JPxSGEGjHGjFNQcHQ4cBNPMUYjLB8x78VrKm9Lsai8cQEAxY1d` |
| 2026-10-07 22:29:55 | e2e | page: crank_fees TUICHECK10 | 5001 | `2vDGrL8BXmxLdqsSapfKqRfCdgBjdy6pgEBZ85enU4rGbbCZw38ykaiACFjZ9csEdNrhuo3CJEUeZQ2XFGH4SJpe` |
| 2026-10-07 22:29:55 | e2e | page: register G4N8…ddaZ (sent by lineage-worker cosign) | 10001 | `2nUKYXzSoh5RsHsbixC1TCYtxujuYXzE47xvRK3MBVBvfnj5piCyQpAwimnJK41jgd2R2wZrWB6zBw3nKSrD2yBb` |
| 2026-10-07 22:29:55 | e2e | page: bond 5 tLINE | 5001 | `5TakP81Hfs8DZPWP9NBqqDTF4x5UB7zKSDif7T76pXercPCQFYE6krNos1YLcYDvBXXesdbuuyJ1RXB3on4B1mPT` |
| 2026-10-07 22:30:15 | e2e | fund the test wallet 8juHDv3a67114S8JTjCwUGQkrZqjkw9Mac5fneSBsQi2 with 0.040796131 SOL from the deployer | 5000 | `3KM5eZ9PWWWEQTczcbvtYze8iJmnB2cnBC5taEPEhzwBJ3M9zjGbnyDcZZEHC3pfWcr2QVP79ZFWLyWoVyJVsK2R` |
| 2026-10-07 22:32:01 | e2e | page: launch_agent TUICHECK10 (mint D4ymaHFULQnd1NWdoappnXrsdZy8ihbLqatkM5fkFtVE) | 15001 | `3hKvnWiouptXFWVAWSDhRdxx1Z9su1JDLecA6HxQYEYxn8owbZNTPAJMf4YUfHHhkQTgrCsRPhHQEMmt3RGhR4E9` |
| 2026-10-07 22:32:01 | e2e | page: buy TUICHECK10 on DBC | 5001 | `g1u7hMf5HufsKWKiogYRknNw5MY5h4EZvsMNZMvCzxznBuFxsEs27PRrF1rdAPpZdEKzhpXz2cXLkwyH6quYJnZ` |
| 2026-10-07 22:32:02 | e2e | page: crank_fees TUICHECK10 | 5001 | `27r25gppWHpRCpHzGBeHT8K3wCGpbZo1V2qoYHuxfR47TwJA47C4qL8XNbBLLf93KXscxfZP5hLrVPzZ45S3JErw` |
| 2026-10-07 22:32:02 | e2e | page: register Ei54…fvho (sent by lineage-worker cosign) | 10001 | `4P6ZufazAQKxPPsQRiQacpqoKYcbtg7XCD8oUzv5uz9vzbRAPYD9uEJxt17QPWKCoT7Y8EWhfGk7RNVJvE2fjue6` |
| 2026-10-07 22:32:02 | e2e | page: bond 5 tLINE | 5001 | `2F3a1vp6XFUj4n5BGepVpg3MzKM5ZsUtD7ZxNAiAYjfAiTxJ6H3axaRTEUGrsHEKqWgw7L3gNNsdT92crfgk5bxS` |
| 2026-10-07 22:32:02 | e2e | page: request_unbond 1 tLINE | 5001 | `3awnAmwVj1wtaX4WFckvz1dEZywnLtbpWJQiuSPvYAMfFBAcQHuwTtYwEjkgDTsfXP5i31wyZWXHSNAmyVdmuz8D` |
| 2026-10-07 22:32:02 | e2e | page: claim epoch 3 wallet | 5001 | `DgpvEHxYbXcBR92Tb6aN54kK86AytMdngJMkSu49XBddTHSDkD2DfuBkutFVZSkEJUxJtrRF14YvmWFQxXXHGj3` |
| 2026-10-07 22:32:02 | e2e | split: treasury 4320000 to reserve and pool (test wallet pays the fee) | 5000 | `3hjp6gEoZETc2fA3zF4H4679tf9XuSy1J23UScnKuANMMD3PfUyWt1eBMEBV5tgD9kP3N5oJ24wZQEnfVesNF8zU` |
| 2026-10-07 22:32:03 | e2e | post_epoch 3 (test epoch for the Claims tab: one leaf agent:Ei54yY7HarLLPENujpF63yCsfwZeBDVjeuC9tp9kfvho:wallet amount 864000, root 5c9681ee83d44fbd...) | 5000 | `43RJ7AwceecRZioSWSHCCWBbKa82euM7ofBD5RTq61aTm6mjMJSBDfndwmRU2iznHkrQFar2xQFR1bwBZQStYrHN` |
