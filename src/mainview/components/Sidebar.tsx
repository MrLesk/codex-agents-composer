import {
  Bot,
  ChevronDown,
  ChevronRight,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
} from "lucide-react";
import { Link, NavLink, useLocation, useNavigate } from "react-router";
import { useCallback, useState } from "react";
import { clsx } from "clsx";
import { fetchAgentDetail } from "../api";
import { useManager } from "../context/ManagerContext";
import type { Skill } from "../types";

const SKILL_MIME_TYPE = "application/x-codex-skill";

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

export function Sidebar() {
  const navigate = useNavigate();
  const location = useLocation();
  const { agents, assignSkillToAgent, assigningAgentId, refreshAll } = useManager();
  const [activeDropAgentId, setActiveDropAgentId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [expandedAgentId, setExpandedAgentId] = useState<string | null>(null);
  const [skillsByAgentId, setSkillsByAgentId] = useState<Record<string, Skill[]>>({});
  const [loadingSkillsAgentId, setLoadingSkillsAgentId] = useState<string | null>(null);

  const loadAgentSkills = useCallback(
    async (agentId: string, force = false) => {
      if (!force && skillsByAgentId[agentId]) {
        return;
      }

      setLoadingSkillsAgentId(agentId);
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
    [skillsByAgentId],
  );

  const onDrop = async (agentId: string, event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setActiveDropAgentId(null);
    const raw = event.dataTransfer.getData(SKILL_MIME_TYPE);
    if (!raw) return;

    try {
      const data = JSON.parse(raw) as { skillKey?: string };
      if (!data.skillKey) return;
      const assignedSkills = await assignSkillToAgent(agentId, data.skillKey);
      setSkillsByAgentId((prev) => ({
        ...prev,
        [agentId]: assignedSkills,
      }));
    } catch (error) {
      console.error("Failed to assign skill via drag/drop", error);
    }
  };

  const refresh = async () => {
    setRefreshing(true);
    try {
      await refreshAll(true);
      setSkillsByAgentId({});
      setExpandedAgentId(null);
    } finally {
      setRefreshing(false);
    }
  };

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
            <div className="w-8 h-8 rounded-lg bg-blue-600/20 border border-blue-500/40 flex items-center justify-center">
              <Bot className="w-4 h-4 text-blue-300" />
            </div>
            <div>
              <p className="text-gray-100 text-sm">Codex Agents Composer</p>
              <p className="text-[11px] text-gray-500">Create specialized codex agents.</p>
            </div>
          </Link>
          <button
            type="button"
            onClick={refresh}
            className="p-2 rounded-lg border border-gray-800 text-gray-400 hover:text-gray-200 hover:border-gray-700 transition-colors"
            title="Refresh"
          >
            <RefreshCw
              className={clsx("w-4 h-4", refreshing && "animate-spin")}
            />
          </button>
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
          const agentPath = `/agent/${encodeURIComponent(agent.id)}`;
          const isActive = location.pathname === agentPath;

          return (
            <div
              key={agent.id}
              onDragOver={(event) => {
                event.preventDefault();
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
                  <p className="text-[11px] text-gray-500 truncate mt-0.5">
                    {agent.description || "No description"}
                  </p>
                </div>
              </Link>

              <div className="mt-3 rounded-lg border border-gray-800/80 bg-black/20 px-2.5 py-1.5 text-[11px] text-gray-500 flex items-center justify-between">
                <span className="truncate">Drop skills here to assign</span>
                {isAssigning ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
              </div>

              <button
                type="button"
                onClick={() => toggleAccordion(agent.id)}
                className="mt-2 w-full rounded-lg border border-gray-800/80 bg-[#0f0f0f] px-2.5 py-1.5 text-[11px] text-gray-400 hover:text-gray-200 hover:border-gray-700 transition-colors inline-flex items-center justify-between"
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
                  {isLoadingSkills ? (
                    <div className="text-[11px] text-gray-500 inline-flex items-center gap-1.5 px-1 py-1">
                      <Loader2 className="w-3 h-3 animate-spin" />
                      Loading skills...
                    </div>
                  ) : assignedSkills.length === 0 ? (
                    <p className="text-[11px] text-gray-600 px-1 py-1">No skills assigned.</p>
                  ) : (
                    assignedSkills.map((skill) => (
                      <div
                        key={`${agent.id}:${skill.key}`}
                        className="rounded-md border border-gray-800 bg-[#121212] px-2 py-1.5 flex items-center gap-2 justify-between"
                      >
                        <button
                          type="button"
                          onClick={() => openSkillEditor(skill.key)}
                          className="text-[11px] text-gray-200 truncate text-left hover:text-white"
                          title={skill.key}
                        >
                          {skill.name}
                        </button>
                        <button
                          type="button"
                          onClick={() => openSkillEditor(skill.key)}
                          className="shrink-0 inline-flex items-center gap-1 text-[10px] px-2 py-1 rounded-md border border-gray-700 text-gray-300 hover:text-white hover:border-blue-500/50 transition-colors"
                        >
                          <Pencil className="w-3 h-3" />
                          Edit
                        </button>
                      </div>
                    ))
                  )}
                </div>
              ) : null}
            </div>
          );
        })}
      </nav>
    </aside>
  );
}
