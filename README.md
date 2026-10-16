# Craftedimension shop

Small Express shop for 3D printed products (FDM & resin) with live stock counts, Stripe Checkout (GBP, UK delivery) and a password-protected admin page.

> Payments use Stripe Checkout. Without `STRIPE_SECRET_KEY` the shop still runs and checkout shows "payments aren't set up yet". Live keys are refused unless `STRIPE_ALLOW_LIVE=1`.

See `.env.example` for all settings. Webhook endpoint: `POST /api/stripe/webhook` (event `checkout.session.completed`, plus `checkout.session.expired` to release reserved stock). Paid orders appear in `/admin` where they can be marked as sent.

## Run locally
```bash
npm install
ADMIN_PASSWORD=choose-a-password npm start   # http://localhost:3000, admin at /admin
```
If `ADMIN_PASSWORD` is not set, a random password is generated and printed to the console at startup.

## Data
- `data/seed.json` – sample products (all marked as samples), including material, colour, size, detail, finish, care notes and lead time.
- `data/db.json` – live products, stock, orders and custom requests; created from the seed on first start (git-ignored). Delete it to reset. On startup, missing product fields are filled in (sample names get the sample specs; anything else gets PLA or Standard resin, raw finish, and a 3–7 day lead time) without overwriting values already saved.

## Deploy on Render
- Runtime: Node · Build: `npm install` · Start: `node server.js`
- Env: `ADMIN_PASSWORD` (required for a stable admin login). `PORT` is set by Render automatically.
- Storage is a JSON file: on Render's free plan the disk is ephemeral, so stock/orders reset on every redeploy/restart. Attach a persistent disk mounted at `/opt/render/project/src/data` (paid) to keep them.

## API
- `GET /api/products[?type=fdm|resin]` — response includes `Access-Control-Allow-Origin: *`. Other public `GET /api/*` routes do too. Admin routes do not.
- `POST /api/checkout` `{ name, email, items: [{ id, qty }] }` – atomic; 409 if not enough stock
- Admin (HTTP Basic, any username + ADMIN_PASSWORD): `GET /api/admin/data`, `POST/PUT/DELETE /api/admin/products[/:id]`. Product photos are uploaded on those create and edit requests (multipart, 8MB). `hidden: true` keeps a product out of the shop.

## Mobile app
The Craftedimension Android app is recognised when the `User-Agent` contains `CraftedimensionApp`, or when the request includes `X-Craftedimension-App: 1`. For those requests:

- `/admin` and `/api/admin/*` respond with `404` and no login challenge, even if the admin password is sent.
- Any link to `/admin` in the shop HTML is removed, and the page is marked `data-app="1"` so the same links stay hidden if the app's user agent is present.

The storefront has no admin link of its own. The shop page in a normal browser is unchanged.

## Privacy
`/privacy` (`public/privacy.html`) is linked from the footer. Replace the `[OWNER NAME]` and `[CONTACT EMAIL]` placeholders before launch.

## Storage

Set `DATABASE_URL` to a Postgres connection string (Neon or Supabase free tier) and the shop creates its tables (`products`, `orders`, `meta`, `product_images`) on first start and seeds them from `data/db.json` if present, otherwise from `data/seed.json`. Without `DATABASE_URL` it uses the local `data/db.json` file (fine for development, not for Render's free plan, where the disk is wiped on every deploy/restart).

Product photos are resized to WebP (at most 1200px, plus a 400px thumbnail). With `DATABASE_URL` the bytes live in `product_images`, so they survive an ephemeral disk. Otherwise they are files in `data/uploads/` (git-ignored). The shop serves them at `/img/p/<id>.webp`.

Custom-print files (STL, 3MF, OBJ or an image, up to 20MB) are stored in `custom_files` (Postgres `bytea`) when `DATABASE_URL` is set, and in `data/uploads/custom/` otherwise. The request itself (not the file bytes) is kept with the other shop data. `POST /api/custom` checks the fields, ignores a filled honeypot, and allows 5 requests an hour per IP. If `SMTP_HOST` and `OWNER_EMAIL` are set, the owner is emailed; otherwise the request is written to the server log.

## Materials, lead time and custom prints

`/materials` is a draft comparison of FDM, resin, PLA and PETG for a specialist to revise. Product cards show material, colour and size, plus “Made to order · ships in X–Y days”. Stock still decrements on sale and is edited in `/admin`; the shop only shows “Only N left” at 3 or fewer and “Sold out” at 0. `/custom` is the custom-order form (the hero button points here). The returns sentence on product details and `/custom` is marked as a draft for the owner to confirm.

## Postage

UK postage is £3.50, free when the goods subtotal is £30 or more. It is calculated on the server and sent to Stripe as a fixed-amount shipping rate.
