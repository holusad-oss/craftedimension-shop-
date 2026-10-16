// Storage: Postgres when DATABASE_URL is set (Supabase / Neon free tier), otherwise a local JSON file.
// The app keeps a working copy in memory (so stock checks stay synchronous and atomic in this single
// Node process) and writes every change through to the store. Only changed rows are written.
const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, 'data', 'db.json');
const SEED_FILE = path.join(__dirname, 'data', 'seed.json');

function seedState() {
  // Migration: an existing local db.json (products, stock, orders) wins over the sample seed.
  if (fs.existsSync(DB_FILE)) { const d = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); d.orders = d.orders || []; return { state: d, from: 'data/db.json' }; }
  const s = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
  return { state: { products: s.map((p, i) => ({ id: i + 1, sample: true, ...p })), orders: [], nextId: s.length + 1 }, from: 'data/seed.json' };
}

const UPLOAD_DIR = path.join(__dirname, 'data', 'uploads');

function imageId(id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n < 1) return null;
  return n;
}

class JsonStore {
  constructor() { this.kind = 'json-file'; }
  async init() {
    fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
    const { state, from } = seedState();
    if (!fs.existsSync(DB_FILE)) this.write(state);
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
}

class PgStore {
  constructor(url) {
    const { Pool } = require('pg');
    const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url) || process.env.DATABASE_SSL === 'false';
    this.pool = new Pool({ connectionString: url, max: 3, ssl: local ? false : { rejectUnauthorized: false } });
    this.kind = 'postgres'; this.seen = { p: new Map(), o: new Map(), nextId: null }; this.chain = Promise.resolve(); this.pending = null;
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
      );`);
    const has = (await this.pool.query('SELECT 1 FROM meta WHERE key = $1', ['nextId'])).rowCount;
    if (!has) {
      const { state, from } = seedState();
      await this.writeDiff(state);
      console.log(`[store] Postgres: created tables and seeded ${state.products.length} products / ${state.orders.length} orders from ${from}`);
    }
    const products = (await this.pool.query('SELECT data FROM products ORDER BY id')).rows.map(r => r.data);
    const orders = (await this.pool.query('SELECT data FROM orders ORDER BY created_at, id')).rows.map(r => r.data);
    const nextId = (await this.pool.query('SELECT value FROM meta WHERE key = $1', ['nextId'])).rows[0].value;
    products.forEach(p => this.seen.p.set(p.id, JSON.stringify(p)));
    orders.forEach(o => this.seen.o.set(o.id, JSON.stringify(o)));
    this.seen.nextId = nextId;
    console.log(`[store] Postgres connected: ${products.length} products, ${orders.length} orders`);
    return { products, orders, nextId };
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
}

module.exports = function createStore() {
  return process.env.DATABASE_URL ? new PgStore(process.env.DATABASE_URL) : new JsonStore();
};
