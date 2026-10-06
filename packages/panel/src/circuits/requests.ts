import type { Order, Role, Session, Staff, StaffRequest } from '../domain';
import { REQUEST_CATEGORIES } from '../domain';
import type { HandlerCtx, Registry } from '../intents';
import { DomainError } from '../intents';

export const ROLE_LABEL: Record<Role, string> = { owner: 'Owner', cashier: 'Cashier', baker: 'Baker', inventory: 'Inventory', it: 'IT' };
const MAX_OPEN_PER_PERSON = 50;

export const FINAL: StaffRequest['status'][] = ['confirmed', 'withdrawn'];
export const isFinal = (r: Pick<StaffRequest, 'status'>) => FINAL.includes(r.status);

/** Is this request addressed to the person (directly, or through their role)? */
export const isTarget = (r: Pick<StaffRequest, 'toRole' | 'toUserId'>, s: Pick<Session, 'userId' | 'role'>) =>
  r.toUserId ? r.toUserId === s.userId : r.toRole === s.role;

/** The owner sees every request (oversight). Everyone else sees what they sent and what is for them. */
export const canSeeRequest = (r: StaffRequest, s: Pick<Session, 'userId' | 'role'>) => s.role === 'owner' || isTarget(r, s) || r.fromId === s.userId;

export type RequestAction = 'acknowledge' | 'done' | 'decide' | 'confirm' | 'reopen' | 'withdraw';

/**
 * What this person may do with this request right now. The intents check against it and the feed shows it,
 * so the screen can never offer something the server would refuse.
 */
export function requestActions(r: StaffRequest, s: Pick<Session, 'userId' | 'role'>): RequestAction[] {
  if (isFinal(r)) return [];
  const out: RequestAction[] = [];
  const mine = r.fromId === s.userId;
  const forMe = isTarget(r, s);
  const takenByOther = !!r.takenBy && r.takenBy.userId !== s.userId;
  if (forMe && r.choices && r.status !== 'done') out.push('decide');
  if (forMe && !r.choices && ['sent', 'seen'].includes(r.status)) out.push('acknowledge');
  if (forMe && !r.choices && ['sent', 'seen', 'acknowledged'].includes(r.status) && !takenByOther) out.push('done');
  if (mine && r.status === 'done') out.push('confirm', 'reopen');
  if (mine && ['sent', 'seen'].includes(r.status)) out.push('withdraw');
  return out;
}

/** Waiting for this person to act: addressed to them and open, or finished and waiting for their confirmation. */
export function needsPerson(r: StaffRequest, s: Pick<Session, 'userId' | 'role'>): boolean {
  if (isFinal(r)) return false;
  const a = requestActions(r, s);
  return a.includes('decide') || a.includes('acknowledge') || a.includes('done') || a.includes('confirm');
}

async function load(ctx: Pick<HandlerCtx, 'store'>, id: string): Promise<StaffRequest> {
  const r = await ctx.store.get<StaffRequest>('staffRequests', id);
  if (!r) throw new DomainError('invalid', ['That request no longer exists.']);
  return r;
}

const note = (ctx: Pick<HandlerCtx, 'now'>, text: string) => ({ at: ctx.now(), text });
const clean = (t: string | undefined) => t?.trim() || undefined;

function change(ctx: HandlerCtx, r: StaffRequest, patch: Partial<StaffRequest>, text: string): StaffRequest {
  return { ...r, ...patch, updatedAt: ctx.now(), timeline: [...r.timeline, note(ctx, text)] };
}

