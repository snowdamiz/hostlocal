use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::ErrorKind,
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize};

const WINDOW_STATE_FILENAME: &str = "window-state.json";

#[derive(Debug, Deserialize, Serialize)]
pub struct SavedWindowState {
    pub width: u32,
    pub height: u32,
    pub x: i32,
    pub y: i32,
}

pub fn app_window_state_path(app: &AppHandle) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let app_config_dir = app.path().app_config_dir()?;
    fs::create_dir_all(&app_config_dir)?;
    Ok(app_config_dir.join(WINDOW_STATE_FILENAME))
}

pub fn restore_window_state(
    window: &tauri::WebviewWindow,
    state_path: &Path,
) -> Result<(), String> {
    let state_bytes = match fs::read(state_path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
    };

    let state: SavedWindowState =
        serde_json::from_slice(&state_bytes).map_err(|error| error.to_string())?;

    if state.width > 0 && state.height > 0 {
        window
            .set_size(PhysicalSize::new(state.width, state.height))
            .map_err(|error| error.to_string())?;
    }

    window
        .set_position(PhysicalPosition::new(state.x, state.y))
        .map_err(|error| error.to_string())?;

    Ok(())
}

pub fn persist_window_state(
    window: &tauri::WebviewWindow,
    state_path: &Path,
) -> Result<(), String> {
    if window.is_minimized().unwrap_or(false) {
        return Ok(());
    }

    let size = window.outer_size().map_err(|error| error.to_string())?;
    if size.width == 0 || size.height == 0 {
        return Ok(());
    }

    let position = window.outer_position().map_err(|error| error.to_string())?;

    let state = SavedWindowState {
        width: size.width,
        height: size.height,
        x: position.x,
        y: position.y,
    };

    let json = serde_json::to_vec_pretty(&state).map_err(|error| error.to_string())?;
    fs::write(state_path, json).map_err(|error| error.to_string())
}
