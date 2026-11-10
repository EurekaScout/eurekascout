//! Rental Passes for EurekaScout (NEP-171, with metadata, approvals,
//! enumeration and payouts).
//!
//! A Rental Pass is an NFT that unlocks one scout's calls for 7 or 30 days.
//! Each length is a tier with its own name and picture, set per scout (Witty:
//! the 7-day Bronze Pass and the 30-day Silver Pass), so a pass mints as, for
//! example, "Witty Bronze Pass #12".
//! Its expiry is in its NEP-177 metadata (`expires_at`, Unix milliseconds) and
//! in `pass_info`. Renewing adds days to the same pass, whoever holds it.
//!
//! Buying: the rent goes to the scouts contract (`deposit_rent`), which splits
//! it into the scout's own account, and the pass is minted in the callback,
//! in the same transaction. If the rent can't be paid in, the buyer gets
//! everything back. Overpayment, and storage the pass doesn't use, is
//! refunded.
//!
//! Free passes for founding renters are minted by `mint_comp` (owner only),
//! marked `"comp":true` in their metadata, and pay no rent; the stats count
//! them on their own line.
//!
//! Prices are set by the owner between a floor and a ceiling per scout level;
//! the level is set by the recorder account with its inputs, and every change
//! is logged. Nothing here can shorten, take back or burn someone's pass.

use std::collections::HashMap;

use near_contract_standards::non_fungible_token::approval::NonFungibleTokenApproval;
use near_contract_standards::non_fungible_token::core::{
    ext_nft_receiver, NonFungibleTokenCore, NonFungibleTokenResolver,
};
use near_contract_standards::non_fungible_token::enumeration::NonFungibleTokenEnumeration;
use near_contract_standards::non_fungible_token::events::NftMint;
use near_contract_standards::non_fungible_token::metadata::{
    NFTContractMetadata, NonFungibleTokenMetadataProvider, TokenMetadata,
};
use near_contract_standards::non_fungible_token::{
    refund_approved_account_ids, NonFungibleToken, Token, TokenId,
};
use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::{json, Value};
use near_sdk::store::LookupMap;
use near_sdk::{
    assert_one_yocto, env, ext_contract, is_promise_success, near, require, AccountId,
    BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, PromiseOrValue,
};

/// Version of this contract's code, shown in `get_config`.
const CONTRACT_VERSION: &str = "1.0.0";
const EVENT_STANDARD: &str = "eurekascout_pass";
const EVENT_VERSION: &str = "1.0.0";

const DAY_NS: u64 = 24 * 60 * 60 * 1_000_000_000;
/// Attached on top of the price for a new pass's storage. The contract keeps
/// what the pass's bytes cost plus `STORAGE_MARGIN_BYTES` (for later growth,
/// like a transfer to a new account) and refunds the rest.
pub const PASS_STORAGE_FEE: u128 = 15_000_000_000_000_000_000_000; // 0.015 NEAR
const STORAGE_MARGIN_BYTES: u64 = 500;
/// Lowest price floor `new` accepts: the scouts contract books payments of
/// 0.001 NEAR or more.
const MIN_FLOOR: u128 = 1_000_000_000_000_000_000_000;
const MAX_LEVELS: usize = 10;
const MAX_LEVEL_INPUTS_BYTES: usize = 280;
const MAX_NAME_BYTES: usize = 32;
const MAX_MEDIA_BYTES: usize = 100;
const MAX_TIER_BYTES: usize = 16;
/// Most passes one account's check looks through. Hiding a pass past this
/// would take 500 bought passes, all paying rent to the scout. The bot also
/// checks by pass (`pass_info`), which this doesn't limit.
const MAX_SCAN: usize = 500;

const GAS_DEPOSIT_RENT: Gas = Gas::from_tgas(15);
const GAS_ON_RENT: Gas = Gas::from_tgas(30);
const GAS_RESOLVE_TRANSFER: Gas = Gas::from_tgas(15);

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    OwnerById,
    TokenMetadata,
    Enumeration,
    Approval,
    Listings,
    Passes,
    Owed,
}

/// The most a 7-day and a 30-day pass can cost at one level (Rookie = 0).
#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct Level {
    pub name: String,
    pub max_7d: U128,
    pub max_30d: U128,
}

