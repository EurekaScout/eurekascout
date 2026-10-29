// Deploys EurekaScout's sealing contract LOCKED, in ONE transaction:
// create the contract account, fund it, deploy the code and initialise it, with NO access key.
// Nobody (including us) can ever change the code. The owner account can still seal, reveal and
// set the reveal window, because those are contract methods, not keys.
//
// Step 1, preview (checks everything, sends nothing):
//   node scripts/deploy-receipts.mjs --network testnet --owner eurekascout.testnet --name locked.eurekascout.testnet
// Step 2, deploy: add --yes (on mainnet it also asks you to type the contract name).
//
// Options:
//   --network testnet|mainnet   (required)
//   --owner   ACCOUNT           pays for the deploy and becomes the contract owner (its key must be in ~/.near-credentials)
//   --name    ACCOUNT           the new contract account, a sub-account of --owner
//   --fund    "2.5 NEAR"        sent to the contract: code storage plus room for calls (default 2.5 NEAR)
//   --wasm    PATH              default contracts/witty/target/near/witty.wasm
//   --rpc     URL               optional, if the default RPC is slow or down
//   --yes                       actually send the transaction

import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { Near } from "near-kit";
import { FileKeyStore } from "near-kit/keys/file";

const OFFICIAL_START_NS = "1793491200000000000"; // 1 Nov 2026 00:00 UTC
const REVEAL_WINDOW_NS = "172800000000000"; // 48 hours
const YOCTO_PER_BYTE = 10n ** 19n; // NEAR storage staking: 1 NEAR per 100 KB
const YOCTO_PER_NEAR = 10n ** 24n;
const GAS = "30 Tgas";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);
const fail = (msg) => {
  console.error(`\n  STOP: ${msg}\n`);
  process.exit(1);
};

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(bytes) {
  let n = BigInt("0x" + Buffer.from(bytes).toString("hex"));
  let out = "";
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}
const near2yocto = (text) => {
  const m = /^\s*(\d+(?:\.\d+)?)\s*NEAR\s*$/i.exec(text);
  if (!m) fail(`--fund must look like "2.5 NEAR" (got "${text}")`);
  const [whole, frac = ""] = m[1].split(".");
  return BigInt(whole) * YOCTO_PER_NEAR + BigInt((frac + "0".repeat(24)).slice(0, 24));
};
const fmt = (yocto) => (Number(yocto / 10n ** 20n) / 10_000).toFixed(4) + " NEAR";

const network = arg("network");
const owner = arg("owner");
const name = arg("name");
const fund = arg("fund", "2.5 NEAR");
const wasmPath = arg("wasm", "contracts/witty/target/near/witty.wasm");
const rpc = arg("rpc");
const send = flag("yes");

if (!["testnet", "mainnet"].includes(network)) fail("--network must be testnet or mainnet");
if (!owner || !name) fail("--owner and --name are required");
if (!name.endsWith(`.${owner}`)) fail(`${name} must be a sub-account of ${owner} (end with .${owner})`);
if (!existsSync(wasmPath)) fail(`no contract file at ${wasmPath} - run: cd contracts/witty && cargo near build non-reproducible-wasm`);

const code = new Uint8Array(readFileSync(wasmPath));
const sha = createHash("sha256").update(code).digest();
const codeHash = base58(sha);
const fundYocto = near2yocto(fund);
const codeStorage = BigInt(code.length) * YOCTO_PER_BYTE;

const keyStore = new FileKeyStore(join(homedir(), ".near-credentials"), network);
const near = new Near({
  network: rpc ? { networkId: network, rpcUrl: rpc } : network,
  keyStore,
  defaultSignerId: owner,
  defaultWaitUntil: "FINAL",
});
const explorer = network === "mainnet" ? "https://nearblocks.io" : "https://testnet.nearblocks.io";

console.log(`\nEurekaScout sealing contract - ${send ? "DEPLOY" : "preview (nothing is sent)"} on ${network}`);
console.log(`  contract account : ${name}  (new, no keys = locked)`);
console.log(`  owner            : ${owner}`);
console.log(`  code             : ${wasmPath}, ${(code.length / 1024).toFixed(1)} KB`);
console.log(`  code sha256      : ${sha.toString("hex")}`);
console.log(`  code hash (NEAR) : ${codeHash}`);
console.log(`  settings         : official_start 1 Nov 2026 00:00 UTC, reveal window 48 h`);
console.log(`  funding          : ${fmt(fundYocto)} (code storage needs about ${fmt(codeStorage)})`);

// ---- checks ----
if (!(await keyStore.get(owner))) fail(`no key for ${owner} in ~/.near-credentials/${network}/`);
if (fundYocto < codeStorage + YOCTO_PER_NEAR / 2n)
  fail(`fund at least ${fmt(codeStorage + YOCTO_PER_NEAR / 2n)}: code storage plus 0.5 NEAR for calls`);
if (await near.accountExists(name)) fail(`${name} already exists - pick another name`);
const ownerState = await near.getAccount(owner);
const available = near2yocto(`${ownerState.available} NEAR`);
console.log(`  ${owner} can spend : ${fmt(available)}`);
if (available < fundYocto + YOCTO_PER_NEAR / 20n) fail(`${owner} needs ${fmt(fundYocto)} plus about 0.05 NEAR for fees`);
console.log("  checks           : all passed");

if (!send) {
  console.log(`\nPreview only. To deploy, run the same command with --yes at the end.\n`);
  process.exit(0);
}

if (network === "mainnet") {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const typed = (await rl.question(`\nThis is permanent. Type the contract name to deploy (${name}): `)).trim();
  rl.close();
  if (typed !== name) fail("name didn't match - nothing was sent");
}

// ---- deploy: one transaction, no key added ----
console.log("\nSending...");
const result = await near
  .transaction(owner)
  .createAccount(name)
  .transfer(name, fund)
  .deployContract(name, code)
  .functionCall(name, "new", { owner, official_start: OFFICIAL_START_NS, reveal_window: REVEAL_WINDOW_NS }, { gas: GAS })
  .send();
const tx = result?.transaction?.hash ?? result?.transaction_outcome?.id ?? "(see the account page)";
console.log(`  transaction      : ${tx}`);

// ---- verify on chain ----
const config = await near.view(name, "get_config", {});
const keys = await near.getAccessKeys(name);
const account = await near.getAccount(name);
const ok = {
  "owner is right": config.owner === owner,
  "48 h reveal window": config.reveal_window === REVEAL_WINDOW_NS,
  "starts 1 Nov 00:00 UTC": config.official_start === OFFICIAL_START_NS,
  "version 1.0.0": config.version === "1.0.0",
  "no keys (locked)": keys.keys.length === 0,
  "on-chain code = this file": account.codeHash === codeHash,
};
console.log("\nChecks on chain:");
for (const [label, pass] of Object.entries(ok)) console.log(`  ${pass ? "PASS" : "FAIL"}  ${label}`);
console.log(`\n  contract : ${explorer}/address/${name}`);
console.log(`  tx       : ${explorer}/txns/${tx}\n`);
process.exit(Object.values(ok).every(Boolean) ? 0 : 1);
