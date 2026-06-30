/**
 * Deterministic JSON canonicalization for the hash chain (build spec §7).
 *
 * The same canonicalization MUST be used identically on write and on verify,
 * or a faithfully-stored chain would fail to re-verify. Do not feed raw
 * `JSON.stringify` output (whose object key order can drift) into the hash.
 *
 * Rules:
 *   - object keys sorted lexicographically (by UTF-16 code unit, the JS default
 *     for Array.prototype.sort on strings),
 *   - no insignificant whitespace,
 *   - arrays preserve order (order is significant),
 *   - numbers formatted by the standard JSON number production,
 *   - `undefined` object properties are dropped (as standard JSON does);
 *     `undefined` is not a legal top-level/array value and throws.
 */
export function canonicalJson(value: unknown): string {
  return serialize(value);
}

function serialize(value: unknown): string {
  if (value === null) return 'null';

  const t = typeof value;
  if (t === 'number') {
    if (!Number.isFinite(value as number)) {
      throw new Error('canonicalJson: non-finite number is not representable');
    }
    return JSON.stringify(value);
  }
  if (t === 'boolean') return value ? 'true' : 'false';
  if (t === 'string') return JSON.stringify(value);
  if (t === 'bigint') {
    throw new Error('canonicalJson: bigint is not representable');
  }

  if (Array.isArray(value)) {
    return '[' + value.map((v) => serialize(v === undefined ? null : v)).join(',') + ']';
  }

  if (t === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    const parts = keys.map((k) => JSON.stringify(k) + ':' + serialize(obj[k]));
    return '{' + parts.join(',') + '}';
  }

  // functions, symbols, undefined at top level
  throw new Error(`canonicalJson: value of type ${t} is not representable`);
}
