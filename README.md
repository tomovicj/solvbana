# Solvbana

**Point it at a failed Solana transaction. It tells you which line of your program failed, and why.**

> **Status: early development.** The architecture is settled; implementation is in progress. Phases 0, 1, 2 and 4 are done: a signature resolves to a typed structure naming the failing instruction, its logs are read for everything they disclose, the failing program is resolved — proving whether the deployed binary is the one that ran, reading its IDL, and checking its hash against a verified-build registry — and the failure is then explained from the transaction record and that IDL. You can also **upload your own IDL and compiled binary** for programs that publish neither. Against the 47-signature test corpus that lands 7 `exact`, 34 `variant-only`, and 6 `unknown`; against a sample of live mainnet failures the great majority land at `unknown`, and `pnpm coverage` reports that honestly — every one of them now blocked on the failing program publishing no IDL, rather than on anything the tool failed to read. **Source fetching and throw-site indexing are deferred** — only 3 of the corpus's 24 live programs have a verified build, so there is almost no source to index — and source rendering in the example below is not implemented. See [ROADMAP.md](./ROADMAP.md) for what exists and what doesn't.

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
| 1 | Log parsing | Free | Anchor constraint errors already name the account, the variant, and the `#[msg]` text; panics already carry `file:line:col`; Anchor programs already log which handler ran |
| 2 | IDL + discriminator | A few RPC calls | Error variant name and `#[msg]` text for programs that log neither; which handler ran; and the repository and commit that built the binary, proven live at the failing slot |
| 3 | Static analysis | Source fetch | Every throw site indexed, filtered by reachability from the failing handler, bounded by observed CPIs and `msg!` breadcrumbs |
| 4 | Replay | Archive state + rbpf | Exact program counter, DWARF-symbolized, with an intra-program call stack |

Most real failures resolve at tier 1 or 2. Tier 4 exists for the ones that don't.

## Confidence, and why every answer has one

Every result carries an explicit confidence level:

- **`exact`** — the location is read, not inferred: a panic message or an Anchor `thrown in <file>:<line>` that the program printed about itself. `exact` always comes with at least one location; it never means "we're sure but can't say where".
- **`narrowed`** — inference reduced the candidates to a specific set. All surviving candidates are shown, ranked. Never just the top one.
- **`variant-only`** — the error is identified but not located. This covers more than it sounds like: an Anchor error attributed to a specific account, with its name, its `#[msg]` text, and the two operands that failed the comparison — including, where the record proves which side is which, the address the program required and did not get — is `variant-only`, because none of that is a line number.
- **`unknown`** — logs were truncated, state is unavailable, or the failure is opaque. Says so plainly.

A debugger that is confidently wrong once is a debugger you stop trusting. The tool would rather return three candidates than one guess.

It also declines guesses that would be easy to make. Anchor reserves error codes 2000–2999 for constraints, so a bare `Custom(2012)` looks a lot like `ConstraintAddress` — but that range is one framework's convention, and any program may return any code for any reason. The tool will name it once it has fetched an IDL from the program's Anchor-derived address, because only an Anchor program publishes one there and that is real evidence. Until then it reports the number and says why it will not name it.

## When your program publishes nothing

Most programs don't. Sampling live mainnet failures, **62% are a bare `Custom(n)` from a program with no on-chain IDL** — no name, no `#[msg]` text, nothing but a number. No amount of inference fixes that: the program simply never said what its codes mean.

You can say it instead. Point the server at a directory and upload what `anchor build` already produced:

```
SOLVBANA_ARTIFACT_DIR=./artifacts pnpm dev

curl -X POST localhost:3000/artifacts -H 'content-type: application/json' \
  -d "{\"idl\": $(cat target/idl/my_program.json)}"
```

After that, every diagnosis of that program names its error codes. Uploading the compiled `.so` as well answers a different question immediately — whether the build in front of you is the one actually deployed:

```json
{ "binary": { "hash": "38c6d0f7…", "deployed": { "kind": "match" } } }
```

An uploaded IDL is held to a lower trust than one read from chain, and the output says which you got:

- It has to **prove it describes the program that ran**, by declaring the discriminator the failing instruction actually used. A document that doesn't match is refused and says so — it's for a different program, or a different version of one.
- It **never unlocks Anchor's built-in error table**. That shortcut is licensed by an IDL existing at the program's Anchor-derived address, which only an Anchor program can publish; a file you sent proves nothing of the kind.
- Names that come from it are reported as `supplied-idl`, never `idl`, because you should be able to tell your own claim from something read off chain.

## Correctness guarantees

**Slot-accurate binaries.** Programs get upgraded. `Solvbana` reads the deployment slot out of the program's ProgramData account and compares it against the failing transaction's: if the current deployment predates the failure, it provably *is* the binary that ran. If the program was redeployed since, the bytes that ran are gone — a standard RPC serves only current state — so the tool says so and resolves nothing further. It never falls back to the current deployment silently.

**Verified source only.** Source *mapping* requires a verified build. The on-chain binary is hashed and checked against the registry entry before any line number is derived from it. Unverified programs get error names and messages, never mapped line numbers. A location the program printed about itself — a panic message, an Anchor throw site — is exempt, because nothing was mapped: the running program said where it was.

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
