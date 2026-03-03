import { useEffect, useMemo, useState } from "react";
import { Search, RotateCw, HardDrive, Cloud, Plus, Loader2 } from "lucide-react";
import { useNavigate } from "react-router";
import { SkillCard } from "../components/SkillCard";
import { useManager } from "../context/ManagerContext";
import { useSkillSearch } from "../hooks/useSkillSearch";

const PAGE_SIZE = 9;

export function SkillsPage() {
  const { skills, loading, refreshSkills } = useManager();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [localVisibleCount, setLocalVisibleCount] = useState(PAGE_SIZE);
  const [remoteVisibleCount, setRemoteVisibleCount] = useState(PAGE_SIZE);

  const { filteredSkills: localFiltered } = useSkillSearch({
    skills,
    query,
    sourceFilter: "local",
    enableRemoteLookup: false,
  });

  const {
    filteredSkills: remoteFiltered,
    searchingRemote,
    clearRemoteResults,
  } = useSkillSearch({
    skills,
    query,
    sourceFilter: "remote",
    enableRemoteLookup: true,
  });

  useEffect(() => {
    setLocalVisibleCount(PAGE_SIZE);
    setRemoteVisibleCount(PAGE_SIZE);
  }, [query]);

  const localVisibleSkills = useMemo(
    () => localFiltered.slice(0, localVisibleCount),
    [localFiltered, localVisibleCount],
  );

  const remoteVisibleSkills = useMemo(
    () => remoteFiltered.slice(0, remoteVisibleCount),
    [remoteFiltered, remoteVisibleCount],
  );

  const refresh = async () => {
    setRefreshing(true);
    try {
      await refreshSkills(true);
      clearRemoteResults();
      setLocalVisibleCount(PAGE_SIZE);
      setRemoteVisibleCount(PAGE_SIZE);
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <section className="p-7 md:p-9 max-w-7xl mx-auto">
      <div className="flex flex-wrap items-end justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl text-gray-100">Skill Catalog</h1>
          <p className="text-sm text-gray-500 mt-1">
            Drag a skill onto an agent in the left sidebar to install and assign it.
          </p>
        </div>

        <button
          type="button"
          onClick={refresh}
          className="px-3 py-1.5 rounded-lg border border-gray-800 bg-[#171717] text-gray-300 hover:text-white hover:border-gray-700 inline-flex items-center gap-1.5"
        >
          <RotateCw className={refreshing ? "w-3.5 h-3.5 animate-spin" : "w-3.5 h-3.5"} />
          Refresh
        </button>
      </div>

      <div className="mb-7 flex items-stretch gap-3 max-w-2xl">
        <div className="relative flex-1">
          <Search className="absolute top-2.5 left-3 w-4 h-4 text-gray-600" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search by name, source repo, or skill id"
            className="w-full bg-[#161616] border border-gray-800 rounded-lg h-10 pl-9 pr-3 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500/40"
          />
        </div>
        <button
          type="button"
          onClick={() => navigate("/skill/new")}
          className="px-3 h-10 rounded-lg border border-blue-500/40 bg-blue-500/10 text-blue-300 hover:bg-blue-500/20 text-sm leading-none inline-flex items-center gap-1.5"
        >
          <Plus className="w-4 h-4" />
          New Skill
        </button>
      </div>

      {loading ? (
        <div className="text-sm text-gray-500 py-10">Loading catalog...</div>
      ) : (
        <div className="space-y-9">
          <section>
            <div className="mb-4 flex items-center gap-2">
              <HardDrive className="w-4 h-4 text-green-400" />
              <h2 className="text-base text-gray-100">Local Skills</h2>
              <span className="text-xs text-gray-500">({localFiltered.length})</span>
            </div>

            {localVisibleSkills.length === 0 ? (
              <div className="text-sm text-gray-500 py-3">No local skills match your search.</div>
            ) : (
              <>
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                  {localVisibleSkills.map((skill) => (
                    <SkillCard
                      key={skill.key}
                      skill={skill}
                      onOpen={(clickedSkill) =>
                        navigate(`/skill/${encodeURIComponent(clickedSkill.key)}`)
                      }
                    />
                  ))}
                </div>

                {localFiltered.length > localVisibleCount ? (
                  <div className="mt-4 flex justify-center">
                    <button
                      type="button"
                      onClick={() => setLocalVisibleCount((count) => count + PAGE_SIZE)}
                      className="px-3.5 py-1.5 rounded-lg border border-gray-800 bg-[#171717] text-sm text-gray-300 hover:text-white hover:border-gray-700"
                    >
                      Load More Local Skills
                    </button>
                  </div>
                ) : null}
              </>
            )}
          </section>

          <section>
            <div className="mb-4 flex items-center gap-2">
              <Cloud className="w-4 h-4 text-blue-400" />
              <h2 className="text-base text-gray-100">Remote Skills</h2>
              <span className="text-xs text-gray-500">({remoteFiltered.length})</span>
              {searchingRemote ? (
                <span className="text-xs text-gray-500 inline-flex items-center gap-1.5 ml-1">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  Searching online skills...
                </span>
              ) : null}
            </div>

            {remoteVisibleSkills.length === 0 ? (
              <div className="text-sm text-gray-500 py-3">No remote skills match your search.</div>
            ) : (
              <>
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                  {remoteVisibleSkills.map((skill) => (
                    <SkillCard
                      key={skill.key}
                      skill={skill}
                      onOpen={(clickedSkill) =>
                        navigate(`/skill/${encodeURIComponent(clickedSkill.key)}`)
                      }
                    />
                  ))}
                </div>

                {remoteFiltered.length > remoteVisibleCount ? (
                  <div className="mt-4 flex justify-center">
                    <button
                      type="button"
                      onClick={() => setRemoteVisibleCount((count) => count + PAGE_SIZE)}
                      className="px-3.5 py-1.5 rounded-lg border border-gray-800 bg-[#171717] text-sm text-gray-300 hover:text-white hover:border-gray-700"
                    >
                      Load More Remote Skills
                    </button>
                  </div>
                ) : null}
              </>
            )}
          </section>
        </div>
      )}
    </section>
  );
}
