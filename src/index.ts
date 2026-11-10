/**
 * Ephemeris Service — Cloudflare Worker
 *
 * Swiss Ephemeris 2.10.03 compiled to WebAssembly. Computes planetary
 * positions, declinations, and Placidus house cusps. Reached only via a
 * Cloudflare service binding (no public routes).
 *
 * POST /v1/chart              { jd, lat?, lon? }             → positions + optional houses
 * POST /v1/batch              { jds[], lat?, lon? }          → array of positions + optional houses
 * POST /v1/refine-crossings   { items[] }                    → refinement results (newton, bisect, etc.)
 * POST /v1/batch-houses       { jd, locations[] }            → houses at multiple locations
 * GET  /v1/health             → { ok, swisseph, chiron }
 * GET  /v1/source             → { license, source }
 */

import {
  computePositions,
  computeHouses,
  computeSiderealTime,
  getVersion,
  hasChiron,
  BODY_NAMES,
  type Positions,
  type HouseCusps,
  type BodyName,
} from "./swisseph";

import {
  processItem,
  batchComputeHouses,
  REFINE_MAX_ITEMS,
  BATCH_HOUSES_MAX,
  type RefineCrossingItem,
  type RefineCrossingKind,
} from "./refinement";

// ---------------------------------------------------------------------------
// Environment bindings
// ---------------------------------------------------------------------------

