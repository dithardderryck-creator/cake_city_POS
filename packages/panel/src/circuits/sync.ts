import type { OutboxItem } from '../domain';
import type { Registry } from '../intents';

export const syncIntents = {
  'sync/flush': {
    circuit: 'Sync',
    roles: ['owner', 'it'],
    handle: async (_p, ctx) => {
      const items = (await ctx.store.list<OutboxItem>('outbox')).filter((i) => i.status === 'pending');
      const terminal = ctx.terminals.sync;
      if (items.length === 0) return { summary: 'Everything is already synced', skipSync: true, data: { sent: 0 } };
      if (!terminal) {
        return {
          summary: 'No sync connection is set up yet',
          skipSync: true,
          data: { sent: 0 },
          warnings: [`${items.length} items are waiting. They stay safe on this device.`],
        };
      }
      if (!terminal.isOnline()) {
        return {
          summary: 'Offline',
          skipSync: true,
          data: { sent: 0 },
          warnings: [`${items.length} items are waiting and will send when the connection returns.`],
        };
      }
      await terminal.push(items);
      for (const i of items) await ctx.store.put('outbox', { ...i, status: 'sent' as const, attempts: i.attempts + 1 });
      return { summary: `Synced ${items.length} items`, skipSync: true, data: { sent: items.length } };
    },
  },
} satisfies Partial<Registry>;
