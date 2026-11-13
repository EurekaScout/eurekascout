// Downloads the price files of Witty's revealed calls from his API, so `node witty_score.mjs` can re-score them:
//   Solana:    the price recorder's file for every revealed call, into data/prices/
//   Robinhood: the readings of every finished call that the live scorer has saved, into data/prices/rh/. These are
//              the swaps it read from the chain, each with its block. A call with no file yet is read from the chain by
//              the scorer, and `node witty_score.mjs --from-chain` reads every Robinhood call from the chain again.
// Only revealed calls are published. Node 20+, nothing to install.
// A dropped connection, a slow answer or a busy server is tried again (4 tries per file). A file that still fails is
// skipped and counted, and the scorer marks that call "not scored", never guessed.
//
//   node fetch_prices.mjs [--api=https://api.eurekascout.com]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const API = (process.argv.find((a) => a.startsWith("--api=")) || "--api=https://api.eurekascout.com").slice(6).replace(/\/$/, "");
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "data", "prices");
const TRIES = 4, TIMEOUT_MS = 30_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** GET as text. Tries again after a dropped connection, a timeout, or HTTP 408, 429 or 5xx; any other HTTP error is final. */
async function get(url) {
  let last;
  for (let i = 0; i < TRIES; i++) {
    if (i) await sleep(1000 * 2 ** (i - 1));     // 1 s, 2 s, 4 s
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (r.ok) return await r.text();           // read inside the try: a connection can drop halfway through the file
      last = new Error(`HTTP ${r.status}`);
      if (r.status !== 408 && r.status !== 429 && r.status < 500) break;
    } catch (e) { last = new Error(e?.name === "TimeoutError" ? `no answer in ${TIMEOUT_MS / 1000} s` : `connection dropped (${e?.cause?.code || e?.name || "network error"})`); }
  }
  throw last;
}

fs.mkdirSync(dir, { recursive: true });
let calls;
try { calls = JSON.parse(await get(`${API}/data/prices/index.json`)).calls || []; }
catch (e) { console.error(`the list of price files didn't load: ${e.message}`); process.exit(1); }
let got = 0, failed = 0, n = 0;
for (const c of calls) {
  if (++n % 50 === 0) console.log(`  ${n} of ${calls.length}...`);
  if (!/^[0-9a-f]{64}$/.test(c.hash)) continue;
  try {
    const text = await get(`${API}/data/prices/${c.hash}.jsonl`);   // always fetched again: a call keeps recording after its reveal
    fs.writeFileSync(path.join(dir, `${c.hash}.jsonl`), text);
    got++;
  } catch (e) { failed++; console.log(`call #${c.id}: ${e.message}, skipped`); }
}
console.log(`${calls.length} revealed Solana calls: ${got} price files saved in ${dir}${failed ? `, ${failed} failed (run it again for those)` : ""}`);

// Robinhood: a saved file never changes, so the ones already here are skipped.
const rhDir = path.join(dir, "rh");
let rhCalls = null;
try { rhCalls = JSON.parse(await get(`${API}/data/prices/rh/index.json`)).calls || []; }
catch (e) { console.log(`Robinhood price files: the list didn't load (${e.message}). The scorer will read those calls from the chain.`); }
if (rhCalls) {
  fs.mkdirSync(rhDir, { recursive: true });
  let rhGot = 0, rhHad = 0, rhFailed = 0;
  for (const c of rhCalls) {
    if (!/^[0-9a-f]{64}$/.test(c.hash)) continue;
    const file = path.join(rhDir, `${c.hash}.json`);
    if (fs.existsSync(file)) { rhHad++; continue; }
    try {
      const text = await get(`${API}/data/prices/rh/${c.hash}.json`);
      JSON.parse(text);                                   // a file that isn't JSON is not kept
      fs.writeFileSync(`${file}.tmp`, text);
      fs.renameSync(`${file}.tmp`, file);
      rhGot++;
    } catch (e) { rhFailed++; console.log(`call #${c.id}: ${e.message}, skipped`); }
  }
  console.log(`${rhCalls.length} finished Robinhood calls: ${rhGot} price files downloaded, ${rhHad} already here${rhFailed ? `, ${rhFailed} failed (run it again for those)` : ""}`);
}
