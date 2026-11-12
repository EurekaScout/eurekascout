#!/usr/bin/env node
// witty_score.mjs: Witty's record, re-scored by anyone from the chain. MIT.
//
// Reads every call on receipts.eurekascout.near. For each revealed call it checks that the SHA-256 of the revealed JSON
// equals the hash sealed before the call played out, then plays the call's OWN plan, exactly as it was sealed, on
// prices from the chain. This file holds no plan of its own: every target, stop, take-profit and time limit comes from
// the call's revealed JSON (staged plans through witty_plan.mjs).
//
// What the scorer itself sets, the same for every call (this is how the record is measured):
//   fees:    4% off every result (fees and slippage for a round trip); a win is above 1.00x after fees
//   a rug:   the price at 0.2x of the entry or less, or the pool emptied (99% of its liquidity pulled, or the ETH side
//            of a v2 pool down to 1% of its peak): sold at that price
//   a spike: a reading over 50x the one before counts only if the next reading confirms it (at least half of it)
//   missing data is never scored, and a call not revealed by its deadline counts as a loss (0.00x)
//
// A call without a staged plan carries a target and a time limit. Reading the prices in time order, the first of these
// decides it: the price reaches the target (sold at the target); a rug; the call's trailing rule, if it has one (once
// the price has reached `arm`, sold if it falls back to `floor`); the call's stop loss, if it has one (sold at THAT
// reading's price: a fast crash can gap below the stop); otherwise sold at the price when the time limit ends.
// Entry = the pool price at the call. Robinhood: the price after the last swap before the call's block. Solana: the
// price recorder's first reading after the call (a few seconds later).
//
// Where the prices come from:
//   Robinhood: the call's pool on Robinhood Chain, every swap with its block (Uniswap v4 Swap events of the
//              PoolManager; v3 Swap or v2 Sync events of the pool). Anyone can rebuild these from the chain.
//   Solana:    data/prices/<call hash>.jsonl from witty_prices.mjs (the PumpSwap pool's vaults, read on the chain
//              every 10 s, each reading with its slot). A pool's past balances can't be read back from the chain
//              later, so Solana calls need these files.
//
//   node witty_score.mjs              scores every call on chain (Node 20+, nothing to install). Each call prints as
//                                     soon as it is scored: Solana calls take no time, a Robinhood call takes from
//                                     seconds to minutes on the public RPC, because its prices are rebuilt from the chain
//   node witty_score.mjs --call 12    one call in full detail
//   node witty_score.mjs --selftest   offline checks
// Writes data/scores.json. Settings from the environment: WITTY_DATA (default ./data), WITTY_CONTRACT, WITTY_NETWORK,
// NEAR_RPC, RH_RPC, RH_RPC2.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { parseLadder, decideLadder, RUG_X } from "./witty_plan.mjs";
export { parseLadder, decideLadder };

export const VERSION = "witty-score 2 (public)";
/** How the record is measured: the same for every call, never part of a call's plan. */
export const MEASURE = { rug: 0.2, fees: 0.04, spikeX: 50 };
const HOUR_S = 3600;   // wording only ("in the hour" or "in the window")
export const RH_PUBLIC_RPC = "https://rpc.mainnet.chain.robinhood.com";
export const NEAR_PUBLIC_RPCS = { mainnet: ["https://free.rpc.fastnear.com", "https://rpc.mainnet.near.org"], testnet: ["https://test.rpc.fastnear.com", "https://rpc.testnet.near.org"] };

export const SWAP_V4 = "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f";   // Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)
export const INIT_V4 = "0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438";   // Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)
const LOG_SPAN = 10_000;          // blocks per eth_getLogs (Robinhood's RPC accepts 10,000)
const INIT_LOOKBACK_CHUNKS = 48;  // how far back to look for the pool's creation (48 x 10,000 blocks, about 13 h)
const Q96 = 2 ** 96;

// ---------------- pure scoring (tested in --selftest) ----------------

/** Drops one-reading spikes: a reading over 50x the previous counts only if the next is at least half of it. */
export function dropSpikes(readings) {
  return readings.filter((r, i) => {
    const prev = readings[i - 1], next = readings[i + 1];
    if (!prev || !(prev.px > 0) || !(r.px > MEASURE.spikeX * prev.px)) return true;
    return !!next && next.px >= r.px / 2;
  });
}

/** The call's trailing rule {arm, floor} (written "1.3x" or 1.3), or null for calls sealed without one. */
export function parseTrail(v, target) {
  if (v == null) return null;
  const num = (x) => (typeof x === "number" ? x : /^\s*\d*\.?\d+\s*x?\s*$/i.test(String(x)) ? parseFloat(x) : NaN);
  const arm = num(v.arm), floor = num(v.floor);
  if (!(arm > floor && floor > 1 && arm < target)) throw new Error(`bad trail: arm ${v.arm}, floor ${v.floor} (want 1x < floor < arm < the target)`);
  return { arm, floor };
}

/** A stop loss as written in a call: null, 0.6, "0.6x" or "-40%" -> 0.6. Must sit between the rug line and 1. */
export function parseStop(v) {
  if (v == null) return null;
  let x = NaN;
  if (typeof v === "number") x = v;
  else if (/^\s*\d*\.?\d+\s*x?\s*$/i.test(String(v))) x = parseFloat(v);
  else if (/^\s*-\s*\d+(\.\d+)?\s*%\s*$/.test(String(v))) x = 1 - parseFloat(String(v).replace(/[-%\s]/g, "")) / 100;
  if (!(x > MEASURE.rug && x < 1)) throw new Error(`stop loss ${JSON.stringify(v)} not understood (want a multiple of the entry like "0.6x", between ${MEASURE.rug}x and 1x)`);
  return +x.toFixed(6);
}

const num = (x) => (typeof x === "number" ? x : /^\s*\d*\.?\d+\s*x?\s*$/i.test(String(x)) ? parseFloat(x) : NaN);
const secs = (t) => { const m = String(t ?? "").match(/^\s*(\d+)\s*(d|h|m)\s*$/i); return m ? parseInt(m[1]) * { d: 86400, h: 3600, m: 60 }[m[2].toLowerCase()] : NaN; };

/** The plan of a call without a staged plan, as it was sealed: its target and its time limit. */
export function parseBasic(call) {
  const target = num(call?.target), windowS = secs(call?.time_limit);
  if (!(target > 1) || !(windowS > 0)) {
    throw new Error(`the call carries no plan the scorer can read (target ${JSON.stringify(call?.target ?? null)}, time_limit ${JSON.stringify(call?.time_limit ?? null)})`);
  }
  return { target, windowS, targetLabel: `${target}x`, windowLabel: String(call.time_limit).trim() };
}

/** The call's own plan on readings [{at (s after the call), px}] in time order. plan = parseBasic(call);
 *  stop = null (no stop loss) or a multiple of the entry; trail = null or {arm, floor}. */
export function decide(entry, readings, plan, stop = null, trail = null) {
  if (!(entry > 0)) return { scored: false, why: "no entry price" };
  let peak = 1, last = null;
  for (const r of dropSpikes(readings.filter((r) => r.at <= plan.windowS))) {
    const x = (r.px ?? 0) / entry;
    peak = Math.max(peak, x);
    if (x >= plan.target) return { scored: true, exit: plan.targetLabel, gross: plan.target, at: r.at, peak };
    if (!(r.px > 0) || x <= MEASURE.rug) return { scored: true, exit: "rugged", gross: Math.max(0, x), at: r.at, peak };
    if (trail && peak >= trail.arm && x <= trail.floor) return { scored: true, exit: "trail", gross: x, at: r.at, peak };
    if (stop != null && x <= stop) return { scored: true, exit: "stopped", gross: x, at: r.at, peak };
    last = { x, at: r.at };
  }
  if (!last) return { scored: false, why: "no prices found after the entry within the call's time limit (missing data is never scored)" };
  return { scored: true, exit: plan.windowLabel, gross: last.x, at: plan.windowS, peak };
}

export const afterFees = (gross) => gross * (1 - MEASURE.fees);

