// Shop-product resin colours. Black, White, and Grey are the print-ready SKUs.
// `colour` on a product is the listing description. `colourOptions` is the shopper's choice.
const COLOURS = [
  { id: 'black', label: 'Black' },
  { id: 'white', label: 'White' },
  { id: 'grey', label: 'Grey' },
];

function isResinProduct(p) {
  if (!p || typeof p !== 'object') return false;
  if (String(p.printType || '').toLowerCase() === 'resin') return true;
  return /\bresin\b/i.test(String(p.material || ''));
}

function colourOptionsEnabled(p) {
  if (!p || typeof p !== 'object') return false;
  if (typeof p.colourOptions === 'boolean') return p.colourOptions;
  return isResinProduct(p);
}

function ensureColourOptions(p) {
  if (!p || typeof p !== 'object') return false;
  if (typeof p.colourOptions === 'boolean') return false;
  p.colourOptions = isResinProduct(p);
  return true;
}

function normaliseColour(value) {
  const s = String(value == null ? '' : value).trim().toLowerCase();
  if (!s) return null;
  const hit = COLOURS.find(c => c.id === s || c.label.toLowerCase() === s);
  return hit ? hit.id : null;
}

function colourLabel(id) {
  const hit = COLOURS.find(c => c.id === id);
  return hit ? hit.label : '';
}

function itemTitle(item) {
  const name = item && item.name != null ? String(item.name) : '';
  const colour = item && item.colour ? String(item.colour).trim() : '';
  return colour ? name + ' \u2014 ' + colour : name;
}

function orderItem(line) {
  const item = { id: line.p.id, name: line.p.name, qty: line.q, price: line.p.price };
  if (line.colour) item.colour = colourLabel(line.colour);
  return item;
}

// Turn basket rows into order lines. Colour is required only when that product
// has colour options. Stock is shared across colours of the same product.
function resolveBasket(products, items) {
  if (!Array.isArray(items) || !items.length || items.length > 50) {
    return { error: 'Your basket is empty.', status: 400 };
  }
  const list = Array.isArray(products) ? products : [];
  const lines = [];
  for (const it of items) {
    const q = Math.floor(Number(it && it.qty));
    if (!(q > 0 && q <= 100)) return { error: 'Invalid quantity.', status: 400 };
    const id = Number(it && it.id);
    const p = list.find(x => x.id === id);
    if (!p || !Number.isInteger(id)) return { error: `Unknown product ${it && it.id}.`, status: 400 };
    let colour = null;
    if (colourOptionsEnabled(p)) {
      colour = normaliseColour(it.colour);
      if (!colour) return { error: `Choose a colour for ${p.name}: Black, White, or Grey.`, status: 400 };
    }
    const existing = lines.find(line => line.p === p && line.colour === colour);
    if (existing) existing.q += q;
    else lines.push({ p, q, colour });
  }
  const qtyByProduct = new Map();
  for (const line of lines) qtyByProduct.set(line.p, (qtyByProduct.get(line.p) || 0) + line.q);
  for (const [p, q] of qtyByProduct) {
    if (p.hidden) return { error: `${p.name} isn't in the shop any more.`, status: 409, refresh: true };
    if (!(p.price > 0)) return { error: `${p.name} can't be bought online yet.`, status: 400 };
    if (p.stock < q) {
      return {
        error: p.stock === 0 ? `${p.name} is sold out.` : `Only ${p.stock} of ${p.name} left.`,
        status: 409,
        refresh: true,
      };
    }
  }
  return { lines };
}

module.exports = {
  COLOURS,
  isResinProduct,
  colourOptionsEnabled,
  ensureColourOptions,
  normaliseColour,
  colourLabel,
  itemTitle,
  orderItem,
  resolveBasket,
};
