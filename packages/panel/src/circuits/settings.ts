import type { ShopSettings } from '../domain';
import type { Registry } from '../intents';
import type { Store } from '../ports';

export async function loadSettings(store: Pick<Store, 'get'>): Promise<ShopSettings> {
  return (await store.get<ShopSettings>('settings', 'shop')) ?? { id: 'shop', decoratingStage: false };
}

export const settingsIntents = {
  'settings/update': {
    circuit: 'Settings',
    roles: ['owner'],
    validate: (p) => (p.decoratingStage === undefined ? ['Choose a setting to change.'] : []),
    handle: async (p, ctx) => {
      const current = await loadSettings(ctx.store);
      const next: ShopSettings = { ...current, decoratingStage: p.decoratingStage ?? current.decoratingStage };
      await ctx.store.put('settings', next);
      return {
        summary: next.decoratingStage ? 'Turned on the Decorating stage for custom cakes' : 'Turned off the Decorating stage for custom cakes',
        target: 'shop',
        events: [{ type: 'SettingsChanged', payload: { decoratingStage: next.decoratingStage } }],
      };
    },
  },
} satisfies Partial<Registry>;
