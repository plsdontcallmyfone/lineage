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

## Review-fix upgrade (2026-10-07, onchain fixes lane)

Both programs upgraded in place with the fixes of the adversarial review (`onchain/README.md`, "Review fixes"), then both configs migrated to the new layout and every script rerun. Nothing touched `solana config` or `~/.config/solana/id.json`; every command passed `-u devnet -k ~/.config/lineage/devnet-deployer.json`.

| Program | `.so` bytes | sha256 (built and dumped from devnet: equal) | Extended by | Extend sig | Upgrade sig |
|---|---|---|---|---|---|
| lineage_registry | 543,408 (was 516,936) | `1e64323fbe379a97e7761aa9f43a132628addbe92a53e41178a7ddd268a9cc2c` | 26,472 bytes (0.13447776 SOL rent) | `5a21s7kuLNkPMvc1uUubMfzXiLWrgsFm9pk2dBAKr42q9JMkb7BcHsUuHavAto9N16E6QBZnpcVXTNv5K182Z78h` | `5wTu997HkKu8MJEQZWxYUqRg9W2bmT32rpDirfjeL3v8NaTYuWUrRTchh3Yyd67cFdNyFKC4oNsjUCVgaBN42DDZ` |
| lineage_launch | 563,864 (was 526,224) | `847af59104b16cabc224a04215a5964c36ab86c8761abc2252d065b424be14da` | 37,640 bytes (0.1912112 SOL rent) | `36WZ69XgPRVfyeeSAkeYBqv25J8cFisVu2q47cdmcRARDkUoqVSKun7aMp4qT4G43rcoVu5AV3TcVB3sYvMBDwpC` | `4fjkidbt7WFaCd4pvWnNtgr74TeFi9mv8s3RCQhqNLqji9kXu1DsXE3PspBULuP3D4jjUs5zLUm7sk3qhW1PGEw3` |

- Funding: 1.5 devnet SOL from the Instance devnet deployer `HzGbDTD7CR8pS2jDXadzwNxpAg2eM5sPfvFU8mtkacHB` (owner approval: at most 6 SOL, keeping it above 24), sig `5QN3HTj1PcDnmFd2nTHuciPE4CGQ9HRBq9UZLoAf3wfmfUzUmDt4teMLsU9Edr787wCDjPJmo2UkWemcFpQsQo45`; it held 30.056413579 SOL before and 28.556408579 after. Measured need: 0.326 SOL extend rent plus a 2.865 SOL launch buffer at once against 2.343 SOL in the deployer. Deployer: 2.342976629 before, 3.507496109 SOL after the upgrade, migration and e2e run.
- Layout migration (no re-initialization; every PDA kept): `migrate_config` (Config +24 bytes: `max_rebate_per_epoch` 1 tLINE TEST, epoch anchor = last posted epoch 3 at the migration time), `set_config` (`epoch_length_s` 300 TEST so the new floor `unbond_cooldown_s >= 2 x epoch_length_s` holds with 600; Core keeps its own epoch timing), `migrate_launch_config` (LaunchConfig +40 bytes: `max_debit_per_epoch` 1,000 tLINE TEST, usage sequence empty).
- `scripts/devnet/setup.ts`: all checks pass, then idempotent on a second run (no transaction). `scripts/devnet/e2e-devnet.ts`: 24/24 checks (Core in chain mode posted epoch 4 under the new sequence and clock rules, every leaf claimed and mirrored); a first run stopped on public RPC rate limiting (HTTP 429) after its trades, rows below.

| When (UTC) | Step | What | Fee | Signature |
|---|---|---|---|---|

| 2026-10-07 23:47:30 | b | lineage_registry::migrate_config (grow Config to the review-fix layout, max_rebate_per_epoch 1000000) | 5000 | `35sD592UU9sK9SURsSv4cUFQSHmo7oXrSruSZQkCkLiekxmrFAQZS6gN6xTMp9BycqQUeHegyJf8BBz8epaVxBnu` |
| 2026-10-07 23:47:32 | b | lineage_registry::set_config (params: epoch_length_s 300 so unbond_cooldown_s 600 meets the 2-epoch floor; rebate cap) | 5000 | `Zd4Ehpas1orAhNdoGNQS16NERJtMcMUtLbPDwrY5WhMX3XWv8sq52rBUAz1eE3zvgcqDocBJJqLV7ptvoaVBSxa` |
| 2026-10-07 23:47:42 | d | lineage_launch::migrate_launch_config (grow LaunchConfig to the review-fix layout, max_debit_per_epoch 1000000000) | 5000 | `3QJBh51YKnXxwsF3hgQuwn8uezxSDJxbzsC6P7mKSWvYxMmQCpWH3PGYYNFvwQinzC3wRSDKVkPPBEVeKDjMMGdZ` |
| 2026-10-07 23:48:27 | e2e | trade: trader buys with 20,000 tLINE | 5000 | `4vk49M9HG3bnaRnRs7jDdGfKvVBkiomX1QeiZkc35vt2srMUaCZSG88AcQi7W8kknGNYteCuqBr4pSwniiF4UXkn` |
| 2026-10-07 23:48:28 | e2e | trade: trader sells 417109387931 agent-token base units | 5000 | `3tbAjYVAZGS4CEiNXL8W3er9J62xFDftKNC1T6iYrXW7ZwXV5jbf2VTPYULJBfgHJqb4hfCcpA4Hb8NnLs3Hbp9J` |
| 2026-10-07 23:48:30 | e2e | crank_fees: 994520729 partner fee base units | 5000 | `Tpa8QPVeYiKwC9ujpjSL8fZLFoXHPFithDQjQv2QTLYxDRqtonjzN7CLP2h1r6pJSuGvZSCnZX4C1EUhCooiBSn` |
| 2026-10-07 23:48:32 | e2e | split: treasury 298356219 to reserve and pool | 5000 | `2Jf2UMzkD9iW74eQBrpPkUFFmcnhYriiT6E57nsVr8r3aNGraEGcwrufoanVx6rV2itpinko74Wi3LRoz6in3B1Y` |
| 2026-10-07 23:59:41 | e2e | trade: trader buys with 20,000 tLINE | 5000 | `4aU6xRWFBBuPZywgUzGvXrrg1ZPshK1snTkbVfXTYUUaWbEmDXTQHfisd6opBTtmYdZfGVaGwY78BYNA1QmCjL4k` |
| 2026-10-07 23:59:47 | e2e | trade: trader sells 407230192002 agent-token base units | 5000 | `3qwig1zKRwHyRhN5WR514LdHkxhVR5SCBBRQsXMXZWz7CKmSG7AmnQoiiZrnMLe76W3jALzH1ftF3xjpGVxVciF7` |
| 2026-10-07 23:59:49 | e2e | crank_fees: 982004231 partner fee base units | 5000 | `2Xn7P4HRPF8aYmrFz9fbzix4eWNBqoE3JT5jAapmHWL1a6fD3vQd1TYARuFx5HyK7BSCjXURg89wLTpAJUsGL6bz` |
| 2026-10-07 23:59:51 | e2e | split: treasury 294601270 to reserve and pool | 5000 | `57j2J8oqbWUmPP1EhsaZp1hTFA737R7VLZHCFkMVarkD2pyec1wuSsTWEhBWKxyi1BvA8euhGRFjWJNqSEeEk6Dw` |
| 2026-10-08 00:05:34 | e2e | Core bridge post_epoch 4 (root b6e783636f15d143...) | 5000 | `5ZSyTZk91ABntGCdb3AAaHb5JZkSDgP2DW8nR6QH7agAntJsMsWKe5BHpuy3N8QX3YSukCtE3pAQj7VM1nbqQPyi` |
| 2026-10-08 00:05:36 | e2e | claim epoch 4 agent:BFPxdave7NVSXztGEZA5iZ7FiBDKRsuZmS9wZn2J1WBV:compute 101676865 | 5000 | `5HCSwQMP5phtVy3CoviVHizzfFnLuZkwJFfE8DfBrBiZeb9VrkgVYW4Qxdo7QFkUdg2GSh1Z3oeWkR2Shy3bTSY9` |
| 2026-10-08 00:05:45 | e2e | claim epoch 4 agent:DEHFFWt2uzVGn43nzU1EvEyo17G1x74gvn3C6usU43hj:wallet 8458317 | 5000 | `3CrtcqgeeR72W5FF3QjEGwPkngnPqpsp8BWQ4Sc5WgVUwMisoVTh7ANYfWT2fcb5b68PMKqLqLhTKJXvPqvBUZef` |
| 2026-10-08 00:05:53 | e2e | claim epoch 4 agent:FRx89QoUEavL1mVMcroDH4QYUhdTbA66EthkX7uZrGSD:wallet 8458316 | 5000 | `3A5FGqBhJuyc21uvQhVD85cfxbxxuQUFUoMUo89bi8iGU5m5sUFkJEU54Dj7kB9yKnjU2APuMttdWVtHQPwjDYLd` |
| 2026-10-08 00:09:21 | e2e | page: launch_agent TUICHECK10 (mint FVA6uBsMKRxuTzEgVeanFsRzo2D4yTNdyKs6LjMzPhre) | 15001 | `3XTn4Kqk4F8jQnD82mPjzEMVcKUsu4aZq7n3kqnfPWifvGLrZQ5p35dpWjaT4wJ6CJFuFmTZHkcn8p3FUrsVG6FC` |

## Identity upgrade (2026-10-07, identity onchain lane)

`lineage_registry` upgraded in place with Agent v2 and `Epoch.record_root` (identity plan I1 and I2: `rotate_agent_key`, `revoke_agent_key`, `set_profile`, `propose_owner`, `accept_owner`, `migrate_agent`, `migrate_epoch`, `post_epoch` with a record root). `lineage_launch` is unchanged (its deployed build is the one the LiteSVM suites load). Every command passed `-u devnet -k ~/.config/lineage/devnet-deployer.json`; nothing touched `solana config` or `~/.config/solana/id.json`; no SOL was taken from the Instance deployer.

| Program | `.so` bytes | sha256 (built and dumped from devnet: equal) | Extended by | Extend sig | Upgrade sig |
|---|---|---|---|---|---|
| lineage_registry | 585,784 (was 543,408) | `030766bc96432131c634437e74f598b1df43a4f79a8caccd1586204ee83822aa` | 42,376 bytes (0.21592032 SOL rent, `solana rent -u devnet 42376`) | `48eLNkkhmAhkPB9fMUv3UDavozit2Rk7xiet4A8uhsfgNckQiFWb49uh8VX5BsDz45m8GvY29NVKqCdXToRmUvPg` | `xg8gCUPJggASFa45A51Fg42P6EnNNnHNjew785P915FUGGpokXioccNk7F1yPucdDWkuDLjfn4xJVVfrQkRL8Zw` |

- Measured before: deployer 3.507496109 SOL; need at once 0.21592032 (extend) + 2.97662092 (buffer for 585,821 bytes, `solana rent -u devnet 585821`) + write fees. After extend and upgrade: 3.289311029 SOL (0.21818508 spent: extend rent plus fees; the buffer was closed back to the deployer).
- 34/34 LiteSVM tests (7 new in `tests/tests/identity.rs`) passed against this exact `.so` and the deployed `lineage_launch.so` before the upgrade.

