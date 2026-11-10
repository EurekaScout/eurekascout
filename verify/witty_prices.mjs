#!/usr/bin/env node
// witty_prices.mjs: records every Solana call's price straight from the chain. MIT.
//
// Witty's Solana calls are scored on prices read from the chain. For each Solana call, this reads the coin's PumpSwap
// pool (its SOL vault and its coin vault) every 10 s through the first hour, then every 30 s until 24 h, or until the
// call's own time limit when its plan runs longer. Readings land on the clock's 10 s (30 s) marks, so every call that's
// due is read together: ONE RPC call for all the pools' vaults (and one for all the bonding curves), however many
// calls are running. Every line keeps the Solana slot it was read at. Price in SOL = SOL in the pool / coins in the pool.
//
// A coin still on its pump.fun bonding curve has no pool yet: the recorder reads the curve itself (its virtual SOL and
// coin reserves, which set the curve's price) at the same pace. When the curve completes, the coin moves to its
// PumpSwap pool: the recorder works out that pool's address on the chain (pump.fun's canonical pool for the coin, a
// program-derived address) and carries on in the same file. The first line read from the pool says so.
//
// Robinhood calls need no recorder: every swap is an event on Robinhood Chain with its price and block, so the scorer
// rebuilds any window from the chain afterwards.
//
//   node witty_prices.mjs --selftest              offline checks, touches nothing
//   node witty_prices.mjs --check MINT POOL       reads one real PumpSwap pool twice, live; writes nothing
//   node witty_prices.mjs                         runs forever (the price recorder service)
//
// Reads data/calls.json (written when a call is made). Writes data/prices/<call hash>.jsonl (first line = what was
// read and how) and data/prices_state.json. A price file shows which coin a call is about, so it stays private
// (mode 600) until that call is revealed.
// Settings from the environment: SOL_RPC, SOL_RPC2 (the public Solana RPC is always last), WITTY_DATA.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const VERSION = "witty-prices 1.2";
export const PUMPSWAP = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
export const PUMP = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";   // pump.fun: the bonding curves
export const WSOL = "So11111111111111111111111111111111111111112";
export const TOKEN_PROGRAMS = ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"];
export const SCHEDULE = {
  fastEveryS: 10, fastForS: 3660,      // first hour (plus a minute, so the 1h price is always inside)
  slowEveryS: 30, slowForS: 86400,     // then every 30 s until 24 h (or the call's time limit, if longer)
  findPoolEveryS: 15, findPoolForS: 300,
  afterGradS: 900,                     // once a curve completes, how long to look for its PumpSwap pool
  extraS: 600,                         // recording runs this much past the plan's time limit
};
const SOL_PUBLIC_RPC = "https://api.mainnet-beta.solana.com";

/** How long to record a call: 24 h, or its own time limit plus 10 min when that is longer. */
export function recordForS(call) {
  const m = String(call?.plan?.time_limit ?? call?.time_limit ?? "").match(/^\s*(\d+)\s*(d|h|m)\s*$/i);
  const w = m ? parseInt(m[1]) * { d: 86400, h: 3600, m: 60 }[m[2].toLowerCase()] : 0;
  return Math.max(SCHEDULE.slowForS, w ? w + SCHEDULE.extraS : 0);
}

// ---- pump.fun bonding curves: the curve's address is derived from the coin (a program-derived address) ----

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function b58decode(s) {
  let n = 0n;
  for (const ch of String(s)) { const i = B58.indexOf(ch); if (i < 0) throw new Error("not base58"); n = n * 58n + BigInt(i); }
  const out = [];
  while (n > 0n) { out.unshift(Number(n & 255n)); n >>= 8n; }
  for (const ch of String(s)) { if (ch !== "1") break; out.unshift(0); }
  if (out.length !== 32) throw new Error("not a 32-byte address");
  return Buffer.from(out);
}
export function b58encode(buf) {
  let n = 0n;
  for (const b of buf) n = (n << 8n) | BigInt(b);
  let s = "";
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of buf) { if (b !== 0) break; s = "1" + s; }
  return s;
}
const FP = 2n ** 255n - 19n;
const md = (a) => ((a % FP) + FP) % FP;
const pw = (b, e) => { let r = 1n; b = md(b); while (e > 0n) { if (e & 1n) r = (r * b) % FP; b = (b * b) % FP; e >>= 1n; } return r; };
const ED_D = md(-121665n * pw(121666n, FP - 2n));
/** True if 32 bytes are an ed25519 point (a program-derived address must not be one). */
export function isOnCurve(bytes) {
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(bytes[i]);
  y &= (1n << 255n) - 1n;
  if (y >= FP) return false;
  const y2 = md(y * y), u = md(y2 - 1n), v = md(ED_D * y2 + 1n);
  const w = md(u * pw(v, FP - 2n));
  return w === 0n || pw(w, (FP - 1n) / 2n) === 1n;
}
export function findPda(seeds, programId) {
  const prog = b58decode(programId);
  for (let bump = 255; bump >= 0; bump--) {
    const h = crypto.createHash("sha256").update(Buffer.concat([...seeds, Buffer.from([bump]), prog, Buffer.from("ProgramDerivedAddress")])).digest();
    if (!isOnCurve(h)) return b58encode(h);
  }
  throw new Error("no program address");
}
export const curveAddress = (mint) => findPda([Buffer.from("bonding-curve"), b58decode(mint)], PUMP);
const CURVE_TAG = crypto.createHash("sha256").update("account:BondingCurve").digest().subarray(0, 8);
/** A bonding curve account: its virtual reserves (they set the price) and whether it has completed. */
export function parseCurve(buf) {
  if (!buf || buf.length < 49 || !buf.subarray(0, 8).equals(CURVE_TAG)) return null;
  return { vtok: buf.readBigUInt64LE(8), vsol: buf.readBigUInt64LE(16), complete: buf[48] === 1 };
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
function writeJson(file, obj) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 1), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** JSON-RPC over several URLs: on an error it moves to the next one. Never prints a URL (they hold API keys). */
export function makeRpc(urls, fetchFn = fetch) {
  const list = urls.filter(Boolean);
  return async (method, params) => {
    let last;
    for (const u of list) {
      try {
        const r = await fetchFn(u, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(15_000),
        });
        const j = await r.json();
        if (j.error) { last = new Error(`${method}: ${JSON.stringify(j.error).slice(0, 160)}`); continue; }
        return j.result;
      } catch (e) { last = new Error(`${method}: ${e?.name || "error"}`); }
    }
    throw last || new Error("no Solana RPC set");
  };
}

