// Downloads the price recorder's file for every revealed Solana call from Witty's API into data/prices/, so
// `node witty_score.mjs` can re-score those calls. Only revealed calls are published. Node 20+, nothing to install.
//
//   node fetch_prices.mjs [--api=https://api.eurekascout.com]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const API = (process.argv.find((a) => a.startsWith("--api=")) || "--api=https://api.eurekascout.com").slice(6).replace(/\/$/, "");
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "data", "prices");
fs.mkdirSync(dir, { recursive: true });
const r = await fetch(`${API}/data/prices/index.json`);
if (!r.ok) { console.error(`the list of price files didn't load: HTTP ${r.status}`); process.exit(1); }
const calls = (await r.json()).calls || [];
let got = 0, failed = 0;
for (const c of calls) {
  if (!/^[0-9a-f]{64}$/.test(c.hash)) continue;
  const f = await fetch(`${API}/data/prices/${c.hash}.jsonl`);   // always fetched again: a 3-day call keeps recording after its reveal
  if (!f.ok) { failed++; console.log(`call #${c.id}: HTTP ${f.status}, skipped`); continue; }
  fs.writeFileSync(path.join(dir, `${c.hash}.jsonl`), await f.text());
  got++;
}
console.log(`${calls.length} revealed Solana calls: ${got} price files saved in ${dir}${failed ? `, ${failed} failed` : ""}`);
