// UXA API 서버 — 모든 에이전트는 이 Worker를 거쳐서만 OpenAI를 부른다.
//   GET  /health         살아 있는지, 비밀값이 등록됐는지 확인
//   GET  /health/openai  비밀값 키로 OpenAI에 실제로 접속되는지 확인 (토큰 사용 없음, 키 값은 절대 내보내지 않음)
//   POST /api/chat       { input, instructions?, max_output_tokens?, schema? } → { text, model, usage, incomplete }
//                        schema(JSON Schema)를 주면 그 형식의 JSON 문자열로만 답한다
//   POST /api/auth/signup { email, password, name, agree } → { token, user, remember }
//   POST /api/auth/login  { email, password, remember } → { token, user, remember }
//   POST /api/auth/logout Authorization: Bearer <token> → { ok }
//   GET  /api/auth/me     Authorization: Bearer <token> → { user }
//   /api/guides, /api/guides/:id  내 인터뷰 가이드 목록·저장·열기·덮어쓰기·이름 바꾸기·삭제 (guides.js)
//   /api/sessions                 내 인터뷰 세션 목록·만들기 (sessions.js)
//   /api/sessions/:id[/close|/interviews/:iid|/messages/:mid/note|redactions|/debrief/...]  세션 상세·링크 닫기·전사·메모·마스킹·디브리핑
//   GET  /api/debriefs            내 확정 디브리핑 (debrief.js)
//   /api/personas[/sources|analyze|compose|:id]  인터뷰 전사 → 어피니티 매핑 → 페르소나 문서 (personas.js)
//   /api/personas/:id/image-prompt|image, GET /api/personas/image/:imageId  프로필 사진 프롬프트 조립·생성·제공 (personaImage.js)
//   /api/personas/:id/index|chat  근거 노트 벡터 색인(rag_chunks)과 페르소나 채팅 (personaChat.js)
//   /api/p/:token[/interviews[/me[/messages|pause|resume|end|withdraw]]] 참가자 링크: 세션 정보·동의하고 시작·다시 열기·AI 모더레이터 대화

import { signup, login, logout, me } from "./auth.js";
import { guides } from "./guides.js";
import { sessions, participant } from "./sessions.js";
import { sessionDetail } from "./sessionDetail.js";
import { myDebriefs } from "./debrief.js";
import { personas } from "./personas.js";
import { servePersonaImage } from "./personaImage.js";

const MAX_INPUT_CHARS = 20000;
const MAX_OUTPUT_TOKENS = 4000;

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    try {
      return await route(request, env, cors);
    } catch (err) {
      // 요청 본문(비밀번호 등)은 남기지 않고 오류 내용만 기록한다
      console.error("unhandled", String(err?.message || err));
      return json({ error: "서버에서 문제가 생겼어요. 잠시 후 다시 시도해 주세요." }, 500, cors);
    }
  },
};

async function route(request, env, cors) {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

  if (url.pathname === "/health" && request.method === "GET") {
    return json({
      ok: true,
      service: "uxa-api",
      model: env.OPENAI_MODEL,
      openaiKey: env.OPENAI_API_KEY ? "set" : "missing",
      time: new Date().toISOString(),
    }, 200, cors);
  }

  if (url.pathname === "/health/openai" && request.method === "GET") {
    return json(await checkOpenAI(env), 200, cors);
  }

  if (url.pathname === "/api/chat" && request.method === "POST") {
    if (!cors["Access-Control-Allow-Origin"]) return json({ error: "허용되지 않은 사이트에서 온 요청이에요." }, 403, cors);
    return chat(request, env, cors);
  }

  const guidePath = url.pathname.match(/^\/api\/guides(?:\/([^/]+))?$/);
  const participantPath = url.pathname.match(/^\/api\/p\/([^/]+)(?:\/(interviews)(?:\/(me)(?:\/(messages|pause|resume|end|withdraw))?)?)?$/);
  const detailPath = url.pathname.match(/^\/api\/sessions\/([0-9a-f-]{36})(?:\/(close|interviews|messages|debrief)(?:\/([^/]+)(?:\/(note|redactions))?)?)?$/);
  // 페르소나 사진은 <img src> 로 읽으므로 Origin 검사 전에 처리한다 (id 가 열쇠, 로그인 없음)
  const imagePath = url.pathname.match(/^\/api\/personas\/image\/([0-9a-f]+)$/);
  if (imagePath && request.method === "GET") return servePersonaImage(env, imagePath[1]);

  const personaPath = url.pathname.match(/^\/api\/personas(?:\/([^/]+))?(?:\/(image-prompt|image|index|chat))?$/);
  if (url.pathname.startsWith("/api/auth/") || guidePath || participantPath || detailPath || personaPath || url.pathname === "/api/sessions" || url.pathname === "/api/debriefs") {
    if (!cors["Access-Control-Allow-Origin"]) return json({ error: "허용되지 않은 사이트에서 온 요청이에요." }, 403, cors);
    const reply = (data, status = 200) => json(data, status, cors);
    const routes = {
      "POST /api/auth/signup": signup,
      "POST /api/auth/login": login,
      "POST /api/auth/logout": logout,
      "GET /api/auth/me": me,
    };
    if (guidePath) return guides(request, env, reply, guidePath[1]);
    if (url.pathname === "/api/sessions") return sessions(request, env, reply);
    if (detailPath) return sessionDetail(request, env, reply, ...detailPath.slice(1));
    if (url.pathname === "/api/debriefs" && request.method === "GET") return myDebriefs(request, env, reply);
    if (personaPath) return personas(request, env, reply, personaPath[1], personaPath[2]);
    if (participantPath) return participant(request, env, reply, participantPath[1], participantPath[2], participantPath[3], participantPath[4]);
    const handler = routes[`${request.method} ${url.pathname}`];
    if (handler) return handler(request, env, reply);
  }

  return json({ error: "없는 경로예요." }, 404, cors);
}

