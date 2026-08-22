# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Current state

**Phases 0 (ingest), 1 (log analysis), 2 (source resolution) and 4 (explanation) are done.** `POST /diagnose` fetches a real transaction, normalizes it into a typed `FailedTransaction`, reads its logs for everything they disclose on their own, resolves the failing program — proving whether the deployed binary is the one that ran, fetching its IDL, and checking its hash against a verified-build registry — and then explains the failure from the transaction record and that IDL.

Against the 45-signature corpus that lands **7 `exact`, 32 `variant-only`, 6 `unknown`**. The `exact` answers are panics and `AnchorError thrown in <file>:<line>`, both locations the program printed about itself. The six remaining `unknown` are programs that publish no on-chain IDL, or whose ProgramData has been closed — undecoded by design rather than by omission.

Developers can also **upload their own artifacts** for the programs that publish nothing — `POST /artifacts` takes an Anchor IDL and a compiled `.so`, and the IDL is read during diagnosis. `pnpm coverage` over 200 live mainnet failures puts the tool at 77.5% `unknown`, of which **62% is programs publishing no IDL at all**. That is the gap uploads close, and it is not one inference could.

**Phase 3's source half is deferred, and the reason is a measurement rather than a preference.** Its premise is fetching source at the verified commit Phase 2 resolves, and only 3 of the 24 live corpus programs have a verified build whose hash matches what is deployed. That is 4 of 45 transactions, none of which the phase would answer. Do not start it without first harvesting fixtures that can score it — the corpus contains no `ConstraintSeeds` or `ConstraintHasOne` failure at all. The realistic unlock is a local source path, not the registry.

The contract every later tier has to keep: always answer, never throw for an undiagnosable input, and always say what the answer is worth and why.

### Reading a failure: `packages/core/src/analyze/`

Pure and I/O-free, like `ingest/`. `analyze(transaction)` runs detectors cheapest-and-most-specific first and stops at the first that answers, because the categories overlap in `meta.err` — a panic, a compute exhaustion, and a stack overrun all surface as `ProgramFailedToComplete`, and only the logs tell them apart.

### Resolving the program: `packages/core/src/resolve/`

Async and I/O-bound, unlike `analyze/`, and reached through a second port — `AccountSource` beside `TransactionSource`. `diagnose()` runs the free log analysis first, then resolves whenever an account source is available.

Phase 2 skipped resolution for an already-named error, because the only thing it produced was a name. Phase 4 changed that calculus: the IDL supplies account names, argument types and declared PDA seeds, all worth having even when the error named itself. The cost is three prefix reads, cached per program and deployment, with the expensive verified-build path still opt-in behind `verifySource`.

Resolution stays strictly additive either way — an error the program printed about itself is never re-decided by an IDL that may be a deployment behind.

The cascade halts at the deployment check. If the binary on chain is not the binary that ran, no amount of IDL or registry work produces a statement about the right code, so nothing downstream runs.

**Resolution is an enrichment, never a prerequisite.** `deps.accounts` is optional, and a resolution that throws is caught and appended to `reasons` — the log-derived answer must survive an RPC failure that happens after it was already established.

**`frames.ts` is load-bearing and easy to get wrong.** It rebuilds the CPI frame stack from the `invoke` / `success` / `failed` bracket sequence, and every other detector reads a *single frame's own lines*. Corpus signature `2WH1WJ5N…` is the reason: the failing program logs `Instruction: BuyExactQuoteIn`, then calls a fee program that logs `Instruction: GetFees` and returns successfully, and only afterwards throws. Anything that scans "the last `Instruction:` line before the failure" reports `GetFees` — a handler in a program that did not fail. `failingFrame` orders by `closedAt`, not by depth or invoke order, because a CPI failure logs the innermost `failed:` line first and each caller's on the way out.

### Explaining the failure: `packages/core/src/explain/`

Async but **I/O-free** — address derivation goes through subtle crypto, which is promise-returning. That is a different thing from `resolve/`'s network I/O, and the distinction is load-bearing: **this tier never fetches an account.** A failed transaction rolls back, so an account the instruction found missing may well exist now, and `getAccountInfo` serves current state only. Everything reported was recorded at the failing slot.

