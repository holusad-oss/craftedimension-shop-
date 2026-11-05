// Browser copy of lib/order-enquiry.js. Keep the two in step.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.orderEnquiry = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const SHOP_EMAIL = 'teamcraftedimensions@gmail.com';
  const FREE_FROM = 35;
  const POSTAGE = 3.5;
  const gbp = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' });

  function message(lines) {
    if (!Array.isArray(lines) || !lines.length) return '';
    const rows = lines.map(line => {
      const qty = Math.floor(Number(line.qty));
      const price = Number(line.price);
      return qty + ' \u00d7 ' + String(line.title) + ' \u2014 ' + gbp.format(price * qty);
    });
    const sub = lines.reduce((sum, line) => sum + Number(line.price) * Math.floor(Number(line.qty)), 0);
    const subP = Math.round(sub * 100);
    const post = subP >= FREE_FROM * 100 ? 0 : POSTAGE;
    const total = subP / 100 + post;
    return [
      'Hello,',
      '',
      'I would like to pay by bank transfer. Please send the payment instructions.',
      '',
      rows.join('\n'),
      '',
      'Subtotal: ' + gbp.format(sub),
      'UK postage: ' + (post ? gbp.format(post) : 'FREE'),
      'Total: ' + gbp.format(total),
      '',
      'This email is an enquiry. It does not place an order, and it does not mean a transfer has been made.',
    ].join('\n');
  }

  function mailto(lines) {
    const body = message(lines);
    if (!body) return '';
    return 'mailto:' + SHOP_EMAIL
      + '?subject=' + encodeURIComponent('Bank transfer order enquiry')
      + '&body=' + encodeURIComponent(body);
  }

  return { SHOP_EMAIL, FREE_FROM, POSTAGE, message, mailto };
});
