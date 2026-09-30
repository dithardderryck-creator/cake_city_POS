import { useState } from 'react';
import { Button, Keypad, LineRow, Note, OptionChips, Sheet, StatusChip, TextField, type KeypadKey } from '@cake-pos/design-system';
import type { PaymentMethod } from '@cake-pos/panel';
import { useFeed, useRun } from '../lib/panel';

const METHODS: { id: PaymentMethod; label: string }[] = [
  { id: 'cash', label: 'Cash' },
  { id: 'card', label: 'Card' },
  { id: 'bank_transfer', label: 'Bank transfer' },
  { id: 'mobile_money', label: 'Mobile money' },
];

function PaymentSheet({ orderId, balance, balanceLabel, onClose }: { orderId: string; balance: number; balanceLabel: string; onClose: () => void }) {
  const run = useRun();
  const [method, setMethod] = useState<PaymentMethod>('cash');
  const [amount, setAmount] = useState(String(balance));
  const [fresh, setFresh] = useState(true);
  const [allowPartial, setAllowPartial] = useState(false);
  const [reference, setReference] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const typed = Number(amount);
  const isPartial = Number.isFinite(typed) && typed > 0 && typed + 0.005 < balance;

  const press = (k: KeypadKey) => {
    setError(null);
    setAmount((a) => {
      if (k === 'back') return a.slice(0, -1);
      if (k === '.') return fresh ? '0.' : a.includes('.') ? a : (a || '0') + '.';
      return fresh ? k : a.length < 9 ? a + k : a;
    });
    setFresh(false);
  };

  const submit = async () => {
    setBusy(true);
    const r = await run('payments/record_payment', { orderId, method, amount: typed, reference: reference || undefined, allowPartial }, { inlineErrors: true });
    setBusy(false);
    if (r.ok) onClose();
    else setError(r.error.messages.join(' '));
  };

  return (
    <Sheet open title="Take payment" onClose={onClose}>
      <div className="cp-stack">
        <p className="cp-muted">Balance to pay: {balanceLabel}</p>
        <OptionChips label="Payment method" variant="segmented" value={method} onChange={(id) => setMethod(id as PaymentMethod)} options={METHODS} />
        <div className="cp-display-value" aria-live="polite">
          {amount || '0'}
        </div>
        <Keypad mode="amount" onKey={press} />
        <Button
          variant="soft"
          onClick={() => {
            setAmount(String(balance));
            setFresh(true);
            setAllowPartial(false);
            setError(null);
          }}
        >
          Use full balance
        </Button>
        {method !== 'cash' && <TextField label="Reference (optional)" value={reference} onChange={setReference} hint="For example a transaction code" />}
        {isPartial && (
          <label className="app-check">
            <input type="checkbox" checked={allowPartial} onChange={(e) => setAllowPartial(e.target.checked)} />
            <span>This is less than the balance. Allow a partial payment for this order.</span>
          </label>
        )}
        {error && <Note tone="danger">{error}</Note>}
        <Button size="lg" block loading={busy} disabled={!(typed > 0)} onClick={submit}>
          Take payment
        </Button>
      </div>
    </Sheet>
  );
}

function RefundSheet({ orderId, refundableLabel, onClose }: { orderId: string; refundableLabel: string; onClose: () => void }) {
  const run = useRun();
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [method, setMethod] = useState<PaymentMethod>('cash');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    const r = await run('payments/approve_refund', { orderId, amount: Number(amount), reason, method }, { inlineErrors: true });
    setBusy(false);
    if (r.ok) onClose();
    else setError(r.error.messages.join(' '));
  };

  return (
    <Sheet open title="Refund" onClose={onClose}>
      <div className="cp-stack">
        <p className="cp-muted">Up to {refundableLabel} can be refunded on this order.</p>
        <TextField label="Amount" inputMode="decimal" value={amount} onChange={setAmount} />
        <TextField label="Reason" value={reason} onChange={setReason} hint="Kept in the activity log" />
        <OptionChips label="Refund method" variant="segmented" value={method} onChange={(id) => setMethod(id as PaymentMethod)} options={METHODS} />
        {error && <Note tone="danger">{error}</Note>}
        <Button size="lg" block loading={busy} onClick={submit}>
          Refund
        </Button>
      </div>
    </Sheet>
  );
}

