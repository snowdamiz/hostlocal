use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::State;

const DEVICE_CODE_URL: &str = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL: &str = "https://github.com/login/oauth/access_token";
const VIEWER_URL: &str = "https://api.github.com/user";
const REPOSITORIES_URL: &str = "https://api.github.com/user/repos";
const REPOSITORY_ISSUES_BASE_URL: &str = "https://api.github.com/repos";
const DEVICE_GRANT_TYPE: &str = "urn:ietf:params:oauth:grant-type:device_code";
const USER_AGENT: &str = "hostlocal-github-auth";
const GITHUB_CLIENT_ID: &str = "Ov23liFYf8FT68KkI3jg";
const KEYRING_SERVICE: &str = "com.sn0w.hostlocal";
const KEYRING_ACCOUNT: &str = "github_access_token";

#[derive(Default)]
pub struct GithubAuthState {
    session: Mutex<GithubSession>,
}

#[derive(Default)]
struct GithubSession {
    access_token: Option<String>,
    user: Option<GithubUser>,
    pending: Option<PendingDeviceAuth>,
}

#[derive(Clone)]
struct PendingDeviceAuth {
    device_code: String,
    user_code: String,
    verification_uri: String,
    expires_at_epoch_seconds: i64,
    interval_seconds: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GithubUser {
    pub login: String,
    #[serde(rename(serialize = "avatarUrl", deserialize = "avatar_url"))]
    pub avatar_url: String,
    #[serde(rename(serialize = "htmlUrl", deserialize = "html_url"))]
    pub html_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GithubRepository {
    pub id: i64,
    pub name: String,
    #[serde(rename(serialize = "fullName", deserialize = "full_name"))]
    pub full_name: String,
    #[serde(rename(serialize = "htmlUrl", deserialize = "html_url"))]
    pub html_url: String,
    #[serde(rename(serialize = "isPrivate", deserialize = "private"))]
    pub is_private: bool,
    #[serde(default)]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubRepositoryItem {
    pub id: i64,
    pub number: i64,
    pub title: String,
    pub html_url: String,
    pub state: String,
    pub is_pull_request: bool,
    pub draft: bool,
    pub labels: Vec<String>,
    pub assignees: Vec<String>,
    pub author_login: Option<String>,
    pub body: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubAuthStatusResponse {
    pub connected: bool,
    pub user: Option<GithubUser>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubDeviceAuthStartResponse {
    pub user_code: String,
    pub verification_uri: String,
    pub expires_at_epoch_seconds: i64,
    pub interval_seconds: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubDeviceAuthPollResponse {
    pub status: String,
    pub user: Option<GithubUser>,
}

#[derive(Debug, Deserialize)]
struct DeviceCodeResponse {
    device_code: String,
    user_code: String,
    verification_uri: String,
    expires_in: i64,
    interval: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct AccessTokenSuccessResponse {
    access_token: String,
}

#[derive(Debug, Deserialize)]
struct AccessTokenErrorResponse {
    error: String,
}

#[derive(Debug, Deserialize)]
struct GithubIssuePullRequestMarker {}

#[derive(Debug, Deserialize)]
struct GithubRepositoryIssueLabel {
    name: String,
}

#[derive(Debug, Clone, Deserialize)]
struct GithubRepositoryIssueUser {
    login: String,
}

#[derive(Debug, Deserialize)]
struct GithubRepositoryIssueItem {
    id: i64,
    number: i64,
    title: String,
    html_url: String,
    state: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    labels: Vec<GithubRepositoryIssueLabel>,
    #[serde(default)]
    assignees: Vec<GithubRepositoryIssueUser>,
    #[serde(default)]
    user: Option<GithubRepositoryIssueUser>,
    #[serde(default)]
    body: Option<String>,
    updated_at: String,
    #[serde(default)]
    pull_request: Option<GithubIssuePullRequestMarker>,
}

pub fn github_client_id() -> Result<String, String> {
    Ok(GITHUB_CLIENT_ID.to_string())
}

fn now_epoch_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

fn github_http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .build()
        .map_err(|e| e.to_string())
}

fn map_http_error(status: StatusCode, body: String) -> String {
    let normalized_body = body.trim();
    if normalized_body.is_empty() {
        format!("GitHub request failed with status {}", status.as_u16())
    } else {
        format!(
            "GitHub request failed with status {}: {}",
            status.as_u16(),
            normalized_body
        )
    }
}

fn keyring_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT).map_err(|e| e.to_string())
}

fn read_persisted_token() -> Result<Option<String>, String> {
    let entry = keyring_entry()?;
    match entry.get_password() {
        Ok(token) => Ok(Some(token)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

fn persist_token(token: &str) -> Result<(), String> {
    let entry = keyring_entry()?;
    entry.set_password(token).map_err(|e| e.to_string())
}

fn clear_persisted_token() -> Result<(), String> {
    let entry = keyring_entry()?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

async fn fetch_viewer(token: &str) -> Result<GithubUser, String> {
    let client = github_http_client()?;
    let response = client
        .get(VIEWER_URL)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(map_http_error(status, body));
    }

    response
        .json::<GithubUser>()
        .await
        .map_err(|e| e.to_string())
}

async fn fetch_repositories(token: &str) -> Result<Vec<GithubRepository>, String> {
    let client = github_http_client()?;
    let mut repositories: Vec<GithubRepository> = Vec::new();
    let mut page: u32 = 1;

    loop {
        let url = format!("{REPOSITORIES_URL}?sort=updated&per_page=100&page={page}");
        let response = client
            .get(&url)
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28")
            .bearer_auth(token)
            .send()
            .await
            .map_err(|e| e.to_string())?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(map_http_error(status, body));
        }

        let batch = response
            .json::<Vec<GithubRepository>>()
            .await
            .map_err(|e| e.to_string())?;
        let batch_len = batch.len();
        if batch_len == 0 {
            break;
        }
        repositories.extend(batch);
        if batch_len < 100 {
            break;
        }

        page += 1;
    }

    Ok(repositories)
}

async fn fetch_repository_items(
    token: &str,
    repository_full_name: &str,
) -> Result<Vec<GithubRepositoryItem>, String> {
    let repository_full_name = repository_full_name.trim();
    if repository_full_name.is_empty() {
        return Err("Repository name is required.".to_string());
    }

    if !repository_full_name.contains('/') {
        return Err("Repository name must be in owner/repository format.".to_string());
    }

    let client = github_http_client()?;
    let mut items: Vec<GithubRepositoryItem> = Vec::new();
    let mut page: u32 = 1;

    loop {
        let url = format!(
            "{REPOSITORY_ISSUES_BASE_URL}/{repository_full_name}/issues?state=all&sort=updated&direction=desc&per_page=100&page={page}"
        );
        let response = client
            .get(&url)
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28")
            .bearer_auth(token)
            .send()
            .await
            .map_err(|e| e.to_string())?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(map_http_error(status, body));
        }

        let batch = response
            .json::<Vec<GithubRepositoryIssueItem>>()
            .await
            .map_err(|e| e.to_string())?;
        let batch_len = batch.len();
        if batch_len == 0 {
            break;
        }

        items.extend(batch.into_iter().map(|item| {
            GithubRepositoryItem {
                id: item.id,
                number: item.number,
                title: item.title,
                html_url: item.html_url,
                state: item.state,
                is_pull_request: item.pull_request.is_some(),
                draft: item.draft,
                labels: item.labels.into_iter().map(|label| label.name).collect(),
                assignees: item
                    .assignees
                    .into_iter()
                    .map(|assignee| assignee.login)
                    .collect(),
                author_login: item.user.map(|user| user.login),
                body: item.body,
                updated_at: item.updated_at,
            }
        }));

        if batch_len < 100 {
            break;
        }

        page += 1;
    }

    Ok(items)
}

#[tauri::command]
pub async fn github_auth_status(
    state: State<'_, GithubAuthState>,
) -> Result<GithubAuthStatusResponse, String> {
    {
        let session = state
            .session
            .lock()
            .map_err(|_| "Failed to access auth state".to_string())?;
        if session.access_token.is_some() && session.user.is_some() {
            return Ok(GithubAuthStatusResponse {
                connected: true,
                user: session.user.clone(),
            });
        }
    }

    let Some(token) = (match read_persisted_token() {
        Ok(token) => token,
        Err(error) => {
            eprintln!("Failed to read GitHub token from keyring: {error}");
            None
        }
    }) else {
        return Ok(GithubAuthStatusResponse {
            connected: false,
            user: None,
        });
    };

    match fetch_viewer(&token).await {
        Ok(user) => {
            let mut session = state
                .session
                .lock()
                .map_err(|_| "Failed to access auth state".to_string())?;
            session.access_token = Some(token);
            session.user = Some(user.clone());

            Ok(GithubAuthStatusResponse {
                connected: true,
                user: Some(user),
            })
        }
        Err(_) => {
            let _ = clear_persisted_token();
            let mut session = state
                .session
                .lock()
                .map_err(|_| "Failed to access auth state".to_string())?;
            session.access_token = None;
            session.user = None;
            session.pending = None;
            Ok(GithubAuthStatusResponse {
                connected: false,
                user: None,
            })
        }
    }
}

#[tauri::command]
pub async fn github_list_repositories(
    state: State<'_, GithubAuthState>,
) -> Result<Vec<GithubRepository>, String> {
    let session_token = {
        let session = state
            .session
            .lock()
            .map_err(|_| "Failed to access auth state".to_string())?;
        session.access_token.clone()
    };

    let token = if let Some(token) = session_token {
        token
    } else {
        match read_persisted_token() {
            Ok(Some(token)) => token,
            Ok(None) => return Err("Connect GitHub to load repositories.".to_string()),
            Err(error) => {
                eprintln!("Failed to read GitHub token from keyring: {error}");
                return Err("Connect GitHub to load repositories.".to_string());
            }
        }
    };

    match fetch_repositories(&token).await {
        Ok(repositories) => {
            let mut session = state
                .session
                .lock()
                .map_err(|_| "Failed to access auth state".to_string())?;
            session.access_token = Some(token);
            Ok(repositories)
        }
        Err(error) => {
            if error.contains("status 401") {
                let _ = clear_persisted_token();
                let mut session = state
                    .session
                    .lock()
                    .map_err(|_| "Failed to access auth state".to_string())?;
                session.access_token = None;
                session.user = None;
                session.pending = None;
                return Err("GitHub session expired. Connect again.".to_string());
            }
            Err(error)
        }
    }
}

#[tauri::command]
pub async fn github_list_repository_items(
    state: State<'_, GithubAuthState>,
    repository_full_name: String,
) -> Result<Vec<GithubRepositoryItem>, String> {
    let session_token = {
        let session = state
            .session
            .lock()
            .map_err(|_| "Failed to access auth state".to_string())?;
        session.access_token.clone()
    };

    let token = if let Some(token) = session_token {
        token
    } else {
        match read_persisted_token() {
            Ok(Some(token)) => token,
            Ok(None) => return Err("Connect GitHub to load repository items.".to_string()),
            Err(error) => {
                eprintln!("Failed to read GitHub token from keyring: {error}");
                return Err("Connect GitHub to load repository items.".to_string());
            }
        }
    };

    match fetch_repository_items(&token, &repository_full_name).await {
        Ok(items) => {
            let mut session = state
                .session
                .lock()
                .map_err(|_| "Failed to access auth state".to_string())?;
            session.access_token = Some(token);
            Ok(items)
        }
        Err(error) => {
            if error.contains("status 401") {
                let _ = clear_persisted_token();
                let mut session = state
                    .session
                    .lock()
                    .map_err(|_| "Failed to access auth state".to_string())?;
                session.access_token = None;
                session.user = None;
                session.pending = None;
                return Err("GitHub session expired. Connect again.".to_string());
            }
            Err(error)
        }
    }
}

#[tauri::command]
pub fn github_auth_logout(state: State<'_, GithubAuthState>) -> Result<(), String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| "Failed to access auth state".to_string())?;
    session.access_token = None;
    session.user = None;
    session.pending = None;
    if let Err(error) = clear_persisted_token() {
        eprintln!("Failed to clear GitHub token from keyring: {error}");
    }
    Ok(())
}

#[tauri::command]
pub fn github_open_verification_url(url: String) -> Result<(), String> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return Err("Verification URL is empty".to_string());
    }

    if !trimmed.starts_with("https://github.com/login/device") {
        return Err("Invalid verification URL".to_string());
    }

    webbrowser::open(trimmed)
        .map(|_| ())
        .map_err(|e| format!("Unable to open browser: {e}"))
}

#[tauri::command]
pub fn github_open_item_url(url: String) -> Result<(), String> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return Err("URL is empty".to_string());
    }

