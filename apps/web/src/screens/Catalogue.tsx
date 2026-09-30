import { useState } from 'react';
import { Button, EmptyState, Note, Sheet, StatusChip } from '@cake-pos/design-system';
import type { CatalogueGridItem } from '@cake-pos/panel';
import { useFeed, useRun } from '../lib/panel';

/** Commits on Enter or when the field loses focus, and only if the value changed. */
function NumberCell({ value, placeholder, label, onCommit }: { value: string; placeholder: string; label: string; onCommit: (n: number) => void }) {
  const [v, setV] = useState(value);
  const [seen, setSeen] = useState(value);
  if (seen !== value) {
    setSeen(value);
    setV(value);
  }
  const commit = () => {
    if (v.trim() === '' || v === value) return;
    onCommit(Number(v));
  };
  return (
    <input
      className="cp-input app-cell"
      inputMode="decimal"
      aria-label={label}
      placeholder={placeholder}
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget.blur() as void)}
    />
  );
}

function ProductCard({ item }: { item: CatalogueGridItem }) {
  const run = useRun();
  const [confirm, setConfirm] = useState(false);
  const { can } = item;

  return (
    <article className="cp-card cp-card--flush" aria-label={item.name}>
      <div className="app-prodhead">
        <div>
          <h2 className="cp-display" style={{ margin: 0, fontSize: 'var(--cp-text-lg)' }}>
            {item.name}
          </h2>
          {item.allergens.length > 0 && <p className="cp-muted" style={{ margin: 0 }}>Contains {item.allergens.join(', ')}</p>}
        </div>
        <div className="app-chips">
          {!item.availableToday && <StatusChip label="Off the menu today" tone="attention" />}
          {can.manage && (
            <Button size="sm" variant="soft" onClick={() => run('catalogue/toggle_available_today', { productId: item.productId, available: !item.availableToday })}>
              {item.availableToday ? 'Take off the menu today' : 'Put back on the menu'}
            </Button>
          )}
          {can.manage && (
            <Button size="sm" variant="ghost" onClick={() => setConfirm(true)}>
              Archive
            </Button>
          )}
        </div>
      </div>

      <div className="app-tablewrap">
        <table className="app-table">
          <thead>
            <tr>
              <th scope="col">Version</th>
              <th scope="col">Price</th>
              <th scope="col">In stock</th>
              <th scope="col">On open orders</th>
              <th scope="col">Sale</th>
            </tr>
          </thead>
          <tbody>
            {item.combinations.map((c) => (
              <tr key={c.combinationId}>
                <th scope="row">{c.label}</th>
                <td>
                  {can.price ? (
                    <NumberCell
                      value={c.price === null ? '' : String(c.price)}
                      placeholder="Set price"
                      label={`Price for ${c.label}`}
                      onCommit={(n) => run('catalogue/set_price', { combinationId: c.combinationId, price: n })}
                    />
                  ) : (
                    (c.priceLabel ?? 'No price yet')
                  )}
                </td>
                <td>
                  {can.stock ? (
                    <NumberCell value={String(c.onHand)} placeholder="0" label={`Stock for ${c.label}`} onCommit={(n) => run('stock/set_count', { combinationId: c.combinationId, count: n })} />
                  ) : (
                    c.onHand
                  )}
                </td>
                <td>
                  {c.committed}
                  {c.warning && <span className="app-warn"> Short</span>}
                </td>
                <td>
                  {can.price ? (
                    <Button
                      size="sm"
                      variant={c.markedUnavailable ? 'soft' : 'ghost'}
                      onClick={() => run('catalogue/mark_unavailable', { combinationId: c.combinationId, unavailable: !c.markedUnavailable })}
                    >
                      {c.markedUnavailable ? 'Make available' : 'On sale'}
                    </Button>
                  ) : (
                    <StatusChip label={c.sellable ? 'On sale' : (c.reason ?? 'Unavailable')} tone={c.sellable ? 'ready' : 'muted'} />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {confirm && (
        <Sheet open title={`Archive ${item.name}?`} onClose={() => setConfirm(false)}>
          <div className="cp-stack">
            <p>It will leave the sell screen but stay on past orders and in records.</p>
            <div className="app-buttons">
              <Button variant="ghost" onClick={() => setConfirm(false)}>
                Keep it
              </Button>
              <Button
                variant="danger"
                onClick={async () => {
                  const r = await run('catalogue/archive_product', { productId: item.productId });
                  if (r.ok) setConfirm(false);
                }}
              >
                Archive
              </Button>
            </div>
          </div>
        </Sheet>
      )}
    </article>
  );
}

export function Catalogue() {
  const grid = useFeed('catalogue_grid', {});
  return (
    <div className="cp-stack" style={{ gap: 'var(--cp-space-4)' }}>
      <h1 className="cp-display app-title" style={{ margin: 0 }}>
        Catalogue
      </h1>
      {grid.error && <Note tone="danger">{grid.error}</Note>}
      {grid.data && grid.data.length === 0 && <EmptyState title="The catalogue is empty">Products the owner adds will show up here.</EmptyState>}
      {(grid.data ?? []).map((p) => (
        <ProductCard key={p.productId} item={p} />
      ))}
    </div>
  );
}
