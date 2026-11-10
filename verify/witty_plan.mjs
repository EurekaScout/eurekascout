#!/usr/bin/env node
// witty_plan.mjs: plays a staged plan exactly as it was sealed in a call. MIT.
//
// The scorer (witty_score.mjs) uses it for calls that carry a staged plan. Every level, size and time limit comes
// from the call's own revealed JSON: this file holds no plan of its own.
//
//   node witty_plan.mjs --selftest
//
// A revealed call may carry `plan`:
//   { kind: "ladder" | "steps",
//     entries: [{ at, buy }, ...], reserve, stop (or null), time_limit ("24h", "3d"...), hold_rest (optional),
//     ladder: tp1 { at, sell }, dip { at, sell }, tp2 { at, keep }, runner_trail
//     steps:  sells [{ at, sell }, ...] }
// Levels ("at") are multiples of the call's entry price, written "1.5x" or 1.5. Buys are fractions of the money set
// aside for the call; later buys happen only on the way down, never after the first sale, and are skipped once the
// price is below half their level (a crash, not a dip). Take-profits are measured against the AVERAGE cost of the coins
// bought. Sales are fractions of the coins held when the first take-profit fired. A fall to 0.2x of the entry (or an
// empty pool) is a rug: everything left is sold. Whatever is left at the time limit is sold then, unless the plan has
// hold_rest: true; the record still counts such a call at its time limit, valuing what is left at its price then.

import path from "node:path";

export const RUG_X = 0.2;   // the record's rug line, the same for every call (witty_score.mjs MEASURE.rug; its selftest checks)

const num = (x) => (typeof x === "number" ? x : /^\s*\d*\.?\d+\s*x?\s*$/i.test(String(x)) ? parseFloat(x) : NaN);
const secs = (t) => { const m = String(t).match(/^\s*(\d+)\s*(d|h|m)\s*$/i); return m ? parseInt(m[1]) * { d: 86400, h: 3600, m: 60 }[m[2].toLowerCase()] : NaN; };

/** The call's staged plan as numbers, or null for calls sealed without one. Throws on a malformed plan. */
export function parseLadder(v) {
  if (v == null || !["ladder", "steps"].includes(v.kind)) return null;
  const L = { kind: v.kind, windowS: secs(v.time_limit), holdRest: v.hold_rest === true };
  if (!(L.windowS > 0)) throw new Error(`bad plan: time_limit ${v.time_limit}`);
  L.stop = v.stop == null ? null : num(v.stop);
  if (L.stop != null && !(L.stop > 0 && L.stop < 1)) throw new Error(`bad plan: stop ${v.stop}`);
  L.entries = Array.isArray(v.entries) && v.entries.length ? v.entries.map((e) => ({ at: num(e.at), buy: Number(e.buy) })) : [{ at: 1, buy: 1 }];
  const entriesOk = L.entries[0].at === 1 && L.entries.every((e, i) => e.at > 0 && e.at <= 1 && e.buy > 0 && (i === 0 || e.at < L.entries[i - 1].at));
  if (!entriesOk || L.entries.reduce((a, e) => a + e.buy, 0) > 1.0001) throw new Error("bad plan: entries");
  if (v.kind === "ladder") {
    Object.assign(L, { tp1: num(v.tp1?.at), sell1: Number(v.tp1?.sell), dip: num(v.dip?.at), sellDip: Number(v.dip?.sell),
      tp2: num(v.tp2?.at), keep: Number(v.tp2?.keep), trail: Number(v.runner_trail) });
    for (const k of ["tp1", "sell1", "dip", "sellDip", "tp2", "keep", "trail"]) if (!(L[k] > 0)) throw new Error(`bad plan: ${k} = ${L[k]}`);
    if (!(L.tp2 > L.tp1 && L.dip < L.tp1 && L.sell1 + L.sellDip + L.keep <= 1.0001)) throw new Error("bad plan: order");
  } else {
    L.sells = (v.sells || []).map((x) => ({ at: num(x.at), sell: Number(x.sell) }));
    const ok = L.sells.length && L.sells.every((x, i) => x.at > 1 && x.sell > 0 && (i === 0 || x.at > L.sells[i - 1].at));
    if (!ok || L.sells.reduce((a, x) => a + x.sell, 0) > 1.0001) throw new Error("bad plan: sells");
  }
  return L;
}

