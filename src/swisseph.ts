/**
 * Swiss Ephemeris WASM wrapper for Cloudflare Workers.
 *
 * Loads the WebAssembly module, mounts the seas_18.se1 asteroid file for
 * Chiron, and exposes three operations: planetary positions (ecliptic),
 * equatorial positions (for declination), and Placidus house cusps.
 *
 * The .wasm module is imported as a CompiledWasm (WebAssembly.Module) and
 * the .se1 data file as a Data blob (ArrayBuffer), both via module rules
 * in wrangler.jsonc (production) and modulesRules in vitest.config.ts (tests).
 *
 * The Emscripten module is initialised once and cached for the lifetime
 * of the isolate.
 */

// @ts-expect-error — patched Emscripten glue (ESM, no types)
import createSwissEphModule from "./wasm/swisseph-glue.mjs";

// @ts-expect-error — CompiledWasm rule: gives WebAssembly.Module
import wasmModule from "./wasm/swisseph.wasm";

// @ts-expect-error — Data rule: gives ArrayBuffer
import chironData from "../data/seas_18.se1";

// ---------------------------------------------------------------------------
// Swiss Ephemeris constants (from swephexp.h via @kuntay/swisseph)
// ---------------------------------------------------------------------------

/** Body IDs for swe_calc_ut */
export const SE_BODY = {
  Sun: 0,
  Moon: 1,
  Mercury: 2,
  Venus: 3,
  Mars: 4,
  Jupiter: 5,
  Saturn: 6,
  Uranus: 7,
  Neptune: 8,
  Pluto: 9,
  TrueNode: 11,
  Chiron: 15,
} as const;

export type BodyName = keyof typeof SE_BODY;
export const BODY_NAMES = Object.keys(SE_BODY) as BodyName[];

/** swe_calc_ut flag constants */
const SEFLG_SPEED = 256;
const SEFLG_EQUATORIAL = 2048;
const SEFLG_SWIEPH = 2; // prefer Swiss Ephemeris (data files, or Moshier fallback)

/** Buffer sizes matching sweodef.h and instance.js conventions */
const POSITION_DOUBLES = 6;
const ERROR_BUFFER_SIZE = 256;
const CUSPS_BUFFER_SIZE = 37; // Gauquelin needs 37; we always allocate the max
const ASCMC_BUFFER_SIZE = 10;
const HOUSE_COUNT = 12;

/** Placidus house system character code */
const HSYS_PLACIDUS = "P".charCodeAt(0);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BodyPosition {
  lon: number;
  lat: number;
  speed: number;
  ra: number;
  decl: number;
}

export interface HouseCusps {
  cusps: number[];
  asc: number;
  mc: number;
}

export type Positions = Record<BodyName, BodyPosition>;

// ---------------------------------------------------------------------------
// Emscripten module interface (minimal; enough for what we need)
// ---------------------------------------------------------------------------

interface EmscriptenModule {
  cwrap: (
    name: string,
    returnType: string | null,
    argTypes: string[]
  ) => (...args: unknown[]) => unknown;
  _malloc: (size: number) => number;
  _free: (ptr: number) => void;
  getValue: (ptr: number, type: string) => number;
  setValue: (ptr: number, value: number, type: string) => void;
  UTF8ToString: (ptr: number) => string;
  stringToUTF8: (str: string, ptr: number, maxBytes: number) => void;
  FS: {
    mkdir: (path: string) => void;
    writeFile: (path: string, data: Uint8Array) => void;
  };
}

// ---------------------------------------------------------------------------
// Module-level singleton (initialised lazily, cached per isolate)
// ---------------------------------------------------------------------------

let cachedInstance: SwissEphInstance | null = null;
let initPromise: Promise<SwissEphInstance> | null = null;

