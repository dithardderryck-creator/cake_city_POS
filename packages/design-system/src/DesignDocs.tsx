import { useState, type ReactNode } from 'react';
import { Button } from './components/Button';
import { OptionChips, StatusChip } from './components/Choice';
import { EmptyState, Field, Note, TextField, Toasts } from './components/Feedback';
import { Keypad, PinDots, type KeypadKey } from './components/Keypad';
import { LineRow } from './components/LineRow';
import { ProductTile } from './components/ProductTile';
import { Sheet } from './components/Sheet';

/* ---------- Live examples ---------- */

function ChoiceExample() {
  const [size, setSize] = useState<string | null>('8');
  return (
    <>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <StatusChip label="New" tone="attention" />
        <StatusChip label="Ready" tone="ready" />
        <StatusChip label="Completed" tone="done" />
        <StatusChip label="Unpaid" tone="danger" />
        <StatusChip label="Cancelled" tone="muted" />
        <StatusChip label="Draft" />
      </div>
      <OptionChips
        label="Size"
        value={size}
        onChange={setSize}
        options={[
          { id: 'slice', label: 'Slice' },
          { id: '6', label: '6-inch' },
          { id: '8', label: '8-inch' },
          { id: '10', label: '10-inch', disabled: true },
        ]}
      />
      <OptionChips
        variant="segmented"
        label="Fulfilment"
        value="pickup"
        onChange={() => undefined}
        options={[
          { id: 'pickup', label: 'Pickup' },
          { id: 'delivery', label: 'Delivery' },
        ]}
      />
    </>
  );
}

function KeypadExample() {
  const [pin, setPin] = useState('');
  const [amount, setAmount] = useState('');
  const press = (set: (fn: (s: string) => string) => void, max: number) => (k: KeypadKey) =>
    set((s) => (k === 'back' ? s.slice(0, -1) : k === '.' ? (s.includes('.') || !s ? s : s + '.') : s.length < max ? s + k : s));
  return (
    <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', width: '100%' }}>
      <div className="cp-stack" style={{ width: 240 }}>
        <PinDots length={pin.length} />
        <Keypad mode="pin" onKey={press(setPin, 4)} />
      </div>
      <div className="cp-stack" style={{ width: 240 }}>
        <div className="cp-display-value" aria-live="polite">
          {amount || '0'}
        </div>
        <Keypad mode="amount" onKey={press(setAmount, 9)} />
      </div>
    </div>
  );
}

function SheetExample() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>Open a sheet</Button>
      <Sheet open={open} title="Chocolate Fudge Cake" onClose={() => setOpen(false)}>
        <div className="cp-stack">
          <p className="cp-muted">Try Tab, Shift+Tab and Escape. Focus stays inside until the sheet closes.</p>
          <Button block onClick={() => setOpen(false)}>
            Add to order
          </Button>
        </div>
      </Sheet>
    </>
  );
}

function FieldExample() {
  const [v, setV] = useState('');
  return (
    <div className="cp-stack" style={{ width: '100%', maxWidth: 320 }}>
      <TextField label="Customer name" hint="Leave empty for a walk-in customer" value={v} onChange={setV} />
      <TextField label="Delivery address" error="Add a delivery address." value="" onChange={() => undefined} />
      <Field label="Custom control">{(a) => <select {...a} className="cp-input"><option>Cash</option><option>Card</option></select>}</Field>
    </div>
  );
}

/* ---------- Documentation content ---------- */

interface ComponentDoc {
  name: string;
  description: string;
  variants: [string, string][];
  states: [string, string][];
  a11y: string[];
  dos: string[];
  donts: string[];
  example: ReactNode;
}