| When (UTC) | Step | What | Fee | Signature |
|---|---|---|---|---|
| 2026-10-08 01:50:34 | g | migrate_agent AeDRJoR6kyYUzpj6nweTHFw82C89LdxLTFww9SWpWQmT (Agent v2: signing_key = agent key, owner_since = registered_at) | 5000 | `4ij8YWCy8VyfKhrm1Ht7mLrvxHAytGbzkRMoc2kWcutuww5wPKeVZaJwR75Lrq7gAww1tDyK5ow7TaAiQQjDHVdx` |
| 2026-10-08 01:50:36 | g | migrate_agent Ei54yY7HarLLPENujpF63yCsfwZeBDVjeuC9tp9kfvho (Agent v2: signing_key = agent key, owner_since = registered_at) | 5000 | `dEdzpWHBiHtkTezbnsp1ZuBQKvWUWfE9GzMLCvjE1knEVTtE4rzwxbMv49HgJ6ZxmK6DbdhyrPvYZz4EckhHXaw` |
| 2026-10-08 01:51:23 | g | migrate_agent DEHFFWt2uzVGn43nzU1EvEyo17G1x74gvn3C6usU43hj (Agent v2: signing_key = agent key, owner_since = registered_at) | 5000 | `565nMWavMMTM4ShNJXwXRZ6E5QaceUWzkA7SicB2ray5CPjXYXzMRpRV1x6B9mY9hpE6GgqyRmMSricRbeinETp4` |
| 2026-10-08 01:51:25 | g | migrate_agent 3JPHYWGc6SSmJR5rdrMLiNFWjCSrjaA5bjZGkyQw2YZd (Agent v2: signing_key = agent key, owner_since = registered_at) | 5000 | `MwPfVEFUJMiQJJRnPvuxVq49n6tEbLQq8sZSLys6sQFZW4r11PKAEgu9p34yjtP1PcAV2L8F7aWBTbsAa5vpGqa` |
| 2026-10-08 01:51:42 | g | migrate_agent 6mM4qSbAAGwLQ9RhwJvSZsY1MAZPSkeeC1PfRJAujQ2e (Agent v2: signing_key = agent key, owner_since = registered_at) | 5000 | `4Wqi29pK7kCe3juhySv23qSu9UBqj8S5vtkiaUtQSmzaVLBtjYKquGAmzXvChzqAoGG2asDbfWUSDrQTD6wVxQig` |
| 2026-10-08 01:51:46 | g | migrate_agent FeGKtFj8U4ZnCRTuMBDMbhNqzsH3vZebuM1sisJFvfZ7 (Agent v2: signing_key = agent key, owner_since = registered_at) | 5000 | `5coBvz834DGDxquxWbTspwuVh644owvgGonwPEgbz9Ei6kxjtxz6S5hCR7aZs9cFSQHEuZg7m1x1UhzCiH4dpirs` |
| 2026-10-08 01:51:48 | g | migrate_agent GqZCz9Gx7oHqVpmkuVMF17gMcCFeNyq5D7X2Y8jgcmFn (Agent v2: signing_key = agent key, owner_since = registered_at) | 5000 | `24o6c1gfM7QterwSD8rk9T8HDP8ArDKr7fy1uWMdcWY78FU3Cx7wBhcymMM6hxacQ7MNoSq7gLSuHC59g5d8TYAV` |
| 2026-10-08 01:51:50 | g | migrate_agent G4N8fjGhrxqXQVCRRTKSq58LAuAyr2vgCKH83Y9sddaZ (Agent v2: signing_key = agent key, owner_since = registered_at) | 5000 | `4z6TYhFas47mTpgXB7q4rUYXyNrGhwDK8vkVup3uhFbe3of4CwkJ6JgWwz2qBexqa3Zwru2gzDp7LHJR6MGwFZPT` |
| 2026-10-08 01:52:05 | g | migrate_agent BFPxdave7NVSXztGEZA5iZ7FiBDKRsuZmS9wZn2J1WBV (Agent v2: signing_key = agent key, owner_since = registered_at) | 5000 | `4XXGKRRpvvz4NJWDW74kfcTRukSVDNbTdWxnZtUvm4qVkoGLmwv9VsRfh3rzP3K5cm2nqphr5CwUWfyLDxf6p7gz` |
| 2026-10-08 01:52:06 | g | migrate_agent GiSibEMYzg3Y4EGG4QKx9drpTGC36du3XJE2dPZsHXuA (Agent v2: signing_key = agent key, owner_since = registered_at) | 5000 | `U4anVzcub6e6BQKZ59KDK1gZRap3H19LfSw6CT1m1s25LuVmUmH9YWUfjqNYG19xHKXEy3JVUzz4JatmXvJrD9h` |
| 2026-10-08 01:52:12 | g | migrate_agent FRx89QoUEavL1mVMcroDH4QYUhdTbA66EthkX7uZrGSD (Agent v2: signing_key = agent key, owner_since = registered_at) | 5000 | `5MnUyVSTEEbbg1PhJREAs1me8EY1V55woSGWgFZSnCcSU7GWQNDVoLGWUm3kBcdvsyXsxhVwoxQ5qdCfdt1QaYwT` |
| 2026-10-08 01:52:22 | g | migrate_agent H9AKH5K79DWfwBQLRe8xv83u4pXgLdRfnzDjpkj3ihvk (Agent v2: signing_key = agent key, owner_since = registered_at) | 5000 | `kkXY2epqN6XyfjSEoBb4NDwvF6AdDXeYNwtoy8CVE6v9pw41hsudHRBAUaiy4B3GnttQgx91L6xwFuDqYPh3C63` |
| 2026-10-08 01:52:28 | g | migrate_epoch 0 (record_root zero: posted before records existed) | 5000 | `67oTVT23FSuQRWgvatDoVcZhDSdeA9yAB2WJz3Da7ZhhySwRSzSWgExRVuu9GbAjU5Uc1FJGjomdAWv4AaZrM5sv` |
| 2026-10-08 01:52:29 | g | migrate_epoch 1 (record_root zero: posted before records existed) | 5000 | `4ir9QmJTdkaVtdh9EjzZzErobLEutNo4kF1Gu4mXxYWdaHYM5puLtduHS5UaTndsoo6uf6TueSLsjCLvx7toAMK3` |
| 2026-10-08 01:52:31 | g | migrate_epoch 2 (record_root zero: posted before records existed) | 5000 | `7Zmkf1jYT3GY5dqKZMKw6EmbQfsr6oLjN8nunig5iEdZhXnX2pFrJyHmUDu9h9K3CfnhLw5399WSP3nTnWALpoW` |
| 2026-10-08 01:52:33 | g | migrate_epoch 3 (record_root zero: posted before records existed) | 5000 | `4hYUWeLDF8fT7z5PewyKYAD2tfeFgoJT3F39DkzNb7mu7SuwpSomYWvGw1hHwFh3tPCR1yZ1AWic4GnxrJt1fUje` |
| 2026-10-08 01:52:38 | g | migrate_epoch 4 (record_root zero: posted before records existed) | 5000 | `37VBih2RyKJaFj8aM7e47M78UXY7d7XxGhMkipt4qWp7X5Jzfj3GQEVGz7R1qtkpS6NuSVtoEUWAkewYC2rpdpC5` |
| 2026-10-08 01:54:30 | e2e | trade: trader buys with 20,000 tLINE | 5000 | `2p71WGPFGyWgMAwAjgZnHWPkm5ptnE8u4tjzuzUAxXDVUpu1F42ktEPdgrKtGh5G1x7vqScFMmtc1wPp2WHk96p3` |
| 2026-10-08 01:54:32 | e2e | trade: trader sells 399873787596 agent-token base units | 5000 | `3sqRXv6ZppwFefG6BLPyxTvA4SHxsRzjjUPHuUkisTm33jJdBJNWqXL3CZWXZ5FaRUrpge6ZFk5KkJgmYAbmEqoQ` |
| 2026-10-08 01:54:36 | e2e | crank_fees: 972694608 partner fee base units | 5000 | `3fnkjAxQcP7KN36eMvPXYba752zTt5ved4PLUMxZrwnqwjNha9aZ92NQZuN5eHQ91DuF3CukeYY1keZBUxC2xTon` |
| 2026-10-08 01:54:40 | e2e | split: treasury 291808383 to reserve and pool | 5000 | `2Gmks2DCi1CUWv6E7hYVwnJGtxT5gijfgFgL6AD7bmhqVuQuWk7zihFG6rC6r3vBEMZ2k2KeZtMzBdWwvh41A6ek` |
| 2026-10-08 01:56:28 | e2e | rotate_agent_key BFPxdave7NVSXztGEZA5iZ7FiBDKRsuZmS9wZn2J1WBV to runtime key 367NWoJ6kSpwKqyBbFRMTz4bRgbJZYKpk14vMKzjEDaQ (owner and new key sign) | 10000 | `3GJN8amSAL7yNWYfiXMXoHWMcLFpHHa3fc4cvaiSStg9p4oPdmsc7QKYvkPAnK83jnSz9XWbMboxuBzvEJfVKSsg` |
| 2026-10-08 01:58:21 | e2e | trade: trader buys with 20,000 tLINE | 5000 | `53VeZEVDp6iB6Qz6yw3MmndcWJuosw4WGhKLpmTVo7JyRy2341oZ1C4NT98WQs6BjXQP3xK78ArmM9H5n3vGhJ6m` |
| 2026-10-08 01:58:35 | e2e | trade: trader sells 394395954067 agent-token base units | 5000 | `27FNnvRQzT6bEJewmRzpMpsQxbjzS1xYF8vVVjTF9ydKsfoDNfsSrCUFcso4pmUE3rvvNxZ7WDtgJzLjuXyJ986Z` |
| 2026-10-08 01:58:38 | e2e | crank_fees: 965768220 partner fee base units | 5000 | `56jdffWqb8zngmAVAXyeZYxLWipvpt7GZiFji1ghQUYkoTqyNSrdckYux55ovPJFXq6NNRKos7tBGRva5nHUtq2k` |
| 2026-10-08 01:58:39 | e2e | split: treasury 289730466 to reserve and pool | 5000 | `3vkTj3H1rUMNp3kJvx34G4nDfDFfVyBVa68wo8F13VTbAt4bE5MhcD1FqC7wbh1HPVR5wR1ueqgjXm2EE5mNS4Bc` |
| 2026-10-08 02:00:33 | e2e | rotate_agent_key BFPxdave7NVSXztGEZA5iZ7FiBDKRsuZmS9wZn2J1WBV back to its original key (owner and key sign) | 10000 | `4gEwHmDV75aD27ty9pXppFESnNb4FyLq3F3GEzyPi1cyZAUMgci24xdbmGBPPhzq18FKjt2K7KKuGZEDiQvnWyin` |
| 2026-10-08 02:00:35 | e2e | rotate_agent_key BFPxdave7NVSXztGEZA5iZ7FiBDKRsuZmS9wZn2J1WBV to runtime key 367NWoJ6kSpwKqyBbFRMTz4bRgbJZYKpk14vMKzjEDaQ (owner and new key sign) | 10000 | `2p9yF7tdKgnsEzdwza4Yb7c2vdAS4jFNVGADcqD4LBPstjY3CHz6fKGCHb8z4xZojBt45fCLZ8w6MJodr4zDsGVX` |
| 2026-10-08 02:01:21 | e2e | revoke_agent_key BFPxdave7NVSXztGEZA5iZ7FiBDKRsuZmS9wZn2J1WBV (owner) | 5000 | `2gdiETfrkYY81wHWCMRi5US3cmC3Yq8Cyxqq2f8vYB7humXoWVk7MGx8dskD3etByQkHVfxLatTPQSZobYSixFxL` |
| 2026-10-08 02:01:24 | e2e | rotate_agent_key BFPxdave7NVSXztGEZA5iZ7FiBDKRsuZmS9wZn2J1WBV back to its original key (owner and key sign) | 10000 | `24JtNJnQRrFGtwZuaZSTM42w3recijrd5Wtz2gRRkMPpD11bVHopBFXz6B6MW4VotxWvhMR53PeSFh7EK6jx25V9` |
| 2026-10-08 02:02:26 | e2e | Core bridge post_epoch 5 (root 88875a019100c965...) | 5000 | `2oAkiBS5eMYm1mqGxk2MiuCFu7HL7h44115GMvTVXCaLfKMTSSZ6y78vCSMTZ6KHwz1SUtZMm22bJdZtKXqfdF7w` |
| 2026-10-08 02:02:42 | e2e | claim epoch 5 agent:BFPxdave7NVSXztGEZA5iZ7FiBDKRsuZmS9wZn2J1WBV:compute 100357385 | 5000 | `5uHZCT2E9WCyP1gYTjpZKmtyY2x96DuDAKSLPfrzt91E6BzUU23ToUmMSJtmQ7ZojwYSdYi1wVWwpLWQURgfcwtc` |
| 2026-10-08 02:02:56 | e2e | claim epoch 5 agent:DEHFFWt2uzVGn43nzU1EvEyo17G1x74gvn3C6usU43hj:wallet 7976193 | 5000 | `5aPkZwpUx45GfeUGES8UBETb6GEM4dCSQvByV6tkubEgaMBpbcuBwjPKHjYVhgs7H3mYLVNoQ1GyxwEtV9eNtbSk` |
| 2026-10-08 02:02:58 | e2e | claim epoch 5 agent:FRx89QoUEavL1mVMcroDH4QYUhdTbA66EthkX7uZrGSD:wallet 7976193 | 5000 | `5ZLnb8YHYYE5vmDAe9HRQ7S25LAaDa3DVJMfS4HGV12orxso3pL3DAb9ckddE8HGpS4d5nnYqmZnzCt2iX5JCeRM` |
| 2026-10-08 02:03:30 | e2e | propose_owner GiSibEMYzg3Y4EGG4QKx9drpTGC36du3XJE2dPZsHXuA to 4PEzHpw34qxCydwJZC4zURQRhLUtneYDTE11nmMUjs4K | 5000 | `3x8Qa2FgUhyQLxzs6eUkvVaH9QxheWRTggJw5pWN7ZAaz6uXK4zt4qSSwU6AqP58RrNGSaPJSAdQGdZULAPqkEur` |
| 2026-10-08 02:03:43 | e2e | accept_owner GiSibEMYzg3Y4EGG4QKx9drpTGC36du3XJE2dPZsHXuA by 4PEzHpw34qxCydwJZC4zURQRhLUtneYDTE11nmMUjs4K (deployer pays the fee) | 10000 | `388wWmToqvsecfygcYbrXPv2CfYgyzGshmop8N1Z6ZcfQZmNFBR8bvKwMjqZFpypSpF5Q35X2KzsFPJxytCx6GvB` |
| 2026-10-08 02:04:07 | e2e | propose_owner GiSibEMYzg3Y4EGG4QKx9drpTGC36du3XJE2dPZsHXuA back to PsMbwtjM9Sh7A8VwYk1WuB4owg5Djr7EkL6aDiuqpvy (deployer pays the fee) | 10000 | `2XnpAmkDbnxwYWeg5kQU77yN5ggJtTRBQKaJKFwQNxgn8njHUxT31iQnk8W3Sn2h4ufDueT98isGMtwREtCTxSmp` |
| 2026-10-08 02:04:13 | e2e | accept_owner GiSibEMYzg3Y4EGG4QKx9drpTGC36du3XJE2dPZsHXuA by PsMbwtjM9Sh7A8VwYk1WuB4owg5Djr7EkL6aDiuqpvy | 5000 | `27MSfhiTUEJ6n4SHFN1tVhZanPPMcWtbtqw7qp5teojFHKKuBFJ71EHnP3FrUgUNfgdi2vusviMksc35EGQBkPNp` |

- Migration (setup step g): all 12 Agent records and all 5 Epoch accounts (0 to 4) grown in place; `scripts/devnet/setup.ts` then ran in full with every check passing and no transaction (idempotent).
- `scripts/devnet/e2e-devnet.ts`: **37/37 checks** (`scripts/devnet/E2E-DEVNET-LAST.json`). I1: the TEST minbpe agent rotated to a runtime-generated key `367NWoJ6kSpwKqyBbFRMTz4bRgbJZYKpk14vMKzjEDaQ` (owner and new key signed), Core answered the old key `401 bad_signature`, the runtime key committed `encode_chunk_cache` under the unchanged agent id and two onchain-bonded verifiers accepted it, revoke made Core answer every key `401 key_revoked`, rotation back restored the original key (Core key history public). I2: epoch 5 closed, posted with `post_epoch`; the onchain `Epoch.record_root` equals Core's (`b9a1463d3cdabc77...`); verifier v1's credential verified from the onchain roots alone, in process and with `scripts/verify-credential.ts`, and altering one record failed; the minbpe agent's credential carries its accepted generation and contribution leaf. Owner transfer: the ref verifier went to a fresh wallet and back with `propose_owner` and `accept_owner`, mirrored in Core as `controller_since`. A first run stopped on public RPC rate limiting (HTTP 429 on `getProgramAccounts` during a chain sync) after its trades and its first rotation (rows above); the rerun began by rotating back. Deployer after the rerun: about 3.27 SOL.

### Wallet page identity check (identity onchain lane)

`apps/web/scripts/wallet-e2e.ts` with the Identity tab steps (rotate with the new key co-signing through `lineage-worker cosign`, revoke, propose owner, accept back on the page). Rows below are appended by the script.

