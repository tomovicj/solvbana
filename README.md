# Solvbana

**Point it at a failed Solana transaction. It tells you which line of your program failed, and why.**

> **Status: early development.** Solvbana is an HTTP service: JSON in, JSON out. Phases 0–4 are done: a signature resolves to a typed structure naming the failing instruction, its logs are read for everything they disclose, the failing program is resolved — proving whether the deployed binary is the one that ran, reading its IDL, and checking its hash against a verified-build registry — and the failure is then explained from the transaction record and that IDL. Legacy, version 0 and version 1 transactions are read. You can also **upload your own IDL, compiled binary and Rust source** for programs that publish none of them. The source is searched for the lines that raise the error that fired, or for the `#[account(...)]` declaration Anchor blamed. When the deployed binary is confirmed as the one that ran, that produces a `narrowed` answer with candidate line numbers. Every route except `GET /health` needs an API key.
>
> Against the 51-signature test corpus the engine lands 7 `exact`, 34 `variant-only` and 10 `unknown`, and no `narrowed`, because no corpus fixture has an uploaded source tree. Six of the ten `unknown` are programs that publish no IDL or have had their ProgramData closed. The other four are version 1 failures from programs with no IDL. In one `pnpm coverage` run on 2026-11-10 (200 failures across 25 blocks), 83.0% landed at `unknown`, 8.5% at `variant-only` and 8.5% at `exact`. All 166 unnamed failures were blocked on the failing program publishing no IDL, and none on fetching or on transaction version. That split is one run's traffic, not a trend. The corpus statistics in the sections below were measured over the 47 fixtures that predate the version 1 additions. **Fetching source at a verified commit is still deferred**, because only 3 of the corpus's 24 live programs have a verified build (measured over those same 47 fixtures). Line numbers therefore come from source you upload, not source the tool fetches. Replay (Phase 5) is not started. See [ROADMAP.md](./ROADMAP.md) for what exists and what doesn't.

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
curl -X POST localhost:3000/diagnose -H 'content-type: application/json' -H "Authorization: Bearer $SOLVBANA_KEY" \
  -d '{"signature": "5GV9BFLXPfp5fCbBHyQRACjtMLPwoG663CMSaV4YxY58ZmBdhvWZv7LDzLFGLzzxnHeR3PDyeKDSK4WHrsnJN8Vy"}'
