//! Round-trip tests against real servers. Ignored by default. Run with:
//!
//! DISPATCH_TEST_KEYS=/path/to/keys cargo test live -- --ignored --nocapture --test-threads=1
//!
//! Expects FTP on 127.0.0.1:2121, FTPES with a self-signed certificate on
//! 127.0.0.1:2122 and SFTP on 127.0.0.1:2222, all with user "test" and
//! password "secret". The keys folder holds client_plain (no passphrase) and
//! client_pass (passphrase "letmein"), both authorized on the SFTP server.

use std::sync::Arc;

use super::{Conn, ConnectParams, Ctx, Progress};
use crate::known_hosts::KnownHosts;
use crate::log::Logger;
use crate::sites::{AuthMethod, Protocol};

fn ctx(name: &str) -> Ctx {
    let path = std::env::temp_dir().join(format!("dispatch-known-hosts-{name}-{}.json", std::process::id()));
    let _ = std::fs::remove_file(&path);
    Ctx { known_hosts: Arc::new(KnownHosts::load(path)), log: Logger::stderr() }
}

fn params(protocol: Protocol, port: u16) -> ConnectParams {
    ConnectParams {
        protocol,
        host: "127.0.0.1".into(),
        port,
        user: "test".into(),
        auth: AuthMethod::Password,
        password: Some("secret".into()),
        key_path: String::new(),
        passphrase: None,
        insecure_tls: false,
    }
}

fn key(name: &str) -> String {
    let dir = std::env::var("DISPATCH_TEST_KEYS").expect("set DISPATCH_TEST_KEYS");
    format!("{dir}/{name}")
}

async fn roundtrip(p: ConnectParams, ctx: &Ctx) {
    let mut conn = Conn::connect(&p, ctx).await.expect("connect");
    let home = conn.home().await.expect("home");
    let dir = super::join(&home, &format!("dispatch-test-{}", std::process::id()));
    let _ = conn.remove_tree(&dir, true).await;
    conn.mkdir(&dir).await.expect("mkdir");
    conn.mkdir(&super::join(&dir, "sub dir")).await.expect("mkdir with space");

    // 3 MB of non-repeating data, so a short or reordered transfer shows up.
    let data: Vec<u8> = (0..3_000_000u32).map(|i| (i.wrapping_mul(2_654_435_761) >> 13) as u8).collect();
    let local = std::env::temp_dir().join(format!("dispatch-up-{}.bin", std::process::id()));
    std::fs::write(&local, &data).unwrap();
    let remote = super::join(&dir, "file ø.bin");
    let progress = Progress::default();
    conn.upload(&local, &remote, &progress).await.expect("upload");
    assert_eq!(progress.transferred.load(std::sync::atomic::Ordering::Relaxed), data.len() as u64);
    assert_eq!(conn.file_size(&remote).await.expect("size"), Some(data.len() as u64));
    assert_eq!(conn.file_size(&super::join(&dir, "missing")).await.expect("size of missing"), None);

    let entries = conn.list(&dir).await.expect("list");
    let file = entries.iter().find(|e| e.name == "file ø.bin").expect("uploaded file listed");
    assert_eq!(file.size, data.len() as u64);
    assert!(!file.is_dir);
    assert!(entries.iter().any(|e| e.name == "sub dir" && e.is_dir));

    let down = std::env::temp_dir().join(format!("dispatch-down-{}.bin", std::process::id()));
    conn.download(&remote, &down, &Progress::default()).await.expect("download");
    assert!(std::fs::read(&down).unwrap() == data, "downloaded bytes differ");

    let renamed = super::join(&dir, "renamed.bin");
    conn.rename(&remote, &renamed).await.expect("rename");
    conn.chmod(&renamed, 0o600).await.expect("chmod");
    let entries = conn.list(&dir).await.expect("list after rename");
    let file = entries.iter().find(|e| e.name == "renamed.bin").expect("renamed file listed");
    assert_eq!(file.mode.map(|m| m & 0o777), Some(0o600));

    // A cancelled transfer stops with "cancelled" and leaves no partial file.
    let cancelled = Progress::default();
    cancelled.cancel.store(true, std::sync::atomic::Ordering::Relaxed);
    let target = std::env::temp_dir().join(format!("dispatch-cancel-{}.bin", std::process::id()));
    let err = conn.download(&renamed, &target, &cancelled).await.unwrap_err();
    assert_eq!(err.code, "cancelled");
    assert!(!target.exists());

    // The connection is unusable after a cancelled FTP transfer; reconnect like the queue does.
    let mut conn = Conn::connect(&p, ctx).await.expect("reconnect");
    conn.remove_tree(&dir, true).await.expect("remove tree");
    let after = conn.list(&home).await.expect("list home");
    assert!(!after.iter().any(|e| dir.ends_with(&e.name)), "test folder still there");
    conn.close().await;
    let _ = std::fs::remove_file(local);
    let _ = std::fs::remove_file(down);
}

