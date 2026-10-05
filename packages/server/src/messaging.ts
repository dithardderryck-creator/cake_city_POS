import type { MessageTerminal, SendResult } from '@cake-pos/panel';

/**
 * SMS and WhatsApp through a provider the shop chooses. The panel only knows the MessageTerminal shape; everything
 * about a provider's web address, passwords and error codes stays in this file.
 */

export type SmsProviderConfig =
  | { kind: 'twilio'; accountSid: string; authToken: string; from?: string; messagingServiceSid?: string }
  | { kind: 'africastalking'; username: string; apiKey: string; senderId?: string; sandbox: boolean }
  | { kind: 'webhook'; url: string; token?: string };

export type WhatsAppProviderConfig =
  | { kind: 'twilio'; accountSid: string; authToken: string; from: string }
  | { kind: 'webhook'; url: string; token?: string };

export interface MessagingConfig {
  sms: SmsProviderConfig | null;
  whatsapp: WhatsAppProviderConfig | null;
}

type Fetch = typeof fetch;
const TIMEOUT_MS = 15_000;

/** Network trouble and busy providers are worth trying again. A refusal of the request itself is not. */
const retryableStatus = (status: number) => status === 408 || status === 429 || status >= 500;

async function post(fetchImpl: Fetch, url: string, init: RequestInit): Promise<{ status: number; text: string } | { error: string }> {
  try {
    const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    return { status: res.status, text: await res.text() };
  } catch (err) {
    // Never include the address or headers: they can carry secrets.
    const name = err instanceof Error ? err.name : '';
    return { error: name === 'TimeoutError' || name === 'AbortError' ? 'The provider did not answer in time.' : 'Could not reach the provider.' };
  }
}

const json = (text: string): Record<string, any> | null => {
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
};

const clip = (s: unknown, n = 160) => String(s ?? '').replace(/\s+/g, ' ').slice(0, n);

/* ---------- Twilio (SMS and WhatsApp) ---------- */

function twilio(c: { accountSid: string; authToken: string }, fetchImpl: Fetch, channel: 'sms' | 'whatsapp', sender: { from?: string; messagingServiceSid?: string }) {
  return async (to: string, text: string): Promise<SendResult> => {
    const body = new URLSearchParams({ To: channel === 'whatsapp' ? `whatsapp:${to}` : to, Body: text });
    if (sender.messagingServiceSid) body.set('MessagingServiceSid', sender.messagingServiceSid);
    else if (sender.from) body.set('From', sender.from);
    const r = await post(fetchImpl, `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(c.accountSid)}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: `Basic ${Buffer.from(`${c.accountSid}:${c.authToken}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body,
    });
    if ('error' in r) return { ok: false, retry: true, error: r.error };
    const data = json(r.text);
    if (r.status >= 200 && r.status < 300) return { ok: true, id: typeof data?.sid === 'string' ? data.sid : undefined };
    if (r.status === 401) return { ok: false, retry: false, error: 'Twilio refused the account details. Check the Account SID and Auth Token.' };
    return { ok: false, retry: retryableStatus(r.status), error: `Twilio: ${clip(data?.message ?? `HTTP ${r.status}`)}${data?.code ? ` (code ${data.code})` : ''}` };
  };
}

/* ---------- Africa's Talking (SMS) ---------- */

/** Statuses that mean the message was taken: 100 Processed, 101 Sent, 102 Queued. */
const AT_OK = new Set([100, 101, 102]);
/** The provider's own faults, worth trying again: 500 InternalServerError, 501 GatewayError, 502 RejectedByGateway. */
const AT_RETRY = new Set([500, 501, 502]);

function africasTalking(c: Extract<SmsProviderConfig, { kind: 'africastalking' }>, fetchImpl: Fetch) {
  const base = c.sandbox ? 'https://api.sandbox.africastalking.com' : 'https://api.africastalking.com';
  return async (to: string, text: string): Promise<SendResult> => {
    const body = new URLSearchParams({ username: c.username, to, message: text });
    if (c.senderId) body.set('from', c.senderId);
    const r = await post(fetchImpl, `${base}/version1/messaging`, {
      method: 'POST',
      headers: { apiKey: c.apiKey, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if ('error' in r) return { ok: false, retry: true, error: r.error };
    if (r.status === 401 || r.status === 403) return { ok: false, retry: false, error: "Africa's Talking refused the username or API key." };
    const data = json(r.text);
    if (r.status >= 200 && r.status < 300) {
      const rec = data?.SMSMessageData?.Recipients?.[0];
      if (!rec) return { ok: false, retry: false, error: `Africa's Talking: ${clip(data?.SMSMessageData?.Message ?? 'no recipient in the answer')}` };
      const code = Number(rec.statusCode);
      if (AT_OK.has(code)) return { ok: true, id: typeof rec.messageId === 'string' ? rec.messageId : undefined };
      return { ok: false, retry: AT_RETRY.has(code), error: `Africa's Talking: ${clip(rec.status ?? `status ${code}`)}` };
    }
    return { ok: false, retry: retryableStatus(r.status), error: `Africa's Talking: HTTP ${r.status}` };
  };
}

/* ---------- Generic webhook (any provider, or a small bridge the shop writes) ---------- */

function webhook(c: { url: string; token?: string }, fetchImpl: Fetch, channel: 'sms' | 'whatsapp') {
  return async (to: string, text: string): Promise<SendResult> => {
    const r = await post(fetchImpl, c.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(c.token ? { Authorization: `Bearer ${c.token}` } : {}) },
      body: JSON.stringify({ channel, to, text }),
    });
    if ('error' in r) return { ok: false, retry: true, error: r.error };
    if (r.status >= 200 && r.status < 300) return { ok: true };
    return { ok: false, retry: retryableStatus(r.status), error: `The message service answered HTTP ${r.status}.` };
  };
}

export function createMessenger(config: MessagingConfig, fetchImpl: Fetch = fetch): MessageTerminal | undefined {
  const senders: Partial<Record<'sms' | 'whatsapp', (to: string, text: string) => Promise<SendResult>>> = {};
  const s = config.sms;
  if (s?.kind === 'twilio') senders.sms = twilio(s, fetchImpl, 'sms', s);
  else if (s?.kind === 'africastalking') senders.sms = africasTalking(s, fetchImpl);
  else if (s?.kind === 'webhook') senders.sms = webhook(s, fetchImpl, 'sms');
  const w = config.whatsapp;
  if (w?.kind === 'twilio') senders.whatsapp = twilio(w, fetchImpl, 'whatsapp', { from: w.from });
  else if (w?.kind === 'webhook') senders.whatsapp = webhook(w, fetchImpl, 'whatsapp');
  const channels = (Object.keys(senders) as Array<'sms' | 'whatsapp'>).sort();
  if (channels.length === 0) return undefined;
  return {
    channels: () => channels,
    send: async (m) => {
      const send = senders[m.channel];
      return send ? send(m.to, m.text) : { ok: false, retry: false, error: `No ${m.channel} provider is set up.` };
    },
  };
}
