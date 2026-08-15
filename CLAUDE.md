# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Current state

**Phase 0 (ingest & normalize) is done.** `POST /diagnose` fetches a real transaction and returns a typed `FailedTransaction`: the failing instruction, the parsed `meta.err`, the flattened account keys, the CPI-nested instruction tree, and the tokenized log stream. Confidence is still `unknown` for every answer — decoding `Custom(6001)` as a number is short of `variant-only`, which needs the IDL's variant name and `#[msg]` text from Phase 2. Phase 1 (exact answers without source) is next, and the Anchor and panic lines it needs are already sitting in `logs.lines[].raw`.

The contract every later tier has to keep: always answer, never throw for an undiagnosable input, and always say what the answer is worth and why.

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

**Slot accuracy is non-negotiable.** Programs get upgraded, so the binary must be the one live at the _failing slot_ — resolved by walking `Upgrade` instructions on the ProgramData account and bisecting by slot. Silently falling back to the current deployment is a bug, not a convenience. If the historical binary cannot be resolved, degrade confidence and state why in the output.

**Line numbers require a verified build.** Hash the resolved on-chain binary and confirm it matches the verified-build registry entry _before_ producing any source mapping. Unverified programs are capped at `variant-only`: names and messages, never lines.

**Replay must be validated against the ledger.** A replayed transaction has to reproduce the recorded `meta.err` and compute consumption. Divergence means the reconstructed state is wrong — fail loudly rather than reporting the result.

**Degrade in tiers, never fail blank.** Unverified program → error message without a line. No IDL → raw code with a decoded category. No logs → error kind and instruction index. There must be something useful at every level of missing information.

## The fixture corpus is the spec

45 real failing mainnet signatures live in `fixtures/`, spanning Anchor constraints, Anchor account errors, custom errors, panics, compute exhaustion, native-program errors, and named runtime errors from non-native programs. Every phase is measured against this corpus, and regressions in it block shipping.

Layout:

- `fixtures/transactions/<signature>.json` — the raw `getTransaction` response, stored as wire JSON so it stays readable and diffable.
- `fixtures/manifest.json` — hand-checked expectations per signature, plus a `distinctnessKey` the harvester uses to cap repeats. Without that cap a harvest fills with whichever error the busiest program is currently throwing, testing one code path many times over.
- `fixtures/synthetic/` — hand-written edge cases a block scan will not produce: truncated logs, absent logs, missing `loadedAddresses`, null `stackHeight`, an unknown `meta.err` variant, and a transaction-level failure. Kept separate so re-running the harvester cannot clobber them.

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
