// Deploys and sets up the Witty NFTs, the Rental Pass and Witty's own account, step by step.
// Every step previews first (checks everything, sends nothing); add --yes to send it.
// On mainnet, the permanent steps also ask you to type a name.
//
//   node scripts/deploy-nft.mjs --network testnet --owner eurekascout.testnet --step contracts
//
// Steps, in order:
//   contracts    deploy scouts.<owner> and pass.<owner>, each LOCKED in one transaction (no key ever)
//   pass         deploy only a (new) pass contract, LOCKED, and let it pay rent into the scouts contract
//                (use with --pass NAME when the old pass account is taken)
//   witty        create Witty: his own account witty.scouts.<owner> (no keys) and his 100-NFT collection
//   open-mint    open minting
//   mint-first   mint Witty NFT #1 to the owner, at the public price
//   list-passes  put Witty's Rental Passes on sale
//   comp         a free founding pass: add --to ACCOUNT (and --days 7 or 30, default 7)
//   close-mint   close minting again (e.g. after a quiet test before launch); open-mint reopens it
//   pause-sales  pause pass sales and renewals (passes already sold keep working)
//   open-sales   reopen pass sales after a pause (list-passes is only for the first time)
//   status       read-only: what's on chain now
//
// Options:
//   --network testnet|mainnet  (required)
//   --owner    ACCOUNT  pays, owns both contracts and gets the platform fee (its key in ~/.near-credentials)
//   --recorder ACCOUNT  sets Witty's level (default: the owner)
//   --operator ACCOUNT  pays Witty's bills (default: the owner on testnet, none on mainnet)
//   --payees   A,B      who bills can go to (default: the owner on testnet, none on mainnet)
//   --pass     ACCOUNT  the pass contract (default: pass.<owner> on mainnet; passes.<owner> on testnet, where
//                       pass.eurekascout.testnet holds the first, pre-tiers version)
//   --rpc      URL      optional, if the default RPC is slow or down
//   --yes               actually send

import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { Near } from "near-kit";
import { FileKeyStore } from "near-kit/keys/file";

const NEAR = 10n ** 24n;
const BYTE = 10n ** 19n;
const GAS = "300 Tgas";
const n = (text) => {
  const m = /^\s*(\d+(?:\.\d+)?)\s*NEAR\s*$/i.exec(text);
  if (!m) throw new Error(`bad amount ${text}`);
  const [w, f = ""] = m[1].split(".");
  return BigInt(w) * NEAR + BigInt((f + "0".repeat(24)).slice(0, 24));
};
const fmt = (y) => `${(Number(BigInt(y) / 10n ** 18n) / 1e6).toFixed(4)} NEAR`;

// What each network gets. Mainnet prices are the 4 Nov decisions at NEAR ≈ $3.80.
const PLAN = {
  testnet: {
    fund: { scouts: n("4.5 NEAR"), pass: n("4 NEAR") },
    mint: { price: n("1 NEAR"), min: n("0.5 NEAR") },
    pass: { min: n("0.05 NEAR"), p7: n("0.1 NEAR"), p30: n("0.3 NEAR") },
  },
  mainnet: {
    fund: { scouts: n("4.3 NEAR"), pass: n("3.75 NEAR") },
    mint: { price: n("13 NEAR"), min: n("4 NEAR") },          // about $50; never below about $15
    pass: { min: n("0.5 NEAR"), p7: n("1.3 NEAR"), p30: n("4 NEAR") }, // $5 and $15
  },
};
// Each level's cap and picture are fixed at creation. Every Witty NFT shows the picture of his current level.
const MINT_LEVELS = [["Rookie", "200 NEAR"], ["Analyst", "300 NEAR"], ["Elite", "500 NEAR"]];
const levelPic = (name) => `https://eurekascout.com/img/nft-${name.toLowerCase()}.webp`;
const PASS_LEVELS = [["Rookie", "4 NEAR", "12 NEAR"], ["Analyst", "6 NEAR", "18 NEAR"], ["Elite", "10 NEAR", "30 NEAR"]];
const BILLS_CAP = n("2 NEAR");
const NFT_MEDIA = "https://eurekascout.com/img/nft-rookie.webp";
const TIERS = {
  tier_7d: { name: "Bronze", media: "https://eurekascout.com/img/pass-bronze.webp" },
  tier_30d: { name: "Silver", media: "https://eurekascout.com/img/pass-silver.webp" },
};
const WASM = { scouts: "contracts/scouts/target/near/witty_scouts.wasm", pass: "contracts/pass/target/near/witty_pass.wasm", vault: "contracts/vault/target/near/witty_vault.wasm" };

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
  let v = BigInt("0x" + Buffer.from(bytes).toString("hex"));
  let out = "";
  while (v > 0n) {
    out = ALPHABET[Number(v % 58n)] + out;
    v /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}
