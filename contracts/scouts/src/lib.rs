//! Scout NFTs for EurekaScout (NEP-171, with metadata, approvals,
//! enumeration and payouts).
//!
//! Each scout is a collection of at most `max_supply` NFTs that anyone can
//! mint once minting opens. Witty is scout `witty`, 100 NFTs, `witty-1` to
//! `witty-100`. Holding one gives access to the scout's calls, and every NFT
//! earns an equal share of the holders' part of every payment into the scout.
//!
//! Each scout has a NEAR account of its own, for example
//! `witty.scouts.eurekascout.near`, created with the vault code and no access
//! keys. That account holds the scout's money; this contract keeps its books
//! and is the only account it obeys.
//!
//! Every payment into a scout (rent from the Rental Pass contract, a tip)
//! splits the same way, fixed when the scout is created (Witty: 70% holders,
//! 10% bills, 20% platform fee):
//! - the holders' 70% is shared equally by the NFTs that exist at that
//!   moment (so a scout takes no payments until its first NFT is minted).
//!   Each NFT's share stays with the NFT until its holder claims it, so it
//!   moves with the NFT when it's sold, and a claim cancels every
//!   marketplace approval on that NFT;
//! - the bills budget can only be paid out by the scout's operator, to payees
//!   on the scout's list, within a cap per rolling 30 days that can be
//!   lowered but never raised above the cap set at creation;
//! - the platform fee can only be claimed by the platform account, to itself.
//!
//! Mint money never goes to holders: it goes to the scout's own side (the
//! bills budget and the platform fee, in the split's ratio), so no holder is
//! ever paid by later minters. Holders earn only from payments into the scout.
//!
//! The mint price is capped by the scout's level (Witty: Rookie 200 NEAR,
//! Analyst 300 NEAR, Elite 500 NEAR), fixed at creation. The recorder account
//! sets the level with the inputs it came from, so anyone can recompute it
//! from the receipts contract; the owner sets the price under the cap.
//!
//! There is no admin withdrawal and no way to change a scout's split or its
//! supply. A payout comes off the books before it is sent and goes back on if
//! the transfer fails. NEAR sent straight to a scout's account is booked by
//! `sync_vault` and split like any payment.

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
use near_sdk::json_types::{Base58CryptoHash, Base64VecU8, U128, U64};
use near_sdk::serde_json::{json, Value};
use near_sdk::store::LookupMap;
use near_sdk::{
    assert_one_yocto, env, ext_contract, is_promise_success, near, require, AccountId,
    BorshStorageKey, CryptoHash, Gas, NearToken, PanicOnDefault, Promise, PromiseError,
    PromiseOrValue,
};

/// Version of this contract's code, shown in `get_config`.
const CONTRACT_VERSION: &str = "1.0.0";
const EVENT_STANDARD: &str = "eurekascout_scouts";
const EVENT_VERSION: &str = "1.0.0";

/// Basis points: 10,000 = 100%.
const BPS: u128 = 10_000;
/// Holders always get at least half of every payment.
const MIN_HOLDER_BPS: u16 = 5_000;
const ONE_NEAR: u128 = 1_000_000_000_000_000_000_000_000;
const DAY_NS: u64 = 24 * 60 * 60 * 1_000_000_000;
/// The bills cap counts what was paid in the last 30 days. Bills are kept as
/// one total per UTC day, and a day counts until 30 days after it ends.
const BILLS_WINDOW_NS: u64 = 30 * DAY_NS;
const MAX_BILLS_CAP: u128 = 100 * ONE_NEAR;
const MAX_PAYEES: usize = 10;
const MAX_RENT_SOURCES: usize = 10;
const MAX_MEMO_BYTES: usize = 140;
const MAX_NAME_BYTES: usize = 32;
const MAX_MEDIA_BYTES: usize = 100;
const MAX_LEVELS: usize = 10;
const MAX_LEVEL_INPUTS_BYTES: usize = 280;
const MAX_SUPPLY_LIMIT: u32 = 10_000;
/// Most NFTs one `claim` call takes.
const MAX_CLAIM: usize = 20;
/// Most NFTs an account's access check looks through.
const MAX_SCAN: usize = 500;
/// Smallest payment, bill or mint price this contract books (0.001 NEAR).
const MIN_PAYMENT: u128 = ONE_NEAR / 1_000;
/// Attached on top of the mint price for the NFT's storage. The contract
/// keeps what the NFT's bytes cost plus a margin and refunds the rest.
pub const NFT_STORAGE_FEE: u128 = 15_000_000_000_000_000_000_000; // 0.015 NEAR
/// Kept per NFT for later growth: a transfer to a new account, approvals.
const STORAGE_MARGIN_BYTES: u64 = 500;
/// Highest mint price a scout can be given (keeps the sums far from overflow).
const MAX_MINT_PRICE: u128 = 10_000 * ONE_NEAR;
/// Bytes on top of the vault code that its account needs (account record,
/// margin). The vault keeps no state.
const VAULT_EXTRA_BYTES: u128 = 2_000;
/// What `sync_vault` leaves unbooked in a scout's account, as headroom.
const VAULT_MARGIN: u128 = ONE_NEAR / 100;
/// Free balance this contract must keep to create a scout (its books).
const CREATE_RESERVE: u128 = ONE_NEAR / 20;

const GAS_VAULT_SEND: Gas = Gas::from_tgas(10);
const GAS_VAULT_REPORT: Gas = Gas::from_tgas(5);
const GAS_ON_PAYOUT: Gas = Gas::from_tgas(20);
const GAS_ON_REPORT: Gas = Gas::from_tgas(10);
const GAS_ON_VAULT_CREATED: Gas = Gas::from_tgas(15);
const GAS_RESOLVE_TRANSFER: Gas = Gas::from_tgas(20);

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    OwnerById,
    TokenMetadata,
    Enumeration,
    Approval,
    Scouts,
    Editions,
}

/// Which part of a scout's books a payout comes from.
#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Bucket {
    Holders,
    Bills,
    Platform,
}

