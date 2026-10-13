const SITE_ORIGIN = 'https://dickys1.github.io';
const SITE_URL = `${SITE_ORIGIN}/dickys/`;
const PRODUCTS = {
  1: { name: 'Pentagon Terrarium', price: 2200, variants: ['Gold', 'Bronze', 'Silver', 'Black', 'Red'] },
  2: { name: 'Pyramid Terrarium', price: 1800, variants: ['Black'] },
  3: { name: 'Pentagon Candle Holder', price: 1200, variants: ['Red', 'Rose', 'Gold', 'Silver', 'Magenta'] },
  4: { name: 'Pyramid Candle Lantern', price: 1000, variants: ['Black', 'Bronze'] },
  5: { name: 'Copper Hex Planter', price: 1500, variants: ['Copper'] },
  6: { name: 'Pink Dahlia Vase', price: 2200, variants: ['Copper'] },
  7: { name: 'Twin Pyramid Planter', price: 2500, variants: ['Charcoal pot', 'Blush pot'] },
  8: { name: 'Festive Gift Terrarium', price: 1800, variants: ['Green', 'Pink'] },
};
const MAX_ORDER_ITEMS = 30;
const MAX_ORDER_QUANTITY = 99;

let cachedToken;
let tokenExpiresAt = 0;
let cachedTokenEnvironment;
let cachedIpnId;
let cachedIpnEnvironment;

function jsonResponse(body, status, origin) {
  const headers = {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  };

  if (origin === SITE_ORIGIN) {
    headers['Access-Control-Allow-Origin'] = SITE_ORIGIN;
    headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
    headers['Access-Control-Allow-Headers'] = 'Content-Type';
    headers.Vary = 'Origin';
  }

  return new Response(JSON.stringify(body), { status, headers });
}

function apiBase(environment) {
  return environment === 'live'
    ? 'https://pay.pesapal.com/v3/api'
    : 'https://cybqa.pesapal.com/pesapalv3/api';
}

async function readProviderResponse(response) {
  const result = await response.json().catch(() => null);
  if (!response.ok || !result || result.error) {
    throw new Error('The payment provider could not complete the request.');
  }
  return result;
}

async function getAccessToken(env) {
  const environment = env.PESAPAL_ENV === 'live' ? 'live' : 'sandbox';
  if (
    cachedToken &&
    cachedTokenEnvironment === environment &&
    Date.now() < tokenExpiresAt
  ) {
    return cachedToken;
  }

  if (!env.PESAPAL_CONSUMER_KEY || !env.PESAPAL_CONSUMER_SECRET) {
    throw new Error('Card payments are not configured.');
  }

  const response = await fetch(`${apiBase(environment)}/Auth/RequestToken`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      consumer_key: env.PESAPAL_CONSUMER_KEY,
      consumer_secret: env.PESAPAL_CONSUMER_SECRET,
    }),
    signal: AbortSignal.timeout(15000),
  });
  const result = await readProviderResponse(response);
  if (typeof result.token !== 'string' || !result.token) {
    throw new Error('The payment provider returned an invalid token.');
  }

  cachedToken = result.token;
  cachedTokenEnvironment = environment;
  tokenExpiresAt = Date.now() + 4 * 60 * 1000;
  return cachedToken;
}

async function registerIpn(env, token, environment, workerOrigin) {
  if (cachedIpnId && cachedIpnEnvironment === environment) {
    return cachedIpnId;
  }

  const response = await fetch(`${apiBase(environment)}/URLSetup/RegisterIPN`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      url: `${workerOrigin}/api/ipn`,
      ipn_notification_type: 'GET',
    }),
    signal: AbortSignal.timeout(15000),
  });
  const result = await readProviderResponse(response);
  if (typeof result.ipn_id !== 'string' || !result.ipn_id) {
    throw new Error('The payment provider did not return an IPN identifier.');
  }

  cachedIpnId = result.ipn_id;
  cachedIpnEnvironment = environment;
  return cachedIpnId;
}

