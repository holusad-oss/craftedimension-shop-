// Storage: Postgres when DATABASE_URL is set (Supabase / Neon free tier), otherwise a local JSON file.
// The app keeps a working copy in memory (so stock checks stay synchronous and atomic in this single
// Node process) and writes every change through to the store. Only changed rows are written.
const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, 'data', 'db.json');
const SEED_FILE = path.join(__dirname, 'data', 'seed.json');
const UPLOAD_DIR = path.join(__dirname, 'data', 'uploads');
const CUSTOM_DIR = path.join(UPLOAD_DIR, 'custom');
const FINISHES = ['raw', 'sanded', 'primed', 'painted'];

// Sample specs keyed by product name. Used only when a field is missing, so a later edit is kept.
const SAMPLE_SPECS = {
  'Hex Planter (Sample)': {
    material: 'PLA', colour: 'Terracotta', size_mm: { l: 100, w: 100, h: 90 },
    detail: '0.2 mm layers', finish: 'raw',
    care_notes: 'Not food-safe — do not use it for food or drink. PLA softens in heat or a hot car. Hand wash only.',
    lead_time_days: [3, 7],
  },
  'Cable Tidy Set (Sample)': {
    material: 'PETG', colour: 'Black', size_mm: { l: 40, w: 20, h: 15 },
    detail: '0.2 mm layers', finish: 'raw',
    care_notes: 'PETG takes everyday knocks better than PLA. Still not food-safe. Keep clips off a radiator.',
    lead_time_days: [3, 7],
  },
  'Lithophane Lamp (Sample)': {
    material: 'PLA', colour: 'White', size_mm: { l: 120, w: 90, h: 140 },
    detail: '0.2 mm layers', finish: 'raw',
    care_notes: 'White PLA, meant to be lit from behind. Not food-safe. PLA softens in heat or a hot car — keep it away from a hot bulb and from a sunny windowsill.',
    lead_time_days: [3, 7],
  },
  'Articulated Dragon (Sample)': {
    material: 'PLA', colour: 'Forest green', size_mm: { l: 300, w: 40, h: 50 },
    detail: '0.2 mm layers', finish: 'raw',
    care_notes: 'Flex the joints gently the first time. Not a toy for young children. PLA softens in heat or a hot car.',
    lead_time_days: [3, 7],
  },
  'Headphone Stand (Sample)': {
    material: 'PLA', colour: 'Matte black', size_mm: { l: 110, w: 100, h: 240 },
    detail: '0.2 mm layers', finish: 'sanded',
    care_notes: 'Sanded matte PLA. Not food-safe. PLA softens in heat or a hot car, so keep it off a sunny windowsill.',
    lead_time_days: [3, 7],
  },
  'Miniature Knight Figure (Sample)': {
    material: 'Standard resin', colour: 'Grey', size_mm: { l: 32, w: 25, h: 32 },
    detail: '0.05 mm resin', finish: 'raw',
    care_notes: 'Unpainted standard resin, grey. Display it indoors and handle thin parts gently. Not food-safe.',
    lead_time_days: [3, 7],
  },
  'Leaf Jewellery Dish (Sample)': {
    material: 'Tough (ABS-like) resin', colour: 'Sage', size_mm: { l: 90, w: 90, h: 25 },
    detail: '0.05 mm resin', finish: 'sanded',
    care_notes: 'Tough (ABS-like) resin, sanded. For jewellery, not food. Handle thin edges gently.',
    lead_time_days: [3, 7],
  },
  'Mini Bust Ornament (Sample)': {
    material: 'Standard resin', colour: 'Stone-effect', size_mm: { l: 40, w: 35, h: 60 },
    detail: '0.05 mm resin', finish: 'painted',
    care_notes: 'Standard resin with a stone-effect finish. Display it indoors. Dust with a dry or slightly damp cloth. Not food-safe.',
    lead_time_days: [3, 7],
  },
};

// Earlier sample defaults, replaced only when a row still has them. An edited value is left alone.
const PREVIOUS_SAMPLE = {
  'Miniature Knight Figure (Sample)': {
    material: 'ABS-like resin',
    care_notes: 'Unpainted ABS-like resin. Resin is brittle, not for outdoor use. Not food-safe. Don\'t drop it, and keep it out of long sun.',
  },
  'Leaf Jewellery Dish (Sample)': {
    material: 'Standard resin',
    care_notes: 'Sanded standard resin for jewellery, not food. Not food-safe. Resin is brittle, not for outdoor use.',
  },
  'Mini Bust Ornament (Sample)': {
    colour: 'Stone grey',
    care_notes: 'Painted standard resin. Dust it; don\'t soak it. Not food-safe. Resin is brittle, not for outdoor use.',
  },
};

function dimOf(v) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 10) / 10;
}

