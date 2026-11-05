const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn } = require('node:child_process');

const root = path.join(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');

const ABOUT = 'Crafted.i.mentions. specialises in skulls, gothic oddities, and curious pieces — made to leave your shelves a little haunted. Each piece starts as a careful FDM or resin print, then gets a hand finish so paint, wear, and detail land with a real twist — never factory-flat. With passion for a craft, design and art, every piece is unique.';

const CUSTOMER_FILES = [
  'public/index.html',
  'public/shop.js',
  'public/order-enquiry.js',
  'public/terms.html',
  'public/privacy.html',
  'public/delivery.html',
  'public/returns.html',
  'public/materials.html',
  'public/custom.html',
  'public/styles.css',
];

test('bank transfer enquiry names pieces, postage and total, and an empty basket has no mailto', () => {
  const enquiry = require('../lib/order-enquiry');
  const lines = [
    { title: 'Knight — Black', qty: 1, price: 12 },
    { title: 'Knight — Grey', qty: 2, price: 12 },
    { title: 'Planter', qty: 1, price: 8 },
  ];
  const text = enquiry.message(lines);
  assert.match(text, /1 × Knight — Black — £12\.00/);
  assert.match(text, /2 × Knight — Grey — £24\.00/);
  assert.match(text, /1 × Planter — £8\.00/);
  assert.match(text, /Subtotal: £44\.00/);
  assert.match(text, /UK postage: FREE/);
  assert.match(text, /Total: £44\.00/);
  assert.match(text, /bank transfer/i);
  assert.match(text, /payment instructions/i);
  assert.doesNotMatch(text, /sort code|account number|account name|IBAN|paid|confirmed order|payment received/i);

  const small = enquiry.message([{ title: 'Planter', qty: 1, price: 8 }]);
  assert.match(small, /UK postage: £3\.50/);
  assert.match(small, /Total: £11\.50/);

  const edge = enquiry.message([{ title: 'Planter', qty: 1, price: 35 }]);
  assert.match(edge, /UK postage: FREE/);
  assert.match(edge, /Total: £35\.00/);

  assert.equal(enquiry.message([]), '');
  assert.equal(enquiry.mailto([]), '');
  const href = enquiry.mailto(lines);
  assert.equal(href.startsWith('mailto:teamcraftedimensions@gmail.com?'), true);
  const query = new URLSearchParams(href.slice(href.indexOf('?') + 1));
  assert.equal(query.get('subject'), 'Bank transfer order enquiry');
  assert.equal(query.get('body'), text);
  const browserCopy = require('../public/order-enquiry');
  assert.equal(browserCopy.message(lines), text);
  assert.equal(browserCopy.mailto([]), '');
});

test('customer pages and shop script do not offer Stripe or card checkout', () => {
  const banned = [
    /stripe/i,
    /card payments coming soon/i,
    /checkout securely/i,
    /secure checkout/i,
    /payments by stripe/i,
    /js\.stripe\.com/i,
    /api\/checkout\/session/i,
  ];
  for (const file of CUSTOMER_FILES) {
    const text = read(file);
    for (const pattern of banned) {
      assert.equal(pattern.test(text), false, file + ' matches ' + pattern);
    }
  }
  const home = read('public/index.html');
  assert.match(home, /Bank transfer only for now/);
  assert.match(home, /do not take card payments/i);
  assert.match(home, /teamcraftedimensions@gmail\.com/);
  assert.match(home, /£3\.50/);
  assert.match(home, /free above £35/i);
  assert.match(home, new RegExp(ABOUT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(home, /Every curve and edge is checked on screen/);
  assert.match(home, /logo-header\.v7/);
  const shop = read('public/shop.js');
  assert.match(shop, /orderEnquiry\.mailto/);
  assert.doesNotMatch(shop, /location\.href\s*=/);
  assert.doesNotMatch(shop, /closest\('a\.order-link'\)/);
  const terms = read('public/terms.html');
  assert.match(terms, /bank transfer only/i);
  assert.match(terms, /\[OWNER NAME\]/);
  assert.match(terms, /\[BUSINESS ADDRESS\]/);
  assert.doesNotMatch(terms, /card payments are taken/i);
  const returns = read('public/returns.html');
  assert.match(returns, /14 days after you receive the goods/);
  assert.match(returns, /14 days after telling us/);
});

function startShop(port, extraEnv) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      ADMIN_PASSWORD: 'testpass',
      DATABASE_URL: '',
      STRIPE_SECRET_KEY: 'sk_test_disabled_checkout_closed',
      STRIPE_WEBHOOK_SECRET: 'whsec_test_historical_only',
      STRIPE_ALLOW_LIVE: '',
      ...extraEnv,
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

test('card checkout cannot start a session, and public pages say bank transfer', async t => {
  const shop = startShop(3878);
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
    return { status: res.status, body, headers: res.headers };
  }
  function form(fields) {
    const fd = new FormData();
    Object.entries(fields).forEach(([key, value]) => fd.set(key, value));
    return fd;
  }
  try {
    const home = await api('/');
    assert.equal(home.status, 200);
    assert.match(home.body, /Bank transfer only for now/);
    assert.doesNotMatch(home.body, /stripe/i);
    const csp = home.headers.get('content-security-policy') || '';
    assert.doesNotMatch(csp, /stripe/i);

    const config = await api('/api/config');
    assert.equal(config.body.payments, false);
    assert.equal(config.body.postage, 3.5);
    assert.equal(config.body.freePostageFrom, 35);
    assert.equal(JSON.stringify(config.body).toLowerCase().includes('stripe'), false);

    const resin = await api('/api/admin/products', {
      method: 'POST',
      headers: { Authorization: auth },
      body: form({ name: 'Bank transfer knight', price: '12', stock: '3', printType: 'Resin', material: 'Standard resin' }),
    });
    assert.equal(resin.status, 200);
    created.push(resin.body.id);

    const before = await api('/api/admin/data', { headers: { Authorization: auth } });
    const ordersBefore = before.body.orders.length;

    const missing = await api('/api/checkout/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [{ id: resin.body.id, qty: 1 }] }),
    });
    assert.equal(missing.status, 400);
    assert.match(missing.body.error, /Black, White, or Grey/);

    const empty = await api('/api/checkout/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [] }),
    });
    assert.equal(empty.status, 400);
    assert.match(empty.body.error, /basket is empty/i);
    assert.equal(empty.body.url, undefined);

    const closed = await api('/api/checkout/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [{ id: resin.body.id, qty: 1, colour: 'Black' }] }),
    });
    assert.equal(closed.status, 503);
    assert.equal(closed.body.notConfigured, true);
    assert.equal(closed.body.url, undefined);
    assert.match(closed.body.error, /bank transfer/i);
    assert.doesNotMatch(closed.body.error, /stripe/i);

    const after = await api('/api/admin/data', { headers: { Authorization: auth } });
    assert.equal(after.body.orders.length, ordersBefore);
    assert.equal(after.body.products.find(p => p.id === resin.body.id).stock, 3);

    const success = await api('/checkout/success');
    assert.doesNotMatch(success.body, /stripe/i);
    const cancel = await api('/checkout/cancel');
    assert.doesNotMatch(cancel.body, /stripe/i);
    const terms = await api('/terms');
    assert.match(terms.body, /bank transfer only/i);
    assert.doesNotMatch(terms.body, /stripe/i);
  } finally {
    for (const id of created) {
      await api('/api/admin/products/' + id, { method: 'DELETE', headers: { Authorization: auth } });
    }
  }
});
