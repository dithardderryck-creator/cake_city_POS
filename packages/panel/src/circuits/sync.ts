import { flushChanges, queueFullCopy } from '../changelog';
import type { Registry } from '../intents';

const explain = (r: Awaited<ReturnType<typeof flushChanges>>) => {
  const wait = r.pending ? [`${r.pending} changes are waiting and stay safe on this device.`] : [];
  switch (r.state) {
    case 'sent':
      return { summary: `Sent ${r.sent} changes to the online database`, warnings: [] as string[] };
    case 'nothing':
      return { summary: 'The online database is up to date', warnings: [] as string[] };
    case 'not_set_up':
      return { summary: 'No online database is connected yet', warnings: wait };
    case 'offline':
      return { summary: 'Offline', warnings: wait.map((w) => `${w} They will send when the connection returns.`) };
    case 'failed':
      return { summary: 'The online database did not accept the changes', warnings: [r.error ? `It said: ${r.error}` : 'No reason was given.', ...wait, 'Nothing is lost; it will try again.'] };
  }
};

export const syncIntents = {
  'sync/flush': {
    circuit: 'Sync',
    roles: ['owner', 'it'],
    handle: async (_p, ctx) => {
      const r = await flushChanges(ctx.store, ctx.terminals.sync);
      const e = explain(r);
      return { summary: e.summary, skipSync: true, data: { sent: r.sent, pending: r.pending, state: r.state }, ...(e.warnings.length ? { warnings: e.warnings } : {}) };
    },
  },

  'sync/full_copy': {
    circuit: 'Sync',
    roles: ['owner', 'it'],
    handle: async (_p, ctx) => {
      const queued = await queueFullCopy(ctx.store, ctx.now);
      return { summary: `Queued everything (${queued} records) for the online database`, skipSync: true, data: { queued } };
    },
  },
} satisfies Partial<Registry>;