const docs: ComponentDoc[] = [
  {
    name: 'Button',
    description: 'The one control for taking an action. Name it after what happens: Save changes, Take payment, Mark ready.',
    variants: [
      ['primary', 'The main action on a screen. One per view.'],
      ['soft', 'A friendly secondary action, such as Add another.'],
      ['ghost', 'Low emphasis, such as Close or Cancel.'],
      ['danger', 'Removes or cancels something. Always pair with a clear label.'],
    ],
    states: [
      ['Default', 'Pill shape, 48px tall minimum.'],
      ['Hover / Active', 'Darkens slightly and shrinks a little when pressed.'],
      ['Disabled', 'Faded and not focusable. Explain why nearby.'],
      ['Loading', 'Disabled with aria-busy while the panel is working.'],
    ],
    a11y: ['Native button element, so Enter and Space work.', 'Visible focus ring on every state.', 'Loading sets aria-busy and blocks double taps.'],
    dos: ['Use sentence case and plain verbs.', 'Keep the same name through the whole flow.'],
    donts: ['Do not use "Submit" or "OK".', 'Do not place two primary buttons side by side.'],
    example: (
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Button>Take payment</Button>
        <Button variant="soft">Add another</Button>
        <Button variant="ghost">Close</Button>
        <Button variant="danger">Cancel order</Button>
        <Button disabled>Take payment</Button>
        <Button loading>Saving</Button>
        <Button size="sm">Mark ready</Button>
      </div>
    ),
  },
  {
    name: 'Status chip and option chips',
    description: 'Status chips show where something stands and cannot be tapped. Option chips let someone pick one choice, like a size or filling.',
    variants: [
      ['StatusChip tones', 'neutral, attention, ready, done, muted and danger. The panel chooses the tone.'],
      ['OptionChips', 'A radio group. "chips" for wrapping choices, "segmented" for two or three short ones.'],
    ],
    states: [
      ['Selected', 'Pink fill with a raspberry border.'],
      ['Disabled option', 'Faded and struck through, with no tab stop.'],
    ],
    a11y: ['OptionChips is a radiogroup. Arrow keys move and select, Tab enters and leaves the group.', 'Status is always written out. Colour only reinforces it.'],
    dos: ['Show only choices that exist for this product.', 'Strike through options that are unavailable instead of hiding them.'],
    donts: ['Do not use colour alone to show status.', 'Do not use chips for more than about six choices.'],
    example: <ChoiceExample />,
  },
  {
    name: 'Product tile',
    description: 'A catalogue product in the sell grid. The icing drip along the top is the shop signature, so keep it on every tile.',
    variants: [['default', 'Name, a short line of detail, and a "From" price.']],
    states: [
      ['Default', 'White card with a soft shadow.'],
      ['Hover / Active', 'Shadow deepens, then the tile shrinks slightly when pressed.'],
      ['Disabled', 'Faded, with the reason shown in place of the price.'],
    ],
    a11y: ['A button, so Enter and Space open it.', 'The reason for being disabled is text, not only fading.'],
    dos: ['Say why a tile is unavailable, for example "Off the menu today".'],
    donts: ['Do not hide unavailable products. Staff need to explain them to customers.'],
    example: (
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: 12, width: '100%' }}>
        <ProductTile name="Chocolate Fudge Cake" meta="3 sizes, 2 fillings" priceLabel="5" />
        <ProductTile name="Red Velvet Cake" meta="Cream cheese frosting" disabled disabledReason="Off the menu today" />
        <ProductTile name="Lemon Drizzle Cake" meta="Not priced yet" priceLabel={null} />
      </div>
    ),
  },
  {
    name: 'Order line',
    description: 'One item on an order, with its chosen options, frozen price, allergens, status and the next steps.',
    variants: [['default', 'Title, options, quantity times price, total, status and actions.']],
    states: [
      ['Active', 'Normal text with a status chip.'],
      ['Cancelled', 'Struck through and muted, kept for the record.'],
    ],
    a11y: ['A list item. Allergens are written as "Contains ..." so they are read out.'],
    dos: ['Show allergens on every line that has them.', 'Render only the actions the panel provides.'],
    donts: ['Do not work out prices or next steps in the UI.'],
    example: (
      <ul style={{ margin: 0, padding: 0, width: '100%', maxWidth: 420 }}>
        <LineRow
          title="Chocolate Fudge Cake"
          options="8-inch, Chocolate ganache, Eggless"
          allergens={['egg', 'dairy']}
          qty={1}
          unitPriceLabel="45"
          totalLabel="45"
          statusLabel="New"
          statusTone="attention"
          actions={<Button size="sm">Mark ready</Button>}
        />
        <LineRow title="Lemon Drizzle Cake" options="Slice, Vanilla cream, Standard" qty={2} unitPriceLabel="4" totalLabel="8" statusLabel="Cancelled" statusTone="muted" cancelled />
      </ul>
    ),
  },
  {
    name: 'Keypad',
    description: 'Big number keys for PINs and cash amounts, sized for thumbs on a phone and fingers on a tablet.',
    variants: [
      ['pin', 'Digits only, with PinDots that show progress without revealing the code.'],
      ['amount', 'Adds a decimal key.'],
    ],
    states: [
      ['Default', '60px keys in a three-column grid.'],
      ['Pressed', 'Key shrinks briefly.'],
      ['Disabled', 'Keys fade while the panel is checking.'],
    ],
    a11y: ['Delete and decimal keys have spoken labels.', 'PinDots announces a count, never the digits.', 'Amount display is a live region.'],
    dos: ['Show the typed amount in large type above the keys.'],
    donts: ['Do not use a keypad for text.'],
    example: <KeypadExample />,
  },
  {
    name: 'Sheet',
    description: 'A focused panel for one task, such as choosing a size or taking a payment. A bottom sheet on phones and a centred dialog on wider screens.',
    variants: [['default', 'Title, close button and content.']],
    states: [
      ['Open', 'Rises in over a dimmed background. Motion is off for people who ask for reduced motion.'],
      ['Closed', 'Focus returns to the control that opened it.'],
    ],
    a11y: ['role="dialog" with aria-modal and a labelled title.', 'Focus moves in on open, is trapped while open, and returns on close.', 'Escape and tapping outside both close it.'],
    dos: ['Keep one task per sheet.'],
    donts: ['Do not stack sheets on top of each other.'],
    example: <SheetExample />,
  },
  {
    name: 'Field',
    description: 'A label, an input, a hint and an error, joined together so screen readers read them as one.',
    variants: [
      ['TextField', 'The common case: label, input, hint and error in one component.'],
      ['Field', 'Wraps any control, such as a select.'],
    ],
    states: [
      ['Default', 'Soft border.'],
      ['Focus', 'Raspberry border plus the focus ring.'],
      ['Error', 'Red border with a message that says what to fix.'],
    ],
    a11y: ['Label is tied to the control.', 'Hint and error are linked with aria-describedby.', 'Errors are announced when they appear.'],
    dos: ['Write errors as instructions: "Add a delivery address."'],
    donts: ['Do not use placeholder text as the label.'],
    example: <FieldExample />,
  },
  {
    name: 'Feedback: empty state, note and toast',
    description: 'The three ways the interface talks back: an invitation when there is nothing yet, a warning beside the thing it is about, and a short confirmation after an action.',
    variants: [
      ['EmptyState', 'Says what belongs here and how to add it.'],
      ['Note', 'attention for things to check, danger for things that block.'],
      ['Toast', 'info, warning and error. Repeats the action name: "Marked ready".'],
    ],
    states: [['Toast', 'Rises in, stays a few seconds, then leaves.']],
    a11y: ['Toasts are in a polite live region.', 'Danger notes use role="alert".'],
    dos: ['Explain what went wrong and what to do next.'],
    donts: ['Do not apologise or be vague. Say what happened.'],
    example: (
      <div className="cp-stack" style={{ width: '100%', maxWidth: 420 }}>
        <EmptyState title="No orders yet" action={<Button variant="soft">Start an order</Button>}>
          New orders will show up here as soon as one is started.
        </EmptyState>
        <Note>20 is still unpaid.</Note>
        <Note tone="danger">That is more than the balance. Enter 20 or less.</Note>
        <div style={{ position: 'relative', height: 60 }}>
          <div style={{ position: 'absolute', inset: 0 }}>
            <Toasts items={[{ id: 1, text: 'Marked ready: Chocolate Fudge Cake' }]} />
          </div>
        </div>
      </div>
    ),
  },
];

