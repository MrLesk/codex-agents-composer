import { Cloud, HardDrive, Download, Package } from "lucide-react";
import { clsx } from "clsx";
import type { Skill } from "../types";

const SKILL_MIME_TYPE = "application/x-codex-skill";

interface SkillCardProps {
  skill: Skill;
  compact?: boolean;
  onAssign?: (skill: Skill) => void;
  onOpen?: (skill: Skill) => void;
  disabled?: boolean;
  actionLabel?: string;
  actionTone?: "primary" | "danger";
  dragHint?: string;
  dragIntent?: "assign" | "unassign";
}

export function SkillCard({
  skill,
  compact = false,
  onAssign,
  onOpen,
  disabled = false,
  actionLabel = "Assign",
  actionTone = "primary",
  dragHint = "Drag to assign",
  dragIntent = "assign",
}: SkillCardProps) {
  const onDragStart = (event: React.DragEvent<HTMLElement>) => {
    event.dataTransfer.effectAllowed = dragIntent === "unassign" ? "move" : "copy";
    event.dataTransfer.setData(
      SKILL_MIME_TYPE,
      JSON.stringify({ skillKey: skill.key, intent: dragIntent }),
    );
  };

  const open = () => {
    if (onOpen) {
      onOpen(skill);
    }
  };

  return (
    <article
      className={clsx(
        "rounded-xl border border-gray-800 bg-[#171717] transition-colors",
        compact ? "px-3 py-2" : "p-4",
        disabled ? "opacity-70" : "hover:border-gray-700",
        onOpen && "cursor-pointer",
      )}
      draggable
      onDragStart={onDragStart}
      onClick={open}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          {skill.source === "local" ? (
            <HardDrive className="w-4 h-4 text-green-400 shrink-0" />
          ) : (
            <Cloud className="w-4 h-4 text-blue-400 shrink-0" />
          )}
          <div className="min-w-0">
            <p className="text-sm text-gray-100 truncate">{skill.name}</p>
            <p className="text-[11px] text-gray-500 truncate">
              {skill.origin || skill.path || "local"}
            </p>
          </div>
        </div>
        {skill.installs ? (
          <span className="text-[11px] text-gray-400 inline-flex items-center gap-1">
            <Download className="w-3 h-3" />
            {skill.installs.toLocaleString()}
          </span>
        ) : null}
      </div>

      {!compact && skill.description ? (
        <p className="text-xs text-gray-400 mt-2 line-clamp-2">{skill.description}</p>
      ) : null}

      <div className="mt-3 flex items-center justify-between gap-3">
        <span className="text-[10px] uppercase text-gray-500 tracking-wide inline-flex items-center gap-1">
          <Package className="w-3 h-3" />
          {dragHint}
        </span>
        {onAssign ? (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onAssign(skill);
            }}
            disabled={disabled}
            className={clsx(
              "text-xs px-2.5 py-1 rounded-md border disabled:opacity-60 cursor-pointer",
              actionTone === "danger"
                ? "border-rose-500/40 text-rose-300 hover:bg-rose-600/15"
                : "border-blue-500/40 text-blue-300 hover:bg-blue-600/15",
            )}
          >
            {actionLabel}
          </button>
        ) : null}
      </div>
    </article>
  );
}