**Phase 4 never changes `confidence` or `candidates`.** It explains what earlier tiers established and locates nothing new. `explain/corpus.test.ts` asserts it by diagnosing each fixture with and without the explanation and requiring both to agree.

Three rules that are easy to get wrong, each of which produced a real bug while building this:

- **Positional account naming has two distinct hazards.** A transaction passing *more* accounts than the IDL declares is harmless — those are Anchor's `remaining_accounts` and the declared ones keep their positions. An *optional* account is not: omitting one shifts everything after it, and the record does not say which were supplied, so naming stops at the first optional. Passing *fewer* than declared means the published IDL and the deployed binary disagree, and nothing is named. `nameableCount` is the whole rule.
- **`pda.program` decides what the address derives under.** 155 of the corpus's 571 seeded accounts declare one — an associated token account derives under the Associated Token program, not under the program declaring it. Ignoring the field produced 19 spurious "this PDA is wrong" mismatches against accounts that were perfectly correct.
- **A seed reading another account's data is refused, not fetched.** A dotted path such as `pool.base_mint` needs current state; the check reports `unresolved` and names the component. This is the same reasoning that stops `AccountKeys` from reading a lookup table.

The associated-token check **proves rather than infers**: every candidate triple is drawn from the transaction's own accounts and mints, so a hit means the derivation reproduced the address exactly and no naming convention was consulted. The bounded negative is reported too, with the search space stated — an address that is not the associated token account of anything the instruction passed is an address the client derived wrongly, and that is the more useful of the two outcomes.

### Uploaded artifacts: `packages/core/src/resolve/local.ts` and `packages/server/src/artifacts/`

Roughly 94% of the programs that fail on mainnet publish neither an on-chain IDL nor a verified build, so for those an uploaded IDL is the only route to an error name. `ArtifactStore` is a third port beside `TransactionSource` and `AccountSource`, and is deliberately the narrowest: **read-only** (ingesting an upload is transport's job) and **IDL-only** (the binary's question is about current state and is settled once, at upload).

Four rules keep an uploaded file from becoming a confidently wrong answer. They are the whole point of this tier:

1. **A supplied IDL is not evidence the program is Anchor.** The licence for Anchor's built-in error table is that only an Anchor program publishes at the Anchor-derived address — a fact about chain state. Anyone can write JSON. `ResolvedIdl` carries `provenance`, and `anchorBuiltinFor` refuses anything supplied. Carried *on the IDL* so it cannot be dropped at a call site.
2. **A supplied IDL must prove it describes the program that ran**, by declaring the discriminator the failing instruction used. An 8-byte match is not a coincidence; its absence means a different program or a different version. An empty observation proves nothing and also refuses.
3. **Names from an upload are `supplied-idl`, never `idl`.** The asymmetry with handler names is deliberate: a handler name arrives with its discriminator proof, an error name is only the document's claim.
4. **An on-chain IDL always wins, and the deployment check still gates everything.** An upload does not reopen a question the slot check closed.

**The resolution cache needed a second invalidation rule.** Its key is built from chain state, which is immutable by construction — a redeploy moves the deployment slot. An artifact store is not: it gains an IDL between two diagnoses with nothing in the key to show it. `forgetProgram(programId)` exists for that and the upload route calls it. Found against a live endpoint, where the first diagnosis after an upload kept answering from before it.

**Hash both sides through `elfHash`.** A ProgramData account carries a 45-byte loader header and megabytes of zero padding; a locally built `.so` carries neither. Trimming one and not the other makes two copies of one program hash differently.

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
| `pnpm snapshot` | Record the program, ProgramData header and IDL accounts every corpus program resolves through. **Refuses** to overwrite a snapshot whose deployment slot has moved, and exits non-zero when it does — `--force` to replace one deliberately. Unchanged snapshots are left alone rather than rewritten. Manual only, never CI |
| `pnpm coverage` | Diagnose live mainnet failures and report the confidence distribution and what blocked each unnamed one. Manual only, never CI |

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

