import { Database } from "bun:sqlite";
import { mkdir, access, writeFile, readFile, readdir, stat, unlink } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { callCodexAppServer } from "./appServerClient";
import { buildSkillSearchQueryVariants, resolveSkillSearchLookupQuery } from "../shared/skillSearchQuery";
import type {
  AgentDetailPayload,
  AgentRecord,
  AgentScope,
  BootstrapPayload,
  CreateAgentInput,
  CreateSkillInput,
  ModelRecord,
  MultiAgentSettings,
  ProjectOption,
  ReasoningEffort,
  SaveSkillInput,
  SkillDocument,
  SkillRecord,
  UpdateSettingsInput,
  UpdateAgentInput,
} from "./types";

interface ConfigReadResult {
  config: {
    model?: string;
    model_reasoning_effort?: ReasoningEffort;
    agents?: Record<string, unknown> & {
      max_threads?: unknown;
      max_depth?: unknown;
      job_max_runtime_seconds?: unknown;
    };
  };
}

interface ConfigWriteResult {
  status: "ok" | "okOverridden";
}

type ConfigMergeStrategy = "replace" | "upsert";

interface ConfigEdit {
  keyPath: string;
  value: unknown;
  mergeStrategy: ConfigMergeStrategy;
}

interface ModelListResult {
  data: Array<{
    id: string;
    model: string;
    displayName?: string;
    description?: string;
    defaultReasoningEffort?: ReasoningEffort;
    supportedReasoningEfforts?: Array<{ reasoningEffort: ReasoningEffort }>;
  }>;
}

interface SkillsListResult {
  data: Array<{
    cwd: string;
    skills: Array<{
      name: string;
      description?: string;
      path?: string;
      scope?: string;
    }>;
  }>;
}

interface GlobalStateFile {
  "electron-saved-workspace-roots"?: unknown;
  "active-workspace-roots"?: unknown;
}

interface AgentStorageLocation {
  scope: AgentScope;
  projectPath: string | null;
  agentConfigDir: string;
}

interface KnownAgentConfigFile extends AgentStorageLocation {
  configFile: string;
}

