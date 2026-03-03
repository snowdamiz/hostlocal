use crate::db::{with_connection, DbPath};
use regex::Regex;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_shell::{process::CommandEvent, ShellExt};
use tempfile::TempDir;

const BRANCH_PREFIX: &str = "hostlocal";
const SIDECAR_ALIAS: &str = "hostlocal-worker";
const WORKSPACE_REPO_DIR: &str = "repo";
const RUNTIME_EVIDENCE_DIR: &str = "hostlocal-runtime-evidence";
const RUNTIME_RUN_STAGE_CHANGED_EVENT: &str = "runtime/run-stage-changed";
const RUNTIME_RUN_TELEMETRY_EVENT: &str = "runtime/run-telemetry";
const RUNTIME_RECOVERY_REASON_CODE: &str = "runtime_recovery_process_lost";
const RUNTIME_RECOVERY_FIX_HINT: &str =
    "A previous HostLocal session ended during execution. Requeue the issue to run again.";
const REDACTION_MARKER: &str = "[REDACTED]";

#[derive(Debug)]
struct RuntimeTelemetryRedactionRule {
    reason_code: &'static str,
    pattern: Regex,
    replacement: &'static str,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeTelemetryRedactionReason {
    pub reason_code: String,
    pub match_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct RuntimeTelemetryRedactionResult {
    masked_text: String,
    reasons: Vec<RuntimeTelemetryRedactionReason>,
    total_redactions: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RuntimeTelemetryMilestone {
    Queue,
    Start,
    Preparing,
    Coding,
    Validating,
    Publishing,
    Finalization,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RuntimeTelemetryMilestoneDetail {
    kind: &'static str,
    stage: &'static str,
    message: String,
    include_in_summary: bool,
}

fn runtime_milestone_detail(
    milestone: RuntimeTelemetryMilestone,
    terminal_status: Option<&str>,
) -> RuntimeTelemetryMilestoneDetail {
    match milestone {
        RuntimeTelemetryMilestone::Queue => RuntimeTelemetryMilestoneDetail {
            kind: "milestone",
            stage: "queued",
            message: "Issue run queued for execution.".to_string(),
            include_in_summary: true,
        },
        RuntimeTelemetryMilestone::Start => RuntimeTelemetryMilestoneDetail {
            kind: "milestone",
            stage: "queued",
            message: "Run started from repository queue.".to_string(),
            include_in_summary: true,
        },
        RuntimeTelemetryMilestone::Preparing => RuntimeTelemetryMilestoneDetail {
            kind: "milestone",
            stage: "preparing",
            message: "Preparing local workspace for issue run.".to_string(),
            include_in_summary: true,
        },
        RuntimeTelemetryMilestone::Coding => RuntimeTelemetryMilestoneDetail {
            kind: "milestone",
            stage: "coding",
            message: "Coding milestone started in worker runtime.".to_string(),
            include_in_summary: true,
        },
        RuntimeTelemetryMilestone::Validating => RuntimeTelemetryMilestoneDetail {
            kind: "milestone",
            stage: "validating",
            message: "Validation milestone started for runtime outputs.".to_string(),
            include_in_summary: true,
        },
        RuntimeTelemetryMilestone::Publishing => RuntimeTelemetryMilestoneDetail {
            kind: "milestone",
            stage: "publishing",
            message: "Publishing milestone started for runtime outputs.".to_string(),
            include_in_summary: true,
        },
        RuntimeTelemetryMilestone::Finalization => RuntimeTelemetryMilestoneDetail {
            kind: "milestone",
            stage: "finalized",
            message: format!(
                "Run finalized with terminal status: {}.",
                terminal_status.unwrap_or("unknown")
            ),
            include_in_summary: true,
        },
    }
}

fn runtime_telemetry_redaction_rules() -> &'static [RuntimeTelemetryRedactionRule] {
    static RULES: OnceLock<Vec<RuntimeTelemetryRedactionRule>> = OnceLock::new();
    RULES
        .get_or_init(|| {
            vec![
                RuntimeTelemetryRedactionRule {
                    reason_code: "authorization_header",
                    pattern: Regex::new(r"(?i)(authorization\s*[:=]\s*bearer\s+)[^\s,;]+")
                        .expect("valid authorization redaction regex"),
                    replacement: "${1}[REDACTED]",
                },
                RuntimeTelemetryRedactionRule {
                    reason_code: "credential_assignment",
                    pattern: Regex::new(
                        r#"(?i)\b([A-Z0-9_]*(?:TOKEN|API_KEY|SECRET|PASSWORD|SESSION|COOKIE|CREDENTIALS)[A-Z0-9_]*\s*=\s*)("[^"]*"|'[^']*'|[^\s]+)"#,
                    )
                    .expect("valid credential assignment redaction regex"),
                    replacement: "${1}[REDACTED]",
                },
                RuntimeTelemetryRedactionRule {
                    reason_code: "sensitive_key_value",
                    pattern: Regex::new(
                        r#"(?i)\b((?:api[_-]?key|token|secret|password|session(?:id)?|cookie)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)"#,
                    )
                    .expect("valid sensitive key value redaction regex"),
                    replacement: "${1}[REDACTED]",
                },
                RuntimeTelemetryRedactionRule {
                    reason_code: "sensitive_query_parameter",
                    pattern: Regex::new(
                        r"(?i)((?:access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|password|session(?:id)?)=)[^&\s]+",
                    )
                    .expect("valid sensitive query parameter redaction regex"),
                    replacement: "${1}[REDACTED]",
                },
                RuntimeTelemetryRedactionRule {
                    reason_code: "known_token_prefix",
                    pattern: Regex::new(
                        r"\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{16,}|xox[baprs]-[A-Za-z0-9-]{16,}|AKIA[0-9A-Z]{16})\b",
                    )
                    .expect("valid known token prefix redaction regex"),
                    replacement: REDACTION_MARKER,
                },
            ]
        })
        .as_slice()
}

fn runtime_telemetry_risky_fragment_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r"\b[A-Za-z0-9_-]{32,}\b").expect("valid risky fragment redaction regex")
    })
}

fn redact_risky_fragments(value: &str) -> (String, usize) {
    let mut masked = String::with_capacity(value.len());
    let mut cursor = 0;
    let mut redaction_count = 0;
    for fragment in runtime_telemetry_risky_fragment_pattern().find_iter(value) {
        masked.push_str(&value[cursor..fragment.start()]);
        let candidate = fragment.as_str();
        let has_letter = candidate.chars().any(|ch| ch.is_ascii_alphabetic());
        let has_digit = candidate.chars().any(|ch| ch.is_ascii_digit());
        if has_letter && has_digit {
            masked.push_str(REDACTION_MARKER);
            redaction_count += 1;
        } else {
            masked.push_str(candidate);
        }
        cursor = fragment.end();
    }
    masked.push_str(&value[cursor..]);
    (masked, redaction_count)
}

fn redact_sensitive_text(value: &str) -> RuntimeTelemetryRedactionResult {
    let mut masked_text = value.to_string();
    let mut reasons = Vec::new();

    for rule in runtime_telemetry_redaction_rules() {
        let match_count = rule.pattern.find_iter(&masked_text).count();
        if match_count == 0 {
            continue;
        }
        masked_text = rule
            .pattern
            .replace_all(&masked_text, rule.replacement)
            .to_string();
        reasons.push(RuntimeTelemetryRedactionReason {
            reason_code: rule.reason_code.to_string(),
            match_count,
        });
    }

    let (masked_for_risky_fragments, risky_fragment_matches) = redact_risky_fragments(&masked_text);
    masked_text = masked_for_risky_fragments;
    if risky_fragment_matches > 0 {
        reasons.push(RuntimeTelemetryRedactionReason {
            reason_code: "risky_fragment".to_string(),
            match_count: risky_fragment_matches,
        });
    }

    let total_redactions = reasons.iter().map(|reason| reason.match_count).sum();
    RuntimeTelemetryRedactionResult {
        masked_text,
        reasons,
        total_redactions,
    }
}

