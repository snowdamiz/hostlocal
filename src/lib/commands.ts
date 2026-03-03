import { invoke } from "@tauri-apps/api/core";

export interface GithubUser {
  login: string;
  avatarUrl: string;
  htmlUrl: string;
}

export interface GithubRepository {
  id: number;
  name: string;
  fullName: string;
  htmlUrl: string;
  isPrivate: boolean;
  description: string | null;
}

export interface GithubRepositoryItem {
  id: number;
  number: number;
  title: string;
  htmlUrl: string;
  state: "open" | "closed";
  isPullRequest: boolean;
  draft: boolean;
  labels: string[];
  assignees: string[];
  authorLogin: string | null;
  body: string | null;
  updatedAt: string;
}

export interface GithubIssueIntakeRequest {
  repositoryFullName: string;
  issueNumber: number;
  agentLabel: string;
}

export interface GithubIssueIntakeOutcome {
  accepted: boolean;
  reasonCode: string | null;
  fixHint: string | null;
}

export interface RuntimeEnqueueIssueRunRequest {
  repositoryFullName: string;
  issueNumber: number;
  issueTitle: string;
}

export interface RuntimeDequeueIssueRunRequest {
  repositoryFullName: string;
  issueNumber: number;
}

export interface RuntimeControlIssueRunRequest {
  repositoryFullName: string;
  issueNumber: number;
}

export interface RuntimeAbortIssueRunRequest {
  repositoryFullName: string;
  issueNumber: number;
  reason?: string | null;
}

export interface RuntimeSteerIssueRunRequest {
  repositoryFullName: string;
  issueNumber: number;
  instruction: string;
}

export type RuntimeEnqueueIssueRunStatus =
  | "started"
  | "queued"
  | "blocked"
  | "startup_failed"
  | "not_found";

export type RuntimeDequeueIssueRunStatus = "removed" | "not_found";

export interface RuntimeEnqueueIssueRunOutcome {
  status: RuntimeEnqueueIssueRunStatus;
  queuePosition: number | null;
  reasonCode: string | null;
  fixHint: string | null;
}

export interface RuntimeDequeueIssueRunOutcome {
  status: RuntimeDequeueIssueRunStatus;
  queuePosition: number | null;
  reasonCode: string | null;
  fixHint: string | null;
}

export interface RuntimeRunControlOutcome {
  acknowledged: boolean;
  runId: number | null;
  isPaused: boolean | null;
  reasonCode: string | null;
  fixHint: string | null;
}

export type RuntimeRunStage = "queued" | "preparing" | "coding" | "validating" | "publishing";
export type RuntimeTerminalStatus = "success" | "failed" | "cancelled" | "guardrail_blocked";

export interface RuntimeRepositoryRunSnapshotItem {
  runId: number;
  issueNumber: number;
  issueTitle: string;
  issueBranchName: string;
  stage: RuntimeRunStage;
  queuePosition: number | null;
  terminalStatus: RuntimeTerminalStatus | null;
  reasonCode: string | null;
  fixHint: string | null;
  isPaused: boolean;
  pausedAt: string | null;
  updatedAt: string;
  terminalAt: string | null;
}

export interface RuntimeRepositoryRunSnapshot {
  repositoryFullName: string;
  repositoryKey: string;
  runs: RuntimeRepositoryRunSnapshotItem[];
}

export interface RuntimeRunTransitionHistoryItem {
  sequence: number;
  stage: RuntimeRunStage;
  terminalStatus: RuntimeTerminalStatus | null;
  reasonCode: string | null;
  fixHint: string | null;
  createdAt: string;
}

export interface RuntimeIssueRunHistoryItem {
  runId: number;
  issueNumber: number;
  issueTitle: string;
  issueBranchName: string;
  stage: RuntimeRunStage;
  queuePosition: number | null;
  terminalStatus: RuntimeTerminalStatus | null;
  reasonCode: string | null;
  fixHint: string | null;
  isPaused: boolean;
  pausedAt: string | null;
  createdAt: string;
  updatedAt: string;
  terminalAt: string | null;
  transitions: RuntimeRunTransitionHistoryItem[];
}

export interface RuntimeIssueRunHistory {
  repositoryFullName: string;
  repositoryKey: string;
  issueNumber: number;
  runs: RuntimeIssueRunHistoryItem[];
}