const codeHash = (bytes) => base58(createHash("sha256").update(bytes).digest());
const readWasm = (k) => {
  if (!existsSync(WASM[k])) fail(`no ${WASM[k]} - run: cd contracts/${k} && cargo near build non-reproducible-wasm`);
  return new Uint8Array(readFileSync(WASM[k]));
};

const network = arg("network");
const owner = arg("owner");
const step = arg("step");
const send = flag("yes");
if (!["testnet", "mainnet"].includes(network)) fail("--network must be testnet or mainnet");
if (!owner) fail("--owner is required");
const STEPS = ["contracts", "pass", "witty", "open-mint", "mint-first", "list-passes", "comp", "close-mint", "pause-sales", "open-sales", "status"];
if (!STEPS.includes(step)) fail(`--step must be one of: ${STEPS.join(", ")}`);
const plan = PLAN[network];
const scouts = `scouts.${owner}`;
const pass = arg("pass", network === "testnet" ? `passes.${owner}` : `pass.${owner}`);
if (!pass.endsWith(`.${owner}`)) fail(`${pass} must be a sub-account of ${owner}`);
const vault = `witty.${scouts}`;
const recorder = arg("recorder", owner);
const operator = arg("operator", network === "testnet" ? owner : null);
const payees = (arg("payees", network === "testnet" ? owner : "") || "").split(",").filter(Boolean);

const keyStore = new FileKeyStore(join(homedir(), ".near-credentials"), network);
const rpc = arg("rpc");
const near = new Near({ network: rpc ? { networkId: network, rpcUrl: rpc } : network, keyStore, defaultSignerId: owner, defaultWaitUntil: "FINAL" });
const explorer = network === "mainnet" ? "https://nearblocks.io" : "https://testnet.nearblocks.io";
if (step !== "status" && !(await keyStore.get(owner))) fail(`no key for ${owner} in ~/.near-credentials/${network}/`);

async function confirmPermanent(name) {
  if (network !== "mainnet") return;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const typed = (await rl.question(`\nThis is permanent. Type ${name} to go ahead: `)).trim();
  rl.close();
  if (typed !== name) fail("that didn't match - nothing was sent");
}
async function canSpend(amount) {
  const st = await near.getAccount(owner);
  const avail = n(`${st.available} NEAR`);
  console.log(`  ${owner} can spend : ${fmt(avail)}`);
  if (avail < amount + NEAR / 10n) fail(`${owner} needs ${fmt(amount)} plus about 0.1 NEAR for fees`);
}
const report = (checks) => {
  console.log("\nChecks on chain:");
  for (const [label, ok] of Object.entries(checks)) console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  return Object.values(checks).every(Boolean);
};
const done = (ok) => process.exit(ok ? 0 : 1);
const previewOnly = () => {
  console.log(`\nPreview only. To send it, run the same command with --yes at the end.\n`);
  process.exit(0);
};
/** The value a transaction's last call returned (JSON), or null. near.call returns the whole outcome. */
function returned(outcome) {
  const v = outcome?.status?.SuccessValue;
  if (!v) return null;
  const text = Buffer.from(v, "base64").toString("utf8");
  return text ? JSON.parse(text) : null;
}
const call = async (contract, method, args, deposit = 0n) =>
  returned(await near.call(contract, method, args, { gas: GAS, attachedDeposit: deposit }));

console.log(`\nWitty NFTs - step "${step}" - ${send ? "SENDING" : "preview (nothing is sent)"} on ${network}`);

