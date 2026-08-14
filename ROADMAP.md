# Solana Transaction Debugger — Build Roadmap

**Goal:** given a transaction signature, report where in the source the transaction failed, and explain why.

**Ordering principle:** every phase ships something usable on its own. Infrastructure cost rises with phase number; answer precision rises with it too. Do not start Phase 5 until Phases 1–4 are covering their categories well.

---

## Phase 0 — Ingest & Normalize

Foundation. No diagnosis yet, just a clean internal representation of a failed transaction.

- [ ] RPC client wrapper around `getTransaction` with `maxSupportedTransactionVersion: 0` set (omitting it errors on all v0 transactions)
- [ ] Handle `null` responses — distinguish "never landed" from "outside RPC retention window"
- [ ] Archive RPC fallback for transactions older than public node retention (~2 days)
- [ ] Normalize legacy vs v0 messages; resolve `addressTableLookups` into a flat `accountKeys` list
- [ ] Parse `meta.err` into a typed enum: `InstructionError(index, kind)`, top-level variants (`InsufficientFundsForRent`, `AlreadyProcessed`, …)
- [ ] Build the instruction tree from `meta.innerInstructions` — outer instructions with CPI children, preserving stack depth
- [ ] Log parser: tokenize `invoke [depth]` / `success` / `failed` / `Program log:` / `consumed N of M compute units` into a structured event stream keyed to the instruction tree
- [ ] Detect log truncation (10KB cap) and flag it on the parsed result
- [ ] Fixture corpus: 30–50 real failing signatures spanning Anchor constraints, custom errors, panics, compute exhaustion, native program errors. This is the regression suite for everything below.

**Done when:** any failed signature yields a typed structure identifying which instruction failed, with what error, and what the log stream around it was.

---

## Phase 1 — Exact Answers Without Source

The cases where the location falls out of the logs directly. Highest value per unit of effort — build this before anything clever.

- [ ] **Anchor constraint errors (2000–2999):** parse `AnchorError caused by account: <name>` → account struct field name + which `#[account(...)]` constraint
- [ ] Extract `Left:` / `Right:` pubkey pairs from constraint failures and surface them as expected vs actual
- [ ] **Anchor account errors (3000–3999):** discriminator mismatch, not initialized, owner mismatch → map to the offending account
- [ ] **Panic symbolization:** regex `panicked at '<msg>', <file>:<line>:<col>` — this is already an exact source location, no inference needed
- [ ] Classify common panic messages (overflow, unwrap on None, index out of bounds, division by zero) with plain-English explanations
- [ ] **Compute budget exhaustion:** detect `exceeded CUs meter`, report `unitsConsumed` vs the limit, and which instruction burned the budget
- [ ] **Stack violations:** parse `Access violation in stack frame N` → explain the 4KB frame limit and typical causes
- [ ] Native program error tables: SPL Token, Associated Token, System, Stake — static code → name/message maps
- [ ] Confidence field on every result: `exact` | `narrowed` | `variant-only` | `unknown`

**Done when:** the tool gives a genuinely useful answer for constraint violations and panics with no source code and no build infrastructure at all.

---

## Phase 2 — Source Resolution

Connecting an on-chain program to the code that produced it. Correctness-critical.

- [ ] IDL resolution: `anchor idl fetch` for on-chain IDLs; parse `errors[]` into code → name + `#[msg]` message
- [ ] Local IDL upload path for programs without a published IDL
- [ ] **Slot-accurate binary resolution** — the correctness trap:
  - [ ] Locate the ProgramData account for the program ID
  - [ ] Enumerate `Upgrade` instructions via `getSignaturesForAddress`
  - [ ] Bisect by slot to find the deployment live at the failing slot
  - [ ] **Never** fall back to the current deployment silently — if the historical binary can't be resolved, degrade confidence and say so
- [ ] Verified build lookup: OtterSec registry / `solana-verify` — program hash → repo + commit
- [ ] Hash the resolved on-chain binary and confirm it matches the registry entry before trusting any source mapping
- [ ] Source fetch and cache by commit SHA
- [ ] Explicit unverified-program mode: error names and messages from IDL, no line numbers, confidence capped at `variant-only`

**Done when:** for a verified program, the tool can produce the exact source tree that was running at the failing slot — and refuses to guess when it can't.

---

## Phase 3 — Inference & Narrowing

Turning an error variant into a small set of candidate throw sites.

