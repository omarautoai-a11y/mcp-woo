# WooCommerce MCP Server

A simple Node.js server that bridges WooCommerce REST API with n8n and AI Agents.

## Endpoints

- `GET /health` — Health check (no auth)
- `GET /products` — Fetch products from WooCommerce
- `POST /orders` — Create an order in WooCommerce

All protected endpoints require the `x-api-key` header.

## Environment Variables

| Variable | Description |
|---|---|
| `PORT` | Server port (default: 3000) |
| `WC_URL` | Your WooCommerce store URL (e.g., https://example.com) |
| `WC_CONSUMER_KEY` | WooCommerce REST API consumer key |
| `WC_CONSUMER_SECRET` | WooCommerce REST API consumer secret |
| `INTERNAL_API_KEY` | A long random string to protect the API |

## Deploy on Coolify

1. New Application → connect this GitHub repo
2. Build Pack: Nixpacks
3. Port: 3000
4. Start command: `node server.js`
5. Add all environment variables from the table above
6. Deploy

