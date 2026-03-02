use crate::github_auth::{
    current_session_access_token, github_http_client, read_persisted_token, remember_access_token,
    GithubAuthState,
};
use reqwest::header::HeaderMap;
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::State;

pub const INTAKE_LABEL_PREFIX: &str = "intake:";
pub const AGENT_LABEL_PREFIX: &str = "agent:";
pub const DENY_SIGNAL_LABELS: &[&str] = &["epic", "large", "size:xl", "scope:epic"];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubIssueIntakeRequest {
    pub repository_full_name: String,
    pub issue_number: i64,
    pub agent_label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubIssueIntakePolicyInput {
    pub state: String,
    pub is_pull_request: bool,
    pub labels: Vec<String>,
    pub body: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GithubIssueIntakeOutcome {
    pub accepted: bool,
    pub reason_code: Option<String>,
    pub fix_hint: Option<String>,
}

impl GithubIssueIntakeOutcome {
    fn accepted() -> Self {
        Self {
            accepted: true,
            reason_code: None,
            fix_hint: None,
        }
    }

    fn rejected(reason_code: &str, fix_hint: &str) -> Self {
        Self {
            accepted: false,
            reason_code: Some(reason_code.to_string()),
            fix_hint: Some(fix_hint.to_string()),
        }
    }
}

#[derive(Debug, Clone)]
pub struct GithubApiResponse {
    pub status: u16,
    pub body: Option<String>,
    pub retry_after_seconds: Option<u64>,
    pub rate_limit_reset_epoch_seconds: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct GithubIssueApiLabel {
    name: String,
}

#[derive(Debug, Deserialize)]
struct GithubIssueApiPullRequestMarker {}

#[derive(Debug, Deserialize)]
struct GithubIssueApiItem {
    state: String,
    #[serde(default)]
    labels: Vec<GithubIssueApiLabel>,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    pull_request: Option<GithubIssueApiPullRequestMarker>,
}

#[derive(Debug, Serialize)]
struct GithubIssueLabelsMutation {
    labels: Vec<String>,
}

pub fn evaluate_issue_intake_policy(issue: &GithubIssueIntakePolicyInput) -> GithubIssueIntakeOutcome {
    if issue.is_pull_request {
        return GithubIssueIntakeOutcome::rejected(
            "is_pull_request",
            "Move an issue card instead of a pull request.",
        );
    }

    if !issue.state.eq_ignore_ascii_case("open") {
        return GithubIssueIntakeOutcome::rejected(
            "issue_closed",
            "Reopen the issue before moving it to In Progress.",
        );
    }

    let has_body = issue
        .body
        .as_deref()
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false);
    if !has_body {
        return GithubIssueIntakeOutcome::rejected(
            "empty_body",
            "Add implementation details to the issue body before intake.",
        );
    }

    let has_intake_label = issue
        .labels
        .iter()
        .any(|label| label.trim().to_ascii_lowercase().starts_with(INTAKE_LABEL_PREFIX));
    if !has_intake_label {
        return GithubIssueIntakeOutcome::rejected(
            "missing_intake_label",
            "Add an intake:* label to mark the issue as intake-eligible.",
        );
    }

    let has_deny_signal = issue.labels.iter().any(|label| {
        let normalized = label.trim().to_ascii_lowercase();
        DENY_SIGNAL_LABELS
            .iter()
            .any(|deny_label| normalized == *deny_label)
    });
    if has_deny_signal {
        return GithubIssueIntakeOutcome::rejected(
            "deny_signal_present",
            "Split the issue into smaller tasks and remove epic/large markers.",
        );
    }

    GithubIssueIntakeOutcome::accepted()
}

fn normalize_label(label: &str) -> String {
    label.trim().to_ascii_lowercase()
}

pub fn normalize_agent_label(agent_label: &str) -> Option<String> {
    let normalized = normalize_label(agent_label);
    if normalized.is_empty() {
        return None;
    }

    if normalized.starts_with(AGENT_LABEL_PREFIX) {
        if normalized.len() <= AGENT_LABEL_PREFIX.len() {
            return None;
        }
        return Some(normalized);
    }

    Some(format!("{AGENT_LABEL_PREFIX}{normalized}"))
}

pub fn labels_satisfy_intake_acceptance(labels: &[String], agent_label: &str) -> bool {
    let normalized_agent_label = normalize_label(agent_label);
    if normalized_agent_label.is_empty() {
        return false;
    }

    let has_intake_label = labels
        .iter()
        .any(|label| normalize_label(label).starts_with(INTAKE_LABEL_PREFIX));
    let has_agent_label = labels
        .iter()
        .any(|label| normalize_label(label) == normalized_agent_label);

    has_intake_label && has_agent_label
}

fn parse_retry_after_seconds(headers: &HeaderMap) -> Option<u64> {
    headers
        .get("retry-after")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse::<u64>().ok())
}

fn parse_rate_limit_reset_epoch_seconds(headers: &HeaderMap) -> Option<i64> {
    headers
        .get("x-ratelimit-reset")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse::<i64>().ok())
}

