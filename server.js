// --- Imports & setup ---
const express = require('express');
const cors = require('cors');
const { v4: uuid } = require('uuid');
const { createClient } = require('@supabase/supabase-js');
const { Client: SquareClient } = require('square');
require('dotenv').config();

// Compute proration in cents based on start date to end of month
function prorateCents(startDateISO, monthlyCents) {
  const start = new Date(startDateISO + 'T00:00:00');
  // localize to America/Menominee if needed; for simplicity we use UTC-midnight
  const y = start.getUTCFullYear(), m = start.getUTCMonth();
  const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const startDay = start.getUTCDate(); // 1..31
  if (startDay <= 1) return Number(monthlyCents); // full month if starting on 1st
  const remainingDays = (daysInMonth - startDay + 1); // include start day
  const prorated = Math.round((Number(monthlyCents) * remainingDays) / daysInMonth);
  return prorated;
}

// Compute the next billing date (the next 1st)
function nextFirst(startDateISO) {
  const d = new Date(startDateISO + 'T00:00:00Z');
  const y = d.getUTCFullYear(), m = d.getUTCMonth(), day = d.getUTCDate();
  if (day === 1) {
    // charged full today; next is the 1st of next month
    return new Date(Date.UTC(y, m + 1, 1)).toISOString().slice(0,10);
  }
  // Started mid-month; we charged pro-rate now; next is the 1st of next month
  return new Date(Date.UTC(y, m + 1, 1)).toISOString().slice(0,10);
}

// --- Helpers ---
const must = (name) => {
  const v = process.env[name];
  if (!v) console.error(`[env] Missing ${name}`);
  return v;
};

// --- Supabase ---
const SUPABASE_URL = must('SUPABASE_URL');
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_ANON_KEY;
const supabase = (SUPABASE_URL && SUPABASE_KEY) ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;

// --- Square ---
const square = process.env.SQUARE_ACCESS_TOKEN
  ? new SquareClient({
      accessToken: process.env.SQUARE_ACCESS_TOKEN,
      environment: (process.env.SQUARE_ENV === 'production') ? 'production' : 'sandbox'
    })
  : null;

// --- App & middleware ---
const app = express();
const PORT = process.env.PORT || 10000;

// JSON first
app.use(express.json());

// Safely JSON-encode any BigInt values (prevents "Do not know how to serialize a BigInt")
const safeJson = (obj) =>
  JSON.parse(JSON.stringify(obj, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));






// allow both www and non-www + any subdomain of makdmrentals.com
const allow = (process.env.ORIGIN_ALLOWLIST || 'https://makdmrentals.com,https://www.makdmrentals.com')
  .split(',').map(s => s.trim()).filter(Boolean);

const corsOptions = {
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);            // curl/health checks
    try {
      const u = new URL(origin);
      if (allow.includes(origin)) return cb(null, true);
      if (u.hostname.endsWith('makdmrentals.com')) return cb(null, true);
    } catch (_) {}
    cb(null, false);
  },
  methods: ['GET','POST','PATCH','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
  credentials: false,
  maxAge: 600,
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));


// (Optional) tiny request log to Render logs
app.use((req,res,next)=>{ console.log(req.method, req.path, 'Origin:', req.headers.origin||'-'); next(); });

// --- Health & config ---
app.get('/', (req, res) => {
  res.json({
    ok: true,
    supabase: !!supabase,
    square: !!square,
    allowlist: allow
  });
});

app.get('/config', (req, res) => {
  res.json({
    applicationId: process.env.SQUARE_APPLICATION_ID || null,
    locationId: process.env.SQUARE_LOCATION_ID || null
  });
});

// reuse the same logic via GET to simplify testing from a browser



// ---------- Units ----------
app.get('/api/units', async (req, res) => {
  if (!supabase) return res.status(500).json({ error: 'Supabase not configured' });
  const { data, error } = await supabase.from('units').select('*').order('number', { ascending: true });
  if (error) return res.status(400).json({ error: error.message });
  res.json(data || []);
});

