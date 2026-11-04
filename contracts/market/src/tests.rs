//! Unit tests: local arithmetic and state transitions (no cross-contract
//! execution; that lives in `tests/` against a real Sandbox).

use near_sdk::json_types::{U128, U64};
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{
    test_vm_config, testing_env, AccountId, Gas, NearToken, PromiseOrValue, PromiseResult,
};
use std::collections::HashMap;

use crate::balances::{add, Res};
use crate::state::{Contract, SettlementOutcome};
use crate::storage::storage_cost;
use crate::types::WithdrawalStatus;

const ONE: u128 = 1_000_000;
const CUTOFF: u64 = 1_000_000;
const MID: &str = "mkt-1";

fn acct(n: &str) -> AccountId {
    n.parse().unwrap()
}
fn token() -> AccountId {
    acct("token.test")
}
fn me() -> AccountId {
    acct("market.test")
}

fn ctx(pred: &str, yocto: u128, ts: u64) -> VMContextBuilder {
    let mut b = VMContextBuilder::new();
    b.current_account_id(me())
        .predecessor_account_id(acct(pred))
        .signer_account_id(acct(pred))
        .attached_deposit(NearToken::from_yoctonear(yocto))
        .prepaid_gas(Gas::from_tgas(100))
        .block_timestamp(ts);
    b
}

fn set(pred: &str, yocto: u128, ts: u64) {
    testing_env!(ctx(pred, yocto, ts).build());
}

fn new_contract() -> Contract {
    set("owner.test", 0, 1);
    Contract::new(
        token(),
        MID.to_string(),
        "Will it rain?".to_string(),
        "Resolves YES if it rains.".to_string(),
        U64(CUTOFF),
    )
}

fn register(c: &mut Contract, who: &str) {
    set(who, storage_cost().as_yoctonear(), 5);
    c.storage_deposit(None, None);
}

/// Registers `who` and credits `amount` through the real receiver.
fn fund(c: &mut Contract, who: &str, amount: u128) {
    register(c, who);
    set("token.test", 0, 5);
    match c.ft_on_transfer(acct(who), U128(amount), "deposit".into()) {
        PromiseOrValue::Value(unused) => assert_eq!(unused.0, 0),
        _ => panic!("expected value"),
    }
}

fn avail(c: &Contract, who: &str) -> u128 {
    c.get_account(acct(who)).unwrap().available_collateral.0
}
fn shares(c: &Contract, who: &str) -> (u128, u128) {
    let p = c.get_position(acct(who), MID.into());
    (p.yes.0, p.no.0)
}

fn split(c: &mut Contract, who: &str, amount: u128) {
    set(who, 1, 10);
    c.split_position(MID.into(), U128(amount));
}
fn merge(c: &mut Contract, who: &str, amount: u128) {
    set(who, 1, 10);
    c.merge_positions(MID.into(), U128(amount));
}

// ---------------- init & registration ----------------

#[test]
fn init_sets_immutable_terms() {
    let c = new_contract();
    let cfg = c.get_config();
    assert_eq!(cfg.collateral_token_id, token());
    assert_eq!(cfg.market_id, MID);
    assert_eq!(cfg.decimals, 6);
    assert_eq!(cfg.deposit_msg, "deposit");
    let m = c.get_market(MID.into());
    assert_eq!(m.split_cutoff_ns.0, CUTOFF);
}

#[test]
#[should_panic(expected = "invalid initialization arguments")]
fn init_rejects_past_cutoff() {
    set("owner.test", 0, 500);
    Contract::new(token(), MID.into(), "q".into(), "r".into(), U64(400));
}

#[test]
fn registration_charges_fixed_cost_and_is_idempotent() {
    let mut c = new_contract();
    assert!(c.storage_balance_of(acct("alice.test")).is_none());
    register(&mut c, "alice.test");
    let b = c.storage_balance_of(acct("alice.test")).unwrap();
    assert_eq!(b.total, storage_cost());
    assert_eq!(c.get_totals().registered_accounts.0, 1);
    // registering again does not double count
    register(&mut c, "alice.test");
    assert_eq!(c.get_totals().registered_accounts.0, 1);
}

