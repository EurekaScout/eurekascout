// Witty's platform fee, and NEAR for the receipts contract's storage, step by step. Every step previews first; add
// --yes to send (on mainnet you also type the account's name).
//
// The scouts contract lets only its platform account claim a scout's platform fee: all of it at once, to itself
// (claim_platform_fee, 1 yoctoNEAR attached; there's no partial amount and no other receiver). So paying the receipts
// contract's storage out of the fee takes two steps:
//
//   node scripts/platform-fee.mjs --network mainnet --owner eurekascout.near --step claim
//   node scripts/platform-fee.mjs --network mainnet --owner eurekascout.near --step fund --amount 4
//
// Steps:
//   status  read-only: Witty's platform fee, bills budget and vault; the platform account; receipts' free balance
//   claim   claim Witty's whole platform fee into the platform account (--owner)
//   fund    send --amount N NEAR (default 4, at most 10) from the platform account to the receipts contract, a plain
//           transfer; the platform account keeps at least 1 NEAR free
//
// Options: --network testnet|mainnet (required) · --owner ACCOUNT (the platform account, which signs; required) ·
//          --scouts ACCOUNT (default scouts.<owner>) · --receipts ACCOUNT (default receipts.<owner>) ·
//          --scout ID (default witty) · --amount N · --rpc URL · --yes

import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { Near } from "near-kit";
import { FileKeyStore } from "near-kit/keys/file";

const NEAR = 10n ** 24n, BYTE = 10n ** 19n, KEEP = NEAR;   // the platform account keeps 1 NEAR free (trial passes, gas)
const MAX_FUND = 10n * NEAR;

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : fallback; };
const fail = (msg) => { console.error(`\n  STOP: ${msg}\n`); process.exit(1); };
const fmt = (y) => `${(Number(BigInt(y) / 10n ** 18n) / 1e6).toFixed(4)} NEAR`;
/** "4" or "4.5" NEAR -> yocto, exactly; null if it isn't a plain amount. */
const toYocto = (v) => { const t = String(v ?? "").trim(); if (!/^\d+(\.\d{1,24})?$/.test(t)) return null; const [w, f = ""] = t.split("."); return BigInt(w) * NEAR + BigInt((f + "0".repeat(24)).slice(0, 24)); };

const network = arg("network"), owner = arg("owner"), step = arg("step"), send = process.argv.includes("--yes");
if (!["testnet", "mainnet"].includes(network)) fail("--network must be testnet or mainnet");
if (!owner) fail("--owner is required (the platform account)");
const STEPS = ["status", "claim", "fund"];
if (!STEPS.includes(step)) fail(`--step must be one of: ${STEPS.join(", ")}`);
const scouts = arg("scouts", `scouts.${owner}`), receipts = arg("receipts", `receipts.${owner}`), scoutId = arg("scout", "witty");
const rpcUrl = arg("rpc", network === "mainnet" ? "https://free.rpc.fastnear.com" : "https://test.rpc.fastnear.com");
const explorer = network === "mainnet" ? "https://nearblocks.io" : "https://testnet.nearblocks.io";

