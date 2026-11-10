//! Unit tests for the Rental Pass contract, one per rule in the threat model.
//! Cross-contract calls don't run here: each test checks what a call sends,
//! then plays the callback with a chosen result.

use super::*;
use near_contract_standards::non_fungible_token::metadata::NFT_METADATA_SPEC;
use near_sdk::mock::MockAction;
use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
use near_sdk::{test_vm_config, testing_env, PromiseResult, RuntimeFeesConfig};

const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
const MILLI: u128 = NEAR / 1000;
const DAY: u64 = DAY_NS;
const T0: u64 = 1_794_700_800_000_000_000; // 2026-11-15 00:00 UTC
const YOCTO: u128 = 1;
const P7: u128 = 2 * NEAR;
const P30: u128 = 6 * NEAR;

fn a(s: &str) -> AccountId {
    s.parse().unwrap()
}
fn me() -> AccountId {
    a("pass.eurekascout.near")
}
fn owner() -> AccountId {
    a("eurekascout.near")
}
fn scouts() -> AccountId {
    a("scouts.eurekascout.near")
}
fn recorder() -> AccountId {
    a("witty-recorder.near")
}
fn renter() -> AccountId {
    a("renter.near")
}
fn friend() -> AccountId {
    a("friend.near")
}
fn founder() -> AccountId {
    a("founding-renter.near")
}
fn witty() -> String {
    "witty".to_string()
}

fn set_with_balance(pred: &AccountId, deposit: u128, ts: u64, balance: u128) {
    testing_env!(VMContextBuilder::new()
        .current_account_id(me())
        .predecessor_account_id(pred.clone())
        .signer_account_id(pred.clone())
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .account_balance(NearToken::from_yoctonear(balance))
        .block_timestamp(ts)
        .build());
}
fn set(pred: &AccountId, deposit: u128, ts: u64) {
    set_with_balance(pred, deposit, ts, 50 * NEAR);
}
fn set_cb_with_balance(ts: u64, result: PromiseResult, balance: u128) {
    testing_env!(
        VMContextBuilder::new()
            .current_account_id(me())
            .predecessor_account_id(me())
            .signer_account_id(me())
            .account_balance(NearToken::from_yoctonear(balance))
            .block_timestamp(ts)
            .build(),
        test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        vec![result]
    );
}
fn set_cb(ts: u64, result: PromiseResult) {
    set_cb_with_balance(ts, result, 50 * NEAR);
}
fn ok() -> PromiseResult {
    PromiseResult::Successful(vec![])
}
fn failed() -> PromiseResult {
    PromiseResult::Failed
}

fn bronze() -> Tier {
    Tier { name: "Bronze".to_string(), media: Some("https://eurekascout.com/img/pass-bronze.webp".to_string()) }
}
fn silver() -> Tier {
    Tier { name: "Silver".to_string(), media: Some("https://eurekascout.com/img/pass-silver.webp".to_string()) }
}

fn levels() -> Vec<Level> {
    vec![
        Level { name: "Rookie".to_string(), max_7d: U128(3 * NEAR), max_30d: U128(9 * NEAR) },
        Level { name: "Pro".to_string(), max_7d: U128(10 * NEAR), max_30d: U128(30 * NEAR) },
    ]
}

fn listed() -> Contract {
    set(&owner(), 0, T0);
    let mut c = Contract::new(
        owner(),
        scouts(),
        recorder(),
        NFTContractMetadata {
            spec: NFT_METADATA_SPEC.to_string(),
            name: "EurekaScout Rental Passes".to_string(),
            symbol: "PASS".to_string(),
            icon: None,
            base_uri: None,
            reference: None,
            reference_hash: None,
        },
        U128(NEAR / 2),
        levels(),
    );
    set(&owner(), YOCTO, T0);
    c.add_scout(witty(), "Witty".to_string(), bronze(), silver(), U128(P7), U128(P30));
    c
}