    if !trimmed.starts_with("https://github.com/") {
        return Err("Invalid GitHub URL".to_string());
    }

    webbrowser::open(trimmed)
        .map(|_| ())
        .map_err(|e| format!("Unable to open browser: {e}"))
}

#[tauri::command]
pub async fn github_auth_start(
    state: State<'_, GithubAuthState>,
) -> Result<GithubDeviceAuthStartResponse, String> {
    let client_id = github_client_id()?;
    let client = github_http_client()?;

    let response = client
        .post(DEVICE_CODE_URL)
        .header("Accept", "application/json")
        .form(&[
            ("client_id", client_id.as_str()),
            ("scope", "read:user user:email repo"),
        ])
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(map_http_error(status, body));
    }

    let payload = response
        .json::<DeviceCodeResponse>()
        .await
        .map_err(|e| e.to_string())?;

    let interval_seconds = payload.interval.unwrap_or(5);
    let pending = PendingDeviceAuth {
        device_code: payload.device_code.clone(),
        user_code: payload.user_code.clone(),
        verification_uri: payload.verification_uri.clone(),
        expires_at_epoch_seconds: now_epoch_seconds() + payload.expires_in,
        interval_seconds,
    };

    {
        let mut session = state
            .session
            .lock()
            .map_err(|_| "Failed to access auth state".to_string())?;
        session.access_token = None;
        session.user = None;
        session.pending = Some(pending.clone());
    }

    Ok(GithubDeviceAuthStartResponse {
        user_code: pending.user_code,
        verification_uri: pending.verification_uri,
        expires_at_epoch_seconds: pending.expires_at_epoch_seconds,
        interval_seconds: pending.interval_seconds,
    })
}