/** A fresh position. Money in units of the call's budget; coins in "coins per budget at the entry price". */
export function planState() {
  return { cost: 0, coins: 0, bought: 0, got: 0, fills: 0, sold: false, base: 0, high: 1, peak: 1,
    tp1: false, dip: false, tp2: false, stepsDone: 0, exit: null, at: null, log: [] };
}

function buy(S, e, x, acts) {
  S.cost += e.buy; S.coins += e.buy / x; S.bought += e.buy / x; S.fills++;
  S.log.push(`buy${S.fills}@${x.toFixed(2)}x`); acts.push({ buy: e.buy, x });
}
function sell(S, n, why, x, acts) {
  n = Math.min(n, S.coins);
  if (!(n > 1e-12)) return;
  const frac = n / S.coins;
  S.got += n * Math.max(0, x); S.coins -= n; S.sold = true;
  S.log.push(`${why}@${x.toFixed(2)}x`); acts.push({ sell: frac, why, x });
}
function end(S, exit, x, at, acts) { sell(S, S.coins, exit, x, acts); S.exit = exit; S.at = at; }

/** The first buy, at x (1 for the record; the real fill price for the wallet). */
export function planStart(L, S, x = 1) { const acts = []; S.peak = Math.max(S.peak, x); buy(S, L.entries[0], x, acts); return acts; }

/** One price reading: x = price / the call's entry price, at = seconds since the call. Returns the actions it calls for
 *  ({buy: fraction of the budget} or {sell: fraction of the coins held now, why}); S.exit is set once the plan is done. */
export function planTick(L, S, x, at) {
  const acts = [];
  if (S.exit) return acts;
  S.peak = Math.max(S.peak, x);
  if (!(x > RUG_X)) { end(S, S.sold ? "rugged after profit" : "rugged", x, at, acts); return acts; }
  if (!S.sold && S.fills < L.entries.length) {
    const e = L.entries[S.fills];
    if (x <= e.at && x > e.at / 2) buy(S, e, x, acts);
  }
  const xr = x / (S.cost / S.bought);   // against the average cost
  if (L.kind === "ladder") {
    if (!S.tp1) {
      if (xr >= L.tp1) { S.base = S.coins; sell(S, S.coins * L.sell1, "tp1", x, acts); S.tp1 = true; S.high = xr; }
      else if (L.stop != null && xr <= L.stop) end(S, "stopped", x, at, acts);
    } else {
      S.high = Math.max(S.high, xr);
      const keep = S.base * L.keep;
      if (!S.tp2 && xr >= L.tp2) { sell(S, S.coins - keep, "tp2", x, acts); S.tp2 = true; }
      if (!S.dip && !S.tp2 && xr <= L.dip) { sell(S, Math.min(S.coins - keep, S.base * L.sellDip), "dip", x, acts); S.dip = true; S.high = xr; }
      if (L.stop != null && xr <= L.stop) end(S, "stopped", x, at, acts);
      else if (S.coins <= keep + 1e-12 && xr <= S.high * (1 - L.trail)) end(S, "trail", x, at, acts);
    }
  } else {
    while (S.stepsDone < L.sells.length && xr >= L.sells[S.stepsDone].at) {
      if (!S.base) S.base = S.coins;
      sell(S, S.base * L.sells[S.stepsDone].sell, `tp${S.stepsDone + 1}`, x, acts); S.stepsDone++;
    }
    if (S.coins <= 1e-12) { S.exit = "targets"; S.at = at; }
    else if (L.stop != null && xr <= L.stop) end(S, "stopped", x, at, acts);
  }
  if (!S.exit && at >= L.windowS && !L.holdRest) end(S, "time", x, at, acts);   // hold_rest plans have no time exit
  return acts;
}

