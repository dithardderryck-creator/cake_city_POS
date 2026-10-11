import type { Change, SyncTerminal } from '@cake-pos/panel';

export interface OnlineDbConfig {
  /** Base address of the online database's sync endpoint, for example https://shop.example.com/api. */
  url: string;
  /** Secret that proves this shop server may write. Sent as a bearer token. */
  token: string;
}

export interface HttpSyncOptions extends OnlineDbConfig {
  /** Names this shop server to the receiver (the order-number prefix). */
  deviceId: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** After a failed send, wait this long before trying again. */
  backoffMs?: number;
  now?: () => number;
}

/**
 * Terminal: the online database, reached over HTTPS.
 *
 * POST {url}/sync/push with { deviceId, changes } where changes are in order, oldest first, each with a unique id.
 * Any 2xx answer means every change in the request is stored. Anything else, or no answer within the timeout, means none
 * are treated as stored and the same changes are sent again later; the receiver must ignore ids it already has.
 */
export function createHttpSyncTerminal(o: HttpSyncOptions): SyncTerminal {
  const f = o.fetchImpl ?? fetch;
  const now = o.now ?? Date.now;
  const timeoutMs = o.timeoutMs ?? 10_000;
  const backoffMs = o.backoffMs ?? 30_000;
  const base = o.url.replace(/\/+$/, '');
  let retryAt = 0;
  return {
    isOnline: () => now() >= retryAt,
    push: async () => undefined,
    async pushChanges(changes: Change[]) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeoutMs);
      try {
        const res = await f(`${base}/sync/push`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${o.token}` },
          body: JSON.stringify({ deviceId: o.deviceId, changes }),
          signal: ctl.signal,
        });
        if (res.ok) {
          retryAt = 0;
          return { ok: true as const };
        }
        retryAt = now() + backoffMs;
        const body = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200);
        return { ok: false as const, error: `HTTP ${res.status}${body ? `: ${body}` : ''}` };
      } catch (err) {
        retryAt = now() + backoffMs;
        return { ok: false as const, error: ctl.signal.aborted ? 'The online database did not answer in time' : err instanceof Error ? err.message : String(err) };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
