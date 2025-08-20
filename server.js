// --- Imports & setup ---
const express = require('express');
const cors = require('cors');
const { v4: uuid } = require('uuid');
const { createClient } = require('@supabase/supabase-js');
const { Client: SquareClient } = require('square');
require('dotenv').config();

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


// CORS allowlist (both www and non-www by default)
const rawAllow = process.env.ORIGIN_ALLOWLIST || 'https://makdmrentals.com,https://www.makdmrentals.com';
const allow = rawAllow.split(',').map(s => s.trim()).filter(Boolean);
const corsOptions = {
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);                 // curl/health checks
    return cb(null, allow.includes(origin));
  },
  methods: ['GET','POST','PATCH','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
  credentials: false,
  maxAge: 600
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
  if (!supabase) return res.status(500).json({ error: 'Supabase not configured' });
  const {
    unit_id, tenant_id, start_date, rent_cents,
    deposit_cents = 0, autopay = true, square_card_id = null
  } = req.body || {};

  const { data, error } = await supabase
    .from('leases')
    .insert([{ unit_id, tenant_id, start_date, rent_cents, deposit_cents, status: 'active', autopay, square_card_id }])
    .select('*').single();

  if (error) return res.status(400).json({ error: error.message });

  // keep the unit status in sync
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

// --- Start server ---
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
