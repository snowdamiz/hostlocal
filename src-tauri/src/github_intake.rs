use serde::{Deserialize, Serialize};

pub const INTAKE_LABEL_PREFIX: &str = "intake:";
pub const AGENT_LABEL_PREFIX: &str = "agent:";
pub const DENY_SIGNAL_LABELS: &[&str] = &["epic", "large", "size:xl", "scope:epic"];

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

pub fn evaluate_issue_intake_policy(_issue: &GithubIssueIntakePolicyInput) -> GithubIssueIntakeOutcome {
    GithubIssueIntakeOutcome::accepted()
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
}
