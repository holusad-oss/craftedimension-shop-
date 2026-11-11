const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('node:child_process');

const root = path.join(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');

test('server startup logs never interpolate the admin password', () => {
  const src = read('server.js');
  assert.match(src, /Admin password is set from ADMIN_PASSWORD/);
  assert.match(src, /ADMIN_PASSWORD is not set; a random password was generated/);
  assert.doesNotMatch(src, /password: \$\{ADMIN_PASSWORD\}/);
  assert.doesNotMatch(src, /console\.(log|warn|info|error|debug)`[^`]*\$\{ADMIN_PASSWORD\}/);
  assert.doesNotMatch(src, /console\.(log|warn|info|error|debug)\([^)]*\$\{ADMIN_PASSWORD\}/);
});

function startShop(port, extraEnv) {
  const secret = extraEnv && extraEnv.ADMIN_PASSWORD;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      ADMIN_PASSWORD: 'testpass',
      DATABASE_URL: '',
      STRIPE_SECRET_KEY: '',
      STRIPE_WEBHOOK_SECRET: '',
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
  return { child, port, logs: () => buf, secret, ready };
}

async function api(port, url, options) {
  const res = await fetch('http://127.0.0.1:' + port + url, options);
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body };
}

test('DATA_DIR keeps db.json off the repo and seed.json is still used when the db is missing', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cim-data-'));
  t.after(() => { fs.rmSync(dataDir, { recursive: true, force: true }); });
  const secret = 'data-dir-test-secret-must-not-be-logged';
  const shop = startShop(3880, { DATA_DIR: dataDir, ADMIN_PASSWORD: secret });
  t.after(() => { shop.child.kill('SIGTERM'); });
  await shop.ready;
  const logs = shop.logs();
  assert.match(logs, new RegExp('Data directory: ' + dataDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(logs, /JSON file .+\/db\.json \(seeded from .+\/data\/seed\.json\)/);
  assert.match(logs, /Admin password is set from ADMIN_PASSWORD/);
  assert.equal(logs.includes(secret), false);
  assert.doesNotMatch(logs, /password: /);
  assert.equal(fs.existsSync(path.join(dataDir, 'db.json')), true);
  const seeded = JSON.parse(fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8'));
  assert.deepEqual(seeded.products, []);
});

test('a product written under DATA_DIR is still there after a restart', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cim-data-'));
  t.after(() => { fs.rmSync(dataDir, { recursive: true, force: true }); });
  const secret = 'restart-test-secret-must-not-be-logged';
  const auth = 'Basic ' + Buffer.from('owner:' + secret).toString('base64');
  const first = startShop(3881, { DATA_DIR: dataDir, ADMIN_PASSWORD: secret });
  await first.ready;
  const created = await api(3881, '/api/admin/products', {
    method: 'POST',
    headers: { Authorization: auth },
    body: (() => {
      const fd = new FormData();
      fd.set('name', 'Persistence check');
      fd.set('price', '1');
      fd.set('stock', '1');
      fd.set('printType', 'FDM');
      fd.set('hidden', 'true');
      return fd;
    })(),
  });
  assert.equal(created.status, 200);
  const id = created.body.id;
  first.child.kill('SIGTERM');
  await new Promise(resolve => first.child.once('exit', resolve));

  const second = startShop(3882, { DATA_DIR: dataDir, ADMIN_PASSWORD: secret });
  t.after(() => { second.child.kill('SIGTERM'); });
  await second.ready;
  assert.match(second.logs(), /JSON file .+\/db\.json \(existing\)/);
  assert.equal(second.logs().includes(secret), false);
  const data = await api(3882, '/api/admin/data', { headers: { Authorization: auth } });
  assert.equal(data.status, 200);
  const product = data.body.products.find(p => p.id === id);
  assert.ok(product);
  assert.equal(product.name, 'Persistence check');
  assert.equal(product.hidden, true);
  const pub = await api(3882, '/api/products');
  assert.equal(pub.body.some(p => p.id === id), false);
});
