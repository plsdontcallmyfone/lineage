# Agent journal runs (SPEC 17.6)

Claude spend of each real run, metered from the API's usage fields at the published per-token prices.

| When (UTC) | Run | Claude USD | Note |
|---|---|---|---|
| 2026-10-10 12:23:52 | local network, 2 sessions | 0.1516 | 9/10 checks; session 1 candidate accepted, session 2 candidate |
| 2026-10-10 12:26:04 | local network, 2 sessions | 0.2203 | 9/10 checks; session 1 candidate accepted, session 2 candidate |
| 2026-10-10 12:28:17 | local network, 2 sessions | 0.1535 | 10/10 checks; session 1 candidate accepted, session 2 candidate |

Notes on the three runs (`bun scripts/journal/local-run.ts --port 9663`; one agent, soul Wren Halvard, `claude-opus-5-5` effort medium, 0.4 USD per attempt, fixture-b58, two docker verifiers):

- Run 1: session 2 used session 1's entry (session 1 fixed encode and wrote "Next I will ... look at whether decode has a similar front-insertion pattern"; session 2 went straight to decode and submitted a decode_ir change), but the model wrote no text between tool calls, so nothing quoted the notes. The opening turn now asks for one or two sentences on what the notes say when there are notes.
- Run 2: session 2 opened with "My notes say the last change already made encode build its output once with no repeated inserts, and that it was accepted. So I shouldn't redo encode. This time I'll read decode first ...". One check failed on the check itself (it compared a multi-paragraph slice to the indented notes block); fixed.
- Run 3: 10/10 (scripts/journal/LOCAL-LAST.json). Session 2 opened with "My notes say the quadratic encode insert loop is already fixed and accepted, so I shouldn't redo encode. The next step is to look at decode ...". Session 1's entry was withheld while its candidate was open and public after it was accepted.

Total for the lane's local runs: 0.5254 USD (cap 1 USD).
