import { Database } from "bun:sqlite";
import { mkdir, access, writeFile, readFile, unlink } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { callCodexAppServer } from "./appServerClient";
import { buildSkillSearchQueryVariants, resolveSkillSearchLookupQuery } from "../shared/skillSearchQuery";
import type {
  AgentDetailPayload,
  AgentRecord,
  BootstrapPayload,
  CreateAgentInput,
  CreateSkillInput,
  SaveSkillInput,
  ModelRecord,
  ReasoningEffort,
  SkillDocument,
  SkillRecord,
  UpdateAgentInput,
} from "./types";

interface ConfigReadResult {
  config: {
    model?: string;
    model_reasoning_effort?: ReasoningEffort;
    agents?: Record<string, unknown>;
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

interface AgentSectionEntry {
  description?: string;
  config_file?: string;
}

interface AgentConfigFile {
  model?: string;
  model_reasoning_effort?: ReasoningEffort;
  developer_instructions?: string;
}

interface SkillMarkdownParts {
  frontmatter: Record<string, unknown>;
  name: string;
  description: string;
  content: string;
  markdown: string;
}

const RESERVED_AGENT_KEYS = new Set(["max_threads", "max_depth"]);
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
    this.agentConfigDir = path.join(this.codexHome, "agents-composer", "agents");

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

    const [agents, skills, models] = await Promise.all([
      this.getAgents(),
      this.getSkills(),
      this.getModels(),
    ]);

    return { agents, skills, models };
  }

