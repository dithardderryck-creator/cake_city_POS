import { beforeEach, describe, expect, it } from 'vitest';
import type { StaffRequest } from './domain';
import { needsPerson, requestActions } from './circuits/requests';
import { createMemoryStore, createPanel, seedDemo, DEMO_STAFF, type AlertInboxData, type DispatchResult, type NavItem, type Panel, type RequestInboxData, type RequestRow, type Staff, type Store } from './index';

let t: number;
const clock = { now: () => new Date(t) };
let store: Store;
let panel: Panel;
let errors: unknown[];

type Role = 'owner' | 'cashier' | 'baker' | 'inventory' | 'it';
const ROLES: Role[] = ['owner', 'cashier', 'baker', 'inventory', 'it'];
const sid: Record<string, string> = {};
const uid: Record<string, string> = {};
async function signIn(role: Role) {
  const pin = DEMO_STAFF.find((s) => s.role === role)!.pin;
  const staff = (await store.list<Staff>('staff')).find((s) => s.role === role)!;
  uid[role] = staff.id;
  const r = await panel.dispatch('auth/sign_in', { userId: staff.id, pin });
  if (!r.ok) throw new Error('sign in failed');
  sid[role] = (r.data as { sessionId: string }).sessionId;
}
const relog = async () => {
  for (const r of ROLES) await signIn(r);
};
const ok = <T = unknown>(r: DispatchResult) => {
  if (!r.ok) throw new Error(`Expected ok, got ${r.error.code}: ${r.error.messages.join(' ')}`);
  return r.data as T;
};
const errOf = (r: DispatchResult) => (r.ok ? '' : r.error.messages.join(' '));
const send = (role: Role, type: Parameters<Panel['dispatch']>[0], payload: Parameters<Panel['dispatch']>[1]) => panel.dispatch(type, payload as never, sid[role]);

const MIN = 60_000;
const HOUR = 3_600_000;
const advance = async (ms: number) => {
  t += ms;
  await relog();
};
const inbox = async (role: Role) => {
  const r = await panel.feed('request_inbox', {}, sid[role]);
  if (!r.ok) throw new Error(r.error.messages.join(' '));
  return r.data as RequestInboxData;
};
const row = async (role: Role, id: string): Promise<RequestRow> => {
  const r = (await inbox(role)).rows.find((x) => x.requestId === id);
  if (!r) throw new Error(`${role} cannot see ${id}`);
  return r;
};
const alerts = async (role: 'owner' | 'cashier' | 'baker' | 'inventory') => {
  const r = await panel.feed('alert_inbox', {}, sid[role]);
  return (r.ok ? (r.data as AlertInboxData).open : []).filter((a) => a.kind === 'request_waiting');
};
const newReq = async (from: Role, extra: Record<string, unknown> = {}) =>
  ok<{ requestId: string }>(await send(from, 'requests/send', { toRole: 'baker', category: 'Order issue', title: 'Customer changed the text', ...extra })).requestId;

beforeEach(async () => {
  t = new Date(2026, 9, 4, 8, 0, 0).getTime();
  errors = [];
  store = createMemoryStore();
  panel = createPanel({ store, clock, onError: (e) => errors.push(e) });
  await seedDemo(store, panel);
  await relog();
});

