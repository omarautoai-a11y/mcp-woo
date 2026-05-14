require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z } = require('zod');
const crypto = require('crypto');

// ========================================
// Config & Validation
// ========================================
const PORT = process.env.PORT || 3000;
const WC_URL = process.env.WC_URL;
const WC_KEY = process.env.WC_CONSUMER_KEY;
const WC_SECRET = process.env.WC_CONSUMER_SECRET;
const WP_USER = process.env.WP_USER;
const WP_APP_PASSWORD = process.env.WP_APP_PASSWORD;
const API_KEY = process.env.INTERNAL_API_KEY;

const required = { WC_URL, WC_KEY, WC_SECRET, WP_USER, WP_APP_PASSWORD, API_KEY };
for (const [name, value] of Object.entries(required)) {
  if (!value) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
}

// Auth headers
const wcAuth = 'Basic ' + Buffer.from(`${WC_KEY}:${WC_SECRET}`).toString('base64');
const wpAuth = 'Basic ' + Buffer.from(`${WP_USER}:${WP_APP_PASSWORD.replace(/\s/g, '')}`).toString('base64');
const baseUrl = WC_URL.replace(/\/$/, '');

// ========================================
// API Helpers
// ========================================
async function wcRequest(path, options = {}) {
  const url = `${baseUrl}/wp-json/wc/v3${path}`;
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
    throw new Error(`WooCommerce API error (${res.status}): ${typeof data === 'object' ? data.message || JSON.stringify(data) : data}`);
  }
  return data;
}

