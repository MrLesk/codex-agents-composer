import { useEffect, useMemo, useState } from "react";
import { fetchSkills } from "../api";
import type { Skill } from "../types";
import {
  buildSkillSearchQueryVariants,
  resolveSkillSearchLookupQuery,
} from "../../shared/skillSearchQuery";

export type SkillSourceFilter = "all" | "local" | "remote";

interface UseSkillSearchOptions {
  skills: Skill[];
  query: string;
  sourceFilter?: SkillSourceFilter;
  enableRemoteLookup?: boolean;
  skillFilter?: (skill: Skill) => boolean;
  debounceMs?: number;
}

function matchesSkillQuery(skill: Skill, queryVariants: string[]): boolean {
  if (queryVariants.length === 0) return true;

  const haystacks = [
    skill.name,
    skill.origin || "",
    skill.skillId || "",
    skill.description || "",
    skill.path || "",
    skill.key,
  ].map((value) => value.toLowerCase());

  return queryVariants.some((query) =>
    haystacks.some((haystack) => haystack.includes(query)),
  );
}

function applyFilters(
  skills: Skill[],
  queryVariants: string[],
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

    return matchesSkillQuery(skill, queryVariants);
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

  const queryVariants = useMemo(
    () => buildSkillSearchQueryVariants(query),
    [query],
  );
  const lookupQuery = useMemo(
    () => resolveSkillSearchLookupQuery(query),
    [query],
  );

  const baseFiltered = useMemo(
    () => applyFilters(skills, queryVariants, sourceFilter, skillFilter),
    [skills, queryVariants, sourceFilter, skillFilter],
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
      lookupQuery.length >= 3;

    if (!shouldLookupRemote) {
      setSearchedSkills(null);
      setSearchingRemote(false);
      return;
    }

    setSearchingRemote(true);

    let cancelled = false;
    const timer = window.setTimeout(() => {
      void fetchSkills(false, lookupQuery)
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
  }, [query, lookupQuery, sourceFilter, enableRemoteLookup, debounceMs]);

  const filteredSkills = useMemo(() => {
    if (!searchedSkills) {
      return baseFiltered;
    }

    return applyFilters(searchedSkills, queryVariants, sourceFilter, skillFilter);
  }, [searchedSkills, baseFiltered, queryVariants, sourceFilter, skillFilter]);

  return {
    filteredSkills,
    searchingRemote,
    clearRemoteResults: () => setSearchedSkills(null),
  };
}