if (step === "contracts") {
  const sc = readWasm("scouts"), pa = readWasm("pass"), va = readWasm("vault");
  const vaultHash = codeHash(va);
  console.log(`  scouts contract : ${scouts}  ${(sc.length / 1024).toFixed(0)} KB, code hash ${codeHash(sc)}, funded ${fmt(plan.fund.scouts)}`);
  console.log(`  pass contract   : ${pass}  ${(pa.length / 1024).toFixed(0)} KB, code hash ${codeHash(pa)}, funded ${fmt(plan.fund.pass)}`);
  console.log(`  vault code hash : ${vaultHash} (every scout's own account must run exactly this)`);
  console.log(`  owner, platform : ${owner} · recorder ${recorder}`);
  console.log(`  pass prices     : floor ${fmt(plan.pass.min)}; caps ${PASS_LEVELS.map(([l, a, b]) => `${l} ${a}/${b}`).join(", ")} (7/30 days)`);
  for (const id of [scouts, pass]) if (await near.accountExists(id)) fail(`${id} already exists`);
  if (plan.fund.scouts < BigInt(sc.length) * BYTE + NEAR / 4n) fail("scouts funding doesn't cover its code plus 0.25 NEAR");
  if (plan.fund.pass < BigInt(pa.length) * BYTE + NEAR / 4n) fail("pass funding doesn't cover its code plus 0.25 NEAR");
  await canSpend(plan.fund.scouts + plan.fund.pass);
  console.log("  checks          : all passed");
  if (!send) previewOnly();
  await confirmPermanent(scouts);
  await near.transaction(owner).createAccount(scouts).transfer(scouts, plan.fund.scouts).deployContract(scouts, sc)
    .functionCall(scouts, "new", {
      owner_id: owner, platform_id: owner, recorder_id: recorder, vault_code_hash: vaultHash,
      metadata: { spec: "nft-1.0.0", name: "Witty the Scout", symbol: "WITTY" }, rent_sources: [pass],
    }, { gas: GAS }).send();
  console.log(`  sent: ${scouts}`);
  await near.transaction(owner).createAccount(pass).transfer(pass, plan.fund.pass).deployContract(pass, pa)
    .functionCall(pass, "new", {
      owner_id: owner, scouts_contract: scouts, recorder_id: recorder,
      metadata: { spec: "nft-1.0.0", name: "Witty Rental Pass", symbol: "WPASS" },
      min_price: plan.pass.min.toString(),
      levels: PASS_LEVELS.map(([name, a, b]) => ({ name, max_7d: n(a).toString(), max_30d: n(b).toString() })),
    }, { gas: GAS }).send();
  console.log(`  sent: ${pass}`);
  const [sCfg, pCfg] = [await near.view(scouts, "get_config", {}), await near.view(pass, "get_config", {})];
  const [sAcc, pAcc] = [await near.getAccount(scouts), await near.getAccount(pass)];
  const ok = report({
    "scouts: no keys (locked)": (await near.getAccessKeys(scouts)).keys.length === 0,
    "pass: no keys (locked)": (await near.getAccessKeys(pass)).keys.length === 0,
    "scouts: on-chain code = this file": sAcc.codeHash === codeHash(sc),
    "pass: on-chain code = this file": pAcc.codeHash === codeHash(pa),
    "scouts: vault code pinned": sCfg.vault_code_hash === vaultHash,
    "scouts: rent comes from the pass contract": sCfg.rent_sources?.[0] === pass,
    "pass: rent goes to the scouts contract": pCfg.scouts_contract === scouts,
  });
  console.log(`\n  ${explorer}/address/${scouts}\n  ${explorer}/address/${pass}\n`);
  done(ok);
}

if (step === "pass") {
  const pa = readWasm("pass");
  console.log(`  pass contract   : ${pass}  ${(pa.length / 1024).toFixed(0)} KB, code hash ${codeHash(pa)}, funded ${fmt(plan.fund.pass)}`);
  console.log(`  rent goes to    : ${scouts} (which will accept it as rent)`);
  console.log(`  pass prices     : floor ${fmt(plan.pass.min)}; caps ${PASS_LEVELS.map(([l, a, b]) => `${l} ${a}/${b}`).join(", ")} (7/30 days)`);
  if (!(await near.accountExists(scouts))) fail(`${scouts} doesn't exist - run --step contracts`);
  if (await near.accountExists(pass)) fail(`${pass} already exists - pick another name with --pass`);
  if (plan.fund.pass < BigInt(pa.length) * BYTE + NEAR / 4n) fail("pass funding doesn't cover its code plus 0.25 NEAR");
  await canSpend(plan.fund.pass);
  console.log("  checks          : all passed");
  if (!send) previewOnly();
  await confirmPermanent(pass);
  await near.transaction(owner).createAccount(pass).transfer(pass, plan.fund.pass).deployContract(pass, pa)
    .functionCall(pass, "new", {
      owner_id: owner, scouts_contract: scouts, recorder_id: recorder,
      metadata: { spec: "nft-1.0.0", name: "Witty Rental Pass", symbol: "WPASS" },
      min_price: plan.pass.min.toString(),
      levels: PASS_LEVELS.map(([name, a, b]) => ({ name, max_7d: n(a).toString(), max_30d: n(b).toString() })),
    }, { gas: GAS }).send();
  console.log(`  sent: ${pass}`);
  const sources = (await near.view(scouts, "get_config", {})).rent_sources || [];
  if (!sources.includes(pass)) await call(scouts, "add_rent_source", { account_id: pass }, 1n);
  const ok = report({
    "pass: no keys (locked)": (await near.getAccessKeys(pass)).keys.length === 0,
    "pass: on-chain code = this file": (await near.getAccount(pass)).codeHash === codeHash(pa),
    "pass: rent goes to the scouts contract": (await near.view(pass, "get_config", {})).scouts_contract === scouts,
    "scouts: counts it as rent": ((await near.view(scouts, "get_config", {})).rent_sources || []).includes(pass),
  });
  console.log(`\n  ${explorer}/address/${pass}\n`);
  done(ok);
}

