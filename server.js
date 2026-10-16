const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');
const DB = path.join(__dirname, 'data', 'db.json');

const SEED = path.join(__dirname, 'data', 'seed.json');
const SAMPLES = JSON.parse(fs.readFileSync(SEED, 'utf8'));

function load() {
  fs.mkdirSync(path.dirname(DB), { recursive: true });
  if (!fs.existsSync(DB)) {
    const db = { products: SAMPLES.map((p, i) => ({ id: i + 1, sample: true, ...p })), orders: [], nextId: SAMPLES.length + 1 };
    save(db); return db;
  }
  return JSON.parse(fs.readFileSync(DB, 'utf8'));
}
function save(d) { const t = DB + '.tmp'; fs.writeFileSync(t, JSON.stringify(d, null, 2)); fs.renameSync(t, DB); }
let db = load();

const app = express();
app.use(express.json());

function isApp(req) {
  const ua = req.get('user-agent') || '';
  const mark = (req.get('x-craftedimension-app') || '').trim();
  return ua.includes('CraftedimensionApp') || mark === '1';
}
function notForApp(req, res, next) {
  if (!isApp(req)) return next();
  res.status(404).type('text').send('Not found');
}
function stripAdminLinks(html) {
  return html.replace(/<a\b[^>]*href=(["'])\/admin\/?\1[^>]*>[\s\S]*?<\/a>/gi, '');
}
function sendShopHtml(req, res, name) {
  fs.readFile(path.join(__dirname, 'public', name), 'utf8', (err, html) => {
    if (err) return res.status(404).type('text').send('Not found');
    if (isApp(req)) html = stripAdminLinks(html).replace(/<html\b/i, '<html data-app="1"');
    res.type('html').send(html);
  });
}

// Read-only public GETs. Admin routes stay same-origin and are not listed here.
app.use((req, res, next) => {
  if (req.method === 'GET' && req.path.startsWith('/api/') && !req.path.startsWith('/api/admin')) {
    res.set('Access-Control-Allow-Origin', '*');
  }
  next();
});
app.use('/admin', notForApp);
app.use('/api/admin', notForApp);

const pub = p => ({ id: p.id, name: p.name, description: p.description, price: p.price, stock: p.stock, gradient: p.gradient, printType: p.printType || 'FDM', sample: !!p.sample });
app.get('/api/products', (req, res) => {
  const t = String(req.query.type || '').toLowerCase();
  res.json(db.products.filter(p => !t || t === 'all' || (p.printType || 'FDM').toLowerCase() === t).map(pub));
});

// Checkout: Node is single-threaded and this handler is fully synchronous, so
// validate-then-decrement runs atomically. All lines succeed or none do.
app.post('/api/checkout', (req, res) => {
  const { name, email, items } = req.body || {};
  if (!name || !email || !/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Name and a valid email are required.' });
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'Cart is empty.' });
  const qty = {};
  for (const it of items) {
    const q = Math.floor(Number(it.qty));
    if (!(q > 0)) return res.status(400).json({ error: 'Invalid quantity.' });
    qty[it.id] = (qty[it.id] || 0) + q;
  }
  const lines = [];
  for (const [id, q] of Object.entries(qty)) {
    const p = db.products.find(x => x.id === Number(id));
    if (!p) return res.status(400).json({ error: `Unknown product ${id}.` });
    if (p.stock < q) return res.status(409).json({ error: p.stock === 0 ? `${p.name} is sold out.` : `Only ${p.stock} of ${p.name} left.`, products: db.products.map(pub) });
    lines.push({ p, q });
  }
  lines.forEach(({ p, q }) => { p.stock -= q; });
  const order = { id: crypto.randomBytes(4).toString('hex').toUpperCase(), name, email, createdAt: new Date().toISOString(),
    items: lines.map(({ p, q }) => ({ id: p.id, name: p.name, qty: q, price: p.price })),
    total: +lines.reduce((s, { p, q }) => s + p.price * q, 0).toFixed(2), payment: 'not connected (demo)' };
  db.orders.push(order); save(db);
  res.json({ ok: true, order, products: db.products.map(pub) });
});

// Admin (HTTP Basic auth, any username)
function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const pw = Buffer.from(h.split(' ')[1] || '', 'base64').toString().split(':').slice(1).join(':');
  if (h.startsWith('Basic ') && pw.length === ADMIN_PASSWORD.length && crypto.timingSafeEqual(Buffer.from(pw), Buffer.from(ADMIN_PASSWORD))) return next();
  res.set('WWW-Authenticate', 'Basic realm="Craftedimension admin"').status(401).send('Authentication required');
}
app.get('/admin', auth, (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/api/admin/data', auth, (req, res) => res.json(db));
function clean(b, base = {}) {
  const p = { ...base };
  if (b.name !== undefined) p.name = String(b.name).slice(0, 120);
  if (b.description !== undefined) p.description = String(b.description).slice(0, 500);
  if (b.price !== undefined) p.price = Math.max(0, +Number(b.price).toFixed(2) || 0);
  if (b.stock !== undefined) p.stock = Math.max(0, Math.floor(Number(b.stock)) || 0);
  if (b.gradient !== undefined) p.gradient = Number(b.gradient) % 3 || 0;
  if (b.printType !== undefined) p.printType = String(b.printType).toLowerCase() === 'resin' ? 'Resin' : 'FDM';
  if (b.sample !== undefined) p.sample = !!b.sample;
  return p;
}
app.post('/api/admin/products', auth, (req, res) => {
  if (!req.body.name) return res.status(400).json({ error: 'Name required' });
  const p = clean({ price: 0, stock: 0, gradient: 0, description: '', sample: false, printType: 'FDM', ...req.body }, { id: db.nextId++ });
  db.products.push(p); save(db); res.json(p);
});
app.put('/api/admin/products/:id', auth, (req, res) => {
  const i = db.products.findIndex(p => p.id === Number(req.params.id));
  if (i < 0) return res.status(404).json({ error: 'Not found' });
  db.products[i] = clean(req.body, db.products[i]); save(db); res.json(db.products[i]);
});
app.delete('/api/admin/products/:id', auth, (req, res) => {
  db.products = db.products.filter(p => p.id !== Number(req.params.id)); save(db); res.json({ ok: true });
});

app.get(['/', '/index.html'], (req, res) => sendShopHtml(req, res, 'index.html'));
app.get(['/privacy', '/privacy.html'], (req, res) => sendShopHtml(req, res, 'privacy.html'));
app.use(express.static(path.join(__dirname, 'public')));
app.listen(PORT, () => {
  console.log(`Craftedimension demo shop on http://localhost:${PORT}`);
  console.log(`Admin: http://localhost:${PORT}/admin  password: ${ADMIN_PASSWORD}${process.env.ADMIN_PASSWORD ? ' (from env)' : ' (random, generated at startup — set ADMIN_PASSWORD to fix it)'}`);
});