/** pump.fun's canonical PumpSwap pool for a coin (the pool its bonding curve moves to): a program-derived address of
 *  the PumpSwap program, from seeds "pool", index 0, the coin's pool authority (itself derived from the coin), the coin
 *  and wrapped SOL. Nothing is looked up: the address follows from the coin. */
export function canonicalPool(mint) {
  const authority = findPda([Buffer.from("pool-authority"), b58decode(mint)], PUMP);
  return findPda([Buffer.from("pool"), Buffer.alloc(2), b58decode(authority), b58decode(mint), b58decode(WSOL)], PUMPSWAP);
}

export class Recorder {
  constructor({ dataDir, rpc, clock = () => Date.now(), log = console.log }) {
    Object.assign(this, { rpc, clock, log });
    this.callsFile = path.join(dataDir, "calls.json");
    this.stateFile = path.join(dataDir, "prices_state.json");
    this.pricesDir = path.join(dataDir, "prices");
    fs.mkdirSync(this.pricesDir, { recursive: true, mode: 0o700 });
    this.state = readJson(this.stateFile, { calls: {} });
    this.lastErrorLog = 0;
  }

  save() { writeJson(this.stateFile, this.state); }
  file(hash) { return path.join(this.pricesDir, `${hash}.jsonl`); }

  /** New Solana calls from calls.json; stop calls whose seal failed. */
  scanCalls() {
    const calls = readJson(this.callsFile, {});
    const now = this.clock();
    let changed = 0;
    for (const rec of Object.values(calls)) {
      if (!rec?.hash || rec.chain !== "solana") continue;
      const c = this.state.calls[rec.hash];
      if (c) {
        if (!c.done && ["not_sealed_backup_failed", "seal_failed"].includes(rec.status)) {
          Object.assign(c, { done: true, note: `not sealed (${rec.status}), recording stopped` });
          changed++;
        }
        continue;
      }
      const t0 = Number(rec.created_ms);
      if (!t0 || !["backing_up", "sealed"].includes(rec.status) || now - t0 > SCHEDULE.fastForS * 1000) {
        this.state.calls[rec.hash] = { coin: rec.coin, t0: t0 || null, done: true, skipped: true,
          note: "no price file: the call's first hour had passed (or it wasn't sealed) when the recorder first saw it" };
        changed++;
        continue;
      }
      let call = {};
      try { call = JSON.parse(rec.call_json); } catch { /* keep going without the hint */ }
      this.state.calls[rec.hash] = { coin: rec.coin, mint: call.contract_address, hint: call.pool_address || null,
        t0, next: now, findUntil: t0 + SCHEDULE.findPoolForS * 1000, until: t0 + recordForS(call) * 1000, n: 0 };
      this.log(`new call: ${rec.coin} (${rec.hash.slice(0, 8)}...)`);
      changed++;
    }
    if (changed) this.save();
    return changed;
  }

  /** Where to read this coin: its PumpSwap pool, else (not graduated yet) its pump.fun bonding curve, else null. */
  async findPool(c) {
    const swap = await this.findPumpSwap(c);
    if (swap) return { venue: "pumpswap", ...swap };
    if (c.graduated) return null;   // its curve has completed: only the PumpSwap pool will do
    return this.findCurve(c);
  }

  /** The coin's pump.fun bonding curve, if it exists and is still trading. */
  async findCurve(c) {
    let curve;
    try { curve = curveAddress(c.mint); } catch { return null; }
    const r = await this.rpc("getMultipleAccounts", [[curve], { encoding: "base64", commitment: "confirmed" }]);
    const a = r?.value?.[0];
    if (!a || a.owner !== PUMP) return null;
    const cv = parseCurve(Buffer.from(a.data?.[0] || "", "base64"));
    if (!cv || cv.complete) return null;
    return { venue: "curve", pool: curve, curve, tokDecimals: 6 };   // pump.fun coins always have 6 decimals
  }

