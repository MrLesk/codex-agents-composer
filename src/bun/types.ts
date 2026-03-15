export type SkillSource = "local" | "remote";

export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | string;

export interface SkillRecord {
  key: string;
  source: SkillSource;
  origin: string | null;
  skillId: string | null;
  name: string;
  description: string | null;
  path: string | null;
  scope: string | null;
  installs: number | null;
}

export interface AgentRecord {
  id: string;
  name: string;
  description: string;
  model: string;
  reasoningEffort: ReasoningEffort;
  instructions: string;
  configFile: string;
  skillCount: number;
}

export interface ModelRecord {
  id: string;
  displayName: string;
  description: string;
  defaultReasoningEffort: ReasoningEffort;
  supportedReasoningEfforts: ReasoningEffort[];
}

export interface MultiAgentSettings {
  multiAgentEnabled: boolean;
  maxThreads: number | null;
  maxDepth: number | null;
  jobMaxRuntimeSeconds: number | null;
}

export interface BootstrapPayload {
  agents: AgentRecord[];
  skills: SkillRecord[];
  models: ModelRecord[];
  settings: MultiAgentSettings;
}

export interface AgentDetailPayload {
  agent: AgentRecord;
  assignedSkills: SkillRecord[];
  allSkills: SkillRecord[];
  models: ModelRecord[];
}

export interface CreateAgentInput {
  name: string;
  description: string;
  model: string;
  reasoningEffort: ReasoningEffort;
  instructions: string;
  skillKeys?: string[];
}

export interface UpdateAgentInput {
  name: string;
  description: string;
  model: string;
  reasoningEffort: ReasoningEffort;
  instructions: string;
}

export interface SkillDocument {
  skill: SkillRecord;
  markdown: string;
  name: string;
  description: string;
  content: string;
}

export interface CreateSkillInput {
  name: string;
  description: string;
  content: string;
}

export interface SaveSkillInput {
  name: string;
  description: string;
  content: string;
}

export interface UpdateSettingsInput {
  multiAgentEnabled: boolean;
  maxThreads: number | null;
  maxDepth: number | null;
  jobMaxRuntimeSeconds: number | null;
}