/// A pass length's name and picture, e.g. Bronze for 7 days.
#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct Tier {
    pub name: String,
    pub media: Option<String>,
}

/// One scout's passes for sale.
#[near(serializers = [borsh])]
pub struct Listing {
    name: String,
    tier_7d: Tier,
    tier_30d: Tier,
    level: u8,
    level_inputs: String,
    price_7d: u128,
    price_30d: u128,
    sales_open: bool,
    paid_passes: u64,
    renewals: u64,
    comp_passes: u64,
    rent_total: u128,
}

#[near(serializers = [borsh])]
pub struct Pass {
    scout_id: String,
    /// The tier's name when the pass was minted ("Bronze", "Silver").
    tier: String,
    /// Nanoseconds since the Unix epoch, by the chain's clock.
    expires_at: u64,
    comp: bool,
    paid_total: u128,
}

#[near(serializers = [json])]
pub struct PassView {
    pub token_id: TokenId,
    pub owner_id: AccountId,
    pub scout_id: String,
    pub tier: String,
    /// Nanoseconds since the Unix epoch.
    pub expires_at: U64,
    pub active: bool,
    pub comp: bool,
    pub paid_total: U128,
}

#[near(serializers = [json])]
pub struct ListingView {
    pub scout_id: String,
    pub name: String,
    /// The 7-day and 30-day passes' names and pictures.
    pub tier_7d: Tier,
    pub tier_30d: Tier,
    pub level: u8,
    pub level_name: String,
    pub level_inputs: String,
    /// What a pass costs now (the price, capped by the level).
    pub price_7d: U128,
    pub price_30d: U128,
    /// What to attach to `buy_pass`: the price plus the pass's storage.
    pub attach_7d: U128,
    pub attach_30d: U128,
    pub sales_open: bool,
    pub paid_passes: U64,
    pub renewals: U64,
    pub comp_passes: U64,
    pub rent_total: U128,
}

#[near(serializers = [json])]
pub struct ConfigView {
    pub version: String,
    pub owner_id: AccountId,
    pub scouts_contract: AccountId,
    pub recorder_id: AccountId,
    pub min_price: U128,
    pub levels: Vec<Level>,
    pub pass_storage_fee: U128,
    pub transfers_open: bool,
    pub passes_minted: U64,
    pub total_owed: U128,
}

/// NEP-199 payout.
#[near(serializers = [json])]
pub struct Payout {
    pub payout: HashMap<AccountId, U128>,
}

#[ext_contract(ext_scouts)]
#[allow(dead_code)]
trait Scouts {
    fn deposit_rent(&mut self, scout_id: String);
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    owner_id: AccountId,
    scouts_contract: AccountId,
    recorder_id: AccountId,
    min_price: u128,
    levels: Vec<Level>,
    transfers_open: bool,
    next_id: u64,
    total_owed: u128,
    /// Change held for purchases whose callback hasn't run yet; never used
    /// for another buyer's refund.
    pending: u128,
    tokens: NonFungibleToken,
    metadata: NFTContractMetadata,
    listings: LookupMap<String, Listing>,
    passes: LookupMap<TokenId, Pass>,
    /// Refunds that couldn't be sent at once, for `claim_refund`.
    owed: LookupMap<AccountId, u128>,
}

#[near]
impl Contract {
    /// `min_price` is the floor for any pass; `levels[i]` caps the prices at
    /// level i. Amounts are yoctoNEAR.
    #[init]
    pub fn new(
        owner_id: AccountId,
        scouts_contract: AccountId,
        recorder_id: AccountId,
        metadata: NFTContractMetadata,
        min_price: U128,
        levels: Vec<Level>,
    ) -> Self {
        assert_deployer();
        metadata.assert_valid();
        require!(min_price.0 >= MIN_FLOOR, "The price floor must be at least 0.001 NEAR");
        require!(!levels.is_empty() && levels.len() <= MAX_LEVELS, "Give 1 to 10 levels");
        for l in &levels {
            require!(
                l.max_7d.0 >= min_price.0 && l.max_30d.0 >= min_price.0,
                "Every level's ceiling must be at or above the floor"
            );
            require!(l.name.len() <= MAX_NAME_BYTES, "A level name is too long");
        }
        Self {
            tokens: NonFungibleToken::new(
                StorageKey::OwnerById,
                owner_id.clone(),
                Some(StorageKey::TokenMetadata),
                Some(StorageKey::Enumeration),
                Some(StorageKey::Approval),
            ),
            owner_id,
            scouts_contract,
            recorder_id,
            min_price: min_price.0,
            levels,
            transfers_open: true,
            next_id: 0,
            total_owed: 0,
            pending: 0,
            metadata,
            listings: LookupMap::new(StorageKey::Listings),
            passes: LookupMap::new(StorageKey::Passes),
            owed: LookupMap::new(StorageKey::Owed),
        }
    }