/// Buys a pass for `buyer` (or as a gift) and plays the callback.
fn buy(c: &mut Contract, buyer: &AccountId, days: u32, attach: u128, gift: Option<AccountId>, ts: u64) -> Option<PassView> {
    set(buyer, attach, ts);
    let price = if days == 7 { P7 } else { P30 };
    let _ = c.buy_pass(witty(), days, gift.clone());
    set_cb(ts, ok());
    c.on_rent(buyer.clone(), witty(), days, U128(attach), U128(price), Some(gift.unwrap_or(buyer.clone())), None)
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

// ---------- Buying ----------

#[test]
fn buying_sends_exactly_the_price_to_witty_and_mints_the_pass() {
    let mut c = listed();
    set(&renter(), P7 + PASS_STORAGE_FEE, T0);
    let _ = c.buy_pass(witty(), 7, None);
    // The rent goes to the scouts contract's deposit_rent for Witty.
    let r = get_created_receipts();
    let call = r.iter().find(|r| r.receiver_id == scouts()).unwrap();
    match &call.actions[0] {
        MockAction::FunctionCallWeight { method_name, args, attached_deposit, .. } => {
            assert_eq!(method_name, b"deposit_rent");
            assert_eq!(attached_deposit.as_yoctonear(), P7);
            let v: Value = near_sdk::serde_json::from_slice(args).unwrap();
            assert_eq!(v["scout_id"], "witty");
        }
        other => panic!("expected a function call, got {other:?}"),
    }
    // No pass until the rent is in.
    assert!(!c.is_active(renter(), witty()));

    set_cb(T0, ok());
    let v = c
        .on_rent(renter(), witty(), 7, U128(P7 + PASS_STORAGE_FEE), U128(P7), Some(renter()), None)
        .unwrap();
    assert_eq!(v.token_id, "1");
    assert_eq!(v.owner_id, renter());
    assert_eq!(v.expires_at.0, T0 + 7 * DAY);
    assert!(!v.comp);
    assert_eq!(v.paid_total.0, P7);
    // The storage the pass doesn't use comes back.
    let back = transfers_to(&renter());
    assert_eq!(back.len(), 1);
    assert!(back[0] > 0 && back[0] < PASS_STORAGE_FEE);
    let t = c.nft_token("1".to_string()).unwrap();
    let m = t.metadata.unwrap();
    assert_eq!(m.title.as_deref(), Some("Witty Bronze Pass #1"));
    assert_eq!(m.media.as_deref(), Some("https://eurekascout.com/img/pass-bronze.webp"));
    assert_eq!(v.tier, "Bronze");
    assert_eq!(m.expires_at, Some(((T0 + 7 * DAY) / 1_000_000).to_string()));
    assert_eq!(m.extra.as_deref(), Some(r#"{"scout_id":"witty","tier":"Bronze","comp":false}"#));
    let l = c.get_listing(witty()).unwrap();
    assert_eq!((l.paid_passes.0, l.rent_total.0, l.comp_passes.0), (1, P7, 0));
    assert!(get_logs().iter().any(|l| l.contains("pass_paid")));
}

#[test]
fn overpayment_is_refunded() {
    let mut c = listed();
    buy(&mut c, &renter(), 30, P30 + PASS_STORAGE_FEE + 3 * NEAR, None, T0).unwrap();
    let back = transfers_to(&renter());
    assert!(back[0] > 3 * NEAR && back[0] < 3 * NEAR + PASS_STORAGE_FEE);
}

#[test]
fn a_pass_can_be_a_gift() {
    let mut c = listed();
    let v = buy(&mut c, &renter(), 7, P7 + PASS_STORAGE_FEE + NEAR, Some(friend()), T0).unwrap();
    assert_eq!(v.owner_id, friend());
    assert!(c.is_active(friend(), witty()));
    assert!(!c.is_active(renter(), witty()));
    // The change goes back to whoever paid.
    let back = transfers_to(&renter());
    assert!(back[0] > NEAR && back[0] < NEAR + PASS_STORAGE_FEE);
    assert!(transfers_to(&friend()).is_empty());
}

#[test]
#[should_panic(expected = "the pass price plus")]
fn paying_too_little_is_refused() {
    let mut c = listed();
    set(&renter(), P7, T0);
    let _ = c.buy_pass(witty(), 7, None);
}

#[test]
#[should_panic(expected = "A pass is for 7 or 30 days")]
fn passes_are_for_7_or_30_days() {
    let mut c = listed();
    set(&renter(), 100 * NEAR, T0);
    let _ = c.buy_pass(witty(), 14, None);
}

#[test]
#[should_panic(expected = "That scout isn't listed")]
fn no_passes_for_an_unlisted_scout() {
    let mut c = listed();
    set(&renter(), 100 * NEAR, T0);
    let _ = c.buy_pass("fake-witty".to_string(), 7, None);
}

#[test]
#[should_panic(expected = "Sales for this scout are paused")]
fn paused_sales_take_no_money() {
    let mut c = listed();
    set(&owner(), YOCTO, T0);
    c.set_sales_open(witty(), false);
    set(&renter(), 100 * NEAR, T0);
    let _ = c.buy_pass(witty(), 7, None);
}

#[test]
fn a_failed_rent_forward_refunds_the_whole_purchase() {
    let mut c = listed();
    let attach = P7 + PASS_STORAGE_FEE + NEAR;
    set(&renter(), attach, T0);
    let _ = c.buy_pass(witty(), 7, None);
    set_cb(T0, failed());
    assert!(c.on_rent(renter(), witty(), 7, U128(attach), U128(P7), Some(renter()), None).is_none());
    assert_eq!(transfers_to(&renter()), vec![attach]);
    assert!(!c.is_active(renter(), witty()));
    assert!(c.nft_token("1".to_string()).is_none());
    assert_eq!(c.get_listing(witty()).unwrap().rent_total.0, 0);
}

#[test]
fn a_refund_that_has_not_arrived_yet_can_be_claimed() {
    let mut c = listed();
    let attach = P7 + PASS_STORAGE_FEE;
    // This contract holds little, and the bounced rent hasn't come back yet.
    set_cb_with_balance(T0, failed(), NEAR / 10);
    c.on_rent(renter(), witty(), 7, U128(attach), U128(P7), Some(renter()), None);
    // The part that is here goes back now; the rest is owed.
    assert_eq!(transfers_to(&renter()), vec![PASS_STORAGE_FEE]);
    assert_eq!(c.owed_to(renter()).0, P7);
    assert_eq!(c.get_config().total_owed.0, P7);
    // Once it's back, the renter claims it.
    set(&renter(), 0, T0 + 1);
    let _ = c.claim_refund();
    assert_eq!(transfers_to(&renter()), vec![P7]);
    assert_eq!(c.owed_to(renter()).0, 0);
}

#[test]
#[should_panic(expected = "Nothing is owed to this account")]
fn nobody_else_can_claim_a_refund() {
    let mut c = listed();
    set_cb_with_balance(T0, failed(), NEAR / 10);
    c.on_rent(renter(), witty(), 7, U128(P7 + PASS_STORAGE_FEE), U128(P7), Some(renter()), None);
    set(&friend(), 0, T0);
    let _ = c.claim_refund();
}

#[test]
fn the_storage_fee_covers_a_new_pass_and_the_rest_comes_back() {
    // Worst case: the longest scout ID, name and media URL, and a
    // 64-character account getting its first pass.
    set(&owner(), 0, T0);
    let mut c = listed();
    let long_id = "w".repeat(32);
    set(&owner(), YOCTO, T0);
    let long_tier = || Tier { name: "T".repeat(16), media: Some("m".repeat(100)) };
    c.add_scout(long_id.clone(), "N".repeat(32), long_tier(), long_tier(), U128(P7), U128(P30));
    let long: AccountId = format!("{}.near", "a".repeat(59)).parse().unwrap();
    set(&long, P30 + PASS_STORAGE_FEE, T0);
    let _ = c.buy_pass(long_id.clone(), 30, None);
    set_cb(T0, ok());
    let before = env::storage_usage();
    c.on_rent(long.clone(), long_id, 30, U128(P30 + PASS_STORAGE_FEE), U128(P30), Some(long.clone()), None);
    let byte = env::storage_byte_cost().as_yoctonear();
    let used = (env::storage_usage() - before) as u128;
    let kept = PASS_STORAGE_FEE - transfers_to(&long).iter().sum::<u128>();
    eprintln!("worst-case pass: {used} bytes; kept {kept} yoctoNEAR");
    assert!(used * byte <= kept, "the contract kept less than the pass's storage");
    assert!(kept <= (used + STORAGE_MARGIN_BYTES as u128) * byte);
    assert!(used * byte < PASS_STORAGE_FEE);
}

#[test]
#[should_panic(expected = "The media URL is too long")]
fn media_urls_have_a_limit() {
    let mut c = listed();
    set(&owner(), YOCTO, T0);
    c.add_scout("other".to_string(), "Other".to_string(), Tier { name: "Gold".to_string(), media: Some("m".repeat(101)) }, silver(), U128(P7), U128(P30));
}

// ---------- Expiry ----------

#[test]
fn a_pass_expires_on_time_and_stays_as_a_receipt() {
    let mut c = listed();
    buy(&mut c, &renter(), 7, P7 + PASS_STORAGE_FEE, None, T0);
    set(&renter(), 0, T0 + 7 * DAY - 1);
    assert!(c.is_active(renter(), witty()));
    set(&renter(), 0, T0 + 7 * DAY);
    assert!(!c.is_active(renter(), witty()));
    assert!(!c.pass_info("1".to_string()).unwrap().active);
    assert_eq!(c.nft_token("1".to_string()).unwrap().owner_id, renter());
}

#[test]
fn renewing_adds_days_to_the_same_pass() {
    let mut c = listed();
    buy(&mut c, &renter(), 7, P7 + PASS_STORAGE_FEE, None, T0);
    // Before it runs out: 30 more days on top of the expiry.
    set(&renter(), P30, T0 + 2 * DAY);
    let _ = c.renew("1".to_string(), 30);
    set_cb(T0 + 2 * DAY, ok());
    let v = c
        .on_rent(renter(), witty(), 30, U128(P30), U128(P30), None, Some("1".to_string()))
        .unwrap();
    assert_eq!(v.token_id, "1");
    assert_eq!(v.expires_at.0, T0 + 37 * DAY);
    assert_eq!(v.paid_total.0, P7 + P30);
    let m = c.nft_token("1".to_string()).unwrap().metadata.unwrap();
    assert_eq!(m.expires_at, Some(((T0 + 37 * DAY) / 1_000_000).to_string()));
    let l = c.get_listing(witty()).unwrap();
    assert_eq!((l.paid_passes.0, l.renewals.0, l.rent_total.0), (1, 1, P7 + P30));
    assert_eq!(c.nft_total_supply().0, 1);
}

#[test]
fn renewing_a_lapsed_pass_starts_from_now() {
    let mut c = listed();
    buy(&mut c, &renter(), 7, P7 + PASS_STORAGE_FEE, None, T0);
    let later = T0 + 20 * DAY;
    set(&renter(), P7, later);
    let _ = c.renew("1".to_string(), 7);
    set_cb(later, ok());
    let v = c.on_rent(renter(), witty(), 7, U128(P7), U128(P7), None, Some("1".to_string())).unwrap();
    assert_eq!(v.expires_at.0, later + 7 * DAY);
}

#[test]
fn renewing_a_pass_you_sold_is_a_gift_to_its_holder() {
    let mut c = listed();
    buy(&mut c, &renter(), 7, P7 + PASS_STORAGE_FEE, None, T0);
    set(&renter(), YOCTO, T0);
    c.nft_transfer(friend(), "1".to_string(), None, None);
    set(&renter(), P7, T0 + DAY);
    let _ = c.renew("1".to_string(), 7);
    set_cb(T0 + DAY, ok());
    let v = c.on_rent(renter(), witty(), 7, U128(P7), U128(P7), None, Some("1".to_string())).unwrap();
    assert_eq!(v.owner_id, friend());
    assert!(c.is_active(friend(), witty()));
    assert!(!c.is_active(renter(), witty()));
}

#[test]
fn a_failed_renewal_changes_nothing_and_refunds() {
    let mut c = listed();
    buy(&mut c, &renter(), 7, P7 + PASS_STORAGE_FEE, None, T0);
    set_cb(T0 + DAY, failed());
    assert!(c.on_rent(renter(), witty(), 7, U128(P7), U128(P7), None, Some("1".to_string())).is_none());
    assert_eq!(transfers_to(&renter()), vec![P7]);
    assert_eq!(c.pass_info("1".to_string()).unwrap().expires_at.0, T0 + 7 * DAY);
}

// ---------- Who holds the pass ----------

#[test]
fn after_a_pass_changes_hands_only_the_new_holder_is_active() {
    let mut c = listed();
    buy(&mut c, &renter(), 30, P30 + PASS_STORAGE_FEE, None, T0);
    set(&renter(), YOCTO, T0 + DAY);
    c.nft_transfer(friend(), "1".to_string(), None, None);
    assert!(c.is_active(friend(), witty()));
    assert!(!c.is_active(renter(), witty()));
    assert_eq!(c.pass_info("1".to_string()).unwrap().owner_id, friend());
}

#[test]
fn active_pass_picks_the_one_that_lasts_longest() {
    let mut c = listed();
    buy(&mut c, &renter(), 7, P7 + PASS_STORAGE_FEE, None, T0);
    buy(&mut c, &renter(), 30, P30 + PASS_STORAGE_FEE, None, T0);
    let v = c.active_pass(renter(), witty()).unwrap();
    assert_eq!(v.token_id, "2");
    assert!(c.active_pass(renter(), "someone-else".to_string()).is_none());
    assert!(c.active_pass(friend(), witty()).is_none());
}

#[test]
#[should_panic(expected = "Pass transfers are paused")]
fn transfers_can_be_paused_if_sharing_becomes_a_problem() {
    let mut c = listed();
    buy(&mut c, &renter(), 7, P7 + PASS_STORAGE_FEE, None, T0);
    set(&owner(), YOCTO, T0);
    c.set_transfers_open(false);
    // The pass still works for its holder...
    assert!(c.is_active(renter(), witty()));
    // ...but can't move.
    set(&renter(), YOCTO, T0);
    c.nft_transfer(friend(), "1".to_string(), None, None);
}

#[test]
#[should_panic(expected = "Owner only")]
fn only_the_owner_pauses_transfers() {
    let mut c = listed();
    set(&renter(), YOCTO, T0);
    c.set_transfers_open(false);
}

// ---------- Free passes ----------

#[test]
fn a_comp_pass_is_marked_and_pays_no_rent() {
    let mut c = listed();
    set(&owner(), PASS_STORAGE_FEE, T0);
    let v = c.mint_comp(witty(), founder(), 7);
    assert!(v.comp);
    assert_eq!(v.paid_total.0, 0);
    assert_eq!(v.expires_at.0, T0 + 7 * DAY);
    assert!(c.is_active(founder(), witty()));
    // No rent is sent anywhere.
    assert!(get_created_receipts().iter().all(|r| r.receiver_id != scouts()));
    let m = c.nft_token(v.token_id).unwrap().metadata.unwrap();
    assert_eq!(m.extra.as_deref(), Some(r#"{"scout_id":"witty","tier":"Bronze","comp":true}"#));
    let l = c.get_listing(witty()).unwrap();
    assert_eq!((l.comp_passes.0, l.paid_passes.0, l.rent_total.0), (1, 0, 0));
    assert!(get_logs().iter().any(|l| l.contains("comp_pass")));
}

#[test]
fn a_comp_pass_renewed_with_real_rent_counts_that_rent() {
    let mut c = listed();
    set(&owner(), PASS_STORAGE_FEE, T0);
    c.mint_comp(witty(), founder(), 7);
    set_cb(T0 + 6 * DAY, ok());
    c.on_rent(founder(), witty(), 7, U128(P7), U128(P7), None, Some("1".to_string()));
    let l = c.get_listing(witty()).unwrap();
    assert_eq!((l.comp_passes.0, l.paid_passes.0, l.renewals.0, l.rent_total.0), (1, 0, 1, P7));
    assert!(c.pass_info("1".to_string()).unwrap().comp);
}

#[test]
#[should_panic(expected = "Owner only")]
fn only_the_owner_gives_free_passes() {
    let mut c = listed();
    set(&renter(), PASS_STORAGE_FEE, T0);
    c.mint_comp(witty(), renter(), 30);
}

#[test]
#[should_panic(expected = "for the pass's storage")]
fn a_free_pass_still_pays_its_storage() {
    let mut c = listed();
    set(&owner(), 0, T0);
    c.mint_comp(witty(), founder(), 7);
}

// ---------- Prices and levels ----------

#[test]
#[should_panic(expected = "That's below the price floor")]
fn a_price_of_zero_is_refused() {
    let mut c = listed();
    set(&owner(), YOCTO, T0);
    c.set_prices(witty(), U128(0), U128(P30));
}

#[test]
#[should_panic(expected = "That's above the ceiling for the scout's level")]
fn a_1000x_price_is_refused() {
    let mut c = listed();
    set(&owner(), YOCTO, T0);
    c.set_prices(witty(), U128(P7 * 1000), U128(P30));
}

#[test]
#[should_panic(expected = "Owner only")]
fn only_the_owner_sets_prices() {
    let mut c = listed();
    set(&recorder(), YOCTO, T0);
    c.set_prices(witty(), U128(P7), U128(P30));
}

#[test]
fn a_higher_level_raises_the_ceiling_and_a_lower_one_caps_the_price() {
    let mut c = listed();
    set(&recorder(), 0, T0);
    c.set_level(witty(), 1, "42 calls, 1.18x per $1 after fees, receipts #1-#42".to_string());
    set(&owner(), YOCTO, T0);
    c.set_prices(witty(), U128(8 * NEAR), U128(24 * NEAR));
    let l = c.get_listing(witty()).unwrap();
    assert_eq!((l.level, l.level_name.as_str(), l.price_7d.0), (1, "Pro", 8 * NEAR));
    assert_eq!(l.attach_7d.0, 8 * NEAR + PASS_STORAGE_FEE);
    assert!(l.level_inputs.starts_with("42 calls"));
    // Back to Rookie: the prices are held to the Rookie cap at once.
    set(&recorder(), 0, T0);
    c.set_level(witty(), 0, "recomputed".to_string());
    let l = c.get_listing(witty()).unwrap();
    assert_eq!((l.price_7d.0, l.price_30d.0), (3 * NEAR, 9 * NEAR));
    assert!(get_logs().iter().any(|l| l.contains("level_set")));
}

#[test]
#[should_panic(expected = "Only the recorder sets levels")]
fn only_the_recorder_sets_levels() {
    let mut c = listed();
    set(&owner(), 0, T0);
    c.set_level(witty(), 1, "trust me".to_string());
}

#[test]
#[should_panic(expected = "No such level")]
fn levels_must_exist() {
    let mut c = listed();
    set(&recorder(), 0, T0);
    c.set_level(witty(), 2, "".to_string());
}

#[test]
fn config_shows_the_rules() {
    let c = listed();
    let cfg = c.get_config();
    assert_eq!(cfg.scouts_contract, scouts());
    assert_eq!(cfg.recorder_id, recorder());
    assert_eq!(cfg.min_price.0, NEAR / 2);
    assert_eq!(cfg.pass_storage_fee.0, 15 * MILLI);
    assert!(cfg.transfers_open);
    assert_eq!(cfg.levels.len(), 2);
}

// ---------- Fixes from the independent review ----------

#[test]
fn a_refund_never_spends_another_buyer_s_change() {
    let mut c = listed();
    // A pays with 10 NEAR of change; their callback hasn't run yet.
    let attach_a = P7 + PASS_STORAGE_FEE + 10 * NEAR;
    set(&renter(), attach_a, T0);
    let _ = c.buy_pass(witty(), 7, None);
    // B's purchase bounces before the bounced rent is back.
    let attach_b = P7 + PASS_STORAGE_FEE;
    set(&friend(), attach_b, T0);
    let _ = c.buy_pass(witty(), 7, None);
    let locked = env::storage_usage() as u128 * env::storage_byte_cost().as_yoctonear();
    let held_a = attach_a - P7;
    let held_b = attach_b - P7;
    set_cb_with_balance(T0, failed(), locked + held_a + held_b);
    c.on_rent(friend(), witty(), 7, U128(attach_b), U128(P7), Some(friend()), None);
    // B gets what's certainly theirs now, and the rest is owed; A's change is untouched.
    assert_eq!(transfers_to(&friend()), vec![held_b]);
    assert_eq!(c.owed_to(friend()).0, P7);
    // A's callback still has A's change to give back.
    set_cb_with_balance(T0, ok(), locked + held_a);
    let v = c.on_rent(renter(), witty(), 7, U128(attach_a), U128(P7), Some(renter()), None);
    assert!(v.is_some());
    assert!(transfers_to(&renter())[0] > 10 * NEAR);
}

#[test]
#[should_panic(expected = "The price floor must be at least 0.001 NEAR")]
fn the_price_floor_can_t_be_below_what_the_scouts_contract_books() {
    set(&owner(), 0, T0);
    Contract::new(
        owner(),
        scouts(),
        recorder(),
        NFTContractMetadata {
            spec: NFT_METADATA_SPEC.to_string(),
            name: "x".to_string(),
            symbol: "x".to_string(),
            icon: None,
            base_uri: None,
            reference: None,
            reference_hash: None,
        },
        U128(MILLI - 1),
        vec![Level { name: "Rookie".to_string(), max_7d: U128(NEAR), max_30d: U128(NEAR) }],
    );
}

#[test]
#[should_panic(expected = "Only the deployer can set this contract up")]
fn nobody_else_can_set_the_pass_contract_up_first() {
    set(&a("attacker.near"), 0, T0);
    Contract::new(
        a("attacker.near"),
        a("fake-scouts.near"),
        a("attacker.near"),
        NFTContractMetadata {
            spec: NFT_METADATA_SPEC.to_string(),
            name: "x".to_string(),
            symbol: "x".to_string(),
            icon: None,
            base_uri: None,
            reference: None,
            reference_hash: None,
        },
        U128(1),
        levels(),
    );
}

#[test]
fn transfer_call_keeps_15_tgas_for_the_resolve_step() {
    let mut c = listed();
    buy(&mut c, &renter(), 7, P7 + PASS_STORAGE_FEE, None, T0);
    set(&renter(), YOCTO, T0);
    let _ = c.nft_transfer_call(friend(), "1".to_string(), None, None, "".to_string());
    assert_eq!(c.pass_info("1".to_string()).unwrap().owner_id, friend());
    assert!(get_created_receipts().iter().any(|r| r.receiver_id == me()
        && r.actions.iter().any(|x| matches!(x, MockAction::FunctionCallWeight { method_name, prepaid_gas, .. }
            if method_name == b"nft_resolve_transfer" && *prepaid_gas == Gas::from_tgas(15)))));
    // Returned: back with the renter.
    set_cb(T0, PromiseResult::Successful(b"true".to_vec()));
    assert!(!c.nft_resolve_transfer(renter(), friend(), "1".to_string(), Some(HashMap::new())));
    assert!(c.is_active(renter(), witty()));
}

// ---------- Bronze and Silver ----------

#[test]
fn a_30_day_pass_is_a_silver_pass_and_keeps_its_tier_when_renewed() {
    let mut c = listed();
    let v = buy(&mut c, &renter(), 30, P30 + PASS_STORAGE_FEE, None, T0).unwrap();
    assert_eq!(v.tier, "Silver");
    let m = c.nft_token(v.token_id.clone()).unwrap().metadata.unwrap();
    assert_eq!(m.title.as_deref(), Some("Witty Silver Pass #1"));
    assert_eq!(m.media.as_deref(), Some("https://eurekascout.com/img/pass-silver.webp"));
    // A 7-day renewal adds days; the pass stays Silver.
    set_cb(T0 + DAY, ok());
    let r = c.on_rent(renter(), witty(), 7, U128(P7), U128(P7), None, Some(v.token_id.clone())).unwrap();
    assert_eq!(r.tier, "Silver");
    let l = c.get_listing(witty()).unwrap();
    assert_eq!((l.tier_7d.name.as_str(), l.tier_30d.name.as_str()), ("Bronze", "Silver"));
}

#[test]
fn new_tier_names_apply_to_new_passes_only() {
    let mut c = listed();
    buy(&mut c, &renter(), 7, P7 + PASS_STORAGE_FEE, None, T0);
    set(&owner(), YOCTO, T0);
    c.set_tiers(witty(), Tier { name: "Copper".to_string(), media: None }, silver());
    assert!(get_logs().iter().any(|l| l.contains("tiers_set")));
    let v = buy(&mut c, &friend(), 7, P7 + PASS_STORAGE_FEE, None, T0).unwrap();
    assert_eq!(v.tier, "Copper");
    assert_eq!(c.pass_info("1".to_string()).unwrap().tier, "Bronze");
}

#[test]
#[should_panic(expected = "Owner only")]
fn only_the_owner_renames_tiers() {
    let mut c = listed();
    set(&renter(), YOCTO, T0);
    c.set_tiers(witty(), bronze(), silver());
}

#[test]
#[should_panic(expected = "A tier name has 1 to 16 characters")]
fn tier_names_are_short() {
    let mut c = listed();
    set(&owner(), YOCTO, T0);
    c.set_tiers(witty(), Tier { name: "".to_string(), media: None }, silver());
}
