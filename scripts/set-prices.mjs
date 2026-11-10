// Re-price Witty's NFT and passes to their dollar targets, in one command. The contracts store prices in NEAR, so
// they drift from the dollar targets as NEAR's price moves. You give NEAR's price in dollars; this works out the
// new NEAR prices, shows old and new side by side, and sends nothing until you add --yes (on mainnet you also type
// the account's name).
//
//   node scripts/set-prices.mjs --network mainnet --owner eurekascout.near --near-usd 3.49
//
// Options: --network testnet|mainnet (required) · --owner ACCOUNT (owns both contracts and signs; required) ·
//          --near-usd N    what 1 NEAR costs in dollars now (required; look it up, don't guess)
//          --bronze N      the Bronze Pass (7 days) in dollars (default 5)
//          --silver N      the Silver Pass (30 days) in dollars (default 15)
//          --nft N         the Witty NFT in dollars (default 50)
//          --scouts ACCOUNT (default scouts.<owner>) · --pass ACCOUNT (default pass.<owner>; passes.<owner> on testnet)
//          --scout ID (default witty) · --rpc URL · --force (allow a change of more than 50%) · --yes
//          --selftest      check the arithmetic offline, no network
//
// Passes are rounded to 0.01 NEAR and the NFT to 0.1 NEAR. Every price must stay between the contract's floor and
// the cap for Witty's level; a price outside them stops here, and the contract would refuse it too. A buyer who is
// paying at the moment a price changes gets their payment back and pays the new price.

import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

const NEAR = 10n ** 24n;
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : fallback; };
const flag = (name) => process.argv.includes(`--${name}`);
const fail = (msg) => { console.error(`\n  STOP: ${msg}\n`); process.exit(1); };
const fmt = (y) => `${(Number(BigInt(y) / 10n ** 18n) / 1e6).toFixed(2)} NEAR`;

/** Dollars to yoctoNEAR at a NEAR price, rounded to `step` NEAR (0.01 or 0.1). Whole-number maths, no float drift. */
export function toNear(usd, nearUsd, step) {
  const units = Math.round(usd / nearUsd / step);                    // how many steps
  const perStep = BigInt(Math.round(step * 1000)) * (NEAR / 1000n);  // one step in yocto
  return BigInt(units) * perStep;
}
const usdOf = (yocto, nearUsd) => (Number(BigInt(yocto) / 10n ** 18n) / 1e6) * nearUsd;
const pct = (a, b) => (Number(BigInt(b) - BigInt(a)) / Number(BigInt(a))) * 100;
function num(name, fallback, lo, hi) {
  const raw = arg(name, fallback);
  if (raw === undefined) fail(`--${name} is required`);
  const v = Number(raw);
  if (!Number.isFinite(v) || v < lo || v > hi) fail(`--${name} must be a number between ${lo} and ${hi} (got ${raw})`);
  return v;
}

