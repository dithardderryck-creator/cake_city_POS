import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { configure, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WebSocket } from 'ws';
import { createScryptHasher, loadConfig, createLogger, startServer, type RunningServer } from '@cake-pos/server';
import { seedDemo } from '@cake-pos/panel';

configure({ asyncUtilTimeout: 6000 });

let server: RunningServer;
let dataDir: string;

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cakepos-ui-'));
  const config = loadConfig({ DATA_DIR: dataDir, PORT: '0', HOST: '127.0.0.1' });
  server = await startServer({ config, log: createLogger({ level: 'error', stdout: false }) });
  await seedDemo(server.store, server.panel, createScryptHasher());
  // The app in "real" mode: pointed at this server, using a real WebSocket for live feeds.
  vi.stubEnv('VITE_SERVER_URL', server.url);
  vi.stubGlobal('WebSocket', WebSocket);
});

afterAll(async () => {
  await server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function mountApp() {
  vi.resetModules();
  localStorage.clear();
  const [{ default: App }, { PanelProvider }] = await Promise.all([import('./App'), import('./lib/panel')]);
  render(
    <PanelProvider>
      <App />
    </PanelProvider>,
  );
}

async function signInAs(user: ReturnType<typeof userEvent.setup>, staff: RegExp, pin: string) {
  await user.click(await screen.findByRole('radio', { name: staff }));
  const keypad = screen.getByRole('group', { name: 'PIN keypad' });
  for (const d of pin) await user.click(within(keypad).getByRole('button', { name: d }));
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
}

describe('the same app, running against the real shop server', () => {
  it('a cashier sells a cake, and the SERVER’s database ends up right', async () => {
    const user = userEvent.setup();
    await mountApp();
    expect(await screen.findByRole('heading', { name: 'Who is working?' })).toBeTruthy();

    await signInAs(user, /Baraka/, '0000');
    expect(await screen.findByText(/PIN does not match/)).toBeTruthy();
    await signInAs(user, /Baraka/, '2222');
    expect(await screen.findByRole('button', { name: 'Sell' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Staff' })).toBeNull(); // not a cashier's screen

    await user.click(await screen.findByRole('button', { name: /Chocolate Fudge Cake/ }));
    const sheet = await screen.findByRole('dialog', { name: 'Chocolate Fudge Cake' });
    await user.click(within(sheet).getByRole('button', { name: 'Add to order' }));
    expect(await screen.findByRole('heading', { name: /^Order S-0001$/ })).toBeTruthy();

    await user.click(await screen.findByRole('button', { name: 'Take payment' }));
    const pay = await screen.findByRole('dialog', { name: 'Take payment' });
    await user.click(within(pay).getByRole('button', { name: 'Take payment' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    await user.click(screen.getByRole('button', { name: 'Orders' }));
    await user.click(await screen.findByRole('button', { name: 'Mark ready' }));
    await user.click(await screen.findByRole('button', { name: 'Hand over' }));
    await waitFor(() => expect(screen.getAllByText('Completed').length).toBeGreaterThan(0));

    // Not just what the screen says: what the server actually recorded.
    const payments = await server.store.list<{ id: string; amount: number; method: string }>('payments');
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({ amount: 5, method: 'cash' });
    const sales = (await server.store.list<{ id: string; combinationId: string; qty: number; reason: string }>('stockMovements')).filter((m) => m.reason === 'sale');
    expect(sales).toHaveLength(1);
    expect(sales[0]!.qty).toBe(-1);
    const sold = await server.store.get<{ id: string; stockCount: number }>('combinations', sales[0]!.combinationId);
    expect(sold?.stockCount).toBe(3); // that one slice went from 4 to 3
    const audit = await server.store.list<{ id: string; actorName?: string; intent: string; outcome: string }>('audit');
    expect(audit.some((a) => a.actorName?.startsWith('Baraka') && a.intent === 'orders/advance_line' && a.outcome === 'ok')).toBe(true);
    expect(audit.some((a) => a.intent === 'auth/sign_in' && a.outcome === 'denied')).toBe(true); // the wrong PIN is on record
  });

  it('the owner manages staff, and a new person can then sign in', async () => {
    const user = userEvent.setup();
    await mountApp();
    await signInAs(user, /Amina/, '1111');
    await user.click(await screen.findByRole('button', { name: 'Staff' }));
    expect(await screen.findByRole('heading', { name: 'Staff' })).toBeTruthy();

    const form = await screen.findByRole('region', { name: 'Add someone' });
    await user.type(within(form).getByLabelText('Name'), 'Zawadi');
    await user.type(within(form).getByLabelText('PIN'), '7777');
    await user.click(within(form).getByRole('button', { name: 'Add person' }));
    expect(await screen.findByText('Zawadi')).toBeTruthy(); // the live list updated by itself

    // Sign out, then sign in as the new person with the PIN just set.
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    await signInAs(user, /Zawadi/, '7777');
    expect(await screen.findByRole('button', { name: 'Sell' })).toBeTruthy();
  });

  it('IT sees real system facts and backup state from the server', async () => {
    const user = userEvent.setup();
    await mountApp();
    await signInAs(user, /Ibrahim/, '9999');
    expect(await screen.findByRole('heading', { name: 'Panel map' })).toBeTruthy();
    expect(await screen.findByText('This computer')).toBeTruthy();
    expect(screen.getByText('Data folder')).toBeTruthy();
    expect(screen.getByText(/No backup has been taken yet/)).toBeTruthy();
  });
});