    // ---------- Buying and renewing ----------

    /// Buys a 7- or 30-day pass for `scout_id`, for yourself or as a gift to
    /// `receiver_id`. Attach the price plus `PASS_STORAGE_FEE` (see
    /// `get_listing`); anything over, and the storage the pass doesn't use,
    /// is refunded.
    #[payable]
    pub fn buy_pass(
        &mut self,
        scout_id: String,
        days: u32,
        receiver_id: Option<AccountId>,
    ) -> Promise {
        let buyer = env::predecessor_account_id();
        let receiver = receiver_id.unwrap_or_else(|| buyer.clone());
        let price = self.price_now(&scout_id, days);
        let attached = env::attached_deposit().as_yoctonear();
        let needed = price + PASS_STORAGE_FEE;
        require!(
            attached >= needed,
            format!("Attach {needed} yoctoNEAR: the pass price plus {PASS_STORAGE_FEE} for its storage")
        );
        self.rent_then(buyer, scout_id, days, attached, price, Some(receiver), None)
    }

    /// Adds 7 or 30 days to a pass, from its expiry or from now if it has run
    /// out. Anyone can renew any pass: the days go to whoever holds it.
    #[payable]
    pub fn renew(&mut self, token_id: TokenId, days: u32) -> Promise {
        let scout_id = self
            .passes
            .get(&token_id)
            .unwrap_or_else(|| env::panic_str("Pass not found"))
            .scout_id
            .clone();
        let price = self.price_now(&scout_id, days);
        let attached = env::attached_deposit().as_yoctonear();
        require!(attached >= price, format!("Attach {price} yoctoNEAR to renew"));
        let payer = env::predecessor_account_id();
        self.rent_then(payer, scout_id, days, attached, price, None, Some(token_id))
    }

    /// Callback after the rent was paid into the scout. Mints or extends the
    /// pass and refunds any change; if the rent didn't go through, refunds
    /// everything and makes no pass.
    #[private]
    #[allow(clippy::too_many_arguments)]
    pub fn on_rent(
        &mut self,
        payer: AccountId,
        scout_id: String,
        days: u32,
        attached: U128,
        price: U128,
        receiver_id: Option<AccountId>,
        token_id: Option<TokenId>,
    ) -> Option<PassView> {
        let held = attached.0 - price.0;
        self.pending = self.pending.saturating_sub(held);
        if !is_promise_success() {
            // The rent comes back to this contract; return all of it.
            self.refund(&payer, attached.0, held);
            emit(
                "purchase_refunded",
                json!({ "payer": payer, "scout_id": scout_id, "amount": attached }),
            );
            return None;
        }
        let now = env::block_timestamp();
        let (id, change) = match token_id {
            None => {
                let receiver = receiver_id.unwrap_or_else(|| payer.clone());
                let (id, kept) = self.mint_pass(&scout_id, &receiver, days, false, price.0, now);
                self.listing_mut(&scout_id).paid_passes += 1;
                (id, held - kept)
            }
            Some(id) => {
                self.extend_pass(&id, days, price.0, now);
                self.listing_mut(&scout_id).renewals += 1;
                (id, held)
            }
        };
        self.listing_mut(&scout_id).rent_total += price.0;
        if change > 0 {
            Promise::new(payer.clone()).transfer(NearToken::from_yoctonear(change)).detach();
        }
        let view = self.pass_info(id).unwrap();
        emit(
            "pass_paid",
            json!({
                "token_id": view.token_id,
                "owner_id": view.owner_id,
                "payer": payer,
                "scout_id": scout_id,
                "days": days,
                "price": price,
                "expires_at": view.expires_at,
            }),
        );
        Some(view)
    }

