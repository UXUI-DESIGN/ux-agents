// 세션 상세 (리서처) — 로그인한 본인의 세션만. 남의 세션 id는 모두 404('볼 수 없는 세션')
//   GET  /api/sessions/:id                              세션 정보 + 참가자 목록 (철회는 번호와 상태만)
//   POST /api/sessions/:id/close                        링크 닫기 (새 참가자를 더 받지 않음)
//   GET  /api/sessions/:id/interviews/:iid              전사 (발화·분석 제외·마스킹 구간·메모). 처음 열 때 개인정보를 찾아 표시
//   PUT  /api/sessions/:id/messages/:mid/note           { observation, interpretation } 메모 저장
//   PUT  /api/sessions/:id/messages/:mid/redactions     { spans } 마스킹 구간 고치기 (풀기·더 가리기)
//   /api/sessions/:id/debrief[/generate|draft|finalize] 디브리핑 초안·확정 (debrief.js)

import { currentUser } from "./auth.js";
import { debrief } from "./debrief.js";
import { firstJson } from "./json.js";

const NOT_FOUND = { error: "볼 수 없는 세션입니다.", code: "not_found" };
const MAX_NOTE = 4000;
const PII_KINDS = ["이름", "연락처", "이메일", "회사·기관", "주소", "계정", "기타"];

export async function sessionDetail(request, env, json, sessionId, sub, subId, subAction) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: "로그인이 필요해요.", code: "unauthorized" }, 401);
  const s = await env.DB.prepare(
    `SELECT id, name, guide_id, guide_title, guide_snapshot, duration, expected_participants, link_token, status, created_at, closed_at,
            (SELECT COUNT(*) FROM guides g WHERE g.id = interview_sessions.guide_id AND g.user_id = interview_sessions.user_id) AS guide_exists
       FROM interview_sessions WHERE id = ? AND user_id = ?`
  ).bind(sessionId, user.id).first();
  if (!s) return json(NOT_FOUND, 404);
  const method = request.method;

  if (!sub && method === "GET") return json({ session: sessionInfo(s), participants: await participantsOf(env, s.id) });
  if (sub === "debrief") return debrief(request, env, json, s, user, subId);

  if (sub === "close" && method === "POST") {
    if (s.status === "open") {
      const now = Math.floor(Date.now() / 1000);
      await env.DB.prepare("UPDATE interview_sessions SET status = 'closed', closed_at = ? WHERE id = ?").bind(now, s.id).run();
      s.status = "closed";
      s.closed_at = now;
    }
    return json({ session: sessionInfo(s) });
  }

  if (sub === "interviews" && subId && !subAction && method === "GET") {
    const iv = await env.DB.prepare(
      "SELECT id, seq, code, status, profile, consented_at, finished_at, paused_total, created_at FROM interviews WHERE id = ? AND session_id = ?"
    ).bind(subId, s.id).first();
    if (!iv) return json({ error: "참가자를 찾을 수 없어요.", code: "not_found" }, 404);
    if (iv.status === "withdrawn") return json({ interview: { id: iv.id, seq: iv.seq, status: "withdrawn" }, messages: [] });

    const { results } = await env.DB.prepare(
      `SELECT m.id, m.role, m.content, m.stage, m.excluded, m.created_at, m.pii, m.pii_checked_at,
              COALESCE(n.observation, '') AS observation, COALESCE(n.interpretation, '') AS interpretation
         FROM interview_messages m LEFT JOIN message_notes n ON n.message_id = m.id
        WHERE m.interview_id = ? ORDER BY m.id`
    ).bind(iv.id).all();
    await detectPii(env, results);
    return json({
      interview: { ...interviewRow(iv), profile: iv.profile ? JSON.parse(iv.profile) : {} },
      messages: results.map((m) => ({
        id: m.id, role: m.role, content: m.content, stage: m.stage, excluded: !!m.excluded, created_at: m.created_at,
        pii: m.pii ? JSON.parse(m.pii) : [], observation: m.observation, interpretation: m.interpretation,
      })),
    });
  }

  if (sub === "messages" && subId && (subAction === "note" || subAction === "redactions") && method === "PUT") {
    // 이 세션의 발화인지 확인 (남의 세션 발화 id로는 고칠 수 없다)
    const m = await env.DB.prepare(
      "SELECT m.id, m.content FROM interview_messages m JOIN interviews i ON i.id = m.interview_id WHERE m.id = ? AND i.session_id = ?"
    ).bind(Number(subId), s.id).first();
    if (!m) return json({ error: "발화를 찾을 수 없어요.", code: "not_found" }, 404);
    let body;
    try { body = await request.json(); } catch { return json({ error: "JSON 본문이 필요해요." }, 400); }
    const now = Math.floor(Date.now() / 1000);

    if (subAction === "note") {
      const obs = typeof body.observation === "string" ? body.observation.slice(0, MAX_NOTE) : "";
      const int = typeof body.interpretation === "string" ? body.interpretation.slice(0, MAX_NOTE) : "";
      await env.DB.prepare(
        `INSERT INTO message_notes (message_id, observation, interpretation, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(message_id) DO UPDATE SET observation = excluded.observation, interpretation = excluded.interpretation, updated_at = excluded.updated_at`
      ).bind(m.id, obs, int, now).run();
      return json({ ok: true, updated_at: now });
    }

    const spans = cleanSpans(body.spans, m.content.length);
    if (!spans) return json({ error: "마스킹 구간 형식이 올바르지 않아요." }, 400);
    await env.DB.prepare("UPDATE interview_messages SET pii = ?, pii_checked_at = COALESCE(pii_checked_at, ?) WHERE id = ?")
      .bind(JSON.stringify(spans), now, m.id).run();
    return json({ ok: true, pii: spans });
  }

  return json({ error: "없는 경로예요." }, 404);
}