/// One scout: its collection, its books and its settings.
#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct Scout {
    vault_id: AccountId,
    /// False until the scout's account exists.
    ready: bool,
    name: String,
    media: Option<String>,
    holder_bps: u16,
    bills_bps: u16,
    platform_bps: u16,
    max_supply: u32,
    minted: u32,
    mint_open: bool,
    /// The price the owner set. Minting charges it, capped by the level.
    mint_price: u128,
    mint_price_min: u128,
    /// The mint price cap at each level, fixed at creation.
    levels: Vec<MintLevel>,
    level: u8,
    level_inputs: String,
    /// What each NFT has earned since the scout was created, in yoctoNEAR.
    /// An NFT's unclaimed share is this minus its `paid_acc`.
    acc_per_nft: u128,
    /// Holders' rounding dust not yet shared out; shared with the next payment.
    undistributed: u128,
    /// Everything holders are owed: unclaimed shares plus `undistributed`.
    holder_pool: u128,
    bills_balance: u128,
    platform_balance: u128,
    /// The bills cap now, and the most it can ever be (set at creation).
    bills_cap: u128,
    bills_cap_max: u128,
    /// Bills that count against the cap: (UTC day number, total that day).
    bills_window: Vec<(u64, u128)>,
    payees: Vec<AccountId>,
    operator_id: Option<AccountId>,
    /// Payouts sent from the scout's account and not yet confirmed.
    in_flight: u128,
    /// Counts every payout started, so `sync_vault` can tell if one started
    /// while it was reading the account's balance.
    payout_nonce: u64,
    created_at: u64,
    rent_total: u128,
    rent_count: u64,
    other_total: u128,
    other_count: u64,
    mint_total: u128,
    holders_paid: u128,
    bills_paid: u128,
    platform_paid: u128,
}

/// One NFT of a scout's collection.
#[near(serializers = [borsh])]
pub struct Edition {
    scout_id: String,
    number: u32,
    /// The scout's `acc_per_nft` up to which this NFT has been paid.
    paid_acc: u128,
}

/// The most an NFT can cost to mint at one level (Rookie = 0).
#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct MintLevel {
    pub name: String,
    pub max_price: U128,
    /// The NFTs' picture while the scout is at this level. Wallets read it
    /// through `nft_token`, so every NFT changes picture when the level does.
    /// None keeps the picture the NFT was minted with.
    pub media: Option<String>,
}

#[near(serializers = [json])]
pub struct SplitView {
    pub holder_bps: u16,
    pub bills_bps: u16,
    pub platform_bps: u16,
}

/// A scout as the views return it. Amounts are yoctoNEAR, times nanoseconds.
#[near(serializers = [json])]
pub struct ScoutView {
    pub scout_id: String,
    pub name: String,
    pub vault_id: AccountId,
    pub ready: bool,
    pub split: SplitView,
    pub max_supply: u32,
    pub minted: u32,
    pub mint_open: bool,
    /// What minting costs now: the set price, capped by the level.
    pub mint_price: U128,
    /// What to attach to `mint`: the price plus the NFT's storage.
    pub attach_to_mint: U128,
    pub mint_price_min: U128,
    pub levels: Vec<MintLevel>,
    pub level: u8,
    pub level_name: String,
    pub level_inputs: String,
    /// What each NFT has earned since the scout was created.
    pub earned_per_nft: U128,
    /// Everything holders are owed now (unclaimed shares and undistributed).
    pub holder_pool: U128,
    pub undistributed: U128,
    pub bills_balance: U128,
    pub platform_balance: U128,
    pub bills_cap: U128,
    pub bills_cap_max: U128,
    pub bills_spent_30d: U128,
    /// What the operator could pay out now: the cap left, up to the budget.
    pub bills_left_30d: U128,
    pub payees: Vec<AccountId>,
    pub operator_id: Option<AccountId>,
    /// Payouts on their way out of the scout's account.
    pub in_flight: U128,
    pub created_at: U64,
    /// Payments from the rent sources (the Rental Pass contract).
    pub rent_total: U128,
    pub rent_count: U64,
    /// Payments from anyone else, and NEAR booked by `sync_vault`.
    pub other_total: U128,
    pub other_count: U64,
    /// Mint money (all of it went to bills and the platform fee).
    pub mint_total: U128,
    pub holders_paid: U128,
    pub bills_paid: U128,
    pub platform_paid: U128,
}

/// One NFT of a scout's collection.
#[near(serializers = [json])]
pub struct EditionView {
    pub token_id: TokenId,
    pub scout_id: String,
    pub number: u32,
    pub owner_id: AccountId,
    /// What its holder can claim now.
    pub claimable: U128,
}

/// Bills paid on one UTC day.
#[near(serializers = [json])]
pub struct BillView {
    /// Start of the day, nanoseconds since the Unix epoch.
    pub day: U64,
    pub amount: U128,
}

#[near(serializers = [json])]
pub struct ConfigView {
    pub version: String,
    pub owner_id: AccountId,
    pub platform_id: AccountId,
    pub recorder_id: AccountId,
    pub vault_code_hash: Base58CryptoHash,
    pub rent_sources: Vec<AccountId>,
    pub min_holder_bps: u16,
    pub bills_window_ns: U64,
    pub nft_storage_fee: U128,
}

/// What `create_scout` sets, all fixed except where noted.
#[near(serializers = [json])]
pub struct NewScout {
    pub scout_id: String,
    pub name: String,
    pub media: Option<String>,
    pub holder_bps: u16,
    pub bills_bps: u16,
    pub platform_bps: u16,
    pub max_supply: u32,
    /// The launch price. It can later move between the min and the cap of
    /// the scout's level (`set_mint_price`).
    pub mint_price: U128,
    pub mint_price_min: U128,
    /// Mint price caps by level, Rookie first. The scout starts at level 0.
    pub levels: Vec<MintLevel>,
    /// The bills cap can later be lowered, never raised above this.
    pub bills_cap: U128,
    pub payees: Vec<AccountId>,
    pub operator_id: Option<AccountId>,
}

/// NEP-199 payout.
#[near(serializers = [json])]
pub struct Payout {
    pub payout: HashMap<AccountId, U128>,
}

