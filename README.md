# Solvbana

**Point it at a failed Solana transaction. It tells you which line of your program failed, and why.**

> **Status: early development.** The architecture is settled; implementation is in progress. Phases 0–1 are the current focus. See [ROADMAP.md](./ROADMAP.md) for what exists and what doesn't.

---

## The problem

You get a signature and this:

```json
{"InstructionError": [1, {"Custom": 6001}]}
```

That tells you an error *variant* fired somewhere in a program. It doesn't tell you which `require!` raised it, what the values were, or what assumption in your head was wrong. Explorers show you the same log lines you already have. Finding the actual line is a manual grep through source you may not have, against a binary version you have to guess at.

`Solvbana` closes that gap.

## What it does

```
$ solvbana 5x8Kq...vN2p

Transaction failed at instruction 1 of 3
  Program: MyProg1111111111111111111111111111111111111 (verified · commit a3f9c21)
  Handler: withdraw  (discriminator b7 12 4f ...)

  Error: ConstraintSeeds (2006)
  Confidence: exact

  programs/my-prog/src/instructions/withdraw.rs:47

    45 │  #[account(
    46 │      mut,
    47 │      seeds = [b"vault", authority.key().as_ref()],
       │              ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^ seeds constraint failed
    48 │      bump
    49 │  )]
    50 │  pub vault: Account<'info, Vault>,

  Expected PDA:  8xY2... (derived from seeds above, bump 254)
  Actual passed: 3fKa...

  Recomputing with the seeds in your source produces 8xY2..., but the client
  passed 3fKa.... The client is deriving with a different seed set or a stale
  bump. Check that the client uses the same seed order and calls
  findProgramAddress rather than caching a bump.
```

The line number is table stakes. The paragraph underneath it is the point.

## How it works

Four independent signals, applied in order of cost:

| Tier | Signal | Cost | Gives you |
|---|---|---|---|
| 1 | Log parsing | Free | Anchor constraint errors already name the account; panics already carry `file:line:col` |
| 2 | IDL + discriminator | One RPC call | Error variant name and `#[msg]` text; which handler ran |
| 3 | Static analysis | Source fetch | Every throw site indexed, filtered by reachability from the failing handler, bounded by observed CPIs and `msg!` breadcrumbs |
| 4 | Replay | Archive state + rbpf | Exact program counter, DWARF-symbolized, with an intra-program call stack |

Most real failures resolve at tier 1 or 2. Tier 4 exists for the ones that don't.

## Confidence, and why every answer has one

Every result carries an explicit confidence level:

- **`exact`** — the location is read directly from a panic message or an Anchor account attribution. Not inferred.
- **`narrowed`** — inference reduced the candidates to a specific set. All surviving candidates are shown, ranked. Never just the top one.
- **`variant-only`** — the error is decoded but the source isn't available or isn't verified. You get the name and message, no line.
- **`unknown`** — logs were truncated, state is unavailable, or the failure is opaque. Says so plainly.

A debugger that is confidently wrong once is a debugger you stop trusting. The tool would rather return three candidates than one guess.

## Correctness guarantees

**Slot-accurate binaries.** Programs get upgraded. `Solvbana` resolves the binary that was live at the failing slot by walking `Upgrade` instructions on the ProgramData account and bisecting by slot. It never falls back to the current deployment silently — if the historical binary can't be resolved, confidence drops and the report says why.

**Verified source only.** Source mapping requires a verified build. The on-chain binary is hashed and checked against the registry entry before any line number is produced. Unverified programs get error names and messages, never line numbers.

**Replay is checked against the ledger.** A replayed transaction must reproduce the same `meta.err` and compute consumption as the recorded one. Divergence means the reconstructed state is wrong, and the tool fails loudly rather than reporting a plausible answer.

## Limitations

Worth knowing before you file an issue:

- **Only landed transactions.** A transaction rejected at preflight, dropped by the leader, or expired on a stale blockhash was never recorded and cannot be retrieved from a signature.
- **Log truncation.** Solana caps transaction logs at 10KB. Long-running transactions lose their tail, which is exactly where the panic message usually is. Reported as reduced confidence, not silently ignored.
- **Unverified programs.** No verified build means no source, means no line number. This is a hard limit, not a temporary one.
- **RPC retention.** Public nodes keep roughly two days. Older transactions need an archive endpoint.
- **Replay needs historical account state.** `getTransaction` records pre-*balances*, not pre-*data*, so transaction inputs cannot be reconstructed from the transaction alone. Tier 4 requires an archive provider that serves historical account state.
- **Simulation is not replay.** Pre-flight simulation runs against *current* state and will not reproduce a state-dependent historical failure. The tool warns when you're doing this.

## Making your programs debuggable

Diagnosis quality is substantially decided at build time:

- Define errors with `#[error_code]` and real `#[msg]` strings. `Custom(0)` costs hours; "Vault is already at capacity" costs seconds.
- Prefer `require_eq!` / `require_keys_eq!` over bare `require!` — they log both operands.
- Set `overflow-checks = true` in the release profile so arithmetic bugs panic with a line number instead of wrapping silently.
- Log sparingly in hot paths. Every `msg!` burns compute and pushes the important lines closer to the truncation boundary.
- Publish a verified build. Without one, no tool can give you a line number.

## Roadmap

See [ROADMAP.md](./ROADMAP.md). Phases ship independently; each is useful on its own.

## Contributing

The most valuable contribution right now is **failing signatures**. The fixture corpus is the spec — every phase is measured against it, and regressions block shipping. If you have a mainnet failure that's poorly diagnosed, open an issue with the signature and what actually went wrong.