fn current_epoch_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

fn map_issue_fetch_failure(response: &GithubApiResponse) -> GithubIssueIntakeOutcome {
    if response.status == 401 {
        return GithubIssueIntakeOutcome::rejected(
            "label_persist_failed",
            "GitHub session expired. Reconnect GitHub and retry intake.",
        );
    }

    if response.status == 404 {
        return GithubIssueIntakeOutcome::rejected(
            "label_persist_failed",
            "Issue no longer exists in this repository. Refresh and try again.",
        );
    }

    GithubIssueIntakeOutcome::rejected(
        "label_persist_failed",
        "GitHub issue details could not be verified. Retry intake after connectivity recovers.",
    )
}

pub fn map_label_persist_failure(response: &GithubApiResponse) -> GithubIssueIntakeOutcome {
    if response.status == 429 || response.status == 403 {
        if let Some(retry_after_seconds) = response.retry_after_seconds {
            return GithubIssueIntakeOutcome::rejected(
                "label_persist_rate_limited",
                &format!(
                    "GitHub rate limit reached. Retry this intake in about {retry_after_seconds} seconds."
                ),
            );
        }

        if let Some(reset_epoch_seconds) = response.rate_limit_reset_epoch_seconds {
            let now_seconds = current_epoch_seconds();
            let retry_after_seconds = (reset_epoch_seconds - now_seconds).max(1);
            return GithubIssueIntakeOutcome::rejected(
                "label_persist_rate_limited",
                &format!(
                    "GitHub rate limit reached. Retry this intake in about {retry_after_seconds} seconds."
                ),
            );
        }

        return GithubIssueIntakeOutcome::rejected(
            "label_persist_rate_limited",
            "GitHub rate limit reached. Retry this intake shortly.",
        );
    }

    let fallback_hint = if let Some(body) = response.body.as_deref() {
        if body.trim().is_empty() {
            "GitHub label write did not persist. Retry intake after GitHub is healthy.".to_string()
        } else {
            "GitHub label write did not persist. Retry intake after GitHub is healthy.".to_string()
        }
    } else {
        "GitHub label write did not persist. Retry intake after GitHub is healthy.".to_string()
    };

    GithubIssueIntakeOutcome::rejected("label_persist_failed", &fallback_hint)
}

async fn fetch_github_issue(
    client: &reqwest::Client,
    token: &str,
    repository_full_name: &str,
    issue_number: i64,
) -> Result<GithubIssueApiItem, GithubApiResponse> {
    let issue_url = format!(
        "https://api.github.com/repos/{repository_full_name}/issues/{issue_number}"
    );

    let response = client
        .get(&issue_url)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .bearer_auth(token)
        .send()
        .await
        .map_err(|error| GithubApiResponse {
            status: 0,
            body: Some(error.to_string()),
            retry_after_seconds: None,
            rate_limit_reset_epoch_seconds: None,
        })?;

    if !response.status().is_success() {
        let status = response.status().as_u16();
        let retry_after_seconds = parse_retry_after_seconds(response.headers());
        let rate_limit_reset_epoch_seconds =
            parse_rate_limit_reset_epoch_seconds(response.headers());
        let body = response.text().await.ok();
        return Err(GithubApiResponse {
            status,
            body,
            retry_after_seconds,
            rate_limit_reset_epoch_seconds,
        });
    }

    response
        .json::<GithubIssueApiItem>()
        .await
        .map_err(|error| GithubApiResponse {
            status: 500,
            body: Some(format!("Failed to parse GitHub issue response: {error}")),
            retry_after_seconds: None,
            rate_limit_reset_epoch_seconds: None,
        })
}

