import type { InstructionNode, LogEvent, LogLine, LogStream } from './types.ts';

/**
 * The exact marker the runtime appends when a transaction's logs exceed the 10KB
 * cap. It stops writing at that point, so everything after it is lost — which is
 * usually where a panic message would have been.
 *
 * Detection is by this marker rather than by measuring the byte total: the cap
 * applies to what the runtime counted, not to what survived into the response.
 */
const TRUNCATION_MARKER = 'Log truncated';

const INVOKE = /^Program (\S+) invoke \[(\d+)\]$/;
const SUCCESS = /^Program (\S+) success$/;
const FAILED = /^Program (\S+) failed: (.+)$/;
const CONSUMED = /^Program (\S+) consumed (\d+) of (\d+) compute units$/;
const RETURN = /^Program return: (\S+) (.*)$/;
const DATA = /^Program data: (.*)$/;
const LOG = /^Program log: ([\s\S]*)$/;

/**
 * Classify a single log line.
 *
 * The raw line is always retained alongside the event by the caller. Phase 1
 * reads `AnchorError caused by account: ...` and `panicked at '<msg>',
 * <file>:<line>:<col>` straight out of these lines, so a tokenizer that
 * discarded the text would destroy the highest-value signal in the project.
 */
export function classifyLogLine(line: string): LogEvent {
  if (line === TRUNCATION_MARKER) return { kind: 'truncated' };

  const invoke = INVOKE.exec(line);
  if (invoke) {
    return { kind: 'invoke', programId: invoke[1]!, depth: Number(invoke[2]) };
  }

  const success = SUCCESS.exec(line);
  if (success) return { kind: 'success', programId: success[1]! };

  const failed = FAILED.exec(line);
  if (failed) return { kind: 'failed', programId: failed[1]!, reason: failed[2]! };

  const consumed = CONSUMED.exec(line);
  if (consumed) {
    return {
      kind: 'consumed',
      programId: consumed[1]!,
      units: Number(consumed[2]),
      budget: Number(consumed[3]),
    };
  }

  const returned = RETURN.exec(line);
  if (returned) return { kind: 'return', programId: returned[1]!, base64: returned[2]! };

  const data = DATA.exec(line);
  if (data) return { kind: 'data', base64: data[1]! };

  // Checked after the more specific `Program <id> ...` forms, since a program's
  // own `msg!` output can contain anything at all.
  const log = LOG.exec(line);
  if (log) return { kind: 'log', message: log[1]! };

  return { kind: 'unparsed' };
}

/**
 * Tokenize `meta.logMessages` and attribute each line to a top-level instruction.
 *
 * The `invoke` / `success` / `failed` lines form a stack that mirrors the
 * instruction tree, so tracking depth is enough to know which top-level
 * instruction was executing. The nesting is only used to decide when a top-level
 * instruction has ended; matching individual CPI frames to specific tree nodes is
 * Phase 3's job.
 *
 * Two cases produce `null` attribution rather than a guess:
 *
 * - lines emitted before any `invoke` (runtime-level messages);
 * - everything after a truncation marker, where the stack state is unknowable.
 */
export function parseLogs(
  messages: readonly string[] | null,
  outerInstructions: readonly InstructionNode[],
): LogStream {
  if (messages === null) {
    return { truncated: false, absent: true, lines: [] };
  }

  const lines: LogLine[] = [];
  let depth = 0;
  let outerIndex: number | null = null;
  let nextOuter = 0;
  let truncated = false;

  for (const [index, raw] of messages.entries()) {
    const event = classifyLogLine(raw);

    if (event.kind === 'truncated') {
      truncated = true;
      lines.push({ index, raw, event, outerIndex: null });
      // The tail is gone; anything after this point cannot be placed honestly.
      continue;
    }

    if (truncated) {
      lines.push({ index, raw, event, outerIndex: null });
      continue;
    }

    if (event.kind === 'invoke') {
      // A depth-1 invoke opens the next top-level instruction. The runtime emits
      // these in message order, so a counter is enough — and it stays correct
      // even when the reported program differs from the message's programIdIndex.
      if (depth === 0) {
        outerIndex = nextOuter < outerInstructions.length ? nextOuter : null;
        nextOuter += 1;
      }
      depth += 1;
      lines.push({ index, raw, event, outerIndex });
      continue;
    }

    lines.push({ index, raw, event, outerIndex });

    if (event.kind === 'success' || event.kind === 'failed') {
      depth = Math.max(0, depth - 1);
      if (depth === 0) outerIndex = null;
    }
  }

  return { truncated, absent: false, lines };
}

/** Every log line attributed to one top-level instruction, in emission order. */
export function linesForInstruction(logs: LogStream, outerIndex: number): LogLine[] {
  return logs.lines.filter((line) => line.outerIndex === outerIndex);
}
