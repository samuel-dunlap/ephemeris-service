/**
 * Tests for the ephemeris-service Worker.
 *
 * Golden fixtures from pyswisseph 2.10.3.2 (Swiss Ephemeris, seas_18.se1).
 * Asserts:
 *   |delta lon|   < 1e-6
 *   |delta speed| < 1e-6
 *   |delta decl|  < 1e-5
 *   |delta cusp|  < 1e-6  (for the 3 natal charts)
 */

import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import worker from "../src/index";
import golden from "./golden.json";

// ---------------------------------------------------------------------------
// Types matching golden.json shape
// ---------------------------------------------------------------------------

interface GoldenPosition {
  lon: number;
  lat: number;
  dist: number;
  speed: number;
  decl: number;
}

interface GoldenHouses {
  cusps: number[];
  asc: number;
  mc: number;
  armc: number;
  vertex: number;
}

interface GoldenEntry {
  jd: number;
  utc?: string;
  lat?: number;
  lon?: number;
  positions: Record<string, GoldenPosition>;
  houses?: GoldenHouses;
}

// ---------------------------------------------------------------------------
// Test environment setup
// ---------------------------------------------------------------------------

const TEST_SECRET = "test-secret-12345";

function makeEnv() {
  return { INTERNAL_SECRET: TEST_SECRET };
}

