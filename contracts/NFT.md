# Witty NFTs, Rental Passes and Witty's own account

Three contracts, written from the threat model before any code and checked by independent reviewers, including a randomised test of 20,000 steps of mints, rent, tips, claims, failures and sales in random order (every finding fixed, each with a test):

| Crate | Account | What it does |
|---|---|---|
| `vault/` | `witty.scouts.eurekascout.near` | Witty's own account. Created by the scouts contract with this code and no access keys. Anyone can send NEAR in; only its parent (the scouts contract) can send NEAR out. It keeps no state. |
| `scouts/` | `scouts.eurekascout.near` | The Witty NFTs (NEP-171, 177, 178, 181, 199): at most 100, `witty-1` to `witty-100`, minted by anyone. Holding one gives access to Witty's calls and an equal share of the holders' 70% of every rent payment. |
| `pass/` | `pass.eurekascout.near` | The Rental Passes (NEP-171, 177, 178, 181, 199), for people who'd rather rent than own: the Bronze Pass (7 days) and the Silver Pass (30 days). Their rent goes into Witty's account in the same transaction as the pass. |
| `../outlayer/pass-check/` | OutLayer | Plan A of the bot's check: does this account hold a Witty NFT or a live pass? |

## Where the money goes

| Money | Holders (each NFT an equal share) | Witty's bills budget | Platform fee |
|---|---|---|---|
| Rent (Rental Passes), tips | 70% | 10% | 20% |
| Minting a Witty NFT | none | 1/3 | 2/3 |

Holders earn only from rent and tips, never from later minters. All of it sits in Witty's own account until it's claimed or paid out, so anyone can check it on NearBlocks.

## Rules, and the code that enforces them

- **No back door to Witty's money.** Witty's account is created with `create_account + transfer + deploy_contract` and no `add_key`. Its only method that moves NEAR, `send`, checks that the caller is its parent. The scouts contract has no admin withdrawal. Both contracts are deployed locked, in one transaction with their `new` (which only the contract or its parent account can call).
- **The vault code is pinned.** The scouts contract is set up with the SHA-256 of the vault wasm and refuses any other code. Anyone can compare it with the code hash NEAR shows for `witty.scouts.eurekascout.near`.
- **Fixed at creation:** the split (holders always get at least 50%), the supply (100), the most the bills cap can ever be (2 NEAR per 30 days), the lowest mint price, and the mint price cap and picture at each level.
- **The record sets the price ceiling.** Witty's mint price is capped by his level: Rookie up to 200 NEAR, Analyst up to 300 NEAR, Elite up to 500 NEAR. The recorder sets the level with the inputs it came from (logged, and recomputable from the receipts contract with the public scorer); the owner sets the price under the cap. If the level drops, the price is held to the new cap at once. Witty launches as a Rookie at about 13 NEAR.
- **Every NFT shows Witty's level.** Each level has its own picture (Rookie, Analyst, Elite). `nft_token`, `nft_tokens` and `nft_tokens_for_owner` return each NFT with the picture of his current level and the level's name in `extra`, so when the recorder sets a new level every NFT changes picture in wallets, with nobody touching the NFTs. If he drops back, the pictures go back too. The level rules (how many official calls and what return per $1) live in the level script, not the contract: they start at Analyst for 30+ official calls and $1.05+ per $1 after fees, and Elite for 100+ calls and $1.25+, and any change to them is dated in the build log.
- **Equal shares.** Each payment's 70% is divided by the NFTs that exist at that moment. A new NFT shares in payments made after it's minted, not before. Rounding dust is carried forward and shared with the next payment, never lost.
- **No rent before the first NFT.** With no NFTs there's nobody to share the 70% with, and holding it for later would hand it all to whoever mints first. So until an NFT exists, `deposit_rent` refuses and the pass contract refunds the renter. At launch, minting opens before pass sales.
- **A share stays with its NFT** until its holder claims it, so it's sold with the NFT. Only the NFT's holder at that moment can claim (with a full-access key, 1 yoctoNEAR). A claim comes off the books before it is sent and goes back onto the NFT if the transfer fails. A claim cancels every marketplace approval on the NFTs claimed, so a listing can't outlive the share it was priced on.
- **Witty's bills** are paid by his operator (a function-call key on the server), only to listed payees, only from the bills budget, within the cap for the last 30 days (each UTC day's total counts until 30 days after the day ends), each logged with its memo. We set the payees and the operator; we can lower the cap, never raise it above 2 NEAR. Bills never touch holders' shares.
- **The platform fee** can only be claimed by the platform account, to itself.
- **Tips.** NEAR sent straight to Witty's account is booked by `sync_vault` (anyone can call it) and split like rent. It never counts money that's on its way out, and if a payout starts or settles while it reads the balance, it books nothing and can be called again, so nothing is ever booked twice.
- **No dead ends.** An NFT can't be minted or sent to this contract or any scout's account, and those can't be payees, where NEAR or an NFT could never move again.
- **Passes**: buying forwards exactly the price to `scouts.deposit_rent` and mints the pass in the callback. If the rent can't go in, the buyer gets everything back (if the bounced rent hasn't arrived yet, the rest is held for `claim_refund`). Attach the price plus 0.015 NEAR for storage; overpayment, and storage the pass doesn't use, is refunded. Renewing adds days to the same pass, whoever holds it. Nothing can shorten, take back or burn a pass.
- **Tiers.** Each scout's passes have a tier per length, set when the scout is listed: Witty's are Bronze (7 days) and Silver (30 days). A pass is minted as "Witty Bronze Pass #12" with that tier's image and `"tier"` in its metadata, and keeps its tier for life, renewals included. `set_tiers` (owner) renames or re-images tiers for new passes only, so a pass already sold never changes.
- **Free passes** (`mint_comp`, owner only) are marked `"comp":true` in their metadata, pay no rent, and are counted on their own line, never as rent or paid passes.
- **The bot's check**: `access(account_id, "witty")` on the scouts contract, `active_pass(account_id, "witty")` and `pass_info(token_id)` on the pass contract. The OutLayer check reports how access was found (`nft` or `pass`), who holds it, and whether that's the caller; anything that isn't a well-formed answer is an error, never a yes.

