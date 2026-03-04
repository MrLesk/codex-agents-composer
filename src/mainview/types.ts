export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | string;

export type SkillSource = "local" | "remote";

export interface Skill {
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

export interface SkillDocument {
  skill: Skill;
  markdown: string;
  name: string;
  description: string;
  content: string;
}

export interface Agent {
  id: string;
  name: string;
  description: string;
  model: string;
  reasoningEffort: ReasoningEffort;
  instructions: string;
  configFile: string;
  skillCount: number;
}

export interface ModelOption {
  id: string;
  displayName: string;
  description: string;
  defaultReasoningEffort: ReasoningEffort;
  supportedReasoningEfforts: ReasoningEffort[];
}

export interface BootstrapPayload {
  agents: Agent[];
  skills: Skill[];
  models: ModelOption[];
}

export interface AgentDetailPayload {
  agent: Agent;
  assignedSkills: Skill[];
  allSkills: Skill[];
  models: ModelOption[];
}

export interface CreateAgentInput {
  name: string;
  description: string;
  model: string;
  reasoningEffort: ReasoningEffort;
  instructions: string;
}

export interface UpdateAgentInput {
  name: string;
  description: string;
  model: string;
  reasoningEffort: ReasoningEffort;
  instructions: string;
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
