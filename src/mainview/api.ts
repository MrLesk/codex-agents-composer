import type {
  Agent,
  AgentDetailPayload,
  BootstrapPayload,
  CreateAgentInput,
  CreateSkillInput,
  Skill,
  SkillDocument,
  UpdateAgentInput,
} from "./types";

const API_BASE = import.meta.env.VITE_API_BASE || "http://127.0.0.1:8765";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers || {}),
    },
  });

  const payload = (await response.json()) as T & { error?: string };
  if (!response.ok) {
    throw new Error(payload.error || `Request failed (${response.status})`);
  }

  return payload;
}

export async function fetchBootstrap(refresh = false): Promise<BootstrapPayload> {
  return request<BootstrapPayload>(`/api/bootstrap?refresh=${refresh ? "1" : "0"}`);
}

export async function fetchSkills(refresh = false, query?: string): Promise<Skill[]> {
  const params = new URLSearchParams({
    refresh: refresh ? "1" : "0",
  });

  if (query?.trim()) {
    params.set("q", query.trim());
  }

  const result = await request<{ skills: Skill[] }>(`/api/skills?${params.toString()}`);
  return result.skills;
}

export async function fetchAgentDetail(agentId: string): Promise<AgentDetailPayload> {
  return request<AgentDetailPayload>(`/api/agents/${encodeURIComponent(agentId)}`);
}

export async function createAgent(input: CreateAgentInput): Promise<Agent> {
  const result = await request<{ agent: Agent }>("/api/agents", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return result.agent;
}

export async function updateAgent(
  agentId: string,
  input: UpdateAgentInput,
): Promise<Agent> {
  const result = await request<{ agent: Agent }>(
    `/api/agents/${encodeURIComponent(agentId)}`,
    {
      method: "PUT",
      body: JSON.stringify(input),
    },
  );
  return result.agent;
}

export async function deleteAgent(agentId: string): Promise<void> {
  await request<{ ok: true }>(`/api/agents/${encodeURIComponent(agentId)}`, {
    method: "DELETE",
  });
}

export async function assignSkill(agentId: string, skillKey: string): Promise<Skill[]> {
  const result = await request<{ assignedSkills: Skill[] }>(
    `/api/agents/${encodeURIComponent(agentId)}/assign`,
    {
      method: "POST",
      body: JSON.stringify({ skillKey }),
    },
  );
  return result.assignedSkills;
}

export async function unassignSkill(agentId: string, skillKey: string): Promise<Skill[]> {
  const result = await request<{ assignedSkills: Skill[] }>(
    `/api/agents/${encodeURIComponent(agentId)}/unassign`,
    {
      method: "POST",
      body: JSON.stringify({ skillKey }),
    },
  );
  return result.assignedSkills;
}

export async function fetchSkillDocument(skillKey: string): Promise<SkillDocument> {
  const result = await request<{ document: SkillDocument }>(
    `/api/skills/${encodeURIComponent(skillKey)}`,
  );
  return result.document;
}

export async function saveSkillDocument(
  skillKey: string,
  markdown: string,
): Promise<SkillDocument> {
  const result = await request<{ document: SkillDocument }>(
    `/api/skills/${encodeURIComponent(skillKey)}`,
    {
      method: "PUT",
      body: JSON.stringify({ markdown }),
    },
  );
  return result.document;
}

export async function createSkill(input: CreateSkillInput): Promise<SkillDocument> {
  const result = await request<{ document: SkillDocument }>("/api/skills", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return result.document;
}