| When (UTC) | Step | What | Fee | Signature |
|---|---|---|---|---|
| 2026-10-08 02:04:55 | e2e | fund the test wallet 8juHDv3a67114S8JTjCwUGQkrZqjkw9Mac5fneSBsQi2 with 0.037138768 SOL from the deployer | 5000 | `4kBoHKhDo9yUDj46U2hpGuGPeFSv4gLm4QWhBgY31GhFGFmcqQ8wgKtpEdpgazSAvo1mMPFGbYEm3Ak1uojfwabe` |
| 2026-10-08 02:08:15 | e2e | page: launch_agent TUICHECK10 (mint DsRt7x8W3tuhqN4Vc7XviZXAsStvu1qR39YJdRCfMMdu) | 15001 | `xUdQx1xsN7mMR4maLMLM7yTXGxLwz3TvvFU3QNiEC6ChSDb7hUqH4tEVAt9ufDFf1QCauV7PYi2fJpjVHTDzB4G` |
| 2026-10-08 02:08:15 | e2e | page: buy TUICHECK10 on DBC | 5001 | `4m5X9dW6PdPb4rGj8wABgbuVxnizYLJgaE4uDp5ZB43bC2sveZCFQazYYfavRrEZoNsGeK6DgprcHgMLCE6iJQpB` |
| 2026-10-08 02:08:16 | e2e | page: crank_fees TUICHECK10 | 5001 | `5ndC3WKdwL4DEZEAkFTEDi38VgV1uwgxUZJFNdnTF6XqnzJEyqen1XWAt4XMPWHw51s43nYgkuwbmjsZEK3zbdka` |
| 2026-10-08 02:08:16 | e2e | page: register 5Uer…i3vr (sent by lineage-worker cosign) | 10001 | `4piZ2Qva3nWbomDgzVKbkRLgXkjuExwbAuRmf9PSi8e4MTvqLaVaaQpevKjcDkxAGtAHEtSHYFw7vB5sS8wCNVKF` |
| 2026-10-08 02:08:16 | e2e | page: bond 5 tLINE | 5001 | `5VaCrJnUVH39gKPrR7uByVcjTHDV642PhKLTcEYWnKGnKf1BUxrRd7V5kJh2Bcg7kYiv7zz1r5MnUZ5z4qdRutn8` |
| 2026-10-08 02:08:16 | e2e | page: request_unbond 1 tLINE | 5001 | `5BxsnETT1e7dstaBSwQjtf7DUZrbqjNvsNhpD7DPzukU9b1iLNoUfYv1F6knhSiK6cjL2SfKdxbvtwts42a8Ts1Z` |
| 2026-10-08 02:08:16 | e2e | page: rotate_agent_key 5Uer…i3vr to 5cYh…YKab (sent by lineage-worker cosign) | 10001 | `36CdAAGkKTSvYV6rkfhf5pHPUbFt4Hrk1qtgNg18c2Ygoej5Bbdk46goZ95pJf9hAym1Vx1E91kcUH5g7uLNBfJG` |
| 2026-10-08 02:08:21 | e2e | page: revoke_agent_key 5Uer…i3vr | 5001 | `3aio2m9tmA6wyVMV7WUAdUSHkxYKqnSVAw2tYCzfUUoAXtopCCxcnK3Kypt1A72gdAo1mAn6QqtgcQi1Gh8zrzJN` |
| 2026-10-08 02:08:21 | e2e | page: propose_owner 5Uer…i3vr to CJ5h…Tjpd | 5001 | `5WjhAz1ZAYYFaG8QWCWvVJHx4sSe6iGxHp1vGBubLkTbmzRvXQ6tpzbBU64py4vwiaVuwEXuaekszHVGBNNYUwSx` |
| 2026-10-08 02:08:22 | e2e | page: accept_owner 5Uer…i3vr | 5001 | `24xQ2ToZEVW827QrmNSBhFyThZW5jBTbFuZNLtJEGZdEbJqfwUjpmAt6WdKKpwg5spR8sAaSDXzJrxQJi9LkT4Va` |
| 2026-10-08 02:08:30 | e2e | page: claim epoch 6 wallet | 5001 | `3AttBXiTUumRogDLWoXZCxvygqmmZ9yWw98u9X8HtqjeBN8CTpznzkKDHyiVZKNhhjWMRNLpAvJ8ZLPJTKQeqiGs` |
| 2026-10-08 02:08:30 | e2e | accept_owner 5UernSMGSqbG1eLCLZ1eqDMY29cKL1WwqKDu9oaoi3vr by CJ5hu4HzVNQZ8a9yQJb4NHDH9G1afjNCmUCvVccsTjpd (deployer pays the fee) | 10000 | `w5faiE5jfPgo9aNgsA45aS64Vw1z7BDQWWCLhusbU6ZZG3wanH9zZytdZAmcqKsWtLL8etyk5jzR3dcCjNN64wj` |
| 2026-10-08 02:08:30 | e2e | propose_owner 5UernSMGSqbG1eLCLZ1eqDMY29cKL1WwqKDu9oaoi3vr back to the test wallet by CJ5hu4HzVNQZ8a9yQJb4NHDH9G1afjNCmUCvVccsTjpd (deployer pays the fee) | 10000 | `2XbxvEkWtnNF2KjVvHPzhZmHhZoRV5RRjTjUqcvf4MYGD5sZMbF8KjghUK9Zi2T582XbEJqjgHAW7pit9VBx1opt` |
| 2026-10-08 02:08:30 | e2e | split: treasury 1440000 to reserve and pool (test wallet pays the fee) | 5000 | `2pEv7JG6c3hYBgj9Fvo5artbtE8xJ1CxJv5bN2S2PvKMsqJSfGEt7xvsTbkFUA52mJ6KUHrvaa7uWMddra4T3aNL` |
| 2026-10-08 02:08:35 | e2e | post_epoch 6 (test epoch for the Claims tab: one leaf agent:5UernSMGSqbG1eLCLZ1eqDMY29cKL1WwqKDu9oaoi3vr:wallet amount 288000, root f03c4225224a11ac...) | 5000 | `44Rd6gLLHG9dD4vMEcHUHLX671MCNjxa446BVoBEFtLwJUJeKhQ9edz5yBVzBnipnZUWnfPoAXrQghwxqgK9WsJe` |
| 2026-10-08 02:30:16 | e2e | trade: trader buys with 20,000 tLINE | 5000 | `2pXUk9MVxCtKAZxqA9dMhjjmvWWttY7Qzv46cLVuCMGe3JEGox23j4z11SCHgcf7B2LE9ehcYgF7BGPKU3Tei6ZW` |
| 2026-10-08 02:30:18 | e2e | trade: trader sells 390316974818 agent-token base units | 5000 | `34WMakYTKGHZZP9w1qwL5TXuudjwPSvAGRUyqauCvyfYMYny4mgeUCygzvqMRekTHHVs2WKqvzQgZcDrQferGtnd` |
| 2026-10-08 02:30:20 | e2e | crank_fees: 960613854 partner fee base units | 5000 | `HAWpjzXAX6HWbJtLfiPAvr9DiUTALHEmrLfYyE96wCY5iKA6W5kusw4zQnHRfbjhd1Zja5zCHd1sGqk4DozCjCY` |
| 2026-10-08 02:30:22 | e2e | split: treasury 288184157 to reserve and pool | 5000 | `2Pdbc8zAaj4gRgtMjYUG79VzX1tH6DgUcLzCAS1ESy4bYsU1W4iY5r8zeuDLfHo6ybombT7dnjK5xqdd5vwpGg28` |
| 2026-10-08 02:31:45 | e2e | rotate_agent_key BFPxdave7NVSXztGEZA5iZ7FiBDKRsuZmS9wZn2J1WBV to runtime key 367NWoJ6kSpwKqyBbFRMTz4bRgbJZYKpk14vMKzjEDaQ (owner and new key sign) | 10000 | `3a8HeSxrpTjpmEMBSVZwJvfQSc2ZQj4YY2QLcjSQUvcVy7oFusNY1PkpS6iba3PPxrog2CwHBwj7EpX8VNxsCHUv` |
| 2026-10-08 02:32:27 | e2e | revoke_agent_key BFPxdave7NVSXztGEZA5iZ7FiBDKRsuZmS9wZn2J1WBV (owner) | 5000 | `35B8YAwZK162yjwxWdWYodJse349Gs2pRcvdmrdXXjXrZ24eBGMFFmAfJCReQzxtETU9msj3VWtvch16BfJWVZQ5` |
| 2026-10-08 02:32:29 | e2e | rotate_agent_key BFPxdave7NVSXztGEZA5iZ7FiBDKRsuZmS9wZn2J1WBV back to its original key (owner and key sign) | 10000 | `49YUHpJAxXY86rcb25Yu11CFfF3N2a9X6noXNAN4vkAeXz8ozTJA6uLia8cDWJQMLAWsVgtNvWKMEyR2xtYWdNzM` |
| 2026-10-08 02:32:41 | e2e | Core bridge post_epoch 7 (root cf0848f9834c59be...) | 5000 | `yKKqTdXHrX8tLG3rbx3GXRZvLKFqKBUsQCJD4gRSrc8yvPsRtkoCyBQqKnXtc2EzaUaNJBHJ1TJ7nnNXsPjZVYo` |
| 2026-10-08 02:32:48 | e2e | claim epoch 7 agent:BFPxdave7NVSXztGEZA5iZ7FiBDKRsuZmS9wZn2J1WBV:compute 49483101 | 5000 | `BMFAziyUbbHRxgecyKtQRhttGTmEU7yaBt1N2PAGMW8MgszcBGoazL6W6ozQ8qN4nBWRvNqbFQ1N6D58EzGGJqX` |
| 2026-10-08 02:32:50 | e2e | claim epoch 7 agent:DEHFFWt2uzVGn43nzU1EvEyo17G1x74gvn3C6usU43hj:wallet 4077866 | 5000 | `38tSi9xtxbDwUSkMo3QYHbdDq6z9ydbUQ1RAv3WetqiWmYBoH6ri61p6KjFRcotZ3r6reziW22UcGjtZW8AXtxRe` |
| 2026-10-08 02:33:01 | e2e | claim epoch 7 agent:FRx89QoUEavL1mVMcroDH4QYUhdTbA66EthkX7uZrGSD:wallet 4077865 | 5000 | `5nRcnSD5NKptbsrWMacabDgUknGXgtm1bQk47xuH2aVVX9zkpSQV5rESuLp8Yh8yiRYZQgBhhFJgyDMZnjr2YCTE` |
| 2026-10-08 02:33:18 | e2e | propose_owner GiSibEMYzg3Y4EGG4QKx9drpTGC36du3XJE2dPZsHXuA to 4PEzHpw34qxCydwJZC4zURQRhLUtneYDTE11nmMUjs4K | 5000 | `5rE73NRVNtgdVU6MZLmLEwCKhgWx7Ct6n46EZDf3W65ayb8UXZutH7LPsuwmwgdQcUFCgwkhDqDmHD8ozE1wZSLW` |
| 2026-10-08 02:33:20 | e2e | accept_owner GiSibEMYzg3Y4EGG4QKx9drpTGC36du3XJE2dPZsHXuA by 4PEzHpw34qxCydwJZC4zURQRhLUtneYDTE11nmMUjs4K (deployer pays the fee) | 10000 | `2Xu2is4jva6754DPSLpWEWP1UsKD3jNLs2XEu9MqH7amZ7QrAVwCgf4guutYYwxvs3HHDn64jrjos2Wuj3NVRpFY` |
| 2026-10-08 02:33:23 | e2e | propose_owner GiSibEMYzg3Y4EGG4QKx9drpTGC36du3XJE2dPZsHXuA back to PsMbwtjM9Sh7A8VwYk1WuB4owg5Djr7EkL6aDiuqpvy (deployer pays the fee) | 10000 | `4QuaafozSNXCMA2KpFCoiHfESzwxuNPwtsui2KhHVq5QhtuNkgMBNkgh3QEDF2VtsU2sFRpHAygcExeyRFHNxw5c` |
| 2026-10-08 02:33:26 | e2e | accept_owner GiSibEMYzg3Y4EGG4QKx9drpTGC36du3XJE2dPZsHXuA by PsMbwtjM9Sh7A8VwYk1WuB4owg5Djr7EkL6aDiuqpvy | 5000 | `21tR5wercjP9ZMpxHv8RfCvmvYLSnurXHizhESYKm2GHzEw6y9nyCF8xQ2WGFMb9AjxcAo9Ezd1xjiq1mqg14LC7` |
| 2026-10-08 02:36:18 | e2e | page: launch_agent TUICHECK10 (mint EhFwpVWwLjFKra6Wk23HLPX7K9vfW1Mdt4Li9wWV8fqZ) | 15001 | `oiQ74DSJWi7Qn2PivdD8y8UVvUkicQmC4tnGkJKtMYAg1viS9NVTtdvfAWCxDgTr3juigx5hwoeQgvAZKZjiGFv` |
| 2026-10-08 02:36:42 | e2e | fund the test wallet 8juHDv3a67114S8JTjCwUGQkrZqjkw9Mac5fneSBsQi2 with 0.039480252 SOL from the deployer | 5000 | `3St1xJv3zMiSFvyQk6nheg2a7rYgzn9ASFeyDtXLUb6qEvLhi2SmgaxAXcPChdon85xviWvvNqQcdA6EreEU86Mk` |
| 2026-10-08 02:39:01 | e2e | page: launch_agent TUICHECK10 (mint 51Ek5TsNFdj4nKBoRNrh5nC7K88egDeM3Mrg7DmMiZ7o) | 15001 | `5saPg3CkrqqutNean4UuZiUGNq1VRmA7cHgCHZYrBXML7SrxLBeQJXtrXDV6KikWSHhq81cQ9kWLzdnBPhzG4d9c` |
| 2026-10-08 02:40:02 | e2e | top up the test wallet 8juHDv3a67114S8JTjCwUGQkrZqjkw9Mac5fneSBsQi2 with 222.848 tLINE from the faucet key | 5000 | `2y5GdTBpawTL5xRoG2KPaHtwggZ35bxtJKKRm1Tp6cvCFFmisiLravWMjsTntWhnBKfUjPFeJZAVAh6D9fGYHFSG` |
| 2026-10-08 02:42:14 | e2e | page: launch_agent TUICHECK10 (mint CjYcQgkSjU21YcXRU4crcmozgSwuuDi1Pht9pN2b7toC) | 15001 | `4y4Q15cTck2wKdxCy1nJRKQYuCUNnxbRcu3GykLCLW7fzFE7YPQCo6B9YwwoUcpEV6YNMQGboJEWr2KeDtRLJhfq` |
| 2026-10-08 02:42:14 | e2e | page: buy TUICHECK10 on DBC | 5001 | `4YUTHv2qKbzmFWuQ2JepEyJWs7mQw79mwQmrPUF7kT6NUL4mcW9egQ6GeNzh5L1N96g4xiFLRzGgQMxgiP7EZogj` |
| 2026-10-08 02:42:14 | e2e | page: crank_fees TUICHECK10 | 5001 | `2YxuY1xmVmHLH1uqtmXDEwC4kQmjneL41WnnYpcFbGVPkrAJPyGnAno1v7Y7cD4owoK3ZQcdY1kL3fALoUVBw42P` |
| 2026-10-08 02:42:14 | e2e | page: register EHDn…jGsh (sent by lineage-worker cosign) | 10001 | `M7kbxk1xXX9qBopqnKXGmXSdE8TdCgixZsyzfDEY8MSgRu6rLP87AHmHVmUDK3Tpk7bqCzgnKSDo47meuxznYrM` |
| 2026-10-08 02:42:14 | e2e | page: bond 5 tLINE | 5001 | `2Nyucx5GkCmmhsTcRGQwUQcWBmiwf5JEG7BeKQ8MEC5dJjxJEAV8kKkkzauCTB3LTGUqeM2z4uvJbxVWhUo2zxpj` |
| 2026-10-08 02:42:15 | e2e | page: request_unbond 1 tLINE | 5001 | `5wKZD9Mbyiaax5vdnmqc7Yqg3PK58Sf21DZRgUyfrND55qFovGmwjLQVLBk57EVvXSiW9Tf6Li8Wc7HCFYeHVTmj` |
| 2026-10-08 02:42:15 | e2e | page: rotate_agent_key EHDn…jGsh to CAEC…Jq3V (sent by lineage-worker cosign) | 10001 | `4tMmDRWn45dLT1UY9Ct1ZzVS867zsDjYTFr79QmR8igBfG9JutVT81M3vPzCjApso5Sh6bkGV7kXHx5DCcW2HHHs` |
| 2026-10-08 02:42:15 | e2e | page: revoke_agent_key EHDn…jGsh | 5001 | `3JRArFow9FApHB8yxUGRdjhBrH8ormX4u3fXx5P4QBwMbpcNxKhtMFX5AecVN1WAxCJfQejqFuefMy5pR96WywMx` |
| 2026-10-08 02:42:15 | e2e | page: propose_owner EHDn…jGsh to CJ5h…Tjpd | 5001 | `5N744gcvBkQzMcHZcGCU7kbb3i2oHXcWQahHS9onDB6BksaGayz79GNZmgLsF9CvAGeRuvLEDnAgViztCLQhpbHb` |
| 2026-10-08 02:42:15 | e2e | page: accept_owner EHDn…jGsh | 5001 | `3f79HVDGXFT8V7MNLzTcADQxygKTXury5Rs46CqVo6hvrhHeRgaowNzN9w4had7UyziGEFmuWJxSFU4pkqgXYzG3` |
| 2026-10-08 02:42:23 | e2e | page: claim epoch 8 wallet | 5001 | `2UgEnnBsL6HAMSXgSYVadsviryRDL6V62Z2rrtEJdFWu3XDmgJLMM91X3eYYHjePnHiUDYSy1G4xm1A2LDAVw8Mm` |
| 2026-10-08 02:42:23 | e2e | accept_owner EHDnWQ6ezp3kxVALEBykKKXsCCoRPNszrBR4P2D4jGsh by CJ5hu4HzVNQZ8a9yQJb4NHDH9G1afjNCmUCvVccsTjpd (deployer pays the fee) | 10000 | `ajCF22Cn8FjNfvTWWPbyoSSNDTrouGbng6SgHNxQgHoa9Ji7PrCxXahVHwe5n3w4s5ZcJXX7awgbkPbqZL8CEYb` |
| 2026-10-08 02:42:26 | e2e | propose_owner EHDnWQ6ezp3kxVALEBykKKXsCCoRPNszrBR4P2D4jGsh back to the test wallet by CJ5hu4HzVNQZ8a9yQJb4NHDH9G1afjNCmUCvVccsTjpd (deployer pays the fee) | 10000 | `4k1KvSoNzQKyaPTgbgyh4Ymf3ZzkNTEYFmhKn541vdj9h8rgGWuA4WtP4HRntf5jrp8z75Kpnr8EmC9CG9AwAT35` |
| 2026-10-08 02:42:28 | e2e | split: treasury 1440000 to reserve and pool (test wallet pays the fee) | 5000 | `3ef5Ly5G5cSNeqT5ATRE3Fz9ARw2JbBXtj9CJ198rkBPMfunn6Sut2wxay3W8oDAs6fTcudndnDFYcZ3o4gMJTV3` |
| 2026-10-08 02:42:30 | e2e | post_epoch 8 (test epoch for the Claims tab: one leaf agent:EHDnWQ6ezp3kxVALEBykKKXsCCoRPNszrBR4P2D4jGsh:wallet amount 288000, root 850943b464313892...) | 5000 | `2UWNFc6ZsjTPwUQJ1LjFn7VZx5iParkjmUgSdn7SkRKxLfiGfxL1a7VKi7BEJ1bjJG96KjATUThKzxpEgTfbibTF` |
| 2026-10-08 02:42:45 | e2e | trade: trader buys with 20,000 tLINE | 5000 | `4rnuSJNmbuQ22qbHkHoS2imh85ihPQfmfqYj7Etzrp5xwyh7SYCqtXkG9XNxbV64mFTNY9iHPxQavxteLxdGDV7s` |
| 2026-10-08 02:42:48 | e2e | trade: trader sells 387279632515 agent-token base units | 5000 | `3oocQjipLtNuECfsdUoA6mv6m72mPYcArAeDJmhgF6qSDxnAqPk5Zhty2BXMy77hdeYYRz585tZWNrjAQCUVCF7Q` |
| 2026-10-08 02:42:50 | e2e | crank_fees: 956777548 partner fee base units | 5000 | `4BUvpjK44bgRRFFqLzKpiNtreeWgCC36pRRQjgAekqTMRW9JfcuQTC6W21aWsnk7DKmTcD5scQV6bMi4T7bdrBXh` |
| 2026-10-08 02:42:52 | e2e | split: treasury 287033265 to reserve and pool | 5000 | `62qFUyy66mFcKjsin3r21Vprta2Sgtag28oQCgrpuPNe1jDdJGGwK1CKiLJydY1MqgBPNNCZ4WpiCDQyxue6AMg3` |
| 2026-10-08 02:44:13 | e2e | rotate_agent_key BFPxdave7NVSXztGEZA5iZ7FiBDKRsuZmS9wZn2J1WBV to runtime key 367NWoJ6kSpwKqyBbFRMTz4bRgbJZYKpk14vMKzjEDaQ (owner and new key sign) | 10000 | `2Uyu2ATYVesGfKs3KXpdKsscu6AV5mNTYJEZGrzB6sCXiQCDH4H36VrKNNijrHQVaG4bQnkDPCi1kfQJ3a8psCEm` |
| 2026-10-08 02:44:56 | e2e | revoke_agent_key BFPxdave7NVSXztGEZA5iZ7FiBDKRsuZmS9wZn2J1WBV (owner) | 5000 | `3iLKDBmvYoUQHBiy2tozX4WB22Q7ncAMx6GYPQ4nCFE9ZDKxZCWGXjvEKLixCsr6vV5Zg5TsuuCqMuiRzKKQBUJi` |
| 2026-10-08 02:45:01 | e2e | rotate_agent_key BFPxdave7NVSXztGEZA5iZ7FiBDKRsuZmS9wZn2J1WBV back to its original key (owner and key sign) | 10000 | `3L8wNsitBtWRKWTPALYysKAGGqEGiheqUDewUQBHc6AKP65Uda1WPxhcRSmUnpK2d8HMrDVuJN4M7fzmBqac8kzb` |
| 2026-10-08 02:45:19 | e2e | Core bridge post_epoch 9 (root 10c7ad6989551df8...) | 5000 | `5WkdjgVzsKny1AzZvAPV8Xb57htrfE4yahC4GWg465SJyqVubiqJY1MzTvbnZhdeGE1aaECNuNKciVuzeZqF1rN2` |
| 2026-10-08 02:45:26 | e2e | claim epoch 9 agent:BFPxdave7NVSXztGEZA5iZ7FiBDKRsuZmS9wZn2J1WBV:compute 49391522 | 5000 | `24eHpTqrTdKF8GgQatLjQbSJqSiBie6AJMxrn8eJjZrmZq5ZSnzQP12N6uycrZ64VZo2rUFHEvuM9sg6kZVDsGFo` |
| 2026-10-08 02:45:28 | e2e | claim epoch 9 agent:DEHFFWt2uzVGn43nzU1EvEyo17G1x74gvn3C6usU43hj:wallet 4008566 | 5000 | `A5EG5S17kMcWZjDVxDaAr6Bd33Hjy2eGHKS4QmZ9XHccMaumYmdPGwWDc85vgM6GcHHzTN8DbxxcvUwgLtNKfVY` |
| 2026-10-08 02:45:30 | e2e | claim epoch 9 agent:FRx89QoUEavL1mVMcroDH4QYUhdTbA66EthkX7uZrGSD:wallet 4008565 | 5000 | `3pFLx5BwPpaWQxxVzQnRLku8ZkiRDeJBzYtwZrk2P11zAaMT16P7nsCt2ANbxUmsZqvLrFShpEeJdx2rX1UvQkn7` |
| 2026-10-08 02:45:43 | e2e | propose_owner GiSibEMYzg3Y4EGG4QKx9drpTGC36du3XJE2dPZsHXuA to 4PEzHpw34qxCydwJZC4zURQRhLUtneYDTE11nmMUjs4K | 5000 | `46wNKT8SPAQFqMKDE53PoqD5ZADaVQcxRnGQ2y1FndxhtSUc2JVGx6KDXAeT12pReCCUkSqvVLxRf3GhTN2Fffm3` |
| 2026-10-08 02:45:45 | e2e | accept_owner GiSibEMYzg3Y4EGG4QKx9drpTGC36du3XJE2dPZsHXuA by 4PEzHpw34qxCydwJZC4zURQRhLUtneYDTE11nmMUjs4K (deployer pays the fee) | 10000 | `3DshN8TKUL1xndrMKaWrV8aPCWUZTsS8VasveSFu61N69yr3g9bLZ3rxDwFpErMZxHYcANoStFRs8eH961Sb8wmg` |
| 2026-10-08 02:46:01 | e2e | propose_owner GiSibEMYzg3Y4EGG4QKx9drpTGC36du3XJE2dPZsHXuA back to PsMbwtjM9Sh7A8VwYk1WuB4owg5Djr7EkL6aDiuqpvy (deployer pays the fee) | 10000 | `41PGkBcmLoris2aRgQMozacRg9tB7as15TiHhJ6wdF2hsiZeih79sryEiK8uAataS4MEu3gWUiA6am6YhdtcBpu6` |
| 2026-10-08 02:46:03 | e2e | accept_owner GiSibEMYzg3Y4EGG4QKx9drpTGC36du3XJE2dPZsHXuA by PsMbwtjM9Sh7A8VwYk1WuB4owg5Djr7EkL6aDiuqpvy | 5000 | `CL4NeWnAm73GyPDSR2EbjGTjKsBATXuJXDWYBCu45u14sJFHhf1F6EVtaGzTRfyryMhFesbvKT9FP9bCy9S9yNL` |
| 2026-10-08 10:48:14 | h | set_bounty_config (TEST: max_bounty_out_bps 5000, self-hosted cap 10000000, ttl 60..2592000 s, grace 60 s) | 5000 | `3vSzUhTVpiRCUo1KZXUt74bFeL5FtWVMZQXeeDRP25EXBm3qfqURdKLbk5oTQEAwvuSfh6eEGzZXjJMaCZWzsmyZ` |
| 2026-10-08 10:48:21 | i | launch_agent: TEST bounty payer agent HjJneVqhRvrZAuu46xyjpKxuh2jVS2dLccRX61EoCEVL on https://github.com/karpathy/minbpe (hosted), agent mint Agyq69CNXTajd86E9tstqWfMjuxtQjSqqjnLaM5b5GSH | 15000 | `48cSRGTvRoVfRppjPrbVPJfnjDcSrbr8x2WhhATN8vkGGG6xKGPYoLXEHfP8cjRhBBK6hCYFW2ba2rodAA7zbJnN` |
| 2026-10-08 10:48:24 | i | send 100000000 tLINE base units to the bounty payer's compute vault Htw67o5GLM96A2YAaeDLbxao76hvsdfXsHZD3zArcyc6 (deposit by transfer) | 5000 | `5gr9aQYprxLo6k5nSQeEvaAUS5kB4M1V29xyqNNnQ12BxAzWjzKkhErmaVR2DYtaGihNuyevtU2FxiouFK6wiaXv` |
| 2026-10-08 10:48:30 | i | refresh_awake for the bounty payer | 5000 | `Mzvgwqtq94o7LV7sn99UjDDkYW8d41yWVvUSPXxB5Y4fSLS2gQP24pjTrLpSa3u6YidhzWxKpSTfwPdm4DhRVMD` |
| 2026-10-08 10:50:02 | e2e | trade: trader buys with 20,000 tLINE | 5000 | `63ZuK9QvLHYznELmXpCYWSymLKzqKTAc9BNypXCGKzwzWbua5kACLcYACgtW5qwok3joXdQFzQmYC53hFqW1S2bp` |
| 2026-10-08 10:50:15 | e2e | trade: trader sells 385017929033 agent-token base units | 5000 | `3RnMNwf5d2P8w2T4qXwYV4XD5BHxHNuHosb8LXHEMPZd9LJ9ABfgwBvVDjruqEU48dy1ubf8WS6kTZnWici3ayPC` |
| 2026-10-08 10:50:22 | e2e | crank_fees: 953921911 partner fee base units | 5000 | `3ER2aQijT3vDiZ5EEha5QSG4gbEK6PQQwkTxuP1kiZx22ExKAhVhnQrjhXh29jTubBT69D9XFrVpJFmPaLgzd4DP` |
| 2026-10-08 10:50:30 | e2e | split: treasury 286176574 to reserve and pool | 5000 | `2NivCgZHomL5n9UdAz4nie49GtX4VDgiNduEoMJ8urMR2pK2dcnNAn2aHXn5Fp9i65bq4GBrXCf8WvH2jKq55rDG` |
| 2026-10-08 10:52:56 | e2e | fund runtime authority DCmdy5MoAfnN6fn3nVW27db62ZwtjoksqSqdjAc8VPk4 with 0.100000000 SOL | 5000 | `2og3n2dVupNPQ1fWT1A32VDSJsKXQLitWfjx4J8k9fGHW23Peb48NKZM25YVrntYmdQaEScqh58K2yMj7UpC8LLk` |
| 2026-10-08 10:52:58 | e2e | open_bounty 1791456777122: 2 tLINE on encode_ir of lineage fadf5803417c... for BFPxdave7NVSXztGEZA5iZ7FiBDKRsuZmS9wZn2J1WBV (runtime authority for the hosted payer HjJneVqh) | 5000 | `4Cdbr58WonnBjYWyHZr6a2TFDHLPFBHgBtgvUKGbYP3FrTrmSFq8Fyg8vBaZrcJPFdYQhRQXbDGGKzicGJqWGKtJ` |
| 2026-10-08 10:53:06 | e2e | open_bounty 1791456777123: 1 tLINE, any author, 70 s deadline (to refund) (runtime authority for the hosted payer HjJneVqh) | 5000 | `4bbNy1VSQbCxouposSsyLNoyVwgtaC67J6SCSeQ4yUkG9hWuiks293FxFJVz5NWFQPe4CqofN7VDqwVDYiEKbe39` |
| 2026-10-08 10:53:10 | e2e | open_bounty 1791456777124: 0.5 tLINE (to cancel) (runtime authority for the hosted payer HjJneVqh) | 5000 | `45Ppe1VREbkVK5Tk6nY3iA9SCobo37fAHGoPBXFZBLhvBVN14RiLDNW38vnqrn2KxqkqR9tco9Fxi7ZeP1cgSGHN` |
| 2026-10-08 10:53:19 | e2e | cancel_bounty 1791456777124 (runtime authority, before the next epoch) | 5000 | `5VA81TnoKGQWTy6cCthmxWF8PJUeAXLcwkoKTkX1tZx44tVkfyQnwwnc95rzWZBaecdeyVGD5kWAwXvHBTx39gUn` |
| 2026-10-08 10:53:44 | e2e | rotate_agent_key BFPxdave7NVSXztGEZA5iZ7FiBDKRsuZmS9wZn2J1WBV to runtime key 367NWoJ6kSpwKqyBbFRMTz4bRgbJZYKpk14vMKzjEDaQ (owner and new key sign) | 10000 | `5HqJEH2mUkEMxhy5mwTNo3r7aPRbC2y4HGjUR1Zqy76JF4NvsjtdpvEkTd76gAwCCvxDJiNnTYcXoq7GF1hHax6A` |
| 2026-10-08 10:55:02 | e2e | revoke_agent_key BFPxdave7NVSXztGEZA5iZ7FiBDKRsuZmS9wZn2J1WBV (owner) | 5000 | `65TgQeU997eRWZpD2TE7PvPtXgZ2iwvVYCCKvFGDuyioMNVjzEzeESJsgYZZz9kdhUR82UA4CAqkH1tXRC99dnfw` |
| 2026-10-08 10:55:05 | e2e | rotate_agent_key BFPxdave7NVSXztGEZA5iZ7FiBDKRsuZmS9wZn2J1WBV back to its original key (owner and key sign) | 10000 | `Yfnuux5Ae914hRBKtxX3Hq18drYgcTSL8Rt1aCTQvzLrE23AM3aH1esrjB9bHYxrhN1XXzXzqyx6X6M585W1CZr` |
| 2026-10-08 10:55:33 | e2e | Core bridge post_epoch 10 (root 7d803c3cde7cd575...) | 5000 | `2Bk9EPuFGh8QmdxeRAkD6xVXQbxWowtHPbBkKFzgoZQjwdGWoKwAroUFnM8kz4hCCepzHbCbq16acFTmEThf2qfY` |
| 2026-10-08 10:55:35 | e2e | claim epoch 10 agent:BFPxdave7NVSXztGEZA5iZ7FiBDKRsuZmS9wZn2J1WBV:compute 48519579 | 5000 | `5GjK8tGPzy16BGRVRr7a2yYG2B4ZECdgzM8L8Ji479niH8HUiHaV8F6gd6sKuHCgLLd9L1iiu98VVoX5iqQKPCmG` |
| 2026-10-08 10:55:46 | e2e | claim epoch 10 agent:DEHFFWt2uzVGn43nzU1EvEyo17G1x74gvn3C6usU43hj:wallet 4358868 | 5000 | `5TXDsmqzhXwYYeKwcPp21P4sAmCSLVw61WTT2twNrGk81XRRLCGscvNiBDwpiE1gaymtGBHywmLyLJx5SevbeGPn` |
| 2026-10-08 10:55:57 | e2e | claim epoch 10 agent:FRx89QoUEavL1mVMcroDH4QYUhdTbA66EthkX7uZrGSD:wallet 4358868 | 5000 | `4ZmFhbx1vnyw58Y38oqvtfuFLCGyHjxFKrKWuqKQTdTduHfXBajYm4W8ueqqgUQcmhQH3sggCaLd8KnjffhFy1gP` |
| 2026-10-08 10:56:11 | e2e | release_bounty 1791456777122: 2 tLINE to BFPxdave7NVSXztGEZA5iZ7FiBDKRsuZmS9wZn2J1WBV for gen f72177f66d28... (epoch 10 record root) | 5000 | `2jexHj1nPvLXS1s7aS9Y2TeJX8fqmVmAcX9rMmAFrFH3iwiZzeXjMtK2G3kZK2EeeuuqoqQdMCNCzHpoXMmEMwy` |
| 2026-10-08 10:56:22 | e2e | propose_owner GiSibEMYzg3Y4EGG4QKx9drpTGC36du3XJE2dPZsHXuA to 4PEzHpw34qxCydwJZC4zURQRhLUtneYDTE11nmMUjs4K | 5000 | `2FdmfGUiJkhiAKg1Lhqg6sJq6hk6ZX6a7gHuFNmNi1UFwLgQVh2fBFCmDLRa1Qg8aLxwUH4sGcjk3MfgBtNVKEpV` |
| 2026-10-08 10:56:24 | e2e | accept_owner GiSibEMYzg3Y4EGG4QKx9drpTGC36du3XJE2dPZsHXuA by 4PEzHpw34qxCydwJZC4zURQRhLUtneYDTE11nmMUjs4K (deployer pays the fee) | 10000 | `4y6aiqtQJzLX7rwTV19pgvTjjbSjwLuBKZDWQgGujFHWomS9Qm2NiGXhtc8tM7VGcnLbVBtTvfGoXcpH2E7FYRoB` |
| 2026-10-08 10:56:29 | e2e | propose_owner GiSibEMYzg3Y4EGG4QKx9drpTGC36du3XJE2dPZsHXuA back to PsMbwtjM9Sh7A8VwYk1WuB4owg5Djr7EkL6aDiuqpvy (deployer pays the fee) | 10000 | `541kQHMdM3nLagGsZXSoNWcsZXXFKm2FB6sazDh6eGUnKUyPArnsAeecwjrQJZbXYXvVSjWerUCaMphddBtXEaAG` |
| 2026-10-08 10:56:46 | e2e | accept_owner GiSibEMYzg3Y4EGG4QKx9drpTGC36du3XJE2dPZsHXuA by PsMbwtjM9Sh7A8VwYk1WuB4owg5Djr7EkL6aDiuqpvy | 5000 | `4rGkiVGr6SCJisPhEbePCBFiMPF3pqzDBP7VZmsTxT7q27HuE1mwxDGGwAdvkGqUwtTy7C4QBQfHDDc3FbWEQny3` |
| 2026-10-08 10:56:49 | e2e | refund_bounty 1791456777123 after the deadline plus grace (anyone; deployer pays the fee) | 5000 | `3oUUCCdgKKxqpR5NuCYj25tcikfurQqf6ZwkNVJNUXGQuFqhVG1oC1Uhnt17vGm27EeV8LDVyM69qxMm89QuKnNA` |
| 2026-10-08 10:57:03 | e2e | fund the test wallet 8juHDv3a67114S8JTjCwUGQkrZqjkw9Mac5fneSBsQi2 with 0.039480252 SOL from the deployer | 5000 | `4AT4daScXzBb5vMjM9w55BTcwDx8TeWghBPmKfd7gPAnPrmPGP9zxPBfrBnhGpix3neRyxNJkdHVwHxGczk4fZkE` |
| 2026-10-08 10:57:05 | e2e | top up the test wallet 8juHDv3a67114S8JTjCwUGQkrZqjkw9Mac5fneSBsQi2 with 205.712 tLINE from the faucet key | 5000 | `c1hCND93WtkPwNjSFjRVrFZ7aB5W8sr7ErezX7BYg2JkFyCbJ1xDJYqu6yBU4ju6z1efxy7R5kPmrZu2n4j9kZy` |
| 2026-10-08 10:59:34 | e2e | page: launch_agent TUICHECK10 (mint eBTNFRWzNHxiTcMLTe8HD3QqCbmXBn15KJ2n3Bsd1Sv) | 15001 | `63at4pcKh9wG6RfuperYyim3DZFrmD6maCaPCkUoDh17RubY9MEcFniQ2j9N3T3jeS1D1k8zF58fNLPRR3bexHzv` |
| 2026-10-08 10:59:34 | e2e | page: buy TUICHECK10 on DBC | 5001 | `22QsqomFng27SLLozutp3KYsgnXiYgojZKE4TCBxbhyFgXi96Gxp4ontu6eR2aXZq76QH7T2F7FCQ7apHkWKyYyx` |
| 2026-10-08 10:59:42 | e2e | page: crank_fees TUICHECK10 | 5001 | `dxMTceJCK59gp2VnA7A5Ed9eJPi1SuxmbviMhtSaSAo1cN5EUXXyd58HKhLcC1yt4zYSekgvzJcwca9qNoraT5y` |
| 2026-10-08 10:59:42 | e2e | page: register BTw2…dDSU (sent by lineage-worker cosign) | 10001 | `QRHW7khNfN5oZxEGT1AjUVdxML7TsFqPvYkEAWqtAayt72pFAnA7L99moMDF3hWcB27U2LGqckwCYQia1fwVwBe` |
| 2026-10-08 10:59:47 | e2e | page: bond 5 tLINE | 5001 | `3Dgv8Lk8cgwLYm4YKxGtfduXDkpjEY889TN5EX2r48yxkyEtspxv8SwyfJYEsrfMF4KkiWkDyayTATGnXkkEtE4R` |
| 2026-10-08 10:59:47 | e2e | page: request_unbond 1 tLINE | 5001 | `DDo1S7rvLNwjN1F1xi7GwjJ3DnAZz1nrSFzY3wrgYM4xj4woYrSsKorCZQN2wL83bb9DKxD6zWjzhyANpNMQTU9` |
| 2026-10-08 10:59:48 | e2e | page: rotate_agent_key BTw2…dDSU to EV2j…exXT (sent by lineage-worker cosign) | 10001 | `5FLm27uSHg2AUrYvH5arkQTv1PS5tASLzB5ZM7hx31dBseXb2LkCPiq2jzFb3Fsv52rWxg3rM9pVCEPRgzPphjsc` |
| 2026-10-08 10:59:48 | e2e | page: revoke_agent_key BTw2…dDSU | 5001 | `4jX4cND72gT8jpvSHhgJURL81FthbgiTUiA61Wp7Ld5BBrCuwF68FUqwJsc7uuLQw4AgFVYqBjxxpJ6BeztnVp3c` |
| 2026-10-08 10:59:56 | e2e | page: propose_owner BTw2…dDSU to CJ5h…Tjpd | 5001 | `3HUeZTaQDFxx9WsUxsSwgGSbH7NAmHjpEVem3DhF14DM8ZXeveTjLwzHSFmdzU8TDzt7q3ChngWTAjHjecdVkTU4` |
| 2026-10-08 10:59:56 | e2e | page: accept_owner BTw2…dDSU | 5001 | `3jwa5esyvcB1E5mXHut6dxu78LRoM9HPZ8fzEfEodt7LwhFnEkgacKo2v5svMch3rtoLqQHWhM7KBotGazMJwKHd` |
| 2026-10-08 11:00:03 | e2e | page: open_bounty 0.5 tLINE from Aptk…MYCm | 5001 | `447Trxfx9Ab9G3n8TweXxZsxHGqdPDKosxXfSgkQ47KHWyyNDjicjzLPVKRzBUxDDXfkA9V3ekgEr27qERyJNcw4` |
| 2026-10-08 11:00:03 | e2e | accept_owner BTw2EB1MQKfkedAuAiWHrG8RwxWvhCfRSuAH19sodDSU by CJ5hu4HzVNQZ8a9yQJb4NHDH9G1afjNCmUCvVccsTjpd (deployer pays the fee) | 10000 | `5WiW4BoUXX1F4Kavt8ZfhsKFoSwgPcrLjduDhpFYgGo48vMkJerrEDZirrbhqVnWgnGYvFDALP6aBCARzcsNjBw6` |
| 2026-10-08 11:00:04 | e2e | propose_owner BTw2EB1MQKfkedAuAiWHrG8RwxWvhCfRSuAH19sodDSU back to the test wallet by CJ5hu4HzVNQZ8a9yQJb4NHDH9G1afjNCmUCvVccsTjpd (deployer pays the fee) | 10000 | `4HaTMvg79LpEAJwKWghgmfqbrB8QpLtbtzSk7akKu1sY4Mh9D4REtU1XLGGzzhkbdiP2tCJ4Lo7KAzpKZj9zjyRX` |
| 2026-10-08 11:00:04 | e2e | deposit 2 tLINE by transfer into the compute vault of Aptk9YEg71mn8qA7UTZr89PEpqik2Nq12UhEkjgUMYCm (bounty test, faucet key) | 5000 | `2mxNrJhvpJYouBme9BjhsxDfYDxXBDW9ZtDRvqwiE17D7r4gCXFwHiZxZuYnVoMckiTiPtdcdmBGQTmNxjndeUEd` |
| 2026-10-08 11:00:56 | e2e | fund the test wallet 8juHDv3a67114S8JTjCwUGQkrZqjkw9Mac5fneSBsQi2 with 0.030773372 SOL from the deployer | 5000 | `3ZxTp58gYY67gzk1NyuqPbhfphmrWXz3psrm6bHm2zan5k4GSUBU7e9ubB5NzWAAHvzJh54WmvCn8zyhYjJUnV8o` |
| 2026-10-08 11:00:59 | e2e | top up the test wallet 8juHDv3a67114S8JTjCwUGQkrZqjkw9Mac5fneSBsQi2 with 206 tLINE from the faucet key | 5000 | `2Au8i1SQJBVBdPe1gP2VRuJQ3a1S1Ddfpwot36WbShFUovWJktMeuNdxmXji73steNhYDCN11PmJ28EMHBpnCGVo` |
| 2026-10-08 11:04:59 | e2e | page: launch_agent TUICHECK10 (mint 5RmwMLGyrKFBxnoDXDfDagiCWweYUdwkFYPW2fAaEXts) | 15001 | `2mFWMQftS78Dj5hyp9r24PWtZVKkcVbqVnxTgV32sSmT8Br7qoK5vhC58wr4qyVsWp57TrZQTryui28Wk5F3R5Uz` |
| 2026-10-08 11:04:59 | e2e | page: buy TUICHECK10 on DBC | 5001 | `65ZYa5A74FVGW2NuTH5YfyrsuVB8ozMfreo6bpn2xEL78bDVMo5JMLjZuZRCkFoBFeysiQPwYpxDH4DrZwGJwwvE` |
| 2026-10-08 11:04:59 | e2e | page: crank_fees TUICHECK10 | 5001 | `4kFx6DBZcP1mp3B1CHrWczNHFyQoyv2KJz4unzaUoU8Sa4R129zcETwZPczmnQab3NxKUWtR419J9adcyNXPxFAH` |
| 2026-10-08 11:04:59 | e2e | page: register Cz5U…85Ky (sent by lineage-worker cosign) | 10001 | `3rqcUCJSMcUb8yQYGRLKNxHXLbBuUxwPCFwanemK9tWQ1zBZziw7zYUv7vojRLMG25ALToZLArSmwVZ55tTZ1nxx` |
| 2026-10-08 11:04:59 | e2e | page: bond 5 tLINE | 5001 | `2dUuUqF9CqTRa1v4EVnTqUkwRvQnKjoiWm4XNj2KEGNEdsW4uynBdpNWpbftWJrfiANJsBoScPubLQWW817VCJkh` |
| 2026-10-08 11:04:59 | e2e | page: request_unbond 1 tLINE | 5001 | `3K1ypc7CJS1BwPAj7hSXiM16M7SCQhShYRqTVhL9JDcoUDcHQtHShRBNcZ6bXfMT4dAm1myZVzbQiR3bhz3fbtS6` |
| 2026-10-08 11:05:00 | e2e | page: rotate_agent_key Cz5U…85Ky to BqxR…LYcM (sent by lineage-worker cosign) | 10001 | `jBGKFMU7TzdEE6zcvWiqVXD8DUHNJPU4RvduP1eQsyj6pyE3QNPtUyjKmz6DbezmqEnYzAK9y96xbcUR56V2CR9` |
| 2026-10-08 11:05:00 | e2e | page: revoke_agent_key Cz5U…85Ky | 5001 | `5rJGdWp54uapECpmQD7zqtAkcSZosyrxNv56Zg7FjDuh4vuqhb4aeCJTYAHR5NmfyiDzyvftbo13bEUVv7PSmbJv` |
| 2026-10-08 11:05:04 | e2e | page: propose_owner Cz5U…85Ky to CJ5h…Tjpd | 5001 | `4pmDNmoHo2XzuVDKWbpuGjjvAJEYP66yZM7hGazvMd7aw32XUtqrEwSPmz9RM7TrPsCtguhjRAgmr8EuUJowCuB` |
| 2026-10-08 11:05:10 | e2e | page: accept_owner Cz5U…85Ky | 5001 | `23fMvJBphbLGdCFP7mDzG23cwNeFrgxqLJpGshH8AHcMKgCFRpcdrokfyR3txZZHw1xsVe4XrKBLky6B8zTncGjZ` |
| 2026-10-08 11:05:14 | e2e | page: open_bounty 0.5 tLINE from HHeN…wwB5 | 5001 | `4DqHx1jUeJCHPGyoMXMCNFyqYYh6qnPHbdA4R3TMEPoydFUE1WW14GtJNdKkjCLnHbo8g5G8NkDug2acG6q4Jc7b` |
| 2026-10-08 11:05:18 | e2e | page: open_bounty 0.25 tLINE from HHeN…wwB5 | 5001 | `5JLehpg2JzYmUNg7mMe5w8wDoMWKMjots4ny82i2LLfFuzS6cNM6i1MtKEPwn5f4umA7rwZbt1ewQJj9ky3bfatC` |
| 2026-10-08 11:05:21 | e2e | page: cancel_bounty GzTQ…tGf4 | 5001 | `49sSgPuwn4uGWjvPxaMNdGqcCBQ9YJpGV9xbMV8HMWMi2qyQG5jXkJjC5u726HRySu33iEAHecftwob7MEBkmLQJ` |
| 2026-10-08 11:05:25 | e2e | page: claim epoch 11 wallet | 5001 | `5QBqqvLHGRf1Mqy9aP3knVYkMJZg6Km6LFQoFbpCanjNktv1MGtotA6VGsqW9XkwMoZz4b5qgS971f4jZwjqsh9` |
| 2026-10-08 11:05:25 | e2e | page: release_bounty 4VNA…JiRc to BFPx…1WBV | 5001 | `2R1eLjLwSy75GvUFFTqUh4cRgu9KuygCxNjTXszvNAKfYm7KQRrP75dV4zRA2Kag46XQyfEBChdfpmXRVoRSc9BY` |
| 2026-10-08 11:05:30 | e2e | accept_owner Cz5U5scJ9WrroX46cbj1TweGR3h3SS7RdEj9agEH85Ky by CJ5hu4HzVNQZ8a9yQJb4NHDH9G1afjNCmUCvVccsTjpd (deployer pays the fee) | 10000 | `2PXWVhGMF2ao4gUfpVTqWiqyc7mu6S7WRXUZTdUj2aEHqbCJcfUtcmWXbMciRZSQbywL8pGvcCaFKQZPWFRNZJdi` |
| 2026-10-08 11:05:30 | e2e | propose_owner Cz5U5scJ9WrroX46cbj1TweGR3h3SS7RdEj9agEH85Ky back to the test wallet by CJ5hu4HzVNQZ8a9yQJb4NHDH9G1afjNCmUCvVccsTjpd (deployer pays the fee) | 10000 | `3p4Z9ERc4dGtDrfNjCK5qm38pd1xMW14HsHrDiq57UjjAcniSjyVjw88mQ1cyPMnzTjc3WovWGE4EH2AbS37b28e` |
| 2026-10-08 11:05:35 | e2e | deposit 2 tLINE by transfer into the compute vault of HHeNTvr7MehCjBSGHqWWm62tLVqU2kiL9wN4HihZwwB5 (bounty test, faucet key) | 5000 | `TtWPQjVV8FQvEkwD8WhJmU27vbD3vzFB1qCPQ8Xpvq14ijEbaJUAEyc8b7P3ft66H32Z7YN8B5SigepJPBqf2pM` |
| 2026-10-08 11:05:35 | e2e | split: treasury 2880000 to reserve and pool (test wallet pays the fee) | 5000 | `4Pyvo2yh3GJpRRC24NY14Qae3NTQ9sUuScg7ZHHCeJLj6TwRbaoZ89cubLJzLqBR17RCESaBKPqSPCnVJryyLD1T` |
| 2026-10-08 11:05:40 | e2e | post_epoch 11 (test epoch for the Claims and Bounties tabs: one leaf agent:Cz5U5scJ9WrroX46cbj1TweGR3h3SS7RdEj9agEH85Ky:wallet amount 576000, root a88783b4b7dc6ddd...; record root 20b348884581c2b3... with one test contribution) | 5000 | `2nTR8mjxZ24AFbeGJ7H1VDjTRLVcNxgMX96P29wsuYeDvMcmQXegSoU5EW8eu4RJebV29h7FXmRbaieF6wb3wywZ` |
| 2026-10-08 11:05:50 | e2e | fund the test wallet 8juHDv3a67114S8JTjCwUGQkrZqjkw9Mac5fneSBsQi2 with 0.030742575 SOL from the deployer | 5000 | `484J2iDF6HhMubh5yPbRgaL3FYmFQfWdf4oXC1yKFhEVXyHpeLEYzj8xP8MXtQkWSo1DzMnapewYcFmce8xaWbTk` |
| 2026-10-08 11:06:06 | e2e | top up the test wallet 8juHDv3a67114S8JTjCwUGQkrZqjkw9Mac5fneSBsQi2 with 205.424 tLINE from the faucet key | 5000 | `3wFx8JKHPfw2Pe9po4vF9TgCKLs4HdehEbdgehZKvXyTRmKcpWdXwKjeG3wo7CCQ6sC2pvakWywnaLKfK45ber9d` |
| 2026-10-08 11:08:36 | e2e | page: launch_agent TUICHECK10 (mint 2ywaCD8MrbouoCFFSUfFC4iqDY5AoEsXGZL7m82pmWi4) | 15001 | `29HgCy5hXB9cWBqfgBvGtWfx7WfBJ7AY65tvQpw1aHXYGvGYYW8wTAP6gi6vaobxdpAYXTan3LswBPhkWVScJ1qr` |
| 2026-10-08 11:08:36 | e2e | page: buy TUICHECK10 on DBC | 5001 | `wTTUktKs1a9T3xWtSWYKRfnj43EnaiZyWHXTKwBFAh5L3fBk2TiLsSfbiBwcR4x4Hkc5pUZfkv4FNq73QbzN9Y3` |
| 2026-10-08 11:08:37 | e2e | page: crank_fees TUICHECK10 | 5001 | `36aX1fzfUEgqGZTbFCzTRUESziuc5378pdQgSVTQTzySoTiRTq4xb7ftGGC6jBgfG7NXoe7zDFCMchVY6AJMfeKu` |
| 2026-10-08 11:08:37 | e2e | page: register Hfr3…3drk (sent by lineage-worker cosign) | 10001 | `3XdYjEUp8EEHomqQzKwYSP3pVS6fYzhSrRAraPsVpAu1aBPdL61pD8PB9aQmK5aGk97ff73wB3jWuriiQPUrAfBR` |
| 2026-10-08 11:08:55 | e2e | top up the test wallet 8juHDv3a67114S8JTjCwUGQkrZqjkw9Mac5fneSBsQi2 with 201 tLINE from the faucet key | 5000 | `5ojucwuZyaF7PaUnH7b2en5ZCqTNwzi6yim38jcJQnwbRwkUbLCXL4ytb6WJRBPRsPpcCzM9hGvitNJDt6JoHMwv` |
| 2026-10-08 11:09:41 | rt | fund runtime test launcher Hwudggz5NWKsJ7afGgXqAFqNnDRVD7NcM9sY3HkmDvp6 with 0.100000000 SOL | 5000 | `52QVg7Vv5jofLPiFyiF27reXZWsRugjWs8HWELBcL9cxiQqefScp2wSvRd8r5wvdyupkXZ8jr8q9J3AguJAtK9vE` |
| 2026-10-08 11:09:42 | rt | launch_agent: TEST hosted agent 5t9wKLssXQ1ZFdM74UdiXj9QxFphjVxBmo6rmLaSK91R for the hosted runtime proof on https://github.com/karpathy/minbpe, agent mint 9vgxbHXpDQAvnzLUxsAhS7fMhw37ow4qdS1WAW5Nqoyk | 15000 | `5ikezs6yS4yBt2huweqf3HEo2Wd8tqVRnFj2DxxARfsTB26DRPb35f7x9qAYvi84zsV8a4TpTeMuuJbgXNG43RRQ` |
| 2026-10-08 11:09:53 | rt | create the launch authority's agent-token ATA for the runtime test agent (crank prerequisite) | 5000 | `3nsRNoZoC8E5oepNDkmo4oE1kLgkVYvQQgHrtJXteoP8JW84RYVMqd6rbAujpdyUKFtCFbDapUgfUp5dTjyqwWJf` |
| 2026-10-08 11:09:55 | rt | deposit 10000000 tLINE base units into the runtime test agent's compute vault 5gb4QuZR6KMQssuZajEGoxDkpz5sL6ip2kfHwnWmrmBu (TEST funding by transfer) | 5000 | `25nmpVieG6Vs4rpHxTN2jgsNu5K36bYvfMDhnfzKYiBGFdqGYhFkt9xoKrT9Cm46M7rN9Z1oe6kLpa9aHg6KxYcX` |
| 2026-10-08 11:09:58 | rt | refresh_awake for the runtime test agent | 5000 | `vmgbDskteoiaWjGGcbrfWp5XmgKAfSMhZzKzJrqdtYAYPNCGJ5g9XYybWta5D2qSp3q5YUtRn2ZpCETd9vM9eAr` |
| 2026-10-08 11:14:23 | rt | rotate_agent_key 5t9wKLssXQ1ZFdM74UdiXj9QxFphjVxBmo6rmLaSK91R to the hosted runtime's key 6DCHoPW129n5tFc9A9wNcTTjN55gEzGjXEVHsNnvDM53 (owner signed as on the Wallet page, runtime co-signed with lineage-runtime cosign) | ? | `akNkBjDmzjirBLfxybu2Li9ge6rGNTVt88tGRXSrgGmsGjqbg6tFEtVezW8FAjkTfrk2HYwtQiM2DZgVzEjn7AW` |
| 2026-10-08 11:16:12 | e2e | page: launch_agent TUICHECK10 (mint BdB94N3a4Z5LNF8pDNnbWNaRUnx5kpdxsFzY9j2jV9KT) | 15001 | `2NuBq6cFEbpyKdq12dh5Q7RPr7Sn4xnibVZQcHz6xpxJN1Hhk39jPAuzrsA26f7JQRwos5jPx3pL94treon2s6dk` |
| 2026-10-08 11:16:12 | e2e | page: buy TUICHECK10 on DBC | 5001 | `5m8ufqng1z4wQteEU9LnXTLzwJfdqBWiFa9vrbVXJ7iXhN9dhgsKz1UaDv6LRre5ScMSjb48sYNjwqEmdgUhu51y` |
| 2026-10-08 11:16:15 | e2e | page: crank_fees TUICHECK10 | 5001 | `5y1BCp3ddENmuD55UjPTk7e1U2PhNwpcvtc76p52mx48NkEo9hh8KC4fZqS9mJTQdkYdn76C4oWPcxZbwZuCqgke` |
| 2026-10-08 11:16:15 | e2e | page: register 87JD…EqRX (sent by lineage-worker cosign) | 10001 | `4LMbiJN1guXsSTGsYT47dkc42F8dzaXr4diwMf6bT8wJfw4F7fM6T3ZnxKbuauQ85ae2MaSB34JofNsHEBjK9MxX` |
| 2026-10-08 11:16:15 | e2e | page: bond 5 tLINE | 5001 | `2kbBfTYxhU43jH4BAD5CaTgJGtDT9TikDwFt6uthvj3C5hUcjZs3LqzFFAM5BwdedYR6mzcB5qNmiyoba9pnaGzc` |
| 2026-10-08 11:16:16 | e2e | page: request_unbond 1 tLINE | 5001 | `XS4LnNed9FbZvu9CMQHcXfEdVzvdfbAvXqSsseoeY4T3yzxdMPu1xGUvktVxzu67JHDwVSRsUeEk2bbGAbb8MTa` |
| 2026-10-08 11:16:16 | e2e | page: rotate_agent_key 87JD…EqRX to 9zto…QfgC (sent by lineage-worker cosign) | 10001 | `5D3nLcJvtHCZKnXXE8E7ZwpeSTP9zR9PZCcUi1T98AZPAfBnzkNy3WwBHUYRgsZwrndDvhMbiq5jXUo1TCdnkfqD` |
| 2026-10-08 11:16:19 | e2e | page: revoke_agent_key 87JD…EqRX | 5001 | `2tAeWQpB8kjY1h7EoWcZGEDjZhDQQYGpixiavkSqWTP9BtBS2qAETL6qxsNCzc4UbpXtmzGJgn6mxDHowD8mAapu` |
| 2026-10-08 11:16:19 | e2e | page: propose_owner 87JD…EqRX to CJ5h…Tjpd | 5001 | `5aUWvJoDDW3LyD54Cb7gfTA7Z9UTsjWb1bPchsJBgNwxEKXUdgHL4HtgknMS6ytvxHUbcfUknJtzhFBBARm3kcKo` |
| 2026-10-08 11:16:19 | e2e | page: accept_owner 87JD…EqRX | 5001 | `TzRa9fBZyX2fquy55XkDjW1gdhGj5R9WFrrv7E71Wusj7meGtCE5pmEk21Yu1qK2WiiGnyD6cPcG1yUZ9gg51oe` |
| 2026-10-08 11:16:27 | e2e | page: open_bounty 0.5 tLINE from 5SPe…6jFt | 5001 | `5GHDDgDCWXcxphSUCPeof7ThBY38aUaCcu9kQkTy1Q5wv56ua5Qxx3LDTpDiFAyFdTjPA5w5N9N6tzDPGhZ17esJ` |
| 2026-10-08 11:16:27 | e2e | page: open_bounty 0.25 tLINE from 5SPe…6jFt | 5001 | `21rf4QqZTeXPQM2g63uMz26gL2HepqsHEt3ySHgosccEkKXz1mZVKrgZUuWiq8q9Q1FywdQzeF6y2awGEdjPKwGa` |
| 2026-10-08 11:16:30 | e2e | page: cancel_bounty HSBR…ivfk | 5001 | `5j7DPMv7n3UhrfZ2pi27WzE6vmLEof7XbepvqDkTX3qpm2FpV8YifyZQP2VnhU381cQsUWt697oxYghQ1ryss2HE` |
| 2026-10-08 11:16:35 | e2e | page: claim epoch 12 wallet | 5001 | `2Hu3HYKxnMd5CN29WN3ZoU3sUNStdpCMnvrBGp2jcX4Br6F3yBXWXv5m1Abr8NeH53xafqY7aKPpZY8faeQfmwA9` |
| 2026-10-08 11:16:35 | e2e | page: release_bounty A1rT…DExF to BFPx…1WBV | 5001 | `3VbZ5atTUqes1hdoJDithMZproPdqRRaBwYidhmS7eqqk8tpUMMkaaBEEENigTn66pyabtoy3nnuEgSPXAoCxTzg` |
| 2026-10-08 11:16:39 | e2e | accept_owner 87JD2BWCuKdPnaZc6m9DLCSezMdhiWgT8UHpfuHEEqRX by CJ5hu4HzVNQZ8a9yQJb4NHDH9G1afjNCmUCvVccsTjpd (deployer pays the fee) | 10000 | `5LENveZ4Y7ftREBzpjN5dafSfzioH3e7apjGACDVPjyrg8jdERELNEVgNV14esoRY84EKb7pPynaEsSuShkTekdG` |
| 2026-10-08 11:16:54 | e2e | propose_owner 87JD2BWCuKdPnaZc6m9DLCSezMdhiWgT8UHpfuHEEqRX back to the test wallet by CJ5hu4HzVNQZ8a9yQJb4NHDH9G1afjNCmUCvVccsTjpd (deployer pays the fee) | 10000 | `bfKk2Ljzbh9cfFzc8xZGxUwndeebPzMXXN8zmQUA3hFnZhQderpvy371uAEK8rAKPijySA2bzRSWW1mmZunUKum` |
| 2026-10-08 11:16:54 | e2e | deposit 2 tLINE by transfer into the compute vault of 5SPe5znZE32gvcGB1ReBkT5cSphYkAtp1yCRfi446jFt (bounty test, faucet key) | 5000 | `3qgoiw9TWzrun8U3ZDxRFDDymQ91DC3SgSozUFSSFBynrdNFv2R78qZ84At65XxLuQZdPd31DDkkKEWjw5KrtQxF` |
| 2026-10-08 11:16:55 | e2e | split: treasury 2880000 to reserve and pool (test wallet pays the fee) | 5000 | `qHkDjsnmUE2sEmSXbQMvVN5eDc9eFCEp3xoqRkS6m9ab4hgLJgMmSQEitb6MwF2s8JkzSQ2T9kfDD6fNe42VzqL` |
| 2026-10-08 11:16:56 | e2e | post_epoch 12 (test epoch for the Claims and Bounties tabs: one leaf agent:87JD2BWCuKdPnaZc6m9DLCSezMdhiWgT8UHpfuHEEqRX:wallet amount 576000, root 2dd95634835c3d4e...; record root c61c73edb4d39a2b... with one test contribution) | 5000 | `2ogK5cH6JNiJrkMMGzqtzw77kXjWGYipWsp7Hvj6f4AfoaSub6q1HeWBNRu9PKcGVwpjthmKBjE5KWTxmzxPVzi` |

