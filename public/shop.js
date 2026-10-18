document.getElementById('year').textContent = new Date().getFullYear();
const gbp = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' });
const CUBE = '<svg class="cube-icon" viewBox="0 0 64 64" aria-hidden="true" focusable="false"><path fill="#a94f20" d="M10 18 32 30 32 54 10 42Z"/><path fill="#c4622d" d="M54 18 32 30 32 54 54 42Z"/><path fill="#c4622d" d="M32 6 46.7 14 17.3 14Z"/><path fill="#e6a94a" d="M17.3 14 46.7 14 54 18 46.7 22 17.3 22 10 18Z"/><path fill="#c4622d" d="M17.3 22 46.7 22 32 30Z"/></svg>';
let products = [], cart = {}, filter = 'All', shownSlide = {};
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
function render() {
  document.getElementById('grid').innerHTML = products.filter(p => filter === 'All' || p.printType === filter).map(p => {
    const inCart = cart[p.id] || 0, avail = p.stock - inCart;
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
    const meta = [p.material, p.colour, sizeText(p)].filter(Boolean).map(esc).join(' \u00b7 ');
    const specs = `<details class="specs"><summary>Print details</summary>
      <dl class="spec">
        <dt>Material</dt><dd>${esc(p.material || '\u2014')}</dd>
        <dt>Colour</dt><dd>${esc(p.colour || '\u2014')}</dd>
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
      <div class="card-foot"><div><span class="price">${gbp.format(p.price)}</span>${st ? '<br>' + st : ''}</div>
      <button class="btn small" data-add="${p.id}" ${avail <= 0 ? 'disabled' : ''}>${p.stock === 0 ? 'Sold out' : avail <= 0 ? 'All in basket' : 'Add to basket'}</button></div>
    </article>`;
  }).join('') || '<p class="muted">No products in this category yet.</p>';
  const ids = Object.keys(cart).filter(id => cart[id] > 0);
  let total = 0;
  document.getElementById('cart-lines').innerHTML = ids.length ? ids.map(id => {
    const p = products.find(x => x.id == id); if (!p) return '';
    total += p.price * cart[id];
    return `<div class="cart-line"><span>${esc(p.name)}</span><span><button data-dec="${id}" aria-label="Remove one">−</button> ${cart[id]} <button data-add="${id}" aria-label="Add one" ${cart[id] >= p.stock ? 'disabled' : ''}>+</button></span><span class="price">${gbp.format(p.price * cart[id])}</span></div>`;
  }).join('') + basketTotals(total) : '<p class="muted">Your basket is empty.</p>';
  document.getElementById('cart-count').textContent = ids.reduce((s, id) => s + cart[id], 0);
}
// Display only — the server recalculates postage from its own prices at checkout.
const FREE_FROM = 30, POSTAGE = 3.5;
function basketTotals(sub) {
  const subP = Math.round(sub * 100), post = subP >= FREE_FROM * 100 ? 0 : POSTAGE;
  const hint = post ? `<p class="postage-hint">Add ${gbp.format(FREE_FROM - subP / 100)} more for <strong>free UK postage</strong> on orders of ${gbp.format(FREE_FROM)} or more.</p>` : '<p class="postage-hint ok">You\u2019ve got <strong>free UK postage</strong>.</p>';
  return `<div class="cart-sum"><span>Subtotal</span><span class="price">${gbp.format(sub)}</span></div>
    <div class="cart-sum"><span>UK postage</span><span class="price">${post ? gbp.format(post) : 'FREE'}</span></div>
    <div class="cart-total">Total <span class="price">${gbp.format(subP / 100 + post)}</span></div>${hint}`;
}
function setProducts(list) {
  products = list;
  for (const id in cart) { const p = products.find(x => x.id == id); cart[id] = p ? Math.min(cart[id], p.stock) : 0; }
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
  const a = e.target.closest('[data-add]'), d = e.target.closest('[data-dec]');
  if (a && !a.disabled) { const id = a.dataset.add, p = products.find(x => x.id == id); if ((cart[id] || 0) < p.stock) cart[id] = (cart[id] || 0) + 1; render(); }
  if (d) { cart[d.dataset.dec]--; render(); }
});
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
let payments = null;
let paymentsOn = false;
function setCheckoutMode(on) {
  paymentsOn = !!on;
  const btn = document.getElementById('checkout-btn');
  const alt = document.getElementById('order-by-message');
  if (!paymentsOn) {
    btn.disabled = true;
    btn.setAttribute('aria-disabled', 'true');
    btn.textContent = 'Card payments coming soon';
    if (alt) alt.hidden = false;
  } else {
    btn.disabled = false;
    btn.removeAttribute('aria-disabled');
    btn.textContent = 'Checkout securely';
    if (alt) alt.hidden = true;
  }
}
function orderSummary() {
  const ids = Object.keys(cart).filter(id => cart[id] > 0);
  if (!ids.length) return '';
  let sub = 0;
  const lines = ids.map(id => {
    const p = products.find(x => x.id == id);
    if (!p) return '';
    sub += p.price * cart[id];
    return cart[id] + ' \u00d7 ' + p.name + ' \u2014 ' + gbp.format(p.price * cart[id]);
  }).filter(Boolean);
  const subP = Math.round(sub * 100), post = subP >= FREE_FROM * 100 ? 0 : POSTAGE;
  return 'Hello, I would like to order:\n\n' + lines.join('\n') +
    '\n\nSubtotal: ' + gbp.format(sub) +
    '\nUK postage: ' + (post ? gbp.format(post) : 'FREE') +
    '\nTotal: ' + gbp.format(subP / 100 + post) +
    '\n\nPlease tell me how to pay.';
}
fetch('/api/config').then(r => r.json()).then(c => {
  payments = c;
  if (!c.payments) {
    setCheckoutMode(false);
    document.getElementById('pay-note').innerHTML = "<strong>Card payments aren't open yet.</strong> You can still fill your basket, then use <a class=\"order-link\" href=\"/#contact\">Order by message</a>. UK postage is £3.50, or free on orders of £30 or more.";
    document.getElementById('footer-note').textContent = 'Online payments coming soon';
  } else {
    setCheckoutMode(true);
    if (c.testMode) document.getElementById('footer-note').textContent = 'Stripe test mode · no real payments';
  }
}).catch(() => setCheckoutMode(false));
document.addEventListener('click', e => {
  const link = e.target.closest('a.order-link');
  if (!link) return;
  e.preventDefault();
  const ta = document.querySelector('#contact-form textarea[name=message]');
  const summary = orderSummary();
  if (ta && summary) ta.value = summary;
  const section = document.getElementById('contact');
  if (section && section.scrollIntoView) section.scrollIntoView();
  try { history.replaceState(null, '', '/#contact'); } catch {}
  if (ta) ta.focus();
});
document.getElementById('checkout').addEventListener('submit', async e => {
  e.preventDefault();
  if (!paymentsOn) return;
  const msg = document.getElementById('checkout-msg'), btn = document.getElementById('checkout-btn');
  const items = Object.entries(cart).filter(([, q]) => q > 0).map(([id, qty]) => ({ id: +id, qty }));
  if (!items.length) { msg.className = 'err'; msg.textContent = 'Add something to your basket first.'; return; }
  btn.disabled = true; msg.className = ''; msg.textContent = 'Taking you to secure checkout…';
  try {
    const r = await fetch('/api/checkout/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items }) });
    const j = await r.json();
    if (j.products) setProducts(j.products);
    if (r.ok && j.url) { try { sessionStorage.setItem('cdPendingOrder', j.order); } catch {} location.href = j.url; setTimeout(() => { if (paymentsOn) btn.disabled = false; }, 4000); return; }
    msg.className = 'err'; msg.textContent = j.error || 'Something went wrong. Please try again.';
  } catch { msg.className = 'err'; msg.textContent = "Couldn't reach the shop. Check your connection and try again."; }
  if (paymentsOn) btn.disabled = false;
});
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
// When checkout opened outside this page (Android app -> system browser), check the order on return.
async function checkPending() {
  let id; try { id = sessionStorage.getItem('cdPendingOrder'); } catch {}
  if (!id) return;
  const msg = document.getElementById('checkout-msg'), btn = document.getElementById('checkout-btn');
  if (paymentsOn) { btn.disabled = false; btn.removeAttribute('aria-disabled'); }
  try {
    const { status } = await (await fetch('/api/orders/' + encodeURIComponent(id) + '/status')).json();
    if (status === 'paid' || status === 'sent') { sessionStorage.removeItem('cdPendingOrder'); cart = {}; msg.className = 'ok'; msg.textContent = `Thank you! Order ${id} is paid. A receipt is on its way by email.`; refresh(); }
    else if (status === 'pending') { msg.className = ''; msg.textContent = 'Finish paying on the Stripe page, or tap Checkout securely to start again.'; }
    else { sessionStorage.removeItem('cdPendingOrder'); refresh(); }
  } catch {}
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) checkPending(); });
window.addEventListener('pageshow', checkPending);
refresh(); setInterval(refresh, 10000);
