use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;

const BRANCH_PREFIX: &str = "hostlocal";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeEnqueueIssueRunRequest {
    pub repository_full_name: String,
    pub issue_number: i64,
    pub issue_title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeDequeueIssueRunRequest {
    pub repository_full_name: String,
    pub issue_number: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeQueueOutcome {
    pub status: String,
    pub queue_position: Option<usize>,
    pub reason_code: Option<String>,
    pub fix_hint: Option<String>,
}

impl RuntimeQueueOutcome {
    pub fn started() -> Self {
        Self {
            status: "started".to_string(),
            queue_position: None,
            reason_code: None,
            fix_hint: None,
        }
    }

    pub fn queued(queue_position: usize) -> Self {
        Self {
            status: "queued".to_string(),
            queue_position: Some(queue_position),
            reason_code: None,
            fix_hint: None,
        }
    }

    pub fn removed() -> Self {
        Self {
            status: "removed".to_string(),
            queue_position: None,
            reason_code: None,
            fix_hint: None,
        }
    }

    pub fn not_found(reason_code: &str, fix_hint: &str) -> Self {
        Self {
            status: "not_found".to_string(),
            queue_position: None,
            reason_code: Some(reason_code.to_string()),
            fix_hint: Some(fix_hint.to_string()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeIssueRun {
    pub repository_full_name: String,
    pub repository_key: String,
    pub issue_number: i64,
    pub issue_title: String,
    pub issue_branch_name: String,
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct RepositoryRuntimeQueue {
    pub active_run: Option<RuntimeIssueRun>,
    pub queued_runs: VecDeque<RuntimeIssueRun>,
}

#[derive(Debug, Default)]
pub struct RuntimeBoundaryState {
    repos: HashMap<String, RepositoryRuntimeQueue>,
}

#[derive(Default)]
pub struct RuntimeBoundarySharedState {
    queue: Mutex<RuntimeBoundaryState>,
}

impl RuntimeBoundarySharedState {
    pub fn lock(&self) -> Result<std::sync::MutexGuard<'_, RuntimeBoundaryState>, String> {
        self.queue
            .lock()
            .map_err(|_| "Failed to access runtime boundary state".to_string())
    }
}

impl RuntimeBoundaryState {
    pub fn enqueue_run(&mut self, run: RuntimeIssueRun) -> RuntimeQueueOutcome {
        let repository_state = self.repos.entry(run.repository_key.clone()).or_default();
        if repository_state.active_run.is_none() {
            repository_state.active_run = Some(run);
            return RuntimeQueueOutcome::started();
        }

        repository_state.queued_runs.push_front(run);
        RuntimeQueueOutcome::queued(repository_state.queued_runs.len())
    }

    pub fn dequeue_queued_run(&mut self, _repository_key: &str, _issue_number: i64) -> bool {
        false
    }

    pub fn repository_queue(&self, repository_key: &str) -> Option<&RepositoryRuntimeQueue> {
        self.repos.get(repository_key)
    }
}

pub fn normalize_repository_key(repository_full_name: &str) -> Option<String> {
    let normalized = repository_full_name.trim().to_ascii_lowercase();
    if normalized.is_empty() {
        return None;
    }

    Some(normalized)
}

pub fn sanitize_branch_slug(issue_title: &str) -> String {
    let normalized = issue_title.trim().to_ascii_lowercase();
    if normalized.is_empty() {
        return "run".to_string();
    }

    normalized
}

pub fn issue_branch_name(issue_number: i64, issue_title: &str) -> String {
    let slug = sanitize_branch_slug(issue_title);
    format!("{BRANCH_PREFIX}/issue-{issue_number}-{slug}")
}

pub fn create_runtime_issue_run(request: RuntimeEnqueueIssueRunRequest) -> Option<RuntimeIssueRun> {
    let repository_key = normalize_repository_key(&request.repository_full_name)?;
    if request.issue_number <= 0 {
        return None;
    }

    let issue_branch_name = issue_branch_name(request.issue_number, &request.issue_title);
    Some(RuntimeIssueRun {
        repository_full_name: request.repository_full_name.trim().to_string(),
        repository_key,
        issue_number: request.issue_number,
        issue_title: request.issue_title.trim().to_string(),
        issue_branch_name,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug)]
    struct NormalizeRepositoryCase<'a> {
        name: &'a str,
        input: &'a str,
        expected: Option<&'a str>,
    }

    #[derive(Debug)]
    struct SlugCase<'a> {
        name: &'a str,
        input: &'a str,
        expected: &'a str,
    }

    fn build_run(repository: &str, issue_number: i64, title: &str) -> RuntimeIssueRun {
        create_runtime_issue_run(RuntimeEnqueueIssueRunRequest {
            repository_full_name: repository.to_string(),
            issue_number,
            issue_title: title.to_string(),
        })
        .expect("valid runtime issue run")
    }

    #[test]
    fn runtime_boundary_normalizes_repository_keys_table() {
        let cases = [
            NormalizeRepositoryCase {
                name: "owner_repo_lowercase",
                input: "Owner/Repo",
                expected: Some("owner/repo"),
            },
            NormalizeRepositoryCase {
                name: "trim_and_lowercase_segments",
                input: " Owner / Repo ",
                expected: Some("owner/repo"),
            },
            NormalizeRepositoryCase {
                name: "reject_empty",
                input: " ",
                expected: None,
            },
            NormalizeRepositoryCase {
                name: "reject_missing_owner",
                input: "/repo",
                expected: None,
            },
            NormalizeRepositoryCase {
                name: "reject_missing_repo",
                input: "owner/",
                expected: None,
            },
            NormalizeRepositoryCase {
                name: "reject_extra_segments",
                input: "owner/repo/extra",
                expected: None,
            },
        ];

        for case in cases {
            let actual = normalize_repository_key(case.input);
            assert_eq!(
                actual.as_deref(),
                case.expected,
                "case failed: {}",
                case.name
            );
        }
    }

    #[test]
    fn runtime_boundary_sanitizes_issue_branch_slug_table() {
        let cases = [
            SlugCase {
                name: "normal_sentence",
                input: "Fix OAuth callback race",
                expected: "fix-oauth-callback-race",
            },
            SlugCase {
                name: "trim_and_symbols",
                input: "  Add 🧪 test + docs  ",
                expected: "add-test-docs",
            },
            SlugCase {
                name: "collapse_separators",
                input: "A---B__C",
                expected: "a-b-c",
            },
            SlugCase {
                name: "fallback_when_empty_after_sanitize",
                input: " // ",
                expected: "run",
            },
        ];

        for case in cases {
            let actual = sanitize_branch_slug(case.input);
            assert_eq!(actual, case.expected, "case failed: {}", case.name);
        }
    }

    #[test]
    fn runtime_boundary_queue_uses_fifo_order_for_same_repository() {
        let mut state = RuntimeBoundaryState::default();

        let first = build_run("Owner/Repo", 101, "First issue");
        let second = build_run("owner/repo", 102, "Second issue");
        let third = build_run("owner/repo", 103, "Third issue");

        assert_eq!(state.enqueue_run(first), RuntimeQueueOutcome::started());
        assert_eq!(state.enqueue_run(second), RuntimeQueueOutcome::queued(1));
        assert_eq!(state.enqueue_run(third), RuntimeQueueOutcome::queued(2));

        let repo_queue = state
            .repository_queue("owner/repo")
            .expect("repo queue exists");
        assert_eq!(
            repo_queue.active_run.as_ref().map(|run| run.issue_number),
            Some(101)
        );
        assert_eq!(repo_queue.queued_runs.len(), 2);
        assert_eq!(repo_queue.queued_runs[0].issue_number, 102);
        assert_eq!(repo_queue.queued_runs[1].issue_number, 103);
    }

    #[test]
    fn runtime_boundary_dequeue_removes_queued_only_by_issue_identity() {
        let mut state = RuntimeBoundaryState::default();
        let first = build_run("owner/repo", 201, "First");
        let second = build_run("owner/repo", 202, "Second");
        let third = build_run("owner/repo", 203, "Third");

        state.enqueue_run(first);
        state.enqueue_run(second);
        state.enqueue_run(third);

        assert!(state.dequeue_queued_run("owner/repo", 202));
        assert!(!state.dequeue_queued_run("owner/repo", 201));

        let repo_queue = state
            .repository_queue("owner/repo")
            .expect("repo queue exists");
        assert_eq!(
            repo_queue.active_run.as_ref().map(|run| run.issue_number),
            Some(201)
        );
        assert_eq!(repo_queue.queued_runs.len(), 1);
        assert_eq!(repo_queue.queued_runs[0].issue_number, 203);
    }
}