export interface RuntimeIssueRunHistoryRequest {
  repositoryFullName: string;
  issueNumber: number;
}

export interface RuntimeIssueRunTelemetryRequest {
  repositoryFullName: string;
  issueNumber: number;
  runId?: number | null;
  limit?: number | null;
}

export interface RuntimeTelemetryRedactionReason {
  reasonCode: string;
  matchCount: number;
}

export interface RuntimeRunTelemetryEventPayload {
  eventId: number;
  runId: number;
  repositoryFullName: string;
  repositoryKey: string;
  issueNumber: number;
  issueTitle: string;
  issueBranchName: string;
  sequence: number;
  kind: string;
  stage: string;
  message: string;
  redactionReasons: RuntimeTelemetryRedactionReason[];
  includeInSummary: boolean;
  createdAt: string;
}

export interface RuntimeIssueRunTelemetry {
  repositoryFullName: string;
  repositoryKey: string;
  issueNumber: number;
  runId: number;
  events: RuntimeRunTelemetryEventPayload[];
}

export type RuntimeIssueRunSummaryCompletionStatus = RuntimeTerminalStatus | "in-progress";

export interface RuntimeIssueRunSummaryCompletion {
  status: RuntimeIssueRunSummaryCompletionStatus;
  terminalAt: string | null;
}

export interface RuntimeIssueRunSummaryKeyAction {
  kind: string;
  stage: string;
  message: string;
  createdAt: string;
}

export type RuntimeIssueRunSummaryValidationStatus =
  | "pass"
  | "fail"
  | "timeout"
  | "not-found"
  | "not-run";

export interface RuntimeIssueRunSummaryValidationOutcomes {
  code: RuntimeIssueRunSummaryValidationStatus;
  browser: RuntimeIssueRunSummaryValidationStatus;
}

export interface RuntimeIssueRunSummary {
  repositoryFullName: string;
  repositoryKey: string;
  issueNumber: number;
  runId: number;
  completion: RuntimeIssueRunSummaryCompletion;
  keyActions: RuntimeIssueRunSummaryKeyAction[];
  validationOutcomes: RuntimeIssueRunSummaryValidationOutcomes;
}

export interface RuntimeIssueRunSummaryRequest {
  repositoryFullName: string;
  issueNumber: number;
  runId?: number | null;
}

export interface RuntimeRunStageChangedEventPayload {
  runId: number;
  repositoryFullName: string;
  repositoryKey: string;
  issueNumber: number;
  issueTitle: string;
  issueBranchName: string;
  stage: RuntimeRunStage;
  queuePosition: number | null;
  terminalStatus: RuntimeTerminalStatus | null;
  reasonCode: string | null;
  fixHint: string | null;
  isPaused: boolean;
  pausedAt: string | null;
}

export interface GithubAuthStatus {
  connected: boolean;
  user: GithubUser | null;
}

export interface GithubDeviceAuthStart {
  userCode: string;
  verificationUri: string;
  expiresAtEpochSeconds: number;
  intervalSeconds: number;
}

export type GithubDeviceAuthPollStatus =
  | "pending"
  | "slow_down"
  | "authorized"
  | "expired"
  | "denied";

export interface GithubDeviceAuthPoll {
  status: GithubDeviceAuthPollStatus;
  user: GithubUser | null;
}

export interface CreatedProject {
  id: number;
  name: string;
  folderName: string;
  folderPath: string;
}

export function getDevelopmentFolder(): Promise<string | null> {
  return invoke<string | null>("sqlite_get_development_folder");
}

export function setDevelopmentFolder(folderPath: string): Promise<void> {
  return invoke("sqlite_set_development_folder", { folderPath });
}

export function pickDevelopmentFolder(): Promise<string | null> {
  return invoke<string | null>("pick_development_folder");
}

export function getDbPath(): Promise<string> {
  return invoke<string>("sqlite_db_path");
}

export function dbHealthcheck(): Promise<string> {
  return invoke<string>("sqlite_healthcheck");
}

export function insertMessage(body: string): Promise<number> {
  return invoke<number>("sqlite_insert_message", { body });
}

export function listMessages(): Promise<string[]> {
  return invoke<string[]>("sqlite_list_messages");
}

export function listProjects(): Promise<CreatedProject[]> {
  return invoke<CreatedProject[]>("sqlite_list_projects");
}

