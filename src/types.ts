/**
 * Types for Cursor Cloud Agents API v1
 * @see https://cursor.com/docs/cloud-agent/api/endpoints
 */

export type AgentStatus = "ACTIVE" | "IDLE" | "ARCHIVED";

export type RunStatus =
  | "CREATING"
  | "RUNNING"
  | "FINISHED"
  | "ERROR"
  | "CANCELLED"
  | "EXPIRED";

export interface PromptImage {
  data?: string;
  mimeType?: string;
  url?: string;
}

export interface Prompt {
  text: string;
  images?: PromptImage[];
}

export interface ModelParam {
  id: string;
  value: string;
}

export interface ModelSelection {
  id: string;
  params?: ModelParam[];
}

export interface RepoConfig {
  url: string;
  startingRef?: string;
  prUrl?: string;
}

export interface EnvConfig {
  type: "cloud" | "pool" | "machine";
  name?: string;
}

export interface Agent {
  id: string;
  name: string;
  status: AgentStatus;
  env?: EnvConfig;
  repos?: RepoConfig[];
  workOnCurrentBranch?: boolean;
  autoCreatePR?: boolean;
  url?: string;
  createdAt: string;
  updatedAt?: string;
  latestRunId?: string;
}

export interface GitBranch {
  repoUrl: string;
  branch?: string;
  prUrl?: string;
}

export interface Run {
  id: string;
  agentId: string;
  status: RunStatus;
  createdAt: string;
  updatedAt?: string;
  durationMs?: number;
  result?: string;
  git?: {
    branches: GitBranch[];
  };
}

export interface CreateAgentResponse {
  agent: Agent;
  run: Run;
}

export interface CreateRunResponse {
  run: Run;
}

export interface ListAgentsResponse {
  items: Agent[];
  nextCursor?: string;
}

export interface ListRunsResponse {
  items: Run[];
  nextCursor?: string;
}

export interface MeResponse {
  apiKeyName: string;
  createdAt: string;
  userId?: number;
  userEmail?: string;
  userFirstName?: string;
  userLastName?: string;
}

export interface ModelInfo {
  id: string;
  displayName: string;
  description?: string;
  aliases?: string[];
  parameters?: Array<{
    id: string;
    displayName?: string;
    values: Array<{ value: string; displayName?: string }>;
  }>;
  variants?: Array<{
    params: ModelParam[];
    displayName: string;
    description?: string;
    isDefault?: boolean;
  }>;
}

export interface ListModelsResponse {
  items: ModelInfo[];
}

export interface ListRepositoriesResponse {
  items: Array<{ url: string }>;
}

export interface IdResponse {
  id: string;
}
