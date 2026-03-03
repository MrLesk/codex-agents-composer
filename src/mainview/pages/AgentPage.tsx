import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import { useForm } from "react-hook-form";
import { ArrowLeft, ChevronDown, Loader2, Save, Search, TriangleAlert } from "lucide-react";
import { createAgent, fetchAgentDetail, updateAgent } from "../api";
import { SkillCard } from "../components/SkillCard";
import { useManager } from "../context/ManagerContext";
import { useSkillSearch } from "../hooks/useSkillSearch";
import type { ModelOption, ReasoningEffort, Skill } from "../types";

interface AgentFormValues {
  name: string;
  description: string;
  model: string;
  reasoningEffort: ReasoningEffort;
  instructions: string;
}

function resolveReasoningOptions(model: ModelOption | undefined): ReasoningEffort[] {
  if (!model) return ["low", "medium", "high"];
  return model.supportedReasoningEfforts.length > 0
    ? model.supportedReasoningEfforts
    : [model.defaultReasoningEffort];
}

const FALLBACK_MODEL = "gpt-5.3-codex";
const FALLBACK_REASONING: ReasoningEffort = "medium";
const SKILL_MIME_TYPE = "application/x-codex-skill";

export function AgentPage() {
  const { agentId } = useParams<{ agentId: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const isCreateRoute = location.pathname === "/agent/new";
  const isCreate = isCreateRoute || !agentId || agentId === "new";
  const {
    models,
    skills: catalogSkills,
    upsertAgent,
    assignSkillToAgent,
    unassignSkillFromAgent,
    deleteAgentById,
  } = useManager();

  const [assignedSkills, setAssignedSkills] = useState<Skill[]>([]);
  const [allSkills, setAllSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [mutatingSkillKey, setMutatingSkillKey] = useState<string | null>(null);
  const [catalogQuery, setCatalogQuery] = useState("");
  const [isDroppingOnAssigned, setIsDroppingOnAssigned] = useState(false);
  const [isDroppingOnCatalog, setIsDroppingOnCatalog] = useState(false);
  const [dangerOpen, setDangerOpen] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState("");
  const [deletingAgent, setDeletingAgent] = useState(false);

  const {
    register,
    handleSubmit,
    watch,
    reset,
    setValue,
    formState: { isDirty },
  } = useForm<AgentFormValues>({
    defaultValues: {
      name: "",
      description: "",
      model: models[0]?.id || FALLBACK_MODEL,
      reasoningEffort: models[0]?.defaultReasoningEffort || FALLBACK_REASONING,
      instructions: "",
    },
  });

  useEffect(() => {
    if (!isCreate && agentId) {
      setLoading(true);
      void fetchAgentDetail(agentId)
        .then((payload) => {
          setAssignedSkills(payload.assignedSkills);
          setAllSkills(payload.allSkills);
          reset({
            name: payload.agent.name,
            description: payload.agent.description,
            model: payload.agent.model,
            reasoningEffort: payload.agent.reasoningEffort,
            instructions: payload.agent.instructions,
          });
        })
        .finally(() => {
          setLoading(false);
        });
      return;
    }

    setLoading(false);
    setAssignedSkills([]);
    setAllSkills(catalogSkills);
    reset({
      name: "",
      description: "",
      model: models[0]?.id || FALLBACK_MODEL,
      reasoningEffort: models[0]?.defaultReasoningEffort || FALLBACK_REASONING,
      instructions: "",
    });
  }, [agentId, isCreate, reset]);

  useEffect(() => {
    if (!isCreate) return;

    setAllSkills(catalogSkills);
    setAssignedSkills((prev) =>
      prev.filter((skill) => catalogSkills.some((entry) => entry.key === skill.key)),
    );
  }, [catalogSkills, isCreate]);

  useEffect(() => {
    setDangerOpen(false);
    setDeleteConfirmText("");
  }, [agentId, isCreate]);

  const selectedModelId = watch("model");
  const selectedModel = models.find((model) => model.id === selectedModelId);
  const reasoningOptions = resolveReasoningOptions(selectedModel);

  useEffect(() => {
    const current = watch("reasoningEffort");
    if (!reasoningOptions.includes(current)) {
      setValue("reasoningEffort", reasoningOptions[0] || FALLBACK_REASONING, {
        shouldDirty: true,
      });
    }
  }, [reasoningOptions, setValue, watch]);

  const assignedSkillKeys = useMemo(
    () => new Set(assignedSkills.map((skill) => skill.key)),
    [assignedSkills],
  );

  const includeCatalogSkill = useCallback(
    (skill: Skill) => !assignedSkillKeys.has(skill.key),
    [assignedSkillKeys],
  );

  const {
    filteredSkills: filteredCatalogSkills,
    searchingRemote: searchingCatalogRemote,
  } = useSkillSearch({
    skills: allSkills,
    query: catalogQuery,
    sourceFilter: "all",
    enableRemoteLookup: true,
    skillFilter: includeCatalogSkill,
  });

  const unassignedCatalogCount = useMemo(
    () => allSkills.filter(includeCatalogSkill).length,
    [allSkills, includeCatalogSkill],
  );

  const deleteTargetId = agentId || "";
  const canDelete = !isCreate && deleteTargetId.length > 0 && deleteConfirmText.trim() === deleteTargetId;

  const onSubmit = async (formValues: AgentFormValues) => {
    setSaving(true);
    try {
      if (isCreate) {
        const skillKeysToAssign = assignedSkills.map((skill) => skill.key);
        const created = await createAgent({
          name: formValues.name,
          description: formValues.description,
          model: formValues.model,
          reasoningEffort: formValues.reasoningEffort,
          instructions: formValues.instructions,
        });

        upsertAgent(created);

        for (const skillKey of skillKeysToAssign) {
          try {
            await assignSkillToAgent(created.id, skillKey);
          } catch (error) {
            console.error(`Failed to assign skill '${skillKey}' after create`, error);
          }
        }

        navigate(`/agent/${encodeURIComponent(created.id)}`);
      } else if (agentId) {
        const previousId = agentId;
        const updated = await updateAgent(previousId, {
          name: formValues.name,
          description: formValues.description,
          model: formValues.model,
          reasoningEffort: formValues.reasoningEffort,
          instructions: formValues.instructions,
        });

        upsertAgent(updated, updated.id !== previousId ? previousId : undefined);

        if (updated.id !== previousId) {
          navigate(`/agent/${encodeURIComponent(updated.id)}`);
          return;
        }

        const refreshed = await fetchAgentDetail(updated.id);
        setAssignedSkills(refreshed.assignedSkills);
        setAllSkills(refreshed.allSkills);
      }
    } finally {
      setSaving(false);
    }
  };

  const onDeleteAgent = async () => {
    if (!deleteTargetId || !canDelete) return;

    setDeletingAgent(true);
    try {
      await deleteAgentById(deleteTargetId);
      navigate("/", { replace: true });
    } finally {
      setDeletingAgent(false);
    }
  };

  const assignOne = async (skill: Skill) => {
    if (isCreate) {
      setAssignedSkills((prev) => {
        if (prev.some((entry) => entry.key === skill.key)) {
          return prev;
        }
        return [skill, ...prev];
      });
      return;
    }

    const targetAgentId = agentId || "";
    if (!targetAgentId) return;

    setMutatingSkillKey(skill.key);
    try {
      const assigned = await assignSkillToAgent(targetAgentId, skill.key);
      setAssignedSkills(assigned);
    } finally {
      setMutatingSkillKey(null);
    }
  };

  const unassignOne = async (skill: Skill) => {
    if (isCreate) {
      setAssignedSkills((prev) => prev.filter((entry) => entry.key !== skill.key));
      return;
    }

    const targetAgentId = agentId || "";
    if (!targetAgentId) return;

    setMutatingSkillKey(skill.key);
    try {
      const assigned = await unassignSkillFromAgent(targetAgentId, skill.key);
      setAssignedSkills(assigned);
    } finally {
      setMutatingSkillKey(null);
    }
  };

  const assignFromDrag = async (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDroppingOnAssigned(false);

    const raw = event.dataTransfer.getData(SKILL_MIME_TYPE);
    if (!raw) return;

    try {
      const data = JSON.parse(raw) as { skillKey?: string };
      if (!data.skillKey) return;

      const draggedSkill =
        allSkills.find((skill) => skill.key === data.skillKey) ||
        filteredCatalogSkills.find((skill) => skill.key === data.skillKey);

      if (!draggedSkill) return;
      await assignOne(draggedSkill);
    } catch (error) {
      console.error("Failed to assign skill in agent board via drag/drop", error);
    }
  };

  const unassignFromDrag = async (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDroppingOnCatalog(false);

    const raw = event.dataTransfer.getData(SKILL_MIME_TYPE);
    if (!raw) return;

    try {
      const data = JSON.parse(raw) as { skillKey?: string; intent?: "assign" | "unassign" };
      if (!data.skillKey) return;

      const isAssignedSkill = assignedSkillKeys.has(data.skillKey);
      const shouldUnassign = data.intent === "unassign" || isAssignedSkill;
      if (!shouldUnassign) {
        return;
      }

      const draggedSkill = assignedSkills.find((skill) => skill.key === data.skillKey);
      if (!draggedSkill) return;
      await unassignOne(draggedSkill);
    } catch (error) {
      console.error("Failed to unassign skill in agent board via drag/drop", error);
    }
  };

  if (loading) {
    return <div className="p-8 text-sm text-gray-500">Loading agent...</div>;
  }

  return (
    <section className="p-7 md:p-9 max-w-6xl mx-auto">
      <div className="flex items-start justify-between mb-7 gap-4">
        <div>
          <Link
            to="/"
            className="text-xs text-gray-400 hover:text-gray-200 inline-flex items-center gap-1"
          >
            <ArrowLeft className="w-3 h-3" />
            Back to catalog
          </Link>
          <h1 className="text-2xl mt-2">{isCreate ? "Create Agent" : `Agent · ${agentId}`}</h1>
          <p className="text-sm text-gray-500 mt-1">
            Configure model, reasoning, and instructions. Skills are assigned below.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void handleSubmit(onSubmit)()}
          disabled={saving}
          className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm inline-flex items-center gap-2 disabled:opacity-70 cursor-pointer"
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          {isCreate ? "Create" : isDirty ? "Save" : "Saved"}
        </button>
      </div>

      <div className="space-y-5 mb-8">
        <div className="space-y-1.5">
          <label className="text-xs text-gray-400">Name</label>
          <input
            {...register("name", { required: true })}
            className="w-full bg-transparent border-0 border-b border-gray-700 px-0 py-1 text-lg text-gray-100 rounded-none focus:outline-none focus:border-blue-500/60"
            placeholder="reviewer_agent"
          />
          <p className="text-[11px] text-gray-600">
            Used as the agent key in Codex config.
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          <div className="space-y-1.5">
            <label className="text-xs text-gray-400">Model</label>
            <select
              {...register("model")}
              className="w-full h-10 bg-[#161616] border border-gray-800 rounded-lg px-4 text-sm text-gray-100"
            >
              {models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.displayName}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs text-gray-400">Reasoning Effort</label>
            <select
              {...register("reasoningEffort")}
              className="w-full h-10 bg-[#161616] border border-gray-800 rounded-lg px-4 text-sm text-gray-100 capitalize"
            >
              {reasoningOptions.map((level) => (
                <option key={String(level)} value={level}>
                  {String(level)}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="space-y-1.5">
          <label className="text-xs text-gray-400">
            Description <span className="text-gray-600">(guidance Codex uses to choose this role)</span>
          </label>
          <textarea
            {...register("description")}
            rows={3}
            className="w-full bg-[#161616] border border-gray-800 rounded-lg px-4 py-2.5 text-sm text-gray-100"
            placeholder="What this agent is for"
          />
        </div>

        <div className="space-y-1.5">
          <label className="text-xs text-gray-400">
            Developer Instructions <span className="text-gray-600">(extra role-specific instructions applied on spawn)</span>
          </label>
          <textarea
            {...register("instructions")}
            rows={6}
            className="w-full bg-[#161616] border border-gray-800 rounded-lg px-4 py-3 text-sm text-gray-100 font-mono"
            placeholder="Instructions written into the agent config file"
          />
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <div
          className={
            isDroppingOnAssigned
              ? "rounded-xl border border-green-500/70 bg-green-500/10"
              : "rounded-xl border border-gray-800 bg-[#121212]"
          }
          onDragOver={(event) => {
            event.preventDefault();
            setIsDroppingOnAssigned(true);
          }}
          onDragLeave={() => setIsDroppingOnAssigned(false)}
          onDrop={(event) => void assignFromDrag(event)}
        >
          <div className="px-4 py-3 border-b border-gray-800 text-xs text-gray-400 uppercase tracking-wide">
            {isCreate ? "Selected Skills" : "Assigned Skills"} ({assignedSkills.length})
          </div>
          <div className="p-3 space-y-2 max-h-[460px] overflow-auto">
            {assignedSkills.length === 0 ? (
              <p className="text-xs text-gray-600 py-5 text-center">
                {isCreate ? "No skills selected yet." : "No skills assigned yet."}
              </p>
            ) : (
              assignedSkills.map((skill) => (
                <SkillCard
                  key={skill.key}
                  skill={skill}
                  compact
                  dragHint="Drag to unassign"
                  dragIntent="unassign"
                  actionLabel="Unassign"
                  actionTone="danger"
                  onAssign={() => void unassignOne(skill)}
                  onOpen={() => navigate(`/skill/${encodeURIComponent(skill.key)}`)}
                  disabled={mutatingSkillKey === skill.key}
                />
              ))
            )}
          </div>
        </div>

        <div
          className={
            isDroppingOnCatalog
              ? "rounded-xl border border-rose-500/70 bg-rose-500/10"
              : "rounded-xl border border-gray-800 bg-[#121212]"
          }
          onDragOver={(event) => {
            event.preventDefault();
            setIsDroppingOnCatalog(true);
          }}
          onDragLeave={() => setIsDroppingOnCatalog(false)}
          onDrop={(event) => void unassignFromDrag(event)}
        >
          <div className="px-4 py-3 border-b border-gray-800 text-xs text-gray-400 uppercase tracking-wide">
            Catalog Board ({filteredCatalogSkills.length})
          </div>
          <div className="px-3 pt-3">
            <div className="relative">
              <Search className="absolute top-2.5 left-3 w-4 h-4 text-gray-600" />
              <input
                value={catalogQuery}
                onChange={(event) => setCatalogQuery(event.target.value)}
                placeholder="Search by name, source repo, or skill id"
                className="w-full bg-[#161616] border border-gray-800 rounded-lg h-10 pl-9 pr-3 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500/40"
              />
            </div>
          </div>
          {searchingCatalogRemote ? (
            <div className="px-3 pt-2 text-xs text-gray-500 inline-flex items-center gap-2">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              Searching online skills...
            </div>
          ) : null}
          <div className="p-3 space-y-2 max-h-[460px] overflow-auto">
            {filteredCatalogSkills.length === 0 ? (
              <p className="text-xs text-gray-600 py-5 text-center">
                {unassignedCatalogCount === 0
                  ? "No catalog skills available."
                  : "No skills match your search."}
              </p>
            ) : (
              filteredCatalogSkills.map((skill) => (
                <SkillCard
                  key={skill.key}
                  skill={skill}
                  compact
                  onAssign={() => void assignOne(skill)}
                  onOpen={() => navigate(`/skill/${encodeURIComponent(skill.key)}`)}
                  disabled={mutatingSkillKey === skill.key}
                />
              ))
            )}
          </div>
        </div>
      </div>

      {!isCreate ? (
        <div className="mt-8 rounded-xl border border-rose-500/30 bg-rose-950/10">
          <button
            type="button"
            onClick={() => setDangerOpen((open) => !open)}
            className="w-full px-4 py-3 inline-flex items-center justify-between text-sm text-rose-300 hover:text-rose-200 cursor-pointer"
          >
            <span className="inline-flex items-center gap-2">
              <TriangleAlert className="w-4 h-4" />
              Danger Zone
            </span>
            <ChevronDown className={dangerOpen ? "w-4 h-4 rotate-180" : "w-4 h-4"} />
          </button>

          {dangerOpen ? (
            <div className="border-t border-rose-500/20 px-4 py-4 space-y-3">
              <p className="text-xs text-gray-300">
                Deleting this agent removes its config and unassigns all skills from this agent.
              </p>
              <p className="text-xs text-gray-400">
                To confirm, type <span className="font-mono text-gray-200">{deleteTargetId}</span> below.
              </p>

              <input
                value={deleteConfirmText}
                onChange={(event) => setDeleteConfirmText(event.target.value)}
                placeholder="Type agent id to confirm"
                className="w-full bg-[#161616] border border-rose-500/40 rounded-lg h-10 px-3 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-rose-400/70"
              />

              <div className="flex items-center justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => {
                    setDangerOpen(false);
                    setDeleteConfirmText("");
                  }}
                  className="px-3 py-1.5 rounded-lg border border-gray-700 text-sm text-gray-300 hover:text-white hover:border-gray-600 cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void onDeleteAgent()}
                  disabled={!canDelete || deletingAgent}
                  className="px-3 py-1.5 rounded-lg border border-rose-500/50 bg-rose-600/20 text-sm text-rose-200 hover:bg-rose-600/30 disabled:opacity-50 cursor-pointer"
                >
                  {deletingAgent ? "Deleting..." : "Delete Agent"}
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