#[test]
fn registration_with_excess_deposit_registers_once() {
    let mut c = new_contract();
    set("alice.test", storage_cost().as_yoctonear() * 3, 5);
    let b = c.storage_deposit(None, Some(true));
    assert_eq!(b.total, storage_cost());
    assert_eq!(c.get_totals().registered_accounts.0, 1);
}

#[test]
fn someone_can_register_another_account() {
    let mut c = new_contract();
    set("payer.test", storage_cost().as_yoctonear(), 5);
    c.storage_deposit(Some(acct("bob.test")), None);
    assert!(c.get_account(acct("bob.test")).is_some());
    assert!(c.get_account(acct("payer.test")).is_none());
}

#[test]
#[should_panic(expected = "below the storage registration cost")]
fn registration_underpaid_fails() {
    let mut c = new_contract();
    set("alice.test", storage_cost().as_yoctonear() - 1, 5);
    c.storage_deposit(None, None);
}

// ---------------- deposits ----------------

#[test]
#[should_panic(expected = "approved collateral token")]
fn forged_receiver_call_from_wrong_caller_panics() {
    let mut c = new_contract();
    register(&mut c, "alice.test");
    set("evil.test", 0, 5);
    let _ = c.ft_on_transfer(acct("alice.test"), U128(100 * ONE), "deposit".into());
}

#[test]
fn deposit_credits_sender_only() {
    let mut c = new_contract();
    register(&mut c, "bob.test");
    fund(&mut c, "alice.test", 100 * ONE);
    assert_eq!(avail(&c, "alice.test"), 100 * ONE);
    assert_eq!(avail(&c, "bob.test"), 0);
    assert_eq!(c.get_totals().available_collateral.0, 100 * ONE);
}

#[test]
fn msg_cannot_choose_beneficiary() {
    let mut c = new_contract();
    register(&mut c, "alice.test");
    register(&mut c, "bob.test");
    set("token.test", 0, 5);
    let r = c.ft_on_transfer(acct("alice.test"), U128(ONE), "bob.test".into());
    match r {
        PromiseOrValue::Value(u) => assert_eq!(u.0, ONE, "fully refunded"),
        _ => panic!(),
    }
    assert_eq!(avail(&c, "bob.test"), 0);
    assert_eq!(avail(&c, "alice.test"), 0);
}

#[test]
fn unregistered_sender_is_refunded_without_credit() {
    let mut c = new_contract();
    set("token.test", 0, 5);
    let r = c.ft_on_transfer(acct("ghost.test"), U128(5 * ONE), "deposit".into());
    match r {
        PromiseOrValue::Value(u) => assert_eq!(u.0, 5 * ONE),
        _ => panic!(),
    }
    assert_eq!(c.get_totals().available_collateral.0, 0);
    assert!(c.get_account(acct("ghost.test")).is_none());
}

#[test]
fn zero_amount_deposit_is_refunded() {
    let mut c = new_contract();
    register(&mut c, "alice.test");
    set("token.test", 0, 5);
    match c.ft_on_transfer(acct("alice.test"), U128(0), "deposit".into()) {
        PromiseOrValue::Value(u) => assert_eq!(u.0, 0),
        _ => panic!(),
    }
    assert_eq!(c.get_totals().available_collateral.0, 0);
}

#[test]
fn deposit_overflow_is_refunded_and_changes_nothing() {
    let mut c = new_contract();
    fund(&mut c, "alice.test", u128::MAX - 5);
    set("token.test", 0, 5);
    match c.ft_on_transfer(acct("alice.test"), U128(10), "deposit".into()) {
        PromiseOrValue::Value(u) => assert_eq!(u.0, 10),
        _ => panic!(),
    }
    assert_eq!(avail(&c, "alice.test"), u128::MAX - 5);
    assert_eq!(c.get_totals().available_collateral.0, u128::MAX - 5);
}

#[test]
fn deposits_allowed_after_cutoff() {
    let mut c = new_contract();
    register(&mut c, "alice.test");
    set("token.test", 0, CUTOFF + 10);
    let _ = c.ft_on_transfer(acct("alice.test"), U128(ONE), "deposit".into());
    assert_eq!(avail(&c, "alice.test"), ONE);
}

