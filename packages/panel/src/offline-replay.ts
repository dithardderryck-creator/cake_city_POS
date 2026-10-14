import { z } from 'zod';
import type { AuditEntry, Device, HeldAction, OfflinePass, OfflineSeen, Role, Session, Staff } from './domain';
import type { DispatchResult, IntentMap } from './intents';
import { QUEUEABLE, OFFLINE_ROLES } from './circuits/offline';
import { quickSaleTotal } from './circuits/orders';
import { offlineTag, sameTag, type QueuedAction } from './offline-proof';
import type { Clock, Ids, Store } from './ports';

/** How far a device clock may be off from the server's before a sale is sent to the owner to look at. */
export const CLOCK_SKEW_MS = 5 * 60_000;
export const MAX_REPLAY_ACTIONS = 200;

const iso = z
  .string()
  .max(40)
  .refine((s) => !Number.isNaN(Date.parse(s)), 'not a date');

const replaySchema = z.strictObject({
  passId: z.string().min(1).max(80),
  actions: z
    .array(
      z.strictObject({
        seq: z.number().int().min(1).max(1_000_000),
        requestId: z.string().min(1).max(80),
        type: z.string().min(1).max(60),
        payload: z.unknown(),
        queuedAt: iso,
        tag: z.string().regex(/^[0-9a-f]{64}$/),
      }),
    )
    .min(1)
    .max(MAX_REPLAY_ACTIONS),
});

export type ReplayInput = { passId: string; actions: Array<QueuedAction & { tag: string }> };

/**
 * done: it went through. duplicate: it had already gone through (or been held); nothing ran again.
 * held: it is waiting for the owner. rejected: it was refused and logged. retry: something failed on the server, send again.
 */
export type ReplayStatus = 'done' | 'duplicate' | 'held' | 'rejected' | 'retry';

export interface ReplayItemResult {
  seq: number;
  requestId: string;
  status: ReplayStatus;
  /** Plain language, safe to show on the till. */
  message: string;
  orderId?: string;
  number?: string;
  total?: number;
}

export type ReplayResult =
  | { ok: true; results: ReplayItemResult[] }
  | { ok: false; error: { code: 'forbidden' | 'invalid' | 'error'; messages: string[] } };

export interface ReplayDeps {
  store: Store;
  clock: Clock;
  ids: Ids;
  /** The secret for one pass, from the server's master key. */
  passKey(passId: string, userId: string, deviceId: string): Promise<string>;
  /** Runs one instruction as someone, stamped with a time, through the normal pipeline. All or nothing. */
  runAs(session: Session, at: string, type: 'orders/quick_sale', payload: IntentMap['orders/quick_sale'], requestId: string, device: Device): Promise<DispatchResult>;
  /** Everything that touches the store happens one at a time. */
  serial<T>(fn: () => Promise<T>): Promise<T>;
  resolveDevice(deviceToken: string | undefined): Promise<Device | null>;
  changed(): void;
  onError(err: unknown): void;
}

const fmt = (n: number) => String(Math.round(n));

