// Pluggable owner notifier. Uses SMTP when SMTP_HOST is set, otherwise logs to the console.
const nodemailer = require('nodemailer');
const gbp = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' });

function formatOrder(o) {
  const a = (o.shipping && o.shipping.address) || {};
  const addr = [o.shipping && o.shipping.name, a.line1, a.line2, a.city, a.state, a.postal_code, a.country].filter(Boolean).join('\n');
  return `New paid order ${o.id}\n\n` +
    o.items.map(i => `${i.qty} × ${i.name} @ ${gbp.format(i.price)}`).join('\n') +
    `\n\nTotal paid: ${gbp.format(o.amountPaid != null ? o.amountPaid : o.total)}\nCustomer email: ${o.email || '-'}\n\nShip to:\n${addr || '(no address)'}\n`;
}

let transport = null;
function getTransport() {
  if (!process.env.SMTP_HOST) return null;
  if (!transport) transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || '') === 'true' || Number(process.env.SMTP_PORT) === 465,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
  return transport;
}

async function orderPaid(order) {
  const text = formatOrder(order);
  const t = getTransport(), to = process.env.OWNER_EMAIL;
  if (!t || !to) { console.log('[notify] (no SMTP_HOST/OWNER_EMAIL set, logging instead)\n' + text); return { logged: true }; }
  await t.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER || to, to, subject: `New order ${order.id} — ${order.items.map(i => i.name).join(', ')}`.slice(0, 150), text });
  console.log(`[notify] emailed ${to} about order ${order.id}`);
  return { emailed: true };
}
module.exports = { orderPaid, formatOrder };