interface CWraps {
  calcUt: (
    jd: number,
    body: number,
    flags: number,
    buf: number,
    err: number
  ) => number;
  housesEx2: (
    jd: number,
    flags: number,
    lat: number,
    lon: number,
    hsys: number,
    cusps: number,
    ascmc: number,
    cuspSpeed: number,
    ascmcSpeed: number,
    err: number
  ) => number;
  sidtime: (jd: number) => number;
  setEphePath: (path: string) => void;
  version: (buf: number) => string;
}

interface SwissEphInstance {
  em: EmscriptenModule;
  c: CWraps;
  bufPosition: number;
  bufError: number;
  bufCusps: number;
  bufCuspSpeed: number;
  bufAscmc: number;
  bufAscmcSpeed: number;
  bufName: number;
}

async function createInstance(): Promise<SwissEphInstance> {
  const em: EmscriptenModule = await createSwissEphModule({
    wasmModule,
    print: () => {},
    printErr: () => {},
  });

  // Mount the Chiron asteroid ephemeris file into MEMFS
  try {
    em.FS.mkdir("/ephe");
  } catch {
    // already exists
  }
  em.FS.writeFile("/ephe/seas_18.se1", new Uint8Array(chironData));

  const setEphePath = em.cwrap("swe_set_ephe_path", null, [
    "string",
  ]) as CWraps["setEphePath"];
  setEphePath("/ephe");

  // Allocate persistent buffers
  const bufPosition = em._malloc(POSITION_DOUBLES * 8);
  const bufError = em._malloc(ERROR_BUFFER_SIZE);
  const bufCusps = em._malloc(CUSPS_BUFFER_SIZE * 8);
  const bufCuspSpeed = em._malloc(CUSPS_BUFFER_SIZE * 8);
  const bufAscmc = em._malloc(ASCMC_BUFFER_SIZE * 8);
  const bufAscmcSpeed = em._malloc(ASCMC_BUFFER_SIZE * 8);
  const bufName = em._malloc(ERROR_BUFFER_SIZE);

  // cwrap the C functions we need
  const calcUt = em.cwrap("swe_calc_ut", "number", [
    "number",
    "number",
    "number",
    "number",
    "number",
  ]) as CWraps["calcUt"];

  const housesEx2 = em.cwrap("swe_houses_ex2", "number", [
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
  ]) as CWraps["housesEx2"];

  const sidtime = em.cwrap("swe_sidtime", "number", [
    "number",
  ]) as CWraps["sidtime"];

  const version = em.cwrap("swe_version", "string", [
    "number",
  ]) as CWraps["version"];

  return {
    em,
    c: { calcUt, housesEx2, sidtime, setEphePath, version },
    bufPosition,
    bufError,
    bufCusps,
    bufCuspSpeed,
    bufAscmc,
    bufAscmcSpeed,
    bufName,
  };
}