export function createReplayer(d: ReplayDeps) {
  const now = () => d.clock.now().toISOString();

  async function audit(entry: Omit<AuditEntry, 'id' | 'at'>) {
    await d.store.put<AuditEntry>('audit', { id: d.ids.next('aud'), at: now(), ...entry });
  }

  /** A refusal that someone should be able to see later: written to the audit trail as a security event. */
  async function refuse(why: string, who?: { userId: string; name: string; role: Role }): Promise<void> {
    await d.store.transaction(() =>
      audit({ ...(who ? { actorId: who.userId, actorName: who.name, role: who.role } : {}), intent: 'offline/replay', summary: `Refused an offline sale: ${why}`, outcome: 'denied' }),
    );
  }

  async function replay(input: unknown, deviceToken: string | undefined): Promise<ReplayResult> {
    const parsed = replaySchema.safeParse(input);
    if (!parsed.success) return { ok: false, error: { code: 'invalid', messages: ['The list of offline sales was not in the right shape.'] } };
    const { passId, actions } = parsed.data as ReplayInput;

    // Who is asking: the registered device. Without it nothing below is even looked at.
    const device = await d.serial(() => d.resolveDevice(deviceToken));
    if (!device) {
      await d.serial(() => refuse('the request did not come from a registered device'));
      return { ok: false, error: { code: 'forbidden', messages: ['This device is not registered, so its offline sales cannot be accepted.'] } };
    }
    const first = await d.serial(async () => {
      const pass = await d.store.get<OfflinePass>('offlinePasses', passId);
      // Same answer for "no such pass" and "someone else's pass", so a device cannot probe for passes.
      if (!pass || pass.deviceId !== device.id) {
        await refuse(`the pass does not belong to the device "${device.name}"`);
        return { ok: false as const };
      }
      const person = await d.store.get<Staff>('staff', pass.userId);
      if (!person || !person.active || !(OFFLINE_ROLES as readonly string[]).includes(person.role)) {
        await refuse(`${pass.userName} can no longer sell`, { userId: pass.userId, name: pass.userName, role: person?.role ?? 'cashier' });
        return { ok: false as const, person: false };
      }
      return { ok: true as const };
    });
    if (!first.ok) {
      const gone = 'person' in first;
      return {
        ok: false,
        error: { code: 'forbidden', messages: [gone ? 'The person who made these sales can no longer sell, so they were not accepted. Tell the owner.' : 'These offline sales were not accepted. Tell the owner.'] },
      };
    }

    const results: ReplayItemResult[] = [];
    for (const a of actions) {
      const r = await d.serial(() => one(passId, device, a).catch((err): ReplayItemResult => {
        d.onError(err);
        return { seq: a.seq, requestId: a.requestId, status: 'retry', message: 'Something went wrong on the server. Nothing was lost. It will be sent again.' };
      }));
      results.push(r);
      // A server failure is not a verdict on this sale. Later sales depend on it, so stop and let the till send again.
      if (r.status === 'retry') break;
    }
    d.changed();
    return { ok: true, results };
  }

  async function one(passId: string, device: Device, a: QueuedAction & { tag: string }): Promise<ReplayItemResult> {
    const base = { seq: a.seq, requestId: a.requestId };
    const pass = (await d.store.get<OfflinePass>('offlinePasses', passId))!;
    const person = await d.store.get<Staff>('staff', pass.userId);
    const who = { userId: pass.userId, name: pass.userName, role: (person?.role ?? 'cashier') as Role };
    // The person may have been switched off or the device revoked while the queue was being sent.
    const liveDevice = await d.store.get<Device>('devices', device.id);
    if (!person || !person.active || !(OFFLINE_ROLES as readonly string[]).includes(person.role) || !liveDevice || liveDevice.revokedAt) {
      await refuse(`sale ${a.seq} from "${device.name}": the person or the device is no longer allowed`, who);
      return { ...base, status: 'rejected', message: 'Refused: the person or the till is no longer allowed to sell.' };
    }

    const key = await d.passKey(pass.id, pass.userId, pass.deviceId);
    const prevTag = a.seq < pass.nextSeq ? null : pass.lastTag;

    // Already seen: answer from the record. It counts only if it is the very same sale.
    const seen = await d.store.get<OfflineSeen>('offlineLog', `${passId}:${a.seq}`);
    if (seen) {
      if (seen.requestId === a.requestId && sameTag(seen.tag, a.tag)) return { ...base, status: 'duplicate', message: seen.message, orderId: seen.orderId, number: seen.number, total: seen.total };
      await refuse(`sale ${a.seq} from "${device.name}" does not match the sale already received with that number`, who);
      return { ...base, status: 'rejected', message: 'Refused: this sale does not match what was already received. Tell the owner.' };
    }

    // The place in the chain: exactly the next one, no gaps, no jumping ahead.
    if (a.seq !== pass.nextSeq || prevTag === null) {
      await refuse(`sale ${a.seq} from "${device.name}" arrived out of order (expected ${pass.nextSeq})`, who);
      return { ...base, status: 'rejected', message: a.seq > pass.nextSeq ? `Refused: sale ${pass.nextSeq} is missing before this one. Tell the owner.` : 'Refused: this sale is out of order. Tell the owner.' };
    }

    // The proof: nobody without the pass key can make this tag, and any change to the sale breaks it.
    const expected = await offlineTag(key, pass.id, prevTag, a);
    if (!sameTag(expected, a.tag)) {
      await refuse(`sale ${a.seq} from "${device.name}" was changed or made up (its proof does not match)`, who);
      return { ...base, status: 'rejected', message: 'Refused: this sale was changed after it was made, so it cannot be trusted. Tell the owner.' };
    }

    // From here the sale is genuine. Anything wrong now is for the owner to judge, not a reason to lose it.
    const receivedAt = now();
    const nowMs = d.clock.now().getTime();
    const sentMs = Date.parse(a.queuedAt);
    const reasons: string[] = [];
    if (!(QUEUEABLE as readonly string[]).includes(a.type)) reasons.push('This kind of action is not allowed offline.');
    if (sentMs < Date.parse(pass.issuedAt) - CLOCK_SKEW_MS) reasons.push('The till says it was made before it was given permission to sell offline.');
    if (sentMs > Date.parse(pass.expiresAt) + CLOCK_SKEW_MS) reasons.push('It was made after the offline permission ran out.');
    if (sentMs > nowMs + CLOCK_SKEW_MS) reasons.push("The till's clock is ahead of the shop's.");
    if (pass.lastAt && sentMs < Date.parse(pass.lastAt)) reasons.push('It says it was made before the sale that came before it.');
    if (pass.closedAt && sentMs > Date.parse(pass.closedAt) + CLOCK_SKEW_MS) reasons.push('It was made after the till was given a newer offline permission.');

    const sale = a.payload as IntentMap['orders/quick_sale'];
    const isSale = (QUEUEABLE as readonly string[]).includes(a.type);
    let saleTotal = 0;
    if (isSale) {
      if (typeof sale?.expectedTotal !== 'number') reasons.push('It does not say what total the customer was shown.');
      const priced = Array.isArray(sale?.items) ? await quickSaleTotal({ store: d.store }, sale.items) : null;
      saleTotal = priced ?? (typeof sale?.expectedTotal === 'number' ? sale.expectedTotal : 0);
      if (pass.sales + 1 > pass.maxSales) reasons.push(`It is over the limit of ${pass.maxSales} sales for one offline permission.`);
      if (pass.total + saleTotal > pass.maxTotal) reasons.push(`It takes the offline total over the limit of ${fmt(pass.maxTotal)}.`);
    }

    if (reasons.length === 0 && isSale) {
      const at = new Date(Math.min(sentMs, nowMs)).toISOString();
      const res = await d.runAs({ userId: person.id, name: person.name, role: person.role }, at, 'orders/quick_sale', sale, a.requestId, device);
      if (res.ok) {
        const data = (res.data ?? {}) as { orderId?: string; number?: string; total?: number };
        const message = `Sent: order ${data.number ?? ''}, ${fmt(data.total ?? saleTotal)}.`.replace('order ,', 'order');
        await d.store.transaction(async () => {
          await d.store.put<OfflinePass>('offlinePasses', { ...pass, nextSeq: a.seq + 1, lastTag: a.tag, lastAt: a.queuedAt, sales: pass.sales + 1, total: pass.total + (data.total ?? saleTotal) });
          await d.store.put<OfflineSeen>('offlineLog', { id: `${passId}:${a.seq}`, passId, seq: a.seq, tag: a.tag, requestId: a.requestId, status: 'done', receivedAt, message, orderId: data.orderId, number: data.number, total: data.total });
          await audit({ actorId: who.userId, actorName: who.name, role: who.role, intent: 'offline/replay', target: data.orderId, summary: `Offline sale ${a.seq} from "${device.name}" went through as order ${data.number ?? ''}`.trim(), outcome: 'ok' });
        });
        return { ...base, status: 'done', message, orderId: data.orderId, number: data.number, total: data.total };
      }
      if (res.error.code === 'error') return { ...base, status: 'retry', message: 'Something went wrong on the server. Nothing was lost. It will be sent again.' };
      reasons.push(...res.error.messages);
    }

    // Held: stored whole, shown to the owner, never dropped and never forced through.
    const held: HeldAction = {
      id: d.ids.next('hld'),
      passId,
      userId: pass.userId,
      userName: pass.userName,
      deviceId: pass.deviceId,
      deviceName: pass.deviceName,
      requestId: a.requestId,
      type: a.type,
      payload: a.payload,
      queuedAt: a.queuedAt,
      receivedAt,
      reasons: [...new Set(reasons)],
      status: 'held',
    };
    const message = `Held for the owner: ${held.reasons[0]}`;
    await d.store.transaction(async () => {
      await d.store.put('heldActions', held);
      await d.store.put<OfflinePass>('offlinePasses', { ...pass, nextSeq: a.seq + 1, lastTag: a.tag, lastAt: pass.lastAt && Date.parse(pass.lastAt) > sentMs ? pass.lastAt : a.queuedAt });
      await d.store.put<OfflineSeen>('offlineLog', { id: `${passId}:${a.seq}`, passId, seq: a.seq, tag: a.tag, requestId: a.requestId, status: 'held', receivedAt, message, heldId: held.id });
      await audit({ actorId: who.userId, actorName: who.name, role: who.role, intent: 'offline/replay', target: held.id, summary: `Offline sale ${a.seq} from "${device.name}" is waiting for the owner: ${held.reasons[0]}`, outcome: 'invalid' });
    });
    return { ...base, status: 'held', message };
  }

  return replay;
}
