// Integration tests for the Witty NFTs, Rental Passes and Witty's own account, on a local NEAR node
// (near-kit Sandbox). Run from the repo root after building the three contracts:
//   npm run test:nft
//
// What this proves on a real node, beyond the Rust unit tests: cross-contract calls, refunds and
// callbacks really happen, the money really moves between accounts, and nothing is ever locked
// with a key. Each test follows the threat model's list for Thu 5 Nov.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Near, generateKey } from "near-kit";
import { Sandbox } from "near-kit/sandbox";

const wasm = (name) => new Uint8Array(readFileSync(new URL(`../contracts/${name}/target/near/witty_${name}.wasm`, import.meta.url)));
const SCOUTS_WASM = wasm("scouts");
const PASS_WASM = wasm("pass");
const VAULT_WASM = wasm("vault");

const NEAR = 10n ** 24n;
const MILLI = NEAR / 1000n;
const BYTE = 10n ** 19n;
const DAY_NS = 86_400_000_000_000n;
const GAS = "300 Tgas";
const ONE_YOCTO = 1n;
const LATEST = { finality: "optimistic" };

let sandbox, near, root, scouts, pass, vault;
const u = {}; // users: { id, near }

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
const sha = (bytes) => createHash("sha256").update(bytes).digest();

/** Raw balance in yoctoNEAR. */
const balance = async (id) => BigInt((await near.rpc.getAccount(id, LATEST)).amount);
/** Balance not locked for storage, in yoctoNEAR. */
async function freeBalance(id) {
  const a = await near.rpc.getAccount(id, LATEST);
  return BigInt(a.amount) - BigInt(a.storage_usage) * BYTE;
}
const view = (contract, method, args = {}) => near.view(contract, method, args, LATEST);
const scout = () => view(scouts, "get_scout", { scout_id: "witty" });
const claimable = async (token_id) => BigInt((await view(scouts, "edition_info", { token_id })).claimable);
const fmt = (y) => `${(Number(y) / 1e24).toFixed(6)} NEAR`;

/** A new account with its own full-access key and NEAR. */
async function makeUser(name, amount = 100n * NEAR) {
  const id = `${name}.${root}`;
  const key = generateKey();
  await near.transaction(root).createAccount(id).transfer(id, amount).addKey(key.publicKey.toString(), { type: "fullAccess" }).send();
  return { id, key };
}
/** The value a transaction's last call returned (JSON), or null. */
function returned(outcome) {
  const v = outcome?.status?.SuccessValue;
  if (!v) return null;
  const text = Buffer.from(v, "base64").toString("utf8");
  return text ? JSON.parse(text) : null;
}
/** A call signed by one of the test users. Throws with the contract's message if it fails. */
const call = async (who, contract, method, args, deposit = 0n) =>
  returned(await near.transaction(who.id).signWith(who.key.secretKey).functionCall(contract, method, args, { gas: GAS, attachedDeposit: deposit }).send());
const sendNear = (who, to, amount) => near.transaction(who.id).signWith(who.key.secretKey).transfer(to, amount).send();
// near.call returns the whole transaction outcome; returned() gives the value the method returned
const asOwner = async (contract, method, args, deposit = 0n) =>
  returned(await near.call(contract, method, args, { gas: GAS, attachedDeposit: deposit }));

/** Gas a single transaction can burn here; a balance change within this is "nothing but gas". */
const GAS_SLACK = 30n * MILLI;