if (step === "witty") {
  const va = readWasm("vault");
  const cfg = await near.view(scouts, "get_config", {});
  if (cfg.vault_code_hash !== codeHash(va)) fail(`${WASM.vault} isn't the vault code ${scouts} pins (${cfg.vault_code_hash})`);
  if (await near.view(scouts, "get_scout", { scout_id: "witty" })) fail("Witty already exists");
  const deposit = BigInt(va.length + 2000) * BYTE; // exactly what create_scout asks: nothing extra sits unbooked
  console.log(`  Witty's account : ${vault} (no keys, runs only the pinned vault code), storage ${fmt(deposit)}`);
  console.log(`  collection      : 100 NFTs, 70% holders / 10% bills / 20% platform, fixed forever`);
  console.log(`  mint price      : ${fmt(plan.mint.price)} (never below ${fmt(plan.mint.min)}); caps ${MINT_LEVELS.map(([l, a]) => `${l} ${a}`).join(", ")}`);
  console.log(`  bills           : at most ${fmt(BILLS_CAP)} per 30 days · operator ${operator ?? "none yet"} · payees ${payees.join(", ") || "none yet"}`);
  console.log(`  pictures        : ${MINT_LEVELS.map(([l]) => `${l} nft-${l.toLowerCase()}.webp`).join(", ")} (every NFT shows his current level)`);
  console.log(`  minting         : closed until the open-mint step`);
  await canSpend(deposit);
  console.log("  checks          : all passed");
  if (!send) previewOnly();
  await confirmPermanent(vault);
  await call(scouts, "create_scout", {
    scout: {
      scout_id: "witty", name: "Witty the Scout", media: NFT_MEDIA,
      holder_bps: 7000, bills_bps: 1000, platform_bps: 2000, max_supply: 100,
      mint_price: plan.mint.price.toString(), mint_price_min: plan.mint.min.toString(),
      levels: MINT_LEVELS.map(([name, cap]) => ({ name, max_price: n(cap).toString(), media: levelPic(name) })),
      bills_cap: BILLS_CAP.toString(), payees, operator_id: operator,
    },
    vault_code: Buffer.from(va).toString("base64"),
  }, deposit);
  const s = await near.view(scouts, "get_scout", { scout_id: "witty" });
  const acc = await near.getAccount(vault);
  const ok = report({
    "Witty is ready": s?.ready === true,
    "Witty's account has no keys": (await near.getAccessKeys(vault)).keys.length === 0,
    "Witty's account runs the pinned vault code": acc.codeHash === codeHash(va),
    "split 70/10/20": s?.split?.holder_bps === 7000 && s?.split?.bills_bps === 1000 && s?.split?.platform_bps === 2000,
    "100 NFTs, none minted": s?.max_supply === 100 && s?.minted === 0,
    "minting closed": s?.mint_open === false,
  });
  console.log(`\n  ${explorer}/address/${vault}\n`);
  done(ok);
}

if (step === "open-mint") {
  const s = await near.view(scouts, "get_scout", { scout_id: "witty" });
  if (!s?.ready) fail("create Witty first (--step witty)");
  console.log(`  minting opens at ${fmt(s.mint_price)} (attach ${fmt(s.attach_to_mint)})`);
  if (!send) previewOnly();
  await call(scouts, "set_mint_open", { scout_id: "witty", open: true }, 1n);
  done(report({ "minting is open": (await near.view(scouts, "get_scout", { scout_id: "witty" })).mint_open === true }));
}

