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

fn table_column_exists(
    conn: &Connection,
    table_name: &str,
    column_name: &str,
) -> rusqlite::Result<bool> {
    let mut stmt = conn.prepare(format!("PRAGMA table_info({table_name})").as_str())?;
    let columns = stmt.query_map([], |row| row.get::<_, String>(1))?;
    for column in columns {
        if column? == column_name {
            return Ok(true);
        }
    }
    Ok(false)
}

fn ensure_runtime_runs_pause_columns(conn: &Connection) -> rusqlite::Result<()> {
    if !table_column_exists(conn, "runtime_runs", "is_paused")? {
        conn.execute(
            "ALTER TABLE runtime_runs
             ADD COLUMN is_paused INTEGER NOT NULL DEFAULT 0 CHECK(is_paused IN (0, 1))",
            [],
        )?;
    }

    if !table_column_exists(conn, "runtime_runs", "paused_at")? {
        conn.execute("ALTER TABLE runtime_runs ADD COLUMN paused_at TEXT", [])?;
    }

    Ok(())
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
            terminal_at TEXT,
            is_paused INTEGER NOT NULL DEFAULT 0 CHECK(is_paused IN (0, 1)),
            paused_at TEXT
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
    )?;
    ensure_runtime_runs_pause_columns(conn)
}

pub fn with_connection<T, F>(db_path: &Path, operation: F) -> Result<T, String>
where
    F: FnOnce(&Connection) -> rusqlite::Result<T>,
{
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
    initialize_schema(&conn).map_err(|e| e.to_string())?;
    operation(&conn).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sqlite_column_exists(conn: &Connection, table_name: &str, column_name: &str) -> bool {
        let mut stmt = conn
            .prepare(format!("PRAGMA table_info({table_name})").as_str())
            .expect("prepare pragma table_info");
        let columns = stmt
            .query_map([], |row| row.get::<_, String>(1))
            .expect("query pragma table_info")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect pragma table_info rows");
        columns.iter().any(|column| column == column_name)
    }

    #[test]
    fn runtime_boundary_schema_migration_adds_paused_columns_for_existing_runtime_runs_table() {
        let conn = Connection::open_in_memory().expect("open in-memory sqlite");
        conn.execute_batch(
            "
            CREATE TABLE runtime_runs (
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
            ",
        )
        .expect("create legacy runtime_runs table");
        assert!(!sqlite_column_exists(&conn, "runtime_runs", "is_paused"));
        assert!(!sqlite_column_exists(&conn, "runtime_runs", "paused_at"));

        initialize_schema(&conn).expect("initialize schema with migration");

        assert!(sqlite_column_exists(&conn, "runtime_runs", "is_paused"));
        assert!(sqlite_column_exists(&conn, "runtime_runs", "paused_at"));
    }

    #[test]
    fn runtime_boundary_schema_migration_is_idempotent_for_paused_columns() {
        let conn = Connection::open_in_memory().expect("open in-memory sqlite");
        initialize_schema(&conn).expect("initialize schema");
        initialize_schema(&conn).expect("initialize schema second time");

        assert!(sqlite_column_exists(&conn, "runtime_runs", "is_paused"));
        assert!(sqlite_column_exists(&conn, "runtime_runs", "paused_at"));
    }
}
