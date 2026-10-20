const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Stripe = require('stripe');
const multer = require('multer');
const sharp = require('sharp');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const notify = require('./notify');

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY || '';
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
// Test mode only unless the owner deliberately opts in to live keys.
const LIVE_BLOCKED = STRIPE_KEY.startsWith('sk_live_') && process.env.STRIPE_ALLOW_LIVE !== '1';
const PAYMENTS_ON = !!STRIPE_KEY && !LIVE_BLOCKED;
const RESERVE_MIN = 30; // Stripe minimum session lifetime is 30 min
function stripeOpts() {
  // STRIPE_API_BASE is for local testing against a mock (e.g. http://127.0.0.1:12111). Never set it on Render.
  if (!process.env.STRIPE_API_BASE) return {};
  const u = new URL(process.env.STRIPE_API_BASE);
  return { host: u.hostname, port: u.port, protocol: u.protocol.replace(':', '') };
}
const stripe = new Stripe(STRIPE_KEY || 'sk_test_not_configured', stripeOpts());

const store = require('./store')();
let db = null; // loaded in start()
function save(d) { const p = store.save(d); p.catch(() => {}); return p; }

const MAX_PHOTO = 8 * 1024 * 1024;
const MAX_PHOTOS = 8;
const MAX_PHOTO_REQUEST = 32 * 1024 * 1024;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PHOTO, files: MAX_PHOTOS },
  fileFilter(req, file, cb) {
    const type = String(file.mimetype || '').toLowerCase();
    const name = String(file.originalname || '').toLowerCase();
    if (type.startsWith('image/') || /\.(jpe?g|png|webp|heic|heif)$/.test(name)) return cb(null, true);
    cb(new Error('Please choose a photo (JPEG, PNG, WebP or HEIC).'));
  },
});
function withPhoto(req, res, next) {
  const ct = req.headers['content-type'] || '';
  if (!ct.includes('multipart/form-data')) return next();
  upload.fields([{ name: 'photos', maxCount: MAX_PHOTOS }, { name: 'photo', maxCount: 1 }])(req, res, err => {
    if (err) {
      const tooBig = err.code === 'LIMIT_FILE_SIZE';
      const tooMany = err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE';
      const status = tooBig ? 413 : 400;
      const error = tooBig ? 'That photo is larger than 8MB. Please choose a smaller one.'
        : tooMany ? 'You can add up to 8 photos.'
        : (err.message || 'Could not read that photo.');
      return res.status(status).json({ error });
    }
    const files = photoFiles(req);
    const total = files.reduce((sum, file) => sum + (file.size || 0), 0);
    if (total > MAX_PHOTO_REQUEST) return res.status(413).json({ error: 'Those photos are larger than 32MB together. Please choose smaller ones.' });
    next();
  });
}
function photoFiles(req) {
  const groups = req.files || {};
  return [].concat(groups.photos || [], groups.photo || []);
}
async function makeWebp(buf) {
  const img = sharp(buf, { failOn: 'none', animated: false, limitInputPixels: 80e6 }).rotate();
  const meta = await img.metadata();
  if (!meta || !meta.width || !meta.height) throw new Error('unreadable');
  const full = await img.clone().resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();
  const thumb = await img.clone().resize({ width: 400, height: 400, fit: 'inside', withoutEnlargement: true }).webp({ quality: 75 }).toBuffer();
  return { full, thumb };
}
function photoError() {
  return "Couldn't use that photo. Please choose a JPEG, PNG, WebP or HEIC image.";
}

