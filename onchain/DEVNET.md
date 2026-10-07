# Devnet record

| Program | Id | Deployed | ProgramData bytes | Rent locked (SOL) | Upgrade authority |
|---|---|---|---|---|---|
| lineage_registry | `2vhj9aBZkuoCpmJxm5BcA3CYkvBJgY6VHTax8FpFmxuY` | 2026-10-07, sig `2eBTNxyf6MHEpvaJnbbttbDfTiBK6rRCCViAUee46DCbQ6MkPd6A27UjP7KfbQYWkrkFSgoqhWJqa3tyrGE78Rft` | 516,936 (exact) | 2.62691372 | `CVEZWyUBoNb6Zkte3qa7JDu5TBV4wTH6wMw4pLodnDih` |
| lineage_launch | `8eHzm1XtNtbxJujrMAci4VdhCJvQttFUBukmkFaUwsAT` | 2026-10-07, sig `21Xm2YztSGUhq38p3tmBSNMsWAzrCqLqRXF6XHQoAtMHSq9MrSQHEfoyNphcaaWBwNrrBGSRQmxMAJ9nYiU2hYMy` | 526,224 (exact) | 2.67409676 | `CVEZWyUBoNb6Zkte3qa7JDu5TBV4wTH6wMw4pLodnDih` |

- Binaries deployed: `lineage_registry.so` sha256 `14b534cc2165e9888426b8a9de0c4d3c7bd69cbe704715cfc7c9af086407c2b4`, `lineage_launch.so` sha256 `fae228465be7b037156e9efb960a009c4cb53db7b3fb53ba6b239a6a1b25a86b`; the registry dump from devnet hashes the same. 16/16 onchain tests passed against these exact files before deploy.
- Funding: 8.5 devnet SOL from the Instance devnet deployer `HzGbDTD7CR8pS2jDXadzwNxpAg2eM5sPfvFU8mtkacHB` (owner instruction, 2026-10-07), sig `3qQRaMbZCEgfQZnQuJV3R36sG8qu5XdStpTTUUCFFn1DfEqXGzBAqNSkKDnuDa16Pc58zH1qQEN9u9PpEr6xCSGQ`. Deployer balance after both deploys: 3.19212828 SOL.
- Exact `--max-len`: any upgrade that grows a program needs `solana program extend` first.
- Not yet initialized (needs a devnet $LINE test mint, `initialize`, a DBC config and `initialize_launch`; see DEPLOY.md "After the deploy").

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
