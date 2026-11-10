/**
 * Names taken from a transaction's logs or an IDL are whatever non-space text a
 * program chose to print. They are used to search source, so they are admitted
 * only when they could be a name in source at all.
 */
const RUST_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** Whether `name` is an ASCII Rust identifier of at most 64 characters. */
export function isRustIdentifier(name: string): boolean {
  return RUST_IDENTIFIER.test(name);
}

/** Escape `text` for literal use inside a `RegExp` source. */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
}

/**
 * The refusal stated when a logged name cannot be looked up in source.
 *
 * The name is shown JSON-quoted and clipped: it came from outside and may be
 * arbitrarily long or contain control characters.
 */
export function notAnIdentifier(kind: string, name: string): string {
  const shown = JSON.stringify(name.length > 40 ? `${name.slice(0, 40)}...` : name);
  return (
    `The ${kind} name the program logged (${shown}) is not a Rust identifier, so there is ` +
    'nothing in source to look for under it.'
  );
}
