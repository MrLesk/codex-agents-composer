import {
  ChevronDown,
  ChevronRight,
  Loader2,
  Pencil,
  Plus,
  Settings2,
  Unplug,
} from "lucide-react";
import { Link, NavLink, useLocation, useNavigate } from "react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { clsx } from "clsx";
import { fetchAgentDetail } from "../api";
import { useManager } from "../context/ManagerContext";
import { clearActiveSkillDrag, getActiveSkillDrag, setActiveSkillDrag } from "../skillDragState";
import type { AgentScope, Skill } from "../types";
import appLogo from "../assets/app-logo.png";

const SKILL_MIME_TYPE = "application/x-codex-skill";

interface PendingDroppedSkill {
  skillName: string;
}

interface DraggedSidebarSkill {
  agentId: string;
  skillName: string;
}

function formatModelLabel(model: string): string {
  return model
    .split("-")
    .map((token) => {
      const lower = token.toLowerCase();
      if (lower === "gpt") return "GPT";
      if (lower === "codex") return "Codex";
      if (!token) return token;
      return token.charAt(0).toUpperCase() + token.slice(1);
    })
    .join("-");
}

function formatReasoningLabel(reasoningEffort: string): string {
  const lower = reasoningEffort.toLowerCase();
  if (!lower) return "";
  if (lower === "xhigh") return "XHigh";
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

function formatAgentScopeLabel(scope: AgentScope, projectPath: string | null): string {
  if (scope === "global") {
    return "Global";
  }

  if (!projectPath) {
    return "Project";
  }

  const segments = projectPath.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] || projectPath;
}

