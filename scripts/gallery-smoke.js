// Smoke check: create a product with 4 photos, reorder, remove, set the main photo, and read /api/products.
// Usage: ADMIN_PASSWORD=testpass node scripts/gallery-smoke.js
const sharp = require('sharp');

const base = process.env.SHOP_URL || 'http://127.0.0.1:3000';
const password = process.env.ADMIN_PASSWORD || 'testpass';
const auth = 'Basic ' + Buffer.from('owner:' + password).toString('base64');

function fail(message) { console.error(message); process.exit(1); }
async function png(colour) {
  return sharp({ create: { width: 24, height: 16, channels: 3, background: colour } }).png().toBuffer();
}
async function api(path, options) {
  const res = await fetch(base + path, options);
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body, headers: res.headers };
}

(async () => {
  const colours = ['#cc3333', '#2266cc', '#228844', '#e6b422'];
  const files = await Promise.all(colours.map(png));
  const fd = new FormData();
  fd.set('name', 'Gallery smoke');
  fd.set('price', '12.5');
  fd.set('stock', '4');
  fd.set('description', 'Four photos');
  files.forEach((buf, i) => fd.append('photos', new Blob([buf], { type: 'image/png' }), 'photo-' + (i + 1) + '.png'));
  const created = await api('/api/admin/products', { method: 'POST', headers: { Authorization: auth }, body: fd });
  if (created.status !== 200) fail('create ' + created.status + ' ' + JSON.stringify(created.body));
  const product = created.body;
  if (!Array.isArray(product.images) || product.images.length !== 4) fail('expected 4 image ids, got ' + JSON.stringify(product.images));
  const [a, b, c, d] = product.images;

  const list = await api('/api/products');
  const pub = (list.body || []).find(p => p.id === product.id);
  if (!pub) fail('missing from /api/products');
  if (!pub.image || !pub.thumb) fail('missing image/thumb');
  if (!Array.isArray(pub.images) || pub.images.length !== 4) fail('public images length');
  if (pub.images[0].url !== pub.image || pub.images[0].thumb !== pub.thumb) fail('main fields do not match images[0]');
  if (!pub.images.every(shot => shot.url && shot.thumb)) fail('image entries need url and thumb');
  const mainBefore = Buffer.from(await (await fetch(base + pub.image)).arrayBuffer());

  const reordered = await api('/api/admin/products/' + product.id, {
    method: 'PUT',
    headers: { Authorization: auth },
    body: (() => { const form = new FormData(); form.set('imageOrder', [d, b, a].join(',')); return form; })(),
  });
  if (reordered.status !== 200) fail('reorder ' + reordered.status + ' ' + JSON.stringify(reordered.body));
  if (reordered.body.images.join(',') !== [d, b, a].join(',')) fail('order ' + reordered.body.images.join(','));

  const after = await api('/api/products');
  const pub2 = after.body.find(p => p.id === product.id);
  if (pub2.images.length !== 3) fail('expected 3 after remove');
  if (pub2.image !== pub2.images[0].url) fail('main not images[0] after reorder');
  const mainAfter = Buffer.from(await (await fetch(base + pub2.image)).arrayBuffer());
  if (mainBefore.equals(mainAfter)) fail('main photo bytes did not change');
  const extra = await fetch(base + pub2.images[1].url);
  if (extra.status !== 200) fail('second photo ' + extra.status);
  const removedUrl = '/img/p/' + product.id + '-' + c + '.webp';
  const gone = await fetch(base + removedUrl);
  if (gone.status !== 404) fail('removed photo still served ' + gone.status);

  const mainSet = await api('/api/admin/products/' + product.id, {
    method: 'PUT',
    headers: { Authorization: auth },
    body: (() => { const form = new FormData(); form.set('imageOrder', [a, d, b].join(',')); return form; })(),
  });
  if (mainSet.status !== 200 || mainSet.body.images[0] !== a) fail('set main failed ' + JSON.stringify(mainSet.body && mainSet.body.images));

  const tooMany = new FormData();
  tooMany.set('name', 'Too many');
  tooMany.set('price', '1');
  for (let i = 0; i < 9; i++) tooMany.append('photos', new Blob([files[0]], { type: 'image/png' }), 'x.png');
  const rejected = await api('/api/admin/products', { method: 'POST', headers: { Authorization: auth }, body: tooMany });
  if (rejected.status !== 400) fail('9 photos should be rejected, got ' + rejected.status);

  const del = await api('/api/admin/products/' + product.id, { method: 'DELETE', headers: { Authorization: auth } });
  if (del.status !== 200) fail('delete ' + del.status);
  const still = await fetch(base + pub.image);
  if (still.status !== 404) fail('deleted photo still served');
  console.log('gallery smoke ok');
})().catch(err => fail(err.stack || err.message));
