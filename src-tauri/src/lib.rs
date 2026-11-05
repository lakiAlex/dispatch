mod commands;
mod error;
mod import;
mod known_hosts;
mod local;
mod log;
mod remote;
mod sites;
mod transfer;

use std::sync::Arc;

use tauri::Manager;

use commands::AppState;
use known_hosts::KnownHosts;
use remote::Ctx;
use sites::SiteStore;
use transfer::TransferManager;

/// Transfers that run at the same time. Most shared hosts allow a handful of
/// connections per IP, and browsing uses one more.
const TRANSFER_WORKERS: usize = 2;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let dir = app.path().app_config_dir()?;
            std::fs::create_dir_all(&dir)?;
            let ctx = Ctx {
                known_hosts: Arc::new(KnownHosts::load(dir.join("known_hosts.json"))),
                log: log::Logger::new(app.handle().clone()),
            };
            let transfers = TransferManager::new(app.handle().clone(), ctx.clone());
            transfers.start(TRANSFER_WORKERS);
            app.manage(AppState {
                sites: SiteStore::load(dir.join("sites.json")),
                ctx,
                sessions: Default::default(),
                connect_cancel: Default::default(),
                connect_seq: Default::default(),
                transfers,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_sites,
            commands::save_site,
            commands::delete_site,
            commands::filezilla_path,
            commands::import_filezilla,
            commands::import_cyberduck,
            commands::connect,
            commands::cancel_connect,
            commands::disconnect,
            commands::trust_host_key,
            commands::remote_list,
            commands::remote_mkdir,
            commands::remote_rename,
            commands::remote_delete,
            commands::remote_chmod,
            commands::local_home,
            commands::local_list,
            commands::local_mkdir,
            commands::local_rename,
            commands::local_trash,
            commands::enqueue_upload,
            commands::enqueue_download,
            commands::queue_snapshot,
            commands::queue_cancel,
            commands::queue_retry,
            commands::queue_clear,
            commands::queue_resolve,
            commands::queue_set_policy,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
