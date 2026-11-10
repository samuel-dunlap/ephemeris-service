/**
 * Tests for /v1/refine-crossings and /v1/batch-houses endpoints.
 *
 * Each test computes a known result via the per-call /v1/chart path, then
 * verifies the new endpoints reproduce it exactly (byte-identical positions).
 *
 * Fixture: Hartford natal, 2004-03-11 16:20 UTC, 41.7658 N, 72.6734 W
 * JD = 2453075.18056 (approx)
 */

import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src/index";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEST_SECRET = "test-secret-12345";

// Hartford natal JD (2004-03-11 16:20 UTC)
const HARTFORD_JD = 2453075.180555556;
const HARTFORD_LAT = 41.7658;
const HARTFORD_LON = -72.6734;

// Valid JD range from the service
const JD_MIN = 2378497;
const JD_MAX = 2597641;

function makeEnv() {
  return { INTERNAL_SECRET: TEST_SECRET };
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function post(
  path: string,
  body: unknown,
  secret?: string,
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (secret !== undefined) {
    headers["X-Internal-Secret"] = secret;
  }
  const request = new Request(`http://localhost${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, makeEnv(), ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function postChart(body: unknown): Promise<Response> {
  return post("/v1/chart", body, TEST_SECRET);
}

async function postRefine(body: unknown, secret: string | undefined = TEST_SECRET): Promise<Response> {
  return post("/v1/refine-crossings", body, secret);
}

async function postBatchHouses(
  body: unknown,
  secret: string | undefined = TEST_SECRET,
): Promise<Response> {
  return post("/v1/batch-houses", body, secret);
}

// ---------------------------------------------------------------------------
// Helper: get positions at a single JD via /v1/chart
// ---------------------------------------------------------------------------

interface ChartPositions {
  [body: string]: {
    lon: number;
    lat: number;
    speed: number;
    ra: number;
    decl: number;
  };
}

async function getPositionsAt(jd: number): Promise<ChartPositions> {
  const res = await postChart({ jd });
  expect(res.status).toBe(200);
  const data = (await res.json()) as { positions: ChartPositions };
  return data.positions;
}

// ---------------------------------------------------------------------------
// /v1/refine-crossings — Auth and validation
// ---------------------------------------------------------------------------

describe("POST /v1/refine-crossings — auth", () => {
  it("returns 401 on missing secret", async () => {
    const validBody = { items: [{ kind: "newton", body: "Sun", targetLon: 0, approxJd: HARTFORD_JD, meanMotion: 1 }] };
    const request = new Request("http://localhost/v1/refine-crossings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validBody),
    });
    const ctx = createExecutionContext();
    const res = await worker.fetch(request, makeEnv(), ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(401);
  });

  it("returns 401 on wrong secret", async () => {
    const validBody = { items: [{ kind: "newton", body: "Sun", targetLon: 0, approxJd: HARTFORD_JD, meanMotion: 1 }] };
    const request = new Request("http://localhost/v1/refine-crossings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Secret": "wrong-secret",
      },
      body: JSON.stringify(validBody),
    });
    const ctx = createExecutionContext();
    const res = await worker.fetch(request, makeEnv(), ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(401);
  });

  it("returns 503 when INTERNAL_SECRET env is unset", async () => {
    const request = new Request("http://localhost/v1/refine-crossings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Secret": "anything",
      },
      body: JSON.stringify({ items: [{ kind: "newton", body: "Sun", targetLon: 0, approxJd: HARTFORD_JD, meanMotion: 1 }] }),
    });
    const ctx = createExecutionContext();
    const res = await worker.fetch(request, {} as any, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(503);
  });
});

describe("POST /v1/refine-crossings — validation", () => {
  it("returns 400 on invalid JSON", async () => {
    const request = new Request("http://localhost/v1/refine-crossings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Secret": TEST_SECRET,
      },
      body: "not json",
    });
    const ctx = createExecutionContext();
    const res = await worker.fetch(request, makeEnv(), ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(400);
  });

  it("returns 400 when items is empty", async () => {
    const res = await postRefine({ items: [] });
    expect(res.status).toBe(400);
  });

  it("returns 400 when items exceeds 200", async () => {
    const items = Array.from({ length: 201 }, () => ({
      kind: "newton",
      body: "Sun",
      targetLon: 0,
      approxJd: HARTFORD_JD,
      meanMotion: 1,
    }));
    const res = await postRefine({ items });
    expect(res.status).toBe(400);
  });

  it("returns 400 for unknown kind", async () => {
    const res = await postRefine({
      items: [{ kind: "unknown", body: "Sun" }],
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when newton is missing body", async () => {
    const res = await postRefine({
      items: [{ kind: "newton", targetLon: 0, approxJd: HARTFORD_JD, meanMotion: 1 }],
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when newton has invalid body name", async () => {
    const res = await postRefine({
      items: [{ kind: "newton", body: "FakeBody", targetLon: 0, approxJd: HARTFORD_JD, meanMotion: 1 }],
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when newton has out-of-range approxJd", async () => {
    const res = await postRefine({
      items: [{ kind: "newton", body: "Sun", targetLon: 0, approxJd: 1000000, meanMotion: 1 }],
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when newton has zero meanMotion", async () => {
    const res = await postRefine({
      items: [{ kind: "newton", body: "Sun", targetLon: 0, approxJd: HARTFORD_JD, meanMotion: 0 }],
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when bisect is missing loJd", async () => {
    const res = await postRefine({
      items: [{ kind: "bisect", body: "Sun", targetLon: 0, hiJd: HARTFORD_JD + 1 }],
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when lunation-bisect has invalid elongTarget", async () => {
    const res = await postRefine({
      items: [{ kind: "lunation-bisect", loJd: HARTFORD_JD, hiJd: HARTFORD_JD + 1, elongTarget: 90 }],
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when station-refine has out-of-range computed JD", async () => {
    // natalJd + hiAge exceeds JD_MAX
    const res = await postRefine({
      items: [{
        kind: "station-refine",
        body: "Mercury",
        natalJd: JD_MAX,
        loAge: 0,
        hiAge: 1,
      }],
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when sign-bisect has invalid targetSign", async () => {
    const res = await postRefine({
      items: [{
        kind: "sign-bisect",
        body: "Sun",
        natalJd: HARTFORD_JD,
        loAge: 0,
        hiAge: 1,
        targetSign: 12,
      }],
    });
    expect(res.status).toBe(400);
  });

  it("accepts exactly 200 items", async () => {
    const items = Array.from({ length: 200 }, () => ({
      kind: "newton",
      body: "Sun",
      targetLon: 351.0,
      approxJd: HARTFORD_JD,
      meanMotion: 0.9856,
    }));
    const res = await postRefine({ items });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { results: unknown[] };
    expect(data.results).toHaveLength(200);
  });
});

// ---------------------------------------------------------------------------
// /v1/refine-crossings — Newton's method
// ---------------------------------------------------------------------------

describe("POST /v1/refine-crossings — newton", () => {
  it("finds the Sun's solar return (same year) via Newton's method", async () => {
    // Get the Sun's natal longitude at Hartford birth
    const natalPos = await getPositionsAt(HARTFORD_JD);
    const natalSunLon = natalPos.Sun.lon;

    // Approximate JD for 2025 solar return (roughly 21 years later)
    const approxReturnJd = HARTFORD_JD + 365.2422 * 21;

    const res = await postRefine({
      items: [{
        kind: "newton",
        body: "Sun",
        targetLon: natalSunLon,
        approxJd: approxReturnJd,
        meanMotion: 0.9856,
        maxIter: 50,
        tolerance: 1e-5,
      }],
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      results: Array<{
        jd: number;
        positions: ChartPositions;
        converged: boolean;
        iterations: number;
      }>;
    };

    expect(data.results).toHaveLength(1);
    const result = data.results[0];
    expect(result.converged).toBe(true);
    expect(result.iterations).toBeGreaterThan(0);
    expect(result.iterations).toBeLessThanOrEqual(50);

    // The Sun at the returned JD should be very close to the natal Sun longitude
    const returnSunLon = result.positions.Sun.lon;
    const sep = Math.abs(((returnSunLon - natalSunLon + 180) % 360) - 180);
    expect(sep).toBeLessThan(1e-5);

    // Cross-check: positions at the returned JD via /v1/chart should match exactly
    const chartPos = await getPositionsAt(result.jd);
    expect(result.positions.Sun.lon).toBe(chartPos.Sun.lon);
    expect(result.positions.Moon.lon).toBe(chartPos.Moon.lon);
    expect(result.positions.Mercury.lon).toBe(chartPos.Mercury.lon);
  });

  it("multiple Newton items in one batch", async () => {
    const natalPos = await getPositionsAt(HARTFORD_JD);
    const natalSunLon = natalPos.Sun.lon;

    // Request solar return for years 19, 20, 21, 22
    const items = [19, 20, 21, 22].map((yr) => ({
      kind: "newton" as const,
      body: "Sun",
      targetLon: natalSunLon,
      approxJd: HARTFORD_JD + 365.2422 * yr,
      meanMotion: 0.9856,
    }));

    const res = await postRefine({ items });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      results: Array<{ jd: number; converged: boolean; positions: ChartPositions }>;
    };

    expect(data.results).toHaveLength(4);
    for (const r of data.results) {
      expect(r.converged).toBe(true);
      // Each should be close to the natal Sun lon
      const sep = Math.abs(((r.positions.Sun.lon - natalSunLon + 180) % 360) - 180);
      expect(sep).toBeLessThan(1e-5);
    }

    // Results should be at different JDs (different years)
    const jds = data.results.map((r) => r.jd);
    for (let i = 1; i < jds.length; i++) {
      expect(jds[i] - jds[i - 1]).toBeGreaterThan(364);
      expect(jds[i] - jds[i - 1]).toBeLessThan(367);
    }
  });

  it("Newton's method matches manual iteration via /v1/chart", async () => {
    // Manually perform Newton's method via /v1/chart and compare
    const natalPos = await getPositionsAt(HARTFORD_JD);
    const natalSunLon = natalPos.Sun.lon;
    const approxJd = HARTFORD_JD + 365.2422 * 5;
    const meanMotion = 0.9856;
    const tolerance = 1e-5;

    // Manual Newton's
    let jd = approxJd;
    for (let i = 0; i < 50; i++) {
      const pos = await getPositionsAt(jd);
      const currentLon = pos.Sun.lon;
      const raw = ((natalSunLon - currentLon) % 360 + 360) % 360;
      const sep = raw > 180 ? raw - 360 : raw;
      if (Math.abs(sep) < tolerance) break;
      jd += sep / meanMotion;
    }
    const manualJd = jd;

    // Batch Newton's
    const res = await postRefine({
      items: [{
        kind: "newton",
        body: "Sun",
        targetLon: natalSunLon,
        approxJd,
        meanMotion,
        tolerance,
      }],
    });
    const data = (await res.json()) as {
      results: Array<{ jd: number; positions: ChartPositions }>;
    };

    expect(data.results[0].jd).toBe(manualJd);
  });

  it("HD design date Newton's method works", async () => {
    // HD design date: Sun 88 deg behind birth Sun
    const natalPos = await getPositionsAt(HARTFORD_JD);
    const birthSunLon = natalPos.Sun.lon;
    const targetLon = ((birthSunLon - 88) % 360 + 360) % 360;
    const avgSunSpeed = 360 / 365.2422;
    const approxJd = HARTFORD_JD - 88 / avgSunSpeed;

    const res = await postRefine({
      items: [{
        kind: "newton",
        body: "Sun",
        targetLon,
        approxJd,
        meanMotion: avgSunSpeed,
        maxIter: 6,
        tolerance: 0.01,
      }],
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      results: Array<{ jd: number; converged: boolean; positions: ChartPositions }>;
    };

    expect(data.results[0].converged).toBe(true);
    // The design date should be ~88-90 days before birth
    const daysBefore = HARTFORD_JD - data.results[0].jd;
    expect(daysBefore).toBeGreaterThan(85);
    expect(daysBefore).toBeLessThan(95);
  });
});

// ---------------------------------------------------------------------------
// /v1/refine-crossings — Bisection
// ---------------------------------------------------------------------------

describe("POST /v1/refine-crossings — bisect", () => {
  it("finds the exact JD of a planetary crossing via bisection", async () => {
    // Get Jupiter's position at two points, find where it crosses a target
    const jd1 = HARTFORD_JD + 365;
    const jd2 = jd1 + 30;
    const pos1 = await getPositionsAt(jd1);
    const pos2 = await getPositionsAt(jd2);

    // Jupiter moves forward, pick a target between the two longitudes
    const targetLon = (pos1.Jupiter.lon + pos2.Jupiter.lon) / 2;

    const res = await postRefine({
      items: [{
        kind: "bisect",
        body: "Jupiter",
        targetLon,
        loJd: jd1,
        hiJd: jd2,
        bisectTolerance: 0.0007,
        bisectMaxIter: 20,
      }],
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      results: Array<{ jd: number; converged: boolean; positions: ChartPositions; iterations: number }>;
    };

    expect(data.results).toHaveLength(1);
    const result = data.results[0];
    expect(result.converged).toBe(true);
    // The result JD should be between the bracket
    expect(result.jd).toBeGreaterThanOrEqual(jd1);
    expect(result.jd).toBeLessThanOrEqual(jd2);
  });

  it("bisect matches manual bisection via /v1/chart", async () => {
    // Manual bisection for Saturn crossing a specific longitude
    const jd1 = HARTFORD_JD + 200;
    const jd2 = jd1 + 10;
    const pos1 = await getPositionsAt(jd1);
    const pos2 = await getPositionsAt(jd2);

    const targetLon = (pos1.Saturn.lon + pos2.Saturn.lon) / 2;

    // angleDiff: signed angular difference in [-180, 180]
    function angleDiff(from: number, to: number): number {
      let d = ((to - from) % 360 + 360) % 360;
      if (d > 180) d -= 360;
      return d;
    }

    // Manual bisection
    let lo = jd1;
    let hi = jd2;
    const loPos = await getPositionsAt(lo);
    let dLo = angleDiff(targetLon, loPos.Saturn.lon);
    for (let i = 0; i < 20; i++) {
      if (hi - lo < 0.0007) break;
      const mid = (lo + hi) / 2;
      const midPos = await getPositionsAt(mid);
      const dMid = angleDiff(targetLon, midPos.Saturn.lon);
      if (dMid === 0) { lo = mid; hi = mid; break; }
      if ((dLo > 0) === (dMid > 0)) {
        lo = mid;
        dLo = dMid;
      } else {
        hi = mid;
      }
    }
    const manualJd = (lo + hi) / 2;

    // Endpoint bisection
    const res = await postRefine({
      items: [{
        kind: "bisect",
        body: "Saturn",
        targetLon,
        loJd: jd1,
        hiJd: jd2,
        bisectTolerance: 0.0007,
        bisectMaxIter: 20,
      }],
    });
    const data = (await res.json()) as {
      results: Array<{ jd: number; positions: ChartPositions }>;
    };

    expect(data.results[0].jd).toBe(manualJd);
  });
});

// ---------------------------------------------------------------------------
// /v1/refine-crossings — Lunation bisection
// ---------------------------------------------------------------------------

describe("POST /v1/refine-crossings — lunation-bisect", () => {
  it("finds a new moon (elongation 0) via lunation bisection", async () => {
    // Scan a 30-day window to find a bracket where elongation crosses 0
    const startJd = HARTFORD_JD + 100;
    let prevElong = -1;
    let bracketLo = 0;
    let bracketHi = 0;

    for (let d = 0; d <= 30; d++) {
      const jd = startJd + d;
      const pos = await getPositionsAt(jd);
      const elong = ((pos.Moon.lon - pos.Sun.lon) % 360 + 360) % 360;

      if (prevElong >= 0 && prevElong > 300 && elong < 60) {
        // Elongation wrapped from near 360 to near 0 — new moon bracket
        bracketLo = startJd + d - 1;
        bracketHi = jd;
        break;
      }
      prevElong = elong;
    }

    expect(bracketLo).toBeGreaterThan(0);

    const res = await postRefine({
      items: [{
        kind: "lunation-bisect",
        loJd: bracketLo,
        hiJd: bracketHi,
        elongTarget: 0,
        lunationMaxIter: 15,
      }],
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      results: Array<{ jd: number; converged: boolean; positions: ChartPositions; iterations: number }>;
    };

    const result = data.results[0];
    expect(result.converged).toBe(true);
    expect(result.jd).toBeGreaterThan(bracketLo);
    expect(result.jd).toBeLessThan(bracketHi);
    // At the new moon, elongation should be very close to 0
    const elong = ((result.positions.Moon.lon - result.positions.Sun.lon) % 360 + 360) % 360;
    const offset = elong > 180 ? elong - 360 : elong;
    expect(Math.abs(offset)).toBeLessThan(0.05); // within ~0.05 degrees
  });

  it("lunation-bisect matches manual refineCrossing via /v1/chart", async () => {
    // Manually perform lunation bisection and compare
    const startJd = HARTFORD_JD + 200;
    let prevElong = -1;
    let bracketLo = 0;
    let bracketHi = 0;

    for (let d = 0; d <= 30; d++) {
      const jd = startJd + d;
      const pos = await getPositionsAt(jd);
      const elong = ((pos.Moon.lon - pos.Sun.lon) % 360 + 360) % 360;
      if (prevElong >= 0 && prevElong > 140 && prevElong < 220 && (elong > 220 || elong < 140)) {
        // Full moon crossing
        bracketLo = startJd + d - 1;
        bracketHi = jd;
        break;
      }
      prevElong = elong;
    }

    if (bracketLo === 0) {
      // Try new moon instead
      prevElong = -1;
      for (let d = 0; d <= 30; d++) {
        const jd = startJd + d;
        const pos = await getPositionsAt(jd);
        const elong = ((pos.Moon.lon - pos.Sun.lon) % 360 + 360) % 360;
        if (prevElong >= 0 && prevElong > 300 && elong < 60) {
          bracketLo = startJd + d - 1;
          bracketHi = jd;
          break;
        }
        prevElong = elong;
      }
    }

    expect(bracketLo).toBeGreaterThan(0);

    // Determine target (0 or 180) by checking the elongation pattern
    const posLo = await getPositionsAt(bracketLo);
    const elongLo = ((posLo.Moon.lon - posLo.Sun.lon) % 360 + 360) % 360;
    const target: 0 | 180 = elongLo > 140 && elongLo < 220 ? 180 : 0;

    // Manual bisection
    let lo = bracketLo;
    let hi = bracketHi;
    for (let i = 0; i < 15; i++) {
      const mid = (lo + hi) / 2;
      const pos = await getPositionsAt(mid);
      const elong = ((pos.Moon.lon - pos.Sun.lon) % 360 + 360) % 360;
      let offset: number;
      if (target === 0) {
        offset = elong > 180 ? elong - 360 : elong;
      } else {
        offset = elong - 180;
        if (offset > 180) offset -= 360;
        if (offset < -180) offset += 360;
      }
      if (offset < 0) lo = mid;
      else hi = mid;
    }
    const manualJd = (lo + hi) / 2;

    // Endpoint bisection
    const res = await postRefine({
      items: [{
        kind: "lunation-bisect",
        loJd: bracketLo,
        hiJd: bracketHi,
        elongTarget: target,
        lunationMaxIter: 15,
      }],
    });
    const data = (await res.json()) as {
      results: Array<{ jd: number; positions: ChartPositions }>;
    };

    expect(data.results[0].jd).toBe(manualJd);
  });
});

// ---------------------------------------------------------------------------
// /v1/refine-crossings — Station refinement
// ---------------------------------------------------------------------------

describe("POST /v1/refine-crossings — station-refine", () => {
  it("finds a Mercury progressed station", async () => {
    // Mercury goes retrograde in the first few years after many natal dates.
    // Use a bracket where Mercury's speed sign flips.
    // Scan at integer ages to find a bracket.
    let bracketLoAge = -1;
    let bracketHiAge = -1;
    let prevSpd = 0;

    const natalPos = await getPositionsAt(HARTFORD_JD);
    prevSpd = natalPos.Mercury.speed;

    for (let age = 1; age <= 60; age++) {
      const pos = await getPositionsAt(HARTFORD_JD + age);
      const spd = pos.Mercury.speed;
      if ((prevSpd > 0 && spd <= 0) || (prevSpd < 0 && spd >= 0)) {
        bracketLoAge = age - 1;
        bracketHiAge = age;
        break;
      }
      prevSpd = spd;
    }

    if (bracketLoAge < 0) {
      // Skip if no station found in 60 years
      return;
    }

    const res = await postRefine({
      items: [{
        kind: "station-refine",
        body: "Mercury",
        natalJd: HARTFORD_JD,
        loAge: bracketLoAge,
        hiAge: bracketHiAge,
        subStep: 0.1,
        stationBisectIters: 10,
      }],
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      results: Array<{ jd: number; converged: boolean; positions: ChartPositions; iterations: number }>;
    };

    const result = data.results[0];
    expect(result.converged).toBe(true);
    // The station JD should be within the bracket
    expect(result.jd).toBeGreaterThanOrEqual(HARTFORD_JD + bracketLoAge);
    expect(result.jd).toBeLessThanOrEqual(HARTFORD_JD + bracketHiAge);

    // Mercury speed at the station should be near zero
    expect(Math.abs(result.positions.Mercury.speed)).toBeLessThan(0.2);
  });

  it("station-refine matches manual sub-step + bisection via /v1/chart", async () => {
    // Find a station bracket first
    let bracketLoAge = -1;
    let bracketHiAge = -1;
    let prevSpd = 0;
    const natalPos = await getPositionsAt(HARTFORD_JD);
    prevSpd = natalPos.Mercury.speed;

    for (let age = 1; age <= 60; age++) {
      const pos = await getPositionsAt(HARTFORD_JD + age);
      const spd = pos.Mercury.speed;
      if ((prevSpd > 0 && spd <= 0) || (prevSpd < 0 && spd >= 0)) {
        bracketLoAge = age - 1;
        bracketHiAge = age;
        break;
      }
      prevSpd = spd;
    }

    if (bracketLoAge < 0) return;

    // Manual sub-step + bisection (verbatim from unified-compute.ts)
    let lo = bracketLoAge;
    let hi = bracketHiAge;
    const loPos = await getPositionsAt(HARTFORD_JD + lo);
    let spdLo = loPos.Mercury.speed;

    const SUB_STEP = 0.1;
    for (let subAge = lo + SUB_STEP; subAge <= hi; subAge += SUB_STEP) {
      const pos = await getPositionsAt(HARTFORD_JD + subAge);
      const spd = pos.Mercury.speed;
      if ((spdLo > 0 && spd <= 0) || (spdLo < 0 && spd >= 0)) {
        hi = subAge;
        break;
      }
      lo = subAge;
      spdLo = spd;
    }

    let bisectSpdLo = spdLo;
    for (let i = 0; i < 10; i++) {
      const mid = (lo + hi) / 2;
      const pos = await getPositionsAt(HARTFORD_JD + mid);
      const midSpd = pos.Mercury.speed;
      if ((bisectSpdLo > 0 && midSpd > 0) || (bisectSpdLo < 0 && midSpd < 0)) {
        lo = mid;
        bisectSpdLo = midSpd;
      } else {
        hi = mid;
      }
    }
    const manualJd = HARTFORD_JD + (lo + hi) / 2;

    // Endpoint
    const res = await postRefine({
      items: [{
        kind: "station-refine",
        body: "Mercury",
        natalJd: HARTFORD_JD,
        loAge: bracketLoAge,
        hiAge: bracketHiAge,
        subStep: 0.1,
        stationBisectIters: 10,
      }],
    });
    const data = (await res.json()) as {
      results: Array<{ jd: number }>;
    };

    // The endpoint computes positions at the final age, so its JD =
    // natalJd + finalAge. The manual path returns natalJd + (lo+hi)/2.
    // They should be identical.
    expect(data.results[0].jd).toBe(manualJd);
  });
});

// ---------------------------------------------------------------------------
// /v1/refine-crossings — Sign bisection
// ---------------------------------------------------------------------------

describe("POST /v1/refine-crossings — sign-bisect", () => {
  it("finds the age where the Sun enters a sign via bisection", async () => {
    // The Sun at natal JD is in a specific sign.
    // 1 day later in progression = ~1 degree. After ~30 days the Sun
    // should enter the next sign.
    const natalPos = await getPositionsAt(HARTFORD_JD);
    const natalSignIndex = Math.floor(((natalPos.Sun.lon % 360 + 360) % 360) / 30);
    const nextSign = (natalSignIndex + 1) % 12;

    // Find the bracket: scan integer ages to find where the Sun enters nextSign
    let bracketLo = -1;
    let bracketHi = -1;
    for (let age = 1; age <= 100; age++) {
      const pos = await getPositionsAt(HARTFORD_JD + age);
      const si = Math.floor(((pos.Sun.lon % 360 + 360) % 360) / 30);
      if (si === nextSign) {
        bracketLo = age - 1;
        bracketHi = age;
        break;
      }
    }

    if (bracketLo < 0) return;

    const res = await postRefine({
      items: [{
        kind: "sign-bisect",
        body: "Sun",
        natalJd: HARTFORD_JD,
        loAge: bracketLo,
        hiAge: bracketHi,
        targetSign: nextSign,
        bisectMaxIter: 10,
      }],
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      results: Array<{ jd: number; converged: boolean; positions: ChartPositions }>;
    };

    const result = data.results[0];
    expect(result.converged).toBe(true);
    expect(result.jd).toBeGreaterThanOrEqual(HARTFORD_JD + bracketLo);
    expect(result.jd).toBeLessThanOrEqual(HARTFORD_JD + bracketHi);

    // The result is at the sign boundary (lo side is NOT in target, hi side IS).
    // The midpoint (lo+hi)/2 may be in either sign. Verify the Sun is within
    // 0.01 degrees of the sign boundary (nextSign * 30).
    const sunLon = ((result.positions.Sun.lon % 360) + 360) % 360;
    const signBoundary = nextSign * 30;
    const distToBoundary = Math.min(
      Math.abs(sunLon - signBoundary),
      360 - Math.abs(sunLon - signBoundary),
    );
    expect(distToBoundary).toBeLessThan(0.01); // within ~0.01 degrees of boundary
  });

  it("sign-bisect matches manual bisection via /v1/chart", async () => {
    const natalPos = await getPositionsAt(HARTFORD_JD);
    const natalSignIndex = Math.floor(((natalPos.Sun.lon % 360 + 360) % 360) / 30);
    const nextSign = (natalSignIndex + 1) % 12;

    let bracketLo = -1;
    let bracketHi = -1;
    for (let age = 1; age <= 100; age++) {
      const pos = await getPositionsAt(HARTFORD_JD + age);
      const si = Math.floor(((pos.Sun.lon % 360 + 360) % 360) / 30);
      if (si === nextSign) {
        bracketLo = age - 1;
        bracketHi = age;
        break;
      }
    }

    if (bracketLo < 0) return;

    // Manual bisection
    let lo = bracketLo;
    let hi = bracketHi;
    for (let i = 0; i < 10; i++) {
      const mid = (lo + hi) / 2;
      const pos = await getPositionsAt(HARTFORD_JD + mid);
      const midSign = Math.floor(((pos.Sun.lon % 360 + 360) % 360) / 30);
      if (midSign !== nextSign) {
        lo = mid;
      } else {
        hi = mid;
      }
    }
    const manualJd = HARTFORD_JD + (lo + hi) / 2;

    // Endpoint
    const res = await postRefine({
      items: [{
        kind: "sign-bisect",
        body: "Sun",
        natalJd: HARTFORD_JD,
        loAge: bracketLo,
        hiAge: bracketHi,
        targetSign: nextSign,
        bisectMaxIter: 10,
      }],
    });
    const data = (await res.json()) as {
      results: Array<{ jd: number }>;
    };

    expect(data.results[0].jd).toBe(manualJd);
  });
});

// ---------------------------------------------------------------------------
// /v1/refine-crossings — Mixed kinds
// ---------------------------------------------------------------------------

describe("POST /v1/refine-crossings — mixed kinds", () => {
  it("handles a batch with different kinds, one per slot", async () => {
    const natalPos = await getPositionsAt(HARTFORD_JD);
    const natalSunLon = natalPos.Sun.lon;

    const res = await postRefine({
      items: [
        {
          kind: "newton",
          body: "Sun",
          targetLon: natalSunLon,
          approxJd: HARTFORD_JD + 365.2422 * 10,
          meanMotion: 0.9856,
        },
        {
          kind: "bisect",
          body: "Jupiter",
          targetLon: natalPos.Jupiter.lon + 5,
          loJd: HARTFORD_JD + 100,
          hiJd: HARTFORD_JD + 200,
        },
      ],
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      results: Array<{ jd?: number; error?: string; converged?: boolean }>;
    };

    expect(data.results).toHaveLength(2);
    // First item (newton) should converge
    expect(data.results[0].converged).toBe(true);
    expect(data.results[0].jd).toBeDefined();
    // Second item (bisect) — may or may not converge depending on whether
    // Jupiter crosses that longitude in the bracket
    expect(data.results[1].jd).toBeDefined();
  });

  it("failed items return error without blocking other items", async () => {
    const natalPos = await getPositionsAt(HARTFORD_JD);

    const res = await postRefine({
      items: [
        {
          kind: "newton",
          body: "Sun",
          targetLon: natalPos.Sun.lon,
          approxJd: HARTFORD_JD + 365.2422,
          meanMotion: 0.9856,
        },
        // This item will fail because meanMotion causes wild divergence
        // but the endpoint still succeeds at the batch level
        {
          kind: "newton",
          body: "Sun",
          targetLon: natalPos.Sun.lon,
          approxJd: HARTFORD_JD + 365.2422 * 2,
          meanMotion: 0.0001,
          maxIter: 3,
        },
      ],
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      results: Array<{ jd?: number; converged?: boolean; error?: string }>;
    };

    expect(data.results).toHaveLength(2);
    // First item should converge normally
    expect(data.results[0].converged).toBe(true);
    // Second item: with very small meanMotion, Newton's method diverges wildly
    // (JD goes out of range), producing an error result. The batch still succeeds.
    // It may have either an error string or a jd with converged: false.
    const second = data.results[1];
    if ("error" in second) {
      expect(typeof second.error).toBe("string");
    } else {
      expect(second.converged).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// /v1/batch-houses — Auth and validation
// ---------------------------------------------------------------------------

describe("POST /v1/batch-houses — auth", () => {
  it("returns 401 on missing secret", async () => {
    const request = new Request("http://localhost/v1/batch-houses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jd: HARTFORD_JD, locations: [{ lat: 0, lon: 0 }] }),
    });
    const ctx = createExecutionContext();
    const res = await worker.fetch(request, makeEnv(), ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(401);
  });

  it("returns 401 on wrong secret", async () => {
    const request = new Request("http://localhost/v1/batch-houses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Secret": "wrong-secret",
      },
      body: JSON.stringify({ jd: HARTFORD_JD, locations: [{ lat: 0, lon: 0 }] }),
    });
    const ctx = createExecutionContext();
    const res = await worker.fetch(request, makeEnv(), ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(401);
  });
});

describe("POST /v1/batch-houses — validation", () => {
  it("returns 400 when jd is out of range", async () => {
    const res = await postBatchHouses({
      jd: 1000000,
      locations: [{ lat: 0, lon: 0 }],
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when locations is empty", async () => {
    const res = await postBatchHouses({
      jd: HARTFORD_JD,
      locations: [],
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when locations exceeds 50", async () => {
    const locations = Array.from({ length: 51 }, () => ({ lat: 0, lon: 0 }));
    const res = await postBatchHouses({ jd: HARTFORD_JD, locations });
    expect(res.status).toBe(400);
  });

  it("returns 400 when |lat| > 90", async () => {
    const res = await postBatchHouses({
      jd: HARTFORD_JD,
      locations: [{ lat: 91, lon: 0 }],
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when |lon| > 180", async () => {
    const res = await postBatchHouses({
      jd: HARTFORD_JD,
      locations: [{ lat: 0, lon: 181 }],
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 on invalid JSON", async () => {
    const request = new Request("http://localhost/v1/batch-houses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Secret": TEST_SECRET,
      },
      body: "not json",
    });
    const ctx = createExecutionContext();
    const res = await worker.fetch(request, makeEnv(), ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// /v1/batch-houses — Successful operations
// ---------------------------------------------------------------------------

describe("POST /v1/batch-houses — functionality", () => {
  it("returns houses for a single location", async () => {
    const res = await postBatchHouses({
      jd: HARTFORD_JD,
      locations: [{ lat: HARTFORD_LAT, lon: HARTFORD_LON }],
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      results: Array<{
        lat: number;
        lon: number;
        houses: { cusps: number[]; asc: number; mc: number };
      }>;
    };

    expect(data.results).toHaveLength(1);
    expect(data.results[0].lat).toBe(HARTFORD_LAT);
    expect(data.results[0].lon).toBe(HARTFORD_LON);
    expect(data.results[0].houses.cusps).toHaveLength(12);
    expect(typeof data.results[0].houses.asc).toBe("number");
    expect(typeof data.results[0].houses.mc).toBe("number");
  });

  it("batch-houses matches individual /v1/chart houses exactly", async () => {
    const locations = [
      { lat: HARTFORD_LAT, lon: HARTFORD_LON },
      { lat: 36.16, lon: -86.78 },     // Nashville
      { lat: 40.7128, lon: -74.006 },   // NYC
      { lat: -33.8688, lon: 151.2093 }, // Sydney
      { lat: 51.5074, lon: -0.1278 },   // London
    ];

    // Get houses via batch-houses
    const batchRes = await postBatchHouses({
      jd: HARTFORD_JD,
      locations,
    });
    expect(batchRes.status).toBe(200);
    const batchData = (await batchRes.json()) as {
      results: Array<{
        lat: number;
        lon: number;
        houses: { cusps: number[]; asc: number; mc: number };
      }>;
    };

    expect(batchData.results).toHaveLength(locations.length);

    // Compare each location's houses against individual /v1/chart call
    for (let i = 0; i < locations.length; i++) {
      const chartRes = await postChart({
        jd: HARTFORD_JD,
        lat: locations[i].lat,
        lon: locations[i].lon,
      });
      expect(chartRes.status).toBe(200);
      const chartData = (await chartRes.json()) as {
        houses: { cusps: number[]; asc: number; mc: number };
      };

      // Houses should match exactly (same WASM, same JD, same lat/lon)
      for (let c = 0; c < 12; c++) {
        expect(
          batchData.results[i].houses.cusps[c],
          `Location ${i} cusp ${c + 1}`,
        ).toBe(chartData.houses.cusps[c]);
      }
      expect(batchData.results[i].houses.asc).toBe(chartData.houses.asc);
      expect(batchData.results[i].houses.mc).toBe(chartData.houses.mc);
    }
  });

  it("accepts exactly 50 locations", async () => {
    const locations = Array.from({ length: 50 }, (_, i) => ({
      lat: -80 + (i * 160) / 49,
      lon: -170 + (i * 340) / 49,
    }));
    const res = await postBatchHouses({ jd: HARTFORD_JD, locations });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      results: Array<{ lat: number; lon: number; houses: unknown }>;
    };
    expect(data.results).toHaveLength(50);
  });

  it("preserves order of results matching input locations", async () => {
    const locations = [
      { lat: 51.5074, lon: -0.1278 },   // London
      { lat: -33.8688, lon: 151.2093 }, // Sydney
      { lat: HARTFORD_LAT, lon: HARTFORD_LON },
    ];

    const res = await postBatchHouses({ jd: HARTFORD_JD, locations });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      results: Array<{ lat: number; lon: number }>;
    };

    expect(data.results).toHaveLength(3);
    expect(data.results[0].lat).toBe(locations[0].lat);
    expect(data.results[0].lon).toBe(locations[0].lon);
    expect(data.results[1].lat).toBe(locations[1].lat);
    expect(data.results[1].lon).toBe(locations[1].lon);
    expect(data.results[2].lat).toBe(locations[2].lat);
    expect(data.results[2].lon).toBe(locations[2].lon);
  });
});

// ---------------------------------------------------------------------------
// /v1/refine-crossings — positions cross-check for all kinds
// ---------------------------------------------------------------------------

describe("POST /v1/refine-crossings — positions cross-check", () => {
  it("all refinement results include positions matching /v1/chart at the same JD", async () => {
    const natalPos = await getPositionsAt(HARTFORD_JD);
    const natalSunLon = natalPos.Sun.lon;

    const res = await postRefine({
      items: [
        {
          kind: "newton",
          body: "Sun",
          targetLon: natalSunLon,
          approxJd: HARTFORD_JD + 365.2422 * 3,
          meanMotion: 0.9856,
        },
      ],
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      results: Array<{ jd: number; positions: ChartPositions }>;
    };

    const result = data.results[0];

    // Get positions at the exact same JD via /v1/chart
    const chartPos = await getPositionsAt(result.jd);

    // All 12 bodies should match exactly
    const bodies = [
      "Sun", "Moon", "Mercury", "Venus", "Mars",
      "Jupiter", "Saturn", "Uranus", "Neptune", "Pluto",
      "TrueNode", "Chiron",
    ];

    for (const body of bodies) {
      expect(
        result.positions[body].lon,
        `${body}.lon`,
      ).toBe(chartPos[body].lon);
      expect(
        result.positions[body].lat,
        `${body}.lat`,
      ).toBe(chartPos[body].lat);
      expect(
        result.positions[body].speed,
        `${body}.speed`,
      ).toBe(chartPos[body].speed);
      expect(
        result.positions[body].ra,
        `${body}.ra`,
      ).toBe(chartPos[body].ra);
      expect(
        result.positions[body].decl,
        `${body}.decl`,
      ).toBe(chartPos[body].decl);
    }
  });
});
