document.getElementById('year').textContent = new Date().getFullYear();
const gbp = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' });
const CUBE = '<svg class="cube-icon" viewBox="0 0 64 64" aria-hidden="true" focusable="false"><path fill="#a94f20" d="M10 18 32 30 32 54 10 42Z"/><path fill="#c4622d" d="M54 18 32 30 32 54 54 42Z"/><path fill="#c4622d" d="M32 6 46.7 14 17.3 14Z"/><path fill="#e6a94a" d="M17.3 14 46.7 14 54 18 46.7 22 17.3 22 10 18Z"/><path fill="#c4622d" d="M17.3 22 46.7 22 32 30Z"/></svg>';
let products = [], cart = {}, filter = 'All';
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

function render() {
  document.getElementById('grid').innerHTML = products.filter(p => filter === 'All' || p.printType === filter).map(p => {
    const inCart = cart[p.id] || 0, avail = p.stock - inCart;
    const st = p.stock === 0 ? '<span class="stock out">Sold out</span>' : `<span class="stock${p.stock <= 3 ? ' low' : ''}">${p.stock} left</span>`;
    return `<article class="card">
      <div class="card-media">${CUBE}<span class="type type-${p.printType.toLowerCase()}">${esc(p.printType)}</span>${p.sample ? '<span class="badge">Sample</span>' : ''}</div>
      <h3>${esc(p.name)}</h3><p>${esc(p.description)}</p>
      <div class="card-foot"><div><span class="price">${gbp.format(p.price)}</span><br>${st}</div>
      <button class="btn small" data-add="${p.id}" ${avail <= 0 ? 'disabled' : ''}>${p.stock === 0 ? 'Sold out' : avail <= 0 ? 'All in basket' : 'Add to basket'}</button></div>
    </article>`;
  }).join('') || '<p class="muted">No products in this category yet.</p>';
  const ids = Object.keys(cart).filter(id => cart[id] > 0);
  let total = 0;
  document.getElementById('cart-lines').innerHTML = ids.length ? ids.map(id => {
    const p = products.find(x => x.id == id); if (!p) return '';
    total += p.price * cart[id];
    return `<div class="cart-line"><span>${esc(p.name)}</span><span><button data-dec="${id}" aria-label="Remove one">−</button> ${cart[id]} <button data-add="${id}" aria-label="Add one" ${cart[id] >= p.stock ? 'disabled' : ''}>+</button></span><span class="price">${gbp.format(p.price * cart[id])}</span></div>`;
  }).join('') + `<div class="cart-total">Total <span class="price">${gbp.format(total)}</span></div>` : '<p class="muted">Your basket is empty.</p>';
  document.getElementById('cart-count').textContent = ids.reduce((s, id) => s + cart[id], 0);
}
function setProducts(list) {
  products = list;
  for (const id in cart) { const p = products.find(x => x.id == id); cart[id] = p ? Math.min(cart[id], p.stock) : 0; }
  render();
}
async function refresh() { try { setProducts(await (await fetch('/api/products')).json()); } catch {} }

document.addEventListener('click', e => {
  const c = e.target.closest('[data-filter]');
  if (c) { filter = c.dataset.filter; document.querySelectorAll('.chip').forEach(x => x.classList.toggle('active', x === c)); render(); return; }
  const a = e.target.closest('[data-add]'), d = e.target.closest('[data-dec]');
  if (a && !a.disabled) { const id = a.dataset.add, p = products.find(x => x.id == id); if ((cart[id] || 0) < p.stock) cart[id] = (cart[id] || 0) + 1; render(); }
  if (d) { cart[d.dataset.dec]--; render(); }
});
document.getElementById('checkout').addEventListener('submit', async e => {
  e.preventDefault();
  const msg = document.getElementById('checkout-msg'), f = new FormData(e.target);
  const items = Object.entries(cart).filter(([, q]) => q > 0).map(([id, qty]) => ({ id: +id, qty }));
  if (!items.length) { msg.className = 'err'; msg.textContent = 'Add something to your basket first.'; return; }
  const r = await fetch('/api/checkout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: f.get('name'), email: f.get('email'), items }) });
  const j = await r.json();
  if (j.products) setProducts(j.products);
  if (r.ok) { cart = {}; render(); e.target.reset(); msg.className = 'ok'; msg.textContent = `Demo order ${j.order.id} placed (${gbp.format(j.order.total)}). No payment was taken.`; }
  else { msg.className = 'err'; msg.textContent = j.error || 'Something went wrong.'; }
});
refresh(); setInterval(refresh, 10000);
