# Agent identity: prior art for Lineage

Research lane notes, accessed 2026-10-07. Every claim cites a numbered source at the end. "Not verified" means I looked and could not confirm it from a primary source.

Context: in Lineage each agent has an ed25519 key (its Solana address) and an onchain Agent PDA. The question is what existing standards and patterns we can reuse to (a) bind that key to other identities (GitHub, domains, social handles), (b) carry reputation that cannot be bought, and (c) say something about which model and harness produced a contribution.

---

## 1. ERC-8004 "Trustless Agents"

### Status
- EIP status: **Draft**, Standards Track: ERC. Created 2025-08-13. Authors: Marco De Rossi, Davide Crapis, Jordan Ellis, Erik Reppel. Requires EIP-155, EIP-712, EIP-721, EIP-1271. [1]
- Despite Draft status, reference contracts are deployed on many mainnets (see Deployments). Some third-party sources say "finalized" or "launched on mainnet January 29, 2026"; the EIP page itself still says Draft as of 2026-10-07. [1][3][5]

### Identity Registry
- Built on **ERC-721 with URIStorage**. tokenId = `agentId`, tokenURI = `agentURI`. So yes, identity is an NFT and is transferable by default. [1]
- Global agent id = `agentRegistry` string `{namespace}:{chainId}:{identityRegistry}` (for example `eip155:1:0x742...`) plus `agentId`. [1]
- `agentURI` resolves to the registration file via `ipfs://`, `https://`, or base64 `data:` URI. [1]
- Registration file fields: `type`, `name`, `description`, `image`, `services` (endpoints such as web, A2A, MCP, OASF, ENS, DID, email, each with optional version), `x402Support`, `active`, `registrations` (list of `{agentId, agentRegistry}`), optional `supportedTrust` (examples in the wild: `"reputation"`, `"tee-attestation"`). [1][14]
- Functions (as quoted from the EIP): [1]
  - `function register() external returns (uint256 agentId)`
  - `function register(string agentURI) external returns (uint256 agentId)`
  - `function register(string agentURI, MetadataEntry[] calldata metadata) external returns (uint256 agentId)`
  - `setAgentURI` (emits `URIUpdated`), `getMetadata` / `setMetadata` (emits `MetadataSet`)
  - `setAgentWallet(agentId, newWallet, deadline, signature)`, `getAgentWallet`, `unsetAgentWallet`
- `agentWallet` is a reserved metadata key: defaults to the owner address, cannot be set through `setMetadata()` or `register()`, changing it needs a signature from the new wallet (EIP-712 for EOAs, ERC-1271 for contract wallets), and it is **cleared on transfer**. [1]
- Events: `Registered`, plus ERC-721 `Transfer` and `MetadataSet`. [1]

### Endpoint domain verification (optional)
- Agent proves control of an HTTPS endpoint domain by serving `https://{endpoint-domain}/.well-known/agent-registration.json` containing at least a `registrations` list (or the full registration file). A client treats the domain as verified if that file is reachable and contains a `registrations` entry matching the onchain `agentRegistry` and `agentId`. [1]

### Reputation Registry
- `initialize(address identityRegistry_)`, `getIdentityRegistry()`. [1]
- `giveFeedback(agentId, value, valueDecimals, tag1, tag2, endpoint, feedbackURI, feedbackHash)`; `value` is a signed `int128`, `valueDecimals` 0 to 18. Submitter MUST NOT be the agent owner or an approved operator. Emits `NewFeedback`. Onchain storage: value, valueDecimals, tag1, tag2, isRevoked, 1-indexed feedbackIndex; endpoint, feedbackURI, feedbackHash are event-only. [1]
- `revokeFeedback(uint256 agentId, uint64 feedbackIndex)` emits `FeedbackRevoked`. [1]
- `appendResponse(agentId, clientAddress, feedbackIndex, responseURI, responseHash)`: anyone may append (refund notice, spam flag). Emits `ResponseAppended`. [1]
- Reads: `getSummary` (count, summaryValue, summaryValueDecimals; requires a non-empty `clientAddresses` filter list), `readFeedback`, `readAllFeedback`, `getResponseCount`, `getClients`, `getLastIndex`. [1]
- `feedbackAuth`: the current EIP text contains **no** `feedbackAuth` mechanism. A commenter describes an earlier design where the server agent pre-authorized clients to leave feedback; I could not verify from the EIP history when or whether it was removed (not verified). [1][7]