fn runtime_event_sanitized_read_view(
    event: &RuntimePersistedRunEvent,
) -> (String, Vec<RuntimeTelemetryRedactionReason>) {
    let redaction = redact_sensitive_text(&event.message);
    if redaction.masked_text == event.message {
        return (event.message.clone(), event.redaction_reasons.clone());
    }

    let mut reason_counts = BTreeMap::<String, usize>::new();
    for reason in &event.redaction_reasons {
        *reason_counts.entry(reason.reason_code.clone()).or_insert(0) += reason.match_count;
    }
    for reason in redaction.reasons {
        *reason_counts.entry(reason.reason_code).or_insert(0) += reason.match_count;
    }

    let merged_reasons = reason_counts
        .into_iter()
        .map(|(reason_code, match_count)| RuntimeTelemetryRedactionReason {
            reason_code,
            match_count,
        })
        .collect();
    (redaction.masked_text, merged_reasons)
}

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

    pub fn blocked(block: &GuardrailBlock) -> Self {
        Self {
            status: "blocked".to_string(),
            queue_position: None,
            reason_code: Some(block.reason_code()),
            fix_hint: Some(block.fix_hint()),
        }
    }

    pub fn startup_failed(reason_code: &str, fix_hint: &str) -> Self {
        Self {
            status: "startup_failed".to_string(),
            queue_position: None,
            reason_code: Some(reason_code.to_string()),
            fix_hint: Some(fix_hint.to_string()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GuardrailBlock {
    rule: String,
    target_type: String,
}

impl GuardrailBlock {
    pub fn new(rule: impl Into<String>, target_type: impl Into<String>) -> Self {
        Self {
            rule: rule.into(),
            target_type: target_type.into(),
        }
    }

    #[cfg(test)]
    pub fn rule(&self) -> &str {
        &self.rule
    }

    #[cfg(test)]
    pub fn target_type(&self) -> &str {
        &self.target_type
    }

    pub fn reason_code(&self) -> String {
        format!("runtime_guardrail_{}_{}", self.rule, self.target_type)
    }

    pub fn fix_hint(&self) -> String {
        format!(
            "Blocked {} target because it violated {} rule.",
            self.target_type, self.rule
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeIssueRun {
    pub run_id: Option<i64>,
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

        repository_state.queued_runs.push_back(run);
        RuntimeQueueOutcome::queued(repository_state.queued_runs.len())
    }

    pub fn dequeue_queued_run(
        &mut self,
        repository_key: &str,
        issue_number: i64,
    ) -> Option<RuntimeIssueRun> {
        let Some(repository_state) = self.repos.get_mut(repository_key) else {
            return None;
        };

        if repository_state
            .active_run
            .as_ref()
            .is_some_and(|run| run.issue_number == issue_number)
        {
            return None;
        }

        let Some(position) = repository_state
            .queued_runs
            .iter()
            .position(|run| run.issue_number == issue_number)
        else {
            return None;
        };

        let removed = repository_state.queued_runs.remove(position);
        if repository_state.active_run.is_none() && repository_state.queued_runs.is_empty() {
            self.repos.remove(repository_key);
        }

        removed
    }

    pub fn finalize_active_and_promote_next(
        &mut self,
        repository_key: &str,
        issue_number: i64,
    ) -> Option<RuntimeIssueRun> {
        let Some(repository_state) = self.repos.get_mut(repository_key) else {
            return None;
        };

        let is_matching_active = repository_state
            .active_run
            .as_ref()
            .is_some_and(|active| active.issue_number == issue_number);
        if !is_matching_active {
            return None;
        }

        repository_state.active_run = None;
        let next_run = repository_state.queued_runs.pop_front();
        if let Some(next) = next_run.clone() {
            repository_state.active_run = Some(next);
        }

        if repository_state.active_run.is_none() && repository_state.queued_runs.is_empty() {
            self.repos.remove(repository_key);
        }

        next_run
    }

    pub fn restore_queued_runs_and_collect_active(
        &mut self,
        queued_runs: Vec<RuntimeIssueRun>,
    ) -> Vec<RuntimeIssueRun> {
        self.repos.clear();
        let mut active_runs = Vec::new();

        for queued_run in queued_runs {
            let repository_state = self.repos.entry(queued_run.repository_key.clone()).or_default();
            if repository_state.active_run.is_none() {
                repository_state.active_run = Some(queued_run.clone());
                active_runs.push(queued_run);
                continue;
            }

            repository_state.queued_runs.push_back(queued_run);
        }

        active_runs
    }

    #[cfg(test)]
    pub fn repository_queue(&self, repository_key: &str) -> Option<&RepositoryRuntimeQueue> {
        self.repos.get(repository_key)
    }
}

fn repository_segment_is_safe(segment: &str) -> bool {
    if segment.is_empty() || segment == "." || segment == ".." {
        return false;
    }

    segment
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' || ch == '.')
}

pub fn normalize_repository_key(repository_full_name: &str) -> Option<String> {
    let raw = repository_full_name.trim();
    if raw.is_empty() {
        return None;
    }

    let mut segments = raw.split('/');
    let owner = segments.next()?.trim();
    let repository = segments.next()?.trim();
    if owner.is_empty() || repository.is_empty() || segments.next().is_some() {
        return None;
    }
    if !repository_segment_is_safe(owner) || !repository_segment_is_safe(repository) {
        return None;
    }

    Some(format!(
        "{}/{}",
        owner.to_ascii_lowercase(),
        repository.to_ascii_lowercase()
    ))
}

pub fn sanitize_branch_slug(issue_title: &str) -> String {
    let mut slug = String::with_capacity(issue_title.len());
    let mut previous_was_separator = true;

    for ch in issue_title.chars() {
        let is_separator = !ch.is_ascii_alphanumeric();
        if is_separator {
            if !previous_was_separator {
                slug.push('-');
                previous_was_separator = true;
            }
            continue;
        }

        slug.push(ch.to_ascii_lowercase());
        previous_was_separator = false;
    }

    let trimmed = slug.trim_matches('-').to_string();
    if trimmed.is_empty() {
        return "run".to_string();
    }

    const MAX_SLUG_LEN: usize = 48;
    let mut bounded = trimmed;
    if bounded.len() > MAX_SLUG_LEN {
        bounded.truncate(MAX_SLUG_LEN);
        bounded = bounded.trim_end_matches('-').to_string();
    }

    if bounded.is_empty() {
        return "run".to_string();
    }

    bounded
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
        run_id: None,
        repository_full_name: request.repository_full_name.trim().to_string(),
        repository_key,
        issue_number: request.issue_number,
        issue_title: request.issue_title.trim().to_string(),
        issue_branch_name,
    })
}

pub fn ensure_within_workspace(
    workspace_root: &Path,
    candidate: &Path,
) -> Result<(), GuardrailBlock> {
    let canonical_root = fs::canonicalize(workspace_root)
        .map_err(|_| GuardrailBlock::new("workspace_boundary", "path"))?;
    let canonical_candidate =
        fs::canonicalize(candidate).map_err(|_| GuardrailBlock::new("workspace_boundary", "path"))?;

    if canonical_candidate.strip_prefix(&canonical_root).is_err() {
        return Err(GuardrailBlock::new("workspace_boundary", "path"));
    }

    Ok(())
}

fn ensure_within_workspace_for_create(
    workspace_root: &Path,
    candidate: &Path,
) -> Result<(), GuardrailBlock> {
    let parent = candidate
        .parent()
        .ok_or_else(|| GuardrailBlock::new("workspace_boundary", "path"))?;
    let canonical_root = fs::canonicalize(workspace_root)
        .map_err(|_| GuardrailBlock::new("workspace_boundary", "path"))?;
    let canonical_parent =
        fs::canonicalize(parent).map_err(|_| GuardrailBlock::new("workspace_boundary", "path"))?;

    if canonical_parent.strip_prefix(&canonical_root).is_err() {
        return Err(GuardrailBlock::new("workspace_boundary", "path"));
    }

    Ok(())
}

#[derive(Debug, Clone)]
struct StartRunError {
    outcome: RuntimeQueueOutcome,
    workspace_root: Option<PathBuf>,
}

impl StartRunError {
    fn guardrail(block: GuardrailBlock, workspace_root: Option<PathBuf>) -> Self {
        Self {
            outcome: RuntimeQueueOutcome::blocked(&block),
            workspace_root,
        }
    }

    fn startup(workspace_root: Option<PathBuf>) -> Self {
        Self {
            outcome: RuntimeQueueOutcome::startup_failed(
                "runtime_startup_failed",
                "Runtime startup failed before local worker execution could begin.",
            ),
            workspace_root,
        }
    }

    fn with_outcome(outcome: RuntimeQueueOutcome, workspace_root: Option<PathBuf>) -> Self {
        Self {
            outcome,
            workspace_root,
        }
    }
}

#[derive(Debug, Clone)]
struct PreparedWorkspace {
    workspace_root: PathBuf,
    repository_path: PathBuf,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RuntimeRunStage {
    Queued,
    Preparing,
    Coding,
    Validating,
    Publishing,
}

impl RuntimeRunStage {
    fn as_str(self) -> &'static str {
        match self {
            RuntimeRunStage::Queued => "queued",
            RuntimeRunStage::Preparing => "preparing",
            RuntimeRunStage::Coding => "coding",
            RuntimeRunStage::Validating => "validating",
            RuntimeRunStage::Publishing => "publishing",
        }
    }

    fn from_db(value: &str) -> Option<Self> {
        match value {
            "queued" => Some(Self::Queued),
            "preparing" => Some(Self::Preparing),
            "coding" => Some(Self::Coding),
            "validating" => Some(Self::Validating),
            "publishing" => Some(Self::Publishing),
            _ => None,
        }
    }

    fn next(self) -> Option<Self> {
        match self {
            RuntimeRunStage::Queued => Some(RuntimeRunStage::Preparing),
            RuntimeRunStage::Preparing => Some(RuntimeRunStage::Coding),
            RuntimeRunStage::Coding => Some(RuntimeRunStage::Validating),
            RuntimeRunStage::Validating => Some(RuntimeRunStage::Publishing),
            RuntimeRunStage::Publishing => None,
        }
    }

    fn can_transition_to(self, next: Self) -> bool {
        self.next().is_some_and(|expected_next| expected_next == next)
    }
}

fn runtime_prepare_failed_outcome() -> RuntimeQueueOutcome {
    RuntimeQueueOutcome::startup_failed(
        "runtime_workspace_prepare_failed",
        "Runtime workspace preparation failed before local worker execution could begin.",
    )
}

fn run_git_command(args: &[&str], current_dir: Option<&Path>) -> Result<(), RuntimeQueueOutcome> {
    let mut command = Command::new("git");
    command.args(args);
    if let Some(dir) = current_dir {
        command.current_dir(dir);
    }
    let status = command.status().map_err(|_| runtime_prepare_failed_outcome())?;
    if !status.success() {
        return Err(runtime_prepare_failed_outcome());
    }

    Ok(())
}

fn prepare_workspace_for_run(run: &RuntimeIssueRun) -> Result<PreparedWorkspace, StartRunError> {
    let temp_dir = TempDir::new_in(std::env::temp_dir()).map_err(|_| StartRunError::startup(None))?;
    let workspace_root = temp_dir.keep();
    let repository_path = workspace_root.join(WORKSPACE_REPO_DIR);

    ensure_within_workspace_for_create(&workspace_root, &repository_path)
        .map_err(|block| StartRunError::guardrail(block, Some(workspace_root.clone())))?;

    let clone_url = format!(
        "https://github.com/{}.git",
        run.repository_full_name.trim()
    );
    let clone_destination = repository_path.to_string_lossy().to_string();
    run_git_command(
        &["clone", "--depth", "1", &clone_url, &clone_destination],
        None,
    )
    .map_err(|outcome| StartRunError::with_outcome(outcome, Some(workspace_root.clone())))?;

    ensure_within_workspace(&workspace_root, &repository_path)
        .map_err(|block| StartRunError::guardrail(block, Some(workspace_root.clone())))?;

    run_git_command(
        &["switch", "-c", &run.issue_branch_name],
        Some(&repository_path),
    )
    .map_err(|outcome| StartRunError::with_outcome(outcome, Some(workspace_root.clone())))?;

    Ok(PreparedWorkspace {
        workspace_root,
        repository_path,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RuntimeTerminalStatus {
    Success,
    Failed,
    Cancelled,
    GuardrailBlocked,
}

impl RuntimeTerminalStatus {
    fn as_str(self) -> &'static str {
        match self {
            RuntimeTerminalStatus::Success => "success",
            RuntimeTerminalStatus::Failed => "failed",
            RuntimeTerminalStatus::Cancelled => "cancelled",
            RuntimeTerminalStatus::GuardrailBlocked => "guardrail_blocked",
        }
    }

    fn from_db(value: &str) -> Option<Self> {
        match value {
            "success" => Some(Self::Success),
            "failed" => Some(Self::Failed),
            "cancelled" => Some(Self::Cancelled),
            "guardrail_blocked" => Some(Self::GuardrailBlocked),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RuntimePersistedRun {
    run_id: i64,
    repository_key: String,
    repository_full_name: String,
    issue_number: i64,
    issue_title: String,
    issue_branch_name: String,
    queue_order: i64,
    stage: RuntimeRunStage,
    terminal_status: Option<RuntimeTerminalStatus>,
    reason_code: Option<String>,
    fix_hint: Option<String>,
    created_at: String,
    updated_at: String,
    terminal_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RuntimePersistedTransition {
    transition_id: i64,
    run_id: i64,
    sequence: i64,
    stage: RuntimeRunStage,
    terminal_status: Option<RuntimeTerminalStatus>,
    reason_code: Option<String>,
    fix_hint: Option<String>,
    created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RuntimePersistedRunEvent {
    event_id: i64,
    run_id: i64,
    sequence: i64,
    kind: String,
    stage: String,
    message: String,
    redaction_reasons: Vec<RuntimeTelemetryRedactionReason>,
    include_in_summary: bool,
    created_at: String,
}

fn runtime_invariant_error(message: impl Into<String>) -> rusqlite::Error {
    rusqlite::Error::InvalidParameterName(message.into())
}

fn read_runtime_persisted_run(row: &rusqlite::Row<'_>) -> rusqlite::Result<RuntimePersistedRun> {
    let stage_raw: String = row.get(7)?;
    let stage = RuntimeRunStage::from_db(&stage_raw)
        .ok_or_else(|| runtime_invariant_error(format!("invalid persisted stage: {stage_raw}")))?;
    let terminal_status_raw: Option<String> = row.get(8)?;
    let terminal_status = terminal_status_raw
        .map(|value| {
            RuntimeTerminalStatus::from_db(&value).ok_or_else(|| {
                runtime_invariant_error(format!("invalid persisted terminal status: {value}"))
            })
        })
        .transpose()?;

    Ok(RuntimePersistedRun {
        run_id: row.get(0)?,
        repository_key: row.get(1)?,
        repository_full_name: row.get(2)?,
        issue_number: row.get(3)?,
        issue_title: row.get(4)?,
        issue_branch_name: row.get(5)?,
        queue_order: row.get(6)?,
        stage,
        terminal_status,
        reason_code: row.get(9)?,
        fix_hint: row.get(10)?,
        created_at: row.get(11)?,
        updated_at: row.get(12)?,
        terminal_at: row.get(13)?,
    })
}

fn persisted_run_to_runtime_issue_run(persisted: RuntimePersistedRun) -> RuntimeIssueRun {
    RuntimeIssueRun {
        run_id: Some(persisted.run_id),
        repository_full_name: persisted.repository_full_name,
        repository_key: persisted.repository_key,
        issue_number: persisted.issue_number,
        issue_title: persisted.issue_title,
        issue_branch_name: persisted.issue_branch_name,
    }
}

fn read_runtime_persisted_transition(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<RuntimePersistedTransition> {
    let stage_raw: String = row.get(3)?;
    let stage = RuntimeRunStage::from_db(&stage_raw).ok_or_else(|| {
        runtime_invariant_error(format!("invalid persisted transition stage: {stage_raw}"))
    })?;
    let terminal_status_raw: Option<String> = row.get(4)?;
    let terminal_status = terminal_status_raw
        .map(|value| {
            RuntimeTerminalStatus::from_db(&value).ok_or_else(|| {
                runtime_invariant_error(format!("invalid persisted transition terminal status: {value}"))
            })
        })
        .transpose()?;

    Ok(RuntimePersistedTransition {
        transition_id: row.get(0)?,
        run_id: row.get(1)?,
        sequence: row.get(2)?,
        stage,
        terminal_status,
        reason_code: row.get(5)?,
        fix_hint: row.get(6)?,
        created_at: row.get(7)?,
    })
}

fn read_runtime_persisted_run_event(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<RuntimePersistedRunEvent> {
    let redaction_reasons_raw: String = row.get(6)?;
    let redaction_reasons: Vec<RuntimeTelemetryRedactionReason> =
        serde_json::from_str(&redaction_reasons_raw).map_err(|error| {
            runtime_invariant_error(format!(
                "invalid runtime run event redaction metadata: {error}"
            ))
        })?;

    Ok(RuntimePersistedRunEvent {
        event_id: row.get(0)?,
        run_id: row.get(1)?,
        sequence: row.get(2)?,
        kind: row.get(3)?,
        stage: row.get(4)?,
        message: row.get(5)?,
        redaction_reasons,
        include_in_summary: row.get::<_, i64>(7)? != 0,
        created_at: row.get(8)?,
    })
}

fn load_runtime_run_by_id(conn: &Connection, run_id: i64) -> rusqlite::Result<RuntimePersistedRun> {
    conn.query_row(
        "SELECT
            run_id,
            repository_key,
            repository_full_name,
            issue_number,
            issue_title,
            issue_branch_name,
            queue_order,
            stage,
            terminal_status,
            reason_code,
            fix_hint,
            created_at,
            updated_at,
            terminal_at
         FROM runtime_runs
         WHERE run_id = ?1",
        params![run_id],
        read_runtime_persisted_run,
    )
}

fn load_non_terminal_runtime_runs_ordered(
    conn: &Connection,
) -> rusqlite::Result<Vec<RuntimePersistedRun>> {
    let mut stmt = conn.prepare(
        "SELECT
            run_id,
            repository_key,
            repository_full_name,
            issue_number,
            issue_title,
            issue_branch_name,
            queue_order,
            stage,
            terminal_status,
            reason_code,
            fix_hint,
            created_at,
            updated_at,
            terminal_at
         FROM runtime_runs
         WHERE terminal_status IS NULL
         ORDER BY repository_key ASC, queue_order ASC, run_id ASC",
    )?;
    let rows = stmt.query_map([], read_runtime_persisted_run)?;
    rows.collect()
}

fn load_recoverable_queued_runtime_runs_ordered(
    conn: &Connection,
) -> rusqlite::Result<Vec<RuntimePersistedRun>> {
    let mut stmt = conn.prepare(
        "SELECT
            run_id,
            repository_key,
            repository_full_name,
            issue_number,
            issue_title,
            issue_branch_name,
            queue_order,
            stage,
            terminal_status,
            reason_code,
            fix_hint,
            created_at,
            updated_at,
            terminal_at
         FROM runtime_runs
         WHERE terminal_status IS NULL
           AND stage = ?1
         ORDER BY repository_key ASC, queue_order ASC, run_id ASC",
    )?;
    let rows = stmt.query_map([RuntimeRunStage::Queued.as_str()], read_runtime_persisted_run)?;
    rows.collect()
}

fn load_runtime_run_transitions_newest_first(
    conn: &Connection,
    run_id: i64,
) -> rusqlite::Result<Vec<RuntimePersistedTransition>> {
    let mut stmt = conn.prepare(
        "SELECT
            transition_id,
            run_id,
            sequence,
            stage,
            terminal_status,
            reason_code,
            fix_hint,
            created_at
         FROM runtime_run_transitions
         WHERE run_id = ?1
         ORDER BY sequence DESC, transition_id DESC",
    )?;
    let rows = stmt.query_map(params![run_id], read_runtime_persisted_transition)?;
    rows.collect()
}

fn load_runtime_run_event_by_id(
    conn: &Connection,
    event_id: i64,
) -> rusqlite::Result<RuntimePersistedRunEvent> {
    conn.query_row(
        "SELECT
            event_id,
            run_id,
            sequence,
            kind,
            stage,
            message,
            redaction_reasons,
            include_in_summary,
            created_at
         FROM runtime_run_events
         WHERE event_id = ?1",
        params![event_id],
        read_runtime_persisted_run_event,
    )
}

fn load_runtime_run_events_newest_first(
    conn: &Connection,
    run_id: i64,
) -> rusqlite::Result<Vec<RuntimePersistedRunEvent>> {
    let mut stmt = conn.prepare(
        "SELECT
            event_id,
            run_id,
            sequence,
            kind,
            stage,
            message,
            redaction_reasons,
            include_in_summary,
            created_at
         FROM runtime_run_events
         WHERE run_id = ?1
         ORDER BY sequence DESC, event_id DESC",
    )?;
    let rows = stmt.query_map(params![run_id], read_runtime_persisted_run_event)?;
    rows.collect()
}

fn next_runtime_run_event_sequence(conn: &Connection, run_id: i64) -> rusqlite::Result<i64> {
    conn.query_row(
        "SELECT COALESCE(MAX(sequence), 0) + 1
         FROM runtime_run_events
         WHERE run_id = ?1",
        params![run_id],
        |row| row.get(0),
    )
}

fn insert_runtime_run_event(
    conn: &Connection,
    run_id: i64,
    kind: &str,
    stage: &str,
    message: &str,
    include_in_summary: bool,
) -> Result<RuntimePersistedRunEvent, String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    load_runtime_run_by_id(&tx, run_id)
        .map_err(|e| format!("runtime run not found for telemetry event: {e}"))?;

    let sequence = next_runtime_run_event_sequence(&tx, run_id).map_err(|e| e.to_string())?;
    let redaction = redact_sensitive_text(message);
    let redaction_reasons = serde_json::to_string(&redaction.reasons).map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO runtime_run_events (
            run_id,
            sequence,
            kind,
            stage,
            message,
            redaction_reasons,
            include_in_summary
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            run_id,
            sequence,
            kind,
            stage,
            redaction.masked_text,
            redaction_reasons,
            if include_in_summary { 1_i64 } else { 0_i64 }
        ],
    )
    .map_err(|e| e.to_string())?;
    let event_id = tx.last_insert_rowid();
    tx.commit().map_err(|e| e.to_string())?;

    load_runtime_run_event_by_id(conn, event_id).map_err(|e| e.to_string())
}

fn runtime_run_telemetry_payload_from_event(
    run: &RuntimePersistedRun,
    event: RuntimePersistedRunEvent,
) -> RuntimeRunTelemetryEventPayload {
    let (sanitized_message, redaction_reasons) = runtime_event_sanitized_read_view(&event);
    RuntimeRunTelemetryEventPayload {
        event_id: event.event_id,
        run_id: run.run_id,
        repository_full_name: run.repository_full_name.clone(),
        repository_key: run.repository_key.clone(),
        issue_number: run.issue_number,
        issue_title: run.issue_title.clone(),
        issue_branch_name: run.issue_branch_name.clone(),
        sequence: event.sequence,
        kind: event.kind,
        stage: event.stage,
        message: sanitized_message,
        redaction_reasons,
        include_in_summary: event.include_in_summary,
        created_at: event.created_at,
    }
}

fn persist_runtime_run_event_payload(
    conn: &Connection,
    run_id: i64,
    kind: &str,
    stage: &str,
    message: &str,
    include_in_summary: bool,
) -> Result<RuntimeRunTelemetryEventPayload, String> {
    let run = load_runtime_run_by_id(conn, run_id).map_err(|e| e.to_string())?;
    let event = insert_runtime_run_event(conn, run_id, kind, stage, message, include_in_summary)?;
    Ok(runtime_run_telemetry_payload_from_event(&run, event))
}

fn runtime_run_telemetry_payloads_newest_first(
    conn: &Connection,
    run_id: i64,
) -> Result<Vec<RuntimeRunTelemetryEventPayload>, String> {
    let run = load_runtime_run_by_id(conn, run_id).map_err(|e| e.to_string())?;
    let events = load_runtime_run_events_newest_first(conn, run_id).map_err(|e| e.to_string())?;
    Ok(events
        .into_iter()
        .map(|event| runtime_run_telemetry_payload_from_event(&run, event))
        .collect())
}

fn prune_terminal_history_for_issue(
    conn: &Connection,
    repository_key: &str,
    issue_number: i64,
    keep_limit: i64,
) -> rusqlite::Result<()> {
    let mut stale_stmt = conn.prepare(
        "SELECT run_id
         FROM runtime_runs
         WHERE repository_key = ?1
           AND issue_number = ?2
           AND terminal_status IS NOT NULL
         ORDER BY terminal_at DESC, run_id DESC
         LIMIT -1 OFFSET ?3",
    )?;
    let stale_rows = stale_stmt.query_map(
        params![repository_key, issue_number, keep_limit],
        |row| row.get::<_, i64>(0),
    )?;
    let stale_run_ids: Vec<i64> = stale_rows.collect::<Result<Vec<_>, _>>()?;
    drop(stale_stmt);

    for stale_run_id in stale_run_ids {
        conn.execute("DELETE FROM runtime_runs WHERE run_id = ?1", params![stale_run_id])?;
    }

    Ok(())
}

fn load_active_runtime_run_by_issue(
    conn: &Connection,
    repository_key: &str,
    issue_number: i64,
) -> rusqlite::Result<Option<RuntimePersistedRun>> {
    conn.query_row(
        "SELECT
            run_id,
            repository_key,
            repository_full_name,
            issue_number,
            issue_title,
            issue_branch_name,
            queue_order,
            stage,
            terminal_status,
            reason_code,
            fix_hint,
            created_at,
            updated_at,
            terminal_at
         FROM runtime_runs
         WHERE repository_key = ?1
           AND issue_number = ?2
           AND terminal_status IS NULL
         ORDER BY run_id DESC
         LIMIT 1",
        params![repository_key, issue_number],
        read_runtime_persisted_run,
    )
    .optional()
}

fn next_runtime_queue_order(conn: &Connection, repository_key: &str) -> rusqlite::Result<i64> {
    conn.query_row(
        "SELECT COALESCE(MAX(queue_order), -1) + 1
         FROM runtime_runs
         WHERE repository_key = ?1
           AND terminal_status IS NULL",
        params![repository_key],
        |row| row.get(0),
    )
}

fn insert_runtime_run(conn: &Connection, run: &RuntimeIssueRun) -> Result<RuntimePersistedRun, String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let queue_order = next_runtime_queue_order(&tx, &run.repository_key).map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO runtime_runs (
            repository_key,
            repository_full_name,
            issue_number,
            issue_title,
            issue_branch_name,
            queue_order,
            stage
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            run.repository_key.as_str(),
            run.repository_full_name.as_str(),
            run.issue_number,
            run.issue_title.as_str(),
            run.issue_branch_name.as_str(),
            queue_order,
            RuntimeRunStage::Queued.as_str()
        ],
    )
    .map_err(|e| e.to_string())?;
    let run_id = tx.last_insert_rowid();
    tx.execute(
        "INSERT INTO runtime_run_transitions (
            run_id,
            sequence,
            stage
         ) VALUES (?1, ?2, ?3)",
        params![run_id, 1_i64, RuntimeRunStage::Queued.as_str()],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    load_runtime_run_by_id(conn, run_id).map_err(|e| e.to_string())
}

fn resolve_runtime_run_id(conn: &Connection, run: &RuntimeIssueRun) -> Result<i64, String> {
    if let Some(run_id) = run.run_id {
        return Ok(run_id);
    }

    load_active_runtime_run_by_issue(conn, &run.repository_key, run.issue_number)
        .map_err(|e| e.to_string())?
        .map(|persisted| persisted.run_id)
        .ok_or_else(|| "missing persisted runtime run".to_string())
}

fn transition_run_stage(
    conn: &Connection,
    run_id: i64,
    expected_stage: RuntimeRunStage,
    next_stage: Option<RuntimeRunStage>,
    terminal_status: Option<RuntimeTerminalStatus>,
    reason_code: Option<&str>,
    fix_hint: Option<&str>,
) -> Result<RuntimePersistedRun, String> {
    if next_stage.is_none() && terminal_status.is_none() {
        return Err("transition must update stage or set terminal status".to_string());
    }

    if terminal_status.is_none() && reason_code.is_some() {
        return Err("reason code requires terminal status".to_string());
    }

    if terminal_status.is_none() && fix_hint.is_some() {
        return Err("fix hint requires terminal status".to_string());
    }

    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let current = load_runtime_run_by_id(&tx, run_id).map_err(|e| e.to_string())?;
    if current.terminal_status.is_some() {
        return Err("runtime run already finalized".to_string());
    }

    if current.stage != expected_stage {
        return Err(format!(
            "runtime transition expected {:?} but found {:?}",
            expected_stage, current.stage
        ));
    }

    if let Some(target_stage) = next_stage {
        if !expected_stage.can_transition_to(target_stage) {
            return Err(format!(
                "invalid runtime stage transition {:?} -> {:?}",
                expected_stage, target_stage
            ));
        }
    }

    let applied_stage = next_stage.unwrap_or(expected_stage);
    let next_sequence: i64 = tx
        .query_row(
            "SELECT COALESCE(MAX(sequence), 0) + 1
             FROM runtime_run_transitions
             WHERE run_id = ?1",
            params![run_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    let terminal_status_value = terminal_status.map(RuntimeTerminalStatus::as_str);
    tx.execute(
        "UPDATE runtime_runs
         SET stage = ?1,
             terminal_status = ?2,
             reason_code = ?3,
             fix_hint = ?4,
             updated_at = CURRENT_TIMESTAMP,
             terminal_at = CASE
                WHEN ?2 IS NULL THEN terminal_at
                ELSE COALESCE(terminal_at, CURRENT_TIMESTAMP)
             END
         WHERE run_id = ?5",
        params![
            applied_stage.as_str(),
            terminal_status_value,
            reason_code,
            fix_hint,
            run_id
        ],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO runtime_run_transitions (
            run_id,
            sequence,
            stage,
            terminal_status,
            reason_code,
            fix_hint
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            run_id,
            next_sequence,
            applied_stage.as_str(),
            terminal_status_value,
            reason_code,
            fix_hint
        ],
    )
    .map_err(|e| e.to_string())?;
    if terminal_status_value.is_some() {
        prune_terminal_history_for_issue(&tx, &current.repository_key, current.issue_number, 20)
            .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;

    load_runtime_run_by_id(conn, run_id).map_err(|e| e.to_string())
}

fn persist_insert_runtime_run(db_path: &Path, run: &RuntimeIssueRun) -> Result<RuntimePersistedRun, String> {
    with_connection(db_path, |conn| {
        insert_runtime_run(conn, run).map_err(runtime_invariant_error)
    })
}

fn persist_transition_runtime_run_stage(
    db_path: &Path,
    run: &RuntimeIssueRun,
    expected_stage: RuntimeRunStage,
    next_stage: RuntimeRunStage,
) -> Result<RuntimePersistedRun, String> {
    with_connection(db_path, |conn| {
        let run_id = resolve_runtime_run_id(conn, run).map_err(runtime_invariant_error)?;
        transition_run_stage(
            conn,
            run_id,
            expected_stage,
            Some(next_stage),
            None,
            None,
            None,
        )
        .map_err(runtime_invariant_error)
    })
}

fn persist_finalize_runtime_run(
    db_path: &Path,
    run: &RuntimeIssueRun,
    terminal_status: RuntimeTerminalStatus,
    reason_code: Option<&str>,
    fix_hint: Option<&str>,
) -> Result<RuntimePersistedRun, String> {
    with_connection(db_path, |conn| {
        let run_id = resolve_runtime_run_id(conn, run).map_err(runtime_invariant_error)?;
        let current = load_runtime_run_by_id(conn, run_id)?;
        transition_run_stage(
            conn,
            run_id,
            current.stage,
            None,
            Some(terminal_status),
            reason_code,
            fix_hint,
        )
        .map_err(runtime_invariant_error)
    })
}

fn persist_advance_runtime_run_to_publishing(
    db_path: &Path,
    run: &RuntimeIssueRun,
) -> Result<Vec<RuntimePersistedRun>, String> {
    with_connection(db_path, |conn| {
        let run_id = resolve_runtime_run_id(conn, run).map_err(runtime_invariant_error)?;
        let mut current = load_runtime_run_by_id(conn, run_id)?;
        let mut advanced_stages = Vec::new();
        while current.stage != RuntimeRunStage::Publishing {
            let Some(next_stage) = current.stage.next() else {
                break;
            };
            current = transition_run_stage(
                conn,
                run_id,
                current.stage,
                Some(next_stage),
                None,
                None,
                None,
            )
            .map_err(runtime_invariant_error)?;
            advanced_stages.push(current.clone());
        }

        Ok(advanced_stages)
    })
}

struct RuntimeStartupReconcileOutcome {
    recoverable_runs: Vec<RuntimeIssueRun>,
    stage_change_payloads: Vec<RuntimeRunStageChangedEventPayload>,
    telemetry_payloads: Vec<RuntimeRunTelemetryEventPayload>,
}

fn reconcile_runtime_state_on_startup_inner(
    conn: &Connection,
) -> Result<RuntimeStartupReconcileOutcome, String> {
    let non_terminal_runs = load_non_terminal_runtime_runs_ordered(conn).map_err(|e| e.to_string())?;
    let mut touched_repositories = BTreeMap::new();
    let mut telemetry_payloads = Vec::new();
    for persisted in &non_terminal_runs {
        touched_repositories
            .entry(persisted.repository_key.clone())
            .or_insert_with(|| persisted.repository_full_name.clone());

        if persisted.stage == RuntimeRunStage::Queued {
            continue;
        }

        transition_run_stage(
            conn,
            persisted.run_id,
            persisted.stage,
            None,
            Some(RuntimeTerminalStatus::Failed),
            Some(RUNTIME_RECOVERY_REASON_CODE),
            Some(RUNTIME_RECOVERY_FIX_HINT),
        )?;
        let recovery_detail = RuntimeTelemetryMilestoneDetail {
            kind: "milestone",
            stage: "finalized",
            message: "Recovered stale in-flight run as failed after app restart.".to_string(),
            include_in_summary: true,
        };
        let telemetry_payload = persist_runtime_run_event_payload(
            conn,
            persisted.run_id,
            recovery_detail.kind,
            recovery_detail.stage,
            recovery_detail.message.as_str(),
            recovery_detail.include_in_summary,
        )?;
        telemetry_payloads.push(telemetry_payload);
    }

    let recoverable_runs = load_recoverable_queued_runtime_runs_ordered(conn)
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(persisted_run_to_runtime_issue_run)
        .collect();
    let mut stage_change_payloads = Vec::new();
    for (repository_key, repository_full_name) in touched_repositories {
        let snapshot =
            runtime_get_repository_run_snapshot_inner(conn, &repository_key, &repository_full_name)?;
        let snapshot_repository_full_name = snapshot.repository_full_name.clone();
        let snapshot_repository_key = snapshot.repository_key.clone();
        stage_change_payloads.extend(snapshot.runs.into_iter().map(|run| {
            RuntimeRunStageChangedEventPayload {
                run_id: run.run_id,
                repository_full_name: snapshot_repository_full_name.clone(),
                repository_key: snapshot_repository_key.clone(),
                issue_number: run.issue_number,
                issue_title: run.issue_title,
                issue_branch_name: run.issue_branch_name,
                stage: run.stage,
                queue_position: run.queue_position,
                terminal_status: run.terminal_status,
                reason_code: run.reason_code,
                fix_hint: run.fix_hint,
            }
        }));
    }

    Ok(RuntimeStartupReconcileOutcome {
        recoverable_runs,
        stage_change_payloads,
        telemetry_payloads,
    })
}

pub fn reconcile_runtime_state_on_startup(app: &AppHandle) -> Result<(), String> {
    let db_path = app.state::<DbPath>();
    let reconcile_outcome = with_connection(&db_path.0, |conn| {
        reconcile_runtime_state_on_startup_inner(conn).map_err(runtime_invariant_error)
    })?;

    let active_runs = {
        let state = app.state::<RuntimeBoundarySharedState>();
        let mut queue = state.lock()?;
        queue.restore_queued_runs_and_collect_active(reconcile_outcome.recoverable_runs)
    };

    for payload in &reconcile_outcome.stage_change_payloads {
        emit_runtime_stage_changed_event(app, payload);
    }
    for payload in &reconcile_outcome.telemetry_payloads {
        emit_runtime_run_telemetry_event(app, payload);
    }

    for run in active_runs {
        if let Err(start_error) = start_run_worker(app, run.clone()) {
            let terminal_status = if start_error.outcome.status == "blocked" {
                RuntimeTerminalStatus::GuardrailBlocked
            } else {
                RuntimeTerminalStatus::Failed
            };
            finalize_run(
                app,
                run,
                start_error.workspace_root,
                terminal_status,
                start_error.outcome.reason_code.clone(),
                start_error.outcome.fix_hint.clone(),
            );
        }
    }

    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeRepositoryRunSnapshotItem {
    pub run_id: i64,
    pub issue_number: i64,
    pub issue_title: String,
    pub issue_branch_name: String,
    pub stage: String,
    pub queue_position: Option<usize>,
    pub terminal_status: Option<String>,
    pub reason_code: Option<String>,
    pub fix_hint: Option<String>,
    pub updated_at: String,
    pub terminal_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeRepositoryRunSnapshot {
    pub repository_full_name: String,
    pub repository_key: String,
    pub runs: Vec<RuntimeRepositoryRunSnapshotItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeRunTransitionHistoryItem {
    pub sequence: i64,
    pub stage: String,
    pub terminal_status: Option<String>,
    pub reason_code: Option<String>,
    pub fix_hint: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeIssueRunHistoryItem {
    pub run_id: i64,
    pub issue_number: i64,
    pub issue_title: String,
    pub issue_branch_name: String,
    pub stage: String,
    pub queue_position: Option<usize>,
    pub terminal_status: Option<String>,
    pub reason_code: Option<String>,
    pub fix_hint: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub terminal_at: Option<String>,
    pub transitions: Vec<RuntimeRunTransitionHistoryItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeIssueRunHistory {
    pub repository_full_name: String,
    pub repository_key: String,
    pub issue_number: i64,
    pub runs: Vec<RuntimeIssueRunHistoryItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeIssueRunHistoryRequest {
    pub repository_full_name: String,
    pub issue_number: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeIssueRunTelemetry {
    pub repository_full_name: String,
    pub repository_key: String,
    pub issue_number: i64,
    pub run_id: i64,
    pub events: Vec<RuntimeRunTelemetryEventPayload>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeIssueRunTelemetryRequest {
    pub repository_full_name: String,
    pub issue_number: i64,
    pub run_id: Option<i64>,
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeIssueRunSummaryCompletion {
    pub status: String,
    pub terminal_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeIssueRunSummaryKeyAction {
    pub kind: String,
    pub stage: String,
    pub message: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeIssueRunSummaryValidationOutcomes {
    pub code: String,
    pub browser: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeIssueRunSummary {
    pub repository_full_name: String,
    pub repository_key: String,
    pub issue_number: i64,
    pub run_id: i64,
    pub completion: RuntimeIssueRunSummaryCompletion,
    pub key_actions: Vec<RuntimeIssueRunSummaryKeyAction>,
    pub validation_outcomes: RuntimeIssueRunSummaryValidationOutcomes,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeIssueRunSummaryRequest {
    pub repository_full_name: String,
    pub issue_number: i64,
    pub run_id: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeRunStageChangedEventPayload {
    pub run_id: i64,
    pub repository_full_name: String,
    pub repository_key: String,
    pub issue_number: i64,
    pub issue_title: String,
    pub issue_branch_name: String,
    pub stage: String,
    pub queue_position: Option<usize>,
    pub terminal_status: Option<String>,
    pub reason_code: Option<String>,
    pub fix_hint: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeRunTelemetryEventPayload {
    pub event_id: i64,
    pub run_id: i64,
    pub repository_full_name: String,
    pub repository_key: String,
    pub issue_number: i64,
    pub issue_title: String,
    pub issue_branch_name: String,
    pub sequence: i64,
    pub kind: String,
    pub stage: String,
    pub message: String,
    pub redaction_reasons: Vec<RuntimeTelemetryRedactionReason>,
    pub include_in_summary: bool,
    pub created_at: String,
}

fn runtime_stage_changed_event_payload_inner(
    conn: &Connection,
    run_id: i64,
) -> Result<RuntimeRunStageChangedEventPayload, String> {
    let run = load_runtime_run_by_id(conn, run_id).map_err(|e| e.to_string())?;
    let queue_position = if run.stage == RuntimeRunStage::Queued && run.terminal_status.is_none() {
        let position: i64 = conn
            .query_row(
                "SELECT COUNT(*)
                 FROM runtime_runs
                 WHERE repository_key = ?1
                   AND terminal_status IS NULL
                   AND stage = ?2
                   AND (queue_order < ?3 OR (queue_order = ?3 AND run_id <= ?4))",
                params![
                    run.repository_key.as_str(),
                    RuntimeRunStage::Queued.as_str(),
                    run.queue_order,
                    run.run_id
                ],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        usize::try_from(position).ok()
    } else {
        None
    };

    Ok(RuntimeRunStageChangedEventPayload {
        run_id: run.run_id,
        repository_full_name: run.repository_full_name,
        repository_key: run.repository_key,
        issue_number: run.issue_number,
        issue_title: run.issue_title,
        issue_branch_name: run.issue_branch_name,
        stage: run.stage.as_str().to_string(),
        queue_position,
        terminal_status: run.terminal_status.map(|status| status.as_str().to_string()),
        reason_code: run.reason_code,
        fix_hint: run.fix_hint,
    })
}

fn emit_runtime_stage_changed_event(
    app: &AppHandle,
    payload: &RuntimeRunStageChangedEventPayload,
) {
    let _ = app.emit(RUNTIME_RUN_STAGE_CHANGED_EVENT, payload);
}

fn emit_runtime_stage_changed_event_for_run(app: &AppHandle, run_id: i64) {
    let db_path = app.state::<DbPath>();
    let payload = with_connection(&db_path.0, |conn| {
        runtime_stage_changed_event_payload_inner(conn, run_id).map_err(runtime_invariant_error)
    });

    if let Ok(payload) = payload {
        emit_runtime_stage_changed_event(app, &payload);
    }
}

fn emit_runtime_run_telemetry_event(
    app: &AppHandle,
    payload: &RuntimeRunTelemetryEventPayload,
) {
    let _ = app.emit(RUNTIME_RUN_TELEMETRY_EVENT, payload);
}

fn record_runtime_telemetry_event(
    app: &AppHandle,
    run: &RuntimeIssueRun,
    kind: &str,
    stage: &str,
    message: &str,
    include_in_summary: bool,
) {
    let db_path = app.state::<DbPath>();
    let payload = with_connection(&db_path.0, |conn| {
        let run_id = resolve_runtime_run_id(conn, run).map_err(runtime_invariant_error)?;
        persist_runtime_run_event_payload(conn, run_id, kind, stage, message, include_in_summary)
            .map_err(runtime_invariant_error)
    });
    if let Ok(payload) = payload {
        emit_runtime_run_telemetry_event(app, &payload);
    }
}

fn record_runtime_telemetry_milestone(
    app: &AppHandle,
    run: &RuntimeIssueRun,
    milestone: RuntimeTelemetryMilestone,
    terminal_status: Option<RuntimeTerminalStatus>,
) {
    let detail = runtime_milestone_detail(
        milestone,
        terminal_status.map(RuntimeTerminalStatus::as_str),
    );
    record_runtime_telemetry_event(
        app,
        run,
        detail.kind,
        detail.stage,
        detail.message.as_str(),
        detail.include_in_summary,
    );
}

fn runtime_get_repository_run_snapshot_inner(
    conn: &Connection,
    repository_key: &str,
    repository_full_name: &str,
) -> Result<RuntimeRepositoryRunSnapshot, String> {
    let mut queue_position_stmt = conn
        .prepare(
            "SELECT run_id
             FROM runtime_runs
             WHERE repository_key = ?1
               AND terminal_status IS NULL
               AND stage = ?2
             ORDER BY queue_order ASC, run_id ASC",
        )
        .map_err(|e| e.to_string())?;
    let queued_rows = queue_position_stmt
        .query_map(params![repository_key, RuntimeRunStage::Queued.as_str()], |row| {
            row.get::<_, i64>(0)
        })
        .map_err(|e| e.to_string())?;
    let queued_run_ids: Vec<i64> = queued_rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    drop(queue_position_stmt);

    let queue_positions: HashMap<i64, usize> = queued_run_ids
        .into_iter()
        .enumerate()
        .map(|(index, run_id)| (run_id, index + 1))
        .collect();

    let mut runs_stmt = conn
        .prepare(
            "SELECT
                r.run_id,
                r.repository_key,
                r.repository_full_name,
                r.issue_number,
                r.issue_title,
                r.issue_branch_name,
                r.queue_order,
                r.stage,
                r.terminal_status,
                r.reason_code,
                r.fix_hint,
                r.created_at,
                r.updated_at,
                r.terminal_at
             FROM runtime_runs r
             WHERE r.repository_key = ?1
               AND r.run_id = (
                    SELECT candidate.run_id
                    FROM runtime_runs candidate
                    WHERE candidate.repository_key = r.repository_key
                      AND candidate.issue_number = r.issue_number
                    ORDER BY
                        (candidate.terminal_status IS NULL) DESC,
                        candidate.updated_at DESC,
                        candidate.run_id DESC
                    LIMIT 1
               )
             ORDER BY r.issue_number ASC, r.run_id DESC",
        )
        .map_err(|e| e.to_string())?;
    let runs = runs_stmt
        .query_map(params![repository_key], read_runtime_persisted_run)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    let snapshot_items = runs
        .into_iter()
        .map(|run| RuntimeRepositoryRunSnapshotItem {
            run_id: run.run_id,
            issue_number: run.issue_number,
            issue_title: run.issue_title,
            issue_branch_name: run.issue_branch_name,
            stage: run.stage.as_str().to_string(),
            queue_position: queue_positions.get(&run.run_id).copied(),
            terminal_status: run.terminal_status.map(|status| status.as_str().to_string()),
            reason_code: run.reason_code,
            fix_hint: run.fix_hint,
            updated_at: run.updated_at,
            terminal_at: run.terminal_at,
        })
        .collect();

    Ok(RuntimeRepositoryRunSnapshot {
        repository_full_name: repository_full_name.to_string(),
        repository_key: repository_key.to_string(),
        runs: snapshot_items,
    })
}

fn runtime_get_issue_run_history_inner(
    conn: &Connection,
    repository_key: &str,
    repository_full_name: &str,
    issue_number: i64,
) -> Result<RuntimeIssueRunHistory, String> {
    let mut queue_position_stmt = conn
        .prepare(
            "SELECT run_id
             FROM runtime_runs
             WHERE repository_key = ?1
               AND terminal_status IS NULL
               AND stage = ?2
             ORDER BY queue_order ASC, run_id ASC",
        )
        .map_err(|e| e.to_string())?;
    let queued_rows = queue_position_stmt
        .query_map(params![repository_key, RuntimeRunStage::Queued.as_str()], |row| {
            row.get::<_, i64>(0)
        })
        .map_err(|e| e.to_string())?;
    let queued_run_ids: Vec<i64> = queued_rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    drop(queue_position_stmt);
    let queue_positions: HashMap<i64, usize> = queued_run_ids
        .into_iter()
        .enumerate()
        .map(|(index, run_id)| (run_id, index + 1))
        .collect();

    let mut history_stmt = conn
        .prepare(
            "SELECT
                run_id,
                repository_key,
                repository_full_name,
                issue_number,
                issue_title,
                issue_branch_name,
                queue_order,
                stage,
                terminal_status,
                reason_code,
                fix_hint,
                created_at,
                updated_at,
                terminal_at
             FROM runtime_runs
             WHERE repository_key = ?1
               AND issue_number = ?2
             ORDER BY
                COALESCE(terminal_at, updated_at) DESC,
                run_id DESC
             LIMIT 20",
        )
        .map_err(|e| e.to_string())?;
    let runs = history_stmt
        .query_map(params![repository_key, issue_number], read_runtime_persisted_run)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    let mut history_items = Vec::with_capacity(runs.len());
    for run in runs {
        let transitions = load_runtime_run_transitions_newest_first(conn, run.run_id)
            .map_err(|e| e.to_string())?
            .into_iter()
            .map(|transition| RuntimeRunTransitionHistoryItem {
                sequence: transition.sequence,
                stage: transition.stage.as_str().to_string(),
                terminal_status: transition
                    .terminal_status
                    .map(|status| status.as_str().to_string()),
                reason_code: transition.reason_code,
                fix_hint: transition.fix_hint,
                created_at: transition.created_at,
            })
            .collect();

        history_items.push(RuntimeIssueRunHistoryItem {
            run_id: run.run_id,
            issue_number: run.issue_number,
            issue_title: run.issue_title,
            issue_branch_name: run.issue_branch_name,
            stage: run.stage.as_str().to_string(),
            queue_position: queue_positions.get(&run.run_id).copied(),
            terminal_status: run.terminal_status.map(|status| status.as_str().to_string()),
            reason_code: run.reason_code,
            fix_hint: run.fix_hint,
            created_at: run.created_at,
            updated_at: run.updated_at,
            terminal_at: run.terminal_at,
            transitions,
        });
    }

    Ok(RuntimeIssueRunHistory {
        repository_full_name: repository_full_name.to_string(),
        repository_key: repository_key.to_string(),
        issue_number,
        runs: history_items,
    })
}

const DEFAULT_RUNTIME_ISSUE_TELEMETRY_LIMIT: usize = 100;
const MAX_RUNTIME_ISSUE_TELEMETRY_LIMIT: usize = 250;
const MAX_RUNTIME_SUMMARY_KEY_ACTIONS: usize = 8;

fn resolve_runtime_issue_telemetry_limit(limit: Option<usize>) -> usize {
    limit
        .unwrap_or(DEFAULT_RUNTIME_ISSUE_TELEMETRY_LIMIT)
        .clamp(1, MAX_RUNTIME_ISSUE_TELEMETRY_LIMIT)
}

fn load_runtime_run_for_issue(
    conn: &Connection,
    repository_key: &str,
    issue_number: i64,
    run_id: Option<i64>,
) -> Result<Option<RuntimePersistedRun>, String> {
    if let Some(run_id) = run_id {
        return conn
            .query_row(
                "SELECT
                    run_id,
                    repository_key,
                    repository_full_name,
                    issue_number,
                    issue_title,
                    issue_branch_name,
                    queue_order,
                    stage,
                    terminal_status,
                    reason_code,
                    fix_hint,
                    created_at,
                    updated_at,
                    terminal_at
                 FROM runtime_runs
                 WHERE run_id = ?1
                   AND repository_key = ?2
                   AND issue_number = ?3
                 LIMIT 1",
                params![run_id, repository_key, issue_number],
                read_runtime_persisted_run,
            )
            .optional()
            .map_err(|e| e.to_string());
    }

    conn.query_row(
        "SELECT
            run_id,
            repository_key,
            repository_full_name,
            issue_number,
            issue_title,
            issue_branch_name,
            queue_order,
            stage,
            terminal_status,
            reason_code,
            fix_hint,
            created_at,
            updated_at,
            terminal_at
         FROM runtime_runs
         WHERE repository_key = ?1
           AND issue_number = ?2
         ORDER BY
            (terminal_status IS NULL) DESC,
            COALESCE(terminal_at, updated_at) DESC,
            run_id DESC
         LIMIT 1",
        params![repository_key, issue_number],
        read_runtime_persisted_run,
    )
    .optional()
    .map_err(|e| e.to_string())
}

fn runtime_get_issue_run_telemetry_inner(
    conn: &Connection,
    repository_key: &str,
    repository_full_name: &str,
    issue_number: i64,
    run_id: Option<i64>,
    limit: Option<usize>,
) -> Result<RuntimeIssueRunTelemetry, String> {
    let target_run = load_runtime_run_for_issue(conn, repository_key, issue_number, run_id)?
        .ok_or_else(|| "Runtime telemetry is unavailable for the selected issue.".to_string())?;
    let mut events = runtime_run_telemetry_payloads_newest_first(conn, target_run.run_id)?;
    events.truncate(resolve_runtime_issue_telemetry_limit(limit));

    Ok(RuntimeIssueRunTelemetry {
        repository_full_name: repository_full_name.to_string(),
        repository_key: repository_key.to_string(),
        issue_number,
        run_id: target_run.run_id,
        events,
    })
}

fn parse_validation_status(value: &str) -> Option<&'static str> {
    let lowered = value.to_ascii_lowercase();
    if lowered.contains("not-found") || lowered.contains("not found") {
        return Some("not-found");
    }
    if lowered.contains("not-run") || lowered.contains("not run") {
        return Some("not-run");
    }
    if lowered.contains("timeout") || lowered.contains("timed out") {
        return Some("timeout");
    }
    if lowered.contains("pass") || lowered.contains("passed") || lowered.contains("success") {
        return Some("pass");
    }
    if lowered.contains("fail") || lowered.contains("failed") || lowered.contains("error") {
        return Some("fail");
    }
    None
}

fn derive_validation_outcomes(
    events: &[RuntimePersistedRunEvent],
) -> RuntimeIssueRunSummaryValidationOutcomes {
    let mut code_status: Option<String> = None;
    let mut browser_status: Option<String> = None;
    let mut validation_seen = false;

    for event in events {
        let kind = event.kind.to_ascii_lowercase();
        let stage = event.stage.to_ascii_lowercase();
        let message = event.message.to_ascii_lowercase();

        let is_validation_event = kind.contains("validation")
            || stage.contains("validation")
            || stage.contains("validating");
        if is_validation_event {
            validation_seen = true;
        }

        let target = if stage.contains("code") || message.contains("code validation") {
            Some("code")
        } else if stage.contains("browser")
            || stage.contains("visual")
            || message.contains("browser validation")
            || message.contains("visual validation")
        {
            Some("browser")
        } else {
            None
        };
        let Some(target) = target else {
            continue;
        };

        let status = parse_validation_status(&stage).or_else(|| parse_validation_status(&message));
        let Some(status) = status else {
            continue;
        };

        if target == "code" && code_status.is_none() {
            code_status = Some(status.to_string());
            continue;
        }
        if target == "browser" && browser_status.is_none() {
            browser_status = Some(status.to_string());
        }
    }

    let fallback = if validation_seen {
        "not-found".to_string()
    } else {
        "not-run".to_string()
    };

    RuntimeIssueRunSummaryValidationOutcomes {
        code: code_status.unwrap_or_else(|| fallback.clone()),
        browser: browser_status.unwrap_or(fallback),
    }
}

fn runtime_get_issue_run_summary_inner(
    conn: &Connection,
    repository_key: &str,
    repository_full_name: &str,
    issue_number: i64,
    run_id: Option<i64>,
) -> Result<RuntimeIssueRunSummary, String> {
    let target_run = load_runtime_run_for_issue(conn, repository_key, issue_number, run_id)?
        .ok_or_else(|| "Runtime summary is unavailable for the selected issue.".to_string())?;
    let telemetry_events =
        load_runtime_run_events_newest_first(conn, target_run.run_id).map_err(|e| e.to_string())?;

    let key_actions = telemetry_events
        .iter()
        .filter(|event| event.include_in_summary)
        .take(MAX_RUNTIME_SUMMARY_KEY_ACTIONS)
        .map(|event| {
            let (sanitized_message, _) = runtime_event_sanitized_read_view(event);
            RuntimeIssueRunSummaryKeyAction {
                kind: event.kind.clone(),
                stage: event.stage.clone(),
                message: sanitized_message,
                created_at: event.created_at.clone(),
            }
        })
        .collect();

    let completion_status = target_run
        .terminal_status
        .map(|status| status.as_str().to_string())
        .unwrap_or_else(|| "in-progress".to_string());

    Ok(RuntimeIssueRunSummary {
        repository_full_name: repository_full_name.to_string(),
        repository_key: repository_key.to_string(),
        issue_number,
        run_id: target_run.run_id,
        completion: RuntimeIssueRunSummaryCompletion {
            status: completion_status,
            terminal_at: target_run.terminal_at,
        },
        key_actions,
        validation_outcomes: derive_validation_outcomes(&telemetry_events),
    })
}

pub fn runtime_get_repository_run_snapshot(
    db_path: &Path,
    repository_full_name: &str,
) -> Result<RuntimeRepositoryRunSnapshot, String> {
    let repository_full_name = repository_full_name.trim();
    let repository_key = normalize_repository_key(repository_full_name).ok_or_else(|| {
        "Select a valid repository issue before loading runtime snapshot.".to_string()
    })?;

    with_connection(db_path, |conn| {
        runtime_get_repository_run_snapshot_inner(conn, &repository_key, repository_full_name)
            .map_err(runtime_invariant_error)
    })
}

pub fn runtime_get_issue_run_history(
    db_path: &Path,
    request: RuntimeIssueRunHistoryRequest,
) -> Result<RuntimeIssueRunHistory, String> {
    let repository_full_name = request.repository_full_name.trim();
    let repository_key = normalize_repository_key(repository_full_name).ok_or_else(|| {
        "Select a valid repository issue before loading runtime run history.".to_string()
    })?;
    if request.issue_number <= 0 {
        return Err("Select a valid repository issue before loading runtime run history.".to_string());
    }

    with_connection(db_path, |conn| {
        runtime_get_issue_run_history_inner(
            conn,
            &repository_key,
            repository_full_name,
            request.issue_number,
        )
        .map_err(runtime_invariant_error)
    })
}

pub fn runtime_get_issue_run_telemetry(
    db_path: &Path,
    request: RuntimeIssueRunTelemetryRequest,
) -> Result<RuntimeIssueRunTelemetry, String> {
    let repository_full_name = request.repository_full_name.trim();
    let repository_key = normalize_repository_key(repository_full_name).ok_or_else(|| {
        "Select a valid repository issue before loading runtime telemetry.".to_string()
    })?;
    if request.issue_number <= 0 {
        return Err("Select a valid repository issue before loading runtime telemetry.".to_string());
    }

    with_connection(db_path, |conn| {
        runtime_get_issue_run_telemetry_inner(
            conn,
            &repository_key,
            repository_full_name,
            request.issue_number,
            request.run_id,
            request.limit,
        )
        .map_err(runtime_invariant_error)
    })
}

pub fn runtime_get_issue_run_summary(
    db_path: &Path,
    request: RuntimeIssueRunSummaryRequest,
) -> Result<RuntimeIssueRunSummary, String> {
    let repository_full_name = request.repository_full_name.trim();
    let repository_key = normalize_repository_key(repository_full_name).ok_or_else(|| {
        "Select a valid repository issue before loading runtime summary.".to_string()
    })?;
    if request.issue_number <= 0 {
        return Err("Select a valid repository issue before loading runtime summary.".to_string());
    }

    with_connection(db_path, |conn| {
        runtime_get_issue_run_summary_inner(
            conn,
            &repository_key,
            repository_full_name,
            request.issue_number,
            request.run_id,
        )
        .map_err(runtime_invariant_error)
    })
}

fn runtime_transition_failed_outcome() -> RuntimeQueueOutcome {
    RuntimeQueueOutcome::startup_failed(
        "runtime_transition_persist_failed",
        "Runtime state persistence failed while transitioning run stage.",
    )
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeRunEvidence {
    run_id: String,
    repository_key: String,
    issue_number: i64,
    branch: String,
    terminal_status: String,
    blocked_reason_code: Option<String>,
}

fn generate_run_id(run: &RuntimeIssueRun) -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    format!(
        "{}-{}-{}",
        run.repository_key.replace('/', "_"),
        run.issue_number,
        millis
    )
}

fn runtime_evidence_dir() -> PathBuf {
    std::env::temp_dir().join(RUNTIME_EVIDENCE_DIR)
}

fn record_terminal_evidence(
    run: &RuntimeIssueRun,
    terminal_status: RuntimeTerminalStatus,
    blocked_reason_code: Option<String>,
) -> Option<PathBuf> {
    let evidence_dir = runtime_evidence_dir();
    if fs::create_dir_all(&evidence_dir).is_err() {
        return None;
    }

    let run_id = generate_run_id(run);
    let evidence = RuntimeRunEvidence {
        run_id: run_id.clone(),
        repository_key: run.repository_key.clone(),
        issue_number: run.issue_number,
        branch: run.issue_branch_name.clone(),
        terminal_status: terminal_status.as_str().to_string(),
        blocked_reason_code,
    };
    let encoded = match serde_json::to_vec_pretty(&evidence) {
        Ok(encoded) => encoded,
        Err(_) => return None,
    };
    let path = evidence_dir.join(format!("{run_id}.json"));
    if fs::write(&path, encoded).is_err() {
        return None;
    }

    Some(path)
}

fn finalize_workspace_cleanup(workspace_root: Option<&Path>) -> bool {
    let Some(workspace_root) = workspace_root else {
        return false;
    };

    let _ = fs::remove_dir_all(workspace_root);
    true
}

fn finalize_run(
    app: &AppHandle,
    run: RuntimeIssueRun,
    workspace_root: Option<PathBuf>,
    terminal_status: RuntimeTerminalStatus,
    reason_code: Option<String>,
    fix_hint: Option<String>,
) {
    let db_path = app.state::<DbPath>();
    if terminal_status == RuntimeTerminalStatus::Success {
        if let Ok(advanced_stages) = persist_advance_runtime_run_to_publishing(&db_path.0, &run) {
            for stage in advanced_stages {
                emit_runtime_stage_changed_event_for_run(app, stage.run_id);
                if stage.stage == RuntimeRunStage::Validating {
                    record_runtime_telemetry_milestone(
                        app,
                        &run,
                        RuntimeTelemetryMilestone::Validating,
                        None,
                    );
                }
                if stage.stage == RuntimeRunStage::Publishing {
                    record_runtime_telemetry_milestone(
                        app,
                        &run,
                        RuntimeTelemetryMilestone::Publishing,
                        None,
                    );
                }
            }
        }
    }
    let finalized = if let Ok(finalized) = persist_finalize_runtime_run(
        &db_path.0,
        &run,
        terminal_status,
        reason_code.as_deref(),
        fix_hint.as_deref(),
    ) {
        finalized
    } else {
        let _ = record_terminal_evidence(&run, terminal_status, reason_code);
        let _ = finalize_workspace_cleanup(workspace_root.as_deref());
        return;
    };

    emit_runtime_stage_changed_event_for_run(app, finalized.run_id);
    record_runtime_telemetry_milestone(
        app,
        &run,
        RuntimeTelemetryMilestone::Finalization,
        Some(terminal_status),
    );

    let _ = record_terminal_evidence(&run, terminal_status, reason_code);
    let _ = finalize_workspace_cleanup(workspace_root.as_deref());

    let next_run = {
        let state = app.state::<RuntimeBoundarySharedState>();
        let mut queue = match state.lock() {
            Ok(queue) => queue,
            Err(_) => return,
        };
        queue.finalize_active_and_promote_next(&run.repository_key, run.issue_number)
    };

    if let Some(next_run) = next_run {
        if let Err(start_error) = start_run_worker(app, next_run.clone()) {
            let next_terminal_status = if start_error.outcome.status == "blocked" {
                RuntimeTerminalStatus::GuardrailBlocked
            } else {
                RuntimeTerminalStatus::Failed
            };
            let next_reason_code = start_error.outcome.reason_code.clone();
            let next_fix_hint = start_error.outcome.fix_hint.clone();
            finalize_run(
                app,
                next_run,
                start_error.workspace_root,
                next_terminal_status,
                next_reason_code,
                next_fix_hint,
            );
        }
    }
}

fn spawn_sidecar_for_run(
    app: &AppHandle,
    run: &RuntimeIssueRun,
    prepared: &PreparedWorkspace,
) -> Result<(), StartRunError> {
    ensure_within_workspace(&prepared.workspace_root, &prepared.repository_path)
        .map_err(|block| StartRunError::guardrail(block, Some(prepared.workspace_root.clone())))?;

    let command = app
        .shell()
        .sidecar(SIDECAR_ALIAS)
        .map_err(|_| {
            StartRunError::guardrail(
                GuardrailBlock::new("command_scope", "command"),
                Some(prepared.workspace_root.clone()),
            )
        })?
        .current_dir(prepared.repository_path.clone());

    let (mut receiver, _child) = command
        .spawn()
        .map_err(|_| StartRunError::startup(Some(prepared.workspace_root.clone())))?;

    let app_handle = app.clone();
    let run_for_finalize = run.clone();
    let workspace_for_finalize = prepared.workspace_root.clone();
    tauri::async_runtime::spawn(async move {
        let mut terminal_status = RuntimeTerminalStatus::Cancelled;
        while let Some(event) = receiver.recv().await {
            match event {
                CommandEvent::Terminated(payload) => {
                    let exit_code = payload.code.unwrap_or(-1);
                    record_runtime_telemetry_event(
                        &app_handle,
                        &run_for_finalize,
                        "system",
                        "coding",
                        format!("Worker process exited with status code {exit_code}.").as_str(),
                        false,
                    );
                    terminal_status = if payload.code == Some(0) {
                        RuntimeTerminalStatus::Success
                    } else {
                        RuntimeTerminalStatus::Failed
                    };
                    break;
                }
                CommandEvent::Error(_) => {
                    record_runtime_telemetry_event(
                        &app_handle,
                        &run_for_finalize,
                        "system",
                        "coding",
                        "Worker process reported an execution error before termination.",
                        false,
                    );
                    terminal_status = RuntimeTerminalStatus::Failed;
                    break;
                }
                _ => {}
            }
        }

        finalize_run(
            &app_handle,
            run_for_finalize,
            Some(workspace_for_finalize),
            terminal_status,
            None,
            None,
        );
    });

    Ok(())
}

fn start_run_worker(app: &AppHandle, run: RuntimeIssueRun) -> Result<(), StartRunError> {
    record_runtime_telemetry_milestone(app, &run, RuntimeTelemetryMilestone::Start, None);

    let db_path = app.state::<DbPath>();
    let preparing = persist_transition_runtime_run_stage(
        &db_path.0,
        &run,
        RuntimeRunStage::Queued,
        RuntimeRunStage::Preparing,
    )
    .map_err(|_| StartRunError::with_outcome(runtime_transition_failed_outcome(), None))?;
    emit_runtime_stage_changed_event_for_run(app, preparing.run_id);
    record_runtime_telemetry_milestone(app, &run, RuntimeTelemetryMilestone::Preparing, None);

    let prepared = prepare_workspace_for_run(&run)?;
    let coding = persist_transition_runtime_run_stage(
        &db_path.0,
        &run,
        RuntimeRunStage::Preparing,
        RuntimeRunStage::Coding,
    )
    .map_err(|_| {
        StartRunError::with_outcome(
            runtime_transition_failed_outcome(),
            Some(prepared.workspace_root.clone()),
        )
    })?;
    emit_runtime_stage_changed_event_for_run(app, coding.run_id);
    record_runtime_telemetry_milestone(app, &run, RuntimeTelemetryMilestone::Coding, None);

    spawn_sidecar_for_run(app, &run, &prepared)
}

#[cfg(test)]
pub fn runtime_enqueue_issue_run_inner(
    state: &RuntimeBoundarySharedState,
    request: RuntimeEnqueueIssueRunRequest,
) -> Result<RuntimeQueueOutcome, String> {
    let Some(run) = create_runtime_issue_run(request) else {
        return Ok(RuntimeQueueOutcome::not_found(
            "invalid_runtime_request",
            "Select a valid repository issue before starting a run.",
        ));
    };

    let outcome = {
        let mut queue = state.lock()?;
        queue.enqueue_run(run)
    };
    Ok(outcome)
}

#[cfg(test)]
pub fn runtime_dequeue_issue_run_inner(
    state: &RuntimeBoundarySharedState,
    request: RuntimeDequeueIssueRunRequest,
) -> Result<RuntimeQueueOutcome, String> {
    let Some(repository_key) = normalize_repository_key(&request.repository_full_name) else {
        return Ok(RuntimeQueueOutcome::not_found(
            "invalid_runtime_request",
            "Select a valid repository issue before removing a queued run.",
        ));
    };

    if request.issue_number <= 0 {
        return Ok(RuntimeQueueOutcome::not_found(
            "invalid_runtime_request",
            "Select a valid repository issue before removing a queued run.",
        ));
    }

    let removed = {
        let mut queue = state.lock()?;
        queue.dequeue_queued_run(&repository_key, request.issue_number)
    };
    if removed.is_some() {
        return Ok(RuntimeQueueOutcome::removed());
    }

    Ok(RuntimeQueueOutcome::not_found(
        "queued_run_not_found",
        "Issue run was not queued for this repository.",
    ))
}

#[tauri::command]
pub async fn runtime_enqueue_issue_run(
    app: AppHandle,
    state: State<'_, RuntimeBoundarySharedState>,
    request: RuntimeEnqueueIssueRunRequest,
) -> Result<RuntimeQueueOutcome, String> {
    let Some(mut run) = create_runtime_issue_run(request) else {
        return Ok(RuntimeQueueOutcome::not_found(
            "invalid_runtime_request",
            "Select a valid repository issue before starting a run.",
        ));
    };

    let db_path = app.state::<DbPath>();
    let persisted = persist_insert_runtime_run(&db_path.0, &run)?;
    run.run_id = Some(persisted.run_id);
    emit_runtime_stage_changed_event_for_run(&app, persisted.run_id);
    record_runtime_telemetry_milestone(&app, &run, RuntimeTelemetryMilestone::Queue, None);

    let outcome = {
        let mut queue = match state.lock() {
            Ok(queue) => queue,
            Err(error) => {
                if let Ok(finalized) = persist_finalize_runtime_run(
                    &db_path.0,
                    &run,
                    RuntimeTerminalStatus::Failed,
                    Some("runtime_queue_state_unavailable"),
                    Some("Retry enqueue after restarting HostLocal."),
                ) {
                    emit_runtime_stage_changed_event_for_run(&app, finalized.run_id);
                    record_runtime_telemetry_milestone(
                        &app,
                        &run,
                        RuntimeTelemetryMilestone::Finalization,
                        Some(RuntimeTerminalStatus::Failed),
                    );
                }
                return Err(error);
            }
        };
        queue.enqueue_run(run.clone())
    };
    if outcome.status != "started" {
        return Ok(outcome);
    }

    if let Err(start_error) = start_run_worker(&app, run.clone()) {
        let terminal_status = if start_error.outcome.status == "blocked" {
            RuntimeTerminalStatus::GuardrailBlocked
        } else {
            RuntimeTerminalStatus::Failed
        };
        let reason_code = start_error.outcome.reason_code.clone();
        let fix_hint = start_error.outcome.fix_hint.clone();
        finalize_run(
            &app,
            run,
            start_error.workspace_root,
            terminal_status,
            reason_code,
            fix_hint,
        );
        return Ok(start_error.outcome);
    }

    Ok(outcome)
}

#[tauri::command]
pub async fn runtime_dequeue_issue_run(
    app: AppHandle,
    state: State<'_, RuntimeBoundarySharedState>,
    request: RuntimeDequeueIssueRunRequest,
) -> Result<RuntimeQueueOutcome, String> {
    let Some(repository_key) = normalize_repository_key(&request.repository_full_name) else {
        return Ok(RuntimeQueueOutcome::not_found(
            "invalid_runtime_request",
            "Select a valid repository issue before removing a queued run.",
        ));
    };

    if request.issue_number <= 0 {
        return Ok(RuntimeQueueOutcome::not_found(
            "invalid_runtime_request",
            "Select a valid repository issue before removing a queued run.",
        ));
    }

    let removed_run = {
        let mut queue = state.lock()?;
        queue.dequeue_queued_run(&repository_key, request.issue_number)
    };
    let Some(removed_run) = removed_run else {
        return Ok(RuntimeQueueOutcome::not_found(
            "queued_run_not_found",
            "Issue run was not queued for this repository.",
        ));
    };

    let db_path = app.state::<DbPath>();
    let finalized = persist_finalize_runtime_run(
        &db_path.0,
        &removed_run,
        RuntimeTerminalStatus::Cancelled,
        Some("runtime_queue_removed"),
        Some("Issue run was removed from queue before execution."),
    )?;
    emit_runtime_stage_changed_event_for_run(&app, finalized.run_id);
    record_runtime_telemetry_milestone(
        &app,
        &removed_run,
        RuntimeTelemetryMilestone::Finalization,
        Some(RuntimeTerminalStatus::Cancelled),
    );

    Ok(RuntimeQueueOutcome::removed())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::initialize_schema;
    use rusqlite::Connection;
    use tempfile::tempdir;

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

    fn runtime_schema_test_connection() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory sqlite");
        initialize_schema(&conn).expect("initialize sqlite schema");
        conn
    }

    fn runtime_insert_test_run(
        conn: &Connection,
        repository_key: &str,
        repository_full_name: &str,
        issue_number: i64,
        issue_title: &str,
        queue_order: i64,
    ) -> i64 {
        conn.execute(
            "INSERT INTO runtime_runs (
                repository_key,
                repository_full_name,
                issue_number,
                issue_title,
                issue_branch_name,
                queue_order,
                stage
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            rusqlite::params![
                repository_key,
                repository_full_name,
                issue_number,
                issue_title,
                format!("hostlocal/issue-{issue_number}-test"),
                queue_order,
                "queued"
            ],
        )
        .expect("insert runtime run");
        let run_id = conn.last_insert_rowid();
        conn.execute(
            "INSERT INTO runtime_run_transitions (
                run_id,
                sequence,
                stage
            ) VALUES (?1, ?2, ?3)",
            rusqlite::params![run_id, 1_i64, "queued"],
        )
        .expect("insert initial transition");

        run_id
    }

    fn transition_run_stage_under_test(
        conn: &Connection,
        run_id: i64,
        expected_stage: &str,
        next_stage: &str,
    ) -> Result<(), String> {
        let expected = RuntimeRunStage::from_db(expected_stage)
            .ok_or_else(|| format!("invalid test expected stage: {expected_stage}"))?;
        let next = RuntimeRunStage::from_db(next_stage)
            .ok_or_else(|| format!("invalid test next stage: {next_stage}"))?;
        transition_run_stage(conn, run_id, expected, Some(next), None, None, None).map(|_| ())
    }

    fn run_stage_value(conn: &Connection, run_id: i64) -> String {
        conn.query_row(
            "SELECT stage FROM runtime_runs WHERE run_id = ?1",
            [run_id],
            |row| row.get(0),
        )
        .expect("fetch run stage")
    }

    fn transition_count(conn: &Connection, run_id: i64) -> i64 {
        conn.query_row(
            "SELECT COUNT(*) FROM runtime_run_transitions WHERE run_id = ?1",
            [run_id],
            |row| row.get(0),
        )
        .expect("count transitions")
    }

    fn sqlite_object_exists(conn: &Connection, object_type: &str, name: &str) -> bool {
        conn.query_row(
            "SELECT 1 FROM sqlite_master WHERE type = ?1 AND name = ?2 LIMIT 1",
            [object_type, name],
            |_| Ok(()),
        )
        .is_ok()
    }

    #[test]
    fn runtime_boundary_schema_creates_runtime_tables_and_indexes() {
        let conn = runtime_schema_test_connection();

        assert!(sqlite_object_exists(&conn, "table", "runtime_runs"));
        assert!(sqlite_object_exists(
            &conn,
            "table",
            "runtime_run_transitions"
        ));
        assert!(sqlite_object_exists(
            &conn,
            "index",
            "idx_runtime_runs_repository_queue"
        ));
        assert!(sqlite_object_exists(
            &conn,
            "index",
            "idx_runtime_runs_issue_terminal_history"
        ));
        assert!(sqlite_object_exists(
            &conn,
            "index",
            "idx_runtime_run_transitions_run_sequence"
        ));
        assert!(sqlite_object_exists(
            &conn,
            "table",
            "runtime_run_events"
        ));
        assert!(sqlite_object_exists(
            &conn,
            "index",
            "idx_runtime_run_events_run_sequence"
        ));
        assert!(sqlite_object_exists(
            &conn,
            "index",
            "idx_runtime_run_events_summary"
        ));
    }

    #[test]
    fn runtime_boundary_schema_allows_only_canonical_stage_values() {
        let conn = runtime_schema_test_connection();
        let result = conn.execute(
            "INSERT INTO runtime_runs (
                repository_key,
                repository_full_name,
                issue_number,
                issue_title,
                issue_branch_name,
                queue_order,
                stage
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            rusqlite::params![
                "owner/repo",
                "Owner/Repo",
                123_i64,
                "Invalid stage test",
                "hostlocal/issue-123-invalid-stage-test",
                1_i64,
                "invalid_stage"
            ],
        );

        assert!(
            result.is_err(),
            "invalid canonical stage values should be rejected"
        );
    }

    #[test]
    fn runtime_boundary_schema_allows_only_terminal_metadata_status_values() {
        let conn = runtime_schema_test_connection();
        let result = conn.execute(
            "INSERT INTO runtime_runs (
                repository_key,
                repository_full_name,
                issue_number,
                issue_title,
                issue_branch_name,
                queue_order,
                stage,
                terminal_status
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            rusqlite::params![
                "owner/repo",
                "Owner/Repo",
                124_i64,
                "Invalid terminal test",
                "hostlocal/issue-124-invalid-terminal-test",
                2_i64,
                "queued",
                "unknown_terminal"
            ],
        );

        assert!(
            result.is_err(),
            "invalid terminal metadata values should be rejected"
        );
    }

    #[test]
    fn runtime_boundary_transition_guard_rejects_skips_and_backtracking() {
        let conn = runtime_schema_test_connection();
        let run_id = runtime_insert_test_run(
            &conn,
            "owner/repo",
            "Owner/Repo",
            211,
            "Transition guard test",
            0,
        );

        let skip = transition_run_stage_under_test(&conn, run_id, "queued", "coding");
        assert!(
            skip.is_err(),
            "queued -> coding must be rejected as a skipped transition"
        );

        let accepted = transition_run_stage_under_test(&conn, run_id, "queued", "preparing");
        assert!(accepted.is_ok(), "queued -> preparing should be accepted");

        let backtrack = transition_run_stage_under_test(&conn, run_id, "preparing", "queued");
        assert!(
            backtrack.is_err(),
            "preparing -> queued must be rejected as a backtrack"
        );
    }

    #[test]
    fn runtime_boundary_transition_guard_updates_run_and_transition_log_atomically() {
        let conn = runtime_schema_test_connection();
        let run_id = runtime_insert_test_run(
            &conn,
            "owner/repo",
            "Owner/Repo",
            212,
            "Atomic transition test",
            1,
        );
        assert_eq!(run_stage_value(&conn, run_id), "queued");
        assert_eq!(transition_count(&conn, run_id), 1);

        let result = transition_run_stage_under_test(&conn, run_id, "queued", "preparing");
        assert!(result.is_ok(), "queued -> preparing should succeed");
        assert_eq!(run_stage_value(&conn, run_id), "preparing");
        assert_eq!(transition_count(&conn, run_id), 2);
    }

    #[test]
    fn runtime_boundary_transition_guard_rolls_back_on_expected_stage_mismatch() {
        let conn = runtime_schema_test_connection();
        let run_id = runtime_insert_test_run(
            &conn,
            "owner/repo",
            "Owner/Repo",
            213,
            "Expected-stage mismatch test",
            2,
        );
        assert_eq!(run_stage_value(&conn, run_id), "queued");
        assert_eq!(transition_count(&conn, run_id), 1);

        let mismatch = transition_run_stage_under_test(&conn, run_id, "preparing", "coding");
        assert!(mismatch.is_err(), "mismatched expected stage should fail");
        assert_eq!(
            run_stage_value(&conn, run_id),
            "queued",
            "canonical run stage should remain unchanged after rollback"
        );
        assert_eq!(
            transition_count(&conn, run_id),
            1,
            "transition count should remain unchanged after rollback"
        );
    }

    #[test]
    fn runtime_boundary_persistence_assigns_monotonic_queue_order_per_repository() {
        let conn = runtime_schema_test_connection();
        let first = build_run("owner/repo", 3011, "Queue order first");
        let second = build_run("owner/repo", 3012, "Queue order second");
        let other_repo = build_run("owner/other", 3013, "Queue order other repo");

        let persisted_first = insert_runtime_run(&conn, &first).expect("persist first run");
        let persisted_second = insert_runtime_run(&conn, &second).expect("persist second run");
        let persisted_other = insert_runtime_run(&conn, &other_repo).expect("persist other run");

        assert_eq!(persisted_first.queue_order, 0);
        assert_eq!(persisted_second.queue_order, 1);
        assert_eq!(
            persisted_other.queue_order, 0,
            "queue order should be scoped per repository"
        );
    }

    #[test]
    fn runtime_boundary_terminal_metadata_persists_on_canonical_and_transition_rows() {
        let conn = runtime_schema_test_connection();
        let run = build_run("owner/repo", 4011, "Terminal metadata");
        let persisted = insert_runtime_run(&conn, &run).expect("persist runtime run");

        let finalized = transition_run_stage(
            &conn,
            persisted.run_id,
            RuntimeRunStage::Queued,
            None,
            Some(RuntimeTerminalStatus::Failed),
            Some("runtime_test_failed"),
            Some("Review runtime logs and retry."),
        )
        .expect("finalize runtime run");

        assert_eq!(finalized.terminal_status, Some(RuntimeTerminalStatus::Failed));
        assert_eq!(
            finalized.reason_code.as_deref(),
            Some("runtime_test_failed")
        );
        assert_eq!(
            finalized.fix_hint.as_deref(),
            Some("Review runtime logs and retry.")
        );

        let transition: (String, Option<String>, Option<String>) = conn
            .query_row(
                "SELECT terminal_status, reason_code, fix_hint
                 FROM runtime_run_transitions
                 WHERE run_id = ?1
                 ORDER BY sequence DESC
                 LIMIT 1",
                [persisted.run_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("latest transition");
        assert_eq!(transition.0, "failed");
        assert_eq!(transition.1.as_deref(), Some("runtime_test_failed"));
        assert_eq!(
            transition.2.as_deref(),
            Some("Review runtime logs and retry.")
        );
    }

    #[test]
    fn runtime_boundary_transition_history_can_be_read_newest_first() {
        let conn = runtime_schema_test_connection();
        let run = build_run("owner/repo", 4012, "Transition order");
        let persisted = insert_runtime_run(&conn, &run).expect("persist runtime run");

        transition_run_stage(
            &conn,
            persisted.run_id,
            RuntimeRunStage::Queued,
            Some(RuntimeRunStage::Preparing),
            None,
            None,
            None,
        )
        .expect("queued -> preparing");
        transition_run_stage(
            &conn,
            persisted.run_id,
            RuntimeRunStage::Preparing,
            Some(RuntimeRunStage::Coding),
            None,
            None,
            None,
        )
        .expect("preparing -> coding");
        transition_run_stage(
            &conn,
            persisted.run_id,
            RuntimeRunStage::Coding,
            Some(RuntimeRunStage::Validating),
            None,
            None,
            None,
        )
        .expect("coding -> validating");

        let transitions = load_runtime_run_transitions_newest_first(&conn, persisted.run_id)
            .expect("load transitions newest-first");
        let stages: Vec<String> = transitions
            .into_iter()
            .map(|transition| transition.stage.as_str().to_string())
            .collect();
        assert_eq!(
            stages,
            vec![
                "validating".to_string(),
                "coding".to_string(),
                "preparing".to_string(),
                "queued".to_string(),
            ]
        );
    }

    #[test]
    fn runtime_boundary_persists_runtime_events_with_monotonic_sequence_and_masked_messages() {
        let conn = runtime_schema_test_connection();
        let run = build_run("owner/repo", 4014, "Telemetry persistence");
        let persisted = insert_runtime_run(&conn, &run).expect("persist runtime run");

        let first = insert_runtime_run_event(
            &conn,
            persisted.run_id,
            "milestone",
            "queued",
            "Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz1234567890",
            true,
        )
        .expect("insert first runtime event");
        let second = insert_runtime_run_event(
            &conn,
            persisted.run_id,
            "milestone",
            "coding",
            "coding milestone reached",
            false,
        )
        .expect("insert second runtime event");

        assert_eq!(first.sequence, 1);
        assert_eq!(second.sequence, 2);
        assert!(
            first.message.contains("[REDACTED]"),
            "persisted event message should keep inline redaction markers"
        );
        assert!(
            !first
                .message
                .contains("ghp_abcdefghijklmnopqrstuvwxyz1234567890"),
            "raw secret values must never be stored in telemetry rows"
        );

        let events = load_runtime_run_events_newest_first(&conn, persisted.run_id)
            .expect("load runtime run events newest-first");
        let sequences: Vec<i64> = events.into_iter().map(|event| event.sequence).collect();
        assert_eq!(sequences, vec![2, 1]);
    }

    #[test]
    fn runtime_boundary_runtime_run_telemetry_payload_replay_is_newest_first() {
        let conn = runtime_schema_test_connection();
        let run = build_run("owner/repo", 4015, "Telemetry replay");
        let persisted = insert_runtime_run(&conn, &run).expect("persist runtime run");

        insert_runtime_run_event(
            &conn,
            persisted.run_id,
            "milestone",
            "queued",
            "Issue run queued for execution.",
            true,
        )
        .expect("insert queued telemetry milestone");
        insert_runtime_run_event(
            &conn,
            persisted.run_id,
            "milestone",
            "preparing",
            "Preparing local workspace for issue run.",
            true,
        )
        .expect("insert preparing telemetry milestone");

        let payloads = runtime_run_telemetry_payloads_newest_first(&conn, persisted.run_id)
            .expect("load runtime telemetry payload replay");
        assert_eq!(payloads.len(), 2);
        assert_eq!(payloads[0].sequence, 2);
        assert_eq!(payloads[1].sequence, 1);
        assert_eq!(payloads[0].kind, "milestone");
        assert_eq!(payloads[0].stage, "preparing");
        assert_eq!(payloads[0].repository_key, "owner/repo");
    }

    #[test]
    fn runtime_boundary_issue_telemetry_defaults_to_latest_run_and_applies_limit() {
        let conn = runtime_schema_test_connection();
        let issue_number = 4016;

        let first_run = build_run("owner/repo", issue_number, "Telemetry run one");
        let first_persisted = insert_runtime_run(&conn, &first_run).expect("persist first run");
        insert_runtime_run_event(
            &conn,
            first_persisted.run_id,
            "milestone",
            "queued",
            "first-run event",
            true,
        )
        .expect("insert first run event");

        let second_run = build_run("owner/repo", issue_number, "Telemetry run two");
        let second_persisted = insert_runtime_run(&conn, &second_run).expect("persist second run");
        insert_runtime_run_event(
            &conn,
            second_persisted.run_id,
            "milestone",
            "queued",
            "second-run oldest",
            true,
        )
        .expect("insert second run first event");
        insert_runtime_run_event(
            &conn,
            second_persisted.run_id,
            "milestone",
            "coding",
            "second-run newest",
            true,
        )
        .expect("insert second run second event");

        let telemetry = runtime_get_issue_run_telemetry_inner(
            &conn,
            "owner/repo",
            "Owner/Repo",
            issue_number,
            None,
            Some(1),
        )
        .expect("load issue telemetry");

        assert_eq!(telemetry.repository_key, "owner/repo");
        assert_eq!(telemetry.issue_number, issue_number);
        assert_eq!(telemetry.run_id, second_persisted.run_id);
        assert_eq!(telemetry.events.len(), 1);
        assert_eq!(telemetry.events[0].message, "second-run newest");
        assert_eq!(telemetry.events[0].sequence, 2);
    }

    #[test]
    fn runtime_boundary_issue_telemetry_supports_explicit_run_selection() {
        let conn = runtime_schema_test_connection();
        let issue_number = 4017;

        let first_run = build_run("owner/repo", issue_number, "Telemetry run one");
        let first_persisted = insert_runtime_run(&conn, &first_run).expect("persist first run");
        insert_runtime_run_event(
            &conn,
            first_persisted.run_id,
            "milestone",
            "queued",
            "first-run event",
            true,
        )
        .expect("insert first run event");

        let second_run = build_run("owner/repo", issue_number, "Telemetry run two");
        let second_persisted = insert_runtime_run(&conn, &second_run).expect("persist second run");
        insert_runtime_run_event(
            &conn,
            second_persisted.run_id,
            "milestone",
            "queued",
            "second-run event",
            true,
        )
        .expect("insert second run event");

        let telemetry = runtime_get_issue_run_telemetry_inner(
            &conn,
            "owner/repo",
            "Owner/Repo",
            issue_number,
            Some(first_persisted.run_id),
            Some(10),
        )
        .expect("load issue telemetry");

        assert_eq!(telemetry.run_id, first_persisted.run_id);
        assert_eq!(telemetry.events.len(), 1);
        assert_eq!(telemetry.events[0].message, "first-run event");
    }

    #[test]
    fn runtime_boundary_issue_telemetry_rejects_invalid_request_with_actionable_text() {
        let invalid_repository = runtime_get_issue_run_telemetry(
            Path::new("/tmp/hostlocal-test.db"),
            RuntimeIssueRunTelemetryRequest {
                repository_full_name: "invalid".to_string(),
                issue_number: 4018,
                run_id: None,
                limit: None,
            },
        )
        .expect_err("invalid repository should be rejected");
        assert_eq!(
            invalid_repository,
            "Select a valid repository issue before loading runtime telemetry."
        );

        let invalid_issue = runtime_get_issue_run_telemetry(
            Path::new("/tmp/hostlocal-test.db"),
            RuntimeIssueRunTelemetryRequest {
                repository_full_name: "Owner/Repo".to_string(),
                issue_number: 0,
                run_id: None,
                limit: None,
            },
        )
        .expect_err("invalid issue should be rejected");
        assert_eq!(
            invalid_issue,
            "Select a valid repository issue before loading runtime telemetry."
        );
    }

    #[test]
    fn runtime_boundary_issue_summary_includes_completion_and_summary_actions() {
        let conn = runtime_schema_test_connection();
        let issue_number = 4019;
        let run = build_run("owner/repo", issue_number, "Summary contract");
        let persisted = insert_runtime_run(&conn, &run).expect("persist run");

        transition_run_stage(
            &conn,
            persisted.run_id,
            RuntimeRunStage::Queued,
            Some(RuntimeRunStage::Preparing),
            None,
            None,
            None,
        )
        .expect("queued -> preparing");
        transition_run_stage(
            &conn,
            persisted.run_id,
            RuntimeRunStage::Preparing,
            Some(RuntimeRunStage::Coding),
            None,
            None,
            None,
        )
        .expect("preparing -> coding");
        transition_run_stage(
            &conn,
            persisted.run_id,
            RuntimeRunStage::Coding,
            Some(RuntimeRunStage::Validating),
            None,
            None,
            None,
        )
        .expect("coding -> validating");
        transition_run_stage(
            &conn,
            persisted.run_id,
            RuntimeRunStage::Validating,
            Some(RuntimeRunStage::Publishing),
            None,
            None,
            None,
        )
        .expect("validating -> publishing");
        transition_run_stage(
            &conn,
            persisted.run_id,
            RuntimeRunStage::Publishing,
            None,
            Some(RuntimeTerminalStatus::Success),
            None,
            None,
        )
        .expect("publishing -> success");

        insert_runtime_run_event(
            &conn,
            persisted.run_id,
            "milestone",
            "queued",
            "queued action",
            true,
        )
        .expect("insert queued action");
        insert_runtime_run_event(
            &conn,
            persisted.run_id,
            "worker",
            "coding",
            "internal worker detail",
            false,
        )
        .expect("insert worker detail");
        insert_runtime_run_event(
            &conn,
            persisted.run_id,
            "milestone",
            "publishing",
            "published action",
            true,
        )
        .expect("insert published action");

        let summary = runtime_get_issue_run_summary_inner(
            &conn,
            "owner/repo",
            "Owner/Repo",
            issue_number,
            None,
        )
        .expect("load issue summary");

        assert_eq!(summary.run_id, persisted.run_id);
        assert_eq!(summary.completion.status, "success");
        assert!(summary.completion.terminal_at.is_some());
        assert_eq!(summary.key_actions.len(), 2);
        assert_eq!(summary.key_actions[0].message, "published action");
        assert_eq!(summary.key_actions[1].message, "queued action");
    }

    #[test]
    fn runtime_boundary_issue_summary_validation_defaults_to_not_run_without_validation_events() {
        let conn = runtime_schema_test_connection();
        let issue_number = 4020;
        let run = build_run("owner/repo", issue_number, "Validation not run");
        let persisted = insert_runtime_run(&conn, &run).expect("persist run");

        transition_run_stage(
            &conn,
            persisted.run_id,
            RuntimeRunStage::Queued,
            None,
            Some(RuntimeTerminalStatus::Failed),
            Some("runtime_failed"),
            Some("retry"),
        )
        .expect("queued -> failed");

        insert_runtime_run_event(
            &conn,
            persisted.run_id,
            "milestone",
            "queued",
            "queued action",
            true,
        )
        .expect("insert queued action");

        let summary = runtime_get_issue_run_summary_inner(
            &conn,
            "owner/repo",
            "Owner/Repo",
            issue_number,
            None,
        )
        .expect("load issue summary");
        assert_eq!(summary.validation_outcomes.code, "not-run");
        assert_eq!(summary.validation_outcomes.browser, "not-run");
    }

    #[test]
    fn runtime_boundary_issue_summary_uses_not_found_fallback_when_validation_target_missing() {
        let conn = runtime_schema_test_connection();
        let issue_number = 4021;
        let run = build_run("owner/repo", issue_number, "Validation fallback");
        let persisted = insert_runtime_run(&conn, &run).expect("persist run");

        transition_run_stage(
            &conn,
            persisted.run_id,
            RuntimeRunStage::Queued,
            Some(RuntimeRunStage::Preparing),
            None,
            None,
            None,
        )
        .expect("queued -> preparing");
        transition_run_stage(
            &conn,
            persisted.run_id,
            RuntimeRunStage::Preparing,
            Some(RuntimeRunStage::Coding),
            None,
            None,
            None,
        )
        .expect("preparing -> coding");
        transition_run_stage(
            &conn,
            persisted.run_id,
            RuntimeRunStage::Coding,
            Some(RuntimeRunStage::Validating),
            None,
            None,
            None,
        )
        .expect("coding -> validating");
        transition_run_stage(
            &conn,
            persisted.run_id,
            RuntimeRunStage::Validating,
            Some(RuntimeRunStage::Publishing),
            None,
            None,
            None,
        )
        .expect("validating -> publishing");
        transition_run_stage(
            &conn,
            persisted.run_id,
            RuntimeRunStage::Publishing,
            None,
            Some(RuntimeTerminalStatus::Success),
            None,
            None,
        )
        .expect("publishing -> success");

        insert_runtime_run_event(
            &conn,
            persisted.run_id,
            "milestone",
            "validating",
            "validation phase started",
            true,
        )
        .expect("insert validation milestone");
        insert_runtime_run_event(
            &conn,
            persisted.run_id,
            "validation",
            "code-pass",
            "code validation: pass",
            true,
        )
        .expect("insert code validation result");

        let summary = runtime_get_issue_run_summary_inner(
            &conn,
            "owner/repo",
            "Owner/Repo",
            issue_number,
            None,
        )
        .expect("load issue summary");

        assert_eq!(summary.validation_outcomes.code, "pass");
        assert_eq!(summary.validation_outcomes.browser, "not-found");
    }

    #[test]
    fn runtime_boundary_issue_telemetry_enforces_newest_first_limit_for_selected_run() {
        let conn = runtime_schema_test_connection();
        let issue_number = 4022;
        let run = build_run("owner/repo", issue_number, "Telemetry ordering");
        let persisted = insert_runtime_run(&conn, &run).expect("persist run");

        insert_runtime_run_event(
            &conn,
            persisted.run_id,
            "milestone",
            "queued",
            "first",
            true,
        )
        .expect("insert first");
        insert_runtime_run_event(
            &conn,
            persisted.run_id,
            "milestone",
            "preparing",
            "second",
            true,
        )
        .expect("insert second");
        insert_runtime_run_event(
            &conn,
            persisted.run_id,
            "milestone",
            "coding",
            "third",
            true,
        )
        .expect("insert third");

        let telemetry = runtime_get_issue_run_telemetry_inner(
            &conn,
            "owner/repo",
            "Owner/Repo",
            issue_number,
            Some(persisted.run_id),
            Some(2),
        )
        .expect("load telemetry");

        assert_eq!(telemetry.events.len(), 2);
        assert_eq!(telemetry.events[0].message, "third");
        assert_eq!(telemetry.events[1].message, "second");
    }

    #[test]
    fn runtime_boundary_issue_telemetry_redacts_legacy_unsanitized_rows_on_read() {
        let conn = runtime_schema_test_connection();
        let issue_number = 4023;
        let run = build_run("owner/repo", issue_number, "Legacy telemetry sanitization");
        let persisted = insert_runtime_run(&conn, &run).expect("persist run");

        conn.execute(
            "INSERT INTO runtime_run_events (
                run_id,
                sequence,
                kind,
                stage,
                message,
                redaction_reasons,
                include_in_summary
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            rusqlite::params![
                persisted.run_id,
                1_i64,
                "milestone",
                "queued",
                "Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz1234567890",
                "[]",
                1_i64
            ],
        )
        .expect("insert legacy unsanitized event");

        let telemetry = runtime_get_issue_run_telemetry_inner(
            &conn,
            "owner/repo",
            "Owner/Repo",
            issue_number,
            Some(persisted.run_id),
            Some(10),
        )
        .expect("load telemetry");
        assert_eq!(telemetry.events.len(), 1);
        assert!(
            !telemetry.events[0]
                .message
                .contains("ghp_abcdefghijklmnopqrstuvwxyz1234567890"),
            "telemetry payload should not expose raw secret fragments from legacy rows"
        );
        assert!(
            telemetry.events[0].message.contains("[REDACTED]"),
            "telemetry payload should preserve masked marker after read sanitization"
        );
    }

    #[test]
    fn runtime_boundary_issue_summary_redacts_legacy_unsanitized_key_actions() {
        let conn = runtime_schema_test_connection();
        let issue_number = 4024;
        let run = build_run("owner/repo", issue_number, "Legacy summary sanitization");
        let persisted = insert_runtime_run(&conn, &run).expect("persist run");

        conn.execute(
            "INSERT INTO runtime_run_events (
                run_id,
                sequence,
                kind,
                stage,
                message,
                redaction_reasons,
                include_in_summary
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            rusqlite::params![
                persisted.run_id,
                1_i64,
                "milestone",
                "queued",
                "api_key=raw-secret-value",
                "[]",
                1_i64
            ],
        )
        .expect("insert legacy unsanitized summary action");

        let summary = runtime_get_issue_run_summary_inner(
            &conn,
            "owner/repo",
            "Owner/Repo",
            issue_number,
            Some(persisted.run_id),
        )
        .expect("load summary");

        assert_eq!(summary.key_actions.len(), 1);
        assert!(
            !summary.key_actions[0]
                .message
                .contains("api_key=raw-secret-value"),
            "summary key actions should not expose raw secret fragments from legacy rows"
        );
        assert!(
            summary.key_actions[0].message.contains("[REDACTED]"),
            "summary key actions should preserve masked marker after read sanitization"
        );
    }

    #[test]
    fn runtime_boundary_milestone_templates_cover_lifecycle_checkpoints() {
        let checkpoints = [
            (
                RuntimeTelemetryMilestone::Queue,
                "Issue run queued for execution.",
            ),
            (
                RuntimeTelemetryMilestone::Start,
                "Run started from repository queue.",
            ),
            (
                RuntimeTelemetryMilestone::Preparing,
                "Preparing local workspace for issue run.",
            ),
            (
                RuntimeTelemetryMilestone::Coding,
                "Coding milestone started in worker runtime.",
            ),
            (
                RuntimeTelemetryMilestone::Validating,
                "Validation milestone started for runtime outputs.",
            ),
            (
                RuntimeTelemetryMilestone::Publishing,
                "Publishing milestone started for runtime outputs.",
            ),
            (
                RuntimeTelemetryMilestone::Finalization,
                "Run finalized with terminal status: success.",
            ),
        ];

        for (milestone, expected_message) in checkpoints {
            let detail = runtime_milestone_detail(milestone, Some("success"));
            assert_eq!(detail.kind, "milestone");
            assert_eq!(detail.message, expected_message);
            assert!(detail.include_in_summary);
        }
    }

    #[test]
    fn runtime_boundary_terminal_history_retains_newest_twenty_per_issue() {
        let conn = runtime_schema_test_connection();
        let active_run = build_run("owner/repo", 4013, "Still active");
        let _ = insert_runtime_run(&conn, &active_run).expect("persist active run");

        for index in 0..25_i64 {
            let run = build_run("owner/repo", 4013, &format!("Terminal run {index}"));
            let persisted = insert_runtime_run(&conn, &run).expect("persist terminal run");
            let reason_code = format!("runtime_failure_{index:02}");
            let fix_hint = format!("Fix hint {index:02}");
            transition_run_stage(
                &conn,
                persisted.run_id,
                RuntimeRunStage::Queued,
                None,
                Some(RuntimeTerminalStatus::Failed),
                Some(reason_code.as_str()),
                Some(fix_hint.as_str()),
            )
            .expect("finalize run");
        }

        let terminal_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM runtime_runs
                 WHERE repository_key = ?1
                   AND issue_number = ?2
                   AND terminal_status IS NOT NULL",
                rusqlite::params!["owner/repo", 4013_i64],
                |row| row.get(0),
            )
            .expect("count terminal runs");
        let non_terminal_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM runtime_runs
                 WHERE repository_key = ?1
                   AND issue_number = ?2
                   AND terminal_status IS NULL",
                rusqlite::params!["owner/repo", 4013_i64],
                |row| row.get(0),
            )
            .expect("count non-terminal runs");

        assert_eq!(
            terminal_count, 20,
            "retention should keep only the latest 20 terminal runs"
        );
        assert_eq!(
            non_terminal_count, 1,
            "retention should not delete active/queued rows"
        );
    }

    #[test]
    fn runtime_boundary_reconcile_startup_finalizes_unrecoverable_inflight_runs() {
        let conn = runtime_schema_test_connection();
        let inflight_run_id =
            runtime_insert_test_run(&conn, "owner/repo", "Owner/Repo", 4101, "Inflight run", 0);
        transition_run_stage(
            &conn,
            inflight_run_id,
            RuntimeRunStage::Queued,
            Some(RuntimeRunStage::Preparing),
            None,
            None,
            None,
        )
        .expect("queued -> preparing");
        transition_run_stage(
            &conn,
            inflight_run_id,
            RuntimeRunStage::Preparing,
            Some(RuntimeRunStage::Coding),
            None,
            None,
            None,
        )
        .expect("preparing -> coding");

        let queued_run_id =
            runtime_insert_test_run(&conn, "owner/repo", "Owner/Repo", 4102, "Queued run", 1);

        let restored_runs = reconcile_runtime_state_on_startup_inner(&conn)
            .expect("reconcile startup")
            .recoverable_runs;
        assert_eq!(
            restored_runs
                .iter()
                .map(|run| run.issue_number)
                .collect::<Vec<_>>(),
            vec![4102],
            "only queued runs should remain recoverable after startup reconciliation"
        );

        let inflight_terminal: (Option<String>, Option<String>, Option<String>) = conn
            .query_row(
                "SELECT terminal_status, reason_code, fix_hint
                 FROM runtime_runs
                 WHERE run_id = ?1",
                [inflight_run_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("load reconciled inflight run");
        assert_eq!(inflight_terminal.0.as_deref(), Some("failed"));
        assert_eq!(
            inflight_terminal.1.as_deref(),
            Some(RUNTIME_RECOVERY_REASON_CODE)
        );
        assert_eq!(
            inflight_terminal.2.as_deref(),
            Some(RUNTIME_RECOVERY_FIX_HINT)
        );

        let queued_terminal: Option<String> = conn
            .query_row(
                "SELECT terminal_status FROM runtime_runs WHERE run_id = ?1",
                [queued_run_id],
                |row| row.get(0),
            )
            .expect("queued run terminal status");
        assert_eq!(
            queued_terminal, None,
            "queued runs should remain non-terminal after reconciliation"
        );
    }

    #[test]
    fn runtime_boundary_reconcile_startup_restores_queued_runs_in_fifo_order() {
        let conn = runtime_schema_test_connection();
        runtime_insert_test_run(&conn, "beta/repo", "Beta/Repo", 4202, "Beta second", 1);
        runtime_insert_test_run(&conn, "alpha/repo", "Alpha/Repo", 4201, "Alpha first", 0);
        runtime_insert_test_run(&conn, "beta/repo", "Beta/Repo", 4200, "Beta first", 0);
        runtime_insert_test_run(&conn, "alpha/repo", "Alpha/Repo", 4203, "Alpha second", 1);

        let restored_runs = reconcile_runtime_state_on_startup_inner(&conn)
            .expect("reconcile startup")
            .recoverable_runs;
        let restored_identity: Vec<(String, i64)> = restored_runs
            .into_iter()
            .map(|run| (run.repository_key, run.issue_number))
            .collect();

        assert_eq!(
            restored_identity,
            vec![
                ("alpha/repo".to_string(), 4201),
                ("alpha/repo".to_string(), 4203),
                ("beta/repo".to_string(), 4200),
                ("beta/repo".to_string(), 4202),
            ],
            "startup reconciliation should restore queued runs by repository and queue_order FIFO"
        );
    }

    #[test]
    fn runtime_boundary_snapshot_exposes_stage_queue_position_and_terminal_metadata() {
        let conn = runtime_schema_test_connection();

        let active_run = build_run("owner/repo", 4301, "Active");
        let active_persisted = insert_runtime_run(&conn, &active_run).expect("persist active run");
        transition_run_stage(
            &conn,
            active_persisted.run_id,
            RuntimeRunStage::Queued,
            Some(RuntimeRunStage::Preparing),
            None,
            None,
            None,
        )
        .expect("queued -> preparing");
        transition_run_stage(
            &conn,
            active_persisted.run_id,
            RuntimeRunStage::Preparing,
            Some(RuntimeRunStage::Coding),
            None,
            None,
            None,
        )
        .expect("preparing -> coding");

        let queued_run = build_run("owner/repo", 4302, "Queued");
        let queued_persisted = insert_runtime_run(&conn, &queued_run).expect("persist queued run");
        conn.execute(
            "UPDATE runtime_runs
             SET is_paused = 1,
                 paused_at = '2026-03-03T12:00:00Z'
             WHERE run_id = ?1",
            [queued_persisted.run_id],
        )
        .expect("mark queued run paused");

        let terminal_run = build_run("owner/repo", 4303, "Terminal");
        let terminal_persisted =
            insert_runtime_run(&conn, &terminal_run).expect("persist terminal run");
        transition_run_stage(
            &conn,
            terminal_persisted.run_id,
            RuntimeRunStage::Queued,
            None,
            Some(RuntimeTerminalStatus::Failed),
            Some("runtime_snapshot_failed"),
            Some("Retry after resolving the startup issue."),
        )
        .expect("finalize terminal run");

        let snapshot = runtime_get_repository_run_snapshot_inner(&conn, "owner/repo", "Owner/Repo")
            .expect("load snapshot");
        assert_eq!(snapshot.repository_key, "owner/repo");
        assert_eq!(snapshot.runs.len(), 3);

        let by_issue: HashMap<i64, RuntimeRepositoryRunSnapshotItem> = snapshot
            .runs
            .into_iter()
            .map(|item| (item.issue_number, item))
            .collect();

        let active = by_issue.get(&4301).expect("active issue entry");
        assert_eq!(active.stage, "coding");
        assert_eq!(active.queue_position, None);
        assert_eq!(active.terminal_status, None);

        let queued = by_issue.get(&4302).expect("queued issue entry");
        assert_eq!(queued.stage, "queued");
        assert_eq!(queued.queue_position, Some(1));
        assert!(queued.is_paused);
        assert_eq!(queued.paused_at.as_deref(), Some("2026-03-03T12:00:00Z"));
        assert_eq!(queued.terminal_status, None);

        let terminal = by_issue.get(&4303).expect("terminal issue entry");
        assert_eq!(terminal.terminal_status.as_deref(), Some("failed"));
        assert_eq!(
            terminal.reason_code.as_deref(),
            Some("runtime_snapshot_failed")
        );
        assert_eq!(
            terminal.fix_hint.as_deref(),
            Some("Retry after resolving the startup issue.")
        );
    }

    #[test]
    fn runtime_boundary_issue_history_is_newest_first_and_bounded_to_twenty() {
        let conn = runtime_schema_test_connection();

        for index in 0..25_i64 {
            let run = build_run("owner/repo", 4401, &format!("History run {index}"));
            let persisted = insert_runtime_run(&conn, &run).expect("persist runtime run");
            let reason_code = format!("runtime_history_failure_{index:02}");
            let fix_hint = format!("History fix hint {index:02}");
            transition_run_stage(
                &conn,
                persisted.run_id,
                RuntimeRunStage::Queued,
                None,
                Some(RuntimeTerminalStatus::Failed),
                Some(reason_code.as_str()),
                Some(fix_hint.as_str()),
            )
            .expect("finalize runtime run");
        }

        let history = runtime_get_issue_run_history_inner(&conn, "owner/repo", "Owner/Repo", 4401)
            .expect("load history");
        assert_eq!(history.runs.len(), 20);
        assert_eq!(
            history.runs[0].reason_code.as_deref(),
            Some("runtime_history_failure_24")
        );
        assert_eq!(
            history.runs[19].reason_code.as_deref(),
            Some("runtime_history_failure_05")
        );
        assert!(
            history
                .runs
                .iter()
                .all(|run| run.issue_number == 4401),
            "history should only include rows for the selected issue"
        );

        let newest_run = history.runs.first().expect("newest history run");
        assert!(
            !newest_run.transitions.is_empty(),
            "history entry should include transition timeline"
        );
        assert_eq!(
            newest_run.transitions[0].terminal_status.as_deref(),
            Some("failed")
        );
    }

    #[test]
    fn runtime_boundary_issue_history_exposes_paused_state_metadata() {
        let conn = runtime_schema_test_connection();
        let run = build_run("owner/repo", 4402, "Paused history");
        let persisted = insert_runtime_run(&conn, &run).expect("persist runtime run");
        conn.execute(
            "UPDATE runtime_runs
             SET is_paused = 1,
                 paused_at = '2026-03-03T12:15:00Z'
             WHERE run_id = ?1",
            [persisted.run_id],
        )
        .expect("mark persisted run paused");

        let history = runtime_get_issue_run_history_inner(&conn, "owner/repo", "Owner/Repo", 4402)
            .expect("load history");
        assert_eq!(history.runs.len(), 1);
        assert!(history.runs[0].is_paused);
        assert_eq!(
            history.runs[0].paused_at.as_deref(),
            Some("2026-03-03T12:15:00Z")
        );
    }

    #[test]
    fn runtime_boundary_stage_event_payload_includes_repository_stage_and_queue_position() {
        let conn = runtime_schema_test_connection();
        let first = build_run("owner/repo", 4501, "First queued");
        let second = build_run("owner/repo", 4502, "Second queued");

        let _first_persisted = insert_runtime_run(&conn, &first).expect("persist first run");
        let second_persisted = insert_runtime_run(&conn, &second).expect("persist second run");
        conn.execute(
            "UPDATE runtime_runs
             SET is_paused = 1,
                 paused_at = '2026-03-03T12:30:00Z'
             WHERE run_id = ?1",
            [second_persisted.run_id],
        )
        .expect("mark second run paused");

        let payload = runtime_stage_changed_event_payload_inner(&conn, second_persisted.run_id)
            .expect("build stage event payload");
        assert_eq!(payload.repository_key, "owner/repo");
        assert_eq!(payload.issue_number, 4502);
        assert_eq!(payload.stage, "queued");
        assert_eq!(payload.queue_position, Some(2));
        assert!(payload.is_paused);
        assert_eq!(payload.paused_at.as_deref(), Some("2026-03-03T12:30:00Z"));
    }

    #[test]
    fn runtime_boundary_stage_event_payload_preserves_terminal_reason_and_fix_hint() {
        let conn = runtime_schema_test_connection();
        let run = build_run("owner/repo", 4503, "Terminal payload");
        let persisted = insert_runtime_run(&conn, &run).expect("persist run");
        transition_run_stage(
            &conn,
            persisted.run_id,
            RuntimeRunStage::Queued,
            None,
            Some(RuntimeTerminalStatus::Failed),
            Some("runtime_event_terminal_failed"),
            Some("Resolve failure and retry."),
        )
        .expect("finalize run");

        let payload = runtime_stage_changed_event_payload_inner(&conn, persisted.run_id)
            .expect("build stage event payload");
        assert_eq!(payload.terminal_status.as_deref(), Some("failed"));
        assert_eq!(
            payload.reason_code.as_deref(),
            Some("runtime_event_terminal_failed")
        );
        assert_eq!(
            payload.fix_hint.as_deref(),
            Some("Resolve failure and retry.")
        );
    }

    #[test]
    fn runtime_boundary_redacts_sensitive_telemetry_fragments() {
        let raw = "Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz1234567890 \
COOKIE: sessionid=sensitive-session-value \
GITHUB_TOKEN=ghs_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890 \
https://example.com/callback?access_token=my-token-value";
        let result = redact_sensitive_text(raw);

        assert!(
            !result.masked_text.contains("ghp_abcdefghijklmnopqrstuvwxyz1234567890"),
            "authorization bearer value should never survive redaction"
        );
        assert!(
            !result.masked_text.contains("sessionid=sensitive-session-value"),
            "cookie/session fragment should never survive redaction"
        );
        assert!(
            !result
                .masked_text
                .contains("ghs_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890"),
            "credential-like env assignment should be redacted"
        );
        assert!(
            !result.masked_text.contains("access_token=my-token-value"),
            "sensitive query parameters should be redacted"
        );
        assert!(
            result.masked_text.contains("[REDACTED]"),
            "sanitized output should contain inline redaction markers"
        );
    }

    #[test]
    fn runtime_boundary_redaction_returns_structured_reason_metadata() {
        let raw = "Authorization: Bearer github_pat_1234567890abcdefghijklmnopqrstuvwxyz";
        let result = redact_sensitive_text(raw);

        assert!(
            result
                .reasons
                .iter()
                .any(|reason| reason.reason_code == "authorization_header"),
            "redaction metadata should identify matched reason categories"
        );
        assert!(
            result.total_redactions >= 1,
            "metadata should track non-zero redaction counts"
        );
    }

    #[test]
    fn runtime_boundary_redacts_uncertain_but_risky_fragments() {
        let risky = "job output token candidate: A1B2C3D4E5F6G7H8J9K0L1M2N3P4Q5R6";
        let result = redact_sensitive_text(risky);

        assert!(
            !result
                .masked_text
                .contains("A1B2C3D4E5F6G7H8J9K0L1M2N3P4Q5R6"),
            "high-risk fragment should be conservatively redacted"
        );
        assert!(
            result
                .reasons
                .iter()
                .any(|reason| reason.reason_code == "risky_fragment"),
            "metadata should explain conservative risky-fragment masking"
        );
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

        assert!(state.dequeue_queued_run("owner/repo", 202).is_some());
        assert!(state.dequeue_queued_run("owner/repo", 201).is_none());

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

    #[test]
    fn runtime_boundary_enqueue_command_outcomes_started_then_queued() {
        let state = RuntimeBoundarySharedState::default();
        let first = runtime_enqueue_issue_run_inner(
            &state,
            RuntimeEnqueueIssueRunRequest {
                repository_full_name: "Owner/Repo".to_string(),
                issue_number: 301,
                issue_title: "First queued candidate".to_string(),
            },
        )
        .expect("first enqueue");
        assert_eq!(first.status, "started");
        assert_eq!(first.queue_position, None);

        let second = runtime_enqueue_issue_run_inner(
            &state,
            RuntimeEnqueueIssueRunRequest {
                repository_full_name: "owner/repo".to_string(),
                issue_number: 302,
                issue_title: "Second queued candidate".to_string(),
            },
        )
        .expect("second enqueue");
        assert_eq!(second.status, "queued");
        assert_eq!(second.queue_position, Some(1));
    }

    #[test]
    fn runtime_boundary_dequeue_command_reports_removed_for_queued_issue() {
        let state = RuntimeBoundarySharedState::default();
        runtime_enqueue_issue_run_inner(
            &state,
            RuntimeEnqueueIssueRunRequest {
                repository_full_name: "owner/repo".to_string(),
                issue_number: 401,
                issue_title: "Active issue".to_string(),
            },
        )
        .expect("enqueue active");
        runtime_enqueue_issue_run_inner(
            &state,
            RuntimeEnqueueIssueRunRequest {
                repository_full_name: "owner/repo".to_string(),
                issue_number: 402,
                issue_title: "Queued issue".to_string(),
            },
        )
        .expect("enqueue queued");

        let outcome = runtime_dequeue_issue_run_inner(
            &state,
            RuntimeDequeueIssueRunRequest {
                repository_full_name: "owner/repo".to_string(),
                issue_number: 402,
            },
        )
        .expect("dequeue queued issue");
        assert_eq!(outcome.status, "removed");
        assert_eq!(outcome.reason_code, None);
        assert_eq!(outcome.fix_hint, None);
    }

    #[test]
    fn runtime_boundary_dequeue_command_reports_not_found_with_reason_hint() {
        let state = RuntimeBoundarySharedState::default();
        runtime_enqueue_issue_run_inner(
            &state,
            RuntimeEnqueueIssueRunRequest {
                repository_full_name: "owner/repo".to_string(),
                issue_number: 501,
                issue_title: "Active issue".to_string(),
            },
        )
        .expect("enqueue active");

        let outcome = runtime_dequeue_issue_run_inner(
            &state,
            RuntimeDequeueIssueRunRequest {
                repository_full_name: "owner/repo".to_string(),
                issue_number: 999,
            },
        )
        .expect("dequeue missing issue");
        assert_eq!(outcome.status, "not_found");
        assert_eq!(
            outcome.reason_code.as_deref(),
            Some("queued_run_not_found")
        );
        assert_eq!(
            outcome.fix_hint.as_deref(),
            Some("Issue run was not queued for this repository.")
        );
    }

    #[test]
    fn runtime_boundary_rejects_path_traversal_repository_segments() {
        let cases = [
            "../repo",
            "owner/..",
            "owner/repo/../../extra",
            "owner/repo;rm",
        ];

        for input in cases {
            assert_eq!(
                normalize_repository_key(input),
                None,
                "expected guardrail rejection for unsafe repository input: {input}"
            );
        }
    }

    #[test]
    fn runtime_boundary_guardrail_outcome_reports_rule_and_target_without_raw_values() {
        let block = GuardrailBlock::new("workspace_boundary", "path");
        let outcome = RuntimeQueueOutcome::blocked(&block);

        assert_eq!(outcome.status, "blocked");
        assert_eq!(
            outcome.reason_code.as_deref(),
            Some("runtime_guardrail_workspace_boundary_path")
        );
        assert_eq!(
            outcome.fix_hint.as_deref(),
            Some("Blocked path target because it violated workspace_boundary rule.")
        );
        assert!(outcome
            .fix_hint
            .as_deref()
            .is_some_and(|hint| !hint.contains("/private/")));
    }

    #[test]
    fn runtime_boundary_ensure_within_workspace_blocks_out_of_boundary_paths() {
        let workspace = tempdir().expect("workspace tempdir");
        let nested = workspace.path().join("repo");
        std::fs::create_dir_all(&nested).expect("create nested path");
        assert!(ensure_within_workspace(workspace.path(), &nested).is_ok());

        let outside = tempdir().expect("outside tempdir");
        let outside_target = outside.path().join("escape");
        std::fs::create_dir_all(&outside_target).expect("create outside path");
        let block = ensure_within_workspace(workspace.path(), &outside_target)
            .expect_err("outside path should be blocked");
        assert_eq!(block.rule(), "workspace_boundary");
        assert_eq!(block.target_type(), "path");
    }

    #[test]
    fn runtime_boundary_records_minimal_terminal_evidence_payload() {
        let run = build_run("owner/repo", 701, "Capture run evidence");
        let evidence_path = record_terminal_evidence(
            &run,
            RuntimeTerminalStatus::GuardrailBlocked,
            Some("runtime_guardrail_workspace_boundary_path".to_string()),
        )
        .expect("evidence file path");

        let raw = std::fs::read_to_string(&evidence_path).expect("read evidence file");
        let payload: serde_json::Value = serde_json::from_str(&raw).expect("decode evidence");
        assert_eq!(payload["repositoryKey"], "owner/repo");
        assert_eq!(payload["issueNumber"], 701);
        assert_eq!(payload["branch"], "hostlocal/issue-701-capture-run-evidence");
        assert_eq!(payload["terminalStatus"], "guardrail_blocked");
        assert_eq!(
            payload["blockedReasonCode"],
            "runtime_guardrail_workspace_boundary_path"
        );
    }

    #[test]
    fn runtime_boundary_finalize_workspace_cleanup_removes_directory_tree() {
        let workspace = tempdir().expect("workspace tempdir");
        let file_path = workspace.path().join("artifact.txt");
        std::fs::write(&file_path, "temp artifact").expect("write temp artifact");
        assert!(workspace.path().exists());

        let removed = finalize_workspace_cleanup(Some(workspace.path()));
        assert!(removed, "cleanup should report attempted removal");
        assert!(
            !workspace.path().exists(),
            "workspace directory should be removed by terminal finalizer"
        );
    }
}
