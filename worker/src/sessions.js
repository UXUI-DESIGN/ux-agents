// 인터뷰 세션 (AI 인터뷰 모더레이터)
//   리서처(로그인): 모든 조회를 WHERE user_id = 로그인한 사용자 로 묶는다. 남의 세션·가이드는 404.
//     GET  /api/sessions                 내 세션 목록 (참가자 수 포함)
//     POST /api/sessions                 세션 만들기 → { id, token }
//   참가자(로그인 없음, 링크의 무작위 값으로만 접근):
//     GET  /api/p/:token                 참가자에게 보여줄 세션 정보 (가이드 내용은 내보내지 않음)
//     POST /api/p/:token/interviews      동의하고 시작 → P코드를 매겨 별도 인터뷰로 기록 → { interview, key }
//     GET  /api/p/:token/interviews/me   X-Interview-Key로 자기 인터뷰 다시 열기 (새로고침해도 같은 참가자)
//   닫힌 세션·없는 세션은 모두 '이 인터뷰는 종료되었습니다'

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
// 참가자 링크로 할 수 있는 일은 이 세션의 정보 보기·동의·자기 인터뷰 다시 열기뿐이다.
// 리서처 계정·가이드 원문·다른 세션은 어떤 응답에도 담지 않는다.

// 참가자가 고를 수 있는 답. 모두 '답하고 싶지 않음'을 둔다
export const COLLECT_CHOICES = {
  age_group: ["10대", "20대", "30대", "40대", "50대", "60대 이상"],
  occupation: ["학생", "직장인(사무·전문직)", "직장인(서비스·현장직)", "자영업", "프리랜서", "주부", "구직 중", "기타"],
  region: ["서울", "부산", "대구", "인천", "광주", "대전", "울산", "세종", "경기", "강원", "충북", "충남", "전북", "전남", "경북", "경남", "제주", "해외"],
  usage_period: ["사용해 본 적 없음", "1개월 미만", "1~6개월", "6개월~1년", "1~3년", "3년 이상"],
  usage_frequency: ["거의 매일", "주 2~3회", "주 1회", "월 1~3회", "그보다 적게"],
};
const DECLINE = "답하고 싶지 않음";
const CONSENT_KEYS = ["record", "anonymous", "withdraw"]; // 대화 기록 저장 · 익명 처리 · 철회 권리
const ENDED = { error: "이 인터뷰는 종료되었습니다.", code: "ended" };

export async function participant(request, env, json, token, sub, me) {
  if (!/^[A-Za-z0-9_-]{40,}$/.test(token)) return json(ENDED, 404);
  const s = await env.DB.prepare("SELECT id, name, purpose, duration, collect, consent, status, guide_snapshot FROM interview_sessions WHERE link_token = ?")
    .bind(token).first();
  if (!s || s.status !== "open") return json(ENDED, s ? 410 : 404);
  const collectKeys = JSON.parse(s.collect);

  // 세션 정보: 주제·목적·시간·동의 문구·받을 항목(선택지)만
  if (!sub && request.method === "GET") {
    const snap = JSON.parse(s.guide_snapshot);
    const topic = snap.source === "guide" ? snap.input?.topic || s.name : s.name;
    const collect = collectKeys.map((key) => ({ key, label: COLLECT_OPTIONS[key], options: [...COLLECT_CHOICES[key], DECLINE] }));
    // 세션 이름은 리서처 내부용이라 보내지 않는다
    return json({ session: { topic, purpose: s.purpose, duration: s.duration, collect, consent: s.consent } });
  }

  // 새로고침·다시 열기: 처음 시작할 때 받은 열쇠로 자기 인터뷰만 찾는다
  if (sub === "interviews" && me && request.method === "GET") {
    const key = request.headers.get("X-Interview-Key") || "";
    if (!key) return json({ error: "인터뷰를 찾을 수 없어요.", code: "not_found" }, 404);
    const row = await env.DB.prepare("SELECT code, status, consented_at FROM interviews WHERE key_hash = ? AND session_id = ?")
      .bind(await sha256Hex(key), s.id).first();
    if (!row) return json({ error: "인터뷰를 찾을 수 없어요.", code: "not_found" }, 404);
    return json({ interview: { code: row.code, status: row.status, consentedAt: row.consented_at } });
  }

  // 인터뷰 시작: 동의 확인 → 이 세션의 다음 번호로 P코드를 매기고 동의 내용·시각을 저장
  if (sub === "interviews" && !me && request.method === "POST") {
    let body;
    try { body = await request.json(); } catch { return json({ error: "JSON 본문이 필요해요." }, 400); }
    const consents = body.consents || {};
    if (!CONSENT_KEYS.every((k) => consents[k] === true)) return json({ error: "모든 항목에 동의해야 시작할 수 있어요.", code: "consent_required" }, 400);

    const input = body.profile && typeof body.profile === "object" ? body.profile : {};
    const profile = {};
    for (const key of collectKeys) {
      const v = input[key];
      if (![...COLLECT_CHOICES[key], DECLINE].includes(v)) return json({ error: `${COLLECT_OPTIONS[key]}을(를) 골라 주세요.`, field: key }, 400);
      profile[key] = v;
    }

    const now = Math.floor(Date.now() / 1000);
    const limited = await rateLimit(request, env, json, "interview", "참여", now);
    if (limited) return limited;

    const interviewId = crypto.randomUUID();
    const key = randomToken();
    const consentRecord = JSON.stringify({ ...Object.fromEntries(CONSENT_KEYS.map((k) => [k, true])), text: s.consent });
    // 번호 매기기와 저장을 한 문장으로: 동시에 들어와도 같은 번호가 나오지 않는다 (UNIQUE(session_id, seq))
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const row = await env.DB.prepare(
          `INSERT INTO interviews (id, session_id, status, profile, created_at, seq, code, consents, consented_at, key_hash)
           SELECT ?, ?, 'consented', ?, ?, n, 'P' || printf('%02d', n), ?, ?, ?
             FROM (SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM interviews WHERE session_id = ?)
           RETURNING code`
        ).bind(interviewId, s.id, JSON.stringify(profile), now, consentRecord, now, await sha256Hex(key), s.id).first();
        return json({ interview: { code: row.code, status: "consented", consentedAt: now }, key }, 201);
      } catch (err) {
        if (!/UNIQUE/i.test(String(err))) throw err;
      }
    }
    return json({ error: "잠시 후 다시 시도해 주세요." }, 503);
  }

  return json({ error: "없는 경로예요." }, 404);
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// 32바이트 무작위 값 (base64url, 43자) — 추측할 수 없는 참가자 링크
function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