export function summarize(rows) {
  const s = rows.filter((r) => r.scored);
  if (!s.length) return { calls: 0 };
  const nets = s.map((r) => r.net).sort((a, b) => a - b);
  const mid = Math.floor(nets.length / 2);
  return {
    calls: s.length,
    per_dollar: +(nets.reduce((a, b) => a + b, 0) / s.length).toFixed(3),
    median: +(nets.length % 2 ? nets[mid] : (nets[mid - 1] + nets[mid]) / 2).toFixed(3),
    win_pct: Math.round((100 * s.filter((r) => r.net > 1).length) / s.length),
    hit_2x_pct: Math.round((100 * s.filter((r) => r.exit === "2x").length) / s.length),
    rugged_pct: Math.round((100 * s.filter((r) => /rugged/.test(String(r.exit))).length) / s.length),
    stopped_pct: Math.round((100 * s.filter((r) => r.exit === "stopped").length) / s.length),
    trail_pct: Math.round((100 * s.filter((r) => r.exit === "trail").length) / s.length),
    ladder_pct: Math.round((100 * s.filter((r) => String(r.exit).startsWith("ladder")).length) / s.length),
  };
}

/** Coin price in the other currency from a v4 sqrtPriceX96 (price = (sqrtP / 2^96)^2 = currency1 per currency0). */
export function v4Price(sqrtPriceX96, coinIs1, dec0, dec1) {
  const r = Number(BigInt(sqrtPriceX96)) / Q96;
  const oneIn0 = r * r * 10 ** (dec0 - dec1);           // human currency1 per currency0
  if (!(oneIn0 > 0)) return 0;
  return coinIs1 ? 1 / oneIn0 : oneIn0;
}
const sqrtOf = (log) => BigInt("0x" + log.data.slice(2 + 64 * 2, 2 + 64 * 3));          // Swap: amount0, amount1, sqrtPriceX96, ...
const initSqrtOf = (log) => BigInt("0x" + log.data.slice(2 + 64 * 3, 2 + 64 * 4));      // Initialize: fee, tickSpacing, hooks, sqrtPriceX96, tick
export const sha256Hex = (text) => crypto.createHash("sha256").update(text, "utf8").digest("hex");

// ---------------- price sources ----------------

/** Solana: the price recorder's file -> readings up to the call's time limit (and all of them, for staged plans). */
export function solanaReadings(file, calledMs, windowS) {
  let lines;
  try { lines = fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l)); } catch { return null; }
  const head = lines.find((l) => l.header);
  if (!head) return null;
  const px = (l) => (l.sol == null || l.tok == null || BigInt(l.tok) === 0n || BigInt(l.sol) === 0n) ? 0
    : (Number(BigInt(l.sol)) / 1e9) / (Number(BigInt(l.tok)) / 10 ** head.coin_decimals);
  const all = lines.filter((l) => !l.header && l.t >= calledMs).map((l) => ({ at: (l.t - calledMs) / 1000, px: px(l), slot: l.slot }));
  if (!all.length) return null;
  const [first, ...rest] = all;
  return { entry: first.px, entryAt: first.at, entrySlot: first.slot, readings: rest.filter((r) => r.at <= windowS), all: rest,
    pool: head.pool, source: `${head.venue === "feed" ? `${head.dex || "DEX"} pair price data` : head.venue === "curve" ? "pump.fun bonding curve" : "PumpSwap pool vaults"}, ${all.filter((r) => r.at <= HOUR_S).length} readings in the hour`,
    note: first.at > 120 ? `entry read ${Math.round(first.at)} s after the call` : undefined };
}

/** JSON-RPC that is gentle and patient: at most one request every `gapMs`; on "429 Too Many Requests", a timeout
 *  or an empty answer it waits (1 s, 2 s, 4 s) and asks again, then moves to the next URL. A URL that was still
 *  rate-limiting after all its tries is set aside for `coolMs` (unless every URL is set aside), so the next request
 *  goes straight to an RPC that answers. A missing result is an error, never "no data". Never prints a URL (they
 *  hold API keys). `stats` counts what happened. */
export function makeRpc(urls, fetchFn = fetch, { gapMs = 80, tries = 4, coolMs = 600_000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now() } = {}) {
  const list = urls.filter(Boolean);
  const stats = { requests: 0, retries: 0, fellOver: 0, setAside: 0 };
  const cooledUntil = new Map();   // URL index -> ms
  let nextAt = 0;
  const call = async (method, params) => {
    let last;
    const ready = list.map((_, i) => i).filter((i) => !((cooledUntil.get(i) || 0) > now()));
    const order = ready.length ? ready : list.map((_, i) => i);
    for (const [n, i] of order.entries()) {
      if (n > 0) stats.fellOver++;
      let limited = false;
      for (let attempt = 0; attempt < tries; attempt++) {
        if (attempt > 0) { stats.retries++; await sleep(1000 * 2 ** (attempt - 1)); }
        const wait = nextAt - Date.now();
        if (wait > 0) await sleep(wait);
        nextAt = Date.now() + gapMs;
        stats.requests++;
        limited = false;
        try {
          const r = await fetchFn(list[i], { method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(20_000) });
          if (r.status === 429) { last = new Error(`${method}: HTTP 429 Too Many Requests`); limited = true; continue; }   // wait, ask again
          const j = await r.json();
          if (j.error) {
            last = new Error(`${method}: ${JSON.stringify(j.error).slice(0, 160)}`);
            if (j.error.code === 429 || /too many|rate|limit|capacity/i.test(j.error.message || "")) { limited = true; continue; }   // wait, ask again
            break;                                                                                               // a real refusal: next URL
          }
          if (j.result === undefined || j.result === null) { last = new Error(`${method}: empty answer`); continue; }
          return j.result;
        } catch (e) { last = new Error(`${method}: ${e?.name || "error"}`); }
      }
      if (limited && list.length > 1) { cooledUntil.set(i, now() + coolMs); stats.setAside++; }   // still rate-limited: set it aside
    }
    throw last || new Error("no RPC set");
  };
  call.stats = stats;
  return call;
}

export const TOPIC = {
  v3Swap: "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67",   // Swap(address,address,int256,int256,uint160,uint128,int24)
  v2Sync: "0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1",   // Sync(uint112,uint112)
};
export const MODLIQ_V4 = "0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec";   // ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)
const word = (log, i) => BigInt("0x" + log.data.slice(2 + 64 * i, 2 + 64 * (i + 1)));
const int256 = (v) => (v >= 2n ** 255n ? v - 2n ** 256n : v);
const logIndex = (l) => parseInt(l.logIndex ?? "0x0", 16);
const addrOf = (hex32) => "0x" + String(hex32).slice(-40).toLowerCase();

/** Robinhood: the call's pool rebuilt from its own events. Uniswap v4 (32-byte pool id): Swap events of the
 *  PoolManager. Uniswap v3 / v2 (pool address): the pool's Swap / Sync events. */
