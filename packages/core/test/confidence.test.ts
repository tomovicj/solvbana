import { describe, expect, it } from 'vitest';
import { CONFIDENCE_LEVELS, capAt, isAtLeast, weakest } from '@solvbana/core';

describe('confidence', () => {
  it('orders levels weakest to strongest', () => {
    expect(CONFIDENCE_LEVELS).toEqual(['unknown', 'variant-only', 'narrowed', 'exact']);
  });

  it('takes the floor when combining evidence', () => {
    expect(weakest('exact', 'variant-only')).toBe('variant-only');
    expect(weakest('narrowed', 'narrowed')).toBe('narrowed');
  });

  it('caps rather than raises', () => {
    // An unverified build caps at variant-only no matter how exact the log looked.
    expect(capAt('exact', 'variant-only')).toBe('variant-only');
    // Capping never promotes a weaker result.
    expect(capAt('unknown', 'exact')).toBe('unknown');
  });

  it('compares against a floor', () => {
    expect(isAtLeast('narrowed', 'variant-only')).toBe(true);
    expect(isAtLeast('variant-only', 'narrowed')).toBe(false);
  });
});