```

That is a real mainnet failure: a PumpSwap `buy` rejected with `ConstraintSeeds`. Below is an excerpt of what the engine returns once the accounts struct has been uploaded as source, against the program's recorded state at the failing slot. The transaction record, account table, decoded arguments, per-frame compute and balance deltas are omitted:

```jsonc
{
  "confidence": "narrowed",
  "summary": "Instruction 2 of 2 failed in pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA (handler Buy) with ConstraintSeeds (2006).",
  "candidates": [{
    "location": { "file": "src/instructions/buy.rs", "line": 7 },
    "rank": 1,
    "rationale": "Anchor raised ConstraintSeeds against the coin_creator_vault_authority field of BuyAccounts, read from the handler's Context<> parameter rather than from its name. … The source was supplied rather than built from the deployed binary, so this locates a candidate and does not prove the line that ran."
  }],
  "explanation": {
    "declaration": {
      "struct": "BuyAccounts",
      "field": "coin_creator_vault_authority",
      "constraint": "seeds = [b\"creator_vault\", pool.coin_creator.as_ref()]"
    },
    "comparison": {
      "left": "8N3GDaZ2iwN65oxVatKTLPNooAVUJTbfiVJ1ahyqwjSk",
      "right": "GMc58fp264TR3fB7JnS9jVYy4fqJQx3N9Hx4UWw9zspD",
      "passed": "left"   // proved: `left` is the address the account actually holds
    },
    "derivations": [{
      "account": "coin_creator_vault_authority",
      "status": "unresolved",
      "blockedBy": "pool.coin_creator, which reads a field out of another account's data — that is only available as current state, which is not what ran"
    }],
    "guidance": {
      "meaning": "The account passed for this field is not the PDA the seeds in its #[account(seeds = ...)] attribute derive. … The program required GMc58fp…, and the instruction passed 8N3GDaZ2…"
    }
  }
}
```

The answer has four parts: the declaration that failed, the address the program wanted, the one the client sent, and a proof of which is which. It also says what it could not do. It will not recompute the seeds, because one of them reads another account's state, and that state may have changed since the failing slot.

The example was measured against the state recorded in the fixture corpus, plus an uploaded accounts struct. It is not reproducible against live mainnet today. PumpSwap was redeployed at slot 458921517, after the transaction's slot of 441026236. A live diagnosis therefore reports deployment `upgraded-since` and resolves no IDL, so `comparison.passed` stays null. With the accounts struct uploaded, the answer is `variant-only`, with no candidate and no declaration. The reason says that source was uploaded, that the program was redeployed after the transaction ran, and that no line from the tree is reported, because a line number from the wrong revision is worse than none. The `narrowed` in the excerpt reflects the corpus's recorded state, where the deployment is slot-accurate. This is the slot-accuracy rule working as designed: the binary that ran is no longer served, so an uploaded tree is not used against a binary it cannot be tied to.

The line number is table stakes. The explanation is the point. Formatting it for humans is left to whatever consumes the JSON.

## How it works

Four independent signals, applied in order of cost:

| Tier | Signal | Cost | Gives you |
|---|---|---|---|
| 1 | Log parsing | Free | Anchor constraint errors already name the account, the variant, and the `#[msg]` text; panics already carry `file:line:col`; Anchor programs already log which handler ran |
| 2 | IDL + discriminator | A few RPC calls | Error variant name and `#[msg]` text for programs that log neither; which handler ran; and the repository and commit that built the binary, proven live at the failing slot |
| 3 | Static analysis | Uploaded source | The lines that raise the error that fired, ranked by whether they sit in the failing handler; for Anchor's generated constraint errors, the `#[account(...)]` declaration it blamed. Reachability, CPI and `msg!`-breadcrumb bounding are planned but not built |
| 4 | Replay | Archive state + rbpf | Exact program counter, DWARF-symbolized, with an intra-program call stack |

Most real failures resolve at tier 1 or 2. Tier 4 exists for the ones that don't.

## Confidence, and why every answer has one

Every result carries an explicit confidence level:

- **`exact`** — the location is read, not inferred: a panic message or an Anchor `thrown in <file>:<line>` that the program printed about itself. `exact` always comes with at least one location; it never means "we're sure but can't say where".
- **`narrowed`** — inference reduced the candidates to a specific set. All surviving candidates are shown, ranked. Never just the top one.
- **`variant-only`** — the error is identified but not located. This covers more than it sounds like: an Anchor error attributed to a specific account, with its name, its `#[msg]` text, and the two operands that failed the comparison — including, where the record proves which side is which, the address the program required and did not get — is `variant-only` unless uploaded source locates it, because none of that is a line number.
- **`unknown`** — logs were truncated, state is unavailable, or the failure is opaque. Says so plainly.

A debugger that is confidently wrong once is a debugger you stop trusting. The tool would rather return three candidates than one guess.

It also declines guesses that would be easy to make. Anchor reserves error codes 2000–2999 for constraints, so a bare `Custom(2012)` looks a lot like `ConstraintAddress` — but that range is one framework's convention, and any program may return any code for any reason. The tool will name it once it has fetched an IDL from the program's Anchor-derived address, because only an Anchor program publishes one there and that is real evidence. Until then it reports the number and says why it will not name it.

## When your program publishes nothing

