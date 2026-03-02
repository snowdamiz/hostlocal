import { invoke } from "@tauri-apps/api/core";

export interface GithubUser {
  login: string;
  avatarUrl: string;
  htmlUrl: string;
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
