import type { Staff } from '../domain';
import type { HandlerCtx } from '../intents';

export interface LoginState {
  id: string; // the staff id
  failures: number;
  lockCount: number;
  lockedUntil?: string;
}

export type PinCheck = { ok: true } | { ok: false; message: string };

const plural = (n: number) => `${n} ${n === 1 ? 'minute' : 'minutes'}`;

/**
 * Check a PIN, counting wrong attempts and locking after too many.
 * The counters are written even when the check fails, which is why the caller returns a
 * committed `failure` result instead of throwing.
 */
export async function checkPin(ctx: HandlerCtx, staff: Staff | undefined, userId: string, pin: string): Promise<PinCheck> {
  const nowMs = ctx.clock.now().getTime();
  const state = (staff && (await ctx.store.get<LoginState>('loginState', userId))) || { id: userId, failures: 0, lockCount: 0 };

  if (state.lockedUntil && Date.parse(state.lockedUntil) > nowMs) {
    const mins = Math.ceil((Date.parse(state.lockedUntil) - nowMs) / 60_000);
    return { ok: false, message: `Too many wrong PINs. Try again in ${plural(mins)}.` };
  }

  const good = !!staff && staff.active && (await ctx.hasher.verify(staff.pinHash, staff.id, pin));
  if (good) {
    if (state.failures || state.lockCount || state.lockedUntil) await ctx.store.put<LoginState>('loginState', { id: userId, failures: 0, lockCount: 0 });
    return { ok: true };
  }

  // Unknown or inactive people are not tracked, so random ids cannot fill the database.
  if (!staff || !staff.active) return { ok: false, message: 'That PIN does not match. Try again.' };

  const failures = state.failures + 1;
  if (failures >= ctx.config.lockoutMaxFailures) {
    const table = ctx.config.lockoutMinutes;
    const mins = table[Math.min(state.lockCount, table.length - 1)]!;
    await ctx.store.put<LoginState>('loginState', {
      id: userId,
      failures: 0,
      lockCount: state.lockCount + 1,
      lockedUntil: new Date(nowMs + mins * 60_000).toISOString(),
    });
    return { ok: false, message: `Too many wrong PINs. Locked for ${plural(mins)}.` };
  }
  await ctx.store.put<LoginState>('loginState', { ...state, failures });
  const left = ctx.config.lockoutMaxFailures - failures;
  return { ok: false, message: `That PIN does not match. ${left} ${left === 1 ? 'try' : 'tries'} left.` };
}
