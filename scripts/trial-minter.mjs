// Sets up the owner account's helper contract (free trial passes, and Witty's level), step by step. Every step
// previews first; add --yes to send.
//
// The pass contract lets only its owner mint free passes (mint_comp), with 0.015 NEAR attached for storage. Witty's
// server must not hold the owner's full-access key, and limited keys can't attach NEAR. So the owner account runs a
// tiny contract (contracts/trial-minter): `trial_mint(receiver_id)` mints one free 7-day Bronze Pass, paying the
// deposit itself, and only the owner's own keys can call it. The server gets a function-call key for `trial_mint`
// and `record_level` only: it can mint trial passes, up to the contract's cap, and set Witty's level on the scouts and
// pass contracts (the owner account is their recorder), and nothing else. The level comes from Witty's public record
// (Analyst at 30+ official calls and $1.05+ per $1 after fees, Elite at 100+ and $1.25+); anyone can recompute it from
// the record re-scored with verify/witty_score.mjs.
//
//   node scripts/trial-minter.mjs --network testnet --owner eurekascout.testnet --step deploy
//
// Steps, in order:
//   deploy      put the helper's code on the owner account and set it up (--cap N, default 1000), or update its
//               code (the count is kept); the owner's keys, NEAR and the contracts it owns don't change
//   add-key     give the server its key: --key ed25519:... (the public key the server printed with --trial-key); a key
//               that's already there gets today's methods (trial_mint, record_level)
//   test-mint   mint one trial pass with the server's kind of key, from ~/.near-credentials-trial: --to ACCOUNT
//               (testnet: checks the limited key works end to end)
//   set-cap     change how many more trial passes may be minted: --cap N (full-access key)
//   test-level  TESTNET only: set Witty's level with the server's kind of key: --level 0|1|2 (then back to 0)
//   status      read-only: the minter, the pass owner, the balance
//
// Options: --network testnet|mainnet (required) · --owner ACCOUNT (required; owns the pass contract) ·
//          --pass ACCOUNT (default pass.<owner> on mainnet, passes.<owner> on testnet) · --rpc URL · --yes

import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { Near } from "near-kit";
import { FileKeyStore } from "near-kit/keys/file";

const NEAR = 10n ** 24n, BYTE = 10n ** 19n;
const WASM = "contracts/trial-minter/target/near/witty_trial_minter.wasm";
const NO_CODE = "11111111111111111111111111111111";
const ALLOWANCE = "10 NEAR";     // gas the server's key may spend in all: 0.01 NEAR reserved a trial (100 Tgas), so ~1,000 trials

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : fallback; };
const fail = (msg) => { console.error(`\n  STOP: ${msg}\n`); process.exit(1); };
const fmt = (y) => `${(Number(BigInt(y) / 10n ** 18n) / 1e6).toFixed(4)} NEAR`;
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const base58 = (bytes) => { let v = BigInt("0x" + Buffer.from(bytes).toString("hex")), out = ""; while (v > 0n) { out = ALPHABET[Number(v % 58n)] + out; v /= 58n; } for (const b of bytes) { if (b !== 0) break; out = "1" + out; } return out; };
const codeHash = (bytes) => base58(createHash("sha256").update(bytes).digest());

const network = arg("network"), owner = arg("owner"), step = arg("step"), send = process.argv.includes("--yes");
if (!["testnet", "mainnet"].includes(network)) fail("--network must be testnet or mainnet");
if (!owner) fail("--owner is required");
const STEPS = ["deploy", "add-key", "test-mint", "test-level", "set-cap", "status"];
const METHODS = ["trial_mint", "record_level"];
if (!STEPS.includes(step)) fail(`--step must be one of: ${STEPS.join(", ")}`);
const pass = arg("pass", network === "testnet" ? `passes.${owner}` : `pass.${owner}`);
const rpcUrl = arg("rpc", network === "mainnet" ? "https://free.rpc.fastnear.com" : "https://test.rpc.fastnear.com");
const keyStore = new FileKeyStore(join(homedir(), ".near-credentials"), network);
const near = new Near({ network: { networkId: network, rpcUrl }, keyStore, defaultSignerId: owner, defaultWaitUntil: "FINAL" });
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
const keysOf = (id) => query({ request_type: "view_access_key_list", account_id: id }).then((r) => r.keys);
const minterOf = () => view(owner, "get_trial_minter").catch(() => null);
function returned(outcome) {
  const v = outcome?.status?.SuccessValue;
  if (!v) return null;
  const text = Buffer.from(v, "base64").toString("utf8");
  return text ? JSON.parse(text) : null;
}
async function confirm(name) {
  if (network !== "mainnet") return;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const typed = (await rl.question(`\nThis changes ${name} on mainnet. Type ${name} to go ahead: `)).trim();
  rl.close();
  if (typed !== name) fail("that didn't match - nothing was sent");
}
const report = (checks) => { console.log("\nChecks on chain:"); for (const [k, v] of Object.entries(checks)) console.log(`  ${v ? "PASS" : "FAIL"}  ${k}`); process.exit(Object.values(checks).every(Boolean) ? 0 : 1); };
const preview = () => { console.log("\nPreview only. To send it, run the same command with --yes at the end.\n"); process.exit(0); };