/** Closes what is left at x (the time limit, or a manual sale). */
export function planEnd(L, S, x, at, why = "time") { const acts = []; if (!S.exit) end(S, why, x, at, acts); return acts; }

/** Scores a staged call on its readings [{at, px}] (spikes already dropped). gross = money back per 1 invested.
 *  peak = the coin's highest price in the call's window, even after the plan is done; plan_peak = the highest
 *  while the plan was still running. */
export function decideLadder(entry, readings, L) {
  if (!(entry > 0)) return { scored: false, why: "no entry price" };
  const S = planState(); planStart(L, S, 1);
  let last = null, top = 1;
  for (const r of readings) {
    if (r.at > L.windowS) break;
    const x = (r.px ?? 0) / entry;
    top = Math.max(top, x);   // the window's peak is tracked to the end, even after the plan is done
    if (S.exit) continue;
    last = { x, at: r.at };
    planTick(L, S, x, r.at);
  }
  if (!last) return { scored: false, why: "no prices found after the entry within the window (missing data is never scored)" };
  if (!S.exit) planEnd(L, S, last.x, L.windowS);
  return { scored: true, exit: S.exit, gross: S.got / S.cost, at: S.at, peak: Math.max(S.peak, top), plan_peak: S.peak, steps: S.log, cost: S.cost,
    stages: { fills: S.fills, tp1: S.tp1, dip: S.dip, tp2: S.tp2, targets: S.stepsDone } };
}


// ---------------- selftest (made-up plans: none of these is one of Witty's) ----------------

