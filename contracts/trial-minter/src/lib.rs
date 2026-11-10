//! The owner account's helper for Witty's server: free 7-day trial passes, and Witty's level.
//!
//! Deployed on the owner account (eurekascout.near), which owns the pass contract and is the recorder of both
//! contracts. `trial_mint` mints one free 7-day
//! Witty Bronze Pass through the pass contract's owner-only `mint_comp`, paying its storage deposit (0.015 NEAR, the
//! unused part comes back) from this account.
//!
//! `record_level` sets Witty's level (0 Rookie, 1 Analyst, 2 Elite) on both the scouts contract (the NFTs' picture and
//! mint price cap) and the pass contract (the pass price caps), with the inputs it came from, logged on chain. The level
//! script on the server works it out from Witty's public record; anyone can recompute it.
//!
//! Only this account's own keys can call it. Witty's server holds a function-call key limited to `trial_mint` and
//! `record_level`: with it the server can mint trial passes, up to `remaining`, and set the level, and nothing else. It
//! can't attach NEAR, change prices, open or pause sales, mint other passes, move NEAR or touch the account's keys.
//! Changing `remaining` needs a full-access key (one yoctoNEAR attached), which stays on the owner's own computer.
//!
//! If a mint fails, the deposit comes back by itself and the count is restored.

use near_sdk::serde_json::{Value, json};
use near_sdk::{
    AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseError, assert_one_yocto, env, near, require,
};

const VERSION: &str = "1.1.1";
/// A trial pass: always Witty's, always 7 days.
pub const DAYS: u32 = 7;
pub const SCOUT: &str = "witty";
/// What the pass contract's `mint_comp` asks to be attached for a pass's storage.
pub const STORAGE_FEE: NearToken = NearToken::from_millinear(15);
const MINT_GAS: Gas = Gas::from_tgas(50);
const LEVEL_GAS: Gas = Gas::from_tgas(15);
/// Witty's levels: 0 Rookie, 1 Analyst, 2 Elite (both contracts have these three).
pub const TOP_LEVEL: u8 = 2;
/// Both contracts take level inputs of up to 280 bytes.
pub const MAX_INPUTS: usize = 280;
const CALLBACK_GAS: Gas = Gas::from_tgas(10);

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    pass: AccountId,
    remaining: u32,
    minted: u32,
}

#[near(serializers = [json])]
#[derive(Debug, PartialEq)]
pub struct MinterView {
    pub version: String,
    pub pass: AccountId,
    pub remaining: u32,
    pub minted: u32,
    pub days: u32,
}

#[near]
impl Contract {
    /// Called once, by this account, in the deploy transaction.
    #[init]
    #[private]
    pub fn new(pass: AccountId, remaining: u32) -> Self {
        Self { pass, remaining, minted: 0 }
    }

    /// Mints one free 7-day Bronze Pass to `receiver_id`. This account's own keys only. Returns the pass (or null if
    /// the pass contract refused).
    pub fn trial_mint(&mut self, receiver_id: AccountId) -> Promise {
        self.assert_self();
        require!(self.remaining > 0, "No trial passes left");
        self.remaining -= 1;
        self.minted += 1;
        let args = json!({ "scout_id": SCOUT, "receiver_id": receiver_id, "days": DAYS });
        Promise::new(self.pass.clone())
            .function_call("mint_comp".to_string(), args.to_string().into_bytes(), STORAGE_FEE, MINT_GAS)
            .then(Self::ext(env::current_account_id()).with_static_gas(CALLBACK_GAS).on_minted())
    }

    #[private]
    pub fn on_minted(&mut self, #[callback_result] r: Result<Value, PromiseError>) -> Option<Value> {
        match r {
            Ok(pass) => {
                env::log_str(&format!("trial pass minted · {} left", self.remaining));
                Some(pass)
            }
            Err(_) => {
                // the pass contract refused: the deposit is already on its way back; give the count back too
                self.remaining += 1;
                self.minted -= 1;
                None
            }
        }
    }

    /// Sets Witty's level on the scouts contract (scouts.<this account>) and the pass contract, with its inputs. This
    /// account's own keys only (it's the recorder of both).
    pub fn record_level(&mut self, level: u8, inputs: String) -> Promise {
        self.assert_self();
        require!(level <= TOP_LEVEL, "No such level");
        require!(inputs.len() <= MAX_INPUTS, "The level inputs are too long");
        let args = json!({ "scout_id": SCOUT, "level": level, "inputs": inputs }).to_string().into_bytes();
        let scouts: AccountId = format!("scouts.{}", env::current_account_id()).parse().unwrap();
        env::log_str(&format!("level {level}: {inputs}"));
        // both calls at once, then one callback that says whether both took (a joint promise can't be returned itself)
        Promise::new(scouts)
            .function_call("set_level".to_string(), args.clone(), NearToken::from_yoctonear(0), LEVEL_GAS)
            .and(Promise::new(self.pass.clone()).function_call("set_level".to_string(), args, NearToken::from_yoctonear(0), LEVEL_GAS))
            .then(Self::ext(env::current_account_id()).with_static_gas(CALLBACK_GAS).on_levels(level))
    }