  async getAgentDetail(agentId: string): Promise<AgentDetailPayload> {
    const [agent, allSkills, assignedSkills, models] = await Promise.all([
      this.getAgent(agentId),
      this.getSkills(),
      this.getAssignedSkills(agentId),
      this.getModels(),
    ]);

    if (!agent) {
      throw new Error(`Agent '${agentId}' not found in Codex config`);
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

    if (!agentName) {
      throw new Error("Agent name is required");
    }

    const existingAgent = await this.getAgent(agentName);
    if (existingAgent) {
      throw new Error(`Agent '${agentName}' already exists`);
    }

    const configPath = path.join(this.agentConfigDir, `${agentName}.toml`);
    await this.writeAgentConfigFile(configPath, {
      model: input.model || DEFAULT_MODEL,
      model_reasoning_effort: input.reasoningEffort || DEFAULT_REASONING,
      developer_instructions: input.instructions || "",
    });

    await this.writeAgentConfigValue(`agents.${agentName}.description`, input.description || "");
    await this.writeAgentConfigValue(`agents.${agentName}.config_file`, configPath);

    const created = await this.getAgent(agentName);
    if (!created) {
      throw new Error("Failed to create agent");
    }

    return created;
  }

  async updateAgent(agentId: string, input: UpdateAgentInput): Promise<AgentRecord> {
    const current = await this.getAgent(agentId);
    if (!current) {
      throw new Error(`Agent '${agentId}' not found in Codex config`);
    }

    const nextAgentId = this.sanitizeAgentName(input.name || agentId);
    if (!nextAgentId) {
      throw new Error("Agent name is required");
    }

    if (nextAgentId !== agentId) {
      const conflicting = await this.getAgent(nextAgentId);
      if (conflicting) {
        throw new Error(`Agent '${nextAgentId}' already exists`);
      }
    }

    const nextConfigPath =
      nextAgentId === agentId
        ? current.configFile
        : path.join(this.agentConfigDir, `${nextAgentId}.toml`);

    await this.writeAgentConfigFile(nextConfigPath, {
      model: input.model || DEFAULT_MODEL,
      model_reasoning_effort: input.reasoningEffort || DEFAULT_REASONING,
      developer_instructions: input.instructions || "",
    });

    if (nextAgentId === agentId) {
      await this.writeAgentConfigValue(`agents.${agentId}.description`, input.description || "");
      await this.writeAgentConfigValue(`agents.${agentId}.config_file`, nextConfigPath);
    } else {
      await this.writeAgentConfigValues([
        {
          keyPath: `agents.${nextAgentId}`,
          value: {
            description: input.description || "",
            config_file: nextConfigPath,
          },
          mergeStrategy: "upsert",
        },
        {
          keyPath: `agents.${agentId}`,
          value: {},
          mergeStrategy: "replace",
        },
      ]);

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
        .run(nextAgentId, agentId);

      this.db.query("DELETE FROM agent_skills WHERE agent_id = ?1").run(agentId);

      if (current.configFile !== nextConfigPath) {
        try {
          await unlink(current.configFile);
        } catch {
          // Ignore cleanup errors for old config files.
        }
      }
    }

    const updated = await this.getAgent(nextAgentId);
    if (!updated) {
      throw new Error("Failed to reload updated agent");
    }

    return updated;
  }

  async deleteAgent(agentId: string): Promise<void> {
    const current = await this.getAgent(agentId);
    if (!current) {
      throw new Error(`Agent '${agentId}' not found in Codex config`);
    }

    await this.writeAgentConfigValue(`agents.${agentId}`, {}, "replace");
    this.db.query("DELETE FROM agent_skills WHERE agent_id = ?1").run(agentId);

    if (current.configFile) {
      try {
        await unlink(current.configFile);
      } catch {
        // Ignore cleanup errors for deleted agent config files.
      }
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

    const nextDescription = input.description || "";
    const nextContent = input.content || "";
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

    const markdown = this.serializeSkillMarkdown({
      frontmatter: {},
      name: input.name.trim() || slug,
      description: input.description || "",
      content,
    });

    await mkdir(skillDir, { recursive: true });
    await writeFile(skillPath, markdown, "utf8");

    await this.refreshLocalSkills();
    // Ensure the skill is in the catalog even if the app server didn't discover it
    this.upsertLocalSkillCatalogEntry(skillPath, input.name.trim() || slug, input.description || null);

    const skillKey = `local:${skillPath}`;
    return this.getSkillDocument(skillKey);
  }

  private async getAgent(agentId: string): Promise<AgentRecord | null> {
    const agents = await this.getAgents();
    return agents.find((agent) => agent.id === agentId) ?? null;
  }

  private async getAgents(): Promise<AgentRecord[]> {
    const configRead = await this.readCodexConfig();
    const globalModel = configRead.config.model || DEFAULT_MODEL;
    const globalReasoning =
      configRead.config.model_reasoning_effort || DEFAULT_REASONING;

    const agentsSection = configRead.config.agents || {};
    const entries = Object.entries(agentsSection).filter(([key, value]) => {
      if (RESERVED_AGENT_KEYS.has(key)) return false;
      return Boolean(value && typeof value === "object");
    });

    const counts = this.db
      .query(
        `SELECT agent_id as agentId, COUNT(*) as count
         FROM agent_skills
         GROUP BY agent_id`,
      )
      .all() as Array<{ agentId: string; count: number }>;

    const countByAgent = new Map<string, number>();
    for (const row of counts) {
      countByAgent.set(row.agentId, row.count);
    }

    const agents = await Promise.all(
      entries.map(async ([agentKey, raw]) => {
        const parsedEntry = raw as AgentSectionEntry;
        if (!parsedEntry.config_file) {
          return null;
        }

        const parsedConfig = await this.readAgentConfigFile(
          parsedEntry.config_file,
          globalModel,
          globalReasoning,
        );

        const skillCount = countByAgent.get(agentKey) || 0;

        return {
          id: agentKey,
          name: agentKey,
          description: parsedEntry.description || "",
          model: parsedConfig.model,
          reasoningEffort: parsedConfig.reasoningEffort,
          instructions: parsedConfig.instructions,
          configFile: parsedEntry.config_file,
          skillCount,
        } satisfies AgentRecord;
      }),
    );

    return agents
      .filter((agent): agent is AgentRecord => Boolean(agent))
      .sort((a, b) => a.name.localeCompare(b.name));
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

  private getAssignedSkills(agentId: string): SkillRecord[] {
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
         WHERE a.agent_id = ?1
         ORDER BY a.created_at DESC`,
      )
      .all(agentId) as SkillRecord[];
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

  private async readCodexConfig(): Promise<ConfigReadResult> {
    return callCodexAppServer<ConfigReadResult>("config/read", {
      includeLayers: false,
      cwd: this.cwd,
    });
  }

  private async writeAgentConfigValue(
    keyPath: string,
    value: unknown,
    mergeStrategy: ConfigMergeStrategy = "upsert",
  ): Promise<void> {
    const result = await callCodexAppServer<ConfigWriteResult>(
      "config/value/write",
      {
        keyPath,
        value,
        mergeStrategy,
      },
    );

    if (!result || (result.status !== "ok" && result.status !== "okOverridden")) {
      throw new Error(`Failed to write config key '${keyPath}'`);
    }
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
    fallbackModel: string,
    fallbackReasoning: ReasoningEffort,
  ): Promise<{ model: string; reasoningEffort: ReasoningEffort; instructions: string }> {
    try {
      await access(configFile, fsConstants.F_OK);
      const content = await Bun.file(configFile).text();
      const parsed = Bun.TOML.parse(content) as AgentConfigFile;

      return {
        model: parsed.model || fallbackModel,
        reasoningEffort: parsed.model_reasoning_effort || fallbackReasoning,
        instructions: parsed.developer_instructions || "",
      };
    } catch {
      return {
        model: fallbackModel,
        reasoningEffort: fallbackReasoning,
        instructions: "",
      };
    }
  }

  private async writeAgentConfigFile(
    configFile: string,
    data: AgentConfigFile,
  ): Promise<void> {
    await mkdir(path.dirname(configFile), { recursive: true });

    const lines = [
      `model = ${JSON.stringify(data.model || DEFAULT_MODEL)}`,
      `model_reasoning_effort = ${JSON.stringify(data.model_reasoning_effort || DEFAULT_REASONING)}`,
      `developer_instructions = ${JSON.stringify(data.developer_instructions || "")}`,
      "",
    ];

    await writeFile(configFile, lines.join("\n"), "utf8");
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
