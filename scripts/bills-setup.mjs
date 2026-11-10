// Lets Witty pay his own receipts storage out of his bills budget, step by step. Every step previews first; add --yes
// to send (on mainnet you also type the account's name).
//
// The scouts contract pays a bill only to an account on the scout's payee list, only when its operator asks
// (pay_bill), only from the bills budget, and never more than the bills cap in any 30 days. So:
//
//   LAPTOP  --step setup      receipts.<owner> on Witty's payee list, and <owner> as Witty's operator (one transaction)
//   SERVER  --step server-key make the server's bills key once (the private half stays in ~/.near-credentials-bills,
//                             readable by root only; prints only the public half)
//   LAPTOP  --step add-key --key ed25519:...   put that key on <owner>: it may call scouts.<owner>.pay_bill and
//                             nothing else, no NEAR attached, up to 0.25 NEAR of gas in all
//   SERVER  --step test-bill  pay one 0.001 NEAR bill to receipts.<owner> with the server's key (proves it end to end)
//   either  --step status     read-only
//
// Options: --network testnet|mainnet (required) · --owner ACCOUNT (required; owns the scouts contract) ·
//          --scouts ACCOUNT (default scouts.<owner>) · --receipts ACCOUNT (default receipts.<owner>) ·
//          --scout ID (default witty) · --operator ACCOUNT (default <owner>) · --key ed25519:... · --rpc URL · --yes

import fs from "node:fs";
import crypto from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { Near } from "near-kit";
import { FileKeyStore } from "near-kit/keys/file";

const NEAR = 10n ** 24n;
const METHODS = ["pay_bill"];
const ALLOWANCE = "0.25 NEAR";            // gas the server's bills key may spend in all (about 50 bills at 50 Tgas)
const TEST_BILL = NEAR / 1000n;           // 0.001 NEAR, the contract's smallest bill
const BILLS_DIR = join(homedir(), ".near-credentials-bills");

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : fallback; };
const fail = (msg) => { console.error(`\n  STOP: ${msg}\n`); process.exit(1); };
const fmt = (y) => `${(Number(BigInt(y ?? 0) / 10n ** 18n) / 1e6).toFixed(4)} NEAR`;
const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const b58 = (bytes) => { let v = BigInt("0x" + (Buffer.from(bytes).toString("hex") || "0")), o = ""; while (v > 0n) { o = A[Number(v % 58n)] + o; v /= 58n; } for (const b of bytes) { if (b) break; o = "1" + o; } return o; };

const network = arg("network"), owner = arg("owner"), step = arg("step"), send = process.argv.includes("--yes");
if (!["testnet", "mainnet"].includes(network)) fail("--network must be testnet or mainnet");
if (!owner) fail("--owner is required (the scouts contract's owner)");
const STEPS = ["status", "setup", "server-key", "add-key", "test-bill"];
if (!STEPS.includes(step)) fail(`--step must be one of: ${STEPS.join(", ")}`);
const scouts = arg("scouts", `scouts.${owner}`), receipts = arg("receipts", `receipts.${owner}`), scoutId = arg("scout", "witty");
const operator = arg("operator", owner);
const rpcUrl = arg("rpc", network === "mainnet" ? "https://free.rpc.fastnear.com" : "https://test.rpc.fastnear.com");
const explorer = network === "mainnet" ? "https://nearblocks.io" : "https://testnet.nearblocks.io";

// ---------- server-key (SERVER): no chain calls, only a key file ----------
if (step === "server-key") {
  const dir = join(BILLS_DIR, network), file = join(dir, `${owner}.json`);
  let made = false;
  if (!fs.existsSync(file)) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    const pub = publicKey.export({ format: "der", type: "spki" }).subarray(12), seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(16);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify({ account_id: owner, public_key: `ed25519:${b58(pub)}`, private_key: `ed25519:${b58(Buffer.concat([seed, pub]))}` }), { mode: 0o600 });
    made = true;
  }
  const pk = JSON.parse(fs.readFileSync(file, "utf8")).public_key;
  console.log(`\n${made ? "Made" : "Already have"} the server's bills key for ${owner} (the private half stays in ${file}, readable by this user only).`);
  console.log(`PUBLIC key, for the laptop's add-key step:\n${pk}\n`);
  process.exit(0);
}

