/**
 * Game5 幸运筹码乐园 —— 云存档同步 Worker
 * ---------------------------------------------------------------
 * v2 变更（新增功能，旧接口行为完全不变）：
 *   新增 POST /proxy —— 受管理员密码保护的 GitHub 代理通道。
 *   让 saves.html 只用「管理员密码」就能读写仓库存档：
 *     · GitHub 令牌只存在 Worker secret 里，永远不会下发到浏览器、也不在仓库任何文件里
 *     · 管理员密码也只存在 Worker secret 里，页面只负责把它送回来校验
 *     · 代理只放行白名单端点，且仓库被锁死在 REPO_OWNER/REPO_NAME，借道写别的仓库不可能
 *
 * 旧接口（游戏内自动同步，前端 api/cloud-sync.ts 在用，勿改语义）：
 *   GET  {worker}/?username=xxx            —— 拉取 Game5Saves/{username}/save.json
 *   POST {worker}/?username=xxx {save}     —— 推送 Game5Saves/{username}/save.json
 *   GET/POST ?username=xxx&account=1       —— Game5Accounts/{username}.json
 *
 * 需要在 Cloudflare Workers 后台配置：
 *   Secret : GITHUB_TOKEN     细粒度 PAT，仅授权本仓库 Contents: read and write
 *   Secret : ADMIN_PASSWORD   管理员密码，建议 20 位以上随机串（Worker 无状态，做不了失败封禁，只能靠密码长度）
 *   Var    : REPO_OWNER       YunYu-ca
 *   Var    : REPO_NAME        YunYu-ca.github.io
 */

const ALLOWED_ORIGINS = new Set([
  "https://yunyu-ca.github.io",
  "http://localhost:8137",
  "http://127.0.0.1:8137",
]);

// 只允许这些 GitHub 端点通过代理（按 saves.html 实际用到的读写链路收口）
const ALLOW = [
  /^\/repos\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/, // 仓库信息
  /^\/repos\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/branches(\?[\w=&.,-]*)?$/,
  /^\/repos\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/git\/trees\/[\w.@/-]+(\?recursive=1)?$/,
  /^\/repos\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/git\/commits\/[0-9a-f]{40}$/,
  /^\/repos\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/git\/ref\/heads\/[\w./-]+$/,
  /^\/repos\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/git\/refs(\/heads\/[\w./-]+)?$/,
  /^\/repos\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/git\/blobs(\/[0-9a-f]{40})?$/,
  /^\/repos\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/git\/trees$/,
  /^\/repos\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/git\/commits$/,
  /^\/users\/[A-Za-z0-9._-]+\/repos(\?[\w=&.,-]*)?$/,
  /^\/user$/,
];

const METHODS = ["GET", "POST", "PATCH"];
const MAX_BODY_CHARS = 24 * 1024 * 1024; // 请求体上限（含 base64 后的存档内容）
const MAX_RAW_BYTES = 12 * 1024 * 1024; // 单次 raw 读取上限，避免 Workers CPU 超时

function json(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign({ "Content-Type": "application/json" }, headers || {}),
  });
}

function b64(s) {
  const bin = new TextEncoder().encode(s);
  let str = "";
  for (const b of bin) str += String.fromCharCode(b);
  return btoa(str);
}

function decodeB64(s) {
  const bin = atob(s);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(arr);
}

function bytesToB64(buf) {
  const bin = new Uint8Array(buf);
  const chunk = 0x8000;
  let str = "";
  for (let i = 0; i < bin.length; i += chunk) {
    str += String.fromCharCode.apply(null, bin.subarray(i, i + chunk));
  }
  return btoa(str);
}

// 常数时间比较，不提前返回
function sameSecret(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function slow(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function ghGet(owner, repo, path, token) {
  return fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": "game5-cloud-sync-worker",
      Accept: "application/vnd.github+json",
    },
  });
}