export class Robinhood {
  constructor(rpc, pause = (ms) => new Promise((r) => setTimeout(r, ms))) { this.rpc = rpc; this.pause = pause; this.ts = new Map(); this.secsPerBlock = 0.105; }
  hex(n) { return "0x" + n.toString(16); }
  async blockTime(n) {
    if (!this.ts.has(n)) this.ts.set(n, parseInt((await this.rpc("eth_getBlockByNumber", [this.hex(n), false])).timestamp, 16));
    return this.ts.get(n);
  }
  /** The first block at or after this unix time (a binary search that starts near the expected block). */
  async blockAt(t) {
    const head = parseInt(await this.rpc("eth_blockNumber", []), 16);
    const headT = await this.blockTime(head);
    if (headT < t) return null;                                      // not mined yet
    const guess = Math.max(1, Math.min(head, head - Math.round((headT - t) / this.secsPerBlock)));
    let lo = Math.max(1, guess - 20_000), hi = Math.min(head, guess + 20_000);
    for (let k = 1; lo > 1 && (await this.blockTime(lo)) >= t; k++) { hi = lo; lo = Math.max(1, lo - 20_000 * 2 ** k); }
    for (let k = 1; hi < head && (await this.blockTime(hi)) < t; k++) { lo = hi; hi = Math.min(head, hi + 20_000 * 2 ** k); }
    while (hi - lo > 1) { const mid = Math.floor((lo + hi) / 2); if ((await this.blockTime(mid)) < t) lo = mid; else hi = mid; }
    return hi;
  }
  async logs(filter, from, to) {
    const out = [];
    for (let f = from; f <= to; f += LOG_SPAN) {
      out.push(...await this.rpc("eth_getLogs", [{ ...filter, fromBlock: this.hex(f), toBlock: this.hex(Math.min(to, f + LOG_SPAN - 1)) }]));
    }
    return out;
  }
  async decimals(addr) {
    if (/^0x0{40}$/.test(addr)) return 18;                          // native ETH
    const d = parseInt(await this.rpc("eth_call", [{ to: addr, data: "0x313ce567" }, "latest"]), 16);
    if (!Number.isInteger(d)) throw new Error(`decimals() of ${addr} unreadable`);
    return d;
  }
  async readings(call, calledMs, windowS) {   // the call's own time limit
    const pool = String(call.pool_address || "").toLowerCase();
    const isV4 = /^0x[0-9a-f]{64}$/.test(pool), isAddr = /^0x[0-9a-f]{40}$/.test(pool);
    if (!isV4 && !isAddr) return { why: `pool ${call.pool_address || "(none)"} is neither a Uniswap v4 pool id nor a pool address` };
    const t0 = Math.floor(calledMs / 1000);
    const startBlock = await this.blockAt(t0);
    const endBlock = await this.blockAt(t0 + windowS);
    if (!startBlock || !endBlock) return { why: windowS > HOUR_S ? "the call's window isn't over on the chain yet" : "the call's first hour isn't over on the chain yet" };
    const coin = String(call.contract_address).toLowerCase();
    const read = () => (isV4 ? this.v4Events(pool, coin, startBlock, endBlock) : this.v2v3Events(pool, coin, startBlock, endBlock));
    let r = await read();
    if (r.why) return r;
    if (!r.events.some((e) => e.block >= startBlock)) { await this.pause(3000); r = await read(); }   // read once more before saying "none"
    if (r.why) return r;
    const events = [...r.events].sort((a, b) => a.block - b.block || a.li - b.li);
    const before = events.filter((e) => e.block < startBlock), after = events.filter((e) => e.block >= startBlock);
    const swapsBefore = before.filter((e) => e.kind === "swap");
    // the pool was already emptied (all liquidity pulled) when the call was made: nobody could sell, a loss at 0
    if (before.at(-1)?.kind === "empty") {
      const secs = Math.round((startBlock - before.at(-1).block) * this.secsPerBlock);
      return { entry: swapsBefore.at(-1)?.px ?? r.opening ?? 1, readings: [{ at: 0, px: 0, block: startBlock }], startBlock, endBlock,
        note: `all liquidity was pulled from the pool about ${secs} s before the call: nobody could sell`,
        source: `${r.kind} events: liquidity removed at block ${before.at(-1).block}, the call came at block ${startBlock}` };
    }
    const moves = after.filter((e) => e.kind !== "refill");
    if (!moves.length) return { why: `no swaps found in the pool during the hour (blocks ${startBlock}-${endBlock}), read twice: not scored, check the pool` };
    let entry, entryNote;
    if (swapsBefore.length) entry = swapsBefore.at(-1).px;
    else if (r.opening != null) { entry = r.opening; entryNote = "entry = the pool's opening price"; }
    else { entry = moves.find((e) => e.kind === "swap")?.px; entryNote = "entry = the first swap after the call"; }
    const span = endBlock - startBlock;
    const readings = moves.map((e) => ({ at: ((e.block - startBlock) / span) * windowS, px: e.kind === "empty" ? 0 : e.px, block: e.block }));
    const pulled = moves.find((e) => e.kind === "empty");
    return { entry, readings, startBlock, endBlock,
      note: [r.note, entryNote, pulled ? `liquidity pulled at block ${pulled.block}` : null].filter(Boolean).join("; ") || undefined,
      source: `${r.kind} events, blocks ${startBlock}-${endBlock}, ${moves.filter((e) => e.kind === "swap").length} swaps in the ${windowS > HOUR_S ? "window" : "hour"}` };
  }
  /** Uniswap v4: currencies from the pool's Initialize event, prices from the PoolManager's Swap events. */
  async v4Events(poolId, coin, startBlock, endBlock) {
    let init = null;
    for (let k = 0; k < INIT_LOOKBACK_CHUNKS && !init; k++) {
      const to = startBlock - k * LOG_SPAN, from = Math.max(1, to - LOG_SPAN + 1);
      const found = await this.rpc("eth_getLogs", [{ fromBlock: this.hex(from), toBlock: this.hex(to), topics: [INIT_V4, poolId] }]);
      if (found.length) init = found[0];
      if (from === 1) break;
    }
    let c0, c1, note;
    if (init) { c0 = addrOf(init.topics[2]); c1 = addrOf(init.topics[3]); }
    else { c0 = "0x" + "0".repeat(40); c1 = coin; note = "pool creation not found: assumed coin/ETH"; }
    const coinIs1 = c1 === coin;
    if (!coinIs1 && c0 !== coin) return { why: `pool ${poolId.slice(0, 10)}... does not hold the called coin` };
    const [d0, d1] = [await this.decimals(c0), await this.decimals(c1)];
    const initBlock = init ? parseInt(init.blockNumber, 16) : null;
    const from = Math.max(initBlock ?? 1, startBlock - 4 * LOG_SPAN);
    const logs = await this.logs({ topics: [SWAP_V4, poolId] }, from, endBlock);
    const events = logs.map((l) => ({ kind: "swap", block: parseInt(l.blockNumber, 16), li: logIndex(l), px: v4Price(sqrtOf(l), coinIs1, d0, d1) }));
    // liquidity in the pool, from every ModifyLiquidity since its creation: "empty" when 99% or more is pulled
    if (initBlock != null) {
      const changes = (await this.logs({ topics: [MODLIQ_V4, poolId] }, initBlock, endBlock))
        .map((l) => ({ block: parseInt(l.blockNumber, 16), li: logIndex(l), delta: int256(word(l, 2)) }))
        .sort((a, b) => a.block - b.block || a.li - b.li);
      let total = 0n, peak = 0n, empty = false;
      for (const c of changes) {
        total += c.delta;
        if (total > peak) peak = total;
        const nowEmpty = peak > 0n && total * 100n <= peak;
        if (nowEmpty !== empty) { events.push({ kind: nowEmpty ? "empty" : "refill", block: c.block, li: c.li }); empty = nowEmpty; }
      }
    } else note = [note, "liquidity pulls can't be checked without the pool's creation"].filter(Boolean).join("; ");
    return { kind: "Uniswap v4 Swap", note,
      opening: initBlock != null && initBlock >= from ? v4Price(initSqrtOf(init), coinIs1, d0, d1) : null, events };
  }
  /** Uniswap v3 / v2 pool at an address: token0/token1 from the pool; v3 Swap events, or v2 Sync events. */
  async v2v3Events(pool, coin, startBlock, endBlock) {
    const t0 = addrOf(await this.rpc("eth_call", [{ to: pool, data: "0x0dfe1681" }, "latest"]));   // token0()
    const t1 = addrOf(await this.rpc("eth_call", [{ to: pool, data: "0xd21220a7" }, "latest"]));   // token1()
    const coinIs1 = t1 === coin;
    if (!coinIs1 && t0 !== coin) return { why: `pool ${pool.slice(0, 10)}... does not hold the called coin` };
    const [d0, d1] = [await this.decimals(t0), await this.decimals(t1)];
    const from = startBlock - 4 * LOG_SPAN;
    const v3 = await this.logs({ address: pool, topics: [TOPIC.v3Swap] }, from, endBlock);
    if (v3.length) {
      return { kind: "Uniswap v3 Swap", opening: null, note: "v3 liquidity pulls are not checked yet (prices only)",
        events: v3.map((l) => ({ kind: "swap", block: parseInt(l.blockNumber, 16), li: logIndex(l), px: v4Price(word(l, 2), coinIs1, d0, d1) })) };
    }
    // v2: every Sync carries both reserves; when the other side (ETH) falls to 1% of its peak, the pool was emptied
    const v2 = await this.logs({ address: pool, topics: [TOPIC.v2Sync] }, from, endBlock);
    let peakQuote = 0;
    const events = v2.map((l) => {
      const r0 = Number(word(l, 0)) / 10 ** d0, r1 = Number(word(l, 1)) / 10 ** d1;
      const quote = coinIs1 ? r0 : r1;
      peakQuote = Math.max(peakQuote, quote);
      const base = { block: parseInt(l.blockNumber, 16), li: logIndex(l) };
      if (!(r0 > 0) || !(r1 > 0) || quote <= peakQuote / 100) return { ...base, kind: "empty" };
      return { ...base, kind: "swap", px: coinIs1 ? r0 / r1 : r1 / r0 };
    });
    return { kind: "Uniswap v2 Sync", opening: null, events };
  }
}