async fn apply_issue_labels(
    client: &reqwest::Client,
    token: &str,
    repository_full_name: &str,
    issue_number: i64,
    labels: &[String],
) -> Result<(), GithubApiResponse> {
    let labels_url = format!(
        "https://api.github.com/repos/{repository_full_name}/issues/{issue_number}/labels"
    );

    let request_body = GithubIssueLabelsMutation {
        labels: labels.to_vec(),
    };

    let response = client
        .post(&labels_url)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .bearer_auth(token)
        .json(&request_body)
        .send()
        .await
        .map_err(|error| GithubApiResponse {
            status: 0,
            body: Some(error.to_string()),
            retry_after_seconds: None,
            rate_limit_reset_epoch_seconds: None,
        })?;

    if !response.status().is_success() {
        let status = response.status().as_u16();
        let retry_after_seconds = parse_retry_after_seconds(response.headers());
        let rate_limit_reset_epoch_seconds =
            parse_rate_limit_reset_epoch_seconds(response.headers());
        let body = response.text().await.ok();
        return Err(GithubApiResponse {
            status,
            body,
            retry_after_seconds,
            rate_limit_reset_epoch_seconds,
        });
    }

    Ok(())
}

fn resolve_github_token(state: &GithubAuthState) -> Option<String> {
    match current_session_access_token(state) {
        Ok(Some(token)) => Some(token),
        Ok(None) => match read_persisted_token() {
            Ok(Some(token)) => {
                let _ = remember_access_token(state, token.clone());
                Some(token)
            }
            _ => None,
        },
        Err(_) => None,
    }
}

