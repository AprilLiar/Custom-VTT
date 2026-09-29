// **What one action actually costs in database round trips (decided, new).**
//
// Reported as "even on perfect internet I experience a 3 sec delay between
// making an action and seeing the change". That number cannot be reasoned about
// from the code, because the thing that decides it is not how many queries an
// action makes — it is how many of them have to happen ONE AFTER ANOTHER.
//
// Against a local file those are indistinguishable: both are microseconds.
// Against Turso every sequential step is a real network round trip, so:
//
//     wall time  ≈  sequential depth  ×  round trip
//
// Five queries issued together cost one trip. Five issued one after another
// cost five. `readMany`/`writeMany` exist precisely to turn the second into the
// first, and this is how to find out where they are still missing.
//
// **Waves, not counts.** A "wave" is a group of queries that were in flight at
// the same time, so the wave count IS the sequential depth. A handler that
// makes forty queries in three waves is fine; one that makes twelve in twelve
// waves is the one costing a second.
//
// Off unless `DOGFIGHT_PROFILE=1`, and it costs one AsyncLocalStorage lookup
// per query when on. Never left on in production — it is a tool for answering
// "which action is slow, and why", not telemetry.
import { AsyncLocalStorage } from 'node:async_hooks';

export const PROFILING = process.env.DOGFIGHT_PROFILE === '1';
// `DOGFIGHT_TRACE=move:declare` prints that one action's waves in order, which
// is what turns "15 round trips" into "these six awaits could be one batch".
const TRACE = process.env.DOGFIGHT_TRACE || null;

const store = new AsyncLocalStorage();

// Rendered by the reporter below; also returned so a script can assert on it.
const summary = new Map();

export function startProfile(label) {
  if (!PROFILING) return null;
  return { label, trips: 0, waves: 0, inFlight: 0, started: Date.now(), slowest: [] };
}

// Called by db.js around every statement. `inFlight === 0` at the moment a
// query starts means nothing else was pending, so this is the head of a new
// wave — a step that had to wait for the previous one to come back.
export function trackTrip(promiseFactory, sql) {
  // Explicitly first: `profile()` never calls `store.run()` when profiling is
  // off, so the AsyncLocalStorage hooks are never enabled and this costs a
  // boolean on the hot path rather than a context lookup per query.
  if (!PROFILING) return promiseFactory();
  const ctx = store.getStore();
  if (!ctx) return promiseFactory();
  ctx.trips += 1;
  if (ctx.inFlight === 0) ctx.waves += 1;
  ctx.inFlight += 1;
  const started = Date.now();
  if (TRACE && ctx.label === TRACE) {
    ctx.trace ??= [];
    ctx.trace.push({ wave: ctx.waves, sql: String(sql ?? '').replace(/\s+/g, ' ').slice(0, 110) });
  }
  const done = () => {
    ctx.inFlight -= 1;
    const ms = Date.now() - started;
    if (ms >= 1) ctx.slowest.push({ ms, sql: String(sql ?? '').replace(/\s+/g, ' ').slice(0, 90) });
  };
  return promiseFactory().then(
    (v) => { done(); return v; },
    (e) => { done(); throw e; }
  );
}

// Wrap one unit of work — a socket event, a REST handler — so everything it
// does is attributed to it.
export async function profile(label, fn) {
  if (!PROFILING) return fn();
  const ctx = startProfile(label);
  try {
    return await store.run(ctx, fn);
  } finally {
    const ms = Date.now() - ctx.started;
    const prev = summary.get(label) ?? { label, runs: 0, trips: 0, waves: 0, ms: 0 };
    prev.runs += 1;
    prev.trips += ctx.trips;
    prev.waves += ctx.waves;
    prev.ms += ms;
    summary.set(label, prev);
    if (TRACE && ctx.label === TRACE && ctx.trace?.length) {
      console.log(`\n[trace] ${label} — ${ctx.waves} sequential waves:`);
      let last = -1;
      for (const t of ctx.trace) {
        console.log(`${t.wave !== last ? `\n  wave ${String(t.wave).padStart(2)}` : '        '}  ${t.sql}`);
        last = t.wave;
      }
      console.log('');
    }
    if (ctx.trips) {
      console.log(
        `[profile] ${label.padEnd(34)} ${String(ctx.trips).padStart(4)} queries in ` +
          `${String(ctx.waves).padStart(3)} waves  (${ms}ms local)`
      );
    }
  }
}

// The table that answers "which action would a 200ms round trip hurt most".
export function profileReport(roundTripMs = 200) {
  const rows = [...summary.values()].sort((a, b) => b.waves / b.runs - a.waves / a.runs);
  const lines = [
    '',
    `action                              queries   waves   predicted @ ${roundTripMs}ms/trip`,
    '-'.repeat(78),
  ];
  for (const r of rows) {
    const waves = r.waves / r.runs;
    const trips = r.trips / r.runs;
    lines.push(
      `${r.label.padEnd(34)} ${trips.toFixed(1).padStart(7)} ${waves.toFixed(1).padStart(7)}` +
        `   ${((waves * roundTripMs) / 1000).toFixed(2)}s`
    );
  }
  return lines.join('\n');
}

export function resetProfile() {
  summary.clear();
}
