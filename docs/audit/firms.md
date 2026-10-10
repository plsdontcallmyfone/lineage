# Solana audit firms: shortlist

Every page below was read on **2026-10-10**, on the firm's own site. Site maps came from
`firecrawl map` and page contents from WebFetch. WebFetch passes each page through a summarizer, so
**the text in quotation marks is the summarizer's extract, not raw page text**. Check the exact wording
at the URL before quoting a firm back to itself. "Not published" means we did not find it on the pages
listed. That does not mean the firm has no answer.

**Prices:** no firm publishes prices for a full audit. The only published prices we found are Adevar
Labs' pre-audit tiers (section 7).

**Lead times:** only Accretion (reply within one business day, start within 24 hours) and Adevar
(reply within 24 hours) publish any. Nobody publishes how long the wait is before an audit starts or
how long an audit takes.

## What to send any of them

- The commit and tree hashes in `SCOPE.md`, with the LOC table: 3,921 lines of Rust code across three
  programs.
- This directory: architecture and trust model, threat model, internal audit, powers, review areas.
- `BUILD-AND-TEST.md` and the Meteora dumps (`onchain/vendor/meteora`, hashes in `SCOPE.md`).
- Repository access. The repository is public (`github.com/plsdontcallmyfone/lineage`).

Adevar's pre-audit advice asks teams to freeze the code between scope lock and the end of the
engagement. Our plan already pins the program trees by hash (`SCOPE.md`).

## Shortlist

### 1. OtterSec

- **Pages read:** https://osec.io/services, https://osec.io/audits, https://osec.io/contact
- **Solana evidence:**
  - /services: "We've worked extensively with the Solana Foundation on auditing the Solana Core code,
    along with Account Compression."
  - /audits has a Chain column with more than 100 rows labelled Solana. Examples include Meteora DLMM,
    Squads v4, Solana Token22, Anchor, Raydium AMM V3, Kamino Lending, Marginfi V2, Jupiter Perps and
    Pump Fun.
- **What they ask for:**
  - Contact form fields: inquiry type ("Security audit" or "CTF sponsorship"), Name, Email, Company,
    "Budget (optional)", "Timeline (optional)" and Message.
  - The form's prompt: "Tell us what you are building, where the highest-risk parts live, and when
    you need coverage."
- **Process (/services):**
  1. Initial discussion of goals, timeline and security needs.
  2. Information gathering: they send an MNDA and review the in-scope repositories.
  3. A quote based on expected duration, likely vulnerabilities and complexity.
  4. Kickoff, with findings shared as they come up.
  5. A final report with findings and suggested fixes.
- **Lead times:** not published.
- **Prices:** not published.
- **Contact:** https://osec.io/contact, contact@osec.io

### 2. Neodyme

- **Pages read:** https://neodyme.io/blockchain, https://neodyme.io/en/about, https://neodyme.io/en/reports
- **Solana evidence:**
  - /blockchain: "Solana contract audits", "Auditing Solana since 2020".
  - /reports lists 35 sampled public reports, including Token-2022 (Apr 2024), Squads v4 (Dec 2024),
    Drift (Jun 2024), Orca Whirlpools (May 2022), Metaplex Token Metadata (Jul 2025) and P-Token
    (Jun 2025).
- **What they ask for:** not published.
- **Process:** not published.
- **Lead times:** not published.
- **Prices:** not published ("Please contact us for a quote").
- **Contact:** contact@neodyme.io. The "Book an Audit" link opens an email with the subject
  "New Audit Inquiry".

### 3. Accretion (Accretion Labs Pte. Ltd., Singapore)

- **Pages read:** https://accretion.xyz, https://accretion.xyz/inquiry
- **Solana evidence:**
  - "100% Solana. Researchers, not generalists." The site says the firm has done Solana-only audits
    since January 2025, including "Framework-aware Anchor review".
  - Named clients include the Solana Foundation, Jupiter, Metaplex, Sanctum, Marginfi, MetaDAO and
    Light Protocol.
  - Reports are published in the `accretion-xyz/audit-reports` GitHub repository.
- **What they ask for (inquiry form):**
  - Name, company, preferred contact (email or Telegram) and preferred start date.
  - Service: "Solana audit", "Opsec review", "Security consulting" or "Not sure yet".
  - A repository link: "If your repo is private, invite `robre` on GitHub."
  - Notes.
- **Process:**
  1. "We read your inquiry and reply within one business day."
  2. "No scoping call needed, just share your repository and tell us what you need audited."
  3. "You get a written proposal covering scope, timeline, and a fixed price."
- **Lead times:**
  - Reply within one business day. The home page says 24 hours.
  - "we'll get started within 24 hours".
  - Critical bugs are reported within 24 hours of discovery.
  - "Six months of post-audit support included".