function selftest() {
  const results = [];
  const check = (name, ok) => results.push([name, !!ok]);
  const R = (pairs) => pairs.map(([m, x]) => ({ at: m * 60, px: x }));
  const near = (a, b) => Math.abs(a - b) < 1e-9;

  const steps = parseLadder({ kind: "steps", entries: [{ at: "1x", buy: 1 }], sells: [{ at: "1.5x", sell: 0.5 }], stop: null, time_limit: "2h" });
  check("a steps plan is read from the call: levels as numbers, the time limit in seconds",
    steps.kind === "steps" && steps.sells[0].at === 1.5 && steps.windowS === 7200 && steps.stop === null && steps.entries[0].buy === 1);
  let d = decideLadder(1, R([[10, 1.2], [20, 1.6], [119, 1.3], [130, 4]]), steps);
  check("steps: half sold at 1.6x (the first reading at or over 1.5x), the rest at the time limit (1.3x): 1.45, readings after the limit ignored",
    d.scored && near(d.gross, 0.5 * 1.6 + 0.5 * 1.3) && d.exit === "time");
  const held = parseLadder({ kind: "steps", entries: [{ at: "1x", buy: 1 }], sells: [{ at: "1.5x", sell: 0.5 }], stop: null, time_limit: "2h", hold_rest: true });
  d = decideLadder(1, R([[10, 1.2], [20, 1.6], [119, 1.3], [130, 4]]), held);
  check("hold_rest: the record still counts the call at its time limit, valuing what is left at its price then",
    d.scored && near(d.gross, 1.45) && held.holdRest === true);

  const dca = parseLadder({ kind: "steps", entries: [{ at: "1x", buy: 0.5 }, { at: "0.8x", buy: 0.5 }], sells: [{ at: "1.25x", sell: 1 }], stop: null, time_limit: "6h" });
  d = decideLadder(1, R([[5, 0.8], [30, 1.12]]), dca);
  const coins = 0.5 / 1 + 0.5 / 0.8;
  check("a dip buy at 0.8x lowers the average cost; the take-profit is measured against it (sold at 1.12x, not 1.25x)",
    d.scored && d.exit === "targets" && near(d.gross, coins * 1.12) && d.stages.fills === 2);
  d = decideLadder(1, R([[5, 0.35], [10, 0.15]]), dca);
  check("a crash below half a buy level skips that buy (a crash, not a dip); a fall to 0.2x or less is a rug",
    d.scored && d.exit === "rugged" && d.stages.fills === 1 && near(d.gross, 0.15));
  d = decideLadder(1, R([[5, 1.3], [10, 0.1]]), parseLadder({ kind: "steps", entries: [{ at: "1x", buy: 1 }], sells: [{ at: "1.2x", sell: 0.5 }], stop: null, time_limit: "1h" }));
  check("a rug after a take-profit is called \"rugged after profit\"", d.exit === "rugged after profit" && near(d.gross, 0.5 * 1.3 + 0.5 * 0.1));

  const lad = parseLadder({ kind: "ladder", entries: [{ at: "1x", buy: 1 }], reserve: 0, tp1: { at: "1.4x", sell: 0.4 }, dip: { at: "1.1x", sell: 0.3 },
    tp2: { at: "2.5x", keep: 0.2 }, runner_trail: 0.3, stop: "0.75x", time_limit: "4h" });
  d = decideLadder(1, R([[5, 1.45], [20, 2.6], [40, 3.0], [50, 2.0]]), lad);
  check("ladder: 40% at the first take-profit, down to the kept 20% at the second, the rest trails 30% from its high: 2.02",
    d.scored && d.exit === "trail" && near(d.gross, 0.4 * 1.45 + 0.4 * 2.6 + 0.2 * 2.0));
  d = decideLadder(1, R([[5, 0.9], [9, 0.7]]), lad);
  check("ladder: the call's own stop (0.75x) sells everything before any take-profit", d.exit === "stopped" && near(d.gross, 0.7));
  d = decideLadder(1, R([[5, 1.45], [20, 1.05], [60, 1.2]]), lad);
  check("ladder: a fall back to the dip level after the first take-profit sells a part, the rest goes at the time limit or the trail",
    d.scored && d.stages.dip === true && d.stages.tp1 === true);
  d = decideLadder(1, R([[5, 0.9], [9, 0.7], [60, 3], [200, 6], [230, 0.1]]), lad);
  check("the peak is the coin's highest price in the call's window, even after the plan is done: stopped at 0.7x, peak 6x",
    d.exit === "stopped" && near(d.gross, 0.7) && near(d.peak, 6) && near(d.plan_peak, 1));
  d = decideLadder(1, R([[60, 1.2], [300, 9]]), lad);
  check("...but never a price after the window (a 9x at 5 h, past this plan's 4 h): peak 1.2x", d.exit === "time" && near(d.peak, 1.2));
  check("no readings after the entry: not scored (missing data never becomes a result)", decideLadder(1, [], lad).scored === false);
  check("no entry price: not scored", decideLadder(0, R([[1, 2]]), lad).scored === false);

  let bad = 0;
  for (const p of [{ kind: "steps", entries: [{ at: "1x", buy: 1 }], sells: [{ at: "1.5x", sell: 0.5 }] },                                     // no time limit
    { kind: "steps", entries: [{ at: "1x", buy: 0.7 }, { at: "0.8x", buy: 0.7 }], sells: [{ at: "2x", sell: 1 }], time_limit: "1h" },             // buys over 100%
    { kind: "ladder", entries: [{ at: "1x", buy: 1 }], tp1: { at: "2x", sell: 0.5 }, dip: { at: "2.2x", sell: 0.3 }, tp2: { at: "3x", keep: 0.2 }, runner_trail: 0.3, time_limit: "1h" },   // dip above tp1
    { kind: "steps", entries: [{ at: "1x", buy: 1 }], sells: [{ at: "0.9x", sell: 1 }], time_limit: "1h" }]) {                                   // a "take-profit" under the entry
    try { parseLadder(p); } catch { bad++; }
  }
  check("a malformed plan is refused, never guessed at (no time limit, buys over 100%, levels out of order, a sale under the entry)", bad === 4);
  check("a call without a staged plan: null (the scorer then reads the call's target and time limit)", parseLadder(null) === null && parseLadder({ kind: "other" }) === null);

  let fails = 0;
  for (const [name, ok] of results) { console.log(`${ok ? "PASS" : "FAIL"}  ${name}`); if (!ok) fails++; }
  console.log(`\n${results.length - fails}/${results.length} passed`);
  process.exit(fails ? 1 : 0);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain && process.argv.includes("--selftest")) selftest();