Most programs don't. In sampled live mainnet failures, **most are a bare `Custom(n)` from a program with no on-chain IDL**. There is no name, no `#[msg]` text, only a number. The 2026-11-10 `pnpm coverage` run put the share at 83.0% of 200 failures. The split moves a lot between runs, though: two earlier runs minutes apart read 72.5% and 85.5%. No amount of inference fixes this, because the program never said what its codes mean.

You can say it instead. Point the server at a directory and upload what `anchor build` already produced:

```
SOLVBANA_API_KEYS=alice:<sha256hex> SOLVBANA_ARTIFACT_DIR=./artifacts pnpm dev

curl -X POST localhost:3000/artifacts -H 'content-type: application/json' -H "Authorization: Bearer $SOLVBANA_KEY" \
  -d "{\"idl\": $(cat target/idl/my_program.json)}"
```

After that, every diagnosis of that program names its error codes. Uploading the compiled `.so` as well answers a different question immediately — whether the build in front of you is the one actually deployed:

```json
{ "binary": { "hash": "38c6d0f7…", "deployed": { "kind": "match" } } }
```

Uploading the program's Rust source, as a `source` map of relative path to file contents (`.rs` only), turns a named error into candidate line numbers when the deployed binary is confirmed as the one that ran:

```
curl -X POST localhost:3000/artifacts -H 'content-type: application/json' -H "Authorization: Bearer $SOLVBANA_KEY" \
  -d '{"programId": "<program>", "source": {"src/lib.rs": "…", "src/errors.rs": "…"}}'
```

Two checks apply before a line number is given. The first is the deployment. The tree is searched only when the deployed binary is provably the one that ran: live at or before the failing slot, or immutable. If the program was redeployed since, its ProgramData is closed, or the deployment could not be read, the tree is not used at all. The reason says what the check found, and no line from the tree is reported. A matching error code does not change that. Error enums are usually append-only, so agreement on one code says little about which revision ran. The second is the numbering proof. Anchor numbers `#[error_code]` variants sequentially from 6000, so the declaration order has to map the transaction's `Custom(n)` back to the same name the logs or IDL established. If it maps to a different name, the tree is a different revision and every candidate from it is refused. Anchor's own constraint errors (`ConstraintSeeds`, `AccountNotInitialized`, …) carry no such proof. They are located by the field name Anchor printed, and the rationale says so. Either way, source caps at `narrowed`. A tree somebody uploaded is not hash-proven against the deployed binary. A later source upload replaces the earlier tree rather than merging into it. Scanning is capped at 1,000,000 characters per file and 8,000,000 per tree, and a file or invocation past a cap is listed as not searched. It is never read as "not raised anywhere". A tree of 8 MB takes about 2 seconds to search. Candidates are capped at 50, best-ranked first, and the reason says how many sites matched when the cap cuts. An upload in which one path is a directory of another (`src/x.rs` and `src/x.rs/inner.rs`) is rejected with 400.

An uploaded IDL is held to a lower trust than one read from chain, and the output says which you got:

- It has to **prove it describes the program that ran**, by declaring the discriminator the failing instruction actually used. A document that doesn't match is refused and says so — it's for a different program, or a different version of one.
- It **never unlocks Anchor's built-in error table**. That shortcut is licensed by an IDL existing at the program's Anchor-derived address, which only an Anchor program can publish; a file you sent proves nothing of the kind.
- Names that come from it are reported as `supplied-idl`, never `idl`, because you should be able to tell your own claim from something read off chain.

Uploads belong to the API key that filed them. Each tenant's files sit apart from every other tenant's, a caller sees only its own uploads, and a diagnosis reads only the caller's files. `GET /artifacts` with your key lists the programs you have filed, whether an IDL is filed for each, and how many source files. The two proofs above do not make this unnecessary. They catch an honest mismatch, but discriminators and `#[error_code]` numbering are public, so neither stops someone who sets out to forge one. An upload must never reach another caller's diagnosis. Artifacts from the earlier un-tenanted layout are no longer read. When the server finds `idl` or `src` directly under the artifact directory, it logs a warning at startup. Those files must be uploaded again under a key.

