const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const resin = require('../lib/resin-colour');
const { formatOrder } = require('../notify');

test('resin print type and resin material turn colour options on when the flag is missing', () => {
  assert.equal(resin.colourOptionsEnabled({ printType: 'Resin', material: 'PLA' }), true);
  assert.equal(resin.colourOptionsEnabled({ printType: 'FDM', material: 'Tough (ABS-like) resin' }), true);
  assert.equal(resin.colourOptionsEnabled({ printType: 'FDM', material: 'PLA', colour: 'Black' }), false);
});

test('an explicit colourOptions flag wins over material and print type', () => {
  assert.equal(resin.colourOptionsEnabled({ printType: 'Resin', colourOptions: false }), false);
  assert.equal(resin.colourOptionsEnabled({ printType: 'FDM', material: 'PLA', colourOptions: true }), true);
});

test('missing flag is filled from resin detection and a saved flag is left alone', () => {
  const resinProduct = { printType: 'Resin', material: 'Standard resin' };
  assert.equal(resin.ensureColourOptions(resinProduct), true);
  assert.equal(resinProduct.colourOptions, true);

  const filament = { printType: 'FDM', material: 'PLA' };
  assert.equal(resin.ensureColourOptions(filament), true);
  assert.equal(filament.colourOptions, false);

  const chosenOff = { printType: 'Resin', colourOptions: false };
  assert.equal(resin.ensureColourOptions(chosenOff), false);
  assert.equal(chosenOff.colourOptions, false);
});

test('basket lines require Black, White, or Grey only when colour options are on', () => {
  const products = [
    { id: 1, name: 'Knight', price: 12, stock: 5, printType: 'Resin', colourOptions: true },
    { id: 2, name: 'Planter', price: 8, stock: 4, printType: 'FDM', material: 'PLA', colourOptions: false },
  ];

  const missing = resin.resolveBasket(products, [{ id: 1, qty: 1 }]);
  assert.equal(missing.status, 400);
  assert.match(missing.error, /Knight/);
  assert.match(missing.error, /Black, White, or Grey/);

  const bad = resin.resolveBasket(products, [{ id: 1, qty: 1, colour: 'Sage' }]);
  assert.equal(bad.status, 400);

  const ok = resin.resolveBasket(products, [
    { id: 1, qty: 1, colour: 'black' },
    { id: 1, qty: 2, colour: 'Grey' },
    { id: 2, qty: 1, colour: 'black' },
  ]);
  assert.equal(ok.error, undefined);
  assert.deepEqual(ok.lines.map(resin.orderItem), [
    { id: 1, name: 'Knight', qty: 1, price: 12, colour: 'Black' },
    { id: 1, name: 'Knight', qty: 2, price: 12, colour: 'Grey' },
    { id: 2, name: 'Planter', qty: 1, price: 8 },
  ]);
});

test('the same resin product in two colours shares one stock count', () => {
  const products = [
    { id: 1, name: 'Knight', price: 12, stock: 2, printType: 'Resin', colourOptions: true },
  ];
  const over = resin.resolveBasket(products, [
    { id: 1, qty: 1, colour: 'white' },
    { id: 1, qty: 2, colour: 'black' },
  ]);
  assert.equal(over.status, 409);
  assert.match(over.error, /Only 2 of Knight left/);
});

test('paid-order email names the resin colour', () => {
  const text = formatOrder({
    id: 'AB12',
    items: [{ qty: 2, name: 'Knight', price: 12, colour: 'Black' }],
    postage: 3.5,
    total: 27.5,
    amountPaid: 27.5,
    email: 'a@b.co.uk',
    shipping: { name: 'Ada', address: { line1: '1 Ink Lane', city: 'York', postal_code: 'YO1 1AA', country: 'GB' } },
  });
  assert.match(text, /2 × Knight — Black @/);
});

function startShop() {
  const port = 3877;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      ADMIN_PASSWORD: 'testpass',
      DATABASE_URL: '',
      STRIPE_SECRET_KEY: '',
      STRIPE_WEBHOOK_SECRET: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let buf = '';
  let started = false;
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('shop did not start\n' + buf)), 8000);
    child.stdout.on('data', chunk => {
      buf += chunk;
      if (!started && buf.includes('demo shop')) {
        started = true;
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr.on('data', chunk => { buf += chunk; });
    child.on('exit', code => {
      if (!started) {
        clearTimeout(timer);
        reject(new Error('shop exited ' + code + '\n' + buf));
      }
    });
  });
  return { child, port, ready };
}