console.log(`\nTrial minter - step "${step}" - ${send ? "SENDING" : "preview (nothing is sent)"} on ${network}`);
const acc = await accountOf(owner).catch(() => fail(`${owner} doesn't exist`));
const cfg = await view(pass, "get_config").catch(() => fail(`${pass} doesn't answer get_config`));
const free = BigInt(acc.amount) - BigInt(acc.storage_usage) * BYTE;
console.log(`  owner      : ${owner} · ${fmt(free)} free · code ${acc.code_hash === NO_CODE ? "none" : acc.code_hash}`);
console.log(`  pass       : ${pass} · owned by ${cfg.owner_id}`);
if (cfg.owner_id !== owner) fail(`${pass} is owned by ${cfg.owner_id}, not ${owner}: only its owner can mint free passes`);

if (step === "status") {
  const m = await minterOf(), keys = await keysOf(owner);
  const fc = keys.filter((k) => k.access_key.permission?.FunctionCall?.receiver_id === owner);
  console.log(JSON.stringify({ minter: m, trial_keys: fc.map((k) => ({ key: `${k.public_key.slice(0, 16)}…`, methods: k.access_key.permission.FunctionCall.method_names, allowance: k.access_key.permission.FunctionCall.allowance ? fmt(k.access_key.permission.FunctionCall.allowance) : "unlimited" })) }, null, 1));
  process.exit(0);
}

if (!(await keyStore.get(owner)) && step !== "test-mint") fail(`no key for ${owner} in ~/.near-credentials/${network}/`);

if (step === "deploy") {
  if (!existsSync(WASM)) fail(`no ${WASM} - run: cd contracts/trial-minter && cargo near build non-reproducible-wasm`);
  const wasm = new Uint8Array(readFileSync(WASM)), cap = Number(arg("cap", "1000"));
  if (!(cap >= 1 && cap <= 100000)) fail("--cap must be 1 to 100000");
  const lock = BigInt(wasm.length) * BYTE + 300n * BYTE;
  console.log(`  code       : ${(wasm.length / 1024).toFixed(0)} KB, hash ${codeHash(wasm)} · locks about ${fmt(lock)} on ${owner} for storage`);
  console.log(`  cap        : ${cap} trial passes (each costs ${owner} about 0.012 NEAR: storage + gas)`);
  const m = await minterOf();
  if (acc.code_hash !== NO_CODE && !m) fail(`${owner} already runs other code (${acc.code_hash}): not overwriting it`);
  if (m) console.log(`  note       : the helper is already there (v${m.version}, ${m.minted} minted, ${m.remaining} left): this replaces its code, keeps its count`);
  if (free < lock + NEAR / 2n) fail(`${owner} needs about ${fmt(lock + NEAR / 2n)} free: the code's storage plus 0.5 NEAR`);
  console.log("  checks     : all passed");
  if (!send) preview();
  await confirm(owner);
  let tx = near.transaction(owner).deployContract(owner, wasm);
  if (!m) tx = tx.functionCall(owner, "new", { pass, remaining: cap }, { gas: "30 Tgas" });
  await tx.send();
  const after = await accountOf(owner), mm = await minterOf();
  report({
    [`${owner} runs the minter (code = this file)`]: after.code_hash === codeHash(wasm),
    [`it mints through ${pass}`]: mm?.pass === pass,
    [`${mm?.remaining} trial passes may be minted, 7 days each`]: mm?.remaining > 0 && mm?.days === 7,
    [`${owner}'s keys are unchanged`]: (await keysOf(owner)).length > 0,
  });
}