async function query(params) {
  const r = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { finality: "final", ...params } }) });
  const j = await r.json();
  if (j.error || j.result?.error) throw new Error(JSON.stringify(j.error || j.result.error).slice(0, 200));
  return j.result;
}
const view = (account, method, args = {}) => query({ request_type: "call_function", account_id: account, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") })
  .then((r) => JSON.parse(Buffer.from(r.result).toString()));
const accountOf = (id) => query({ request_type: "view_account", account_id: id });
const keysOf = (id) => query({ request_type: "view_access_key_list", account_id: id }).then((r) => r.keys);
const billKeys = (keys) => keys.filter((k) => k.access_key.permission?.FunctionCall?.receiver_id === scouts);
async function confirm(name) {
  if (network !== "mainnet") return;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const typed = (await rl.question(`\nThis changes ${name} on mainnet. Type ${name} to go ahead: `)).trim();
  rl.close();
  if (typed !== name) fail("that didn't match - nothing was sent");
}
const report = (checks) => { console.log("\nChecks on chain:"); for (const [k, v] of Object.entries(checks)) console.log(`  ${v ? "PASS" : "FAIL"}  ${k}`); process.exit(Object.values(checks).every(Boolean) ? 0 : 1); };
const preview = () => { console.log("\nPreview only. To send it, run the same command with --yes at the end.\n"); process.exit(0); };
const txLink = (out) => { const h = out?.transaction?.hash || out?.transaction_outcome?.id; if (h) console.log(`  sent       : ${explorer}/txns/${h}`); };

// ---------- what's on chain now ----------
console.log(`\nBills - step "${step}" - ${send ? "SENDING" : "preview (nothing is sent)"} on ${network}`);
const cfg = await view(scouts, "get_config").catch(() => fail(`${scouts} doesn't answer get_config`));
const scout = await view(scouts, "get_scout", { scout_id: scoutId }).catch(() => null);
if (!scout) fail(`${scouts} has no scout called ${scoutId}`);
const rcpAcc = await accountOf(receipts).catch(() => fail(`${receipts} doesn't exist`));
const keys = await keysOf(owner).catch(() => fail(`${owner} doesn't exist`));
const payees = scout.payees || [];
const left30 = scout.bills_left_30d != null ? BigInt(scout.bills_left_30d) : BigInt(scout.bills_cap) - BigInt(scout.bills_spent_30d || 0);
console.log(`  scouts     : ${scouts} · owner ${cfg.owner_id}`);
console.log(`  ${scoutId.padEnd(10)} : bills budget ${fmt(scout.bills_balance)} · cap ${fmt(scout.bills_cap)} per 30 days (max ${fmt(scout.bills_cap_max)}) · ${fmt(left30)} left this 30 days`);
console.log(`  payees     : ${payees.length ? payees.join(", ") : "none"}`);
console.log(`  operator   : ${scout.operator_id || "none"}`);
const bk = billKeys(keys);
console.log(`  bills keys : ${bk.length ? bk.map((k) => `${k.public_key.slice(0, 16)}… (${k.access_key.permission.FunctionCall.method_names.join(", ")}, ${k.access_key.permission.FunctionCall.allowance ? fmt(k.access_key.permission.FunctionCall.allowance) : "no limit"} of gas left)`).join("; ") : `none on ${owner} for ${scouts}`}`);
console.log(`  receipts   : ${receipts} · ${fmt(BigInt(rcpAcc.amount) - BigInt(rcpAcc.storage_usage) * 10n ** 19n)} free`);
if (step === "status") process.exit(0);

// ---------- setup (LAPTOP): receipts on the payee list, the operator ----------
if (step === "setup") {
  if (cfg.owner_id !== owner) fail(`${scouts} is owned by ${cfg.owner_id}: run this with --owner ${cfg.owner_id}`);
  const needPayee = !payees.includes(receipts), needOp = scout.operator_id !== operator;
  if (!needPayee && !needOp) fail(`${receipts} is already a payee and ${operator} is already the operator: nothing to do`);
  if (needPayee && payees.length >= 10) fail(`${scoutId} already has 10 payees, the most the contract allows`);
  if (operator === scouts || operator.endsWith(`.${scouts}`)) fail(`the operator can't be ${scouts} or a scout's account`);
  const newPayees = needPayee ? [...payees, receipts] : payees;
  console.log(`\n  plan       : one transaction from ${owner} to ${scouts}, 1 yoctoNEAR attached to each call`);
  if (needPayee) console.log(`               set_payees("${scoutId}", [${newPayees.join(", ")}])${payees.length ? " - the ones there now stay" : ""}`);
  if (needOp) console.log(`               set_operator("${scoutId}", ${operator})${scout.operator_id ? ` - replaces ${scout.operator_id}` : ""}`);
  console.log(`               no NEAR moves: bills still need the operator to ask, and stay within ${fmt(scout.bills_cap)} per 30 days`);
  if (!send) preview();
  await confirm(owner);
  const near = new Near({ network: { networkId: network, rpcUrl }, keyStore: new FileKeyStore(join(homedir(), ".near-credentials"), network), defaultSignerId: owner, defaultWaitUntil: "FINAL" });
  let tx = near.transaction(owner);
  if (needPayee) tx = tx.functionCall(scouts, "set_payees", { scout_id: scoutId, payees: newPayees }, { gas: "30 Tgas", attachedDeposit: 1n });
  if (needOp) tx = tx.functionCall(scouts, "set_operator", { scout_id: scoutId, operator_id: operator }, { gas: "30 Tgas", attachedDeposit: 1n });
  const out = await tx.send().catch((e) => fail(`it didn't go through: ${String(e.message || e).slice(0, 200)}`));
  txLink(out);
  const after = await view(scouts, "get_scout", { scout_id: scoutId });
  report({ [`${receipts} is on ${scoutId}'s payee list`]: (after.payees || []).includes(receipts), [`${operator} is ${scoutId}'s operator`]: after.operator_id === operator,
    "the bills budget didn't change": String(after.bills_balance) === String(scout.bills_balance) });
}

// ---------- add-key (LAPTOP): the server's key, for pay_bill only ----------
if (step === "add-key") {
  const key = arg("key");
  if (!/^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(key || "")) fail("--key ed25519:... (the PUBLIC key the server printed with --step server-key)");
  if (operator !== owner) fail(`the key goes on the operator's account; this script only adds keys to ${owner}`);
  const have = keys.find((k) => k.public_key === key);
  if (have?.access_key?.permission === "FullAccess") fail("that's a full-access key: not touching it");
  const had = have?.access_key?.permission?.FunctionCall;
  if (had) fail(`that key is already on ${owner} (for ${had.receiver_id}: ${had.method_names.join(", ") || "any method"}): not changing it`);
  console.log(`\n  plan       : add a key to ${owner}: ${key}`);
  console.log(`               it may call ${scouts}.${METHODS.join(", ")} only · no NEAR attached · up to ${ALLOWANCE} of gas in all`);
  if (scout.operator_id !== owner) console.log(`  note       : ${owner} isn't ${scoutId}'s operator yet, so the key can't pay anything until --step setup`);
  if (!send) preview();
  await confirm(owner);
  const near = new Near({ network: { networkId: network, rpcUrl }, keyStore: new FileKeyStore(join(homedir(), ".near-credentials"), network), defaultSignerId: owner, defaultWaitUntil: "FINAL" });
  const out = await near.transaction(owner).addKey(key, { type: "functionCall", receiverId: scouts, methodNames: METHODS, allowance: ALLOWANCE }).send()
    .catch((e) => fail(`it didn't go through: ${String(e.message || e).slice(0, 200)}`));
  txLink(out);
  const k = (await keysOf(owner)).find((x) => x.public_key === key), fc = k?.access_key?.permission?.FunctionCall;
  report({ "the key is on the account": !!k, "it is not a full-access key": !!k && k.access_key.permission !== "FullAccess",
    [`it can only call ${scouts}.${METHODS.join(", ")}`]: fc?.receiver_id === scouts && fc?.method_names?.join() === METHODS.join() });
}

// ---------- test-bill (SERVER): one 0.001 NEAR bill with the server's key ----------
if (step === "test-bill") {
  const file = join(BILLS_DIR, network, `${owner}.json`);
  if (!fs.existsSync(file)) fail(`no bills key in ${file}: run --step server-key here first`);
  const pk = JSON.parse(fs.readFileSync(file, "utf8")).public_key;
  const k = keys.find((x) => x.public_key === pk), fc = k?.access_key?.permission?.FunctionCall;
  if (!k) fail(`the bills key (${pk.slice(0, 16)}…) isn't on ${owner} yet: run --step add-key on the laptop`);
  if (k.access_key.permission === "FullAccess" || fc?.receiver_id !== scouts || fc?.method_names?.join() !== METHODS.join()) fail("the bills key on chain isn't limited to pay_bill: stopping");
  if (scout.operator_id !== owner) fail(`${scoutId}'s operator is ${scout.operator_id || "nobody"}, not ${owner}: run --step setup on the laptop`);
  if (!payees.includes(receipts)) fail(`${receipts} isn't on ${scoutId}'s payee list: run --step setup on the laptop`);
  if (BigInt(scout.bills_balance) < TEST_BILL || left30 < TEST_BILL) fail(`there's no room for a ${fmt(TEST_BILL)} bill (budget ${fmt(scout.bills_balance)}, ${fmt(left30)} left this 30 days)`);
  console.log(`\n  plan       : pay_bill("${scoutId}", ${receipts}, ${fmt(TEST_BILL)}) signed by ${owner} with the bills key ${pk.slice(0, 16)}…`);
  console.log(`               ${fmt(TEST_BILL)} goes from ${scoutId}'s bills budget to ${receipts}`);
  if (!send) preview();
  await confirm(owner);
  const near = new Near({ network: { networkId: network, rpcUrl }, keyStore: new FileKeyStore(BILLS_DIR, network), defaultSignerId: owner, defaultWaitUntil: "FINAL" });
  const before = BigInt(rcpAcc.amount);
  const out = await near.call(scouts, "pay_bill", { scout_id: scoutId, payee_id: receipts, amount: String(TEST_BILL), memo: "test: the server's bills key works" }, { gas: "50 Tgas" })
    .catch((e) => fail(`the bill didn't go through: ${String(e.message || e).slice(0, 200)}`));
  txLink(out);
  const after = await view(scouts, "get_scout", { scout_id: scoutId }), acc = await accountOf(receipts);
  console.log(`  now        : bills budget ${fmt(after.bills_balance)} · ${receipts} +${fmt(BigInt(acc.amount) - before)}`);
  report({ [`${scoutId}'s bills budget went down by ${fmt(TEST_BILL)}`]: BigInt(scout.bills_balance) - BigInt(after.bills_balance) === TEST_BILL,
    [`${receipts} received it`]: BigInt(acc.amount) - before >= TEST_BILL, "nothing is left in flight": BigInt(after.in_flight || 0) === 0n });
}