#[ext_contract(ext_vault)]
#[allow(dead_code)]
trait Vault {
    fn send(&self, receiver_id: AccountId, amount: U128) -> Promise;
    fn report(&self) -> U128;
    fn get_parent(&self) -> Option<AccountId>;
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    owner_id: AccountId,
    platform_id: AccountId,
    /// Sets scouts' levels (our server's recorder key).
    recorder_id: AccountId,
    vault_code_hash: CryptoHash,
    /// Accounts whose payments count as rent (the Rental Pass contract).
    rent_sources: Vec<AccountId>,
    tokens: NonFungibleToken,
    metadata: NFTContractMetadata,
    scouts: LookupMap<String, Scout>,
    editions: LookupMap<TokenId, Edition>,
}

#[near]
impl Contract {
    /// `vault_code_hash` pins the code every scout's account gets: the base58
    /// SHA-256 of the vault wasm, as NEAR shows it for an account's code.
    /// Only this account or its parent can call it (deploy and `new` go in
    /// one transaction).
    #[init]
    pub fn new(
        owner_id: AccountId,
        platform_id: AccountId,
        recorder_id: AccountId,
        vault_code_hash: Base58CryptoHash,
        metadata: NFTContractMetadata,
        rent_sources: Vec<AccountId>,
    ) -> Self {
        assert_deployer();
        metadata.assert_valid();
        require!(rent_sources.len() <= MAX_RENT_SOURCES, "Too many rent sources");
        Self {
            tokens: NonFungibleToken::new(
                StorageKey::OwnerById,
                owner_id.clone(),
                Some(StorageKey::TokenMetadata),
                Some(StorageKey::Enumeration),
                Some(StorageKey::Approval),
            ),
            owner_id,
            platform_id,
            recorder_id,
            vault_code_hash: vault_code_hash.into(),
            rent_sources,
            metadata,
            scouts: LookupMap::new(StorageKey::Scouts),
            editions: LookupMap::new(StorageKey::Editions),
        }
    }

    // ---------- Owner ----------