function sessionInfo(s) {
  const snap = JSON.parse(s.guide_snapshot);
  return {
    id: s.id, name: s.name, topic: snap.source === "guide" ? snap.input?.topic || s.name : s.name,
    guide_id: s.guide_id, guide_title: s.guide_title, guide_exists: !!s.guide_exists,
    token: s.link_token, status: s.status, duration: s.duration, expected: s.expected_participants,
    created_at: s.created_at, closed_at: s.closed_at,
  };
}

function interviewRow(iv) {
  if (iv.status === "withdrawn") return { id: iv.id, seq: iv.seq, status: "withdrawn" };
  const end = iv.finished_at;
  return {
    id: iv.id, seq: iv.seq, code: iv.code, status: iv.status, started_at: iv.consented_at, finished_at: end,
    duration_sec: end && iv.consented_at ? Math.max(0, end - iv.consented_at - (iv.paused_total || 0)) : null,
  };
}

async function participantsOf(env, sessionId) {
  const { results } = await env.DB.prepare(
    `SELECT i.id, i.seq, i.code, i.status, i.consented_at, i.finished_at, i.paused_total, i.created_at,
            (SELECT COUNT(*) FROM interview_messages m WHERE m.interview_id = i.id) AS messages,
            (SELECT COUNT(*) FROM interview_messages m WHERE m.interview_id = i.id AND m.role = 'participant') AS participant_messages
       FROM interviews i WHERE i.session_id = ? ORDER BY i.seq`
  ).bind(sessionId).all();
  return results.map((r) => (r.status === "withdrawn" ? interviewRow(r) : { ...interviewRow(r), messages: r.messages, participant_messages: r.participant_messages }));
}

// ── 개인정보 찾기 ──
// 규칙(전화·이메일·주민번호·계좌)으로 먼저 찾고, 이름·회사·주소처럼 규칙으로 안 잡히는 것은 AI로 찾는다.
// 한 번 찾은 발화는 pii_checked_at을 남겨 다시 찾지 않는다 (리서처가 고친 구간이 덮이지 않게).
const RULES = [
  ["이메일", /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g],
  ["연락처", /(?:\+82[-\s]?)?0\d{1,2}[-.\s]?\d{3,4}[-.\s]?\d{4}/g],
  ["기타", /\d{6}[-\s]?[1-4]\d{6}/g], // 주민등록번호
  ["기타", /\d{3,6}-\d{2,6}-\d{2,8}/g], // 계좌번호 꼴
];

