import type { Staff } from '../domain';
import { DomainError, type Registry } from '../intents';
import { hashPin } from '../ports';

export const authIntents = {
  'auth/sign_in': {
    circuit: 'Auth',
    roles: 'public',
    validate: (p) => {
      const errors: string[] = [];
      if (!p.userId) errors.push('Choose who is signing in.');
      if (!/^\d{4,6}$/.test(p.pin ?? '')) errors.push('Enter your 4 to 6 digit PIN.');
      return errors;
    },
    handle: async (p, ctx) => {
      const staff = await ctx.store.get<Staff>('staff', p.userId);
      const ok = !!staff && staff.active && staff.pinHash === (await hashPin(staff.id, p.pin));
      if (!ok || !staff) throw new DomainError('forbidden', ['That PIN does not match. Try again.']);
      const session = { userId: staff.id, name: staff.name, role: staff.role };
      const sessionId = ctx.issueSession(session);
      return {
        summary: `${staff.name} signed in`,
        target: staff.id,
        actor: session,
        data: { sessionId, session },
        skipSync: true,
      };
    },
  },
  'auth/sign_out': {
    circuit: 'Auth',
    roles: ['owner', 'cashier', 'baker', 'inventory', 'it'],
    handle: async (_p, ctx) => {
      ctx.endSession(ctx.sessionId);
      return { summary: `${ctx.session?.name ?? 'Someone'} signed out`, skipSync: true };
    },
  },
} satisfies Partial<Registry>;