    /// Sends you a refund that couldn't be sent at once.
    pub fn claim_refund(&mut self) -> Promise {
        let who = env::predecessor_account_id();
        let amount = self.owed.get(&who).copied().unwrap_or(0);
        require!(amount > 0, "Nothing is owed to this account");
        require!(
            free_balance() >= self.total_owed + self.pending,
            "The refund hasn't arrived here yet. Try again in a minute"
        );
        self.owed.remove(&who);
        self.total_owed -= amount;
        emit("refund_claimed", json!({ "account_id": who, "amount": U128(amount) }));
        Promise::new(who).transfer(NearToken::from_yoctonear(amount))
    }

    // ---------- Owner ----------

    /// Owner only. Free pass for a founding renter: marked as a comp, no rent.
    /// Attach `PASS_STORAGE_FEE` for its storage.
    #[payable]
    pub fn mint_comp(&mut self, scout_id: String, receiver_id: AccountId, days: u32) -> PassView {
        self.assert_owner();
        require!(days == 7 || days == 30, "A pass is for 7 or 30 days");
        require!(self.listings.get(&scout_id).is_some(), "That scout isn't listed");
        let attached = env::attached_deposit().as_yoctonear();
        require!(
            attached >= PASS_STORAGE_FEE,
            format!("Attach {PASS_STORAGE_FEE} yoctoNEAR for the pass's storage")
        );
        let (id, kept) =
            self.mint_pass(&scout_id, &receiver_id, days, true, 0, env::block_timestamp());
        self.listing_mut(&scout_id).comp_passes += 1;
        if attached > kept {
            Promise::new(env::predecessor_account_id())
                .transfer(NearToken::from_yoctonear(attached - kept))
                .detach();
        }
        let view = self.pass_info(id).unwrap();
        emit(
            "comp_pass",
            json!({
                "token_id": view.token_id,
                "owner_id": view.owner_id,
                "scout_id": scout_id,
                "days": days,
                "expires_at": view.expires_at,
            }),
        );
        view
    }

    /// Owner only. Puts a scout's passes on sale. The scout must exist on the
    /// scouts contract, or every purchase is refunded.
    #[payable]
    pub fn add_scout(
        &mut self,
        scout_id: String,
        name: String,
        tier_7d: Tier,
        tier_30d: Tier,
        price_7d: U128,
        price_30d: U128,
    ) {
        assert_one_yocto();
        self.assert_owner();
        require!(self.listings.get(&scout_id).is_none(), "That scout is already listed");
        require!(!scout_id.is_empty() && scout_id.len() <= MAX_NAME_BYTES, "Bad scout ID");
        require!(!name.is_empty() && name.len() <= MAX_NAME_BYTES, "Bad name");
        check_tier(&tier_7d);
        check_tier(&tier_30d);
        self.check_prices(0, price_7d.0, price_30d.0);
        emit(
            "scout_listed",
            json!({ "scout_id": scout_id, "price_7d": price_7d, "price_30d": price_30d }),
        );
        self.listings.insert(
            scout_id,
            Listing {
                name,
                tier_7d,
                tier_30d,
                level: 0,
                level_inputs: String::new(),
                price_7d: price_7d.0,
                price_30d: price_30d.0,
                sales_open: true,
                paid_passes: 0,
                renewals: 0,
                comp_passes: 0,
                rent_total: 0,
            },
        );
    }

    /// Owner only. New names and pictures for the passes minted from now on
    /// (passes already minted keep theirs). Prices and rules don't change.
    #[payable]
    pub fn set_tiers(&mut self, scout_id: String, tier_7d: Tier, tier_30d: Tier) {
        assert_one_yocto();
        self.assert_owner();
        check_tier(&tier_7d);
        check_tier(&tier_30d);
        emit("tiers_set", json!({ "scout_id": scout_id, "tier_7d": tier_7d.name, "tier_30d": tier_30d.name }));
        let l = self.listing_mut(&scout_id);
        l.tier_7d = tier_7d;
        l.tier_30d = tier_30d;
    }

