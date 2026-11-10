import { describe, expect, it } from 'vitest';
import {
  attributeFor,
  explainAnchor,
  explainRuntimeVariant,
  hasAnchorExplanation,
  nativeError,
} from '@solvbana/core';

const INHERITED = ['constructor', 'toString', '__proto__', 'hasOwnProperty'];

describe('name-keyed lookups ignore inherited properties', () => {
  it.each(INHERITED)('attributeFor(%s)', (name) => {
    expect(attributeFor(name)).toBe(attributeFor('NotARealErrorName'));
  });

  it.each(INHERITED)('explainRuntimeVariant(%s)', (name) => {
    expect(explainRuntimeVariant(name)).toBe(explainRuntimeVariant('NotARealVariant'));
  });

  it.each(INHERITED)('nativeError(%s, 0)', (name) => {
    expect(nativeError(name, 0)).toBe(nativeError('NotARealProgram', 0));
  });

  it.each(INHERITED)('hasAnchorExplanation(%s)', (name) => {
    expect(hasAnchorExplanation(name)).toBe(false);
  });

  it.each(INHERITED)('explainAnchor(%s) matches an unknown name', (name) => {
    const make = (n: string) =>
      explainAnchor({ name: n, number: 6001 } as Parameters<typeof explainAnchor>[0], null);
    expect(make(name)).toBe(make('NotARealName').replace('NotARealName', name));
  });
});