#[tokio::test]
#[ignore]
async fn live_ftp() {
    roundtrip(params(Protocol::FtpPlain, 2121), &ctx("ftp")).await;
}

#[tokio::test]
#[ignore]
async fn live_ftp_falls_back_to_plain() {
    // The plain server refuses AUTH TLS, so "TLS if available" continues without it.
    roundtrip(params(Protocol::Ftp, 2121), &ctx("ftp-auto")).await;
}

#[tokio::test]
#[ignore]
async fn live_ftpes_self_signed() {
    let ctx = ctx("ftpes");
    let err = match Conn::connect(&params(Protocol::Ftpes, 2122), &ctx).await {
        Err(e) => e,
        Ok(_) => panic!("self-signed certificate was accepted"),
    };
    assert_eq!(err.code, "cert", "{}", err.message);
    let mut p = params(Protocol::Ftpes, 2122);
    p.insecure_tls = true;
    roundtrip(p, &ctx).await;
}

#[tokio::test]
#[ignore]
async fn live_ftp_wrong_password() {
    let mut p = params(Protocol::FtpPlain, 2121);
    p.password = Some("wrong".into());
    let err = Conn::connect(&p, &ctx("ftp-auth")).await.err().expect("login should fail");
    assert_eq!(err.code, "auth", "{}", err.message);
}

#[tokio::test]
#[ignore]
async fn live_sftp_password() {
    roundtrip(params(Protocol::Sftp, 2222), &ctx("sftp")).await;
}

#[tokio::test]
#[ignore]
async fn live_sftp_wrong_password() {
    let mut p = params(Protocol::Sftp, 2222);
    p.password = Some("wrong".into());
    let err = Conn::connect(&p, &ctx("sftp-auth")).await.err().expect("login should fail");
    assert_eq!(err.code, "auth", "{}", err.message);
}

#[tokio::test]
#[ignore]
async fn live_sftp_keys() {
    let ctx = ctx("sftp-keys");
    let mut p = params(Protocol::Sftp, 2222);
    p.auth = AuthMethod::Key;
    p.password = None;
    p.key_path = key("client_plain");
    roundtrip(p.clone(), &ctx).await;

    p.key_path = key("client_pass");
    let err = Conn::connect(&p, &ctx).await.err().expect("needs passphrase");
    assert_eq!(err.code, "need_passphrase", "{}", err.message);
    p.passphrase = Some("wrong".into());
    let err = Conn::connect(&p, &ctx).await.err().expect("wrong passphrase");
    assert_eq!(err.code, "need_passphrase", "{}", err.message);
    p.passphrase = Some("letmein".into());
    Conn::connect(&p, &ctx).await.expect("connect with passphrase").close().await;
}

#[tokio::test]
#[ignore]
async fn live_sftp_host_key_changed() {
    let ctx = ctx("sftp-hostkey");
    ctx.known_hosts.trust("127.0.0.1:2222", "ssh-ed25519 SHA256:not-the-real-key");
    let err = Conn::connect(&params(Protocol::Sftp, 2222), &ctx).await.err().expect("must refuse");
    assert_eq!(err.code, "hostkey_changed", "{}", err.message);
    let actual = err.data.as_ref().and_then(|d| d["actual"].as_str()).expect("fingerprint in data").to_string();
    ctx.known_hosts.trust("127.0.0.1:2222", &actual);
    Conn::connect(&params(Protocol::Sftp, 2222), &ctx).await.expect("trusted now").close().await;
}
