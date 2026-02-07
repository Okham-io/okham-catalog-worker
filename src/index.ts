export interface Env {
  CATALOG_BUCKET: R2Bucket;
  CATALOG_INDEX: KVNamespace;
  OKHAM_CATALOG_WORKER: string;
  INGEST_ENABLED: string;
}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Hub-Signature-256",
};

function json(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data, null, 2) + "\n", {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...CORS_HEADERS,
      ...(init?.headers ?? {}),
    },
  });
}

function text(data: string, init?: ResponseInit): Response {
  return new Response(data, {
    ...init,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      ...CORS_HEADERS,
      ...(init?.headers ?? {}),
    },
  });
}

function notFound(): Response {
  return json({ error: "not_found" }, { status: 404 });
}

function badRequest(message: string): Response {
  return json({ error: "bad_request", message }, { status: 400 });
}

function keyJoin(...parts: string[]): string {
  return parts
    .join("/")
    .replace(/\\/g, "/")
    .replace(/\/+/, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/^\//, "");
}

async function serveRegistry(env: Env, kind: string): Promise<Response> {
  const key = keyJoin("catalog", kind, "registry.json");
  const v = await env.CATALOG_INDEX.get(key);
  if (!v) return notFound();
  return new Response(v, {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=60",
      ...CORS_HEADERS,
    },
  });
}

async function serveLatestAlias(baseUrl: URL, env: Env, kind: string, id: string, file: string): Promise<Response> {
  const latestKey = keyJoin("catalog", kind, id, "latest.json");
  const latestJson = await env.CATALOG_INDEX.get(latestKey);
  if (!latestJson) {
    return notFound();
  }
  let latest: { version?: string };
  try {
    latest = JSON.parse(latestJson);
  } catch {
    return json({ error: "invalid_latest", key: latestKey }, { status: 500 });
  }
  if (!latest.version) return json({ error: "invalid_latest", key: latestKey }, { status: 500 });

  // Canonical URL shape on the catalog subdomain is root-based:
  //   https://catalog.okham.io/<kind>/<id>/<version>/<file>
  // Keep host from the deployment.
  const url = new URL(
    `/${encodeURIComponent(kind)}/${encodeURIComponent(id)}/${encodeURIComponent(latest.version)}/${file}`,
    baseUrl.origin,
  );

  // Redirect is better for caching; clients can follow.
  return new Response(null, {
    status: 302,
    headers: {
      location: url.toString(),
      "cache-control": "public, max-age=30",
      ...CORS_HEADERS,
    },
  });
}

async function serveArtifact(env: Env, kind: string, id: string, version: string, file: string): Promise<Response> {
  const key = keyJoin("catalog", kind, id, version, file);
  const obj = await env.CATALOG_BUCKET.get(key);
  if (!obj) return notFound();

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("etag", obj.httpEtag);
  headers.set("cache-control", "public, max-age=31536000, immutable");
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);

  // If content-type missing, try a reasonable default.
  if (!headers.get("content-type")) {
    if (file.endsWith(".json")) headers.set("content-type", "application/json; charset=utf-8");
    else if (file.endsWith(".yaml") || file.endsWith(".yml")) headers.set("content-type", "text/yaml; charset=utf-8");
    else headers.set("content-type", "application/octet-stream");
  }

  return new Response(obj.body, { headers });
}

async function handleIngest(_req: Request, env: Env): Promise<Response> {
  if (env.INGEST_ENABLED !== "1") {
    return json(
      {
        error: "disabled",
        message:
          "Ingest is not enabled yet. Enable by setting INGEST_ENABLED=1 and implementing webhook verification + publish pipeline.",
      },
      { status: 501 },
    );
  }
  return json({ error: "not_implemented" }, { status: 501 });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });

    const url = new URL(req.url);
    const path = url.pathname;

    // This worker is the catalog API. Canonical deployment is on catalog.okham.io at root.
    // For backwards compatibility, also accept /catalog/* when routed under okham.io.
    const isLegacyPrefix = path === "/catalog" || path === "/catalog/" || path.startsWith("/catalog/");
    const apiPath = path.startsWith("/catalog/") ? path.slice("/catalog".length) : path; // keep leading '/'

    // Human-facing entrypoints
    if (path === "/" || path === "" || path === "/catalog" || path === "/catalog/") {
      return new Response(null, {
        status: 302,
        headers: {
          location: "https://okham.io/catalogs/",
          "cache-control": "public, max-age=300",
          ...CORS_HEADERS,
        },
      });
    }

    // Health / ingest (support both root-based and legacy-prefixed)
    if (apiPath === "/_health") {
      return json({ ok: true, worker: env.OKHAM_CATALOG_WORKER, now: new Date().toISOString(), legacy: isLegacyPrefix });
    }

    if (apiPath === "/_ingest/github" && req.method === "POST") {
      return handleIngest(req, env);
    }

    // /<kind>/registry.json
    const registryMatch = apiPath.match(/^\/([^/]+)\/registry\.json$/);
    if (registryMatch && req.method === "GET") {
      const kind = decodeURIComponent(registryMatch[1]);
      return serveRegistry(env, kind);
    }

    // /<kind>/<id>/latest/<file>
    const latestMatch = apiPath.match(/^\/([^/]+)\/([^/]+)\/latest\/(.+)$/);
    if (latestMatch && req.method === "GET") {
      const kind = decodeURIComponent(latestMatch[1]);
      const id = decodeURIComponent(latestMatch[2]);
      const file = latestMatch[3];
      return serveLatestAlias(url, env, kind, id, file);
    }

    // /<kind>/<id>/<version>/<file>
    const artifactMatch = apiPath.match(/^\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/);
    if (artifactMatch && req.method === "GET") {
      const kind = decodeURIComponent(artifactMatch[1]);
      const id = decodeURIComponent(artifactMatch[2]);
      const version = decodeURIComponent(artifactMatch[3]);
      const file = artifactMatch[4];
      return serveArtifact(env, kind, id, version, file);
    }

    return notFound();
  },
};