const MAX_CUSTOM = 20 * 1024 * 1024;
const customUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_CUSTOM, files: 1 },
  fileFilter(req, file, cb) {
    const type = String(file.mimetype || '').toLowerCase();
    const name = String(file.originalname || '').toLowerCase();
    if (/\.(stl|3mf|obj)$/.test(name) || type.startsWith('image/') || /\.(jpe?g|png|webp|gif|heic|heif|bmp)$/.test(name)) return cb(null, true);
    cb(new Error('Please upload an STL, 3MF, OBJ or an image.'));
  },
});
function withCustomFile(req, res, next) {
  customUpload.single('file')(req, res, err => {
    if (!err) return next();
    const tooBig = err.code === 'LIMIT_FILE_SIZE';
    res.status(tooBig ? 413 : 400).json({
      error: tooBig ? 'That file is larger than 20MB. Please send a smaller one.' : (err.message || 'Could not read that file.'),
    });
  });
}
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // Render terminates HTTPS at its proxy
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      scriptSrc: ["'self'", 'https://js.stripe.com', "'unsafe-inline'"],
      styleSrc: ["'self'", 'https://fonts.googleapis.com', "'unsafe-inline'"],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:', 'blob:'],
      connectSrc: ["'self'", 'https://api.stripe.com', 'https://checkout.stripe.com'],
      frameSrc: ['https://js.stripe.com', 'https://checkout.stripe.com'],
      formAction: ["'self'", 'https://checkout.stripe.com'],
      frameAncestors: ["'none'"],
      objectSrc: ["'none'"],
    },
  },
  strictTransportSecurity: { maxAge: 15552000, includeSubDomains: false },
  frameguard: { action: 'deny' },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  crossOriginEmbedderPolicy: false,
}));
function tooMany(req, res) {
  const msg = 'Too many requests from this address. Please try again later.';
  if (String(req.originalUrl || '').startsWith('/api/')) return res.status(429).json({ error: msg });
  res.status(429).type('text').send(msg);
}
const limitOpts = (windowMs, limit) => ({
  windowMs, limit, standardHeaders: true, legacyHeaders: false, handler: tooMany,
  skip: req => String((req.body && req.body.company) || '').trim() !== '',
});
const checkoutLimit = rateLimit(limitOpts(15 * 60 * 1000, 10));
const customLimit = rateLimit(limitOpts(60 * 60 * 1000, 5));
const contactLimit = rateLimit(limitOpts(60 * 60 * 1000, 5));
const adminAuthLimit = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false,
  skipSuccessfulRequests: true, handler: tooMany,
});
app.get('/healthz', (req, res) => res.status(200).type('text').send('ok'));
// Stripe webhook needs the raw body for signature checks, so it is registered before express.json().
app.post('/api/stripe/webhook', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
  if (!WEBHOOK_SECRET) { console.warn('[stripe] webhook received but STRIPE_WEBHOOK_SECRET is not set'); return res.status(503).send('Webhook not configured'); }
  let event;
  try { event = stripe.webhooks.constructEvent(req.body, req.get('stripe-signature') || '', WEBHOOK_SECRET); }
  catch (e) { console.warn('[stripe] bad webhook signature:', e.message); return res.status(400).send('Bad signature'); }
  // Persist before acknowledging, so Stripe retries if the database write fails.
  try { handleEvent(event); await store.flush(); await save(db); } catch (e) { console.error('[stripe] handler error', e); return res.status(500).send('Handler error'); }
  res.json({ received: true });
});
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
app.use('/admin', adminAuthLimit);
app.use('/api/admin', adminAuthLimit);

function cmNumber(mm) {
  const n = Number(mm);
  if (!Number.isFinite(n)) return '';
  return String(Math.round(n * 10) / 100);
}
// Stored size is mm: l is depth, w is width, h is height. Shop text is cm, whole numbers without a trailing .0.
function formatSizeText(size) {
  const s = size && typeof size === 'object' ? size : {};
  const parts = [];
  if (s.h != null && s.h !== '') parts.push('H ' + cmNumber(s.h));
  if (s.w != null && s.w !== '') parts.push('W ' + cmNumber(s.w));
  if (s.l != null && s.l !== '') parts.push('D ' + cmNumber(s.l));
  return parts.length ? parts.join(' \u00d7 ') + ' cm' : '';
}
const pub = p => {
  const size = p.size_mm || { l: null, w: null, h: null };
  const o = {
    id: p.id, name: p.name, description: p.description, price: p.price, stock: p.stock, gradient: p.gradient, printType: p.printType || 'FDM', sample: !!p.sample,
    material: p.material || '', colour: p.colour || '', size_mm: size, sizeText: formatSizeText(size),
    detail: p.detail || '', finish: p.finish || 'raw', care_notes: p.care_notes || '',
    lead_time_days: Array.isArray(p.lead_time_days) ? p.lead_time_days : [3, 7],
  };
  const keys = Array.isArray(p.images) ? p.images : [];
  if (keys.length) {
    const v = p.photoRev || 1;
    const shot = (key, index) => index === 0
      ? { url: `/img/p/${p.id}.webp?v=${v}`, thumb: `/img/p/${p.id}-thumb.webp?v=${v}` }
      : { url: `/img/p/${p.id}-${key}.webp?v=${v}`, thumb: `/img/p/${p.id}-${key}-thumb.webp?v=${v}` };
    const main = shot(keys[0], 0);
    o.image = main.url;
    o.thumb = main.thumb;
    o.images = keys.map((key, index) => shot(key, index));
  }
  return o;
};
function publicList() { return db.products.filter(p => !p.hidden).map(pub); }
app.get('/api/products', (req, res) => {
  const t = String(req.query.type || '').toLowerCase();
  res.json(publicList().filter(p => !t || t === 'all' || (p.printType || 'FDM').toLowerCase() === t));
});
app.get('/img/p/:name', async (req, res) => {
  const m = /^(\d+)(?:-([a-f0-9]{8}))?(-thumb)?\.webp$/.exec(req.params.name);
  if (!m) return res.status(404).type('text').send('Not found');
  const id = Number(m[1]);
  const product = db.products.find(p => p.id === id);
  const keys = product && Array.isArray(product.images) ? product.images : [];
  const slot = m[2] || keys[0] || '0';
  if (m[2] && !keys.includes(m[2])) return res.status(404).type('text').send('Not found');
  let img;
  try { img = await store.readImage(id, m[3] ? 'thumb' : 'full', slot); }
  catch (e) { console.error('[img]', e.message); return res.status(500).type('text').send('Not found'); }
  if (!img) return res.status(404).type('text').send('Not found');
  if (!Buffer.isBuffer(img.buf)) img.buf = Buffer.from(img.buf);
  const etag = '"' + new Date(img.updated).getTime() + '-' + img.buf.length + '"';
  res.set('Content-Type', 'image/webp');
  res.set('Cache-Control', 'public, max-age=86400');
  res.set('ETag', etag);
  if (req.get('if-none-match') === etag) return res.status(304).end();
  res.send(img.buf);
});