interface Env {
  INTERNAL_SECRET?: string;
  /** Injected at deploy time by scripts/deploy-all.sh from the subtree split SHA. */
  SOURCE_COMMIT?: string;
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

/** Maximum number of Julian Days in a single batch request. */
const BATCH_MAX_JDS = 500;

interface BatchRequest {
  jds: number[];
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

function validateBatchBody(body: unknown): body is BatchRequest {
  if (body === null || typeof body !== "object") return false;
  const obj = body as Record<string, unknown>;

  // jds must be an array of finite numbers within range, max BATCH_MAX_JDS
  if (!Array.isArray(obj.jds)) return false;
  if (obj.jds.length === 0 || obj.jds.length > BATCH_MAX_JDS) return false;
  for (const jd of obj.jds) {
    if (typeof jd !== "number" || !Number.isFinite(jd)) return false;
    if (jd < JD_MIN || jd > JD_MAX) return false;
  }

  // Optional lat/lon — same validation as single chart
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
// Refine-crossings validation
// ---------------------------------------------------------------------------

const VALID_REFINE_KINDS = new Set<RefineCrossingKind>([
  "newton",
  "bisect",
  "lunation-bisect",
  "station-refine",
  "sign-bisect",
]);

const VALID_BODY_NAMES = new Set<string>(BODY_NAMES);

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isValidJd(jd: unknown): boolean {
  return isFiniteNumber(jd) && jd >= JD_MIN && jd <= JD_MAX;
}

function validateRefineBody(
  body: unknown,
): { items: RefineCrossingItem[] } | string {
  if (body === null || typeof body !== "object") return "Invalid body";
  const obj = body as Record<string, unknown>;

  if (!Array.isArray(obj.items)) return "items must be an array";
  if (obj.items.length === 0 || obj.items.length > REFINE_MAX_ITEMS) {
    return `items.length must be 1..${REFINE_MAX_ITEMS}`;
  }

  for (let i = 0; i < obj.items.length; i++) {
    const item = obj.items[i];
    if (item === null || typeof item !== "object") {
      return `items[${i}]: must be an object`;
    }
    const it = item as Record<string, unknown>;

    if (!VALID_REFINE_KINDS.has(it.kind as RefineCrossingKind)) {
      return `items[${i}].kind: must be one of ${[...VALID_REFINE_KINDS].join(", ")}`;
    }

    const kind = it.kind as RefineCrossingKind;

    // Per-kind required field validation
    switch (kind) {
      case "newton": {
        if (!VALID_BODY_NAMES.has(it.body as string))
          return `items[${i}].body: must be a valid body name`;
        if (!isFiniteNumber(it.targetLon))
          return `items[${i}].targetLon: required finite number`;
        if (!isValidJd(it.approxJd))
          return `items[${i}].approxJd: required valid JD (${JD_MIN}..${JD_MAX})`;
        if (!isFiniteNumber(it.meanMotion) || it.meanMotion === 0)
          return `items[${i}].meanMotion: required non-zero finite number`;
        if (it.maxIter !== undefined && (!Number.isInteger(it.maxIter) || (it.maxIter as number) < 1))
          return `items[${i}].maxIter: must be a positive integer`;
        if (it.tolerance !== undefined && (!isFiniteNumber(it.tolerance) || (it.tolerance as number) <= 0))
          return `items[${i}].tolerance: must be a positive number`;
        break;
      }
      case "bisect": {
        if (!VALID_BODY_NAMES.has(it.body as string))
          return `items[${i}].body: must be a valid body name`;
        if (!isFiniteNumber(it.targetLon))
          return `items[${i}].targetLon: required finite number`;
        if (!isValidJd(it.loJd))
          return `items[${i}].loJd: required valid JD`;
        if (!isValidJd(it.hiJd))
          return `items[${i}].hiJd: required valid JD`;
        if (it.bisectTolerance !== undefined && (!isFiniteNumber(it.bisectTolerance) || (it.bisectTolerance as number) <= 0))
          return `items[${i}].bisectTolerance: must be a positive number`;
        if (it.bisectMaxIter !== undefined && (!Number.isInteger(it.bisectMaxIter) || (it.bisectMaxIter as number) < 1))
          return `items[${i}].bisectMaxIter: must be a positive integer`;
        break;
      }
      case "lunation-bisect": {
        if (!isValidJd(it.loJd))
          return `items[${i}].loJd: required valid JD`;
        if (!isValidJd(it.hiJd))
          return `items[${i}].hiJd: required valid JD`;
        if (it.elongTarget !== 0 && it.elongTarget !== 180)
          return `items[${i}].elongTarget: must be 0 or 180`;
        if (it.lunationMaxIter !== undefined && (!Number.isInteger(it.lunationMaxIter) || (it.lunationMaxIter as number) < 1))
          return `items[${i}].lunationMaxIter: must be a positive integer`;
        break;
      }
      case "station-refine": {
        if (!VALID_BODY_NAMES.has(it.body as string))
          return `items[${i}].body: must be a valid body name`;
        if (!isValidJd(it.natalJd))
          return `items[${i}].natalJd: required valid JD`;
        if (!isFiniteNumber(it.loAge))
          return `items[${i}].loAge: required finite number`;
        if (!isFiniteNumber(it.hiAge))
          return `items[${i}].hiAge: required finite number`;
        if (it.subStep !== undefined && (!isFiniteNumber(it.subStep) || (it.subStep as number) <= 0))
          return `items[${i}].subStep: must be a positive number`;
        if (it.stationBisectIters !== undefined && (!Number.isInteger(it.stationBisectIters) || (it.stationBisectIters as number) < 1))
          return `items[${i}].stationBisectIters: must be a positive integer`;
        // Validate that computed JDs (natalJd + loAge, natalJd + hiAge) are in range
        const stLoJd = (it.natalJd as number) + (it.loAge as number);
        const stHiJd = (it.natalJd as number) + (it.hiAge as number);
        if (stLoJd < JD_MIN || stLoJd > JD_MAX)
          return `items[${i}]: natalJd + loAge (${stLoJd}) out of JD range`;
        if (stHiJd < JD_MIN || stHiJd > JD_MAX)
          return `items[${i}]: natalJd + hiAge (${stHiJd}) out of JD range`;
        break;
      }
      case "sign-bisect": {
        if (!VALID_BODY_NAMES.has(it.body as string))
          return `items[${i}].body: must be a valid body name`;
        if (!isValidJd(it.natalJd))
          return `items[${i}].natalJd: required valid JD`;
        if (!isFiniteNumber(it.loAge))
          return `items[${i}].loAge: required finite number`;
        if (!isFiniteNumber(it.hiAge))
          return `items[${i}].hiAge: required finite number`;
        if (!Number.isInteger(it.targetSign) || (it.targetSign as number) < 0 || (it.targetSign as number) > 11)
          return `items[${i}].targetSign: must be an integer 0..11`;
        if (it.bisectMaxIter !== undefined && (!Number.isInteger(it.bisectMaxIter) || (it.bisectMaxIter as number) < 1))
          return `items[${i}].bisectMaxIter: must be a positive integer`;
        // Validate computed JDs
        const sbLoJd = (it.natalJd as number) + (it.loAge as number);
        const sbHiJd = (it.natalJd as number) + (it.hiAge as number);
        if (sbLoJd < JD_MIN || sbLoJd > JD_MAX)
          return `items[${i}]: natalJd + loAge (${sbLoJd}) out of JD range`;
        if (sbHiJd < JD_MIN || sbHiJd > JD_MAX)
          return `items[${i}]: natalJd + hiAge (${sbHiJd}) out of JD range`;
        break;
      }
    }
  }

  return { items: obj.items as RefineCrossingItem[] };
}

// ---------------------------------------------------------------------------
// Batch-houses validation
// ---------------------------------------------------------------------------

interface BatchHousesRequest {
  jd: number;
  locations: Array<{ lat: number; lon: number }>;
}

function validateBatchHousesBody(
  body: unknown,
): BatchHousesRequest | string {
  if (body === null || typeof body !== "object") return "Invalid body";
  const obj = body as Record<string, unknown>;

  if (!isValidJd(obj.jd)) {
    return `jd: required valid JD (${JD_MIN}..${JD_MAX})`;
  }

  if (!Array.isArray(obj.locations)) return "locations must be an array";
  if (obj.locations.length === 0 || obj.locations.length > BATCH_HOUSES_MAX) {
    return `locations.length must be 1..${BATCH_HOUSES_MAX}`;
  }

  for (let i = 0; i < obj.locations.length; i++) {
    const loc = obj.locations[i];
    if (loc === null || typeof loc !== "object") {
      return `locations[${i}]: must be an object`;
    }
    const l = loc as Record<string, unknown>;
    if (!isFiniteNumber(l.lat) || Math.abs(l.lat) > 90) {
      return `locations[${i}].lat: required, |lat| <= 90`;
    }
    if (!isFiniteNumber(l.lon) || Math.abs(l.lon) > 180) {
      return `locations[${i}].lon: required, |lon| <= 180`;
    }
  }

  return {
    jd: obj.jd as number,
    locations: obj.locations as Array<{ lat: number; lon: number }>,
  };
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
  const gst: number = await computeSiderealTime(jd);

  // Houses only when both lat and lon are provided
  let houses: HouseCusps | undefined;
  if (lat !== undefined && lon !== undefined) {
    houses = await computeHouses(jd, lat, lon);
  }

  // --- Shape the response to match the contract ---
  const positionsOut: Record<
    string,
    { lon: number; lat: number; speed: number; ra: number; decl: number }
  > = {};
  for (const [name, pos] of Object.entries(positions)) {
    positionsOut[name] = {
      lon: pos.lon,
      lat: pos.lat,
      speed: pos.speed,
      ra: pos.ra,
      decl: pos.decl,
    };
  }

  const result: {
    positions: typeof positionsOut;
    gst: number;
    houses?: { cusps: number[]; asc: number; mc: number; placidus: boolean };
  } = { positions: positionsOut, gst };

  if (houses) {
    result.houses = {
      cusps: houses.cusps,
      asc: houses.asc,
      mc: houses.mc,
      placidus: houses.placidus,
    };
  }

  return json(result);
}

async function handleBatch(
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

  if (!validateBatchBody(body)) {
    return errorResponse(
      `Invalid body: requires { jds: number[] (1..${BATCH_MAX_JDS}, each ${JD_MIN}..${JD_MAX}), lat?: number (|lat|<=90), lon?: number (|lon|<=180) }`,
      400
    );
  }

  const { jds, lat, lon } = body;
  const wantHouses = lat !== undefined && lon !== undefined;

  // --- Compute all JDs ---
  const results: Array<{
    jd: number;
    positions: Record<
      string,
      { lon: number; lat: number; speed: number; ra: number; decl: number }
    >;
    gst: number;
    houses?: { cusps: number[]; asc: number; mc: number; placidus: boolean };
  }> = [];

  for (const jd of jds) {
    const positions: Positions = await computePositions(jd);
    const gst: number = await computeSiderealTime(jd);

    // Shape positions to match the contract
    const positionsOut: Record<
      string,
      { lon: number; lat: number; speed: number; ra: number; decl: number }
    > = {};
    for (const [name, pos] of Object.entries(positions)) {
      positionsOut[name] = {
        lon: pos.lon,
        lat: pos.lat,
        speed: pos.speed,
        ra: pos.ra,
        decl: pos.decl,
      };
    }

    const entry: (typeof results)[number] = {
      jd,
      positions: positionsOut,
      gst,
    };

    if (wantHouses) {
      const houses: HouseCusps = await computeHouses(jd, lat!, lon!);
      entry.houses = {
        cusps: houses.cusps,
        asc: houses.asc,
        mc: houses.mc,
        placidus: houses.placidus,
      };
    }

    results.push(entry);
  }

  return json({ results });
}

async function handleHealth(): Promise<Response> {
  const version = await getVersion();
  const chiron = await hasChiron();
  return json({ ok: true, swisseph: version, chiron });
}

function handleSource(env: Env): Response {
  return json({
    license: "AGPL-3.0-or-later",
    source: "https://github.com/samuel-dunlap/ephemeris-service",
    sourceCommit: env.SOURCE_COMMIT ?? "unknown",
  });
}

async function handleRefineCrossings(
  request: Request,
  env: Env
): Promise<Response> {
  // --- Auth ---
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

  const validated = validateRefineBody(body);
  if (typeof validated === "string") {
    return errorResponse(validated, 400);
  }

  // --- Process each item independently ---
  const results = [];
  for (const item of validated.items) {
    results.push(await processItem(item));
  }

  return json({ results });
}

async function handleBatchHouses(
  request: Request,
  env: Env
): Promise<Response> {
  // --- Auth ---
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

  const validated = validateBatchHousesBody(body);
  if (typeof validated === "string") {
    return errorResponse(validated, 400);
  }

  // --- Compute houses for all locations ---
  const results = await batchComputeHouses(validated.jd, validated.locations);
  return json({ results });
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
      return handleSource(env);
    }

    // POST /v1/chart
    if (path === "/v1/chart" && request.method === "POST") {
      return handleChart(request, env);
    }

    // POST /v1/batch
    if (path === "/v1/batch" && request.method === "POST") {
      return handleBatch(request, env);
    }

    // POST /v1/refine-crossings
    if (path === "/v1/refine-crossings" && request.method === "POST") {
      return handleRefineCrossings(request, env);
    }

    // POST /v1/batch-houses
    if (path === "/v1/batch-houses" && request.method === "POST") {
      return handleBatchHouses(request, env);
    }

    // Everything else
    return errorResponse("Method not allowed", 405);
  },
};