- [ ] Parse instruction data: first 8 bytes → discriminator → handler name (via IDL)
- [ ] Static analysis pass over the resolved source: index every `require!`, `require_eq!`, `require_keys_eq!`, `err!`, `return Err(...)` with file, line, and the error variant it raises
- [ ] Call graph from handler entry points; reachability filter to drop throw sites the failing handler can't reach
- [ ] **CPI progress bounding:** compare observed inner instructions against CPI call sites in the handler — failure is bounded between the last completed CPI and the next one
- [ ] **Log breadcrumb bounding:** each observed `msg!` in the source establishes a lower bound on execution position
- [ ] Combine all filters; rank surviving candidates
- [ ] Report the full candidate set when more than one survives — never present a guess as certainty
- [ ] Regression check: on the fixture corpus, measure how often the correct site is (a) uniquely identified, (b) in the top 3

**Done when:** a `Custom(6001)` failure resolves to one or two `require!` sites in the correct handler, with the source excerpt shown.

---

## Phase 4 — Explanation Layer

The actual differentiator. A line number is table stakes; the answer to "why" is the product.

- [ ] Render the failing source with surrounding context, throw site highlighted
- [ ] Show the constraint expression itself — for `ConstraintSeeds`, print the `seeds = [...]` from source alongside the Left/Right pubkeys so the wrong derivation is visible
- [ ] Recompute expected PDAs from the source seeds and diff against actual — catch bump and seed-ordering mistakes explicitly
- [ ] Account state table: for each account in the failing instruction, show owner, lamports, data length, and decoded type where the IDL allows
- [ ] Balance delta view from `preBalances`/`postBalances` and token balances, with the note that failed transactions roll back everything but the fee
- [ ] Compute unit breakdown per instruction
- [ ] Explanation templates per error category — what this error means, the usual causes, what to check
- [ ] Suggested fixes where the diagnosis is unambiguous (e.g. `AccountDidNotSerialize` → the computed `space` vs actual data length)
- [ ] Shareable permalink per diagnosis

**Done when:** the output tells someone what went wrong in their mental model, not just where the process stopped.

---

## Phase 5 — Replay

Exact answers for what inference can't resolve. Expensive; this phase largely determines the cost structure.

- [ ] Historical account state sourcing — the hard prerequisite. `getTransaction` gives pre-*balances*, not pre-*data*, so inputs cannot be reconstructed from the transaction alone. Evaluate:
  - [ ] Archive provider with historical account state (Old Faithful, Geyser-backed stores)
  - [ ] Replay forward from a snapshot at a prior slot
  - [ ] Cost and latency comparison — pick one before building on it
- [ ] `solana_rbpf` execution harness: load the slot-accurate binary, install syscalls, seed accounts, execute
- [ ] Verify replay fidelity: the replayed transaction must reproduce the same `meta.err` and compute consumption as the ledger. Divergence means the state reconstruction is wrong — fail loudly rather than reporting results
- [ ] Instruction tracing with PC capture at the fault
- [ ] Debug rebuild at the verified commit to produce DWARF (verified builds are release; the debug rebuild must be byte-reproducible or the mapping is unsound)
- [ ] PC → source line via DWARF line table
- [ ] Reconstruct the intra-program Rust call stack from frame pointers
- [ ] Sandbox and resource-limit the replay path
- [ ] Cross-check replay results against Phase 3 inference on the fixture corpus — disagreement is a bug in one of them

**Done when:** for a verified program with available historical state, the tool reports the exact throw site with a call stack, confirmed against inference.

---

## Phase 6 — Productization

- [ ] Handle truncated logs gracefully — flag reduced confidence, explain why breadcrumbs are missing, suggest reducing `msg!` volume in hot paths
- [ ] Caching: resolved binaries, source trees, IDLs, static analysis indexes — all immutable by commit hash
- [ ] Rate limiting and RPC cost control; batch signature submission
- [ ] Simulation mode for pre-flight debugging, with a prominent warning that simulation runs against *current* state and will not reproduce historical state-dependent failures
- [ ] API for CI integration — fail a build when a test transaction errors, with the diagnosis inline
- [ ] Coverage metrics: what fraction of real mainnet failures land in each confidence bucket
- [ ] Guidance doc for contract authors on making programs debuggable (`#[error_code]` with real messages, `require_eq!` over bare `require!`, `overflow-checks = true`, sparing logs)

---

## Cross-Cutting Rules

1. **Never present inference as certainty.** Every answer carries a confidence level. One confidently wrong line number costs more trust than ten honest "couldn't narrow this past three candidates."
2. **Slot accuracy is non-negotiable.** Current-deployment binaries against historical transactions produce plausible, wrong answers.
3. **Degrade in tiers, don't fail.** Unverified program → error message without a line. No IDL → raw code with a decoded category. No logs → error kind and instruction index. Something useful at every level.
4. **The fixture corpus is the spec.** Every phase is measured against it; regressions there block shipping.