/** Get (or create) the cached Swiss Ephemeris instance. */
async function getSwissEph(): Promise<SwissEphInstance> {
  if (cachedInstance) return cachedInstance;
  if (!initPromise) {
    initPromise = createInstance().then((inst) => {
      cachedInstance = inst;
      return inst;
    });
  }
  return initPromise;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readDoubles(em: EmscriptenModule, ptr: number, n: number): number[] {
  return Array.from({ length: n }, (_, i) =>
    em.getValue(ptr + i * 8, "double")
  );
}

function readError(em: EmscriptenModule, bufError: number): string | null {
  const s = em.UTF8ToString(bufError);
  return s && s.length ? s : null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute ecliptic + equatorial positions for all 12 bodies at a Julian Day.
 */
export async function computePositions(jd: number): Promise<Positions> {
  const inst = await getSwissEph();
  const { em, c, bufPosition, bufError } = inst;
  const result: Partial<Positions> = {};

  for (const name of BODY_NAMES) {
    const bodyId = SE_BODY[name];
    const flags = SEFLG_SWIEPH | SEFLG_SPEED;

    // --- Ecliptic position (longitude, latitude, speed) ---
    em.setValue(bufError, 0, "i8");
    const ret = c.calcUt(jd, bodyId, flags, bufPosition, bufError);
    if (ret < 0) {
      const msg = readError(em, bufError);
      throw new Error(`swe_calc_ut failed for ${name}: ${msg}`);
    }
    const [lon, lat, , lonSpeed] = readDoubles(em, bufPosition, 4);

    // --- Equatorial position (for declination) ---
    const eqFlags = SEFLG_SWIEPH | SEFLG_SPEED | SEFLG_EQUATORIAL;
    em.setValue(bufError, 0, "i8");
    const eqRet = c.calcUt(jd, bodyId, eqFlags, bufPosition, bufError);
    if (eqRet < 0) {
      const msg = readError(em, bufError);
      throw new Error(`swe_calc_ut (equatorial) failed for ${name}: ${msg}`);
    }
    const [ra, decl] = readDoubles(em, bufPosition, 2); // [RA, decl, ...]

    result[name] = { lon, lat, speed: lonSpeed, ra, decl };
  }

  return result as Positions;
}

/**
 * Compute Placidus house cusps + ASC/MC for a Julian Day and geographic
 * location (latitude north-positive, longitude east-positive).
 */
export async function computeHouses(
  jd: number,
  lat: number,
  lon: number
): Promise<HouseCusps> {
  const inst = await getSwissEph();
  const { em, c, bufCusps, bufCuspSpeed, bufAscmc, bufAscmcSpeed, bufError } =
    inst;

  em.setValue(bufError, 0, "i8");

  // Zero the cusps buffer (same safety measure as instance.js)
  for (let i = 0; i < HOUSE_COUNT + 1; i++) {
    em.setValue(bufCusps + i * 8, 0, "double");
  }

  const ret = c.housesEx2(
    jd,
    0, // flags
    lat,
    lon,
    HSYS_PLACIDUS,
    bufCusps,
    bufAscmc,
    bufCuspSpeed,
    bufAscmcSpeed,
    bufError
  );

  // Read 13 doubles (1-based: cusps[1]..cusps[12]) and convert to 0-based
  const raw = readDoubles(em, bufCusps, HOUSE_COUNT + 1);
  const cusps = raw.slice(1, HOUSE_COUNT + 1);

  // Check for hard error (ret < 0 AND cusps all zero)
  const filled = cusps.some((v) => v !== 0);
  if (ret < 0 && !filled) {
    const msg = readError(em, bufError);
    throw new Error(`swe_houses_ex2 failed: ${msg}`);
  }

  const ascmc = readDoubles(em, bufAscmc, 2); // [ASC, MC]

  return {
    cusps,
    asc: ascmc[0],
    mc: ascmc[1],
  };
}

/**
 * Return the Swiss Ephemeris version string.
 */
export async function getVersion(): Promise<string> {
  const inst = await getSwissEph();
  return inst.c.version(inst.bufName);
}

/**
 * Verify Chiron is available by doing a test calculation.
 */
export async function hasChiron(): Promise<boolean> {
  try {
    const inst = await getSwissEph();
    const { em, c, bufPosition, bufError } = inst;
    em.setValue(bufError, 0, "i8");
    const ret = c.calcUt(
      2451545.0,
      SE_BODY.Chiron,
      SEFLG_SWIEPH | SEFLG_SPEED,
      bufPosition,
      bufError
    );
    return ret >= 0;
  } catch {
    return false;
  }
}

/**
 * Compute Greenwich Sidereal Time for a Julian Day (UT).
 * Uses Swiss Ephemeris swe_sidtime which includes nutation correction.
 * Returns sidereal time in degrees (0–360).
 */
export async function computeSiderealTime(jd: number): Promise<number> {
  const inst = await getSwissEph();
  const hours = inst.c.sidtime(jd) as number;
  return (hours * 15.0) % 360;
}
