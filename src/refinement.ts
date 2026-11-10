/**
 * refinement.ts — Server-side refinement loops for ephemeris-service.
 *
 * Each algorithm is copied verbatim from astro-engine so that results are
 * byte-identical to the per-call path. Source locations:
 *
 *   signedSeparation  — astro-engine/src/compute/transit/timelords.ts:230-233
 *   angleDiff          — astro-engine/src/compute/unified-compute.ts:3783-3787
 *   normDeg            — astro-engine/src/compute/hd/design-date.ts:17-19
 *   signedDiff         — astro-engine/src/compute/hd/design-date.ts:25-31
 *   signIndex          — astro-engine/src/compute/transit/timelords.ts:35-37
 *   findReturn/newton  — astro-engine/src/compute/transit/timelords.ts:244-269
 *   bisectCrossing     — astro-engine/src/compute/unified-compute.ts:3792-3818
 *   refineCrossing     — astro-engine/src/compute/unified-compute.ts:2925-2953
 *   stationRefine      — astro-engine/src/compute/unified-compute.ts:1434-1466
 *   signBisect         — astro-engine/src/compute/unified-compute.ts:1350-1366
 */

import {
  computePositions,
  computeHouses,
  type Positions,
  type HouseCusps,
  type BodyName,
  BODY_NAMES,
} from "./swisseph";

// ---------------------------------------------------------------------------
// Geometric helpers (verbatim copies from astro-engine)
// ---------------------------------------------------------------------------

/**
 * Signed shortest separation from `current` to `target` on the 360-degree
 * circle, in the range (-180, 180].
 * Source: timelords.ts:230-233
 */
export function signedSeparation(current: number, target: number): number {
  const raw = ((target - current) % 360 + 360) % 360;
  return raw > 180 ? raw - 360 : raw;
}

/**
 * Signed angular difference in [-180, 180].
 * Source: unified-compute.ts:3783-3787
 */
export function angleDiff(from: number, to: number): number {
  let d = ((to - from) % 360 + 360) % 360;
  if (d > 180) d -= 360;
  return d;
}

/**
 * Normalise an angle into [0, 360).
 * Source: design-date.ts:17-19
 */
export function normDeg(d: number): number {
  return ((d % 360) + 360) % 360;
}

/**
 * Signed shortest-arc difference a - b, result in (-180, 180].
 * Source: design-date.ts:25-31
 */