#[tauri::command]
pub async fn github_attempt_issue_intake(
    state: State<'_, GithubAuthState>,
    request: GithubIssueIntakeRequest,
) -> Result<GithubIssueIntakeOutcome, String> {
    let repository_full_name = request.repository_full_name.trim();
    if repository_full_name.is_empty() || !repository_full_name.contains('/') || request.issue_number <= 0 {
        return Ok(GithubIssueIntakeOutcome::rejected(
            "label_persist_failed",
            "Select a valid repository issue before retrying intake.",
        ));
    }

    let Some(agent_label) = normalize_agent_label(&request.agent_label) else {
        return Ok(GithubIssueIntakeOutcome::rejected(
            "label_persist_failed",
            "Agent ownership label is invalid. Retry with a valid agent label.",
        ));
    };

    let Some(token) = resolve_github_token(&state) else {
        return Ok(GithubIssueIntakeOutcome::rejected(
            "label_persist_failed",
            "Connect GitHub before attempting issue intake.",
        ));
    };

    let client = match github_http_client() {
        Ok(client) => client,
        Err(_) => {
            return Ok(GithubIssueIntakeOutcome::rejected(
                "label_persist_failed",
                "GitHub client initialization failed. Retry intake.",
            ));
        }
    };

    let issue = match fetch_github_issue(&client, &token, repository_full_name, request.issue_number).await {
        Ok(issue) => issue,
        Err(response) => return Ok(map_issue_fetch_failure(&response)),
    };

    let issue_labels = issue
        .labels
        .iter()
        .map(|label| label.name.clone())
        .collect::<Vec<_>>();
    let policy_outcome = evaluate_issue_intake_policy(&GithubIssueIntakePolicyInput {
        state: issue.state,
        is_pull_request: issue.pull_request.is_some(),
        labels: issue_labels.clone(),
        body: issue.body,
    });

    if !policy_outcome.accepted {
        return Ok(policy_outcome);
    }

    let intake_label = issue_labels.iter().find_map(|label| {
        let normalized = normalize_label(label);
        if normalized.starts_with(INTAKE_LABEL_PREFIX) {
            Some(normalized)
        } else {
            None
        }
    });

    let Some(intake_label) = intake_label else {
        return Ok(GithubIssueIntakeOutcome::rejected(
            "missing_intake_label",
            "Add an intake:* label to mark the issue as intake-eligible.",
        ));
    };

    let required_labels = vec![intake_label, agent_label.clone()];

    if let Err(response) = apply_issue_labels(
        &client,
        &token,
        repository_full_name,
        request.issue_number,
        &required_labels,
    )
    .await
    {
        return Ok(map_label_persist_failure(&response));
    }

    let refreshed_issue = match fetch_github_issue(&client, &token, repository_full_name, request.issue_number).await {
        Ok(issue) => issue,
        Err(response) => return Ok(map_label_persist_failure(&response)),
    };

    let refreshed_labels = refreshed_issue
        .labels
        .into_iter()
        .map(|label| label.name)
        .collect::<Vec<_>>();

    if !labels_satisfy_intake_acceptance(&refreshed_labels, &agent_label) {
        return Ok(GithubIssueIntakeOutcome::rejected(
            "label_persist_failed",
            "Required intake labels did not persist on GitHub. Retry intake.",
        ));
    }

    Ok(GithubIssueIntakeOutcome::accepted())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Clone)]
    struct PolicyCase {
        name: &'static str,
        issue: GithubIssueIntakePolicyInput,
        expected: GithubIssueIntakeOutcome,
    }

    fn valid_issue() -> GithubIssueIntakePolicyInput {
        GithubIssueIntakePolicyInput {
            state: "open".to_string(),
            is_pull_request: false,
            labels: vec!["intake:small".to_string()],
            body: Some("Implement this in one focused PR.".to_string()),
        }
    }

    #[test]
    fn policy_locked_decisions_table() {
        let cases = vec![
            PolicyCase {
                name: "accept_open_issue_with_body_and_intake_label",
                issue: valid_issue(),
                expected: GithubIssueIntakeOutcome::accepted(),
            },
            PolicyCase {
                name: "reject_closed_issue",
                issue: GithubIssueIntakePolicyInput {
                    state: "closed".to_string(),
                    ..valid_issue()
                },
                expected: GithubIssueIntakeOutcome::rejected(
                    "issue_closed",
                    "Reopen the issue before moving it to In Progress.",
                ),
            },
            PolicyCase {
                name: "reject_pull_request",
                issue: GithubIssueIntakePolicyInput {
                    is_pull_request: true,
                    ..valid_issue()
                },
                expected: GithubIssueIntakeOutcome::rejected(
                    "is_pull_request",
                    "Move an issue card instead of a pull request.",
                ),
            },
            PolicyCase {
                name: "reject_empty_body",
                issue: GithubIssueIntakePolicyInput {
                    body: Some("   ".to_string()),
                    ..valid_issue()
                },
                expected: GithubIssueIntakeOutcome::rejected(
                    "empty_body",
                    "Add implementation details to the issue body before intake.",
                ),
            },
            PolicyCase {
                name: "reject_missing_intake_label_family",
                issue: GithubIssueIntakePolicyInput {
                    labels: vec!["triage".to_string()],
                    ..valid_issue()
                },
                expected: GithubIssueIntakeOutcome::rejected(
                    "missing_intake_label",
                    "Add an intake:* label to mark the issue as intake-eligible.",
                ),
            },
            PolicyCase {
                name: "reject_deny_signal_label",
                issue: GithubIssueIntakePolicyInput {
                    labels: vec!["intake:small".to_string(), "epic".to_string()],
                    ..valid_issue()
                },
                expected: GithubIssueIntakeOutcome::rejected(
                    "deny_signal_present",
                    "Split the issue into smaller tasks and remove epic/large markers.",
                ),
            },
        ];

        for case in cases {
            let actual = evaluate_issue_intake_policy(&case.issue);
            assert_eq!(actual, case.expected, "case failed: {}", case.name);
        }
    }

    #[test]
    fn command_helpers_normalize_agent_label_prefix() {
        assert_eq!(
            normalize_agent_label("hostlocal").expect("agent label"),
            "agent:hostlocal"
        );
        assert_eq!(
            normalize_agent_label("agent:runner").expect("agent label"),
            "agent:runner"
        );
    }

    #[test]
    fn command_helpers_reject_empty_agent_label() {
        assert!(normalize_agent_label("   ").is_none());
    }

    #[test]
    fn command_helpers_detect_required_labels() {
        let labels = vec!["intake:small".to_string(), "agent:hostlocal".to_string()];
        assert!(labels_satisfy_intake_acceptance(&labels, "agent:hostlocal"));
        assert!(!labels_satisfy_intake_acceptance(&labels, "agent:other"));
    }

    #[test]
    fn command_helpers_map_rate_limit_failure() {
        let response = GithubApiResponse {
            status: 429,
            body: Some("too many requests".to_string()),
            retry_after_seconds: Some(30),
            rate_limit_reset_epoch_seconds: None,
        };

        let outcome = map_label_persist_failure(&response);
        assert_eq!(outcome.reason_code.as_deref(), Some("label_persist_rate_limited"));
        assert_eq!(
            outcome.fix_hint.as_deref(),
            Some("GitHub rate limit reached. Retry this intake in about 30 seconds.")
        );
    }
}