describe('sending', () => {
  it('sends to a role and shows it to the sender, the role and the owner only', async () => {
    const id = await newReq('cashier');
    for (const who of ['cashier', 'baker', 'owner'] as const) expect((await row(who, id)).title).toBe('Customer changed the text');
    await expect(row('inventory', id)).rejects.toThrow(/cannot see/);
    await expect(row('it', id)).rejects.toThrow(/cannot see/);
    const r = await row('baker', id);
    expect(r).toMatchObject({ status: 'sent', forMe: true, mine: false, needsYou: true, from: { name: expect.stringContaining('Baraka'), role: 'cashier' }, to: { label: 'Baker', role: 'baker' } });
    expect(r.steps).toEqual(['Sent', 'Seen', 'Acknowledged', 'Done', 'Confirmed']);
    expect((await row('cashier', id)).needsYou).toBe(false);
  });

  it('can be sent to one person, and only that person sees it besides the sender and owner', async () => {
    const id = await newReq('cashier', { toRole: undefined, toUserId: uid.inventory });
    expect((await row('inventory', id)).to).toMatchObject({ label: expect.stringContaining('Juma'), userId: uid.inventory });
    await expect(row('baker', id)).rejects.toThrow();
  });

  it('refuses nonsense with a plain reason', async () => {
    const bad = async (extra: Record<string, unknown>) => errOf(await send('cashier', 'requests/send', { toRole: 'baker', category: 'Money', title: 'x', ...extra } as never));
    expect(await bad({ toUserId: uid.baker })).toMatch(/role or a person/);
    expect(await bad({ toRole: undefined })).toMatch(/role or a person/);
    expect(await bad({ toRole: 'cashier' })).toMatch(/your own role/);
    expect(await bad({ toRole: undefined, toUserId: uid.cashier })).toMatch(/yourself/);
    expect(await bad({ toRole: undefined, toUserId: 'nobody' })).toMatch(/not available/);
    expect(await bad({ title: '   ' })).toMatch(/what the issue is/);
    expect(await bad({ tag: 'Parking' })).toMatch(/only for the category "Other"/);
    expect(await bad({ choices: ['Yes', 'yes'] })).toMatch(/different/);
    expect(await bad({ choices: ['Yes', ' '] })).toMatch(/some words/);
    expect(await bad({ orderId: 'ord_nope' })).toMatch(/order does not exist/);
    expect(errOf(await send('cashier', 'requests/send', { toRole: 'baker', category: 'Nonsense', title: 'x' } as never))).toBeTruthy();
    expect((await inbox('cashier')).rows).toHaveLength(0);
  });

  it('shows the short tag for "Other"', async () => {
    const id = await newReq('cashier', { category: 'Other', tag: ' Parking ' });
    expect((await row('baker', id)).category).toBe('Parking');
  });

  it('lets IT receive requests, but does not raise phone alerts for them', async () => {
    const id = await newReq('cashier', { toRole: 'it', category: 'System error', urgent: true });
    expect((await row('it', id)).needsYou).toBe(true);
    await advance(HOUR);
    expect((await alerts('cashier')).length + (await alerts('baker')).length + (await alerts('inventory')).length).toBe(0);
  });
});