// ---------------- split / merge ----------------

#[test]
fn split_and_merge_follow_the_acceptance_table() {
    let mut c = new_contract();
    fund(&mut c, "alice.test", 100 * ONE);
    split(&mut c, "alice.test", 100 * ONE);
    assert_eq!(avail(&c, "alice.test"), 0);
    assert_eq!(shares(&c, "alice.test"), (100 * ONE, 100 * ONE));
    let t = c.get_totals();
    assert_eq!(
        (t.market_backing.0, t.outstanding_yes.0, t.outstanding_no.0),
        (100 * ONE, 100 * ONE, 100 * ONE)
    );
    merge(&mut c, "alice.test", 40 * ONE);
    assert_eq!(avail(&c, "alice.test"), 40 * ONE);
    assert_eq!(shares(&c, "alice.test"), (60 * ONE, 60 * ONE));
    let t = c.get_totals();
    assert_eq!(t.market_backing.0, 60 * ONE);
    assert_eq!(t.available_collateral.0, 40 * ONE);
    assert_eq!(t.settled_escrow_requirement.0, 100 * ONE);
}

#[test]
fn one_base_unit_is_exact() {
    let mut c = new_contract();
    fund(&mut c, "alice.test", 3);
    split(&mut c, "alice.test", 1);
    assert_eq!(shares(&c, "alice.test"), (1, 1));
    assert_eq!(c.get_totals().market_backing.0, 1);
    merge(&mut c, "alice.test", 1);
    assert_eq!(avail(&c, "alice.test"), 3);
    assert_eq!(c.get_totals().market_backing.0, 0);
}

#[test]
#[should_panic(expected = "amount must be greater than zero")]
fn zero_split_rejected() {
    let mut c = new_contract();
    fund(&mut c, "alice.test", ONE);
    split(&mut c, "alice.test", 0);
}

#[test]
#[should_panic(expected = "amount must be greater than zero")]
fn zero_merge_rejected() {
    let mut c = new_contract();
    fund(&mut c, "alice.test", ONE);
    split(&mut c, "alice.test", ONE);
    merge(&mut c, "alice.test", 0);
}

#[test]
#[should_panic(expected = "insufficient available collateral")]
fn split_more_than_available_rejected() {
    let mut c = new_contract();
    fund(&mut c, "alice.test", ONE);
    split(&mut c, "alice.test", ONE + 1);
}

#[test]
#[should_panic(expected = "insufficient YES/NO shares")]
fn merge_more_than_held_rejected() {
    let mut c = new_contract();
    fund(&mut c, "alice.test", ONE);
    split(&mut c, "alice.test", ONE);
    merge(&mut c, "alice.test", ONE + 1);
}

#[test]
#[should_panic(expected = "unknown market id")]
fn split_unknown_market_rejected() {
    let mut c = new_contract();
    fund(&mut c, "alice.test", ONE);
    set("alice.test", 1, 10);
    c.split_position("other".into(), U128(ONE));
}

