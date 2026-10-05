import { describe, expect, it } from 'vitest';
import { createMemoryStore } from '@cake-pos/panel';
import { loadConfig, ConfigError } from './config';
import { createMessenger, type MessagingConfig } from './messaging';
import { createPushTerminal, loadOrCreateVapid } from './push';

interface Call {
  url: string;
  method?: string;
  headers: Record<string, string>;
  body: string;
}
function fakeFetch(answer: { status: number; body?: unknown; text?: string } | Error | ((c: Call) => { status: number; body?: unknown })) {
  const calls: Call[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    const call: Call = { url: String(url), method: init.method, headers: Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>)), body: String(init.body ?? '') };
    calls.push(call);
    if (answer instanceof Error) throw answer;
    const a = typeof answer === 'function' ? answer(call) : answer;
    const text = 'text' in a && a.text !== undefined ? a.text : JSON.stringify(a.body ?? {});
    return { status: a.status, text: async () => text } as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const twilioCfg: MessagingConfig = {
  sms: { kind: 'twilio', accountSid: 'AC123', authToken: 'secret-token', from: '+15005550006' },
  whatsapp: { kind: 'twilio', accountSid: 'AC123', authToken: 'secret-token', from: 'whatsapp:+14155238886' },
};
const msg = { to: '+255712345678', text: 'Cake POS: Flour is out of stock. ' };

