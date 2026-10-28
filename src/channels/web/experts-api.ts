// 专家和 MCP 的接口：/api/experts、/api/mcp。每人管自己的，看不到别人的（管理员也一样）。
import type { IncomingMessage, ServerResponse } from "node:http";
import { userMcpServers } from "../../agents/codex/session.js";
import {
  ACCESS_LABEL,
  ACCESS_LEVELS,
  createExpert,
  deleteExpert,
  EXPERT_LIMITS,
  EXPERT_TEMPLATES,
  getExpert,
  listExperts,
  updateExpert,
  type Expert,
  type ExpertInput,
} from "../../core/experts.js";
import { hub } from "../../core/hub.js";
import { claudeMachineMcp, createMcp, deleteMcp, getMcp, listMcp, MACHINE_PREFIX, MCP_LIMITS, mcpView, updateMcp, type McpInput } from "../../core/mcp.js";
import { activeSkills } from "../../core/skills.js";
import { isAdmin, type User } from "../../core/users.js";
import { HttpError, readJsonBody, sendJson } from "./http.js";

const bad = (err: unknown) => (err instanceof HttpError ? err : new HttpError(400, err instanceof Error ? err.message : String(err)));

function expertView(e: Expert) {
  return {
    id: e.id,
    name: e.name,
    description: e.description,
    icon: e.icon,
    color: e.color,
    welcome: e.welcome,
    quickPrompts: e.quickPrompts,
    engine: e.engine,
    model: e.model ?? "",
    effort: e.effort ?? "",
    prompt: e.prompt,
    basePrompt: e.basePrompt,
    access: e.access,
    cwd: e.cwd ?? "",
    webSearch: e.webSearch,
    webFetch: e.webFetch,
    skills: e.skills,
    mcp: e.mcp,
    subagents: e.subagents,
    memory: e.memory,
    updatedAt: e.updatedAt,
  };
}

/** 选专家时要的那点信息（bootstrap 里给，/api/experts/brief 刷新） */
export function expertBrief(e: Expert) {
  return {
    id: e.id,
    name: e.name,
    description: e.description,
    icon: e.icon,
    color: e.color,
    engine: e.engine,
    access: e.access,
    cwd: e.cwd ?? "",
    model: e.model ?? "",
    effort: e.effort ?? "",
    welcome: e.welcome,
    quickPrompts: e.quickPrompts,
  };
}

/** 机器上原有的 MCP，只给管理员。Codex 的要问 app-server，没启用就不问（问一次就会拉起它） */
async function machineMcp(user: User): Promise<{ claude: string[]; codex: string[] } | undefined> {
  if (!isAdmin(user)) return undefined;
  const enabled = new Set(hub.enabledAgents().map((d) => d.id));
  const codex = enabled.has("codex") ? await userMcpServers().catch(() => [] as string[]) : [];
  return { claude: enabled.has("claude") ? Object.keys(claudeMachineMcp()) : [], codex };
}

/** 处理了就返回 true */
export async function handleExpertsApi(req: IncomingMessage, res: ServerResponse, p: string, user: User): Promise<boolean> {
  const method = req.method ?? "GET";

  if (p === "/api/experts" && method === "GET") {
    const enabled = hub.enabledAgents().map((d) => d.id);
    sendJson(res, 200, {
      experts: listExperts(user.id).map(expertView),
      builtin: enabled.map((id) => ({ id, name: hub.label(id), engine: id })),
      engines: enabled,
      templates: EXPERT_TEMPLATES.map((t) => ({ id: t.id, label: t.label, expert: t.expert })),
      access: ACCESS_LEVELS.map((id) => ({ id, label: ACCESS_LABEL[id] })),
      skills: activeSkills(user.id).map((s) => ({ id: s.id, name: s.name, description: s.description })),
      mcp: listMcp(user.id).map((s) => ({ id: s.id, name: s.name, description: s.description, type: s.type })),
      ...(await machineMcp(user).then((m) => (m ? { machineMcp: m, machinePrefix: MACHINE_PREFIX } : {}))),
      limits: EXPERT_LIMITS,
    });
    return true;
  }

  if (p === "/api/experts/brief" && method === "GET") {
    sendJson(res, 200, { experts: listExperts(user.id).map(expertBrief) });
    return true;
  }

  if (p === "/api/experts" && method === "POST") {
    const body = await readJsonBody<ExpertInput>(req, 256 * 1024);
    try {
      sendJson(res, 200, expertView(createExpert(user.id, body)));
    } catch (err) {
      throw bad(err);
    }
    return true;
  }

  const em = /^\/api\/experts\/(e_[a-f0-9]+)$/.exec(p);
  if (em) {
    const expert = getExpert(em[1]!);
    if (!expert || expert.owner !== user.id) throw new HttpError(404, "这个专家不存在");
    if (method === "GET") {
      sendJson(res, 200, expertView(expert));
      return true;
    }
    if (method === "PATCH") {
      const body = await readJsonBody<ExpertInput>(req, 256 * 1024);
      try {
        sendJson(res, 200, expertView(updateExpert(user.id, expert.id, body)));
      } catch (err) {
        throw bad(err);
      }
      return true;
    }
    if (method === "DELETE") {
      try {
        deleteExpert(user.id, expert.id);
      } catch (err) {
        throw bad(err);
      }
      sendJson(res, 200, { ok: true });
      return true;
    }
    return false;
  }

  if (p === "/api/mcp" && method === "GET") {
    const experts = listExperts(user.id);
    sendJson(res, 200, {
      servers: listMcp(user.id).map((s) => ({ ...mcpView(s), usedBy: experts.filter((e) => e.mcp.includes(s.id)).map((e) => e.name) })),
      limits: MCP_LIMITS,
    });
    return true;
  }

  if (p === "/api/mcp" && method === "POST") {
    const body = await readJsonBody<McpInput>(req, 256 * 1024);
    try {
      sendJson(res, 200, mcpView(createMcp(user.id, body)));
    } catch (err) {
      throw bad(err);
    }
    return true;
  }

  const mm = /^\/api\/mcp\/(m_[a-f0-9]+)$/.exec(p);
  if (mm) {
    const server = getMcp(mm[1]!);
    if (!server || server.owner !== user.id) throw new HttpError(404, "这个 MCP 不存在");
    if (method === "PATCH") {
      const body = await readJsonBody<McpInput>(req, 256 * 1024);
      try {
        sendJson(res, 200, mcpView(updateMcp(user.id, server.id, body)));
      } catch (err) {
        throw bad(err);
      }
      return true;
    }
    if (method === "DELETE") {
      try {
        deleteMcp(user.id, server.id);
      } catch (err) {
        throw bad(err);
      }
      sendJson(res, 200, { ok: true });
      return true;
    }
    return false;
  }
  return false;
}