  /** The PumpSwap pool for this coin: the one the call recorded if it is a PumpSwap pool, else the coin's canonical pool. */
  async findPumpSwap(c) {
    let canonical = null;
    try { canonical = canonicalPool(c.mint); } catch { /* not a Solana address */ }
    let candidates = [...new Set([c.hint, canonical].filter(Boolean))];
    if (!candidates.length) return null;
    const r = await this.rpc("getMultipleAccounts", [candidates, { encoding: "base64", dataSlice: { offset: 0, length: 0 } }]);
    const own = (r?.value || []).map((a) => a?.owner || null);
    candidates = candidates.filter((_, i) => own[i] === PUMPSWAP);
    if (!candidates.length) return null;
    for (const pool of candidates) {
      let sol = null, tok = null;
      for (const prog of TOKEN_PROGRAMS) {
        const r = await this.rpc("getTokenAccountsByOwner", [pool, { programId: prog }, { encoding: "jsonParsed" }]);
        for (const a of r?.value || []) {
          const info = a.account?.data?.parsed?.info || {};
          if (info.mint === WSOL) sol = a.pubkey;
          else if (info.mint === c.mint) tok = { vault: a.pubkey, decimals: Number(info.tokenAmount?.decimals) };
        }
      }
      if (sol && tok && Number.isInteger(tok.decimals)) return { pool, solVault: sol, tokVault: tok.vault, tokDecimals: tok.decimals };
    }
    return null;
  }

  /** One reading of both vaults (or of the bonding curve), in one RPC call, with the slot it was read at.
   *  Returns null, writing nothing, when the curve has just completed (the coin is moving to its PumpSwap pool). */
  async snapshot(hash, c) {
    if (c.venue === "curve") {
      const r = await this.rpc("getMultipleAccounts", [[c.curve], { encoding: "base64", commitment: "confirmed" }]);
      return this.fromCurve(hash, c, r?.value?.[0], r?.context?.slot ?? null);
    }
    const r = await this.rpc("getMultipleAccounts", [[c.solVault, c.tokVault], { encoding: "jsonParsed", commitment: "confirmed" }]);
    const [s, k] = r?.value || [];
    return this.fromVaults(hash, c, s, k, r?.context?.slot ?? null);
  }
  /** A reading from the bonding curve's account; null (nothing written) when the curve has just completed. */
  fromCurve(hash, c, a, slot) {
    const cv = a && a.owner === PUMP ? parseCurve(Buffer.from(a.data?.[0] || "", "base64")) : null;
    if (!cv) throw new Error("bonding curve unreadable");
    if (cv.complete) {
      Object.assign(c, { graduated: true, venue: null, pool: null, curve: null, findUntil: this.clock() + SCHEDULE.afterGradS * 1000 });
      this.log(`${c.coin}: its bonding curve completed, looking for its PumpSwap pool`);
      return null;
    }
    return this.write(hash, c, { t: this.clock(), slot, sol: String(cv.vsol), tok: String(cv.vtok) });
  }
  /** A reading from the pool's two vault accounts. */
  fromVaults(hash, c, s, k, slot) {
    return this.write(hash, c, {
      t: this.clock(), slot,
      sol: s?.data?.parsed?.info?.tokenAmount?.amount ?? null,     // lamports of SOL in the pool (null = vault gone)
      tok: k?.data?.parsed?.info?.tokenAmount?.amount ?? null,     // raw coin units in the pool
    });
  }
  /** Every due call read together: one getMultipleAccounts for all the bonding curves, one for all the pools' vaults
   *  (at most 100 accounts a call). A failed RPC call puts each of its calls on the usual retry. */
  async readMany(due, now) {
    const parts = (list, per) => { const out = []; for (let i = 0; i < list.length; i += per) out.push(list.slice(i, i + per)); return out; };
    const curves = due.filter(([, c]) => c.venue === "curve"), pools = due.filter(([, c]) => c.venue !== "curve");
    for (const part of parts(curves, 100)) {
      let r;
      try { r = await this.rpc("getMultipleAccounts", [part.map(([, c]) => c.curve), { encoding: "base64", commitment: "confirmed" }]); }
      catch (e) { for (const [, c] of part) this.failed(c, now, e); continue; }
      part.forEach(([hash, c], i) => {
        try { const line = this.fromCurve(hash, c, r?.value?.[i], r?.context?.slot ?? null); line ? this.after(c, now) : (c.next = now + 1000); }
        catch (e) { this.failed(c, now, e); }
      });
    }
    for (const part of parts(pools, 50)) {
      let r;
      try { r = await this.rpc("getMultipleAccounts", [part.flatMap(([, c]) => [c.solVault, c.tokVault]), { encoding: "jsonParsed", commitment: "confirmed" }]); }
      catch (e) { for (const [, c] of part) this.failed(c, now, e); continue; }
      part.forEach(([hash, c], i) => {
        try { this.fromVaults(hash, c, r?.value?.[2 * i], r?.value?.[2 * i + 1], r?.context?.slot ?? null); this.after(c, now); }
        catch (e) { this.failed(c, now, e); }
      });
    }
  }
  /** After a reading: done at the end, else the next 10 s mark (first hour) or 30 s mark. */
  after(c, now) {
    const until = c.until || c.t0 + SCHEDULE.slowForS * 1000;
    if (this.clock() >= until) {
      Object.assign(c, { done: true, note: `recorded to ${Math.round((until - c.t0) / 3_600_000)} h (${c.n} readings)` });
      this.log(`${c.coin}: done, ${c.n} readings`);
      return;
    }
    const ms = ((this.clock() - c.t0) / 1000 < SCHEDULE.fastForS ? SCHEDULE.fastEveryS : SCHEDULE.slowEveryS) * 1000;
    c.next = Math.floor(now / ms) * ms + ms;
  }
  failed(c, now, e) {
    c.errors = (c.errors || 0) + 1;
    c.next = now + 3000;
    if (now >= (c.until || c.t0 + SCHEDULE.slowForS * 1000) + 3_600_000) Object.assign(c, { done: true, note: `stopped: reads kept failing past the end (${e.message})` });
    if (now - this.lastErrorLog > 60_000) { this.lastErrorLog = now; this.log(`${c.coin}: read failed (${e.message}), retrying`); }
  }