// ---------------- scoring a call ----------------

/** A call's kind is its `category`. Only calls sealed before kinds existed lack it: those get theirs from their old type. */
const OLD_GAMBLE_TYPES = new Set(["leader", "graduation"]);
export const kindOf = (call) => call.category || (!call.call_type || OLD_GAMBLE_TYPES.has(call.call_type) ? "gamble" : "scalping");

export async function scoreCall({ id, hash, callJson, warmUp, status, pricesDir, rh }) {
  const row = { id, hash, warm_up: !!warmUp, status };
  if (status === "expired") return Object.assign(row, { scored: true, exit: "expired", gross: 0, net: 0, why: "never revealed before the deadline: counts as a loss" });
  if (!callJson) return Object.assign(row, { scored: false, why: "not revealed yet" });
  if (sha256Hex(callJson) !== hash) return Object.assign(row, { scored: false, why: "the revealed JSON does NOT match the sealed hash" });
  const call = JSON.parse(callJson);
  Object.assign(row, { token: call.token, chain: call.chain, called_at: call.called_at,
    contract_address: call.contract_address, rules_version: call.rules_version, stop_loss: call.stop_loss ?? null });
  let stop = null, trail = null, ladder = null, basic = null;
  try {
    ladder = parseLadder(call.plan ?? null);
    stop = parseStop(call.stop_loss);
    if (!ladder) { basic = parseBasic(call); trail = parseTrail(call.trail ?? null, basic.target); }
  } catch (e) { return Object.assign(row, { scored: false, why: e.message }); }
  const windowS = ladder ? ladder.windowS : basic.windowS;
  row.category = kindOf(call);
  const calledMs = Date.parse(call.called_at);
  let src;
  if (call.chain === "solana") {
    src = solanaReadings(path.join(pricesDir, `${hash}.jsonl`), calledMs, windowS);
    if (!src) return Object.assign(row, { scored: false, why: "no chain prices recorded (sealed before the price recorder started)" });
    if (Date.now() - calledMs < windowS * 1000) return Object.assign(row, { scored: false, why: "the call's time limit isn't over yet" });
  } else if (call.chain === "robinhood") {
    if (!rh) return Object.assign(row, { scored: false, why: "no Robinhood RPC" });
    src = await rh.readings(call, calledMs, windowS);
    if (src.why) return Object.assign(row, { scored: false, why: src.why });
  } else return Object.assign(row, { scored: false, why: `chain ${call.chain} is not scored` });
  const d = ladder ? decideLadder(src.entry, dropSpikes(src.all || src.readings), ladder) : decide(src.entry, src.readings, basic, stop, trail);
  if (d.scored && !ladder) {   // a call without a staged plan: the peak is the highest price in its window too, even after the exit
    const top = Math.max(1, ...dropSpikes(src.readings || []).filter((r) => r.at <= windowS && r.px > 0).map((r) => r.px / src.entry));
    d.peak = Math.max(d.peak || 1, top);
  }
  if (!d.scored) return Object.assign(row, { scored: false, why: d.why });
  row.peak = +(d.peak || 1).toFixed(3);   // how high it went (shown on rugs)
  if (ladder) { row.plan = ladder.kind; row.steps = d.steps; row.cost = +d.cost.toFixed(3); }
  const brief = (x) => ({ exit: x.exit, gross: +x.gross.toFixed(4), net: +afterFees(x.gross).toFixed(4), exit_minute: +(x.at / 60).toFixed(1) });
  return Object.assign(row, { scored: true, ...brief(d), peak_x: +d.peak.toFixed(2), entry_price: src.entry, source: src.source, note: src.note || d.note });
}

// ---------------- selftest (made-up calls and plans: none of these is one of Witty's) ----------------

