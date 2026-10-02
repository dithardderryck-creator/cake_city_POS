import { describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from './App';
import { PanelProvider } from './lib/panel';

async function signInAs(user: ReturnType<typeof userEvent.setup>, staff: RegExp, pin: string) {
  await user.click(await screen.findByRole('radio', { name: staff }));
  const keypad = screen.getByRole('group', { name: 'PIN keypad' });
  for (const d of pin) await user.click(within(keypad).getByRole('button', { name: d }));
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
}

describe('the app, end to end against the real panel', () => {
  it('a cashier can sell a cake: add, pay, hand over, and stock drops only at hand-over', async () => {
    const user = userEvent.setup();
    render(
      <PanelProvider>
        <App />
      </PanelProvider>,
    );

    expect(await screen.findByRole('heading', { name: 'Who is working?' })).toBeTruthy();

    // Wrong PIN first: the panel says so in plain words and nothing is signed in.
    await signInAs(user, /Baraka/, '0000');
    expect(await screen.findByText(/PIN does not match/)).toBeTruthy();

    // Right PIN.
    await signInAs(user, /Baraka/, '2222');
    expect(await screen.findByRole('button', { name: 'Sell' })).toBeTruthy();
    // Cashier does not get the owner's Activity tab or the IT panel map.
    expect(screen.queryByRole('button', { name: 'Activity' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Panel map' })).toBeNull();

    // Open a cake, keep the default version, add it.
    await user.click(await screen.findByRole('button', { name: /Chocolate Fudge Cake/ }));
    const sheet = await screen.findByRole('dialog', { name: 'Chocolate Fudge Cake' });
    expect(within(sheet).getByText(/in stock/)).toBeTruthy();
    await user.click(within(sheet).getByRole('button', { name: 'Add to order' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    // The order appears with the frozen price and needs payment.
    expect(await screen.findByRole('heading', { name: /^Order [A-Z]+-0001$/ })).toBeTruthy();
    expect(screen.getByText('Unpaid')).toBeTruthy();

    // Take full payment in cash.
    await user.click(screen.getByRole('button', { name: 'Take payment' }));
    const pay = await screen.findByRole('dialog', { name: 'Take payment' });
    await user.click(within(pay).getByRole('button', { name: 'Take payment' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // "Paid" is also a row label in the totals, so wait for the Unpaid chip to go instead.
    await waitFor(() => expect(screen.queryByText('Unpaid')).toBeNull());

    // Stock has NOT dropped yet (BR-03): still 4 on hand, with 1 committed on the open order.
    // A cashier can read stock but not edit it, so these are plain text cells.
    const versionCells = async () => {
      const card = await screen.findByRole('article', { name: 'Chocolate Fudge Cake' });
      const row = within(card).getByRole('row', { name: /Slice, Vanilla cream, Standard/ });
      const cells = within(row).getAllByRole('cell');
      return { price: cells[0]!.textContent, stock: cells[1]!.textContent, committed: cells[2]!.textContent };
    };
    await user.click(screen.getByRole('button', { name: 'Catalogue' }));
    await waitFor(async () => expect(await versionCells()).toMatchObject({ price: '5', stock: '4', committed: '1' }));
    expect(screen.queryByLabelText('Price for Slice, Vanilla cream, Standard')).toBeNull();

    // Hand over: ready, then handed over.
    await user.click(screen.getByRole('button', { name: 'Orders' }));
    await user.click(await screen.findByRole('button', { name: 'Mark ready' }));
    await user.click(await screen.findByRole('button', { name: 'Hand over' }));
    await waitFor(() => expect(screen.getAllByText('Completed').length).toBeGreaterThan(0));

    // Now stock has dropped from 4 to 3 and nothing is committed any more.
    await user.click(screen.getByRole('button', { name: 'Catalogue' }));
    await waitFor(async () => expect(await versionCells()).toMatchObject({ stock: '3', committed: '0' }));
  });

  it('IT sees only the panel map, and the map shows real activity', async () => {
    const user = userEvent.setup();
    render(
      <PanelProvider>
        <App />
      </PanelProvider>,
    );
    await signInAs(user, /Ibrahim/, '9999');
    expect(await screen.findByRole('heading', { name: 'Panel map' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Sell' })).toBeNull();
    // Live circuits and the planned ones are both listed honestly.
    expect(screen.getAllByText('Live').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Planned').length).toBeGreaterThan(0);
    expect(screen.getByText('Cloud sync')).toBeTruthy();
  });
});