async function wpRequest(path, options = {}) {
  const url = `${baseUrl}/wp-json/wp/v2${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'Authorization': wpAuth,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) {
    throw new Error(`WordPress API error (${res.status}): ${typeof data === 'object' ? data.message || JSON.stringify(data) : data}`);
  }
  return data;
}

// Format response for MCP
const ok = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
const err = (e) => ({ content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true });

// ========================================
// MCP Server Setup
// ========================================
function createMcpServer() {
  const server = new McpServer({
    name: 'woocommerce-mcp-server',
    version: '2.0.0'
  });

  // ============ PRODUCTS ============
  server.tool(
    'list_products',
    'List products from WooCommerce store. Supports pagination and filtering.',
    {
      per_page: z.number().optional().describe('Number of products per page (default 10, max 100)'),
      page: z.number().optional().describe('Page number'),
      status: z.enum(['any', 'draft', 'pending', 'private', 'publish']).optional().describe('Product status'),
      category: z.string().optional().describe('Category ID to filter by')
    },
    async ({ per_page = 10, page = 1, status, category }) => {
      try {
        const params = new URLSearchParams({ per_page: String(per_page), page: String(page) });
        if (status) params.set('status', status);
        if (category) params.set('category', category);
        const data = await wcRequest(`/products?${params}`);
        return ok({ count: data.length, products: data.map(p => ({
          id: p.id, name: p.name, slug: p.slug, status: p.status,
          price: p.price, regular_price: p.regular_price, stock_status: p.stock_status,
          permalink: p.permalink, categories: p.categories?.map(c => c.name)
        })) });
      } catch (e) { return err(e); }
    }
  );

  server.tool(
    'search_products',
    'Search products by name or description (supports Arabic).',
    {
      query: z.string().describe('Search query'),
      per_page: z.number().optional().describe('Results per page (default 10)')
    },
    async ({ query, per_page = 10 }) => {
      try {
        const params = new URLSearchParams({ search: query, per_page: String(per_page) });
        const data = await wcRequest(`/products?${params}`);
        return ok({ count: data.length, query, products: data.map(p => ({
          id: p.id, name: p.name, price: p.price, permalink: p.permalink
        })) });
      } catch (e) { return err(e); }
    }
  );

  server.tool(
    'get_product',
    'Get full details of a specific product by ID.',
    { id: z.number().describe('Product ID') },
    async ({ id }) => {
      try { return ok(await wcRequest(`/products/${id}`)); }
      catch (e) { return err(e); }
    }
  );

  server.tool(
    'create_product',
    'Create a new product in WooCommerce.',
    {
      name: z.string().describe('Product name'),
      description: z.string().optional().describe('Full product description (HTML allowed)'),
      short_description: z.string().optional().describe('Short description'),
      regular_price: z.string().optional().describe('Regular price as string e.g. "100"'),
      sale_price: z.string().optional().describe('Sale price as string'),
      sku: z.string().optional().describe('Stock Keeping Unit'),
      stock_quantity: z.number().optional().describe('Stock quantity'),
      manage_stock: z.boolean().optional().describe('Enable stock management'),
      categories: z.array(z.number()).optional().describe('Array of category IDs'),
      images: z.array(z.string()).optional().describe('Array of image URLs'),
      status: z.enum(['draft', 'pending', 'private', 'publish']).optional().describe('Default: draft')
    },
    async (input) => {
      try {
        const body = { ...input, status: input.status || 'draft' };
        if (input.categories) body.categories = input.categories.map(id => ({ id }));
        if (input.images) body.images = input.images.map(src => ({ src }));
        const data = await wcRequest('/products', { method: 'POST', body: JSON.stringify(body) });
        return ok({ id: data.id, name: data.name, permalink: data.permalink, status: data.status });
      } catch (e) { return err(e); }
    }
  );

  server.tool(
    'update_product',
    'Update an existing product. Pass only the fields you want to change.',
    {
      id: z.number().describe('Product ID'),
      name: z.string().optional(),
      description: z.string().optional(),
      regular_price: z.string().optional(),
      sale_price: z.string().optional(),
      stock_quantity: z.number().optional(),
      status: z.enum(['draft', 'pending', 'private', 'publish']).optional()
    },
    async ({ id, ...updates }) => {
      try {
        const data = await wcRequest(`/products/${id}`, { method: 'PUT', body: JSON.stringify(updates) });
        return ok({ id: data.id, name: data.name, status: data.status, updated: true });
      } catch (e) { return err(e); }
    }
  );

  // ============ ORDERS ============
  server.tool(
    'list_orders',
    'List orders from WooCommerce.',
    {
      per_page: z.number().optional().describe('Orders per page (default 10)'),
      status: z.enum(['any', 'pending', 'processing', 'on-hold', 'completed', 'cancelled', 'refunded', 'failed']).optional()
    },
    async ({ per_page = 10, status }) => {
      try {
        const params = new URLSearchParams({ per_page: String(per_page) });
        if (status) params.set('status', status);
        const data = await wcRequest(`/orders?${params}`);
        return ok({ count: data.length, orders: data.map(o => ({
          id: o.id, status: o.status, total: o.total, currency: o.currency,
          customer: `${o.billing?.first_name} ${o.billing?.last_name}`,
          phone: o.billing?.phone, date: o.date_created,
          items_count: o.line_items?.length
        })) });
      } catch (e) { return err(e); }
    }
  );

  server.tool(
    'get_order',
    'Get full details of a specific order.',
    { id: z.number().describe('Order ID') },
    async ({ id }) => {
      try { return ok(await wcRequest(`/orders/${id}`)); }
      catch (e) { return err(e); }
    }
  );

  server.tool(
    'update_order_status',
    'Update order status.',
    {
      id: z.number().describe('Order ID'),
      status: z.enum(['pending', 'processing', 'on-hold', 'completed', 'cancelled', 'refunded', 'failed']).describe('New status')
    },
    async ({ id, status }) => {
      try {
        const data = await wcRequest(`/orders/${id}`, { method: 'PUT', body: JSON.stringify({ status }) });
        return ok({ id: data.id, status: data.status, updated: true });
      } catch (e) { return err(e); }
    }
  );

  // ============ POSTS (Blog Articles) ============
  server.tool(
    'list_posts',
    'List blog posts from WordPress.',
    {
      per_page: z.number().optional(),
      status: z.enum(['publish', 'draft', 'pending', 'private', 'any']).optional(),
      search: z.string().optional().describe('Search keyword')
    },
    async ({ per_page = 10, status, search }) => {
      try {
        const params = new URLSearchParams({ per_page: String(per_page) });
        if (status) params.set('status', status);
        if (search) params.set('search', search);
        const data = await wpRequest(`/posts?${params}`);
        return ok({ count: data.length, posts: data.map(p => ({
          id: p.id, title: p.title?.rendered, slug: p.slug, status: p.status,
          link: p.link, date: p.date
        })) });
      } catch (e) { return err(e); }
    }
  );

  server.tool(
    'get_post',
    'Get full content of a specific post.',
    { id: z.number().describe('Post ID') },
    async ({ id }) => {
      try { return ok(await wpRequest(`/posts/${id}`)); }
      catch (e) { return err(e); }
    }
  );

  server.tool(
    'create_post',
    'Create a new blog post. Content can be HTML. Supports Arabic.',
    {
      title: z.string().describe('Post title'),
      content: z.string().describe('Post content (HTML allowed)'),
      excerpt: z.string().optional().describe('Short excerpt'),
      status: z.enum(['publish', 'draft', 'pending', 'private']).optional().describe('Default: draft'),
      categories: z.array(z.number()).optional().describe('Array of category IDs'),
      tags: z.array(z.number()).optional().describe('Array of tag IDs'),
      featured_media: z.number().optional().describe('Featured image media ID'),
      slug: z.string().optional().describe('URL slug')
    },
    async (input) => {
      try {
        const body = { ...input, status: input.status || 'draft' };
        const data = await wpRequest('/posts', { method: 'POST', body: JSON.stringify(body) });
        return ok({ id: data.id, title: data.title?.rendered, link: data.link, status: data.status });
      } catch (e) { return err(e); }
    }
  );

  server.tool(
    'update_post',
    'Update an existing post.',
    {
      id: z.number().describe('Post ID'),
      title: z.string().optional(),
      content: z.string().optional(),
      excerpt: z.string().optional(),
      status: z.enum(['publish', 'draft', 'pending', 'private']).optional()
    },
    async ({ id, ...updates }) => {
      try {
        const data = await wpRequest(`/posts/${id}`, { method: 'PUT', body: JSON.stringify(updates) });
        return ok({ id: data.id, title: data.title?.rendered, status: data.status, updated: true });
      } catch (e) { return err(e); }
    }
  );

  // ============ PAGES ============
  server.tool(
    'list_pages',
    'List WordPress pages.',
    { per_page: z.number().optional() },
    async ({ per_page = 20 }) => {
      try {
        const data = await wpRequest(`/pages?per_page=${per_page}`);
        return ok({ count: data.length, pages: data.map(p => ({
          id: p.id, title: p.title?.rendered, slug: p.slug, link: p.link, status: p.status
        })) });
      } catch (e) { return err(e); }
    }
  );

  server.tool(
    'create_page',
    'Create a new WordPress page (e.g. Contact, About).',
    {
      title: z.string().describe('Page title'),
      content: z.string().describe('Page content (HTML allowed)'),
      status: z.enum(['publish', 'draft', 'pending', 'private']).optional(),
      slug: z.string().optional()
    },
    async (input) => {
      try {
        const body = { ...input, status: input.status || 'draft' };
        const data = await wpRequest('/pages', { method: 'POST', body: JSON.stringify(body) });
        return ok({ id: data.id, title: data.title?.rendered, link: data.link, status: data.status });
      } catch (e) { return err(e); }
    }
  );

  // ============ MEDIA ============
  server.tool(
    'upload_media',
    'Upload an image to WordPress media library from a URL.',
    {
      url: z.string().describe('Public URL of the image to upload'),
      title: z.string().optional().describe('Title for the media item'),
      alt_text: z.string().optional().describe('Alt text for accessibility')
    },
    async ({ url, title, alt_text }) => {
      try {
        // Download the image
        const imgRes = await fetch(url);
        if (!imgRes.ok) throw new Error(`Could not download image from ${url}`);
        const buffer = Buffer.from(await imgRes.arrayBuffer());
        const filename = url.split('/').pop().split('?')[0] || 'upload.jpg';
        const contentType = imgRes.headers.get('content-type') || 'image/jpeg';

        // Upload to WordPress
        const uploadRes = await fetch(`${baseUrl}/wp-json/wp/v2/media`, {
          method: 'POST',
          headers: {
            'Authorization': wpAuth,
            'Content-Type': contentType,
            'Content-Disposition': `attachment; filename="${filename}"`
          },
          body: buffer
        });
        const data = await uploadRes.json();
        if (!uploadRes.ok) throw new Error(data.message || 'Upload failed');

        // Update title/alt if provided
        if (title || alt_text) {
          await wpRequest(`/media/${data.id}`, {
            method: 'POST',
            body: JSON.stringify({ title, alt_text })
          });
        }
        return ok({ id: data.id, source_url: data.source_url, link: data.link });
      } catch (e) { return err(e); }
    }
  );

  // ============ CATEGORIES ============
  server.tool(
    'list_categories',
    'List product or post categories.',
    {
      type: z.enum(['products', 'posts']).describe('Type: "products" for WooCommerce, "posts" for blog'),
      per_page: z.number().optional()
    },
    async ({ type, per_page = 50 }) => {
      try {
        const data = type === 'products'
          ? await wcRequest(`/products/categories?per_page=${per_page}`)
          : await wpRequest(`/categories?per_page=${per_page}`);
        return ok({ count: data.length, categories: data.map(c => ({
          id: c.id, name: c.name, slug: c.slug, count: c.count
        })) });
      } catch (e) { return err(e); }
    }
  );

  return server;
}

// ========================================
// Express App
// ========================================
const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Auth middleware
function authenticate(req, res, next) {
  const key = req.header('x-api-key') || req.query.api_key;
  if (!key || key !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized: invalid or missing API key' });
  }
  next();
}

// Health check (no auth)
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'woocommerce-mcp-server',
    version: '2.0.0',
    timestamp: new Date().toISOString()
  });
});

// ========================================
// MCP Endpoint (Streamable HTTP transport)
// ========================================
// Store transports by session ID
const transports = {};

app.post('/mcp', authenticate, async (req, res) => {
  try {
    const sessionId = req.headers['mcp-session-id'];
    let transport;

    if (sessionId && transports[sessionId]) {
      transport = transports[sessionId];
    } else if (!sessionId && req.body?.method === 'initialize') {
      // New session
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: (sid) => {
          transports[sid] = transport;
          console.log(`MCP session initialized: ${sid}`);
        }
      });
      transport.onclose = () => {
        if (transport.sessionId) {
          delete transports[transport.sessionId];
          console.log(`MCP session closed: ${transport.sessionId}`);
        }
      };
      const mcpServer = createMcpServer();
      await mcpServer.connect(transport);
    } else {
      return res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Bad Request: invalid or missing session ID' },
        id: null
      });
    }

    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error('MCP error:', error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null
      });
    }
  }
});

// SSE notifications (server-to-client)
app.get('/mcp', authenticate, async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  if (!sessionId || !transports[sessionId]) {
    return res.status(400).send('Invalid or missing session ID');
  }
  await transports[sessionId].handleRequest(req, res);
});

// Session termination
app.delete('/mcp', authenticate, async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  if (!sessionId || !transports[sessionId]) {
    return res.status(400).send('Invalid or missing session ID');
  }
  await transports[sessionId].handleRequest(req, res);
});

// ========================================
// Start server
// ========================================
app.listen(PORT, '0.0.0.0', () => {
  console.log(`MCP Server v2.0 running on port ${PORT}`);
  console.log(`Health: http://localhost:${PORT}/health`);
  console.log(`MCP Endpoint: http://localhost:${PORT}/mcp`);
});
