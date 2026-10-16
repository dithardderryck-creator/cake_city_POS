import type { Device, PairingCode } from '../domain';
import type { Registry } from '../intents';
import { sha256Hex } from '../ports';

/** No 0/O or 1/I/L look-alikes: the code is read off one screen and typed into another. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const CODE_LENGTH = 8;
const MAX_PENDING_CODES = 10;

/** 8 characters from 32, so 40 bits of randomness. Every base64url symbol maps to one of 32 evenly. */
export function newPairingCode(token: string): string {
  let out = '';
  for (const ch of token.slice(0, CODE_LENGTH)) out += ALPHABET[BASE64URL.indexOf(ch) % 32];
  return out;
}

/** What the person typed, tidied: capitals, no dashes or spaces. */
export function normalizeCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export const showCode = (c: string) => `${c.slice(0, 4)}-${c.slice(4)}`;

export const NOT_REGISTERED = 'This device is not registered. Ask the owner or IT for a pairing code.';

const cleanName = (s: string) => s.trim().replace(/\s+/g, ' ');

export const deviceTokenHash = (token: string) => sha256Hex(`device:${token}`);
export const codeHash = (code: string) => sha256Hex(`pair:${normalizeCode(code)}`);

export const deviceIntents = {
  'devices/create_code': {
    circuit: 'Devices',
    roles: ['owner', 'it'],
    validate: async (p, ctx) => {
      const name = cleanName(p.name);
      if (!name) return ['Give the device a name, such as "Counter tablet", so you can tell it apart later.'];
      if (name.length > 40) return ['Keep the device name to 40 characters or fewer.'];
      const nowMs = ctx.clock.now().getTime();
      const devices = await ctx.store.list<Device>('devices');
      if (p.replaces) {
        const old = devices.find((d) => d.id === p.replaces);
        if (!old || old.revokedAt) return ['The device you want to replace is no longer registered.'];
        if (ctx.device?.id === old.id) return ['You are using this device right now, so it cannot be replaced from here. It is already registered.'];
      }
      if (devices.some((d) => !d.revokedAt && d.id !== p.replaces && d.name.toLowerCase() === name.toLowerCase())) return [`A device called "${name}" is already registered. Choose another name.`];
      const codes = await ctx.store.list<PairingCode>('pairingCodes');
      const pending = codes.filter((c) => !c.usedAt && !c.cancelledAt && Date.parse(c.expiresAt) > nowMs);
      if (pending.some((c) => c.name.toLowerCase() === name.toLowerCase())) return [`There is already an open code for "${name}". Use it, or cancel it first.`];
      if (pending.length >= MAX_PENDING_CODES) return ['There are too many open codes. Cancel the ones you do not need.'];
      return [];
    },
    handle: async (p, ctx) => {
      const name = cleanName(p.name);
      const code = newPairingCode(ctx.secrets.token());
      const at = ctx.clock.now().getTime();
      const rec: PairingCode = {
        id: await codeHash(code),
        name,
        createdAt: new Date(at).toISOString(),
        expiresAt: new Date(at + ctx.config.pairingCodeMs).toISOString(),
        createdByName: ctx.session!.name,
        ...(p.replaces ? { replacesDeviceId: p.replaces } : {}),
      };
      await ctx.store.put('pairingCodes', rec);
      // The code itself is shown once, here. Only its hash is kept.
      return { summary: `Made a pairing code for "${name}"`, target: rec.id, data: { code: showCode(code), name, expiresAt: rec.expiresAt } };
    },
  },

  'devices/cancel_code': {
    circuit: 'Devices',
    roles: ['owner', 'it'],
    validate: async (p, ctx) => {
      const c = await ctx.store.get<PairingCode>('pairingCodes', p.codeId);
      if (!c || c.usedAt || c.cancelledAt) return ['That code is no longer open.'];
      return [];
    },
    handle: async (p, ctx) => {
      const c = (await ctx.store.get<PairingCode>('pairingCodes', p.codeId))!;
      await ctx.store.put('pairingCodes', { ...c, cancelledAt: ctx.now() });
      return { summary: `Cancelled the pairing code for "${c.name}"`, target: c.id };
    },
  },

  'devices/pair': {
    circuit: 'Devices',
    roles: 'public',
    handle: async (p, ctx) => {
      const refuse = (why: string) => ({
        summary: `Device pairing refused: ${why}`,
        failure: { code: 'forbidden' as const, messages: ['That code is not valid, was already used, or has expired. Ask the owner or IT for a new one.'] },
        skipSync: true,
      });
      if (normalizeCode(p.code).length !== CODE_LENGTH) return refuse('wrong length');
      const rec = await ctx.store.get<PairingCode>('pairingCodes', await codeHash(p.code));
      if (!rec) return refuse('unknown code');
      if (rec.usedAt || rec.cancelledAt) return refuse('code already closed');
      if (Date.parse(rec.expiresAt) <= ctx.clock.now().getTime()) return refuse('code expired');
      const deviceToken = ctx.secrets.token();
      const device: Device = {
        id: ctx.ids.next('dev'),
        name: rec.name,
        tokenHash: await deviceTokenHash(deviceToken),
        createdAt: ctx.now(),
        createdByName: rec.createdByName,
      };
      await ctx.store.put('pairingCodes', { ...rec, usedAt: ctx.now() });
      // A re-registration retires the old record (its browser lost the secret), so the same name is not listed twice.
      const old = rec.replacesDeviceId ? await ctx.store.get<Device>('devices', rec.replacesDeviceId) : undefined;
      if (old && !old.revokedAt) {
        await ctx.store.put('devices', { ...old, revokedAt: ctx.now(), revokedByName: `replaced by a new registration` });
        await ctx.revokeDeviceSessions(old.id);
      }
      await ctx.store.put('devices', device);
      return { summary: `Registered the device "${device.name}"${old ? ' (replacing the old registration)' : ''}`, target: device.id, data: { deviceToken, deviceName: device.name }, skipSync: true };
    },
  },

  'devices/rename': {
    circuit: 'Devices',
    roles: ['owner', 'it'],
    validate: async (p, ctx) => {
      const d = await ctx.store.get<Device>('devices', p.deviceId);
      if (!d || d.revokedAt) return ['That device is no longer registered.'];
      const name = cleanName(p.name);
      if (!name) return ['Give the device a name.'];
      if (name.length > 40) return ['Keep the device name to 40 characters or fewer.'];
      const others = await ctx.store.list<Device>('devices');
      if (others.some((o) => o.id !== d.id && !o.revokedAt && o.name.toLowerCase() === name.toLowerCase())) return [`A device called "${name}" is already registered.`];
      return [];
    },
    handle: async (p, ctx) => {
      const d = (await ctx.store.get<Device>('devices', p.deviceId))!;
      const name = cleanName(p.name);
      await ctx.store.put('devices', { ...d, name });
      return { summary: `Renamed the device "${d.name}" to "${name}"`, target: d.id };
    },
  },

  'devices/revoke': {
    circuit: 'Devices',
    roles: ['owner', 'it'],
    validate: async (p, ctx) => {
      const d = await ctx.store.get<Device>('devices', p.deviceId);
      if (!d || d.revokedAt) return ['That device is already revoked.'];
      if (ctx.device?.id === d.id) return ['You are using this device right now. Revoke it from another device, so you are not locked out by accident.'];
      const active = (await ctx.store.list<Device>('devices')).filter((x) => !x.revokedAt);
      if (active.length <= 1) return ['This is the only registered device. Register another one first, or nobody could sign in.'];
      return [];
    },
    handle: async (p, ctx) => {
      const d = (await ctx.store.get<Device>('devices', p.deviceId))!;
      await ctx.store.put('devices', { ...d, revokedAt: ctx.now(), revokedByName: ctx.session!.name });
      await ctx.revokeDeviceSessions(d.id);
      return { summary: `Revoked the device "${d.name}"`, target: d.id, events: [{ type: 'DeviceRevoked', payload: { deviceId: d.id } }] };
    },
  },
} satisfies Partial<Registry>;
