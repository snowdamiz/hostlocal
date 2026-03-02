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