    /// Owner only. Creates a scout: its own account (`<scout_id>.<this
    /// contract>`) with the vault code and no access keys, and its
    /// collection, closed for minting until `set_mint_open`. The attached
    /// NEAR goes to the scout's account to pay for its storage. The split and
    /// the supply can't be changed after this.
    #[payable]
    pub fn create_scout(&mut self, scout: NewScout, vault_code: Base64VecU8) -> Promise {
        self.assert_owner();
        let NewScout {
            scout_id,
            name,
            media,
            holder_bps,
            bills_bps,
            platform_bps,
            max_supply,
            mint_price,
            mint_price_min,
            levels,
            bills_cap,
            payees,
            operator_id,
        } = scout;
        check_scout_id(&scout_id);
        require!(self.scouts.get(&scout_id).is_none(), "That scout already exists");
        require!(!name.is_empty() && name.len() <= MAX_NAME_BYTES, "Bad name");
        require!(
            media.as_ref().is_none_or(|m| m.len() <= MAX_MEDIA_BYTES),
            "The media URL is too long"
        );
        require!(
            holder_bps as u128 + bills_bps as u128 + platform_bps as u128 == BPS,
            "The split must add up to 10000 basis points"
        );
        require!(holder_bps >= MIN_HOLDER_BPS, "Holders must get at least 50%");
        require!(bills_bps + platform_bps > 0, "Mint money needs somewhere to go");
        require!((1..=MAX_SUPPLY_LIMIT).contains(&max_supply), "Bad supply");
        require!(!levels.is_empty() && levels.len() <= MAX_LEVELS, "Give 1 to 10 levels");
        for l in &levels {
            require!(!l.name.is_empty() && l.name.len() <= MAX_NAME_BYTES, "Bad level name");
            require!(
                l.media.as_ref().is_none_or(|m| m.len() <= MAX_MEDIA_BYTES),
                "A level's media URL is too long"
            );
            require!(
                mint_price_min.0 <= l.max_price.0 && l.max_price.0 <= MAX_MINT_PRICE,
                "Every level's cap must be between the min price and 10,000 NEAR"
            );
        }
        require!(
            MIN_PAYMENT <= mint_price_min.0
                && mint_price_min.0 <= mint_price.0
                && mint_price.0 <= levels[0].max_price.0,
            "The mint price must be at least 0.001 NEAR, at least the min, and under the first level's cap"
        );
        require!(bills_cap.0 <= MAX_BILLS_CAP, "The bills cap is too high");
        check_payees(&payees);
        if let Some(op) = &operator_id {
            require!(!is_ours(op), "The operator can't be this contract or a scout's account");
        }
        require!(
            env::sha256_array(&vault_code.0) == self.vault_code_hash,
            "That isn't the vault code this contract was set up with"
        );
        let deposit = env::attached_deposit();
        let needed = env::storage_byte_cost()
            .saturating_mul(vault_code.0.len() as u128 + VAULT_EXTRA_BYTES);
        require!(
            deposit >= needed,
            format!("Attach at least {} yoctoNEAR for the scout's account", needed.as_yoctonear())
        );
        require!(
            free_balance().saturating_sub(deposit.as_yoctonear()) >= CREATE_RESERVE,
            "This contract needs 0.05 NEAR of free balance to store a new scout"
        );
        let vault_id: AccountId = format!("{}.{}", scout_id, env::current_account_id())
            .parse()
            .unwrap_or_else(|_| env::panic_str("That scout ID doesn't make a valid account"));

        self.scouts.insert(
            scout_id.clone(),
            Scout {
                vault_id: vault_id.clone(),
                ready: false,
                name,
                media,
                holder_bps,
                bills_bps,
                platform_bps,
                max_supply,
                minted: 0,
                mint_open: false,
                mint_price: mint_price.0,
                mint_price_min: mint_price_min.0,
                levels,
                level: 0,
                level_inputs: String::new(),
                acc_per_nft: 0,
                undistributed: 0,
                holder_pool: 0,
                bills_balance: 0,
                platform_balance: 0,
                bills_cap: bills_cap.0,
                bills_cap_max: bills_cap.0,
                bills_window: Vec::new(),
                payees,
                operator_id,
                in_flight: 0,
                payout_nonce: 0,
                created_at: 0,
                rent_total: 0,
                rent_count: 0,
                other_total: 0,
                other_count: 0,
                mint_total: 0,
                holders_paid: 0,
                bills_paid: 0,
                platform_paid: 0,
            },
        );

        // No add_key action: the scout's account has no keys, ever.
        Promise::new(vault_id)
            .create_account()
            .transfer(deposit)
            .deploy_contract(vault_code.0)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_ON_VAULT_CREATED)
                    .on_vault_created(scout_id, U128(deposit.as_yoctonear())),
            )
    }

    /// Owner only. If a scout's account was created but the scout wasn't
    /// marked ready (the callback ran out of gas, say), checks the account
    /// exists and marks it ready.
    #[payable]
    pub fn retry_create(&mut self, scout_id: String) -> Promise {
        assert_one_yocto();
        self.assert_owner();
        let s = self.scout(&scout_id);
        require!(!s.ready, "That scout is already ready");
        ext_vault::ext(s.vault_id.clone())
            .with_static_gas(GAS_VAULT_REPORT)
            .get_parent()
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_ON_VAULT_CREATED)
                    .on_vault_created(scout_id, U128(0)),
            )
    }

    /// Callback after the scout's account is created (or, from
    /// `retry_create`, found). If the account couldn't be created, forgets
    /// the scout; a failed retry changes nothing.
    #[private]
    pub fn on_vault_created(&mut self, scout_id: String, deposit: U128) -> bool {
        let is_retry = deposit.0 == 0;
        if is_promise_success() {
            let Some(s) = self.scouts.get_mut(&scout_id).filter(|s| !s.ready) else {
                emit("scout_create_skipped", json!({ "scout_id": scout_id }));
                return false;
            };
            s.ready = true;
            s.created_at = env::block_timestamp();
            let vault_id = s.vault_id.clone();
            emit("scout_created", json!({ "scout_id": scout_id, "vault_id": vault_id }));
            true
        } else if is_retry {
            emit("scout_retry_failed", json!({ "scout_id": scout_id }));
            false
        } else {
            self.scouts.remove(&scout_id);
            // The deposit comes back to this contract; pass it on to the owner
            // if it is already here.
            let sent = free_balance() >= deposit.0;
            if sent {
                Promise::new(self.owner_id.clone())
                    .transfer(NearToken::from_yoctonear(deposit.0))
                    .detach();
            }
            emit(
                "scout_create_failed",
                json!({ "scout_id": scout_id, "deposit": deposit, "refunded": sent }),
            );
            false
        }
    }

    /// Owner only. Opens or closes minting.
    #[payable]
    pub fn set_mint_open(&mut self, scout_id: String, open: bool) {
        assert_one_yocto();
        self.assert_owner();
        emit("mint_open_set", json!({ "scout_id": scout_id, "open": open }));
        self.ready_scout_mut(&scout_id).mint_open = open;
    }

    /// Owner only. A new mint price, between the min and the cap of the
    /// scout's level now.
    #[payable]
    pub fn set_mint_price(&mut self, scout_id: String, mint_price: U128) {
        assert_one_yocto();
        self.assert_owner();
        let s = self.ready_scout_mut(&scout_id);
        let cap = s.levels[s.level as usize].max_price.0;
        require!(
            s.mint_price_min <= mint_price.0 && mint_price.0 <= cap,
            "The mint price must stay between the min and the cap for the scout's level"
        );
        s.mint_price = mint_price.0;
        emit("mint_price_set", json!({ "scout_id": scout_id, "mint_price": mint_price }));
    }

    /// The recorder only. Sets the scout's level with the inputs it came
    /// from, so anyone can recompute it. A lower level caps the mint price at
    /// once; a higher one lets the owner raise it.
    pub fn set_level(&mut self, scout_id: String, level: u8, inputs: String) {
        require!(
            env::predecessor_account_id() == self.recorder_id,
            "Only the recorder sets levels"
        );
        require!(inputs.len() <= MAX_LEVEL_INPUTS_BYTES, "The level inputs are too long");
        let s = self.ready_scout_mut(&scout_id);
        require!((level as usize) < s.levels.len(), "No such level");
        s.level = level;
        s.level_inputs = inputs.clone();
        emit("level_set", json!({ "scout_id": scout_id, "level": level, "inputs": inputs }));
    }

    /// Owner only. Who the scout may pay bills to (up to 10 accounts). Bills
    /// only ever come from the bills budget, never from holders' shares.
    #[payable]
    pub fn set_payees(&mut self, scout_id: String, payees: Vec<AccountId>) {
        assert_one_yocto();
        self.assert_owner();
        check_payees(&payees);
        emit("payees_set", json!({ "scout_id": scout_id, "payees": payees }));
        self.ready_scout_mut(&scout_id).payees = payees;
    }

    /// Owner only. The account allowed to call `pay_bill`, or none.
    #[payable]
    pub fn set_operator(&mut self, scout_id: String, operator_id: Option<AccountId>) {
        assert_one_yocto();
        self.assert_owner();
        if let Some(op) = &operator_id {
            require!(!is_ours(op), "The operator can't be this contract or a scout's account");
        }
        emit("operator_set", json!({ "scout_id": scout_id, "operator_id": operator_id }));
        self.ready_scout_mut(&scout_id).operator_id = operator_id;
    }

    /// Owner only. Sets the bills cap, never above the cap set at creation.
    #[payable]
    pub fn set_bills_cap(&mut self, scout_id: String, bills_cap: U128) {
        assert_one_yocto();
        self.assert_owner();
        let s = self.ready_scout_mut(&scout_id);
        require!(bills_cap.0 <= s.bills_cap_max, "The bills cap can't go above its maximum");
        s.bills_cap = bills_cap.0;
        emit("bills_cap_set", json!({ "scout_id": scout_id, "bills_cap": bills_cap }));
    }

    /// Owner only. Payments from these accounts count as rent in the stats.
    #[payable]
    pub fn add_rent_source(&mut self, account_id: AccountId) {
        assert_one_yocto();
        self.assert_owner();
        require!(!self.rent_sources.contains(&account_id), "Already a rent source");
        require!(self.rent_sources.len() < MAX_RENT_SOURCES, "Too many rent sources");
        emit("rent_source_added", json!({ "account_id": account_id }));
        self.rent_sources.push(account_id);
    }

    // ---------- Minting ----------

    /// Anyone, once minting is open. Mints the scout's next NFT to you (or to
    /// `receiver_id`). Attach the mint price plus `NFT_STORAGE_FEE` (see
    /// `get_scout`); anything over, and the storage the NFT doesn't use, is
    /// refunded. The mint money goes to the scout's own account, to its
    /// bills budget and platform fee. A new NFT shares in payments made from
    /// now on.
    #[payable]
    pub fn mint(&mut self, scout_id: String, receiver_id: Option<AccountId>) -> EditionView {
        let payer = env::predecessor_account_id();
        let receiver = receiver_id.unwrap_or_else(|| payer.clone());
        require!(!is_ours(&receiver), "A scout NFT can't go to this contract or a scout's account");
        let attached = env::attached_deposit().as_yoctonear();
        let (number, price, acc, name, media, max_supply, vault_id) = {
            let s = self.ready_scout_mut(&scout_id);
            require!(s.mint_open, "Minting isn't open");
            require!(s.minted < s.max_supply, "All of this scout's NFTs are minted");
            let price = price_now(s);
            let needed = price + NFT_STORAGE_FEE;
            require!(
                attached >= needed,
                format!("Attach {needed} yoctoNEAR: the mint price plus {NFT_STORAGE_FEE} for its storage")
            );
            s.minted += 1;
            // Mint money: to the scout's own side, in the split's ratio.
            let to_bills = price * s.bills_bps as u128 / (s.bills_bps as u128 + s.platform_bps as u128);
            s.bills_balance += to_bills;
            s.platform_balance += price - to_bills;
            s.mint_total += price;
            (
                s.minted,
                price,
                s.acc_per_nft,
                s.name.clone(),
                s.media.clone(),
                s.max_supply,
                s.vault_id.clone(),
            )
        };
        let token_id = format!("{scout_id}-{number}");
        let before = env::storage_usage();
        let now = env::block_timestamp();
        self.tokens.internal_mint_with_refund(
            token_id.clone(),
            receiver.clone(),
            Some(TokenMetadata {
                title: Some(format!("{name} #{number}")),
                media,
                copies: Some(max_supply as u64),
                issued_at: Some(ms(now)),
                extra: Some(json!({ "scout_id": scout_id, "number": number }).to_string()),
                ..Default::default()
            }),
            None,
        );
        NftMint { owner_id: &receiver, token_ids: &[&token_id], memo: None }.emit();
        // A new NFT is paid up to now: it shares in payments from now on.
        self.editions.insert(
            token_id.clone(),
            Edition { scout_id: scout_id.clone(), number, paid_acc: acc },
        );
        self.editions.flush();
        let used = env::storage_usage().saturating_sub(before) + STORAGE_MARGIN_BYTES;
        let kept = (env::storage_byte_cost().as_yoctonear() * used as u128).min(NFT_STORAGE_FEE);

        Promise::new(vault_id).transfer(NearToken::from_yoctonear(price)).detach();
        let change = attached - price - kept;
        if change > 0 {
            Promise::new(payer.clone()).transfer(NearToken::from_yoctonear(change)).detach();
        }
        emit(
            "nft_minted",
            json!({
                "scout_id": scout_id,
                "token_id": token_id,
                "owner_id": receiver,
                "payer": payer,
                "mint_price": U128(price),
            }),
        );
        self.edition_info(token_id).unwrap()
    }

    // ---------- Money in ----------

    /// Anyone can pay a scout. The attached NEAR is split by the scout's
    /// split and sent to the scout's own account. Payments from the rent
    /// sources count as rent; anything else counts as other income.
    #[payable]
    pub fn deposit_rent(&mut self, scout_id: String) {
        let amount = env::attached_deposit().as_yoctonear();
        require!(amount >= MIN_PAYMENT, "Attach at least 0.001 NEAR");
        let from = env::predecessor_account_id();
        let kind = if self.rent_sources.contains(&from) { "rent" } else { "other" };
        let vault_id = self.book_payment(&scout_id, amount, kind, &from);
        Promise::new(vault_id).transfer(NearToken::from_yoctonear(amount)).detach();
    }

    /// Anyone. Books NEAR that was sent straight to the scout's account (a
    /// tip, say) as other income, split like any payment. It reads the
    /// account's free balance; if a payout starts or settles while it reads,
    /// it books nothing and can simply be called again.
    pub fn sync_vault(&mut self, scout_id: String) -> Promise {
        let (vault_id, nonce) = {
            let s = self.ready_scout_mut(&scout_id);
            require!(s.minted > 0, "This scout has no NFTs yet");
            (s.vault_id.clone(), s.payout_nonce)
        };
        ext_vault::ext(vault_id).with_static_gas(GAS_VAULT_REPORT).report().then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_ON_REPORT)
                .on_vault_report(scout_id, U64(nonce)),
        )
    }

    /// Callback with the scout's account's free balance. Books what is more
    /// than the books, the payouts on their way (which may or may not have
    /// left yet) and a small margin. If any payout started or settled while
    /// the balance was read, it books nothing.
    #[private]
    pub fn on_vault_report(
        &mut self,
        scout_id: String,
        nonce: U64,
        #[callback_result] free: Result<U128, PromiseError>,
    ) -> U128 {
        let Ok(free) = free else { return U128(0) };
        let surplus = {
            let s = self.ready_scout_mut(&scout_id);
            if s.payout_nonce != nonce.0 {
                emit("sync_skipped", json!({ "scout_id": scout_id }));
                return U128(0);
            }
            let books = s.holder_pool + s.bills_balance + s.platform_balance;
            free.0
                .saturating_sub(books)
                .saturating_sub(s.in_flight)
                .saturating_sub(VAULT_MARGIN)
        };
        if surplus < MIN_PAYMENT {
            return U128(0);
        }
        let vault_id = self.scout(&scout_id).vault_id.clone();
        self.book_payment(&scout_id, surplus, "sync", &vault_id);
        U128(surplus)
    }

    // ---------- Money out ----------

    /// Holders (1 yoctoNEAR attached). Claims what your NFTs of one scout have
    /// earned (up to 20 NFTs per call), sent from the scout's account to you.
    /// A claim cancels every marketplace approval on the NFTs claimed.
    #[payable]
    pub fn claim(&mut self, token_ids: Vec<TokenId>) -> Promise {
        assert_one_yocto();
        require!(!token_ids.is_empty() && token_ids.len() <= MAX_CLAIM, "Claim 1 to 20 NFTs at a time");
        let caller = env::predecessor_account_id();
        let scout_id = self.edition(&token_ids[0]).scout_id.clone();
        let acc = self.scout(&scout_id).acc_per_nft;
        let mut parts: Vec<(TokenId, U128)> = Vec::new();
        for (i, id) in token_ids.iter().enumerate() {
            require!(!token_ids[..i].contains(id), "An NFT is listed twice");
            require!(
                self.tokens.owner_by_id.get(id).as_ref() == Some(&caller),
                "You can only claim for NFTs you hold"
            );
            let e = self
                .editions
                .get_mut(id)
                .unwrap_or_else(|| env::panic_str("Not a scout NFT"));
            require!(e.scout_id == scout_id, "Claim one scout's NFTs at a time");
            let owed = acc - e.paid_acc;
            e.paid_acc = acc;
            if owed > 0 {
                parts.push((id.clone(), U128(owed)));
            }
        }
        let total: u128 = parts.iter().map(|p| p.1.0).sum();
        require!(total > 0, "Nothing to claim");
        for (id, _) in &parts {
            self.clear_approvals(id, &caller);
        }
        self.ready_scout_mut(&scout_id).holder_pool -= total;
        emit(
            "claim",
            json!({ "scout_id": scout_id, "owner_id": caller, "amount": U128(total), "parts": parts }),
        );
        self.start_payout(scout_id, Bucket::Holders, caller, total, None, parts)
    }

    /// The scout's operator only. Pays a bill from the scout's bills budget to
    /// a payee on the scout's list, within the cap for the last 30 days. Never
    /// touches holders' shares.
    pub fn pay_bill(
        &mut self,
        scout_id: String,
        payee_id: AccountId,
        amount: U128,
        memo: String,
    ) -> Promise {
        require!(memo.len() <= MAX_MEMO_BYTES, "The memo is too long");
        let caller = env::predecessor_account_id();
        let now = env::block_timestamp();
        let today = now / DAY_NS;
        {
            let s = self.ready_scout_mut(&scout_id);
            require!(
                s.operator_id.as_ref() == Some(&caller),
                "Only the scout's operator can pay its bills"
            );
            require!(s.payees.contains(&payee_id), "That payee isn't on the scout's list");
            require!(amount.0 >= MIN_PAYMENT, "A bill must be at least 0.001 NEAR");
            require!(amount.0 <= s.bills_balance, "Not enough in the scout's bills budget");
            s.bills_window.retain(|b| day_counts(b.0, now));
            let spent: u128 = s.bills_window.iter().map(|b| b.1).sum();
            require!(
                spent + amount.0 <= s.bills_cap,
                "That's over the scout's bills cap for the last 30 days"
            );
            s.bills_balance -= amount.0;
            match s.bills_window.last_mut() {
                Some(last) if last.0 == today => last.1 += amount.0,
                _ => s.bills_window.push((today, amount.0)),
            }
        }
        emit(
            "bill_paid",
            json!({
                "scout_id": scout_id,
                "payee_id": payee_id,
                "amount": amount,
                "memo": memo,
                "operator_id": caller,
            }),
        );
        self.start_payout(scout_id, Bucket::Bills, payee_id, amount.0, Some(now), vec![])
    }

    /// The platform account only (1 yoctoNEAR attached). Sends the scout's
    /// platform fee balance to the platform account.
    #[payable]
    pub fn claim_platform_fee(&mut self, scout_id: String) -> Promise {
        assert_one_yocto();
        require!(
            env::predecessor_account_id() == self.platform_id,
            "Only the platform account can claim the platform fee"
        );
        let amt = {
            let s = self.ready_scout_mut(&scout_id);
            let amt = s.platform_balance;
            require!(amt > 0, "No platform fee to claim");
            s.platform_balance = 0;
            amt
        };
        let to = self.platform_id.clone();
        emit("platform_fee_claimed", json!({ "scout_id": scout_id, "amount": U128(amt) }));
        self.start_payout(scout_id, Bucket::Platform, to, amt, None, vec![])
    }

    /// Callback after the scout's account sends a payout. If the transfer
    /// failed, the amount goes back on the books: a claim goes back onto the
    /// NFTs it came from, for whoever holds them now.
    #[private]
    pub fn on_payout(
        &mut self,
        scout_id: String,
        bucket: Bucket,
        receiver_id: AccountId,
        amount: U128,
        bill_at: Option<U64>,
        parts: Vec<(TokenId, U128)>,
    ) -> bool {
        let ok = is_promise_success();
        let amt = amount.0;
        if !ok && bucket == Bucket::Holders {
            for (id, part) in &parts {
                if let Some(e) = self.editions.get_mut(id) {
                    e.paid_acc -= part.0;
                }
            }
        }
        let s = self
            .scouts
            .get_mut(&scout_id)
            .unwrap_or_else(|| env::panic_str("Scout not found"));
        s.in_flight = s.in_flight.saturating_sub(amt);
        // A settled payout changes the balance too: a sync reading across
        // it must not book.
        s.payout_nonce += 1;
        if ok {
            match bucket {
                Bucket::Holders => s.holders_paid += amt,
                Bucket::Bills => s.bills_paid += amt,
                Bucket::Platform => s.platform_paid += amt,
            }
        } else {
            match bucket {
                Bucket::Holders => s.holder_pool += amt,
                Bucket::Bills => {
                    s.bills_balance += amt;
                    // The failed bill no longer counts against the cap.
                    if let Some(at) = bill_at
                        && let Some(i) = s.bills_window.iter().position(|b| b.0 == at.0 / DAY_NS)
                    {
                        s.bills_window[i].1 = s.bills_window[i].1.saturating_sub(amt);
                        if s.bills_window[i].1 == 0 {
                            s.bills_window.remove(i);
                        }
                    }
                }
                Bucket::Platform => s.platform_balance += amt,
            }
        }
        emit(
            if ok { "payout_sent" } else { "payout_failed_restored" },
            json!({
                "scout_id": scout_id,
                "bucket": bucket,
                "receiver_id": receiver_id,
                "amount": amount,
            }),
        );
        ok
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
            .unwrap_or_else(|| env::panic_str("Token not found"));
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
        if let Some(m) = max_len_payout {
            require!(m >= 1, "max_len_payout must be at least 1");
        }
        check_receiver(&receiver_id);
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

    pub fn get_config(&self) -> ConfigView {
        ConfigView {
            version: CONTRACT_VERSION.to_string(),
            owner_id: self.owner_id.clone(),
            platform_id: self.platform_id.clone(),
            recorder_id: self.recorder_id.clone(),
            vault_code_hash: Base58CryptoHash::from(self.vault_code_hash),
            rent_sources: self.rent_sources.clone(),
            min_holder_bps: MIN_HOLDER_BPS,
            bills_window_ns: U64(BILLS_WINDOW_NS),
            nft_storage_fee: U128(NFT_STORAGE_FEE),
        }
    }

    pub fn get_scout(&self, scout_id: String) -> Option<ScoutView> {
        let s = self.scouts.get(&scout_id)?;
        let now = env::block_timestamp();
        let spent: u128 = s
            .bills_window
            .iter()
            .filter(|b| day_counts(b.0, now))
            .map(|b| b.1)
            .sum();
        let left = s.bills_cap.saturating_sub(spent).min(s.bills_balance);
        Some(ScoutView {
            scout_id,
            name: s.name.clone(),
            vault_id: s.vault_id.clone(),
            ready: s.ready,
            split: SplitView {
                holder_bps: s.holder_bps,
                bills_bps: s.bills_bps,
                platform_bps: s.platform_bps,
            },
            max_supply: s.max_supply,
            minted: s.minted,
            mint_open: s.mint_open,
            mint_price: U128(price_now(s)),
            attach_to_mint: U128(price_now(s) + NFT_STORAGE_FEE),
            mint_price_min: U128(s.mint_price_min),
            levels: s.levels.clone(),
            level: s.level,
            level_name: s.levels[s.level as usize].name.clone(),
            level_inputs: s.level_inputs.clone(),
            earned_per_nft: U128(s.acc_per_nft),
            holder_pool: U128(s.holder_pool),
            undistributed: U128(s.undistributed),
            bills_balance: U128(s.bills_balance),
            platform_balance: U128(s.platform_balance),
            bills_cap: U128(s.bills_cap),
            bills_cap_max: U128(s.bills_cap_max),
            bills_spent_30d: U128(spent),
            bills_left_30d: U128(left),
            payees: s.payees.clone(),
            operator_id: s.operator_id.clone(),
            in_flight: U128(s.in_flight),
            created_at: U64(s.created_at),
            rent_total: U128(s.rent_total),
            rent_count: U64(s.rent_count),
            other_total: U128(s.other_total),
            other_count: U64(s.other_count),
            mint_total: U128(s.mint_total),
            holders_paid: U128(s.holders_paid),
            bills_paid: U128(s.bills_paid),
            platform_paid: U128(s.platform_paid),
        })
    }

    pub fn edition_info(&self, token_id: TokenId) -> Option<EditionView> {
        let e = self.editions.get(&token_id)?;
        let s = self.scouts.get(&e.scout_id)?;
        Some(EditionView {
            owner_id: self.tokens.owner_by_id.get(&token_id)?,
            scout_id: e.scout_id.clone(),
            number: e.number,
            claimable: U128(s.acc_per_nft - e.paid_acc),
            token_id,
        })
    }

    /// The first NFT of `scout_id` that `account_id` holds now, if any: the
    /// check the bot makes for holders before every call it sends.
    pub fn access(&self, account_id: AccountId, scout_id: String) -> Option<EditionView> {
        let owned = self.tokens.tokens_per_owner.as_ref()?.get(&account_id)?;
        owned
            .iter()
            .take(MAX_SCAN)
            .find(|id| self.editions.get(id).is_some_and(|e| e.scout_id == scout_id))
            .and_then(|id| self.edition_info(id))
    }

    /// What `account_id`'s NFTs of `scout_id` can claim now, NFT by NFT.
    pub fn claimable_for(&self, account_id: AccountId, scout_id: String) -> Vec<EditionView> {
        let Some(owned) = self.tokens.tokens_per_owner.as_ref().and_then(|t| t.get(&account_id)) else {
            return vec![];
        };
        owned
            .iter()
            .take(MAX_SCAN)
            .filter(|id| self.editions.get(id).is_some_and(|e| e.scout_id == scout_id))
            .filter_map(|id| self.edition_info(id))
            .collect()
    }

    /// Bills that count against the cap now, one total per UTC day. Each bill
    /// is in the `bill_paid` events with its payee and memo.
    pub fn get_bills(&self, scout_id: String) -> Vec<BillView> {
        let now = env::block_timestamp();
        self.scouts
            .get(&scout_id)
            .map(|s| {
                s.bills_window
                    .iter()
                    .filter(|b| day_counts(b.0, now))
                    .map(|b| BillView { day: U64(b.0 * DAY_NS), amount: U128(b.1) })
                    .collect()
            })
            .unwrap_or_default()
    }
}