interface AgentConfigFile {
  name?: string;
  description?: string;
  model?: string;
  model_reasoning_effort?: ReasoningEffort;
  developer_instructions?: string;
  skills?: {
    config?: Array<{
      path?: string;
      enabled?: boolean;
      [key: string]: unknown;
    }>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface ResolvedAgentConfig {
  name: string;
  description: string;
  model: string;
  reasoningEffort: ReasoningEffort;
  instructions: string;
  skillPaths: string[];
}

interface SkillMarkdownParts {
  frontmatter: Record<string, unknown>;
  name: string;
  description: string;
  content: string;
  markdown: string;
}

const REMOTE_REFRESH_INTERVAL_MS = 30 * 60 * 1000;
const DEFAULT_MODEL = "gpt-5.3-codex";
const DEFAULT_REASONING: ReasoningEffort = "medium";

export class ManagerStore {
  private readonly db: Database;
  private readonly cwd: string;
  private readonly codexHome: string;
  private readonly agentConfigDir: string;

  constructor(cwd: string) {
    this.cwd = cwd;
    this.codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
    this.agentConfigDir = path.join(this.codexHome, "agents");

    const dbPath = path.join(this.codexHome, "agents-composer", "composer.db");
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS skills_catalog (
        skill_key TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        origin TEXT,
        skill_id TEXT,
        name TEXT NOT NULL,
        description TEXT,
        path TEXT,
        scope TEXT,
        installs INTEGER,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_skills (
        agent_id TEXT NOT NULL,
        skill_key TEXT NOT NULL,
        source TEXT NOT NULL,
        origin TEXT,
        skill_id TEXT,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(agent_id, skill_key)
      );

      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  async getBootstrap(refresh = false): Promise<BootstrapPayload> {
    await this.refreshLocalSkills();
    try {
      await this.refreshRemoteSkills(refresh);
    } catch {
      // Remote refresh is best-effort; don't block bootstrap.
    }

    const configRead = await this.readCodexConfig();

    const [agents, skills, models] = await Promise.all([
      this.getAgents(configRead),
      this.getSkills(),
      this.getModels(),
    ]);
    const projects = await this.getProjectOptions();
    const activeProjectPath = await this.getActiveProjectPath(projects.map((project) => project.path));

    return {
      agents,
      skills,
      models,
      projects,
      activeProjectPath,
      settings: this.getMultiAgentSettings(configRead),
    };
  }

  async getAgentDetail(agentId: string): Promise<AgentDetailPayload> {
    const [agent, allSkills, assignedSkills, models] = await Promise.all([
      this.getAgent(agentId),
      this.getSkills(),
      this.getAssignedSkills(agentId),
      this.getModels(),
    ]);

    if (!agent) {
      throw new Error(`Agent '${agentId}' not found`);
    }

    return {
      agent,
      assignedSkills,
      allSkills,
      models,
    };
  }

  async createAgent(input: CreateAgentInput): Promise<AgentRecord> {
    const agentName = this.sanitizeAgentName(input.name);
    const description = this.requireAgentField(input.description, "Agent description");
    const instructions = this.requireAgentField(
      input.instructions,
      "Agent developer instructions",
    );
    const storage = await this.resolveAgentStorageLocation(input.scope, input.projectPath);

    if (!agentName) {
      throw new Error("Agent name is required");
    }

    const configPath = path.join(storage.agentConfigDir, `${agentName}.toml`);
    if (await this.agentConfigFileExists(configPath)) {
      throw new Error(`Agent '${agentName}' already exists`);
    }
    const createdAgentId = this.createAgentRecordId(
      storage.scope,
      storage.projectPath,
      agentName,
    );
    await this.rememberProjectPathForDiscovery(storage.projectPath);
    await this.writeAgentConfigFile(configPath, {
      name: agentName,
      description,
      model: input.model || DEFAULT_MODEL,
      model_reasoning_effort: input.reasoningEffort || DEFAULT_REASONING,
      developer_instructions: instructions,
    });

    const skillKeys = Array.isArray(input.skillKeys)
      ? Array.from(
          new Set(
            input.skillKeys.filter(
              (skillKey): skillKey is string =>
                typeof skillKey === "string" && skillKey.length > 0,
            ),
          ),
        )
      : [];

    try {
      for (const skillKey of skillKeys) {
        await this.assignSkill(createdAgentId, skillKey);
      }
    } catch (error) {
      try {
        await this.deleteAgent(createdAgentId);
      } catch (rollbackError) {
        const message = error instanceof Error ? error.message : String(error);
        const rollbackMessage =
          rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
        throw new Error(`${message}. Rollback failed: ${rollbackMessage}`);
      }

      throw error;
    }

    const created = await this.getAgent(createdAgentId);
    if (!created) {
      throw new Error("Failed to create agent");
    }

    return created;
  }

  async updateAgent(agentId: string, input: UpdateAgentInput): Promise<AgentRecord> {
    const current = await this.getAgent(agentId);
    if (!current) {
      throw new Error(`Agent '${agentId}' not found`);
    }

    const nextAgentId = this.sanitizeAgentName(input.name || agentId);
    const description = this.requireAgentField(input.description, "Agent description");
    const instructions = this.requireAgentField(
      input.instructions,
      "Agent developer instructions",
    );
    const nextStorage = await this.resolveAgentStorageLocation(input.scope, input.projectPath);
    if (!nextAgentId) {
      throw new Error("Agent name is required");
    }

    const nextIdentityChanged =
      current.name !== nextAgentId ||
      current.scope !== nextStorage.scope ||
      current.projectPath !== nextStorage.projectPath;

    if (nextIdentityChanged) {
      const candidatePath = path.join(nextStorage.agentConfigDir, `${nextAgentId}.toml`);
      if (
        candidatePath !== current.configFile &&
        (await this.agentConfigFileExists(candidatePath))
      ) {
        throw new Error(`Agent '${nextAgentId}' already exists`);
      }
    }

    const nextConfigPath =
      !nextIdentityChanged
        ? current.configFile
        : path.join(nextStorage.agentConfigDir, `${nextAgentId}.toml`);
    const currentSkillPaths =
      !nextIdentityChanged
        ? []
        : await this.readAssignedSkillPathsFromConfig(current.configFile);

    await this.writeAgentConfigFile(nextConfigPath, {
      name: nextAgentId,
      description,
      model: input.model || DEFAULT_MODEL,
      model_reasoning_effort: input.reasoningEffort || DEFAULT_REASONING,
      developer_instructions: instructions,
    });
    await this.rememberProjectPathForDiscovery(nextStorage.projectPath);

    if (nextIdentityChanged) {
      await this.writeAgentSkillPaths(nextConfigPath, currentSkillPaths);
    }

    if (nextIdentityChanged) {
      const nextRecordId = this.createAgentRecordId(
        nextStorage.scope,
        nextStorage.projectPath,
        nextAgentId,
      );
      this.db
        .query(
          `INSERT OR IGNORE INTO agent_skills (
            agent_id,
            skill_key,
            source,
            origin,
            skill_id,
            name,
            created_at
          )
          SELECT
            ?1,
            skill_key,
            source,
            origin,
            skill_id,
            name,
            created_at
          FROM agent_skills
          WHERE agent_id = ?2`,
        )
        .run(nextRecordId, agentId);

      this.db.query("DELETE FROM agent_skills WHERE agent_id = ?1").run(agentId);

      if (current.configFile !== nextConfigPath) {
        try {
          await unlink(current.configFile);
        } catch {
          // Ignore cleanup errors for old config files.
        }
      }
    }

    const updatedAgentId = nextIdentityChanged
      ? this.createAgentRecordId(nextStorage.scope, nextStorage.projectPath, nextAgentId)
      : agentId;
    const updated = await this.getAgent(updatedAgentId);
    if (!updated) {
      throw new Error("Failed to reload updated agent");
    }

    return updated;
  }

  async deleteAgent(agentId: string): Promise<void> {
    const current = await this.getAgent(agentId);
    if (!current) {
      throw new Error(`Agent '${agentId}' not found`);
    }

    this.db.query("DELETE FROM agent_skills WHERE agent_id = ?1").run(agentId);

    try {
      await unlink(current.configFile);
    } catch {
      // Ignore cleanup errors for deleted agent config files.
    }
  }

  async deleteSkill(skillKey: string): Promise<void> {
    const skill = this.findSkillRecord(skillKey);
    if (!skill) {
      throw new Error(`Skill '${skillKey}' not found`);
    }
    if (skill.source !== "local") {
      throw new Error("Cannot delete a remote skill");
    }

    // Delete the skill file from disk
    if (skill.path) {
      try {
        await unlink(skill.path);
        // Remove parent directory if empty
        const dir = path.dirname(skill.path);
        const { readdir } = await import("node:fs/promises");
        const entries = await readdir(dir);
        if (entries.length === 0) {
          const { rmdir } = await import("node:fs/promises");
          await rmdir(dir);
        }
      } catch {
        // Ignore cleanup errors
      }
    }

    await this.removeSkillPathFromAllAgentConfigs(skill.path || null);

    // Remove from agent_skills (unassign from all agents)
    this.db.query("DELETE FROM agent_skills WHERE skill_key = ?1").run(skillKey);
    // Remove from skills_catalog
    this.db.query("DELETE FROM skills_catalog WHERE skill_key = ?1").run(skillKey);

    await this.refreshLocalSkills();
  }

  async assignSkill(agentId: string, skillKey: string): Promise<SkillRecord[]> {
    const agent = await this.getAgent(agentId);
    if (!agent) {
      throw new Error(`Agent '${agentId}' does not exist`);
    }

    const skill = this.findSkillRecord(skillKey);

    if (!skill) {
      throw new Error(`Skill '${skillKey}' not found`);
    }

    if (skill.source === "remote") {
      if (!skill.origin || !skill.skillId) {
        throw new Error("Remote skill is missing source metadata");
      }
      await this.installRemoteSkill(skill.origin, skill.skillId);
      await this.refreshLocalSkills();
    }

    const skillPath = await this.resolveAssignableSkillPath(skill);
    const existingSkillPaths = await this.readAssignedSkillPathsFromConfig(agent.configFile);
    if (!existingSkillPaths.includes(skillPath)) {
      await this.writeAgentSkillPaths(agent.configFile, [...existingSkillPaths, skillPath]);
    }

    this.db
      .query(
        `INSERT OR IGNORE INTO agent_skills (
          agent_id,
          skill_key,
          source,
          origin,
          skill_id,
          name,
          created_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
      )
      .run(
        agentId,
        skill.key,
        skill.source,
        skill.origin,
        skill.skillId,
        skill.name,
        Date.now(),
      );

    return this.getAssignedSkills(agentId);
  }

  async unassignSkill(agentId: string, skillKey: string): Promise<SkillRecord[]> {
    const agent = await this.getAgent(agentId);
    if (!agent) {
      throw new Error(`Agent '${agentId}' does not exist`);
    }

    const skill = this.resolveSkillRecord(skillKey);
    if (!skill) {
      throw new Error(`Skill '${skillKey}' not found`);
    }

    const skillPath = await this.resolveAssignableSkillPath(skill);
    const existingSkillPaths = await this.readAssignedSkillPathsFromConfig(agent.configFile);
    await this.writeAgentSkillPaths(
      agent.configFile,
      existingSkillPaths.filter((currentPath) => currentPath !== skillPath),
    );

    this.db
      .query(`DELETE FROM agent_skills WHERE agent_id = ?1 AND skill_key = ?2`)
      .run(agentId, skillKey);

    return this.getAssignedSkills(agentId);
  }

  async refreshSkillsCatalog(forceRemote = true): Promise<SkillRecord[]> {
    await this.refreshLocalSkills();
    try {
      await this.refreshRemoteSkills(forceRemote);
    } catch {
      // Remote refresh is best-effort; don't block local skill visibility.
    }
    return this.getSkills();
  }

  async searchSkills(query: string, refreshRemote = false): Promise<SkillRecord[]> {
    const queryVariants = buildSkillSearchQueryVariants(query);
    const lookupQuery = resolveSkillSearchLookupQuery(query);

    if (queryVariants.length === 0) {
      if (refreshRemote) {
        return this.refreshSkillsCatalog(true);
      }
      return this.getSkills();
    }

    if (refreshRemote) {
      await this.refreshSkillsCatalog(true);
    }

    let matches = this.getSkills().filter((skill) =>
      this.matchesSkillQuery(skill, queryVariants),
    );

    const shouldLookupRemote =
      !lookupQuery.startsWith("local:") &&
      lookupQuery.length >= 3;

    if (!shouldLookupRemote) {
      return matches;
    }

    try {
      const discovered = await this.searchRemoteSkillsByQuery(lookupQuery);

      if (discovered.length === 0) {
        return matches;
      }

      this.upsertRemoteSkills(discovered);
      matches = this.getSkills().filter((skill) =>
        this.matchesSkillQuery(skill, queryVariants),
      );
      return matches;
    } catch {
      return matches;
    }
  }

  async getSkillDocument(skillKey: string): Promise<SkillDocument> {
    const skill = this.resolveSkillRecord(skillKey);
    if (!skill) {
      throw new Error(`Skill '${skillKey}' not found`);
    }

    let markdown = "";

    if (skill.source === "remote") {
      const remoteMarkdown =
        skill.origin && skill.skillId
          ? await this.fetchRemoteSkillMarkdown(skill.origin, skill.skillId)
          : null;

      markdown = remoteMarkdown || [
        `# ${skill.name}`,
        "",
        "Remote skill preview is not available yet for this repository layout.",
        "",
        skill.origin && skill.skillId
          ? `Try opening: https://github.com/${skill.origin}/tree/main/skills/${skill.skillId}`
          : "",
      ].filter(Boolean).join("\n");
    } else if (skill.path) {
      try {
        markdown = await readFile(skill.path, "utf8");
      } catch {
        markdown = "";
      }
    }

    const parsed = this.parseSkillMarkdown(markdown, skill.name);

    return {
      skill,
      markdown: parsed.markdown,
      name: parsed.name,
      description: parsed.description,
      content: parsed.content,
    };
  }

  private async fetchRemoteSkillMarkdown(
    origin: string,
    skillId: string,
  ): Promise<string | null> {
    const variants = Array.from(
      new Set([
        skillId,
        skillId.toLowerCase(),
        skillId.replace(/_/g, "-"),
        skillId.replace(/-/g, "_"),
        `${skillId}-skill`,
        `${skillId.toLowerCase()}-skill`,
        `${skillId.replace(/_/g, "-")}-skill`,
        `${skillId.replace(/-/g, "_")}-skill`,
      ]),
    );

    const branches = ["main", "master"];
    const paths = variants.flatMap((variant) => [
      `skills/${variant}/SKILL.md`,
      `${variant}/SKILL.md`,
      `skills/${variant}/skill.md`,
      `${variant}/skill.md`,
    ]);

    for (const branch of branches) {
      for (const filePath of paths) {
        const markdown = await this.fetchRawGithubMarkdown(origin, branch, filePath);
        if (markdown) {
          return markdown;
        }
      }
    }

    // Fallback: scan repository tree and pick the best matching SKILL.md path.
    for (const branch of branches) {
      const treePath = await this.findSkillPathInGithubTree(origin, branch, skillId);
      if (!treePath) continue;

      const markdown = await this.fetchRawGithubMarkdown(origin, branch, treePath);
      if (markdown) {
        return markdown;
      }
    }

    return null;
  }

  private async fetchRawGithubMarkdown(
    origin: string,
    branch: string,
    filePath: string,
  ): Promise<string | null> {
    const url = `https://raw.githubusercontent.com/${origin}/${branch}/${filePath}`;

    try {
      const response = await fetch(url);
      if (!response.ok) return null;

      const markdown = await response.text();
      const cleaned = markdown.trim();
      if (!cleaned || cleaned === "404: Not Found") return null;

      return markdown;
    } catch {
      return null;
    }
  }

  private async findSkillPathInGithubTree(
    origin: string,
    branch: string,
    skillId: string,
  ): Promise<string | null> {
    const url = `https://api.github.com/repos/${origin}/git/trees/${branch}?recursive=1`;

    try {
      const response = await fetch(url, {
        headers: {
          accept: "application/vnd.github+json",
        },
      });

      if (!response.ok) return null;

      const payload = (await response.json()) as {
        tree?: Array<{ path?: string; type?: string }>;
      };

      const candidates = (payload.tree || [])
        .filter((entry) => entry.type === "blob" && typeof entry.path === "string")
        .map((entry) => entry.path as string)
        .filter((pathValue) => /(^|\/)skill\.md$/i.test(pathValue));

      if (candidates.length === 0) return null;

      const normalizedSkill = skillId.toLowerCase().replace(/[_\s]+/g, "-");
      const normalizedNoSymbols = normalizedSkill.replace(/[-_]/g, "");

      let bestPath: string | null = null;
      let bestScore = Number.NEGATIVE_INFINITY;

      for (const candidate of candidates) {
        const lower = candidate.toLowerCase();
        const dir = lower.replace(/\/skill\.md$/i, "");
        const segments = dir.split("/").filter(Boolean);
        const lastSegment = segments[segments.length - 1] || "";
        const compactLast = lastSegment.replace(/[-_]/g, "");

        let score = 0;

        if (lastSegment === normalizedSkill) score += 120;
        if (lastSegment === `${normalizedSkill}-skill`) score += 115;
        if (lastSegment === `${normalizedSkill}_skill`) score += 112;
        if (lastSegment.includes(normalizedSkill)) score += 70;

        if (compactLast === normalizedNoSymbols) score += 80;
        if (compactLast === `${normalizedNoSymbols}skill`) score += 75;

        if (lower.includes(`/skills/${normalizedSkill}`)) score += 20;
        if (lower.includes(`/skills/${normalizedSkill}-skill`)) score += 18;

        // Slight preference for shallower paths after semantic matching.
        score -= segments.length;

        if (score > bestScore) {
          bestScore = score;
          bestPath = candidate;
        }
      }

      return bestPath;
    } catch {
      return null;
    }
  }

  async saveSkillDocument(skillKey: string, input: SaveSkillInput): Promise<SkillDocument> {
    const document = await this.getSkillDocument(skillKey);

    const nextName = (input.name || document.name || document.skill.name).trim();
    if (!nextName) {
      throw new Error("Skill name is required");
    }

    const nextDescription = (input.description || "").trim();
    if (!nextDescription) {
      throw new Error("Skill description is required");
    }

    const nextContent = input.content || "";
    if (!nextContent.trim()) {
      throw new Error("Skill instructions are required");
    }
    const current = this.parseSkillMarkdown(document.markdown, nextName);

    const markdown = this.serializeSkillMarkdown({
      frontmatter: current.frontmatter,
      name: nextName,
      description: nextDescription,
      content: nextContent,
    });

    if (document.skill.source === "remote") {
      const baseSlug = this.sanitizeSkillName(nextName || document.skill.skillId || document.skill.name);
      if (!baseSlug) {
        throw new Error("Unable to determine local skill name");
      }

      const { skillPath } = await this.resolveNextLocalSkillPath(baseSlug);
      await mkdir(path.dirname(skillPath), { recursive: true });
      await writeFile(skillPath, markdown, "utf8");
      await this.refreshLocalSkills();
      this.upsertLocalSkillCatalogEntry(skillPath, nextName, nextDescription || null);

      return this.getSkillDocument(`local:${skillPath}`);
    }

    const localPath = document.skill.path;
    if (!localPath) {
      throw new Error("Local skill path is missing");
    }

    await mkdir(path.dirname(localPath), { recursive: true });
    await writeFile(localPath, markdown, "utf8");
    await this.refreshLocalSkills();
    this.upsertLocalSkillCatalogEntry(localPath, nextName, nextDescription || null);

    return this.getSkillDocument(`local:${localPath}`);
  }

  async createSkill(input: CreateSkillInput): Promise<SkillDocument> {
    const slug = this.sanitizeSkillName(input.name);

    if (!slug) {
      throw new Error("Skill name is required");
    }

    const description = (input.description || "").trim();
    if (!description) {
      throw new Error("Skill description is required");
    }

    const skillDir = path.join(this.codexHome, "skills", slug);
    const skillPath = path.join(skillDir, "SKILL.md");

    try {
      await access(skillPath, fsConstants.F_OK);
      throw new Error(`Skill '${slug}' already exists`);
    } catch (error) {
      if (error instanceof Error && !error.message.includes("no such file")) {
        const anyError = error as NodeJS.ErrnoException;
        if (anyError.code !== "ENOENT") {
          throw error;
        }
      }
    }

    const content = input.content || "";
    if (!content.trim()) {
      throw new Error("Skill instructions are required");
    }

    const markdown = this.serializeSkillMarkdown({
      frontmatter: {},
      name: input.name.trim() || slug,
      description,
      content,
    });

    await mkdir(skillDir, { recursive: true });
    await writeFile(skillPath, markdown, "utf8");

    await this.refreshLocalSkills();
    // Ensure the skill is in the catalog even if the app server didn't discover it
    this.upsertLocalSkillCatalogEntry(skillPath, input.name.trim() || slug, description);

    const skillKey = `local:${skillPath}`;
    return this.getSkillDocument(skillKey);
  }

  async updateSettings(input: UpdateSettingsInput): Promise<MultiAgentSettings> {
    await this.writeAgentConfigValues([
      {
        keyPath: "agents.max_threads",
        value: input.maxThreads,
        mergeStrategy: "upsert",
      },
      {
        keyPath: "agents.max_depth",
        value: input.maxDepth,
        mergeStrategy: "upsert",
      },
      {
        keyPath: "agents.job_max_runtime_seconds",
        value: input.jobMaxRuntimeSeconds,
        mergeStrategy: "upsert",
      },
    ]);

    const configRead = await this.readCodexConfig();
    return this.getMultiAgentSettings(configRead);
  }

  private async getAgent(agentId: string): Promise<AgentRecord | null> {
    const agents = await this.getAgents();
    return agents.find((agent) => agent.id === agentId) ?? null;
  }

  private async getAgents(configRead?: ConfigReadResult): Promise<AgentRecord[]> {
    const resolvedConfig = configRead || (await this.readCodexConfig());
    const globalModel = resolvedConfig.config.model || DEFAULT_MODEL;
    const globalReasoning =
      resolvedConfig.config.model_reasoning_effort || DEFAULT_REASONING;
    const configFiles = await this.listKnownAgentConfigFiles();

    const agents = await Promise.all(
      configFiles.map(async ({ configFile, projectPath, scope }) => {
        const fallbackName = path.basename(configFile, ".toml");
        const parsedConfig = await this.readAgentConfigFile(
          configFile,
          fallbackName,
          "",
          globalModel,
          globalReasoning,
        );

        return {
          id: this.createAgentRecordId(scope, projectPath, parsedConfig.name),
          name: parsedConfig.name,
          description: parsedConfig.description,
          scope,
          projectPath,
          model: parsedConfig.model,
          reasoningEffort: parsedConfig.reasoningEffort,
          instructions: parsedConfig.instructions,
          configFile,
          skillCount: parsedConfig.skillPaths.length,
        } satisfies AgentRecord;
      }),
    );

    return agents
      .filter((agent): agent is AgentRecord => Boolean(agent))
      .sort((a, b) => {
        const nameCompare = a.name.localeCompare(b.name);
        if (nameCompare !== 0) return nameCompare;
        if (a.scope !== b.scope) return a.scope === "global" ? -1 : 1;
        return (a.projectPath || "").localeCompare(b.projectPath || "");
      });
  }

  private async getProjectOptions(): Promise<ProjectOption[]> {
    const paths = await this.getConfiguredProjectPaths();
    return paths.map((projectPath) => ({
      path: projectPath,
      label: projectPath,
    }));
  }

  private async getActiveProjectPath(
    knownProjectPaths: string[],
  ): Promise<string | null> {
    const globalStatePath = path.join(this.codexHome, ".codex-global-state.json");

    try {
      const content = await readFile(globalStatePath, "utf8");
      const parsed = JSON.parse(content) as GlobalStateFile;
      const activePaths = await this.normalizeKnownProjectPaths(
        this.readStringArray(parsed["active-workspace-roots"]),
      );
      return activePaths.find((entry) => knownProjectPaths.includes(entry)) || null;
    } catch {
      return null;
    }
  }

  private getMultiAgentSettings(configRead: ConfigReadResult): MultiAgentSettings {
    const agentsSection = configRead.config.agents || {};

    return {
      maxThreads: this.parseOptionalPositiveInteger(agentsSection.max_threads),
      maxDepth: this.parseOptionalPositiveInteger(agentsSection.max_depth),
      jobMaxRuntimeSeconds: this.parseOptionalPositiveInteger(
        agentsSection.job_max_runtime_seconds,
      ),
    };
  }

  private async getModels(): Promise<ModelRecord[]> {
    const modelResult = await callCodexAppServer<ModelListResult>(
      "model/list",
      {},
    );

    return modelResult.data.map((model) => ({
      id: model.model || model.id,
      displayName: model.displayName || model.model || model.id,
      description: model.description || "",
      defaultReasoningEffort:
        model.defaultReasoningEffort || DEFAULT_REASONING,
      supportedReasoningEfforts:
        model.supportedReasoningEfforts?.map((entry) => entry.reasoningEffort) ||
        [DEFAULT_REASONING],
    }));
  }

  private getSkills(): SkillRecord[] {
    return this.db
      .query(
        `SELECT
          skill_key as key,
          source,
          origin,
          skill_id as skillId,
          name,
          description,
          path,
          scope,
          installs
         FROM skills_catalog
         ORDER BY
           CASE WHEN source = 'local' THEN 0 ELSE 1 END,
           installs DESC,
           name ASC`,
      )
      .all() as SkillRecord[];
  }

  private async getAssignedSkills(agentId: string): Promise<SkillRecord[]> {
    const agent = await this.getAgent(agentId);
    if (!agent) {
      return [];
    }

    const skillPaths = await this.readAssignedSkillPathsFromConfig(agent.configFile);
    return skillPaths.map((skillPath) => this.resolveSkillRecordByPath(skillPath));
  }

  private findSkillRecord(skillKey: string): SkillRecord | null {
    return this.db
      .query(
        `SELECT
          skill_key as key,
          source,
          origin,
          skill_id as skillId,
          name,
          description,
          path,
          scope,
          installs
         FROM skills_catalog
         WHERE skill_key = ?1`,
      )
      .get(skillKey) as SkillRecord | null;
  }

  private findAssignedSkillRecord(skillKey: string): SkillRecord | null {
    return this.db
      .query(
        `SELECT
          a.skill_key as key,
          a.source as source,
          a.origin as origin,
          a.skill_id as skillId,
          a.name as name,
          c.description as description,
          c.path as path,
          c.scope as scope,
          c.installs as installs
         FROM agent_skills a
         LEFT JOIN skills_catalog c
           ON c.skill_key = a.skill_key
         WHERE a.skill_key = ?1
         ORDER BY a.created_at DESC
         LIMIT 1`,
      )
      .get(skillKey) as SkillRecord | null;
  }

  private findSkillRecordByPath(skillPath: string): SkillRecord | null {
    return this.db
      .query(
        `SELECT
          skill_key as key,
          source,
          origin,
          skill_id as skillId,
          name,
          description,
          path,
          scope,
          installs
         FROM skills_catalog
         WHERE path = ?1
         LIMIT 1`,
      )
      .get(skillPath) as SkillRecord | null;
  }

  private resolveSkillRecord(skillKey: string): SkillRecord | null {
    const catalog = this.findSkillRecord(skillKey);
    if (catalog) {
      return catalog;
    }

    const assigned = this.findAssignedSkillRecord(skillKey);
    if (assigned) {
      if (assigned.source === "local" && !assigned.path && assigned.key.startsWith("local:")) {
        assigned.path = assigned.key.slice("local:".length);
      }
      return assigned;
    }

    if (skillKey.startsWith("local:")) {
      const localPath = skillKey.slice("local:".length);
      const name = path.basename(path.dirname(localPath)) || path.basename(localPath) || "local-skill";
      return {
        key: skillKey,
        source: "local",
        origin: null,
        skillId: null,
        name,
        description: null,
        path: localPath,
        scope: null,
        installs: null,
      };
    }

    if (skillKey.startsWith("remote:")) {
      const ref = skillKey.slice("remote:".length);
      const separatorIndex = ref.lastIndexOf("/");
      const origin = separatorIndex > 0 ? ref.slice(0, separatorIndex) : null;
      const skillId = separatorIndex > 0 ? ref.slice(separatorIndex + 1) : null;
      return {
        key: skillKey,
        source: "remote",
        origin,
        skillId,
        name: skillId || ref,
        description: null,
        path: null,
        scope: null,
        installs: null,
      };
    }

    return null;
  }

  private resolveSkillRecordByPath(skillPath: string): SkillRecord {
    const catalog = this.findSkillRecordByPath(skillPath);
    if (catalog) {
      return catalog;
    }

    return {
      key: `local:${skillPath}`,
      source: "local",
      origin: null,
      skillId: null,
      name: path.basename(path.dirname(skillPath)) || path.basename(skillPath) || "local-skill",
      description: null,
      path: skillPath,
      scope: null,
      installs: null,
    };
  }

  private async readCodexConfig(): Promise<ConfigReadResult> {
    return callCodexAppServer<ConfigReadResult>("config/read", {
      includeLayers: false,
      cwd: this.cwd,
    });
  }

  private parseOptionalPositiveInteger(value: unknown): number | null {
    if (typeof value === "number" && Number.isInteger(value) && value > 0) {
      return value;
    }

    if (typeof value === "string") {
      const parsed = Number(value.trim());
      if (Number.isInteger(parsed) && parsed > 0) {
        return parsed;
      }
    }

    return null;
  }

  private requireAgentField(value: string, label: string): string {
    const trimmed = value.trim();
    if (!trimmed) {
      throw new Error(`${label} is required`);
    }
    return trimmed;
  }

  private async writeAgentConfigValues(edits: ConfigEdit[]): Promise<void> {
    const result = await callCodexAppServer<ConfigWriteResult>(
      "config/batchWrite",
      { edits },
    );

    if (!result || (result.status !== "ok" && result.status !== "okOverridden")) {
      throw new Error("Failed to write config values");
    }
  }

  private async readAgentConfigFile(
    configFile: string,
    fallbackName: string,
    fallbackDescription: string,
    fallbackModel: string,
    fallbackReasoning: ReasoningEffort,
  ): Promise<ResolvedAgentConfig> {
    try {
      await access(configFile, fsConstants.F_OK);
      const content = await Bun.file(configFile).text();
      const parsed = Bun.TOML.parse(content) as AgentConfigFile;

      return {
        name: parsed.name || fallbackName,
        description: parsed.description || fallbackDescription,
        model: parsed.model || fallbackModel,
        reasoningEffort: parsed.model_reasoning_effort || fallbackReasoning,
        instructions: parsed.developer_instructions || "",
        skillPaths: this.parseAgentSkillPaths(parsed),
      };
    } catch {
      return {
        name: fallbackName,
        description: fallbackDescription,
        model: fallbackModel,
        reasoningEffort: fallbackReasoning,
        instructions: "",
        skillPaths: [],
      };
    }
  }

  private async writeAgentConfigFile(
    configFile: string,
    data: AgentConfigFile,
  ): Promise<void> {
    await mkdir(path.dirname(configFile), { recursive: true });

    const existing = await this.readRawAgentConfig(configFile);
    const nextConfig: AgentConfigFile = {
      ...existing,
      name: data.name || "",
      description: data.description || "",
      model: data.model || DEFAULT_MODEL,
      model_reasoning_effort: data.model_reasoning_effort || DEFAULT_REASONING,
      developer_instructions: data.developer_instructions || "",
    };

    await writeFile(configFile, this.stringifyAgentConfig(nextConfig), "utf8");
  }

  private async readRawAgentConfig(configFile: string): Promise<AgentConfigFile> {
    try {
      await access(configFile, fsConstants.F_OK);
      const content = await Bun.file(configFile).text();
      const parsed = Bun.TOML.parse(content);
      return this.isTomlTable(parsed) ? (parsed as AgentConfigFile) : {};
    } catch {
      return {};
    }
  }

  private parseAgentSkillPaths(config: AgentConfigFile): string[] {
    const entries = config.skills?.config;
    if (!Array.isArray(entries)) {
      return [];
    }

    return entries
      .filter(
        (entry): entry is { path: string; enabled?: boolean } =>
          Boolean(entry) &&
          typeof entry === "object" &&
          typeof entry.path === "string" &&
          entry.path.trim().length > 0 &&
          entry.enabled !== false,
      )
      .map((entry) => entry.path.trim());
  }

  private async readAssignedSkillPathsFromConfig(configFile: string): Promise<string[]> {
    const config = await this.readRawAgentConfig(configFile);
    return this.parseAgentSkillPaths(config);
  }

  private async writeAgentSkillPaths(
    configFile: string,
    skillPaths: string[],
  ): Promise<void> {
    const existing = await this.readRawAgentConfig(configFile);
    const dedupedSkillPaths = Array.from(new Set(skillPaths.map((value) => value.trim()).filter(Boolean)));
    const nextConfig: AgentConfigFile = { ...existing };
    const existingSkillsSection = this.isTomlTable(existing.skills) ? { ...existing.skills } : {};

    if (dedupedSkillPaths.length === 0) {
      delete existingSkillsSection.config;
      if (Object.keys(existingSkillsSection).length === 0) {
        delete nextConfig.skills;
      } else {
        nextConfig.skills = existingSkillsSection;
      }
    } else {
      nextConfig.skills = {
        ...existingSkillsSection,
        config: dedupedSkillPaths.map((skillPath) => ({
          path: skillPath,
          enabled: true,
        })),
      };
    }

    await writeFile(configFile, this.stringifyAgentConfig(nextConfig), "utf8");
  }

  private async removeSkillPathFromAllAgentConfigs(skillPath: string | null): Promise<void> {
    if (!skillPath) {
      return;
    }

    const configFiles = await this.listKnownAgentConfigFiles();
    await Promise.all(
      configFiles.map(async ({ configFile }) => {
        const currentPaths = await this.readAssignedSkillPathsFromConfig(configFile);
        if (!currentPaths.includes(skillPath)) {
          return;
        }

        await this.writeAgentSkillPaths(
          configFile,
          currentPaths.filter((currentPath) => currentPath !== skillPath),
        );
      }),
    );
  }

  private async resolveAssignableSkillPath(skill: SkillRecord): Promise<string> {
    if (skill.path) {
      return skill.path;
    }

    if (skill.source === "local" && skill.key.startsWith("local:")) {
      return skill.key.slice("local:".length);
    }

    if (skill.source === "remote" && skill.skillId) {
      const localSkills = this.getSkills().filter((entry) => entry.source === "local" && entry.path);
      const installed = localSkills.find((entry) => {
        if (!entry.path) return false;
        const pathSkillId = path.basename(path.dirname(entry.path));
        return pathSkillId === skill.skillId || entry.name === skill.skillId;
      });

      if (installed?.path) {
        return installed.path;
      }
    }

    throw new Error(`Skill '${skill.name}' is missing a local path`);
  }

  private stringifyAgentConfig(config: AgentConfigFile): string {
    const lines: string[] = [];
    this.writeTomlSection(lines, [], config);

    if (lines[lines.length - 1] !== "") {
      lines.push("");
    }

    return lines.join("\n");
  }

  private writeTomlSection(
    lines: string[],
    pathSegments: string[],
    value: Record<string, unknown>,
  ): void {
    const scalarEntries: Array<[string, unknown]> = [];
    const tableEntries: Array<[string, Record<string, unknown>]> = [];
    const arrayTableEntries: Array<[string, Array<Record<string, unknown>>]> = [];

    for (const [key, entryValue] of Object.entries(value)) {
      if (entryValue === undefined || entryValue === null) {
        continue;
      }

      if (this.isTomlTable(entryValue)) {
        tableEntries.push([key, entryValue]);
        continue;
      }

      if (this.isArrayOfTomlTables(entryValue)) {
        arrayTableEntries.push([key, entryValue]);
        continue;
      }

      scalarEntries.push([key, entryValue]);
    }

    if (pathSegments.length > 0 && scalarEntries.length > 0) {
      this.ensureTomlSectionSpacing(lines);
      lines.push(`[${pathSegments.map((segment) => this.formatTomlKey(segment)).join(".")}]`);
    }

    for (const [key, entryValue] of scalarEntries) {
      lines.push(`${this.formatTomlKey(key)} = ${this.formatTomlValue(entryValue, key)}`);
    }

    for (const [key, childValue] of tableEntries) {
      this.writeTomlSection(lines, [...pathSegments, key], childValue);
    }

    for (const [key, items] of arrayTableEntries) {
      for (const item of items) {
        this.writeTomlArrayTable(lines, [...pathSegments, key], item);
      }
    }
  }

  private writeTomlArrayTable(
    lines: string[],
    pathSegments: string[],
    value: Record<string, unknown>,
  ): void {
    const scalarEntries: Array<[string, unknown]> = [];
    const tableEntries: Array<[string, Record<string, unknown>]> = [];
    const arrayTableEntries: Array<[string, Array<Record<string, unknown>>]> = [];

    for (const [key, entryValue] of Object.entries(value)) {
      if (entryValue === undefined || entryValue === null) {
        continue;
      }

      if (this.isTomlTable(entryValue)) {
        tableEntries.push([key, entryValue]);
        continue;
      }

      if (this.isArrayOfTomlTables(entryValue)) {
        arrayTableEntries.push([key, entryValue]);
        continue;
      }

      scalarEntries.push([key, entryValue]);
    }

    this.ensureTomlSectionSpacing(lines);
    lines.push(`[[${pathSegments.map((segment) => this.formatTomlKey(segment)).join(".")}]]`);

    for (const [key, entryValue] of scalarEntries) {
      lines.push(`${this.formatTomlKey(key)} = ${this.formatTomlValue(entryValue, key)}`);
    }

    for (const [key, childValue] of tableEntries) {
      this.writeTomlSection(lines, [...pathSegments, key], childValue);
    }

    for (const [key, items] of arrayTableEntries) {
      for (const item of items) {
        this.writeTomlArrayTable(lines, [...pathSegments, key], item);
      }
    }
  }

  private ensureTomlSectionSpacing(lines: string[]): void {
    if (lines.length === 0) {
      return;
    }

    if (lines[lines.length - 1] !== "") {
      lines.push("");
    }
  }

  private formatTomlKey(key: string): string {
    return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
  }

  private formatTomlValue(value: unknown, key?: string): string {
    if (typeof value === "string") {
      return this.formatTomlString(value, key === "developer_instructions");
    }

    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        throw new Error("Cannot serialize non-finite number in agent config");
      }
      return String(value);
    }

    if (typeof value === "boolean") {
      return value ? "true" : "false";
    }

    if (value instanceof Date) {
      return value.toISOString();
    }

    if (Array.isArray(value)) {
      return `[${value.map((entry) => this.formatTomlValue(entry)).join(", ")}]`;
    }

    throw new Error(`Unsupported agent config value: ${String(value)}`);
  }

  private formatTomlString(value: string, forceMultiline = false): string {
    const normalized = value.replace(/\r\n/g, "\n");
    if (!forceMultiline && !normalized.includes("\n")) {
      return JSON.stringify(normalized);
    }

    const escaped = normalized
      .replace(/\\/g, "\\\\")
      .replace(/"""/g, '\\"""');

    return `"""\n${escaped}\n"""`;
  }

  private isTomlTable(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date);
  }

  private isArrayOfTomlTables(value: unknown): value is Array<Record<string, unknown>> {
    return Array.isArray(value) && value.length > 0 && value.every((entry) => this.isTomlTable(entry));
  }

  private async listKnownAgentConfigFiles(): Promise<KnownAgentConfigFile[]> {
    const locations = await this.getAgentStorageLocations();
    const configFiles = await Promise.all(
      locations.map(async (location) => {
        try {
          const entries = await readdir(location.agentConfigDir, { withFileTypes: true });
          return entries
            .filter((entry) => entry.isFile() && entry.name.endsWith(".toml"))
            .map((entry) => ({
              ...location,
              configFile: path.join(location.agentConfigDir, entry.name),
            }));
        } catch {
          return [] as KnownAgentConfigFile[];
        }
      }),
    );

    return configFiles.flat().sort((a, b) => a.configFile.localeCompare(b.configFile));
  }

  private async getAgentStorageLocations(): Promise<AgentStorageLocation[]> {
    const projectPaths = await this.getKnownProjectPathsForDiscovery();
    return [
      {
        scope: "global",
        projectPath: null,
        agentConfigDir: this.agentConfigDir,
      },
      ...projectPaths.map((projectPath) => ({
        scope: "project" as const,
        projectPath,
        agentConfigDir: path.join(projectPath, ".codex", "agents"),
      })),
    ];
  }

  private async resolveAgentStorageLocation(
    scope: AgentScope,
    projectPathInput: string | null,
  ): Promise<AgentStorageLocation> {
    if (scope === "global") {
      return {
        scope,
        projectPath: null,
        agentConfigDir: this.agentConfigDir,
      };
    }

    if (scope !== "project") {
      throw new Error(`Unsupported agent scope '${String(scope)}'`);
    }

    const projectPath = await this.resolveProjectRootPath(projectPathInput);
    return {
      scope,
      projectPath,
      agentConfigDir: path.join(projectPath, ".codex", "agents"),
    };
  }

  private async resolveProjectRootPath(projectPathInput: string | null): Promise<string> {
    const trimmed = (projectPathInput || "").trim();
    if (!trimmed) {
      throw new Error("Project folder is required for project-specific agents");
    }

    const expanded =
      trimmed === "~"
        ? os.homedir()
        : trimmed.startsWith("~/")
          ? path.join(os.homedir(), trimmed.slice(2))
          : trimmed;
    const resolved = path.isAbsolute(expanded)
      ? path.normalize(expanded)
      : path.resolve(this.cwd, expanded);

    try {
      const entry = await stat(resolved);
      if (!entry.isDirectory()) {
        throw new Error("Project folder must be a directory");
      }
    } catch (error) {
      if (error instanceof Error && error.message === "Project folder must be a directory") {
        throw error;
      }
      throw new Error(`Project folder '${resolved}' does not exist`);
    }

    return resolved;
  }

  private createAgentRecordId(
    scope: AgentScope,
    projectPath: string | null,
    name: string,
  ): string {
    return Buffer.from(
      JSON.stringify({
        scope,
        projectPath,
        name,
      }),
    ).toString("base64url");
  }

  private async getConfiguredProjectPaths(): Promise<string[]> {
    const globalStateProjects = await this.readProjectPathsFromGlobalState();
    if (globalStateProjects.length > 0) {
      return globalStateProjects;
    }

    return this.readProjectPathsFromConfigFile();
  }

  private async getKnownProjectPathsForDiscovery(): Promise<string[]> {
    return this.normalizeKnownProjectPaths([
      ...(await this.getConfiguredProjectPaths()),
      ...this.getPersistedProjectPaths(),
    ]);
  }

  private async readProjectPathsFromGlobalState(): Promise<string[]> {
    const globalStatePath = path.join(this.codexHome, ".codex-global-state.json");

    try {
      const content = await readFile(globalStatePath, "utf8");
      const parsed = JSON.parse(content) as GlobalStateFile;
      return this.normalizeKnownProjectPaths([
        ...this.readStringArray(parsed["active-workspace-roots"]),
        ...this.readStringArray(parsed["electron-saved-workspace-roots"]),
      ]);
    } catch {
      return [];
    }
  }

  private async readProjectPathsFromConfigFile(): Promise<string[]> {
    const configPath = path.join(this.codexHome, "config.toml");

    try {
      const content = await readFile(configPath, "utf8");
      const parsed = Bun.TOML.parse(content) as { projects?: Record<string, unknown> };
      return this.normalizeKnownProjectPaths(Object.keys(parsed.projects || {}));
    } catch {
      return [];
    }
  }

  private async normalizeKnownProjectPaths(paths: string[]): Promise<string[]> {
    const seen = new Set<string>();
    const result: string[] = [];

    for (const candidate of paths) {
      const trimmed = candidate.trim();
      if (!trimmed) continue;

      const resolved = path.normalize(trimmed);
      if (seen.has(resolved)) continue;

      try {
        const entry = await stat(resolved);
        if (!entry.isDirectory()) {
          continue;
        }
      } catch {
        continue;
      }

      seen.add(resolved);
      result.push(resolved);
    }

    return result;
  }

  private async agentConfigFileExists(configPath: string): Promise<boolean> {
    try {
      await access(configPath, fsConstants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  private getPersistedProjectPaths(): string[] {
    const raw = this.getMetadata("project_specific_agent_roots");
    if (!raw) {
      return [];
    }

    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed)
        ? parsed.filter((entry): entry is string => typeof entry === "string")
        : [];
    } catch {
      return [];
    }
  }

  private async rememberProjectPathForDiscovery(projectPath: string | null): Promise<void> {
    if (!projectPath) {
      return;
    }

    const nextPaths = await this.normalizeKnownProjectPaths([
      ...this.getPersistedProjectPaths(),
      projectPath,
    ]);
    this.setMetadata("project_specific_agent_roots", JSON.stringify(nextPaths));
  }

  private readStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return value.filter((entry): entry is string => typeof entry === "string");
  }

  private upsertLocalSkillCatalogEntry(
    skillPath: string,
    name: string,
    description: string | null,
  ): void {
    const skillKey = `local:${skillPath}`;
    this.db
      .query(
        `INSERT INTO skills_catalog (
          skill_key, source, origin, skill_id, name, description, path, scope, installs, updated_at
        ) VALUES (?1, 'local', NULL, NULL, ?2, ?3, ?4, NULL, NULL, ?5)
        ON CONFLICT(skill_key) DO UPDATE SET
          name = excluded.name,
          description = excluded.description,
          path = excluded.path,
          updated_at = excluded.updated_at`,
      )
      .run(skillKey, name, description, skillPath, Date.now());
  }

  private async refreshLocalSkills(): Promise<void> {
    const result = await callCodexAppServer<SkillsListResult>("skills/list", {
      cwds: [this.cwd],
      forceReload: true,
    });

    this.db.query("DELETE FROM skills_catalog WHERE source = 'local'").run();

    const upsert = this.db.query(
      `INSERT INTO skills_catalog (
        skill_key,
        source,
        origin,
        skill_id,
        name,
        description,
        path,
        scope,
        installs,
        updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
      ON CONFLICT(skill_key) DO UPDATE SET
        name = excluded.name,
        description = excluded.description,
        path = excluded.path,
        scope = excluded.scope,
        updated_at = excluded.updated_at`,
    );

    const now = Date.now();
    for (const bucket of result.data) {
      for (const skill of bucket.skills) {
        const skillKey = `local:${skill.path || skill.name}`;
        upsert.run(
          skillKey,
          "local",
          null,
          null,
          skill.name,
          skill.description || null,
          skill.path || null,
          skill.scope || null,
          null,
          now,
        );
      }
    }
  }

  private async refreshRemoteSkills(force = false): Promise<void> {
    const lastRefresh = Number(this.getMetadata("remote_refresh_ts") || "0");
    const now = Date.now();
    if (!force && now - lastRefresh < REMOTE_REFRESH_INTERVAL_MS) {
      return;
    }

    const response = await fetch("https://skills.sh", {
      headers: {
        accept: "text/html",
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch skills.sh (${response.status})`);
    }

    const html = await response.text();
    const remoteSkills = this.parseRemoteSkillsFromRscPayload(html);

    if (remoteSkills.length === 0) {
      throw new Error("No remote skills found in skills.sh payload");
    }

    this.db.query("DELETE FROM skills_catalog WHERE source = 'remote'").run();

    const upsert = this.db.query(
      `INSERT INTO skills_catalog (
        skill_key,
        source,
        origin,
        skill_id,
        name,
        description,
        path,
        scope,
        installs,
        updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, NULL, NULL, NULL, ?6, ?7)
      ON CONFLICT(skill_key) DO UPDATE SET
        origin = excluded.origin,
        skill_id = excluded.skill_id,
        name = excluded.name,
        installs = excluded.installs,
        updated_at = excluded.updated_at`,
    );

    for (const skill of remoteSkills) {
      upsert.run(
        skill.key,
        "remote",
        skill.origin,
        skill.skillId,
        skill.name,
        skill.installs,
        now,
      );
    }

    this.setMetadata("remote_refresh_ts", String(now));
  }

  private parseRemoteSkillsFromRscPayload(html: string): Array<{
    key: string;
    origin: string;
    skillId: string;
    name: string;
    installs: number;
  }> {
    const byKey = new Map<
      string,
      { key: string; origin: string; skillId: string; name: string; installs: number }
    >();

    const escapedPattern =
      /\\"source\\":\\"([^"\\]+)\\",\\"skillId\\":\\"([^"\\]+)\\",\\"name\\":\\"([^"\\]+)\\",\\"installs\\":(\d+)/g;
    const plainPattern =
      /"source":"([^"]+)","skillId":"([^"]+)","name":"([^"]+)","installs":(\d+)/g;

    const collectMatches = (pattern: RegExp) => {
      for (const match of html.matchAll(pattern)) {
        const origin = match[1]?.trim();
        const skillId = match[2]?.trim();
        const name = match[3]?.trim();
        const installs = Number(match[4] || "0");

        if (!origin || !skillId || !name) continue;
        const key = `remote:${origin}/${skillId}`;
        const existing = byKey.get(key);
        if (!existing || installs > existing.installs) {
          byKey.set(key, {
            key,
            origin,
            skillId,
            name,
            installs,
          });
        }
      }
    };

    collectMatches(escapedPattern);
    if (byKey.size === 0) {
      collectMatches(plainPattern);
    }

    return Array.from(byKey.values()).sort((a, b) => b.installs - a.installs);
  }

  private async installRemoteSkill(origin: string, skillId: string): Promise<void> {
    const command = [
      "npx",
      "-y",
      "skills",
      "add",
      origin,
      "-g",
      "-a",
      "codex",
      "-s",
      skillId,
      "-y",
    ];

    const proc = Bun.spawn(command, {
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    if (code !== 0) {
      const detail = [
        this.stripAnsi(stdout).trim(),
        this.stripAnsi(stderr).trim(),
      ].filter(Boolean).join("\n");
      throw new Error(detail || "skills add failed with code " + code);
    }
  }

  private matchesSkillQuery(skill: SkillRecord, queryVariants: string[]): boolean {
    if (queryVariants.length === 0) {
      return true;
    }

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

  private async searchRemoteSkillsByQuery(query: string): Promise<Array<{
    key: string;
    origin: string;
    skillId: string;
    name: string;
    installs: number;
  }>> {
    const proc = Bun.spawn(["npx", "-y", "skills", "find", query], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    if (code !== 0) {
      const detail = [
        this.stripAnsi(stdout).trim(),
        this.stripAnsi(stderr).trim(),
      ].filter(Boolean).join("\n");
      throw new Error(detail || "skills find failed with code " + code);
    }

    return this.parseRemoteSkillCliOutput(stdout);
  }

  private parseRemoteSkillCliOutput(output: string): Array<{
    key: string;
    origin: string;
    skillId: string;
    name: string;
    installs: number;
  }> {
    const byKey = new Map<
      string,
      { key: string; origin: string; skillId: string; name: string; installs: number }
    >();

    const cleaned = this.stripAnsi(output);
    const lines = cleaned.split(/\r?\n/).map((line) => line.trim());
    const resultPattern =
      /^([a-z0-9._-]+\/[a-z0-9._-]+)@([a-z0-9._-]+)(?:\s+([0-9][0-9,]*)\s+installs?)?$/i;

    for (const line of lines) {
      const match = line.match(resultPattern);
      if (!match) continue;

      const origin = match[1].toLowerCase();
      const skillId = match[2];
      const installs = Number((match[3] || "0").replace(/,/g, ""));
      const key = "remote:" + origin + "/" + skillId;
      const existing = byKey.get(key);
      if (!existing || installs > existing.installs) {
        byKey.set(key, {
          key,
          origin,
          skillId,
          name: skillId,
          installs,
        });
      }
    }

    return Array.from(byKey.values()).sort((a, b) => b.installs - a.installs);
  }

  private stripAnsi(value: string): string {
    return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
  }

  private upsertRemoteSkills(skills: Array<{
    key: string;
    origin: string;
    skillId: string;
    name: string;
    installs: number;
  }>): void {
    if (skills.length === 0) {
      return;
    }

    const now = Date.now();
    const upsert = this.db.query(
      `INSERT INTO skills_catalog (
        skill_key,
        source,
        origin,
        skill_id,
        name,
        description,
        path,
        scope,
        installs,
        updated_at
      ) VALUES (?1, 'remote', ?2, ?3, ?4, NULL, NULL, NULL, ?5, ?6)
      ON CONFLICT(skill_key) DO UPDATE SET
        source = 'remote',
        origin = excluded.origin,
        skill_id = excluded.skill_id,
        name = excluded.name,
        installs = excluded.installs,
        updated_at = excluded.updated_at`,
    );

    for (const skill of skills) {
      upsert.run(
        skill.key,
        skill.origin,
        skill.skillId,
        skill.name,
        skill.installs,
        now,
      );
    }
  }

  private sanitizeAgentName(raw: string): string {
    const cleaned = raw
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "");

    if (!cleaned) {
      return "";
    }

    if (/^[a-z]/.test(cleaned)) {
      return cleaned;
    }

    return `agent_${cleaned}`;
  }

  private sanitizeSkillName(raw: string): string {
    const cleaned = raw
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "");

    return cleaned;
  }

  private buildDefaultSkillContent(): string {
    return `Describe what this skill does and when to use it.\n\n## Instructions\n\n1. Add clear, direct instructions for the agent.\n2. Include any constraints and expected output format.\n3. Add examples if needed.\n`;
  }

  private parseSkillMarkdown(markdown: string, fallbackName: string): SkillMarkdownParts {
    const normalized = (markdown || "").replace(/\r\n/g, "\n");
    const match = normalized.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);

    let frontmatter: Record<string, unknown> = {};
    let content = normalized;

    if (match) {
      const frontmatterRaw = match[1] || "";
      try {
        const parsed = Bun.YAML.parse(frontmatterRaw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          frontmatter = { ...(parsed as Record<string, unknown>) };
        }
      } catch {
        frontmatter = {};
      }
      content = normalized.slice(match[0].length);
    }

    const parsedName = typeof frontmatter.name === "string" ? frontmatter.name.trim() : "";
    const name = parsedName || fallbackName;
    const description =
      typeof frontmatter.description === "string" ? frontmatter.description : "";

    const serialized = this.serializeSkillMarkdown({
      frontmatter,
      name,
      description,
      content,
    });

    return {
      frontmatter,
      name,
      description,
      content,
      markdown: serialized,
    };
  }

  private serializeSkillMarkdown(input: {
    frontmatter: Record<string, unknown>;
    name: string;
    description: string;
    content: string;
  }): string {
    const frontmatter: Record<string, unknown> = {
      ...input.frontmatter,
      name: input.name.trim(),
      description: input.description,
    };

    const yamlLines: string[] = [];
    for (const [key, value] of Object.entries(frontmatter)) {
      if (typeof value === "string") {
        if (value.includes("\n")) {
          yamlLines.push(`${key}: |`);
          for (const line of value.split("\n")) {
            yamlLines.push(`  ${line}`);
          }
        } else {
          yamlLines.push(`${key}: ${JSON.stringify(value)}`);
        }
        continue;
      }

      if (typeof value === "number" || typeof value === "boolean") {
        yamlLines.push(`${key}: ${String(value)}`);
        continue;
      }

      if (value == null) {
        yamlLines.push(`${key}: null`);
        continue;
      }

      yamlLines.push(`${key}: ${Bun.YAML.stringify(value).trim()}`);
    }

    const yaml = yamlLines.join("\n");
    const normalizedContent = (input.content || "")
      .replace(/\r\n/g, "\n")
      .replace(/^\n+/, "")
      .trimEnd();

    if (!normalizedContent) {
      return `---\n${yaml}\n---\n`;
    }

    return `---\n${yaml}\n---\n\n${normalizedContent}\n`;
  }

  private async resolveNextLocalSkillPath(baseSlug: string): Promise<{ slug: string; skillPath: string }> {
    let index = 0;

    while (true) {
      const slug = index === 0 ? baseSlug : `${baseSlug}-${index + 1}`;
      const skillPath = path.join(this.codexHome, "skills", slug, "SKILL.md");

      try {
        await access(skillPath, fsConstants.F_OK);
        index += 1;
      } catch (error) {
        const anyError = error as NodeJS.ErrnoException;
        if (anyError.code === "ENOENT") {
          return { slug, skillPath };
        }
        throw error;
      }
    }
  }

  private getMetadata(key: string): string | null {
    const row = this.db
      .query("SELECT value FROM metadata WHERE key = ?1")
      .get(key) as { value: string } | null;
    return row?.value ?? null;
  }

  private setMetadata(key: string, value: string): void {
    this.db
      .query(
        `INSERT INTO metadata (key, value)
         VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }
}
