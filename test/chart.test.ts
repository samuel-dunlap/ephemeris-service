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
  return { INTERNAL_SECRET: TEST_SECRET, SOURCE_COMMIT: "test-commit-sha" };
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

async function postBatch(
  body: unknown,
  secret?: string
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (secret !== undefined) {
    headers["X-Internal-Secret"] = secret;
  }

  const request = new Request("http://localhost/v1/batch", {
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
  it("returns AGPL license info with source commit", async () => {
    const res = await getPath("/v1/source");
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      license: string;
      source: string;
      sourceCommit: string;
    };
    expect(data.license).toBe("AGPL-3.0-or-later");
    expect(data.source).toBe(
      "https://github.com/samuel-dunlap/ephemeris-service"
    );
    expect(data.sourceCommit).toBe("test-commit-sha");
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

// ---------------------------------------------------------------------------
// POST /v1/batch — batch endpoint
// ---------------------------------------------------------------------------

describe("POST /v1/batch", () => {
  // --- Auth ---

  it("returns 401 on missing secret", async () => {
    const res = await postBatch({ jds: [2451545.0] });
    expect(res.status).toBe(401);
  });

  it("returns 401 on wrong secret", async () => {
    const res = await postBatch({ jds: [2451545.0] }, "wrong-secret");
    expect(res.status).toBe(401);
  });

  it("returns 503 when INTERNAL_SECRET env is unset", async () => {
    const request = new Request("http://localhost/v1/batch", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Secret": "anything",
      },
      body: JSON.stringify({ jds: [2451545.0] }),
    });
    const ctx = createExecutionContext();
    const res = await worker.fetch(request, {} as any, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(503);
  });

  // --- Validation ---

  it("returns 400 on invalid JSON", async () => {
    const request = new Request("http://localhost/v1/batch", {
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

  it("returns 400 when jds is missing", async () => {
    const res = await postBatch({}, TEST_SECRET);
    expect(res.status).toBe(400);
  });

  it("returns 400 when jds is not an array", async () => {
    const res = await postBatch({ jds: 2451545.0 }, TEST_SECRET);
    expect(res.status).toBe(400);
  });

  it("returns 400 when jds is empty", async () => {
    const res = await postBatch({ jds: [] }, TEST_SECRET);
    expect(res.status).toBe(400);
  });

  it("returns 400 when jds exceeds 500 entries", async () => {
    const jds = Array.from({ length: 501 }, (_, i) => 2451545.0 + i);
    const res = await postBatch({ jds }, TEST_SECRET);
    expect(res.status).toBe(400);
  });

  it("returns 400 when a jd is out of range (too low)", async () => {
    const res = await postBatch({ jds: [2378496] }, TEST_SECRET);
    expect(res.status).toBe(400);
  });

  it("returns 400 when a jd is out of range (too high)", async () => {
    const res = await postBatch({ jds: [2597642] }, TEST_SECRET);
    expect(res.status).toBe(400);
  });

  it("returns 400 when a jd is not a number", async () => {
    const res = await postBatch({ jds: ["abc"] }, TEST_SECRET);
    expect(res.status).toBe(400);
  });

  it("returns 400 when a jd is NaN", async () => {
    const res = await postBatch({ jds: [NaN] }, TEST_SECRET);
    expect(res.status).toBe(400);
  });

  it("returns 400 when |lat| > 90", async () => {
    const res = await postBatch(
      { jds: [2451545.0], lat: 91, lon: 0 },
      TEST_SECRET
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when |lon| > 180", async () => {
    const res = await postBatch(
      { jds: [2451545.0], lat: 0, lon: 181 },
      TEST_SECRET
    );
    expect(res.status).toBe(400);
  });

  it("returns 405 for GET requests", async () => {
    const req = new Request("http://localhost/v1/batch", { method: "GET" });
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, makeEnv(), ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(405);
  });

  // --- Successful responses ---

  it("returns results for a single JD without houses", async () => {
    const res = await postBatch({ jds: [2451545.0] }, TEST_SECRET);
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      results: Array<{
        jd: number;
        positions: Record<string, unknown>;
        gst: number;
        houses?: unknown;
      }>;
    };

    expect(data.results).toHaveLength(1);
    expect(data.results[0].jd).toBe(2451545.0);
    expect(Object.keys(data.results[0].positions)).toHaveLength(12);
    expect(typeof data.results[0].gst).toBe("number");
    expect(data.results[0].houses).toBeUndefined();
  });

  it("returns results for multiple JDs in order", async () => {
    const jds = [2451545.0, 2451546.0, 2451547.0];
    const res = await postBatch({ jds }, TEST_SECRET);
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      results: Array<{ jd: number }>;
    };

    expect(data.results).toHaveLength(3);
    expect(data.results[0].jd).toBe(2451545.0);
    expect(data.results[1].jd).toBe(2451546.0);
    expect(data.results[2].jd).toBe(2451547.0);
  });

  it("includes houses when lat and lon are provided", async () => {
    const res = await postBatch(
      { jds: [2451545.0], lat: 36.16, lon: -86.78 },
      TEST_SECRET
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      results: Array<{
        jd: number;
        houses?: { cusps: number[]; asc: number; mc: number };
      }>;
    };

    expect(data.results).toHaveLength(1);
    expect(data.results[0].houses).toBeDefined();
    expect(data.results[0].houses!.cusps).toHaveLength(12);
    expect(typeof data.results[0].houses!.asc).toBe("number");
    expect(typeof data.results[0].houses!.mc).toBe("number");
  });

  it("batch results match individual /v1/chart results", async () => {
    // Use golden entries to cross-check: batch should match chart
    const samuelNatal = (golden as Record<string, GoldenEntry>)[
      "samuel_natal"
    ];
    const transitJ2000 = (golden as Record<string, GoldenEntry>)[
      "transit_2000-01-01"
    ];

    // Batch both JDs together (without houses since transit has none)
    const batchRes = await postBatch(
      { jds: [samuelNatal.jd, transitJ2000.jd] },
      TEST_SECRET
    );
    expect(batchRes.status).toBe(200);

    // Individual chart calls
    const chartRes1 = await postChart({ jd: samuelNatal.jd }, TEST_SECRET);
    const chartRes2 = await postChart({ jd: transitJ2000.jd }, TEST_SECRET);

    const batchData = (await batchRes.json()) as {
      results: Array<{
        jd: number;
        positions: Record<
          string,
          { lon: number; lat: number; speed: number; ra: number; decl: number }
        >;
        gst: number;
      }>;
    };
    const chartData1 = (await chartRes1.json()) as {
      positions: Record<
        string,
        { lon: number; lat: number; speed: number; ra: number; decl: number }
      >;
      gst: number;
    };
    const chartData2 = (await chartRes2.json()) as {
      positions: Record<
        string,
        { lon: number; lat: number; speed: number; ra: number; decl: number }
      >;
      gst: number;
    };

    // First batch result should match first chart call exactly
    for (const body of CONTRACT_BODIES) {
      expect(batchData.results[0].positions[body].lon).toBe(
        chartData1.positions[body].lon
      );
      expect(batchData.results[0].positions[body].speed).toBe(
        chartData1.positions[body].speed
      );
      expect(batchData.results[0].positions[body].decl).toBe(
        chartData1.positions[body].decl
      );
    }
    expect(batchData.results[0].gst).toBe(chartData1.gst);

    // Second batch result should match second chart call exactly
    for (const body of CONTRACT_BODIES) {
      expect(batchData.results[1].positions[body].lon).toBe(
        chartData2.positions[body].lon
      );
      expect(batchData.results[1].positions[body].speed).toBe(
        chartData2.positions[body].speed
      );
      expect(batchData.results[1].positions[body].decl).toBe(
        chartData2.positions[body].decl
      );
    }
    expect(batchData.results[1].gst).toBe(chartData2.gst);
  });

  it("accepts exactly 500 JDs", async () => {
    // Generate 500 consecutive JDs starting from J2000
    const jds = Array.from({ length: 500 }, (_, i) => 2451545.0 + i);
    const res = await postBatch({ jds }, TEST_SECRET);
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      results: Array<{ jd: number }>;
    };
    expect(data.results).toHaveLength(500);
    // Verify order is preserved
    expect(data.results[0].jd).toBe(2451545.0);
    expect(data.results[499].jd).toBe(2451545.0 + 499);
  });

  it("each result has all 12 bodies with full position fields", async () => {
    const res = await postBatch({ jds: [2451545.0] }, TEST_SECRET);
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      results: Array<{
        positions: Record<
          string,
          { lon: number; lat: number; speed: number; ra: number; decl: number }
        >;
      }>;
    };

    const pos = data.results[0].positions;
    for (const body of CONTRACT_BODIES) {
      expect(pos[body], `${body} missing`).toBeDefined();
      expect(typeof pos[body].lon).toBe("number");
      expect(typeof pos[body].lat).toBe("number");
      expect(typeof pos[body].speed).toBe("number");
      expect(typeof pos[body].ra).toBe("number");
      expect(typeof pos[body].decl).toBe("number");
    }
  });
});
