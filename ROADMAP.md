# Solana Transaction Debugger — Build Roadmap

**Goal:** given a transaction signature, report where in the source the transaction failed, and explain why.

**Ordering principle:** every phase ships something usable on its own. Infrastructure cost rises with phase number; answer precision rises with it too. Do not start Phase 5 until Phases 1–4 are covering their categories well.

---

## Phase 0 — Ingest & Normalize

Foundation. No diagnosis yet, just a clean internal representation of a failed transaction.

- [x] RPC client wrapper around `getTransaction` with `maxSupportedTransactionVersion: 0` set (omitting it errors on all v0 transactions)
- [x] Handle `null` responses — distinguish "never landed" from "outside RPC retention window"
- [x] Archive RPC fallback for transactions older than public node retention (~2 days)
- [x] Normalize legacy vs v0 messages; resolve `addressTableLookups` into a flat `accountKeys` list
- [x] Parse `meta.err` into a typed enum: `InstructionError(index, kind)`, top-level variants (`InsufficientFundsForRent`, `AlreadyProcessed`, …)
- [x] Build the instruction tree from `meta.innerInstructions` — outer instructions with CPI children, preserving stack depth
- [x] Log parser: tokenize `invoke [depth]` / `success` / `failed` / `Program log:` / `consumed N of M compute units` into a structured event stream keyed to the instruction tree
- [x] Detect log truncation (10KB cap) and flag it on the parsed result
- [x] Fixture corpus: 30–50 real failing signatures spanning Anchor constraints, custom errors, panics, compute exhaustion, native program errors. This is the regression suite for everything below.

**Done when:** any failed signature yields a typed structure identifying which instruction failed, with what error, and what the log stream around it was.

---

## Phase 1 — Exact Answers Without Source

The cases where the location falls out of the logs directly. Highest value per unit of effort — build this before anything clever.

- [x] **Anchor constraint errors:** parse `AnchorError caused by account: <name>` → account struct field name + which `#[account(...)]` constraint
- [x] Extract `Left:` / `Right:` pubkey pairs from constraint failures and surface them as expected vs actual — in both shapes Anchor emits them, inline for integers and split across lines for pubkeys
- [x] **Anchor account errors:** discriminator mismatch, not initialized, owner mismatch → map to the offending account
- [x] **Anchor throw sites:** `AnchorError thrown in <file>:<line>` is an exact source location the program printed about itself — worth more than the account form and free from the same log line
- [x] Handler names from Anchor's `Program log: Instruction: <Handler>` prologue, read from the *failing frame only* — a CPI callee logs one too
- [x] **Panic symbolization:** both Rust formats — `panicked at '<msg>', <file>:<line>:<col>` and the 1.73+ form where the message follows a newline inside the same log entry
- [x] Classify common panic messages (overflow, unwrap on None, index out of bounds, division by zero) with plain-English explanations
- [x] **Compute budget exhaustion:** detect `exceeded CUs meter`, report `unitsConsumed` vs the limit and the `SetComputeUnitLimit` the client requested, and which frame burned the budget
- [x] **Stack violations:** parse `Access violation in stack frame N` → explain the 4KB frame limit and typical causes
- [x] Native program error tables: SPL Token, Token-2022, Associated Token, System, Stake — static code → name/message maps, keyed on the pinned program address and never on a code range
- [x] Plain-English explanations for the runtime's own `InstructionError` variants
- [x] Confidence field on every result: `exact` | `narrowed` | `variant-only` | `unknown`

**Done when:** the tool gives a genuinely useful answer for constraint violations and panics with no source code and no build infrastructure at all.

Two rules were settled here and bind every later phase:

- **`exact` requires a source location.** An account-attributed Anchor error is read rather than inferred, and still caps at `variant-only`, because it locates a field in an accounts struct rather than a line. `exact` therefore never appears with an empty candidate list, and that is asserted across the corpus.
- **Nothing is named from a code range.** Anchor reserves 2000–2999 and 3000–3999 by convention, not by anything the runtime enforces, and the corpus contains two Whirlpool failures returning `Custom(2012)` with no Anchor logging at all. A code the program did not publish a name for stays a number until Phase 2 resolves an IDL. Error tables are permitted only where the program's address is pinned and its error enum published.

---

## Phase 2 — Source Resolution

Connecting an on-chain program to the code that produced it. Correctness-critical.

