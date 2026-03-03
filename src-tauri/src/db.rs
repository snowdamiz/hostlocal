use rusqlite::{Connection, Result};
use std::{
    fs,
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Manager};

pub struct DbPath(pub PathBuf);

pub fn app_db_path(app: &AppHandle) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let app_data_dir = app.path().app_data_dir()?;
    fs::create_dir_all(&app_data_dir)?;
    Ok(app_data_dir.join("hostlocal.sqlite"))
}

pub fn initialize_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            body TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS app_settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS projects (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            folder_name TEXT NOT NULL UNIQUE,
            folder_path TEXT NOT NULL UNIQUE,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS runtime_runs (
            run_id INTEGER PRIMARY KEY AUTOINCREMENT,
            repository_key TEXT NOT NULL,
            repository_full_name TEXT NOT NULL,
            issue_number INTEGER NOT NULL,
            issue_title TEXT NOT NULL,
            issue_branch_name TEXT NOT NULL,
            queue_order INTEGER NOT NULL,
            stage TEXT NOT NULL CHECK(stage IN ('queued', 'preparing', 'coding', 'validating', 'publishing')),
            terminal_status TEXT CHECK(terminal_status IN ('success', 'failed', 'cancelled', 'guardrail_blocked')),
            reason_code TEXT,
            fix_hint TEXT,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            terminal_at TEXT
        );
        CREATE TABLE IF NOT EXISTS runtime_run_transitions (
            transition_id INTEGER PRIMARY KEY AUTOINCREMENT,
            run_id INTEGER NOT NULL,
            sequence INTEGER NOT NULL,
            stage TEXT NOT NULL CHECK(stage IN ('queued', 'preparing', 'coding', 'validating', 'publishing')),
            terminal_status TEXT CHECK(terminal_status IN ('success', 'failed', 'cancelled', 'guardrail_blocked')),
            reason_code TEXT,
            fix_hint TEXT,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(run_id) REFERENCES runtime_runs(run_id) ON DELETE CASCADE,
            UNIQUE(run_id, sequence)
        );
        CREATE TABLE IF NOT EXISTS runtime_run_events (
            event_id INTEGER PRIMARY KEY AUTOINCREMENT,
            run_id INTEGER NOT NULL,
            sequence INTEGER NOT NULL,
            kind TEXT NOT NULL,
            stage TEXT NOT NULL,
            message TEXT NOT NULL,
            redaction_reasons TEXT NOT NULL DEFAULT '[]',
            include_in_summary INTEGER NOT NULL DEFAULT 0 CHECK(include_in_summary IN (0, 1)),
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(run_id) REFERENCES runtime_runs(run_id) ON DELETE CASCADE,
            UNIQUE(run_id, sequence)
        );
        CREATE INDEX IF NOT EXISTS idx_runtime_runs_repository_queue
            ON runtime_runs(repository_key, stage, queue_order, run_id);
        CREATE INDEX IF NOT EXISTS idx_runtime_runs_issue_terminal_history
            ON runtime_runs(repository_key, issue_number, terminal_status, terminal_at DESC, run_id DESC);
        CREATE INDEX IF NOT EXISTS idx_runtime_run_transitions_run_sequence
            ON runtime_run_transitions(run_id, sequence DESC, transition_id DESC);
        CREATE INDEX IF NOT EXISTS idx_runtime_run_events_run_sequence
            ON runtime_run_events(run_id, sequence DESC, event_id DESC);
        CREATE INDEX IF NOT EXISTS idx_runtime_run_events_summary
            ON runtime_run_events(run_id, include_in_summary, sequence DESC, event_id DESC);
        ",
    )
}

pub fn with_connection<T, F>(db_path: &Path, operation: F) -> Result<T, String>
where
    F: FnOnce(&Connection) -> rusqlite::Result<T>,
{
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
    initialize_schema(&conn).map_err(|e| e.to_string())?;
    operation(&conn).map_err(|e| e.to_string())
}
