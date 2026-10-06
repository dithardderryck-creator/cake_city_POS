import { describe, expect, it } from 'vitest';
import { createMemoryStore, createPanel, type OutboxItem } from './index';

describe('housekeeping of the outbox', () => {
  it('drops week-old sync rows, keeps recent ones and unsent notifications', async () => {
    const now = new Date('2026-10-06T12:00:00Z');
    const store = createMemoryStore();
    const panel = createPanel({ store, clock: { now: () => now } });
    const row = (id: string, kind: OutboxItem['kind'], daysAgo: number): OutboxItem => ({ id, kind, payload: {}, createdAt: new Date(now.getTime() - daysAgo * 86_400_000).toISOString(), attempts: 0, status: 'pending' });
    for (const r of [row('old-sync', 'sync', 8), row('new-sync', 'sync', 2), row('old-notify', 'notify', 30)]) await store.put('outbox', r);
    const r = await panel.maintain();
    expect(r.syncPruned).toBe(1);
    expect((await store.list<OutboxItem>('outbox')).map((o) => o.id).sort()).toEqual(['new-sync', 'old-notify']);
  });
});
