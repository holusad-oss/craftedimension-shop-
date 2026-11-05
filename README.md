# Crafted.i.mentions shop

Small Express shop for 3D printed products (FDM & resin) with live stock counts, bank transfer enquiries by email, and a password-protected admin page.

> Card checkout is closed. The basket asks the shopper to email [teamcraftedimensions@gmail.com](mailto:teamcraftedimensions@gmail.com) for bank transfer instructions. The link is a normal mailto. The shop does not send it, does not store it as an order, and does not treat it as payment. Bank account details are not published on the site. `POST /api/checkout/session` no longer starts a card payment, even if `STRIPE_SECRET_KEY` is set.

See `.env.example` for all settings. `POST /api/stripe/webhook` remains so an older card payment can still be recorded (`checkout.session.completed`, plus `checkout.session.expired` to release reserved stock). Those orders stay in `/admin`, where a paid one can be marked as sent. Do not delete that history.

## Run locally
```bash
npm install
ADMIN_PASSWORD=choose-a-password npm start   # http://localhost:3000, admin at /admin
```
If `ADMIN_PASSWORD` is not set, a random password is generated and printed to the console at startup.

## Data
- `data/seed.json` – starting catalogue. It is an empty list, so a fresh boot has no products until they are added in `/admin` (with photos).
- `data/db.json` – live products, stock, orders, custom requests and contact messages; created from the seed on first start (git-ignored). Delete it to reset to an empty catalogue. On startup, missing product fields are filled in (PLA or Standard resin, raw finish, and a 3–7 day lead time; a few legacy sample names still receive their old specs if that exact name is already stored) without overwriting values already saved.

## Deploy on Render
- Runtime: Node · Build: `npm install` · Start: `node server.js`
- Env: `ADMIN_PASSWORD` (required for a stable admin login). `PORT` is set by Render automatically.
- Storage is a JSON file: on Render's free plan the disk is ephemeral, so stock/orders reset on every redeploy/restart. Attach a persistent disk mounted at `/opt/render/project/src/data` (paid) to keep them.
- `GET /healthz` returns `ok` and is what `.github/workflows/keep-awake.yml` curls every 10 minutes, so a free Render service is less likely to spin down. GitHub may delay or disable scheduled runs on inactive repositories, so this is a best effort, not a guarantee. You can also run the workflow by hand.

## API
- `GET /api/products[?type=fdm|resin]` — response includes `Access-Control-Allow-Origin: *`. Other public `GET /api/*` routes do too. Admin routes do not.
- `POST /api/checkout` `{ name, email, items: [{ id, qty }] }` – atomic; 409 if not enough stock
- Admin (HTTP Basic, any username + ADMIN_PASSWORD): `GET /api/admin/data`, `POST/PUT/DELETE /api/admin/products[/:id]`. Product photos are uploaded as repeated multipart file fields named `photos` (a single `photo` field still works). Up to 8 photos, 8MB each, 32MB per request. The first photo is the main one. On edit, `imageOrder` is the full order: existing image ids and `n:0`, `n:1`, … for the new files in that request. Ids left out are removed. `GET /api/products` still returns `image` and `thumb` for the main photo, plus `images: [{ url, thumb }]`. `size_mm` stays in millimetres (`l` is depth). `sizeText` is the shop wording in centimetres, for example `H 17 × W 10 × D 3 cm`, with any dimension that is not set left out. `hidden: true` keeps a product out of the shop.

## Mobile app
The Crafted.i.mentions Android app is recognised when the `User-Agent` contains `CraftedimensionApp`, or when the request includes `X-Craftedimension-App: 1`. For those requests:

- `/admin` and `/api/admin/*` respond with `404` and no login challenge, even if the admin password is sent.
- Any link to `/admin` in the shop HTML is removed, and the page is marked `data-app="1"` so the same links stay hidden if the app's user agent is present.

The storefront has no admin link of its own. The shop page in a normal browser is unchanged.

## Privacy
`/privacy` (`public/privacy.html`) is linked from the footer. It says what the shop keeps to process an order, that you pay direct and we never see your banking login, and that details are shared only with the courier. For privacy questions, email [teamcraftedimensions@gmail.com](mailto:teamcraftedimensions@gmail.com).

## Storage

Set `DATABASE_URL` to a Postgres connection string (Neon or Supabase free tier) and the shop creates its tables (`products`, `orders`, `meta`, `product_images`, `product_gallery`) on first start and seeds them from `data/db.json` if present, otherwise from `data/seed.json`. Without `DATABASE_URL` it uses the local `data/db.json` file (fine for development, not for Render's free plan, where the disk is wiped on every deploy/restart).

Product photos are resized to WebP (at most 1200px, plus a 400px thumbnail). Each product keeps an ordered list of up to 8. With `DATABASE_URL` the bytes live in `product_gallery`, and a product's original single photo is also kept in `product_images`, so they survive an ephemeral disk. Otherwise they are files in `data/uploads/` (git-ignored). The main photo is served at `/img/p/<id>.webp`.

Custom-print files (STL, 3MF, OBJ or an image, up to 20MB) are stored in `custom_files` (Postgres `bytea`) when `DATABASE_URL` is set, and in `data/uploads/custom/` otherwise. The request itself (not the file bytes) is kept with the other shop data. `POST /api/custom` checks the fields, ignores a filled honeypot, and allows 5 requests an hour per IP. Contact messages (`POST /api/contact`) use the same honeypot and hourly limit and are stored with the shop data. Checkout is limited to 10 requests per 15 minutes per IP. Failed admin logins are limited to 10 per 15 minutes per IP. If `SMTP_HOST` and `OWNER_EMAIL` are set, the owner is emailed; otherwise the message is written to the server log. From and Reply-To on those messages default to `teamcraftedimensions@gmail.com` (override with `SMTP_FROM` and `SMTP_REPLY_TO`). SMTP login is still `SMTP_USER` / `SMTP_PASS`.

Postgres also keeps contact messages in `contact_messages`.

## Legal pages

`/delivery`, `/returns` and `/terms` are linked from the footer. They still use `[OWNER NAME]` and `[BUSINESS ADDRESS]` and each shows a "Draft — for owner review" banner. The shop email on the site is [teamcraftedimensions@gmail.com](mailto:teamcraftedimensions@gmail.com). Replace the name and address placeholders before launch.

## Materials, lead time and custom prints

`/materials` compares FDM and resin, then PLA, PETG, standard resin and tough (ABS-like) resin. Product cards show material, colour and size, plus “Made to order · ships in X–Y days”. Stock still decrements on sale and is edited in `/admin`; the shop only shows “Only N left” at 3 or fewer and “Sold out” at 0. `/custom` is the custom-order form (the hero button points here). The returns sentence on product details and `/custom` is marked as a draft for the owner to confirm.

## Postage

UK postage is £3.50, free when the goods subtotal is £35 or more. The basket shows the same figures in the bank transfer email. The shop does not take the payment itself.
