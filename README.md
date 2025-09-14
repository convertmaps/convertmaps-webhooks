# ConvertMaps Webhook Worker

Token-only, provider-agnostic webhook that normalizes purchase events and writes them to Supabase.

- One URL per node: `/webhook/{workspace_id}/{node_id}/{token}`
- No provider secrets; accepts Stripe/Paddle/Lemon/Shopify/custom JSON
- Idempotent inserts; itemized revenue with product mapping by node
- Hardened: JSON/content-type, size caps, per-IP and per-token rate limits, basic schema guards

## Quick Start

1) Install dependencies (Wrangler only is required to run):
```bash
npx wrangler --version
```

2) Set secrets (once):
```bash
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
```

3) Dev
```bash
npx wrangler dev
```

4) Deploy
```bash
npx wrangler deploy
```

5) Custom Domain / Route (Cloudflare Dashboard)
- Workers & Pages → cm-webhooks → Triggers → Custom Domains → add `hooks.convertmaps.io`
- Or add a Route: `hooks.convertmaps.io/webhook/*` → service `cm-webhooks`

## Test
Get the tokenized path from Supabase (one per node):
```sql
select public.ensure_node_webhook_path('<workspace_uuid>','<node_uuid>');
```
Then post a test payload:
```bash
curl -X POST "https://hooks.convertmaps.io<webhook_path>" \
  -H "Content-Type: application/json" \
  -d '{"provider":"custom","type":"purchase","provider_event_id":"order_123","currency":"USD","total_cents":9900,"items":[{"name":"Pro","quantity":1,"unit_amount_cents":9900}]}'
```

## Repo Structure
- `src/index.ts` Worker source
- `wrangler.toml` Worker config (route + vars)
- `.github/workflows/deploy.yml` optional CI to auto-deploy on push

## CI (GitHub Actions)
This repo includes an optional workflow in `.github/workflows/deploy.yml`.
- Add repo secrets in GitHub → Settings → Secrets and variables → Actions:
  - `CLOUDFLARE_API_TOKEN` (Workers Write)
  - `CLOUDFLARE_ACCOUNT_ID` (from `npx wrangler whoami`)
- Push to `main` to auto-deploy

## Notes
- Prices stored as integer cents. Format on display.
- Multiple items and order bumps supported. If no items provided, total may be attributed to the node's primary product.
- For durable rate limits across isolates, migrate the counters to KV/Durable Objects later.

## Troubleshooting
- 415 Content-Type error: set `Content-Type: application/json` and POST JSON
- 403 Invalid token: check URL token from `ensure_node_webhook_path`
- 429 Too many requests: per-IP / per-token rate limit triggered
- See Cloudflare logs and Supabase error messages for details
