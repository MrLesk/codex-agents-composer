import { useEffect, useMemo, useState } from "react";
import { fetchSkills } from "../api";
import type { Skill } from "../types";

export type SkillSourceFilter = "all" | "local" | "remote";

interface UseSkillSearchOptions {
  skills: Skill[];
  query: string;
  sourceFilter?: SkillSourceFilter;
  enableRemoteLookup?: boolean;
  skillFilter?: (skill: Skill) => boolean;
  debounceMs?: number;
}

function matchesSkillQuery(skill: Skill, normalizedQuery: string): boolean {
  if (!normalizedQuery) return true;

  return (
    skill.name.toLowerCase().includes(normalizedQuery) ||
    (skill.origin || "").toLowerCase().includes(normalizedQuery) ||
    (skill.skillId || "").toLowerCase().includes(normalizedQuery) ||
    (skill.description || "").toLowerCase().includes(normalizedQuery) ||
    (skill.path || "").toLowerCase().includes(normalizedQuery) ||
    skill.key.toLowerCase().includes(normalizedQuery)
  );
}

function applyFilters(
  skills: Skill[],
  normalizedQuery: string,
  sourceFilter: SkillSourceFilter,
  skillFilter?: (skill: Skill) => boolean,
): Skill[] {
  return skills.filter((skill) => {
    if (sourceFilter !== "all" && skill.source !== sourceFilter) {
      return false;
    }

    if (skillFilter && !skillFilter(skill)) {
      return false;
    }

    return matchesSkillQuery(skill, normalizedQuery);
  });
}

export function useSkillSearch({
  skills,
  query,
  sourceFilter = "all",
  enableRemoteLookup = true,
  skillFilter,
  debounceMs = 300,
}: UseSkillSearchOptions) {
  const [searchedSkills, setSearchedSkills] = useState<Skill[] | null>(null);
  const [searchingRemote, setSearchingRemote] = useState(false);

  const normalizedQuery = useMemo(() => query.trim().toLowerCase(), [query]);

  const baseFiltered = useMemo(
    () => applyFilters(skills, normalizedQuery, sourceFilter, skillFilter),
    [skills, normalizedQuery, sourceFilter, skillFilter],
  );

  useEffect(() => {
    const q = query.trim();

    if (!q) {
      setSearchedSkills(null);
      setSearchingRemote(false);
      return;
    }

    const shouldLookupRemote =
      enableRemoteLookup &&
      sourceFilter !== "local" &&
      q.length >= 3;

    if (!shouldLookupRemote) {
      setSearchedSkills(null);
      setSearchingRemote(false);
      return;
    }

    setSearchingRemote(true);

    let cancelled = false;
    const timer = window.setTimeout(() => {
      void fetchSkills(false, q)
        .then((results) => {
          if (cancelled) return;
          setSearchedSkills(results);
        })
        .catch(() => {
          if (cancelled) return;
          setSearchedSkills(null);
        })
        .finally(() => {
          if (cancelled) return;
          setSearchingRemote(false);
        });
    }, debounceMs);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query, sourceFilter, enableRemoteLookup, debounceMs]);

  const filteredSkills = useMemo(() => {
    if (!searchedSkills) {
      return baseFiltered;
    }

    return applyFilters(searchedSkills, normalizedQuery, sourceFilter, skillFilter);
  }, [searchedSkills, baseFiltered, normalizedQuery, sourceFilter, skillFilter]);

  return {
    filteredSkills,
    searchingRemote,
    clearRemoteResults: () => setSearchedSkills(null),
  };
}