- **Prices:** not published. The site says only that proposals carry a fixed price.
- **Contact:** https://accretion.xyz/inquiry, contact@accretion.xyz, Telegram @robrto for urgent
  incidents.
- **Kudelski:** the site does not say Accretion is linked to Kudelski Security, and Kudelski's site
  does not mention Accretion. We list them separately.

### 4. Sec3

- **Pages read:** https://sec3.dev/audits, https://sec3.dev/contact
- **Solana evidence:** the heading of /audits is "Security Audits for Solana Protocols". Listed
  reports include Huma Vault (2026), DeFi Tuna (2025), Keel Solana PSM (2025) and Lulo (2024).
- **What they ask for (form):**
  - Service: Audit, Formal Verification, Security Review, Post-Deployment Support, Free Tool Question
    or Other.
  - Name, email and company or protocol.
  - Project stage: Planning, In Development, Pre-Launch or Live/Deployed.
  - Message.
- **Process:** no steps are published. The page lists coverage areas: program logic, dependency
  risk, upgrade authority and opsec, monitoring after deployment, and reporting with remediation.
- **Lead times:** not published.
- **Prices:** not published.
- **Contact:** https://sec3.dev/contact, contact@sec3.dev

### 5. Trail of Bits

- **Pages read:** https://trailofbits.com/services/blockchain, https://trailofbits.com/contact,
  https://trailofbits.com/library/reserve-protocol-solana-dtfs
- **Solana evidence:**
  - "Our team has extensive experience in auditing Solana-based projects." The page links to Solana
    Lints and Not-So-Smart Contracts (Solana).
  - The "Reserve Protocol Solana DTFs" library page (2025-04) describes a two-week review that found
    12 issues.
- **What they ask for:** not readable. The contact page text did not include the form's field labels.
- **Process (/services/blockchain):**
  1. Scope and threat model: "Define the system boundary: contracts, nodes, bridges, off-chain
     services, deployment plan".
  2. Design and upgradeability review.
  3. Implementation review.
  4. Invariant testing and exploit development.
  5. "Deliver a written report, walk findings through with your team, and re-test patches".
- **Lead times:** not published. The site lists the effort of past engagements, but not as quoted
  timelines.
- **Prices:** not published.
- **Contact:**
  - "Request a quote" at https://trailofbits.com/contact.
  - Free one-hour office hours at https://trailofbits.com/office-hours/.
  - SendSafely or PGP for secure exchange.

### 6. Ackee Blockchain

- **Pages read:** https://ackee.xyz, https://ackee.xyz/contact,
  https://ackee.xyz/blog/list-of-our-public-audits,
  https://ackee.xyz/blog/omnipair-oracle-less-lending-audit-summary
- **Solana evidence:**
  - Audits for "Solana, Ethereum and EVM-based projects".
  - Marinade Finance (4 engineering weeks, co-audited with Kudelski Security and Neodyme).
  - An Omnipair summary (Mar 3, 2026) describing 9 engineering days of fuzzing.
  - Ackee builds Trident, a Solana fuzzer.
- **What they ask for:** not readable. The contact page text did not include the form fields.
- **Process:** not published beyond "one-time audits and long-term partnerships".
- **Lead times:** not published.
- **Prices:** not published.
- **Contact:**
  - "Get audited" at https://ackee.xyz/contact.
  - The email on that page is obfuscated by Cloudflare. The summarizer decoded it as
    hello@ackeeblockchain.com, but the page does not display it, so confirm it before writing to it.

### 7. Adevar Labs

- **Pages read:** https://adevarlabs.com/request-audit,
  https://adevarlabs.com/solutions/whiteglove-audits, https://adevarlabs.com/solutions/preaudit,
  https://adevarlabs.com/reports,
  https://adevarlabs.com/blog/11-things-we-wish-every-team-did-before-their-audit (post dated
  June 30, 2026)
- **Solana evidence:** /reports names DoubleZero ("across Solana"), GLAM ("on Solana"), Loopscale
  ("Solana-native credit protocol") and Bench ("on Solana using Anchor").
- **What they ask for:**
  - "Tell us about your project and we'll get back to you within 24 hours."
  - Whiteglove discovery: "We read your documentation".
  - The pre-audit blog post lists what teams should do first:
    - arrive with a threat model;
    - run static and AI scans first;
    - send fixes back quickly;
    - "Don't commit code between scope lock and engagement close";
    - plan fuzzing and monitoring for after the audit.
- **Process (Whiteglove):**
  1. Discovery
  2. Threat modeling
  3. Manual audit
  4. Advanced testing (fuzzing)
  5. Fix review
- **Lead times:**
  - Response within 24 hours.
  - Pre-audit Express: "Results delivered in hours".
  - Full audit duration: not captured.
