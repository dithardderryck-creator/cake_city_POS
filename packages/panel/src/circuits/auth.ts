import type { Staff } from '../domain';
import type { Registry } from '../intents';
import { checkPin } from './pin';

const PIN = /^\d{4,6}$/;

export const authIntents = {
  'auth/sign_in': {
    circuit: 'Auth',
    roles: 'public',
    validate: (p) => {
      const errors: string[] = [];
      if (!PIN.test(p.pin)) errors.push('Enter your 4 to 6 digit PIN.');
      return errors;
    },
    handle: async (p, ctx) => {
      const staff = await ctx.store.get<Staff>('staff', p.userId);
      const check = await checkPin(ctx, staff, p.userId, p.pin);
      if (!check.ok || !staff) {
        return {
          summary: `Sign-in refused for ${staff?.name ?? 'an unknown person'}`,
          target: p.userId,
          failure: { code: 'forbidden', messages: [check.ok ? 'That PIN does not match. Try again.' : check.message] },
          skipSync: true,
        };
      }
      const session = { userId: staff.id, name: staff.name, role: staff.role };
      const sessionId = await ctx.issueSession(session);
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
      await ctx.endSession(ctx.sessionId);
      return { summary: `${ctx.session?.name ?? 'Someone'} signed out`, skipSync: true };
    },
  },

  'auth/change_pin': {
    circuit: 'Auth',
    roles: ['owner', 'cashier', 'baker', 'inventory', 'it'],
    validate: (p) => {
      const errors: string[] = [];
      if (!PIN.test(p.newPin)) errors.push('The new PIN must be 4 to 6 digits.');
      if (p.newPin === p.currentPin) errors.push('Choose a PIN that is different from the current one.');
      return errors;
    },
    handle: async (p, ctx) => {
      const me = ctx.session!;
      const staff = await ctx.store.get<Staff>('staff', me.userId);
      const check = await checkPin(ctx, staff, me.userId, p.currentPin);
      if (!check.ok || !staff) {
        return {
          summary: `${me.name} entered a wrong current PIN while changing it`,
          target: me.userId,
          failure: { code: 'forbidden', messages: [check.ok ? 'That PIN does not match.' : check.message] },
          skipSync: true,
        };
      }
      await ctx.store.put('staff', { ...staff, pinHash: await ctx.hasher.hash(staff.id, p.newPin) });
      // Any other device signed in as this person is signed out. This one stays.
      await ctx.revokeSessions(staff.id, ctx.sessionId);
      return { summary: `${me.name} changed their PIN`, target: staff.id };
    },
  },
} satisfies Partial<Registry>;