- [x] IDL resolution from the Anchor-derived address; parse `errors[]` into code → name + `#[msg]` message. Both layouts: pre-0.30 (camelCase, no discriminators) and 0.30+ (`spec`, snake_case, explicit discriminators) — roughly half the corpus each
- [x] Handler names by matching instruction discriminators against the IDL, for programs that log no Anchor prologue
- [x] **An IDL published at the Anchor-derived address unlocks Anchor's built-in error table.** This is the evidence Phase 1 refuses to assume: only an Anchor program publishes there, so the reserved ranges demonstrably apply and `Custom(2012)` becomes `ConstraintAddress`. Without an IDL the refusal stands
- [x] **Slot-accurate binary resolution** — the correctness trap:
  - [x] Locate the ProgramData account for the program ID
  - [x] Read `last_deploy_slot` from its header. This is a single 45-byte read and it answers the question outright — no `Upgrade` enumeration and no bisection, both of which were in the original plan and are unnecessary
  - [x] Non-upgradeable loaders (`BPFLoader2`, `NativeLoader`) resolve as immutable for free: their bytes cannot have changed
  - [x] **Never** fall back to the current deployment silently. When the program was redeployed after the transaction, the bytes that ran are gone — `getAccountInfo` serves current state only — so the answer is a refusal, not a fallback
- [x] Verified build lookup: OtterSec registry — program hash → repo + commit. `status-all` returns conflicting entries, so an entry is only trusted when it is `is_verified` **and** its `executable_hash` equals its `on_chain_hash`
- [x] Hash the resolved on-chain binary and confirm it matches the registry entry: `sha256(programData[45..])` with trailing zeros trimmed. The registry's own `on_chain_hash` is recomputed rather than believed
- [x] The registry lookup is gated on the deployment check — an entry describes what is deployed *now*, so on a stale deployment it is a true statement about the wrong bytes
- [x] Explicit unverified-program mode: error names and messages from IDL, no line numbers, confidence capped at `variant-only`
- [ ] Local IDL upload path for programs without a published IDL — folded into Phase 3's local source path, since the two arrive together
- [ ] Source fetch and cache by commit SHA — deferred to Phase 3, which is what consumes the tree
- [x] Report a registry entry that rebuilds to the deployed binary but which the registry does not currently mark verified. The gate is unchanged and such an entry is never treated as a verified build; it is named, with the registry's own stale hash as the stated reason it did not qualify

**Done when:** for a verified program, the tool can produce the exact source tree that was running at the failing slot — and refuses to guess when it can't.

The corpus reaches **7 `exact` / 34 `variant-only` / 6 `unknown`** with resolution applied. Only two fixtures moved, and that is the honest ceiling: the remaining six undecoded programs publish no on-chain IDL, or have had their ProgramData closed. The phase's output is the resolution layer Phase 3 depends on, not the confidence delta.

Note the corpus systematically under-represents the degrade paths. Harvested fixtures are always recent, so every real program in it still runs the binary that ran; `upgraded-since` exists only as a synthetic fixture, and must stay one.

That is a statement about the recorded snapshots, not about mainnet. Between recording them and the Phase 4 work two of the 24 live programs redeployed — Whirlpool to slot 440170207 and ORE to 439924903, against snapshots read at roughly 439652000 — so a live diagnosis of those same signatures now refuses at the deployment check. Roughly 8% of the programs in two days. `upgraded-since` is the ordinary outcome for anything but a fresh signature, and the frozen snapshots are the only reason the suite did not quietly start describing different binaries.

`pnpm snapshot` was a trap rather than a routine refresh, and now refuses: a snapshot whose `lastDeploySlot` has moved is reported rather than overwritten, the run exits non-zero, and `--force` is required to replace one deliberately. Re-running it unguarded would have flipped Whirlpool to `upgraded-since` and deleted the corpus's only live-plus-IDL-plus-`anchor-builtin` coverage.

Run against mainnet after the guard landed, **8 of the 27 recorded programs had redeployed** — Whirlpool, Jupiter, both Raydium programs, ORE and three more — against snapshots read at roughly 439652000, about three days earlier. The two-in-two-days figure above was the first measurement of the same drift; 30% in three days is the rate to plan around. The remaining 19 were byte-identical, and are left untouched rather than rewritten, so the script is idempotent and a real change stays visible in a diff.

---

## Phase 3 — Inference & Narrowing

Turning an error variant into a small set of candidate throw sites.

**Deferred after measurement.** The phase rests on fetching the source tree at the verified commit Phase 2 resolves, and the corpus says that tree is almost never available. Of the 24 live corpus programs, **3** have a verified build whose hash matches the deployed binary — SPL Token, GODL and Oridion. Five have registry entries where none is verified, and fifteen have no entry at all.

