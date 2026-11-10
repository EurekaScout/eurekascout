//! Witty's own account.
//!
//! Each Scout NFT gets a NEAR account of its own, for example
//! `witty.scouts.eurekascout.near`, which holds the scout's rent so anyone can
//! see the balance. The scouts contract creates the account with this code and
//! no access keys, so nobody can sign for it and its code can never change.
//!
//! The account obeys one caller only: its parent account (the scouts
//! contract), which keeps the books and decides every payout by its rules.
//! Anyone can send NEAR in; only the parent can send NEAR out. NEAR sent here
//! directly (a tip, say) is booked by the parent's `sync_vault`, which asks
//! this account for its free balance with `report`.
//!
//! The vault keeps no state of its own, so its storage never grows.

use near_sdk::json_types::U128;
use near_sdk::{env, near, require, AccountId, NearToken, Promise};

/// Version of this contract's code.
const VAULT_VERSION: &str = "1.0.0";

#[near(contract_state)]
#[derive(Default)]
pub struct Vault {}

/// The account this vault obeys: its own account ID with the first part
/// removed (`witty.scouts.eurekascout.near` obeys `scouts.eurekascout.near`).
fn parent_of(account: &str) -> Option<AccountId> {
    let (_, parent) = account.split_once('.')?;
    parent.parse().ok()
}

#[near]
impl Vault {
    /// Sends `amount` yoctoNEAR to `receiver_id`. Only the parent can call it.
    /// It returns the transfer, so the parent's callback sees whether the
    /// money arrived and can put it back on its books if it didn't.
    pub fn send(&self, receiver_id: AccountId, amount: U128) -> Promise {
        let parent = parent_of(env::current_account_id().as_str())
            .unwrap_or_else(|| env::panic_str("This vault has no parent account"));
        require!(
            env::predecessor_account_id() == parent,
            "Only the scouts contract can move this account's NEAR"
        );
        require!(amount.0 > 0, "Nothing to send");
        Promise::new(receiver_id).transfer(NearToken::from_yoctonear(amount.0))
    }

    /// This account's balance not locked for its storage, in yoctoNEAR.
    pub fn report(&self) -> U128 {
        let locked = env::storage_byte_cost().as_yoctonear() * env::storage_usage() as u128;
        U128(env::account_balance().as_yoctonear().saturating_sub(locked))
    }

    /// The account this vault obeys.
    pub fn get_parent(&self) -> Option<AccountId> {
        parent_of(env::current_account_id().as_str())
    }

    pub fn get_version(&self) -> String {
        VAULT_VERSION.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{get_created_receipts, VMContextBuilder};
    use near_sdk::mock::MockAction;
    use near_sdk::testing_env;

    fn acc(s: &str) -> AccountId {
        s.parse().unwrap()
    }

    fn ctx(predecessor: &str) {
        let c = VMContextBuilder::new()
            .current_account_id(acc("witty.scouts.eurekascout.near"))
            .predecessor_account_id(acc(predecessor))
            .signer_account_id(acc(predecessor))
            .build();
        testing_env!(c);
    }

    #[test]
    fn parent_is_the_account_minus_its_first_part() {
        assert_eq!(
            parent_of("witty.scouts.eurekascout.near"),
            Some(acc("scouts.eurekascout.near"))
        );
        assert_eq!(parent_of("near"), None);
        ctx("anyone.near");
        assert_eq!(Vault::default().get_parent(), Some(acc("scouts.eurekascout.near")));
    }

    #[test]
    fn the_parent_can_send() {
        ctx("scouts.eurekascout.near");
        let v = Vault::default();
        let _ = v.send(acc("holder.near"), U128(5));
        let receipts = get_created_receipts();
        assert_eq!(receipts.len(), 1);
        assert_eq!(receipts[0].receiver_id, acc("holder.near"));
        assert!(matches!(
            receipts[0].actions[0],
            MockAction::Transfer { deposit, .. } if deposit == NearToken::from_yoctonear(5)
        ));
    }

    #[test]
    fn report_gives_the_balance_not_locked_for_storage() {
        let c = VMContextBuilder::new()
            .current_account_id(acc("witty.scouts.eurekascout.near"))
            .predecessor_account_id(acc("anyone.near"))
            .account_balance(NearToken::from_near(2))
            .storage_usage(10_000)
            .build();
        testing_env!(c);
        // 10,000 bytes at 10^19 yoctoNEAR each = 0.1 NEAR locked.
        assert_eq!(Vault::default().report().0, NearToken::from_millinear(1900).as_yoctonear());
    }

    #[test]
    #[should_panic(expected = "Only the scouts contract can move this account's NEAR")]
    fn nobody_else_can_send() {
        ctx("thief.near");
        let v = Vault::default();
        let _ = v.send(acc("thief.near"), U128(5));
    }

    #[test]
    #[should_panic(expected = "Only the scouts contract can move this account's NEAR")]
    fn the_vault_cannot_send_for_itself() {
        ctx("witty.scouts.eurekascout.near");
        let v = Vault::default();
        let _ = v.send(acc("thief.near"), U128(5));
    }

    #[test]
    #[should_panic(expected = "Only the scouts contract can move this account's NEAR")]
    fn the_top_account_is_not_the_parent() {
        ctx("eurekascout.near");
        let v = Vault::default();
        let _ = v.send(acc("eurekascout.near"), U128(5));
    }
}
