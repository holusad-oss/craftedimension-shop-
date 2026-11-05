document.getElementById('year').textContent = new Date().getFullYear();
const gbp = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' });
const CUBE = '<svg class="cube-icon" viewBox="0 0 64 64" aria-hidden="true" focusable="false"><path fill="#a94f20" d="M10 18 32 30 32 54 10 42Z"/><path fill="#c4622d" d="M54 18 32 30 32 54 54 42Z"/><path fill="#c4622d" d="M32 6 46.7 14 17.3 14Z"/><path fill="#e6a94a" d="M17.3 14 46.7 14 54 18 46.7 22 17.3 22 10 18Z"/><path fill="#c4622d" d="M17.3 22 46.7 22 32 30Z"/></svg>';
let products = [], cart = {}, filter = 'All', shownSlide = {}, chosenColour = {}, colourMissing = {};
const FALLBACK_COLOURS = [
  { id: 'black', label: 'Black' },
  { id: 'white', label: 'White' },
  { id: 'grey', label: 'Grey' },
];
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

function leadText(p) {
  const lead = Array.isArray(p.lead_time_days) && p.lead_time_days.length >= 2 ? p.lead_time_days : [3, 7];
  const a = Number(lead[0]), b = Number(lead[1]);
  const days = a === b ? a + ' days' : a + '\u2013' + b + ' days';
  return 'Made to order \u00b7 ships in ' + days;
}
function cmNumber(mm) {
  const n = Number(mm);
  if (!Number.isFinite(n)) return '';
  return String(Math.round(n * 10) / 100);
}
function sizeText(p) {
  if (typeof p.sizeText === 'string') return p.sizeText;
  const s = p.size_mm || {};
  const parts = [];
  if (s.h != null && s.h !== '') parts.push('H ' + cmNumber(s.h));
  if (s.w != null && s.w !== '') parts.push('W ' + cmNumber(s.w));
  if (s.l != null && s.l !== '') parts.push('D ' + cmNumber(s.l));
  return parts.length ? parts.join(' \u00d7 ') + ' cm' : '';
}
function finishLabel(f) {
  return { raw: 'Raw', sanded: 'Sanded', primed: 'Primed', painted: 'Painted' }[f] || f || '';
}
function stockText(p) {
  if (p.stock === 0) return '<span class="stock out">Sold out</span>';
  if (p.stock <= 3) return '<span class="stock low">Only ' + p.stock + ' left</span>';
  return '';
}
function colourChoices(p) {
  if (!p || !p.colourOptions) return [];
  if (Array.isArray(p.colours) && p.colours.length) {
    return p.colours.map(c => ({ id: String(c.id || ''), label: String(c.label || c.id || '') })).filter(c => c.id && c.label);
  }
  return FALLBACK_COLOURS;
}
// Prefix the id so a plain line ("p6") is not an integer key. Integer keys are
// listed first, which would float an FDM line above resin colours added earlier.
function lineBody(key) {
  const s = String(key);
  return s.charAt(0) === 'p' ? s.slice(1) : s;
}
function lineProductId(key) { return lineBody(key).split(':')[0]; }
function lineColour(key) {
  const s = lineBody(key);
  const i = s.indexOf(':');
  return i === -1 ? '' : s.slice(i + 1);
}
function lineKey(id, colour) { return colour ? 'p' + id + ':' + colour : 'p' + id; }
function productQty(id) {
  const want = String(id);
  return Object.keys(cart).reduce((sum, key) => lineProductId(key) === want ? sum + (cart[key] || 0) : sum, 0);
}
function colourLabelOf(p, id) {
  const choice = colourChoices(p).find(c => c.id === id);
  return choice ? choice.label : id;
}
function lineTitle(p, key) {
  const colour = lineColour(key);
  return colour ? p.name + ' \u2014 ' + colourLabelOf(p, colour) : p.name;
}
function colourPicker(p) {
  const choices = colourChoices(p);
  if (!choices.length) return '';
  const selected = chosenColour[String(p.id)] || '';
  const missing = !!colourMissing[String(p.id)] && !choices.some(c => c.id === selected);
  const buttons = choices.map(c => {
    const on = c.id === selected;
    return `<button type="button" class="colour-btn" data-colour="${esc(c.id)}" data-id="${p.id}" aria-pressed="${on ? 'true' : 'false'}">${esc(c.label)}</button>`;
  }).join('');
  return `<div class="colour-pick">
    <p class="colour-label" id="colour-label-${p.id}">Colour</p>
    <div class="colour-options" role="radiogroup" aria-labelledby="colour-label-${p.id}"${missing ? ' aria-invalid="true"' : ''}>${buttons}</div>
    <p class="colour-need"${missing ? '' : ' hidden'}>Choose Black, White, or Grey.</p>
  </div>`;
}
function render() {
  document.getElementById('grid').innerHTML = products.filter(p => filter === 'All' || p.printType === filter).map(p => {
    const inCart = productQty(p.id), avail = p.stock - inCart;
    const st = stockText(p);
    const shots = Array.isArray(p.images) && p.images.length ? p.images : (p.image ? [{ url: p.image, thumb: p.thumb || p.image }] : []);
    const slide = shots.length ? Math.min(shownSlide[p.id] || 0, shots.length - 1) : 0;
    shownSlide[p.id] = slide;
    const media = shots.length
      ? `<img src="${esc(shots[slide].thumb || shots[slide].url)}" alt="${esc(p.name)} photo ${slide + 1}" data-slide="${slide}">`
        + (shots.length > 1
          ? `<button type="button" class="photo-arrow photo-prev" data-photo="prev" data-id="${p.id}" aria-label="Previous photo">‹</button><button type="button" class="photo-arrow photo-next" data-photo="next" data-id="${p.id}" aria-label="Next photo">›</button><span class="photo-count">${slide + 1} / ${shots.length}</span>`
          : '')
      : CUBE;
    const meta = [p.material, p.colourOptions ? '' : p.colour, sizeText(p)].filter(Boolean).map(esc).join(' \u00b7 ');
    const colourDetail = p.colourOptions ? colourChoices(p).map(c => c.label).join(', ') : (p.colour || '\u2014');
    const specs = `<details class="specs"><summary>Print details</summary>
      <dl class="spec">
        <dt>Material</dt><dd>${esc(p.material || '\u2014')}</dd>
        <dt>Colour</dt><dd>${esc(colourDetail)}</dd>
        <dt>Size</dt><dd>${esc(sizeText(p) || '\u2014')}</dd>
        <dt>Detail</dt><dd>${esc(p.detail || '\u2014')}</dd>
        <dt>Finish</dt><dd>${esc(finishLabel(p.finish) || '\u2014')}</dd>
      </dl>
      ${p.care_notes ? `<p class="care">${esc(p.care_notes)}</p>` : ''}
      <p class="spec-links"><a href="/materials">Materials guide</a></p>
      <div class="policy-draft"><strong>Draft for the owner to confirm.</strong> Custom and made-to-order items are exempt from the 14-day cancellation right unless faulty; standard items can be returned within 14 days.</div>
    </details>`;
    return `<article class="card">
      <div class="card-media" data-id="${p.id}">${media}<span class="type type-${p.printType.toLowerCase()}">${esc(p.printType)}</span>${p.sample ? '<span class="badge">Sample</span>' : ''}</div>
      <h3>${esc(p.name)}</h3><p>${esc(p.description)}</p>
      ${meta ? `<p class="meta-line">${meta}</p>` : ''}
      <p class="lead-line">${esc(leadText(p))}</p>
      ${specs}
      ${colourPicker(p)}
      <div class="card-foot"><div><span class="price">${gbp.format(p.price)}</span>${st ? '<br>' + st : ''}</div>
      <button class="btn small" data-add="${p.id}" ${avail <= 0 ? 'disabled' : ''}>${p.stock === 0 ? 'Sold out' : avail <= 0 ? 'All in basket' : 'Add to basket'}</button></div>
    </article>`;
  }).join('') || '<p class="muted">' + (products.length ? 'No products in this category yet.' : 'No products yet.') + '</p>';
  const keys = Object.keys(cart).filter(key => cart[key] > 0);
  let total = 0;
  document.getElementById('cart-lines').innerHTML = keys.length ? keys.map(key => {
    const p = products.find(x => String(x.id) === lineProductId(key)); if (!p) return '';
    const title = lineTitle(p, key);
    total += p.price * cart[key];
    return `<div class="cart-line"><span>${esc(title)}</span><span><button data-dec="${esc(key)}" aria-label="Remove one ${esc(title)}">−</button> ${cart[key]} <button data-inc="${esc(key)}" aria-label="Add one ${esc(title)}" ${productQty(p.id) >= p.stock ? 'disabled' : ''}>+</button></span><span class="price">${gbp.format(p.price * cart[key])}</span></div>`;
  }).join('') + basketTotals(total) : '<p class="muted">Your basket is empty.</p>';
  document.getElementById('cart-count').textContent = keys.reduce((s, key) => s + cart[key], 0);
  syncEnquiry();
}
// Display only — the server recalculates postage from its own prices at checkout.
const FREE_FROM = 35, POSTAGE = 3.5;
function basketTotals(sub) {
  const subP = Math.round(sub * 100), post = subP >= FREE_FROM * 100 ? 0 : POSTAGE;
  const hint = post ? `<p class="postage-hint">Add ${gbp.format(FREE_FROM - subP / 100)} more for <strong>free UK postage</strong> on orders of ${gbp.format(FREE_FROM)} or more.</p>` : '<p class="postage-hint ok">You\u2019ve got <strong>free UK postage</strong>.</p>';
  return `<div class="cart-sum"><span>Subtotal</span><span class="price">${gbp.format(sub)}</span></div>
    <div class="cart-sum"><span>UK postage</span><span class="price">${post ? gbp.format(post) : 'FREE'}</span></div>
    <div class="cart-total">Total <span class="price">${gbp.format(subP / 100 + post)}</span></div>${hint}`;
}
function setProducts(list) {
  products = list;
  const next = {};
  const used = {};
  Object.keys(cart).forEach(key => {
    const id = lineProductId(key);
    const p = products.find(x => String(x.id) === id);
    if (!p) return;
    let colour = lineColour(key);
    const choices = colourChoices(p);
    if (choices.length) {
      if (!choices.some(c => c.id === colour)) return;
    } else colour = '';
    let q = Math.floor(Number(cart[key]));
    if (!(q > 0)) return;
    const room = p.stock - (used[id] || 0);
    if (room <= 0) return;
    q = Math.min(q, room);
    const storeKey = lineKey(id, colour);
    next[storeKey] = (next[storeKey] || 0) + q;
    used[id] = (used[id] || 0) + q;
  });
  cart = next;
  render();
  if (viewerId != null && viewer && !viewer.hidden) openViewer(viewerId);
}
async function refresh() { try { setProducts(await (await fetch('/api/products')).json()); } catch {} }

