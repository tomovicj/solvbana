import { describe, expect, it } from 'vitest';
import { classifyPanic, explainPanic, parsePanic } from '@solvbana/core';

describe('parsePanic', () => {
  it('reads the pre-1.73 format, where the message comes first', () => {
    const parsed = parsePanic(
      "panicked at 'index out of bounds: the len is 0 but the index is 0', src/state.rs:376:12",
    );

    expect(parsed).toEqual({
      site: { file: 'src/state.rs', line: 376, column: 12 },
      message: 'index out of bounds: the len is 0 but the index is 0',
      classification: 'index-out-of-bounds',
    });
  });

  it('reads the 1.73+ format, where the message follows a newline inside one log entry', () => {
    // The runtime does not split this across two `logMessages` entries; the
    // newline is embedded, which is why the tokenizer must not be line-oriented.
    const parsed = parsePanic(
      'panicked at program/src/reset.rs:25:39:\nattempt to add with overflow',
    );

    expect(parsed).toEqual({
      site: { file: 'program/src/reset.rs', line: 25, column: 39 },
      message: 'attempt to add with overflow',
      classification: 'arithmetic-overflow',
    });
  });

  it('ignores a line that merely mentions panicking', () => {
    expect(parsePanic('about to panic')).toBeNull();
    expect(parsePanic('panicked at somewhere')).toBeNull();
  });
});

describe('classifyPanic', () => {
  it.each([
    ['attempt to add with overflow', 'arithmetic-overflow'],
    ['attempt to subtract with overflow', 'arithmetic-overflow'],
    ['attempt to multiply with overflow', 'arithmetic-overflow'],
    ['attempt to divide by zero', 'divide-by-zero'],
    ['index out of bounds: the len is 3 but the index is 7', 'index-out-of-bounds'],
    ['range end index 40 out of range for slice of length 8', 'slice-out-of-range'],
    ['called `Option::unwrap()` on a `None` value', 'unwrap-none'],
    ['called `Result::unwrap()` on an `Err` value: Custom(1)', 'unwrap-err'],
    ['assertion failed: amount > 0', 'explicit-panic'],
    ['something nobody has seen before', 'unclassified'],
  ])('classifies %s', (message, expected) => {
    expect(classifyPanic(message)).toBe(expected);
  });
});

describe('explainPanic', () => {
  it('says that an overflow panic means overflow checks were on', () => {
    // Worth stating: the same bug in a build without them wraps silently and
    // corrupts state, so panicking here is the good outcome.
    const explanation = explainPanic({
      site: { file: 'a.rs', line: 1, column: 1 },
      message: 'attempt to add with overflow',
      classification: 'arithmetic-overflow',
    });

    expect(explanation).toMatch(/overflow-checks/);
    expect(explanation).toMatch(/checked_\*|saturating_\*/);
  });

  it('still explains a panic it could not classify', () => {
    const explanation = explainPanic({
      site: { file: 'a.rs', line: 1, column: 1 },
      message: 'mystery',
      classification: 'unclassified',
    });

    expect(explanation.length).toBeGreaterThan(40);
  });
});