export function signedDiff(a: number, b: number): number {
  let d = normDeg(a) - normDeg(b);
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

/**
 * Return the zodiac sign index (0-11) for a longitude.
 * Source: timelords.ts:35-37
 */
export function signIndex(lon: number): number {
  return Math.floor(((lon % 360) + 360) % 360 / 30);
}

// ---------------------------------------------------------------------------
// Positions output shape (matches /v1/chart contract)
// ---------------------------------------------------------------------------

type PositionsOut = Record<
  string,
  { lon: number; lat: number; speed: number; ra: number; decl: number }
>;

function shapePositions(positions: Positions): PositionsOut {
  const out: PositionsOut = {};
  for (const [name, pos] of Object.entries(positions)) {
    out[name] = {
      lon: pos.lon,
      lat: pos.lat,
      speed: pos.speed,
      ra: pos.ra,
      decl: pos.decl,
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface RefineCrossingResult {
  jd: number;
  positions: PositionsOut;
  converged: boolean;
  iterations: number;
}

export interface RefineCrossingError {
  error: string;
}

export type RefineCrossingItemResult = RefineCrossingResult | RefineCrossingError;

// ---------------------------------------------------------------------------
// Refinement algorithms
// ---------------------------------------------------------------------------

/**
 * Newton's method to find the exact JD where a body reaches targetLon.
 * Source: timelords.ts:244-269 (findReturn)
 */
export async function newtonRefine(
  body: BodyName,
  targetLon: number,
  approxJd: number,
  meanMotion: number,
  maxIter: number,
  tolerance: number,
): Promise<RefineCrossingResult> {
  let jd = approxJd;
  let iterations = 0;
  for (let i = 0; i < maxIter; i++) {
    const positions = await computePositions(jd);
    iterations++;
    const currentLon = positions[body].lon;
    const sep = signedSeparation(currentLon, targetLon);
    if (Math.abs(sep) < tolerance) {
      return { jd, positions: shapePositions(positions), converged: true, iterations };
    }
    jd += sep / meanMotion;
  }
  // Did not converge — return the last position
  const positions = await computePositions(jd);
  return { jd, positions: shapePositions(positions), converged: false, iterations };
}

/**
 * Bisection to find exact JD where a body reaches targetLon within [loJd, hiJd].
 * Source: unified-compute.ts:3792-3818 (bisectCrossing)
 */
export async function bisectRefine(
  body: BodyName,
  targetLon: number,
  loJd: number,
  hiJd: number,
  tolerance: number,
  maxIter: number,
): Promise<RefineCrossingResult> {
  let lo = loJd;
  let hi = hiJd;
  const loPositions = await computePositions(lo);
  let dLo = angleDiff(targetLon, loPositions[body].lon);
  let iterations = 1;
  for (let i = 0; i < maxIter; i++) {
    if (hi - lo < tolerance) break;
    const mid = (lo + hi) / 2;
    const midPositions = await computePositions(mid);
    iterations++;
    const dMid = angleDiff(targetLon, midPositions[body].lon);
    if (dMid === 0) {
      return { jd: mid, positions: shapePositions(midPositions), converged: true, iterations };
    }
    if ((dLo > 0) === (dMid > 0)) {
      lo = mid;
      dLo = dMid;
    } else {
      hi = mid;
    }
  }
  const finalJd = (lo + hi) / 2;
  const positions = await computePositions(finalJd);
  return { jd: finalJd, positions: shapePositions(positions), converged: true, iterations };
}

/**
 * Lunation bisection: find exact JD where Sun-Moon elongation crosses target
 * (0 for new moon, 180 for full moon).
 * Source: unified-compute.ts:2925-2953 (refineCrossing)
 */
export async function lunationBisect(
  loJd: number,
  hiJd: number,
  target: 0 | 180,
  maxIter: number,
): Promise<RefineCrossingResult> {
  let lo = loJd;
  let hi = hiJd;
  let iterations = 0;
  for (let i = 0; i < maxIter; i++) {
    const mid = (lo + hi) / 2;
    const pos = await computePositions(mid);
    iterations++;
    const elong = ((pos.Moon.lon - pos.Sun.lon) % 360 + 360) % 360;
    let offset: number;
    if (target === 0) {
      offset = elong > 180 ? elong - 360 : elong;
    } else {
      offset = elong - 180;
      if (offset > 180) offset -= 360;
      if (offset < -180) offset += 360;
    }
    if (offset < 0) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  const exactJd = (lo + hi) / 2;
  const positions = await computePositions(exactJd);
  iterations++;
  return { jd: exactJd, positions: shapePositions(positions), converged: true, iterations };
}

/**
 * Station refinement: sub-step + bisection to find exact station JD for a
 * progressed body.
 * Source: unified-compute.ts:1434-1466
 *
 * The station is detected as a speed sign flip. loAge/hiAge define a 1-year
 * bracket in "progressed age" space (JD = natalJd + age).
 */
export async function stationRefine(
  body: BodyName,
  natalJd: number,
  loAge: number,
  hiAge: number,
  subStep: number,
  bisectIters: number,
): Promise<RefineCrossingResult> {
  let lo = loAge;
  let hi = hiAge;
  let iterations = 0;

  // Get initial speed at lo
  const loPos = await computePositions(natalJd + lo);
  let spdLo = loPos[body].speed;
  iterations++;

  // Sub-step refinement: narrow from the bracket to a sub-step-sized bracket
  for (let subAge = lo + subStep; subAge <= hi; subAge += subStep) {
    const pos = await computePositions(natalJd + subAge);
    iterations++;
    const spd = pos[body].speed;
    if ((spdLo > 0 && spd <= 0) || (spdLo < 0 && spd >= 0)) {
      hi = subAge;
      break;
    }
    lo = subAge;
    spdLo = spd;
  }

  // Bisection within the narrowed bracket
  let bisectSpdLo = spdLo;
  for (let i = 0; i < bisectIters; i++) {
    const mid = (lo + hi) / 2;
    const pos = await computePositions(natalJd + mid);
    iterations++;
    const midSpd = pos[body].speed;
    if ((bisectSpdLo > 0 && midSpd > 0) || (bisectSpdLo < 0 && midSpd < 0)) {
      lo = mid;
      bisectSpdLo = midSpd;
    } else {
      hi = mid;
    }
  }

  const finalAge = (lo + hi) / 2;
  const finalJd = natalJd + finalAge;
  const positions = await computePositions(finalJd);
  iterations++;
  return { jd: finalJd, positions: shapePositions(positions), converged: true, iterations };
}

/**
 * Sign bisection: find the exact age where a body enters a given zodiac sign
 * via bisection within a 1-year bracket. Used for progressed sign-change
 * detection.
 * Source: unified-compute.ts:1350-1366
 */
export async function signBisect(
  body: BodyName,
  natalJd: number,
  loAge: number,
  hiAge: number,
  targetSign: number,
  maxIter: number,
): Promise<RefineCrossingResult> {
  let lo = loAge;
  let hi = hiAge;
  let iterations = 0;

  for (let i = 0; i < maxIter; i++) {
    const mid = (lo + hi) / 2;
    const pos = await computePositions(natalJd + mid);
    iterations++;
    const midSign = signIndex(pos[body].lon);
    if (midSign !== targetSign) {
      lo = mid;
    } else {
      hi = mid;
    }
  }

  const finalAge = (lo + hi) / 2;
  const finalJd = natalJd + finalAge;
  const positions = await computePositions(finalJd);
  iterations++;
  return { jd: finalJd, positions: shapePositions(positions), converged: true, iterations };
}

// ---------------------------------------------------------------------------
// Batch houses
// ---------------------------------------------------------------------------

export interface BatchHousesResult {
  lat: number;
  lon: number;
  houses: { cusps: number[]; asc: number; mc: number; placidus: boolean };
}

export async function batchComputeHouses(
  jd: number,
  locations: Array<{ lat: number; lon: number }>,
): Promise<BatchHousesResult[]> {
  const results: BatchHousesResult[] = [];
  for (const loc of locations) {
    const houses = await computeHouses(jd, loc.lat, loc.lon);
    results.push({
      lat: loc.lat,
      lon: loc.lon,
      houses: {
        cusps: houses.cusps,
        asc: houses.asc,
        mc: houses.mc,
        placidus: houses.placidus,
      },
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Request item types + dispatcher
// ---------------------------------------------------------------------------

export type RefineCrossingKind =
  | "newton"
  | "bisect"
  | "lunation-bisect"
  | "station-refine"
  | "sign-bisect";

export interface RefineCrossingItem {
  kind: RefineCrossingKind;

  // newton fields
  body?: string;
  targetLon?: number;
  approxJd?: number;
  meanMotion?: number;
  maxIter?: number;
  tolerance?: number;

  // bisect fields
  loJd?: number;
  hiJd?: number;
  bisectTolerance?: number;
  bisectMaxIter?: number;

  // lunation-bisect fields
  elongTarget?: number;
  lunationMaxIter?: number;

  // station-refine fields
  natalJd?: number;
  loAge?: number;
  hiAge?: number;
  subStep?: number;
  stationBisectIters?: number;

  // sign-bisect fields
  targetSign?: number;
}

/** Maximum items per /v1/refine-crossings request. */
export const REFINE_MAX_ITEMS = 200;

/** Maximum locations per /v1/batch-houses request. */
export const BATCH_HOUSES_MAX = 50;

/**
 * Process a single refinement item, dispatching to the appropriate algorithm.
 */
export async function processItem(
  item: RefineCrossingItem,
): Promise<RefineCrossingItemResult> {
  try {
    switch (item.kind) {
      case "newton":
        return await newtonRefine(
          item.body as BodyName,
          item.targetLon!,
          item.approxJd!,
          item.meanMotion!,
          item.maxIter ?? 50,
          item.tolerance ?? 1e-5,
        );

      case "bisect":
        return await bisectRefine(
          item.body as BodyName,
          item.targetLon!,
          item.loJd!,
          item.hiJd!,
          item.bisectTolerance ?? 0.0007,
          item.bisectMaxIter ?? 20,
        );

      case "lunation-bisect":
        return await lunationBisect(
          item.loJd!,
          item.hiJd!,
          item.elongTarget as 0 | 180,
          item.lunationMaxIter ?? 15,
        );

      case "station-refine":
        return await stationRefine(
          item.body as BodyName,
          item.natalJd!,
          item.loAge!,
          item.hiAge!,
          item.subStep ?? 0.1,
          item.stationBisectIters ?? 10,
        );

      case "sign-bisect":
        return await signBisect(
          item.body as BodyName,
          item.natalJd!,
          item.loAge!,
          item.hiAge!,
          item.targetSign!,
          item.bisectMaxIter ?? 10,
        );

      default:
        return { error: `Unknown kind: ${(item as any).kind}` };
    }
  } catch (err: any) {
    return { error: err?.message ?? String(err) };
  }
}
