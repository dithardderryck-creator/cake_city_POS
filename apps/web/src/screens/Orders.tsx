import { useState } from 'react';
import { EmptyState, Note, Sheet, StatusChip } from '@cake-pos/design-system';
import { useFeed, useWide } from '../lib/panel';
import { OrderView } from './OrderView';

export function Orders() {
  const list = useFeed('order_list', {});
  const wide = useWide();
  const [selected, setSelected] = useState<string | null>(null);
  const orders = list.data ?? [];
  const active = selected ?? (wide ? orders[0]?.orderId ?? null : null);

  return (
    <div className={wide ? 'app-orders app-orders--wide' : 'app-orders'}>
      <section aria-label="Orders" className="cp-stack">
        {list.error && <Note tone="danger">{list.error}</Note>}
        {list.data && orders.length === 0 && <EmptyState title="No orders yet">Orders start on the Sell screen, with the first cake you add.</EmptyState>}
        <ul className="app-plain cp-stack">
          {orders.map((o) => (
            <li key={o.orderId}>
              <button type="button" className="app-orderrow" aria-current={o.orderId === active ? 'true' : undefined} onClick={() => setSelected(o.orderId)}>
                <span className="cp-row">
                  <strong className="cp-display">{o.number}</strong>
                  <span className="app-chips">
                    <StatusChip label={o.statusLabel} tone={o.statusTone} />
                    <StatusChip label={o.paymentLabel} tone={o.paymentTone} />
                  </span>
                </span>
                <span className="cp-muted">
                  {o.customerName}, {o.itemCount} {o.itemCount === 1 ? 'item' : 'items'}, {o.fulfilment === 'delivery' ? 'delivery' : 'pickup'}
                </span>
                <span className="cp-row">
                  <span>{o.totalLabel}</span>
                  {o.balanceLabel !== '0' && <span className="cp-muted">Still to pay {o.balanceLabel}</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      {wide && active && (
        <aside className="cp-card app-order" aria-label="Order details">
          <OrderView orderId={active} />
        </aside>
      )}
      {!wide && selected && (
        <Sheet open title="Order" onClose={() => setSelected(null)}>
          <OrderView orderId={selected} />
        </Sheet>
      )}
    </div>
  );
}
