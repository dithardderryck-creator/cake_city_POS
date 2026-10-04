import type { CakeSpec, CakeSpecInput, LineSnapshot, OrderLine, Photo } from '../domain';
import { DomainError, type HandlerCtx, type Registry } from '../intents';
import { deriveOrderStatus } from './order-logic';
import { loadOrderBundle } from './orders';

export const MAX_PHOTOS_PER_CAKE = 6;

const clean = (s: string | undefined) => {
  const t = s?.trim();
  return t ? t : undefined;
};

/** Checks what a person typed. Returns plain sentences for the UI to show. */
export function specProblems(spec: CakeSpecInput): string[] {
  const errors: string[] = [];
  if (!Number.isInteger(spec.servings) || spec.servings < 1) errors.push('Enter how many people the cake should serve.');
  if (!spec.flavor?.trim()) errors.push('Choose a flavor.');
  if (spec.layers !== undefined && (!Number.isInteger(spec.layers) || spec.layers < 1)) errors.push('Layers must be 1 or more.');
  return errors;
}

export function buildSpec(input: CakeSpecInput, photoIds: string[]): CakeSpec {
  return {
    servings: input.servings,
    sizeNote: clean(input.sizeNote),
    flavor: input.flavor.trim(),
    filling: clean(input.filling),
    layers: input.layers ?? 1,
    dietary: [...new Set((input.dietary ?? []).map((d) => d.trim()).filter(Boolean))],
    decorationNotes: clean(input.decorationNotes),
    inscription: clean(input.inscription),
    allergyNotes: clean(input.allergyNotes),
    photoIds,
  };
}

/** The frozen description shown on the order (BR-11). The price is filled in when the owner quotes. */
export function customSnapshot(spec: CakeSpec, unitPrice: number): LineSnapshot {
  const options: Record<string, string> = {
    Servings: spec.sizeNote ? `${spec.servings} (${spec.sizeNote})` : String(spec.servings),
    Flavor: spec.flavor,
  };
  if (spec.filling) options['Filling'] = spec.filling;
  options['Layers'] = String(spec.layers);
  if (spec.dietary.length) options['Dietary'] = spec.dietary.join(', ');
  return { productName: 'Custom cake', options, unitPrice, allergens: [] };
}

export async function loadCustomLine(ctx: Pick<HandlerCtx, 'store'>, orderId: string, lineId: string) {
  const bundle = await loadOrderBundle(ctx, orderId);
  const line = bundle.lines.find((l) => l.id === lineId);
  if (!line || line.type !== 'custom' || !line.custom) throw new DomainError('invalid', ['That custom cake is not on the order.']);
  return { ...bundle, line: line as OrderLine & { custom: NonNullable<OrderLine['custom']> } };
}

const EDITABLE = ['draft', 'awaiting_quote', 'new'];

