import type { Maintenance, Staff } from '../domain';
import type { Registry } from '../intents';
import type { Store } from '../ports';

/** What stops while selling is paused. Making things, counting stock and paying out refunds carry on. */
export const SELLING_INTENTS: ReadonlySet<string> = new Set([
  'orders/create_order',
  'orders/quick_sale',
  'orders/add_catalogue_line',
  'orders/add_custom_line',
  'payments/record_payment',
]);

export const loadMaintenance = async (store: Pick<Store, 'get'>): Promise<Maintenance | null> => {
  const m = await store.get<Maintenance>('maintenance', 'state');
  return m?.on ? m : null;
};

export const pausedMessage = (m: Maintenance) => `Selling is paused${m.message ? `: ${m.message}` : ''}. Your sales are not lost. Try again when it is over.`;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export const opsIntents = {
  'sessions/end': {
    circuit: 'Operations',
    roles: ['it'],
    validate: async (p, ctx) => {
      const who = await ctx.store.get<Staff>('staff', p.userId);
      if (!who || who.removedAt) return ['That person no longer exists.'];
      if (p.userId === ctx.session!.userId) return ['That is you. Use Sign out in the menu.'];
      const live = (await ctx.store.find<{ id: string; expiresAt: string }>('sessions', { where: { userId: p.userId } })).filter((s) => Date.parse(s.expiresAt) > ctx.clock.now().getTime());
      return live.length ? [] : [`${who.name} is not signed in anywhere.`];
    },
    preview: async (p, ctx) => {
      const who = (await ctx.store.get<Staff>('staff', p.userId))!;
      const live = (await ctx.store.find<{ id: string; expiresAt: string; deviceId?: string }>('sessions', { where: { userId: p.userId } })).filter((s) => Date.parse(s.expiresAt) > ctx.clock.now().getTime());
      const devs = await ctx.store.list<{ id: string; name: string }>('devices');
      const names = [...new Set(live.map((s) => devs.find((d) => d.id === s.deviceId)?.name).filter((n): n is string => !!n))];
      return {
        lines: [`Signs ${who.name} out of ${plural(live.length, 'sign-in', 'sign-ins')}.`, ...(names.length ? [`Devices: ${names.join(', ')}.`] : []), 'Nothing they already sent is lost. They can sign in again with their PIN.'],
      };
    },
    handle: async (p, ctx) => {
      const who = (await ctx.store.get<Staff>('staff', p.userId))!;
      const n = (await ctx.store.find('sessions', { where: { userId: p.userId } })).length;
      await ctx.revokeSessions(p.userId);
      return { summary: `Signed ${who.name} out of ${plural(n, 'sign-in', 'sign-ins')}`, target: who.id, data: { ended: n } };
    },
  },

  'maintenance/set': {
    circuit: 'Operations',
    roles: ['it', 'owner'],
    validate: async (p, ctx) => {
      const on = !!(await loadMaintenance(ctx.store));
      if (p.on === on) return [on ? 'Selling is already paused.' : 'Selling is not paused.'];
      if (p.on && (p.message ?? '').length > 140) return ['Keep the message under 140 characters.'];
      return [];
    },
    preview: (p) => ({
      lines: p.on
        ? ['Stops new sales and payments on every till that can reach the server.', 'A notice appears on every screen. Making things, stock and counts carry on.', 'Sales made offline wait on the till and are sent when selling resumes.']
        : ['Selling starts again on every till. Waiting offline sales are sent.'],
    }),
    handle: async (p, ctx) => {
      const msg = (p.message ?? '').trim() || null;
      const cur = await ctx.store.get<Maintenance>('maintenance', 'state');
      await ctx.store.put<Maintenance>('maintenance', {
        id: 'state',
        on: p.on,
        message: p.on ? msg : null,
        since: p.on ? ctx.now() : (cur?.since ?? ctx.now()),
        byName: ctx.session!.name,
      });
      return { summary: p.on ? `Paused selling${msg ? `: ${msg}` : ''}` : 'Selling resumed' };
    },
  },

  'account/ack_notice': {
    circuit: 'Staff',
    roles: ['owner'],
    handle: async (_p, ctx) => {
      const me = (await ctx.store.get<Staff>('staff', ctx.session!.userId))!;
      if (me.itChange) {
        const { itChange: _gone, ...rest } = me;
        await ctx.store.put<Staff>('staff', rest);
      }
      return { summary: 'Saw the note about the change to the account', target: me.id, skipSync: true };
    },
  },
} satisfies Partial<Registry>;
