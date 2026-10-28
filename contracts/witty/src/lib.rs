//! Witty's sealing contract for EurekaScout.
//!
//! How a call works:
//! 1. Seal: Witty's server sends the SHA-256 of the call's JSON (keys sorted,
//!    salt included) plus the chain and rules version. The contract records the
//!    hash, the block, the time and a reveal deadline.
//! 2. Reveal: before the deadline, anyone can send the exact JSON. The contract
//!    hashes it and only accepts it if it matches the sealed hash.
//! 3. Missed deadline: a call that is not revealed in time shows as "expired",
//!    and EurekaScout scores it as a loss (reveal-or-lose).
//!
//! Calls sealed before `official_start` are flagged as warm-up calls.

use near_sdk::json_types::U64;
use near_sdk::serde_json::json;
use near_sdk::store::{LookupMap, Vector};
use near_sdk::{env, near, require, AccountId, BorshStorageKey, PanicOnDefault};

/// Largest call JSON the contract will store on reveal.
const MAX_CALL_JSON_BYTES: usize = 4096;
/// Longest chain name or rules version label.
const MAX_LABEL_BYTES: usize = 32;
/// Most calls returned by one `get_calls` view.
const MAX_PAGE: u32 = 50;

const EVENT_STANDARD: &str = "eurekascout";
const EVENT_VERSION: &str = "1.0.0";

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Calls,
    ByHash,
}

/// One sealed call, as stored on chain.
#[near(serializers = [borsh])]
pub struct SealedCall {
    hash: [u8; 32],
    chain: String,
    rules_version: String,
    sealed_at: u64,
    sealed_block: u64,
    reveal_deadline: u64,
    revealed_at: Option<u64>,
    revealed_block: Option<u64>,
    call_json: Option<String>,
}

/// A call as the views return it. Times are nanoseconds since the Unix epoch.
#[near(serializers = [json])]
pub struct CallView {
    pub id: U64,
    pub hash: String,
    pub chain: String,
    pub rules_version: String,
    pub sealed_at: U64,
    pub sealed_block: U64,
    pub reveal_deadline: U64,
    /// "sealed", "revealed" or "expired"
    pub status: String,
    pub warm_up: bool,
    pub revealed_at: Option<U64>,
    pub revealed_block: Option<U64>,
    pub call_json: Option<String>,
}

#[near(serializers = [json])]
pub struct ConfigView {
    pub owner: AccountId,
    pub official_start: U64,
    pub reveal_window: U64,
}

/// Counts across every call. Profit and loss is scored off chain from prices.
#[near(serializers = [json])]
pub struct RecordView {
    pub total: U64,
    pub revealed: U64,
    pub expired: U64,
    pub waiting: U64,
    pub warm_up: U64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    owner: AccountId,
    official_start: u64,
    reveal_window: u64,
    calls: Vector<SealedCall>,
    by_hash: LookupMap<[u8; 32], u32>,
}

#[near]
impl Contract {
    /// `official_start` and `reveal_window` are in nanoseconds.
    #[init]
    pub fn new(owner: AccountId, official_start: U64, reveal_window: U64) -> Self {
        require!(reveal_window.0 > 0, "reveal_window must be above zero");
        Self {
            owner,
            official_start: official_start.0,
            reveal_window: reveal_window.0,
            calls: Vector::new(StorageKey::Calls),
            by_hash: LookupMap::new(StorageKey::ByHash),
        }
    }

    // ---------- Writes ----------

    /// Owner only. `hash` is the 64-character hex SHA-256 of the call JSON.
    /// Returns the new call's id.
    pub fn seal_call(&mut self, hash: String, chain: String, rules_version: String) -> U64 {
        self.assert_owner();
        let hash_bytes = parse_hash(&hash);
        check_label(&chain, "chain");
        check_label(&rules_version, "rules_version");
        require!(
            self.by_hash.get(&hash_bytes).is_none(),
            "this hash is already sealed"
        );

        let now = env::block_timestamp();
        let id = self.calls.len();
        let deadline = now
            .checked_add(self.reveal_window)
            .unwrap_or_else(|| env::panic_str("reveal deadline overflow"));

        self.calls.push(SealedCall {
            hash: hash_bytes,
            chain: chain.clone(),
            rules_version: rules_version.clone(),
            sealed_at: now,
            sealed_block: env::block_height(),
            reveal_deadline: deadline,
            revealed_at: None,
            revealed_block: None,
            call_json: None,
        });
        self.by_hash.insert(hash_bytes, id);

        emit(
            "call_sealed",
            json!({
                "id": id.to_string(),
                "hash": to_hex(&hash_bytes),
                "chain": chain,
                "rules_version": rules_version,
                "sealed_block": env::block_height().to_string(),
                "reveal_deadline": deadline.to_string(),
                "warm_up": now < self.official_start,
            }),
        );
        U64(id as u64)
    }