### Validation Registry
- `function validationRequest(address validatorAddress, uint256 agentId, string requestURI, bytes32 requestHash) external`: MUST be called by agent owner or operator, emits `ValidationRequest`. [1]
- `validationResponse(requestHash, response /* 0..100 */, responseURI, responseHash, tag)`: MUST be called by the named validator; may be called multiple times per request (progressive finality). Emits `ValidationResponse`. [1]
- Reads: `getValidationStatus`, `getSummary` (count, averageResponse, filter by validators and tag), `getAgentValidations`, `getValidatorRequests`. [1]
- Validator incentives and slashing are explicitly out of scope. [1]
- The official contracts repo says "The Validation Registry portion of the ERC-8004 spec is still under active update and discussion with the TEE community" and lists no ValidationRegistry addresses. [2]

### Deployments (official repo `erc-8004/erc-8004-contracts`) [2]
- Mainnets (same CREATE2 addresses on every chain): IdentityRegistry `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`, ReputationRegistry `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63`. Chains listed include Ethereum, Base, Arbitrum, Optimism, Polygon, Avalanche, BSC, Linea, Scroll, Monad, MegaETH, Robinhood Chain, Taiko and others.
- Testnets: IdentityRegistry `0x8004A818BFB912233c491871b3d84c89A494BD9e`, ReputationRegistry `0x8004B663056A597Dffe9eCcC1965A193B7388713` (Sepolia, Base Sepolia, Robinhood Chain Testnet and others).

### Solana port
- solana.com hosts an "Agent Registry" page: "identity, reputation, and validation registries natively to Solana", "interoperable with ERC-8004 on Ethereum". Lists fees: Register Agent 0.009 SOL, Leave Feedback 0.00001 SOL, Set Agent Wallet 0.00001 SOL. Links to spec at 8004.qnt.sh and repo QuantuLabs/8004-solana-ts. It does not name the builder. [4]
- QuantuLabs `8004-solana` repo: [6]
  - Program IDs. Devnet `agent-registry-8004` `8oo4J9tBB3Hna1jRQ3rWvJjojqM5DYTDJo5cejUuJy3C`, devnet `atom-engine` `AToMufS4QD6hEXvcvBDg9m1AHeCLpmZQsyfYa5h9MwAF`; mainnet `agent-registry-8004` `8oo4dC4JvBLwy5tGgiH3WwK4B9PWxL9Z4XjA2jzkQMbQ`, mainnet `atom-engine` `AToMw53aiPQ8j7iHVb4fGt6nzUNxUhcPc3tbPBZuzVVb` (mainnet binary hash given "as of 2026-03-04").
  - Identity: agent ID is a **Metaplex Core asset pubkey**; all agents in one Metaplex Core collection; metadata in separate PDAs per entry.
  - Instructions: `register()`, `setAgentURI()`, `setMetadata()`, `setAgentWallet()`, `giveFeedback()`, `revokeFeedback()`, `appendResponse()`, admin `initialize` (upgrade authority only).
  - Reputation via a separate "ATOM" engine called by CPI ("HLL[256] + ring buffer[24] + tier vesting + quality/risk", trust tiers 0 to 4). Feedback scored 0 to 100, "event-only with hash-chain proof".
  - Validation: "Validation module archived for future upgrade."
  - Repo has a `SECURITY-AUDIT-REPORT.md`; auditor and findings not verified.
- Cross-chain story is "interoperable" by matching the registration file format and `registrations` list (an agent can list registrations on several chains); there is no bridge or message-passing between registries described in the EIP (inferred from [1], not stated as a design goal there).

### Criticisms
- Empirical study (arXiv 2606.26028, July 2026) of deployed registries on Ethereum, BSC and Base: values not commensurable across reviewers, feedback rarely grounded in verifiable interactions, reputation manipulable at minimal cost; reports that 73.5% / 59.2% / 90.6% of reviewers show coordinated Sybil behavior on Ethereum / BSC / Base, and that self-declared payment proofs do not reduce Sybil feedback. Figures differ slightly between paper versions. [7]
- The anti-self-review check compares addresses, so a fresh wallet bypasses it (secondary blog source, not independently verified). [7]
- EIP itself concedes: Sybil inflation is expected to be handled by filtering on reviewer; registry cannot guarantee advertised capabilities work. [1]

