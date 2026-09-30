import { useState } from 'react';
import { Button, EmptyState, Note, OptionChips, ProductTile, Sheet, TextField } from '@cake-pos/design-system';
import type { CatalogueGridItem, DispatchResult } from '@cake-pos/panel';
import { useFeed, useRun, useWide } from '../lib/panel';
import { OrderView } from './OrderView';

interface Draft {
  customerName: string;
  source: 'walk_in' | 'phone';
  fulfilment: 'pickup' | 'delivery';
  address: string;
}
const EMPTY_DRAFT: Draft = { customerName: '', source: 'walk_in', fulfilment: 'pickup', address: '' };

/** Pick a size, filling and so on. Every fact shown here comes from the catalogue feed. */
function VariantSheet({ item, onClose, onAdd }: { item: CatalogueGridItem; onClose: () => void; onAdd: (combinationId: string, qty: number) => Promise<DispatchResult> }) {
  const first = item.combinations.find((c) => c.sellable) ?? item.combinations[0];
  const [selected, setSelected] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const g of item.groups) init[g.groupId] = g.values.find((v) => first?.valueIds.includes(v.valueId))?.valueId ?? g.values[0]!.valueId;
    return init;
  });
  const [qty, setQty] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const matches = (c: CatalogueGridItem['combinations'][number], sel: Record<string, string>) => item.groups.every((g) => c.valueIds.includes(sel[g.groupId]!));
  const combo = item.combinations.find((c) => matches(c, selected));

  const exists = (groupId: string, valueId: string) =>
    item.combinations.some((c) => matches(c, { ...selected, [groupId]: valueId }));

  const add = async () => {
    if (!combo) return;
    setBusy(true);
    const r = await onAdd(combo.combinationId, qty);
    setBusy(false);
    if (r.ok) onClose();
    else setError(r.error.messages.join(' '));
  };

  return (
    <Sheet open title={item.name} onClose={onClose}>
      <div className="cp-stack">
        {item.description && <p className="cp-muted">{item.description}</p>}
        {item.allergens.length > 0 && <p className="cp-muted">Contains {item.allergens.join(', ')}</p>}
        {item.groups.map((g) => (
          <div key={g.groupId} className="cp-stack" style={{ gap: 6 }}>
            <strong>{g.name}</strong>
            <OptionChips
              label={g.name}
              value={selected[g.groupId] ?? null}
              onChange={(id) => {
                setError(null);
                setSelected((s) => ({ ...s, [g.groupId]: id }));
              }}
              options={g.values.map((v) => ({ id: v.valueId, label: v.label, disabled: !exists(g.groupId, v.valueId) }))}
            />
          </div>
        ))}

        <div className="cp-card cp-stack" style={{ gap: 4 }}>
          {combo ? (
            <>
              <div className="cp-row">
                <span className="cp-total">{combo.priceLabel ?? 'No price yet'}</span>
                <span className="cp-muted">
                  {combo.onHand} in stock{combo.committed > 0 ? `, ${combo.committed} on open orders` : ''}
                </span>
              </div>
              {combo.reason && <Note tone="danger">{combo.reason}</Note>}
              {combo.warning && <Note>{combo.warning}</Note>}
            </>
          ) : (
            <p className="cp-muted">That mix is not available.</p>
          )}
        </div>

        <div className="cp-row">
          <span style={{ fontWeight: 800 }}>How many</span>
          <span className="app-stepper">
            <Button variant="ghost" size="sm" aria-label="Fewer" disabled={qty <= 1} onClick={() => setQty((q) => q - 1)}>
              −
            </Button>
            <output aria-live="polite" className="app-qty">
              {qty}
            </output>
            <Button variant="ghost" size="sm" aria-label="More" onClick={() => setQty((q) => q + 1)}>
              +
            </Button>
          </span>
        </div>

        {error && <Note tone="danger">{error}</Note>}
        <Button size="lg" block loading={busy} disabled={!combo?.sellable} onClick={add}>
          Add to order
        </Button>
      </div>
    </Sheet>
  );
}

