import type { Combination, OptionGroup, OptionValue, Product } from '../domain';
import { DomainError, type HandlerCtx, type Registry } from '../intents';

const nonEmpty = (s: string | undefined) => !!s && s.trim().length > 0;

async function loadProduct(ctx: HandlerCtx, id: string) {
  const product = await ctx.store.get<Product>('products', id);
  if (!product) throw new DomainError('invalid', ['That product no longer exists.']);
  return product;
}

/** Cartesian product of arrays: [[a,b],[c]] -> [[a,c],[b,c]] */
function cartesian<T>(lists: T[][]): T[][] {
  return lists.reduce<T[][]>((acc, list) => acc.flatMap((prefix) => list.map((item) => [...prefix, item])), [[]]);
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

export const catalogueIntents = {
  'catalogue/create_option_group': {
    circuit: 'Catalogue',
    roles: ['owner'],
    validate: (p) => {
      const errors: string[] = [];
      if (!nonEmpty(p.name)) errors.push('Give the option group a name, like Size or Filling.');
      const labels = (p.values ?? []).map((v) => v.label?.trim()).filter(Boolean) as string[];
      if (labels.length === 0) errors.push('Add at least one choice.');
      if (new Set(labels.map((l) => l.toLowerCase())).size !== labels.length)
        errors.push('Each choice needs a different name.');
      return errors;
    },
    handle: async (p, ctx) => {
      const groups = await ctx.store.list<OptionGroup>('optionGroups');
      const group: OptionGroup = { id: ctx.ids.next('grp'), name: p.name.trim(), order: groups.length };
      await ctx.store.put('optionGroups', group);
      const valueIds: string[] = [];
      let order = 0;
      for (const v of p.values.filter((x) => nonEmpty(x.label))) {
        const value: OptionValue = {
          id: ctx.ids.next('val'),
          groupId: group.id,
          label: v.label.trim(),
          allergens: v.allergens ?? [],
          order: order++,
        };
        await ctx.store.put('optionValues', value);
        valueIds.push(value.id);
      }
      return {
        summary: `Created ${group.name} with ${valueIds.length} choices`,
        target: group.id,
        data: { groupId: group.id, valueIds },
        events: [{ type: 'OptionGroupCreated', payload: { groupId: group.id } }],
      };
    },
  },

  'catalogue/create_product': {
    circuit: 'Catalogue',
    roles: ['owner'],
    validate: async (p, ctx) => {
      if (!nonEmpty(p.name)) return ['Give the product a name.'];
      const products = await ctx.store.list<Product>('products');
      const clash = products.some((x) => x.status === 'active' && x.name.toLowerCase() === p.name.trim().toLowerCase());
      return clash ? ['A product with that name already exists.'] : [];
    },
    handle: async (p, ctx) => {
      const product: Product = {
        id: ctx.ids.next('prd'),
        name: p.name.trim(),
        category: p.category?.trim() || 'Cakes',
        description: p.description?.trim() || '',
        status: 'active',
        availableToday: true,
        selectedValueIds: [],
        allergens: p.allergens ?? [],
        createdAt: ctx.now(),
      };
      await ctx.store.put('products', product);
      return {
        summary: `Added ${product.name}`,
        target: product.id,
        data: { productId: product.id },
        events: [{ type: 'ProductCreated', payload: { productId: product.id } }],
      };
    },
  },

  'catalogue/set_product_options': {
    circuit: 'Catalogue',
    roles: ['owner'],
    validate: async (p, ctx) => {
      const values = await ctx.store.list<OptionValue>('optionValues');
      const known = new Set(values.map((v) => v.id));
      return p.valueIds.every((id) => known.has(id)) ? [] : ['One of the chosen options no longer exists.'];
    },
    handle: async (p, ctx) => {
      const product = await loadProduct(ctx, p.productId);
      if (product.status === 'archived') throw new DomainError('invalid', ['This product is archived.']);
      product.selectedValueIds = [...new Set(p.valueIds)];
      await ctx.store.put('products', product);
      return { summary: `Updated options for ${product.name}`, target: product.id };
    },
  },

  'catalogue/generate_combinations': {
    circuit: 'Catalogue',
    roles: ['owner'],
    handle: async (p, ctx) => {
      const product = await loadProduct(ctx, p.productId);
      const [groups, values, existing] = await Promise.all([
        ctx.store.list<OptionGroup>('optionGroups'),
        ctx.store.list<OptionValue>('optionValues'),
        ctx.store.find<Combination>('combinations', { where: { productId: product.id } }),
      ]);
      const chosen = values.filter((v) => product.selectedValueIds.includes(v.id));
      const groupIds = groups
        .filter((g) => chosen.some((v) => v.groupId === g.id))
        .sort((a, b) => a.order - b.order)
        .map((g) => g.id);
      if (groupIds.length === 0) throw new DomainError('invalid', ['Choose the options this product comes in first.']);

      const lists = groupIds.map((gid) =>
        chosen.filter((v) => v.groupId === gid).sort((a, b) => a.order - b.order).map((v) => v.id),
      );
      const wanted = cartesian(lists);
      const mine = existing;
      let created = 0;
      for (const valueIds of wanted) {
        const found = mine.find((c) => sameSet(c.valueIds, valueIds));
        if (found) {
          // Bring back a combination that had been retired by an earlier option change.
          continue;
        }
        await ctx.store.put<Combination>('combinations', {
          id: ctx.ids.next('cmb'),
          productId: product.id,
          valueIds,
          price: null,
          stockCount: 0,
          status: 'available',
          createdAt: ctx.now(),
        });
        created++;
      }
      // Combinations that no longer match the chosen options are retired, never deleted.
      let retired = 0;
      for (const c of mine) {
        if (!wanted.some((w) => sameSet(w, c.valueIds)) && c.status !== 'unavailable') {
          await ctx.store.put('combinations', { ...c, status: 'unavailable' as const });
          retired++;
        }
      }
      return {
        summary: `${created} new combinations for ${product.name}${retired ? `, ${retired} retired` : ''}`,
        target: product.id,
        data: { created, retired, total: wanted.length },
        events: [{ type: 'CombinationsGenerated', payload: { productId: product.id, created } }],
      };
    },
  },

  'catalogue/set_price': {
    circuit: 'Catalogue',
    roles: ['owner'],
    validate: (p) =>
      Number.isFinite(p.price) && p.price >= 0 ? [] : ['Enter a price of zero or more.'],
    handle: async (p, ctx) => {
      const combo = await ctx.store.get<Combination>('combinations', p.combinationId);
      if (!combo) throw new DomainError('invalid', ['That combination no longer exists.']);
      await ctx.store.put('combinations', { ...combo, price: p.price });
      return {
        summary: `Price set to ${ctx.config.formatMoney(p.price)}`,
        target: combo.id,
        events: [{ type: 'PriceChanged', payload: { combinationId: combo.id, price: p.price } }],
      };
    },
  },

  'catalogue/fill_price': {
    circuit: 'Catalogue',
    roles: ['owner'],
    validate: (p) =>
      Number.isFinite(p.price) && p.price >= 0 ? [] : ['Enter a price of zero or more.'],
    handle: async (p, ctx) => {
      const product = await loadProduct(ctx, p.productId);
      const combos = (await ctx.store.find<Combination>('combinations', { where: { productId: product.id } })).filter((c) =>
        c.valueIds.includes(p.valueId),
      );
      for (const c of combos) await ctx.store.put('combinations', { ...c, price: p.price });
      return {
        summary: `Price ${ctx.config.formatMoney(p.price)} applied to ${combos.length} combinations`,
        target: product.id,
        events: [{ type: 'PriceChanged', payload: { productId: product.id, count: combos.length } }],
      };
    },
  },

  'catalogue/mark_unavailable': {
    circuit: 'Catalogue',
    roles: ['owner'],
    handle: async (p, ctx) => {
      const combo = await ctx.store.get<Combination>('combinations', p.combinationId);
      if (!combo) throw new DomainError('invalid', ['That combination no longer exists.']);
      await ctx.store.put('combinations', { ...combo, status: p.unavailable ? 'unavailable' : 'available' });
      return { summary: p.unavailable ? 'Marked unavailable' : 'Marked available', target: combo.id };
    },
  },

  'catalogue/archive_product': {
    circuit: 'Catalogue',
    roles: ['owner'],
    handle: async (p, ctx) => {
      const product = await loadProduct(ctx, p.productId);
      await ctx.store.put('products', { ...product, status: 'archived' as const });
      return {
        summary: `Archived ${product.name}`,
        target: product.id,
        events: [{ type: 'ProductArchived', payload: { productId: product.id } }],
      };
    },
  },

  'catalogue/toggle_available_today': {
    circuit: 'Catalogue',
    roles: ['owner'],
    handle: async (p, ctx) => {
      const product = await loadProduct(ctx, p.productId);
      await ctx.store.put('products', { ...product, availableToday: p.available });
      return {
        summary: `${product.name} ${p.available ? 'is available today' : 'is off the menu today'}`,
        target: product.id,
      };
    },
  },
} satisfies Partial<Registry>;
