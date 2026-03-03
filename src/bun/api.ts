import { ManagerStore } from "./store";
import type {
  CreateAgentInput,
  CreateSkillInput,
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
          const input = (await request.json()) as CreateSkillInput;
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
          const body = (await request.json()) as { markdown?: string };
          if (typeof body.markdown !== "string") {
            return json({ error: "markdown is required" }, 400);
          }
          const document = await store.saveSkillDocument(skillKey, body.markdown);
          return json({ document });
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