  write(hash, c, line) {
    if (c.switched) { Object.assign(line, c.switched); delete c.switched; }   // the first reading from a new pool says which
    fs.appendFileSync(this.file(hash), JSON.stringify(line) + "\n", { mode: 0o600 });
    c.n = (c.n || 0) + 1;
    return line;
  }

  async step() {
    this.scanCalls();
    const now = this.clock();
    let worked = false;
    const due = [];
    for (const [hash, c] of Object.entries(this.state.calls)) {
      if (c.done || now < c.next) continue;
      worked = true;
      try {
        const until = c.until || c.t0 + SCHEDULE.slowForS * 1000;   // calls seen by v1.0 have no `until`: 24 h
        if (!c.pool) {
          const found = await this.findPool(c);
          if (!found) {
            if (now >= c.findUntil || now >= until) {
              Object.assign(c, { done: true, note: c.graduated
                ? `its bonding curve completed, but no PumpSwap pool was found within ${SCHEDULE.afterGradS / 60} min`
                : `no PumpSwap pool or pump.fun bonding curve found within ${SCHEDULE.findPoolForS / 60} min` });
              this.log(`${c.coin}: ${c.note}`);
            } else c.next = now + SCHEDULE.findPoolEveryS * 1000;
            continue;
          }
          Object.assign(c, found);
          if (c.graduated) {   // the file already has its header (the curve): the next line says where readings now come from
            c.switched = { venue: "pumpswap", pool: c.pool, program: PUMPSWAP, sol_vault: c.solVault, coin_vault: c.tokVault, coin_decimals: c.tokDecimals };
            this.log(`${c.coin}: graduated, now recording PumpSwap pool ${c.pool.slice(0, 6)}...`);
          } else {
            const curve = c.venue === "curve";
            fs.writeFileSync(this.file(hash), JSON.stringify({
              header: VERSION, hash, chain: "solana", mint: c.mint, pool: c.pool, program: curve ? PUMP : PUMPSWAP, venue: c.venue,
              sol_vault: curve ? null : c.solVault, coin_vault: curve ? null : c.tokVault, sol_decimals: 9, coin_decimals: c.tokDecimals,
              called_ms: c.t0, record_to_ms: until,
              how: curve
                ? "getMultipleAccounts on the pump.fun bonding curve (commitment confirmed); sol / tok are its virtual SOL and coin reserves; " +
                  "price in SOL = (sol / 1e9) / (tok / 10^coin_decimals). When the curve completes, readings continue from its PumpSwap " +
                  "pool's two vaults: the first such line carries venue 'pumpswap' and the pool"
                : "getMultipleAccounts on both vaults (commitment confirmed); price in SOL = (sol / 1e9) / (tok / 10^coin_decimals)",
              schedule: SCHEDULE,
            }) + "\n", { mode: 0o600 });
            this.log(`${c.coin}: recording ${curve ? "bonding curve" : "pool"} ${c.pool.slice(0, 6)}... (coin decimals ${c.tokDecimals}, to ${Math.round((until - c.t0) / 3_600_000)} h)`);
          }
        }
        due.push([hash, c]);
      } catch (e) { this.failed(c, now, e); }
    }
    if (due.length) await this.readMany(due, now);
    if (worked) this.save();
  }
}

/** Price in SOL per coin from one reading: (SOL in the pool) / (coins in the pool). */
export function priceSol(line, coinDecimals) {
  if (line?.sol == null || line?.tok == null || BigInt(line.tok) === 0n) return null;
  return (Number(BigInt(line.sol)) / 1e9) / (Number(BigInt(line.tok)) / 10 ** coinDecimals);
}

/** --check MINT POOL: read one real pool twice, live, and print what the recorder would store. Writes nothing. */
async function liveCheck(rpc, mint, pool) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "witty-prices-check-"));
  const rec = new Recorder({ dataDir: tmp, rpc, log: () => {} });
  const c = { coin: "check", mint, hint: pool, t0: Date.now() };
  const found = await rec.findPool(c);
  if (!found) { console.log(`STOP: no PumpSwap pool and no live pump.fun bonding curve found for ${mint.slice(0, 8)}...`); fs.rmSync(tmp, { recursive: true }); return 1; }
  Object.assign(c, found);
  console.log(c.venue === "curve"
    ? `still on its pump.fun bonding curve ${c.curve} (decimals ${c.tokDecimals})`
    : `pool ${c.pool} is PumpSwap · SOL vault ${c.solVault.slice(0, 6)}... · coin vault ${c.tokVault.slice(0, 6)}... (decimals ${c.tokDecimals})`);
  for (let i = 0; i < 2; i++) {
    if (i) await new Promise((r) => setTimeout(r, SCHEDULE.fastEveryS * 1000));
    const l = await rec.snapshot("check", c);
    if (!l) { console.log("  the bonding curve just completed: the coin is moving to PumpSwap, check again in a minute"); break; }
    console.log(`  slot ${l.slot} · SOL in pool ${(Number(l.sol) / 1e9).toFixed(4)} · price ${priceSol(l, c.tokDecimals)?.toExponential(4)} SOL per coin`);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  return 0;
}

// ---------------- selftest ----------------

