# okham-catalog-worker

Cloudflare Worker that turns **R2 (artifacts)** + **KV (indexes)** into a stable, vendor-neutral distribution plane under:

- `https://okham.io/catalog/...`

## What it serves (MVP)

### Registries (KV)

- `GET /catalog/<kind>/registry.json`
  - KV key: `catalog/<kind>/registry.json`

### Versioned artifacts (R2)

- `GET /catalog/<kind>/<id>/<version>/<file>`
  - R2 key: `catalog/<kind>/<id>/<version>/<file>`
  - Cached as `immutable`

### Latest alias (KV -> redirect)

- `GET /catalog/<kind>/<id>/latest/<file>`
  - KV key: `catalog/<kind>/<id>/latest.json` with `{ "version": "x.y.z" }`
  - Responds with 302 redirect to the resolved versioned URL.

## Cloudflare resources

Create:

- R2 bucket: `okham-catalog`
- KV namespace: `okham-catalog-index`

Bind them in `wrangler.toml`.

## Deploy

```bash
npm i
npm run deploy
```

Then set a route to map it to your domain:

- `okham.io/catalog/*` -> this Worker

## Ingest (hook-based publishing)

Endpoint reserved:

- `POST /catalog/_ingest/github`

Currently disabled and not implemented (`INGEST_ENABLED=0`).

Next step is to implement:
- GitHub webhook signature verification (`X-Hub-Signature-256`)
- Download repo tarball for `Okham-io/okham-catalog`
- Extract `packages/**` and publish into R2
- Write KV registries + latest pointers

This keeps GitHub as the source-of-truth while making okham.io the authority for browsing/serving.