before(async () => {
  sandbox = await Sandbox.start({ detached: false });
  root = sandbox.rootAccount.id;
  near = new Near({ network: sandbox, defaultSignerId: root, defaultWaitUntil: "FINAL" });
  scouts = `scouts.${root}`;
  pass = `pass.${root}`;
  vault = `witty.${scouts}`;

  // The two contracts, each in ONE transaction with no key added: locked from birth.
  await near
    .transaction(root)
    .createAccount(scouts)
    .transfer(scouts, 6n * NEAR)
    .deployContract(scouts, SCOUTS_WASM)
    .functionCall(scouts, "new", {
      owner_id: root,
      platform_id: root,
      recorder_id: root,
      vault_code_hash: base58(sha(VAULT_WASM)),
      metadata: { spec: "nft-1.0.0", name: "Witty the Scout", symbol: "WITTY" },
      rent_sources: [pass],
    }, { gas: GAS })
    .send();
  await near
    .transaction(root)
    .createAccount(pass)
    .transfer(pass, 5n * NEAR)
    .deployContract(pass, PASS_WASM)
    .functionCall(pass, "new", {
      owner_id: root,
      scouts_contract: scouts,
      recorder_id: root,
      metadata: { spec: "nft-1.0.0", name: "Witty Rental Pass", symbol: "WPASS" },
      min_price: (MILLI * 500n).toString(),
      levels: [
        { name: "Rookie", max_7d: (4n * NEAR).toString(), max_30d: (12n * NEAR).toString() },
        { name: "Analyst", max_7d: (6n * NEAR).toString(), max_30d: (18n * NEAR).toString() },
        { name: "Elite", max_7d: (10n * NEAR).toString(), max_30d: (30n * NEAR).toString() },
      ],
    }, { gas: GAS })
    .send();

  for (const name of ["alice", "bob", "carol", "dave", "ops", "api", "market", "founder", "stranger"]) u[name] = await makeUser(name);

  // Create Witty: his own account (no keys) and his collection of 100, closed for minting.
  await asOwner(scouts, "create_scout", {
    scout: {
      scout_id: "witty",
      name: "Witty the Scout",
      media: "https://eurekascout.com/img/nft-rookie.webp",
      holder_bps: 7000, bills_bps: 1000, platform_bps: 2000,
      max_supply: 100,
      mint_price: (2n * NEAR).toString(),
      mint_price_min: NEAR.toString(),
      levels: [
        { name: "Rookie", max_price: (200n * NEAR).toString(), media: "https://eurekascout.com/img/nft-rookie.webp" },
        { name: "Analyst", max_price: (300n * NEAR).toString(), media: "https://eurekascout.com/img/nft-analyst.webp" },
        { name: "Elite", max_price: (500n * NEAR).toString(), media: "https://eurekascout.com/img/nft-elite.webp" },
      ],
      bills_cap: (2n * NEAR).toString(),
      payees: [u.api.id],
      operator_id: u.ops.id,
    },
    vault_code: Buffer.from(VAULT_WASM).toString("base64"),
  }, BigInt(VAULT_WASM.length + 2000) * BYTE);

  // Witty's passes on sale: the 7-day Bronze Pass for 1 NEAR, the 30-day Silver Pass for 3 NEAR.
  await asOwner(pass, "add_scout", {
    scout_id: "witty", name: "Witty",
    tier_7d: { name: "Bronze", media: "https://eurekascout.com/img/pass-bronze.webp" },
    tier_30d: { name: "Silver", media: "https://eurekascout.com/img/pass-silver.webp" },
    price_7d: NEAR.toString(), price_30d: (3n * NEAR).toString(),
  }, ONE_YOCTO);
});

after(async () => {
  if (sandbox) await sandbox.stop();
});

// ---------- Locked ----------

test("all three accounts are locked: no keys at all", async () => {
  for (const id of [scouts, pass, vault]) {
    const keys = await near.getAccessKeys(id);
    assert.equal(keys.keys.length, 0, `${id} should have no keys`);
  }
});

test("Witty's account runs exactly the vault code the scouts contract pins", async () => {
  const cfg = await view(scouts, "get_config");
  const acct = await near.getAccount(vault);
  assert.equal(cfg.vault_code_hash, base58(sha(VAULT_WASM)));
  assert.equal(acct.codeHash, cfg.vault_code_hash);
  const s = await scout();
  assert.equal(s.ready, true);
  assert.equal(s.vault_id, vault);
  assert.deepEqual([s.split.holder_bps, s.split.bills_bps, s.split.platform_bps], [7000, 1000, 2000]);
});