function normalizePhoneNumber(value) {
  const digits = value.replace(/\D/g, '');
  if (digits.startsWith('0') && digits.length === 10) {
    return `254${digits.slice(1)}`;
  }
  if (digits.startsWith('254') && digits.length === 12) {
    return digits;
  }
  if (digits.startsWith('7') && digits.length === 9) {
    return `254${digits}`;
  }
  return null;
}

function validateCheckout(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'Please check your order details and try again.' };
  }
  if (body.area !== 'nairobi') {
    return { error: 'Online card checkout is currently available for Nairobi deliveries. Please contact us for other destinations.' };
  }

  const customer = body.customer;
  if (
    !customer ||
    typeof customer !== 'object' ||
    typeof customer.name !== 'string' ||
    customer.name.trim().length < 2 ||
    customer.name.trim().length > 100 ||
    typeof customer.email !== 'string' ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.email.trim()) ||
    typeof customer.phone !== 'string' ||
    typeof customer.address !== 'string' ||
    customer.address.trim().length < 3 ||
    customer.address.trim().length > 200
  ) {
    return { error: 'Enter a valid name, email, phone number, and Nairobi delivery address.' };
  }

  const phone = normalizePhoneNumber(customer.phone);
  if (!phone) {
    return { error: 'Enter a valid Kenyan phone number.' };
  }
  if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > MAX_ORDER_ITEMS) {
    return { error: 'Your bag is empty or contains too many items.' };
  }

  let subtotal = 0;
  const items = [];
  for (const item of body.items) {
    const product = PRODUCTS[item?.productId];
    if (
      !product ||
      !Number.isInteger(item.variantIndex) ||
      item.variantIndex < 0 ||
      item.variantIndex >= product.variants.length ||
      !Number.isInteger(item.quantity) ||
      item.quantity < 1 ||
      item.quantity > MAX_ORDER_QUANTITY
    ) {
      return { error: 'Your bag contains an item we could not verify. Please refresh and try again.' };
    }

    subtotal += product.price * item.quantity;
    items.push({
      name: product.name,
      variant: product.variants[item.variantIndex],
      quantity: item.quantity,
      unitPrice: product.price,
    });
  }

  const delivery = subtotal >= 5000 ? 0 : 300;
  return {
    customer: {
      name: customer.name.trim(),
      email: customer.email.trim(),
      phone,
      address: customer.address.trim(),
    },
    items,
    subtotal,
    delivery,
    total: subtotal + delivery,
  };
}

async function submitCheckout(request, env, body) {
  const order = validateCheckout(body);
  if (order.error) {
    return jsonResponse({ error: order.error }, 400, request.headers.get('Origin'));
  }

  const environment = env.PESAPAL_ENV === 'live' ? 'live' : 'sandbox';
  const token = await getAccessToken(env);
  const notificationId = await registerIpn(env, token, environment, new URL(request.url).origin);
  const merchantReference = crypto.randomUUID();
  const [firstName, ...remainingNames] = order.customer.name.split(/\s+/);
  const lastName = remainingNames.join(' ') || firstName;
  const description = order.items
    .map((item) => `${item.quantity} x ${item.name} (${item.variant})`)
    .join(', ')
    .slice(0, 100);

  const response = await fetch(`${apiBase(environment)}/Transactions/SubmitOrderRequest`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      id: merchantReference,
      currency: 'KES',
      amount: order.total,
      description: `Dickys order: ${description}`,
      callback_url: `${SITE_URL}?payment=pesapal-return`,
      notification_id: notificationId,
      billing_address: {
        email_address: order.customer.email,
        phone_number: order.customer.phone,
        country_code: 'KE',
        first_name: firstName,
        last_name: lastName,
        line_1: order.customer.address,
      },
    }),
    signal: AbortSignal.timeout(20000),
  });
  const result = await readProviderResponse(response);
  let redirectUrl;
  try {
    redirectUrl = new URL(result.redirect_url);
  } catch {
    throw new Error('The payment provider returned an invalid checkout URL.');
  }
  if (
    redirectUrl.protocol !== 'https:' ||
    !(redirectUrl.hostname === 'pesapal.com' || redirectUrl.hostname.endsWith('.pesapal.com'))
  ) {
    throw new Error('The payment provider returned an untrusted checkout URL.');
  }

  return jsonResponse(
    { redirectUrl: redirectUrl.toString() },
    200,
    request.headers.get('Origin'),
  );
}