describe('the lifecycle', () => {
  it('goes sent, seen, taken, done, confirmed, and says who did what', async () => {
    const id = await newReq('cashier');
    ok(await send('baker', 'requests/mark_seen', { requestId: id }));
    let r = await row('cashier', id);
    expect(r).toMatchObject({ status: 'seen', step: 1 });
    expect(r.seenBy).toEqual([expect.stringContaining('Neema')]);
    ok(await send('baker', 'requests/acknowledge', { requestId: id }));
    r = await row('baker', id);
    expect(r).toMatchObject({ status: 'acknowledged', step: 2, takenByName: expect.stringContaining('Neema'), actions: ['done'] });
    expect((await row('cashier', id)).needsYou).toBe(false);
    ok(await send('baker', 'requests/done', { requestId: id, note: 'Changed it' }));
    r = await row('cashier', id);
    expect(r).toMatchObject({ status: 'done', step: 3, needsYou: true, actions: ['confirm', 'reopen'] });
    ok(await send('cashier', 'requests/confirm', { requestId: id }));
    r = await row('cashier', id);
    expect(r).toMatchObject({ status: 'confirmed', final: true, step: 4, actions: [], needsYou: false });
    expect(r.timeline.map((x) => x.text)).toEqual([
      expect.stringContaining('sent the request'),
      expect.stringContaining('saw it'),
      expect.stringContaining('took it'),
      expect.stringContaining('marked it done: Changed it'),
      expect.stringContaining('confirmed it is fixed'),
    ]);
    expect(errors).toEqual([]);
  });

  it('counts only the people it is for as having seen it', async () => {
    const id = await newReq('cashier');
    ok(await send('owner', 'requests/mark_seen', { requestId: id }));
    ok(await send('cashier', 'requests/mark_seen', { requestId: id }));
    expect(await row('baker', id)).toMatchObject({ status: 'sent', seenBy: [] });
    ok(await send('baker', 'requests/mark_seen', { requestId: id }));
    ok(await send('baker', 'requests/mark_seen', { requestId: id }));
    expect((await row('baker', id)).seenBy).toHaveLength(1);
    expect(errOf(await send('inventory', 'requests/mark_seen', { requestId: id }))).toMatch(/not available/);
  });

  it('lets one person take it: nobody else can, and only they can finish it', async () => {
    const id = await newReq('cashier', { toRole: 'inventory' });
    ok(await send('inventory', 'requests/acknowledge', { requestId: id }));
    expect(errOf(await send('inventory', 'requests/acknowledge', { requestId: id }))).toMatch(/already taken/);
    expect(errOf(await send('baker', 'requests/acknowledge', { requestId: id }))).toMatch(/not available/);
    expect(errOf(await send('owner', 'requests/acknowledge', { requestId: id }))).toMatch(/already taken/);
    expect((await row('owner', id)).actions).toEqual([]);
  });

  it('refuses to be done by someone it is not for, or confirmed by someone who did not send it', async () => {
    const id = await newReq('cashier');
    expect(errOf(await send('owner', 'requests/done', { requestId: id }))).toMatch(/cannot mark/);
    expect(errOf(await send('cashier', 'requests/confirm', { requestId: id }))).toMatch(/once the other person marks it done/);
    ok(await send('baker', 'requests/done', { requestId: id }));
    expect(errOf(await send('baker', 'requests/confirm', { requestId: id }))).toMatch(/Only the person who sent/);
    expect(errOf(await send('owner', 'requests/confirm', { requestId: id }))).toMatch(/Only the person who sent/);
    expect((await row('baker', id)).takenByName).toContain('Neema'); // finishing it directly also takes it
  });

  it('can be reopened by the sender after "done", and then needs the baker again', async () => {
    const id = await newReq('cashier');
    ok(await send('baker', 'requests/done', { requestId: id }));
    ok(await send('cashier', 'requests/reopen', { requestId: id, reason: 'Still wrong' }));
    const r = await row('baker', id);
    expect(r).toMatchObject({ status: 'acknowledged', needsYou: true, actions: ['done'] });
    expect(r.timeline.at(-1)!.text).toMatch(/reopened it: Still wrong/);
    expect(errOf(await send('cashier', 'requests/reopen', { requestId: id }))).toMatch(/marked done/);
  });

  it('can be taken back only before anyone takes it', async () => {
    const a = await newReq('cashier');
    const b = await newReq('cashier');
    ok(await send('baker', 'requests/mark_seen', { requestId: a }));
    ok(await send('cashier', 'requests/withdraw', { requestId: a }));
    expect(await row('cashier', a)).toMatchObject({ status: 'withdrawn', final: true });
    ok(await send('baker', 'requests/acknowledge', { requestId: b }));
    expect(errOf(await send('cashier', 'requests/withdraw', { requestId: b }))).toMatch(/already taken/);
    expect(errOf(await send('baker', 'requests/withdraw', { requestId: b }))).toMatch(/Only the person who sent/);
    expect(errOf(await send('baker', 'requests/acknowledge', { requestId: a }))).toMatch(/closed/);
  });

  it('puts a closed request out of the open count', async () => {
    const id = await newReq('cashier');
    expect((await inbox('baker')).counts).toEqual({ needsYou: 1, open: 1 });
    ok(await send('baker', 'requests/done', { requestId: id }));
    ok(await send('cashier', 'requests/confirm', { requestId: id }));
    expect((await inbox('baker')).counts).toEqual({ needsYou: 0, open: 0 });
    expect((await inbox('baker')).rows).toHaveLength(1);
  });
});