test('admin flag, public catalogue, and checkout keep resin colour', async t => {
  const shop = startShop();
  t.after(() => { shop.child.kill('SIGTERM'); });
  await shop.ready;
  const base = 'http://127.0.0.1:' + shop.port;
  const auth = 'Basic ' + Buffer.from('owner:testpass').toString('base64');
  const created = [];
  async function api(url, options) {
    const res = await fetch(base + url, options);
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return { status: res.status, body };
  }
  function form(fields) {
    const fd = new FormData();
    Object.entries(fields).forEach(([key, value]) => fd.set(key, value));
    return fd;
  }
  try {
    const resinProduct = await api('/api/admin/products', {
      method: 'POST',
      headers: { Authorization: auth },
      body: form({ name: 'Resin colour knight', price: '12', stock: '3', printType: 'Resin', material: 'Standard resin' }),
    });
    assert.equal(resinProduct.status, 200);
    assert.equal(resinProduct.body.colourOptions, true);
    created.push(resinProduct.body.id);

    const byMaterial = await api('/api/admin/products', {
      method: 'POST',
      headers: { Authorization: auth },
      body: form({ name: 'Material resin dish', price: '9', stock: '2', printType: 'FDM', material: 'Tough (ABS-like) resin' }),
    });
    assert.equal(byMaterial.status, 200);
    assert.equal(byMaterial.body.colourOptions, true);
    created.push(byMaterial.body.id);

    const filament = await api('/api/admin/products', {
      method: 'POST',
      headers: { Authorization: auth },
      body: form({ name: 'PLA planter', price: '8', stock: '4', printType: 'FDM', material: 'PLA', colourOptions: 'false' }),
    });
    assert.equal(filament.status, 200);
    assert.equal(filament.body.colourOptions, false);
    created.push(filament.body.id);

    const optedIn = await api('/api/admin/products', {
      method: 'POST',
      headers: { Authorization: auth },
      body: form({ name: 'Optional colour clip', price: '4', stock: '4', printType: 'FDM', material: 'PETG', colourOptions: 'true' }),
    });
    assert.equal(optedIn.status, 200);
    assert.equal(optedIn.body.colourOptions, true);
    created.push(optedIn.body.id);

    const list = await api('/api/products');
    const pubResin = list.body.find(p => p.id === resinProduct.body.id);
    const pubFilament = list.body.find(p => p.id === filament.body.id);
    assert.equal(pubResin.colourOptions, true);
    assert.deepEqual(pubResin.colours.map(c => c.label), ['Black', 'White', 'Grey']);
    assert.equal(pubFilament.colourOptions, false);
    assert.deepEqual(pubFilament.colours, []);

    const hidden = await api('/api/admin/products/' + optedIn.body.id, {
      method: 'PUT',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ hidden: true }),
    });
    assert.equal(hidden.status, 200);
    assert.equal(hidden.body.colourOptions, true);
    assert.equal(hidden.body.hidden, true);

    const turnedOff = await api('/api/admin/products/' + resinProduct.body.id, {
      method: 'PUT',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ colourOptions: false }),
    });
    assert.equal(turnedOff.status, 200);
    assert.equal(turnedOff.body.colourOptions, false);

    const missing = await api('/api/checkout/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [{ id: byMaterial.body.id, qty: 1 }] }),
    });
    assert.equal(missing.status, 400);
    assert.match(missing.body.error, /Black, White, or Grey/);

    const accepted = await api('/api/checkout/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [{ id: byMaterial.body.id, qty: 1, colour: 'White' }, { id: filament.body.id, qty: 1 }] }),
    });
    assert.equal(accepted.status, 503);
    assert.equal(accepted.body.notConfigured, true);
  } finally {
    for (const id of created) {
      await api('/api/admin/products/' + id, { method: 'DELETE', headers: { Authorization: auth } });
    }
  }
});
