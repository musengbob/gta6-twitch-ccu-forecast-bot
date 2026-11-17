// gta6-twitch-ccu-forecast-01 — launch-day Twitch viewer forecaster.
//
// Model: for each hour h = 2..24 the five quantiles are
//     q_tau(h) = p1 * exp(mu_h + z_tau * sigma_h)
// where p1 is hour 1's print, mu_h is the median log-ratio of hour h to
// hour 1 across comparable past launches, sigma_h is the log-spread of
// those ratios, and z_tau is the standard normal quantile at each level.
//
// mu_h and sigma_h are fitted at runtime from the case file's own
// comparables: only launches that unlocked at midnight local time, whose
// hour-1 print was already meaningful (>= 10,000 viewers, so some region
// had unlocked by hour 1), and excluding the GTA VI pre-release category
// history and any comparable launched on the case's own day (the latter
// keeps leave-one-out validation honest). The median shape is conditioned
// on launch scale: only pool members on the same side of the pool's
// median hour-1 as this case set the median, while the spread always
// comes from the full pool, so a halved pool cannot collapse the
// quantiles. The fitted curves are lightly smoothed across neighbouring
// hours and the spread is floored from hour 6 on. When the pool is too
// small (< 5 launches) the program falls back to embedded constants
// fitted the same way on the rolling-midnight big-launch pool.
//
// Node 22, standard library only, no network, deterministic.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// The five scored levels, in row order, and the matching normal quantiles.
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
const Z = [-1.645, -0.674, 0, 0.674, 1.645];
const HOURS = Array.from({ length: 23 }, (_, i) => i + 2); // 2..24

// Pool rules: a comparable joins the shape pool when its unlock text says
// it rolled out at midnight local time and its hour-1 print is at least
// this many viewers. PC-simultaneous / early-access-only launches are
// kept out by the midnight-local test (their hour 1 is pre-unlock).
const MIN_HOUR1 = 10000;
const MIN_POOL = 5;
// Spread floor from hour 6 onward: the cross-game dispersion stays wide
// all day, so never let a lucky pool pretend otherwise.
const SPREAD_FLOOR_LATE = 0.5;
const SPREAD_FLOOR_EARLY = 0.15;
const SPREAD_CAP = 1.25;

// Embedded fallback: median log-ratio and log-spread per hour from the
// rolling-midnight, hour-1 >= 10k pool (12 launches). Used only when the
// runtime pool has fewer than MIN_POOL members.
const FALLBACK_MU: Record<number, number> = {
  2: -0.114, 3: -0.278, 4: -0.331, 5: -0.208, 6: -0.029, 7: 0.042,
  8: 0.020, 9: 0.012, 10: 0.014, 11: 0.004, 12: 0.026, 13: 0.120,
  14: 0.219, 15: 0.350, 16: 0.466, 17: 0.479, 18: 0.523, 19: 0.640,
  20: 0.784, 21: 0.826, 22: 0.800, 23: 0.689, 24: 0.552,
};
const FALLBACK_SIGMA: Record<number, number> = {
  2: 0.156, 3: 0.340, 4: 0.287, 5: 0.258, 6: 0.527, 7: 0.642,
  8: 0.659, 9: 0.679, 10: 0.680, 11: 0.676, 12: 0.671, 13: 0.664,
  14: 0.650, 15: 0.647, 16: 0.662, 17: 0.638, 18: 0.668, 19: 0.698,
  20: 0.714, 21: 0.692, 22: 0.680, 23: 0.677, 24: 0.720,
};

type HourlyRow = { from: string; viewers: number; channels?: number | null };
type Comparable = {
  name: string;
  day_start: string;
  unlock?: string;
  platforms?: string;
  hourly?: HourlyRow[];
};
type CaseFile = {
  id?: string;
  day_start: string;
  levels?: number[];
  known?: Array<{ hour: number; viewers: number }>;
  history_hourly?: Array<{ viewers: number }>;
  forecast?: Array<{ hour: number }>;
  comparables?: Comparable[];
};