That leaves **4 of 47 transactions** failing in a verified program, and none of the four is a case this phase would answer. Two are SPL Token, which is not Anchor and has no `require!` grammar to index, and whose errors the pinned native table already names. One is GODL, already `exact` from a panic. One is Oridion's `AccountNotInitialized`, an Anchor accounts-struct error that a throw-site index would not find. Building the phase as written would move zero fixtures and its own regression metrics could not be computed.

The blocker is that verified builds are rare, not that static analysis is hard. The realistic unlock is a **local source path** — a developer debugging their own program has the tree checked out — which also subsumes the local-IDL item deferred out of Phase 2. Confidence would cap below `exact` for anything derived from such a tree, since it is not hash-proven against the deployed binary.

- [x] Parse instruction data: first 8 bytes → discriminator → handler name (via IDL). Done in Phase 2 — Anchor programs log their handler name and Phase 1 reads it, and the discriminator covers the ones that do not
- [x] Accept an uploaded IDL and program binary, cross-checked against the observed discriminators and the deployed binary's hash. `POST /artifacts` into a content-addressed store behind an `ArtifactStore` port; the IDL is read during diagnosis, the binary's verdict is settled at upload
- [ ] Accept a local *source tree*, once there is a proven binary to map it against
- [ ] Fetch and cache the source tree at the verified commit Phase 2 resolved
- [ ] Static analysis pass over the resolved source: index every `require!`, `require_eq!`, `require_keys_eq!`, `err!`, `return Err(...)` with file, line, and the error variant it raises
- [ ] Call graph from handler entry points; reachability filter to drop throw sites the failing handler can't reach
- [ ] **CPI progress bounding:** compare observed inner instructions against CPI call sites in the handler — failure is bounded between the last completed CPI and the next one
- [ ] **Log breadcrumb bounding:** each observed `msg!` in the source establishes a lower bound on execution position
- [ ] Combine all filters; rank surviving candidates
- [ ] Report the full candidate set when more than one survives — never present a guess as certainty
- [ ] Regression check: on the fixture corpus, measure how often the correct site is (a) uniquely identified, (b) in the top 3
- [x] Before any of the above: harvest fixtures that can measure it. Two `ConstraintSeeds` failures are now in the corpus, found by matching the `Error Code:` line the program printed about itself rather than Anchor's reserved code range — `harvest.ts --want <Name>` does this, and filtering on the range would have been the same guess the engine refuses. `ConstraintHasOne` did not occur in the same 300-block scan and remains unrepresented

### What the artifact path reaches

`pnpm coverage` over 200 live failures, capped per block so no single busy block dominates. Two runs, before and after the failing program is attributed from the instruction index when the logs name none:

| what blocked the unnamed failures | before | after |
| --- | --- | --- |
| **program publishes no IDL and none was uploaded** | **62.0%** | **85.5%** |
| no failing program identified | 15.5% | **0%** |

**Read the blocker composition, not the confidence split.** Every unnamed failure is now attributed to a specific program and blocked on that program publishing nothing — the engine-side gap is closed, and what remains is entirely the ecosystem one.

The confidence distribution is far too noisy at this sample size to carry a claim. Two 200-failure runs taken minutes apart read 72.5% and 85.5% `unknown`, and 12.5% against 4.5% `exact`, because `exact` comes from panics and how many panics a given 25 blocks contain is traffic, not capability. Quoting a single run's split as an improvement would be exactly the overclaim this project exists to avoid.

That 85.5% is the whole case for the artifact path: it is not a gap inference could close, it is programs declining to say what their error codes mean. An upload closes it for one program at a time, which is exactly the developer-debugging-their-own-program case the README describes.

The corpus reads 13% `unknown` against this. Both numbers are correct and they measure different things — the corpus is one hand-checked instance of each failure shape, not a sample of traffic. Keep them apart.

One trap the measurement itself had. Attributing more programs means resolution runs on far more of the sample, and at the old 120ms pacing 17% of a run came back rate-limited. Those were counted as a diagnostic blocker, which would have had the project understate its own reach and believe the number. Throttling is now bucketed apart, warned about, and exits non-zero, and the default pacing is 400ms.

**Done when:** a `Custom(6001)` failure resolves to one or two `require!` sites in the correct handler, with the source excerpt shown.

`narrowed` remains unused across the codebase, and a corpus test asserts it stays that way until this phase lands.

---

## Phase 4 — Explanation Layer

The actual differentiator. A line number is table stakes; the answer to "why" is the product.

Built **from the transaction record and the program's published IDL**, with no source tree and no account fetches. Everything reported here was recorded at the failing slot, which is what makes it usable where a current-state read would not be: a failed transaction rolls back, so an account the instruction found missing may well exist now.

