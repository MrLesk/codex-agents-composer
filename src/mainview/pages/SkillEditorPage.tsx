import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { ArrowLeft, Loader2, Save } from "lucide-react";
import { createSkill, fetchSkillDocument, saveSkillDocument } from "../api";
import { useManager } from "../context/ManagerContext";
import type { SkillDocument } from "../types";

export function SkillEditorPage() {
  const { skillKey } = useParams<{ skillKey: string }>();
  const navigate = useNavigate();
  const { refreshSkills } = useManager();
  const isNew = skillKey === "new";

  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [document, setDocument] = useState<SkillDocument | null>(null);
  const [name, setName] = useState("");
  const [markdown, setMarkdown] = useState("");

  useEffect(() => {
    if (isNew || !skillKey) {
      setLoadError(null);
      return;
    }

    setLoading(true);
    setLoadError(null);
    void fetchSkillDocument(skillKey)
      .then((nextDocument) => {
        setDocument(nextDocument);
        setName(nextDocument.skill.name);
        setMarkdown(nextDocument.markdown);
      })
      .catch((error) => {
        setDocument(null);
        setName("");
        setMarkdown("");
        setLoadError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setLoading(false));
  }, [isNew, skillKey]);

  const save = async () => {
    setSaving(true);
    try {
      if (isNew) {
        const created = await createSkill({
          name,
          markdown,
        });
        await refreshSkills(true);
        navigate(`/skill/${encodeURIComponent(created.skill.key)}`);
        return;
      }

      if (!skillKey) return;
      const updated = await saveSkillDocument(skillKey, markdown);
      setDocument(updated);
      setName(updated.skill.name);
      setLoadError(null);
      await refreshSkills(false);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="p-8 text-sm text-gray-500">Loading skill...</div>;
  }

  const readOnly = isNew ? false : document ? !document.editable : true;

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
          <p className="text-sm text-gray-500 mt-1">
            {isNew
              ? "Create a local skill with full markdown instructions."
              : loadError
                ? "Could not load this skill. Check the message below."
                : readOnly
                  ? "This skill is read-only. Install/copy as local to edit."
                  : "Edit the SKILL.md content using full markdown."}
          </p>
          {loadError ? (
            <p className="mt-2 text-xs text-red-300 bg-red-500/10 border border-red-500/30 rounded-md px-2 py-1.5">
              {loadError}
            </p>
          ) : null}
        </div>

        <button
          type="button"
          onClick={() => void save()}
          disabled={saving || readOnly || (!isNew && !document)}
          className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm inline-flex items-center gap-2 disabled:opacity-70"
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          {isNew ? "Create Skill" : "Save Markdown"}
        </button>
      </div>

      <div className="space-y-4 flex-1 min-h-0">
        <div className="space-y-1.5">
          <label className="text-xs text-gray-400">Skill Name</label>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            disabled={!isNew}
            placeholder="my-specialized-skill"
            className="w-full bg-[#161616] border border-gray-800 rounded-lg px-4 py-2.5 text-sm text-gray-100 disabled:opacity-60"
          />
          {!isNew && document?.skill.path ? (
            <p className="text-[11px] text-gray-600">{document.skill.path}</p>
          ) : null}
        </div>

        <div className="space-y-1.5 h-[calc(100%-74px)] min-h-[420px]">
          <label className="text-xs text-gray-400">SKILL.md (Markdown)</label>
          <textarea
            value={markdown}
            onChange={(event) => setMarkdown(event.target.value)}
            readOnly={readOnly}
            className="w-full h-full bg-[#121212] border border-gray-800 rounded-lg px-4 py-3 text-sm text-gray-100 font-mono resize-none"
            placeholder="# Skill Name\n\nWrite your instructions here..."
          />
        </div>
      </div>
    </section>
  );
}