    /// Owner only. New prices, within the floor and the scout's level cap.
    #[payable]
    pub fn set_prices(&mut self, scout_id: String, price_7d: U128, price_30d: U128) {
        assert_one_yocto();
        self.assert_owner();
        let level = self.listing(&scout_id).level;
        self.check_prices(level, price_7d.0, price_30d.0);
        emit(
            "prices_set",
            json!({ "scout_id": scout_id, "price_7d": price_7d, "price_30d": price_30d }),
        );
        let l = self.listing_mut(&scout_id);
        l.price_7d = price_7d.0;
        l.price_30d = price_30d.0;
    }

    /// Owner only. Pauses or reopens new sales and renewals for a scout.
    /// Passes already sold keep working.
    #[payable]
    pub fn set_sales_open(&mut self, scout_id: String, open: bool) {
        assert_one_yocto();
        self.assert_owner();
        emit("sales_open_set", json!({ "scout_id": scout_id, "open": open }));
        self.listing_mut(&scout_id).sales_open = open;
    }

    /// Owner only. Pauses or reopens pass transfers (only if sharing becomes
    /// a problem). Passes keep working for whoever holds them.
    #[payable]
    pub fn set_transfers_open(&mut self, open: bool) {
        assert_one_yocto();
        self.assert_owner();
        emit("transfers_open_set", json!({ "open": open }));
        self.transfers_open = open;
    }

    /// The recorder only. Sets a scout's level with the inputs it came from,
    /// so anyone can recompute it from the receipts contract.
    pub fn set_level(&mut self, scout_id: String, level: u8, inputs: String) {
        require!(
            env::predecessor_account_id() == self.recorder_id,
            "Only the recorder sets levels"
        );
        require!((level as usize) < self.levels.len(), "No such level");
        require!(inputs.len() <= MAX_LEVEL_INPUTS_BYTES, "The level inputs are too long");
        emit(
            "level_set",
            json!({ "scout_id": scout_id, "level": level, "inputs": inputs }),
        );
        let l = self.listing_mut(&scout_id);
        l.level = level;
        l.level_inputs = inputs;
    }

    // ---------- NEP-199 payouts ----------

    pub fn nft_payout(&self, token_id: TokenId, balance: U128, max_len_payout: Option<u32>) -> Payout {
        if let Some(m) = max_len_payout {
            require!(m >= 1, "max_len_payout must be at least 1");
        }
        let owner = self
            .tokens
            .owner_by_id
            .get(&token_id)
            .unwrap_or_else(|| env::panic_str("Pass not found"));
        Payout { payout: HashMap::from([(owner, balance)]) }
    }

    #[payable]
    #[allow(clippy::too_many_arguments)]
    pub fn nft_transfer_payout(
        &mut self,
        receiver_id: AccountId,
        token_id: TokenId,
        approval_id: Option<u64>,
        memo: Option<String>,
        balance: U128,
        max_len_payout: Option<u32>,
    ) -> Payout {
        assert_one_yocto();
        self.assert_transfers_open();
        if let Some(m) = max_len_payout {
            require!(m >= 1, "max_len_payout must be at least 1");
        }
        let sender_id = env::predecessor_account_id();
        let (previous_owner, approvals) =
            self.tokens
                .internal_transfer(&sender_id, &receiver_id, &token_id, approval_id, memo);
        if let Some(a) = approvals
            && !a.is_empty()
        {
            refund_approved_account_ids(previous_owner.clone(), &a).detach();
        }
        Payout { payout: HashMap::from([(previous_owner, balance)]) }
    }

    // ---------- Views ----------

    /// The pass with the latest expiry that `account_id` holds now for
    /// `scout_id`, if it hasn't run out. This is the check the bot makes
    /// before every call it sends.
    pub fn active_pass(&self, account_id: AccountId, scout_id: String) -> Option<PassView> {
        let now = env::block_timestamp();
        let owned = self.tokens.tokens_per_owner.as_ref()?.get(&account_id)?;
        owned
            .iter()
            .take(MAX_SCAN)
            .filter_map(|id| {
                let p = self.passes.get(&id)?;
                (p.scout_id == scout_id && p.expires_at > now).then_some((p.expires_at, id))
            })
            .max()
            .and_then(|(_, id)| self.pass_info(id))
    }

    pub fn is_active(&self, account_id: AccountId, scout_id: String) -> bool {
        self.active_pass(account_id, scout_id).is_some()
    }