- [x] Recompute expected PDAs and diff against actual — from the IDL's `pda.seeds` rather than from source, plus the Associated Token program's pinned derivation. 571 seeded accounts across the corpus IDLs, of which 97.6% of seed components resolve from the transaction alone
- [x] Account state table: position, address, IDL name, signer, writable, origin, lamports either side, and the recorded token balance with its mint, owner and token program
- [x] Balance delta view from `preBalances`/`postBalances` and token balances, listing only what changed — on a failure that is the fee, and saying so answers the question the reader was about to ask
- [x] Compute unit breakdown per frame, read from the runtime's own `consumed N of M` lines
- [x] Instruction arguments decoded against the IDL's declared types
- [x] Explanation templates per error category — what this error means, the usual causes, what to check
- [x] Suggested fixes where the evidence is unambiguous
- [ ] Render the failing source with surrounding context, throw site highlighted — waits on Phase 3, which is what produces a source tree
- [ ] Show the constraint expression itself, alongside the Left/Right operands — same dependency
- [ ] Owner and data length per account — not in the transaction record, and a current-state read would describe a different world than the one that failed
- [ ] Shareable permalink per diagnosis — presentation, deferred with the rest of it

**Done when:** the output tells someone what went wrong in their mental model, not just where the process stopped.

### What the corpus shows

Compute is attributed for all 47 fixtures, an account table is built for 40, names are attached for 21, arguments decode for 22, and 19 carry a concrete suggested fix. 49 IDL-declared PDA derivations reproduce the address that was passed and none contradicts one; 9 more refuse because a seed component could not be resolved from the record.

The headline item nearly shipped wrong. When Phase 4 was built, **none of the 9 fixtures with a named offending account had IDL-declared seeds for that account** — five are missing associated token accounts, whose derivation belongs to the Associated Token program rather than to the failing program. Recomputing PDAs from declared seeds alone would have run on twelve fixtures and never once on the account that actually failed, which is why the pinned associated-token derivation was built alongside it.

The two harvested `ConstraintSeeds` fixtures are the first where the blamed account does declare seeds, and they are worth reading as the honest outcome rather than the happy one. PumpSwap's `coin_creator_vault_authority` derives from `[b"creator_vault", pool.coin_creator]`. The literal resolves; `pool.coin_creator` reads a field out of another account's data, which exists only as current state, so the check reports `unresolved` and names the component that blocked it. Two of 11 blamed accounts have declared seeds and **neither can be recomputed** — the seeds that matter are the ones that reach outside the transaction. What the reader still gets is the error name, the blamed field, and the two operands Anchor logged.

Two rules came out of building it:

- **This phase never changes `confidence` or `candidates`.** It explains what earlier tiers established and locates nothing new, so it cannot promote a diagnosis. A corpus test compares each diagnosis against the same diagnosis without the explanation and requires both to match.
- **A derivation is proved, never inferred.** The associated-token check draws every candidate from the transaction's own accounts and mints; a hit means the derivation reproduced the address exactly. The negative is reported too, bounded by the search space it states — an address that is not the associated token account of anything the instruction passed is an address the client derived wrongly, which is the more useful of the two outcomes.

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

- [x] Handle truncated logs gracefully — implemented in Phase 0 and reported as a degradation. Measured at **0 of 6,895** sampled mainnet failures, so it is a real code path with no real traffic behind it. Do not invest further without a reason to
- [ ] Caching: resolved binaries, source trees, IDLs, static analysis indexes — all immutable by commit hash
- [ ] Rate limiting and RPC cost control; batch signature submission
- [ ] Simulation mode for pre-flight debugging, with a prominent warning that simulation runs against *current* state and will not reproduce historical state-dependent failures
- [ ] API for CI integration — fail a build when a test transaction errors, with the diagnosis inline
- [x] Coverage metrics: `pnpm coverage` samples live failures, runs the full engine over each, and reports the distribution and what blocked every unnamed one
- [ ] Guidance doc for contract authors on making programs debuggable (`#[error_code]` with real messages, `require_eq!` over bare `require!`, `overflow-checks = true`, sparing logs)

---

## Cross-Cutting Rules

1. **Never present inference as certainty.** Every answer carries a confidence level. One confidently wrong line number costs more trust than ten honest "couldn't narrow this past three candidates."
2. **Slot accuracy is non-negotiable.** Current-deployment binaries against historical transactions produce plausible, wrong answers.
3. **Degrade in tiers, don't fail.** Unverified program → error message without a line. No IDL → raw code with a decoded category. No logs → error kind and instruction index. Something useful at every level.
4. **The fixture corpus is the spec.** Every phase is measured against it; regressions there block shipping.
