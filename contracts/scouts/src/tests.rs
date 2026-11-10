//! Unit tests for the scouts contract, one per rule in the threat model.
//! Cross-contract calls don't run here: each test checks the books and the
//! receipts a call creates, then plays the callback with a chosen result.

use super::*;
use near_contract_standards::non_fungible_token::metadata::NFT_METADATA_SPEC;
use near_sdk::mock::MockAction;
use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
use near_sdk::{test_vm_config, testing_env, PromiseResult, RuntimeFeesConfig};

const NEAR: u128 = ONE_NEAR;
const T0: u64 = 1_793_491_200_000_000_000; // 2026-11-01 00:00 UTC
const DAY: u64 = DAY_NS;
const CODE: &[u8] = b"pretend this is the vault wasm";
const YOCTO: u128 = 1;
const PRICE: u128 = 5 * NEAR;

fn a(s: &str) -> AccountId {
    s.parse().unwrap()
}
fn me() -> AccountId {
    a("scouts.eurekascout.near")
}
fn owner() -> AccountId {
    a("eurekascout.near")
}
fn platform() -> AccountId {
    a("platform.near")
}
fn pass() -> AccountId {
    a("pass.eurekascout.near")
}
fn alice() -> AccountId {
    a("alice.near")
}
fn bob() -> AccountId {
    a("bob.near")
}
fn carol() -> AccountId {
    a("carol.near")
}
fn operator() -> AccountId {
    a("witty-ops.near")
}
fn api() -> AccountId {
    a("api.near")
}
fn recorder() -> AccountId {
    a("witty-recorder.near")
}
fn market() -> AccountId {
    a("market.near")
}
fn vault() -> AccountId {
    a("witty.scouts.eurekascout.near")
}
fn witty() -> String {
    "witty".to_string()
}
fn w(n: u32) -> TokenId {
    format!("witty-{n}")
}

fn set(pred: &AccountId, deposit: u128, ts: u64) {
    testing_env!(VMContextBuilder::new()
        .current_account_id(me())
        .predecessor_account_id(pred.clone())
        .signer_account_id(pred.clone())
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .account_balance(NearToken::from_near(100))
        .block_timestamp(ts)
        .build());
}

/// A callback, with the result of the call it waited for.
fn set_cb(ts: u64, result: PromiseResult) {
    testing_env!(
        VMContextBuilder::new()
            .current_account_id(me())
            .predecessor_account_id(me())
            .signer_account_id(me())
            .account_balance(NearToken::from_near(100))
            .block_timestamp(ts)
            .build(),
        test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        vec![result]
    );
}
fn ok() -> PromiseResult {
    PromiseResult::Successful(vec![])
}
fn failed() -> PromiseResult {
    PromiseResult::Failed
}

fn contract_meta() -> NFTContractMetadata {
    NFTContractMetadata {
        spec: NFT_METADATA_SPEC.to_string(),
        name: "EurekaScout Scouts".to_string(),
        symbol: "SCOUT".to_string(),
        icon: None,
        base_uri: None,
        reference: None,
        reference_hash: None,
    }
}

fn new_contract() -> Contract {
    set(&owner(), 0, T0);
    Contract::new(
        owner(),
        platform(),
        recorder(),
        Base58CryptoHash::from(env::sha256_array(CODE)),
        contract_meta(),
        vec![pass()],
    )
}

fn witty_spec() -> NewScout {
    NewScout {
        scout_id: witty(),
        name: "Witty the Scout".to_string(),
        media: Some("https://eurekascout.com/img/witty-nft.webp".to_string()),
        holder_bps: 7000,
        bills_bps: 1000,
        platform_bps: 2000,
        max_supply: 100,
        mint_price: U128(PRICE),
        mint_price_min: U128(NEAR),
        levels: witty_levels(),
        bills_cap: U128(2 * NEAR),
        payees: vec![api()],
        operator_id: Some(operator()),
    }
}

fn level_pic(level: &str) -> String {
    format!("https://eurekascout.com/img/nft-{level}.webp")
}

fn witty_levels() -> Vec<MintLevel> {
    vec![
        MintLevel { name: "Rookie".to_string(), max_price: U128(200 * NEAR), media: Some(level_pic("rookie")) },
        MintLevel { name: "Analyst".to_string(), max_price: U128(300 * NEAR), media: Some(level_pic("analyst")) },
        MintLevel { name: "Elite".to_string(), max_price: U128(500 * NEAR), media: None },
    ]
}

fn start_create(c: &mut Contract, spec: NewScout) {
    set(&owner(), NEAR, T0);
    let _ = c.create_scout(spec, Base64VecU8(CODE.to_vec()));
}

/// Witty created (70/10/20, 100 NFTs, 2 NEAR bills cap) with minting open.
fn ready() -> Contract {
    let mut c = new_contract();
    start_create(&mut c, witty_spec());
    set_cb(T0, ok());
    assert!(c.on_vault_created(witty(), U128(NEAR)));
    set(&owner(), YOCTO, T0);
    c.set_mint_open(witty(), true);
    c
}

fn mint_for(c: &mut Contract, who: &AccountId) -> EditionView {
    set(who, PRICE + NFT_STORAGE_FEE, T0);
    c.mint(witty(), None)
}

/// Witty with `n` NFTs: #1 alice, #2 bob, #3 carol, then alice again.
fn with_nfts(n: u32) -> Contract {
    let mut c = ready();
    for i in 0..n {
        let who = [alice(), bob(), carol()][(i % 3) as usize].clone();
        mint_for(&mut c, &who);
    }
    c
}

fn pay_rent(c: &mut Contract, amount: u128) {
    set(&pass(), amount, T0 + DAY);
    c.deposit_rent(witty());
}

fn scout(c: &Contract) -> ScoutView {
    c.get_scout(witty()).unwrap()
}
fn claimable(c: &Contract, id: &TokenId) -> u128 {
    c.edition_info(id.clone()).unwrap().claimable.0
}

/// The `send` call this call made to Witty's account: (receiver, amount).
fn vault_send() -> (AccountId, u128) {
    let r = get_created_receipts();
    let call = r
        .iter()
        .find(|r| r.receiver_id == vault() && matches!(&r.actions[0], MockAction::FunctionCallWeight { method_name, .. } if method_name == b"send"))
        .expect("no send to the vault");
    match &call.actions[0] {
        MockAction::FunctionCallWeight { args, .. } => {
            let v: Value = near_sdk::serde_json::from_slice(args).unwrap();
            (
                v["receiver_id"].as_str().unwrap().parse().unwrap(),
                v["amount"].as_str().unwrap().parse().unwrap(),
            )
        }
        _ => unreachable!(),
    }
}

