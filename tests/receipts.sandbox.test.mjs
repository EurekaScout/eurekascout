// Integration tests for the sealing contract on a local NEAR node (near-kit Sandbox).
// Run from the repo root after building the contract:
//   npm run test:sandbox
//
// What this proves on a real node, beyond the Rust unit tests:
// - the contract deploys and initialises on an account with no keys (locked from birth)
// - seal, reveal, rejection of edited JSON and the owner-only rule all work end to end
// - fast-forwarding blocks moves block time, so a call really expires after its window

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { Near, generateKey } from "near-kit";
import { Sandbox } from "near-kit/sandbox";

const WASM = new URL("../contracts/witty/target/near/witty.wasm", import.meta.url);
const NS_PER_SECOND = 1_000_000_000n;
// 10 minutes: long enough that real time can't explain an expiry during the
// test, so if a call expires it is because fast-forward moved block time.
const WINDOW_SECONDS = 600n;
const GAS = "30 Tgas";
// Read the newest block instead of the last final one (used after fast-forwarding).
const LATEST = { finality: "optimistic" };

let sandbox;
let near;
let root;
let contract;

// Keys sorted, no spaces: the same form the server will hash before sealing.
const canonical = (obj) =>
  JSON.stringify(Object.fromEntries(Object.keys(obj).sort().map((k) => [k, obj[k]])));
const sha256Hex = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const makeCall = (fields) => canonical({ ...fields, salt: randomBytes(16).toString("hex") });

async function seal(callJson, chain = "solana") {
  const hash = sha256Hex(callJson);
  await near.call(contract, "seal_call", { hash, chain, rules_version: "witty-1.0" }, { gas: GAS });
  const view = await near.view(contract, "get_call_by_hash", { hash });
  assert.ok(view, "sealed call should be readable by its hash");
  return view;
}

async function latestBlockTimeMs() {
  const status = await near.getStatus();
  // Trim nanoseconds to milliseconds so Date.parse reads it reliably.
  return Date.parse(status.sync_info.latest_block_time.replace(/(\.\d{3})\d+/, "$1"));
}

// Transactions are built on the last final block. Right after a fast-forward
// that block lags far behind the new head, and the local node rejects a
// transaction based on it as too old. Wait until finality catches up.
async function waitForFinality(timeoutMs = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const latest = (await near.getStatus()).sync_info.latest_block_height;
    const final = (await near.rpc.getBlock({ finality: "final" })).header.height;
    if (latest - final <= 3) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("final block did not catch up after fast-forward");
}

// Adds the node's error details to a rejection, so a failure says why.
const withDetails = (promise) =>
  promise.catch((e) => {
    throw new Error(`${e.message} ${JSON.stringify(e.details ?? e.data ?? {})}`);
  });

before(async () => {
  sandbox = await Sandbox.start({ detached: false });
  root = sandbox.rootAccount.id;
  // Writes wait until final, because reads use the last final block by default.
  near = new Near({ network: sandbox, defaultSignerId: root, defaultWaitUntil: "FINAL" });
  contract = `receipts.${root}`;

  // One transaction: create, fund, deploy and initialise the contract account.
  // No key is added, so nobody can ever change its code: the mainnet plan.
  await near
    .transaction(root)
    .createAccount(contract)
    .transfer(contract, "5 NEAR")
    .deployContract(contract, new Uint8Array(readFileSync(WASM)))
    .functionCall(
      contract,
      "new",
      {
        owner: root,
        official_start: "0",
        reveal_window: (WINDOW_SECONDS * NS_PER_SECOND).toString(),
      },
      { gas: GAS },
    )
    .send();
});

after(async () => {
  if (sandbox) await sandbox.stop();
});

test("deploys locked, with the right settings", async () => {
  const config = await near.view(contract, "get_config", {});
  assert.equal(config.version, "1.0.0");
  assert.equal(config.owner, root);
  assert.equal(config.reveal_window, (WINDOW_SECONDS * NS_PER_SECOND).toString());

  const keys = await near.getAccessKeys(contract);
  assert.equal(keys.keys.length, 0, "the contract account should have no keys");
});

test("seal then reveal the exact JSON", async () => {
  const callJson = makeCall({ call_type: "test", chain: "solana", token: "SANDBOX1" });
  const sealed = await seal(callJson);
  assert.equal(sealed.status, "sealed");
  assert.equal(sealed.warm_up, false);

  await near.call(contract, "reveal_call", { id: sealed.id, call_json: callJson }, { gas: GAS });
  const revealed = await near.view(contract, "get_call", { id: sealed.id });
  assert.equal(revealed.status, "revealed");
  assert.equal(revealed.call_json, callJson);
});

test("an edited call is rejected", async () => {
  const callJson = makeCall({ call_type: "test", chain: "near", token: "SANDBOX2" });
  const sealed = await seal(callJson, "near");
  const edited = callJson.replace("SANDBOX2", "FAKE");
  await assert.rejects(
    near.call(contract, "reveal_call", { id: sealed.id, call_json: edited }, { gas: GAS }),
    /does not match the sealed hash/,
  );
});

test("a stranger cannot seal", async () => {
  const stranger = `stranger.${root}`;
  const key = generateKey();
  await near
    .transaction(root)
    .createAccount(stranger)
    .transfer(stranger, "1 NEAR")
    .addKey(key.publicKey.toString(), { type: "fullAccess" })
    .send();

  const hash = sha256Hex(makeCall({ call_type: "test", token: "SANDBOX3" }));
  await assert.rejects(
    near
      .transaction(stranger)
      .signWith(key.secretKey)
      .functionCall(contract, "seal_call", { hash, chain: "solana", rules_version: "witty-1.0" }, { gas: GAS })
      .send(),
    /only the owner can do this/,
  );
});

test("an unrevealed call expires once block time passes its deadline", async () => {
  const callJson = makeCall({ call_type: "test", chain: "robinhood", token: "SANDBOX4" });
  const sealed = await seal(callJson, "robinhood");
  assert.equal(sealed.status, "sealed");

  // Measure how much block time one fast-forwarded block adds.
  const before = await latestBlockTimeMs();
  await sandbox.fastForward(200);
  const afterSample = await latestBlockTimeMs();
  const msPerBlock = (afterSample - before) / 200;
  console.log(`fast-forward adds about ${msPerBlock.toFixed(1)} ms of block time per block`);
  assert.ok(msPerBlock > 0, "fast-forward must move block time forward");

  // Jump past the 10-minute window, with 20% to spare.
  const blocksNeeded = Math.ceil((Number(WINDOW_SECONDS) * 1000 * 1.2) / msPerBlock);
  assert.ok(blocksNeeded < 200_000, `would need ${blocksNeeded} blocks; window too long for this test`);
  await sandbox.fastForward(blocksNeeded);
  await waitForFinality();

  const expired = await near.view(contract, "get_call", { id: sealed.id }, LATEST);
  assert.equal(expired.status, "expired");

  await assert.rejects(
    withDetails(near.call(contract, "reveal_call", { id: sealed.id, call_json: callJson }, { gas: GAS })),
    /reveal deadline has passed/,
  );
});

test("the record adds up", async () => {
  // So far: 1 revealed, 2 never revealed (the edited one and the expired one),
  // both now past their deadlines. The stranger's seal never landed.
  const record = await near.view(contract, "get_record", {}, LATEST);
  assert.deepEqual(record, {
    total: "3",
    revealed: "1",
    expired: "2",
    waiting: "0",
    warm_up: "0",
  });
});