## Limits we accept

- **Locked means no fixes.** A bug can't be patched; a v2 would go to a new account. That's why every rule has a test and the code had independent reviews.
- **A stolen operator key** can pay listed payees, within the cap, from the bills budget only. We stop it with `set_operator(None)`.
- **`nft_transfer_call`** hands the NFT, and its unclaimed share, to the receiver until it's returned.
- **If a payout's callback ever ran out of gas**, that scout's `sync_vault` would stay blocked (nothing else would). Callbacks get 20 Tgas plus leftover gas, far more than they use.
- **Contracts pay for some storage growth** (an NFT or pass sent to a new account, approvals). Each mint keeps a 500-byte margin for this (the 0.015 NEAR storage fee, less what's unused), we fund each contract with a buffer, and anyone can top one up.
- **A returned `nft_transfer_call` comes back without its marketplace approvals**, on purpose: its share may have been claimed while it was away. The standard says approvals should be restored; we chose safety.
- **The `nft_transfer` event's `authorized_id`** is left out by the NFT standard library we use, so indexers can't see which marketplace made a sale. Transfers themselves are correct.
- **`access` looks through an account's first 500 NFTs** across all scouts. While Witty is the only scout that's 100 at most; the bot can also check one NFT with `edition_info`.
- **A seller can claim, then list again** at the same price; a buyer should check an NFT's `claimable` before buying.
- **If creating a scout fails**, our own deposit can get stuck (no withdrawal exists). It's ours only, and small.
- **NEAR sent to Witty's account before the first NFT** (and anything attached at creation beyond its storage) is booked by the first `sync_vault` after minting starts, shared by the NFTs that exist then. Keep it near zero: attach only what `create_scout` asks for.

## Test

```
cd contracts/vault && cargo test     # 6
cd contracts/scouts && cargo test    # 83
cd contracts/pass && cargo test      # 40
cd outlayer/pass-check && cargo test # 16
```

## Build

```
cd contracts/vault && cargo near build non-reproducible-wasm
cd contracts/scouts && cargo near build non-reproducible-wasm
cd contracts/pass && cargo near build non-reproducible-wasm
cd outlayer/pass-check && cargo build --target wasm32-wasip2 --release
```

The vault is built first: its hash goes into the scouts contract's `new`.
