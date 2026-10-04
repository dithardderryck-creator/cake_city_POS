import type { Photo } from '../domain';

/** The biggest picture accepted. Phones should shrink photos before uploading; the client library does not. */
export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

/** Looks at the first bytes, not the name or the header the sender claims. Returns null for anything but jpeg, png or webp. */
export function sniffImage(bytes: Uint8Array): Photo['mime'] | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a)
    return 'image/png';
  if (bytes.length >= 12 && String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP') return 'image/webp';
  return null;
}

/** Pictures nobody attached to a cake are dropped after this long. */
export const UNATTACHED_PHOTO_TTL_MS = 24 * 3_600_000;
