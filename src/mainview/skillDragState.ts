export type SkillDragIntent = "assign" | "unassign";

export interface SkillDragPayload {
  skillKey: string;
  skillName: string;
  intent: SkillDragIntent;
  agentId?: string;
}

let activeSkillDrag: SkillDragPayload | null = null;

export function setActiveSkillDrag(payload: SkillDragPayload | null): void {
  activeSkillDrag = payload;
}

export function getActiveSkillDrag(): SkillDragPayload | null {
  return activeSkillDrag;
}

export function clearActiveSkillDrag(): void {
  activeSkillDrag = null;
}