// ---------- Internal ----------

impl Contract {
    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner_id, "Owner only");
    }

    fn scout(&self, scout_id: &str) -> &Scout {
        self.scouts
            .get(scout_id)
            .unwrap_or_else(|| env::panic_str("Scout not found"))
    }

    fn ready_scout_mut(&mut self, scout_id: &str) -> &mut Scout {
        let s = self
            .scouts
            .get_mut(scout_id)
            .unwrap_or_else(|| env::panic_str("Scout not found"));
        require!(s.ready, "This scout isn't ready yet");
        s
    }

    fn edition(&self, token_id: &TokenId) -> &Edition {
        self.editions
            .get(token_id)
            .unwrap_or_else(|| env::panic_str("Not a scout NFT"))
    }

    /// Splits a payment by the scout's split and books it: the holders' part
    /// is shared equally by the NFTs that exist now. Returns the scout's
    /// account, where the NEAR goes (or already is).
    fn book_payment(&mut self, scout_id: &str, amount: u128, kind: &str, from: &AccountId) -> AccountId {
        let s = self.ready_scout_mut(scout_id);
        // With no NFTs there's nobody to share the holders' part with, and
        // keeping it for later would hand it all to whoever mints first.
        require!(s.minted > 0, "This scout has no NFTs yet");
        let holders = amount * s.holder_bps as u128 / BPS;
        let bills = amount * s.bills_bps as u128 / BPS;
        let platform = amount - holders - bills;
        s.holder_pool += holders;
        let to_share = s.undistributed + holders;
        let per_nft = to_share / s.minted as u128;
        s.acc_per_nft += per_nft;
        s.undistributed = to_share - per_nft * s.minted as u128;
        s.bills_balance += bills;
        s.platform_balance += platform;
        if kind == "rent" {
            s.rent_total += amount;
            s.rent_count += 1;
        } else {
            s.other_total += amount;
            s.other_count += 1;
        }
        let vault_id = s.vault_id.clone();
        emit(
            "payment",
            json!({
                "scout_id": scout_id,
                "from": from,
                "kind": kind,
                "amount": U128(amount),
                "holders": U128(holders),
                "bills": U128(bills),
                "platform": U128(platform),
            }),
        );
        vault_id
    }

    /// Marks the payout as on its way and asks the scout's account to send it.
    fn start_payout(
        &mut self,
        scout_id: String,
        bucket: Bucket,
        to: AccountId,
        amount: u128,
        bill_at: Option<u64>,
        parts: Vec<(TokenId, U128)>,
    ) -> Promise {
        let vault_id = {
            let s = self.ready_scout_mut(&scout_id);
            s.in_flight += amount;
            s.payout_nonce += 1;
            s.vault_id.clone()
        };
        ext_vault::ext(vault_id)
            .with_static_gas(GAS_VAULT_SEND)
            .send(to.clone(), U128(amount))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_ON_PAYOUT)
                    .on_payout(scout_id, bucket, to, U128(amount), bill_at.map(U64), parts),
            )
    }

    /// Cancels every marketplace approval on an NFT and returns their storage
    /// deposits to its holder.
    fn clear_approvals(&mut self, token_id: &TokenId, holder: &AccountId) {
        if let Some(by_id) = self.tokens.approvals_by_id.as_mut()
            && let Some(approvals) = by_id.remove(token_id)
            && !approvals.is_empty()
        {
            let accounts: Vec<&AccountId> = approvals.keys().collect();
            emit("approvals_cleared", json!({ "token_id": token_id, "account_ids": accounts }));
            refund_approved_account_ids(holder.clone(), &approvals).detach();
        }
    }
}