async function query(params) {
  const r = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { finality: "final", ...params } }) });
  const j = await r.json();
  if (j.error || j.result?.error) throw new Error(JSON.stringify(j.error || j.result.error).slice(0, 200));
  return j.result;
}
const view = (account, method, args = {}) => query({ request_type: "call_function", account_id: account, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") })
  .then((r) => JSON.parse(Buffer.from(r.result).toString()));
const accountOf = (id) => query({ request_type: "view_account", account_id: id });
const freeOf = (a) => BigInt(a.amount) - BigInt(a.storage_usage) * BYTE;
async function confirm(name) {
  if (network !== "mainnet") return;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const typed = (await rl.question(`\nThis moves NEAR from ${name} on mainnet. Type ${name} to go ahead: `)).trim();
  rl.close();
  if (typed !== name) fail("that didn't match - nothing was sent");
}
const report = (checks) => { console.log("\nChecks on chain:"); for (const [k, v] of Object.entries(checks)) console.log(`  ${v ? "PASS" : "FAIL"}  ${k}`); process.exit(Object.values(checks).every(Boolean) ? 0 : 1); };
const preview = () => { console.log("\nPreview only. To send it, run the same command with --yes at the end.\n"); process.exit(0); };

// ---------- what's on chain now ----------
console.log(`\nPlatform fee - step "${step}" - ${send ? "SENDING" : "preview (nothing is sent)"} on ${network}`);
const cfg = await view(scouts, "get_config").catch(() => fail(`${scouts} doesn't answer get_config`));
const scout = await view(scouts, "get_scout", { scout_id: scoutId }).catch(() => null);
if (!scout) fail(`${scouts} has no scout called ${scoutId}`);
const ownerAcc = await accountOf(owner).catch(() => fail(`${owner} doesn't exist`));
const rcpAcc = await accountOf(receipts).catch(() => fail(`${receipts} doesn't exist`));
const vaultId = scout.vault_id || `${scoutId}.${scouts}`;
const vaultAcc = await accountOf(vaultId).catch(() => null);
const fee = BigInt(scout.platform_balance), inFlight = BigInt(scout.in_flight || 0);
console.log(`  scouts     : ${scouts} · platform account ${cfg.platform_id} · owner ${cfg.owner_id}`);
console.log(`  ${scoutId.padEnd(10)} : platform fee ${fmt(fee)} · bills ${fmt(scout.bills_balance)} (cap ${fmt(scout.bills_cap)} per 30 days, max ${fmt(scout.bills_cap_max)}) · in flight ${fmt(inFlight)}`);
if (vaultAcc) console.log(`  vault      : ${vaultId} · ${fmt(vaultAcc.amount)}`);
console.log(`  platform   : ${owner} · ${fmt(freeOf(ownerAcc))} free`);
console.log(`  receipts   : ${receipts} · ${fmt(freeOf(rcpAcc))} free (${fmt(rcpAcc.amount)} in all, ${rcpAcc.storage_usage} bytes stored = ${fmt(BigInt(rcpAcc.storage_usage) * BYTE)} locked)`);
if (step === "status") process.exit(0);

if (cfg.platform_id !== owner) fail(`only ${cfg.platform_id} can claim the platform fee, and it's paid to ${cfg.platform_id} itself: run this with --owner ${cfg.platform_id}`);
const keyStore = new FileKeyStore(join(homedir(), ".near-credentials"), network);
const near = new Near({ network: { networkId: network, rpcUrl }, keyStore, defaultSignerId: owner, defaultWaitUntil: "FINAL" });

// ---------- claim: the whole platform fee into the platform account ----------
if (step === "claim") {
  if (fee <= 0n) fail(`${scoutId} has no platform fee to claim right now`);
  if (inFlight > 0n) fail(`${fmt(inFlight)} is already on its way out of ${scoutId}'s account: wait a minute and look again with --step status`);
  if (vaultAcc && BigInt(vaultAcc.amount) < fee) fail(`${vaultId} holds ${fmt(vaultAcc.amount)}, less than the fee: run sync first, nothing was sent`);
  console.log(`\n  plan       : claim_platform_fee("${scoutId}") on ${scouts}, 1 yoctoNEAR attached`);
  console.log(`               all ${fmt(fee)} goes from ${vaultId} to ${owner} (the contract has no partial claim)`);
  if (!send) preview();
  await confirm(owner);
  const before = BigInt((await accountOf(owner)).amount);
  const out = await near.call(scouts, "claim_platform_fee", { scout_id: scoutId }, { gas: "100 Tgas", attachedDeposit: 1n }).catch((e) => fail(`the claim didn't go through: ${String(e.message || e).slice(0, 200)}`));
  const hash = out?.transaction?.hash || out?.transaction_outcome?.id;
  if (hash) console.log(`  sent       : ${explorer}/txns/${hash}`);
  const after = await view(scouts, "get_scout", { scout_id: scoutId }), acc = await accountOf(owner);
  const gained = BigInt(acc.amount) - before;
  console.log(`  now        : platform fee ${fmt(after.platform_balance)} · in flight ${fmt(after.in_flight || 0)} · ${owner} +${fmt(gained)} (after gas)`);
  report({
    [`${scoutId}'s platform fee is now 0`]: BigInt(after.platform_balance) === 0n,
    "nothing is left in flight (the payout landed)": BigInt(after.in_flight || 0) === 0n,
    [`${owner} received the fee (less up to 0.02 NEAR of gas)`]: gained > fee - NEAR / 50n && gained <= fee,
  });
}

// ---------- fund: a plain transfer to the receipts contract ----------
if (step === "fund") {
  const amount = toYocto(arg("amount", "4"));
  if (amount === null || amount <= 0n) fail("--amount must be a plain NEAR amount, like 4 or 2.5");
  if (amount > MAX_FUND) fail(`--amount is capped at ${fmt(MAX_FUND)} a run`);
  const free = freeOf(ownerAcc);
  if (free - amount < KEEP) fail(`${owner} has ${fmt(free)} free; sending ${fmt(amount)} would leave less than ${fmt(KEEP)} (claim the platform fee first?)`);
  console.log(`\n  plan       : send ${fmt(amount)} from ${owner} to ${receipts} (a plain transfer)`);
  console.log(`               ${owner} keeps ${fmt(free - amount)} free; ${receipts} goes to about ${fmt(freeOf(rcpAcc) + amount)} free`);
  if (!send) preview();
  await confirm(owner);
  const before = BigInt(rcpAcc.amount);
  const out = await near.send(receipts, amount).catch((e) => fail(`the transfer didn't go through: ${String(e.message || e).slice(0, 200)}`));
  const hash = out?.transaction?.hash || out?.transaction_outcome?.id;
  if (hash) console.log(`  sent       : ${explorer}/txns/${hash}`);
  const acc = await accountOf(receipts);
  console.log(`  now        : ${receipts} · ${fmt(freeOf(acc))} free (amount − storage_usage × 1e19)`);
  report({ [`${receipts} received ${fmt(amount)}`]: BigInt(acc.amount) - before >= amount });
}