### Implication for Lineage
- Reuse the **registration file format** (`type`, `name`, `services`, `registrations`, `supportedTrust`) as the off-chain card our Agent PDA points to; add a `registrations` entry of the form `solana:<genesis>:<lineage program id>` + agent PDA so ERC-8004 tooling (8004scan etc.) can read us. This costs nothing and buys interop.
- Do **not** copy ERC-721 transferability for identity: in ERC-8004 the agent NFT can be sold and only `agentWallet` resets. Lineage reputation is earned by verified merges, so the Agent PDA should be keyed by the agent's own ed25519 key and be non-transferable.
- Do not copy the open-feedback reputation model: the 2026 study shows it is Sybil-dominated. Lineage's reputation should come only from verifier-checked events (merged, re-benchmarked improvements), which is closer to ERC-8004's Validation Registry (`validationRequest` / `validationResponse` with a 0..100 score and request hash) than to its Reputation Registry.
- Adopt the `.well-known/agent-registration.json` domain proof verbatim as an optional link type.

---

## 2. W3C DIDs and Verifiable Credentials

### Status
- **Verifiable Credentials Data Model v2.0 is a W3C Recommendation**, dated 15 May 2025 (`https://www.w3.org/TR/2025/REC-vc-data-model-2.0-20250515/`). [8]
- **DID Core v1.0** has been a Recommendation since July 2022 (secondary source). **DID v1.1**: latest entry on the W3C history page is a **Candidate Recommendation Snapshot, 5 March 2026**; no PR/REC entry listed as of 2026-10-07. v1.1 moves resolution into a separate DID Resolution spec and builds on Controlled Identifiers v1.0. [9][10]

### did:key (CCG draft "v0.9")
- Identifier is multibase (base58-btc) of multicodec prefix + raw public key. Ed25519 example `did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK`; codec `ed25519-pub` (`0xed`), 32 bytes. [11]
- Expanded document: one verificationMethod of type `Multikey` with `publicKeyMultibase`, referenced by `authentication`, `assertionMethod`, `capabilityDelegation`, `capabilityInvocation`; a derived X25519 `keyAgreement` key. [11]
- The page does not explain the `z6Mk` prefix or the varint form `0xed01`; the commonly cited varint encoding is not verified from this source.

### did:web (CCG)
- `did:web:example.com` resolves to `https://example.com/.well-known/did.json`; `did:web:example.com:u:bob` to `https://example.com/u/bob/did.json`. [12]
- Security: depends on DNS and TLS; no write authorization defined; path form "does not prove that the domain operator has the private keys". [12]

### did:pkh (CCG, status "Draft")
- `did:pkh:` + CAIP-10 account id. Solana example: `did:pkh:solana:4sGjMW1sUnHzSxGspuhpqLDx6wiyjNtZ:CKg5d12Jhpej1JqtmxLJgaFqqeYjxgPqToJ4LBdvG9Ev` (CAIP-2 chain id `solana:4sGjMW1sUnHzSxGspuhpqLDx6wiyjNtZ`). [13]
- Verification method type for Solana: `Ed25519VerificationKey2018`, with `blockchainAccountId` = `<address>@<chainId>`. [13]

### did:sol (identity.com)
- "Any Solana public key can be a DID": key `abc` is `did:sol:abc`, a **generative** DID with the key as sole authority and no onchain account. To add keys or services, `initialize` a DID Account, a PDA derived from the identifier (`derive_did_account(key.to_bytes())`); instructions include `initialize`, `resize`, `close`, `add_verification_method`; `is_authority` CPI helper; DIDs can be controllers of other DIDs. [15]
- Maintenance: repo `identity-com/sol-did` not archived, but last push 2024-09-20 (GitHub API), Releases empty, and the spec URL (`identity-com.github.io/sol-did/did-method-spec.html`) redirects to `g.identity.com`, which did not resolve on 2026-10-07. Program id and network syntax: not verified. [15]

### Mapping a Solana ed25519 key to a DID
- The 32-byte Solana pubkey (base58 address) is the raw Ed25519 public key, so the same key can be expressed as: `did:key:z6Mk...` (multicodec ed25519-pub + base58btc), `did:pkh:solana:<genesis-ref>:<address>`, or `did:sol:<address>`. did:key and did:pkh are purely generative (no registry); did:sol optionally adds an onchain document. [11][13][15]

### Implication for Lineage
- Expose every agent as `did:pkh:solana:<genesis>:<agent address>` (or `did:key`) in its registration file. This is free, needs no new program, and lets VC tooling verify Lineage-issued credentials signed by the agent key.
- If Lineage issues "verified improvement" credentials off-chain, use the **VC 2.0** envelope (a W3C Recommendation), signed by the Lineage verifier key, with `credentialSubject.id` = agent DID. Keep the onchain record (SAS or our own PDA) as the source of truth; the VC is a portable copy.
- Avoid depending on did:sol given its apparent dormancy.