test("nobody but the scouts contract can move NEAR out of Witty's account", async () => {
  await assert.rejects(call(u.stranger, vault, "send", { receiver_id: u.stranger.id, amount: NEAR.toString() }),
    /Only the scouts contract can move this account's NEAR/);
  await assert.rejects(asOwner(vault, "send", { receiver_id: root, amount: NEAR.toString() }),
    /Only the scouts contract can move this account's NEAR/);
});

// ---------- Before the first NFT ----------

test("before the first NFT, a pass is refunded in full and no pass is made", async () => {
  const listing = await view(pass, "get_listing", { scout_id: "witty" });
  const before = await balance(u.bob.id);
  const r = await call(u.bob, pass, "buy_pass", { scout_id: "witty", days: 7 }, BigInt(listing.attach_7d));
  assert.equal(r ?? null, null);
  const spent = before - (await balance(u.bob.id));
  assert.ok(spent < GAS_SLACK, `bob should only pay gas, paid ${fmt(spent)}`);
  assert.equal((await view(pass, "nft_total_supply")), "0");
  assert.equal((await view(pass, "get_listing", { scout_id: "witty" })).rent_total, "0");
});

test("nobody mints until minting opens", async () => {
  const s = await scout();
  await assert.rejects(call(u.alice, scouts, "mint", { scout_id: "witty" }, BigInt(s.attach_to_mint)), /Minting isn't open/);
});

// ---------- Minting ----------

test("anyone mints once it opens, and the mint money goes to Witty's account, not to holders", async () => {
  await asOwner(scouts, "set_mint_open", { scout_id: "witty", open: true }, ONE_YOCTO);
  const s0 = await scout();
  const vault0 = await balance(vault);
  const e = await call(u.alice, scouts, "mint", { scout_id: "witty" }, BigInt(s0.attach_to_mint));
  assert.equal(e.token_id, "witty-1");
  assert.equal(e.owner_id, u.alice.id);
  assert.equal((await balance(vault)) - vault0, 2n * NEAR, "the full mint price lands in Witty's account");
  const s = await scout();
  assert.equal(s.minted, 1);
  assert.equal(BigInt(s.holder_pool), 0n);
  assert.equal(BigInt(s.bills_balance) + BigInt(s.platform_balance), 2n * NEAR);
  assert.equal(BigInt(s.bills_balance), 2n * NEAR / 3n);
});

// ---------- Rent ----------

test("a pass pays its rent into Witty's account, 70% to holders, 10% bills, 20% platform", async () => {
  const s0 = await scout();
  const vault0 = await balance(vault);
  const listing = await view(pass, "get_listing", { scout_id: "witty" });
  const p = await call(u.bob, pass, "buy_pass", { scout_id: "witty", days: 7 }, BigInt(listing.attach_7d));
  assert.equal(p.owner_id, u.bob.id);
  assert.equal(p.active, true);
  assert.equal(p.comp, false);
  assert.equal(p.tier, "Bronze");
  const t = await view(pass, "nft_token", { token_id: p.token_id });
  assert.equal(t.metadata.title, `Witty Bronze Pass #${p.token_id}`);
  assert.equal(t.metadata.media, "https://eurekascout.com/img/pass-bronze.webp");
  assert.equal((await balance(vault)) - vault0, NEAR, "the rent lands in Witty's account");
  const s = await scout();
  assert.equal(BigInt(s.holder_pool) - BigInt(s0.holder_pool), 7n * NEAR / 10n);
  assert.equal(BigInt(s.bills_balance) - BigInt(s0.bills_balance), NEAR / 10n);
  assert.equal(BigInt(s.platform_balance) - BigInt(s0.platform_balance), 2n * NEAR / 10n);
  assert.equal(await claimable("witty-1"), 7n * NEAR / 10n);
  assert.equal(await view(pass, "is_active", { account_id: u.bob.id, scout_id: "witty" }), true);
  const l = await view(pass, "get_listing", { scout_id: "witty" });
  assert.equal(l.paid_passes, "1");
  assert.equal(BigInt(l.rent_total), NEAR);
});

test("the bot's views give the OutLayer check exactly the fields it reads", async () => {
  const nft = await view(scouts, "access", { account_id: u.alice.id, scout_id: "witty" });
  assert.equal(typeof nft.token_id, "string");
  assert.equal(typeof nft.owner_id, "string");
  assert.equal(typeof nft.scout_id, "string");
  assert.equal(typeof nft.number, "number");
  const p = await view(pass, "active_pass", { account_id: u.bob.id, scout_id: "witty" });
  for (const k of ["token_id", "owner_id", "scout_id", "expires_at"]) assert.equal(typeof p[k], "string", k);
  assert.equal(typeof p.active, "boolean");
  assert.equal(await view(scouts, "access", { account_id: u.stranger.id, scout_id: "witty" }) ?? null, null);
  assert.equal(await view(pass, "active_pass", { account_id: u.stranger.id, scout_id: "witty" }) ?? null, null);
});

// ---------- Claims ----------

test("a holder claims their share, and the claim cancels a live listing", async () => {
  await call(u.alice, scouts, "nft_approve", { token_id: "witty-1", account_id: u.market.id }, 10n * MILLI);
  assert.equal(await view(scouts, "nft_is_approved", { token_id: "witty-1", approved_account_id: u.market.id }), true);
  const before = await balance(u.alice.id);
  await call(u.alice, scouts, "claim", { token_ids: ["witty-1"] }, ONE_YOCTO);
  const got = (await balance(u.alice.id)) - before;
  assert.ok(got > 7n * NEAR / 10n - GAS_SLACK && got <= 7n * NEAR / 10n + 10n * MILLI, `alice got ${fmt(got)}`);
  assert.equal(await claimable("witty-1"), 0n);
  assert.equal(await view(scouts, "nft_is_approved", { token_id: "witty-1", approved_account_id: u.market.id }), false);
  const s = await scout();
  assert.equal(BigInt(s.holders_paid), 7n * NEAR / 10n);
  assert.equal(BigInt(s.in_flight), 0n);
});

test("Witty changes hands: access and the unclaimed share go with the NFT", async () => {
  const listing = await view(pass, "get_listing", { scout_id: "witty" });
  const silver = await call(u.bob, pass, "buy_pass", { scout_id: "witty", days: 30 }, BigInt(listing.attach_30d));
  assert.equal(silver.tier, "Silver");
  assert.equal((await view(pass, "nft_token", { token_id: silver.token_id })).metadata.title, `Witty Silver Pass #${silver.token_id}`);
  assert.equal(await claimable("witty-1"), 21n * NEAR / 10n);
  await call(u.alice, scouts, "nft_transfer", { receiver_id: u.carol.id, token_id: "witty-1" }, ONE_YOCTO);
  assert.equal(await view(scouts, "access", { account_id: u.alice.id, scout_id: "witty" }) ?? null, null);
  assert.equal((await view(scouts, "access", { account_id: u.carol.id, scout_id: "witty" })).token_id, "witty-1");
  await assert.rejects(call(u.alice, scouts, "claim", { token_ids: ["witty-1"] }, ONE_YOCTO), /You can only claim for NFTs you hold/);
  const before = await balance(u.carol.id);
  await call(u.carol, scouts, "claim", { token_ids: ["witty-1"] }, ONE_YOCTO);
  const got = (await balance(u.carol.id)) - before;
  assert.ok(got > 21n * NEAR / 10n - GAS_SLACK, `carol got ${fmt(got)}`);
});

test("a new NFT shares only in rent paid after it's minted", async () => {
  const s0 = await scout();
  await call(u.dave, scouts, "mint", { scout_id: "witty" }, BigInt(s0.attach_to_mint));
  assert.equal(await claimable("witty-2"), 0n);
  const c1 = await claimable("witty-1");
  const listing = await view(pass, "get_listing", { scout_id: "witty" });
  await call(u.dave, pass, "buy_pass", { scout_id: "witty", days: 7 }, BigInt(listing.attach_7d));
  assert.equal(await claimable("witty-2"), 35n * NEAR / 100n);
  assert.equal((await claimable("witty-1")) - c1, 35n * NEAR / 100n);
});

// ---------- Passes ----------

test("renewing adds 7 days to the same pass and pays rent again", async () => {
  const before = await view(pass, "pass_info", { token_id: "1" });
  const supply = await view(pass, "nft_total_supply");
  const listing = await view(pass, "get_listing", { scout_id: "witty" });
  const p = await call(u.bob, pass, "renew", { token_id: "1", days: 7 }, BigInt(listing.price_7d));
  assert.equal(BigInt(p.expires_at) - BigInt(before.expires_at), 7n * DAY_NS);
  assert.equal(await view(pass, "nft_total_supply"), supply);
  assert.equal((await view(pass, "get_listing", { scout_id: "witty" })).renewals, "1");
});

test("a free founding pass is marked as free and pays no rent", async () => {
  const s0 = await scout();
  const p = await asOwner(pass, "mint_comp", { scout_id: "witty", receiver_id: u.founder.id, days: 7 }, 15n * MILLI);
  assert.equal(p.comp, true);
  assert.equal(p.paid_total, "0");
  assert.equal((await scout()).holder_pool, s0.holder_pool);
  const l = await view(pass, "get_listing", { scout_id: "witty" });
  assert.equal(l.comp_passes, "1");
  assert.equal(await view(pass, "is_active", { account_id: u.founder.id, scout_id: "witty" }), true);
  await assert.rejects(call(u.stranger, pass, "mint_comp", { scout_id: "witty", receiver_id: u.stranger.id, days: 30 }, 15n * MILLI), /Owner only/);
});

test("a pass that changes hands gives access to its new holder only", async () => {
  const p = await view(pass, "active_pass", { account_id: u.founder.id, scout_id: "witty" });
  await call(u.founder, pass, "nft_transfer", { receiver_id: u.stranger.id, token_id: p.token_id }, ONE_YOCTO);
  assert.equal(await view(pass, "is_active", { account_id: u.founder.id, scout_id: "witty" }), false);
  assert.equal(await view(pass, "is_active", { account_id: u.stranger.id, scout_id: "witty" }), true);
});

test("rent for a scout that doesn't exist is refunded in full", async () => {
  await asOwner(pass, "add_scout", {
    scout_id: "ghost", name: "Ghost", tier_7d: { name: "Bronze" }, tier_30d: { name: "Silver" },
    price_7d: NEAR.toString(), price_30d: (3n * NEAR).toString(),
  }, ONE_YOCTO);
  const supply = await view(pass, "nft_total_supply");
  const before = await balance(u.bob.id);
  const r = await call(u.bob, pass, "buy_pass", { scout_id: "ghost", days: 7 }, NEAR + 15n * MILLI);
  assert.equal(r ?? null, null);
  assert.ok(before - (await balance(u.bob.id)) < GAS_SLACK, "bob should only pay gas");
  assert.equal(await view(pass, "nft_total_supply"), supply);
  assert.equal((await view(pass, "get_config")).total_owed, "0");
});

// ---------- Bills and fees ----------

test("Witty pays an API bill within his cap; other bills are refused", async () => {
  const before = await balance(u.api.id);
  const s0 = await scout();
  await call(u.ops, scouts, "pay_bill", { scout_id: "witty", payee_id: u.api.id, amount: (NEAR / 2n).toString(), memo: "data API, Nov" });
  assert.equal((await balance(u.api.id)) - before, NEAR / 2n, "the provider gets exactly the bill");
  const s = await scout();
  assert.equal(BigInt(s0.bills_balance) - BigInt(s.bills_balance), NEAR / 2n);
  assert.equal(s.holder_pool, s0.holder_pool, "holders' shares are untouched");
  assert.equal(BigInt(s.bills_spent_30d), NEAR / 2n);
  await assert.rejects(call(u.ops, scouts, "pay_bill", { scout_id: "witty", payee_id: u.ops.id, amount: MILLI.toString(), memo: "to myself" }),
    /That payee isn't on the scout's list/);
  await assert.rejects(call(u.stranger, scouts, "pay_bill", { scout_id: "witty", payee_id: u.api.id, amount: MILLI.toString(), memo: "x" }),
    /Only the scout's operator can pay its bills/);
  // Lower the cap to 1 NEAR: with 0.5 spent, a 0.6 bill is over it.
  await asOwner(scouts, "set_bills_cap", { scout_id: "witty", bills_cap: NEAR.toString() }, ONE_YOCTO);
  await assert.rejects(call(u.ops, scouts, "pay_bill", { scout_id: "witty", payee_id: u.api.id, amount: (6n * NEAR / 10n).toString(), memo: "x" }),
    /over the scout's bills cap/);
  await assert.rejects(asOwner(scouts, "set_bills_cap", { scout_id: "witty", bills_cap: (3n * NEAR).toString() }, ONE_YOCTO),
    /can't go above its maximum/);
});

test("only the platform account claims the platform fee, to itself", async () => {
  await assert.rejects(call(u.stranger, scouts, "claim_platform_fee", { scout_id: "witty" }, ONE_YOCTO),
    /Only the platform account can claim the platform fee/);
  const fee = BigInt((await scout()).platform_balance);
  const before = await balance(root);
  await asOwner(scouts, "claim_platform_fee", { scout_id: "witty" }, ONE_YOCTO);
  const got = (await balance(root)) - before;
  assert.ok(got > fee - GAS_SLACK && got <= fee, `the platform got ${fmt(got)} of ${fmt(fee)}`);
  assert.equal((await scout()).platform_balance, "0");
});

// ---------- Tips and the books ----------

test("a tip sent straight to Witty's account is booked and shared", async () => {
  const s0 = await scout();
  await sendNear(u.stranger, vault, NEAR);
  const booked = BigInt(await call(u.stranger, scouts, "sync_vault", { scout_id: "witty" }));
  assert.ok(booked >= NEAR && booked < NEAR + 50n * MILLI, `sync booked ${fmt(booked)}`);
  const s = await scout();
  assert.equal(BigInt(s.other_total) - BigInt(s0.other_total), booked);
  const again = BigInt(await call(u.stranger, scouts, "sync_vault", { scout_id: "witty" }));
  assert.equal(again, 0n, "a second sync books nothing new");
});

test("the books never claim more than Witty's account holds", async () => {
  const s = await scout();
  const books = BigInt(s.holder_pool) + BigInt(s.bills_balance) + BigInt(s.platform_balance);
  const free = await freeBalance(vault);
  assert.ok(free >= books, `Witty's account holds ${fmt(free)} for ${fmt(books)} on the books`);
  // and what holders are owed is exactly the NFTs' shares plus rounding dust
  const shares = (await claimable("witty-1")) + (await claimable("witty-2"));
  assert.equal(shares + BigInt(s.undistributed), BigInt(s.holder_pool));
});

// ---------- Levels and transfers ----------

test("the record sets the price ceiling, and only the recorder sets the level", async () => {
  const pic = async () => {
    const t = await view(scouts, "nft_token", { token_id: "witty-1" });
    return { media: t.metadata.media, level: JSON.parse(t.metadata.extra).level };
  };
  assert.deepEqual(await pic(), { media: "https://eurekascout.com/img/nft-rookie.webp", level: "Rookie" });
  await assert.rejects(asOwner(scouts, "set_mint_price", { scout_id: "witty", mint_price: (250n * NEAR).toString() }, ONE_YOCTO),
    /cap for the scout's level/);
  await assert.rejects(call(u.stranger, scouts, "set_level", { scout_id: "witty", level: 2, inputs: "trust me" }), /Only the recorder sets levels/);
  await asOwner(scouts, "set_level", { scout_id: "witty", level: 1, inputs: "sandbox: 60 calls, 1.21x per $1 after fees" });
  await asOwner(scouts, "set_mint_price", { scout_id: "witty", mint_price: (250n * NEAR).toString() }, ONE_YOCTO);
  const s = await scout();
  assert.equal(s.level_name, "Analyst");
  assert.equal(BigInt(s.mint_price), 250n * NEAR);
  // every NFT now shows the Analyst picture, in every view wallets use, without anyone touching the NFTs
  assert.deepEqual(await pic(), { media: "https://eurekascout.com/img/nft-analyst.webp", level: "Analyst" });
  const all = await view(scouts, "nft_tokens", {});
  assert.ok(all.length >= 1 && all.every((t) => t.metadata.media.endsWith("nft-analyst.webp")));
  // back to Rookie: the price is held to the Rookie cap at once
  await asOwner(scouts, "set_level", { scout_id: "witty", level: 0, inputs: "sandbox: recomputed" });
  assert.equal(BigInt((await scout()).mint_price), 200n * NEAR);
  assert.deepEqual(await pic(), { media: "https://eurekascout.com/img/nft-rookie.webp", level: "Rookie" });
});

test("an NFT can't be sent to Witty's own account", async () => {
  await assert.rejects(call(u.carol, scouts, "nft_transfer", { receiver_id: vault, token_id: "witty-1" }, ONE_YOCTO),
    /Can't send a scout NFT to this contract or a scout's account/);
});
