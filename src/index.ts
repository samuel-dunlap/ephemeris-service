/**
 * Ephemeris Service — Cloudflare Worker
 *
 * Swiss Ephemeris 2.10.03 compiled to WebAssembly. Computes planetary
 * positions, declinations, and Placidus house cusps. Reached only via a
 * Cloudflare service binding (no public routes).
 *
 * POST /v1/chart   { jd, lat?, lon? }  → positions + optional houses
 * GET  /v1/health  → { ok, swisseph, chiron }
 * GET  /v1/source  → { license, source }
 */

import {
  computePositions,
  computeHouses,
  getVersion,
  hasChiron,
  type Positions,
  type HouseCusps,
} from "./swisseph";

// ---------------------------------------------------------------------------
// Environment bindings
// ---------------------------------------------------------------------------

interface Env {
  INTERNAL_SECRET?: string;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Julian Day range: years 1800–2400 (matching the .se1 file coverage). */
const JD_MIN = 2378497; // ~1800-01-01
const JD_MAX = 2597641; // ~2400-01-01

interface ChartRequest {
  jd: number;
  lat?: number;
  lon?: number;
}

function validateBody(body: unknown): body is ChartRequest {
  if (body === null || typeof body !== "object") return false;
  const obj = body as Record<string, unknown>;

  if (typeof obj.jd !== "number" || !Number.isFinite(obj.jd)) return false;
  if (obj.jd < JD_MIN || obj.jd > JD_MAX) return false;

  if (obj.lat !== undefined) {
    if (typeof obj.lat !== "number" || !Number.isFinite(obj.lat)) return false;
    if (Math.abs(obj.lat) > 90) return false;
  }

  if (obj.lon !== undefined) {
    if (typeof obj.lon !== "number" || !Number.isFinite(obj.lon)) return false;
    if (Math.abs(obj.lon) > 180) return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errorResponse(message: string, status: number): Response {
  return json({ error: message }, status);
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

async function handleChart(
  request: Request,
  env: Env
): Promise<Response> {
  // --- Auth: fail closed when secret is unset ---
  if (!env.INTERNAL_SECRET) {
    return errorResponse("Service misconfigured: secret not set", 503);
  }

  const provided = request.headers.get("X-Internal-Secret");
  if (provided !== env.INTERNAL_SECRET) {
    return errorResponse("Unauthorized", 401);
  }

  // --- Parse and validate body ---
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  if (!validateBody(body)) {
    return errorResponse(
      "Invalid body: requires { jd: number (2378497..2597641), lat?: number (|lat|<=90), lon?: number (|lon|<=180) }",
      400
    );
  }

  const { jd, lat, lon } = body;

  // --- Compute ---
  const positions: Positions = await computePositions(jd);

  // Houses only when both lat and lon are provided
  let houses: HouseCusps | undefined;
  if (lat !== undefined && lon !== undefined) {
    houses = await computeHouses(jd, lat, lon);
  }

  // --- Shape the response to match the contract ---
  const positionsOut: Record<
    string,
    { lon: number; lat: number; speed: number; decl: number }
  > = {};
  for (const [name, pos] of Object.entries(positions)) {
    positionsOut[name] = {
      lon: pos.lon,
      lat: pos.lat,
      speed: pos.speed,
      decl: pos.decl,
    };
  }

  const result: {
    positions: typeof positionsOut;
    houses?: { cusps: number[]; asc: number; mc: number };
  } = { positions: positionsOut };

  if (houses) {
    result.houses = {
      cusps: houses.cusps,
      asc: houses.asc,
      mc: houses.mc,
    };
  }

  return json(result);
}

async function handleHealth(): Promise<Response> {
  const version = await getVersion();
  const chiron = await hasChiron();
  return json({ ok: true, swisseph: version, chiron });
}

function handleSource(): Response {
  return json({
    license: "AGPL-3.0-or-later",
    source: "<repo url placeholder>",
  });
}

// ---------------------------------------------------------------------------
// Worker entry
// ---------------------------------------------------------------------------

export default {
  async fetch(
    request: Request,
    env: Env
  ): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // GET /v1/health
    if (path === "/v1/health" && request.method === "GET") {
      return handleHealth();
    }

    // GET /v1/source
    if (path === "/v1/source" && request.method === "GET") {
      return handleSource();
    }

    // POST /v1/chart
    if (path === "/v1/chart" && request.method === "POST") {
      return handleChart(request, env);
    }

    // Everything else
    return errorResponse("Method not allowed", 405);
  },
};