fn transfers_to(who: &AccountId) -> Vec<u128> {
    get_created_receipts()
        .iter()
        .filter(|r| &r.receiver_id == who)
        .flat_map(|r| r.actions.iter())
        .filter_map(|x| match x {
            MockAction::Transfer { deposit, .. } => Some(deposit.as_yoctonear()),
            _ => None,
        })
        .collect()
}

// ---------- Creating Witty ----------

#[test]
fn creating_witty_makes_his_own_account_with_no_keys() {
    let mut c = new_contract();
    start_create(&mut c, witty_spec());
    let receipts = get_created_receipts();
    let create = receipts.iter().find(|r| r.receiver_id == vault()).unwrap();
    assert!(create.actions.iter().any(|x| matches!(x, MockAction::CreateAccount { .. })));
    assert!(create.actions.iter().any(
        |x| matches!(x, MockAction::DeployContract { code, .. } if code.as_slice() == CODE)
    ));
    // Nothing else: no access key is ever added to the scout's account.
    assert!(create.actions.iter().all(|x| matches!(
        x,
        MockAction::CreateAccount { .. } | MockAction::Transfer { .. } | MockAction::DeployContract { .. }
    )));
    assert!(!scout(&c).ready);
    set_cb(T0, ok());
    assert!(c.on_vault_created(witty(), U128(NEAR)));
    let s = scout(&c);
    assert!(s.ready && !s.mint_open);
    assert_eq!((s.max_supply, s.minted), (100, 0));
    assert_eq!((s.split.holder_bps, s.split.bills_bps, s.split.platform_bps), (7000, 1000, 2000));
    assert_eq!(c.nft_total_supply().0, 0);
}

#[test]
fn a_failed_account_creation_forgets_the_scout() {
    let mut c = new_contract();
    start_create(&mut c, witty_spec());
    set_cb(T0, failed());
    assert!(!c.on_vault_created(witty(), U128(NEAR)));
    assert!(c.get_scout(witty()).is_none());
    assert_eq!(transfers_to(&owner()), vec![NEAR]);
    start_create(&mut c, witty_spec());
}

#[test]
fn retry_create_finishes_a_scout_whose_callback_failed() {
    let mut c = new_contract();
    start_create(&mut c, witty_spec());
    set(&owner(), YOCTO, T0 + 10);
    let _ = c.retry_create(witty());
    set_cb(T0 + 10, failed());
    assert!(!c.on_vault_created(witty(), U128(0)));
    assert!(c.get_scout(witty()).is_some());
    set_cb(T0 + 20, PromiseResult::Successful(b"\"scouts.eurekascout.near\"".to_vec()));
    assert!(c.on_vault_created(witty(), U128(0)));
    assert!(scout(&c).ready);
    // A late first callback does nothing.
    set_cb(T0 + 30, ok());
    assert!(!c.on_vault_created(witty(), U128(NEAR)));
}

#[test]
#[should_panic(expected = "That isn't the vault code this contract was set up with")]
fn a_scout_s_account_only_gets_the_pinned_code() {
    let mut c = new_contract();
    set(&owner(), NEAR, T0);
    let _ = c.create_scout(witty_spec(), Base64VecU8(b"a vault with a back door".to_vec()));
}

#[test]
#[should_panic(expected = "Owner only")]
fn only_the_owner_creates_scouts() {
    let mut c = new_contract();
    set(&alice(), NEAR, T0);
    let _ = c.create_scout(witty_spec(), Base64VecU8(CODE.to_vec()));
}

#[test]
#[should_panic(expected = "That scout already exists")]
fn witty_is_created_once() {
    let mut c = ready();
    start_create(&mut c, witty_spec());
}

#[test]
#[should_panic(expected = "The split must add up to 10000 basis points")]
fn the_split_must_add_up() {
    let mut c = new_contract();
    start_create(&mut c, NewScout { platform_bps: 1000, ..witty_spec() });
}

#[test]
#[should_panic(expected = "Holders must get at least 50%")]
fn holders_get_at_least_half() {
    let mut c = new_contract();
    start_create(&mut c, NewScout { holder_bps: 4000, platform_bps: 5000, ..witty_spec() });
}

#[test]
#[should_panic(expected = "The mint price must be at least 0.001 NEAR, at least the min, and under the first level's cap")]
fn the_mint_price_has_a_floor() {
    let mut c = new_contract();
    start_create(&mut c, NewScout { mint_price: U128(1), mint_price_min: U128(1), ..witty_spec() });
}

#[test]
#[should_panic(expected = "for the scout's account")]
fn creating_needs_enough_for_the_account_s_storage() {
    let mut c = new_contract();
    set(&owner(), 1, T0);
    let _ = c.create_scout(witty_spec(), Base64VecU8(CODE.to_vec()));
}

#[test]
#[should_panic(expected = "This contract needs 0.05 NEAR of free balance to store a new scout")]
fn creating_checks_this_contract_can_store_the_scout() {
    let mut c = new_contract();
    testing_env!(VMContextBuilder::new()
        .current_account_id(me())
        .predecessor_account_id(owner())
        .attached_deposit(NearToken::from_near(1))
        .account_balance(NearToken::from_millinear(1020))
        .block_timestamp(T0)
        .build());
    let _ = c.create_scout(witty_spec(), Base64VecU8(CODE.to_vec()));
}

#[test]
#[should_panic(expected = "A scout ID uses only a-z, 0-9, - and _")]
fn scout_ids_must_make_an_account_name() {
    let mut c = new_contract();
    start_create(&mut c, NewScout { scout_id: "Witty.x".to_string(), ..witty_spec() });
}

// ---------- Minting ----------

#[test]
#[should_panic(expected = "Minting isn't open")]
fn nobody_mints_until_minting_opens() {
    let mut c = new_contract();
    start_create(&mut c, witty_spec());
    set_cb(T0, ok());
    c.on_vault_created(witty(), U128(NEAR));
    mint_for(&mut c, &alice());
}