export const requestIntents = {
  'requests/send': {
    circuit: 'Messages',
    roles: ['owner', 'cashier', 'baker', 'inventory', 'it'],
    validate: async (p, ctx) => {
      const me = ctx.session!;
      const errors: string[] = [];
      if (!!p.toRole === !!p.toUserId) return ['Choose who the request is for: a role or a person.'];
      if (p.toRole && p.toRole === me.role) return ['That is your own role. Choose someone else.'];
      if (p.toUserId) {
        const to = await ctx.store.get<Staff>('staff', p.toUserId);
        if (!to || !to.active) errors.push('That person is not available.');
        else if (to.id === me.userId) errors.push('You cannot send a request to yourself.');
      }
      if (!p.title.trim()) errors.push('Say what the issue is.');
      if (p.tag && p.category !== 'Other') errors.push('A short tag is only for the category "Other".');
      if (p.choices) {
        const labels = p.choices.map((c) => c.trim());
        if (labels.some((c) => !c)) errors.push('Every answer needs some words.');
        if (new Set(labels.map((c) => c.toLowerCase())).size !== labels.length) errors.push('The answers must be different from each other.');
      }
      if (p.orderId && !(await ctx.store.get<Order>('orders', p.orderId))) errors.push('That order does not exist.');
      const open = (await ctx.store.find<StaffRequest>('staffRequests', { where: { fromId: me.userId, status: ['sent', 'seen', 'acknowledged', 'done'] } })).length;
      if (open >= MAX_OPEN_PER_PERSON) errors.push('You have a lot of open requests. Wait for some to be dealt with first.');
      return errors;
    },
    handle: async (p, ctx) => {
      const me = ctx.session!;
      const to = p.toUserId ? (await ctx.store.get<Staff>('staff', p.toUserId))! : undefined;
      const audience: Role = to ? to.role : p.toRole!;
      const r: StaffRequest = {
        id: ctx.ids.next('req'),
        category: p.category,
        tag: p.category === 'Other' ? clean(p.tag) : undefined,
        urgent: !!p.urgent,
        title: p.title.trim(),
        body: clean(p.body),
        link: clean(p.link),
        orderId: p.orderId,
        fromId: me.userId,
        fromName: me.name,
        fromRole: me.role,
        toRole: p.toRole,
        toUserId: p.toUserId,
        toName: to?.name,
        audience,
        choices: p.choices?.map((c) => c.trim()),
        status: 'sent',
        createdAt: ctx.now(),
        updatedAt: ctx.now(),
        seenBy: {},
        timeline: [note(ctx, `${me.name} sent the request`)],
      };
      await ctx.store.put('staffRequests', r);
      return {
        summary: `Sent a${r.urgent ? 'n urgent' : ''} request to ${to?.name ?? ROLE_LABEL[audience]}: ${r.title}`,
        target: r.id,
        data: { requestId: r.id },
        events: [{ type: 'RequestSent', payload: { requestId: r.id, urgent: r.urgent, audience } }],
      };
    },
  },

  'requests/mark_seen': {
    circuit: 'Messages',
    roles: ['owner', 'cashier', 'baker', 'inventory', 'it'],
    validate: async (p, ctx) => {
      const r = await load(ctx, p.requestId);
      return canSeeRequest(r, ctx.session!) ? [] : ['That request is not available.'];
    },
    handle: async (p, ctx) => {
      const me = ctx.session!;
      const r = await load(ctx, p.requestId);
      // Only the people it is for count as having seen it. The sender and the owner looking in do not.
      if (!isTarget(r, me) || r.seenBy[me.userId] || isFinal(r)) return { summary: 'Opened a request (nothing new)', target: r.id };
      const seenBy = { ...r.seenBy, [me.userId]: { name: me.name, at: ctx.now() } };
      await ctx.store.put('staffRequests', change(ctx, r, { seenBy, status: r.status === 'sent' ? 'seen' : r.status }, `${me.name} saw it`));
      return { summary: `Saw a request: ${r.title}`, target: r.id, events: [{ type: 'RequestSeen', payload: { requestId: r.id } }] };
    },
  },

  'requests/acknowledge': {
    circuit: 'Messages',
    roles: ['owner', 'cashier', 'baker', 'inventory', 'it'],
    validate: async (p, ctx) => {
      const r = await load(ctx, p.requestId);
      if (!canSeeRequest(r, ctx.session!)) return ['That request is not available.'];
      if (isFinal(r)) return ['This request is already closed.'];
      if (r.choices) return ['This request needs an answer. Choose one.'];
      if (r.takenBy) return [`${r.takenBy.name} has already taken this.`];
      return requestActions(r, ctx.session!).includes('acknowledge') ? [] : ['Only the people this request is for can take it.'];
    },
    handle: async (p, ctx) => {
      const me = ctx.session!;
      const r = await load(ctx, p.requestId);
      const at = ctx.now();
      const seenBy = { ...r.seenBy, [me.userId]: r.seenBy[me.userId] ?? { name: me.name, at } };
      await ctx.store.put('staffRequests', change(ctx, r, { status: 'acknowledged', seenBy, takenBy: { userId: me.userId, name: me.name, at } }, `${me.name} took it`));
      return { summary: `Took a request: ${r.title}`, target: r.id, events: [{ type: 'RequestAcknowledged', payload: { requestId: r.id } }] };
    },
  },

  'requests/done': {
    circuit: 'Messages',
    roles: ['owner', 'cashier', 'baker', 'inventory', 'it'],
    validate: async (p, ctx) => {
      const r = await load(ctx, p.requestId);
      if (!canSeeRequest(r, ctx.session!)) return ['That request is not available.'];
      if (isFinal(r)) return ['This request is already closed.'];
      if (r.choices) return ['This request needs an answer. Choose one.'];
      if (r.takenBy && r.takenBy.userId !== ctx.session!.userId && isTarget(r, ctx.session!)) return [`${r.takenBy.name} has taken this and will finish it.`];
      return requestActions(r, ctx.session!).includes('done') ? [] : ['You cannot mark this request done.'];
    },
    handle: async (p, ctx) => {
      const me = ctx.session!;
      const r = await load(ctx, p.requestId);
      const at = ctx.now();
      const seenBy = { ...r.seenBy, [me.userId]: r.seenBy[me.userId] ?? { name: me.name, at } };
      const takenBy = r.takenBy ?? { userId: me.userId, name: me.name, at };
      const extra = clean(p.note);
      await ctx.store.put('staffRequests', change(ctx, r, { status: 'done', seenBy, takenBy }, `${me.name} marked it done${extra ? `: ${extra}` : ''}`));
      return { summary: `Marked a request done: ${r.title}`, target: r.id, events: [{ type: 'RequestDone', payload: { requestId: r.id } }] };
    },
  },

  'requests/decide': {
    circuit: 'Messages',
    roles: ['owner', 'cashier', 'baker', 'inventory', 'it'],
    validate: async (p, ctx) => {
      const r = await load(ctx, p.requestId);
      if (!canSeeRequest(r, ctx.session!)) return ['That request is not available.'];
      if (isFinal(r)) return ['This request is already closed.'];
      if (!r.choices) return ['This request has no answers to choose from.'];
      if (!requestActions(r, ctx.session!).includes('decide')) return ['Only the people this request is for can answer it.'];
      if (!r.choices.includes(p.choice)) return ['Choose one of the answers offered.'];
      return [];
    },
    handle: async (p, ctx) => {
      const me = ctx.session!;
      const r = await load(ctx, p.requestId);
      const at = ctx.now();
      const extra = clean(p.note);
      const seenBy = { ...r.seenBy, [me.userId]: r.seenBy[me.userId] ?? { name: me.name, at } };
      await ctx.store.put('staffRequests', change(ctx, r, { status: 'confirmed', outcome: p.choice, seenBy, takenBy: { userId: me.userId, name: me.name, at } }, `${me.name} answered: ${p.choice}${extra ? ` (${extra})` : ''}`));
      return { summary: `Answered "${r.title}": ${p.choice}`, target: r.id, events: [{ type: 'RequestAnswered', payload: { requestId: r.id, choice: p.choice } }] };
    },
  },

  'requests/confirm': {
    circuit: 'Messages',
    roles: ['owner', 'cashier', 'baker', 'inventory', 'it'],
    validate: async (p, ctx) => {
      const r = await load(ctx, p.requestId);
      if (r.fromId !== ctx.session!.userId) return ['Only the person who sent this request can confirm it.'];
      return r.status === 'done' ? [] : ['It can be confirmed once the other person marks it done.'];
    },
    handle: async (p, ctx) => {
      const r = await load(ctx, p.requestId);
      await ctx.store.put('staffRequests', change(ctx, r, { status: 'confirmed' }, `${ctx.session!.name} confirmed it is fixed`));
      return { summary: `Confirmed a request is fixed: ${r.title}`, target: r.id, events: [{ type: 'RequestConfirmed', payload: { requestId: r.id } }] };
    },
  },

  'requests/reopen': {
    circuit: 'Messages',
    roles: ['owner', 'cashier', 'baker', 'inventory', 'it'],
    validate: async (p, ctx) => {
      const r = await load(ctx, p.requestId);
      if (r.fromId !== ctx.session!.userId) return ['Only the person who sent this request can reopen it.'];
      return r.status === 'done' ? [] : ['Only a request marked done can be reopened.'];
    },
    handle: async (p, ctx) => {
      const r = await load(ctx, p.requestId);
      const why = clean(p.reason);
      await ctx.store.put('staffRequests', change(ctx, r, { status: 'acknowledged' }, `${ctx.session!.name} reopened it${why ? `: ${why}` : ''}`));
      return { summary: `Reopened a request: ${r.title}`, target: r.id, events: [{ type: 'RequestReopened', payload: { requestId: r.id } }] };
    },
  },

  'requests/withdraw': {
    circuit: 'Messages',
    roles: ['owner', 'cashier', 'baker', 'inventory', 'it'],
    validate: async (p, ctx) => {
      const r = await load(ctx, p.requestId);
      if (r.fromId !== ctx.session!.userId) return ['Only the person who sent this request can take it back.'];
      return ['sent', 'seen'].includes(r.status) ? [] : ['Someone has already taken it, so it cannot be withdrawn.'];
    },
    handle: async (p, ctx) => {
      const r = await load(ctx, p.requestId);
      await ctx.store.put('staffRequests', change(ctx, r, { status: 'withdrawn' }, `${ctx.session!.name} took the request back`));
      return { summary: `Withdrew a request: ${r.title}`, target: r.id, events: [{ type: 'RequestWithdrawn', payload: { requestId: r.id } }] };
    },
  },
} satisfies Partial<Registry>;

export { REQUEST_CATEGORIES };