if (step === "mint-first") {
  const s = await near.view(scouts, "get_scout", { scout_id: "witty" });
  if (!s?.mint_open) fail("open minting first (--step open-mint)");
  if (s.minted !== 0) fail(`${s.minted} NFT(s) already minted`);
  console.log(`  NFT #1 to ${owner} for ${fmt(s.mint_price)} (attach ${fmt(s.attach_to_mint)}; unused storage comes back)`);
  await canSpend(BigInt(s.attach_to_mint));
  if (!send) previewOnly();
  const e = await call(scouts, "mint", { scout_id: "witty" }, BigInt(s.attach_to_mint));
  done(report({ "witty-1 is minted to the owner": e?.token_id === "witty-1" && e?.owner_id === owner }));
}

if (step === "list-passes") {
  const s = await near.view(scouts, "get_scout", { scout_id: "witty" });
  if (!s?.minted) fail("mint NFT #1 first: Witty takes no rent until an NFT exists (--step mint-first)");
  if (await near.view(pass, "get_listing", { scout_id: "witty" })) fail("Witty's passes are already listed");
  console.log(`  Witty's passes  : ${TIERS.tier_7d.name} (7 days) ${fmt(plan.pass.p7)}, ${TIERS.tier_30d.name} (30 days) ${fmt(plan.pass.p30)} (plus 0.015 NEAR storage, unused part refunded)`);
  if (!send) previewOnly();
  await call(pass, "add_scout", { scout_id: "witty", name: "Witty", ...TIERS, price_7d: plan.pass.p7.toString(), price_30d: plan.pass.p30.toString() }, 1n);
  const l = await near.view(pass, "get_listing", { scout_id: "witty" });
  done(report({
    "passes on sale": l?.sales_open === true,
    "prices set": l?.price_7d === plan.pass.p7.toString() && l?.price_30d === plan.pass.p30.toString(),
    "Bronze (7 days) and Silver (30 days)": l?.tier_7d?.name === "Bronze" && l?.tier_30d?.name === "Silver",
  }));
}

if (step === "comp") {
  const to = arg("to");
  const days = Number(arg("days", "7"));
  if (!to) fail("--to ACCOUNT is required");
  if (![7, 30].includes(days)) fail("--days must be 7 or 30");
  if (!(await near.accountExists(to))) fail(`${to} doesn't exist - check the account name`);
  console.log(`  free founding pass: ${days} days for ${to} (marked as free on chain, pays no rent)`);
  if (!send) previewOnly();
  const p = await call(pass, "mint_comp", { scout_id: "witty", receiver_id: to, days }, 15n * 10n ** 21n);
  done(report({ [`pass #${p?.token_id} to ${to}, marked free`]: p?.owner_id === to && p?.comp === true }));
}

if (step === "close-mint") {
  const s = await near.view(scouts, "get_scout", { scout_id: "witty" });
  if (!s?.ready) fail("Witty doesn't exist yet");
  console.log(`  minting is ${s.mint_open ? "OPEN" : "already closed"} · ${s.minted} of ${s.max_supply} minted; closing it stops new mints only`);
  if (!send) previewOnly();
  await call(scouts, "set_mint_open", { scout_id: "witty", open: false }, 1n);
  done(report({ "minting is closed": (await near.view(scouts, "get_scout", { scout_id: "witty" })).mint_open === false }));
}

if (step === "pause-sales" || step === "open-sales") {
  const open = step === "open-sales";
  const l = await near.view(pass, "get_listing", { scout_id: "witty" });
  if (!l) fail("Witty's passes aren't listed yet (--step list-passes)");
  console.log(`  pass sales are ${l.sales_open ? "OPEN" : "PAUSED"} now · ${l.paid_passes} sold, ${l.comp_passes} free · ${open ? "reopening" : "pausing"} them${open ? "" : " (passes already sold keep working)"}`);
  if (!send) previewOnly();
  await call(pass, "set_sales_open", { scout_id: "witty", open }, 1n);
  done(report({ [`pass sales are ${open ? "open" : "paused"}`]: (await near.view(pass, "get_listing", { scout_id: "witty" })).sales_open === open }));
}

if (step === "status") {
  const s = await near.view(scouts, "get_scout", { scout_id: "witty" }).catch(() => null);
  const l = await near.view(pass, "get_listing", { scout_id: "witty" }).catch(() => null);
  console.log(JSON.stringify({ witty: s, passes: l }, null, 1));
  process.exit(0);
}
