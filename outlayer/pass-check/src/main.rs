//! Witty's access check, run in OutLayer (Plan A).
//!
//! Before Witty's bot sends a call, it asks: does this account hold access
//! to this scout right now? Access is either a Witty NFT (from the scouts
//! contract; it never expires) or an unexpired Rental Pass (from the pass
//! contract). This component answers from the chain, inside OutLayer, so the
//! answer comes with OutLayer's proof of what code produced it.
//!
//! Input (stdin, JSON), one of:
//!   {"scout_id": "witty", "account_id": "renter.near"}
//!   {"scout_id": "witty", "token_id": "12"}         (a Rental Pass)
//!   {"scout_id": "witty", "token_id": "witty-7"}    (a Witty NFT)
//!   {"scout_id": "witty"}                          (checks the caller, NEAR_SENDER_ID)
//! With a token_id, an account_id can be added: then the token must be held
//! by that account.
//!
//! Output (stdout, JSON):
//!   {"ok": true, "active": true, "access_via": "nft", "holder_id": "renter.near",
//!    "caller": "bot.near", "caller_is_holder": false, "block_height": 123, ...}
//!   {"ok": false, "error": "..."}
//!
//! `active` answers "does `holder_id` have access to this scout?". It is not
//! a statement about the caller: anyone can ask about anyone. A service that
//! wants to know whether the caller themselves has access uses
//! `caller_is_holder` as well.
//!
//! The contracts are fixed by network, never taken from the input, so a
//! caller can't point the check at a look-alike contract. Anything a contract
//! returns that isn't a well-formed answer (or null) is an error, never a yes.

use std::io::{self, Read};

use serde::Deserialize;
use serde_json::{json, Value};

const VERSION: &str = "witty-access-check 1.0.0";
const MAX_ID_BYTES: usize = 64;

#[cfg(target_arch = "wasm32")]
wit_bindgen::generate!({
    world: "pass-check",
    path: "wit",
});

#[derive(Deserialize, Debug, Default)]
struct Input {
    scout_id: Option<String>,
    account_id: Option<String>,
    token_id: Option<String>,
}

/// What the check needs from the chain. OutLayer's RPC in production, a fake
/// chain in the tests.
trait Chain {
    /// Height of the latest final block.
    fn final_height(&self) -> Result<u64, String>;
    /// A view call at a block height; returns the method's JSON result.
    fn view(&self, contract: &str, method: &str, args: &Value, height: u64) -> Result<Value, String>;
}

/// The (scouts, pass) contracts for a network.
fn contracts(network: &str) -> Result<(&'static str, &'static str), String> {
    match network {
        "mainnet" => Ok(("scouts.eurekascout.near", "pass.eurekascout.near")),
        "testnet" => Ok(("scouts.eurekascout.testnet", "passes.eurekascout.testnet")),
        other => Err(format!("unknown network {other:?}")),
    }
}

/// A NEAR account ID, checked loosely: lowercase letters, digits, `-`, `_`
/// and `.`, 2 to 64 characters. The contract does the strict check.
fn looks_like_account(s: &str) -> bool {
    (2..=MAX_ID_BYTES).contains(&s.len())
        && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"-_.".contains(&b))
}

fn check(input: &Input, sender: &str, network: &str, chain: &dyn Chain) -> Value {
    match run(input, sender, network, chain) {
        Ok(v) => v,
        Err(e) => json!({ "ok": false, "error": e, "version": VERSION }),
    }
}

/// What the check relies on from a pass or an NFT, read strictly.
struct Held<'a> {
    owner_id: &'a str,
    scout_id: &'a str,
    /// A pass's `active`; a Witty NFT is always live.
    live: bool,
}

/// `null` is "none"; a pass must be an object with every field the right
/// type. Anything else is an error.
fn read_pass(v: &Value) -> Result<Option<Held<'_>>, String> {
    if v.is_null() {
        return Ok(None);
    }
    let bad = || "unexpected answer from the pass contract".to_string();
    let o = v.as_object().ok_or_else(bad)?;
    let s = |k: &str| o.get(k).and_then(Value::as_str).ok_or_else(bad);
    s("token_id")?;
    s("expires_at")?;
    Ok(Some(Held {
        owner_id: s("owner_id")?,
        scout_id: s("scout_id")?,
        live: o.get("active").and_then(Value::as_bool).ok_or_else(bad)?,
    }))
}