const palette = [
  ['Meringue', '--cp-meringue', 'Page background'],
  ['Icing', '--cp-icing', 'Soft fills, selected chips, the drip'],
  ['Raspberry', '--cp-raspberry', 'Main actions'],
  ['Cocoa', '--cp-cocoa', 'Text'],
  ['Pistachio', '--cp-pistachio', 'Completed'],
  ['Butter', '--cp-butter', 'Warnings'],
] as const;

const tones = ['neutral', 'attention', 'ready', 'done', 'muted', 'danger'] as const;
const typeScale = [
  ['--cp-text-2xl', 'Totals and big numbers', true],
  ['--cp-text-xl', 'Sheet and section titles', true],
  ['--cp-text-lg', 'Product names', true],
  ['--cp-text-md', 'Body and buttons', false],
  ['--cp-text-sm', 'Labels and secondary text', false],
  ['--cp-text-xs', 'Hints and status chips', false],
] as const;
const radii = [
  ['--cp-radius-input', 'Inputs'],
  ['--cp-radius-card', 'Cards'],
  ['--cp-radius-tile', 'Product tiles'],
  ['--cp-radius-sheet', 'Sheets'],
  ['--cp-radius-pill', 'Buttons, chips'],
] as const;
const spaces = ['--cp-space-1', '--cp-space-2', '--cp-space-3', '--cp-space-4', '--cp-space-5', '--cp-space-6', '--cp-space-7'] as const;