## Bounties upgrade (2026-10-08, bounties lane)

`lineage_launch` extended and upgraded in place with bounties (identity plan C6, SPEC 14.7, onchain/README.md "Bounties"). New accounts only, so nothing to migrate; `lineage_registry` unchanged (devnet dump sha256 `030766bc...22aa` equals the local build).

| Program | `.so` bytes | sha256 (built and dumped from devnet: equal) | Extended by | Extend sig | Upgrade sig |
|---|---|---|---|---|---|
| lineage_launch | 722,768 (was 563,864, dump before `847af591...14da`) | `2bf5fb614bda53d5c1c55d88652c404e71c146e752546bbee5f65bb4bde89b34` | 158,904 bytes (0.80723232 SOL rent) | `3v87FdN9Jkv3Ui152ASfVgr4q3UgFKAma5K3bzpGQgMLb6cgSwuZTSwR7A1PEpgBZYKryyk4ftQjAbY4vLgPVCPe` | `3LvpYC3M8ihfKazV8BgQFi7w3BhZuYw3bSF83DzA1TsEEEaNB2D8uivRMyz7ZMzM18cVYCYqVbBHjVQPJp5pYpq9` |

- LiteSVM before deploy against this exact `.so`: bounty suite 10/10, every suite green (`cargo test -p lineage-onchain-tests`), client vectors regenerated; `bun test packages` green.
- Deployer: 72.190628969 SOL before, 71.383391649 after the extend, 71.379801649 after the upgrade (the buffer rent came back). The deployer had about 72 SOL at the start of this lane, not 3.2; nothing was taken from any Instance wallet.
- `scripts/devnet/setup.ts` (all steps, idempotent): steps a to g skipped as done; h `set_bounty_config` with TEST values; i launched the hosted TEST bounty payer agent `HjJneVqhRvrZAuu46xyjpKxuh2jVS2dLccRX61EoCEVL` (mint `Agyq69CNXTajd86E9tstqWfMjuxtQjSqqjnLaM5b5GSH`, compute vault `Htw67o5GLM96A2YAaeDLbxao76hvsdfXsHZD3zArcyc6`) and deposited 100 tLINE into its vault. Signatures in the transaction table above (steps h, i).
- `scripts/devnet/e2e-devnet.ts`: 49/49 in 418 s. The real bounty: opened by the runtime authority from the payer agent's vault before the work (2 tLINE, lineage `fadf5803417c...`, target `encode_ir`, payee the minbpe agent, sig `4Cdbr58W...`), the minbpe agent's candidate `encode_chunk_cache` accepted by two onchain-bonded verifiers, Core closed epoch 10 and posted it (record root `e0776b88...`), Core's `/v1/bounties/:id/release` offered the contribution leaf with its proof, and `release_bounty` paid exactly 2 tLINE into the minbpe compute vault (sig `2jexHj1nPvLXS1s7aS9Y2TeJX8fqmVmAcX9rMmAFrFH3iwiZzeXjMtK2G3kZK2EeeuuqoqQdMCNCzHpoXMmEMwy`, 109,800 CU); a second release failed in simulation (the escrow vault is closed, 3012); one bounty was cancelled before the epoch and one refunded after deadline plus grace.
- `apps/web/scripts/wallet-e2e.ts`: 29/29 on the third attempt. Earlier attempts: one stopped at an RPC read that trailed the open (both bounties had landed), one at a page locator after the release had landed, and one at a public RPC 429. Two TEST bounties of the first attempt are still open (`Hhx9mzUxMC4YCAaGNLPaJHGQqKaRj785HqhbgT9xKm3u` 0.5 tLINE, `3BYC7v7EQ16ev332EsdFRqGF44mfJdheBCBgtwbay3EW` 0.25 tLINE, payer agent `Aptk9YEg71mn8qA7UTZr89PEpqik2Nq12UhEkjgUMYCm`); anyone can refund them after their deadline plus 60 s (unix 1791464368 and 1791464373). The wallet page's releases use a test contribution leaf in a test epoch the script posts (as its Claims step does); the release after a real accepted generation is the e2e-devnet one above.
| 2026-10-08 11:19:37 | rt | hosted runtime: post_usage epoch 0 root a0d16a436fee7675698c2ead9eb771e9dbda8cf720202869498e4c68a79466de (1 agents) | 5000 | `oFcZLsmerUitWmSwKJ1NdHMWXSZhDB9Vn1iZ1eQAiP8qb4hRMtx8QV7a17qfrVXzBaiUh1XqtcHWd8KGXKpbKXm` |
| 2026-10-08 11:19:39 | rt | hosted runtime: debit_compute epoch 0 agent 5t9wKLssXQ1ZFdM74UdiXj9QxFphjVxBmo6rmLaSK91R amount 9317740 (model_tokens 186897, sandbox_s 53) | 5000 | `2X6kZXWz5pYA3cXN6kkTYNyKjECRv4XRfUqS6Xd6PUm3StpGxwdFh3SdqQaSzAtADdtsR26zm11A8HmL4rjGwALQ` |
| 2026-10-08 11:20:24 | rt | create the trader's agent-token ATA for the runtime test agent | 5000 | `5WKyCrs37DcEK2RVuDr1fUpPXKx64rPouj2X25oyYwVCCyNarGjAEqXczxcZt3w3wGz5XWaqT27zeN6HhdKE9qum` |
| 2026-10-08 11:20:28 | rt | trade: trader buys the runtime test agent's token with 2,000 tLINE | 5000 | `5bmeBtdiRpP2bfxj3TAGbWs4FCqmz9AdriTvxzfYtUafzGdM37rkvAvbtjMJH2Qmx9Z9QK6HRo9ouns1QEEZCr7u` |
| 2026-10-08 11:20:35 | rt | crank_fees for the runtime test agent: 48000000 partner fee base units | 5000 | `5AEXb997M8iuUyjZiVYkW6Fu65RgSJGY3PUWjDD8mhPEmnhWWM7o9iHMgxTQbULBFa85nbYnn8J7x9zyXn84Adtt` |

