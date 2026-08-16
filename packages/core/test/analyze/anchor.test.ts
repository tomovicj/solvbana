import { describe, expect, it } from 'vitest';
import {
  anchorErrorIn,
  buildFrames,
  comparisonIn,
  handlerIn,
  parseAnchorError,
  parseLogs,
  type Frame,
} from '@solvbana/core';

/** Build a single frame around a program's own log lines. */
function frameOf(messages: string[]): Frame {
  const frames = buildFrames(
    parseLogs(
      [
        'Program Prog invoke [1]',
        ...messages.map((message) => `Program log: ${message}`),
        'Program Prog failed: custom program error: 0x1',
      ],
      [],
    ),
  );
  return frames[0]!;
}

describe('parseAnchorError', () => {
  it('reads a throw site, name, number, and message from the `thrown in` form', () => {
    const parsed = parseAnchorError(
      'AnchorError thrown in programs/pump-amm/src/instructions/swap/buy.rs:687. ' +
        'Error Code: BuySlippageBelowMinBaseAmountOut. Error Number: 6040. ' +
        'Error Message: buy: slippage - would buy less tokens than expected min_base_amount_out.',
    );

    expect(parsed).toEqual({
      name: 'BuySlippageBelowMinBaseAmountOut',
      number: 6040,
      // The message contains its own colons and hyphens and must survive intact.
      message: 'buy: slippage - would buy less tokens than expected min_base_amount_out',
      site: { file: 'programs/pump-amm/src/instructions/swap/buy.rs', line: 687 },
      account: null,
    });
  });

  it('reads the offending account from the `caused by account` form', () => {
    const parsed = parseAnchorError(
      'AnchorError caused by account: encoded_vaa. Error Code: ConstraintOwner. ' +
        'Error Number: 2004. Error Message: An owner constraint was violated.',
    );

    expect(parsed).toMatchObject({ account: 'encoded_vaa', name: 'ConstraintOwner', site: null });
  });

  it('reads the form that carries neither a site nor an account', () => {
    const parsed = parseAnchorError(
      'AnchorError occurred. Error Code: RequireViolated. Error Number: 2500. ' +
        'Error Message: A require expression was violated.',
    );

    expect(parsed).toMatchObject({
      name: 'RequireViolated',
      number: 2500,
      site: null,
      account: null,
    });
  });

  it('does not mistake ordinary program output for an Anchor error', () => {
    expect(parseAnchorError('Instruction: Swap')).toBeNull();
    expect(parseAnchorError('AnchorError but not really')).toBeNull();
  });
});

describe('anchorErrorIn', () => {
  it('reads only the frame it is given', () => {
    const frame = frameOf([
      'Instruction: Sell',
      'AnchorError caused by account: vault. Error Code: ConstraintSeeds. Error Number: 2006. ' +
        'Error Message: A seeds constraint was violated.',
    ]);

    expect(anchorErrorIn(frame)?.account).toBe('vault');
  });
});

describe('handlerIn', () => {
  it('reads the handler from the failing frame and not from a CPI callee', () => {
    // Mainnet signature `2WH1WJ5N…`: the failing program logs BuyExactQuoteIn,
    // then a fee program logs GetFees and returns successfully before the throw.
    const frames = buildFrames(
      parseLogs(
        [
          'Program pAMM invoke [1]',
          'Program log: Instruction: BuyExactQuoteIn',
          'Program pfee invoke [2]',
          'Program log: Instruction: GetFees',
          'Program pfee success',
          'Program log: AnchorError occurred. Error Code: X. Error Number: 6040. Error Message: y.',
          'Program pAMM failed: custom program error: 0x1798',
        ],
        [],
      ),
    );

    expect(handlerIn(frames[0]!)).toBe('BuyExactQuoteIn');
    expect(handlerIn(frames[1]!)).toBe('GetFees');
  });

  it('returns null for a program that emits no Anchor prologue', () => {
    expect(handlerIn(frameOf(['doing some work']))).toBeNull();
  });
});

describe('comparisonIn', () => {
  it('reads operands printed inline', () => {
    const frame = frameOf(['Left: 412250202354', 'Right: 428963556055']);

    expect(comparisonIn(frame)).toEqual({ left: '412250202354', right: '428963556055' });
  });

  it('reads operands printed on the line after their label', () => {
    // Pubkey comparisons print the label alone and the value beneath it.
    const frame = frameOf([
      'Left:',
      '11111111111111111111111111111111',
      'Right:',
      'HDwcJBJXjL9FpJ7UBsYBtaDjsBUhuLCUYoz3zr8SWWaQ',
    ]);

    expect(comparisonIn(frame)).toEqual({
      left: '11111111111111111111111111111111',
      right: 'HDwcJBJXjL9FpJ7UBsYBtaDjsBUhuLCUYoz3zr8SWWaQ',
    });
  });

  it('reports nothing when only one side has a value', () => {
    // Half a comparison reads as a value the code expected without saying what it
    // was compared against, which is worse than saying nothing.
    expect(comparisonIn(frameOf(['Left:', 'Right:']))).toBeNull();
    expect(comparisonIn(frameOf(['Left: 1']))).toBeNull();
  });
});