#[test]
fn anyone_mints_and_the_mint_money_goes_to_witty_s_account() {
    let mut c = ready();
    let v = mint_for(&mut c, &alice());
    assert_eq!((v.token_id.as_str(), v.number, v.owner_id.clone()), ("witty-1", 1, alice()));
    // The mint price goes to Witty's account...
    let r = get_created_receipts();
    assert!(r.iter().any(|r| r.receiver_id == vault()
        && matches!(r.actions[0], MockAction::Transfer { deposit, .. } if deposit.as_yoctonear() == PRICE)));
    // ...booked to his bills and platform fee (1:2), never to holders.
    let s = scout(&c);
    assert_eq!(s.bills_balance.0, PRICE / 3);
    assert_eq!(s.platform_balance.0, PRICE - PRICE / 3);
    assert_eq!((s.holder_pool.0, s.mint_total.0, s.minted), (0, PRICE, 1));
    // Unused storage comes back.
    let back = transfers_to(&alice());
    assert_eq!(back.len(), 1);
    assert!(back[0] > 0 && back[0] < NFT_STORAGE_FEE);
    let m = c.nft_token(w(1)).unwrap().metadata.unwrap();
    assert_eq!(m.title.as_deref(), Some("Witty the Scout #1"));
    assert_eq!(m.copies, Some(100));
    assert_eq!(m.extra.as_deref(), Some(r#"{"scout_id":"witty","number":1,"level":"Rookie"}"#));
    assert_eq!(m.media.as_deref(), Some(level_pic("rookie").as_str()));
    assert!(get_logs().iter().any(|l| l.contains("nft_minted")));
}

#[test]
fn minting_numbers_nfts_in_order_and_can_be_a_gift() {
    let mut c = ready();
    mint_for(&mut c, &alice());
    set(&alice(), PRICE + NFT_STORAGE_FEE + NEAR, T0);
    let v = c.mint(witty(), Some(bob()));
    assert_eq!((v.token_id.as_str(), v.owner_id.clone()), ("witty-2", bob()));
    let back = transfers_to(&alice());
    assert!(back[0] > NEAR && back[0] < NEAR + NFT_STORAGE_FEE);
}

#[test]
#[should_panic(expected = "All of this scout's NFTs are minted")]
fn there_are_never_more_than_100() {
    let mut c = with_nfts(100);
    assert_eq!(scout(&c).minted, 100);
    mint_for(&mut c, &alice());
}

#[test]
#[should_panic(expected = "the mint price plus")]
fn minting_needs_the_price_and_the_storage() {
    let mut c = ready();
    set(&alice(), PRICE, T0);
    c.mint(witty(), None);
}

#[test]
#[should_panic(expected = "A scout NFT can't go to this contract or a scout's account")]
fn an_nft_cannot_be_minted_to_a_scout_s_account() {
    let mut c = ready();
    set(&alice(), PRICE + NFT_STORAGE_FEE, T0);
    c.mint(witty(), Some(vault()));
}

#[test]
fn the_storage_fee_covers_an_nft_minted_to_a_long_account() {
    let mut c = ready();
    let long: AccountId = format!("{}.near", "a".repeat(59)).parse().unwrap();
    let before = env::storage_usage();
    mint_for(&mut c, &long);
    let used = (env::storage_usage() - before) as u128 * env::storage_byte_cost().as_yoctonear();
    let kept = NFT_STORAGE_FEE - transfers_to(&long).iter().sum::<u128>();
    assert!(used <= kept, "kept {kept} for {used} of storage");
    assert!(used < NFT_STORAGE_FEE);
}

#[test]
fn the_owner_moves_the_price_only_within_its_range() {
    let mut c = ready();
    set(&owner(), YOCTO, T0);
    c.set_mint_price(witty(), U128(8 * NEAR));
    assert_eq!(scout(&c).attach_to_mint.0, 8 * NEAR + NFT_STORAGE_FEE);
}

#[test]
#[should_panic(expected = "The mint price must stay between the min and the cap for the scout's level")]
fn the_price_cannot_drop_to_nothing() {
    let mut c = ready();
    set(&owner(), YOCTO, T0);
    c.set_mint_price(witty(), U128(NEAR / 2));
}

#[test]
#[should_panic(expected = "The mint price must stay between the min and the cap for the scout's level")]
fn a_rookie_costs_at_most_200_near() {
    let mut c = ready();
    set(&owner(), YOCTO, T0);
    c.set_mint_price(witty(), U128(200 * NEAR + 1));
}

#[test]
#[should_panic(expected = "The mint price must be at least 0.001 NEAR, at least the min, and under the first level's cap")]
fn witty_can_t_launch_above_the_rookie_cap() {
    let mut c = new_contract();
    start_create(&mut c, NewScout { mint_price: U128(250 * NEAR), ..witty_spec() });
}

#[test]
fn the_record_sets_the_ceiling() {
    let mut c = ready();
    let s = scout(&c);
    assert_eq!((s.level, s.level_name.as_str(), s.levels.len()), (0, "Rookie", 3));
    // Analyst: the owner can now price up to 300 NEAR.
    set(&recorder(), 0, T0);
    c.set_level(witty(), 1, "60 calls, 1.21x per $1 after fees, receipts #1-#60".to_string());
    assert!(get_logs().iter().any(|l| l.contains("level_set") && l.contains("60 calls")));
    set(&owner(), YOCTO, T0);
    c.set_mint_price(witty(), U128(300 * NEAR));
    let s = scout(&c);
    assert_eq!((s.level_name.as_str(), s.mint_price.0), ("Analyst", 300 * NEAR));
    assert_eq!(s.attach_to_mint.0, 300 * NEAR + NFT_STORAGE_FEE);
    assert!(s.level_inputs.starts_with("60 calls"));
    // Back to Rookie: the price is held to the Rookie cap at once.
    set(&recorder(), 0, T0);
    c.set_level(witty(), 0, "recomputed".to_string());
    assert_eq!(scout(&c).mint_price.0, 200 * NEAR);
    set(&alice(), 200 * NEAR + NFT_STORAGE_FEE, T0);
    let v = c.mint(witty(), None);
    assert_eq!(v.number, 1);
    assert_eq!(scout(&c).mint_total.0, 200 * NEAR);
}

#[test]
fn every_nft_changes_picture_when_witty_levels_up() {
    let mut c = with_nfts(3);
    let pics = |c: &Contract| -> Vec<(String, String)> {
        let m = |t: Token| { let m = t.metadata.unwrap(); (m.media.unwrap(), m.extra.unwrap()) };
        let mut v = vec![m(c.nft_token(w(1)).unwrap())];
        v.extend(c.nft_tokens(None, None).into_iter().map(m));
        v.extend(c.nft_tokens_for_owner(bob(), None, None).into_iter().map(m));
        v
    };
    // Rookie: every view shows the Rookie picture and says so.
    assert!(pics(&c).iter().all(|(p, x)| *p == level_pic("rookie") && x.contains(r#""level":"Rookie""#)));
    // The recorder sets Analyst: every NFT, in every view, now shows the Analyst picture. Nobody touched the NFTs.
    set(&recorder(), 0, T0);
    c.set_level(witty(), 1, "31 official calls, $1.06 per $1 after fees".to_string());
    let p = pics(&c);
    assert_eq!(p.len(), 1 + 3 + 1);
    assert!(p.iter().all(|(pic, x)| *pic == level_pic("analyst") && x.contains(r#""level":"Analyst""#)));
    // A new NFT minted at Analyst shows Analyst too.
    let v = mint_for(&mut c, &carol());
    assert_eq!(c.nft_token(v.token_id).unwrap().metadata.unwrap().media.unwrap(), level_pic("analyst"));
    // A level with no picture keeps the one the NFT was minted with, but still names the level.
    set(&recorder(), 0, T0);
    c.set_level(witty(), 2, "test".to_string());
    let m = c.nft_token(w(1)).unwrap().metadata.unwrap();
    assert_eq!(m.media.as_deref(), Some("https://eurekascout.com/img/witty-nft.webp"));
    assert!(m.extra.unwrap().contains(r#""level":"Elite""#));
    // Back down to Rookie: the pictures go back with it.
    set(&recorder(), 0, T0);
    c.set_level(witty(), 0, "recomputed".to_string());
    assert!(pics(&c).iter().all(|(p, _)| *p == level_pic("rookie")));
    // A token that doesn't exist is still None.
    assert!(c.nft_token("witty-99".to_string()).is_none());
}

#[test]
#[should_panic(expected = "A level's media URL is too long")]
fn level_pictures_have_a_size_limit() {
    let mut c = new_contract();
    let mut levels = witty_levels();
    levels[1].media = Some(format!("https://eurekascout.com/{}", "x".repeat(90)));
    start_create(&mut c, NewScout { levels, ..witty_spec() });
}

#[test]
#[should_panic(expected = "Only the recorder sets levels")]
fn only_the_recorder_sets_the_level() {
    let mut c = ready();
    set(&owner(), 0, T0);
    c.set_level(witty(), 2, "trust me".to_string());
}

#[test]
#[should_panic(expected = "No such level")]
fn levels_must_exist() {
    let mut c = ready();
    set(&recorder(), 0, T0);
    c.set_level(witty(), 3, "".to_string());
}

#[test]
#[should_panic(expected = "Every level's cap must be between the min price and 10,000 NEAR")]
fn level_caps_have_limits() {
    let mut c = new_contract();
    let mut levels = witty_levels();
    levels[2].max_price = U128(20_000 * NEAR);
    start_create(&mut c, NewScout { levels, ..witty_spec() });
}

#[test]
#[should_panic(expected = "Owner only")]
fn only_the_owner_opens_minting() {
    let mut c = ready();
    set(&alice(), YOCTO, T0);
    c.set_mint_open(witty(), false);
}

// ---------- Rent in: 70% shared by the NFTs ----------

#[test]
fn rent_is_shared_equally_by_the_nfts() {
    let mut c = with_nfts(2);
    let bills_before = scout(&c).bills_balance.0;
    pay_rent(&mut c, 10 * NEAR);
    assert_eq!(claimable(&c, &w(1)), 35 * NEAR / 10);
    assert_eq!(claimable(&c, &w(2)), 35 * NEAR / 10);
    let s = scout(&c);
    assert_eq!(s.holder_pool.0, 7 * NEAR);
    assert_eq!(s.earned_per_nft.0, 35 * NEAR / 10);
    assert_eq!(s.bills_balance.0 - bills_before, NEAR);
    assert_eq!((s.rent_total.0, s.rent_count.0), (10 * NEAR, 1));
    let r = get_created_receipts();
    assert!(r.iter().any(|r| r.receiver_id == vault()
        && matches!(r.actions[0], MockAction::Transfer { deposit, .. } if deposit == NearToken::from_near(10))));
    assert!(get_logs()[0].contains("\"kind\":\"rent\""));
}

#[test]
fn shares_never_lose_a_yocto() {
    let mut c = with_nfts(3);
    pay_rent(&mut c, 1_000_000_000_000_000_000_000_007);
    let s = scout(&c);
    let shares: u128 = (1..=3).map(|n| claimable(&c, &w(n))).sum();
    assert_eq!(shares + s.undistributed.0, s.holder_pool.0);
    assert_eq!(s.holder_pool.0, 1_000_000_000_000_000_000_000_007u128 * 7 / 10);
    // The leftover is shared out with the next payment.
    pay_rent(&mut c, 3 * NEAR);
    let s = scout(&c);
    let shares: u128 = (1..=3).map(|n| claimable(&c, &w(n))).sum();
    assert_eq!(shares + s.undistributed.0, s.holder_pool.0);
}

#[test]
fn a_new_nft_shares_only_in_rent_paid_after_it_is_minted() {
    let mut c = with_nfts(1);
    pay_rent(&mut c, 10 * NEAR);
    mint_for(&mut c, &bob());
    assert_eq!(claimable(&c, &w(1)), 7 * NEAR);
    assert_eq!(claimable(&c, &w(2)), 0);
    pay_rent(&mut c, 10 * NEAR);
    assert_eq!(claimable(&c, &w(1)), 105 * NEAR / 10);
    assert_eq!(claimable(&c, &w(2)), 35 * NEAR / 10);
}

#[test]
#[should_panic(expected = "This scout has no NFTs yet")]
fn no_rent_before_the_first_nft_so_nobody_can_scoop_it() {
    // Rent kept for later would go to whoever mints first (in one transaction:
    // mint, then a dust payment). So until an NFT exists, rent is refused and
    // the pass contract refunds the renter.
    let mut c = ready();
    pay_rent(&mut c, 10 * NEAR);
}

#[test]
#[should_panic(expected = "This scout has no NFTs yet")]
fn no_sync_before_the_first_nft() {
    let mut c = ready();
    set(&bob(), 0, T0);
    let _ = c.sync_vault(witty());
}

#[test]
fn payments_from_anyone_else_count_as_other_income() {
    let mut c = with_nfts(1);
    set(&bob(), NEAR, T0);
    c.deposit_rent(witty());
    let s = scout(&c);
    assert_eq!((s.rent_total.0, s.other_total.0, s.other_count.0), (0, NEAR, 1));
    assert_eq!(claimable(&c, &w(1)), 7 * NEAR / 10);
}

#[test]
#[should_panic(expected = "Attach at least 0.001 NEAR")]
fn dust_payments_are_refused() {
    let mut c = ready();
    set(&bob(), 1, T0);
    c.deposit_rent(witty());
}

#[test]
#[should_panic(expected = "This scout isn't ready yet")]
fn no_rent_before_witty_s_account_exists() {
    let mut c = new_contract();
    start_create(&mut c, witty_spec());
    pay_rent(&mut c, NEAR);
}

#[test]
#[should_panic(expected = "Scout not found")]
fn no_rent_for_a_scout_that_does_not_exist() {
    let mut c = ready();
    set(&pass(), NEAR, T0);
    c.deposit_rent("fake-witty".to_string());
}

// ---------- Claims ----------

#[test]
fn a_holder_claims_from_witty_s_account() {
    let mut c = with_nfts(2);
    pay_rent(&mut c, 10 * NEAR);
    set(&alice(), YOCTO, T0 + 2 * DAY);
    let _ = c.claim(vec![w(1)]);
    assert_eq!(vault_send(), (alice(), 35 * NEAR / 10));
    assert_eq!(claimable(&c, &w(1)), 0);
    assert_eq!(claimable(&c, &w(2)), 35 * NEAR / 10);
    assert_eq!(scout(&c).holder_pool.0, 35 * NEAR / 10);
    set_cb(T0, ok());
    assert!(c.on_payout(witty(), Bucket::Holders, alice(), U128(35 * NEAR / 10), None, vec![(w(1), U128(35 * NEAR / 10))]));
    assert_eq!(scout(&c).holders_paid.0, 35 * NEAR / 10);
}

#[test]
fn a_holder_claims_several_nfts_at_once() {
    let mut c = with_nfts(4); // alice holds #1 and #4
    pay_rent(&mut c, 40 * NEAR);
    set(&alice(), YOCTO, T0);
    let _ = c.claim(vec![w(1), w(4)]);
    assert_eq!(vault_send(), (alice(), 14 * NEAR));
}

#[test]
#[should_panic(expected = "You can only claim for NFTs you hold")]
fn nobody_can_claim_someone_else_s_share() {
    let mut c = with_nfts(2);
    pay_rent(&mut c, 10 * NEAR);
    set(&alice(), YOCTO, T0);
    let _ = c.claim(vec![w(1), w(2)]);
}

#[test]
#[should_panic(expected = "You can only claim for NFTs you hold")]
fn the_owner_has_no_admin_withdrawal() {
    let mut c = with_nfts(2);
    pay_rent(&mut c, 10 * NEAR);
    set(&owner(), YOCTO, T0);
    let _ = c.claim(vec![w(1)]);
}

#[test]
#[should_panic(expected = "An NFT is listed twice")]
fn an_nft_is_claimed_once_per_call() {
    let mut c = with_nfts(1);
    pay_rent(&mut c, 10 * NEAR);
    set(&alice(), YOCTO, T0);
    let _ = c.claim(vec![w(1), w(1)]);
}

#[test]
#[should_panic(expected = "Nothing to claim")]
fn claiming_twice_gets_nothing_the_second_time() {
    let mut c = with_nfts(1);
    pay_rent(&mut c, 10 * NEAR);
    set(&alice(), YOCTO, T0);
    let _ = c.claim(vec![w(1)]);
    set(&alice(), YOCTO, T0);
    let _ = c.claim(vec![w(1)]);
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn a_claim_needs_a_full_access_key() {
    let mut c = with_nfts(1);
    pay_rent(&mut c, 10 * NEAR);
    set(&alice(), 0, T0);
    let _ = c.claim(vec![w(1)]);
}

#[test]
fn a_claim_cancels_a_live_listing() {
    let mut c = with_nfts(1);
    pay_rent(&mut c, 10 * NEAR);
    set(&alice(), NEAR / 100, T0);
    let _ = c.nft_approve(w(1), market(), None);
    assert!(c.nft_is_approved(w(1), market(), None));
    set(&alice(), YOCTO, T0);
    let _ = c.claim(vec![w(1)]);
    assert!(!c.nft_is_approved(w(1), market(), None));
    assert!(get_logs().iter().any(|l| l.contains("approvals_cleared")));
}

#[test]
#[should_panic(expected = "Sender not approved")]
fn the_marketplace_cannot_sell_after_a_claim() {
    let mut c = with_nfts(1);
    pay_rent(&mut c, 10 * NEAR);
    set(&alice(), NEAR / 100, T0);
    let _ = c.nft_approve(w(1), market(), None);
    set(&alice(), YOCTO, T0);
    let _ = c.claim(vec![w(1)]);
    set(&market(), YOCTO, T0);
    let _ = c.nft_transfer_payout(bob(), w(1), Some(1), None, U128(50 * NEAR), Some(10));
}

#[test]
fn a_failed_claim_goes_back_onto_the_nft() {
    let mut c = with_nfts(1);
    pay_rent(&mut c, 10 * NEAR);
    set(&alice(), YOCTO, T0);
    let _ = c.claim(vec![w(1)]);
    set_cb(T0, failed());
    assert!(!c.on_payout(witty(), Bucket::Holders, alice(), U128(7 * NEAR), None, vec![(w(1), U128(7 * NEAR))]));
    assert_eq!(claimable(&c, &w(1)), 7 * NEAR);
    let s = scout(&c);
    assert_eq!((s.holder_pool.0, s.holders_paid.0, s.in_flight.0), (7 * NEAR, 0, 0));
}

#[test]
fn sold_mid_claim_the_old_holder_gets_nothing_after_the_sale() {
    let mut c = with_nfts(1);
    pay_rent(&mut c, 10 * NEAR);
    set(&alice(), YOCTO, T0);
    let _ = c.claim(vec![w(1)]);
    set(&alice(), YOCTO, T0);
    c.nft_transfer(bob(), w(1), None, None);
    // The claim fails, so it goes back onto the NFT, which bob now holds.
    set_cb(T0, failed());
    c.on_payout(witty(), Bucket::Holders, alice(), U128(7 * NEAR), None, vec![(w(1), U128(7 * NEAR))]);
    set(&bob(), YOCTO, T0);
    let _ = c.claim(vec![w(1)]);
    assert_eq!(vault_send(), (bob(), 7 * NEAR));
}

#[test]
fn an_unclaimed_share_comes_with_the_nft_when_it_is_sold() {
    let mut c = with_nfts(1);
    pay_rent(&mut c, 10 * NEAR);
    set(&alice(), YOCTO, T0);
    c.nft_transfer(bob(), w(1), None, None);
    set(&bob(), YOCTO, T0);
    let _ = c.claim(vec![w(1)]);
    assert_eq!(vault_send(), (bob(), 7 * NEAR));
}

#[test]
fn a_late_failure_never_pays_a_share_twice() {
    let mut c = with_nfts(1);
    pay_rent(&mut c, 10 * NEAR);
    set(&alice(), YOCTO, T0);
    let _ = c.claim(vec![w(1)]); // claim A: 7 NEAR
    pay_rent(&mut c, 10 * NEAR);
    set(&alice(), YOCTO, T0);
    let _ = c.claim(vec![w(1)]); // claim B: 7 NEAR, before A settles
    set_cb(T0, failed());
    c.on_payout(witty(), Bucket::Holders, alice(), U128(7 * NEAR), None, vec![(w(1), U128(7 * NEAR))]);
    // Only claim A's 7 NEAR is back on the NFT.
    assert_eq!(claimable(&c, &w(1)), 7 * NEAR);
    assert_eq!(scout(&c).holder_pool.0, 7 * NEAR);
}

// ---------- Witty's bills ----------

#[test]
fn witty_pays_an_api_bill_within_his_cap() {
    let mut c = with_nfts(1);
    pay_rent(&mut c, 40 * NEAR);
    let before = scout(&c).bills_balance.0;
    set(&operator(), 0, T0 + DAY);
    let _ = c.pay_bill(witty(), api(), U128(15 * NEAR / 10), "data API, Nov".to_string());
    assert_eq!(vault_send(), (api(), 15 * NEAR / 10));
    let s = scout(&c);
    assert_eq!(before - s.bills_balance.0, 15 * NEAR / 10);
    assert_eq!(s.bills_spent_30d.0, 15 * NEAR / 10);
    assert_eq!(s.bills_left_30d.0, 5 * NEAR / 10);
    // Holders' shares are untouched.
    assert_eq!(claimable(&c, &w(1)), 28 * NEAR);
    assert!(get_logs().iter().any(|l| l.contains("bill_paid") && l.contains("data API, Nov")));
}

#[test]
#[should_panic(expected = "That's over the scout's bills cap for the last 30 days")]
fn a_bill_over_the_cap_is_refused() {
    let mut c = with_nfts(1);
    pay_rent(&mut c, 40 * NEAR);
    set(&operator(), 0, T0 + DAY);
    let _ = c.pay_bill(witty(), api(), U128(15 * NEAR / 10), "one".to_string());
    set(&operator(), 0, T0 + 20 * DAY);
    let _ = c.pay_bill(witty(), api(), U128(6 * NEAR / 10), "two".to_string());
}

#[test]
fn the_cap_rolls_over_30_days_after_the_day_ends() {
    let mut c = with_nfts(1);
    pay_rent(&mut c, 40 * NEAR);
    set(&operator(), 0, T0 + DAY + 5);
    let _ = c.pay_bill(witty(), api(), U128(2 * NEAR), "one".to_string());
    set(&operator(), 0, T0 + 32 * DAY - 1);
    assert_eq!(scout(&c).bills_left_30d.0, 0);
    set(&operator(), 0, T0 + 32 * DAY);
    let _ = c.pay_bill(witty(), api(), U128(2 * NEAR), "two".to_string());
    assert_eq!(c.get_bills(witty()).len(), 1);
}

#[test]
#[should_panic(expected = "That payee isn't on the scout's list")]
fn a_bill_to_an_unlisted_payee_is_refused() {
    let mut c = with_nfts(1);
    pay_rent(&mut c, 40 * NEAR);
    set(&operator(), 0, T0);
    let _ = c.pay_bill(witty(), operator(), U128(NEAR), "to myself".to_string());
}

#[test]
#[should_panic(expected = "Not enough in the scout's bills budget")]
fn bills_never_touch_holders_shares() {
    let mut c = ready();
    mint_for(&mut c, &alice()); // bills budget: a third of the mint price
    let budget = scout(&c).bills_balance.0;
    pay_rent(&mut c, 50 * NEAR); // holders: 35 NEAR
    set(&operator(), 0, T0);
    let _ = c.pay_bill(witty(), api(), U128(budget + 5 * NEAR + 1), "too much".to_string());
}

#[test]
#[should_panic(expected = "Only the scout's operator can pay its bills")]
fn only_the_operator_pays_bills() {
    let mut c = with_nfts(1);
    pay_rent(&mut c, 40 * NEAR);
    set(&owner(), 0, T0);
    let _ = c.pay_bill(witty(), api(), U128(NEAR), "x".to_string());
}

#[test]
#[should_panic(expected = "A bill must be at least 0.001 NEAR")]
fn dust_bills_are_refused() {
    let mut c = with_nfts(1);
    pay_rent(&mut c, 40 * NEAR);
    set(&operator(), 0, T0);
    let _ = c.pay_bill(witty(), api(), U128(1), "dust".to_string());
}

#[test]
#[should_panic(expected = "The memo is too long")]
fn a_bill_memo_has_a_limit() {
    let mut c = with_nfts(1);
    pay_rent(&mut c, 40 * NEAR);
    set(&operator(), 0, T0);
    let _ = c.pay_bill(witty(), api(), U128(NEAR), "x".repeat(141));
}

#[test]
fn a_failed_bill_restores_the_budget_and_the_cap() {
    let mut c = with_nfts(1);
    pay_rent(&mut c, 40 * NEAR);
    let before = scout(&c).bills_balance.0;
    let at = T0 + DAY;
    set(&operator(), 0, at);
    let _ = c.pay_bill(witty(), api(), U128(15 * NEAR / 10), "one".to_string());
    set_cb(at, failed());
    c.on_payout(witty(), Bucket::Bills, api(), U128(15 * NEAR / 10), Some(U64(at)), vec![]);
    let s = scout(&c);
    assert_eq!((s.bills_balance.0, s.bills_spent_30d.0, s.bills_paid.0), (before, 0, 0));
    set(&operator(), 0, at + 1);
    let _ = c.pay_bill(witty(), api(), U128(2 * NEAR), "retry".to_string());
}

#[test]
fn bills_are_kept_as_one_total_per_day() {
    let mut c = with_nfts(1);
    pay_rent(&mut c, 40 * NEAR);
    for i in 0..40 {
        set(&operator(), 0, T0 + DAY + i);
        let _ = c.pay_bill(witty(), api(), U128(NEAR / 100), format!("bill {i}"));
    }
    let bills = c.get_bills(witty());
    assert_eq!(bills.len(), 1);
    assert_eq!((bills[0].day.0, bills[0].amount.0), (T0 + DAY, 40 * NEAR / 100));
    set(&operator(), 0, T0 + DAY + 100);
    let _ = c.pay_bill(witty(), api(), U128(NEAR), "the real bill".to_string());
}

// ---------- Bills settings ----------

#[test]
fn the_owner_sets_payees_and_operator_and_can_lower_the_cap() {
    let mut c = ready();
    set(&owner(), YOCTO, T0);
    c.set_payees(witty(), vec![api(), a("rpc.near")]);
    set(&owner(), YOCTO, T0);
    c.set_operator(witty(), None);
    set(&owner(), YOCTO, T0);
    c.set_bills_cap(witty(), U128(NEAR));
    let s = scout(&c);
    assert_eq!(s.payees, vec![api(), a("rpc.near")]);
    assert_eq!(s.operator_id, None);
    assert_eq!((s.bills_cap.0, s.bills_cap_max.0), (NEAR, 2 * NEAR));
    set(&owner(), YOCTO, T0);
    c.set_bills_cap(witty(), U128(2 * NEAR));
}

#[test]
#[should_panic(expected = "The bills cap can't go above its maximum")]
fn the_cap_can_never_be_raised_above_2_near() {
    let mut c = ready();
    set(&owner(), YOCTO, T0);
    c.set_bills_cap(witty(), U128(2 * NEAR + 1));
}

#[test]
#[should_panic(expected = "Owner only")]
fn a_holder_cannot_change_the_payees() {
    let mut c = with_nfts(1);
    set(&alice(), YOCTO, T0);
    c.set_payees(witty(), vec![alice()]);
}

#[test]
#[should_panic(expected = "A payee can't be this contract or a scout's account")]
fn a_scout_s_account_cannot_be_a_payee() {
    let mut c = ready();
    set(&owner(), YOCTO, T0);
    c.set_payees(witty(), vec![api(), vault()]);
}

#[test]
#[should_panic(expected = "A payee is listed twice")]
fn payees_are_listed_once() {
    let mut c = ready();
    set(&owner(), YOCTO, T0);
    c.set_payees(witty(), vec![api(), api()]);
}

// ---------- Platform fee ----------

#[test]
fn the_platform_claims_its_fee_to_itself() {
    let mut c = with_nfts(1);
    let before = scout(&c).platform_balance.0;
    pay_rent(&mut c, 10 * NEAR);
    set(&platform(), YOCTO, T0);
    let _ = c.claim_platform_fee(witty());
    assert_eq!(vault_send(), (platform(), before + 2 * NEAR));
    assert_eq!(scout(&c).platform_balance.0, 0);
    assert_eq!(claimable(&c, &w(1)), 7 * NEAR);
    set_cb(T0, failed());
    c.on_payout(witty(), Bucket::Platform, platform(), U128(before + 2 * NEAR), None, vec![]);
    assert_eq!(scout(&c).platform_balance.0, before + 2 * NEAR);
}

#[test]
#[should_panic(expected = "Only the platform account can claim the platform fee")]
fn a_holder_cannot_claim_the_platform_fee() {
    let mut c = with_nfts(1);
    pay_rent(&mut c, 10 * NEAR);
    set(&alice(), YOCTO, T0);
    let _ = c.claim_platform_fee(witty());
}

// ---------- Tips sent straight to Witty's account ----------

fn report(free: u128) -> PromiseResult {
    PromiseResult::Successful(format!("\"{free}\"").into_bytes())
}

#[test]
fn a_tip_sent_straight_to_witty_s_account_is_booked_and_shared() {
    let mut c = with_nfts(1);
    pay_rent(&mut c, 10 * NEAR);
    let s = scout(&c);
    let books = s.holder_pool.0 + s.bills_balance.0 + s.platform_balance.0;
    set(&bob(), 0, T0);
    let _ = c.sync_vault(witty());
    set_cb(T0, report(books + 2 * NEAR + VAULT_MARGIN));
    assert_eq!(c.on_vault_report(witty(), U64(0), Ok(U128(books + 2 * NEAR + VAULT_MARGIN))).0, 2 * NEAR);
    assert_eq!(claimable(&c, &w(1)), 7 * NEAR + 14 * NEAR / 10);
    assert_eq!(scout(&c).other_total.0, 2 * NEAR);
    // Syncing again books nothing new.
    let s = scout(&c);
    let books = s.holder_pool.0 + s.bills_balance.0 + s.platform_balance.0;
    set_cb(T0, report(books + VAULT_MARGIN));
    assert_eq!(c.on_vault_report(witty(), U64(0), Ok(U128(books + VAULT_MARGIN))).0, 0);
}

#[test]
fn sync_books_nothing_if_a_payout_started_while_it_read_the_balance() {
    let mut c = with_nfts(1);
    pay_rent(&mut c, 10 * NEAR);
    let s = scout(&c);
    let books = s.holder_pool.0 + s.bills_balance.0 + s.platform_balance.0;
    set(&bob(), 0, T0);
    let _ = c.sync_vault(witty());
    set(&alice(), YOCTO, T0);
    let _ = c.claim(vec![w(1)]);
    set_cb(T0, ok());
    c.on_payout(witty(), Bucket::Holders, alice(), U128(7 * NEAR), None, vec![(w(1), U128(7 * NEAR))]);
    // The report was read before the 7 NEAR left: it must not be booked again.
    set_cb(T0, report(books + VAULT_MARGIN));
    assert_eq!(c.on_vault_report(witty(), U64(0), Ok(U128(books + VAULT_MARGIN))).0, 0);
    assert_eq!(scout(&c).holder_pool.0, 0);
    assert!(get_logs().iter().any(|l| l.contains("sync_skipped")));
}

#[test]
fn sync_books_a_tip_around_a_payout_that_is_on_its_way() {
    let mut c = with_nfts(1);
    pay_rent(&mut c, 10 * NEAR);
    set(&alice(), YOCTO, T0);
    let _ = c.claim(vec![w(1)]); // 7 NEAR on its way
    let s = scout(&c);
    let books = s.holder_pool.0 + s.bills_balance.0 + s.platform_balance.0;
    let nonce = 1; // one payout started
    set(&bob(), 0, T0);
    let _ = c.sync_vault(witty());
    // The 7 NEAR may still be in the account: it isn't booked as a tip.
    let free = books + 7 * NEAR + 2 * NEAR + VAULT_MARGIN;
    set_cb(T0, report(free));
    assert_eq!(c.on_vault_report(witty(), U64(nonce), Ok(U128(free))).0, 2 * NEAR);
    // If it already left, the tip is under-booked now and booked later.
    set_cb(T0, report(books + 2 * NEAR + VAULT_MARGIN));
    assert_eq!(c.on_vault_report(witty(), U64(nonce), Ok(U128(books + 2 * NEAR + VAULT_MARGIN))).0, 0);
}

#[test]
fn a_payout_that_settles_while_sync_reads_stops_the_booking() {
    let mut c = with_nfts(1);
    pay_rent(&mut c, 10 * NEAR);
    set(&alice(), YOCTO, T0);
    let _ = c.claim(vec![w(1)]);
    let s = scout(&c);
    let books = s.holder_pool.0 + s.bills_balance.0 + s.platform_balance.0;
    set(&bob(), 0, T0);
    let _ = c.sync_vault(witty()); // reads with the claim on its way (nonce 1)
    // The claim fails and goes back on the books before the report lands.
    set_cb(T0, failed());
    c.on_payout(witty(), Bucket::Holders, alice(), U128(7 * NEAR), None, vec![(w(1), U128(7 * NEAR))]);
    let free = books + 7 * NEAR + VAULT_MARGIN;
    set_cb(T0, report(free));
    assert_eq!(c.on_vault_report(witty(), U64(1), Ok(U128(free))).0, 0);
    assert_eq!(scout(&c).holder_pool.0, 7 * NEAR);
}

#[test]
fn sync_never_books_money_that_is_not_there() {
    let mut c = with_nfts(1);
    pay_rent(&mut c, 10 * NEAR);
    set_cb(T0, report(VAULT_MARGIN));
    assert_eq!(c.on_vault_report(witty(), U64(0), Ok(U128(VAULT_MARGIN))).0, 0);
    assert_eq!(c.on_vault_report(witty(), U64(0), Err(PromiseError::Failed)).0, 0);
    assert_eq!(claimable(&c, &w(1)), 7 * NEAR);
}

// ---------- Access and transfers ----------

#[test]
fn holding_a_witty_nft_is_access_and_it_moves_with_the_nft() {
    let mut c = with_nfts(1);
    assert_eq!(c.access(alice(), witty()).unwrap().token_id, w(1));
    assert!(c.access(bob(), witty()).is_none());
    set(&alice(), YOCTO, T0);
    c.nft_transfer(bob(), w(1), None, Some("sold".to_string()));
    assert!(c.access(alice(), witty()).is_none());
    assert_eq!(c.access(bob(), witty()).unwrap().owner_id, bob());
    assert!(c.access(bob(), "someone-else".to_string()).is_none());
}

#[test]
fn claimable_for_lists_an_account_s_nfts() {
    let mut c = with_nfts(4);
    pay_rent(&mut c, 40 * NEAR);
    let mine = c.claimable_for(alice(), witty());
    assert_eq!(mine.len(), 2);
    assert_eq!(mine.iter().map(|e| e.claimable.0).sum::<u128>(), 14 * NEAR);
}

#[test]
fn a_marketplace_sale_pays_the_seller_and_moves_the_nft() {
    let mut c = with_nfts(1);
    set(&alice(), NEAR / 100, T0);
    let _ = c.nft_approve(w(1), market(), None);
    set(&market(), YOCTO, T0);
    let p = c.nft_transfer_payout(bob(), w(1), Some(1), None, U128(50 * NEAR), Some(10));
    assert_eq!(p.payout.get(&alice()), Some(&U128(50 * NEAR)));
    assert_eq!(p.payout.len(), 1);
    assert_eq!(c.nft_token(w(1)).unwrap().owner_id, bob());
    assert_eq!(c.nft_payout(w(1), U128(10), None).payout.get(&bob()), Some(&U128(10)));
}

#[test]
fn a_returned_transfer_comes_back_without_approvals() {
    let mut c = with_nfts(1);
    set(&alice(), NEAR / 100, T0);
    let _ = c.nft_approve(w(1), market(), None);
    set(&alice(), YOCTO, T0);
    let _ = c.nft_transfer_call(a("game.near"), w(1), None, None, "".to_string());
    assert!(get_created_receipts().iter().any(|r| r.receiver_id == me()
        && r.actions.iter().any(|x| matches!(x, MockAction::FunctionCallWeight { method_name, prepaid_gas, .. }
            if method_name == b"nft_resolve_transfer" && *prepaid_gas == Gas::from_tgas(20)))));
    set_cb(T0, PromiseResult::Successful(b"true".to_vec()));
    let kept = c.nft_resolve_transfer(alice(), a("game.near"), w(1), Some(HashMap::from([(market(), 1)])));
    assert!(!kept);
    assert_eq!(c.nft_token(w(1)).unwrap().owner_id, alice());
    assert!(!c.nft_is_approved(w(1), market(), None));
}

#[test]
#[should_panic(expected = "Can't send a scout NFT to this contract or a scout's account")]
fn an_nft_cannot_be_sent_to_witty_s_account() {
    let mut c = with_nfts(1);
    set(&alice(), YOCTO, T0);
    c.nft_transfer(vault(), w(1), None, None);
}

#[test]
#[should_panic(expected = "Can't send a scout NFT to this contract or a scout's account")]
fn an_nft_cannot_be_sent_to_another_scout_s_account() {
    let mut c = with_nfts(1);
    set(&alice(), YOCTO, T0);
    c.nft_transfer(a("bob.scouts.eurekascout.near"), w(1), None, None);
}

// ---------- Setup ----------

#[test]
#[should_panic(expected = "Only the deployer can set this contract up")]
fn nobody_else_can_set_the_contract_up_first() {
    set(&a("attacker.near"), 0, T0);
    Contract::new(
        a("attacker.near"),
        a("attacker.near"),
        a("attacker.near"),
        Base58CryptoHash::from(env::sha256_array(b"a vault with a back door")),
        contract_meta(),
        vec![],
    );
}

#[test]
fn config_shows_the_pinned_vault_code_and_rent_sources() {
    let mut c = ready();
    let cfg = c.get_config();
    assert_eq!(cfg.vault_code_hash, Base58CryptoHash::from(env::sha256_array(CODE)));
    assert_eq!(cfg.rent_sources, vec![pass()]);
    assert_eq!(cfg.platform_id, platform());
    assert_eq!(cfg.recorder_id, recorder());
    set(&owner(), YOCTO, T0);
    c.add_rent_source(a("x402.eurekascout.near"));
    assert_eq!(c.get_config().rent_sources.len(), 2);
}

#[test]
#[should_panic(expected = "Owner only")]
fn only_the_owner_adds_rent_sources() {
    let mut c = ready();
    set(&alice(), YOCTO, T0);
    c.add_rent_source(alice());
}