---

## 3. Solana Attestation Service (SAS)

### Status
- Announced live on mainnet **23 May 2025** by the Solana Foundation and the Solana Identity Group; described as a free-to-use layer letting approved issuers link off-chain facts (example: KYC results) to a wallet. [16]
- Program ID: **`22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG`** (repo README). Built with Pinocchio; Codama-generated IDL; clients `@solana/attestation` (TS, built on `@solana/kit`) and `solana-attestation` (Rust). Older docs name the packages `sas-lib` and `solana-attestation-service-client`. Apache-2.0, maintained by the Solana Foundation. [17][18]

### Account model [17][18][19]
- **Credential** (issuer): `{ authority, name, authorizedSigners: Address[] }`. PDA seeds `["credential", authority, name]`.
- **Schema**: `{ credential, name, description, layout, fieldNames, isPaused, version }`. PDA seeds `["schema", credential, name, version(u8)]`. `layout` is a byte array of type codes (0 U8 ... 12 String, 13 VecU8, ... 25 VecString); `fieldNames` correspond positionally.
- **Attestation**: `{ nonce, credential, schema, data, signer, expiry, tokenAccount }`. PDA seeds `["attestation", credential, schema, nonce]`. `nonce` is a pubkey, so one attestation per (credential, schema, subject) is natural if the subject's address is used as nonce. `expiry` 0 = never expires.
- Instructions: `CreateCredential`, `ChangeAuthorizedSigners`, `CreateSchema`, `ChangeSchemaStatus`, `ChangeSchemaDescription`, `ChangeSchemaVersion`, `CreateAttestation`, `CloseAttestation` (revocation = close), `TokenizeSchema`, `CreateTokenizedAttestation`, `CloseTokenizedAttestation`, `EmitEvent`.
- Events are emitted via self-CPI (event authority PDA `"__event_authority"`) rather than `sol_log`, so indexers do not lose them to log truncation.

### Tokenized attestations [17]
- `TokenizeSchema` mints a Token-2022 **group mint** for the schema; `CreateTokenizedAttestation` mints a **soulbound** member token to the subject. Extensions: `NonTransferable`, `MetadataPointer`, `GroupMemberPointer`, `PermanentDelegate`, `MintCloseAuthority`.
- README warning: holding the token proves nothing on its own (anyone can mint a look-alike, and the token has no expiry). A verifier must read the `attestation` metadata field, check the mint equals the PDA `["attestationMint", attestation]`, fetch the Attestation account, check program ownership, expected `credential` and `schema`, and compare `expiry` to the clock.
- The group `max_size` set at `TokenizeSchema` caps lifetime issuance; closing does not free a slot and there is no instruction to raise it.

### Limitations
- Trust is entirely in the credential's authorized signers (issuer model); SAS does not itself verify the claim.
- Data is arbitrary bytes under a fixed layout; privacy is the issuer's problem.

### Implication for Lineage
- SAS is the natural Solana-native home for **identity links** ("agent X controls GitHub account Y", "agent X controls domain Z") issued by a Lineage verifier credential. Use agent address as `nonce`; set `expiry` for links that should be re-proved.
- Tokenized SAS attestations give a wallet-visible, non-transferable badge for free, but our own program must always verify the Attestation account, never the token.
- Reputation that changes every merge is better kept in our own Agent PDA (SAS attestations are mostly write-once; updates mean close and recreate).

---

## 4. Social proofs (Keybase pattern and analogs)

### Keybase [20]
- Each user has a public **sigchain**: links (identity proofs, follows, key adds, revocations), each signed by one of the user's keys, each with a sequence number and the hash of the previous link.
- Social proof = a signed statement posted on the external service (tweet, gist, DNS record) that the client re-checks itself. "The Keybase client does not trust the Keybase server."
- Server publishes a site-wide Merkle root (signed, and published into the Bitcoin blockchain) so forks and rollbacks are detectable.

### Farcaster verifications [21][22]
- Protocol spec: a Verification is a proof of address ownership via a signed `VerificationClaim`; for Ethereum an EIP-712 signature with the Farcaster domain separator; removed with `VerificationRemove`. [21]
- Snapchain/Hub message body `VerificationAddAddressBody { address, claim_signature, block_hash, verification_type (0 EOA, 1 contract), chain_id, protocol }`, `Protocol { PROTOCOL_ETHEREUM = 0, PROTOCOL_SOLANA = 1 }`; described as "a bi-directional signature proving that an fid has control over an address". [22]
- Solana support shipped February 2024 (secondary press). Exact bytes the Solana key signs: not verified. [22]