/// What minting costs now: the set price, capped by the scout's level.
fn price_now(s: &Scout) -> u128 {
    s.mint_price.min(s.levels[s.level as usize].max_price.0)
}

/// A scout NFT can't be sent to this contract or to any scout's account,
/// where nobody could ever move it again.
fn check_receiver(receiver_id: &AccountId) {
    require!(!is_ours(receiver_id), "Can't send a scout NFT to this contract or a scout's account");
}

/// This contract, or one of the scouts' accounts (`*.<this contract>`).
fn is_ours(account: &AccountId) -> bool {
    let me = env::current_account_id();
    account == &me
        || account
            .as_str()
            .strip_suffix(me.as_str())
            .is_some_and(|rest| rest.ends_with('.'))
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

fn check_scout_id(id: &str) {
    require!((2..=24).contains(&id.len()), "A scout ID has 2 to 24 characters");
    require!(
        id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_'),
        "A scout ID uses only a-z, 0-9, - and _"
    );
}

fn check_payees(payees: &[AccountId]) {
    require!(payees.len() <= MAX_PAYEES, "Too many payees");
    for (i, p) in payees.iter().enumerate() {
        require!(!payees[..i].contains(p), "A payee is listed twice");
        require!(!is_ours(p), "A payee can't be this contract or a scout's account");
    }
}

/// A day's bills count against the cap until 30 days after the day ends.
fn day_counts(day: u64, now: u64) -> bool {
    (day + 1).saturating_mul(DAY_NS).saturating_add(BILLS_WINDOW_NS) > now
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
        check_receiver(&receiver_id);
        self.tokens.nft_transfer(receiver_id, token_id, approval_id, memo);
    }

    /// The standard's `nft_transfer_call`, with more gas kept for the
    /// resolve step. While the receiver decides, it is the holder, including
    /// of the NFT's unclaimed share.
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
        check_receiver(&receiver_id);
        let sender_id = env::predecessor_account_id();
        let (old_owner, old_approvals) =
            self.tokens
                .internal_transfer(&sender_id, &receiver_id, &token_id, approval_id, memo);
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
        self.tokens.nft_token(token_id).map(|t| self.at_level(t))
    }
}