export function Sidebar() {
  const navigate = useNavigate();
  const location = useLocation();
  const {
    agents,
    assignSkillToAgent,
    unassignSkillFromAgent,
    assigningAgentId,
  } = useManager();
  const [activeDropAgentId, setActiveDropAgentId] = useState<string | null>(null);
  const [expandedAgentId, setExpandedAgentId] = useState<string | null>(null);
  const [skillsByAgentId, setSkillsByAgentId] = useState<Record<string, Skill[]>>({});
  const [loadingSkillsAgentId, setLoadingSkillsAgentId] = useState<string | null>(null);
  const [pendingDroppedSkills, setPendingDroppedSkills] = useState<
    Record<string, PendingDroppedSkill | undefined>
  >({});
  const [draggedSidebarSkill, setDraggedSidebarSkill] = useState<DraggedSidebarSkill | null>(null);
  const [isDroppingOnUnassignZone, setIsDroppingOnUnassignZone] = useState(false);
  const skillsByAgentIdRef = useRef(skillsByAgentId);

  const showSidebarDropHint = location.pathname === "/";

  useEffect(() => {
    skillsByAgentIdRef.current = skillsByAgentId;
  }, [skillsByAgentId]);

  const loadAgentSkills = useCallback(
    async (
      agentId: string,
      options: { showLoadingIfMissing?: boolean } = {},
    ) => {
      const { showLoadingIfMissing = true } = options;
      if (showLoadingIfMissing && !skillsByAgentIdRef.current[agentId]) {
        setLoadingSkillsAgentId(agentId);
      }

      try {
        const detail = await fetchAgentDetail(agentId);
        setSkillsByAgentId((prev) => ({
          ...prev,
          [agentId]: detail.assignedSkills,
        }));
      } catch (error) {
        console.error(`Failed to load assigned skills for '${agentId}'`, error);
      } finally {
        setLoadingSkillsAgentId((current) =>
          current === agentId ? null : current,
        );
      }
    },
    [],
  );

  // Keep expanded agent content stable while refreshing changed skill counts.
  const prevAgentsRef = useRef(agents);
  useEffect(() => {
    const prev = prevAgentsRef.current;
    prevAgentsRef.current = agents;

    if (prev === agents) return;

    const changedAgentIds = agents.flatMap((agent) => {
      const old = prev.find((a) => a.id === agent.id);
      return old && old.skillCount !== agent.skillCount ? [agent.id] : [];
    });

    if (changedAgentIds.length === 0) return;

    setSkillsByAgentId((current) => {
      let next = current;

      for (const agentId of changedAgentIds) {
        if (agentId === expandedAgentId) continue;
        if (!(agentId in next)) continue;

        if (next === current) {
          next = { ...current };
        }

        delete next[agentId];
      }

      return next;
    });

    if (expandedAgentId && changedAgentIds.includes(expandedAgentId)) {
      void loadAgentSkills(expandedAgentId, { showLoadingIfMissing: false });
    }
  }, [agents, expandedAgentId, loadAgentSkills]);

  const onDrop = async (agentId: string, event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setActiveDropAgentId(null);
    const raw = event.dataTransfer.getData(SKILL_MIME_TYPE);
    if (!raw) return;

    try {
      const data = JSON.parse(raw) as {
        skillKey?: string;
        skillName?: string;
        intent?: "assign" | "unassign";
      };
      if (!data.skillKey) return;
      if (data.intent === "unassign") return;

      setPendingDroppedSkills((current) => ({
        ...current,
        [agentId]: {
          skillName: data.skillName || "Assigning skill...",
        },
      }));

      const assignedSkills = await assignSkillToAgent(agentId, data.skillKey);
      setSkillsByAgentId((prev) => ({
        ...prev,
        [agentId]: assignedSkills,
      }));
    } catch (error) {
      console.error("Failed to assign skill via drag/drop", error);
    } finally {
      setPendingDroppedSkills((current) => {
        const next = { ...current };
        delete next[agentId];
        return next;
      });
    }
  };

  const onSidebarSkillDragStart = (
    agentId: string,
    skill: Skill,
    event: React.DragEvent<HTMLDivElement>,
  ) => {
    setActiveSkillDrag({
      agentId,
      skillKey: skill.key,
      skillName: skill.name,
      intent: "unassign",
    });
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(
      SKILL_MIME_TYPE,
      JSON.stringify({
        agentId,
        skillKey: skill.key,
        skillName: skill.name,
        intent: "unassign",
      }),
    );
    setDraggedSidebarSkill({
      agentId,
      skillName: skill.name,
    });
  };

  const onSidebarSkillDragEnd = () => {
    clearActiveSkillDrag();
    setDraggedSidebarSkill(null);
    setIsDroppingOnUnassignZone(false);
  };

  const unassignFromSidebarDrop = async (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDroppingOnUnassignZone(false);
    const raw = event.dataTransfer.getData(SKILL_MIME_TYPE);
    if (!raw) return;

    try {
      const data = JSON.parse(raw) as {
        agentId?: string;
        skillKey?: string;
        intent?: "assign" | "unassign";
      };

      if (!data.skillKey || !data.agentId || data.intent !== "unassign") {
        return;
      }

      const nextAssignedSkills = await unassignSkillFromAgent(data.agentId, data.skillKey);
      setSkillsByAgentId((current) => ({
        ...current,
        [data.agentId!]: nextAssignedSkills,
      }));
    } catch (error) {
      console.error("Failed to unassign skill via sidebar drag/drop", error);
    } finally {
      clearActiveSkillDrag();
      setDraggedSidebarSkill(null);
    }
  };

  // Re-fetch skills for the expanded agent when cache is invalidated
  useEffect(() => {
    if (expandedAgentId && !skillsByAgentId[expandedAgentId]) {
      void loadAgentSkills(expandedAgentId);
    }
  }, [expandedAgentId, skillsByAgentId, loadAgentSkills]);

  const toggleAccordion = (agentId: string) => {
    setExpandedAgentId((current) => {
      const next = current === agentId ? null : agentId;
      if (next) {
        void loadAgentSkills(next);
      }
      return next;
    });
  };

  const openSkillEditor = (skillKey: string) => {
    navigate(`/skill/${encodeURIComponent(skillKey)}`);
  };

  return (
    <aside className="w-80 border-r border-gray-800 bg-[#080808] flex flex-col h-full">
      <div className="px-5 py-4 border-b border-gray-800">
        <div className="flex items-center justify-between">
          <Link
            to="/"
            className="flex items-center gap-2.5 rounded-lg -mx-1 px-1 py-0.5 hover:bg-white/5 transition-colors"
          >
            <div className="w-8 h-8 rounded-lg bg-blue-600/20 border border-blue-500/40 overflow-hidden">
              <img src={appLogo} alt="Codex Agents Composer" className="w-full h-full object-cover" />
            </div>
            <div>
              <p className="text-gray-100 text-sm">Codex Agents Composer</p>
              <p className="text-[11px] text-gray-500">Create specialized codex agents.</p>
            </div>
          </Link>
        </div>
      </div>

      <div className="px-4 py-3">
        <NavLink
          to="/agent/new"
          className="flex items-center justify-center gap-2 px-4 py-3 rounded-xl border border-dashed border-gray-700 text-gray-300 hover:border-blue-500/50 hover:text-white transition-colors"
        >
          <Plus className="w-4 h-4" />
          New Agent
        </NavLink>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 pb-4 space-y-2">
        {agents.map((agent) => {
          const isDropping = activeDropAgentId === agent.id;
          const isAssigning = assigningAgentId === agent.id;
          const isExpanded = expandedAgentId === agent.id;
          const isLoadingSkills = loadingSkillsAgentId === agent.id;
          const assignedSkills = skillsByAgentId[agent.id] || [];
          const orderedAssignedSkills = [...assignedSkills].reverse();
          const pendingDroppedSkill = pendingDroppedSkills[agent.id];
          const agentPath = `/agent/${encodeURIComponent(agent.id)}`;
          const isActive = location.pathname === agentPath;

          return (
            <div
              key={agent.id}
              onDragOver={(event) => {
                const dragIntent = getActiveSkillDrag()?.intent ?? null;
                if (dragIntent !== "assign") {
                  event.dataTransfer.dropEffect = "none";
                  setActiveDropAgentId((current) =>
                    current === agent.id ? null : current,
                  );
                  return;
                }

                event.preventDefault();
                event.dataTransfer.dropEffect = "copy";
                setActiveDropAgentId(agent.id);
              }}
              onDragLeave={() => {
                setActiveDropAgentId((current) =>
                  current === agent.id ? null : current,
                );
              }}
              onDrop={(event) => void onDrop(agent.id, event)}
              className={clsx(
                "rounded-xl border px-4 py-3.5 transition-all",
                isActive
                  ? "border-blue-500/50 bg-blue-600/10"
                  : "border-gray-800 bg-[#121212] hover:border-gray-700",
                isDropping && "border-green-500/70 bg-green-500/10",
              )}
            >
              <Link to={agentPath} className="block">
                <div className="min-w-0">
                  <p className="text-sm text-gray-100 truncate">
                    {agent.name}{" "}
                    <span className="text-[10px] text-gray-500">
                      ({formatModelLabel(agent.model)} - {formatReasoningLabel(agent.reasoningEffort)})
                    </span>
                  </p>
                  <p
                    className="text-[11px] text-gray-500 truncate mt-0.5"
                    title={agent.scope === "project" ? agent.projectPath || agent.description : agent.description}
                  >
                    {formatAgentScopeLabel(agent.scope, agent.projectPath)}
                    {agent.description ? ` · ${agent.description}` : ""}
                  </p>
                </div>
              </Link>

              {showSidebarDropHint ? (
                <div className="mt-3 rounded-lg border border-gray-800/80 bg-black/20 px-2.5 py-1.5 text-[11px] text-gray-500 flex items-center justify-between">
                  <span className="truncate">Drop skills here to assign</span>
                  {isAssigning ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
                </div>
              ) : null}

              <button
                type="button"
                onClick={() => toggleAccordion(agent.id)}
                className="mt-2 w-full rounded-lg border border-gray-800/80 bg-[#0f0f0f] px-2.5 py-1.5 text-[11px] text-gray-400 hover:text-gray-200 hover:border-gray-700 transition-colors inline-flex items-center justify-between cursor-pointer"
              >
                <span className="inline-flex items-center gap-1.5">
                  {isExpanded ? (
                    <ChevronDown className="w-3.5 h-3.5" />
                  ) : (
                    <ChevronRight className="w-3.5 h-3.5" />
                  )}
                  Configured Skills
                </span>
                <span>{agent.skillCount}</span>
              </button>

              {isExpanded ? (
                <div className="mt-1 rounded-lg border border-gray-800/80 bg-black/20 p-2 space-y-1.5">
                  {orderedAssignedSkills.length === 0 && isLoadingSkills ? (
                    <div className="text-[11px] text-gray-500 inline-flex items-center gap-1.5 px-1 py-1">
                      <Loader2 className="w-3 h-3 animate-spin" />
                      Loading skills...
                    </div>
                  ) : orderedAssignedSkills.length === 0 && !pendingDroppedSkill ? (
                    <p className="text-[11px] text-gray-600 px-1 py-1">No skills assigned.</p>
                  ) : (
                    orderedAssignedSkills.map((skill) => (
                      <div
                        key={`${agent.id}:${skill.key}`}
                        draggable
                        onDragStart={(event) => onSidebarSkillDragStart(agent.id, skill, event)}
                        onDragEnd={onSidebarSkillDragEnd}
                        className="rounded-md border border-gray-800 bg-[#121212] px-2 py-1.5 flex items-center gap-2 justify-between cursor-grab active:cursor-grabbing"
                      >
                        <button
                          type="button"
                          onClick={() => openSkillEditor(skill.key)}
                          className="text-[11px] text-gray-200 truncate text-left hover:text-white cursor-pointer"
                          title={skill.key}
                        >
                          {skill.name}
                        </button>
                        <button
                          type="button"
                          onClick={() => openSkillEditor(skill.key)}
                          className="shrink-0 inline-flex items-center gap-1 text-[10px] px-2 py-1 rounded-md border border-gray-700 text-gray-300 hover:text-white hover:border-blue-500/50 transition-colors cursor-pointer"
                        >
                          <Pencil className="w-3 h-3" />
                          Edit
                        </button>
                      </div>
                    ))
                  )}

                  {pendingDroppedSkill ? (
                    <div className="rounded-md border border-blue-500/30 bg-blue-500/5 px-2 py-1.5 flex items-center gap-2 justify-between">
                      <div className="min-w-0">
                        <p className="text-[11px] text-gray-200 truncate">
                          {pendingDroppedSkill.skillName}
                        </p>
                        <p className="text-[10px] text-gray-500">Assigning...</p>
                      </div>
                      <Loader2 className="w-3 h-3 text-blue-300 animate-spin shrink-0" />
                    </div>
                  ) : null}

                  <button
                    type="button"
                    onClick={() =>
                      navigate(
                        `/skill/new?assignToAgentId=${encodeURIComponent(agent.id)}&returnTo=${encodeURIComponent(`${location.pathname}${location.search}`)}`,
                      )
                    }
                    className="w-full inline-flex items-center justify-center gap-1.5 text-[11px] px-2 py-1.5 rounded-md border border-blue-500/40 bg-blue-500/10 text-blue-300 hover:bg-blue-500/20 transition-colors cursor-pointer"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    Create New Skill
                  </button>
                </div>
              ) : null}
            </div>
          );
        })}
      </nav>

      {draggedSidebarSkill ? (
        <div className="px-3 pb-3">
          <div
            onDragOver={(event) => {
              const dragIntent = getActiveSkillDrag()?.intent ?? null;
              if (dragIntent !== "unassign") {
                event.dataTransfer.dropEffect = "none";
                setIsDroppingOnUnassignZone(false);
                return;
              }

              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              setIsDroppingOnUnassignZone(true);
            }}
            onDragLeave={() => setIsDroppingOnUnassignZone(false)}
            onDrop={(event) => void unassignFromSidebarDrop(event)}
            className={clsx(
              "rounded-xl border border-dashed px-3 py-3 transition-colors",
              isDroppingOnUnassignZone
                ? "border-rose-400/70 bg-rose-500/10"
                : "border-rose-500/30 bg-rose-500/5",
            )}
          >
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs text-rose-200 inline-flex items-center gap-1.5">
                  <Unplug className="w-3.5 h-3.5" />
                  Drop Here To Unassign
                </p>
                <p className="mt-1 text-[11px] text-rose-200/70 truncate">
                  {draggedSidebarSkill.skillName}
                </p>
              </div>
              {assigningAgentId === draggedSidebarSkill.agentId ? (
                <Loader2 className="w-3.5 h-3.5 text-rose-200 animate-spin shrink-0" />
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      <div className="border-t border-gray-800 px-3 py-3">
        <NavLink
          to="/settings"
          className={({ isActive }) =>
            clsx(
              "flex items-center gap-2 rounded-xl border px-3 py-2.5 text-sm transition-colors",
              isActive
                ? "border-blue-500/40 bg-blue-500/10 text-blue-200"
                : "border-gray-800 bg-[#121212] text-gray-300 hover:border-gray-700 hover:text-white",
            )
          }
        >
          <Settings2 className="h-4 w-4" />
          Settings
        </NavLink>
      </div>
    </aside>
  );
}
