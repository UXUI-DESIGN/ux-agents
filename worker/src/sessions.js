// 인터뷰 세션 (AI 인터뷰 모더레이터)
//   리서처(로그인): 모든 조회를 WHERE user_id = 로그인한 사용자 로 묶는다. 남의 세션·가이드는 404.
//     GET  /api/sessions                 내 세션 목록 (참가자 수 포함)
//     POST /api/sessions                 세션 만들기 → { id, token }
//   참가자(로그인 없음, 링크의 무작위 값으로만 접근):
//     GET  /api/p/:token                 참가자에게 보여줄 세션 정보 (가이드 내용은 내보내지 않음)
//     POST /api/p/:token/interviews      들어올 때마다 별도 인터뷰 기록을 만든다 → { interviewId }

import { currentUser, rateLimit } from "./auth.js";

// 참가자에게 받을 수 있는 항목. 개인을 특정하지 않는 것만 둔다 (이름·연락처는 없다)
export const COLLECT_OPTIONS = {
  age_group: "연령대",
  occupation: "직군",
  region: "거주 지역(시·도)",
  usage_period: "서비스 사용 기간",
  usage_frequency: "사용 빈도",
};

const DURATIONS = [30, 45, 60];
const MAX_BODY_CHARS = 200000;
const NOT_FOUND = { error: "세션을 찾을 수 없어요.", code: "not_found" };

export async function sessions(request, env, json) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: "로그인이 필요해요.", code: "unauthorized" }, 401);

  if (request.method === "GET") {
    const { results } = await env.DB.prepare(
      `SELECT s.id, s.name, s.guide_title, s.duration, s.expected_participants, s.link_token AS token, s.status, s.created_at,
              (SELECT COUNT(*) FROM interviews i WHERE i.session_id = s.id) AS participants
         FROM interview_sessions s WHERE s.user_id = ? ORDER BY s.created_at DESC`
    ).bind(user.id).all();
    return json({ sessions: results });
  }

  if (request.method === "POST") return createSession(request, env, json, user);
  return json({ error: "없는 경로예요." }, 404);
}

async function createSession(request, env, json, user) {
  const raw = await request.text();
  if (raw.length > MAX_BODY_CHARS) return json({ error: "내용이 너무 길어요." }, 413);
  let body;
  try { body = JSON.parse(raw); } catch { return json({ error: "JSON 본문이 필요해요." }, 400); }

  const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const name = str(body.name, 100);
  const purpose = str(body.purpose, 2000);
  const consent = str(body.consent, 5000);
  const duration = Number(body.duration);
  const expected = body.expected === null || body.expected === "" || body.expected === undefined ? null : Number(body.expected);
  const collect = Array.isArray(body.collect) ? [...new Set(body.collect)] : [];

  if (!name) return json({ error: "세션 이름을 적어 주세요.", field: "name" }, 400);
  if (!purpose) return json({ error: "참가자에게 보여줄 인터뷰 목적을 적어 주세요.", field: "purpose" }, 400);
  if (!consent) return json({ error: "동의서 문구를 적어 주세요.", field: "consent" }, 400);
  if (!DURATIONS.includes(duration)) return json({ error: "세션 시간은 30·45·60분 중에서 골라 주세요.", field: "duration" }, 400);
  if (expected !== null && !(Number.isInteger(expected) && expected >= 1 && expected <= 500)) {
    return json({ error: "예상 참가자 수는 1~500 사이 숫자로 적어 주세요.", field: "expected" }, 400);
  }
  if (collect.some((k) => !(k in COLLECT_OPTIONS))) return json({ error: "받을 수 없는 항목이 있어요.", field: "collect" }, 400);

  // 가이드: 내 가이드를 고르거나, 내용을 직접 붙여 넣는다. 어느 쪽이든 지금 내용을 복사해 둔다
  let guideId = null, guideTitle, snapshot;
  if (typeof body.guideId === "string" && body.guideId) {
    const g = await env.DB.prepare("SELECT id, title, input, content FROM guides WHERE id = ? AND user_id = ?")
      .bind(body.guideId, user.id).first();
    if (!g) return json({ error: "가이드를 찾을 수 없어요.", code: "guide_not_found", field: "guide" }, 404);
    guideId = g.id;
    guideTitle = g.title;
    snapshot = { source: "guide", input: JSON.parse(g.input), content: JSON.parse(g.content) };
  } else {
    const text = str(body.guideText, 100000);
    if (text.length < 20) return json({ error: "인터뷰 가이드를 고르거나 내용을 붙여 넣어 주세요.", field: "guide" }, 400);
    guideTitle = "직접 붙여 넣은 가이드";
    snapshot = { source: "pasted", text };
  }

  const id = crypto.randomUUID();
  const token = randomToken();
  await env.DB.prepare(
    `INSERT INTO interview_sessions (id, user_id, guide_id, guide_title, guide_snapshot, name, purpose, duration, expected_participants, collect, consent, link_token, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, user.id, guideId, guideTitle, JSON.stringify(snapshot), name, purpose, duration, expected, JSON.stringify(collect), consent, token, Math.floor(Date.now() / 1000)).run();
  return json({ id, token }, 201);
}

// ── 참가자용 ──
export async function participant(request, env, json, token, sub) {
  if (!/^[A-Za-z0-9_-]{40,}$/.test(token)) return json(NOT_FOUND, 404);
  const s = await env.DB.prepare("SELECT id, name, purpose, duration, collect, consent, status FROM interview_sessions WHERE link_token = ?")
    .bind(token).first();
  if (!s) return json(NOT_FOUND, 404);

  if (!sub && request.method === "GET") {
    const collect = JSON.parse(s.collect).map((key) => ({ key, label: COLLECT_OPTIONS[key] }));
    return json({ session: { name: s.name, purpose: s.purpose, duration: s.duration, collect, consent: s.consent, status: s.status } });
  }

  if (sub === "interviews" && request.method === "POST") {
    if (s.status !== "open") return json({ error: "지금은 참여할 수 없는 세션이에요.", code: "closed" }, 409);
    const now = Math.floor(Date.now() / 1000);
    const limited = await rateLimit(request, env, json, "interview", "참여", now);
    if (limited) return limited;
    const interviewId = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO interviews (id, session_id, created_at) VALUES (?, ?, ?)").bind(interviewId, s.id, now).run();
    return json({ interviewId }, 201);
  }

  return json({ error: "없는 경로예요." }, 404);
}

// 32바이트 무작위 값 (base64url, 43자) — 추측할 수 없는 참가자 링크
function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