function sizeOf(v) {
  const s = v && typeof v === 'object' ? v : {};
  return { l: dimOf(s.l), w: dimOf(s.w), h: dimOf(s.h) };
}

function leadOf(v, fallback) {
  const fb = fallback || [3, 7];
  if (!Array.isArray(v) || v.length < 2) return [fb[0], fb[1]];
  let a = Math.floor(Number(v[0]));
  let b = Math.floor(Number(v[1]));
  if (!Number.isFinite(a) || a < 0) a = fb[0];
  if (!Number.isFinite(b) || b < 0) b = fb[1];
  return [Math.min(a, b), Math.max(a, b)];
}

function defaultsFor(p) {
  if (SAMPLE_SPECS[p.name]) return SAMPLE_SPECS[p.name];
  const resin = String(p.printType || '').toLowerCase() === 'resin';
  return {
    material: resin ? 'Standard resin' : 'PLA',
    colour: '',
    size_mm: { l: null, w: null, h: null },
    detail: resin ? '0.05 mm resin' : '0.2 mm layers',
    finish: 'raw',
    care_notes: '',
    lead_time_days: [3, 7],
  };
}

function migrateProduct(p) {
  const d = defaultsFor(p);
  let changed = false;
  const limits = { material: 80, colour: 80, detail: 120, care_notes: 800 };
  for (const key of Object.keys(limits)) {
    if (p[key] == null) { p[key] = d[key]; changed = true; }
    else {
      const s = String(p[key]).slice(0, limits[key]);
      if (s !== p[key]) { p[key] = s; changed = true; }
    }
  }
  if (p.finish == null) { p.finish = d.finish; changed = true; }
  else if (!FINISHES.includes(p.finish)) { p.finish = 'raw'; changed = true; }
  if (p.size_mm == null) { p.size_mm = sizeOf(d.size_mm); changed = true; }
  else {
    const s = sizeOf(p.size_mm);
    const extra = Object.keys(p.size_mm).length !== 3;
    if (extra || p.size_mm.l !== s.l || p.size_mm.w !== s.w || p.size_mm.h !== s.h) { p.size_mm = s; changed = true; }
  }
  if (p.lead_time_days == null) { p.lead_time_days = leadOf(d.lead_time_days); changed = true; }
  else {
    const lead = leadOf(p.lead_time_days);
    if (!Array.isArray(p.lead_time_days) || p.lead_time_days.length !== 2 || p.lead_time_days[0] !== lead[0] || p.lead_time_days[1] !== lead[1]) {
      p.lead_time_days = lead; changed = true;
    }
  }
  const prev = PREVIOUS_SAMPLE[p.name];
  const next = SAMPLE_SPECS[p.name];
  if (prev && next) {
    if (prev.material && p.material === prev.material) { p.material = next.material; changed = true; }
    if (prev.colour && p.colour === prev.colour) { p.colour = next.colour; changed = true; }
    if (prev.care_notes && p.care_notes === prev.care_notes) { p.care_notes = next.care_notes; changed = true; }
  }
  return changed;
}

function migrateState(state) {
  let changed = false;
  if (!Array.isArray(state.products)) { state.products = []; changed = true; }
  if (!Array.isArray(state.orders)) { state.orders = []; changed = true; }
  if (!Array.isArray(state.customRequests)) { state.customRequests = []; changed = true; }
  if (!Array.isArray(state.contactMessages)) { state.contactMessages = []; changed = true; }
  for (const p of state.products) if (migrateProduct(p)) changed = true;
  return changed;
}

function seedState() {
  // Migration: an existing local db.json (products, stock, orders) wins over the sample seed.
  if (fs.existsSync(DB_FILE)) {
    const state = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    const changed = migrateState(state);
    return { state, from: 'data/db.json', changed };
  }
  const s = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
  const state = { products: s.map((p, i) => ({ id: i + 1, sample: true, ...p })), orders: [], customRequests: [], contactMessages: [], nextId: s.length + 1 };
  migrateState(state);
  return { state, from: 'data/seed.json', changed: true };
}

function imageId(id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n < 1) return null;
  return n;
}

function customId(id) {
  const s = String(id || '').toLowerCase();
  if (!/^[a-f0-9]{16}$/.test(s)) return null;
  return s;
}