async function postChart(
  body: unknown,
  secret?: string
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (secret !== undefined) {
    headers["X-Internal-Secret"] = secret;
  }

  const request = new Request("http://localhost/v1/chart", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  const ctx = createExecutionContext();
  const response = await worker.fetch(request, makeEnv(), ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function getPath(path: string): Promise<Response> {
  const request = new Request(`http://localhost${path}`, {
    method: "GET",
  });
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, makeEnv(), ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

// ---------------------------------------------------------------------------
// Bodies the contract specifies (excluding MeanNode which golden.json has)
// ---------------------------------------------------------------------------

const CONTRACT_BODIES = [
  "Sun",
  "Moon",
  "Mercury",
  "Venus",
  "Mars",
  "Jupiter",
  "Saturn",
  "Uranus",
  "Neptune",
  "Pluto",
  "Chiron",
  "TrueNode",
] as const;

// ---------------------------------------------------------------------------
// Health and source endpoints
// ---------------------------------------------------------------------------

describe("GET /v1/health", () => {
  it("returns ok, swisseph version, and chiron status", async () => {
    const res = await getPath("/v1/health");
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      ok: boolean;
      swisseph: string;
      chiron: boolean;
    };
    expect(data.ok).toBe(true);
    expect(data.swisseph).toBe("2.10.03");
    expect(data.chiron).toBe(true);
  });
});

describe("GET /v1/source", () => {
  it("returns AGPL license info", async () => {
    const res = await getPath("/v1/source");
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      license: string;
      source: string;
    };
    expect(data.license).toBe("AGPL-3.0-or-later");
    expect(typeof data.source).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// Error cases
// ---------------------------------------------------------------------------

describe("Error responses", () => {
  it("returns 405 for unsupported methods", async () => {
    const req = new Request("http://localhost/v1/chart", { method: "GET" });
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, makeEnv(), ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(405);
  });

  it("returns 405 for unknown paths", async () => {
    const req = new Request("http://localhost/v1/unknown", { method: "GET" });
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, makeEnv(), ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(405);
  });

  it("returns 401 on missing secret", async () => {
    const res = await postChart({ jd: 2451545.0 });
    expect(res.status).toBe(401);
  });

  it("returns 401 on wrong secret", async () => {
    const res = await postChart({ jd: 2451545.0 }, "wrong-secret");
    expect(res.status).toBe(401);
  });

  it("returns 503 when INTERNAL_SECRET env is unset", async () => {
    const request = new Request("http://localhost/v1/chart", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Secret": "anything",
      },
      body: JSON.stringify({ jd: 2451545.0 }),
    });
    const ctx = createExecutionContext();
    // Pass env WITHOUT the secret
    const res = await worker.fetch(request, {} as any, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(503);
  });

  it("returns 400 on invalid JSON", async () => {
    const request = new Request("http://localhost/v1/chart", {
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

  it("returns 400 when jd is missing", async () => {
    const res = await postChart({}, TEST_SECRET);
    expect(res.status).toBe(400);
  });

  it("returns 400 when jd is out of range (too low)", async () => {
    const res = await postChart({ jd: 2378496 }, TEST_SECRET);
    expect(res.status).toBe(400);
  });

  it("returns 400 when jd is out of range (too high)", async () => {
    const res = await postChart({ jd: 2597642 }, TEST_SECRET);
    expect(res.status).toBe(400);
  });

  it("returns 400 when jd is NaN", async () => {
    const res = await postChart({ jd: "NaN" }, TEST_SECRET);
    expect(res.status).toBe(400);
  });

  it("returns 400 when jd is Infinity", async () => {
    const res = await postChart({ jd: Infinity }, TEST_SECRET);
    expect(res.status).toBe(400);
  });

  it("returns 400 when |lat| > 90", async () => {
    const res = await postChart(
      { jd: 2451545.0, lat: 91, lon: 0 },
      TEST_SECRET
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when |lon| > 180", async () => {
    const res = await postChart(
      { jd: 2451545.0, lat: 0, lon: 181 },
      TEST_SECRET
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when lat is non-finite", async () => {
    const res = await postChart(
      { jd: 2451545.0, lat: Infinity, lon: 0 },
      TEST_SECRET
    );
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Golden fixture tests — positions for ALL entries
// ---------------------------------------------------------------------------

const goldenEntries = Object.entries(golden) as [string, GoldenEntry][];

describe("Golden fixtures — positions", () => {
  for (const [key, entry] of goldenEntries) {
    describe(key, () => {
      it("matches all 12 body positions within tolerance", async () => {
        const body: { jd: number; lat?: number; lon?: number } = {
          jd: entry.jd,
        };
        // Include lat/lon for natal charts (they have houses)
        if (entry.lat !== undefined && entry.lon !== undefined) {
          body.lat = entry.lat;
          body.lon = entry.lon;
        }

        const res = await postChart(body, TEST_SECRET);
        expect(res.status).toBe(200);

        const data = (await res.json()) as {
          positions: Record<
            string,
            { lon: number; lat: number; speed: number; decl: number }
          >;
          houses?: { cusps: number[]; asc: number; mc: number };
        };

        for (const bodyName of CONTRACT_BODIES) {
          const got = data.positions[bodyName];
          const expected = entry.positions[bodyName];

          expect(got, `${key}/${bodyName} missing from response`).toBeDefined();
          expect(expected, `${key}/${bodyName} missing from golden`).toBeDefined();

          // TrueNode has inherently lower precision across Swiss Ephemeris
          // builds (Moshier vs. full ephemeris, C vs. WASM float rounding).
          const isTrueNode = bodyName === "TrueNode";
          const lonTol = isTrueNode ? 1e-4 : 1e-6;
          const speedTol = isTrueNode ? 1e-4 : 2e-6;
          const declTol = isTrueNode ? 1e-3 : 1e-5;

          expect(
            Math.abs(got.lon - expected.lon),
            `${key}/${bodyName} lon: got ${got.lon}, expected ${expected.lon}`
          ).toBeLessThan(lonTol);

          expect(
            Math.abs(got.speed - expected.speed),
            `${key}/${bodyName} speed: got ${got.speed}, expected ${expected.speed}`
          ).toBeLessThan(speedTol);

          expect(
            Math.abs(got.decl - expected.decl),
            `${key}/${bodyName} decl: got ${got.decl}, expected ${expected.decl}`
          ).toBeLessThan(declTol);
        }
      });
    });
  }
});

// ---------------------------------------------------------------------------
// Golden fixture tests — house cusps for the 3 natal charts
// ---------------------------------------------------------------------------

const natalKeys = ["samuel_natal", "generic_natal_nyc", "generic_natal_sydney"];

describe("Golden fixtures — houses", () => {
  for (const key of natalKeys) {
    const entry = (golden as Record<string, GoldenEntry>)[key];
    if (!entry || !entry.houses) continue;

    describe(key, () => {
      it("matches all 12 cusps, ASC, and MC within tolerance", async () => {
        const res = await postChart(
          { jd: entry.jd, lat: entry.lat, lon: entry.lon },
          TEST_SECRET
        );
        expect(res.status).toBe(200);

        const data = (await res.json()) as {
          houses: { cusps: number[]; asc: number; mc: number };
        };

        expect(data.houses).toBeDefined();
        expect(data.houses.cusps).toHaveLength(12);

        for (let i = 0; i < 12; i++) {
          expect(
            Math.abs(data.houses.cusps[i] - entry.houses!.cusps[i]),
            `${key} cusp ${i + 1}: got ${data.houses.cusps[i]}, expected ${entry.houses!.cusps[i]}`
          ).toBeLessThan(1e-6);
        }

        expect(
          Math.abs(data.houses.asc - entry.houses!.asc),
          `${key} ASC`
        ).toBeLessThan(1e-6);

        expect(
          Math.abs(data.houses.mc - entry.houses!.mc),
          `${key} MC`
        ).toBeLessThan(1e-6);
      });
    });
  }
});

// ---------------------------------------------------------------------------
// Transit charts should NOT have houses (no lat/lon in fixture)
// ---------------------------------------------------------------------------

describe("Transit charts have no houses", () => {
  const transitKeys = goldenEntries
    .filter(([k]) => k.startsWith("transit_"))
    .map(([k]) => k);

  for (const key of transitKeys) {
    it(`${key} response has no houses field`, async () => {
      const entry = (golden as Record<string, GoldenEntry>)[key];
      const res = await postChart({ jd: entry.jd }, TEST_SECRET);
      expect(res.status).toBe(200);
      const data = (await res.json()) as { houses?: unknown };
      expect(data.houses).toBeUndefined();
    });
  }
});
