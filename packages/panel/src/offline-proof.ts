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

const toHex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

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

/*
 * SHA-256 and HMAC written out in plain code, on purpose. Browsers switch crypto.subtle off on plain http:// addresses,
 * which is how a shop server is usually reached, and a till that cannot sign its sales cannot sell offline. This is
 * checked against the platform's own implementation (and the published test vectors) in the tests.
 */
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export function sha256Bytes(data: Uint8Array): Uint8Array {
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const padded = new Uint8Array(((data.length + 9 + 63) >> 6) << 6);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor((data.length * 8) / 2 ** 32));
  view.setUint32(padded.length - 4, (data.length * 8) >>> 0);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3);
      const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = [h[0]!, h[1]!, h[2]!, h[3]!, h[4]!, h[5]!, h[6]!, h[7]!];
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i]! + w[i]!) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0]! + a) >>> 0;
    h[1] = (h[1]! + b) >>> 0;
    h[2] = (h[2]! + c) >>> 0;
    h[3] = (h[3]! + d) >>> 0;
    h[4] = (h[4]! + e) >>> 0;
    h[5] = (h[5]! + f) >>> 0;
    h[6] = (h[6]! + g) >>> 0;
    h[7] = (h[7]! + hh) >>> 0;
  }
  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) ov.setUint32(i * 4, h[i]!);
  return out;
}

export function hmacSha256Bytes(key: Uint8Array, message: Uint8Array): Uint8Array {
  const block = 64;
  const k = new Uint8Array(block);
  k.set(key.length > block ? sha256Bytes(key) : key);
  const inner = new Uint8Array(block + message.length);
  const outer = new Uint8Array(block + 32);
  for (let i = 0; i < block; i++) {
    inner[i] = k[i]! ^ 0x36;
    outer[i] = k[i]! ^ 0x5c;
  }
  inner.set(message, block);
  outer.set(sha256Bytes(inner), block);
  return sha256Bytes(outer);
}

/** HMAC-SHA-256 as hex. The key is base64 (standard or URL form). Same answer anywhere, with no browser crypto needed. */
export function hmacHexSync(keyB64: string, message: string): string {
  return toHex(hmacSha256Bytes(base64ToBytesLocal(keyB64), new TextEncoder().encode(message)));
}
export const hmacHex = async (keyB64: string, message: string): Promise<string> => hmacHexSync(keyB64, message);

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
export function offlineTagSync(keyB64: string, passId: string, prevTag: string, a: QueuedAction): string {
  return hmacHexSync(keyB64, ['cakepos-offline-v1', passId, String(a.seq), prevTag, a.requestId, a.type, canonicalJson(a.payload), a.queuedAt].join('|'));
}
export const offlineTag = async (keyB64: string, passId: string, prevTag: string, a: QueuedAction): Promise<string> => offlineTagSync(keyB64, passId, prevTag, a);

/** The pass key for one pass, from the server's master key. The server keeps the master key, never the pass keys. */
export function derivePassKeySync(masterKeyB64: string, passId: string, userId: string, deviceId: string): string {
  return bytesToBase64Local(hexToBytes(hmacHexSync(masterKeyB64, ['cakepos-pass-key-v1', passId, userId, deviceId].join('|'))));
}
export const derivePassKey = async (masterKeyB64: string, passId: string, userId: string, deviceId: string): Promise<string> => derivePassKeySync(masterKeyB64, passId, userId, deviceId);

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