describe('Twilio', () => {
  it('sends an SMS with the documented request', async () => {
    const f = fakeFetch({ status: 201, body: { sid: 'SM1', status: 'queued', error_code: null } });
    const r = await createMessenger(twilioCfg, f.impl)!.send({ channel: 'sms', ...msg });
    expect(r).toEqual({ ok: true, id: 'SM1' });
    const c = f.calls[0]!;
    expect(c.url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json');
    expect(c.method).toBe('POST');
    expect(c.headers.Authorization).toBe(`Basic ${Buffer.from('AC123:secret-token').toString('base64')}`);
    expect(c.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    const form = new URLSearchParams(c.body);
    expect(Object.fromEntries(form)).toEqual({ To: '+255712345678', From: '+15005550006', Body: msg.text });
  });

  it('addresses WhatsApp with the whatsapp: prefix on both ends', async () => {
    const f = fakeFetch({ status: 201, body: { sid: 'SM2' } });
    await createMessenger(twilioCfg, f.impl)!.send({ channel: 'whatsapp', ...msg });
    expect(Object.fromEntries(new URLSearchParams(f.calls[0]!.body))).toEqual({ To: 'whatsapp:+255712345678', From: 'whatsapp:+14155238886', Body: msg.text });
  });

  it('uses a messaging service instead of a number when one is given', async () => {
    const f = fakeFetch({ status: 201, body: { sid: 'SM3' } });
    await createMessenger({ sms: { kind: 'twilio', accountSid: 'AC1', authToken: 't', messagingServiceSid: 'MG1' }, whatsapp: null }, f.impl)!.send({ channel: 'sms', ...msg });
    const form = Object.fromEntries(new URLSearchParams(f.calls[0]!.body));
    expect(form.MessagingServiceSid).toBe('MG1');
    expect(form.From).toBeUndefined();
  });

  it('tells a bad number (will never work) from a busy provider (worth another try)', async () => {
    const bad = await createMessenger(twilioCfg, fakeFetch({ status: 400, body: { code: 21211, message: "The 'To' number is not a valid phone number.", status: 400 } }).impl)!.send({ channel: 'sms', ...msg });
    expect(bad).toEqual({ ok: false, retry: false, error: "Twilio: The 'To' number is not a valid phone number. (code 21211)" });
    for (const status of [429, 500, 503]) expect((await createMessenger(twilioCfg, fakeFetch({ status, body: {} }).impl)!.send({ channel: 'sms', ...msg }))).toMatchObject({ ok: false, retry: true });
  });

  it('says plainly when the account details are wrong, without echoing them', async () => {
    const r = await createMessenger(twilioCfg, fakeFetch({ status: 401, body: { message: 'Authenticate' } }).impl)!.send({ channel: 'sms', ...msg });
    expect(r).toMatchObject({ ok: false, retry: false });
    expect(JSON.stringify(r)).not.toContain('secret-token');
    expect((r as { error: string }).error).toMatch(/Account SID and Auth Token/);
  });

  it('treats a dead network or a timeout as a retry, and leaks no secrets in the error', async () => {
    const down = new Error('connect ECONNREFUSED https://AC123:secret-token@api.twilio.com');
    const r = await createMessenger(twilioCfg, fakeFetch(down).impl)!.send({ channel: 'sms', ...msg });
    expect(r).toEqual({ ok: false, retry: true, error: 'Could not reach the provider.' });
    const timeout = Object.assign(new Error('x'), { name: 'TimeoutError' });
    expect(await createMessenger(twilioCfg, fakeFetch(timeout).impl)!.send({ channel: 'sms', ...msg })).toEqual({ ok: false, retry: true, error: 'The provider did not answer in time.' });
  });
});

describe("Africa's Talking", () => {
  const cfg: MessagingConfig = { sms: { kind: 'africastalking', username: 'cakeshop', apiKey: 'at-key', senderId: 'CAKESHOP', sandbox: false }, whatsapp: null };
  const answer = (statusCode: number, status: string) => ({ status: 201, body: { SMSMessageData: { Message: 'Sent to 1/1', Recipients: [{ statusCode, number: '+255712345678', status, cost: 'TZS 20', messageId: 'ATPid_1' }] } } });

  it('sends with the documented request', async () => {
    const f = fakeFetch(answer(101, 'Success'));
    const r = await createMessenger(cfg, f.impl)!.send({ channel: 'sms', ...msg });
    expect(r).toEqual({ ok: true, id: 'ATPid_1' });
    const c = f.calls[0]!;
    expect(c.url).toBe('https://api.africastalking.com/version1/messaging');
    expect(c.headers).toMatchObject({ apiKey: 'at-key', Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' });
    expect(Object.fromEntries(new URLSearchParams(c.body))).toEqual({ username: 'cakeshop', to: '+255712345678', message: msg.text, from: 'CAKESHOP' });
  });

  it('uses the sandbox address when asked', async () => {
    const f = fakeFetch(answer(100, 'Processed'));
    await createMessenger({ ...cfg, sms: { ...(cfg.sms as { kind: 'africastalking'; username: string; apiKey: string; sandbox: boolean }), sandbox: true } }, f.impl)!.send({ channel: 'sms', ...msg });
    expect(f.calls[0]!.url).toBe('https://api.sandbox.africastalking.com/version1/messaging');
  });

  it('counts 100, 101 and 102 as taken, refuses bad numbers and balance for good, and retries the provider’s own faults', async () => {
    for (const code of [100, 101, 102]) expect((await createMessenger(cfg, fakeFetch(answer(code, 'Ok')).impl)!.send({ channel: 'sms', ...msg })).ok).toBe(true);
    expect(await createMessenger(cfg, fakeFetch(answer(403, 'InvalidPhoneNumber')).impl)!.send({ channel: 'sms', ...msg })).toEqual({ ok: false, retry: false, error: "Africa's Talking: InvalidPhoneNumber" });
    expect(await createMessenger(cfg, fakeFetch(answer(405, 'InsufficientBalance')).impl)!.send({ channel: 'sms', ...msg })).toMatchObject({ retry: false });
    for (const code of [500, 501, 502]) expect(await createMessenger(cfg, fakeFetch(answer(code, 'GatewayError')).impl)!.send({ channel: 'sms', ...msg })).toMatchObject({ ok: false, retry: true });
  });

  it('copes with a plain-text refusal and an answer with nobody in it', async () => {
    expect(await createMessenger(cfg, fakeFetch({ status: 401, text: 'The supplied authentication is invalid' }).impl)!.send({ channel: 'sms', ...msg })).toEqual({ ok: false, retry: false, error: "Africa's Talking refused the username or API key." });
    expect(await createMessenger(cfg, fakeFetch({ status: 201, body: { SMSMessageData: { Message: 'No valid recipients', Recipients: [] } } }).impl)!.send({ channel: 'sms', ...msg })).toMatchObject({ ok: false, retry: false });
    expect(await createMessenger(cfg, fakeFetch({ status: 502, text: '<html>Bad gateway</html>' }).impl)!.send({ channel: 'sms', ...msg })).toMatchObject({ ok: false, retry: true });
  });

  it('does not offer WhatsApp it cannot send', () => {
    expect(createMessenger(cfg, fakeFetch({ status: 201 }).impl)!.channels()).toEqual(['sms']);
  });
});

describe('webhook', () => {
  const cfg: MessagingConfig = { sms: { kind: 'webhook', url: 'https://bridge.example/send', token: 'tok' }, whatsapp: { kind: 'webhook', url: 'https://bridge.example/send', token: 'tok' } };
  it('posts the channel, number and text as JSON with a bearer token', async () => {
    const f = fakeFetch({ status: 204 });
    const m = createMessenger(cfg, f.impl)!;
    expect(m.channels()).toEqual(['sms', 'whatsapp']);
    expect((await m.send({ channel: 'whatsapp', ...msg })).ok).toBe(true);
    expect(f.calls[0]!.headers.Authorization).toBe('Bearer tok');
    expect(JSON.parse(f.calls[0]!.body)).toEqual({ channel: 'whatsapp', to: msg.to, text: msg.text });
  });
  it('retries server trouble and gives up on a refusal', async () => {
    expect(await createMessenger(cfg, fakeFetch({ status: 500 }).impl)!.send({ channel: 'sms', ...msg })).toMatchObject({ retry: true });
    expect(await createMessenger(cfg, fakeFetch({ status: 400 }).impl)!.send({ channel: 'sms', ...msg })).toMatchObject({ retry: false });
  });
});

describe('no provider', () => {
  it('gives no messenger at all, so the panel can say texts are not set up', () => {
    expect(createMessenger({ sms: null, whatsapp: null })).toBeUndefined();
  });
});

describe('settings', () => {
  const load = (env: Record<string, string>) => loadConfig({ DATA_DIR: '/tmp/x', ...env });
  it('is off by default', () => {
    expect(load({}).messaging).toEqual({ sms: null, whatsapp: null });
    expect(load({}).pushContact).toBeNull();
  });
  it('reads each provider, and says exactly what is missing', () => {
    expect(load({ SMS_PROVIDER: 'africastalking', AT_USERNAME: 'u', AT_API_KEY: 'k', AT_SANDBOX: '1' }).messaging.sms).toEqual({ kind: 'africastalking', username: 'u', apiKey: 'k', senderId: undefined, sandbox: true });
    expect(load({ SMS_PROVIDER: 'twilio', TWILIO_ACCOUNT_SID: 'AC', TWILIO_AUTH_TOKEN: 't', TWILIO_SMS_FROM: '+1500' }).messaging.sms).toMatchObject({ kind: 'twilio', from: '+1500' });
    expect(() => load({ SMS_PROVIDER: 'twilio', TWILIO_ACCOUNT_SID: 'AC', TWILIO_AUTH_TOKEN: 't' })).toThrow(/TWILIO_SMS_FROM/);
    expect(() => load({ SMS_PROVIDER: 'africastalking', AT_USERNAME: 'u' })).toThrow(/AT_API_KEY is needed/);
    expect(() => load({ SMS_PROVIDER: 'carrier-pigeon' })).toThrow(/SMS_PROVIDER must be one of/);
    expect(() => load({ WHATSAPP_PROVIDER: 'twilio', TWILIO_ACCOUNT_SID: 'AC', TWILIO_AUTH_TOKEN: 't', TWILIO_WHATSAPP_FROM: '+1415' })).toThrow(/whatsapp:\+14155238886/);
    expect(() => load({ SMS_PROVIDER: 'webhook', MESSAGE_WEBHOOK_URL: 'ftp://x' })).toThrow(ConfigError);
  });
  it('turns phone notifications on only with a contact address', () => {
    expect(load({ PUSH_CONTACT: 'owner@cakes.example' }).pushContact).toBe('mailto:owner@cakes.example');
    expect(load({ PUSH_CONTACT: 'https://cakes.example/contact' }).pushContact).toBe('https://cakes.example/contact');
    expect(() => load({ PUSH_CONTACT: 'not an address' })).toThrow(/PUSH_CONTACT/);
  });
});

describe('phone notifications (Web Push)', () => {
  const keys = { publicKey: 'PUB', privateKey: 'PRIV' };
  const sub = { endpoint: 'https://fcm.example/abc', p256dh: 'P', auth: 'A' };
  const payload = (severity: 'critical' | 'warning' | 'test', tag = 'alt_0123456789ab') => ({ title: 'T', body: 'B', tag, severity, screen: 'forecast' as const });

  it('keeps one key pair for the life of the shop, in the database where backups carry it', async () => {
    const store = createMemoryStore();
    let made = 0;
    const gen = () => ({ publicKey: `pub${++made}`, privateKey: `priv${made}` });
    const a = await loadOrCreateVapid(store, gen);
    const b = await loadOrCreateVapid(store, gen);
    expect(b).toEqual(a);
    expect(made).toBe(1);
    await store.put('settings', { id: 'vapid', publicKey: '', privateKey: '' });
    await expect(loadOrCreateVapid(store, gen)).rejects.toThrow(/damaged/); // never quietly replace keys that phones are tied to
  });

  it('sends the payload with the shop’s identity, a lifetime that fits the urgency, and a topic', async () => {
    const seen: Array<{ sub: unknown; payload: string; options: Record<string, unknown> }> = [];
    const t = createPushTerminal({ keys, contact: 'mailto:o@x.example', sender: async (s, p, o) => (seen.push({ sub: s, payload: p, options: o }), { statusCode: 201 }) });
    expect(t.publicKey).toBe('PUB');
    expect(await t.send(sub, payload('critical'))).toEqual({ ok: true });
    expect(seen[0]!.sub).toEqual({ endpoint: sub.endpoint, keys: { p256dh: 'P', auth: 'A' } });
    expect(JSON.parse(seen[0]!.payload)).toMatchObject({ title: 'T', severity: 'critical', screen: 'forecast' });
    expect(seen[0]!.options).toMatchObject({ vapidDetails: { subject: 'mailto:o@x.example', publicKey: 'PUB', privateKey: 'PRIV' }, TTL: 21600, urgency: 'high', topic: 'alt_0123456789ab' });
    await t.send(sub, payload('warning'));
    await t.send(sub, payload('test', 'test-usr_abc!!' + 'x'.repeat(40)));
    expect(seen[1]!.options).toMatchObject({ TTL: 3600, urgency: 'normal' });
    expect((seen[2]!.options.topic as string).length).toBeLessThanOrEqual(32);
    expect(seen[2]!.options.topic).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('forgets devices the phone makers say are gone, retries their outages, and stops on a refusal', async () => {
    const fail = (statusCode?: number) => createPushTerminal({ keys, contact: 'mailto:o@x.example', sender: async () => Promise.reject(Object.assign(new Error('x'), { statusCode })) });
    expect(await fail(410).send(sub, payload('warning'))).toMatchObject({ ok: false, gone: true, retry: false });
    expect(await fail(404).send(sub, payload('warning'))).toMatchObject({ gone: true });
    for (const s of [429, 500, 503]) expect(await fail(s).send(sub, payload('warning'))).toMatchObject({ ok: false, retry: true });
    expect(await fail(undefined).send(sub, payload('warning'))).toMatchObject({ retry: true });
    expect(await fail(403).send(sub, payload('warning'))).toMatchObject({ ok: false, retry: false });
    expect(await fail(413).send(sub, payload('warning'))).toMatchObject({ retry: false });
  });
});
