mod commands;
mod db;
mod github_auth;
mod github_intake;
mod runtime_boundary;
mod window;

use db::{app_db_path, with_connection, DbPath};
use github_auth::GithubAuthState;
use runtime_boundary::RuntimeBoundarySharedState;
use tauri::{Manager, WindowEvent};
use window::{app_window_state_path, persist_window_state, restore_window_state};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let db_path = app_db_path(app.handle())?;
            with_connection(&db_path, |_| Ok(())).map_err(std::io::Error::other)?;
            app.manage(DbPath(db_path));
            app.manage(GithubAuthState::default());
            app.manage(RuntimeBoundarySharedState::default());
            runtime_boundary::reconcile_runtime_state_on_startup(app.handle())
                .map_err(std::io::Error::other)?;

            let window_state_path = app_window_state_path(app.handle())?;
            if let Some(main_window) = app.get_webview_window("main") {
                restore_window_state(&main_window, &window_state_path)
                    .map_err(std::io::Error::other)?;

                let state_path_for_events = window_state_path.clone();
                let main_window_for_events = main_window.clone();
                main_window.on_window_event(move |event| match event {
                    WindowEvent::Moved(_)
                    | WindowEvent::Resized(_)
                    | WindowEvent::CloseRequested { .. } => {
                        let _ =
                            persist_window_state(&main_window_for_events, &state_path_for_events);
                    }
                    _ => {}
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::sqlite_healthcheck,
            commands::sqlite_db_path,
            commands::sqlite_insert_message,
            commands::sqlite_list_messages,
            commands::sqlite_list_projects,
            commands::sqlite_get_development_folder,
            commands::sqlite_set_development_folder,
            commands::sqlite_create_project,
            commands::pick_development_folder,
            github_auth::github_auth_status,
            github_auth::github_list_repositories,
            github_auth::github_list_repository_items,
            github_intake::github_attempt_issue_intake,
            github_intake::github_revert_issue_intake,
            runtime_boundary::runtime_enqueue_issue_run,
            runtime_boundary::runtime_dequeue_issue_run,
            commands::runtime_get_repository_run_snapshot,
            commands::runtime_get_issue_run_history,
            commands::runtime_get_issue_run_telemetry,
            commands::runtime_get_issue_run_summary,
            github_auth::github_auth_start,
            github_auth::github_auth_poll,
            github_auth::github_auth_logout,
            github_auth::github_open_verification_url,
            github_auth::github_open_item_url,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
