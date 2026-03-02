use crate::db::{with_connection, DbPath};
use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use std::{
    fs,
    io::ErrorKind,
    path::{Path, PathBuf},
};
use tauri::State;

const DEVELOPMENT_FOLDER_KEY: &str = "development_folder";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedProject {
    pub id: i64,
    pub name: String,
    pub folder_name: String,
    pub folder_path: String,
}

fn normalize_project_folder_name(project_name: &str) -> String {
    let mut normalized = String::new();
    let mut previous_is_separator = false;

    for character in project_name.chars() {
        if character.is_ascii_alphanumeric() {
            normalized.push(character.to_ascii_lowercase());
            previous_is_separator = false;
            continue;
        }

        if normalized.is_empty() || previous_is_separator {
            continue;
        }

        normalized.push('-');
        previous_is_separator = true;
    }

    let normalized = normalized.trim_matches('-').to_string();
    if normalized.is_empty() {
        "project".to_string()
    } else {
        normalized
    }
}

fn create_project_folder(
    root_folder: &Path,
    base_folder_name: &str,
) -> Result<(String, PathBuf), String> {
    for suffix in 0..1000 {
        let folder_name = if suffix == 0 {
            base_folder_name.to_string()
        } else {
            format!("{base_folder_name}-{}", suffix + 1)
        };
        let folder_path = root_folder.join(&folder_name);

        match fs::create_dir(&folder_path) {
            Ok(_) => return Ok((folder_name, folder_path)),
            Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(format!("unable to create project folder: {error}"));
            }
        }
    }

    Err("unable to allocate a unique project folder name".to_string())
}

#[tauri::command]
pub fn sqlite_healthcheck(db_path: State<'_, DbPath>) -> Result<String, String> {
    with_connection(&db_path.0, |conn| {
        conn.query_row("SELECT sqlite_version()", [], |row| row.get(0))
    })
}

#[tauri::command]
pub fn sqlite_db_path(db_path: State<'_, DbPath>) -> String {
    db_path.0.display().to_string()
}

#[tauri::command]
pub fn sqlite_insert_message(db_path: State<'_, DbPath>, body: String) -> Result<i64, String> {
    let body = body.trim();
    if body.is_empty() {
        return Err("message body cannot be empty".to_string());
    }

    with_connection(&db_path.0, |conn| {
        conn.execute("INSERT INTO messages (body) VALUES (?1)", params![body])?;
        Ok(conn.last_insert_rowid())
    })
}

#[tauri::command]
pub fn sqlite_list_messages(db_path: State<'_, DbPath>) -> Result<Vec<String>, String> {
    with_connection(&db_path.0, |conn| {
        let mut stmt = conn.prepare("SELECT body FROM messages ORDER BY id DESC")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        rows.collect()
    })
}

#[tauri::command]
pub fn sqlite_list_projects(db_path: State<'_, DbPath>) -> Result<Vec<CreatedProject>, String> {
    with_connection(&db_path.0, |conn| {
        let mut stmt = conn
            .prepare("SELECT id, name, folder_name, folder_path FROM projects ORDER BY id DESC")?;
        let rows = stmt.query_map([], |row| {
            Ok(CreatedProject {
                id: row.get(0)?,
                name: row.get(1)?,
                folder_name: row.get(2)?,
                folder_path: row.get(3)?,
            })
        })?;
        rows.collect()
    })
}

#[tauri::command]
pub fn sqlite_get_development_folder(db_path: State<'_, DbPath>) -> Result<Option<String>, String> {
    with_connection(&db_path.0, |conn| {
        conn.query_row(
            "SELECT value FROM app_settings WHERE key = ?1",
            params![DEVELOPMENT_FOLDER_KEY],
            |row| row.get(0),
        )
        .optional()
    })
}

#[tauri::command]
pub fn sqlite_set_development_folder(
    db_path: State<'_, DbPath>,
    folder_path: String,
) -> Result<(), String> {
    let folder_path = folder_path.trim();
    if folder_path.is_empty() {
        return Err("folder path cannot be empty".to_string());
    }

    let folder = Path::new(folder_path);
    if !folder.is_dir() {
        return Err("selected folder does not exist".to_string());
    }

    let normalized = folder
        .canonicalize()
        .map_err(|_| "unable to resolve folder path".to_string())?;
    let normalized_value = normalized.display().to_string();

    with_connection(&db_path.0, |conn| {
        conn.execute(
            "
            INSERT INTO app_settings (key, value, updated_at)
            VALUES (?1, ?2, CURRENT_TIMESTAMP)
            ON CONFLICT(key) DO UPDATE SET
                value = excluded.value,
                updated_at = CURRENT_TIMESTAMP
            ",
            params![DEVELOPMENT_FOLDER_KEY, normalized_value],
        )?;
        Ok(())
    })
}

#[tauri::command]
pub fn sqlite_create_project(
    db_path: State<'_, DbPath>,
    project_name: String,
) -> Result<CreatedProject, String> {
    let project_name = project_name.trim();
    if project_name.is_empty() {
        return Err("project name cannot be empty".to_string());
    }

    let development_folder = with_connection(&db_path.0, |conn| {
        conn.query_row(
            "SELECT value FROM app_settings WHERE key = ?1",
            params![DEVELOPMENT_FOLDER_KEY],
            |row| row.get::<_, String>(0),
        )
        .optional()
    })?
    .ok_or_else(|| "development folder is not configured".to_string())?;

    let development_path = PathBuf::from(&development_folder);
    if !development_path.is_dir() {
        return Err("configured development folder is not available".to_string());
    }

    let base_folder_name = normalize_project_folder_name(project_name);
    let (folder_name, folder_path) = create_project_folder(&development_path, &base_folder_name)?;
    let folder_path_value = folder_path.display().to_string();

    let insert_result = with_connection(&db_path.0, |conn| {
        conn.execute(
            "INSERT INTO projects (name, folder_name, folder_path) VALUES (?1, ?2, ?3)",
            params![project_name, &folder_name, &folder_path_value],
        )?;
        Ok(conn.last_insert_rowid())
    });

    match insert_result {
        Ok(id) => Ok(CreatedProject {
            id,
            name: project_name.to_string(),
            folder_name,
            folder_path: folder_path_value,
        }),
        Err(error) => {
            let _ = fs::remove_dir(&folder_path);
            Err(error)
        }
    }
}

#[tauri::command]
pub async fn pick_development_folder() -> Option<String> {
    rfd::AsyncFileDialog::new()
        .set_title("Select Development Folder")
        .pick_folder()
        .await
        .map(|handle| handle.path().display().to_string())
}
