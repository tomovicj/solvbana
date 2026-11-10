import { accountKeysFrom, versionOneViolations } from './accounts.ts';
import { lamportBalancesFrom, tokenBalancesFrom } from './balances.ts';
import { parseTransactionError } from './error.ts';
import { instructionTreeFrom } from './instructions.ts';
import { parseLogs } from './logs.ts';
import type { FailedTransaction, RawTransaction, TransactionConfig } from './types.ts';

/** `null` when the record carries no config; each unstated field stays `null` too. */
function transactionConfigFrom(raw: RawTransaction): TransactionConfig | null {
  const config = raw.transaction.message.transactionConfig;
  if (config === undefined || config === null) return null;

  return {
    priorityFee: config.priorityFee ?? null,
    computeUnitLimit: config.computeUnitLimit ?? null,
    loadedAccountsDataSizeLimit: config.loadedAccountsDataSizeLimit ?? null,
    heapSize: config.heapSize ?? null,
  };
}

/**
 * Turn a raw `getTransaction` response into the normalized shape every later
 * tier reads from.
 *
 * Pure: no network, no clock, no environment. That is what lets the fixture
 * corpus — which is the project's spec — run offline and deterministically.
 *
 * Nothing here throws on incomplete input. Missing metadata, absent logs, and
 * unresolvable lookup tables each degrade the result and append a line to
 * `degradations`, so a partial answer is always available and always explains
 * what is missing.
 */
export function normalizeTransaction(raw: RawTransaction, signature: string): FailedTransaction {
  const degradations: string[] = [];

  const accounts = accountKeysFrom(raw);
  const violations = versionOneViolations(raw);
  if (violations.length > 0) {
    degradations.push(
      'This version 1 transaction does not have the shape version 1 accounts were verified ' +
        `against: ${violations.join('; ')}. Only the ${String(accounts.keys.length)} statically ` +
        'declared keys are used. Loaded addresses are not relied on, so account indices at or ' +
        `beyond ${String(accounts.keys.length)} are unresolved rather than guessed, and lamport ` +
        'balances are dropped when their count does not match the declared keys, because they ' +
        'could not then be tied to an account by position.',
    );
  } else if (accounts.unresolvedLookups) {
    degradations.push(
      'This transaction loads accounts from address lookup tables, but the RPC did not return ' +
        '`meta.loadedAddresses`. The tables are mutable, so reading one now could resolve ' +
        'addresses against a version that did not exist at the failing slot. Account indices ' +
        `at or beyond ${String(accounts.keys.length)} are therefore unresolved rather than guessed.`,
    );
  }

  const tree = instructionTreeFrom(raw, accounts);
  degradations.push(...tree.degradations);

  const meta = raw.meta;
  if (meta === null) {
    degradations.push(
      'The RPC returned no `meta` for this transaction, so there is no error, no log stream, ' +
        'and no inner instructions to work from.',
    );
  }

  const logs = parseLogs(meta?.logMessages ?? null, tree.nodes);
  if (logs.absent) {
    degradations.push(
      'Log recording was not enabled for this transaction, so no log stream is available. Only ' +
        'the error kind and the failing instruction index can be established.',
    );
  }
  if (logs.truncated) {
    degradations.push(
      'Logs hit the 10KB cap and were truncated. The lost tail is where a panic message or a ' +
        'final constraint failure would appear, so the diagnosis may be missing its strongest ' +
        'evidence. Reducing `msg!` volume in hot paths keeps this from recurring.',
    );
  }

  return {
    signature,
    slot: raw.slot,
    blockTime: raw.blockTime,
    version: raw.version,
    transactionConfig: transactionConfigFrom(raw),
    fee: meta?.fee ?? 0n,
    computeUnitsConsumed: meta?.computeUnitsConsumed ?? null,
    accounts,
    error: parseTransactionError(meta?.err ?? null),
    instructions: tree.nodes,
    innerInstructionsRecorded: tree.innerInstructionsRecorded,
    lamports: lamportBalancesFrom(raw),
    tokenBalances: tokenBalancesFrom(raw),
    logs,
    degradations,
  };
}
