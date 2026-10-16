# Craftedimension shop (demo)

Small Express shop for 3D printed products (FDM & resin) with live stock counts, a demo basket/checkout and a password-protected admin page.

> **Demo only:** no payment provider is connected. Orders just reserve stock.

## Run locally
```bash
npm install
ADMIN_PASSWORD=choose-a-password npm start   # http://localhost:3000, admin at /admin
```
If `ADMIN_PASSWORD` is not set, a random password is generated and printed to the console at startup.

## Data
- `data/seed.json` – sample products (all marked as samples).
- `data/db.json` – live products/stock/orders; created from the seed on first start (git-ignored). Delete it to reset.

## Deploy on Render
- Runtime: Node · Build: `npm install` · Start: `node server.js`
- Env: `ADMIN_PASSWORD` (required for a stable admin login). `PORT` is set by Render automatically.
- Storage is a JSON file: on Render's free plan the disk is ephemeral, so stock/orders reset on every redeploy/restart. Attach a persistent disk mounted at `/opt/render/project/src/data` (paid) to keep them.

## API
- `GET /api/products[?type=fdm|resin]`
- `POST /api/checkout` `{ name, email, items: [{ id, qty }] }` – atomic; 409 if not enough stock
- Admin (HTTP Basic, any username + ADMIN_PASSWORD): `GET /api/admin/data`, `POST/PUT/DELETE /api/admin/products[/:id]`