### ENS text records (ENSIP-5, status final) [23]
- `function text(bytes32 node, string key) view returns (string text);` interface id `0x59d1d43c`. Global keys (`email`, `url`, `avatar`, `description`, `notice`, `keywords`, ...) and reverse-dot service keys (`com.github`, `com.twitter`, `org.telegram`, `io.keybase`).
- These are **self-asserted**: the spec's security considerations say "None"; nothing proves the GitHub account consents.

### Domain proofs
- DNS TXT: Keybase checks DNS proofs (listed as one of the services it verifies). [20]
- `.well-known`: ERC-8004 `/.well-known/agent-registration.json` [1]; did:web `/.well-known/did.json` [12]; A2A agent cards at `/.well-known/agent-card.json` (renamed from `agent.json` in A2A v0.3, optionally JWS-signed) per secondary sources only, not verified against the official A2A spec [24].
- Lens Protocol: not researched (not verified).

### Implication for Lineage
- A link should be **bi-directional**: the agent key signs a statement naming the external account, and the external account publishes that signed statement (gist, repo file, DNS TXT, `.well-known` JSON). One-directional self-asserted records (ENS-style) are not enough.
- Canonical proof statement should include agent address, external handle, Lineage program id, and a timestamp or slot, signed with the agent's ed25519 key (Solana off-chain message signing). A verifier re-fetches and re-checks; the result can be stored as a SAS attestation (section 3).
- Keybase's lesson: publish a hash chain of identity changes per agent (append-only), so key rotation and link removal are auditable. Our Agent PDA can hold the latest head hash.

---

## 5. GitHub commit signing with SSH keys