async function chat(request, env, cors) {
  if (!env.OPENAI_API_KEY) return json({ error: "Worker에 OPENAI_API_KEY 비밀값이 없어요." }, 500, cors);

  let body;
  try { body = await request.json(); } catch { return json({ error: "JSON 본문이 필요해요." }, 400, cors); }

  const input = typeof body.input === "string" ? body.input.trim() : "";
  if (!input) return json({ error: "input이 비어 있어요." }, 400, cors);
  if (input.length > MAX_INPUT_CHARS) return json({ error: `input은 ${MAX_INPUT_CHARS}자 이하로 보내 주세요.` }, 413, cors);

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: env.OPENAI_MODEL,
      input,
      ...(typeof body.instructions === "string" && { instructions: body.instructions }),
      ...(body.schema && typeof body.schema === "object" && {
        text: { format: { type: "json_schema", name: "result", schema: body.schema, strict: true } },
      }),
      max_output_tokens: Math.min(Number(body.max_output_tokens) || 1000, MAX_OUTPUT_TOKENS),
      reasoning: { effort: "none" },
      store: false,
    }),
  });
  const data = await res.json().catch(() => ({}));

  // OpenAI 오류 내용은 그대로 넘기되, 키 문제는 Worker 설정 문제로 알려 준다
  if (!res.ok) {
    const error = res.status === 401 ? "Worker에 등록된 OpenAI 키가 올바르지 않아요." : data?.error?.message || "OpenAI 오류";
    return json({ error, status: res.status }, res.status === 401 ? 502 : res.status, cors);
  }

  const text = (data.output || [])
    .filter((item) => item.type === "message")
    .flatMap((item) => item.content || [])
    .filter((c) => c.type === "output_text")
    .map((c) => c.text).join("").trim();
  return json({ text, model: data.model, usage: data.usage, incomplete: data.status === "incomplete" }, 200, cors);
}

// 사용할 모델 정보를 조회해 키가 살아 있는지 본다 (생성 요청이 아니라 비용이 들지 않는다)
async function checkOpenAI(env) {
  if (!env.OPENAI_API_KEY) return { openai: "미연결", reason: "OPENAI_API_KEY 비밀값이 없어요." };
  try {
    const res = await fetch(`https://api.openai.com/v1/models/${env.OPENAI_MODEL}`, {
      headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` },
    });
    if (res.ok) return { openai: "연결됨", model: env.OPENAI_MODEL };
    if (res.status === 401) return { openai: "미연결", reason: "키가 올바르지 않아요." };
    if (res.status === 404) return { openai: "미연결", reason: `이 키로는 ${env.OPENAI_MODEL} 모델을 쓸 수 없어요.` };
    return { openai: "미연결", reason: `OpenAI 응답 오류 (${res.status})` };
  } catch {
    return { openai: "미연결", reason: "OpenAI에 접속하지 못했어요." };
  }
}

// 허용된 사이트에서 온 요청에만 CORS 헤더를 붙인다
function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!origin || !allowed.includes(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Interview-Key",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}
