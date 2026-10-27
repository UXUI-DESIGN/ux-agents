// UXA API 서버 — 모든 에이전트는 이 Worker를 거쳐서만 OpenAI를 부른다.
//   GET  /health         살아 있는지, 비밀값이 등록됐는지 확인
//   GET  /health/openai  비밀값 키로 OpenAI에 실제로 접속되는지 확인 (토큰 사용 없음, 키 값은 절대 내보내지 않음)
//   POST /api/chat       { input, instructions?, max_output_tokens? } → { text, model, usage }

const MAX_INPUT_CHARS = 20000;
const MAX_OUTPUT_TOKENS = 4000;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);

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

    return json({ error: "없는 경로예요." }, 404, cors);
  },
};

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
  return json({ text, model: data.model, usage: data.usage }, 200, cors);
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
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
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