- **Published prices (pre-audit only):**
  - Express: $2,000 (automated).
  - Core: $4,000 (AI scan plus a senior engineer's review).
  - Complete: $5,500 (adds a fix review).
  - "your entire preaudit fee is credited toward your engagement" if a Whiteglove audit follows.
  - Full audit prices: not published.
- **Contact:** https://adevarlabs.com/request-audit, audits@adevarlabs.com; pre-audit intake at
  https://adevarlabs.com/pre-audit/get-started

### 8. Certora

- **Pages read:** https://www.certora.com/audits, https://www.certora.com/signup?plan=audit,
  https://www.certora.com/pricing, https://www.certora.com/reports/solana-stake-pool,
  https://www.certora.com/reports/squads-v4
- **Solana evidence:**
  - "Solana Stake Pool - Formal Verification by Certora" (July 16, 2026), filed under Solana.
  - A Squads V4 report (Dec 12, 2024).
  - A Solana ecosystem section on the site.
- **What they ask for:** "Share your code with us to determine the complexity and timeline". The
  request form showed only a country field and a terms checkbox. It lists the included services as
  "Manual code review" and "In-depth formal verification review".
- **Process:**
  1. Determine scope and timeline
  2. Specification writing
  3. Code review and prover
  4. Report
- **Lead times:** not published.
- **Prices:**
  - The Prover's Basic tier is free; the Premium and Enterprise tiers say "Contact Us".
  - Audit prices: not published.
- **Contact:** https://www.certora.com/signup?plan=audit

### 9. Zellic

- **Pages read:** https://www.zellic.io/services, https://www.zellic.io/contact,
  https://www.zellic.io/our-work
- **Solana evidence (weaker than the firms above):**
  - "We support Solana security across the entire stack." The page names Pyth Network, Cega Finance
    and CoinFX.
  - /our-work names the Solana Foundation as a client.
  - The visible reports table on /our-work has no audit labelled Solana.
- **What they ask for (form):**
  - Name, company, email, Telegram or Twitter.
  - The kind of service and its scope: long-term engagement, comprehensive assessment, a few
    contracts or files, or other.
  - A project description, a link to the repositories or contracts, an ideal start date or timeline,
    and where you heard of them.
  - "For an expedited response, grant us access to your GitHub repository".
- **Process:**
  - "Tell us a bit about you and we'll schedule a call."
  - Their method covers attack surface enumeration, static analysis, manual review and dynamic
    analysis, with several engineers per engagement and quality control by an engagement manager.
- **Lead times:** not published.
- **Prices:** not published. They offer a free quote.
- **Contact:** https://www.zellic.io/contact. The email addresses on that page are obfuscated and
  could not be read.

## Low confidence

### OShield (madshield.xyz redirects here)

- **Pages read:** https://www.oshield.io/ (madshield.xyz answered with a 302 redirect to it).
- **Solana evidence:** indirect.
  - The page never names Solana.
  - A logo strip, identified only from image file names, shows Raydium, Metaplex, Magic Eden and
    others.
  - It claims "40+" audits.
- **What they ask for, process, lead times, prices:** not published.
- **Contact:** an Airtable "Book Your Audit" form, audit@oshield.io, Telegram t.me/oshieldbot
- **Why low confidence:** its own site does not establish its reputation.

## Fallbacks

### Halborn

- **Pages read:** https://www.halborn.com/solutions/smart-contract-assessment,
  https://www.halborn.com/contact, https://www.halborn.com/audits
- **Solana evidence:** a Solana logo under "Technologies We Assess", and one visible audit tagged
  Solana (1win, Aug 2026). The audits page showed 12 of 265 audits.
- **What they ask for (form):** name, email, phone, organization, website, the service, and "Please
  provide details about your project".
- **Process, lead times, prices:** not published.
- **Contact:** https://www.halborn.com/contact?service=Smart+Contract+Assessment; halborn@protonmail.com
  for secure communication.

### Kudelski Security

- **Pages read:** https://kudelskisecurity.com/, https://kudelskisecurity.com/blockchain,
  https://kudelskisecurity.com/services/ai-emerging-technology/blockchain-security-assessment
- **Solana evidence:** Solana Rust reviews in its report archive: Starke Finance Vaults (May 2025),
  "Solana Contract" (Sep 2023) and Solcial Stacking (Sep 2023). Only page 1 of 120 was read.
- **Process:**
  1. Kickoff and scoping
  2. Manual review
  3. Findings and remediation
- **What they ask for, lead times, prices:** not published.
- **Contact:** the contact form on the site, which has a "Blockchain / Crypto Audit" option. No email
  is shown.

## Could not be read

- **Offside Labs (offside.io):** the site renders only with JavaScript. Every fetch, the sitemap
  included, returned only the title, so we have no evidence for it.