async function getTransactionStatus(env, orderTrackingId) {
  const environment = env.PESAPAL_ENV === 'live' ? 'live' : 'sandbox';
  const token = await getAccessToken(env);
  const url = new URL(`${apiBase(environment)}/Transactions/GetTransactionStatus`);
  url.searchParams.set('orderTrackingId', orderTrackingId);
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  });
  return readProviderResponse(response);
}

function paymentState(result) {
  const description = String(result.payment_status_description || result.status || '').toLowerCase();
  if (description === 'completed') return 'completed';
  if (description === 'failed' || description === 'reversed' || description === 'invalid') {
    return 'failed';
  }
  return 'pending';
}

async function handleStatus(request, env) {
  const origin = request.headers.get('Origin');
  if (origin !== SITE_ORIGIN) {
    return jsonResponse({ error: 'Request origin is not allowed.' }, 403, origin);
  }
  const orderTrackingId = new URL(request.url).searchParams.get('orderTrackingId');
  if (!orderTrackingId || orderTrackingId.length > 100 || !/^[a-zA-Z0-9-]+$/.test(orderTrackingId)) {
    return jsonResponse({ error: 'Invalid payment reference.' }, 400, origin);
  }

  const result = await getTransactionStatus(env, orderTrackingId);
  return jsonResponse({ status: paymentState(result) }, 200, origin);
}

async function handleIpn(request, env) {
  const orderTrackingId = new URL(request.url).searchParams.get('OrderTrackingId');
  if (!orderTrackingId || orderTrackingId.length > 100 || !/^[a-zA-Z0-9-]+$/.test(orderTrackingId)) {
    return jsonResponse({ error: 'Invalid payment reference.' }, 400, null);
  }

  await getTransactionStatus(env, orderTrackingId);
  return jsonResponse({ received: true }, 200, null);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');

    if (request.method === 'OPTIONS' && origin === SITE_ORIGIN) {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': SITE_ORIGIN,
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400',
          Vary: 'Origin',
        },
      });
    }

    try {
      if (url.pathname === '/api/ipn' && request.method === 'GET') {
        return await handleIpn(request, env);
      }
      if (url.pathname === '/api/status' && request.method === 'GET') {
        return await handleStatus(request, env);
      }
      if (url.pathname === '/api/checkout' && request.method === 'POST') {
        if (origin !== SITE_ORIGIN) {
          return jsonResponse({ error: 'Request origin is not allowed.' }, 403, origin);
        }
        if (!request.headers.get('Content-Type')?.startsWith('application/json')) {
          return jsonResponse({ error: 'Expected a JSON checkout request.' }, 415, origin);
        }
        const contentLength = Number(request.headers.get('Content-Length') || 0);
        if (contentLength > 12000) {
          return jsonResponse({ error: 'Checkout request is too large.' }, 413, origin);
        }

        let body;
        try {
          body = await request.json();
        } catch {
          return jsonResponse({ error: 'Invalid checkout request.' }, 400, origin);
        }
        return await submitCheckout(request, env, body);
      }

      return jsonResponse({ error: 'Not found.' }, 404, origin);
    } catch (error) {
      console.error('Pesapal request failed.', error instanceof Error ? error.message : 'Unknown error');
      return jsonResponse(
        { error: 'Secure checkout is temporarily unavailable. Please try again or contact us on WhatsApp.' },
        502,
        origin,
      );
    }
  },
};
