/**
 * The proof that makes selling offline safe. Both the till (in the browser) and the server use these
 * functions, so a sale queued on a device carries a tag only someone holding the pass key can make.
 *
 * Nothing here knows about shops or sales: it is text in, tag out. Keep it small and dependency free.
 */

/** The tag "before" the first sale of a pass. */
export const GENESIS_TAG = '0'.repeat(64);

/** JSON with object keys sorted, so the same details always give the same text, whoever wrote them. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const o = value as Record<string, unknown>;
  const keys = Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
}

const toHex = (buf: ArrayBuffer) =>
  Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

export function base64ToBytesLocal(b64: string): Uint8Array {
  const bin = atob(b64.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64Local(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/** HMAC-SHA-256 as hex. The key is base64 (standard or URL form). */
export async function hmacHex(keyB64: string, message: string): Promise<string> {
  const subtle = globalThis.crypto.subtle;
  const key = await subtle.importKey('raw', base64ToBytesLocal(keyB64) as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toHex(await subtle.sign('HMAC', key, new TextEncoder().encode(message)));
}

/** Compares two hex strings without stopping at the first difference. */
export function sameTag(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** What one queued action says, exactly as it is signed. */
export interface QueuedAction {
  seq: number;
  requestId: string;
  type: string;
  payload: unknown;
  /** Device time, ISO 8601. */
  queuedAt: string;
}

/** The tag for one action in the chain: it covers the pass, its place in the queue, the tag before it and every detail. */
export function offlineTag(keyB64: string, passId: string, prevTag: string, a: QueuedAction): Promise<string> {
  return hmacHex(keyB64, ['cakepos-offline-v1', passId, String(a.seq), prevTag, a.requestId, a.type, canonicalJson(a.payload), a.queuedAt].join('|'));
}

/** The pass key for one pass, from the server's master key. The server keeps the master key, never the pass keys. */
export function derivePassKey(masterKeyB64: string, passId: string, userId: string, deviceId: string): Promise<string> {
  return hmacHex(masterKeyB64, ['cakepos-pass-key-v1', passId, userId, deviceId].join('|')).then((hex) => bytesToBase64Local(hexToBytes(hex)));
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