async function selftest() {
  const results = [];
  const check = (name, ok) => results.push([name, !!ok]);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "witty-prices-test-"));
  const H = 3_600_000;
  let now = Date.parse("2026-11-01T00:12:00Z");
  const POOL = "HLo4v1a1D7ev5ZmfH5Y23unLasrNdqWmpGVZwonQ6hUY", CURVE = "CurvePool111";
  const MINT = "6BTFvjVxwjbWiHQXfZYEMEpD1ShUGGQCAYw2WEpGpump", MINT2 = "AE8JPrsodGgTZQ9R5Mk243NsPaAxZBnAkLk3MtwCpump";
  const POOL2 = canonicalPool(MINT2);
  const owner = { [POOL]: PUMPSWAP, [POOL2]: PUMPSWAP, [CURVE]: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P" };
  const vaults = {
    [POOL]: { TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: [["SolVault1", WSOL, 9]], TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb: [["CoinVault1", MINT, 6]] },
    [POOL2]: { TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: [["SolVault2", WSOL, 9]], TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb: [["CoinVault2", MINT2, 6]] },
  };
  let slot = 463_000_000, failNext = 0, rpcCalls = 0;
  const rpc = async (method, params) => {
    rpcCalls++;
    if (failNext > 0) { failNext--; throw new Error(`${method}: fake outage`); }
    if (method === "getMultipleAccounts" && params[1].dataSlice) return { value: params[0].map((a) => (owner[a] ? { owner: owner[a] } : null)) };
    if (method === "getTokenAccountsByOwner") {
      return { value: (vaults[params[0]]?.[params[1].programId] || []).map(([pk, mint, d]) => ({ pubkey: pk, account: { data: { parsed: { info: { mint, tokenAmount: { decimals: d } } } } } })) };
    }
    if (method === "getMultipleAccounts") {
      slot += 25;
      const bal = (a) => ({ data: { parsed: { info: { tokenAmount: { amount: a } } } } });
      return { context: { slot }, value: params[0].map((a) => bal(/^SolVault/.test(a) ? "85000000000" : "206900000000000")) };
    }
    throw new Error("unexpected " + method);
  };
  const dataDir = path.join(tmp, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const callJson = (mint, pool) => JSON.stringify({ contract_address: mint, pool_address: pool, chain: "solana" });
  const calls = {
    old: { hash: "old", chain: "solana", coin: "OLD", status: "sealed", created_ms: now - 2 * H, call_json: callJson(MINT, POOL) },
    rh: { hash: "rh", chain: "robinhood", coin: "NET", status: "sealed", created_ms: now, call_json: "{}" },
    blorbo: { hash: "blorbo", chain: "solana", coin: "BLORBO", status: "sealed", created_ms: now - 5000, call_json: callJson(MINT, POOL) },
  };
  fs.writeFileSync(path.join(dataDir, "calls.json"), JSON.stringify(calls));
  const logs = [];
  const mk = () => new Recorder({ dataDir, rpc, clock: () => now, log: (m) => logs.push(m) });
  let rec = mk();
  await rec.step();
  const st = rec.state.calls;
  check("a Solana call older than its first hour is skipped, with the reason written down", st.old?.skipped && /first hour had passed/.test(st.old.note));
  check("Robinhood calls are left to the scorer (no price file)", !st.rh && !fs.existsSync(rec.file("rh")));
  const lines = () => fs.readFileSync(rec.file("blorbo"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  let L = lines();
  check("the pool the call recorded is used when it is a PumpSwap pool",
    st.blorbo.pool === POOL && L[0].pool === POOL && L[0].coin_decimals === 6);
  check("a coin's canonical PumpSwap pool is worked out from the coin alone (matches a real pool on the chain)",
    canonicalPool(MINT) === POOL && canonicalPool(MINT2) === "YeDtjjB8USr15RCYmHtAzumK7zZFbrLqNxxUuLcVvEj");
  check("first line says exactly what is read and how (vaults, decimals, program)",
    L[0].header === VERSION && L[0].sol_vault === "SolVault1" && L[0].coin_vault === "CoinVault1" && L[0].program === PUMPSWAP && /price in SOL/.test(L[0].how));
  check("the first reading lands right away, with its slot and both vault amounts",
    L.length === 2 && L[1].slot > 463_000_000 && L[1].sol === "85000000000" && L[1].tok === "206900000000000");

  for (let s = 0; s < 3600; s++) { now += 1000; await rec.step(); }
  L = lines();
  const fast = L.slice(1).filter((l) => l.t <= calls.blorbo.created_ms + 3600_000);
  check("first hour: a reading every 10 s (about 360)", fast.length >= 355 && fast.length <= 362);
  check("readings are 10 s apart", fast.slice(1).every((l, i) => l.t - fast[i].t === 10_000));

  failNext = 2;
  for (let s = 0; s < 30; s++) { now += 1000; await rec.step(); }
  check("an RPC outage doesn't crash it: it retries and keeps recording",
    st.blorbo.errors === 2 && failNext === 0 && lines().length > L.length && logs.some((m) => /read failed/.test(m)));

  rec = mk();
  const before = lines().length;
  for (let s = 0; s < 1200; s++) { now += 1000; await rec.step(); }
  L = lines();
  check("a restart picks up where it left off (same file, header written once)", L.filter((l) => l.header).length === 1 && L.length > before);
  const slow = L.slice(1).filter((l) => l.t > calls.blorbo.created_ms + SCHEDULE.fastForS * 1000);
  check("after the first hour: a reading every 30 s", slow.length >= 30 && slow.slice(1).every((l, i) => l.t - slow[i].t === 30_000));

  calls.abby = { hash: "abby", chain: "solana", coin: "ABBY", status: "backing_up", created_ms: now, call_json: callJson(MINT2, CURVE) };
  calls.nopool = { hash: "nopool", chain: "solana", coin: "NOPOOL", status: "sealed", created_ms: now, call_json: callJson("NoPoolMint", null) };
  fs.writeFileSync(path.join(dataDir, "calls.json"), JSON.stringify(calls));
  now += 1000; await rec.step();
  check("the call recorded a curve that has completed: the coin's PumpSwap pool is found on the chain and checked",
    rec.state.calls.abby.pool === POOL2 && fs.existsSync(rec.file("abby")));
  check("recording starts as soon as the call is written, before its seal lands",
    calls.abby.status === "backing_up" && rec.state.calls.abby.n === 1);
  for (let s = 0; s < 400; s++) { now += 1000; await rec.step(); }
  check("no PumpSwap pool within 5 min: it stops looking and says why", rec.state.calls.nopool.done && /no PumpSwap pool/.test(rec.state.calls.nopool.note));

  calls.abby.status = "not_sealed_backup_failed";
  fs.writeFileSync(path.join(dataDir, "calls.json"), JSON.stringify(calls));
  now += 1000; await rec.step();
  const nAbby = rec.state.calls.abby.n;
  now += 60_000; await rec.step();
  check("a call whose backup failed (so it was never sealed) stops being recorded",
    rec.state.calls.abby.done && rec.state.calls.abby.n === nAbby && /not sealed/.test(rec.state.calls.abby.note));

  for (let s = 0; s < 300; s++) { now += 300_000; await rec.step(); }
  check("24 h after the call: recording ends, with the number of readings", rec.state.calls.blorbo.done && /recorded to 24 h/.test(rec.state.calls.blorbo.note));
  const n24 = lines().length;
  now += 3_600_000; await rec.step();
  check("nothing more is read after 24 h", lines().length === n24);
  const mode = (f) => (fs.statSync(f).mode & 0o777).toString(8);
  check("price files and state are private (600) until the call is revealed", mode(rec.file("blorbo")) === "600" && mode(rec.stateFile) === "600");

  const urlsSeen = [];
  const r2 = makeRpc(["https://secret-key-1.example/abc", "https://second.example"], async (u) => {
    urlsSeen.push(u); if (u.includes("secret")) throw new Error("connect ECONNREFUSED https://secret-key-1.example/abc");
    return { json: async () => ({ result: 42 }) };
  });
  check("RPC falls over to the next URL", (await r2("getSlot", [])) === 42 && urlsSeen.length === 2);
  const r3 = makeRpc(["https://secret-key-1.example/abc"], async () => { throw new Error("fetch https://secret-key-1.example/abc failed"); });
  let msg = ""; try { await r3("getSlot", []); } catch (e) { msg = e.message; }
  check("an RPC error never prints the URL (it may hold an API key)", msg && !msg.includes("secret"));
  check("price in SOL = SOL in pool / coins in pool (85 SOL, 206.9M coins at 6 decimals = 4.108e-7)",
    Math.abs(priceSol({ sol: "85000000000", tok: "206900000000000" }, 6) - 85 / 206_900_000) < 1e-15 &&
    priceSol({ sol: null, tok: "1" }, 6) === null && priceSol({ sol: "1", tok: "0" }, 6) === null);

  // ---- pump.fun bonding curves, graduation, longer time limits ----
  check("curve address = pump.fun's program-derived address (same as @solana/web3.js, incl. a bump below 255)",
    curveAddress(MINT) === "DFmoEmAnGQoTpSmacoFV8i6BddqXdCrHdNoHZU5bpjSZ" && curveAddress(MINT2) === "4Tis5vBYGmAiJbEDpKhKforp22yFSct41b9UKopJTyaG" &&
    curveAddress(WSOL) === "6PiyjiAPkp2KdZtqkyQYzVsD1Prv7t8v4TaYd8ip4YFd" && b58encode(b58decode(PUMPSWAP)) === PUMPSWAP);
  check("recording length: 24 h by default, the call's time limit + 10 min when longer (3 days -> 72 h 10 min)",
    recordForS({}) === 86400 && recordForS({ plan: { time_limit: "1h" } }) === 86400 && recordForS({ plan: { time_limit: "3d" } }) === 259200 + 600 &&
    recordForS({ time_limit: "24h" }) === 86400 + 600);
  const u64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
  const curveData = (vtok, vsol, done) => Buffer.concat([CURVE_TAG, u64(vtok), u64(vsol), u64(0), u64(0), u64(1e15), Buffer.from([done ? 1 : 0]), Buffer.alloc(32)]).toString("base64");
  check("a curve account is read only with pump.fun's BondingCurve tag", parseCurve(Buffer.from(curveData(5, 7, false), "base64"))?.vsol === 7n &&
    parseCurve(Buffer.alloc(81)) === null && parseCurve(Buffer.from(curveData(5, 7, true), "base64"))?.complete === true);

  const CA = curveAddress(MINT), POOL3 = canonicalPool(MINT), POOL4 = canonicalPool(MINT2);
  const cur = { vtok: 1_000_000_000_000_000n, vsol: 30_000_000_000n, done: false };
  let graduated = false, slot2 = 470_000_000;
  const own2 = { [CA]: PUMP, [POOL4]: PUMPSWAP };   // POOL3 exists once the curve has completed
  const vaults2 = { [POOL3]: [["SolVault3", WSOL, 9], ["CoinVault3", MINT, 6]], [POOL4]: [["SolVault4", WSOL, 9], ["CoinVault4", MINT2, 6]] };
  const rpc2 = async (method, params) => {
    if (method === "getMultipleAccounts" && params[1].dataSlice) return { value: params[0].map((a) => (a === POOL3 ? (graduated ? { owner: PUMPSWAP } : null) : own2[a] ? { owner: own2[a] } : null)) };
    if (method === "getTokenAccountsByOwner") return { value: params[1].programId === TOKEN_PROGRAMS[0] ? (vaults2[params[0]] || []).map(([pk, mint, d]) => ({ pubkey: pk, account: { data: { parsed: { info: { mint, tokenAmount: { decimals: d } } } } } })) : [] };
    slot2 += 25;
    if (method === "getMultipleAccounts" && params[1].encoding === "base64")
      return { context: { slot: slot2 }, value: params[0].map((a) => (a === CA ? { owner: PUMP, data: [curveData(cur.vtok, cur.vsol, cur.done), "base64"] } : null)) };
    if (method === "getMultipleAccounts") {
      const bal = (x) => ({ data: { parsed: { info: { tokenAmount: { amount: x } } } } });
      return { context: { slot: slot2 }, value: params[0].map((a) => bal(/^SolVault/.test(a) ? "80000000000" : "200000000000000")) };
    }
    throw new Error("unexpected " + method);
  };
  const dataDir2 = path.join(tmp, "data2");
  fs.mkdirSync(dataDir2, { recursive: true });
  const t2 = now;
  const calls2 = {
    curvy: { hash: "curvy", chain: "solana", coin: "CURVY", status: "sealed", created_ms: t2, call_json: JSON.stringify({ contract_address: MINT, pool_address: CA, plan: { time_limit: "24h" } }) },
    conv: { hash: "conv", chain: "solana", coin: "CONV", status: "sealed", created_ms: t2, call_json: JSON.stringify({ contract_address: MINT2, plan: { kind: "steps", time_limit: "3d" } }) },
  };
  fs.writeFileSync(path.join(dataDir2, "calls.json"), JSON.stringify(calls2));
  const rec2 = new Recorder({ dataDir: dataDir2, rpc: rpc2, clock: () => now, log: (m) => logs.push(m) });
  const lines2 = (h) => fs.readFileSync(rec2.file(h), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  for (let s = 0; s < 120; s++) { now += 1000; await rec2.step(); }
  let C2 = lines2("curvy");
  check("a coin still on its bonding curve is recorded from the curve (no pool needed), every 10 s",
    C2[0].venue === "curve" && C2[0].program === PUMP && C2[0].pool === CA && C2[0].coin_decimals === 6 && C2.length >= 12 && C2.slice(2).every((l) => l.t % 10_000 === 0) && C2.slice(3).every((l, i) => l.t - C2[i + 2].t === 10_000));
  check("curve price = its virtual SOL / virtual coins (30 SOL / 1e9 coins = 3e-8 SOL)", Math.abs(priceSol(C2[1], C2[0].coin_decimals) - 3e-8) < 1e-20);
  cur.vsol = 60_000_000_000n; cur.vtok = 500_000_000_000_000n;
  now += 10_000; await rec2.step();
  check("the curve's price moves with its reserves (60 SOL / 5e8 coins = 1.2e-7)", Math.abs(priceSol(lines2("curvy").at(-1), 6) - 1.2e-7) < 1e-20);
  cur.done = true; graduated = true;
  const nBefore = lines2("curvy").length;
  for (let s = 0; s < 40; s++) { now += 1000; await rec2.step(); }
  C2 = lines2("curvy");
  const sw = C2.slice(nBefore);
  check("when the curve completes it finds the PumpSwap pool and carries on in the same file (header once)",
    C2.filter((l) => l.header).length === 1 && sw.length >= 2 && sw[0].venue === "pumpswap" && sw[0].pool === POOL3 && sw[0].sol_vault === "SolVault3" &&
    sw[0].sol === "80000000000" && !sw[1].venue && rec2.state.calls.curvy.venue === "pumpswap" && logs.some((m) => /graduated, now recording PumpSwap/.test(m)));
  check("no reading is written from a completed curve: every line after it comes from the pool", sw.every((l) => l.sol === "80000000000" && l.tok === "200000000000000"));
  for (let s = 0; s < 300; s++) { now += 300_000; await rec2.step(); }
  check("a 24 h plan is recorded to 24 h; a 3-day plan keeps going", rec2.state.calls.curvy.done && /recorded to 24 h/.test(rec2.state.calls.curvy.note) && !rec2.state.calls.conv.done);
  for (let s = 0; s < 600; s++) { now += 300_000; await rec2.step(); }
  const CV = lines2("conv");
  check("a 3-day plan is recorded to 72 h",
    rec2.state.calls.conv.done && /recorded to 72 h/.test(rec2.state.calls.conv.note) && CV.at(-1).t - t2 >= 259_200_000 && CV.at(-1).t - t2 < 260_400_000 && CV[0].record_to_ms === t2 + 259_800_000);

  // ---- every due call read together ----
  {
    const dataDir3 = path.join(tmp, "data3");
    fs.mkdirSync(dataDir3, { recursive: true });
    const K = ["A", "B", "C", "D"], own3 = Object.fromEntries(K.map((k) => [`Pool${k}`, PUMPSWAP]));
    const amt = { SolA: "1000000000", SolB: "2000000000", SolC: "3000000000", SolD: "4000000000" };
    let reads = 0, most = 0, down = false;
    const rpc3 = async (method, params) => {
      if (method === "getMultipleAccounts" && params[1].dataSlice) return { value: params[0].map((a) => (own3[a] ? { owner: own3[a] } : null)) };
      if (method === "getTokenAccountsByOwner") {
        const k = params[0].slice(-1);
        return { value: params[1].programId === TOKEN_PROGRAMS[0] ? [[`Sol${k}`, WSOL, 9], [`Coin${k}`, `Mint${k}`, 6]].map(([pk, mint, d]) => ({ pubkey: pk, account: { data: { parsed: { info: { mint, tokenAmount: { decimals: d } } } } } })) : [] };
      }
      if (method === "getMultipleAccounts") {
        if (down) throw new Error("getMultipleAccounts: fake outage");
        reads++; most = Math.max(most, params[0].length);
        return { context: { slot: 9 }, value: params[0].map((a) => (amt[a] || /^Coin/.test(a) ? { data: { parsed: { info: { tokenAmount: { amount: amt[a] || "1000000" } } } } } : null)) };
      }
      throw new Error("unexpected " + method);
    };
    now = Math.ceil(now / 30_000) * 30_000;
    const t3 = now, calls3 = {};
    for (const k of ["A", "B", "C"]) calls3[`h${k}`] = { hash: `h${k}`, chain: "solana", coin: k, status: "sealed", created_ms: t3, call_json: JSON.stringify({ contract_address: `Mint${k}`, pool_address: `Pool${k}` }) };
    fs.writeFileSync(path.join(dataDir3, "calls.json"), JSON.stringify(calls3));
    const rec3 = new Recorder({ dataDir: dataDir3, rpc: rpc3, clock: () => now, log: () => {} });
    const lines3 = (h) => fs.readFileSync(rec3.file(h), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((l) => !l.header);
    for (let s = 0; s <= 120; s++) { await rec3.step(); now += 1000; }
    check("three calls at once: ONE RPC call per tick reads all of them (13 in 2 min, not 39), 6 accounts each time",
      reads === 13 && most === 6 && ["hA", "hB", "hC"].every((h) => lines3(h).length === 13));
    check("...and each call gets its own pool's amounts (nothing swapped between calls)",
      lines3("hA").every((l) => l.sol === "1000000000") && lines3("hB").every((l) => l.sol === "2000000000") && lines3("hC").every((l) => l.sol === "3000000000") &&
      ["hA", "hB", "hC"].every((h) => lines3(h).every((l) => l.tok === "1000000" && l.t % 10_000 === 0)));
    now = Math.ceil(now / 10_000) * 10_000;   // a 10 s mark: A, B and C are due, and D is new
    calls3.hD = { hash: "hD", chain: "solana", coin: "D", status: "sealed", created_ms: now, call_json: JSON.stringify({ contract_address: "MintD", pool_address: "PoolD" }) };
    fs.writeFileSync(path.join(dataDir3, "calls.json"), JSON.stringify(calls3));
    down = true; await rec3.step(); now += 1000;
    const errs = ["hA", "hB", "hC", "hD"].map((h) => rec3.state.calls[h].errors || 0);
    down = false;
    for (let s = 0; s < 20; s++) { await rec3.step(); now += 1000; }
    check("an RPC outage puts every call of that read on a retry, then they all carry on together (a new call joins the same read)",
      errs.every((e) => e === 1) && lines3("hD").length >= 2 && lines3("hD").every((l) => l.sol === "4000000000") && most === 8);
    reads = 0;
    for (let s = 0; s < 3600; s++) { await rec3.step(); now += 1000; }
    const slowA = lines3("hA").filter((l) => l.t > t3 + SCHEDULE.fastForS * 1000);
    check("after the first hour every 30 s, still all calls in one read", slowA.length >= 2 && slowA.slice(1).every((l, i) => l.t - slowA[i].t === 30_000) && reads < 400);
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log("--- witty price recorder selftest ---");
  for (const [name, ok] of results) console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  const fails = results.filter(([, ok]) => !ok).length;
  console.log(fails ? `${fails} FAILED` : `all ${results.length} passed`);
  process.exit(fails ? 1 : 0);
}

// ---------------- main ----------------

async function main() {
  if (process.argv.includes("--selftest")) return selftest();
  const urls = [process.env.SOL_RPC, process.env.SOL_RPC2, SOL_PUBLIC_RPC];
  const ci = process.argv.indexOf("--check");
  if (ci > -1) process.exit(await liveCheck(makeRpc(urls), process.argv[ci + 1], process.argv[ci + 2]));
  const rec = new Recorder({
    dataDir: process.env.WITTY_DATA || path.join(process.cwd(), "data"),
    rpc: makeRpc(urls),
  });
  const slot = await rec.rpc("getSlot", []);
  console.log(`Witty price recorder (${VERSION}) · Solana slot ${slot} · ${urls.filter(Boolean).length} RPC(s), keys hidden · ` +
    `every ${SCHEDULE.fastEveryS}s for the first hour, then every ${SCHEDULE.slowEveryS}s to 24 h (longer calls: to their time limit), all due calls in one RPC call · ` +
    `PumpSwap pools and pump.fun bonding curves`);
  for (;;) {
    try { await rec.step(); } catch (e) { console.error("error:", e?.message || e); }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) main().catch((e) => { console.error(e?.message || e); process.exit(1); });