    pub fn pass_info(&self, token_id: TokenId) -> Option<PassView> {
        let p = self.passes.get(&token_id)?;
        let owner_id = self.tokens.owner_by_id.get(&token_id)?;
        Some(PassView {
            owner_id,
            scout_id: p.scout_id.clone(),
            tier: p.tier.clone(),
            expires_at: U64(p.expires_at),
            active: p.expires_at > env::block_timestamp(),
            comp: p.comp,
            paid_total: U128(p.paid_total),
            token_id,
        })
    }

    pub fn get_listing(&self, scout_id: String) -> Option<ListingView> {
        let l = self.listings.get(&scout_id)?;
        let cap = &self.levels[l.level as usize];
        let p7 = l.price_7d.min(cap.max_7d.0);
        let p30 = l.price_30d.min(cap.max_30d.0);
        Some(ListingView {
            name: l.name.clone(),
            tier_7d: l.tier_7d.clone(),
            tier_30d: l.tier_30d.clone(),
            level: l.level,
            level_name: cap.name.clone(),
            level_inputs: l.level_inputs.clone(),
            price_7d: U128(p7),
            price_30d: U128(p30),
            attach_7d: U128(p7 + PASS_STORAGE_FEE),
            attach_30d: U128(p30 + PASS_STORAGE_FEE),
            sales_open: l.sales_open,
            paid_passes: U64(l.paid_passes),
            renewals: U64(l.renewals),
            comp_passes: U64(l.comp_passes),
            rent_total: U128(l.rent_total),
            scout_id,
        })
    }

    pub fn owed_to(&self, account_id: AccountId) -> U128 {
        U128(self.owed.get(&account_id).copied().unwrap_or(0))
    }

    pub fn get_config(&self) -> ConfigView {
        ConfigView {
            version: CONTRACT_VERSION.to_string(),
            owner_id: self.owner_id.clone(),
            scouts_contract: self.scouts_contract.clone(),
            recorder_id: self.recorder_id.clone(),
            min_price: U128(self.min_price),
            levels: self.levels.clone(),
            pass_storage_fee: U128(PASS_STORAGE_FEE),
            transfers_open: self.transfers_open,
            passes_minted: U64(self.next_id),
            total_owed: U128(self.total_owed),
        }
    }
}

// ---------- Internal ----------

