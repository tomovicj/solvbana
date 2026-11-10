import { describe, expect, it } from 'vitest';
import { describeError } from '@solvbana/core';

describe('describeError', () => {
  it('removes an https URL with a key in the path and the query string', () => {
    const out = describeError(new Error('failed https://rpc.example.com/v1/SECRETKEY?api-key=abc'));
    expect(out).toBe('failed [endpoint]');
  });

  it('removes a wss URL', () => {
    expect(describeError(new Error('closed wss://ws.example.com/KEY'))).toBe('closed [endpoint]');
  });

  it('leaves a message with no URL unchanged', () => {
    expect(describeError(new Error('endpoint down'))).toBe('endpoint down');
  });

  it('describes a thrown non-Error', () => {
    expect(describeError('plain http://a.example/KEY string')).toBe('plain [endpoint] string');
    expect(describeError(42)).toBe('42');
  });

  it('removes every URL in one message', () => {
    const out = describeError(new Error('a http://x.example/1 then HTTPS://y.example/2?k=v done'));
    expect(out).toBe('a [endpoint] then [endpoint] done');
  });

  it('does not read the cause', () => {
    const error = new Error('outer', { cause: new Error('https://k.example/SECRET') });
    expect(describeError(error)).toBe('outer');
  });
});
