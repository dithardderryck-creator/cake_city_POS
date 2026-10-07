import { beforeEach, describe, expect, it } from 'vitest';
import type { Announcement, AuditEntry } from './domain';
import { createMemoryStore, createPanel, seedDemo, DEMO_STAFF, type AnnouncementsData, type DispatchResult, type Panel, type Staff, type Store } from './index';

let t: number;
const clock = { now: () => new Date(t) };
let store: Store;
let panel: Panel;

type Role = 'owner' | 'cashier' | 'baker' | 'inventory' | 'it';
const ROLES: Role[] = ['owner', 'cashier', 'baker', 'inventory', 'it'];
const sid: Record<string, string> = {};
const uid: Record<string, string> = {};
const ok = <T = unknown>(r: DispatchResult) => {
  if (!r.ok) throw new Error(`Expected ok, got ${r.error.code}: ${r.error.messages.join(' ')}`);
  return r.data as T;
};
const errOf = (r: DispatchResult) => (r.ok ? '' : r.error.messages.join(' '));
const send = (role: Role, type: Parameters<Panel['dispatch']>[0], payload: Parameters<Panel['dispatch']>[1]) => panel.dispatch(type, payload as never, sid[role]);
const feed = async (role: Role) => {
  const r = await panel.feed('announcements', {}, sid[role]);
  if (!r.ok) throw new Error(r.error.messages.join(' '));
  return r.data as AnnouncementsData;
};
const post = async (text = 'Closing early on Friday', requiresAck = true) => ok<{ announcementId: string }>(await send('owner', 'announcements/post', { text, requiresAck })).announcementId;

beforeEach(async () => {
  t = new Date(2026, 9, 4, 8, 0, 0).getTime();
  store = createMemoryStore();
  panel = createPanel({ store, clock });
  await seedDemo(store, panel);
  for (const role of ROLES) {
    const pin = DEMO_STAFF.find((s) => s.role === role)!.pin;
    const staff = (await store.list<Staff>('staff')).find((s) => s.role === role)!;
    uid[role] = staff.id;
    sid[role] = ok<{ sessionId: string }>(await panel.dispatch('auth/sign_in', { userId: staff.id, pin })).sessionId;
  }
});

