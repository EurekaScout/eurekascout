# EurekaScout build log

One entry per day: what we built, what broke, what we decided. Newest last.
Times are UTC. Mainnet contracts: `receipts.eurekascout.near` (the receipts), `scouts.eurekascout.near` (Witty NFTs), `pass.eurekascout.near` (Rental Passes), `witty.scouts.eurekascout.near` (Witty's own account).

## 25 Oct: the idea

- Witty, an AI memecoin scout, makes calls on Solana and Robinhood Chain. Every call is sealed on NEAR before it plays out and revealed later, so the record can't be edited after the fact.
- Witty is an NFT that earns rent; renters hold a time-limited Rental Pass NFT.
- Tracks: NFTs That Do Something (lead), Agent Economy, AI Security & Defense.

## 26–27 Oct: the spec

- Wrote Witty's call spec (v0.2): what a call holds, its plan, seal and reveal, scoring.
- NEAR Hackathon Support confirmed on 27 Oct that building before 1 Nov is fine; only submission waits for 1 Nov.

## 28 Oct: brand, repo and the sealing contract

- Brand: logo, colours, type, landing page design and the Witty mascot set.
- GitHub repo created (private until 13 Nov).
- Sealing contract written in Rust (near-sdk 5): `seal_call` stores a SHA-256 hash, `reveal_call` checks the JSON against it before the deadline, views return every call and the record. 12 unit tests.
- 6 integration tests on a local NEAR node (near-kit Sandbox): locked deploy, seal and reveal, an edited JSON is rejected, a stranger can't seal, a call expires after its deadline, the record adds up.
- Testnet deploy and a first test call.

## 29 Oct: locked on mainnet

- Rehearsed a locked deploy on testnet, then deployed `receipts.eurekascout.near` on mainnet in one transaction (create, fund, deploy, initialise) with **no access key**, so nobody can change the code. Deploy tx: [tX1QawG5…uAxh](https://nearblocks.io/txns/tX1QawG5c4sopP8hJdLTmKxw87CThnpJKvgAVuhuAxh).
- Reproducible Docker build of commit `14617ea`; the on-chain code hash matches the build (sha256 `6c17062d…d085`).
- Decided: reveal at 46 h (the contract's deadline is 48 h), and every call's JSON and salt are backed up privately before sealing.

## 30 Oct: the sealer goes live

- Sealer v1: makes the calls, backs them up, seals them and reveals each one at 46 h. It runs as an always-on service on our server; its code is private.
- Security: the server signs with a **function-call key** that can only call `seal_call` and `reveal_call` on the receipts contract, with a 0.5 NEAR fee cap. The key was generated on the server and never left it. Add-key tx: [4EgKwEZo…Ntop](https://nearblocks.io/txns/4EgKwEZoJNUNwbnKuxBL959ShhEbUowQdYdn844xNtop).
- First warm-up receipts #0 to #4 sealed from 15:28 UTC.

## 31 Oct: prices from the chain

- Probed both chains: a Solana pool is two vaults (SOL and the coin) that one RPC call can read; Robinhood memecoins trade on Uniswap v4, where every swap is an event with its price.
- **Price recorder** live before the official start: reads each Solana call's pool vaults every 10 s for the first hour, each reading with its slot.
- **Scorer** v1.0: plays each call's plan on those prices, minus 4% for fees. Robinhood results are rebuilt from swap events; Solana results from the recorder.
- 10 more warm-up calls (#10 to #19).

## 1 Nov: day 1 of the official record

- The official record started at 00:00 UTC. The first official call (#20) was priced from 300+ chain readings.
- The scorer's first run showed three Robinhood warm-up calls with no trades at all. The chain showed why: each pool was created about 90 s before the call, traded, and had **all its liquidity removed 2 to 13 s before Witty's call**. A 90-second rug, invisible on price sites, which still showed the old liquidity.
- Scorer v1.2: a pool whose liquidity is pulled counts as rugged at that point (0.00x), including a pool emptied before the call. It also caught two more pools pulled at minute 6, three blocks apart.
- First reveals: warm-up calls #0 to #6 were revealed on time (46 h after sealing) and the public scorer re-hashed each one against its seal.

## 2 Nov: the website, and Witty puts his own money in

- **Website** live on [eurekascout.com](https://eurekascout.com) (deployed from `site/` on every push): Home, How it works, Record, NFTs, Rent and Team. It reads `receipts.eurekascout.near` live through a public NEAR RPC, and the Record re-hashes every revealed call in the browser (SHA-256) against its seal. Built for phones, tablets and desktop, and it installs as an app. Kept out of search engines until the launch on 14 Nov.
- **NFT art:** the artist delivered the three Witty levels (Rookie, Analyst, Elite), hand-drawn from our references.
- **Witty's own wallet:** Witty puts a small, fixed amount on some of his own calls, so his real fills can sit next to the scored results. Its trades are on the Record page; they never feed the score.
- Seven founding renters invited, with a private testers' group.
- Decided: OutLayer (FastNEAR's TEE compute) as an optional upgrade for the Rental Pass check, never the only path. Our own server always does the same job.

## 3 Nov: the wallet, locked down, and first testers

- The wallet's key is **encrypted with a passphrase** (scrypt, then AES-256-GCM with the wallet address as associated data). The service unlocks it from an encrypted systemd credential, so Witty restarts on his own after a reboot; status checks and previews never unlock it. An encrypted backup is kept offline and was checked to open on a second machine. The key was never printed or copied in plain text. The limit we accept: root on the running server could still reach it, which is why the wallet only holds a small amount.
- Withdrawals are built by hand (a System Program transfer), checked byte for byte against `@solana/web3.js`, show a preview and ask for the last 4 characters of the address.
- **OutLayer go/no-go 1 passed:** a test function deployed on testnet ran through OutLayer and returned its result.
- **First day of testing.** Our founding tester **MAMA G** went through the whole site on her phone: every button, the receipt check (each result matched its seal on NEAR), and installing the site as an app on an iPhone. She found two things, both fixed the same day:
  - A check could hang for several seconds when the first public NEAR server was slow. The site now asks the next server if the first hasn't answered in 1.2 s, and takes whichever answers first.
  - Asking for a call that doesn't exist yet didn't say which call is the latest. It now does.
- **Vicky** and **Favvy** tested on day one too: smooth on phone and PC, and the re-hash tool works. Dark mode was asked for twice.
- Added a 404 page: an unknown address used to show the homepage.

## 4 Nov: Witty NFTs, Rental Passes and Witty's own account

- **The design changed (Dre's idea):** Witty is a collection of at most **100 NFTs** (`witty-1` to `witty-100`) that anyone can mint. Holding one gives access to Witty's calls and an equal share of the holders' **70% of every rent payment**, provable on chain. Rental Passes are for people who'd rather rent than own; their rent is what pays holders.
- **Mint money never goes to holders.** It goes to Witty's own account: a third to his bills budget, two thirds to the platform fee. No holder is ever paid by later minters.
- **Witty's own account** (`witty.scouts.eurekascout.near`) is created with no access keys and obeys only the scouts contract. All money sits there, visible on NearBlocks, until it's claimed or paid out by the contract's rules.
- **The record sets the price ceiling:** the mint price is capped by Witty's level (Rookie 200 NEAR, Analyst 300 NEAR, Elite 500 NEAR). Witty launches as a Rookie at about 13 NEAR.
- **Rules in the code:** an NFT's unclaimed share is sold with the NFT; a claim cancels that NFT's marketplace listings; bills come only from the 10% budget, to listed payees, within 2 NEAR per 30 days (the cap can be lowered, never raised); the platform fee can only be claimed by the platform account; no admin withdrawal exists; free founding passes are marked on chain and never counted as rent.
- **Three independent reviews** before any deploy. The first found 11 issues: the worst could let a contract receiving Witty set itself up to keep paying itself bills, and let a stranger set up a contract before us. All fixed. The third found that rent paid before the first NFT could be scooped by whoever minted first, so the contract now takes no rent until an NFT exists. Each finding has a test, and a randomised test of 20,000 steps (mints, rent, tips, claims, failures and sales in random order) kept the books balanced at every step.
- **OutLayer access check:** a WASI component that answers "does this account hold a Witty NFT or a live pass?" from the chain; anything that isn't a well-formed answer is an error, never a yes.

## 5 Nov: Bronze and Silver passes, and the whole launch on testnet

- **Two passes, named for what they are:** the 7-day **Bronze Pass** and the 30-day **Silver Pass** (Dre's idea, so more tiers can follow). A pass is minted as "Witty Bronze Pass #12" with its own image and its tier in the metadata, and keeps its tier for life, renewals included.
- **The whole launch rehearsed on testnet:** contracts locked, Witty's own account created with no keys, minting opened, Witty NFT #1 minted, both passes put on sale, and a free founding pass minted and checked on chain.
- **The site shows prices in NEAR:** Bronze 1.3 NEAR, Silver 4 NEAR.

## 6–7 Nov: mainnet, levels and the Telegram bot

- **Mainnet:** the scouts and pass contracts deployed locked, Witty's own account created with no keys, and Witty NFT #1 minted at 13 NEAR (a third to his bills budget, two thirds to the platform fee). Then a quiet run: minting closed and pass sales paused until the launch.
- **Witty's level** (Rookie, Analyst, Elite) is set from his public record: Analyst at 30+ official calls and $1.05+ per $1 after fees, Elite at 100+ calls and $1.25+. A small owner helper on `eurekascout.near` records it on the scouts and pass contracts; the server's key can call only that and the free-trial mint.
- **Free trial passes:** a free 7-day Bronze Pass for new users, at most 80, switched on at the launch.
- **@scout_witty_bot:** link a NEAR wallet by signing a message (every NEAR wallet's signature form is accepted), then holders get Witty's calls on Telegram the moment they're sealed. Payments from any chain through NEAR Intents.
- **Four kinds of call:** Gamble, Scalping, Conviction and Smart Wallets, each with its own plan sealed in the call, and the record shown per kind. How it works was rewritten to match: summaries only.

## 8 Nov: data, Practice, wallets, cash out and Witty's bills

- **The Record fills itself:** the server re-scores every call every 2 hours and the site reads the result from our API, with each call's plan details left out of the public data.
- **Practice mode:** trade Witty's calls with play money: buy more, sell any part, or let Witty's autopilot trade them for you. The Practice page shows each step in plain words and refreshes every 5 s.
- **Wallets on phones:** the Meteor app connects by itself inside its own browser; MyNearWallet (retired) left the wallet list; and a code from the bot can be typed in on the site instead of following a link.
- **Send NEAR and Cash out** on My Witty: send NEAR to any account, or turn NEAR into SOL or USDC on Solana through NEAR Intents, with the Solana address checked first. First real cash-out: 0.2 NEAR to SOL. A failed swap comes back as wNEAR, with an Unwrap button.
- **The receipts contract ran out of storage NEAR** from 19:31 to 20:03 UTC: seals failed and one reveal waited until the top-up. Each call stores a little data on NEAR, and NEAR charges for storage.
- **Witty pays his own storage now.** Witty's platform share was claimed (8.666 NEAR) and 4 NEAR sent to the receipts contract. Then receipts became a payee of Witty's bills budget, with a server key that can only call `pay_bill`: no deposit, listed payees only, at most 2 NEAR per 30 days. A test bill of 0.001 NEAR went through, and from that night the server pays the storage bill once a day. Every step ran from scripts that preview first and make you type the account name on mainnet (`scripts/platform-fee.mjs`, `scripts/bills-setup.mjs`).
- **We paused Witty's wallet after a losing day.** Calls are still sealed and scored; the wallet buys again only once a replay on 100+ calls with real fill prices shows a plan that makes money.

## 9 Nov: peaks, Witty's account in the open, and a public scorer

- **Dre** has his portrait on the Team page.
- **The NFTs page reads Witty's account from NEAR:** rent earned, bills paid (with today's bills), what holders have collected and passes sold.
- **Peak on every call:** each call shows how high the coin went in its window next to what Witty's plan made. The plan's result stays the score.
- **Prices for every Solana call:** 22 Scalping calls from 7–9 Nov were on DEXes the price recorder couldn't read (Raydium, Meteora) or had no pool it could find, so they have no prices and show as not scored. From 9 Nov such coins are recorded from market price data at the same pace, and each call's data says where its prices came from.
- **The public scorer** (`verify/`): it holds no plan of its own and reads every target, stop and time limit from each call's revealed JSON. Run side by side with the live scorer on the server, it gave the same result, exit, kind, peak and price source for every call both had scored: 101 calls on 10 Nov at 01:13 UTC, 0 differences (two old Robinhood calls were skipped when the public Robinhood RPC rate-limited us, not scored differently). Run from a laptop with only the published price files, it matched the record on the site for all 102 calls both had scored.
- **Price files are public:** each revealed Solana call's price file is published at api.eurekascout.com (only after its reveal), and `verify/fetch_prices.mjs` downloads them all, so anyone can re-score Solana calls too.
- `verify/` has a chain-only version of the price recorder: it reads PumpSwap pools and pump.fun bonding curves, and finds a coin's PumpSwap pool from the chain alone (pump.fun's canonical pool address for the coin, checked against a real pool). The live one also uses market price data for coins on other DEXes, since 9 Nov.
- **Repo goes public on 13 Nov** with a clean history: the code that finds and picks Witty's calls stays private, and everything needed to check his record is MIT.