### How "Verified" works [25][26][27]
- SSH signing needs Git 2.34+. GitHub verifies with the `ssh_data` library against a public key **added to the account as a signing key** (auth keys do not count unless re-uploaded as signing keys; there is no limit on signing keys). [25]
- Email: GitHub's verification reasons include `no_user` ("No user was associated with the committer email address in the commit") and `unverified_email` ("The committer email address in the commit was associated with a user, but the email address is not verified on their account"). So the **committer email must be a verified email of the account that owns the signing key**. [27]
- Other reasons: `unknown_key` ("has not been registered with any user's account"), `invalid`, `malformed_signature`, `expired_key`, `unsigned`, `valid`. [27]
- **Vigilant mode** (off by default): Verified only if the committer is the only author who enabled vigilant mode; "Partially verified" when a non-committer author has vigilant mode on; unsigned commits by a vigilant user show "Unverified". [25]
- **Persistent commit signature verification**: public preview November 2024, **GA 10 December 2024**. Verification is recorded at push time; the record "can't be edited" and persists "even if signing keys are rotated, revoked, or if contributors leave the organization"; GitHub "will not re-verify previously signed commits"; record shared across the repo network (forks); timestamp exposed as `verified_at` in the REST API. Older commits get a record the next time they are verified. [25][28]
- "Rebase and merge" commits created by GitHub are not verified (GitHub lacks the committer's key). [28]

### Supported key types [29][30]
- **Ed25519 is supported and is GitHub's recommended default** (`ssh-keygen -t ed25519`); `ed25519-sk` (security key) also documented; RSA for legacy systems; DSA (`ssh-dss`) no longer accepted. `gh ssh-key add ~/.ssh/id_ed25519.pub --type signing` adds a signing key. [29][30]

### API to add signing keys [31][32][33]
- `POST /user/ssh_signing_keys`, body `{ key (required), title (optional) }`, 201 on success, 422 on validation failure or spam. [31]
- `GET /user/ssh_signing_keys`, `GET /user/ssh_signing_keys/{ssh_signing_key_id}`, `DELETE /user/ssh_signing_keys/{ssh_signing_key_id}`; public `GET /users/{username}/ssh_signing_keys` ("accessible by anyone"). [31]
- Classic PAT / OAuth scopes: `write:ssh_signing_key` (create), `read:ssh_signing_key` (list/get), `admin:ssh_signing_key` (delete). [31]
- Fine-grained PAT: **User permission "SSH signing keys"**, write for POST/DELETE, read for GET. [32]
- GitHub App: same "SSH signing keys" user permission, available only with a **user access token (UAT)**, not an installation token. [33]

### Bots and GitHub Apps [25]
- "Signature verification for bots will only work if the request is verified and authenticated as the GitHub App or bot and contains no custom author information, custom committer information, and no custom signature information, such as Commits API." Commits made in the web UI are GPG-signed by GitHub (`https://github.com/web-flow.gpg`) and show Verified. So an App can get Verified commits by creating them via the API without custom author/committer, but the signature is GitHub's, not the agent's key.

### Machine accounts (Terms of Service, section on account requirements) [34]
- "Accounts registered by 'bots' or other automated methods are not permitted. We do permit machine accounts." A machine account is "set up by an individual human who accepts the Terms on behalf of the Account, provides a valid email address, and is responsible for its actions"; "You may maintain no more than one free machine account in addition to your free Personal Account." URL: `https://docs.github.com/en/site-policy/github-terms/github-terms-of-service` (section B, Account Terms).

### Implication for Lineage
- Strong, cheap link: the agent's ed25519 key can be written in OpenSSH format (`ssh-ed25519 <base64>`) since Solana keys are raw Ed25519. If that exact key is registered as a GitHub signing key and commits are SSH-signed by it, GitHub shows "Verified", and anyone can confirm the link with the public `GET /users/{username}/ssh_signing_keys`. That is a bi-directional proof (GitHub account lists the agent key; agent key signs commits) without any custom gist.
- Caveat: using the same private key for Solana transactions and SSH signatures. The two message formats differ (SSH signatures use the `SSHSIG` envelope with a namespace), so cross-protocol replay looks unlikely, but this is our inference, not verified by a source. A safer alternative is a separate SSH key whose fingerprint is attested by the agent key.
- ToS limit: one free machine account per human, so "one GitHub account per agent" does not scale for a single operator on free accounts; agents should instead attach their key to the operator's account or a paid/org setup. Persistent verification means a merged, verified commit stays Verified even if the key is later removed, which matches Lineage's append-only history.
- Bot path (GitHub App commits via API) yields Verified but proves GitHub, not the agent; record the agent signature separately (for example in a commit trailer or in the onchain submission).

---

## 6. Solana Name Service (SNS) records

### Records v2 (SNS-IP 3, "Record v2 (amended)", Accepted, 2023-08-29) [35]
- Problems addressed: **staleness** (records outlive a domain sale) and **right of association (RoA)** (owner may not actually control the linked resource).
- Record account layout: header `{ staleness_validation_type: u16, right_of_association_validation_type: u16, content_length: u32 }`, then staleness verification id, RoA verification id, record content. `Validation` enum: `None`, `Solana`, `Ethereum`, ...
- Certification program instructions: `AllocateRecord`, `AllocateAndPostRecord`, `EditRecord`, `ValidateSolanaSignature`, `ValidateEthereumSignature` (uses the native secp256k1 program). Any edit resets validations to `None`. PDAs can act as certification authorities via CPI to `ValidateSolanaSignature`.
- Verification by a reader: staleness id must equal the parent domain's **current owner**; RoA id must be pertinent to the record value (type-specific). Example: SOL record set by owner, staleness-validated by owner signature, RoA-validated by the target address's signature.
- Records program IDs: mainnet `HP3D4D1ZCmohQGFVms2SS4LCANgJyksBf5s1F77FuFjZ`, devnet `Ga872GkshNeNMDag7m1Bn54dN3NiHksfqnN2pH6A1H9F`; repo now `SolanaNameService/sns-records` (last push 2026-09-16). [36]
- SDK helpers `verifyRecordStaleness` and `verifyRecordRightOfAssociation(rpc, domain, record, verifier?)`. [37]

### Record types (SNS-IP 1, Accepted) [38]
- Social and web records: `Email`, `URL`, `Discord`, `Github`, `Reddit`, `Twitter`, `Telegram`, `Backpack` (UTF-8 usernames without `@`), `Pic`, plus `SOL` (96 bytes: pubkey + signature), `ETH`, `BTC`, IPFS/ARWV, DNS `A`/`AAAA`/`CNAME`/`TXT`.
- For off-chain handles like Github/Twitter, RoA needs a trusted verifier (the optional `verifier` parameter); who runs that verifier for SNS today: not verified.

### Implication for Lineage
- Optional human-readable name: an operator's `.sol` domain can point to an agent via a v2 `SOL` record that is RoA-validated by the agent key. Lineage can check staleness (owner unchanged) before displaying it.
- The SNS-IP 3 header (validation type + validator id per concern) is a good pattern for our own link records: store "who validated" next to "what is claimed", and invalidate on edit.

---

## 7. Agent provenance and TEE attestation (short)

- **AWS Nitro Enclaves**: attestation document is CBOR in a COSE_Sign1 envelope (alg ECDSA P-384, `{1: -35}`), signed by the AWS Nitro Attestation PKI (root cert fingerprint published). Fields: `module_id`, `timestamp`, `digest` ("SHA384"), `pcrs` (index 0..31), `certificate`, `cabundle`, optional `public_key`, `user_data`, `nonce` (each up to 1024 bytes). [39]
- **NVIDIA H100 confidential computing**: per-GPU ECC identity key and certificate, SPDM-based measured attestation report, OCSP revocation; verify locally or via NVIDIA Remote Attestation Service (NRAS), which returns a JWT. The GPU depends on a CPU confidential VM (TDX or SEV-SNP) for the full chain; Intel Trust Authority offers composite CPU+GPU attestation. [40][41][42]
- **Intel TDX / Phala dstack**: TDX quote verified to Intel (hosted API or local `dcap-qvl`); `reportData` binds a verifier nonce; RTMR3 holds app measurements including `compose-hash` (SHA256 of the Docker Compose config), extended as `RTMR3_new = SHA384(RTMR3_old || SHA384(event))`; KMS measurements checked against an allowlist in a `DstackKms` contract. [43]
- **Marlin Oyster**: Nitro-based; a one-time on-chain verification of an attestation-verifier enclave (via ZK proof or NitroProver), then cheap verification of other enclaves; `AttestationAuther` base contract gates apps to verified enclave keys; Marlin research forum describes feeding results into ERC-8004 `validationResponse`. Marlin-authored sources only. [14][44]
- Olas and "verifiable inference" generally: not researched in depth (not verified).
- Common limitation: attestation proves which image and config ran, not that the model weights inside are what the operator claims unless the image pins and hashes them; vendor PKI is the root of trust (raised in a 2025 critique of H100 CC on GCP). [42]

### Implication for Lineage
- Lineage's own correctness guarantee comes from re-running benchmarks in its sandbox, so TEE attestation is optional metadata, not a gate. A reasonable shape: an optional `harness_attestation` blob in a submission, with `user_data`/`reportData` = hash(agent pubkey || submission hash), so the attestation is bound to that agent and that patch.
- Record model and harness as self-declared fields in the registration card (like ERC-8004 `supportedTrust: ["tee-attestation"]`), upgraded to "attested" only when a verifiable quote is attached.

---

## 8. Non-transferable reputation

- **DeSoc paper**: Ohlhaver, Weyl, Buterin, "Decentralized Society: Finding Web3's Soul", SSRN 4105763, posted 11 May 2022 (revised 6 Feb 2024). Proposes non-transferable soulbound tokens (SBTs) held by "Souls" to encode commitments, credentials and affiliations; uses include provenance, reputation, community wallet recovery, Sybil-resistant governance. [45]
- **ERC-5192 "Minimal Soulbound NFTs"**: Final. Authors Tim Daubenschütz, Anders. Created 2022-07-01. `function locked(uint256 tokenId) external view returns (bool);`, events `Locked(uint256 tokenId)`, `Unlocked(uint256 tokenId)`, interface id `0xb45a3c0e`. [46]
- **Token-2022 NonTransferable** (Solana): mint-level extension; `Transfer`/`TransferChecked` fail with `TokenError::NonTransferable`; token accounts automatically get `NonTransferableAccount` and `ImmutableOwner`; holder can still **burn and close**; `InitializeNonTransferableMint` must precede `InitializeMint` in the same transaction; incompatible with `TransferFeeConfig`. [47][48]
- SAS tokenized attestations already combine NonTransferable with PermanentDelegate (issuer can burn) and MintCloseAuthority (section 3). [17]

### Implication for Lineage
- Reputation should live in program-owned state (the Agent PDA) keyed by the agent's own key, which is non-transferable by construction. A Token-2022 NonTransferable badge is a display convenience only, and since the holder can burn it, it cannot carry negative reputation. Key rotation must be an explicit, signed program instruction that moves the PDA's authority, logged in the identity hash chain (section 4), not a token transfer.

---

## Sources (all accessed 2026-10-07)

1. https://eips.ethereum.org/EIPS/eip-8004
2. https://github.com/erc-8004/erc-8004-contracts
3. https://erc-8004.quicknode.com/docs/contracts
4. https://solana.com/agent-registry
5. https://onekey.so/blog/pt/ecosystem/tudo-o-que-voce-precisa-saber-sobre-o-erc-8004-20260210113201/
6. https://github.com/QuantuLabs/8004-solana
7. https://arxiv.org/pdf/2606.26028 (also https://www.alphaxiv.org/abs/2606.26028v2) and https://yewjin.substack.com/p/building-a-trust-layer-for-ai-agents/comments
8. https://www.w3.org/TR/vc-data-model-2.0/ (REC dated 2025-05-15: https://www.w3.org/TR/2025/REC-vc-data-model-2.0-20250515/)
9. https://www.w3.org/standards/history/did-1.1/
10. https://www.w3.org/TR/2026/CR-did-1.1-20260305/
11. https://w3c-ccg.github.io/did-key-spec/
12. https://w3c-ccg.github.io/did-method-web/
13. https://github.com/w3c-ccg/did-pkh/blob/main/did-pkh-method-draft.md
14. https://hackmd.io/@sagarmarlin/BkwFvq3DWx and https://research.marlin.org/t/building-trustless-ai-agent-infrastructure-with-erc-8004-and-marlins-oyster-tees/130
15. https://github.com/identity-com/sol-did and https://raw.githubusercontent.com/identity-com/sol-did/develop/sol-did/README.md
16. https://solana.com/news/solana-attestation-service
17. https://github.com/solana-foundation/solana-attestation-service (README, program/src/constants.rs, program/src/state/{attestation,credential,schema}.rs)
18. https://solana.com/docs/tools/attestations
19. https://solana.com/docs/tools/attestations/schemas and https://solana.com/docs/tools/attestations/attestations and https://solana.com/docs/tools/attestations/credentials
20. https://book.keybase.io/docs/server
21. https://github.com/farcasterxyz/protocol/blob/main/docs/SPECIFICATION.md
22. https://docs.neynar.com/snapchain/datatypes/messages and https://www.theblock.co/post/278797/farcaster-solana
23. https://docs.ens.domains/ensip/5
24. https://specification.website/spec/agent-readiness/a2a-agent-cards/ and https://api7.ai/blog/a2a-protocol-gateway-layer (secondary)
25. https://docs.github.com/en/authentication/managing-commit-signature-verification/about-commit-signature-verification
26. https://docs.github.com/en/authentication/troubleshooting-commit-signature-verification/using-a-verified-email-address-in-your-gpg-key
27. https://docs.github.com/en/rest/commits/commits (verification `reason` values)
28. https://github.blog/changelog/2024-12-10-persistent-commit-signature-verification-is-generally-available/ and https://github.blog/changelog/2024-11-12-persistent-commit-signature-verification-now-in-public-preview/
29. https://docs.github.com/en/authentication/connecting-to-github-with-ssh/generating-a-new-ssh-key-and-adding-it-to-the-ssh-agent
30. https://docs.github.com/en/authentication/connecting-to-github-with-ssh/adding-a-new-ssh-key-to-your-github-account
31. https://docs.github.com/en/rest/users/ssh-signing-keys
32. https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens
33. https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps
34. https://docs.github.com/en/site-policy/github-terms/github-terms-of-service
35. https://github.com/SolanaNameService/sns-ip/blob/master/proposals/sns-ip-3.md
36. https://github.com/SolanaNameService/sns-records
37. https://cdn.jsdelivr.net/npm/@solana-name-service/sns-sdk-kit@1.0.1/README.md
38. https://github.com/SolanaNameService/sns-ip/blob/master/proposals/sns-ip-1.md
39. https://docs.aws.amazon.com/enclaves/latest/user/verify-root.html
40. https://cacm.acm.org/?p=586427 (Creating the First Confidential GPUs)
41. https://docs.nvidia.com/attestation/quick-start-guide/latest/attestation-examples/hopper_single_gpu.html and https://www.edgeless.systems/wiki/hardware/nvidia-hopper-h100
42. https://docs.trustauthority.intel.com/main/articles/concept-gpu-attestation.html and https://census-labs.com/static/media/uploads/blog/challenging_the_boundaries_of_cc.pdf
43. https://docs.phala.com/phala-cloud/attestation/verifying-attestation and https://developer.litprotocol.com/architecture/verification/full-verification
44. https://marlin.org/
45. https://papers.ssrn.com/abstract=4105763
46. https://eips.ethereum.org/EIPS/eip-5192
47. https://www.solana-program.com/docs/token-2022/extensions
48. https://solana.com/docs/tokens/extensions/non-transferrable-tokens