describe('announcements', () => {
  it('only the owner can post, and an empty one is refused', async () => {
    for (const r of ['cashier', 'baker', 'inventory', 'it'] as const) expect((await send(r, 'announcements/post', { text: 'Hi' })).ok).toBe(false);
    expect(errOf(await send('owner', 'announcements/post', { text: '   ' }))).toMatch(/Write the announcement/);
    expect((await feed('cashier')).rows).toHaveLength(0);
  });

  it('every role sees a posted announcement, newest first, and only the owner can post from the feed', async () => {
    await post('First');
    t += 60_000;
    await post('Second', false);
    for (const r of ROLES) {
      const f = await feed(r);
      expect(f.rows.map((x) => x.text)).toEqual(['Second', 'First']);
      expect(f.can.post).toBe(r === 'owner');
    }
  });

  it('a person who has not opened it has it unseen; opening it clears that; it does not need to be opened twice', async () => {
    const id = await post('Hello', false);
    expect(await feed('baker')).toMatchObject({ unseen: 1, needAck: 0 });
    ok(await send('baker', 'announcements/mark_seen', { announcementId: id }));
    ok(await send('baker', 'announcements/mark_seen', { announcementId: id }));
    expect(await feed('baker')).toMatchObject({ unseen: 0 });
    expect((await feed('cashier')).unseen).toBe(1);
  });

  it('acknowledging counts as reading and clears the need to acknowledge', async () => {
    const id = await post();
    expect((await feed('cashier')).rows[0]).toMatchObject({ requiresAck: true, needsAck: true, seenByMe: false });
    ok(await send('cashier', 'announcements/acknowledge', { announcementId: id }));
    const r = (await feed('cashier')).rows[0];
    expect(r).toMatchObject({ needsAck: false, ackedByMe: true, seenByMe: true });
    expect((await feed('cashier')).needAck).toBe(0);
    expect((await feed('baker')).needAck).toBe(1);
  });

  it('refuses to acknowledge one that does not ask for it, and the owner does not acknowledge their own', async () => {
    const id = await post('Just so you know', false);
    expect(errOf(await send('cashier', 'announcements/acknowledge', { announcementId: id }))).toMatch(/does not ask/);
    expect((await send('owner', 'announcements/acknowledge', { announcementId: id })).ok).toBe(false);
  });

  it('the owner sees who has read and who has acknowledged, but the owner opening it counts for nothing', async () => {
    const id = await post();
    ok(await send('owner', 'announcements/mark_seen', { announcementId: id }));
    ok(await send('baker', 'announcements/mark_seen', { announcementId: id }));
    ok(await send('cashier', 'announcements/acknowledge', { announcementId: id }));
    const r = (await feed('owner')).rows[0];
    const by = (role: string) => r.readers!.find((x) => x.role === role)!;
    expect(r.readers!.map((x) => x.role).sort()).toEqual(['baker', 'cashier', 'inventory', 'it']);
    expect(by('baker')).toMatchObject({ seen: true, acked: false });
    expect(by('cashier')).toMatchObject({ seen: true, acked: true });
    expect(by('inventory')).toMatchObject({ seen: false, acked: false });
    expect(r.progress).toBe('1 of 4 acknowledged');
    expect((await feed('owner')).unseen).toBe(0);
    // Staff never see each other's status.
    expect((await feed('baker')).rows[0].readers).toBeUndefined();
  });

  it('progress for an announcement without acknowledgement counts who has read it', async () => {
    const id = await post('FYI', false);
    ok(await send('it', 'announcements/mark_seen', { announcementId: id }));
    expect((await feed('owner')).rows[0].progress).toBe('1 of 4 have read it');
  });

  it('people who are no longer active are not counted as readers', async () => {
    await post();
    ok(await send('owner', 'staff/set_active', { userId: uid.it, active: false }));
    const r = (await feed('owner')).rows[0];
    expect(r.readers!.map((x) => x.role)).not.toContain('it');
    expect(r.progress).toBe('0 of 3 acknowledged');
  });

  it('the owner can take one down, and then nobody sees it or can acknowledge it', async () => {
    const id = await post();
    ok(await send('owner', 'announcements/retire', { announcementId: id }));
    for (const r of ROLES) expect((await feed(r)).rows).toHaveLength(0);
    expect((await send('cashier', 'announcements/acknowledge', { announcementId: id })).ok).toBe(false);
    expect((await send('cashier', 'announcements/mark_seen', { announcementId: id })).ok).toBe(false);
    expect(errOf(await send('owner', 'announcements/retire', { announcementId: id }))).toMatch(/already down/);
    expect((await send('cashier', 'announcements/retire', { announcementId: id })).ok).toBe(false);
  });

  it('is limited to 20 up at once', async () => {
    for (let i = 0; i < 20; i++) await post(`n${i}`, false);
    expect(errOf(await send('owner', 'announcements/post', { text: 'one more' }))).toMatch(/Take some down/);
  });

  it('is written to the audit log with the person who did it', async () => {
    const id = await post();
    ok(await send('baker', 'announcements/acknowledge', { announcementId: id }));
    const audit = await store.list<AuditEntry>('audit');
    expect(audit.some((a) => a.intent === 'announcements/post' && a.actorId === uid.owner && a.outcome === 'ok')).toBe(true);
    expect(audit.some((a) => a.intent === 'announcements/acknowledge' && a.actorId === uid.baker && a.outcome === 'ok')).toBe(true);
  });

  it('the owner is never asked to acknowledge, and opening it as owner leaves no mark', async () => {
    const id = await post();
    ok(await send('owner', 'announcements/mark_seen', { announcementId: id }));
    expect((await feed('owner')).rows[0]).toMatchObject({ needsAck: false, seenByMe: false });
    expect((await feed('owner')).needAck).toBe(0);
    const stored = await store.get<Announcement>('announcements', id);
    expect(stored!.seenBy).toEqual({});
  });

  it('acknowledging after reading keeps the time it was first read', async () => {
    const id = await post();
    ok(await send('baker', 'announcements/mark_seen', { announcementId: id }));
    const first = (await store.get<Announcement>('announcements', id))!.seenBy[uid.baker].at;
    t += 3_600_000;
    ok(await send('baker', 'announcements/acknowledge', { announcementId: id }));
    const after = (await store.get<Announcement>('announcements', id))!;
    expect(after.seenBy[uid.baker].at).toBe(first);
    expect(after.ackedBy[uid.baker].at).not.toBe(first);
  });
});