#[near]
impl NonFungibleTokenResolver for Contract {
    /// An NFT returned by `nft_on_transfer` comes back with no marketplace
    /// approvals: its unclaimed share may have been claimed while the
    /// receiver held it.
    #[private]
    fn nft_resolve_transfer(
        &mut self,
        previous_owner_id: AccountId,
        receiver_id: AccountId,
        token_id: TokenId,
        approved_account_ids: Option<HashMap<AccountId, u64>>,
    ) -> bool {
        if let Some(a) = approved_account_ids
            && !a.is_empty()
        {
            refund_approved_account_ids(previous_owner_id.clone(), &a).detach();
        }
        self.tokens.nft_resolve_transfer(previous_owner_id, receiver_id, token_id, None)
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
        self.tokens.nft_tokens(from_index, limit).into_iter().map(|t| self.at_level(t)).collect()
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
        self.tokens
            .nft_tokens_for_owner(account_id, from_index, limit)
            .into_iter()
            .map(|t| self.at_level(t))
            .collect()
    }
}

impl Contract {
    /// An NFT as wallets see it: with the picture for its scout's current
    /// level (when that level has one) and the level's name in `extra`. The
    /// level is set on chain by the recorder (`set_level`), so the picture
    /// follows the record with nobody touching the NFTs.
    fn at_level(&self, mut t: Token) -> Token {
        let Some(e) = self.editions.get(&t.token_id) else { return t };
        let Some(s) = self.scouts.get(&e.scout_id) else { return t };
        let Some(lvl) = s.levels.get(s.level as usize) else { return t };
        if let Some(m) = t.metadata.as_mut() {
            if let Some(media) = &lvl.media {
                m.media = Some(media.clone());
            }
            m.extra = Some(
                json!({ "scout_id": e.scout_id, "number": e.number, "level": lvl.name }).to_string(),
            );
        }
        t
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
