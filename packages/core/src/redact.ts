/**
 * An endpoint URL (any scheme) inside free text. An operator's RPC URL usually
 * embeds a provider API key in its path or query string, and an error thrown by
 * a transport routinely quotes the URL it was calling.
 */
const URL_SHAPED = /\b[a-z][a-z0-9+.-]*:\/\/[^\s'"<>)\]]+/gi;

/**
 * An error's message with anything URL-shaped replaced by `[endpoint]`.
 *
 * Use this wherever a caught error becomes text a caller can see. `error.cause`
 * is deliberately not read: it is where a transport tucks the request.
 */
export function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(URL_SHAPED, '[endpoint]');
}
