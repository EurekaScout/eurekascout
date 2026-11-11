# EurekaScout

Witty is an AI memecoin scout that shows its receipts. Every call is **sealed on NEAR before anyone sees it**, revealed 46 hours later with its plan, and scored from public prices after fees. Its record can't be edited, cherry-picked or deleted, and anyone can re-score it.

Built at NEAR HACKATHON (1–14 Nov 2026). Tracks: NFTs That Do Something (lead), Agent Economy, Autonomous Business, AI Security & Defense and Open Innovation.

**Status, 9 Nov:** the sealing contract, the Witty NFT and Rental Pass contracts and Witty's own account are live on mainnet. Witty seals and reveals calls around the clock, the record is re-scored every 2 hours, and @scout_witty_bot sends calls to holders on Telegram. Pass sales open at the launch on 14 Nov.

## The problem

Memecoin callers post their wins and quietly drop their losses. Nobody can check a caller's real record: when the call was made, at what price, and what happened next. Renting a caller's calls is a bet on screenshots.

## How it works

Witty finds early tokens, mostly on Solana, and seals each call on NEAR before anyone sees it. He reveals it later with its plan, and the record is scored from public prices.

1. **Seal.** Each call is sealed with its coin, time, entry, kind and plan, plus a random salt so nobody can guess a call from its hash. The call is written as JSON and backed up privately, and its SHA-256 hash is sealed on `receipts.eurekascout.near`, which records the time and block. Nobody, including us, can change a sealed call.
2. **Reveal.** 46 hours later Witty reveals the exact JSON. The contract re-hashes it and accepts it only if it matches the seal. A call not revealed within 48 hours shows as expired and counts as a loss.
3. **Prices.** On Solana, a price recorder reads each call's coin every 10 seconds in its first hour, then every 30 seconds: straight from the chain (its PumpSwap pool or pump.fun bonding curve, each reading with its slot), or from market price data for coins on other DEXes. On Robinhood Chain, every swap is already an event on the chain.
4. **Score.** The scorer plays each call's own sealed plan on those prices and takes 4% off for fees. A fall to 0.2x of the entry, or an emptied pool, counts as a rug. Every call also shows how high the coin went (its peak) next to what Witty's plan actually made; the plan's result is the score. Wins and losses go on the record together, and none can be dropped.

Calls come in four kinds (Gamble, Scalping, Conviction and Smart Wallets), each with its own plan, and the record is shown for each kind as well as overall.

### What NEAR does

- **Receipts.** `receipts.eurekascout.near` is **locked**: it was deployed with no access key, so its code can never change. The server signs with a function-call key that can only call `seal_call` and `reveal_call` there, with a 0.5 NEAR fee cap.
- **Witty NFTs and Rental Passes** (NEP-171). Up to 100 Witty NFTs; holding one gives access to Witty's calls and an equal share of 70% of every rent payment. Rental Passes (Bronze, 7 days; Silver, 30 days) are for people who'd rather rent than own. Both contracts are locked too. Details: [`contracts/NFT.md`](contracts/NFT.md).
- **Witty's own account** (`witty.scouts.eurekascout.near`) has no access keys and obeys only the scouts contract. Rent splits 70% to holders, 10% to Witty's bills budget and 20% platform fee. Witty pays his own NEAR storage bills from his budget: the server's key for that can only call `pay_bill`, only to listed payees, within 2 NEAR per 30 days.
- **Payments** from any chain through NEAR Intents, and a cash-out from NEAR to SOL or USDC on Solana.

## Try it (do X, see Y)

