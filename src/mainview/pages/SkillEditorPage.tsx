import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { ArrowLeft, ChevronDown, Cloud, HardDrive, Loader2, Package, Save, TriangleAlert } from "lucide-react";
import { createSkill, fetchSkillDocument, saveSkillDocument } from "../api";
import { useManager } from "../context/ManagerContext";
import type { SkillDocument } from "../types";

const SKILL_MIME_TYPE = "application/x-codex-skill";

function parseFallbackFromMarkdown(markdown: string, fallbackName: string): {
  name: string;
  description: string;
  content: string;
} {
  const normalized = (markdown || "").replace(/\r\n/g, "\n");
  const match = normalized.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);

  let name = fallbackName;
  let description = "";
  const content = match ? normalized.slice(match[0].length) : normalized;

  if (match) {
    const frontmatter = match[1] || "";
    for (const rawLine of frontmatter.split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const kv = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
      if (!kv) continue;

      const key = kv[1].toLowerCase();
      const value = kv[2].replace(/^['\"]|['\"]$/g, "").trim();

      if (key === "name" && value) {
        name = value;
      }
      if (key === "description") {
        description = value;
      }
    }
  }

  return { name, description, content };
}

export function SkillEditorPage() {
  const { skillKey } = useParams<{ skillKey: string }>();
  const navigate = useNavigate();
  const { refreshSkills, deleteSkillByKey } = useManager();
  const isNew = !skillKey || skillKey === "new";

  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [document, setDocument] = useState<SkillDocument | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [content, setContent] = useState("");
  const [dangerOpen, setDangerOpen] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState("");
  const [deletingSkill, setDeletingSkill] = useState(false);

  useEffect(() => {
    if (isNew || !skillKey) {
      setDocument(null);
      setLoading(false);
      setLoadError(null);
      setName("");
      setDescription("");
      setContent("");
      return;
    }

    setLoading(true);
    setLoadError(null);
    void fetchSkillDocument(skillKey)
      .then((nextDocument) => {
        const fallback = parseFallbackFromMarkdown(
          nextDocument.markdown || "",
          nextDocument.skill.name,
        );

        const hasNameField = Object.prototype.hasOwnProperty.call(nextDocument, "name");
        const hasDescriptionField = Object.prototype.hasOwnProperty.call(nextDocument, "description");
        const hasContentField = Object.prototype.hasOwnProperty.call(nextDocument, "content");

        setDocument(nextDocument);
        setName(
          hasNameField && typeof nextDocument.name === "string"
            ? nextDocument.name
            : fallback.name,
        );
        setDescription(
          hasDescriptionField && typeof nextDocument.description === "string"
            ? nextDocument.description
            : fallback.description,
        );
        setContent(
          hasContentField && typeof nextDocument.content === "string"
            ? nextDocument.content
            : fallback.content,
        );
      })
      .catch((error) => {
        setDocument(null);
        setName("");
        setDescription("");
        setContent("");
        setLoadError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setLoading(false));
  }, [isNew, skillKey]);

  const isRemoteSkill = !isNew && document?.skill.source === "remote";

  const saveLabel = useMemo(() => {
    if (isNew) return "Create Skill";
    return isRemoteSkill ? "Save Locally" : "Save";
  }, [isNew, isRemoteSkill]);

  const isLocalSkill = !isNew && document?.skill.source === "local";
  const deleteTargetName = name || document?.skill.name || "";
  const canDelete = isLocalSkill && deleteTargetName.length > 0 && deleteConfirmText.trim() === deleteTargetName;

  const onDeleteSkill = async () => {
    if (!skillKey || !canDelete) return;
    setDeletingSkill(true);
    try {
      await deleteSkillByKey(skillKey);
      navigate("/", { replace: true });
    } finally {
      setDeletingSkill(false);
    }
  };

  const canDragToAssign = !isNew && Boolean(document?.skill.key);

  const onSkillDragStart = (event: React.DragEvent<HTMLButtonElement>) => {
    if (!document?.skill.key) return;
    event.dataTransfer.effectAllowed = "copy";
    event.dataTransfer.setData(
      SKILL_MIME_TYPE,
      JSON.stringify({ skillKey: document.skill.key, intent: "assign" }),
    );
  };

  const save = async () => {
    console.log("[save] called", { name, description, content: content.slice(0, 50), isNew, skillKey });
    if (!name.trim()) {
      setLoadError("Skill name is required");
      return;
    }

    setSaving(true);
    setLoadError(null);

    try {
      if (isNew) {
        console.log("[save] creating new skill...");
        const created = await createSkill({
          name,
          description,
          content,
        });
        console.log("[save] created:", created.skill.key);
        await refreshSkills(true);
        navigate(`/skill/${encodeURIComponent(created.skill.key)}`);
        return;
      }

      if (!skillKey) return;
      console.log("[save] updating skill:", skillKey);
      const updated = await saveSkillDocument(skillKey, {
        name,
        description,
        content,
      });
      console.log("[save] updated:", updated.skill.key);

      setDocument(updated);
      setName(updated.name || updated.skill.name);
      setDescription(updated.description || "");
      setContent(updated.content || "");
      await refreshSkills(true);

      if (updated.skill.key !== skillKey) {
        navigate(`/skill/${encodeURIComponent(updated.skill.key)}`);
      }
    } catch (error) {
      console.error("[save] error:", error);
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="p-8 text-sm text-gray-500">Loading skill...</div>;
  }

  return (
    <section className="p-7 md:p-9 max-w-6xl mx-auto h-full flex flex-col">
      <div className="flex items-start justify-between gap-4 mb-6">
        <div>
          <Link
            to="/"
            className="text-xs text-gray-400 hover:text-gray-200 inline-flex items-center gap-1"
          >
            <ArrowLeft className="w-3 h-3" />
            Back to catalog
          </Link>
          <h1 className="text-2xl mt-2">
            {isNew ? "Create Skill" : `Skill Editor · ${name || skillKey || "unknown"}`}
          </h1>
          <div className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-gray-700 bg-[#141414] px-2 py-1 text-[11px] text-gray-300">
            {isRemoteSkill ? <Cloud className="w-3.5 h-3.5 text-blue-400" /> : <HardDrive className="w-3.5 h-3.5 text-green-400" />}
            {isRemoteSkill ? "Remote skill" : "Local skill"}
          </div>
          <p className="text-sm text-gray-500 mt-2">
            {isRemoteSkill
              ? "Editing this remote skill and saving will create a local copy."
              : "Edit frontmatter description and markdown content below."}
          </p>
          {canDragToAssign ? (
            <button
              type="button"
              draggable
              onDragStart={onSkillDragStart}
              className="mt-2 inline-flex items-center gap-2 rounded-md border border-gray-700 bg-[#141414] px-2.5 py-1.5 text-xs text-gray-200 cursor-grab active:cursor-grabbing hover:border-blue-500/50"
              title="Drag to an agent in the sidebar to assign"
            >
              <Package className="w-3.5 h-3.5 text-gray-400" />
              Drag this skill to assign
            </button>
          ) : null}
          {loadError ? (
            <p className="mt-2 text-xs text-red-300 bg-red-500/10 border border-red-500/30 rounded-md px-2 py-1.5">
              {loadError}
            </p>
          ) : null}
        </div>

        <button
          type="button"
          onClick={() => void save()}
          disabled={saving || !name.trim()}
          className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm inline-flex items-center gap-2 disabled:opacity-70 cursor-pointer"
        >
          {saving ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : isRemoteSkill ? (
            <HardDrive className="w-4 h-4" />
          ) : (
            <Save className="w-4 h-4" />
          )}
          {saveLabel}
        </button>
      </div>

      <div className="space-y-4 flex-1 min-h-0">
        <div className="space-y-1.5">
          <label className="text-xs text-gray-400">Skill Name</label>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="my-specialized-skill"
            className="w-full bg-[#161616] border border-gray-800 rounded-lg px-4 py-2.5 text-sm text-gray-100"
          />
          {!isNew && document?.skill.path ? (
            <p className="text-[11px] text-gray-600">{document.skill.path}</p>
          ) : null}
        </div>

        <div className="space-y-1.5">
          <label className="text-xs text-gray-400">Description (frontmatter)</label>
          <textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            rows={3}
            className="w-full bg-[#161616] border border-gray-800 rounded-lg px-4 py-2.5 text-sm text-gray-100"
            placeholder="Use when..."
          />
        </div>

        <div className="space-y-1.5 h-[calc(100%-166px)] min-h-[420px]">
          <label className="text-xs text-gray-400">Skill Content (Markdown)</label>
          <textarea
            value={content}
            onChange={(event) => setContent(event.target.value)}
            className="w-full h-full bg-[#121212] border border-gray-800 rounded-lg px-4 py-3 text-sm text-gray-100 font-mono resize-none"
            placeholder={"## Instructions\n\nWrite your skill content here..."}
          />
        </div>
      </div>

      {isLocalSkill ? (
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
                Deleting this skill removes the file from disk and unassigns it from all agents.
              </p>
              <p className="text-xs text-gray-400">
                To confirm, type <span className="font-mono text-gray-200">{deleteTargetName}</span> below.
              </p>

              <input
                value={deleteConfirmText}
                onChange={(event) => setDeleteConfirmText(event.target.value)}
                placeholder="Type skill name to confirm"
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
                  onClick={() => void onDeleteSkill()}
                  disabled={!canDelete || deletingSkill}
                  className="px-3 py-1.5 rounded-lg border border-rose-500/50 bg-rose-600/20 text-sm text-rose-200 hover:bg-rose-600/30 disabled:opacity-50 cursor-pointer"
                >
                  {deletingSkill ? "Deleting..." : "Delete Skill"}
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