app.post('/api/units', async (req, res) => {
  if (!supabase) return res.status(500).json({ error: 'Supabase not configured' });
  const { number, size, rate_cents, type='standard', status='vacant', property_id=null, notes=null } = req.body || {};
  if (!number || !size || typeof rate_cents !== 'number') {
    return res.status(400).json({ error: 'number, size, rate_cents are required' });
  }
  const { data, error } = await supabase
    .from('units')
    .insert([{ number, size, rate_cents, type, status, property_id, notes }])
    .select('*').single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

app.patch('/api/units/:id', async (req, res) => {
  if (!supabase) return res.status(500).json({ error: 'Supabase not configured' });
  const { id } = req.params;
  const { data, error } = await supabase.from('units').update(req.body || {}).eq('id', id).select('*').single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// ---------- Tenants ----------
app.get('/api/tenants', async (req, res) => {
  if (!supabase) return res.status(500).json({ error: 'Supabase not configured' });
  const { data, error } = await supabase.from('tenants').select('*').order('created_at', { ascending: false });
  if (error) return res.status(400).json({ error: error.message });
  res.json(data || []);
});

app.post('/api/tenants', async (req, res) => {
  if (!supabase) return res.status(500).json({ error: 'Supabase not configured' });
  const { name, email, phone, square_customer_id = null } = req.body || {};
  const { data, error } = await supabase
    .from('tenants')
    .insert([{ name, email, phone, square_customer_id }])
    .select('*').single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

app.patch('/api/tenants/:id', async (req, res) => {
  if (!supabase) return res.status(500).json({ error: 'Supabase not configured' });
  const { id } = req.params;
  const { data, error } = await supabase.from('tenants').update(req.body || {}).eq('id', id).select('*').single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// ---------- Leases ----------
app.get('/api/leases', async (req, res) => {
  if (!supabase) return res.status(500).json({ error: 'Supabase not configured' });
  const { data, error } = await supabase.from('leases').select('*').order('created_at', { ascending: false });
  if (error) return res.status(400).json({ error: error.message });
  res.json(data || []);
});

app.post('/api/leases', async (req, res) => {
  if (!supabase) return res.status(500).json({ error: 'Supabase not configured on server' });
  const {
    unit_id, tenant_id, start_date, rent_cents,
    deposit_cents = 0, autopay = true, square_card_id = null,
    first_charge_cents = null, // <-- from portal after successful charge
    next_due_date = nextFirst(start_date) // safe default
  } = req.body || {};

  const { data, error } = await supabase
    .from('leases')
    .insert([{
      unit_id, tenant_id, start_date, rent_cents, deposit_cents,
      status: 'active', autopay, square_card_id,
      billing_anchor_day: 1,
      next_due_date,
      first_charge_cents
    }])
    .select('*').single();

  if (error) return res.status(400).json({ error: error.message });

  await supabase.from('units').update({ status: 'occupied' }).eq('id', unit_id).throwOnError();

  res.json(data);
});

app.patch('/api/leases/:id', async (req, res) => {
  if (!supabase) return res.status(500).json({ error: 'Supabase not configured' });
  const { id } = req.params;
  const { data, error } = await supabase.from('leases').update(req.body || {}).eq('id', id).select('*').single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// Preview proration/full amount for a unit and start_date
app.get('/api/leases/preview', async (req, res) => {
  if (!supabase) return res.status(500).json({ error: 'Supabase not configured on server' });
  const { unit_id, start_date } = req.query;
  if (!unit_id || !start_date) return res.status(400).json({ error: 'unit_id and start_date are required' });

  const { data: unit, error } = await supabase.from('units').select('rate_cents').eq('id', unit_id).single();
  if (error || !unit) return res.status(404).json({ error: 'Unit not found' });

  const amount_cents = prorateCents(start_date, unit.rate_cents);
  const next_due_date = nextFirst(start_date);

  res.json({ amount_cents, next_due_date, monthly_cents: unit.rate_cents, billing_anchor_day: 1 });
});

// ---------- Square helper routes ----------
app.post('/square/customer', async (req, res) => {
  if (!square) return res.status(503).json({ error: 'Square not configured' });
  try {
    const { name = '', email = '', phone = '' } = req.body || {};
    const out = await square.customersApi.createCustomer({
      givenName: name || undefined,
      emailAddress: email || undefined,
      phoneNumber: phone || undefined
    });
    res.json({ customer_id: out.result.customer.id });
  } catch (e) {
    res.status(400).json({ error: e?.errors?.[0]?.detail || e.message });
  }
});

app.post('/square/save-card', async (req, res) => {
  if (!square) return res.status(503).json({ error: 'Square not configured' });
  try {
    const { customer_id, sourceId } = req.body || {};
    if (!customer_id || !sourceId) return res.status(400).json({ error: 'customer_id and sourceId are required' });
    const out = await square.cardsApi.createCard({
      idempotencyKey: uuid(),
      sourceId,
      card: { customerId: customer_id }
    });
    const c = out.result.card;
    res.json({ card_id: c?.id, last4: c?.last4, brand: c?.cardBrand });
  } catch (e) {
    res.status(400).json({ error: e?.errors?.[0]?.detail || e.message });
  }
});

app.post('/pay/square', async (req, res) => {
  if (!square) return res.status(503).json({ error: 'Square not configured' });
  try {
    const { sourceId, customerCardId, customerId, amount_cents, invoice_id = 'ad-hoc' } = req.body || {};
    if (typeof amount_cents !== 'number') return res.status(400).json({ error: 'amount_cents must be a number (cents)' });

    const payload = {
      idempotencyKey: uuid(),
      amountMoney: { amount: Number(amount_cents), currency: 'USD' }, // <-- Number, not BigInt
      locationId: process.env.SQUARE_LOCATION_ID || undefined,
      note: `invoice:${invoice_id}`,
      autocomplete: true
    };

    // Map saved card id to sourceId; include customerId if you have it
    if (customerCardId) {
      payload.sourceId = customerCardId;
      if (customerId) payload.customerId = customerId;
    } else if (sourceId) {
      payload.sourceId = sourceId;
    } else {
      return res.status(400).json({ error: 'sourceId or customerCardId is required' });
    }

    const out = await square.paymentsApi.createPayment(payload);

    // Always serialize safely (in case SDK returns a bigint somewhere)
    res.json(safeJson(out.result));
  } catch (e) {
    // Also serialize errors safely
    res.status(400).json(safeJson({ error: e?.errors?.[0]?.detail || e.message }));
  }
});

// Utility: add months while keeping day where possible

// --- Payments API ---
// List payments (recent first). Optional ?limit=100
app.get('/api/payments', async (req, res) => {
  if (!supabase) return res.status(500).json({ error: 'Supabase not configured' });
  const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 100));
  const { data, error } = await supabase
    .from('payments')
    .select('id, lease_id, amount_cents, paid_at, status, square_payment_id, note')
    .order('paid_at', { ascending: false })
    .limit(limit);
  if (error) return res.status(400).json({ error: error.message });
  res.json(data || []);
});

// QuickBooks-friendly CSV export of last N payments
app.get('/api/export/payments.csv', async (req, res) => {
  if (!supabase) return res.status(500).json({ error: 'Supabase not configured' });
  const limit = Math.max(1, Math.min(2000, Number(req.query.limit) || 1000));
  const { data, error } = await supabase
    .from('payments')
    .select('paid_at, amount_cents, status, square_payment_id, lease_id, note')
    .order('paid_at', { ascending: false })
    .limit(limit);
  if (error) return res.status(400).json({ error: error.message });

  // CSV headers: Date,Customer,Memo,Amount,Reference
  // (We’ll put lease_id as Customer for now; later we can join tenant name)
  const rows = [
    ['Date','Customer','Memo','Amount','Reference'],
    ... (data || []).map(p => [
      new Date(p.paid_at).toISOString().slice(0,10),
      p.lease_id,
      p.note || p.status,
      (Number(p.amount_cents) / 100).toFixed(2),
      p.square_payment_id || ''
    ])
  ];
  const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\r\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="payments-export.csv"');
  res.send(csv);
});

// Optional: simple refund route (Square capture)
// NOTE: In Square sandbox this creates a refund object; in prod, set permissions carefully.
app.post('/api/payments/refund', async (req, res) => {
  try {
    if (!square) return res.status(503).json({ error: 'Square not configured' });
    const { payment_id, amount_cents } = req.body || {};
    if (!payment_id || !amount_cents) return res.status(400).json({ error: 'payment_id and amount_cents required' });
    const out = await square.refundsApi.refundPayment({
      idempotencyKey: uuid(),
      paymentId: payment_id,
      amountMoney: { amount: Number(amount_cents), currency: 'USD' }
    });
    res.json(out.result);
  } catch (e) {
    res.status(400).json({ error: e?.errors?.[0]?.detail || e.message });
  }
});

app.get('/admin/test-email', async (req, res) => {
  try {
    const to = req.query.to || 'mallgeyer@gmail.com';
    await sendEmail(to, 'Test email – MAKDM Rentals', '<p>This is a test.</p>');
    res.json({ ok: true, to });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

// ---------- AUTOPAY (shared) ----------
function nextMonthFirst(iso) {
  const d = new Date((iso || new Date().toISOString().slice(0,10)) + 'T00:00:00Z');
  const y = d.getUTCFullYear(), m = d.getUTCMonth();
  return new Date(Date.UTC(y, m + 1, 1)).toISOString().slice(0,10);
}

async function runAutopayForDate(runDate) {
  if (!supabase || !square) {
    return { error: 'Backend not fully configured' };
  }
  const today = runDate || new Date().toISOString().slice(0,10);

  // 1) Fetch due leases
  const { data: leases, error: fetchErr } = await supabase
    .from('leases')
    .select('id, tenant_id, unit_id, rent_cents, square_card_id, next_due_date, autopay')
    .eq('autopay', true)
    .eq('next_due_date', today)
    .not('square_card_id', 'is', null);

  if (fetchErr) return { error: fetchErr.message };

  const results = [];
  for (const L of (leases || [])) {
    try {
      // Lookup tenant for customerId (optional)
      const { data: tenant } = await supabase
        .from('tenants')
        .select('square_customer_id')
        .eq('id', L.tenant_id)
        .single();

      // Charge saved card (card_id acts as sourceId)
      const payload = {
        idempotencyKey: uuid(),
        amountMoney: { amount: Number(L.rent_cents), currency: 'USD' },
        sourceId: L.square_card_id,
        customerId: tenant?.square_customer_id || undefined,
        locationId: process.env.SQUARE_LOCATION_ID || undefined,
        note: `autopay:${L.id} ${today}`,
        autocomplete: true
      };

      const pay = await square.paymentsApi.createPayment(payload);

      // Record payment
      const { error: payInsErr } = await supabase.from('payments').insert([{
        lease_id: L.id,
        amount_cents: L.rent_cents,
        square_payment_id: pay.result.payment?.id || null,
        status: 'paid',
        note: `autopay ${today}`
      }]);
      if (payInsErr) console.error('payments insert failed', payInsErr);

      // Advance to 1st of next month
      const next = nextMonthFirst(L.next_due_date || today);
      const { error: leaseUpdErr } = await supabase
        .from('leases')
        .update({ next_due_date: next })
        .eq('id', L.id);
      if (leaseUpdErr) console.error('lease update failed', leaseUpdErr);

      results.push({ lease_id: L.id, ok: true, payment_id: pay.result.payment?.id, next_due_date: next });
    } catch (e) {
      const msg = e?.errors?.[0]?.detail || e.message || String(e);
      results.push({ lease_id: L.id, ok: false, error: msg });

      // Best-effort failure record
      const { error: failInsErr } = await supabase.from('payments').insert([{
        lease_id: L.id,
        amount_cents: L.rent_cents,
        status: 'failed',
        note: msg
      }]);
      if (failInsErr) console.error('payments insert (failed) error', failInsErr);
    }
  }

  return { date: today, count: results.length, results };
}

// POST runner (for cron)
app.post('/api/autopay/run', async (req, res) => {
  const today = (req.query?.date || new Date().toISOString().slice(0,10));
  const out = await runAutopayForDate(today);
  if (out.error) return res.status(400).json(out);
  res.json(out);
});

// GET runner (easy browser test)
app.get('/api/autopay/run-test', async (req, res) => {
  const today = (req.query?.date || new Date().toISOString().slice(0,10));
  const out = await runAutopayForDate(today);
  if (out.error) return res.status(400).json(out);
  res.json(out);
});



// --- Start server ---
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
