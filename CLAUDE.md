# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Current state

**Phases 0 (ingest), 1 (log analysis) and 2 (source resolution) are done.** `POST /diagnose` fetches a real transaction, normalizes it into a typed `FailedTransaction`, reads its logs for everything they disclose on their own, and then resolves the failing program — proving whether the deployed binary is the one that ran, fetching its IDL, and checking its hash against a verified-build registry.

Against the 45-signature corpus that lands **7 `exact`, 32 `variant-only`, 6 `unknown`**. The `exact` answers are panics and `AnchorError thrown in <file>:<line>`, both locations the program printed about itself. The six remaining `unknown` are programs that publish no on-chain IDL, or whose ProgramData has been closed — undecoded by design rather than by omission.

Phase 1 reached further than the roadmap assumed: Anchor logs the variant name and the `#[msg]` text in the same line as the error, and logs the handler name in a `Program log: Instruction: <Handler>` prologue, so none of that waits on an IDL for Anchor programs. Phase 3 is next, and the repo and commit it needs are what Phase 2 produces.

The contract every later tier has to keep: always answer, never throw for an undiagnosable input, and always say what the answer is worth and why.

### Reading a failure: `packages/core/src/analyze/`

Pure and I/O-free, like `ingest/`. `analyze(transaction)` runs detectors cheapest-and-most-specific first and stops at the first that answers, because the categories overlap in `meta.err` — a panic, a compute exhaustion, and a stack overrun all surface as `ProgramFailedToComplete`, and only the logs tell them apart.

### Resolving the program: `packages/core/src/resolve/`

Async and I/O-bound, unlike `analyze/`, and reached through a second port — `AccountSource` beside `TransactionSource`. `diagnose()` runs the free log analysis first and only resolves when it would change the answer: an error the program named itself is not re-decided by an IDL that may be a deployment behind.

The cascade halts at the deployment check. If the binary on chain is not the binary that ran, no amount of IDL or registry work produces a statement about the right code, so nothing downstream runs.

**Resolution is an enrichment, never a prerequisite.** `deps.accounts` is optional, and a resolution that throws is caught and appended to `reasons` — the log-derived answer must survive an RPC failure that happens after it was already established.

**`frames.ts` is load-bearing and easy to get wrong.** It rebuilds the CPI frame stack from the `invoke` / `success` / `failed` bracket sequence, and every other detector reads a *single frame's own lines*. Corpus signature `2WH1WJ5N…` is the reason: the failing program logs `Instruction: BuyExactQuoteIn`, then calls a fee program that logs `Instruction: GetFees` and returns successfully, and only afterwards throws. Anything that scans "the last `Instruction:` line before the failure" reports `GetFees` — a handler in a program that did not fail. `failingFrame` orders by `closedAt`, not by depth or invoke order, because a CPI failure logs the innermost `failed:` line first and each caller's on the way out.

Node/TypeScript pnpm workspace, ESM throughout:

| Package | What it is |
| --- | --- |
| `packages/core` (`@solvbana/core`) | The diagnosis engine. Depends on `@solana/kit` for RPC, and **nothing else** — in particular **no HTTP server or framework imports**, enforced by an ESLint `no-restricted-imports` rule scoped to the package, so the boundary fails lint rather than review. This is what keeps the planned CLI and Phase 6 CI-integration API cheap to add. |
| `packages/server` (`@solvbana/server`) | Fastify transport over `core`. Route schemas are TypeBox, so ajv validation and `fast-json-stringify` serialization both work off the same declarations. |

### Commands

| Command | Does |
| --- | --- |
| `pnpm dev` | Watch-mode server from TypeScript source |
| `pnpm build` | `tsc --build` across the workspace |
| `pnpm typecheck` | Builds, then typechecks both `test/` projects and `scripts/` |
| `pnpm lint` / `pnpm format` | ESLint (type-checked) / Prettier |
| `pnpm test` / `pnpm test:watch` | Vitest |
| `pnpm harvest` | Add mainnet failures to the fixture corpus. Manual only, never CI |
| `pnpm record <sig>` | Add one named signature to the corpus |
| `pnpm snapshot` | Record the program, ProgramData header and IDL accounts every corpus program resolves through. Manual only, never CI |

Single test file: `pnpm vitest run packages/server/test/health.test.ts`. Single test by name: add `-t "returns ok"`.

### Conventions worth knowing before editing

