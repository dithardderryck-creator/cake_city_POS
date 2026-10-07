import type { ShopSettings } from '../domain';
import type { Registry } from '../intents';
import type { Store } from '../ports';
import { normalisePhone } from './notify';

export const DEFAULT_SHOP_NAME = 'Cake shop';

export async function loadSettings(store: Pick<Store, 'get'>): Promise<ShopSettings> {
  const saved = await store.get<ShopSettings>('settings', 'shop');
  return { id: 'shop', decoratingStage: false, ...saved, shopName: saved?.shopName?.trim() || DEFAULT_SHOP_NAME };
}

const tidy = (v: string | null | undefined) => (v === null || v === undefined ? undefined : v.trim() || undefined);

export const settingsIntents = {
  'settings/update': {
    circuit: 'Settings',
    roles: ['owner'],
    validate: (p) => {
      if (Object.values(p).every((v) => v === undefined)) return ['Choose a setting to change.'];
      const errors: string[] = [];
      if (p.shopName !== undefined && !p.shopName.trim()) errors.push('The shop needs a name.');
      if (typeof p.shopPhone === 'string' && p.shopPhone.trim() && !/^[+\d][\d\s\-().]{5,30}$/.test(p.shopPhone.trim())) errors.push('Write the shop phone number with digits only, for example +255 712 345 678.');
      return errors;
    },
    handle: async (p, ctx) => {
      const current = await loadSettings(ctx.store);
      const next: ShopSettings = {
        ...current,
        decoratingStage: p.decoratingStage ?? current.decoratingStage,
        shopName: p.shopName !== undefined ? p.shopName.trim() : current.shopName,
        shopAddress: p.shopAddress !== undefined ? tidy(p.shopAddress) : current.shopAddress,
        shopPhone: p.shopPhone !== undefined ? tidy(p.shopPhone) : current.shopPhone,
        receiptFooter: p.receiptFooter !== undefined ? tidy(p.receiptFooter) : current.receiptFooter,
      };
      await ctx.store.put('settings', next);
      const receipt = p.shopName !== undefined || p.shopAddress !== undefined || p.shopPhone !== undefined || p.receiptFooter !== undefined;
      return {
        summary:
          p.decoratingStage !== undefined && !receipt
            ? next.decoratingStage
              ? 'Turned on the Decorating stage for custom cakes'
              : 'Turned off the Decorating stage for custom cakes'
            : receipt && p.decoratingStage === undefined
              ? 'Changed the shop details printed on receipts'
              : 'Changed the shop settings',
        target: 'shop',
        events: [{ type: 'SettingsChanged', payload: { decoratingStage: next.decoratingStage } }],
      };
    },
  },
} satisfies Partial<Registry>;

export { normalisePhone };
