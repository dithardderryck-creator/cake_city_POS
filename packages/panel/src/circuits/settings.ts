import type { PaymentMethod, ShopSettings } from '../domain';
import type { Registry } from '../intents';
import type { Store } from '../ports';
import { normalisePhone } from './notify';

export const DEFAULT_SHOP_NAME = 'Cake shop';

export const ALL_PAYMENT_METHODS: PaymentMethod[] = ['cash', 'mobile_money', 'card', 'bank_transfer'];
export const DEFAULT_LOW_STOCK_UNITS = 3;
export const DEFAULT_BIG_DIFFERENCE_PERCENT = 10;

/** What is saved, with a sensible value for anything the owner has not chosen yet. */
export async function loadSettings(store: Pick<Store, 'get'>): Promise<ShopSettings> {
  const saved = await store.get<Partial<ShopSettings> & { id: string }>('settings', 'shop');
  return {
    id: 'shop',
    decoratingStage: false,
    ...saved,
    shopName: saved?.shopName?.trim() || DEFAULT_SHOP_NAME,
    paymentMethods: saved?.paymentMethods?.length ? saved.paymentMethods : ALL_PAYMENT_METHODS,
    lowStockUnits: saved?.lowStockUnits ?? DEFAULT_LOW_STOCK_UNITS,
    bigDifferencePercent: saved?.bigDifferencePercent ?? DEFAULT_BIG_DIFFERENCE_PERCENT,
  };
}

/** The refusal for taking a payment by a method the shop has switched off, or nothing. */
export async function methodProblem(store: Pick<Store, 'get'>, method: PaymentMethod): Promise<string[]> {
  const s = await loadSettings(store);
  return s.paymentMethods.includes(method) ? [] : ['This shop does not take that kind of payment. Choose one of the methods shown.'];
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
      if (p.paymentMethods !== undefined && new Set(p.paymentMethods).size === 0) errors.push('Keep at least one way of paying switched on.');
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
        paymentMethods: p.paymentMethods !== undefined ? ALL_PAYMENT_METHODS.filter((m) => p.paymentMethods!.includes(m)) : current.paymentMethods,
        lowStockUnits: p.lowStockUnits ?? current.lowStockUnits,
        bigDifferencePercent: p.bigDifferencePercent ?? current.bigDifferencePercent,
      };
      await ctx.store.put('settings', next);
      const receipt = p.shopName !== undefined || p.shopAddress !== undefined || p.shopPhone !== undefined || p.receiptFooter !== undefined;
      return {
        summary:
          p.decoratingStage !== undefined && !receipt
            ? next.decoratingStage
              ? 'Turned on the Decorating stage for custom cakes'
              : 'Turned off the Decorating stage for custom cakes'
            : receipt && p.decoratingStage === undefined && p.paymentMethods === undefined && p.lowStockUnits === undefined && p.bigDifferencePercent === undefined
              ? 'Changed the shop details printed on receipts'
              : 'Changed the shop settings',
        target: 'shop',
        events: [{ type: 'SettingsChanged', payload: { decoratingStage: next.decoratingStage } }],
      };
    },
  },
} satisfies Partial<Registry>;

export { normalisePhone };
