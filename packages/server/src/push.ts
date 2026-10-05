import webpush from 'web-push';
import type { PushPayload, PushTerminal, SendResult, Store } from '@cake-pos/panel';

/**
 * Web Push to phones and browsers. The VAPID key pair identifies this shop to the phone makers' push services. It is kept
 * in the database, so backups carry it and a restored server keeps working for phones that already subscribed.
 */

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

export async function loadOrCreateVapid(store: Store, generate: () => VapidKeys = () => webpush.generateVAPIDKeys()): Promise<VapidKeys> {
  const saved = await store.get<{ id: string; publicKey: string; privateKey: string }>('settings', 'vapid');
  if (saved) {
    if (!saved.publicKey || !saved.privateKey) throw new Error('The saved push keys are damaged. Do not delete them without telling the staff to turn notifications on again.');
    return { publicKey: saved.publicKey, privateKey: saved.privateKey };
  }
  const keys = generate();
  await store.put('settings', { id: 'vapid', ...keys });
  return keys;
}

type Sender = (
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
  payload: string,
  options: Record<string, unknown>,
) => Promise<{ statusCode: number }>;

const TTL_SECONDS = { critical: 6 * 3600, warning: 3600, test: 300 } as const;

/** Topics must be 32 characters or fewer of URL-safe base64; they let a newer message replace an older one. */
const topicOf = (tag: string) => tag.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || undefined;

export function createPushTerminal(opts: { keys: VapidKeys; contact: string; sender?: Sender }): PushTerminal {
  const sender: Sender = opts.sender ?? ((sub, payload, options) => webpush.sendNotification(sub, payload, options as never) as Promise<{ statusCode: number }>);
  const vapidDetails = { subject: opts.contact, publicKey: opts.keys.publicKey, privateKey: opts.keys.privateKey };
  return {
    publicKey: opts.keys.publicKey,
    send: async (sub, payload: PushPayload): Promise<SendResult> => {
      try {
        await sender({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, JSON.stringify(payload), {
          vapidDetails,
          TTL: TTL_SECONDS[payload.severity],
          urgency: payload.severity === 'critical' ? 'high' : 'normal',
          topic: topicOf(payload.tag),
          timeout: 15_000,
        });
        return { ok: true };
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) return { ok: false, retry: false, gone: true, error: 'The device is no longer subscribed.' };
        if (status === undefined) return { ok: false, retry: true, error: 'Could not reach the phone’s push service.' };
        if (status === 429 || status >= 500 || status === 408) return { ok: false, retry: true, error: `The push service is busy (HTTP ${status}).` };
        return { ok: false, retry: false, error: `The push service refused it (HTTP ${status}).` };
      }
    },
  };
}