if (flag("selftest")) {
  const t = (label, ok) => { console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`); if (!ok) process.exitCode = 1; };
  t("$5 at $3.80 is 1.32 NEAR", toNear(5, 3.8, 0.01) === 1320000000000000000000000n);
  t("$5 at $3.49 is 1.43 NEAR", toNear(5, 3.49, 0.01) === 1430000000000000000000000n);
  t("$15 at $3.49 is 4.30 NEAR", toNear(15, 3.49, 0.01) === 4300000000000000000000000n);
  t("$50 at $3.49 is 14.3 NEAR", toNear(50, 3.49, 0.1) === 14300000000000000000000000n);
  t("$50 at $3.80 is 13.2 NEAR", toNear(50, 3.8, 0.1) === 13200000000000000000000000n);
  t("$5 at $10 is 0.50 NEAR", toNear(5, 10, 0.01) === 500000000000000000000000n);
  t("fmt shows two decimals", fmt(1430000000000000000000000n) === "1.43 NEAR");
  t("dollars back from NEAR", Math.abs(usdOf(1430000000000000000000000n, 3.49) - 4.9907) < 1e-9);
  t("percent change", Math.abs(pct(13n * NEAR, 143n * NEAR / 10n) - 10) < 1e-9);
  console.log(process.exitCode ? "\n  some checks FAILED\n" : "\n  all 9 checks passed\n");
  process.exit(process.exitCode || 0);
}

const network = arg("network"), owner = arg("owner"), send = flag("yes");
if (!["testnet", "mainnet"].includes(network)) fail("--network must be testnet or mainnet");
if (!owner) fail("--owner is required");
const nearUsd = num("near-usd", undefined, 0.3, 100);
const target = { bronze: num("bronze", "5", 0.5, 1000), silver: num("silver", "15", 0.5, 3000), nft: num("nft", "50", 1, 100000) };
const scouts = arg("scouts", `scouts.${owner}`);
const pass = arg("pass", network === "testnet" ? `passes.${owner}` : `pass.${owner}`);
const scoutId = arg("scout", "witty");

const { Near } = await import("near-kit");
const { FileKeyStore } = await import("near-kit/keys/file");
const keyStore = new FileKeyStore(join(homedir(), ".near-credentials"), network);
const rpc = arg("rpc");
const near = new Near({ network: rpc ? { networkId: network, rpcUrl: rpc } : network, keyStore, defaultSignerId: owner, defaultWaitUntil: "FINAL" });

const s = await near.view(scouts, "get_scout", { scout_id: scoutId });
const l = await near.view(pass, "get_listing", { scout_id: scoutId });
const cfg = await near.view(pass, "get_config", {});
if (!s?.ready) fail(`${scoutId} isn't set up on ${scouts}`);
if (!l) fail(`${scoutId}'s passes aren't listed on ${pass}`);

const now = { nft: BigInt(s.mint_price), bronze: BigInt(l.price_7d), silver: BigInt(l.price_30d) };
const next = { nft: toNear(target.nft, nearUsd, 0.1), bronze: toNear(target.bronze, nearUsd, 0.01), silver: toNear(target.silver, nearUsd, 0.01) };
const limits = {
  nft: [BigInt(s.mint_price_min), BigInt(s.levels[s.level].max_price)],
  bronze: [BigInt(cfg.min_price), BigInt(cfg.levels[l.level].max_7d)],
  silver: [BigInt(cfg.min_price), BigInt(cfg.levels[l.level].max_30d)],
};
const NAMES = { nft: "Witty NFT", bronze: "Bronze Pass (7 days)", silver: "Silver Pass (30 days)" };

console.log(`\nWitty's prices - ${send ? "SENDING" : "preview (nothing is sent)"} on ${network} · 1 NEAR = $${nearUsd}`);
console.log(`  Witty is ${s.level_name} (NFT) / ${l.level_name} (passes)\n`);
for (const k of ["nft", "bronze", "silver"]) {
  const same = now[k] === next[k];
  console.log(`  ${NAMES[k].padEnd(22)} target $${target[k]}   now ${fmt(now[k]).padStart(11)} ($${usdOf(now[k], nearUsd).toFixed(2)})   ->   ${fmt(next[k]).padStart(11)} ($${usdOf(next[k], nearUsd).toFixed(2)})${same ? "   no change" : `   ${pct(now[k], next[k]) > 0 ? "+" : ""}${pct(now[k], next[k]).toFixed(1)}%`}`);
}
for (const k of ["nft", "bronze", "silver"]) {
  const [lo, hi] = limits[k];
  if (next[k] < lo) fail(`${NAMES[k]}: ${fmt(next[k])} is under the contract's floor of ${fmt(lo)} - raise its dollar target`);
  if (next[k] > hi) fail(`${NAMES[k]}: ${fmt(next[k])} is over the cap of ${fmt(hi)} for Witty's level - lower its dollar target`);
  if (Math.abs(pct(now[k], next[k])) > 50 && !flag("force")) fail(`${NAMES[k]} would change by ${pct(now[k], next[k]).toFixed(0)}%: check --near-usd ${nearUsd} is right, then add --force if you mean it`);
}
const doNft = now.nft !== next.nft, doPass = now.bronze !== next.bronze || now.silver !== next.silver;
if (!doNft && !doPass) { console.log("\n  Every price already matches. Nothing to do.\n"); process.exit(0); }
console.log(`\n  ${[doNft && "set_mint_price on " + scouts, doPass && "set_prices on " + pass].filter(Boolean).join(" · ")}`);
if (!send) { console.log(`\nPreview only. To send it, run the same command with --yes at the end.\n`); process.exit(0); }

if (!(await keyStore.get(owner))) fail(`no key for ${owner} in ~/.near-credentials/${network}/`);
if (network === "mainnet") {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const typed = (await rl.question(`\nThis changes what buyers pay on mainnet. Type ${owner} to go ahead: `)).trim();
  rl.close();
  if (typed !== owner) fail("that didn't match - nothing was sent");
}
const opts = { gas: "100 Tgas", attachedDeposit: 1n };
if (doNft) await near.call(scouts, "set_mint_price", { scout_id: scoutId, mint_price: next.nft.toString() }, opts);
if (doPass) await near.call(pass, "set_prices", { scout_id: scoutId, price_7d: next.bronze.toString(), price_30d: next.silver.toString() }, opts);

const s2 = await near.view(scouts, "get_scout", { scout_id: scoutId });
const l2 = await near.view(pass, "get_listing", { scout_id: scoutId });
const checks = {
  [`Witty NFT is ${fmt(next.nft)}`]: BigInt(s2.mint_price) === next.nft,
  [`Bronze Pass is ${fmt(next.bronze)}`]: BigInt(l2.price_7d) === next.bronze,
  [`Silver Pass is ${fmt(next.silver)}`]: BigInt(l2.price_30d) === next.silver,
};
console.log("\nChecks on chain:");
for (const [label, ok] of Object.entries(checks)) console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