/// The same for a Witty NFT (`edition_info` / `access` on the scouts contract).
fn read_nft(v: &Value) -> Result<Option<Held<'_>>, String> {
    if v.is_null() {
        return Ok(None);
    }
    let bad = || "unexpected answer from the scouts contract".to_string();
    let o = v.as_object().ok_or_else(bad)?;
    let s = |k: &str| o.get(k).and_then(Value::as_str).ok_or_else(bad);
    s("token_id")?;
    o.get("number").and_then(Value::as_u64).ok_or_else(bad)?;
    Ok(Some(Held { owner_id: s("owner_id")?, scout_id: s("scout_id")?, live: true }))
}

/// Live, for this scout, and (when an account was named) held by it.
fn grants(h: &Option<Held<'_>>, scout_id: &str, account_id: Option<&str>) -> bool {
    h.as_ref().is_some_and(|h| {
        h.live && h.scout_id == scout_id && account_id.is_none_or(|a| h.owner_id == a)
    })
}

fn run(input: &Input, sender: &str, network: &str, chain: &dyn Chain) -> Result<Value, String> {
    let (scouts, passes) = contracts(network)?;
    let scout_id = input.scout_id.as_deref().ok_or("give a scout_id")?;
    if scout_id.is_empty()
        || scout_id.len() > 24
        || !scout_id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"-_".contains(&b))
    {
        return Err("bad scout_id".into());
    }
    if let Some(a) = input.account_id.as_deref()
        && !looks_like_account(a)
    {
        return Err("bad account_id".into());
    }
    let height = chain.final_height()?;

    let (pass, nft, account_id) = if let Some(token_id) = input.token_id.as_deref() {
        let account_id = input.account_id.as_deref();
        let digits = |t: &str| !t.is_empty() && t.len() <= 20 && t.bytes().all(|b| b.is_ascii_digit());
        if digits(token_id) {
            let pass = chain.view(passes, "pass_info", &json!({ "token_id": token_id }), height)?;
            (pass, Value::Null, account_id)
        } else if token_id.strip_prefix(scout_id).and_then(|t| t.strip_prefix('-')).is_some_and(digits) {
            let nft = chain.view(scouts, "edition_info", &json!({ "token_id": token_id }), height)?;
            (Value::Null, nft, account_id)
        } else {
            return Err("bad token_id".into());
        }
    } else {
        let account_id = match input.account_id.as_deref() {
            Some(a) => a,
            None if !sender.is_empty() && looks_like_account(sender) => sender,
            None => return Err("give an account_id or a token_id".into()),
        };
        let args = json!({ "account_id": account_id, "scout_id": scout_id });
        let nft = chain.view(scouts, "access", &args, height)?;
        let pass = chain.view(passes, "active_pass", &args, height)?;
        (pass, nft, Some(account_id))
    };

    let p = read_pass(&pass)?;
    let n = read_nft(&nft)?;
    let via = if grants(&n, scout_id, account_id) {
        Some("nft")
    } else if grants(&p, scout_id, account_id) {
        Some("pass")
    } else {
        None
    };
    let holder_id = match via {
        Some("nft") => n.as_ref().map(|h| h.owner_id),
        _ => p.as_ref().or(n.as_ref()).map(|h| h.owner_id),
    };
    let active = via.is_some();
    let caller_is_holder = active && !sender.is_empty() && holder_id == Some(sender);
    Ok(json!({
        "ok": true,
        "active": active,
        "access_via": via,
        "scout_id": scout_id,
        "token_id": input.token_id,
        "account_id": account_id,
        "holder_id": holder_id,
        "caller": if sender.is_empty() { None } else { Some(sender) },
        "caller_is_holder": caller_is_holder,
        "nft": nft,
        "pass": pass,
        "contracts": { "scouts": scouts, "pass": passes },
        "network": network,
        "block_height": height,
        "version": VERSION,
    }))
}