async function selftest() {
  const results = [];
  const check = (name, ok) => results.push([name, !!ok]);
  const R = (pairs) => pairs.map(([m, x]) => ({ at: m * 60, px: x }));
  const near = (a, b, e = 1e-9) => Math.abs(a - b) < e;
  const P = parseBasic({ target: "3x", time_limit: "2h" });

  // the call's own plan
  check("the plan is read from the call: target \"3x\" and time limit \"2h\" -> 3 and 7200 s; \"1.9x\" and \"45m\" too",
    P.target === 3 && P.windowS === 7200 && P.targetLabel === "3x" && P.windowLabel === "2h" &&
    parseBasic({ target: "1.9x", time_limit: "45m" }).windowS === 2700 && parseBasic({ target: 2, time_limit: "1d" }).windowS === 86400);
  check("a call that carries no readable plan is refused, never given a default",
    [{}, { target: "3x" }, { time_limit: "2h" }, { target: "0.8x", time_limit: "2h" }, { target: "3x", time_limit: "soon" }].every((c) => { try { parseBasic(c); return false; } catch { return true; } }));
  check("the target at minute 12 -> sold at the target (3.00x), 2.88x after fees",
    (() => { const d = decide(1, R([[2, 1.3], [12, 3.1], [30, 0.1]]), P); return d.exit === "3x" && d.gross === 3 && afterFees(d.gross) === 2.88 && d.at === 720; })());
  check("rugged (0.2x or less) before the target -> sold at the rug price",
    (() => { const d = decide(1, R([[5, 1.5], [9, 0.15], [20, 4]]), P); return d.exit === "rugged" && d.gross === 0.15 && d.at === 540; })());
  check("a dip that isn't a rug, then the target -> the target", decide(1, R([[3, 0.5], [40, 3.4]]), P).exit === "3x");
  check("neither -> sold at the price when the call's time limit ends; readings after it don't count",
    (() => { const d = decide(2, R([[10, 2.6], [119.9, 1.8], [130, 9]]), P); return d.exit === "2h" && near(d.gross, 0.9) && d.at === 7200; })());
  check("pool emptied (price 0) -> rugged at 0", (() => { const d = decide(1, R([[4, 1.2], [7, 0]]), P); return d.exit === "rugged" && d.gross === 0; })());
  check("no prices at all after the entry -> NOT scored (missing data never becomes a result)",
    (() => { const d = decide(1, [], P); return d.scored === false && /never scored/.test(d.why); })());
  check("a lone 60x spike is ignored; a confirmed one counts",
    decide(1, R([[1, 1.1], [2, 70], [3, 1.1]]), P).exit === "2h" && decide(1, R([[1, 1.1], [2, 70], [3, 60]]), P).exit === "3x");
  check("no entry price -> not scored", decide(0, R([[1, 2]]), P).scored === false);

  // the call's trailing rule and stop loss, when it has them
  const TR = parseTrail({ arm: "1.3x", floor: "1.15x" }, P.target);
  check("trail: up to 1.35x then back to 1.1x -> sold at 1.10x (trail)", (() => { const d = decide(1, R([[5, 1.35], [15, 1.1], [50, 0.3]]), P, 0.6, TR); return d.exit === "trail" && d.gross === 1.1 && d.at === 900; })());
  check("trail: never armed (high 1.25x) -> falls through to the stop", decide(1, R([[5, 1.25], [15, 0.55]]), P, 0.6, TR).exit === "stopped");
  check("trail: armed, then straight to the target -> the target", decide(1, R([[5, 1.35], [15, 3.1]]), P, 0.6, TR).exit === "3x");
  check("a call sealed without a trailing rule ignores trails", decide(1, R([[5, 1.35], [15, 1.1], [119, 1.05]]), P, 0.6, null).exit === "2h");
  check("trail: a floor above the arm, or an arm above the target, is refused",
    [() => parseTrail({ arm: "1.2x", floor: "1.3x" }, 3), () => parseTrail({ arm: "3.5x", floor: "1.3x" }, 3)].every((f) => { try { f(); return false; } catch { return true; } }));
  const dipThenUp = R([[3, 0.8], [6, 0.55], [20, 3.2]]);
  check("stop 0.6x: a dip to 0.55x is sold there (0.55x, 0.528x after fees) at minute 6",
    (() => { const d = decide(1, dipThenUp, P, 0.6); return d.exit === "stopped" && d.gross === 0.55 && d.at === 360 && near(afterFees(d.gross), 0.528); })());
  check("the same coin with no stop goes on to the target", decide(1, dipThenUp, P).exit === "3x");
  check("a crash that gaps through the stop sells at the price it gapped to (0.25x), not at the stop",
    (() => { const d = decide(1, R([[2, 1.1], [5, 0.25]]), P, 0.6); return d.exit === "stopped" && d.gross === 0.25; })());
  check("a stop can't beat an instant pull: pool emptied -> still rugged at 0.00x",
    (() => { const d = decide(1, R([[2, 1.1], [3, 0]]), P, 0.6); return d.exit === "rugged" && d.gross === 0; })());
  check("stop loss written as 0.6x, 0.6, -40% or -70% (0.3x); null = no stop; nonsense is refused",
    parseStop("0.6x") === 0.6 && parseStop(0.6) === 0.6 && parseStop("-40%") === 0.6 && parseStop("-70%") === 0.3 && parseStop(null) === null &&
    [() => parseStop("0.1x"), () => parseStop("1.5x"), () => parseStop("half"), () => parseStop("-90%")].every((f) => { try { f(); return false; } catch { return true; } }));
  check("staged plans are played by witty_plan.mjs (its own selftest covers them), at the record's rug line",
    RUG_X === MEASURE.rug && decideLadder(1, R([[5, 1.45], [20, 2.6], [40, 3.0], [60, 2.0]]), parseLadder({ kind: "ladder", entries: [{ at: "1x", buy: 1 }], tp1: { at: "1.4x", sell: 0.4 },
      dip: { at: "1.1x", sell: 0.3 }, tp2: { at: "2.5x", keep: 0.2 }, runner_trail: 0.3, stop: "0.75x", time_limit: "4h" })).exit === "trail");

  // the headline
  const sum = summarize([{ scored: true, net: 1.92, exit: "2x" }, { scored: true, net: 0.096, exit: "rugged" }, { scored: true, net: 1.152, exit: "1h" }, { scored: false }]);
  check("headline: $1 per call, median, win %, rug % over scored calls only",
    sum.calls === 3 && sum.per_dollar === 1.056 && sum.median === 1.152 && sum.win_pct === 67 && sum.rugged_pct === 33);
  check("headline counts stopped calls", summarize([{ scored: true, net: 0.48, exit: "stopped" }, { scored: true, net: 1.92, exit: "3x" }]).stopped_pct === 50);
  check("kind of call: the call's own category; older calls by their type",
    kindOf({ category: "conviction", call_type: "leader" }) === "conviction" && kindOf({ call_type: "leader" }) === "gamble" &&
    kindOf({ call_type: "graduation" }) === "gamble" && kindOf({}) === "gamble" && kindOf({ call_type: "another" }) === "scalping");

  // Uniswap v4 price maths: sqrtP = 2^96 means 1:1; 2 x 2^96 means 4 coins per ETH = 0.25 ETH per coin
  check("v4 price: coin as currency1 with ETH as currency0",
    v4Price(2n ** 96n, true, 18, 18) === 1 && v4Price(2n ** 97n, true, 18, 18) === 0.25 && v4Price(2n ** 97n, false, 18, 18) === 4);
  check("v4 price: a real swap (sqrtP 6.07e32) = about 1.70e-8 ETH per coin",
    Math.abs(v4Price(606996633585556073234591992351544n, true, 18, 18) / 1.7037e-8 - 1) < 0.001);

  // Solana: a recorder file
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "witty-score-test-"));
  const called = Date.parse("2026-10-01T00:12:00Z");   // in the past, so its time limit is over
  const hdr = { header: "witty-prices 1.0", pool: "POOL", coin_decimals: 6 };
  const lineAt = (s, sol, tok) => ({ t: called + s * 1000, slot: 1000 + s, sol: String(sol), tok: String(tok) });
  const solCall = { contract_address: "MINT", chain: "solana", call_type: "graduation", token: "TEST", called_at: new Date(called).toISOString(), pool_address: "POOL", rules_version: "test", target: "1.9x", time_limit: "1h" };
  const solJson = JSON.stringify(solCall);
  const solHash = sha256Hex(solJson);
  const fileOf = (hash, lines) => fs.writeFileSync(path.join(tmp, `${hash}.jsonl`), [hdr, ...lines].map((l) => JSON.stringify(l)).join("\n") + "\n");
  // 85 SOL / 200M coins -> the price doubles when SOL doubles and coins halve
  fileOf(solHash, [lineAt(4, 85e9, 200e12), lineAt(600, 100e9, 170e12), lineAt(1500, 130e9, 150e12), lineAt(1510, 2e9, 900e12), lineAt(3590, 1e9, 950e12), lineAt(3700, 1e9, 950e12)]);
  let row = await scoreCall({ id: "7", hash: solHash, callJson: solJson, warmUp: false, status: "revealed", pricesDir: tmp });
  check("Solana: priced from the recorder file; the call's target (1.9x) at minute 25 -> 1.824x after fees",
    row.scored && row.exit === "1.9x" && row.net === 1.824 && row.exit_minute === 25 && /PumpSwap pool vaults/.test(row.source) && row.category === "gamble");
  fileOf(solHash, [lineAt(3, 85e9, 200e12), lineAt(900, 60e9, 260e12), lineAt(3595, 50e9, 290e12), lineAt(4000, 500e9, 1e12)]);
  row = await scoreCall({ id: "7", hash: solHash, callJson: solJson, status: "revealed", pricesDir: tmp });
  const want = (50 / 290) / (85 / 200);
  check("Solana: no target, no rug -> the reading at the end of the call's time limit sets the result; later readings are ignored",
    row.exit === "1h" && near(row.gross, want, 1e-4) && near(row.net, want * 0.96, 1e-4) && row.stop_loss === null);
  row = await scoreCall({ id: "7", hash: solHash, callJson: solJson.replace("TEST", "FAKE"), status: "revealed", pricesDir: tmp });
  check("a revealed JSON that doesn't match its sealed hash is not scored", !row.scored && /does NOT match/.test(row.why));
  const oldJson = JSON.stringify({ ...solCall, token: "OLD" });
  row = await scoreCall({ id: "0", hash: sha256Hex(oldJson), callJson: oldJson, warmUp: true, status: "revealed", pricesDir: tmp });
  check("a Solana call sealed before the recorder existed: not scored, and says why", !row.scored && /before the price recorder/.test(row.why));
  const noPlan = JSON.stringify({ ...solCall, token: "NOPLAN", target: undefined, time_limit: undefined });
  row = await scoreCall({ id: "8", hash: sha256Hex(noPlan), callJson: noPlan, status: "revealed", pricesDir: tmp });
  check("a call that carries no plan: NOT scored, and says why", !row.scored && /no plan the scorer can read/.test(row.why));
  const stopJson = JSON.stringify({ ...solCall, token: "STOPPY", stop_loss: "0.6x" }), stopHash = sha256Hex(stopJson);
  fileOf(stopHash, [lineAt(4, 85e9, 200e12), lineAt(600, 55e9, 260e12), lineAt(1800, 130e9, 150e12), lineAt(4000, 900e9, 100e12)]);
  row = await scoreCall({ id: "30", hash: stopHash, callJson: stopJson, status: "revealed", pricesDir: tmp });
  const wantStop = (55 / 260) / (85 / 200);
  check("a call sealed with its own stop loss (0.6x) is scored under it: stopped at minute 10",
    row.scored && row.exit === "stopped" && row.stop_loss === "0.6x" && near(row.gross, wantStop, 1e-4) && row.exit_minute === 10);
  check("its peak is the highest price in its time limit, even after the stop (2.04x at minute 30), never after it (the 4000 s reading)",
    row.peak_x === +((130 / 150) / (85 / 200)).toFixed(2) && row.peak === +((130 / 150) / (85 / 200)).toFixed(3));
  const venueOf = async (h) => { const j = JSON.stringify({ ...solCall, token: `V${Math.random()}` }), hh = sha256Hex(j);
    fs.writeFileSync(path.join(tmp, `${hh}.jsonl`), [{ ...hdr, ...h }, lineAt(4, 85e9, 200e12), lineAt(600, 90e9, 190e12)].map((l) => JSON.stringify(l)).join("\n") + "\n");
    return (await scoreCall({ id: "40", hash: hh, callJson: j, status: "revealed", pricesDir: tmp })).source; };
  check("each Solana call says where its prices came from: the pool, the bonding curve, or a DEX pair's price data",
    /^PumpSwap pool vaults, 2 readings/.test(await venueOf({})) && /^pump\.fun bonding curve, /.test(await venueOf({ venue: "curve" })) &&
    /^Raydium pair price data, /.test(await venueOf({ venue: "feed", dex: "Raydium" })) && /^DEX pair price data, /.test(await venueOf({ venue: "feed" })));
  const badStop = JSON.stringify({ ...solCall, token: "BAD", stop_loss: "maybe" });
  row = await scoreCall({ id: "31", hash: sha256Hex(badStop), callJson: badStop, status: "revealed", pricesDir: tmp });
  check("a sealed stop loss the scorer can't read: NOT scored, and says why", !row.scored && /stop loss "maybe" not understood/.test(row.why));
  const stagedJson = JSON.stringify({ ...solCall, token: "STAGED", category: "conviction", target: undefined, time_limit: undefined,
    plan: { kind: "steps", entries: [{ at: "1x", buy: 1 }], sells: [{ at: "1.5x", sell: 0.5 }], stop: null, time_limit: "3h" } }), stagedHash = sha256Hex(stagedJson);
  fileOf(stagedHash, [lineAt(4, 85e9, 200e12), lineAt(3000, 130e9, 200e12), lineAt(10700, 110.5e9, 200e12), lineAt(11000, 999e9, 200e12)]);
  row = await scoreCall({ id: "32", hash: stagedHash, callJson: stagedJson, status: "revealed", pricesDir: tmp });
  check("a staged plan: played on the call's own 3 h, half sold at its 1.5x level (1.53x), the rest at the end (1.3x)",
    row.scored && row.plan === "steps" && row.category === "conviction" && near(row.gross, 0.5 * (130 / 85) + 0.5 * 1.3, 1e-4) && row.exit === "time");
  const { call_type: _t, ...newStyle } = { ...solCall, token: "NEWSTYLE", category: "scalping" };
  const newJson = JSON.stringify(newStyle), newHash = sha256Hex(newJson);
  fileOf(newHash, [lineAt(4, 85e9, 200e12), lineAt(1500, 130e9, 150e12)]);
  row = await scoreCall({ id: "41", hash: newHash, callJson: newJson, status: "revealed", pricesDir: tmp });
  check("a call sealed today (its kind in `category`, no call type) is scored from what it carries, and no row carries a call type",
    row.scored && row.category === "scalping" && row.exit === "1.9x" && !("call_type" in row));
  row = await scoreCall({ id: "3", hash: "x", callJson: null, status: "expired", pricesDir: tmp });
  check("a call never revealed by its deadline counts as a loss (0.00x)", row.scored && row.net === 0 && row.exit === "expired");
  row = await scoreCall({ id: "4", hash: "x", callJson: null, status: "sealed", pricesDir: tmp });
  check("a sealed call isn't scored until it is revealed", !row.scored && /not revealed/.test(row.why));

  // Robinhood: a fake chain, 10 blocks per second, a pool created 100 s before the call
  const T0 = Math.floor(called / 1000), B0 = 5_000_000, HEAD = B0 + 60_000;
  const tsOf = (b) => T0 + Math.floor((b - B0) / 10);
  const pool = "0x" + "ab".repeat(32), coin = "0x3e9ad76660c8da6a81140f8fc759aa23eb785606";
  const word = (v) => BigInt(v).toString(16).padStart(64, "0");
  const swap = (b, sqrt) => ({ blockNumber: "0x" + b.toString(16), topics: [SWAP_V4, pool], data: "0x" + word(0) + word(0) + word(sqrt) + word(0) + word(0) + word(0) });
  const S = 2n ** 96n;                                  // 1 coin per ETH
  const swaps = [swap(B0 - 500, S), swap(B0 + 3000, S * 9n / 10n), swap(B0 + 15000, S * 7n / 10n), swap(B0 + 36500, S / 10n)];
  const initLog = { blockNumber: "0x" + (B0 - 1000).toString(16), topics: [INIT_V4, pool, "0x" + "0".repeat(64), "0x" + "0".repeat(24) + coin.slice(2)], data: "0x" + word(10000) + word(200) + word(0) + word(S) + word(0) };
  // a v4 pool that only traded before the call
  const quiet = "0x" + "cd".repeat(32);
  const quietLogs = [{ ...initLog, topics: [INIT_V4, quiet, initLog.topics[2], initLog.topics[3]] }, { ...swap(B0 - 400, S), topics: [SWAP_V4, quiet] }];
  // a Uniswap v3 pool: token0 = WETH, token1 = the coin; rugged at minute 10 (price 1 -> 1/2.45^2 = 0.167)
  const V3 = "0x" + "c3".repeat(20), coin3 = "0x" + "5c".repeat(20), weth = "0x" + "11".repeat(20);
  const v3swap = (b, sqrt) => ({ address: V3, blockNumber: "0x" + b.toString(16), topics: [TOPIC.v3Swap, "0x" + "0".repeat(64), "0x" + "0".repeat(64)], data: "0x" + word(0) + word(0) + word(sqrt) + word(0) + word(0) });
  // a Uniswap v2 pool: token0 = the coin, token1 = WETH; 1h price 1.2105x the entry
  const V2 = "0x" + "c2".repeat(20), coin2 = "0x" + "0a".repeat(20), weth2 = "0x" + "fe".repeat(20);
  const sync = (b, r0, r1) => ({ address: V2, blockNumber: "0x" + b.toString(16), topics: [TOPIC.v2Sync], data: "0x" + word(r0) + word(r1) });
  const E = 10n ** 18n;
  // liquidity pulls (Uniswap v4 ModifyLiquidity: tickLower, tickUpper, liquidityDelta as int256, salt)
  const hexb = (b) => "0x" + b.toString(16);
  const i256 = (v) => (v < 0n ? 2n ** 256n + v : v);
  const initOf = (b, id) => ({ ...initLog, blockNumber: hexb(b), topics: [INIT_V4, id, initLog.topics[2], initLog.topics[3]] });
  const swapIn = (b, id, sqrt, li = 1) => ({ ...swap(b, sqrt), logIndex: hexb(li), topics: [SWAP_V4, id] });
  const liq = (b, id, delta, li = 0) => ({ blockNumber: hexb(b), logIndex: hexb(li), topics: [MODLIQ_V4, id, "0x" + "0".repeat(64)], data: "0x" + word(0) + word(0) + word(i256(delta)) + word(0) });
  const rugP = "0x" + "ee".repeat(32), midP = "0x" + "dd".repeat(32), refP = "0x" + "fa".repeat(32);
  const pullLogs = [
    // created 75 s before, traded, ALL liquidity removed 13 s before the call
    initOf(B0 - 750, rugP), liq(B0 - 750, rugP, 1000n), swapIn(B0 - 600, rugP, S), swapIn(B0 - 200, rugP, S * 9n / 10n), liq(B0 - 130, rugP, -1000n),
    // traded up to 1.5x, then pulled at minute 8 (before the target)
    initOf(B0 - 1000, midP), liq(B0 - 1000, midP, 500n), swapIn(B0 - 300, midP, S), swapIn(B0 + 2000, midP, S * 8165n / 10000n), liq(B0 + 4800, midP, -500n),
    // emptied and refilled before the call: alive at the call, its target at minute 5
    initOf(B0 - 2000, refP), liq(B0 - 2000, refP, 100n), liq(B0 - 1500, refP, -100n), liq(B0 - 1000, refP, 200n), swapIn(B0 - 500, refP, S), swapIn(B0 + 3000, refP, S * 7n / 10n),
  ];
  const V2b = "0x" + "b2".repeat(20), coin2b = "0x" + "0b".repeat(20);
  const syncB = (b, r0, r1) => ({ ...sync(b, r0, r1), address: V2b });
  const allLogs = [initLog, ...swaps, ...quietLogs, ...pullLogs,
    v3swap(B0 - 100, S), v3swap(B0 + 6000, S * 245n / 100n), v3swap(B0 + 7000, S),
    sync(B0 - 50, 1000n * E, E), sync(B0 + 18000, 900n * E, 11n * E / 10n), sync(B0 + 35000, 950n * E, 115n * E / 100n),
    syncB(B0 - 40, 1000n * E, E), syncB(B0 + 9000, 1000n * E, E / 200n)];
  const tokens = { [V3]: [weth, coin3], [V2]: [coin2, weth2], [V2b]: [coin2b, weth2] };
  let rpcCalls = 0;
  const fakeRh = async (m, p) => {
    rpcCalls++;
    if (m === "eth_blockNumber") return "0x" + HEAD.toString(16);
    if (m === "eth_getBlockByNumber") return { timestamp: "0x" + tsOf(parseInt(p[0], 16)).toString(16) };
    if (m === "eth_call") {
      const { to, data } = p[0];
      if (data === "0x0dfe1681") return "0x" + "0".repeat(24) + tokens[to][0].slice(2);
      if (data === "0xd21220a7") return "0x" + "0".repeat(24) + tokens[to][1].slice(2);
      return "0x" + word(18);
    }
    if (m === "eth_getLogs") {
      const { fromBlock, toBlock, topics = [], address } = p[0], f = parseInt(fromBlock, 16), t = parseInt(toBlock, 16);
      return allLogs.filter((l) => (!address || l.address === address) && topics.every((x, i) => x == null || l.topics[i] === x) &&
        parseInt(l.blockNumber, 16) >= f && parseInt(l.blockNumber, 16) <= t);
    }
    throw new Error("unexpected " + m);
  };
  const rh = new Robinhood(fakeRh, async () => {});
  check("block search: the first block at or after a time", (await rh.blockAt(T0)) === B0 && (await rh.blockAt(T0 + 3600)) === B0 + 36000);
  const rhCall = { contract_address: coin, chain: "robinhood", call_type: "leader", token: "NET", called_at: new Date(called).toISOString(), pool_address: pool, rules_version: "test", target: "1.9x", time_limit: "1h" };
  const rhJson = JSON.stringify(rhCall);
  row = await scoreCall({ id: "1", hash: sha256Hex(rhJson), callJson: rhJson, warmUp: true, status: "revealed", pricesDir: tmp, rh });
  // price per coin = 1/(sqrt/2^96)^2: 1 -> 1/0.81 = 1.234 (min 5) -> 1/0.49 = 2.04 at minute 25, over the call's 1.9x target
  check("Robinhood: rebuilt from the pool's Swap events; entry = last swap before the call; the call's target (1.9x) at minute 25",
    row.scored && row.exit === "1.9x" && row.net === 1.824 && row.exit_minute === 25 && /Swap events/.test(row.source) && row.warm_up);
  check("Robinhood: swaps after the hour (block 36,500 > 36,000) don't count", /3 swaps in the hour|2 swaps in the hour/.test(row.source));
  const badPool = JSON.stringify({ ...rhCall, pool_address: "0x1234" });
  row = await scoreCall({ id: "2", hash: sha256Hex(badPool), callJson: badPool, status: "revealed", pricesDir: tmp, rh });
  check("Robinhood: a pool that is neither a v4 id nor an address is not scored, and says why", !row.scored && /neither/.test(row.why));
  const future = JSON.stringify({ ...rhCall, called_at: new Date((T0 + 5900) * 1000).toISOString() });
  row = await scoreCall({ id: "5", hash: sha256Hex(future), callJson: future, status: "revealed", pricesDir: tmp, rh });
  check("Robinhood: not scored before its hour is over on the chain", !row.scored && /isn't over/.test(row.why));
  const quietJson = JSON.stringify({ ...rhCall, pool_address: quiet });
  row = await scoreCall({ id: "6", hash: sha256Hex(quietJson), callJson: quietJson, status: "revealed", pricesDir: tmp, rh });
  check("Robinhood: no swaps found in the hour -> NOT scored, and says so",
    !row.scored && /no swaps found/.test(row.why));
  const v3Json = JSON.stringify({ ...rhCall, contract_address: coin3, pool_address: V3 });
  row = await scoreCall({ id: "9", hash: sha256Hex(v3Json), callJson: v3Json, status: "revealed", pricesDir: tmp, rh });
  check("Robinhood: a Uniswap v3 pool is read from its Swap events; rugged at minute 10",
    row.scored && row.exit === "rugged" && Math.abs(row.gross - 1 / 2.45 ** 2) < 1e-3 && row.exit_minute === 10 && /Uniswap v3 Swap/.test(row.source));
  const v2Json = JSON.stringify({ ...rhCall, contract_address: coin2, pool_address: V2 });
  row = await scoreCall({ id: "10", hash: sha256Hex(v2Json), callJson: v2Json, status: "revealed", pricesDir: tmp, rh });
  const want2 = (1.15 / 950) / (1 / 1000);
  check("Robinhood: a Uniswap v2 pool is read from its Sync events (coin as token0); sold at the price when the call's 1h time limit ends",
    row.scored && row.exit === "1h" && Math.abs(row.gross - want2) < 1e-4 && /Uniswap v2 Sync/.test(row.source));

  const scoreOn = async (id, extra) => {
    const j = JSON.stringify({ ...rhCall, ...extra });
    return scoreCall({ id, hash: sha256Hex(j), callJson: j, status: "revealed", pricesDir: tmp, rh });
  };
  row = await scoreOn("2", { pool_address: rugP });
  check("liquidity pulled 13 s BEFORE the call: rugged, 0.00x, and says when",
    row.scored && row.exit === "rugged" && row.net === 0 && /pulled from the pool about 14 s before the call/.test(row.note));
  row = await scoreOn("21", { pool_address: midP });
  check("liquidity pulled at minute 8, before the target: rugged at minute 8, 0.00x",
    row.scored && row.exit === "rugged" && row.gross === 0 && row.exit_minute === 8 && /liquidity pulled at block/.test(row.note));
  row = await scoreOn("22", { pool_address: refP });
  check("emptied then refilled before the call = alive at the call: scored normally (its target at minute 5)",
    row.scored && row.exit === "1.9x" && row.exit_minute === 5);
  row = await scoreOn("23", { contract_address: coin2b, pool_address: V2b });
  check("Uniswap v2: the ETH side drained to 0.5% of its peak = pulled: rugged at minute 15, 0.00x",
    row.scored && row.exit === "rugged" && row.gross === 0 && row.exit_minute === 15);

  // the RPC client: patient with rate limits, never takes an empty answer as "no data", moves on when refused
  const script = (steps) => async () => {
    const s = steps.shift();
    if (s === "throw") throw new Error("connect failed https://secret-key/abc");
    return { json: async () => (s === "429" ? { error: { code: 429, message: "Too Many Requests" } } : s === "null" ? { result: null }
      : s === "refuse" ? { error: { code: -32601, message: "method not found" } } : { result: s }) };
  };
  const slept = [];
  const rpcA = makeRpc(["https://a/key", "https://b"], script(["429", "null", "ok"]), { gapMs: 0, sleep: async (ms) => slept.push(ms) });
  check("RPC: after a 429 or an empty answer it waits (1 s, then 2 s) and asks again",
    (await rpcA("eth_getLogs", [])) === "ok" && rpcA.stats.retries === 2 && slept.join() === "1000,2000" && rpcA.stats.fellOver === 0);
  const rpcB = makeRpc(["https://a/key", "https://b"], script(["refuse", "ok2"]), { gapMs: 0, sleep: async () => {} });
  check("RPC: a real refusal moves straight to the next URL", (await rpcB("eth_call", [])) === "ok2" && rpcB.stats.fellOver === 1);
  const rpcC = makeRpc(["https://secret-key/abc"], script(["429", "throw", "429", "429"]), { gapMs: 0, sleep: async () => {} });
  let errC = ""; try { await rpcC("eth_getLogs", []); } catch (e) { errC = e.message; }
  check("RPC: gives up after 4 tries with a clear error, and never prints the URL (it may hold an API key)",
    /429/.test(errC) && !errC.includes("secret") && rpcC.stats.requests === 4);
  let clock = 0; const hits = { a: 0, b: 0 };
  const byUrl = async (url) => { const k = url.includes("//a") ? "a" : "b"; hits[k]++;
    return k === "a" ? { status: 429, json: async () => { throw new Error("not json"); } } : { status: 200, json: async () => ({ result: "ok" }) }; };
  const rpcD = makeRpc(["https://a/key", "https://b"], byUrl, { gapMs: 0, sleep: async () => {}, now: () => clock });
  const d1 = await rpcD("eth_getLogs", []), d2 = await rpcD("eth_getLogs", []), d3 = await rpcD("eth_getLogs", []);
  const before = hits.a; clock += 600_001; await rpcD("eth_getLogs", []);
  check("RPC: a URL still rate-limited (HTTP 429) after its tries is set aside for 10 min; the next RPC answers straight away",
    d1 === "ok" && d2 === "ok" && d3 === "ok" && before === 4 && hits.b === 4 && rpcD.stats.setAside === 2 && hits.a === 8);
  const rpcE = makeRpc(["https://a/key"], byUrl, { gapMs: 0, sleep: async () => {}, now: () => clock });
  let e1 = "", e2 = ""; try { await rpcE("eth_call", []); } catch (e) { e1 = e.message; } try { await rpcE("eth_call", []); } catch (e) { e2 = e.message; }
  check("RPC: with only one URL it's never set aside: each request still tries it, and fails clearly",
    /429/.test(e1) && /429/.test(e2) && rpcE.stats.setAside === 0 && rpcE.stats.requests === 8);

  // NEAR views through the same patient RPC client
  const fakeNear = async (url, opt) => { const q = JSON.parse(opt.body).params;
    return { status: 200, json: async () => ({ result: { result: [...Buffer.from(JSON.stringify({ method: q.method_name, args: JSON.parse(Buffer.from(q.args_base64, "base64").toString()) }))] } }) }; };
  const v = await nearView(makeRpc(["https://near.example"], fakeNear, { gapMs: 0 }), "receipts.example.near", "get_calls", { from_index: "0", limit: 50 });
  check("NEAR views: asks the contract, decodes its JSON answer", v.method === "get_calls" && v.args.limit === 50);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log("--- witty scorer selftest ---");
  for (const [name, ok] of results) console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  const fails = results.filter(([, ok]) => !ok).length;
  console.log(fails ? `${fails} FAILED` : `all ${results.length} passed`);
  process.exit(fails ? 1 : 0);
}