**In a browser (no install):** open [eurekascout.com/record.html](https://eurekascout.com/record.html). You see every revealed call read live from `receipts.eurekascout.near`, re-hashed in your browser against its seal (✓ matches seal), with its result after fees and its peak. On [How it works](https://eurekascout.com/how.html), type any call number under "Re-hash a call in your browser" and press Check.

**From a terminal:** needs [near-cli-rs](https://github.com/near/near-cli-rs) for steps 1–3 and Node 20+ for steps 4–5.

1. **Read the contract's settings.**
   `near contract call-function as-read-only receipts.eurekascout.near get_config json-args '{}' network-config mainnet now`
   You see the owner (`eurekascout.near`), the official start (1 Nov 2026 00:00 UTC, in nanoseconds) and the 48 h reveal window.
2. **Check that the contract is locked.**
   `near account list-keys receipts.eurekascout.near network-config mainnet now`
   You see no access keys at all.
3. **Read the record and any call.**
   `near contract call-function as-read-only receipts.eurekascout.near get_record json-args '{}' network-config mainnet now`
   `near contract call-function as-read-only receipts.eurekascout.near get_call json-args '{"id":"1"}' network-config mainnet now`
   You see the totals, then call #1 with its hash, seal time and, once revealed, its JSON. The SHA-256 of that JSON equals the hash.
4. **Re-score every revealed call.**
   `cd verify && node fetch_prices.mjs && node witty_score.mjs` (nothing to install)
   You see each revealed call re-hashed against its seal and scored with its own plan: its exit, its result after fees, its peak, and the record overall and by kind. The scorer holds no plan of its own: every target, stop, take-profit and time limit comes from the call's revealed JSON. `fetch_prices.mjs` first downloads the price file of every revealed Solana call from api.eurekascout.com (a call's file is published only after its reveal) into `verify/data/prices/`; Robinhood calls are rebuilt straight from the chain. A call without prices is marked "not scored", never guessed.
5. **Run the tests.**
   `cd verify && npm run selftest` (plan engine, scorer and price recorder, all offline).
   `cd contracts/witty && cargo test` (12), and the same in `contracts/scouts` (83), `contracts/pass` (40), `contracts/vault` (6) and `contracts/trial-minter` (14). For the integration tests on a local NEAR node: build the contracts with `cargo near build non-reproducible-wasm`, then from the repo root `npm install && npm run test:sandbox && npm run test:nft` (it downloads the local node on first run).

**Verify the deployed code is this code.** `git checkout 14617ea && cd contracts/witty && cargo near build reproducible-wasm` (needs Docker), then `sha256sum target/near/witty.wasm`. You see `6c17062d9a048eb4e71424d940fd4ff5480816af4c477603df360009c872d085`. The code on chain has the same hash, shown as `8GwPrUjAq6ubn1RDkBed7gg72H7rvT6ACM1YPgHo45g8` in base58 (`near account view-account-summary receipts.eurekascout.near network-config mainnet now`). The contract has not changed since that commit, and its own `contract_source_metadata` names it.

## Repository

| Path | What |
|---|---|
| `contracts/witty/` | The sealing contract (Rust, near-sdk 5), unit tests |
| `contracts/scouts/`, `contracts/pass/`, `contracts/vault/` | Witty NFTs, Rental Passes and Witty's own account ([`contracts/NFT.md`](contracts/NFT.md)) |
| `contracts/trial-minter/` | The owner helper that gives free trial passes and records Witty's level, called by a key limited to those two methods |
| `outlayer/pass-check/` | An OutLayer version of the pass check ("does this account hold a Witty NFT or a live pass?") |
| `tests/` | Integration tests on a local NEAR node (near-kit Sandbox) |
| `scripts/` | Deploys (each contract locked in one transaction, checked on chain after) and owner tools; every step previews first |
| `verify/` | Re-score the record: the scorer and its plan engine, `fetch_prices.mjs` (downloads the published Solana price files), and a chain-only version of the Solana price recorder (PumpSwap pools and pump.fun bonding curves). The live recorder also uses market price data for coins on other DEXes, since 9 Nov. |
| `site/` | The website (static, deployed on every push) |
| `BUILDLOG.md` | Day-by-day log |

The code that finds and picks Witty's calls runs on our server and is not in this repository.

## What's next

- **Launch, 14 Nov:** minting and pass sales open, free 7-day trial passes, and the site goes public.
- **Real trading for holders, opt-in:** Witty trades his calls in a wallet made for each holder, with a cap per wallet, once his own wallet is in profit over 100+ calls. Until then, Practice mode trades his calls with play money.
- **After the hackathon:** an open registry where any caller seals and reveals calls under their own name, with Witty as scout #1.

## Related work

Baola ranks callers by their peak. MemeToro escrows AI launches. Witty seals every call on NEAR before it plays out, reveals it 46 hours later, and scores it after fees, losses included.

## Disclosures

- **Built during the hackathon:** everything in this repository. The hackathon counts code from its 19 Oct announcement; we started on 25 Oct and created this repository on 28 Oct 2026 (see `BUILDLOG.md` and `git log`). Submissions open on 1 Nov, and NEAR Hackathon Support confirmed on 27 Oct that building before then is fine.
- **One input that existed before:** some of Witty's call inputs come from private tools of ours that were running before 19 Oct. They are separate projects, not part of this submission or this repository.
- **Libraries:** near-sdk, cargo-near, near-kit and their dependencies; Node's standard library.
- **Built with Claude Code:** most of the code and docs were written with Claude Code, Anthropic's AI coding agent, working from our specs. We set the idea, the rules and every decision, tested each change, and did every deploy, key and signing step ourselves.
- **Our own passes:** we bought 3 passes ourselves to test payments on mainnet. Founding renters' first passes are free; they're marked as free passes on chain and pay no rent.
- **Prices:** prices come from each coin's pool on the chain, or from market price data for coins on other DEXes. Witty's own trades get their quotes and swaps from a swap API; they never feed the score.

## Team

Two people:

- Idarastar (lead): build, data, design and launch
- Dre (pseudonymous by choice): ideas and product direction

Thanks to our founding testers: **MAMA G**, **Vicky** and **Favvy**, who tested the site on day one (MAMA G found its first two fixes).

## License

MIT ([`LICENSE`](LICENSE)): the contracts, tests, scripts, `verify/`, the site and the docs. Everything you need to verify Witty's record is here.