    /// Anyone can reveal, but only the exact JSON that was sealed is accepted,
    /// and only before the deadline.
    pub fn reveal_call(&mut self, id: U64, call_json: String) {
        require!(
            call_json.len() <= MAX_CALL_JSON_BYTES,
            "call_json is too long"
        );
        let now = env::block_timestamp();
        let index = to_index(id);
        let call = self
            .calls
            .get_mut(index)
            .unwrap_or_else(|| env::panic_str("no call with this id"));

        require!(call.revealed_at.is_none(), "call already revealed");
        require!(now <= call.reveal_deadline, "reveal deadline has passed");
        require!(
            env::sha256_array(call_json.as_bytes()) == call.hash,
            "call_json does not match the sealed hash"
        );

        call.revealed_at = Some(now);
        call.revealed_block = Some(env::block_height());
        call.call_json = Some(call_json);

        emit(
            "call_revealed",
            json!({
                "id": id.0.to_string(),
                "hash": to_hex(&call.hash),
                "revealed_block": env::block_height().to_string(),
            }),
        );
    }

    /// Owner only. Applies to calls sealed after this change, never to old ones.
    pub fn set_reveal_window(&mut self, reveal_window: U64) {
        self.assert_owner();
        require!(reveal_window.0 > 0, "reveal_window must be above zero");
        self.reveal_window = reveal_window.0;
        emit(
            "reveal_window_changed",
            json!({ "reveal_window": reveal_window.0.to_string() }),
        );
    }

    /// Owner only. Hands control to a new owner account.
    pub fn set_owner(&mut self, new_owner: AccountId) {
        self.assert_owner();
        emit(
            "owner_changed",
            json!({ "old_owner": self.owner, "new_owner": new_owner }),
        );
        self.owner = new_owner;
    }

    // ---------- Views ----------

    pub fn get_config(&self) -> ConfigView {
        ConfigView {
            owner: self.owner.clone(),
            official_start: U64(self.official_start),
            reveal_window: U64(self.reveal_window),
        }
    }

    pub fn get_call_count(&self) -> U64 {
        U64(self.calls.len() as u64)
    }

    pub fn get_call(&self, id: U64) -> Option<CallView> {
        let index = u32::try_from(id.0).ok()?;
        self.calls.get(index).map(|c| self.view(index, c))
    }

    pub fn get_call_by_hash(&self, hash: String) -> Option<CallView> {
        let hash_bytes = parse_hash(&hash);
        let index = *self.by_hash.get(&hash_bytes)?;
        self.calls.get(index).map(|c| self.view(index, c))
    }

    /// Calls from `from_index`, oldest first, up to `limit` (max 50).
    pub fn get_calls(&self, from_index: U64, limit: u32) -> Vec<CallView> {
        let len = self.calls.len() as u64;
        let start = from_index.0.min(len);
        let end = start.saturating_add(limit.min(MAX_PAGE) as u64).min(len);
        (start..end)
            .filter_map(|i| {
                let index = i as u32;
                self.calls.get(index).map(|c| self.view(index, c))
            })
            .collect()
    }

    /// Note: this reads every call, so it suits a hackathon-sized record.
    pub fn get_record(&self) -> RecordView {
        let now = env::block_timestamp();
        let (mut revealed, mut expired, mut waiting, mut warm_up) = (0u64, 0u64, 0u64, 0u64);
        for c in self.calls.iter() {
            match status_of(c, now) {
                "revealed" => revealed += 1,
                "expired" => expired += 1,
                _ => waiting += 1,
            }
            if c.sealed_at < self.official_start {
                warm_up += 1;
            }
        }
        RecordView {
            total: U64(self.calls.len() as u64),
            revealed: U64(revealed),
            expired: U64(expired),
            waiting: U64(waiting),
            warm_up: U64(warm_up),
        }
    }
}