// ---------------- main ----------------

/** A view call on a NEAR contract, through the patient RPC client. */
export async function nearView(rpc, contract, method, args = {}) {
  const r = await rpc("query", { request_type: "call_function", finality: "final", account_id: contract, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") });
  return JSON.parse(Buffer.from(r.result).toString());
}

async function main() {
  if (process.argv.includes("--selftest")) return selftest();
  const dataDir = process.env.WITTY_DATA || path.join(process.cwd(), "data");
  const contract = process.env.WITTY_CONTRACT || "receipts.eurekascout.near";
  const network = process.env.WITTY_NETWORK || "mainnet";
  const nearRpc = makeRpc([process.env.NEAR_RPC, ...(NEAR_PUBLIC_RPCS[network] || [])], fetch, { gapMs: 50 });
  const onChain = [];
  for (let from = 0; ; from += 50) {
    const page = await nearView(nearRpc, contract, "get_calls", { from_index: String(from), limit: 50 });
    onChain.push(...page);
    if (page.length < 50) break;
  }
  const rpc = makeRpc([process.env.RH_RPC, process.env.RH_RPC2, RH_PUBLIC_RPC]);
  const rh = new Robinhood(rpc);
  const ci = process.argv.indexOf("--call");
  const only = ci > -1 ? String(process.argv[ci + 1]) : null;
  const rows = [];
  const pct = (x) => `${x >= 1 ? "+" : ""}${Math.round((x - 1) * 100)}%`;
  const line = (r) => {
    const name = `#${r.id} ${(r.token || "?").slice(0, 12).padEnd(12)} ${(r.chain || "").padEnd(9)}`;
    return r.scored
      ? `  ${name} ${String(r.exit).padEnd(7)} ${r.net.toFixed(2)}x after fees (${pct(r.net)})${r.exit_minute != null ? ` · exit min ${r.exit_minute}` : ""}${r.peak_x ? ` · peak ${r.peak_x}x` : ""}${r.warm_up ? " · warm-up" : ""}${/pulled/.test(r.note || "") ? ` · ${r.note}` : ""}`
      : `  ${name} not scored: ${r.why}`;
  };
  // Each call prints as soon as it is scored, so a long run is never silent.
  console.log(`Witty scores (${VERSION}) · ${contract} · ${onChain.length} calls on chain`);
  if (!only) console.log("Solana calls are scored from the downloaded price files. A Robinhood call is rebuilt from the chain: seconds to minutes each on the public RPC.");
  console.log("");
  const live = process.stderr.isTTY;   // on a terminal, say which Robinhood call is being read once it has taken 2 s (on stderr, wiped when its result prints)
  for (const v of only ? onChain.filter((c) => String(c.id) === only) : onChain) {
    const wait = live && /"chain"\s*:\s*"robinhood"/.test(v.call_json || "") ? `  #${v.id} reading Robinhood Chain...` : "";
    let shown = false;
    const timer = wait ? setTimeout(() => { shown = true; process.stderr.write(wait); }, 2000) : null;
    let r;
    try {
      r = await scoreCall({ id: v.id, hash: v.hash, callJson: v.call_json || null, warmUp: v.warm_up, status: v.status, pricesDir: path.join(dataDir, "prices"), rh });
    } catch (e) { r = { id: v.id, hash: v.hash, scored: false, why: `error: ${e.message}` }; }
    rows.push(r);
    clearTimeout(timer);
    if (shown) process.stderr.write(`\r${" ".repeat(wait.length)}\r`);
    console.log(line(r));
  }
  const s = rpc.stats;
  console.log(`\nRobinhood RPC: ${s.requests} requests · ${s.retries} waited and retried (rate limits) · ${s.fellOver} moved to the next RPC · ${s.setAside} set aside for 10 min (still rate-limited)`);
  if (only) {
    console.log(JSON.stringify(rows[0] || { why: `no call #${only} on chain` }, null, 1));
    return;
  }
  const official = rows.filter((r) => !r.warm_up), warm = rows.filter((r) => r.warm_up);
  const out = { version: VERSION, contract, made_at: new Date().toISOString(), measured_with: MEASURE,
    official: summarize(official), warm_up: summarize(warm),
    by_chain: Object.fromEntries(["solana", "robinhood"].map((c) => [c, summarize(official.filter((r) => r.chain === c))])),
    by_category: Object.fromEntries(["gamble", "scalping", "conviction", "smart"].map((c) => [c, summarize(official.filter((r) => r.category === c))])), calls: rows };
  const total = (label, s) => s.calls
    ? `${label}: $1 per call -> $${s.per_dollar} after fees · median ${s.median}x · ${s.win_pct}% wins · ${s.rugged_pct}% rugged${s.stopped_pct ? ` · ${s.stopped_pct}% stopped` : ""} · ${s.calls} calls`
    : `${label}: no scored calls yet`;
  console.log("\n" + total("Official record", out.official));
  console.log(total("Warm-up        ", out.warm_up));
  const file = path.join(dataDir, "scores.json");
  fs.mkdirSync(dataDir, { recursive: true });           // a fresh clone has no data/ yet
  fs.writeFileSync(file, JSON.stringify(out, null, 1));
  console.log(`\nSaved ${file}`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) main().catch((e) => { console.error(e?.message || e); process.exit(1); });