function shotsOf(p) {
  if (!p) return [];
  if (Array.isArray(p.images) && p.images.length) return p.images;
  if (p.image) return [{ url: p.image, thumb: p.thumb || p.image }];
  return [];
}
function stepPhoto(id, dir) {
  const p = products.find(x => String(x.id) === String(id));
  const shots = shotsOf(p);
  if (shots.length < 2) return;
  shownSlide[p.id] = ((shownSlide[p.id] || 0) + dir + shots.length) % shots.length;
  render();
}
const viewer = document.getElementById('viewer');
const viewerImg = document.getElementById('viewer-img');
let viewerId = null;
let viewerPushed = false;
function openViewer(id, slide) {
  const p = products.find(x => String(x.id) === String(id));
  const shots = shotsOf(p);
  if (!p || !shots.length || !viewer) return;
  const wanted = Number.isInteger(slide) ? slide : (shownSlide[p.id] || 0);
  const index = Math.min(Math.max(wanted, 0), shots.length - 1);
  shownSlide[p.id] = index;
  viewerImg.src = shots[index].url;
  viewerImg.alt = p.name + ' photo ' + (index + 1);
  const count = document.getElementById('viewer-count');
  if (count) count.textContent = (index + 1) + ' / ' + shots.length;
  const single = shots.length < 2;
  document.getElementById('viewer-prev').hidden = single;
  document.getElementById('viewer-next').hidden = single;
  viewer.hidden = false;
  viewerId = p.id;
  document.getElementById('viewer-close').focus();
  if (!viewerPushed) { history.pushState({ gallery: true }, ''); viewerPushed = true; }
}
function closeViewer(fromPop) {
  if (viewer) viewer.hidden = true;
  if (viewerImg) { viewerImg.removeAttribute('src'); viewerImg.alt = ''; }
  viewerId = null;
  if (viewerPushed && !fromPop) { viewerPushed = false; history.back(); return; }
  viewerPushed = false;
}
let ignorePhotoClick = false;
document.addEventListener('click', e => {
  if (ignorePhotoClick) { ignorePhotoClick = false; return; }
  const photoBtn = e.target.closest('[data-photo]');
  if (photoBtn) { stepPhoto(photoBtn.dataset.id, photoBtn.dataset.photo === 'next' ? 1 : -1); return; }
  const shot = e.target.closest('.card-media img');
  if (shot) {
    const card = shot.closest('.card-media');
    if (card && card.dataset.id) openViewer(card.dataset.id, Number(shot.dataset.slide));
    return;
  }
  const c = e.target.closest('[data-filter]');
  if (c) { filter = c.dataset.filter; document.querySelectorAll('.chip').forEach(x => x.classList.toggle('active', x === c)); render(); return; }
  const colourBtn = e.target.closest('[data-colour]');
  if (colourBtn) {
    const id = String(colourBtn.dataset.id);
    const colour = colourBtn.dataset.colour;
    chosenColour[id] = colour;
    colourMissing[id] = false;
    render();
    const again = document.querySelector('[data-colour="' + colour + '"][data-id="' + id + '"]');
    if (again) again.focus();
    return;
  }
  const a = e.target.closest('[data-add]');
  const inc = e.target.closest('[data-inc]');
  const d = e.target.closest('[data-dec]');
  if (a && !a.disabled) addProduct(a.dataset.add);
  if (inc && !inc.disabled) addLine(inc.dataset.inc);
  if (d) {
    const key = d.dataset.dec;
    cart[key] = (cart[key] || 0) - 1;
    if (cart[key] <= 0) delete cart[key];
    render();
  }
});
function addProduct(id) {
  const p = products.find(x => String(x.id) === String(id));
  if (!p || productQty(p.id) >= p.stock) return;
  const choices = colourChoices(p);
  let colour = '';
  if (choices.length) {
    colour = chosenColour[String(p.id)] || '';
    if (!choices.some(c => c.id === colour)) {
      colourMissing[String(p.id)] = true;
      render();
      const first = document.querySelector('[data-colour][data-id="' + p.id + '"]');
      if (first) first.focus();
      return;
    }
  }
  colourMissing[String(p.id)] = false;
  const key = lineKey(p.id, colour);
  cart[key] = (cart[key] || 0) + 1;
  render();
}
function addLine(key) {
  const id = lineProductId(key);
  const p = products.find(x => String(x.id) === id);
  if (!p || productQty(p.id) >= p.stock || !cart[key]) return;
  cart[key] += 1;
  render();
}
if (viewer) {
  document.getElementById('viewer-close').addEventListener('click', () => closeViewer(false));
  document.getElementById('viewer-prev').addEventListener('click', () => { if (viewerId != null) { stepPhoto(viewerId, -1); openViewer(viewerId); } });
  document.getElementById('viewer-next').addEventListener('click', () => { if (viewerId != null) { stepPhoto(viewerId, 1); openViewer(viewerId); } });
  document.addEventListener('keydown', e => {
    if (viewer.hidden) return;
    if (e.key === 'Escape') closeViewer(false);
    else if (e.key === 'ArrowLeft' && viewerId != null) { stepPhoto(viewerId, -1); openViewer(viewerId); }
    else if (e.key === 'ArrowRight' && viewerId != null) { stepPhoto(viewerId, 1); openViewer(viewerId); }
  });
  window.addEventListener('popstate', () => { if (!viewer.hidden) closeViewer(true); });
}
let touchStart = null;
document.addEventListener('touchstart', e => {
  const media = e.target.closest('.card-media');
  if (!media || e.target.closest('button') || !e.changedTouches[0]) return;
  const t = e.changedTouches[0];
  touchStart = { x: t.clientX, y: t.clientY, id: media.dataset.id };
}, { passive: true });
document.addEventListener('touchend', e => {
  if (!touchStart || !e.changedTouches[0]) { touchStart = null; return; }
  const t = e.changedTouches[0];
  const dx = t.clientX - touchStart.x;
  const dy = t.clientY - touchStart.y;
  const id = touchStart.id;
  touchStart = null;
  if (id && Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) { ignorePhotoClick = true; stepPhoto(id, dx < 0 ? 1 : -1); }
}, { passive: true });
function enquiryLines() {
  return Object.keys(cart).filter(key => cart[key] > 0).map(key => {
    const p = products.find(x => String(x.id) === lineProductId(key));
    if (!p) return null;
    return { title: lineTitle(p, key), qty: cart[key], price: p.price };
  }).filter(Boolean);
}
function syncEnquiry() {
  const link = document.getElementById('order-link');
  const msg = document.getElementById('checkout-msg');
  if (!link || typeof orderEnquiry === 'undefined') return;
  const href = orderEnquiry.mailto(enquiryLines());
  if (!href) {
    link.href = '#products';
    link.textContent = 'Add a piece, then email us';
    if (msg) { msg.className = ''; msg.textContent = 'Your basket is empty. Add a piece before you email a bank transfer enquiry.'; }
    return;
  }
  link.href = href;
  link.textContent = 'Email us for bank transfer instructions';
  if (msg) { msg.className = ''; msg.textContent = 'This opens your email app. Nothing is sent until you send it, and it does not place an order.'; }
}
document.getElementById('contact-form').addEventListener('submit', async e => {
  e.preventDefault();
  const form = e.target, msg = document.getElementById('contact-msg'), btn = document.getElementById('contact-btn');
  const body = { name: form.name.value, email: form.email.value, message: form.message.value, company: form.company.value };
  btn.disabled = true; msg.className = ''; msg.textContent = 'Sending…';
  try {
    const r = await fetch('/api/contact', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { msg.className = 'err'; msg.textContent = j.error || 'Something went wrong. Please try again.'; btn.disabled = false; return; }
    msg.className = 'ok'; msg.textContent = 'Thanks. Your message is with us and we will reply by email.';
    form.reset();
  } catch { msg.className = 'err'; msg.textContent = "Couldn't reach the shop. Check your connection and try again."; btn.disabled = false; }
});
refresh(); setInterval(refresh, 10000);