// ---------- Private helpers ----------

impl Contract {
    fn assert_owner(&self) {
        require!(
            env::predecessor_account_id() == self.owner,
            "only the owner can do this"
        );
    }

    fn view(&self, index: u32, c: &SealedCall) -> CallView {
        CallView {
            id: U64(index as u64),
            hash: to_hex(&c.hash),
            chain: c.chain.clone(),
            rules_version: c.rules_version.clone(),
            sealed_at: U64(c.sealed_at),
            sealed_block: U64(c.sealed_block),
            reveal_deadline: U64(c.reveal_deadline),
            status: status_of(c, env::block_timestamp()).to_string(),
            warm_up: c.sealed_at < self.official_start,
            revealed_at: c.revealed_at.map(U64),
            revealed_block: c.revealed_block.map(U64),
            call_json: c.call_json.clone(),
        }
    }
}

fn status_of(c: &SealedCall, now: u64) -> &'static str {
    if c.revealed_at.is_some() {
        "revealed"
    } else if now > c.reveal_deadline {
        "expired"
    } else {
        "sealed"
    }
}

fn to_index(id: U64) -> u32 {
    u32::try_from(id.0).unwrap_or_else(|_| env::panic_str("no call with this id"))
}

/// Chain names and rules versions: 1 to 32 characters of a-z, 0-9, '.', '-' or '_'.
fn check_label(value: &str, field: &str) {
    let ok = !value.is_empty()
        && value.len() <= MAX_LABEL_BYTES
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'-' || b == b'_');
    if !ok {
        env::panic_str(&format!(
            "{field} must be 1 to 32 characters of a-z, 0-9, '.', '-' or '_'"
        ));
    }
}

fn parse_hash(hex: &str) -> [u8; 32] {
    let bytes = hex.as_bytes();
    if bytes.len() != 64 {
        env::panic_str("hash must be 64 hex characters");
    }
    let mut out = [0u8; 32];
    for (i, pair) in bytes.chunks(2).enumerate() {
        out[i] = (hex_value(pair[0]) << 4) | hex_value(pair[1]);
    }
    out
}

fn hex_value(c: u8) -> u8 {
    match c {
        b'0'..=b'9' => c - b'0',
        b'a'..=b'f' => c - b'a' + 10,
        b'A'..=b'F' => c - b'A' + 10,
        _ => env::panic_str("hash must be 64 hex characters"),
    }
}

fn to_hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(DIGITS[(b >> 4) as usize] as char);
        s.push(DIGITS[(b & 0x0f) as usize] as char);
    }
    s
}

/// Logs a NEP-297 event so indexers and the website can follow calls.
fn emit(event: &str, data: near_sdk::serde_json::Value) {
    let body = json!({
        "standard": EVENT_STANDARD,
        "version": EVENT_VERSION,
        "event": event,
        "data": [data],
    });
    env::log_str(&format!("EVENT_JSON:{body}"));
}