// --- Stripe Checkout -------------------------------------------------------
// Prices and stock come from the server's product data only; the client sends ids and quantities.
const pence = n => Math.round(Number(n) * 100);
// Postage (UK): free when the goods subtotal is £30 or more, otherwise £3.50. Computed in pence.
const FREE_POSTAGE_FROM_P = 3000, POSTAGE_P = 350;
const postagePence = subtotalP => (subtotalP >= FREE_POSTAGE_FROM_P ? 0 : POSTAGE_P);
function baseUrl(req) { return (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, ''); }
function releaseStock(order) {
  if (order.stockReleased || order.status !== 'pending') return;
  order.items.forEach(i => { const p = db.products.find(x => x.id === i.id); if (p) p.stock += i.qty; });
  order.stockReleased = true;
}

app.get('/api/config', (req, res) => res.json({ payments: PAYMENTS_ON, testMode: !STRIPE_KEY.startsWith('sk_live_'), freePostageFrom: FREE_POSTAGE_FROM_P / 100, postage: POSTAGE_P / 100 }));
// Lets the basket (e.g. in the Android app, where Stripe opens in the browser) see whether its order was paid.
app.get('/api/orders/:id/status', (req, res) => {
  const o = db.orders.find(x => x.id === String(req.params.id));
  res.json(o ? { status: o.status } : { status: 'unknown' });
});

app.post('/api/checkout/session', checkoutLimit, async (req, res) => {
  if (!PAYMENTS_ON) return res.status(503).json({ error: "Payments aren't set up yet — please check back soon or contact us to order.", notConfigured: true });
  const { items } = req.body || {};
  if (!Array.isArray(items) || !items.length || items.length > 50) return res.status(400).json({ error: 'Your basket is empty.' });
  const qty = {};
  for (const it of items) {
    const q = Math.floor(Number(it && it.qty));
    if (!(q > 0 && q <= 100)) return res.status(400).json({ error: 'Invalid quantity.' });
    qty[it.id] = (qty[it.id] || 0) + q;
  }
  const lines = [];
  for (const [id, q] of Object.entries(qty)) {
    const p = db.products.find(x => x.id === Number(id));
    if (!p) return res.status(400).json({ error: `Unknown product ${id}.` });
    if (p.hidden) return res.status(409).json({ error: `${p.name} isn't in the shop any more.`, products: publicList() });
    if (!(p.price > 0)) return res.status(400).json({ error: `${p.name} can't be bought online yet.` });
    if (p.stock < q) return res.status(409).json({ error: p.stock === 0 ? `${p.name} is sold out.` : `Only ${p.stock} of ${p.name} left.`, products: publicList() });
    lines.push({ p, q });
  }
  // Reserve stock now (synchronously, so no oversell); released if the session expires or is cancelled.
  lines.forEach(({ p, q }) => { p.stock -= q; });
  const order = { id: crypto.randomBytes(4).toString('hex').toUpperCase(), status: 'pending', createdAt: new Date().toISOString(),
    items: lines.map(({ p, q }) => ({ id: p.id, name: p.name, qty: q, price: p.price })),
    currency: 'gbp' };
  const subP = lines.reduce((s, { p, q }) => s + pence(p.price) * q, 0), postP = postagePence(subP);
  order.subtotal = subP / 100; order.postage = postP / 100; order.total = (subP + postP) / 100;
  db.orders.push(order);
  try { await save(db); } catch { releaseStock(order); db.orders.pop(); return res.status(503).json({ error: "The shop couldn't save your order. Please try again." }); }
  const base = baseUrl(req);
  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      currency: 'gbp',
      line_items: lines.map(({ p, q }) => ({ quantity: q, price_data: { currency: 'gbp', unit_amount: pence(p.price), product_data: { name: p.name } } })),
      shipping_address_collection: { allowed_countries: ['GB'] },
      shipping_options: [{ shipping_rate_data: { type: 'fixed_amount', display_name: postP ? 'UK delivery' : 'Free UK delivery (orders £30+)',
        fixed_amount: { amount: postP, currency: 'gbp' } } }],
      client_reference_id: order.id,
      metadata: { order_id: order.id },
      expires_at: Math.floor(Date.now() / 1000) + RESERVE_MIN * 60,
      success_url: `${base}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${base}/checkout/cancel?order=${order.id}`,
    }, { idempotencyKey: 'order-' + order.id });
    order.sessionId = session.id; await save(db);
    res.json({ url: session.url, order: order.id });
  } catch (e) {
    console.error('[stripe] session create failed:', e.message);
    releaseStock(order); order.status = 'failed'; save(db);
    res.status(502).json({ error: "We couldn't start the payment. Please try again in a moment.", products: publicList() });
  }
});

