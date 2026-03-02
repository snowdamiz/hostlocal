use crate::github_auth::{
    current_session_access_token, github_http_client, read_persisted_token, remember_access_token,
    GithubAuthState,
};
use reqwest::header::{HeaderMap, RETRY_AFTER};
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::State;

pub const INTAKE_LABEL_PREFIX: &str = "intake:";
pub const AGENT_LABEL_PREFIX: &str = "agent:";
pub const DENY_SIGNAL_LABELS: &[&str] = &["epic", "large", "size:xl", "scope:epic"];

const GITHUB_API_BASE_URL: &str = "https://api.github.com/repos";
const GITHUB_API_ACCEPT: &str = "application/vnd.github+json";
const GITHUB_API_VERSION: &str = "2022-11-28";

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

#[derive(Debug, Deserialize)]
struct GithubIssueLabel {
    name: String,
}

#[derive(Debug, Deserialize)]
struct GithubIssueResponse {
    state: String,
    #[serde(default)]
    pull_request: Option<serde_json::Value>,
    #[serde(default)]
    labels: Vec<GithubIssueLabel>,
    #[serde(default)]
    body: Option<String>,
}

#[derive(Debug, Serialize)]
struct GithubIssueLabelMutationRequest<'a> {
    labels: &'a [String],
}

