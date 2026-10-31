// 专家由创建者管理，可共享使用；工具选择和 MCP 配置按登录账号隔离。
import type { IncomingMessage, ServerResponse } from "node:http";
import { userMcpServers } from "../../agents/codex/session.js";
import {
  ACCESS_LABEL,
  ACCESS_LEVELS,
  availableExperts,
  avatarImage,
  avatarUrl,
  createExpert,
  canUseExpert,
  deleteExpert,
  EXPERT_LIMITS,
  EXPERT_TEMPLATES,
  getExpert,
  expertTools,
  updateExpert,
  setExpertTools,
  type Expert,
  type ExpertInput,
} from "../../core/experts.js";
import { builtinAgentDefaults, setBuiltinAgentDefaults } from "../../core/builtin-agents.js";
import { hub } from "../../core/hub.js";
import { claudeMachineMcp, createMcp, deleteMcp, getMcp, listMcp, MACHINE_PREFIX, MCP_LIMITS, mcpView, updateMcp, type McpInput } from "../../core/mcp.js";
import { activeSkills } from "../../core/skills.js";
import { isAdmin, type User } from "../../core/users.js";
import { HttpError, readJsonBody, sendJson } from "./http.js";

const bad = (err: unknown) => (err instanceof HttpError ? err : new HttpError(400, err instanceof Error ? err.message : String(err)));

function expertView(e: Expert, viewer: string) {
  const tools = expertTools(viewer, e);
  return {
    id: e.id,
    name: e.name,
    description: e.description,
    icon: e.icon,
    avatar: avatarUrl(e),
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
    shared: e.shared === true,
    editable: e.owner === viewer,
    skills: tools.skills,
    mcp: tools.mcp,
    subagents: e.subagents.filter((id) => canUseExpert(viewer, id)),
    memory: e.memory,
    updatedAt: e.updatedAt,
  };
}

/** 选专家时要的那点信息（bootstrap 里给，/api/experts/brief 刷新） */
export function expertBrief(e: Expert) {
  return {
    shared: e.shared === true,
    id: e.id,
    name: e.name,
    description: e.description,
    icon: e.icon,
    avatar: avatarUrl(e),
    color: e.color,
    engine: e.engine,
    access: e.access,
    webSearch: e.webSearch,
    webFetch: e.webFetch,
    memory: e.memory,
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

  if (p === "/api/agents/defaults" && method === "GET") {
    sendJson(res, 200, {
      agents: builtinAgentDefaults(user.id),
      skills: activeSkills(user.id).map((s) => ({ id: s.id, name: s.name, description: s.description })),
      mcp: listMcp(user.id).map((s) => ({ id: s.id, name: s.name, description: s.description })),
      ...(await machineMcp(user).then((m) => m ? { machineMcp: m, machinePrefix: MACHINE_PREFIX } : {})),
    });
    return true;
  }
  if (p === "/api/agents/defaults" && method === "PUT") {
    const body = await readJsonBody<{ agents?: unknown }>(req);
    try {
      sendJson(res, 200, { agents: setBuiltinAgentDefaults(user.id, body.agents) });
    } catch (err) {
      throw bad(err);
    }
    return true;
  }

  if (p === "/api/experts" && method === "GET") {
    const enabled = hub.enabledAgents().map((d) => d.id);
    sendJson(res, 200, {
      experts: availableExperts(user.id).map((e) => expertView(e, user.id)),
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
    sendJson(res, 200, { experts: availableExperts(user.id).map(expertBrief) });
    return true;
  }

  if (p === "/api/experts" && method === "POST") {
    const body = await readJsonBody<ExpertInput>(req, 1024 * 1024);
    try {
      sendJson(res, 200, expertView(createExpert(user.id, body), user.id));
    } catch (err) {
      throw bad(err);
    }
    return true;
  }

  // 头像：登录了就能看（管理员看别人的对话时也要显示）。地址带版本号，可以长期缓存
  const am = /^\/api\/experts\/(e_[a-f0-9]+)\/avatar$/.exec(p);
  if (am && method === "GET") {
    const expert = getExpert(am[1]!);
    const img = expert && avatarImage(expert);
    if (!img) throw new HttpError(404, "没有头像");
    res.writeHead(200, { "Content-Type": img.type, "Content-Length": img.data.length, "Cache-Control": "private, max-age=31536000, immutable" });
    res.end(img.data);
    return true;
  }

  const tm = /^\/api\/experts\/(e_[a-f0-9]+)\/tools$/.exec(p);
  if (tm && method === "PUT") {
    if (!canUseExpert(user.id, tm[1]!)) throw new HttpError(404, "这个专家不存在");
    const body = await readJsonBody<unknown>(req);
    try {
      sendJson(res, 200, setExpertTools(user.id, tm[1]!, body));
    } catch (err) {
      throw bad(err);
    }
    return true;
  }

  const em = /^\/api\/experts\/(e_[a-f0-9]+)$/.exec(p);
  if (em) {
    const expert = getExpert(em[1]!);
    if (!expert || !canUseExpert(user.id, expert.id)) throw new HttpError(404, "这个专家不存在");
    if (method === "GET") {
      sendJson(res, 200, expertView(expert, user.id));
      return true;
    }
    if (expert.owner !== user.id) throw new HttpError(403, "只有创建者能修改或删除共享专家；你的工具可单独配置");
    if (method === "PATCH") {
      const body = await readJsonBody<ExpertInput>(req, 1024 * 1024);
      try {
        sendJson(res, 200, expertView(updateExpert(user.id, expert.id, body), user.id));
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
    const experts = availableExperts(user.id);
    sendJson(res, 200, {
      servers: listMcp(user.id).map((s) => ({ ...mcpView(s), usedBy: experts.filter((e) => expertTools(user.id, e).mcp.includes(s.id)).map((e) => e.name) })),
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