function shippingOf(s) {
  const sd = (s.collected_information && s.collected_information.shipping_details) || s.shipping_details || (s.shipping) || null;
  if (!sd) return null;
  return { name: sd.name || '', address: sd.address || {} };
}
function handleEvent(event) {
  const s = event.data && event.data.object;
  if (!s || s.object !== 'checkout.session') return;
  const id = (s.metadata && s.metadata.order_id) || s.client_reference_id;
  const order = db.orders.find(o => o.id === id || (s.id && o.sessionId === s.id));
  if (!order) { console.warn('[stripe] event for unknown order', id, event.type); return; }
  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
    if (s.payment_status !== 'paid' && s.payment_status !== 'no_payment_required') { order.status = 'awaiting_payment'; save(db); return; }
    if (order.status === 'paid' || order.status === 'sent') return; // idempotent: Stripe can redeliver
    if (order.stockReleased) { // paid after we had released the reservation; take stock again (may go negative -> flag)
      order.items.forEach(i => { const p = db.products.find(x => x.id === i.id); if (p) p.stock = Math.max(0, p.stock - i.qty); });
      order.stockReleased = false; order.note = 'Paid after reservation expired — check stock.';
    }
    order.status = 'paid'; order.paidAt = new Date().toISOString();
    order.email = (s.customer_details && s.customer_details.email) || s.customer_email || '';
    order.name = (s.customer_details && s.customer_details.name) || '';
    order.shipping = shippingOf(s);
    order.amountPaid = (s.amount_total || 0) / 100; order.currency = s.currency || 'gbp';
    order.paymentIntent = s.payment_intent || '';
    save(db);
    notify.orderPaid(order).catch(e => console.error('[notify] failed:', e.message));
  } else if (event.type === 'checkout.session.expired' || event.type === 'checkout.session.async_payment_failed') {
    if (order.status === 'pending' || order.status === 'awaiting_payment') { order.status = order.status === 'pending' ? 'pending' : order.status; releaseStock(order); order.status = 'expired'; save(db); }
  }
}

const page = (title, body) => `<!DOCTYPE html><html lang="en-GB"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} — Crafted.i.mentions</title>
<link href="https://fonts.googleapis.com/css2?family=EB+Garamond:ital,wght@0,400;0,500;0,600;0,700;1,400&family=Grenze+Gotisch:wght@500;600;700&display=swap" rel="stylesheet">
<link rel="icon" href="/favicon.v4.ico" sizes="any"><link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.v4.png"><link rel="apple-touch-icon" href="/apple-touch-icon.v4.png">
<meta property="og:title" content="${escH(title)} — Crafted.i.mentions"><meta property="og:description" content="Handcrafted 3D printed products from Crafted.i.mentions."><meta property="og:image" content="https://craftedimension-shop.onrender.com/img/og-image.v4.jpg"><meta name="twitter:card" content="summary_large_image">
<link rel="stylesheet" href="/styles.css"></head><body><header class="site-header"><a class="logo" href="/"><picture><source srcset="/img/logo-ram-header.v4.webp" type="image/webp"><img src="/img/logo-ram-header.v4.png" alt="Crafted.i.mentions" width="447" height="288"></picture></a><nav aria-label="Primary"><a href="/#products">Shop</a></nav></header>
<main class="checkout-result">${body}</main></body></html>`;
const escH = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => '&#' + c.charCodeAt(0) + ';');
const gbpFmt = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' });