export const customIntents = {
  'orders/add_custom_line': {
    circuit: 'Orders',
    roles: ['owner', 'cashier'],
    validate: async (p, ctx) => {
      const { order, lines } = await loadOrderBundle(ctx, p.orderId);
      const status = deriveOrderStatus(lines);
      if (status === 'completed' || status === 'cancelled') return [`Order ${order.number} is ${status}. Start a new order instead.`];
      return specProblems(p.spec);
    },
    handle: async (p, ctx) => {
      const spec = buildSpec(p.spec, []);
      const line: OrderLine = {
        id: ctx.ids.next('lin'),
        orderId: p.orderId,
        type: 'custom',
        qty: 1,
        snapshot: customSnapshot(spec, 0),
        status: 'draft',
        custom: { spec },
      };
      await ctx.store.put('orderLines', line);
      return {
        summary: `Started a custom cake (${spec.servings} servings, ${spec.flavor})`,
        target: line.id,
        data: { lineId: line.id },
        events: [{ type: 'LineAdded', payload: { orderId: p.orderId, lineId: line.id, custom: true } }],
      };
    },
  },

  'orders/update_custom_line': {
    circuit: 'Orders',
    roles: ['owner', 'cashier'],
    validate: async (p, ctx) => {
      const { line } = await loadCustomLine(ctx, p.orderId, p.lineId);
      if (line.status === 'awaiting_quote') return ['The owner is pricing this cake. Withdraw the quote request first to change it.'];
      if (!EDITABLE.includes(line.status)) return ['This cake has already been started, so its details can no longer be changed here.'];
      return specProblems(p.spec);
    },
    handle: async (p, ctx) => {
      const { line } = await loadCustomLine(ctx, p.orderId, p.lineId);
      const before = line.custom.spec;
      const spec = buildSpec(p.spec, before.photoIds);
      const price = line.snapshot.unitPrice;
      await ctx.store.put('orderLines', { ...line, snapshot: customSnapshot(spec, price), custom: { ...line.custom, spec } });
      const warnings: string[] = [];
      const affectsPrice =
        before.servings !== spec.servings ||
        before.layers !== spec.layers ||
        before.flavor !== spec.flavor ||
        before.filling !== spec.filling ||
        before.dietary.join('|') !== spec.dietary.join('|');
      if (line.status === 'new' && affectsPrice)
        warnings.push('The size or recipe changed after the owner quoted. Ask the owner whether the price should change.');
      return {
        summary: 'Changed the custom cake details',
        target: line.id,
        warnings,
        events: [{ type: 'CustomLineUpdated', payload: { orderId: p.orderId, lineId: line.id } }],
      };
    },
  },

  'orders/attach_reference_photo': {
    circuit: 'Orders',
    roles: ['owner', 'cashier'],
    validate: async (p, ctx) => {
      const { line } = await loadCustomLine(ctx, p.orderId, p.lineId);
      if (!EDITABLE.includes(line.status)) return ['This cake has already been started, so photos can no longer be added.'];
      const photo = await ctx.store.get<Photo>('photos', p.photoId);
      if (!photo) return ['That photo was not found. Upload it again.'];
      if (photo.attachedTo && photo.attachedTo !== line.id) return ['That photo is already used on another cake.'];
      if (line.custom.spec.photoIds.includes(p.photoId)) return ['That photo is already on this cake.'];
      if (line.custom.spec.photoIds.length >= MAX_PHOTOS_PER_CAKE) return [`A cake can have up to ${MAX_PHOTOS_PER_CAKE} reference photos.`];
      return [];
    },
    handle: async (p, ctx) => {
      const { line } = await loadCustomLine(ctx, p.orderId, p.lineId);
      const photo = (await ctx.store.get<Photo>('photos', p.photoId))!;
      await ctx.store.put('photos', { ...photo, attachedTo: line.id, orderId: p.orderId });
      const spec = { ...line.custom.spec, photoIds: [...line.custom.spec.photoIds, p.photoId] };
      await ctx.store.put('orderLines', { ...line, custom: { ...line.custom, spec } });
      return {
        summary: 'Added a reference photo to the custom cake',
        target: line.id,
        events: [{ type: 'ReferencePhotoAttached', payload: { orderId: p.orderId, lineId: line.id, photoId: p.photoId } }],
      };
    },
  },

  'orders/remove_reference_photo': {
    circuit: 'Orders',
    roles: ['owner', 'cashier'],
    validate: async (p, ctx) => {
      const { line } = await loadCustomLine(ctx, p.orderId, p.lineId);
      if (!EDITABLE.includes(line.status)) return ['This cake has already been started, so photos can no longer be removed.'];
      if (!line.custom.spec.photoIds.includes(p.photoId)) return ['That photo is not on this cake.'];
      return [];
    },
    handle: async (p, ctx) => {
      const { line } = await loadCustomLine(ctx, p.orderId, p.lineId);
      const photo = await ctx.store.get<Photo>('photos', p.photoId);
      // The file stays until the daily clean-up, in case the removal was a slip.
      if (photo) await ctx.store.put('photos', { ...photo, attachedTo: undefined, orderId: undefined });
      const spec = { ...line.custom.spec, photoIds: line.custom.spec.photoIds.filter((x) => x !== p.photoId) };
      await ctx.store.put('orderLines', { ...line, custom: { ...line.custom, spec } });
      return { summary: 'Removed a reference photo from the custom cake', target: line.id };
    },
  },
} satisfies Partial<Registry>;