#[tauri::command]
pub async fn github_auth_poll(
    state: State<'_, GithubAuthState>,
) -> Result<GithubDeviceAuthPollResponse, String> {
    let client_id = github_client_id()?;

    let pending = {
        let session = state
            .session
            .lock()
            .map_err(|_| "Failed to access auth state".to_string())?;
        session.pending.clone()
    }
    .ok_or_else(|| "No GitHub device authorization is currently pending".to_string())?;

    if now_epoch_seconds() >= pending.expires_at_epoch_seconds {
        let mut session = state
            .session
            .lock()
            .map_err(|_| "Failed to access auth state".to_string())?;
        session.pending = None;
        return Ok(GithubDeviceAuthPollResponse {
            status: "expired".to_string(),
            user: None,
        });
    }

    let client = github_http_client()?;
    let response = client
        .post(ACCESS_TOKEN_URL)
        .header("Accept", "application/json")
        .form(&[
            ("client_id", client_id.as_str()),
            ("device_code", pending.device_code.as_str()),
            ("grant_type", DEVICE_GRANT_TYPE),
        ])
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(map_http_error(status, body));
    }

    let payload = response.text().await.map_err(|e| e.to_string())?;
    if let Ok(success) = serde_json::from_str::<AccessTokenSuccessResponse>(&payload) {
        let user = fetch_viewer(&success.access_token).await?;
        let mut session = state
            .session
            .lock()
            .map_err(|_| "Failed to access auth state".to_string())?;
        session.access_token = Some(success.access_token);
        session.user = Some(user.clone());
        session.pending = None;
        if let Some(token) = &session.access_token {
            if let Err(error) = persist_token(token) {
                eprintln!("Failed to persist GitHub token to keyring: {error}");
            }
        }

        return Ok(GithubDeviceAuthPollResponse {
            status: "authorized".to_string(),
            user: Some(user),
        });
    }

    let error = serde_json::from_str::<AccessTokenErrorResponse>(&payload)
        .map_err(|_| "Unexpected GitHub auth response".to_string())?;

    let status = match error.error.as_str() {
        "authorization_pending" => "pending",
        "slow_down" => "slow_down",
        "expired_token" => {
            let mut session = state
                .session
                .lock()
                .map_err(|_| "Failed to access auth state".to_string())?;
            session.pending = None;
            "expired"
        }
        "access_denied" => {
            let mut session = state
                .session
                .lock()
                .map_err(|_| "Failed to access auth state".to_string())?;
            session.pending = None;
            "denied"
        }
        _ => return Err(format!("GitHub auth failed: {}", error.error)),
    };

    Ok(GithubDeviceAuthPollResponse {
        status: status.to_string(),
        user: None,
    })
}