export async function detectPii(env, messages) {
  const todo = messages.filter((m) => !m.pii_checked_at);
  if (!todo.length) return;
  const found = new Map(todo.map((m) => [m.id, ruleSpans(m.content)]));

  let aiOk = false;
  if (env.OPENAI_API_KEY) {
    try {
      for (const chunk of chunks(todo, 12000)) {
        const items = await aiFind(env, chunk);
        for (const { i, text, kind } of items) {
          const m = chunk[i];
          if (!m || !text || text.length < 2) continue;
          let at = m.content.indexOf(text);
          while (at >= 0) {
            found.get(m.id).push({ s: at, e: at + text.length, kind: PII_KINDS.includes(kind) ? kind : "기타" });
            at = m.content.indexOf(text, at + text.length);
          }
        }
      }
      aiOk = true;
    } catch (err) {
      console.error("pii ai failed", String(err?.message || err));
    }
  }

  const now = Math.floor(Date.now() / 1000);
  const stmts = [];
  for (const m of todo) {
    const spans = merge(found.get(m.id)).map((x) => ({ ...x, src: "auto", on: true }));
    m.pii = JSON.stringify(spans);
    // AI가 실패하면 규칙으로 찾은 것만 보여 주고, 다음에 열 때 다시 찾는다
    if (aiOk) m.pii_checked_at = now;
    stmts.push(env.DB.prepare("UPDATE interview_messages SET pii = ?, pii_checked_at = ? WHERE id = ?").bind(m.pii, aiOk ? now : null, m.id));
  }
  if (stmts.length) await env.DB.batch(stmts);
}

function ruleSpans(text) {
  const spans = [];
  for (const [kind, re] of RULES) for (const m of text.matchAll(re)) spans.push({ s: m.index, e: m.index + m[0].length, kind });
  return spans;
}

// 겹치는 구간은 하나로
function merge(spans) {
  const sorted = [...spans].sort((a, b) => a.s - b.s || b.e - a.e);
  const out = [];
  for (const x of sorted) {
    const last = out.at(-1);
    if (last && x.s < last.e) last.e = Math.max(last.e, x.e);
    else out.push({ ...x });
  }
  return out;
}

function chunks(list, maxChars) {
  const out = [];
  let cur = [], size = 0;
  for (const m of list) {
    if (cur.length && size + m.content.length > maxChars) { out.push(cur); cur = []; size = 0; }
    cur.push(m);
    size += m.content.length;
  }
  if (cur.length) out.push(cur);
  return out;
}

const PII_SCHEMA = {
  type: "object", additionalProperties: false, required: ["items"],
  properties: {
    items: { type: "array", items: {
      type: "object", additionalProperties: false, required: ["i", "text", "kind"],
      properties: { i: { type: "integer" }, text: { type: "string" }, kind: { type: "string", enum: PII_KINDS } },
    } },
  },
};

async function aiFind(env, chunk) {
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: env.OPENAI_MODEL,
      instructions: `당신은 UX 리서치 전사본의 개인정보 마스킹 도우미입니다. 발화 목록에서 참가자 본인이나 다른 사람을 특정할 수 있는 정보를 찾아, 발화에 적힌 그대로의 문자열로 돌려줍니다.
찾을 것: 사람 이름(성+이름, 이름만, '김 대리'처럼 호칭이 붙은 이름 포함), 다니는 회사·학교·병원·기관의 고유한 이름, 동·호수나 도로명까지의 상세 주소, 전화번호, 이메일, SNS·서비스 아이디, 차량 번호 등.
찾지 않을 것: 리서치 대상인 앱·서비스·브랜드·제품 이름(예: 토스, 카카오뱅크, 쿠팡), '편의점', '회사', '엄마'처럼 누구인지 특정되지 않는 일반 명사, 시·도·구 단위의 넓은 지역, 연령대·직군.
i는 발화 번호, text는 발화에 나온 그대로(띄어쓰기 포함), kind는 종류입니다. 없으면 빈 배열.`,
      input: chunk.map((m, i) => `[${i}] ${m.content}`).join("\n"),
      text: { format: { type: "json_schema", name: "pii", schema: PII_SCHEMA, strict: true } },
      reasoning: { effort: "none" },
      max_output_tokens: 2000,
      store: false,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`OpenAI ${res.status}`);
  const raw = (data.output || []).filter((x) => x.type === "message").flatMap((x) => x.content || [])
    .filter((c) => c.type === "output_text").map((c) => c.text).join("");
  const parsed = firstJson(raw);
  if (!parsed) throw new Error("개인정보 찾기 답을 읽지 못함");
  return parsed.items || [];
}

function cleanSpans(spans, len) {
  if (!Array.isArray(spans) || spans.length > 200) return null;
  const out = [];
  for (const x of spans) {
    const s = Number(x?.s), e = Number(x?.e);
    if (!Number.isInteger(s) || !Number.isInteger(e) || s < 0 || e > len || s >= e) return null;
    out.push({ s, e, kind: PII_KINDS.includes(x.kind) ? x.kind : "기타", src: x.src === "manual" ? "manual" : "auto", on: x.on !== false });
  }
  return out.sort((a, b) => a.s - b.s);
}
