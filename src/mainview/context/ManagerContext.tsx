import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  assignSkill,
  deleteAgent,
  deleteSkill,
  fetchBootstrap,
  fetchSkills,
  unassignSkill,
} from "../api";
import type { Agent, ModelOption, Skill } from "../types";

interface ManagerContextValue {
  agents: Agent[];
  skills: Skill[];
  models: ModelOption[];
  loading: boolean;
  error: string | null;
  assigningAgentId: string | null;
  refreshAll: (refreshRemote?: boolean) => Promise<void>;
  refreshSkills: (refreshRemote?: boolean) => Promise<void>;
  assignSkillToAgent: (agentId: string, skillKey: string) => Promise<Skill[]>;
  unassignSkillFromAgent: (agentId: string, skillKey: string) => Promise<Skill[]>;
  deleteAgentById: (agentId: string) => Promise<void>;
  deleteSkillByKey: (skillKey: string) => Promise<void>;
  upsertAgent: (agent: Agent, previousId?: string) => void;
}

const ManagerContext = createContext<ManagerContextValue | null>(null);

export function ManagerProvider({ children }: { children: ReactNode }) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [assigningAgentId, setAssigningAgentId] = useState<string | null>(null);

  const refreshAll = useCallback(async (refreshRemote = false) => {
    setLoading(true);
    setError(null);
    try {
      const payload = await fetchBootstrap(refreshRemote);
      setAgents(payload.agents);
      setSkills(payload.skills);
      setModels(payload.models);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshSkillsOnly = useCallback(async (refreshRemote = false) => {
    try {
      const nextSkills = await fetchSkills(refreshRemote);
      setSkills(nextSkills);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const assignSkillToAgent = useCallback(async (agentId: string, skillKey: string) => {
    setAssigningAgentId(agentId);
    setError(null);
    try {
      const assignedSkills = await assignSkill(agentId, skillKey);

      setAgents((prev) =>
        prev.map((agent) =>
          agent.id === agentId
            ? {
                ...agent,
                skillCount: assignedSkills.length,
              }
            : agent,
        ),
      );

      return assignedSkills;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      throw err;
    } finally {
      setAssigningAgentId(null);
    }
  }, []);

  const unassignSkillFromAgent = useCallback(async (agentId: string, skillKey: string) => {
    setAssigningAgentId(agentId);
    setError(null);
    try {
      const assignedSkills = await unassignSkill(agentId, skillKey);

      setAgents((prev) =>
        prev.map((agent) =>
          agent.id === agentId
            ? {
                ...agent,
                skillCount: assignedSkills.length,
              }
            : agent,
        ),
      );

      return assignedSkills;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      throw err;
    } finally {
      setAssigningAgentId(null);
    }
  }, []);

  const deleteAgentById = useCallback(async (agentId: string) => {
    setError(null);
    try {
      await deleteAgent(agentId);
      setAgents((prev) => prev.filter((agent) => agent.id !== agentId));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      throw err;
    }
  }, []);

  const deleteSkillByKey = useCallback(async (skillKey: string) => {
    setError(null);
    try {
      await deleteSkill(skillKey);
      setSkills((prev) => prev.filter((s) => s.key !== skillKey));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      throw err;
    }
  }, []);

  const upsertAgent = useCallback((nextAgent: Agent, previousId?: string) => {
    setAgents((prev) => {
      const base = previousId
        ? prev.filter((agent) => agent.id !== previousId)
        : prev;

      const exists = base.some((agent) => agent.id === nextAgent.id);
      if (!exists) {
        return [...base, nextAgent].sort((a, b) => a.name.localeCompare(b.name));
      }

      return base.map((agent) => (agent.id === nextAgent.id ? nextAgent : agent));
    });
  }, []);

  useEffect(() => {
    void refreshAll(true);
  }, [refreshAll]);

  const value = useMemo(
    () => ({
      agents,
      skills,
      models,
      loading,
      error,
      assigningAgentId,
      refreshAll,
      refreshSkills: refreshSkillsOnly,
      assignSkillToAgent,
      unassignSkillFromAgent,
      deleteAgentById,
      deleteSkillByKey,
      upsertAgent,
    }),
    [
      agents,
      skills,
      models,
      loading,
      error,
      assigningAgentId,
      refreshAll,
      refreshSkillsOnly,
      assignSkillToAgent,
      unassignSkillFromAgent,
      deleteAgentById,
      deleteSkillByKey,
      upsertAgent,
    ],
  );

  return <ManagerContext.Provider value={value}>{children}</ManagerContext.Provider>;
}

export function useManager(): ManagerContextValue {
  const context = useContext(ManagerContext);
  if (!context) {
    throw new Error("useManager must be used within ManagerProvider");
  }
  return context;
}
