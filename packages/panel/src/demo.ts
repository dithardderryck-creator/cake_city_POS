import type { Staff } from './domain';
import type { Panel } from './kernel';
import { createIds, createSha256Hasher, type PinHasher, type Store } from './ports';

/** Demo staff. PINs are shown on the sign-in screen in demo mode only. */
export const DEMO_STAFF = [
  { name: 'Amina (Owner)', role: 'owner', pin: '1111' },
  { name: 'Baraka (Cashier)', role: 'cashier', pin: '2222' },
  { name: 'Neema (Baker)', role: 'baker', pin: '3333' },
  { name: 'Juma (Inventory)', role: 'inventory', pin: '4444' },
  { name: 'Ibrahim (IT)', role: 'it', pin: '9999' },
] as const;

export async function seedDemo(store: Store, panel: Panel, hasher: PinHasher = createSha256Hasher()): Promise<void> {
  const existing = await store.list<Staff>('staff');
  if (existing.length > 0) return;

  const ids = createIds();
  for (const s of DEMO_STAFF) {
    const id = ids.next('stf');
    await store.put<Staff>('staff', { id, name: s.name, role: s.role, pinHash: await hasher.hash(id, s.pin), active: true });
  }

  // Everything else goes through real intents, so the demo data is audited like any other change.
  const owner = (await store.list<Staff>('staff')).find((s) => s.role === 'owner')!;
  const signIn = await panel.dispatch('auth/sign_in', { userId: owner.id, pin: '1111' });
  if (!signIn.ok) throw new Error('Demo seeding could not sign in');
  const sid = (signIn.data as { sessionId: string }).sessionId;
  const call = async <T,>(p: Promise<{ ok: boolean; data?: unknown }>) => {
    const r = await p;
    if (!r.ok) throw new Error('Demo seeding failed');
    return r.data as T;
  };

  const size = await call<{ valueIds: string[] }>(
    panel.dispatch('catalogue/create_option_group', { name: 'Size', values: [{ label: 'Slice' }, { label: '6-inch' }, { label: '8-inch' }] }, sid),
  );
  const filling = await call<{ valueIds: string[] }>(
    panel.dispatch('catalogue/create_option_group', {
      name: 'Filling',
      values: [{ label: 'Vanilla cream' }, { label: 'Chocolate ganache', allergens: ['dairy'] }],
    }, sid),
  );
  const dietary = await call<{ valueIds: string[] }>(
    panel.dispatch('catalogue/create_option_group', {
      name: 'Dietary',
      values: [{ label: 'Standard' }, { label: 'Eggless' }, { label: 'Gluten-free', allergens: ['may contain nuts'] }],
    }, sid),
  );

  const build = async (name: string, description: string, allergens: string[], base: number, stock: number) => {
    const { productId } = await call<{ productId: string }>(
      panel.dispatch('catalogue/create_product', { name, category: 'Cakes', description, allergens }, sid),
    );
    await panel.dispatch('catalogue/set_product_options', {
      productId,
      valueIds: [...size.valueIds, ...filling.valueIds, ...dietary.valueIds],
    }, sid);
    await panel.dispatch('catalogue/generate_combinations', { productId }, sid);
    await panel.dispatch('catalogue/fill_price', { productId, valueId: size.valueIds[0]!, price: base }, sid);
    await panel.dispatch('catalogue/fill_price', { productId, valueId: size.valueIds[1]!, price: base * 6 }, sid);
    await panel.dispatch('catalogue/fill_price', { productId, valueId: size.valueIds[2]!, price: base * 9 }, sid);
    const grid = await panel.feed('catalogue_grid', {}, sid);
    if (grid.ok) {
      const item = grid.data.find((g) => g.productId === productId)!;
      for (const c of item.combinations) {
        await panel.dispatch('stock/set_count', { combinationId: c.combinationId, count: stock }, sid);
      }
    }
  };

  await build('Chocolate Fudge Cake', 'Dark chocolate sponge with a fudge finish.', ['egg', 'gluten', 'dairy'], 3500, 4);
  await build('Red Velvet Cake', 'Soft red sponge with cream cheese frosting.', ['egg', 'gluten', 'dairy'], 4000, 3);
  await build('Lemon Drizzle Cake', 'Zesty sponge soaked in lemon syrup.', ['egg', 'gluten'], 3000, 5);

  await panel.dispatch('auth/sign_out', {}, sid);
}