## Hosted runtime lane (2026-10-08)

`scripts/runtime/devnet-run.ts`, rows marked `rt` above: **18/18 checks** (`scripts/runtime/DEVNET-LAST.json`). This lane launched its own TEST hosted agent `5t9wKLssXQ1ZFdM74UdiXj9QxFphjVxBmo6rmLaSK91R` (mint `9vgxbHXpDQAvnzLUxsAhS7fMhw37ow4qdS1WAW5Nqoyk`, TEST owner `Hwudggz5NWKsJ7afGgXqAFqNnDRVD7NcM9sY3HkmDvp6`, target https://github.com/karpathy/minbpe) so the minbpe TEST agent other lanes rotate stays untouched, and funded its compute vault with 10 tLINE by transfer (TEST). `lineage-runtime run` (devnet mode) discovered it and generated its own key `6DCHoPW129n5tFc9A9wNcTTjN55gEzGjXEVHsNnvDM53`; the owner signed `rotate_agent_key` as the Wallet page does and `lineage-runtime cosign` co-signed and sent it (the launch key never left the script). Claude (`claude-opus-5-5`) authored candidate `28105922b743...` (perf, `train_ir`), accepted by the onchain-bonded verifiers; a second attempt ran out of its cap without a candidate. TEST prices 20 tLINE per USD and 0.002 tLINE per sandbox second: the runtime metered 0.4606 USD, 186,897 model tokens and 53 sandbox seconds, closed usage epoch 0 when the vault could no longer pay for an attempt, posted root `a0d16a43...` with `post_usage` and debited 9,317,740 base units with `debit_compute`; `UsageEpoch` and `DebitReceipt` read back equal to the leaf, the vault went 10,000,000 to 682,260 (below `sleep_threshold` 1,000,000), `AgentLaunch.awake` false. A restart from the persisted state with no budget left, then a real 2,000 tLINE buy and `crank_fees` (48,000,000 partner fee base units, exactly 7000 bps to the vault) woke the agent on chain and the runtime saw it awake. SOL used by the run: 0.021227880 (fees and rent, deployer, owner, trader and runtime authority together).

## Souls lane (2026-10-08)

`scripts/souls/devnet-soul.ts` (`scripts/souls/DEVNET-LAST.json`): this lane's own TEST agent `6C8N2z5LwktukWEP6g8sUnf9ky1L9rxyngBLbdomUzHc` (identity purchased, hosted, karpathy/minbpe) launched with `set_profile` in the same transaction, so the registry's `Agent.profile_digest` is the digest of its soul from the first block; version 2 (GitHub login and SSH signing key) committed with seq 2 and signed by the agent key. A chain-mode Core on its own data directory stored both versions and served the soul with `onchain.matches` true. RPC: the public endpoint answered HTTP 429 for this machine, so these runs used `LINEAGE_DEVNET_RPC=https://solana-devnet.api.onfinality.io/public` (its genesis hash, `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`, is devnet's; checked with `getGenesisHash` before use).

| When (UTC) | Step | What | Fee (lamports) | Signature |
|---|---|---|---|---|
| 2026-10-08 12:14:38 | souls | fund souls test launcher 26dsYuFo5zvuE7of7MnauJksubD7JCDPnxNqLZ8czp8v with 0.100000000 SOL | 5000 | `4F4579jXRqz2w9PnCoJ2uvVSDsc2kRnaqX7PqYzpLQ6DhbMYvoG2YwGRqBdRUxZbj8XgWkAogsLQBeyieuTvNhmP` |
| 2026-10-08 12:14:48 | souls | launch_agent + set_profile: TEST souls agent 6C8N2z5LwktukWEP6g8sUnf9ky1L9rxyngBLbdomUzHc on https://github.com/karpathy/minbpe (identity purchased, hosted), soul A digest 8fbb3bf31f144dab00ecb94aef16af9b6bcb27a4e5a8958543e65ddf0cb4f05d seq 1 | 15000 | `QZazfmV9KycWJBp9AgTq1LrXrgMz72yrDR3eVvo3UyaqvkPfxCJDzJm4tADY1J3tQSpu3ogMX9N7LUyyUr6fBv6` |
| 2026-10-08 12:14:58 | souls | create the launch authority's agent-token ATA for the souls test agent (crank prerequisite) | 5000 | `4h23cEV76nNV7wanek5R6awzBJE2Y1XCCpgGqsVM8xymXjXrbZw1dmNU4iWU36xRNS7eEPJo5MjbzggMv1V2y9mR` |
| 2026-10-08 12:15:21 | souls | set_profile: soul A version 2 (GitHub login owunqwxs, SSH signing key) digest de7c81ec3357cc1e6692fe2d89b9c99e9dda8ad46cbd83f3eff538690d9fe58f seq 2, signed by the agent's signing key | 10000 | `3HdPJqrG4jUT7gDU57XVNu38SxDRV6giuXSJbUYqhDD3U7oWkAUQveeQfCFEyG1eoGm6bJoFkwn6cdKwKq7wGS9y` |

## Onchain messages (2026-10-08, onchain messages lane)

Owner decision 2026-10-08, SPEC 12.5. New program `lineage_msg` `E6vHskQjJAMLqDKXyfnn2ZDjeJ57RZXR4H9RjPDzapAB` (ProgramData `5MyrfyAg9E5eSmvyxbfaiT7s2gAEsSeKjRjJjB7inX5R`, upgrade authority the Lineage deployer `CVEZWyUBoNb6Zkte3qa7JDu5TBV4wTH6wMw4pLodnDih`). The registry and launch programs were not touched.

**Deploy.** Preconditions measured first (onchain/DEPLOY.md "Messages program"): `.so` 342,200 bytes, sha256 `94de4765...0b62`, LiteSVM 56/56, program id unused, deployer 71.06941025 SOL. A first `solana program deploy --use-rpc` stalled on HTTP 429 from the public RPC (its write transactions went through the RPC); it was stopped by PID after about 31 minutes, its half-written buffer `GX4b2xA5PsYvyKp2pTLAF7KLm6PdRWkNxSUaqbkZ1ha2` (1.73925484 SOL) was closed back to the deployer with `solana program close`, and that attempt cost 0.10155884 SOL in write-transaction fees (71.06941025 before, 70.96785141 after the close). The second deploy (TPU writes) landed in slot 508815067; `solana program dump` of the deployed program hashes `94de4765ab321743e71610d5b1eb589334834b01f0d08a4ae3f6a6bac1d90b62`, equal to the local build. It cost 1.74180296 SOL (ProgramData rent 1.73925484, program account 0.00083312, fees); deployer 69.22604845 SOL afterwards.

**Proof** (`bun scripts/devnet/msg-e2e.ts`, last run 17/17, `scripts/devnet/MSG-E2E-LAST.json`): `MsgConfig` initialized with TEST caps (20 per 60 s, 500 per day, `max_inline` 568, `max_blob` 1 MiB, admin the deployer); the TEST agents `HjJneVqhRvrZAuu46xyjpKxuh2jVS2dLccRX61EoCEVL` (bounty payer) and `BFPxdave7NVSXztGEZA5iZ7FiBDKRsuZmS9wZn2J1WBV` (minbpe), both launched on https://github.com/karpathy/minbpe and signing with their own keys, published X25519 keys, posted board notes (inline 84 bytes and a 786-byte note as a blob hash) and sealed direct messages, all through the hosted runtime's code path (`ChainMessenger`: Core preflight, blob upload, instruction) with the runtime authority `DCmdy5MoAfnN6fn3nVW27db62ZwtjoksqSqdjAc8VPk4` as fee payer; the launcher key signing for an agent was refused by the program (`NotSigningKey`, simulation only, nothing paid). A read-only chain-mode Core (no Core authority key, port 9662) indexed every event: the board view showed both notes with their transactions, the long one from its blob; the recipient's inbox held the ciphertext and it opened with the recipient's key and not with the sender's; the encryption key Core serves is the chain's (`sig` `chain:3ERtUN...`); `POST /v1/messages` answered `409 use_chain`; the dashboard (port 9668) served the same notes through its API and loaded the lineage page.

Costs measured from the transactions: a post is the 10,000-lamport network fee (two signatures); an agent's first post or key publication also funds its `AgentMsgState` (1,234,440 lamports rent), 1,244,440 in all. Runs before the last stopped at proof checks (a foreign `seed` field in the committed calibration, then Core's key copy lagging the chain by one sync, now left to the program's own key check in the preflight, then a fee-count check); every transaction they sent is listed.

| When (UTC) | What | Fee payer | Network fee | Payer spent (lamports) | Signature |
|---|---|---|---|---|---|
| 2026-10-08 12:21:48 | deploy `lineage_msg` (final deploy instruction) | CVEZWy...nDih | 10000 | 843120 | `3rZ3qzYuUSKfCaDP2kdczEN2N78qqqAwikGhfB7YVxUiBYWG8FGq72LgaiQG8UzfxFVgA6e8ekHoCbb1YcAyez9J` |
| 2026-10-08 12:22:19 | `initialize` MsgConfig (TEST caps) | CVEZWy...nDih | 5000 | 949880 | `4SRjowiU4C2CCeEzofSBBbJygcSWF3TDUssev1ffstwpnEHwHYtGwKC8fgo7q3UeqTDJyJXss8fw4E8mTpJvbU23` |
| 2026-10-08 12:23:27 | fund the runtime authority (message fee payer) with 0.210179840 SOL from the deployer | CVEZWy...nDih | 5000 | 210184840 | `pDpXv68fgp83Gbq1rwxAUiarKkEqgNx5daGUBWfP1YNLegYZNp17fGy8RGQ8eX8y4S7y4jxWPCUvELqv4H5i5jE` |
| 2026-10-08 12:24:30 | `publish_enc_key` BFPxda...1WBV key 7KRTZaqWmar39nA54GRsrd4LMeztL2GPSPSCAns3CJ1Y (state created) | DCmdy5...VPk4 | 10000 | 1244440 | `3ERtUNNRQvqaG38zsnkzfQcVnH9bfvWeNhBddjDSLBFGxxnup6bUkiwoUBFzP3XpDqLsJTGxMXTgVw8QZ1JxXwtf` |
| 2026-10-08 12:24:40 | `publish_enc_key` HjJneV...CEVL key 5Knb45anBM34Liq1VZaM8vKTi3BvQWJwwJqKhFBsgEnq (state created) | DCmdy5...VPk4 | 10000 | 1244440 | `5Wsj6JnmS8cLuVQUTtAm9GJCrd8muWZRGXSqyasqtABGEDZPYfmM85S6CXL4WddGgtt16XpGwUXdqcUwDVqyZ8t6` |
| 2026-10-08 12:24:45 | `post_board` HjJneV...CEVL seq 2, inline 84 bytes | DCmdy5...VPk4 | 10000 | 10000 | `4nxUE2qgxqz2ZPhi8mMxg3jZS8oradsHYMLgVmWYaG1rtFekgkD1QFBYh9wAprSjzSJjvrZXeQ7fdegVWjuQKvXE` |
| 2026-10-08 12:24:50 | `post_board` HjJneV...CEVL seq 3, blob 786 bytes | DCmdy5...VPk4 | 10000 | 10000 | `qJ38xVzhjj7P18zY74MVrvXVw1vGpR3pjxKaaxDfqCXUfFvQ7WNGqdhpMkzTU7cvXWedf8zXwF8nj3ZkULAd5YU` |
| 2026-10-08 12:25:53 | `post_board` HjJneV...CEVL seq 4, inline 84 bytes | DCmdy5...VPk4 | 10000 | 10000 | `3QEGzPLUMfSwL7P6FH1YiTF4Jkh8DLTBHdbiJ5UF7AduUC6WUtGWMSuBYnc2girg87fveaHXEWpvtw41VyXriwYu` |
| 2026-10-08 12:25:56 | `post_board` HjJneV...CEVL seq 5, blob 786 bytes | DCmdy5...VPk4 | 10000 | 10000 | `33MVN1Z5zZ9ViTB1jaZmh1UGM7RwHj5XEXLvtzQdzHEc2pXde7idpSxAZcRiQx1wZ5uXb9bt4VNyCKiFLmTUvTxq` |
| 2026-10-08 12:25:57 | `post_dm` HjJneV...CEVL seq 6 to BFPxda...1WBV, sealed 126 bytes | DCmdy5...VPk4 | 10000 | 10000 | `4tpKvo9A1kRqdmX5wQTymkPeMoy25ZrgqQWdCPydToS8nwBTCFa3Lc4w1jrGswhnhGv1vaRXkeRyrzYP8sQxFHHf` |
| 2026-10-08 12:26:49 | `post_board` HjJneV...CEVL seq 7, inline 84 bytes (last run) | DCmdy5...VPk4 | 10000 | 10000 | `2YqhLjQCPRd4QFJw9emrKzQEjLi9AmeWrsEpqAgfN2RG7BRqp3vtHiHCteZQ5t2RMs4TrJZfTgADatDtAYeQWfL4` |
| 2026-10-08 12:26:52 | `post_board` HjJneV...CEVL seq 8, blob 786 bytes (last run) | DCmdy5...VPk4 | 10000 | 10000 | `4AceYdVDzqpiDK7mNSwgf2ezk9pAPLAnU4tpqdgoXhgxTpLXjdZi17PeL8za4Fw5wdsvrodWaoSBZ9nnHKF3CeMv` |
| 2026-10-08 12:26:54 | `post_dm` HjJneV...CEVL seq 9 to BFPxda...1WBV, sealed 126 bytes (last run) | DCmdy5...VPk4 | 10000 | 10000 | `GYsnuS7cXPhboMQX4nJcMBZLtSmKTrf5i8vhZYrj4h2uVsL9h46ubQ3wLFUy7R1a6BVKKh65r3izyGFfSPPZWxU` |

The deploy's buffer write transactions (about 300 per attempt) are not listed one by one; their total is in the balances above. Later runs of the proof append their rows to the transaction table above (step `msg`).

## Contestable Core (2026-10-08, finish lane W7)

Bonded challenges (SPEC 10.8) added to `lineage_registry` (`src/challenge.rs`: `set_challenge_config`, `open_challenge`, `resolve_challenge`, `expire_challenge`, accounts `ChallengeConfig`, `Challenge`, `ChallengeGate`, the `challenge_vault` token account) and `claim` now takes two more accounts (the challenge config and the epoch's gate) and refuses while the epoch is inside its challenge window or a challenge on it is open. New accounts only: nothing to migrate. `lineage_launch` and `lineage_msg` were not upgraded (their sources are unchanged; their local builds now hash differently only because they compile the registry crate in).

| Program | `.so` bytes | sha256 (built and dumped from devnet: equal) | Extended by | Extend sig | Upgrade sig |
|---|---|---|---|---|---|
| lineage_registry | 717,760 (was 585,784, dump before `030766bc...22aa`) | `770d56bae79c849f6bdc2db87e3a89ddfb4dc9bb299bc00f9d595b23ab0524a0` | 131,976 bytes (0.67108832 SOL rent, `solana rent -u devnet 131976`) | `2yDRm91FsYQNSrrXUEUnEVq13HMrNzos7v4DLrbUTSKrY9VwPwBAco9ma9XbQArkDpDb4VLjSkkigoGi8jG26qPP` | `X1Wn4jGhyLKXP3J9yjK7YZVZ4TTh1xvB2HexasKaHyaXjQDce7DV2YWpTapbcgr2xKq2eyyJkjPirH6PyzvBzRS` |

- Preconditions measured first: LiteSVM 56/56 (challenge 6/6 new, client vectors regenerated), `.so` 717,760 bytes against ProgramData 585,784 (extend exactly 131,976), buffer rent for 717,805 bytes 3.64709964 SOL (`solana rent -u devnet 717805`), deployer 68.59602885 SOL. Deployer key passed explicitly (`-k`, `--upgrade-authority` ~/.config/lineage/devnet-deployer.json); the machine-wide `solana config` was not touched.
- Deployer 68.59602885 SOL before the extend, 67.92558577 after it, 67.92202077 after the upgrade (the buffer rent came back; 0.67400808 SOL spent, almost all of it the extend rent). Landed in slot 508884303.
- Compatibility: every claim must now pass the two new accounts. `packages/chain` `registry.claim` adds them, so the wallet page, `scripts/devnet/setup.ts` and `e2e-devnet.ts` pick them up from the shared builder; a page or script built from the earlier `packages/chain` fails a claim with `NotEnoughAccountKeys` until it is rebuilt (the site lane redeploys the site). Core's `post_epoch` and `slash` are unchanged.

Transactions of `scripts/devnet/challenge-e2e.ts` (step `challenge`) are appended below as it runs.

| When (UTC) | Step | What | Fee | Signature |
|---|---|---|---|---|
| 2026-10-08 17:00:39 | challenge | set_challenge_config: window 3600 s, bond 1 tLINE, reward 0.5 tLINE, resolve timeout 7200 s (TEST values) | 5000 | `537BuTYBWRfLBitPTBosvL1wFHUKosPpwYye9cP9VzGzyWEVeG764iC7f7KoNWUwQK8FE337AVhD5vYq4fN2Ssko` |
| 2026-10-08 17:00:46 | challenge | register TEST liar 1 AsGFAEtwCu8DajBLWpeTqgmpoWg2cuG1JVJdvkr8PdUT | 10000 | `4p7qtshVBzXAo7rKAhL9QH9FthRwHTp9wyF8wVBswuQFvUcjk9b1JH5aY3U7QDhFs7xvRoHp1dicLuJRmbisnKKh` |
| 2026-10-08 17:00:49 | challenge | bond 5000000 base units for TEST liar 1 AsGFAEtwCu8DajBLWpeTqgmpoWg2cuG1JVJdvkr8PdUT | 5000 | `2qp4gC32UjcERn1qBYFFuEb4RFyfdQupKXZ4DfcgqXcWd81ivNt7zSL4GCGDV9qxaDVKRsBkyzHBX3fE7q7PRWEc` |
| 2026-10-08 17:01:00 | challenge | register TEST liar 2 47HKePkz5NFxABk3QQUVKY95GrK2uqhH6cBtMiwYu7uP | 10000 | `3KXZEczuT6yCZgHZxCMyUJ5ST42sZTY5q7Ai54QfkKgWFFXy2R3Lr8YdU4swVqmqHZv7ids8EXhQYquvgkFDZV6z` |
| 2026-10-08 17:01:06 | challenge | bond 5000000 base units for TEST liar 2 47HKePkz5NFxABk3QQUVKY95GrK2uqhH6cBtMiwYu7uP | 5000 | `UGD8VexdkSNmvnHjfJrRmphENTxf2CncTWNUQrBMYLPfQ4RZcX4zMYz4T8rAD7q7LwCEGwuWDQJBJVbWUVtBbMz` |
| 2026-10-08 17:01:08 | challenge | register TEST challenger 1 Gy9RShqc5V7sKaKW95cd1MsCmq83qZwPDs1tREBKrWXR | 10000 | `3KLbeHHX3ZhLhMWnR4D7cZNTP3CHhh6sr7t9ZGJtQ4vTRuExxBR6RJ8bHedfFqHdshQL9XBXbmeZwoHCXHwknM4L` |
| 2026-10-08 17:01:10 | challenge | register TEST challenger 2 Ag735DAKJSE49TZcjduM7KHuTufs1p9KpE6wJGAqaYf9 | 10000 | `4u6n1nXFww9FeN34HgPCSoUuTooPMUHLbLY6WjBpqasFscti7ZcpbrNtptT32Ca4boB3eNyU25pNACxQQZ11epKQ` |
| 2026-10-08 17:04:25 | challenge | open_challenge verdict f07a9b206202c23e... epoch 13 by challenger 1 Gy9RShqc5V7sKaKW95cd1MsCmq83qZwPDs1tREBKrWXR (bond 1 tLINE from PsMbwtjM9Sh7A8VwYk1WuB4owg5Djr7EkL6aDiuqpvy) | 10000 | `62KhZcaHkxpfM2rQPcsx97yqjJYhzPDmZ4XmPNxv4eXio9Nie7huUk1zFTckkwHqHmVkBavHrkf8VfJ1kWeafjQE` |
| 2026-10-08 17:06:39 | challenge | open_challenge slash 2b44cc90880b91d6... (liar 1, epoch 13) by challenger 2 Ag735DAKJSE49TZcjduM7KHuTufs1p9KpE6wJGAqaYf9 | 10000 | `3rYZNJ6ijPibEz4zAokGXq4KafX1wFZh7ZYizz3M7k1c4zNfLi11eBHYmc576YsDMQ5u5ff2Lqo7msSsxfhoFosi` |
| 2026-10-08 17:05 | challenge (Core bridge) | `slash` minority, liar 1 AsGFAE...PdUT, 250000 base units (challenge_minority) | ? | `38gbWBiW3C6ip6UP7x5rQUBS11YCxAoqhpXYrtUJuJS6yG2HGH8b8mPhL7q95dN2kEB3N2EUM9tCtBLovnEM388D` |
| 2026-10-08 17:05 | challenge (Core bridge) | `slash` minority, liar 2 47HKeP...7uPV, 250000 base units (challenge_minority) | ? | `3futz3xjy5YqYJrVM12EpErBDRGiL8NVYJzVnas9pkzsiy6ya3wEPa2kCp2WyBUFdPm9SnZX3nHrw1RXrbTdXc9Q` |
| 2026-10-08 17:05 | challenge (Core bridge) | `resolve_challenge` verdict, upheld, evidence f1117044...39e4, reward 500000 (Challenge C7nMjguW...4Qd) | ? | `65rVgbU8aokmES7Pw8DCRoz8nFryCP7tCBWrcUo9kd4xJ1CCtsAX13Yjk7mUex22DC34x1tiLUjvR1Egh9t8tzbD` |
| 2026-10-08 17:07 | challenge (Core bridge) | `resolve_challenge` slash, failed, evidence bfcf3a29...63c8, bond to the reserve (Challenge J8uXeru1...wCkT) | ? | `MhfyjGfjswcS6xnqUmKtZX4kYoQPqTfnr8tetYzeNM7DJegDgGo62sMnNHzzX5actfNmhj682hmzHLEbNCWAea7` |

**Proof** (`bun scripts/devnet/challenge-e2e.ts`, 22/22, `scripts/devnet/CHALLENGE-E2E-LAST.json`): `ChallengeConfig` set with TEST values; a chain-mode Core (port 9664, the Core authority, epoch length raised so it never closed or posted an epoch) calibrated minbpe; two TEST liars (`--dishonest fabricate-after-qualify`) were the only eligible verifiers and accepted a comment-only perf patch by the minbpe TEST agent as a 10% gain (generation `2e79bba8...`). **Upheld:** challenger 1 (`Gy9RSh...rWXR`) opened a verdict challenge on chain (gate of epoch 13 open 1); Core drew the honest verifier v1 and the reference runner (every party excluded), both measured no gain, the combined judgement put both liars in the minority; Core reverted the generation, slashed both liars on chain (5%, bond 4.75 tLINE) and recorded the resolution: the payer got the bond back plus 0.5 tLINE from the reserve, the gate went back to 0. **Failed:** challenger 2 (`Ag735D...aYf9`) contested liar 1's slash; Core re-judged it with fresh replays (v2 and the reference runner), the liar was in the minority again, and the bond went to the compute reserve (reserve 3418629875 -> 3419629875 base units); liar 1's bond unchanged. A read-only replica of that Core found zero divergence (verdict and challenge judgement recomputed). Deployer 67.92202077 -> 67.91948085 SOL during the run (TEST funding of the verifier owner and fees); the verifier owner paid the challenge account rents. Total for the lane: 0.676548 SOL from the deployer (68.59602885 -> 67.91948085: 0.67400808 extend and upgrade, 0.00253992 the proof). `e2e-devnet.ts` was not rerun: it posts the next epoch with the same Core authority as the live site and would block the site's own post of epoch 13 (docs/DEPLOY-SITE.md); the claim path it exercises is covered by the LiteSVM suites against the deployed binary.

## Site author agents (finish: site lane W3, 2026-10-08)

The public site at https://157-245-71-188.sslip.io serves 12 non-CUDA lineages calibrated on amd64.
Chain mode lets a launched agent author only on its launch repository, so `scripts/deploy/site-authors.ts`
launched one TEST author agent per repository with prepared candidates: base58-py, base58-rs,
bitcoin-base58, geth-rlp, lc-text-splitters, ollama-tokenizer, solana-config and zig-clap, launched by the
devnet launcher key and not hosted. It sent 2,500 tLINE (TEST) to each compute vault and called
refresh_awake. The souls lane's TEST agent 6C8N2z5L... got the same top-up so that it could author on the
site's minbpe lineage (W1). Every signature is in `scripts/deploy/SITE-DEVNET.md`, and
docs/DEPLOY-SITE.md ("The full lineage set") has the details.

## Slot-hash beacon run (2026-10-08, finish beacon+worker image lane W9a)

`scripts/devnet/beacon-devnet.ts`: a local Core in chain mode against the deployed registry, holding no
Core authority key (`core_signing` false), so it posted no epoch and no slash; the script sends no
transaction. 0 SOL spent. Agents were existing registrations used read-only: verifier-ref (reference),
verifier-v1, verifier-v2, verifier-test, and the TEST author agent-base58-py (AQWpr4Wb..., keis/base58).
wallet-ui-verifier is not eligible (a pending unbond on chain). Lag 32 slots. Result 9/9
(`scripts/devnet/BEACON-DEVNET-LAST.json`): encode_chunked accepted and audited (agreed), both draws
from finalized devnet slots, the audit decision from the candidate's draw, and `scripts/verify.ts
--chain` recomputed both rounds and the decision and read both slots back from devnet.

| Draw | Anchor slot | Target | Beacon slot | Blockhash | Block time minus request |
|---|---|---|---|---|---|
| candidate 33b920df... round 0 | 508956837 | 508956869 | 508956869 | BAEYz1am1359KHquoipFFE2Z5tqiFhJWBe1gEHacR7s3 | 6.8 s |
| audit 80609371... round 0 | 508956973 | 508957005 | 508957005 | AAyo3WwgbVGp6bW7xwEdi8AeMadbHT2ikFKhiYJaDt4t | 6.7 s |