#[test]
#[should_panic(expected = "unknown market id")]
fn position_view_unknown_market_rejected() {
    let c = new_contract();
    c.get_position(acct("alice.test"), "other".into());
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn split_without_one_yocto_rejected() {
    let mut c = new_contract();
    fund(&mut c, "alice.test", ONE);
    set("alice.test", 0, 10);
    c.split_position(MID.into(), U128(ONE));
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn merge_with_two_yocto_rejected() {
    let mut c = new_contract();
    fund(&mut c, "alice.test", ONE);
    split(&mut c, "alice.test", ONE);
    set("alice.test", 2, 10);
    c.merge_positions(MID.into(), U128(ONE));
}

#[test]
#[should_panic(expected = "not registered")]
fn split_unregistered_rejected() {
    let mut c = new_contract();
    split(&mut c, "ghost.test", ONE);
}

#[test]
#[should_panic(expected = "splitting is closed")]
fn split_at_cutoff_rejected() {
    let mut c = new_contract();
    fund(&mut c, "alice.test", ONE);
    set("alice.test", 1, CUTOFF);
    c.split_position(MID.into(), U128(ONE));
}

#[test]
fn split_just_before_cutoff_ok_and_merge_after_cutoff_ok() {
    let mut c = new_contract();
    fund(&mut c, "alice.test", 2 * ONE);
    set("alice.test", 1, CUTOFF - 1);
    c.split_position(MID.into(), U128(2 * ONE));
    set("alice.test", 1, CUTOFF + 99);
    c.merge_positions(MID.into(), U128(ONE));
    assert_eq!(avail(&c, "alice.test"), ONE);
    assert!(!c.get_market(MID.into()).split_open);
}

#[test]
fn accounts_are_isolated() {
    let mut c = new_contract();
    fund(&mut c, "alice.test", 10 * ONE);
    fund(&mut c, "bob.test", 7 * ONE);
    split(&mut c, "alice.test", 4 * ONE);
    assert_eq!(avail(&c, "bob.test"), 7 * ONE);
    assert_eq!(shares(&c, "bob.test"), (0, 0));
    // Bob holds no shares so he cannot merge Alice's.
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        merge(&mut c, "bob.test", ONE)
    }));
    assert!(r.is_err());
    assert_eq!(shares(&c, "alice.test"), (4 * ONE, 4 * ONE));
    assert_eq!(c.get_totals().market_backing.0, 4 * ONE);
}

#[test]
fn repeated_split_merge_conserves_everything() {
    let mut c = new_contract();
    fund(&mut c, "alice.test", 1_000_003);
    fund(&mut c, "bob.test", 999);
    split(&mut c, "bob.test", 333);
    for i in 1..=200u128 {
        split(&mut c, "alice.test", i);
        if i % 3 == 0 {
            merge(&mut c, "alice.test", i / 2 + 1);
        }
        let t = c.get_totals();
        let a = c.get_account(acct("alice.test")).unwrap();
        let b = c.get_account(acct("bob.test")).unwrap();
        // Totals equal the sum of the two accounts we know about.
        assert_eq!(
            t.available_collateral.0,
            a.available_collateral.0 + b.available_collateral.0
        );
        assert_eq!(t.outstanding_yes.0, a.yes.0 + b.yes.0);
        assert_eq!(t.outstanding_no.0, a.no.0 + b.no.0);
        assert_eq!(t.market_backing.0, t.outstanding_yes.0);
        // Nothing created or destroyed: deposits == available + backing.
        assert_eq!(t.settled_escrow_requirement.0, 1_000_003 + 999);
    }
}

#[test]
fn overflow_is_detected_in_helpers() {
    let r: Res<u128> = add(u128::MAX, 1);
    assert_eq!(r, Err("arithmetic overflow"));
}

#[test]
fn split_overflow_leaves_state_unchanged() {
    let mut c = new_contract();
    fund(&mut c, "alice.test", u128::MAX);
    // Alice holds u128::MAX shares of each side after splitting everything.
    split(&mut c, "alice.test", u128::MAX);
    fund(&mut c, "bob.test", 5);
    let before = (shares(&c, "bob.test"), c.get_totals().market_backing.0);
    // Backing is at u128::MAX: any further split must fail atomically.
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        split(&mut c, "bob.test", 1)
    }));
    assert!(r.is_err());
    assert_eq!(avail(&c, "bob.test"), 5);
    assert_eq!(shares(&c, "bob.test"), before.0);
    assert_eq!(c.get_totals().market_backing.0, before.1);
}

// ---------------- withdrawals ----------------

fn withdraw_req(c: &mut Contract, who: &str, amount: u128) {
    set(who, 1, 20);
    let _ = c.withdraw(U128(amount));
}

fn settle(c: &mut Contract, who: &str, id: u64, result: PromiseResult) -> SettlementOutcome {
    testing_env!(
        ctx("market.test", 0, 30).build(),
        test_vm_config(),
        near_parameters::RuntimeFeesConfig::test(),
        HashMap::default(),
        vec![result],
    );
    c.on_withdraw_complete(acct(who), U64(id))
}