#[derive(Debug)]
struct GithubApiResponse {
    status: u16,
    body: Option<String>,
    retry_after_seconds: Option<u64>,
    rate_limit_reset_epoch_seconds: Option<i64>,
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
            "missing_body",
            "Add implementation details to the issue body before intake.",
        );
    }

    let has_intake_label = issue
        .labels
        .iter()
        .any(|label| normalize_label(label).starts_with(INTAKE_LABEL_PREFIX));
    if !has_intake_label {
        return GithubIssueIntakeOutcome::rejected(
            "missing_intake_label",
            "Add an intake:* label to mark the issue as intake-eligible.",
        );
    }

    let has_deny_signal = issue.labels.iter().any(|label| {
        let normalized = normalize_label(label);
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

#[tauri::command]
pub async fn github_attempt_issue_intake(
    state: State<'_, GithubAuthState>,
    request: GithubIssueIntakeRequest,
) -> Result<GithubIssueIntakeOutcome, String> {
    let repository_full_name = request.repository_full_name.trim();
    if repository_full_name.is_empty() {
        return Ok(GithubIssueIntakeOutcome::rejected(
            "repository_required",
            "Select a repository before moving the issue to In Progress.",
        ));
    }
    if !repository_full_name.contains('/') {
        return Ok(GithubIssueIntakeOutcome::rejected(
            "invalid_repository_name",
            "Repository must use owner/repository format.",
        ));
    }
    if request.issue_number <= 0 {
        return Ok(GithubIssueIntakeOutcome::rejected(
            "invalid_issue_number",
            "Issue number must be a positive integer.",
        ));
    }

    let Some(agent_label) = normalize_agent_label(&request.agent_label) else {
        return Ok(GithubIssueIntakeOutcome::rejected(
            "missing_agent_label",
            "Assign an agent label before moving this issue to In Progress.",
        ));
    };

    let access_token = match resolve_access_token(&state) {
        Ok(Some(token)) => token,
        Ok(None) => {
            return Ok(GithubIssueIntakeOutcome::rejected(
                "github_auth_required",
                "Connect GitHub before moving issues to In Progress.",
            ));
        }
        Err(error) => {
            eprintln!("Failed to resolve GitHub access token for intake: {error}");
            return Ok(GithubIssueIntakeOutcome::rejected(
                "github_auth_required",
                "Reconnect GitHub and retry intake.",
            ));
        }
    };

    if let Err(error) = remember_access_token(state.inner(), access_token.clone()) {
        eprintln!("Failed to cache GitHub access token in auth session: {error}");
    }

    let client = match github_http_client() {
        Ok(client) => client,
        Err(error) => {
            eprintln!("Failed to create GitHub HTTP client for intake: {error}");
            return Ok(GithubIssueIntakeOutcome::rejected(
                "github_client_unavailable",
                "Unable to reach GitHub right now. Retry intake.",
            ));
        }
    };

    let issue = match fetch_issue(&client, &access_token, repository_full_name, request.issue_number).await
    {
        Ok(issue) => issue,
        Err(response) => return Ok(map_authoritative_fetch_failure(&response)),
    };

    let issue_labels = issue
        .labels
        .into_iter()
        .map(|label| label.name)
        .collect::<Vec<_>>();
    let policy_input = GithubIssueIntakePolicyInput {
        state: issue.state,
        is_pull_request: issue.pull_request.is_some(),
        labels: issue_labels.clone(),
        body: issue.body,
    };
    let policy_outcome = evaluate_issue_intake_policy(&policy_input);
    if !policy_outcome.accepted {
        return Ok(policy_outcome);
    }

    let Some(intake_label) = first_intake_label(&issue_labels) else {
        return Ok(GithubIssueIntakeOutcome::rejected(
            "missing_intake_label",
            "Add an intake:* label to mark the issue as intake-eligible.",
        ));
    };
    let labels_to_persist = vec![intake_label, agent_label.clone()];

    if let Err(response) = persist_issue_labels(
        &client,
        &access_token,
        repository_full_name,
        request.issue_number,
        &labels_to_persist,
    )
    .await
    {
        return Ok(map_label_persist_failure(&response));
    }

    let verified_issue =
        match fetch_issue(&client, &access_token, repository_full_name, request.issue_number).await {
            Ok(issue) => issue,
            Err(response) => return Ok(map_label_persist_failure(&response)),
        };
    let verified_labels = verified_issue
        .labels
        .into_iter()
        .map(|label| label.name)
        .collect::<Vec<_>>();
    if !labels_satisfy_intake_acceptance(&verified_labels, &agent_label) {
        return Ok(GithubIssueIntakeOutcome::rejected(
            "label_persist_failed",
            "GitHub did not persist required labels. Retry this intake.",
        ));
    }

    Ok(GithubIssueIntakeOutcome::accepted())
}

fn normalize_label(label: &str) -> String {
    label.trim().to_ascii_lowercase()
}

fn first_intake_label(labels: &[String]) -> Option<String> {
    labels
        .iter()
        .map(|label| normalize_label(label))
        .find(|label| label.starts_with(INTAKE_LABEL_PREFIX))
}

fn normalize_agent_label(agent_label: &str) -> Option<String> {
    let normalized = normalize_label(agent_label);
    if normalized.is_empty() {
        return None;
    }

    if normalized.starts_with(AGENT_LABEL_PREFIX) {
        return Some(normalized);
    }

    Some(format!("{AGENT_LABEL_PREFIX}{normalized}"))
}

fn labels_satisfy_intake_acceptance(labels: &[String], required_agent_label: &str) -> bool {
    let normalized_required_agent = normalize_label(required_agent_label);

    let has_intake_label = labels
        .iter()
        .any(|label| normalize_label(label).starts_with(INTAKE_LABEL_PREFIX));
    let has_required_agent_label = labels
        .iter()
        .any(|label| normalize_label(label) == normalized_required_agent);

    has_intake_label && has_required_agent_label
}

fn now_epoch_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

fn response_retry_after_seconds(response: &GithubApiResponse) -> Option<u64> {
    response.retry_after_seconds.or_else(|| {
        response.rate_limit_reset_epoch_seconds.map(|reset_epoch| {
            let now = now_epoch_seconds();
            if reset_epoch <= now {
                1
            } else {
                (reset_epoch - now) as u64
            }
        })
    })
}

fn map_authoritative_fetch_failure(response: &GithubApiResponse) -> GithubIssueIntakeOutcome {
    match response.status {
        401 => GithubIssueIntakeOutcome::rejected(
            "github_auth_required",
            "Reconnect GitHub and retry intake.",
        ),
        403 | 429 => {
            if let Some(retry_after_seconds) = response_retry_after_seconds(response) {
                GithubIssueIntakeOutcome::rejected(
                    "github_rate_limited",
                    &format!(
                        "GitHub rate limit reached. Retry this intake in about {} seconds.",
                        retry_after_seconds
                    ),
                )
            } else {
                GithubIssueIntakeOutcome::rejected(
                    "github_rate_limited",
                    "GitHub rate limit reached. Wait one minute and retry this intake.",
                )
            }
        }
        404 => GithubIssueIntakeOutcome::rejected(
            "issue_not_found",
            "Refresh repository items and retry this intake.",
        ),
        _ => {
            if response.body.is_some() {
                GithubIssueIntakeOutcome::rejected(
                    "github_fetch_failed",
                    "GitHub issue fetch failed. Retry this intake after checking repository access.",
                )
            } else {
                GithubIssueIntakeOutcome::rejected(
                    "github_fetch_failed",
                    "GitHub issue fetch failed. Retry this intake.",
                )
            }
        }
    }
}

fn map_label_persist_failure(response: &GithubApiResponse) -> GithubIssueIntakeOutcome {
    match response.status {
        403 | 429 => {
            if let Some(retry_after_seconds) = response_retry_after_seconds(response) {
                GithubIssueIntakeOutcome::rejected(
                    "label_persist_rate_limited",
                    &format!(
                        "GitHub rate limit reached. Retry this intake in about {} seconds.",
                        retry_after_seconds
                    ),
                )
            } else {
                GithubIssueIntakeOutcome::rejected(
                    "label_persist_rate_limited",
                    "GitHub rate limit reached. Wait one minute and retry this intake.",
                )
            }
        }
        401 => GithubIssueIntakeOutcome::rejected(
            "label_persist_failed",
            "GitHub authorization expired. Reconnect GitHub and retry intake.",
        ),
        _ => GithubIssueIntakeOutcome::rejected(
            "label_persist_failed",
            "GitHub did not persist required labels. Retry this intake.",
        ),
    }
}

async fn fetch_issue(
    client: &reqwest::Client,
    access_token: &str,
    repository_full_name: &str,
    issue_number: i64,
) -> Result<GithubIssueResponse, GithubApiResponse> {
    let url = format!("{GITHUB_API_BASE_URL}/{repository_full_name}/issues/{issue_number}");
    let response = client
        .get(&url)
        .header("Accept", GITHUB_API_ACCEPT)
        .header("X-GitHub-Api-Version", GITHUB_API_VERSION)
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|error| GithubApiResponse {
            status: 500,
            body: Some(error.to_string()),
            retry_after_seconds: None,
            rate_limit_reset_epoch_seconds: None,
        })?;

    if !response.status().is_success() {
        return Err(response_to_api_response(response).await);
    }

    response
        .json::<GithubIssueResponse>()
        .await
        .map_err(|error| GithubApiResponse {
            status: 500,
            body: Some(error.to_string()),
            retry_after_seconds: None,
            rate_limit_reset_epoch_seconds: None,
        })
}

async fn persist_issue_labels(
    client: &reqwest::Client,
    access_token: &str,
    repository_full_name: &str,
    issue_number: i64,
    labels: &[String],
) -> Result<(), GithubApiResponse> {
    let url = format!("{GITHUB_API_BASE_URL}/{repository_full_name}/issues/{issue_number}/labels");
    let response = client
        .post(&url)
        .header("Accept", GITHUB_API_ACCEPT)
        .header("X-GitHub-Api-Version", GITHUB_API_VERSION)
        .bearer_auth(access_token)
        .json(&GithubIssueLabelMutationRequest { labels })
        .send()
        .await
        .map_err(|error| GithubApiResponse {
            status: 500,
            body: Some(error.to_string()),
            retry_after_seconds: None,
            rate_limit_reset_epoch_seconds: None,
        })?;

    if !response.status().is_success() {
        return Err(response_to_api_response(response).await);
    }

    Ok(())
}

async fn response_to_api_response(response: reqwest::Response) -> GithubApiResponse {
    let status = response.status().as_u16();
    let headers = response.headers().clone();
    let body = response.text().await.unwrap_or_default();
    let trimmed = body.trim();

    GithubApiResponse {
        status,
        body: if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        },
        retry_after_seconds: parse_retry_after_seconds(&headers),
        rate_limit_reset_epoch_seconds: parse_rate_limit_reset_epoch_seconds(&headers),
    }
}

fn parse_retry_after_seconds(headers: &HeaderMap) -> Option<u64> {
    headers
        .get(RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse::<u64>().ok())
}

fn parse_rate_limit_reset_epoch_seconds(headers: &HeaderMap) -> Option<i64> {
    headers
        .get("x-ratelimit-reset")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse::<i64>().ok())
}

fn resolve_access_token(state: &State<'_, GithubAuthState>) -> Result<Option<String>, String> {
    if let Some(token) = current_session_access_token(state.inner())? {
        return Ok(Some(token));
    }

    read_persisted_token()
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
                    "missing_body",
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