export function createProject(projectName: string): Promise<CreatedProject> {
  return invoke<CreatedProject>("sqlite_create_project", { projectName });
}

export function githubAuthStatus(): Promise<GithubAuthStatus> {
  return invoke<GithubAuthStatus>("github_auth_status");
}

export function githubListRepositories(): Promise<GithubRepository[]> {
  return invoke<GithubRepository[]>("github_list_repositories");
}

export function githubListRepositoryItems(repositoryFullName: string): Promise<GithubRepositoryItem[]> {
  return invoke<GithubRepositoryItem[]>("github_list_repository_items", { repositoryFullName });
}

export function githubAttemptIssueIntake(
  request: GithubIssueIntakeRequest,
): Promise<GithubIssueIntakeOutcome> {
  return invoke<GithubIssueIntakeOutcome>("github_attempt_issue_intake", { request });
}

export function githubRevertIssueIntake(
  request: GithubIssueIntakeRequest,
): Promise<GithubIssueIntakeOutcome> {
  return invoke<GithubIssueIntakeOutcome>("github_revert_issue_intake", { request });
}

export function runtimeEnqueueIssueRun(
  request: RuntimeEnqueueIssueRunRequest,
): Promise<RuntimeEnqueueIssueRunOutcome> {
  return invoke<RuntimeEnqueueIssueRunOutcome>("runtime_enqueue_issue_run", { request });
}

export function runtimeDequeueIssueRun(
  request: RuntimeDequeueIssueRunRequest,
): Promise<RuntimeDequeueIssueRunOutcome> {
  return invoke<RuntimeDequeueIssueRunOutcome>("runtime_dequeue_issue_run", { request });
}

export function runtimePauseIssueRun(
  request: RuntimeControlIssueRunRequest,
): Promise<RuntimeRunControlOutcome> {
  return invoke<RuntimeRunControlOutcome>("runtime_pause_issue_run", { request });
}

export function runtimeResumeIssueRun(
  request: RuntimeControlIssueRunRequest,
): Promise<RuntimeRunControlOutcome> {
  return invoke<RuntimeRunControlOutcome>("runtime_resume_issue_run", { request });
}

export function runtimeAbortIssueRun(
  request: RuntimeAbortIssueRunRequest,
): Promise<RuntimeRunControlOutcome> {
  return invoke<RuntimeRunControlOutcome>("runtime_abort_issue_run", { request });
}

export function runtimeSteerIssueRun(
  request: RuntimeSteerIssueRunRequest,
): Promise<RuntimeRunControlOutcome> {
  return invoke<RuntimeRunControlOutcome>("runtime_steer_issue_run", { request });
}

export function runtimeGetRepositoryRunSnapshot(repositoryFullName: string): Promise<RuntimeRepositoryRunSnapshot> {
  return invoke<RuntimeRepositoryRunSnapshot>("runtime_get_repository_run_snapshot", {
    repositoryFullName,
  });
}

export function runtimeGetIssueRunHistory(request: RuntimeIssueRunHistoryRequest): Promise<RuntimeIssueRunHistory> {
  return invoke<RuntimeIssueRunHistory>("runtime_get_issue_run_history", { request });
}

export function runtimeGetIssueRunTelemetry(
  request: RuntimeIssueRunTelemetryRequest,
): Promise<RuntimeIssueRunTelemetry> {
  return invoke<RuntimeIssueRunTelemetry>("runtime_get_issue_run_telemetry", { request });
}

export function runtimeGetIssueRunSummary(
  request: RuntimeIssueRunSummaryRequest,
): Promise<RuntimeIssueRunSummary> {
  return invoke<RuntimeIssueRunSummary>("runtime_get_issue_run_summary", { request });
}

export function githubAuthStart(): Promise<GithubDeviceAuthStart> {
  return invoke<GithubDeviceAuthStart>("github_auth_start");
}

export function githubAuthPoll(): Promise<GithubDeviceAuthPoll> {
  return invoke<GithubDeviceAuthPoll>("github_auth_poll");
}

export function githubAuthLogout(): Promise<void> {
  return invoke<void>("github_auth_logout");
}

export function githubOpenVerificationUrl(url: string): Promise<void> {
  return invoke<void>("github_open_verification_url", { url });
}

export function githubOpenItemUrl(url: string): Promise<void> {
  return invoke<void>("github_open_item_url", { url });
}