describe('questions with answers to choose from', () => {
  const ask = () => newReq('inventory', { toRole: 'owner', category: 'Approval', title: 'Restock butter, 40 kg', choices: ['Approve', 'Not now'], urgent: false });

  it('is answered by the owner, which closes it and shows the outcome to the sender', async () => {
    const id = await ask();
    expect(await row('owner', id)).toMatchObject({ actions: ['decide'], needsYou: true, steps: ['Sent', 'Seen', 'Answered'], choices: ['Approve', 'Not now'] });
    expect(errOf(await send('owner', 'requests/acknowledge', { requestId: id }))).toMatch(/needs an answer/);
    expect(errOf(await send('owner', 'requests/done', { requestId: id }))).toMatch(/needs an answer/);
    expect(errOf(await send('owner', 'requests/decide', { requestId: id, choice: 'Maybe' }))).toMatch(/one of the answers/);
    expect(errOf(await send('inventory', 'requests/decide', { requestId: id, choice: 'Approve' }))).toMatch(/Only the people/);
    expect(errOf(await send('baker', 'requests/decide', { requestId: id, choice: 'Approve' }))).toMatch(/not available/);
    ok(await send('owner', 'requests/decide', { requestId: id, choice: 'Approve', note: 'Use the usual supplier' }));
    const r = await row('inventory', id);
    expect(r).toMatchObject({ status: 'confirmed', outcome: 'Approve', final: true, step: 2, statusLabel: 'Answered: Approve', actions: [] });
    expect(r.timeline.at(-1)!.text).toMatch(/answered: Approve \(Use the usual supplier\)/);
    expect(errOf(await send('owner', 'requests/decide', { requestId: id, choice: 'Approve' }))).toMatch(/closed/);
  });

  it('can be withdrawn by the sender while unanswered', async () => {
    const id = await ask();
    ok(await send('inventory', 'requests/withdraw', { requestId: id }));
    expect((await row('owner', id)).status).toBe('withdrawn');
  });
});

describe('the menu badge', () => {
  it('counts what is waiting for you, and what you must confirm', async () => {
    const nav = async (role: Role) => {
      const r = await panel.feed('navigation', {}, sid[role]);
      return (r.ok ? (r.data as NavItem[]) : []).find((i) => i.id === 'requests');
    };
    expect(await nav('baker')).toEqual({ id: 'requests', label: 'Requests' });
    const id = await newReq('cashier');
    expect((await nav('baker'))!.badge).toBe(1);
    expect((await nav('owner'))!.badge).toBeUndefined();
    ok(await send('baker', 'requests/done', { requestId: id }));
    expect((await nav('baker'))!.badge).toBeUndefined();
    expect((await nav('cashier'))!.badge).toBe(1);
  });
});