## Correctness guarantees

**Slot-accurate binaries.** Programs get upgraded. `Solvbana` reads the deployment slot out of the program's ProgramData account and compares it against the failing transaction's: if the current deployment predates the failure, it provably *is* the binary that ran. If the program was redeployed since, the bytes that ran are gone — a standard RPC serves only current state — so the tool says so and resolves nothing further. It never falls back to the current deployment silently.

**Only verified source is reported as fact.** Source *mapping* requires a verified build. The on-chain binary is hashed and checked against the registry entry before any line number is derived from it. A location the program printed about itself, such as a panic message or an Anchor throw site, is exempt because nothing was mapped: the running program said where it was. Source you upload is the one other route to a line number. It is reported as a `narrowed` candidate, never `exact`, and only after the deployment check and the consistency check above both pass.

**Replay is checked against the ledger** (Phase 5, not yet built). A replayed transaction must reproduce the same `meta.err` and compute consumption as the recorded one. Divergence means the reconstructed state is wrong, and the tool fails loudly rather than reporting a plausible answer.

## Limitations

Worth knowing before you file an issue:

- **Transaction versions.** Legacy, version 0 and version 1 transactions are read. Version 1 was unreadable until 2026-11-10, because the engine requested version 0 only and the RPC rejected every v1 signature (error -32015). In a sample of 6 consecutive finalized blocks on 2026-11-10, 503 transactions were v1, 467 v0 and 488 legacy. Of 473 failed transactions, 202 were v1, 200 v0 and 71 legacy. That sample is why v1 mattered. The v1 layout was checked against 938 mainnet v1 transactions. Each v1 record is checked against it, and a record that breaks it degrades rather than naming accounts. A version the build does not read (2 or later) returns `unknown` with the summary "This transaction uses version N, which this build does not read." `pnpm coverage`, `pnpm harvest` and `pnpm record` request version 1 too. One remaining exposure: a version 2 transaction in a sampled block would fail that whole `getBlock` call in the scripts. The sample is six blocks, so treat these splits as a snapshot.
- **Only landed transactions.** A transaction rejected at preflight, dropped by the leader, or expired on a stale blockhash was never recorded and cannot be retrieved from a signature.
- **Log truncation.** Solana caps transaction logs at 10KB. Long-running transactions lose their tail, which is exactly where the panic message usually is. Reported as reduced confidence, not silently ignored.
- **Unverified programs.** Without a verified build or uploaded source, there is no line number. Only a location the program printed about itself is available. This is a hard limit, not a temporary one. Fetching source for verified builds is not implemented yet either, so today every mapped line comes from an upload.
- **RPC retention.** Public nodes keep roughly two days. Older transactions need an archive endpoint.
- **Replay needs historical account state.** `getTransaction` records pre-*balances*, not pre-*data*, so transaction inputs cannot be reconstructed from the transaction alone. Tier 4 requires an archive provider that serves historical account state.
- **Simulation is not replay.** Pre-flight simulation runs against *current* state and will not reproduce a state-dependent historical failure. The tool warns when you're doing this.
- **Source search is lexical.** Uploaded source is searched by its text, not by a Rust parser or a call graph. A malformed or unclosed invocation is not indexed, nested block comments are not handled, and a site outside the failing handler is reported unranked, because a lexical index cannot follow a helper call. An `#[error_code]` enum with a discriminant that is not a plain integer is refused, so its codes are not checked against the numbering proof.
- **The security review is not finished.** Three areas are still open: whether RPC error text can echo an endpoint URL into the reasons, a bound on the inflated size of an on-chain IDL, and prototype-pollution keys in uploaded JSON.

## Running it