// ---------- Unit tests ----------

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{get_logs, VMContextBuilder};
    use near_sdk::testing_env;

    const HOUR: u64 = 3_600_000_000_000;
    const START: u64 = 1_793_491_200_000_000_000; // 2026-11-01 00:00 UTC
    const CALL: &str = r#"{"chain":"solana","salt":"8f3a","token":"TEST"}"#;

    fn owner() -> AccountId {
        "eurekascout.testnet".parse().unwrap()
    }
    fn stranger() -> AccountId {
        "someone.testnet".parse().unwrap()
    }

    fn set_env(who: AccountId, time: u64, block: u64) {
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id(who)
            .block_timestamp(time)
            .block_height(block)
            .build());
    }

    fn hash_of(s: &str) -> String {
        to_hex(&env::sha256_array(s.as_bytes()))
    }

    fn setup() -> Contract {
        set_env(owner(), START, 100);
        Contract::new(owner(), U64(START), U64(48 * HOUR))
    }

    #[test]
    fn seal_then_reveal() {
        let mut c = setup();
        let id = c.seal_call(hash_of(CALL), "solana".into(), "witty-1.0".into());
        assert_eq!(id.0, 0);
        let v = c.get_call(id).unwrap();
        assert_eq!(v.status, "sealed");
        assert_eq!(v.reveal_deadline.0, START + 48 * HOUR);
        assert!(!v.warm_up);
        assert!(get_logs()[0].starts_with("EVENT_JSON:"));

        set_env(stranger(), START + 47 * HOUR, 200);
        c.reveal_call(id, CALL.to_string());
        let v = c.get_call(id).unwrap();
        assert_eq!(v.status, "revealed");
        assert_eq!(v.call_json.as_deref(), Some(CALL));
        assert_eq!(v.revealed_block.unwrap().0, 200);
    }

    #[test]
    #[should_panic(expected = "does not match the sealed hash")]
    fn wrong_json_is_rejected() {
        let mut c = setup();
        let id = c.seal_call(hash_of(CALL), "solana".into(), "witty-1.0".into());
        c.reveal_call(id, CALL.replace("TEST", "FAKE"));
    }

    #[test]
    #[should_panic(expected = "reveal deadline has passed")]
    fn late_reveal_is_rejected() {
        let mut c = setup();
        let id = c.seal_call(hash_of(CALL), "solana".into(), "witty-1.0".into());
        set_env(owner(), START + 48 * HOUR + 1, 300);
        c.reveal_call(id, CALL.to_string());
    }

    #[test]
    fn unrevealed_call_expires() {
        let mut c = setup();
        let id = c.seal_call(hash_of(CALL), "solana".into(), "witty-1.0".into());
        set_env(stranger(), START + 49 * HOUR, 300);
        assert_eq!(c.get_call(id).unwrap().status, "expired");
        let r = c.get_record();
        assert_eq!((r.total.0, r.expired.0, r.revealed.0), (1, 1, 0));
    }

    #[test]
    #[should_panic(expected = "only the owner")]
    fn stranger_cannot_seal() {
        let mut c = setup();
        set_env(stranger(), START, 101);
        c.seal_call(hash_of(CALL), "solana".into(), "witty-1.0".into());
    }

    #[test]
    #[should_panic(expected = "already sealed")]
    fn same_hash_twice_is_rejected() {
        let mut c = setup();
        c.seal_call(hash_of(CALL), "solana".into(), "witty-1.0".into());
        c.seal_call(hash_of(CALL), "solana".into(), "witty-1.0".into());
    }

    #[test]
    #[should_panic(expected = "already revealed")]
    fn double_reveal_is_rejected() {
        let mut c = setup();
        let id = c.seal_call(hash_of(CALL), "solana".into(), "witty-1.0".into());
        c.reveal_call(id, CALL.to_string());
        c.reveal_call(id, CALL.to_string());
    }

    #[test]
    fn calls_before_start_are_warm_up() {
        let mut c = setup();
        set_env(owner(), START - HOUR, 50);
        let id = c.seal_call(hash_of(CALL), "near".into(), "witty-1.0".into());
        assert!(c.get_call(id).unwrap().warm_up);
        assert_eq!(c.get_record().warm_up.0, 1);
    }

    #[test]
    fn new_window_applies_to_new_calls_only() {
        let mut c = setup();
        let first = c.seal_call(hash_of(CALL), "solana".into(), "witty-1.0".into());
        c.set_reveal_window(U64(6 * HOUR));
        let second = c.seal_call(hash_of("other"), "near".into(), "witty-1.0".into());
        assert_eq!(c.get_call(first).unwrap().reveal_deadline.0, START + 48 * HOUR);
        assert_eq!(c.get_call(second).unwrap().reveal_deadline.0, START + 6 * HOUR);
    }

    #[test]
    fn lookup_by_hash_and_paging() {
        let mut c = setup();
        for i in 0..3 {
            c.seal_call(hash_of(&format!("call {i}")), "robinhood".into(), "witty-1.0".into());
        }
        assert_eq!(c.get_call_by_hash(hash_of("call 2")).unwrap().id.0, 2);
        assert_eq!(c.get_calls(U64(1), 10).len(), 2);
        assert_eq!(c.get_call_count().0, 3);
    }

    #[test]
    #[should_panic(expected = "chain must be")]
    fn bad_chain_name_is_rejected() {
        let mut c = setup();
        c.seal_call(hash_of(CALL), "Solana Mainnet".into(), "witty-1.0".into());
    }
}