export function DesignDocs() {
  const [theme, setTheme] = useState<string | null>('auto');
  const applyTheme = (t: string) => {
    setTheme(t);
    if (t === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', t);
  };

  return (
    <div className="cp-docs">
      <header className="cp-docs__intro">
        <h1 className="cp-display">Cake POS design system</h1>
        <p>
          Warm, soft and easy to tap. Every colour, size and radius below is a token, and every component here is the same code the app uses.
          If it is not on this page, it does not exist yet.
        </p>
        <div className="cp-docs__bar">
          <span className="cp-muted">Theme</span>
          <OptionChips
            variant="segmented"
            label="Theme"
            value={theme}
            onChange={applyTheme}
            options={[
              { id: 'auto', label: 'Auto' },
              { id: 'light', label: 'Light' },
              { id: 'dark', label: 'Dark' },
            ]}
          />
        </div>
      </header>

      <section aria-labelledby="doc-colour">
        <h2 id="doc-colour">Colour</h2>
        <div className="cp-swatches">
          {palette.map(([name, v, use]) => (
            <div key={v} className="cp-swatch">
              <div className="cp-swatch__color" style={{ background: `var(${v})` }} />
              <div className="cp-swatch__body">
                <span className="cp-swatch__name">{name}</span>
                <span className="cp-swatch__var">{v}</span>
                <span className="cp-muted">{use}</span>
              </div>
            </div>
          ))}
        </div>
        <h3 style={{ marginTop: 'var(--cp-space-4)' }}>Status tones</h3>
        <div className="cp-swatches">
          {tones.map((t) => (
            <div key={t} className="cp-swatch">
              <div
                className="cp-swatch__color"
                style={{ background: `var(--cp-tone-${t}-bg)`, color: `var(--cp-tone-${t}-fg)`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800 }}
              >
                Aa
              </div>
              <div className="cp-swatch__body">
                <span className="cp-swatch__name">{t}</span>
                <span className="cp-swatch__var">--cp-tone-{t}-bg / -fg</span>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section aria-labelledby="doc-type">
        <h2 id="doc-type">Type</h2>
        <p style={{ marginBottom: 'var(--cp-space-3)' }}>
          Young Serif gives names and totals a bakery-menu warmth. Nunito, rounded and clear, carries everything you tap and read.
        </p>
        <div className="cp-scale">
          {typeScale.map(([v, use, display]) => (
            <div key={v} className="cp-scale__row">
              <span className="cp-scale__name">{v}</span>
              <span className={display ? 'cp-display' : undefined} style={{ fontSize: `var(${v})` }}>
                {use}
              </span>
            </div>
          ))}
        </div>
      </section>

      <section aria-labelledby="doc-shape">
        <h2 id="doc-shape">Shape and space</h2>
        <p style={{ marginBottom: 'var(--cp-space-3)' }}>Corners get softer as things get bigger and friendlier. Space runs on a 4px base.</p>
        <div className="cp-shapes">
          {radii.map(([v, use]) => (
            <div key={v} className="cp-shape" style={{ borderRadius: `var(${v})` }}>
              {use}
            </div>
          ))}
        </div>
        <div className="cp-spaces" style={{ marginTop: 'var(--cp-space-4)' }}>
          {spaces.map((v) => (
            <div key={v} style={{ textAlign: 'center' }}>
              <div className="cp-space" style={{ height: `var(${v})` }} />
              <span className="cp-swatch__var">{v.replace('--cp-', '')}</span>
            </div>
          ))}
        </div>
      </section>

      <section aria-labelledby="doc-components">
        <h2 id="doc-components">Components</h2>
        <div className="cp-stack" style={{ gap: 'var(--cp-space-6)' }}>
          {docs.map((d) => (
            <article key={d.name} className="cp-card cp-doc" aria-label={d.name}>
              <div className="cp-stack">
                <h3 className="cp-display" style={{ fontSize: 'var(--cp-text-lg)' }}>
                  {d.name}
                </h3>
                <p>{d.description}</p>
                <div className="cp-doc__tablewrap">
                  <table>
                    <caption className="cp-muted" style={{ textAlign: 'left', paddingBottom: 4 }}>Variants</caption>
                    <tbody>
                      {d.variants.map(([k, v]) => (
                        <tr key={k}><th scope="row">{k}</th><td>{v}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
              <div className="cp-stack">
                <div className="cp-doc__example">{d.example}</div>
                <div className="cp-doc__cols">
                  <div className="cp-doc__tablewrap">
                    <table>
                      <caption className="cp-muted" style={{ textAlign: 'left', paddingBottom: 4 }}>States</caption>
                      <tbody>
                        {d.states.map(([k, v]) => (
                          <tr key={k}><th scope="row">{k}</th><td>{v}</td></tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div>
                    <h3>Accessibility</h3>
                    <ul>{d.a11y.map((a) => <li key={a}>{a}</li>)}</ul>
                  </div>
                </div>
                <div className="cp-doc__cols">
                  <div>
                    <h3 className="cp-do">Do</h3>
                    <ul>{d.dos.map((a) => <li key={a}>{a}</li>)}</ul>
                  </div>
                  <div>
                    <h3 className="cp-dont">Don't</h3>
                    <ul>{d.donts.map((a) => <li key={a}>{a}</li>)}</ul>
                  </div>
                </div>
              </div>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