// ---- small statistics (type-7 quantiles, sample spread) ----

function sortedCopy(xs: number[]): number[] {
  return [...xs].sort((a, b) => a - b);
}

function quantileAt(xs: number[], p: number): number {
  const s = sortedCopy(xs);
  if (s.length === 0) return NaN;
  if (s.length === 1) return s[0];
  const pos = p * (s.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

function spreadOf(xs: number[]): number {
  // The larger of the sample std and an IQR-based robust sigma: with a
  // dozen pool members either alone can understate the true dispersion.
  if (xs.length < 2) return 0;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
  const iqr = (quantileAt(xs, 0.75) - quantileAt(xs, 0.25)) / 1.349;
  return Math.max(sd, iqr);
}

// One light pass of a 3-hour moving average; edges use the hours that exist.
function smooth3(values: Map<number, number>): Map<number, number> {
  const out = new Map<number, number>();
  for (const h of HOURS) {
    const near = [h - 1, h, h + 1].filter((x) => values.has(x)).map((x) => values.get(x)!);
    out.set(h, near.reduce((a, b) => a + b, 0) / near.length);
  }
  return out;
}

// ---- comparable handling ----

// Hour index of a row: 1 + whole hours from the comparable's day_start.
function hourOf(comp: Comparable, from: string): number {
  return 1 + Math.round((Date.parse(from) - Date.parse(comp.day_start)) / 3600000);
}

function hourViews(comp: Comparable): Map<number, number> {
  const m = new Map<number, number>();
  for (const row of comp.hourly ?? []) {
    if (typeof row.viewers !== 'number' || !Number.isFinite(row.viewers)) continue;
    const h = hourOf(comp, row.from);
    if (h >= 1 && h <= 24 && !m.has(h)) m.set(h, row.viewers);
  }
  return m;
}

function isRollingMidnight(comp: Comparable): boolean {
  return (comp.unlock ?? '').toLowerCase().includes('midnight local');
}

function isGtaCategoryHistory(comp: Comparable): boolean {
  return (comp.name ?? '').toLowerCase().includes('grand theft auto vi');
}

// Fit mu_h / sigma_h from the case's comparables. caseP1 is this case's
// hour-1 print: pool members on the same side of the pool's median
// hour-1 as the case set the median shape, since big and small launches
// ramp differently; the spread always uses the whole pool. Returns null
// when the pool is too small to trust, so the caller can use the
// embedded table.
function fitShape(dayStart: string, comps: Comparable[], caseP1: number): Map<number, { mu: number; sigma: number }> | null {
  let pool: Array<{ p1: number; hours: Map<number, number> }> = [];
  for (const comp of comps) {
    if (isGtaCategoryHistory(comp)) continue;
    if (comp.day_start === dayStart) continue; // the case's own launch day
    if (!isRollingMidnight(comp)) continue;
    const hours = hourViews(comp);
    const p1 = hours.get(1);
    if (p1 === undefined || p1 < MIN_HOUR1) continue;
    pool.push({ p1, hours });
  }
  if (pool.length < MIN_POOL) return null;
  const fullPool = pool;
  if (caseP1 > 0) {
    const mid = quantileAt(pool.map((m) => m.p1), 0.5);
    const sameSide = pool.filter((m) => (m.p1 >= mid) === (caseP1 >= mid));
    if (sameSide.length >= MIN_POOL) pool = sameSide;
  }

  const mu = new Map<number, number>();
  const sigma = new Map<number, number>();
  for (const h of HOURS) {
    const muLogs: number[] = [];
    const sdLogs: number[] = [];
    for (const member of pool) {
      const v = member.hours.get(h);
      if (v !== undefined && v > 0) muLogs.push(Math.log(v / member.p1));
    }
    for (const member of fullPool) {
      const v = member.hours.get(h);
      if (v !== undefined && v > 0) sdLogs.push(Math.log(v / member.p1));
    }
    if (muLogs.length >= 3) {
      mu.set(h, quantileAt(muLogs, 0.5));
      sigma.set(h, spreadOf(sdLogs.length >= 3 ? sdLogs : muLogs));
    }
  }
  // Fill any hour the pool skipped from its nearest fitted neighbours.
  for (const h of HOURS) {
    if (!mu.has(h)) {
      const near = HOURS.filter((x) => mu.has(x));
      const best = near.sort((a, b) => Math.abs(a - h) - Math.abs(b - h))[0];
      mu.set(h, mu.get(best)!);
      sigma.set(h, sigma.get(best)!);
    }
  }
  const muS = smooth3(mu);
  const sigmaS = smooth3(sigma);
  const out = new Map<number, { mu: number; sigma: number }>();
  for (const h of HOURS) {
    const floor = h >= 6 ? SPREAD_FLOOR_LATE : SPREAD_FLOOR_EARLY;
    out.set(h, {
      mu: muS.get(h)!,
      sigma: Math.min(SPREAD_CAP, Math.max(floor, sigmaS.get(h)!)),
    });
  }
  return out;
}

function fallbackShape(): Map<number, { mu: number; sigma: number }> {
  const mu = new Map<number, number>(HOURS.map((h) => [h, FALLBACK_MU[h]]));
  const sigma = new Map<number, number>(HOURS.map((h) => [h, FALLBACK_SIGMA[h]]));
  const muS = smooth3(mu);
  const sigmaS = smooth3(sigma);
  const out = new Map<number, { mu: number; sigma: number }>();
  for (const h of HOURS) {
    const floor = h >= 6 ? SPREAD_FLOOR_LATE : SPREAD_FLOOR_EARLY;
    out.set(h, {
      mu: muS.get(h)!,
      sigma: Math.min(SPREAD_CAP, Math.max(floor, sigmaS.get(h)!)),
    });
  }
  return out;
}

// ---- forecasting one case ----

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

function forecastCase(c: CaseFile): Array<{ hour: number; q: number[] }> {
  const first = (c.known ?? []).find((k) => k.hour === 1);
  let p1 = first !== undefined && Number.isFinite(first.viewers) ? first.viewers : NaN;
  if (!Number.isFinite(p1) || p1 < 1) {
    const last = (c.history_hourly ?? []).at(-1);
    p1 = last !== undefined && Number.isFinite(last.viewers) && last.viewers >= 1 ? last.viewers : 1;
  }
  p1 = Math.max(1, p1);

  const shape = fitShape(c.day_start, c.comparables ?? [], p1) ?? fallbackShape();
  const wanted = (c.forecast ?? []).map((r) => r.hour).filter((h) => h >= 2 && h <= 24);
  const hours = wanted.length === 23 ? wanted : HOURS;
  return hours.map((h) => {
    const { mu, sigma } = shape.get(h)!;
    const q = Z.map((z) => {
      const v = round2(p1 * Math.exp(mu + z * sigma));
      return Number.isFinite(v) ? Math.min(1e9, Math.max(0.01, v)) : p1;
    });
    for (let j = 1; j < 5; j++) q[j] = Math.max(q[j], q[j - 1]);
    return { hour: h, q };
  });
}

// ---- main: every *.in in name order, one *.out each ----

mkdirSync(OUTPUT_DIR, { recursive: true });
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as CaseFile;
  if (c.levels !== undefined && (c.levels.length !== LEVELS.length || c.levels.some((t, j) => t !== LEVELS[j]))) {
    throw new Error(`${file} asks for levels ${JSON.stringify(c.levels)}, not ${JSON.stringify(LEVELS)}`);
  }
  const hours = forecastCase(c);
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ hours })}\n`);
}