- **Relative imports carry `.ts` extensions.** `tsconfig.base.json` sets `allowImportingTsExtensions` + `rewriteRelativeImportExtensions`, so source runs directly under Node's type stripping and `tsc` rewrites the specifiers to `.js` on emit. Writing `.js` in source will break the dev path.
- **`erasableSyntaxOnly` is on** — no enums, no namespaces, no parameter properties.
- **Cross-package resolution uses a `development` export condition.** `@solvbana/core` resolves to `src/index.ts` in dev and test (`--conditions=development`, and `resolve.conditions` in `vitest.config.ts`) and to `dist/` in production. Tests therefore never run against a stale build. If an import of `@solvbana/core` starts failing, check that condition before anything else.
- **`buildApp()` never calls `listen`.** `src/index.ts` is the only place that binds a port; tests drive the app through `app.inject()`.
- Adding a package means adding it to the root `tsconfig.json` references and giving its `test/` directory a `tsconfig.json` (ESLint's project service resolves the nearest one).

## What this project is

`solvbana` takes a failed Solana transaction signature and reports which line of the on-chain program's source failed, and why. `README.md` has the target output format; `ROADMAP.md` has the full phase breakdown. Read both before designing anything.

## Architecture: four tiers, applied cheapest-first

The whole design is a cost-ordered cascade. Each tier is independently useful and ships on its own; a diagnosis stops at the cheapest tier that answers.

1. **Log parsing** (free) — Anchor constraint errors already name the offending account; Rust panics already carry `file:line:col`. No source or infrastructure needed.
2. **IDL + discriminator** (one RPC call) — error code → variant name and `#[msg]` text; first 8 bytes of instruction data → which handler ran.
3. **Static analysis** (source fetch) — index every throw site in the resolved source, then filter by reachability from the failing handler and bound the position using observed CPIs and `msg!` breadcrumbs.
4. **Replay** (archive state + rbpf) — exact program counter, DWARF-symbolized, with an intra-program call stack.

Most real failures resolve at tier 1 or 2. Tier 4 exists only for what tiers 1–3 cannot narrow. Do not build a later tier to solve a problem an earlier tier can cover — the roadmap's ordering principle is that infrastructure cost rises with phase number, and Phase 5 should not start until 1–4 cover their categories well.

## Invariants that must hold in any implementation

These are the load-bearing correctness rules from `ROADMAP.md`'s cross-cutting section. Violating one produces answers that are plausible and wrong, which is the specific failure mode this project exists to avoid.

**Every result carries a confidence level.** The four values are `exact` (read directly from a panic message or Anchor account attribution), `narrowed` (inference reduced candidates to a set), `variant-only` (error decoded but source unavailable or unverified), and `unknown` (logs truncated or failure opaque). This is not a display concern — it belongs in the core result type from the first commit, and no code path may produce a location without one.

**When more than one candidate survives narrowing, report all of them, ranked.** Never collapse a candidate set to its top entry. Three honest candidates cost less trust than one confident wrong line.

**Slot accuracy is non-negotiable.** Programs get upgraded, so the binary must be the one live at the _failing slot_. This reduces to one number: `UpgradeableLoaderState::ProgramData` stores its most recent deployment slot in its header, so a 45-byte read settles it. At or before the failing slot means the current deployment provably *is* the historical one; a non-upgradeable loader means it always was.

When the program was redeployed after the transaction, **the answer is a refusal, not a fallback.** `getAccountInfo` serves current state only, so the bytes that ran are not retrievable at any price — enumerating the account's `Upgrade` transactions would name the deployment without producing it. Silently reporting the current binary is the exact failure this project exists to avoid: it yields source that looks right and describes different code.

**Mapped line numbers require a verified build.** Hash the resolved on-chain binary and confirm it matches the verified-build registry entry _before_ producing any source mapping. Unverified programs are capped at `variant-only` for anything derived from source: names and messages, never mapped lines.

This governs **mapping**, which is what Phases 2, 3 and 5 do — resolving a binary to a source tree, indexing throw sites, walking a DWARF line table. It does not govern a location the program **printed about itself at runtime**. A Rust panic message and Anchor's `AnchorError thrown in <file>:<line>` are emitted by the running program into its own logs; no binary was mapped to any source, so there is no mapping to verify, and refusing to report them would discard the strongest signal in the whole cascade. These are `exact`. The distinction to hold onto is _read versus derived_: a location the transaction record hands you needs no build verification, and a location this tool computes always does.

**`exact` means there is a location.** An answer that is read rather than inferred but names no line — an Anchor error attributed to an accounts-struct field, a compute exhaustion pinned to a frame — is `variant-only`. This makes the level checkable rather than a matter of judgement, and `corpus.test.ts` asserts it: no fixture may reach `exact` with an empty `candidates` list.

**Error codes are never decoded from a range.** Anchor's reserved bands (2000–2999 constraints, 3000–3999 accounts, 6000+ user) are one framework's convention; the runtime enforces nothing, and any program may return any `u32`. Two Whirlpool fixtures in the corpus return `Custom(2012)` — `ConstraintAddress` in Anchor's table — with no Anchor logging anywhere in the transaction. From the logs alone they stay `unknown` with the raw code and an explicit statement of the refusal.

Three things license a name, and nothing else does:

1. The program **printed it** (`Error Code: …` in an `AnchorError` line).
2. The failing program's **address is pinned** and its error enum published, as with SPL Token and the System Program — a lookup on identity, not on a number.
3. An **IDL was fetched from the program's Anchor-derived address**. Only an Anchor program publishes there, so this is direct evidence that Anchor's conventions apply to *this* program, and `anchorBuiltinFor` takes the resolved IDL as an argument precisely so the licence cannot be left behind at a call site. This is what turns the two Whirlpool fixtures into `ConstraintAddress`, and it is the only reason that is not the same guess Phase 1 refuses.

**Replay must be validated against the ledger.** A replayed transaction has to reproduce the recorded `meta.err` and compute consumption. Divergence means the reconstructed state is wrong — fail loudly rather than reporting the result.

**Degrade in tiers, never fail blank.** Unverified program → error message without a line. No IDL → raw code with a decoded category. No logs → error kind and instruction index. There must be something useful at every level of missing information.

## The fixture corpus is the spec

45 real failing mainnet signatures live in `fixtures/`, spanning Anchor constraints, Anchor account errors, custom errors, panics, compute exhaustion, native-program errors, and named runtime errors from non-native programs. Every phase is measured against this corpus, and regressions in it block shipping.

Layout:

- `fixtures/transactions/<signature>.json` — the raw `getTransaction` response, stored as wire JSON so it stays readable and diffable.
- `fixtures/manifest.json` — hand-checked expectations per signature, plus a `distinctnessKey` the harvester uses to cap repeats. Without that cap a harvest fills with whichever error the busiest program is currently throwing, testing one code path many times over. Each entry also carries a `phase1` block — expected confidence, originating program, handler, error name and number, throw site, offending account — written by reading `meta.logMessages`, never by recording what the analyzer produced. An expectation generated from the code under test asserts nothing. A freshly harvested entry has no `phase1` block, which is the signal that it still needs checking.
- `fixtures/programs/<programId>.json` — the on-chain state source resolution reads, recorded with the `context.slot` of the read. That slot is what keeps the corpus honest: "upgraded between the failing slot and the snapshot slot" is a fact about two fixed numbers, while a live check would silently change its answer as mainnet moves on. The ProgramData **body** is deliberately not recorded — 10MB of mostly zero padding per program is not a fixture — so the hash and trimmed length are stored as facts and the hashing path is covered synthetically instead. `fixtures/programs/manifest.json` holds the hand-checked expectations, and `fixtures/programs/synthetic/` the degrade paths a recent harvest cannot produce.
- `fixtures/synthetic/` — hand-written edge cases a block scan will not produce: truncated logs, absent logs, missing `loadedAddresses`, null `stackHeight`, an unknown `meta.err` variant, a transaction-level failure, a 4KB stack-frame overrun, and a pinned native program returning its own `Custom` code. Kept separate so re-running the harvester cannot clobber them.

Practical implications:

- Cache RPC responses for fixtures so the suite runs offline and deterministically; live RPC in tests makes the corpus unreliable and expensive.
- `reviveRawTransaction` must reproduce exactly what `@solana/kit` produces, bigints included. A fixture revived into a shape production never sees is a green test over a broken parser — which is precisely how the `meta.err` bigint bug survived the first suite and only surfaced against a live endpoint.
- Phase 3 has explicit metrics to maintain: how often the correct throw site is uniquely identified, and how often it lands in the top 3.
- Phase 5 must cross-check replay results against Phase 3 inference on the corpus — disagreement means one of them is broken.

## Domain gotchas that shape the code

These are constraints of the Solana platform, not implementation choices, and each one has bitten the design already:

- `getTransaction` **must** be called with `maxSupportedTransactionVersion: 0`; omitting it errors on every v0 transaction.
- **`@solana/kit` upcasts the integers inside `meta.err` to `bigint`** while leaving structural indices (`programIdIndex`, instruction `accounts`, `innerInstructions[].index`, `stackHeight`, message header counts) as `number`. A `typeof x === 'number'` check on the error index or a `Custom` code silently reports every real failure as unrecognized. `slot`, `blockTime`, `fee`, and `computeUnitsConsumed` are bigints too, and JSON has no bigint — they cross the wire as strings.
- **Truncated logs are detected by the literal `Log truncated` line** the runtime appends, not by measuring 10KB. The cap applies to what the runtime counted, not to what survived into the response.
- **Rust's 1.73+ panic format puts the message after a newline _inside a single log entry_**, not on the next array element: `"Program log: panicked at program/src/reset.rs:25:39:\nattempt to add with overflow"`. Both formats appear in the corpus. A line-oriented tokenizer loses half of every modern panic.
- **`meta.err` names the failing top-level instruction; the logs name the program that actually failed.** For a CPI these are different, and the outer program is usually one that merely propagated the error. Report the innermost.
- **Anchor logs the error name, number, and `#[msg]` text in the same line as the error**, in all three of its forms (`thrown in <file>:<line>`, `caused by account: <field>`, and bare `occurred`). It also logs the handler name on entry. None of this needs an IDL — but a program can be Anchor and log none of it, so the absence of these lines is not evidence the program is not Anchor.
- **The `Left:` / `Right:` operands come in two shapes.** Integers print inline (`Left: 412250202354`); pubkeys print the label alone with the value on the following line. Handle both or lose every key comparison.
- **Loader account layouts**, all confirmed against mainnet: a program account is 36 bytes, `[2,0,0,0]` then a 32-byte ProgramData address. ProgramData is `[3,0,0,0]`, a u64 LE `last_deploy_slot`, a 1-byte `Option` tag and 32-byte authority — ELF from byte 45.
- **The verified-build hash is `sha256(programData[45..])` with trailing zeros trimmed.** The trim is not optional: a ProgramData account is allocated with room for a larger future upgrade, so Whirlpool's is 10,485,760 bytes of which 1,537,769 are program. Hashing the untrimmed buffer matches nothing. Verified to reproduce the registry's `on_chain_hash` exactly.
- **Anchor publishes its IDL at `createWithSeed(findProgramAddress([], programId), "anchor:idl", programId)`**, zlib-compressed behind an 8-byte discriminator, a 32-byte authority, and a u32 LE length. The account is allocated larger than the declared length, so inflate exactly that many bytes.
- **Two Anchor IDL layouts are live in roughly equal numbers.** Pre-0.30 has a top-level `name`, camelCase instruction names, and **no discriminators** — those must be derived as `sha256("global:" + snake_case(name))[0..8]`. From 0.30 the document has `metadata.spec`, snake_case names, and explicit discriminator arrays, which are read rather than recomputed.
- **A verified-build registry returns conflicting entries for one program.** `status-all` for Whirlpool includes an unverified entry for the same repository whose `executable_hash` differs from what is deployed. Require `is_verified` *and* `executable_hash === on_chain_hash`, then recompute the hash locally rather than believing the reported one.
- **`meta.loadedAddresses` usually makes address-lookup-table resolution free** — the RPC returns the resolved writable and readonly addresses, so no separate table fetch is needed. When it is absent, do not fetch the table: its contents may have changed since the failing slot. Degrade and say so.
- A `null` response is ambiguous — "never landed" and "outside the retention window" are different outcomes and must be distinguished, not merged.
- Only landed transactions are retrievable. Preflight rejections, dropped transactions, and expired blockhashes were never recorded.
- Solana caps transaction logs at 10KB. The tail is lost, which is exactly where a panic message usually is. Truncation must be detected and reported as reduced confidence.
- Public RPC keeps roughly two days; older signatures need an archive endpoint.
- `getTransaction` records pre-_balances_, not pre-_data_. Transaction inputs cannot be reconstructed from the transaction alone — this is the hard prerequisite gating Phase 5.
- Simulation is not replay. Preflight simulation runs against _current_ state and will not reproduce a state-dependent historical failure. Any simulation mode must warn prominently.
- v0 messages need `addressTableLookups` resolved into a flat `accountKeys` list before anything else can index accounts by position.

## Output philosophy

The line number is table stakes; the paragraph explaining what was wrong in the developer's mental model is the product. Phase 4 is the differentiator — showing the constraint expression from source next to the actual runtime values, recomputing expected PDAs from the source seeds to expose bump and seed-ordering mistakes, and explaining the usual causes per error category. When implementing output, favor an explanation the reader can act on over a terser location.
