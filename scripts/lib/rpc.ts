/**
 * A minimal JSON-RPC caller for the fixture scripts.
 *
 * These scripts record the wire JSON verbatim, so they deliberately bypass the
 * typed client in `@solvbana/core` — going through it would convert numbers to
 * `bigint` and then need converting back, and the fixture would no longer be
 * "what the RPC actually said".
 */
export interface RpcError {
  code: number;
  message: string;
}

export class RpcCallError extends Error {
  // Declared as fields rather than parameter properties: `erasableSyntaxOnly`
  // keeps every file runnable under Node's type stripping.
  readonly method: string;
  readonly rpcError: RpcError;

  constructor(method: string, rpcError: RpcError) {
    super(`${method} failed (${String(rpcError.code)}): ${rpcError.message}`);
    this.name = 'RpcCallError';
    this.method = method;
    this.rpcError = rpcError;
  }
}

export function rpcUrl(): string {
  const url = process.env['SOLANA_RPC_URL'];
  if (url === undefined || url === '') {
    throw new Error('SOLANA_RPC_URL is not set. Copy .env.example to .env and fill it in.');
  }
  return url;
}

export async function rpcCall<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });

  if (!response.ok) {
    throw new Error(`${method} failed: HTTP ${String(response.status)} ${response.statusText}`);
  }

  const body = (await response.json()) as { result?: T; error?: RpcError };
  if (body.error !== undefined) {
    throw new RpcCallError(method, body.error);
  }

  return body.result as T;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