export function OrderView({ orderId, onNewOrder }: { orderId: string; onNewOrder?: () => void }) {
  const { data, error } = useFeed('order_card', { orderId });
  const run = useRun();
  const [sheet, setSheet] = useState<'pay' | 'refund' | 'cancel' | null>(null);
  const [busy, setBusy] = useState(false);

  if (error) return <Note tone="danger">{error}</Note>;
  if (!data) return <p className="cp-muted">Loading the order…</p>;

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    await fn();
    setBusy(false);
  };

  return (
    <div className="cp-stack">
      <div className="cp-row" style={{ alignItems: 'flex-start' }}>
        <div>
          <h2 className="cp-display app-title" style={{ margin: 0 }}>
            Order {data.number}
          </h2>
          <p className="cp-muted" style={{ margin: 0 }}>
            {data.customerName}, {data.source === 'phone' ? 'phone order' : 'walk-in'}
          </p>
          <p className="cp-muted" style={{ margin: 0 }}>
            {data.fulfilment === 'delivery' ? `Delivery to ${data.deliveryAddress}` : 'Pickup in the shop'}
          </p>
        </div>
        <div className="app-chips">
          <StatusChip label={data.statusLabel} tone={data.statusTone} />
          <StatusChip label={data.paymentLabel} tone={data.paymentTone} />
        </div>
      </div>

      <ul className="app-lines">
        {data.lines.map((l) => (
          <LineRow
            key={l.lineId}
            title={l.title}
            options={l.options}
            allergens={l.allergens}
            qty={l.qty}
            unitPriceLabel={l.unitPriceLabel}
            totalLabel={l.totalLabel}
            statusLabel={l.statusLabel}
            statusTone={l.statusTone}
            cancelled={l.cancelled}
            actions={
              <>
                {l.actions.map((a) => (
                  <Button key={a.to} size="sm" disabled={busy} onClick={() => act(() => run('orders/advance_line', { orderId, lineId: l.lineId, to: a.to }))}>
                    {a.label}
                  </Button>
                ))}
                {l.canRemove && (
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => act(() => run('orders/cancel_line', { orderId, lineId: l.lineId }))}>
                    Remove
                  </Button>
                )}
              </>
            }
          />
        ))}
      </ul>

      <div className="cp-stack" style={{ gap: 4 }}>
        <div className="cp-row">
          <span>Total</span>
          <span className="cp-total">{data.totalLabel}</span>
        </div>
        <div className="cp-row cp-muted">
          <span>Paid</span>
          <span>{data.paidLabel}</span>
        </div>
        {data.refundedLabel && (
          <div className="cp-row cp-muted">
            <span>Refunded</span>
            <span>{data.refundedLabel}</span>
          </div>
        )}
        {data.balance > 0 && (
          <div className="cp-row" style={{ fontWeight: 800 }}>
            <span>Still to pay</span>
            <span>{data.balanceLabel}</span>
          </div>
        )}
      </div>

      {data.warnings.map((w) => (
        <Note key={w}>{w}</Note>
      ))}

      {data.payments.length > 0 && (
        <details>
          <summary className="cp-muted" style={{ cursor: 'pointer' }}>
            {data.payments.length} {data.payments.length === 1 ? 'payment' : 'payments'}
          </summary>
          <ul className="app-plain">
            {data.payments.map((p) => (
              <li key={p.id} className="cp-row cp-muted">
                <span>
                  {p.methodLabel}
                  {p.reference ? `, ${p.reference}` : ''}
                </span>
                <span>{p.amountLabel}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      <div className="cp-stack">
        {data.canRecordPayment && (
          <Button size="lg" block onClick={() => setSheet('pay')}>
            Take payment
          </Button>
        )}
        <div className="app-buttons">
          {data.canRefund && (
            <Button variant="soft" onClick={() => setSheet('refund')}>
              Refund
            </Button>
          )}
          {data.canCancel && (
            <Button variant="ghost" onClick={() => setSheet('cancel')}>
              Cancel order
            </Button>
          )}
          {onNewOrder && (
            <Button variant="soft" onClick={onNewOrder}>
              Start a new order
            </Button>
          )}
        </div>
      </div>

      {sheet === 'pay' && <PaymentSheet orderId={orderId} balance={data.balance} balanceLabel={data.balanceLabel} onClose={() => setSheet(null)} />}
      {sheet === 'refund' && <RefundSheet orderId={orderId} refundableLabel={data.refundableLabel} onClose={() => setSheet(null)} />}
      {sheet === 'cancel' && (
        <Sheet open title={`Cancel order ${data.number}?`} onClose={() => setSheet(null)}>
          <div className="cp-stack">
            <p>Every item on this order will be cancelled. This cannot be undone.</p>
            <div className="app-buttons">
              <Button variant="ghost" onClick={() => setSheet(null)}>
                Keep order
              </Button>
              <Button
                variant="danger"
                onClick={async () => {
                  const r = await run('orders/cancel_order', { orderId });
                  if (r.ok) setSheet(null);
                }}
              >
                Cancel order
              </Button>
            </div>
          </div>
        </Sheet>
      )}
    </div>
  );
}