impl Contract {
    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner_id, "Owner only");
    }

    fn assert_transfers_open(&self) {
        require!(self.transfers_open, "Pass transfers are paused");
    }

    fn listing(&self, scout_id: &str) -> &Listing {
        self.listings
            .get(scout_id)
            .unwrap_or_else(|| env::panic_str("That scout isn't listed"))
    }

    fn listing_mut(&mut self, scout_id: &str) -> &mut Listing {
        self.listings
            .get_mut(scout_id)
            .unwrap_or_else(|| env::panic_str("That scout isn't listed"))
    }

    /// The price of a pass now: the set price, capped by the scout's level.
    fn price_now(&self, scout_id: &str, days: u32) -> u128 {
        let l = self.listing(scout_id);
        require!(l.sales_open, "Sales for this scout are paused");
        let cap = &self.levels[l.level as usize];
        match days {
            7 => l.price_7d.min(cap.max_7d.0),
            30 => l.price_30d.min(cap.max_30d.0),
            _ => env::panic_str("A pass is for 7 or 30 days"),
        }
    }

    fn check_prices(&self, level: u8, price_7d: u128, price_30d: u128) {
        let cap = &self.levels[level as usize];
        require!(
            price_7d >= self.min_price && price_30d >= self.min_price,
            "That's below the price floor"
        );
        require!(
            price_7d <= cap.max_7d.0 && price_30d <= cap.max_30d.0,
            "That's above the ceiling for the scout's level"
        );
    }

    #[allow(clippy::too_many_arguments)]
    fn rent_then(
        &mut self,
        payer: AccountId,
        scout_id: String,
        days: u32,
        attached: u128,
        price: u128,
        receiver_id: Option<AccountId>,
        token_id: Option<TokenId>,
    ) -> Promise {
        self.pending += attached - price;
        ext_scouts::ext(self.scouts_contract.clone())
            .with_attached_deposit(NearToken::from_yoctonear(price))
            .with_static_gas(GAS_DEPOSIT_RENT)
            .deposit_rent(scout_id.clone())
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_ON_RENT)
                    .on_rent(payer, scout_id, days, U128(attached), U128(price), receiver_id, token_id),
            )
    }

    fn mint_pass(
        &mut self,
        scout_id: &str,
        receiver: &AccountId,
        days: u32,
        comp: bool,
        paid: u128,
        now: u64,
    ) -> (TokenId, u128) {
        let before = env::storage_usage();
        self.next_id += 1;
        let token_id = self.next_id.to_string();
        let expires_at = now + days as u64 * DAY_NS;
        let (name, tier) = {
            let l = self.listing(scout_id);
            (l.name.clone(), if days == 7 { l.tier_7d.clone() } else { l.tier_30d.clone() })
        };
        let metadata = TokenMetadata {
            title: Some(format!("{name} {} Pass #{token_id}", tier.name)),
            description: None,
            media: tier.media,
            media_hash: None,
            copies: None,
            issued_at: Some(ms(now)),
            expires_at: Some(ms(expires_at)),
            starts_at: Some(ms(now)),
            updated_at: Some(ms(now)),
            extra: Some(json!({ "scout_id": scout_id, "tier": tier.name, "comp": comp }).to_string()),
            reference: None,
            reference_hash: None,
        };
        self.tokens
            .internal_mint_with_refund(token_id.clone(), receiver.clone(), Some(metadata), None);
        NftMint { owner_id: receiver, token_ids: &[&token_id], memo: None }.emit();
        self.passes.insert(
            token_id.clone(),
            Pass { scout_id: scout_id.to_string(), tier: tier.name, expires_at, comp, paid_total: paid },
        );
        // The pass record is only written at flush; write it now to count it.
        self.passes.flush();
        let used = env::storage_usage().saturating_sub(before) + STORAGE_MARGIN_BYTES;
        let kept = (env::storage_byte_cost().as_yoctonear() * used as u128).min(PASS_STORAGE_FEE);
        (token_id, kept)
    }

    fn extend_pass(&mut self, token_id: &TokenId, days: u32, paid: u128, now: u64) {
        let p = self
            .passes
            .get_mut(token_id)
            .unwrap_or_else(|| env::panic_str("Pass not found"));
        p.expires_at = p.expires_at.max(now) + days as u64 * DAY_NS;
        p.paid_total += paid;
        let expires_at = p.expires_at;
        if let Some(by_id) = self.tokens.token_metadata_by_id.as_mut()
            && let Some(mut m) = by_id.get(token_id)
        {
            m.expires_at = Some(ms(expires_at));
            m.updated_at = Some(ms(now));
            by_id.insert(token_id, &m);
        }
    }

    /// Refunds `amount` to `to`. `sure` of it is certainly in this contract
    /// already; the rest may still be on its way back. What can't be sent now
    /// is recorded for `claim_refund`.
    fn refund(&mut self, to: &AccountId, amount: u128, sure: u128) {
        let spare = free_balance().saturating_sub(self.total_owed).saturating_sub(self.pending);
        let now = if spare >= amount { amount } else { sure.min(amount) };
        if now > 0 {
            Promise::new(to.clone()).transfer(NearToken::from_yoctonear(now)).detach();
        }
        let later = amount - now;
        if later > 0 {
            *self.owed.entry(to.clone()).or_insert(0) += later;
            self.total_owed += later;
            emit("refund_owed", json!({ "account_id": to, "amount": U128(later) }));
        }
    }
}

fn check_tier(t: &Tier) {
    require!(!t.name.is_empty() && t.name.len() <= MAX_TIER_BYTES, "A tier name has 1 to 16 characters");
    require!(
        t.media.as_ref().is_none_or(|m| m.len() <= MAX_MEDIA_BYTES),
        "The media URL is too long"
    );
}

/// Init can only come from this account or its parent, in the deploy
/// transaction, so nobody else can set the contract up first.
fn assert_deployer() {
    let me = env::current_account_id();
    let caller = env::predecessor_account_id();
    let parent = me.as_str().split_once('.').map(|(_, p)| p);
    require!(
        caller == me || Some(caller.as_str()) == parent,
        "Only the deployer can set this contract up"
    );
}

/// This contract's balance not locked for its own storage.
fn free_balance() -> u128 {
    let locked = env::storage_byte_cost().as_yoctonear() * env::storage_usage() as u128;
    env::account_balance().as_yoctonear().saturating_sub(locked)
}