if (step === "add-key") {
  const key = arg("key");
  if (!/^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(key || "")) fail("--key ed25519:... (the PUBLIC key the server printed with: node witty_bot.mjs --trial-key)");
  if (!(await minterOf())) fail(`the minter isn't on ${owner} yet (--step deploy first)`);
  const keys = await keysOf(owner), have = keys.find((k) => k.public_key === key);
  if (have?.access_key?.permission === "FullAccess") fail("that's a full-access key: not touching it");
  const had = have?.access_key?.permission?.FunctionCall;
  if (had && had.receiver_id === owner && had.method_names.join() === METHODS.join()) fail(`that key can already call ${METHODS.join(" and ")}: nothing to do`);
  console.log(`  server key : ${key}${had ? ` (there now, for ${had.method_names.join(", ")}: it gets today's methods)` : ""}`);
  console.log(`  allowed    : call ${owner}.${METHODS.join(` and ${owner}.`)} only · no NEAR attached · up to ${ALLOWANCE} of gas in all`);
  if (!send) preview();
  await confirm(owner);
  let tx = near.transaction(owner);
  if (had) tx = tx.deleteKey(owner, key);
  await tx.addKey(key, { type: "functionCall", receiverId: owner, methodNames: METHODS, allowance: ALLOWANCE }).send();
  const k = (await keysOf(owner)).find((x) => x.public_key === key);
  const fc = k?.access_key?.permission?.FunctionCall;
  report({ "the key is on the account": !!k, [`it can only call ${owner}.${METHODS.join(` and .`)}`]: fc?.receiver_id === owner && fc?.method_names?.join() === METHODS.join(), "it is not a full-access key": k?.access_key?.permission !== "FullAccess" });
}

if (step === "test-mint") {
  const to = arg("to");
  if (!to) fail("--to ACCOUNT (an account that has never held a pass)");
  const trialStore = new FileKeyStore(join(homedir(), ".near-credentials-trial"), network);
  if (!(await trialStore.get(owner))) fail(`no trial key for ${owner} in ~/.near-credentials-trial/${network}/ (make one: node witty-bot/witty_bot.mjs --trial-key, with WITTY_NETWORK=${network} WITTY_OWNER=${owner})`);
  const m = await minterOf();
  if (!m) fail("the minter isn't deployed yet");
  console.log(`  minting    : one free 7-day pass to ${to}, signed with the limited trial key (${m.remaining} left)`);
  if (!send) preview();
  const tnear = new Near({ network: { networkId: network, rpcUrl }, keyStore: trialStore, defaultSignerId: owner, defaultWaitUntil: "FINAL" });
  const p = returned(await tnear.call(owner, "trial_mint", { receiver_id: to }, { gas: "100 Tgas" }));
  console.log(`  got        : ${JSON.stringify(p)}`);
  let blocked = false;   // a harmless call the trial key must not be able to make (it would change nothing if it could)
  try { await tnear.call(pass, "nft_total_supply", {}, { gas: "10 Tgas" }); } catch { blocked = true; }
  report({ [`pass #${p?.token_id} minted to ${to}, free, 7 days`]: p?.owner_id === to && p?.comp === true, "the trial key can't call anything else (a call to the pass contract was refused)": blocked });
}

if (step === "test-level") {
  if (network !== "testnet") fail("test-level is for testnet only: on mainnet the level comes from Witty's public record");
  const level = Number(arg("level"));
  if (![0, 1, 2].includes(level)) fail("--level 0, 1 or 2");
  const trialStore = new FileKeyStore(join(homedir(), ".near-credentials-trial"), network);
  if (!(await trialStore.get(owner))) fail(`no trial key for ${owner} in ~/.near-credentials-trial/${network}/`);
  const scouts = `scouts.${owner}`;
  const [s0, l0] = [await view(scouts, "get_scout", { scout_id: "witty" }), await view(pass, "get_listing", { scout_id: "witty" })];
  console.log(`  level now  : NFTs ${s0.level} (${s0.level_name}) · passes ${l0.level} (${l0.level_name}) -> ${level}`);
  if (!send) preview();
  const tnear = new Near({ network: { networkId: network, rpcUrl }, keyStore: trialStore, defaultSignerId: owner, defaultWaitUntil: "FINAL" });
  await tnear.call(owner, "record_level", { level, inputs: JSON.stringify({ rules: "levels-1", test: true, at: new Date().toISOString().slice(0, 10) }) }, { gas: "60 Tgas" });
  const [s1, l1] = [await view(scouts, "get_scout", { scout_id: "witty" }), await view(pass, "get_listing", { scout_id: "witty" })];
  const nft = await view(scouts, "nft_token", { token_id: "witty-1" }).catch(() => null);
  console.log(`  level now  : NFTs ${s1.level} (${s1.level_name}) · passes ${l1.level} (${l1.level_name}) · witty-1's picture ${nft?.metadata?.media || "?"}`);
  report({ [`the NFTs are at level ${level}`]: s1.level === level, [`the passes are at level ${level}`]: l1.level === level, "the inputs are on chain": /levels-1/.test(s1.level_inputs || "") });
}

if (step === "set-cap") {
  const cap = Number(arg("cap"));
  if (!(cap >= 0 && cap <= 100000)) fail("--cap N (0 to 100000)");
  const m = await minterOf();
  if (!m) fail("the minter isn't deployed yet");
  console.log(`  cap        : ${m.remaining} left now -> ${cap}`);
  if (!send) preview();
  await confirm(owner);
  await near.call(owner, "set_remaining", { remaining: cap }, { gas: "30 Tgas", attachedDeposit: 1n });
  report({ [`${cap} trial passes may be minted`]: (await minterOf()).remaining === cap });
}