#[test]
fn withdraw_debits_and_records_pending() {
    let mut c = new_contract();
    fund(&mut c, "alice.test", 100 * ONE);
    withdraw_req(&mut c, "alice.test", 40 * ONE);
    assert_eq!(avail(&c, "alice.test"), 60 * ONE);
    let t = c.get_totals();
    assert_eq!(t.available_collateral.0, 60 * ONE);
    assert_eq!(t.pending_withdrawals.0, 40 * ONE);
    let w = c.get_withdrawal(acct("alice.test")).unwrap();
    assert_eq!(w.status, WithdrawalStatus::Pending);
    assert_eq!(w.amount.0, 40 * ONE);
    assert_eq!(w.withdrawal_id.0, 1);
    assert_eq!(w.receiver_id, Some(acct("alice.test")));
}

#[test]
fn successful_callback_finalizes() {
    let mut c = new_contract();
    fund(&mut c, "alice.test", 100 * ONE);
    withdraw_req(&mut c, "alice.test", 40 * ONE);
    let o = settle(&mut c, "alice.test", 1, PromiseResult::Successful(vec![]));
    assert_eq!(o, SettlementOutcome::Completed);
    assert_eq!(avail(&c, "alice.test"), 60 * ONE);
    assert_eq!(c.get_totals().pending_withdrawals.0, 0);
    let w = c.get_withdrawal(acct("alice.test")).unwrap();
    assert_eq!(w.status, WithdrawalStatus::Completed);
}

#[test]
fn oversized_success_data_still_counts_as_success() {
    let mut c = new_contract();
    fund(&mut c, "alice.test", ONE);
    withdraw_req(&mut c, "alice.test", ONE);
    let o = settle(
        &mut c,
        "alice.test",
        1,
        PromiseResult::Successful(vec![7u8; 4096]),
    );
    assert_eq!(o, SettlementOutcome::Completed);
    assert_eq!(avail(&c, "alice.test"), 0);
}

#[test]
fn failed_callback_restores_to_current_balance_once() {
    let mut c = new_contract();
    fund(&mut c, "alice.test", 100 * ONE);
    split(&mut c, "alice.test", 30 * ONE);
    withdraw_req(&mut c, "alice.test", 40 * ONE);
    // A deposit lands while the withdrawal is pending.
    set("token.test", 0, 25);
    let _ = c.ft_on_transfer(acct("alice.test"), U128(5 * ONE), "deposit".into());
    assert_eq!(avail(&c, "alice.test"), 35 * ONE);
    let o = settle(&mut c, "alice.test", 1, PromiseResult::Failed);
    assert_eq!(o, SettlementOutcome::FailedRestored);
    // 100 - 30 split - 40 pending + 5 deposit + 40 restored = 75
    assert_eq!(avail(&c, "alice.test"), 75 * ONE);
    assert_eq!(
        shares(&c, "alice.test"),
        (30 * ONE, 30 * ONE),
        "shares untouched"
    );
    let t = c.get_totals();
    assert_eq!(t.pending_withdrawals.0, 0);
    assert_eq!(t.available_collateral.0, 75 * ONE);
    assert_eq!(t.market_backing.0, 30 * ONE);
    assert_eq!(
        c.get_withdrawal(acct("alice.test")).unwrap().status,
        WithdrawalStatus::FailedRestored
    );
}

#[test]
#[should_panic(expected = "no pending withdrawal")]
fn callback_replay_after_success_panics() {
    let mut c = new_contract();
    fund(&mut c, "alice.test", ONE);
    withdraw_req(&mut c, "alice.test", ONE);
    settle(&mut c, "alice.test", 1, PromiseResult::Successful(vec![]));
    settle(&mut c, "alice.test", 1, PromiseResult::Failed);
}

#[test]
fn callback_replay_after_failure_does_not_double_restore() {
    let mut c = new_contract();
    fund(&mut c, "alice.test", 10 * ONE);
    withdraw_req(&mut c, "alice.test", 10 * ONE);
    settle(&mut c, "alice.test", 1, PromiseResult::Failed);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        settle(&mut c, "alice.test", 1, PromiseResult::Failed)
    }));
    assert!(r.is_err());
    assert_eq!(avail(&c, "alice.test"), 10 * ONE);
    assert_eq!(c.get_totals().available_collateral.0, 10 * ONE);
}