app.get('/checkout/success', async (req, res) => {
  const sid = String(req.query.session_id || '');
  let order = db.orders.find(o => o.sessionId && o.sessionId === sid);
  if (order && order.status === 'pending' && PAYMENTS_ON) {
    // Webhook may not have arrived yet: confirm directly with Stripe (read-only) for the message.
    try { const s = await stripe.checkout.sessions.retrieve(sid); if (s.payment_status === 'paid') order = { ...order, status: 'paid', email: s.customer_details && s.customer_details.email }; } catch {}
  }
  if (!order) return res.status(404).send(page('Order not found', `<h1>We couldn't find that order</h1><p>If you've paid, you'll get an email receipt from Stripe. <a href="/#contact">Contact us</a> if you need help.</p><p><a class="btn" href="/">Back to the shop</a></p>`));
  const paid = order.status === 'paid' || order.status === 'sent';
  res.send(page(paid ? 'Thank you' : 'Payment processing', `<h1>${paid ? 'Thank you for your order!' : 'Your payment is being confirmed'}</h1>
<p>Order <strong>${escH(order.id)}</strong> · ${gbpFmt.format(order.total)}${order.postage != null ? ` <span class="muted">(includes ${order.postage ? gbpFmt.format(order.postage) + ' postage' : 'free postage'})</span>` : ''}</p>
<ul class="result-items">${order.items.map(i => `<li>${escH(i.qty)} × ${escH(i.name)}</li>`).join('')}</ul>
<p>${paid ? `We've received your payment${order.email ? ` and a receipt is on its way to <strong>${escH(order.email)}</strong>` : ''}. Your print will be made to order and we'll let you know when it's sent.` : "This usually takes a few seconds. You'll get an email receipt once it's confirmed."}</p>
<p><a class="btn" href="/">Back to the shop</a></p>`));
});

app.get('/checkout/cancel', async (req, res) => {
  const order = db.orders.find(o => o.id === String(req.query.order || '') && o.status === 'pending');
  if (order) {
    if (order.sessionId && PAYMENTS_ON) { try { await stripe.checkout.sessions.expire(order.sessionId); } catch {} }
    // Release only if the session really didn't complete in the meantime.
    if (order.status === 'pending') { releaseStock(order); order.status = 'cancelled'; save(db); }
  }
  res.send(page('Checkout cancelled', `<h1>Checkout cancelled</h1><p>No payment was taken. Your basket items are still available in the shop.</p><p><a class="btn" href="/#cart">Back to your basket</a></p>`));
});

// Admin (HTTP Basic auth, any username)
function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const pw = Buffer.from(h.split(' ')[1] || '', 'base64').toString().split(':').slice(1).join(':');
  if (h.startsWith('Basic ') && pw.length === ADMIN_PASSWORD.length && crypto.timingSafeEqual(Buffer.from(pw), Buffer.from(ADMIN_PASSWORD))) return next();
  res.set('WWW-Authenticate', 'Basic realm="Crafted.i.mentions admin"').status(401).send('Authentication required');
}
app.get('/admin', auth, (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/api/admin/data', auth, (req, res) => res.json(db));
app.post('/api/admin/orders/:id/sent', auth, (req, res) => {
  const o = db.orders.find(x => x.id === req.params.id);
  if (!o) return res.status(404).json({ error: 'Not found' });
  if (o.status !== 'paid' && o.status !== 'sent') return res.status(409).json({ error: 'Only paid orders can be marked as sent.' });
  const undo = req.body && req.body.sent === false;
  o.status = undo ? 'paid' : 'sent'; o.sentAt = undo ? undefined : new Date().toISOString(); save(db); res.json(o);
});
function truthy(v) { return v === true || v === 'true' || v === '1' || v === 'on'; }
function dim(v) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 10) / 10;
}
function clean(b, base = {}, full) {
  const p = { ...base };
  if (b.name !== undefined) p.name = String(b.name).trim().slice(0, 120);
  if (b.description !== undefined) p.description = String(b.description).slice(0, 500);
  if (b.price !== undefined) p.price = Math.max(0, +Number(b.price).toFixed(2) || 0);
  if (b.stock !== undefined) p.stock = Math.max(0, Math.floor(Number(b.stock)) || 0);
  if (b.gradient !== undefined) p.gradient = Number(b.gradient) % 3 || 0;
  if (b.printType !== undefined) p.printType = String(b.printType).toLowerCase() === 'resin' ? 'Resin' : 'FDM';
  if (full || b.sample !== undefined) p.sample = truthy(b.sample);
  if (b.hidden !== undefined) p.hidden = truthy(b.hidden);
  if (b.material !== undefined) p.material = String(b.material).trim().slice(0, 80);
  if (b.colour !== undefined) p.colour = String(b.colour).trim().slice(0, 80);
  if (b.detail !== undefined) p.detail = String(b.detail).trim().slice(0, 120);
  if (b.care_notes !== undefined) p.care_notes = String(b.care_notes).slice(0, 800);
  if (b.finish !== undefined) {
    const f = String(b.finish).toLowerCase();
    p.finish = ['raw', 'sanded', 'primed', 'painted'].includes(f) ? f : 'raw';
  }
  if (b.size_l !== undefined || b.size_w !== undefined || b.size_h !== undefined || (b.size_mm && typeof b.size_mm === 'object')) {
    const src = b.size_mm && typeof b.size_mm === 'object' ? b.size_mm : {};
    const prev = p.size_mm && typeof p.size_mm === 'object' ? p.size_mm : {};
    p.size_mm = {
      l: b.size_l !== undefined ? dim(b.size_l) : (src.l !== undefined ? dim(src.l) : (prev.l ?? null)),
      w: b.size_w !== undefined ? dim(b.size_w) : (src.w !== undefined ? dim(src.w) : (prev.w ?? null)),
      h: b.size_h !== undefined ? dim(b.size_h) : (src.h !== undefined ? dim(src.h) : (prev.h ?? null)),
    };
  }
  if (b.lead_min !== undefined || b.lead_max !== undefined || b.lead_time_days !== undefined) {
    const prev = Array.isArray(p.lead_time_days) ? p.lead_time_days : [3, 7];
    const fromBody = Array.isArray(b.lead_time_days) ? b.lead_time_days : null;
    let min = Math.floor(Number(b.lead_min !== undefined ? b.lead_min : (fromBody ? fromBody[0] : prev[0])));
    let max = Math.floor(Number(b.lead_max !== undefined ? b.lead_max : (fromBody ? fromBody[1] : prev[1])));
    if (!Number.isFinite(min) || min < 0) min = 3;
    if (!Number.isFinite(max) || max < 0) max = 7;
    p.lead_time_days = [Math.min(min, max), Math.max(min, max)];
  }
  delete p.photoFile;
  return p;
}
function newImageKey(used) {
  for (let i = 0; i < 8; i++) {
    const key = crypto.randomBytes(4).toString('hex');
    if (!used.has(key) && key !== '00000000') return key;
  }
  return null;
}
// imageOrder is the full new order. Existing ids are kept as-is; n:0 refers to the first uploaded photos file.
// Ids left out are removed. The first entry is the main photo. Omit imageOrder to keep the current order and append uploads.
async function applyGallery(p, files, body) {
  const incoming = files || [];
  const current = Array.isArray(p.images) ? p.images.slice() : [];
  const ordered = body && Object.prototype.hasOwnProperty.call(body, 'imageOrder');
  if (!incoming.length && !ordered) {
    p.images = current;
    p.photo = current.length > 0;
    return { error: null, added: [], removed: [] };
  }
  const plan = [];
  const usedOld = new Set();
  const usedNew = new Set();
  if (ordered) {
    const tokens = String(body.imageOrder || '').split(',').map(s => s.trim()).filter(Boolean);
    for (const token of tokens) {
      const added = /^n:(\d+)$/.exec(token);
      if (added) {
        const index = Number(added[1]);
        if (!incoming[index] || usedNew.has(index)) return { error: 'One of the new photos could not be placed.', status: 400 };
        usedNew.add(index);
        plan.push({ upload: index });
      } else {
        if (!current.includes(token) || usedOld.has(token)) return { error: 'The photo order includes a photo that is not on this product.', status: 400 };
        usedOld.add(token);
        plan.push({ key: token });
      }
    }
  } else {
    current.forEach(key => plan.push({ key }));
    incoming.forEach((_, index) => plan.push({ upload: index }));
  }
  if (plan.length > MAX_PHOTOS) return { error: 'You can add up to 8 photos.', status: 400 };
  const encoded = new Map();
  for (const index of new Set(plan.filter(item => item.upload != null).map(item => item.upload))) {
    try { encoded.set(index, await makeWebp(incoming[index].buffer)); }
    catch { return { error: photoError(), status: 400 }; }
  }
  const used = new Set(current);
  const images = [];
  const added = [];
  for (const item of plan) {
    if (item.key) { images.push(item.key); continue; }
    const key = newImageKey(used);
    if (!key) return { error: "Couldn't store that photo. Please try again.", status: 503 };
    used.add(key);
    try { await store.saveImage(p.id, encoded.get(item.upload).full, encoded.get(item.upload).thumb, key); }
    catch (e) { console.error('[img] save failed', e.message); return { error: "Couldn't store that photo. Please try again.", status: 503, added }; }
    added.push(key);
    images.push(key);
  }
  const removed = current.filter(key => !images.includes(key));
  p.images = images;
  p.photo = images.length > 0;
  if (added.length || removed.length || images.join() !== current.join()) p.photoRev = Date.now();
  return { error: null, added, removed };
}
async function discardImages(productId, keys) {
  for (const key of keys) await store.deleteImage(productId, key).catch(() => {});
}
app.post('/api/admin/products', auth, withPhoto, async (req, res) => {
  const body = req.body || {};
  if (!String(body.name || '').trim()) return res.status(400).json({ error: 'Please enter a name.' });
  const p = clean(body, {
    id: db.nextId++, price: 0, stock: 0, gradient: 0, description: '', sample: false, printType: 'FDM', hidden: false,
    material: 'PLA', colour: '', size_mm: { l: null, w: null, h: null }, detail: '0.2 mm layers', finish: 'raw', care_notes: '', lead_time_days: [3, 7],
    images: [], photo: false,
  }, true);
  const gallery = await applyGallery(p, photoFiles(req), body);
  if (gallery.error) {
    db.nextId--;
    await discardImages(p.id, gallery.added || []);
    return res.status(gallery.status || 400).json({ error: gallery.error });
  }
  db.products.push(p);
  try { await save(db); }
  catch {
    db.products.pop();
    await store.deleteImage(p.id).catch(() => {});
    return res.status(503).json({ error: "Couldn't save that product. Please try again." });
  }
  await discardImages(p.id, gallery.removed);
  res.json(p);
});
app.put('/api/admin/products/:id', auth, withPhoto, async (req, res) => {
  const i = db.products.findIndex(p => p.id === Number(req.params.id));
  if (i < 0) return res.status(404).json({ error: 'Not found' });
  const multipart = (req.headers['content-type'] || '').includes('multipart/form-data');
  const body = req.body || {};
  // A photo-only update (imageOrder, no name) must not clear the sample flag.
  const next = clean(body, db.products[i], multipart && body.name !== undefined);
  if (!String(next.name || '').trim()) return res.status(400).json({ error: 'Please enter a name.' });
  const gallery = await applyGallery(next, photoFiles(req), multipart ? body : {});
  if (gallery.error) {
    await discardImages(next.id, gallery.added || []);
    return res.status(gallery.status || 400).json({ error: gallery.error });
  }
  const previous = db.products[i];
  db.products[i] = next;
  try { await save(db); }
  catch {
    db.products[i] = previous;
    await discardImages(next.id, gallery.added || []);
    return res.status(503).json({ error: "Couldn't save those changes. Please try again." });
  }
  await discardImages(next.id, gallery.removed);
  res.json(next);
});
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
app.post('/api/custom', withCustomFile, customLimit, async (req, res) => {
  const b = req.body || {};
  // Honeypot: pretend it worked, and do not count it toward the rate limit.
  if (String(b.company || '').trim()) return res.json({ ok: true });
  const name = String(b.name || '').trim();
  const email = String(b.email || '').trim();
  const description = String(b.description || '').trim();
  const material = String(b.material || '').trim();
  const colour = String(b.colour || '').trim();
  const size = String(b.size || '').trim();
  const deadline = String(b.deadline || '').trim();
  const qty = Math.floor(Number(b.quantity));
  if (name.length < 1 || name.length > 120) return res.status(400).json({ error: 'Please enter your name (120 characters or fewer).' });
  if (email.length > 200 || !EMAIL_RE.test(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });
  if (description.length < 1 || description.length > 4000) return res.status(400).json({ error: 'Please describe what you would like printed (up to 4000 characters).' });
  if (!(qty >= 1 && qty <= 100)) return res.status(400).json({ error: 'Quantity must be between 1 and 100.' });
  if (deadline.length > 40) return res.status(400).json({ error: 'Please keep the deadline to 40 characters.' });
  if (material.length > 80 || colour.length > 80 || size.length > 80) return res.status(400).json({ error: 'Please shorten the material, colour or size.' });
  const id = crypto.randomBytes(8).toString('hex');
  const rec = {
    id, createdAt: new Date().toISOString(), name, email, description, material, colour, size, quantity: qty, deadline,
    file: null,
  };
  if (req.file && req.file.size > 0) {
    const filename = path.basename(String(req.file.originalname || 'upload')).replace(/[\r\n"]/g, '').slice(0, 180) || 'upload';
    const mime = String(req.file.mimetype || 'application/octet-stream').slice(0, 120);
    try { await store.saveCustomFile(id, filename, mime, req.file.buffer); }
    catch (e) { console.error('[custom] file save', e.message); return res.status(503).json({ error: "Couldn't store that file. Please try again." }); }
    rec.file = { filename, mime, size: req.file.size };
  }
  if (!Array.isArray(db.customRequests)) db.customRequests = [];
  db.customRequests.push(rec);
  try { await save(db); }
  catch { db.customRequests.pop(); return res.status(503).json({ error: "Couldn't save your request. Please try again." }); }
  notify.customRequest(rec).catch(e => console.error('[notify] custom failed:', e.message));
  res.json({ ok: true, id });
});
app.get('/api/admin/custom/:id/file', auth, async (req, res) => {
  let file;
  try { file = await store.readCustomFile(req.params.id); }
  catch (e) { console.error('[custom] read', e.message); return res.status(500).type('text').send('Not found'); }
  if (!file) return res.status(404).type('text').send('Not found');
  const name = String(file.filename || 'upload').replace(/[\r\n"]/g, '') || 'upload';
  res.set('Content-Type', file.mime || 'application/octet-stream');
  res.set('Content-Disposition', `attachment; filename="${name}"`);
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Cache-Control', 'private, no-store');
  if (!Buffer.isBuffer(file.buf)) file.buf = Buffer.from(file.buf);
  res.send(file.buf);
});

app.delete('/api/admin/products/:id', auth, async (req, res) => {
  const id = Number(req.params.id);
  if (!db.products.some(p => p.id === id)) return res.status(404).json({ error: 'Not found' });
  const kept = db.products;
  db.products = db.products.filter(p => p.id !== id);
  try { await store.deleteImage(id); await save(db); }
  catch { db.products = kept; return res.status(503).json({ error: "Couldn't delete that product. Please try again." }); }
  res.json({ ok: true });
});

app.get(['/', '/index.html'], (req, res) => sendShopHtml(req, res, 'index.html'));
app.get(['/privacy', '/privacy.html'], (req, res) => sendShopHtml(req, res, 'privacy.html'));
app.get(['/materials', '/materials.html'], (req, res) => sendShopHtml(req, res, 'materials.html'));
app.get(['/custom', '/custom.html'], (req, res) => sendShopHtml(req, res, 'custom.html'));
app.get(['/delivery', '/delivery.html'], (req, res) => sendShopHtml(req, res, 'delivery.html'));
app.get(['/returns', '/returns.html'], (req, res) => sendShopHtml(req, res, 'returns.html'));
app.get(['/terms', '/terms.html'], (req, res) => sendShopHtml(req, res, 'terms.html'));
app.post('/api/contact', contactLimit, async (req, res) => {
  const b = req.body || {};
  if (String(b.company || '').trim()) return res.json({ ok: true });
  const name = String(b.name || '').trim();
  const email = String(b.email || '').trim();
  const message = String(b.message || '').trim();
  if (name.length < 1 || name.length > 120) return res.status(400).json({ error: 'Please enter your name (120 characters or fewer).' });
  if (email.length > 200 || !EMAIL_RE.test(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });
  if (message.length < 1 || message.length > 4000) return res.status(400).json({ error: 'Please enter a message (up to 4000 characters).' });
  const rec = { id: crypto.randomBytes(8).toString('hex'), createdAt: new Date().toISOString(), name, email, message };
  if (!Array.isArray(db.contactMessages)) db.contactMessages = [];
  db.contactMessages.push(rec);
  try { await save(db); }
  catch { db.contactMessages.pop(); return res.status(503).json({ error: "Couldn't send your message. Please try again." }); }
  notify.contactMessage(rec).catch(e => console.error('[notify] contact failed:', e.message));
  res.json({ ok: true });
});
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    if (/\.v\d+\.[a-z0-9]+$/i.test(filePath)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  },
}));
async function start() {
  db = await store.init();
  app.listen(PORT, () => {
  console.log(`Storage: ${store.kind}`);
  console.log(PAYMENTS_ON ? `Stripe payments ON (${STRIPE_KEY.startsWith('sk_live_') ? 'LIVE' : 'test'} mode)` : (LIVE_BLOCKED ? 'Stripe live key refused: set STRIPE_ALLOW_LIVE=1 to go live' : 'Stripe not configured: checkout shows "payments not set up"'));
  if (PAYMENTS_ON && !WEBHOOK_SECRET) console.warn('STRIPE_WEBHOOK_SECRET is not set: paid orders will not be recorded!');
  console.log(`Crafted.i.mentions demo shop on http://localhost:${PORT}`);
  console.log(`Admin: http://localhost:${PORT}/admin  password: ${ADMIN_PASSWORD}${process.env.ADMIN_PASSWORD ? ' (from env)' : ' (random, generated at startup — set ADMIN_PASSWORD to fix it)'}`);
});
}
start().catch(e => { console.error('Startup failed:', e.message); process.exit(1); });