/// OutLayer's view returns the method's result when the call works, and the
/// whole RPC answer when it doesn't. Tells the two apart.
fn parse_view(raw: &str, err: &str) -> Result<Value, String> {
    if !err.is_empty() {
        return Err(format!("RPC error: {err}"));
    }
    let v: Value = serde_json::from_str(raw).map_err(|_| format!("not JSON: {raw:.200}"))?;
    if v.get("jsonrpc").is_some() || v.get("error").is_some() || v.pointer("/result/error").is_some() {
        let e = v
            .pointer("/result/error")
            .or_else(|| v.get("error"))
            .map(|e| e.to_string())
            .unwrap_or_else(|| "unexpected RPC answer".into());
        return Err(format!("view failed: {e:.300}"));
    }
    Ok(v)
}

fn parse_height(raw: &str, err: &str) -> Result<u64, String> {
    if !err.is_empty() {
        return Err(format!("RPC error: {err}"));
    }
    let v: Value = serde_json::from_str(raw).map_err(|_| "block: not JSON".to_string())?;
    v.pointer("/result/header/height")
        .or_else(|| v.pointer("/header/height"))
        .and_then(Value::as_u64)
        .ok_or_else(|| "block: no height".to_string())
}

#[cfg(target_arch = "wasm32")]
struct OutLayerRpc;

#[cfg(target_arch = "wasm32")]
impl Chain for OutLayerRpc {
    fn final_height(&self) -> Result<u64, String> {
        let (raw, err) = near::rpc::api::block("final");
        parse_height(&raw, &err)
    }

    fn view(&self, contract: &str, method: &str, args: &Value, height: u64) -> Result<Value, String> {
        let (raw, err) = near::rpc::api::view(contract, method, &args.to_string(), &height.to_string());
        parse_view(&raw, &err)
    }
}

fn read_input() -> Input {
    let mut buf = String::new();
    let _ = io::stdin().read_to_string(&mut buf);
    serde_json::from_str(&buf).unwrap_or_default()
}

#[cfg(target_arch = "wasm32")]
fn main() {
    let input = read_input();
    let sender = std::env::var("NEAR_SENDER_ID").unwrap_or_default();
    let network = std::env::var("NEAR_NETWORK_ID").unwrap_or_else(|_| "mainnet".into());
    let out = check(&input, &sender, &network, &OutLayerRpc);
    println!("{out}");
}