The server does not start unless it has API keys or is told to run without them. Set `SOLVBANA_API_KEYS` to `tenant:sha256hex` pairs, where the hash is the SHA-256 of the secret. The server never holds the secret itself:

```
printf '%s' "$SECRET" | sha256sum | cut -d' ' -f1
```

```
SOLVBANA_API_KEYS=alice:<that hash> SOLVBANA_RATE_LIMIT_PER_MINUTE=60 pnpm dev
```

For a local run with no keys, set `SOLVBANA_ALLOW_UNAUTHENTICATED=true` instead. The server then runs as the single tenant `local`, logs a warning, and every caller shares that one tenant's uploads and rate limit. Setting both variables is a configuration error.

| Route | Key needed | What it does |
| --- | --- | --- |
| `GET /health` | No | Liveness. Not rate limited. |
| `POST /diagnose` | Yes | Diagnoses one signature. |
| `POST /artifacts` | Yes | Files an IDL, a binary or a source tree for one program, under your tenant. |
| `GET /artifacts` | Yes | Lists your own uploads: each program, whether an IDL is filed, and how many source files. |

| Variable | Default | What it does |
| --- | --- | --- |
| `SOLANA_RPC_URL` | none, required | Primary RPC endpoint. Must be an http(s) URL. |
| `SOLANA_ARCHIVE_RPC_URL` | unset | Archive endpoint, tried when the primary does not have a signature. |
| `SOLVBANA_API_KEYS` | unset | Comma-separated `tenant:sha256hex` pairs. A tenant name matches `^[a-z0-9][a-z0-9_-]{0,63}$`, and each tenant may appear once. |
| `SOLVBANA_ALLOW_UNAUTHENTICATED` | `false` | Runs with no keys, as the single tenant `local`. Only valid with no keys set. |
| `SOLVBANA_ARTIFACT_DIR` | unset | Directory for uploads. Unset disables the artifact store, and a diagnosis says so. |
| `SOLVBANA_VERIFY_REGISTRY_URL` | `https://verify.osec.io` | Verified-build registry. Set it to an empty string to turn the lookup off. |
| `SOLVBANA_RATE_LIMIT_PER_MINUTE` | `60` | Requests per tenant per minute. Requests that fail authentication are counted per client IP. |
| `SOLVBANA_TRUST_PROXY` | `false` | Reads the client IP from `X-Forwarded-For`. Enable only behind a proxy that overwrites that header. Otherwise every client can pick its own rate-limit bucket. |
| `SOLVBANA_MAX_BODY_BYTES` | `33554432` (32 MiB) | Largest request body accepted. |
| `HOST` | `127.0.0.1` | Address the server listens on. |
| `PORT` | `3000` | Port the server listens on. |
| `LOG_LEVEL` | `info` | Log level. |
| `NODE_ENV` | `development` | In development, logs are pretty-printed. It does not change authentication. |

## Making your programs debuggable

Diagnosis quality is substantially decided at build time:

- Define errors with `#[error_code]` and real `#[msg]` strings. `Custom(0)` costs hours; "Vault is already at capacity" costs seconds.
- Prefer `require_eq!` / `require_keys_eq!` over bare `require!` — they log both operands.
- Set `overflow-checks = true` in the release profile so arithmetic bugs panic with a line number instead of wrapping silently.
- Log sparingly in hot paths. Every `msg!` burns compute and pushes the important lines closer to the truncation boundary.
- Publish your IDL on chain (`anchor idl init`). Without it, nobody else's tooling can name your error codes.
- Publish a verified build. Without one, nobody but you can be given a line number for your program, and you only get one by uploading your own source.

## Roadmap

See [ROADMAP.md](./ROADMAP.md). Phases ship independently; each is useful on its own.

## Contributing

The most valuable contribution right now is **failing signatures**. The fixture corpus is the spec — every phase is measured against it, and regressions block shipping. If you have a mainnet failure that's poorly diagnosed, open an issue with the signature and what actually went wrong.