#[test]
#[should_panic(expected = "does not match the pending record")]
fn callback_wrong_id_panics() {
    let mut c = new_contract();
    fund(&mut c, "alice.test", ONE);
    withdraw_req(&mut c, "alice.test", ONE);
    settle(&mut c, "alice.test", 99, PromiseResult::Failed);
}

#[test]
#[should_panic(expected = "exactly one promise result")]
fn callback_without_promise_result_cannot_settle() {
    let mut c = new_contract();
    fund(&mut c, "alice.test", ONE);
    withdraw_req(&mut c, "alice.test", ONE);
    testing_env!(ctx("market.test", 0, 30).build());
    c.on_withdraw_complete(acct("alice.test"), U64(1));
}

#[test]
#[should_panic(expected = "already pending")]
fn second_withdrawal_while_pending_rejected() {
    let mut c = new_contract();
    fund(&mut c, "alice.test", 10 * ONE);
    withdraw_req(&mut c, "alice.test", ONE);
    withdraw_req(&mut c, "alice.test", ONE);
}

#[test]
fn other_accounts_can_withdraw_while_one_is_pending() {
    let mut c = new_contract();
    fund(&mut c, "alice.test", 10 * ONE);
    fund(&mut c, "bob.test", 10 * ONE);
    withdraw_req(&mut c, "alice.test", ONE);
    withdraw_req(&mut c, "bob.test", 2 * ONE);
    assert_eq!(c.get_totals().pending_withdrawals.0, 3 * ONE);
}

#[test]
fn can_withdraw_again_after_settlement_with_new_id() {
    let mut c = new_contract();
    fund(&mut c, "alice.test", 10 * ONE);
    withdraw_req(&mut c, "alice.test", ONE);
    settle(&mut c, "alice.test", 1, PromiseResult::Successful(vec![]));
    withdraw_req(&mut c, "alice.test", ONE);
    assert_eq!(
        c.get_withdrawal(acct("alice.test"))
            .unwrap()
            .withdrawal_id
            .0,
        2
    );
}

#[test]
#[should_panic(expected = "insufficient available collateral")]
fn withdraw_more_than_available_rejected() {
    let mut c = new_contract();
    fund(&mut c, "alice.test", ONE);
    withdraw_req(&mut c, "alice.test", ONE + 1);
}

#[test]
#[should_panic(expected = "amount must be greater than zero")]
fn withdraw_zero_rejected() {
    let mut c = new_contract();
    fund(&mut c, "alice.test", ONE);
    withdraw_req(&mut c, "alice.test", 0);
}

#[test]
#[should_panic(expected = "not registered")]
fn withdraw_unregistered_rejected() {
    let mut c = new_contract();
    withdraw_req(&mut c, "ghost.test", ONE);
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn withdraw_without_yocto_rejected() {
    let mut c = new_contract();
    fund(&mut c, "alice.test", ONE);
    set("alice.test", 0, 20);
    let _ = c.withdraw(U128(ONE));
}

#[test]
#[should_panic(expected = "not enough prepaid gas")]
fn withdraw_with_too_little_gas_rejected() {
    let mut c = new_contract();
    fund(&mut c, "alice.test", ONE);
    let mut b = ctx("alice.test", 1, 20);
    b.prepaid_gas(Gas::from_tgas(20));
    testing_env!(b.build());
    let _ = c.withdraw(U128(ONE));
}

#[test]
fn withdraw_cannot_touch_reserved_backing_or_shares() {
    let mut c = new_contract();
    fund(&mut c, "alice.test", 10 * ONE);
    split(&mut c, "alice.test", 10 * ONE);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        withdraw_req(&mut c, "alice.test", 1)
    }));
    assert!(r.is_err(), "backing is not withdrawable");
    assert_eq!(c.get_totals().market_backing.0, 10 * ONE);
}