function DetailsForm({ draft, setDraft }: { draft: Draft; setDraft: (d: Draft) => void }) {
  return (
    <div className="cp-stack">
      <TextField label="Customer name" hint="Leave empty for a walk-in customer" value={draft.customerName} onChange={(v) => setDraft({ ...draft, customerName: v })} />
      <OptionChips
        label="How the order came in"
        variant="segmented"
        value={draft.source}
        onChange={(id) => setDraft({ ...draft, source: id as Draft['source'] })}
        options={[
          { id: 'walk_in', label: 'Walk-in' },
          { id: 'phone', label: 'Phone' },
        ]}
      />
      <OptionChips
        label="Fulfilment"
        variant="segmented"
        value={draft.fulfilment}
        onChange={(id) => setDraft({ ...draft, fulfilment: id as Draft['fulfilment'] })}
        options={[
          { id: 'pickup', label: 'Pickup' },
          { id: 'delivery', label: 'Delivery' },
        ]}
      />
      {draft.fulfilment === 'delivery' && <TextField label="Delivery address" value={draft.address} onChange={(v) => setDraft({ ...draft, address: v })} />}
    </div>
  );
}

export function Sell({ draftOrderId, setDraftOrderId }: { draftOrderId: string | null; setDraftOrderId: (id: string | null) => void }) {
  const grid = useFeed('catalogue_grid', {});
  const card = useFeed('order_card', { orderId: draftOrderId ?? '' }, !!draftOrderId);
  const run = useRun();
  const wide = useWide();
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<CatalogueGridItem | null>(null);
  const [orderOpen, setOrderOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);

  const addToOrder = async (combinationId: string, qty: number): Promise<DispatchResult> => {
    let orderId = draftOrderId;
    if (!orderId) {
      const created = await run(
        'orders/create_order',
        { customerName: draft.customerName, source: draft.source, fulfilment: draft.fulfilment, deliveryAddress: draft.address },
        { inlineErrors: true },
      );
      if (!created.ok) return created;
      orderId = (created.data as { orderId: string }).orderId;
      setDraftOrderId(orderId);
    }
    return run('orders/add_catalogue_line', { orderId, combinationId, qty }, { inlineErrors: true });
  };

  const newOrder = () => {
    setDraftOrderId(null);
    setDraft(EMPTY_DRAFT);
    setOrderOpen(false);
  };

  const shown = (grid.data ?? []).filter((p) => p.name.toLowerCase().includes(q.trim().toLowerCase()));

  const orderPanel = draftOrderId ? (
    <OrderView orderId={draftOrderId} onNewOrder={newOrder} />
  ) : (
    <div className="cp-stack">
      <h2 className="cp-display app-title" style={{ margin: 0 }}>
        New order
      </h2>
      <DetailsForm draft={draft} setDraft={setDraft} />
      <EmptyState title="No items yet">Tap a cake to add it. The order starts with the first item.</EmptyState>
    </div>
  );

  return (
    <div className={wide ? 'app-sell app-sell--wide' : 'app-sell'}>
      <section aria-label="Catalogue" className="cp-stack">
        <TextField label="Search cakes" value={q} onChange={setQ} type="search" />
        {grid.error && <Note tone="danger">{grid.error}</Note>}
        {grid.data && shown.length === 0 && <EmptyState title="No cakes match">Try a different word, or ask the owner to add it to the catalogue.</EmptyState>}
        <div className="app-grid">
          {shown.map((p) => (
            <ProductTile
              key={p.productId}
              name={p.name}
              meta={p.groups.map((g) => g.name).join(', ')}
              priceLabel={p.priceFromLabel}
              disabled={!p.sellable}
              disabledReason={!p.availableToday ? 'Off the menu today' : 'No price yet'}
              onClick={() => setPicked(p)}
            />
          ))}
        </div>
      </section>

      {wide ? (
        <aside className="cp-card app-order" aria-label="Current order">
          {orderPanel}
        </aside>
      ) : (
        <div className="app-bar">
          <span>
            {card.data ? (
              <>
                <strong>{card.data.itemCount}</strong> {card.data.itemCount === 1 ? 'item' : 'items'}, {card.data.totalLabel}
              </>
            ) : (
              'No items yet'
            )}
          </span>
          <Button onClick={() => setOrderOpen(true)}>{draftOrderId ? 'View order' : 'Order details'}</Button>
        </div>
      )}

      {picked && <VariantSheet item={picked} onClose={() => setPicked(null)} onAdd={addToOrder} />}
      {!wide && orderOpen && (
        <Sheet open title="Current order" onClose={() => setOrderOpen(false)}>
          {orderPanel}
        </Sheet>
      )}
    </div>
  );
}