/// Nanoseconds to the NEP-177 format: Unix milliseconds as a string.
fn ms(ns: u64) -> String {
    (ns / 1_000_000).to_string()
}

fn emit(event: &str, data: Value) {
    let body = json!({
        "standard": EVENT_STANDARD,
        "version": EVENT_VERSION,
        "event": event,
        "data": [data],
    });
    env::log_str(&format!("EVENT_JSON:{body}"));
}

// ---------- NEP-171 / 177 / 178 / 181 ----------

#[near]
impl NonFungibleTokenCore for Contract {
    #[payable]
    fn nft_transfer(
        &mut self,
        receiver_id: AccountId,
        token_id: TokenId,
        approval_id: Option<u64>,
        memo: Option<String>,
    ) {
        self.assert_transfers_open();
        self.tokens.nft_transfer(receiver_id, token_id, approval_id, memo);
    }

    #[payable]
    fn nft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        token_id: TokenId,
        approval_id: Option<u64>,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<bool> {
        assert_one_yocto();
        self.assert_transfers_open();
        let sender_id = env::predecessor_account_id();
        let (old_owner, old_approvals) =
            self.tokens
                .internal_transfer(&sender_id, &receiver_id, &token_id, approval_id, memo);
        // The standard's flow, with more gas kept for the resolve step.
        ext_nft_receiver::ext(receiver_id.clone())
            .with_unused_gas_weight(1)
            .nft_on_transfer(sender_id, old_owner.clone(), token_id.clone(), msg)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_RESOLVE_TRANSFER)
                    .with_unused_gas_weight(0)
                    .nft_resolve_transfer(old_owner, receiver_id, token_id, old_approvals),
            )
            .into()
    }

    fn nft_token(&self, token_id: TokenId) -> Option<Token> {
        self.tokens.nft_token(token_id)
    }
}

#[near]
impl NonFungibleTokenResolver for Contract {
    #[private]
    fn nft_resolve_transfer(
        &mut self,
        previous_owner_id: AccountId,
        receiver_id: AccountId,
        token_id: TokenId,
        approved_account_ids: Option<HashMap<AccountId, u64>>,
    ) -> bool {
        self.tokens.nft_resolve_transfer(
            previous_owner_id,
            receiver_id,
            token_id,
            approved_account_ids,
        )
    }
}

#[near]
impl NonFungibleTokenApproval for Contract {
    #[payable]
    fn nft_approve(
        &mut self,
        token_id: TokenId,
        account_id: AccountId,
        msg: Option<String>,
    ) -> Option<Promise> {
        self.tokens.nft_approve(token_id, account_id, msg)
    }

    #[payable]
    fn nft_revoke(&mut self, token_id: TokenId, account_id: AccountId) {
        self.tokens.nft_revoke(token_id, account_id);
    }

    #[payable]
    fn nft_revoke_all(&mut self, token_id: TokenId) {
        self.tokens.nft_revoke_all(token_id);
    }

    fn nft_is_approved(
        &self,
        token_id: TokenId,
        approved_account_id: AccountId,
        approval_id: Option<u64>,
    ) -> bool {
        self.tokens.nft_is_approved(token_id, approved_account_id, approval_id)
    }
}

#[near]
impl NonFungibleTokenEnumeration for Contract {
    fn nft_total_supply(&self) -> U128 {
        self.tokens.nft_total_supply()
    }

    fn nft_tokens(&self, from_index: Option<U128>, limit: Option<u64>) -> Vec<Token> {
        self.tokens.nft_tokens(from_index, limit)
    }

    fn nft_supply_for_owner(&self, account_id: AccountId) -> U128 {
        self.tokens.nft_supply_for_owner(account_id)
    }

    fn nft_tokens_for_owner(
        &self,
        account_id: AccountId,
        from_index: Option<U128>,
        limit: Option<u64>,
    ) -> Vec<Token> {
        self.tokens.nft_tokens_for_owner(account_id, from_index, limit)
    }
}

#[near]
impl NonFungibleTokenMetadataProvider for Contract {
    fn nft_metadata(&self) -> NFTContractMetadata {
        self.metadata.clone()
    }
}

#[cfg(test)]
mod tests;