4. An **uploaded IDL declared the code, and proved itself** by carrying the discriminator the failing instruction used. Strictly weaker than the third: it names codes the document itself declares and nothing more. It never licenses Anchor's built-in table, because a file somebody sent is not a fact about chain state, and its names are labelled `supplied-idl` so the difference survives into the output.

**Replay must be validated against the ledger.** A replayed transaction has to reproduce the recorded `meta.err` and compute consumption. Divergence means the reconstructed state is wrong — fail loudly rather than reporting the result.

**Degrade in tiers, never fail blank.** Unverified program → error message without a line. No IDL → raw code with a decoded category. No logs → error kind and instruction index. There must be something useful at every level of missing information.

## The fixture corpus is the spec

45 real failing mainnet signatures live in `fixtures/`, spanning Anchor constraints, Anchor account errors, custom errors, panics, compute exhaustion, native-program errors, and named runtime errors from non-native programs. Every phase is measured against this corpus, and regressions in it block shipping.

Layout:

- `fixtures/transactions/<signature>.json` — the raw `getTransaction` response, stored as wire JSON so it stays readable and diffable.
- `fixtures/manifest.json` — hand-checked expectations per signature, plus a `distinctnessKey` the harvester uses to cap repeats. Without that cap a harvest fills with whichever error the busiest program is currently throwing, testing one code path many times over. Each entry also carries a `phase1` block — expected confidence, originating program, handler, error name and number, throw site, offending account — written by reading `meta.logMessages`, never by recording what the analyzer produced. An expectation generated from the code under test asserts nothing. A freshly harvested entry has no `phase1` block, which is the signal that it still needs checking. Seven entries also carry a `phase4` block pinning what the explanation establishes about them — the two proven associated-token derivations, the two that derive to nothing, and the three where an IDL/binary disagreement means no account may be named.
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
- **A published IDL can lag the deployed binary.** It is written by the program authority and is *not* updated on upgrade. Oridion logs handler `Reclaim`, which its published IDL does not declare at all, and Whirlpool's `increase_liquidity_v2` declares 16 accounts where the transaction passed 15 with no optional among them. Anything IDL-derived is a statement about what was published, not about what ran, which is a further reason the explanation tier must not touch confidence.
- **`meta.preTokenBalances` carries `mint`, `owner`, `programId` and `decimals` at the failing slot**, which is what makes token accounts explainable without a current-state read. `owner` and `programId` are optional in the response and must not be inferred when absent.
- **The token program is a seed of the associated token address.** Derivation is `[owner, tokenProgram, mint]` under `ATokenGPv…`, and assuming the classic Token program for a Token-2022 mint produces a valid-looking address for an account that never existed. Both programs are live in the corpus; read it from the record.
- **An account holding zero lamports has been deallocated**, so a zero `preBalances` entry is direct evidence the account did not exist — not an inference. This is the whole answer to `AccountNotInitialized`, and it comes free from the record.
- **`meta.preBalances` covers every account the transaction loaded**, including lookup-table ones, so it is routinely longer than the statically declared keys — 19 balances against 11 keys in one corpus fixture. Indices beyond `accounts.keys.length` are unresolved, not absent.
- **Anchor seeds are not borsh.** The seed expression in source writes the conversion explicitly: `to_le_bytes()` for an integer, `as_bytes()` for a string, `as_ref()` for a pubkey. A `String` seed therefore carries no u32 length prefix, while its borsh encoding does.
- `getTransaction` records pre-_balances_, not pre-_data_. Transaction inputs cannot be reconstructed from the transaction alone — this is the hard prerequisite gating Phase 5.
- Simulation is not replay. Preflight simulation runs against _current_ state and will not reproduce a state-dependent historical failure. Any simulation mode must warn prominently.
- v0 messages need `addressTableLookups` resolved into a flat `accountKeys` list before anything else can index accounts by position.

## Output philosophy

The line number is table stakes; the paragraph explaining what was wrong in the developer's mental model is the product. Phase 4 is the differentiator — showing the constraint expression from source next to the actual runtime values, recomputing expected PDAs from the source seeds to expose bump and seed-ordering mistakes, and explaining the usual causes per error category. When implementing output, favor an explanation the reader can act on over a terser location.