/* SECTION: 旧接口 —— Game5 游戏内自动同步（行为保持不变） */
async function handleLegacy(request, env, corsHeaders, url) {
  const token = env.GITHUB_TOKEN;
  if (!token) return json({ ok: false, error: "server not configured: missing GITHUB_TOKEN" }, 500, corsHeaders);

  const username = (url.searchParams.get("username") || "").trim();
  if (!username || !/^[A-Za-z0-9_-]{2,50}$/.test(username)) {
    return json({ ok: false, error: "invalid username" }, 400, corsHeaders);
  }
  const owner = env.REPO_OWNER || "YunYu-ca";
  const repo = env.REPO_NAME || "YunYu-ca.github.io";
  const isAccount = url.searchParams.get("account") === "1";
  const path = isAccount ? `Game5Accounts/${username}.json` : `Game5Saves/${username}/save.json`;

  if (request.method === "GET") {
    const res = await ghGet(owner, repo, path, token);
    if (res.status === 404) return json({ ok: true, exists: false }, 200, corsHeaders);
    if (res.status !== 200) return json({ ok: false, error: `github ${res.status}` }, 502, corsHeaders);
    const data = await res.json();
    let parsed;
    try {
      parsed = JSON.parse(decodeB64(data.content));
    } catch {
      return json({ ok: false, error: "corrupt cloud save" }, 500, corsHeaders);
    }
    return json({ ok: true, exists: true, save: parsed }, 200, corsHeaders);
  }

  if (request.method === "POST") {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, error: "bad json body" }, 400, corsHeaders);
    }
    const payloadData = isAccount ? (body && body.account) : (body && body.save);
    if (!payloadData || typeof payloadData !== "object") {
      return json({ ok: false, error: "missing payload" }, 400, corsHeaders);
    }

    let sha = null;
    const existing = await ghGet(owner, repo, path, token);
    if (existing.status === 200) {
      const d = await existing.json();
      sha = d.sha || null;
    } else if (existing.status !== 404) {
      return json({ ok: false, error: `github read ${existing.status}` }, 502, corsHeaders);
    }

    const payload = {
      message: `Game5 ${isAccount ? "account" : "save"} ${username}`,
      content: b64(JSON.stringify(payloadData)),
      ...(sha ? { sha } : {}),
    };
    const put = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${path}`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": "game5-cloud-sync-worker",
      },
      body: JSON.stringify(payload),
    });
    if (put.status !== 200 && put.status !== 201) {
      const errTxt = await put.text();
      return json({ ok: false, error: `github write ${put.status}: ${errTxt.slice(0, 200)}` }, 502, corsHeaders);
    }
    return json({ ok: true, message: "saved" }, 200, corsHeaders);
  }

  return json({ ok: false, error: "method not allowed" }, 405, corsHeaders);
}

/* SECTION: 新接口 —— 管理员密码保护的 GitHub 代理 */
async function handleProxy(request, env, corsHeaders) {
  if (!env.ADMIN_PASSWORD) {
    return json({ ok: false, error: "worker 未配置 ADMIN_PASSWORD，请先在 Workers 后台添加该 Secret" }, 500, corsHeaders);
  }
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ ok: false, error: "bad json body" }, 400, corsHeaders);
  }
  if (!sameSecret(String(payload.password || ""), String(env.ADMIN_PASSWORD))) {
    await slow(400);
    return json({ ok: false, error: "管理员密码不正确" }, 401, corsHeaders);
  }
  if (!env.GITHUB_TOKEN) {
    return json({ ok: false, error: "worker 未配置 GITHUB_TOKEN" }, 500, corsHeaders);
  }

  const method = String(payload.method || "GET").toUpperCase();
  const path = String(payload.path || "");
  const wantRaw = payload.accept === "raw";
  const owner = (env.REPO_OWNER || "YunYu-ca").toLowerCase();
  const repo = (env.REPO_NAME || "YunYu-ca.github.io").toLowerCase();

  if (METHODS.indexOf(method) < 0) {
    return json({ ok: false, error: `方法不允许：${method}` }, 405, corsHeaders);
  }
  if (!path.startsWith("/") || path.indexOf("..") >= 0 || /^https?:/i.test(path)) {
    return json({ ok: false, error: "路径不合法" }, 400, corsHeaders);
  }
  if (!ALLOW.some((re) => re.test(path))) {
    return json({ ok: false, error: "该 GitHub 端点不在允许清单内" }, 403, corsHeaders);
  }
  const scoped = path.match(/^\/repos\/([^/]+)\/([^/]+)/);
  if (scoped && (scoped[1].toLowerCase() !== owner || scoped[2].toLowerCase() !== repo)) {
    return json({ ok: false, error: "代理已锁定仓库，不允许访问其它仓库" }, 403, corsHeaders);
  }

  let bodyText;
  if (payload.body !== undefined && payload.body !== null) {
    bodyText = JSON.stringify(payload.body);
    if (bodyText.length > MAX_BODY_CHARS) {
      return json({ ok: false, error: "请求体过大，请改用浏览器直连模式或拆分存档" }, 413, corsHeaders);
    }
  }

  const headers = {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    "User-Agent": "game5-cloud-sync-worker",
    Accept: wantRaw ? "application/vnd.github.raw" : "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (bodyText !== undefined) headers["Content-Type"] = "application/json";

  let upstream;
  try {
    upstream = await fetch(`https://api.github.com${path}`, { method, headers, body: bodyText });
  } catch (e) {
    return json({ ok: false, error: `无法连到 GitHub：${e.message}`, status: 502 }, 502, corsHeaders);
  }

  const remaining = upstream.headers.get("x-ratelimit-remaining");
  const reset = upstream.headers.get("x-ratelimit-reset");
  const out = { ok: upstream.ok, status: upstream.status, remaining, reset };

  if (upstream.status === 204 || upstream.status === 304) return json(out, 200, corsHeaders);

  if (wantRaw && upstream.ok) {
    const buf = await upstream.arrayBuffer();
    if (buf.byteLength > MAX_RAW_BYTES) {
      return json({ ok: false, error: "文件超过 Worker 单次读取上限 12MB，请改用浏览器直连模式", status: 413 }, 200, corsHeaders);
    }
    out.contentB64 = bytesToB64(buf);
    out.bytes = buf.byteLength;
    return json(out, 200, corsHeaders);
  }

  const text = await upstream.text();
  if (upstream.ok) {
    try {
      out.data = text ? JSON.parse(text) : null;
    } catch {
      out.data = text;
    }
  } else {
    try {
      out.payload = text ? JSON.parse(text) : { message: text.slice(0, 200) };
    } catch {
      out.payload = { message: text.slice(0, 200) };
    }
  }
  return json(out, 200, corsHeaders);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const allowed =
      !origin ||
      ALLOWED_ORIGINS.has(origin) ||
      origin.startsWith("http://localhost") ||
      origin.startsWith("http://127.0.0.1");

    const corsHeaders = {
      "Access-Control-Allow-Origin": allowed ? origin || "https://yunyu-ca.github.io" : "null",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
    };

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
    if (!allowed) return json({ ok: false, error: "origin not allowed" }, 403, corsHeaders);

    if (url.pathname === "/proxy") {
      if (request.method !== "POST") return json({ ok: false, error: "请对 /proxy 使用 POST" }, 405, corsHeaders);
      return handleProxy(request, env, corsHeaders);
    }
    if (url.pathname === "/ping") {
      return json({ ok: true, service: "lucky-chip-sync", version: "v2", repo: env.REPO_NAME || "YunYu-ca.github.io" }, 200, corsHeaders);
    }
    return handleLegacy(request, env, corsHeaders, url);
  },
};
