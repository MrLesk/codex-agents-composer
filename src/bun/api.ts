import { ManagerStore } from "./store";
import type {
  CreateAgentInput,
  CreateSkillInput,
  SaveSkillInput,
  UpdateAgentInput,
} from "./types";

const JSON_HEADERS = {
  "content-type": "application/json",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
  "access-control-allow-headers": "content-type",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: JSON_HEADERS,
  });
}

function asErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function parseMarkdownPayload(markdown: string): SaveSkillInput {
  const normalized = markdown.replace(/\r\n/g, "\n");
  const match = normalized.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);

  let frontmatter: Record<string, unknown> = {};
  let content = normalized;

  if (match) {
    const frontmatterRaw = match[1] || "";
    try {
      const parsed = Bun.YAML.parse(frontmatterRaw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        frontmatter = parsed as Record<string, unknown>;
      }
    } catch {
      frontmatter = {};
    }
    content = normalized.slice(match[0].length);
  }

  return {
    name: typeof frontmatter.name === "string" ? frontmatter.name : "",
    description:
      typeof frontmatter.description === "string" ? frontmatter.description : "",
    content,
  };
}

function parseSkillWriteInput(body: unknown): SaveSkillInput {
  const source =
    body && typeof body === "object" ? (body as Record<string, unknown>) : {};

  const input: SaveSkillInput = {
    name: typeof source.name === "string" ? source.name : "",
    description:
      typeof source.description === "string" ? source.description : "",
    content: typeof source.content === "string" ? source.content : "",
  };

  const legacyMarkdown =
    typeof source.markdown === "string" ? source.markdown : "";

  if (legacyMarkdown) {
    const parsed = parseMarkdownPayload(legacyMarkdown);
    return {
      name: input.name || parsed.name,
      description: input.description || parsed.description,
      content: input.content || parsed.content,
    };
  }

  return input;
}

export function startApiServer(store: ManagerStore, port: number) {
  const server = Bun.serve({
    port,
    async fetch(request: Request): Promise<Response> {
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: JSON_HEADERS });
      }

      const url = new URL(request.url);
      const pathname = url.pathname;

      try {
        if (request.method === "GET" && pathname === "/api/health") {
          return json({ ok: true });
        }

        if (request.method === "GET" && pathname === "/api/bootstrap") {
          const refresh = url.searchParams.get("refresh") === "1";
          const payload = await store.getBootstrap(refresh);
          return json(payload);
        }

        if (request.method === "GET" && pathname === "/api/skills") {
          const refresh = url.searchParams.get("refresh") === "1";
          const query = (url.searchParams.get("q") || "").trim();
          const skills = query
            ? await store.searchSkills(query, refresh)
            : await store.refreshSkillsCatalog(refresh);
          return json({ skills });
        }

        if (request.method === "POST" && pathname === "/api/skills") {
          const input = parseSkillWriteInput((await request.json()) as CreateSkillInput);
          const document = await store.createSkill(input);
          return json({ document }, 201);
        }

        if (request.method === "POST" && pathname === "/api/skills/refresh") {
          const skills = await store.refreshSkillsCatalog(true);
          return json({ skills });
        }

        const skillMatch = pathname.match(/^\/api\/skills\/(.+)$/);
        if (request.method === "GET" && skillMatch) {
          const skillKey = decodeURIComponent(skillMatch[1]);
          const document = await store.getSkillDocument(skillKey);
          return json({ document });
        }

        if (request.method === "PUT" && skillMatch) {
          const skillKey = decodeURIComponent(skillMatch[1]);
          const input = parseSkillWriteInput((await request.json()) as SaveSkillInput);
          const document = await store.saveSkillDocument(skillKey, input);
          return json({ document });
        }

        if (request.method === "DELETE" && skillMatch) {
          const skillKey = decodeURIComponent(skillMatch[1]);
          await store.deleteSkill(skillKey);
          return json({ ok: true });
        }

        const agentDetailMatch = pathname.match(/^\/api\/agents\/([^/]+)$/);
        if (request.method === "GET" && agentDetailMatch) {
          const agentId = decodeURIComponent(agentDetailMatch[1]);
          const detail = await store.getAgentDetail(agentId);
          return json(detail);
        }

        if (request.method === "POST" && pathname === "/api/agents") {
          const input = (await request.json()) as CreateAgentInput;
          const agent = await store.createAgent(input);
          return json({ agent }, 201);
        }

        if (request.method === "PUT" && agentDetailMatch) {
          const agentId = decodeURIComponent(agentDetailMatch[1]);
          const input = (await request.json()) as UpdateAgentInput;
          const agent = await store.updateAgent(agentId, input);
          return json({ agent });
        }

        if (request.method === "DELETE" && agentDetailMatch) {
          const agentId = decodeURIComponent(agentDetailMatch[1]);
          await store.deleteAgent(agentId);
          return json({ ok: true });
        }

        const assignMatch = pathname.match(/^\/api\/agents\/([^/]+)\/assign$/);
        if (request.method === "POST" && assignMatch) {
          const agentId = decodeURIComponent(assignMatch[1]);
          const body = (await request.json()) as { skillKey?: string };
          if (!body.skillKey) {
            return json({ error: "skillKey is required" }, 400);
          }
          const assignedSkills = await store.assignSkill(agentId, body.skillKey);
          return json({ assignedSkills });
        }

        const unassignMatch = pathname.match(/^\/api\/agents\/([^/]+)\/unassign$/);
        if (request.method === "POST" && unassignMatch) {
          const agentId = decodeURIComponent(unassignMatch[1]);
          const body = (await request.json()) as { skillKey?: string };
          if (!body.skillKey) {
            return json({ error: "skillKey is required" }, 400);
          }
          const assignedSkills = await store.unassignSkill(agentId, body.skillKey);
          return json({ assignedSkills });
        }

        return json({ error: "Not found" }, 404);
      } catch (error) {
        return json(
          {
            error: asErrorMessage(error),
          },
          500,
        );
      }
    },
  });

  return server;
}
