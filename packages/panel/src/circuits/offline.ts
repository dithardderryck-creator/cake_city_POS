import type { HeldAction, OfflinePass, Staff } from '../domain';
import { DomainError, type Registry } from '../intents';
import { loadSettings } from './settings';

const HOUR = 3_600_000;

/** Only the owner and cashiers sell, so only they get passes. */
export const OFFLINE_ROLES = ['owner', 'cashier'] as const;

/** The only instruction that may wait in a till's queue. Everything else needs the cloud. */
export const QUEUEABLE = ['orders/quick_sale'] as const;

export const offlineIntents = {
  'offline/get_pass': {
    circuit: 'Offline',
    roles: ['owner', 'cashier'],
    // The answer holds the pass key. It must never be copied into the retry memory.
    skipRequestMemo: true,
    validate: async (_p, ctx) => {
      const s = await loadSettings(ctx.store);
      if (!s.offlineEnabled) return ['Selling offline is switched off. Ask the owner to turn it on in the shop settings.'];
      if (!ctx.device) return ['Selling offline only works on a registered device. Ask the owner or IT for a pairing code.'];
      return [];
    },
    handle: async (_p, ctx) => {
      const s = await loadSettings(ctx.store);
      const device = ctx.device!;
      const at = ctx.clock.now().getTime();
      // One pass per device: a new one closes the old one. Sales made before this moment on the old pass still count.
      for (const old of await ctx.store.find<OfflinePass>('offlinePasses', { where: { deviceId: device.id } })) {
        if (!old.closedAt) await ctx.store.put('offlinePasses', { ...old, closedAt: new Date(at).toISOString() });
      }
      const pass: OfflinePass = {
        id: ctx.ids.next('ofp'),
        userId: ctx.session!.userId,
        userName: ctx.session!.name,
        deviceId: device.id,
        deviceName: device.name,
        issuedAt: new Date(at).toISOString(),
        expiresAt: new Date(at + s.offlinePassHours * HOUR).toISOString(),
        maxSales: s.offlineMaxSales,
        maxTotal: s.offlineMaxTotal,
        nextSeq: 1,
        lastTag: '0'.repeat(64),
        sales: 0,
        total: 0,
      };
      await ctx.store.put('offlinePasses', pass);
      const key = await ctx.passKey(pass.id, pass.userId, pass.deviceId);
      return {
        summary: `Gave "${device.name}" an offline pass until ${pass.expiresAt}`,
        target: pass.id,
        skipSync: true,
        data: { passId: pass.id, key, userId: pass.userId, issuedAt: pass.issuedAt, expiresAt: pass.expiresAt, maxSales: pass.maxSales, maxTotal: pass.maxTotal, serverTime: pass.issuedAt },
      };
    },
  },

  'offline/review': {
    circuit: 'Offline',
    roles: ['owner'],
    validate: async (p, ctx) => {
      const h = await ctx.store.get<HeldAction>('heldActions', p.heldId);
      if (!h) return ['That sale is no longer in the list.'];
      if (h.status !== 'held') return ['That sale has already been dealt with.'];
      if (p.action === 'dismiss' && !p.note?.trim()) return ['Write a short note saying why you are dismissing it.'];
      if (p.action === 'approve' && !(QUEUEABLE as readonly string[]).includes(h.type)) return ['This kind of action cannot be approved. Dismiss it.'];
      return [];
    },
    handle: async (p, ctx) => {
      const h = (await ctx.store.get<HeldAction>('heldActions', p.heldId))!;
      const owner = ctx.session!;
      const note = p.note?.trim() || undefined;
      if (p.action === 'dismiss') {
        await ctx.store.put('heldActions', { ...h, status: 'dismissed' as const, resolvedAt: ctx.now(), resolvedByName: owner.name, note });
        return { summary: `Dismissed an offline sale from ${h.userName} on ${h.deviceName}`, target: h.id, skipSync: true };
      }

      // Run it again as the person who sold it, at today's prices, stamped with the time it really happened.
      // If that person can no longer sell (left, or changed role), the owner's own name goes on it instead.
      const person = await ctx.store.get<Staff>('staff', h.userId);
      const stillSells = !!person && person.active && (OFFLINE_ROLES as readonly string[]).includes(person.role);
      const as = stillSells ? { userId: person!.id, name: person!.name, role: person!.role } : owner;
      const sentAt = Date.parse(h.queuedAt);
      const at = new Date(Math.min(Number.isNaN(sentAt) ? Infinity : sentAt, Date.parse(h.receivedAt), ctx.clock.now().getTime())).toISOString();
      const payload = { ...(h.payload as Record<string, unknown>) };
      delete payload.expectedTotal;
      const res = await ctx.runAs(as, at, h.type as 'orders/quick_sale', payload);
      if (res.failure) {
        throw new DomainError('invalid', [...res.failure.messages, 'If it can no longer be sold, dismiss it with a note.']);
      }
      const data = (res.data ?? {}) as { orderId?: string; number?: string };
      await ctx.store.put('heldActions', { ...h, status: 'approved' as const, resolvedAt: ctx.now(), resolvedByName: owner.name, note, orderId: data.orderId });
      return {
        summary: `Approved an offline sale from ${h.userName} on ${h.deviceName}${data.number ? `: order ${data.number}` : ''}${stillSells ? '' : ' (recorded under the owner, the seller can no longer sell)'}`,
        target: h.id,
        data: { orderId: data.orderId, number: data.number },
        events: res.events,
        warnings: res.warnings,
      };
    },
  },
} satisfies Partial<Registry>;
