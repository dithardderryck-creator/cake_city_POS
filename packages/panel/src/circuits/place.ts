import type { Role, ShopSettings } from '../domain';
import type { Registry } from '../intents';
import { sha256Hex } from '../ports';
import { loadSettings } from './settings';

/** A position older than this no longer proves where someone is. The pages report again every couple of minutes. */
export const PLACE_FRESH_MS = 10 * 60_000;
/** A position this vague (a computer placed by its internet address, say) cannot show anyone is at the shop. */
const MAX_ACCURACY_M = 300;
/** Indoors a phone is often 20 to 60 m out. Its own stated error is forgiven up to this much. */
const FORGIVEN_ACCURACY_M = 100;

export interface PlaceReport {
  at: string;
  lat: number;
  lng: number;
  accuracyM?: number;
  inside: boolean;
}

/** People the location check never holds: the owner and IT must always be able to get in and turn it off. */
export const EXEMPT_FROM_LOCATION: Role[] = ['owner', 'it'];

/** Straight-line distance in metres between two points on the earth. */
export function distanceM(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(bLat - aLat);
  const dLng = rad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

export type PlaceVerdict = { inside: true; distanceM: number } | { inside: false; distanceM: number; reason: 'far' | 'vague' };

export function judgePlace(s: ShopSettings, lat: number, lng: number, accuracyM?: number): PlaceVerdict {
  if (s.shopLat === undefined || s.shopLng === undefined) return { inside: true, distanceM: 0 };
  const d = Math.round(distanceM(s.shopLat, s.shopLng, lat, lng));
  if (accuracyM !== undefined && accuracyM > MAX_ACCURACY_M) return { inside: false, distanceM: d, reason: 'vague' };
  const forgiven = Math.min(accuracyM ?? 0, FORGIVEN_ACCURACY_M);
  return d - forgiven <= s.locationRadiusM ? { inside: true, distanceM: d } : { inside: false, distanceM: d, reason: 'far' };
}

/** Whether the check holds this person in the lobby right now. */
export function heldInLobby(s: ShopSettings, role: Role, place: PlaceReport | undefined, nowMs: number): boolean {
  if (!s.locationCheckEnabled || EXEMPT_FROM_LOCATION.includes(role)) return false;
  if (s.shopLat === undefined || s.shopLng === undefined) return false; // no spot to measure from, so nothing to enforce
  if (!place || !place.inside) return true;
  return nowMs - Date.parse(place.at) > PLACE_FRESH_MS;
}

/** The few things staff can still do while held in the lobby. */
export const LOBBY_INTENTS = new Set<string>(['auth/sign_out', 'auth/change_pin', 'session/report_place', 'announcements/mark_seen', 'announcements/acknowledge', 'staff/set_contact']);
export const LOBBY_FEEDS = new Set<string>(['me', 'navigation', 'shop_settings', 'announcements', 'notification_setup', 'staff_signin']);

export const LOBBY_MESSAGE = 'You are outside the shop, so only the lobby is open. Go to the shop, then tap Check again.';

export const placeIntents = {
  'session/report_place': {
    circuit: 'Auth',
    roles: ['owner', 'cashier', 'baker', 'inventory', 'it'],
    skipRequestMemo: true,
    handle: async (p, ctx) => {
      const settings = await loadSettings(ctx.store);
      const verdict = judgePlace(settings, p.lat, p.lng, p.accuracyM);
      if (ctx.sessionId) {
        const id = await sha256Hex(ctx.sessionId);
        const rec = await ctx.store.get<{ id: string; place?: PlaceReport }>('sessions', id);
        if (rec) {
          const place: PlaceReport = { at: ctx.now(), lat: p.lat, lng: p.lng, ...(p.accuracyM !== undefined ? { accuracyM: p.accuracyM } : {}), inside: verdict.inside };
          await ctx.store.put('sessions', { ...rec, place });
        }
      }
      return {
        summary: 'Reported a position',
        skipSync: true,
        skipAudit: true,
        data: { inside: verdict.inside, distanceM: verdict.distanceM, ...(verdict.inside ? {} : { reason: verdict.reason }) },
      };
    },
  },
} satisfies Partial<Registry>;