    /// True if both contracts took the level.
    #[private]
    pub fn on_levels(&self, level: u8) -> bool {
        // set_level returns nothing; a small cap keeps a big answer from costing gas
        let ok = (0..env::promise_results_count()).all(|i| env::promise_result_checked(i, 64).is_ok());
        env::log_str(&format!("level {level}: {}", if ok { "set on both contracts" } else { "NOT set on both contracts" }));
        ok
    }

    /// How many more trial passes may be minted. Full-access keys only (one yoctoNEAR attached), never the server's.
    #[payable]
    pub fn set_remaining(&mut self, remaining: u32) {
        assert_one_yocto();
        self.assert_self();
        self.remaining = remaining;
    }

    pub fn get_trial_minter(&self) -> MinterView {
        MinterView { version: VERSION.to_string(), pass: self.pass.clone(), remaining: self.remaining, minted: self.minted, days: DAYS }
    }
}

impl Contract {
    fn assert_self(&self) {
        require!(env::predecessor_account_id() == env::current_account_id(), "Only this account's own keys can do this");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{VMContextBuilder, get_created_receipts};
    use near_sdk::{PromiseResult, testing_env};

    fn owner() -> AccountId { "eurekascout.near".parse().unwrap() }
    fn pass() -> AccountId { "pass.eurekascout.near".parse().unwrap() }
    fn ctx(predecessor: &AccountId, deposit: u128) {
        testing_env!(VMContextBuilder::new()
            .current_account_id(owner())
            .predecessor_account_id(predecessor.clone())
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .account_balance(NearToken::from_near(5))
            .build());
    }
    fn setup(remaining: u32) -> Contract {
        ctx(&owner(), 0);
        Contract::new(pass(), remaining)
    }

    #[test]
    fn mints_a_7_day_witty_pass_through_mint_comp_with_the_storage_deposit() {
        let mut c = setup(3);
        let _ = c.trial_mint("newbie.near".parse().unwrap());
        assert_eq!(c.get_trial_minter().remaining, 2);
        assert_eq!(c.get_trial_minter().minted, 1);
        let receipts = get_created_receipts();
        let to_pass = receipts.iter().find(|r| r.receiver_id == pass()).expect("a call to the pass contract");
        let (method, args, deposit) = to_pass.actions.iter().find_map(|a| match a {
            near_sdk::mock::MockAction::FunctionCallWeight { method_name, args, attached_deposit, .. } =>
                Some((String::from_utf8(method_name.clone()).unwrap(), String::from_utf8(args.clone()).unwrap(), *attached_deposit)),
            _ => None,
        }).expect("a function call");
        assert_eq!(method, "mint_comp");
        assert_eq!(deposit, STORAGE_FEE);
        let v: Value = near_sdk::serde_json::from_str(&args).unwrap();
        assert_eq!(v, json!({ "scout_id": "witty", "receiver_id": "newbie.near", "days": 7 }));
    }

    #[test]
    #[should_panic(expected = "Only this account's own keys can do this")]
    fn nobody_else_can_mint() {
        let mut c = setup(3);
        ctx(&"stranger.near".parse().unwrap(), 0);
        let _ = c.trial_mint("stranger.near".parse().unwrap());
    }

    #[test]
    #[should_panic(expected = "No trial passes left")]
    fn stops_at_the_cap() {
        let mut c = setup(1);
        let _ = c.trial_mint("a.near".parse().unwrap());
        let _ = c.trial_mint("b.near".parse().unwrap());
    }

    #[test]
    fn a_refused_mint_gives_the_count_back() {
        let mut c = setup(2);
        let _ = c.trial_mint("a.near".parse().unwrap());
        testing_env!(
            VMContextBuilder::new().current_account_id(owner()).predecessor_account_id(owner()).build(),
            near_sdk::test_vm_config(),
            near_sdk::RuntimeFeesConfig::test(),
            Default::default(),
            vec![PromiseResult::Failed]
        );
        assert_eq!(c.on_minted(Err(PromiseError::Failed)), None);
        assert_eq!(c.get_trial_minter().remaining, 2);
        assert_eq!(c.get_trial_minter().minted, 0);
    }

    #[test]
    fn a_minted_pass_is_passed_back() {
        let mut c = setup(2);
        let _ = c.trial_mint("a.near".parse().unwrap());
        let pass_view = json!({ "token_id": "9", "owner_id": "a.near", "comp": true });
        assert_eq!(c.on_minted(Ok(pass_view.clone())), Some(pass_view));
        assert_eq!(c.get_trial_minter().remaining, 1);
    }

    #[test]
    #[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
    fn the_servers_key_cant_change_the_cap() {
        // a function-call key can't attach NEAR, so set_remaining is for full-access keys only
        let mut c = setup(2);
        ctx(&owner(), 0);
        c.set_remaining(1_000_000);
    }

    #[test]
    #[should_panic(expected = "Only this account's own keys can do this")]
    fn nobody_else_can_change_the_cap() {
        let mut c = setup(2);
        ctx(&"stranger.near".parse().unwrap(), 1);
        c.set_remaining(1_000_000);
    }

    fn calls_to(receipts: &[near_sdk::mock::Receipt], to: &str) -> Vec<(String, Value, NearToken)> {
        receipts.iter().filter(|r| r.receiver_id.as_str() == to).flat_map(|r| r.actions.iter().filter_map(|a| match a {
            near_sdk::mock::MockAction::FunctionCallWeight { method_name, args, attached_deposit, .. } =>
                Some((String::from_utf8(method_name.clone()).unwrap(), near_sdk::serde_json::from_slice(args).unwrap(), *attached_deposit)),
            _ => None,
        })).collect()
    }

    #[test]
    fn record_level_sets_it_on_both_contracts_with_its_inputs() {
        let mut c = setup(2);
        let inputs = r#"{"rules":"levels-1","calls":31,"per_dollar":1.07}"#.to_string();
        let _ = c.record_level(1, inputs.clone());
        let receipts = get_created_receipts();
        let want = json!({ "scout_id": "witty", "level": 1, "inputs": inputs });
        for to in ["scouts.eurekascout.near", "pass.eurekascout.near"] {
            let calls = calls_to(&receipts, to);
            assert_eq!(calls.len(), 1, "{to}");
            assert_eq!(calls[0].0, "set_level");
            assert_eq!(calls[0].1, want);
            assert_eq!(calls[0].2, NearToken::from_yoctonear(0));
        }
        assert_eq!(c.get_trial_minter().remaining, 2, "levels don't touch the trial count");
    }

    fn with_results(results: Vec<PromiseResult>) {
        testing_env!(
            VMContextBuilder::new().current_account_id(owner()).predecessor_account_id(owner()).build(),
            near_sdk::test_vm_config(),
            near_sdk::RuntimeFeesConfig::test(),
            Default::default(),
            results
        );
    }

    #[test]
    fn record_level_ends_in_one_callback_not_a_joint_promise() {
        let mut c = setup(2);
        let _ = c.record_level(1, "{}".into());
        let receipts = get_created_receipts();
        let back = calls_to(&receipts, "eurekascout.near");
        assert_eq!(back.len(), 1);
        assert_eq!(back[0].0, "on_levels");
        assert_eq!(back[0].1, json!({ "level": 1 }));
    }

    #[test]
    fn the_callback_says_whether_both_contracts_took_it() {
        let c = setup(2);
        with_results(vec![PromiseResult::Successful(vec![]), PromiseResult::Successful(vec![])]);
        assert!(c.on_levels(1));
        with_results(vec![PromiseResult::Successful(vec![]), PromiseResult::Failed]);
        assert!(!c.on_levels(1));
    }

    #[test]
    #[should_panic(expected = "Only this account's own keys can do this")]
    fn nobody_else_can_set_the_level() {
        let mut c = setup(2);
        ctx(&"stranger.near".parse().unwrap(), 0);
        let _ = c.record_level(2, "{}".into());
    }

    #[test]
    #[should_panic(expected = "No such level")]
    fn only_three_levels() {
        let mut c = setup(2);
        let _ = c.record_level(3, "{}".into());
    }

    #[test]
    #[should_panic(expected = "The level inputs are too long")]
    fn inputs_fit_the_contracts() {
        let mut c = setup(2);
        let _ = c.record_level(1, "x".repeat(281));
    }

    #[test]
    fn the_owner_can_change_the_cap() {
        let mut c = setup(2);
        ctx(&owner(), 1);
        c.set_remaining(500);
        assert_eq!(
            c.get_trial_minter(),
            MinterView { version: "1.1.1".into(), pass: pass(), remaining: 500, minted: 0, days: 7 }
        );
    }
}