describe('escalation through alerts', () => {
  it('alerts the people an urgent request is for at once, and the owner (critical) after 15 minutes', async () => {
    const id = await newReq('cashier', { urgent: true, title: 'Oven is not heating' });
    expect((await alerts('baker')).map((a) => a.title)).toEqual(['Urgent: Oven is not heating']);
    expect(await alerts('owner')).toHaveLength(1); // owners see every alert
    const before = await row('baker', id);
    expect(before).toMatchObject({ urgent: true, escalated: false });
    expect(Date.parse(before.escalatesAt!) - Date.parse(before.createdAt)).toBe(15 * MIN);
    expect((await alerts('owner')).filter((a) => a.severity === 'critical')).toHaveLength(0);

    await advance(16 * MIN);
    await send('owner', 'requests/mark_seen', { requestId: id }); // any change re-checks alerts
    const owner = await alerts('owner');
    expect(owner.map((a) => a.title)).toContain('Nobody has taken: Oven is not heating');
    expect(owner.find((a) => a.title.startsWith('Nobody'))).toMatchObject({ severity: 'critical', to: ['owner'] });
    expect((await row('owner', id)).escalated).toBe(true);
  });

  it('stays quiet for an ordinary request until it has waited, then tells the team, then the owner', async () => {
    const id = await newReq('cashier');
    expect(await alerts('baker')).toHaveLength(0);
    await advance(4 * HOUR + MIN);
    await send('cashier', 'requests/mark_seen', { requestId: id });
    expect((await alerts('baker')).map((a) => a.title)).toEqual(['Customer changed the text']);
    expect((await alerts('baker'))[0]!.severity).toBe('warning');
    expect((await alerts('owner')).filter((a) => a.title.startsWith('Nobody'))).toHaveLength(0);
    await advance(4 * HOUR);
    await send('cashier', 'requests/mark_seen', { requestId: id });
    expect((await alerts('owner')).filter((a) => a.title.startsWith('Nobody'))).toHaveLength(1);
  });

  it('clears the alerts when someone takes the request', async () => {
    const id = await newReq('cashier', { urgent: true });
    expect(await alerts('baker')).toHaveLength(1);
    ok(await send('baker', 'requests/acknowledge', { requestId: id }));
    expect(await alerts('baker')).toHaveLength(0);
    expect(await alerts('owner')).toHaveLength(0);
    expect((await row('baker', id)).escalatesAt).toBeUndefined();
  });

  it('alerts the owner straight away for an urgent request addressed to the owner, and takes it back when withdrawn', async () => {
    const id = await newReq('baker', { toRole: 'owner', urgent: true, title: 'Gas smell in the kitchen', category: 'Safety and hygiene' });
    const a = await alerts('owner');
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ title: 'Urgent: Gas smell in the kitchen', severity: 'critical' });
    expect((await row('owner', id)).escalatesAt).toBeUndefined();
    ok(await send('baker', 'requests/withdraw', { requestId: id }));
    expect(await alerts('owner')).toHaveLength(0);
  });

  it('follows the owner\'s timing settings', async () => {
    ok(await send('owner', 'alerts/configure', { urgentRequestMinutes: 5, requestWaitHours: 1 }));
    expect(errOf(await send('owner', 'alerts/configure', { urgentRequestMinutes: 0 }))).toBeTruthy();
    const id = await newReq('cashier', { urgent: true });
    expect(Date.parse((await row('baker', id)).escalatesAt!) - t).toBe(5 * MIN);
    const normal = await newReq('cashier', { title: 'Another' });
    expect(Date.parse((await row('baker', normal)).escalatesAt!) - t).toBe(2 * HOUR);
    const s = await panel.feed('alert_settings', {}, sid.owner);
    expect(s.ok && s.data).toMatchObject({ urgentRequestMinutes: 5, requestWaitHours: 1 });
  });
});

describe('ordering and limits', () => {
  it('lists urgent open requests first, then newest, then recently closed', async () => {
    const a = await newReq('cashier', { title: 'A', urgent: true });
    await advance(MIN);
    await newReq('cashier', { title: 'B' });
    await advance(MIN);
    await newReq('cashier', { title: 'C' });
    await advance(MIN);
    const d = await newReq('cashier', { title: 'D' });
    ok(await send('baker', 'requests/done', { requestId: d }));
    ok(await send('cashier', 'requests/confirm', { requestId: d }));
    expect((await inbox('owner')).rows.map((r) => r.title)).toEqual(['A', 'C', 'B', 'D']);
    expect(a).toBeTruthy();
  });

  it('does not offer "done" to a second person with the same role once someone has taken it', async () => {
    const id = await newReq('cashier');
    ok(await send('baker', 'requests/acknowledge', { requestId: id }));
    const r = (await store.get<StaffRequest>('staffRequests', id))!;
    expect(requestActions(r, { userId: uid.baker!, role: 'baker' })).toEqual(['done']);
    expect(requestActions(r, { userId: 'another-baker', role: 'baker' })).toEqual([]);
    expect(needsPerson(r, { userId: 'another-baker', role: 'baker' })).toBe(false);
  });

  it('stops one person from flooding the inbox', async () => {
    for (let i = 0; i < 50; i++) await newReq('cashier', { title: `n${i}` });
    expect(errOf(await send('cashier', 'requests/send', { toRole: 'baker', category: 'Money', title: 'one more' }))).toMatch(/lot of open requests/);
  });

  it('does not allow a signed-out visitor, and records the audit trail', async () => {
    const r = await panel.dispatch('requests/send', { toRole: 'baker', category: 'Money', title: 'x' } as never, undefined);
    expect(r.ok).toBe(false);
    await newReq('cashier');
    const audit = await panel.feed('audit_view', {}, sid.owner);
    expect(audit.ok && (audit.data as { intent: string }[]).some((a) => a.intent === 'requests/send')).toBe(true);
  });
});