class JsonStore {
  constructor() { this.kind = 'json-file'; }
  async init() {
    fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
    const { state, from, changed } = seedState();
    if (!fs.existsSync(DB_FILE) || changed) this.write(state);
    console.log(`[store] JSON file ${DB_FILE} (${from === 'data/db.json' ? 'existing' : 'seeded from data/seed.json'})`);
    return state;
  }
  write(d) { const t = DB_FILE + '.tmp'; fs.writeFileSync(t, JSON.stringify(d, null, 2)); fs.renameSync(t, DB_FILE); }
  save(d) { this.write(d); return Promise.resolve(); }
  flush() { return Promise.resolve(); }
  async saveImage(id, full, thumb) {
    const n = imageId(id);
    if (!n) throw new Error('Bad product id');
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    const fullPath = path.join(UPLOAD_DIR, n + '.webp');
    const thumbPath = path.join(UPLOAD_DIR, n + '-thumb.webp');
    fs.writeFileSync(fullPath + '.tmp', full); fs.renameSync(fullPath + '.tmp', fullPath);
    fs.writeFileSync(thumbPath + '.tmp', thumb); fs.renameSync(thumbPath + '.tmp', thumbPath);
  }
  async readImage(id, kind) {
    const n = imageId(id);
    if (!n) return null;
    const file = path.join(UPLOAD_DIR, n + (kind === 'thumb' ? '-thumb' : '') + '.webp');
    if (!fs.existsSync(file)) return null;
    const st = fs.statSync(file);
    return { buf: fs.readFileSync(file), updated: st.mtime };
  }
  async deleteImage(id) {
    const n = imageId(id);
    if (!n) return;
    for (const name of [n + '.webp', n + '-thumb.webp']) {
      const file = path.join(UPLOAD_DIR, name);
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
  }
  async saveCustomFile(id, filename, mime, buf) {
    const n = customId(id);
    if (!n) throw new Error('Bad request id');
    fs.mkdirSync(CUSTOM_DIR, { recursive: true });
    const bin = path.join(CUSTOM_DIR, n);
    const meta = { filename: String(filename || 'upload').slice(0, 180), mime: String(mime || 'application/octet-stream').slice(0, 120) };
    fs.writeFileSync(bin + '.tmp', buf); fs.renameSync(bin + '.tmp', bin);
    fs.writeFileSync(bin + '.json.tmp', JSON.stringify(meta)); fs.renameSync(bin + '.json.tmp', bin + '.json');
  }
  async readCustomFile(id) {
    const n = customId(id);
    if (!n) return null;
    const bin = path.join(CUSTOM_DIR, n);
    if (!fs.existsSync(bin) || !fs.existsSync(bin + '.json')) return null;
    let meta;
    try { meta = JSON.parse(fs.readFileSync(bin + '.json', 'utf8')); }
    catch { return null; }
    return { buf: fs.readFileSync(bin), filename: meta.filename || 'upload', mime: meta.mime || 'application/octet-stream' };
  }
}

class PgStore {
  constructor(url) {
    const { Pool } = require('pg');
    const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url) || process.env.DATABASE_SSL === 'false';
    this.pool = new Pool({ connectionString: url, max: 3, ssl: local ? false : { rejectUnauthorized: false } });
    this.kind = 'postgres'; this.seen = { p: new Map(), o: new Map(), c: new Map(), m: new Map(), nextId: null }; this.chain = Promise.resolve(); this.pending = null;
  }
  async init() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS products (id integer PRIMARY KEY, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS orders (id text PRIMARY KEY, status text NOT NULL, created_at timestamptz NOT NULL, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
      CREATE INDEX IF NOT EXISTS orders_status_idx ON orders (status);
      CREATE TABLE IF NOT EXISTS meta (key text PRIMARY KEY, value jsonb NOT NULL);
      CREATE TABLE IF NOT EXISTS product_images (
        product_id integer PRIMARY KEY,
        full bytea NOT NULL,
        thumb bytea NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS custom_requests (
        id text PRIMARY KEY,
        created_at timestamptz NOT NULL,
        data jsonb NOT NULL
      );
      CREATE TABLE IF NOT EXISTS custom_files (
        id text PRIMARY KEY,
        filename text NOT NULL,
        mime text NOT NULL,
        data bytea NOT NULL
      );
      CREATE TABLE IF NOT EXISTS contact_messages (
        id text PRIMARY KEY,
        created_at timestamptz NOT NULL,
        data jsonb NOT NULL
      );`);
    const has = (await this.pool.query('SELECT 1 FROM meta WHERE key = $1', ['nextId'])).rowCount;
    if (!has) {
      const { state, from } = seedState();
      await this.writeDiff(state);
      console.log(`[store] Postgres: created tables and seeded ${state.products.length} products / ${state.orders.length} orders from ${from}`);
    }
    const products = (await this.pool.query('SELECT data FROM products ORDER BY id')).rows.map(r => r.data);
    const orders = (await this.pool.query('SELECT data FROM orders ORDER BY created_at, id')).rows.map(r => r.data);
    const customRequests = (await this.pool.query('SELECT data FROM custom_requests ORDER BY created_at, id')).rows.map(r => r.data);
    const contactMessages = (await this.pool.query('SELECT data FROM contact_messages ORDER BY created_at, id')).rows.map(r => r.data);
    const nextId = (await this.pool.query('SELECT value FROM meta WHERE key = $1', ['nextId'])).rows[0].value;
    products.forEach(p => this.seen.p.set(p.id, JSON.stringify(p)));
    orders.forEach(o => this.seen.o.set(o.id, JSON.stringify(o)));
    customRequests.forEach(r => this.seen.c.set(r.id, JSON.stringify(r)));
    contactMessages.forEach(r => this.seen.m.set(r.id, JSON.stringify(r)));
    this.seen.nextId = nextId;
    const state = { products, orders, customRequests, contactMessages, nextId };
    if (migrateState(state)) await this.writeDiff(state);
    console.log(`[store] Postgres connected: ${products.length} products, ${orders.length} orders, ${customRequests.length} custom requests`);
    return state;
  }
  async writeDiff(d) {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const ids = new Set();
      for (const p of d.products) {
        ids.add(p.id); const j = JSON.stringify(p);
        if (this.seen.p.get(p.id) !== j) { await c.query('INSERT INTO products (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()', [p.id, j]); this.seen.p.set(p.id, j); }
      }
      for (const id of [...this.seen.p.keys()]) if (!ids.has(id)) { await c.query('DELETE FROM products WHERE id = $1', [id]); this.seen.p.delete(id); }
      for (const o of d.orders) {
        const j = JSON.stringify(o);
        if (this.seen.o.get(o.id) !== j) { await c.query('INSERT INTO orders (id, status, created_at, data) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, data = EXCLUDED.data, updated_at = now()', [o.id, o.status || 'demo', o.createdAt || new Date().toISOString(), j]); this.seen.o.set(o.id, j); }
      }
      for (const r of d.customRequests || []) {
        const j = JSON.stringify(r);
        if (this.seen.c.get(r.id) !== j) { await c.query('INSERT INTO custom_requests (id, created_at, data) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data', [r.id, r.createdAt || new Date().toISOString(), j]); this.seen.c.set(r.id, j); }
      }
      for (const r of d.contactMessages || []) {
        const j = JSON.stringify(r);
        if (this.seen.m.get(r.id) !== j) { await c.query('INSERT INTO contact_messages (id, created_at, data) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data', [r.id, r.createdAt || new Date().toISOString(), j]); this.seen.m.set(r.id, j); }
      }
      if (this.seen.nextId !== d.nextId) { await c.query('INSERT INTO meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', ['nextId', JSON.stringify(d.nextId)]); this.seen.nextId = d.nextId; }
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
  }
  // Writes are serialised; a burst of saves collapses into one write of the latest state.
  save(d) {
    if (this.pending) return this.pending;
    this.pending = this.chain = this.chain.then(() => { this.pending = null; return this.writeDiff(d); })
      .catch(e => { console.error('[store] write failed:', e.message); throw e; });
    this.chain = this.chain.catch(() => {});
    return this.pending;
  }
  flush() { return this.chain; }
  async saveImage(id, full, thumb) {
    const n = imageId(id);
    if (!n) throw new Error('Bad product id');
    await this.pool.query(
      `INSERT INTO product_images (product_id, full, thumb) VALUES ($1, $2, $3)
       ON CONFLICT (product_id) DO UPDATE SET full = EXCLUDED.full, thumb = EXCLUDED.thumb, updated_at = now()`,
      [n, full, thumb]
    );
  }
  async readImage(id, kind) {
    const n = imageId(id);
    if (!n) return null;
    const col = kind === 'thumb' ? 'thumb' : 'full';
    const r = await this.pool.query(`SELECT ${col} AS data, updated_at FROM product_images WHERE product_id = $1`, [n]);
    if (!r.rowCount) return null;
    return { buf: r.rows[0].data, updated: r.rows[0].updated_at };
  }
  async deleteImage(id) {
    const n = imageId(id);
    if (!n) return;
    await this.pool.query('DELETE FROM product_images WHERE product_id = $1', [n]);
  }
  async saveCustomFile(id, filename, mime, buf) {
    const n = customId(id);
    if (!n) throw new Error('Bad request id');
    await this.pool.query(
      `INSERT INTO custom_files (id, filename, mime, data) VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET filename = EXCLUDED.filename, mime = EXCLUDED.mime, data = EXCLUDED.data`,
      [n, String(filename || 'upload').slice(0, 180), String(mime || 'application/octet-stream').slice(0, 120), buf]
    );
  }
  async readCustomFile(id) {
    const n = customId(id);
    if (!n) return null;
    const r = await this.pool.query('SELECT filename, mime, data FROM custom_files WHERE id = $1', [n]);
    if (!r.rowCount) return null;
    return { buf: r.rows[0].data, filename: r.rows[0].filename, mime: r.rows[0].mime };
  }
}

module.exports = function createStore() {
  return process.env.DATABASE_URL ? new PgStore(process.env.DATABASE_URL) : new JsonStore();
};
