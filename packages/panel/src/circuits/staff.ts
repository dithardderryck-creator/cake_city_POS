import type { PushSubscriptionRecord, Staff } from '../domain';
import { DomainError, type Registry } from '../intents';

const PIN = /^\d{4,6}$/;

export const staffIntents = {
  'staff/create': {
    circuit: 'Staff',
    roles: ['owner'],
    validate: async (p, ctx) => {
      const errors: string[] = [];
      if (!p.name.trim()) errors.push('Enter the person’s name.');
      if (!PIN.test(p.pin)) errors.push('The PIN must be 4 to 6 digits.');
      const all = await ctx.store.list<Staff>('staff');
      if (all.some((s) => s.active && s.name.toLowerCase() === p.name.trim().toLowerCase()))
        errors.push('Someone with that name already works here.');
      return errors;
    },
    handle: async (p, ctx) => {
      const id = ctx.ids.next('stf');
      const staff: Staff = { id, name: p.name.trim(), role: p.role, pinHash: await ctx.hasher.hash(id, p.pin), active: true };
      await ctx.store.put('staff', staff);
      return { summary: `Added ${staff.name} as ${staff.role}`, target: id, data: { userId: id } };
    },
  },

  'staff/set_pin': {
    circuit: 'Staff',
    roles: ['owner'],
    validate: (p) => (PIN.test(p.pin) ? [] : ['The PIN must be 4 to 6 digits.']),
    handle: async (p, ctx) => {
      const staff = await ctx.store.get<Staff>('staff', p.userId);
      if (!staff) throw new DomainError('invalid', ['That person no longer exists.']);
      await ctx.store.put('staff', { ...staff, pinHash: await ctx.hasher.hash(staff.id, p.pin) });
      await ctx.store.put('loginState', { id: staff.id, failures: 0, lockCount: 0 });
      await ctx.revokeSessions(staff.id, staff.id === ctx.session!.userId ? ctx.sessionId : undefined);
      return { summary: `Reset the PIN for ${staff.name}`, target: staff.id };
    },
  },

  'staff/set_active': {
    circuit: 'Staff',
    roles: ['owner'],
    validate: async (p, ctx) => {
      if (!p.active && p.userId === ctx.session!.userId) return ['You cannot turn off your own account.'];
      const all = await ctx.store.list<Staff>('staff');
      const target = all.find((s) => s.id === p.userId);
      if (!target) return ['That person no longer exists.'];
      if (!p.active && target.role === 'owner' && all.filter((s) => s.active && s.role === 'owner').length <= 1)
        return ['There must always be at least one active owner.'];
      return [];
    },
    handle: async (p, ctx) => {
      const staff = (await ctx.store.get<Staff>('staff', p.userId))!;
      await ctx.store.put('staff', { ...staff, active: p.active });
      if (!p.active) await ctx.revokeSessions(staff.id);
      return { summary: `${staff.name} ${p.active ? 'can sign in again' : 'can no longer sign in'}`, target: staff.id };
    },
  },

  'staff/delete': {
    circuit: 'Staff',
    roles: ['owner'],
    validate: async (p, ctx) => {
      const target = await ctx.store.get<Staff>('staff', p.userId);
      if (!target || target.removedAt) return ['That person is already removed.'];
      if (target.id === ctx.session!.userId) return ['You cannot remove your own account.'];
      if (target.role === 'owner') return ['An owner account cannot be removed.'];
      return [];
    },
    handle: async (p, ctx) => {
      const staff = (await ctx.store.get<Staff>('staff', p.userId))!;
      // The record stays as a name only, so history (orders, payments, audit) still says who did what.
      // Nothing that lets them in or reaches them is kept: PIN, contact, sessions, lock state, phone notifications.
      const { contact: _contact, ...rest } = staff;
      await ctx.store.put<Staff>('staff', { ...rest, pinHash: '', active: false, removedAt: ctx.now() });
      await ctx.revokeSessions(staff.id);
      await ctx.store.delete('loginState', staff.id);
      for (const sub of await ctx.store.find<PushSubscriptionRecord>('pushSubscriptions', { where: { userId: staff.id } })) await ctx.store.delete('pushSubscriptions', sub.id);
      return { summary: `Removed ${staff.name}`, target: staff.id, events: [{ type: 'StaffRemoved', payload: { userId: staff.id } }] };
    },
  },

  'staff/set_role': {
    circuit: 'Staff',
    roles: ['owner'],
    validate: async (p, ctx) => {
      const target = await ctx.store.get<Staff>('staff', p.userId);
      if (!target) return ['That person no longer exists.'];
      if (target.id === ctx.session!.userId) return ['You cannot change your own role.'];
      if (target.role === 'owner') return ['The owner\'s role cannot be changed.'];
      if (target.role === p.role) return [`${target.name} is already ${p.role}.`];
      return [];
    },
    handle: async (p, ctx) => {
      const staff = (await ctx.store.get<Staff>('staff', p.userId))!;
      await ctx.store.put('staff', { ...staff, role: p.role });
      // Whatever they were signed into was built for the old role.
      await ctx.revokeSessions(staff.id);
      return { summary: `Changed ${staff.name} from ${staff.role} to ${p.role}`, target: staff.id, events: [{ type: 'StaffRoleChanged', payload: { userId: staff.id, role: p.role } }] };
    },
  },
} satisfies Partial<Registry>;
