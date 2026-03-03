use crate::db::{with_connection, DbPath};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_shell::{process::CommandEvent, ShellExt};
use tempfile::TempDir;

const BRANCH_PREFIX: &str = "hostlocal";
const SIDECAR_ALIAS: &str = "hostlocal-worker";
const WORKSPACE_REPO_DIR: &str = "repo";
const RUNTIME_EVIDENCE_DIR: &str = "hostlocal-runtime-evidence";

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
) -> Result<RuntimePersistedRun, String> {
    with_connection(db_path, |conn| {
        let run_id = resolve_runtime_run_id(conn, run).map_err(runtime_invariant_error)?;
        let mut current = load_runtime_run_by_id(conn, run_id)?;
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
        }

        Ok(current)
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
        let _ = persist_advance_runtime_run_to_publishing(&db_path.0, &run);
    }
    if persist_finalize_runtime_run(
        &db_path.0,
        &run,
        terminal_status,
        reason_code.as_deref(),
        fix_hint.as_deref(),
    )
    .is_err()
    {
        let _ = record_terminal_evidence(&run, terminal_status, reason_code);
        let _ = finalize_workspace_cleanup(workspace_root.as_deref());
        return;
    }

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
                    terminal_status = if payload.code == Some(0) {
                        RuntimeTerminalStatus::Success
                    } else {
                        RuntimeTerminalStatus::Failed
                    };
                    break;
                }
                CommandEvent::Error(_) => {
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
    let db_path = app.state::<DbPath>();
    persist_transition_runtime_run_stage(
        &db_path.0,
        &run,
        RuntimeRunStage::Queued,
        RuntimeRunStage::Preparing,
    )
    .map_err(|_| StartRunError::with_outcome(runtime_transition_failed_outcome(), None))?;

    let prepared = prepare_workspace_for_run(&run)?;
    persist_transition_runtime_run_stage(
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

    let outcome = {
        let mut queue = match state.lock() {
            Ok(queue) => queue,
            Err(error) => {
                let _ = persist_finalize_runtime_run(
                    &db_path.0,
                    &run,
                    RuntimeTerminalStatus::Failed,
                    Some("runtime_queue_state_unavailable"),
                    Some("Retry enqueue after restarting HostLocal."),
                );
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
    let _ = persist_finalize_runtime_run(
        &db_path.0,
        &removed_run,
        RuntimeTerminalStatus::Cancelled,
        Some("runtime_queue_removed"),
        Some("Issue run was removed from queue before execution."),
    )?;

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
