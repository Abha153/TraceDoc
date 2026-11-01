function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Replaces an id everywhere in a JSON value, including inside longer ids (D-01-F01, data/derived/D-01/page-1.png).
 * The id must not be followed by another letter or digit, so D-01 does not match D-011.
 */
export function remapId<T>(value: T, from: string, to: string): T {
  const re = new RegExp(`(?<![A-Za-z0-9])${escapeRe(from)}(?![A-Za-z0-9])`, "g");
  return JSON.parse(JSON.stringify(value).replace(re, to)) as T;
}
