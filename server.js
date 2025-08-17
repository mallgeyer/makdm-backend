const express = require('express');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const must = (name) => {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required env var: ${name}`);
  }
  return value;
};

const supabaseUrl = must('SUPABASE_URL');
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_ANON_KEY;
if (!supabaseUrl || !supabaseKey) {
  console.error('Missing Supabase config; server will keep running for log visibility.');
}
const supabase = (supabaseUrl && supabaseKey)
  ? createClient(supabaseUrl, supabaseKey)
  : null;

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.get('/', (req, res) => {
  res.json({ ok: true });
});

// ... keep the rest of your routes and logic below

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

// CORS allowlist (important for browser)
const allow = (process.env.ORIGIN_ALLOWLIST||'').split(',').map(s=>s.trim()).filter(Boolean);
app.use(cors({ origin: (o,cb)=> cb(null, !o || allow.includes(o)), credentials:false }));



// Square client
const square = new SquareClient({
  environment: process.env.SQUARE_ENV === 'production' ? Environment.Production : Environment.Sandbox,
  accessToken: process.env.SQUARE_ACCESS_TOKEN,
});

// PayPal endpoints use REST API
const PAYPAL_API = process.env.PAYPAL_ENV === 'production' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
const basicAuth = 'Basic ' + Buffer.from(process.env.PAYPAL_CLIENT_ID+':'+process.env.PAYPAL_CLIENT_SECRET).toString('base64');

// ---------- Health ----------
app.get('/', (req,res)=> res.json({ ok:true }));
app.get('/config', (req,res)=> {
  res.json({
    applicationId: process.env.SQUARE_APPLICATION_ID,
    locationId: process.env.SQUARE_LOCATION_ID,
  });
});

// ---------- Units ----------
app.get('/api/units', async (req,res)=>{
  const { data, error } = await supabase.from('units').select('*').order('number', { ascending:true });
  if(error) return res.status(400).json({ error: error.message });
  res.json(data);
});

app.post('/api/units', async (req,res)=>{
  const { number, size, rate_cents, type='standard', status='vacant', property_id } = req.body;
  const { data, error } = await supabase.from('units').insert([{ number, size, rate_cents, type, status, property_id }]).select('*').single();
  if(error) return res.status(400).json({ error: error.message });
  res.json(data);
});

app.patch('/api/units/:id', async (req,res)=>{
  const { id } = req.params; const patch = req.body;
  const { data, error } = await supabase.from('units').update(patch).eq('id', id).select('*').single();
  if(error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// ---------- Tenants ----------
app.post('/api/tenants', async (req,res)=>{
  const { data, error } = await supabase.from('tenants').insert([req.body]).select('*').single();
  if(error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// ---------- Leases ----------
app.post('/api/leases', async (req,res)=>{
  const { unit_id, tenant_id, start_date, rent_cents, deposit_cents=0 } = req.body;
  const { data, error } = await supabase.from('leases').insert([{ unit_id, tenant_id, start_date, rent_cents, deposit_cents, status:'active' }]).select('*').single();
  if(error) return res.status(400).json({ error: error.message });
  await supabase.from('units').update({ status:'occupied' }).eq('id', unit_id);
  res.json(data);
});

// ---------- Invoices (simple monthly) ----------
app.post('/api/invoices/run', async (req,res)=>{
  const { data: leases } = await supabase.from('leases').select('*').eq('status','active');
  const created = [];
  const today = new Date();
  for(const l of (leases||[])){
    const period_start = new Date(today.getFullYear(), today.getMonth(), 1);
    const period_end   = new Date(today.getFullYear(), today.getMonth()+1, 0);
    const due_date     = new Date(today.getFullYear(), today.getMonth(), 5);
    const inv = {
      lease_id: l.id,
      period_start: period_start.toISOString().slice(0,10),
      period_end:   period_end.toISOString().slice(0,10),
      due_date:     due_date.toISOString().slice(0,10),
      total_cents:  l.rent_cents,
      status: 'open'
    };
    const { data, error } = await supabase.from('invoices').insert([inv]).select('*').single();
    if(!error && data) created.push(data);
  }
  res.json({ created: created.length });
});

// ---------- Square card payments ----------
app.post('/pay/square', async (req,res)=>{
  try {
    const { sourceId, amount_cents, invoice_id='ad-hoc' } = req.body;
    const { paymentsApi } = square;
    const response = await paymentsApi.createPayment({
      idempotencyKey: uuid(),
      sourceId,
      locationId: process.env.SQUARE_LOCATION_ID,
      amountMoney: { amount: BigInt(amount_cents), currency: 'USD' },
      note: `invoice:${invoice_id}`,
      autocomplete: true,
    });
    await supabase.from('payments').insert([{ invoice_id, gateway: 'square', gateway_id: response.result.payment.id, amount_cents, method: 'card' }]);
    if(invoice_id !== 'ad-hoc') await supabase.from('invoices').update({ status:'paid' }).eq('id', invoice_id);
    res.json(response.result);
  } catch (e) {
    res.status(400).json({ error: e?.errors?.[0]?.detail || e.message });
  }
});

// ---------- PayPal (creates order & captures) ----------
app.get('/paypal/client', (req,res)=> res.json({ clientId: process.env.PAYPAL_CLIENT_ID, env: process.env.PAYPAL_ENV }));

app.post('/pay/paypal/create-order', async (req,res)=>{
  const { amount_cents=0, invoice_id='ad-hoc' } = req.body;
  const tok = await fetch(PAYPAL_API + '/v1/oauth2/token', { method:'POST', headers:{ 'Authorization': basicAuth, 'Content-Type':'application/x-www-form-urlencoded' }, body:'grant_type=client_credentials' }).then(r=>r.json());
  const order = await fetch(PAYPAL_API + '/v2/checkout/orders', {
    method:'POST', headers:{ 'Authorization': 'Bearer '+tok.access_token, 'Content-Type':'application/json' },
    body: JSON.stringify({ intent:'CAPTURE', purchase_units:[{ amount:{ currency_code:'USD', value: (amount_cents/100).toFixed(2) }, description:`invoice:${invoice_id}` }] })
  }).then(r=>r.json());
  res.json(order);
});

app.post('/pay/paypal/capture', async (req,res)=>{
  const { orderID, amount_cents=0, invoice_id='ad-hoc' } = req.body;
  const tok = await fetch(PAYPAL_API + '/v1/oauth2/token', { method:'POST', headers:{ 'Authorization': basicAuth, 'Content-Type':'application/x-www-form-urlencoded' }, body:'grant_type=client_credentials' }).then(r=>r.json());
  const cap = await fetch(`${PAYPAL_API}/v2/checkout/orders/${orderID}/capture`, { method:'POST', headers:{ 'Authorization': 'Bearer '+tok.access_token, 'Content-Type':'application/json' } }).then(r=>r.json());
  await supabase.from('payments').insert([{ invoice_id, gateway: 'paypal', gateway_id: cap?.id, amount_cents, method: 'paypal' }]);
  if(invoice_id !== 'ad-hoc') await supabase.from('invoices').update({ status:'paid' }).eq('id', invoice_id);
  res.json(cap);
});

// ---------- CSV export ----------
app.get('/api/exports/qbo', async (req, res) => {
  const { from, to } = req.query; // YYYY-MM-DD
  const { data, error } = await supabase
    .from('invoices')
    .select('id,total_cents,created_at,status')
    .gte('created_at', from)
    .lte('created_at', to);

  if (error) return res.status(400).json({ error: error.message });

  const rows = ['Date,Invoice,Amount,Status'];
  for (const i of (data || [])) {
    rows.push([
      new Date(i.created_at).toISOString().slice(0, 10),
      i.id,
      (i.total_cents / 100).toFixed(2),
      i.status
    ].join(','));
  }

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.send(rows.join('\n')); // <-- note '\n' (backslash-n), not a real line break
});
