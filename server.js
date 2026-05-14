require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const app = express();

// ---------- Config ----------
const PORT = process.env.PORT || 3000;
const WC_URL = process.env.WC_URL;
const WC_KEY = process.env.WC_CONSUMER_KEY;
const WC_SECRET = process.env.WC_CONSUMER_SECRET;
const API_KEY = process.env.INTERNAL_API_KEY;

// Validate required env vars on boot — fail fast
const required = { WC_URL, WC_KEY, WC_SECRET, API_KEY };
for (const [name, value] of Object.entries(required)) {
  if (!value) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
}

// WooCommerce Basic Auth header (HTTPS only)
const wcAuth = 'Basic ' + Buffer.from(`${WC_KEY}:${WC_SECRET}`).toString('base64');

// ---------- Middleware ----------
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Rate limiting: 60 requests / minute per IP
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' }
});
app.use(limiter);

// Internal API Key auth middleware
function authenticate(req, res, next) {
  const key = req.header('x-api-key');
  if (!key || key !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized: invalid or missing x-api-key' });
  }
  next();
}

// Helper to call WooCommerce API
async function wcRequest(path, options = {}) {
  const url = `${WC_URL.replace(/\/$/, '')}/wp-json/wc/v3${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'Authorization': wcAuth,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });

  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }

  if (!res.ok) {
    const err = new Error(typeof data === 'object' ? (data.message || 'WooCommerce error') : 'WooCommerce error');
    err.status = res.status;
    err.details = data;
    throw err;
  }
  return data;
}

// ---------- Routes ----------

// Health check (no auth) — useful for Coolify
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// GET /products — fetch products from WooCommerce
app.get('/products', authenticate, async (req, res, next) => {
  try {
    const params = new URLSearchParams(req.query).toString();
    const data = await wcRequest(`/products${params ? '?' + params : ''}`);
    res.json({ success: true, count: Array.isArray(data) ? data.length : 0, data });
  } catch (err) {
    next(err);
  }
});

// POST /orders — create an order in WooCommerce
app.post('/orders', authenticate, async (req, res, next) => {
  try {
    if (!req.body || Object.keys(req.body).length === 0) {
      return res.status(400).json({ error: 'Request body is required' });
    }
    const data = await wcRequest('/orders', {
      method: 'POST',
      body: JSON.stringify(req.body)
    });
    res.status(201).json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

// 404 handler
app.use((_req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// Centralized error handler
app.use((err, _req, res, _next) => {
  console.error('Error:', err.message, err.details || '');
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error',
    details: err.details || null
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`MCP Server running on port ${PORT}`);
});