#[cfg(not(target_arch = "wasm32"))]
fn main() {
    let _ = read_input();
    eprintln!("Build for OutLayer with: cargo build --target wasm32-wasip2 --release");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    /// A chain where renter.near holds pass #12 (live) and nft.near holds
    /// Witty NFT witty-7.
    struct FakeChain {
        calls: RefCell<Vec<(String, String, Value, u64)>>,
        fail: bool,
        pass: Value,
        nft: Value,
    }

    fn pass12() -> Value {
        json!({
            "token_id": "12", "owner_id": "renter.near", "scout_id": "witty",
            "expires_at": "1795305600000000000", "active": true, "comp": false, "paid_total": "2"
        })
    }
    fn witty7() -> Value {
        json!({ "token_id": "witty-7", "scout_id": "witty", "number": 7, "owner_id": "nft.near", "claimable": "0" })
    }
    fn fake() -> FakeChain {
        FakeChain { calls: RefCell::new(vec![]), fail: false, pass: pass12(), nft: witty7() }
    }
    /// A chain whose contracts answer `pass` and `nft` to everything.
    fn says(pass: Value, nft: Value) -> FakeChain {
        FakeChain { calls: RefCell::new(vec![]), fail: false, pass, nft }
    }

    impl Chain for FakeChain {
        fn final_height(&self) -> Result<u64, String> {
            Ok(1000)
        }
        fn view(&self, contract: &str, method: &str, args: &Value, height: u64) -> Result<Value, String> {
            self.calls.borrow_mut().push((contract.into(), method.into(), args.clone(), height));
            if self.fail {
                return Err("view failed: boom".into());
            }
            let real = self.pass == pass12() && self.nft == witty7();
            if !real {
                return Ok(if contract.starts_with("pass") { self.pass.clone() } else { self.nft.clone() });
            }
            Ok(match method {
                "active_pass" if args["account_id"] == "renter.near" && args["scout_id"] == "witty" => pass12(),
                "pass_info" if args["token_id"] == "12" => pass12(),
                "access" if args["account_id"] == "nft.near" && args["scout_id"] == "witty" => witty7(),
                "edition_info" if args["token_id"] == "witty-7" => witty7(),
                _ => Value::Null,
            })
        }
    }

    fn input(scout: &str, account: Option<&str>, token: Option<&str>) -> Input {
        Input {
            scout_id: Some(scout.into()),
            account_id: account.map(Into::into),
            token_id: token.map(Into::into),
        }
    }

    #[test]
    fn a_renter_with_a_live_pass_has_access() {
        let c = fake();
        let out = check(&input("witty", Some("renter.near"), None), "", "mainnet", &c);
        assert_eq!((out["ok"].clone(), out["active"].clone()), (json!(true), json!(true)));
        assert_eq!(out["access_via"], "pass");
        assert_eq!(out["holder_id"], "renter.near");
        assert_eq!(out["block_height"], 1000);
        let calls = c.calls.borrow();
        assert!(calls.iter().any(|c| c.0 == "pass.eurekascout.near" && c.1 == "active_pass" && c.3 == 1000));
        assert!(calls.iter().any(|c| c.0 == "scouts.eurekascout.near" && c.1 == "access" && c.3 == 1000));
    }

    #[test]
    fn a_witty_nft_holder_has_access() {
        let out = check(&input("witty", Some("nft.near"), None), "", "mainnet", &fake());
        assert_eq!(out["active"], true);
        assert_eq!(out["access_via"], "nft");
        assert_eq!(out["holder_id"], "nft.near");
    }

    #[test]
    fn an_account_with_neither_has_no_access() {
        let out = check(&input("witty", Some("stranger.near"), None), "", "mainnet", &fake());
        assert_eq!((out["ok"].clone(), out["active"].clone()), (json!(true), json!(false)));
        assert!(out["access_via"].is_null());
    }

    #[test]
    fn with_no_account_it_checks_the_caller() {
        let out = check(&input("witty", None, None), "renter.near", "mainnet", &fake());
        assert_eq!(out["account_id"], "renter.near");
        assert_eq!(out["active"], true);
        assert_eq!(out["caller_is_holder"], true);
    }

    #[test]
    fn a_token_checks_by_pass_or_nft_and_names_its_holder() {
        let out = check(&input("witty", None, Some("12")), "", "mainnet", &fake());
        assert_eq!((out["active"].clone(), out["holder_id"].clone()), (json!(true), json!("renter.near")));
        let out = check(&input("witty", None, Some("witty-7")), "", "mainnet", &fake());
        assert_eq!((out["active"].clone(), out["access_via"].clone()), (json!(true), json!("nft")));
        assert_eq!(out["holder_id"], "nft.near");
        let out = check(&input("witty", None, Some("13")), "", "mainnet", &fake());
        assert_eq!(out["active"], false);
        let out = check(&input("witty", None, Some("witty-8")), "", "mainnet", &fake());
        assert_eq!(out["active"], false);
    }

    #[test]
    fn a_token_asked_about_with_an_account_must_be_held_by_that_account() {
        for t in ["12", "witty-7"] {
            let out = check(&input("witty", Some("attacker.near"), Some(t)), "", "mainnet", &fake());
            assert_eq!(out["active"], false, "{t}");
        }
        let out = check(&input("witty", Some("renter.near"), Some("12")), "", "mainnet", &fake());
        assert_eq!(out["active"], true);
    }

    #[test]
    fn another_scout_s_nft_or_pass_does_not_count() {
        let out = check(&input("someone-else", None, Some("12")), "", "mainnet", &fake());
        assert_eq!(out["active"], false);
        // An NFT ID must be this scout's.
        let out = check(&input("someone-else", None, Some("witty-7")), "", "mainnet", &fake());
        assert_eq!(out["ok"], false);
    }

    #[test]
    fn the_contracts_come_from_the_network_not_the_input() {
        let c = fake();
        check(&input("witty", Some("renter.near"), None), "", "testnet", &c);
        let calls = c.calls.borrow();
        assert!(calls.iter().all(|c| c.0 == "passes.eurekascout.testnet" || c.0 == "scouts.eurekascout.testnet"));
        let out = check(&input("witty", Some("renter.near"), None), "", "betanet", &fake());
        assert_eq!(out["ok"], false);
    }

    #[test]
    fn bad_input_is_an_error_not_a_yes() {
        let c = fake();
        for i in [
            Input::default(),
            input("witty", Some("Renter.near"), None),
            input("witty", None, Some("12 OR 1")),
            input("witty", None, Some("witty-7x")),
            input("", Some("renter.near"), None),
            input("Witty", Some("renter.near"), None),
        ] {
            let out = check(&i, "", "mainnet", &c);
            assert_eq!(out["ok"], false, "{i:?}");
            assert!(out.get("active").is_none());
        }
        let out = check(&input("witty", None, None), "", "mainnet", &c);
        assert_eq!(out["error"], "give an account_id or a token_id");
    }

    #[test]
    fn anything_but_a_well_formed_answer_is_never_a_yes() {
        let odd = [json!(false), json!(true), json!([1, 2]), json!("yes"), json!({}),
                   json!({"result": {"error": "x"}}), json!({"token_id": "1", "active": true})];
        for v in odd.iter() {
            for c in [says(v.clone(), Value::Null), says(Value::Null, v.clone())] {
                let out = check(&input("witty", Some("renter.near"), None), "", "mainnet", &c);
                assert_eq!(out["ok"], false, "{v}");
                assert!(out.get("active").is_none(), "{v}");
            }
        }
    }

    #[test]
    fn someone_else_s_pass_or_nft_is_not_a_yes_for_this_account() {
        let out = check(&input("witty", Some("attacker.near"), None), "", "mainnet", &says(pass12(), witty7()));
        // `says` answers every call with renter.near's pass and nft.near's NFT.
        assert_eq!(out["active"], false);
    }

    #[test]
    fn an_expired_pass_is_not_access() {
        let mut p = pass12();
        p["active"] = json!(false);
        let out = check(&input("witty", None, Some("12")), "", "mainnet", &says(p, Value::Null));
        assert_eq!(out["active"], false);
    }

    #[test]
    fn asking_about_someone_else_s_token_does_not_make_the_caller_its_holder() {
        let out = check(&input("witty", None, Some("witty-7")), "attacker.near", "mainnet", &fake());
        assert_eq!(out["active"], true);
        assert_eq!(out["caller"], "attacker.near");
        assert_eq!(out["caller_is_holder"], false);
        let out = check(&input("witty", None, Some("witty-7")), "nft.near", "mainnet", &fake());
        assert_eq!(out["caller_is_holder"], true);
    }

    #[test]
    fn a_chain_error_is_an_error_not_a_no() {
        let c = FakeChain { fail: true, ..fake() };
        let out = check(&input("witty", Some("renter.near"), None), "", "mainnet", &c);
        assert_eq!(out["ok"], false);
        assert!(out.get("active").is_none());
    }

    #[test]
    fn view_answers_are_told_apart_from_rpc_errors() {
        assert_eq!(parse_view("null", "").unwrap(), Value::Null);
        assert_eq!(parse_view(r#"{"token_id":"1","active":true}"#, "").unwrap()["active"], true);
        assert!(parse_view(r#"{"jsonrpc":"2.0","result":{"error":"wasm execution failed"}}"#, "").is_err());
        assert!(parse_view(r#"{"error":{"name":"HANDLER_ERROR"}}"#, "").is_err());
        assert!(parse_view(r#"{"result":{"error":"wasm execution failed"}}"#, "").is_err());
        assert!(parse_view("", "timeout").is_err());
        assert!(parse_view("not json", "").is_err());
    }

    #[test]
    fn the_block_height_is_read_from_either_shape() {
        assert_eq!(parse_height(r#"{"jsonrpc":"2.0","result":{"header":{"height":42}}}"#, "").unwrap(), 42);
        assert_eq!(parse_height(r#"{"header":{"height":7}}"#, "").unwrap(), 7);
        assert!(parse_height(r#"{"result":{}}"#, "").is_err());
    }
}
