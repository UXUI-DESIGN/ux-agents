// 세션 디브리핑 (리서처) — 스킬 §5.1: 톱 인사이트 3 · 인상적 인용구 5~7 · 다음 세션에서 고칠 점 + 포화 판단
//   GET  /api/sessions/:id/debrief            초안·확정본
//   POST /api/sessions/:id/debrief/generate   완료된 참가자의 마스킹된 전사로 초안 만들기 (OpenAI)
//   PUT  /api/sessions/:id/debrief/draft      { content } 초안 고치기
//   POST /api/sessions/:id/debrief/finalize   { content } 확정 → 내 디브리핑
//   GET  /api/debriefs                        내 확정 디브리핑 목록 (마이페이지 '내 디브리핑')
// 읽는 것: 상태가 completed인 참가자의 발화 중 '분석 제외'가 아닌 것만, 개인정보는 [REDACTED]로 바꾼 뒤.
// 철회한 참가자는 기록 자체가 지워져 있고, 상태로도 걸러낸다.

import { currentUser } from "./auth.js";
import { detectPii } from "./sessionDetail.js";
import { firstJson } from "./json.js";

const MAX_TRANSCRIPT_CHARS = 60000;
const MAX_CONTENT_CHARS = 60000;
const CONFIDENCE = ["높음", "보통", "낮음"];
const IMPROVE_TYPES = ["놓친 프로빙", "이해하지 못한 질문", "시간이 모자란 블록", "기타"];
const SATURATION = ["포화", "새 정보 나오는 중", "판단 어려움"];

export async function debrief(request, env, json, session, user, action) {
  const method = request.method;
  const row = await env.DB.prepare("SELECT * FROM debriefs WHERE session_id = ?").bind(session.id).first();

  if (!action && method === "GET") return json({ debrief: view(row), sources: await sourcesOf(env, session.id) });

  if (action === "generate" && method === "POST") {
    const material = await materialOf(env, session);
    if (!material.participants.length) return json({ error: "완료된 참가자가 없어요. 인터뷰를 마친 참가자가 있어야 디브리핑을 만들 수 있어요.", code: "no_completed" }, 409);
    if (!env.OPENAI_API_KEY) return json({ error: "AI를 부르지 못했어요. 잠시 후 다시 시도해 주세요." }, 502);
    let content;
    try {
      content = await askDebrief(env, session, material);
    } catch (err) {
      console.error("debrief failed", String(err?.message || err));
      return json({ error: "디브리핑을 만들지 못했어요. 잠시 후 다시 시도해 주세요." }, 502);
    }
    const now = Math.floor(Date.now() / 1000);
    const meta = { generated_at: now, model: env.OPENAI_MODEL, participants: material.participants.map((p) => p.code), skipped_excluded: material.skippedExcluded };
    await save(env, session, user, row, { draft: content, draft_meta: meta, draft_updated_at: now });
    return json({ debrief: view({ ...row, draft: JSON.stringify(content), draft_meta: JSON.stringify(meta), draft_updated_at: now, final: row?.final, final_meta: row?.final_meta, finalized_at: row?.finalized_at }) });
  }

  if ((action === "draft" && method === "PUT") || (action === "finalize" && method === "POST")) {
    let body;
    try { body = JSON.parse(await request.text()); } catch { return json({ error: "JSON 본문이 필요해요." }, 400); }
    const content = clean(body.content);
    if (!content) return json({ error: "디브리핑 형식이 올바르지 않아요." }, 400);
    if (JSON.stringify(content).length > MAX_CONTENT_CHARS) return json({ error: "디브리핑이 너무 길어요." }, 413);
    const now = Math.floor(Date.now() / 1000);
    const meta = row?.draft_meta ? JSON.parse(row.draft_meta) : {};
    const fields = action === "draft"
      ? { draft: content, draft_meta: meta, draft_updated_at: now }
      : { draft: content, draft_meta: meta, draft_updated_at: now, final: content, final_meta: meta, finalized_at: now };
    await save(env, session, user, row, fields);
    const next = await env.DB.prepare("SELECT * FROM debriefs WHERE session_id = ?").bind(session.id).first();
    return json({ debrief: view(next) });
  }

  return json({ error: "없는 경로예요." }, 404);
}

export async function myDebriefs(request, env, json) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: "로그인이 필요해요.", code: "unauthorized" }, 401);
  const { results } = await env.DB.prepare(
    `SELECT d.session_id, d.final, d.final_meta, d.finalized_at, s.name, s.guide_snapshot, s.guide_title
       FROM debriefs d JOIN interview_sessions s ON s.id = d.session_id
      WHERE d.user_id = ? AND s.user_id = ? AND d.final IS NOT NULL ORDER BY d.finalized_at DESC`
  ).bind(user.id, user.id).all();
  return json({
    debriefs: results.map((r) => {
      const snap = JSON.parse(r.guide_snapshot);
      return {
        session_id: r.session_id, session_name: r.name, guide_title: r.guide_title,
        topic: snap.source === "guide" ? snap.input?.topic || r.name : r.name,
        finalized_at: r.finalized_at, meta: JSON.parse(r.final_meta || "{}"), content: JSON.parse(r.final),
      };
    }),
  });
}

function view(row) {
  if (!row) return null;
  return {
    draft: row.draft ? JSON.parse(row.draft) : null,
    draft_meta: row.draft_meta ? JSON.parse(row.draft_meta) : null,
    draft_updated_at: row.draft_updated_at,
    final: row.final ? JSON.parse(row.final) : null,
    final_meta: row.final_meta ? JSON.parse(row.final_meta) : null,
    finalized_at: row.finalized_at,
    // 초안이 확정본과 같으면 '확정됨', 다르거나 확정본이 없으면 '초안'
    is_draft: !row.final || row.draft !== row.final,
  };
}

async function save(env, session, user, row, f) {
  const j = (v) => (v === undefined ? undefined : v === null ? null : JSON.stringify(v));
  if (!row) {
    await env.DB.prepare(
      "INSERT INTO debriefs (session_id, user_id, draft, draft_meta, draft_updated_at, final, final_meta, finalized_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(session.id, user.id, j(f.draft) ?? null, j(f.draft_meta) ?? null, f.draft_updated_at ?? null, j(f.final) ?? null, j(f.final_meta) ?? null, f.finalized_at ?? null).run();
    return;
  }
  const sets = [], vals = [];
  for (const k of ["draft", "draft_meta", "final", "final_meta"]) if (f[k] !== undefined) { sets.push(`${k} = ?`); vals.push(j(f[k])); }
  for (const k of ["draft_updated_at", "finalized_at"]) if (f[k] !== undefined) { sets.push(`${k} = ?`); vals.push(f[k]); }
  await env.DB.prepare(`UPDATE debriefs SET ${sets.join(", ")} WHERE session_id = ?`).bind(...vals, session.id).run();
}

// 화면에 보여 줄 '읽을 대상' 요약 (몇 명이 완료됐는지)
async function sourcesOf(env, sessionId) {
  const { results } = await env.DB.prepare("SELECT status, COUNT(*) AS n FROM interviews WHERE session_id = ? GROUP BY status").bind(sessionId).all();
  const by = Object.fromEntries(results.map((r) => [r.status, r.n]));
  return { completed: by.completed || 0, in_progress: (by.in_progress || 0) + (by.consented || 0), stopped: by.stopped || 0, withdrawn: by.withdrawn || 0 };
}

// ── 읽을 자료 만들기: 완료된 참가자만, 분석 제외 빼고, 마스킹해서 ──
// interviewIds를 주면 그 참가자만 읽는다 (페르소나 생성에서 고른 인터뷰만)
export async function materialOf(env, session, interviewIds = null) {
  const { results: all } = await env.DB.prepare(
    "SELECT id, code, seq, consented_at, finished_at, paused_total, stage FROM interviews WHERE session_id = ? AND status = 'completed' AND code IS NOT NULL ORDER BY seq"
  ).bind(session.id).all();
  const ivs = interviewIds ? all.filter((iv) => interviewIds.includes(iv.id)) : all;
  const participants = [];
  let skippedExcluded = 0;
  for (const iv of ivs) {
    const { results: msgs } = await env.DB.prepare(
      "SELECT id, role, content, stage, excluded, created_at, pii, pii_checked_at FROM interview_messages WHERE interview_id = ? ORDER BY id"
    ).bind(iv.id).all();
    await detectPii(env, msgs); // 아직 개인정보를 찾지 않은 발화가 있으면 먼저 찾는다
    let pIdx = 0, mIdx = 0;
    const lines = [];
    for (const m of msgs) {
      if (m.excluded) { skippedExcluded++; continue; } // 분석 제외 구간은 절대 읽지 않는다
      const ref = m.role === "participant" ? `${iv.code}-${++pIdx}` : `${iv.code}-M${++mIdx}`;
      lines.push({ ref, id: m.id, role: m.role, stage: m.stage, at: m.created_at - (iv.consented_at || m.created_at), text: maskText(m.content, m.pii) });
    }
    participants.push({ id: iv.id, code: iv.code, seq: iv.seq, minutes: iv.finished_at && iv.consented_at ? Math.round((iv.finished_at - iv.consented_at - (iv.paused_total || 0)) / 60) : null, lines });
  }
  return { participants, skippedExcluded };
}

export function maskText(content, pii) {
  const spans = (typeof pii === "string" ? JSON.parse(pii || "[]") : pii || []).filter((x) => x.on).sort((a, b) => a.s - b.s);
  let out = "", at = 0;
  for (const sp of spans) { if (sp.s < at) continue; out += content.slice(at, sp.s) + "[REDACTED]"; at = sp.e; }
  return out + content.slice(at);
}

export function transcriptText(material, stages) {
  let total = 0;
  const parts = [];
  for (const p of material.participants) {
    const head = `## ${p.code}${p.minutes != null ? ` (약 ${p.minutes}분)` : ""}`;
    const body = p.lines.map((l) => `[${l.ref}] ${l.role === "participant" ? p.code : "모더레이터"} (${stages[l.stage] || "?"}): ${l.text}`).join("\n");
    const chunk = `${head}\n${body}`;
    if (total + chunk.length > MAX_TRANSCRIPT_CHARS) { parts.push(`${head}\n(분량이 많아 이 참가자부터는 생략했습니다)`); break; }
    total += chunk.length;
    parts.push(chunk);
  }
  return parts.join("\n\n");
}

// ── OpenAI ──
const REF = { type: "string", description: "발화 번호. 예: P01-3 (참가자 발화), P01-M2 (모더레이터 발화)" };
const SCHEMA = {
  type: "object", additionalProperties: false, required: ["insights", "quotes", "improvements", "saturation"],
  properties: {
    insights: { type: "array", items: {
      type: "object", additionalProperties: false, required: ["text", "refs", "confidence", "confidence_reason"],
      properties: {
        text: { type: "string", description: "한 문장" },
        refs: { type: "array", items: REF, description: "근거가 된 참가자 발화 번호들" },
        confidence: { type: "string", enum: CONFIDENCE },
        confidence_reason: { type: "string", description: "그렇게 판단한 이유 한 문장 (예: 3명 중 3명이 같은 경험)" },
      },
    } },
    quotes: { type: "array", items: {
      type: "object", additionalProperties: false, required: ["ref", "text", "why"],
      properties: { ref: REF, text: { type: "string", description: "참가자가 한 말 그대로 (일부를 잘라도 되지만 고치지 말 것)" }, why: { type: "string", description: "왜 인상적인지 짧게" } },
    } },
    improvements: { type: "array", items: {
      type: "object", additionalProperties: false, required: ["type", "text", "refs"],
      properties: { type: { type: "string", enum: IMPROVE_TYPES }, text: { type: "string" }, refs: { type: "array", items: REF } },
    } },
    saturation: { type: "array", items: {
      type: "object", additionalProperties: false, required: ["topic", "status", "note"],
      properties: { topic: { type: "string" }, status: { type: "string", enum: SATURATION }, note: { type: "string" } },
    } },
  },
};

async function askDebrief(env, session, material) {
  const snap = JSON.parse(session.guide_snapshot);
  const topic = snap.source === "guide" ? snap.input?.topic || session.name : session.name;
  const blocks = snap.source === "guide" ? (snap.content?.blocks || []) : [];
  const stages = snap.source === "guide" ? ["워밍업", ...blocks.map((b, i) => `블록 ${"ABC"[i] || i + 1}`), "클로징"] : ["시작", "본 질문", "마무리"];
  const rqs = snap.source === "guide" ? (snap.content?.rqs || []) : [];
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: env.OPENAI_MODEL,
      instructions: `당신은 숙련된 UX 리서처입니다. 1:1 사용자 인터뷰 세션들의 전사를 읽고, 세션 직후 팀이 쓰는 디브리핑 노트 초안을 한국어로 씁니다.
연구 주제: ${topic}
${rqs.length ? `연구 질문:\n${rqs.map((r, i) => `RQ${i + 1}. ${r}`).join("\n")}` : ""}
세션 시간: ${session.duration}분 · 단계: ${stages.join(" → ")}
${blocks.length ? `블록: ${blocks.map((b, i) => `${"ABC"[i] || i + 1}=${b.title}`).join(", ")}` : ""}

규칙
- 근거는 아래 전사에 있는 것만. 추측이나 일반론을 사실처럼 쓰지 않습니다.
- 전사의 [REDACTED]는 가린 개인정보입니다. 추측해서 채우지 않습니다.
- insights: 정확히 3개. 각각 한 문장. refs에는 근거가 된 참가자 발화 번호(P01-3 형식)를 적습니다. confidence는 근거의 양과 일관성으로: 여러 참가자가 같은 경험을 했으면 높음, 한두 명이면 보통, 한 번의 짧은 언급이거나 해석이 크게 들어가면 낮음.
- quotes: 5~7개. 참가자 발화만(모더레이터 발화 M은 절대 인용하지 않음). text는 발화에 있는 문장을 글자 그대로. 줄일 수는 있어도 고치거나 다듬지 않습니다.
- improvements: 다음 세션에서 고칠 점. 모더레이터가 놓친 프로빙(답 뒤에 꼬리 질문 없이 넘어간 곳), 참가자가 이해하지 못한 질문(되묻거나 엉뚱하게 답한 곳), 시간이 모자란 블록(클로징 직전에 급히 넘어간 블록 등). refs에 해당 발화 번호.
- saturation: 주제별로 새 정보가 더 나오는지. 여러 참가자에서 같은 이야기만 반복되면 '포화', 참가자마다 새로운 내용이 나오면 '새 정보 나오는 중', 참가자가 적어 판단하기 이르면 '판단 어려움'. note에 근거 한 문장.`,
      input: transcriptText(material, stages),
      text: { format: { type: "json_schema", name: "debrief", schema: SCHEMA, strict: true } },
      reasoning: { effort: "low" },
      max_output_tokens: 4000,
      store: false,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${data?.error?.message || ""}`);
  if (data.status === "incomplete") throw new Error("incomplete");
  const raw = (data.output || []).filter((x) => x.type === "message").flatMap((x) => x.content || [])
    .filter((c) => c.type === "output_text").map((c) => c.text).join("");
  const parsed = firstJson(raw);
  if (!parsed?.insights) throw new Error("디브리핑 답을 읽지 못함");
  return verify(parsed, material);
}

// AI가 쓴 근거를 전사와 맞춰 본다: 인용구가 그 참가자 발화에 글자 그대로 있는지, 발화 번호가 실제로 있는지
export function verify(d, material) {
  const byRef = new Map(material.participants.flatMap((p) => p.lines.map((l) => [l.ref, { ...l, code: p.code }])));
  const norm = (s) => s.replace(/\s+/g, " ").replace(/^["'“”‘’]+|["'“”‘’.…]+$/g, "").trim();
  const refInfo = (refs) => refs.filter((r) => byRef.has(r)).map((r) => ({ ref: r, id: byRef.get(r).id, role: byRef.get(r).role }));
  return {
    insights: d.insights.slice(0, 3).map((x) => ({
      text: x.text, confidence: CONFIDENCE.includes(x.confidence) ? x.confidence : "낮음", confidence_reason: x.confidence_reason,
      refs: refInfo(x.refs).filter((r) => r.role === "participant"),
    })),
    quotes: d.quotes.slice(0, 7).map((q) => {
      const line = byRef.get(q.ref);
      const ok = !!line && line.role === "participant" && norm(line.text).includes(norm(q.text));
      return { ref: line ? q.ref : null, id: line?.id || null, code: line?.code || (q.ref || "").split("-")[0] || "", text: q.text, why: q.why, verified: ok };
    }).filter((q) => !q.ref || byRef.get(q.ref)?.role !== "moderator"),
    improvements: d.improvements.map((x) => ({ type: IMPROVE_TYPES.includes(x.type) ? x.type : "기타", text: x.text, refs: refInfo(x.refs) })),
    saturation: d.saturation.map((x) => ({ topic: x.topic, status: SATURATION.includes(x.status) ? x.status : "판단 어려움", note: x.note })),
  };
}

// 리서처가 고친 내용을 저장할 때 모양 검사
function clean(c) {
  if (!c || typeof c !== "object") return null;
  const str = (v, n = 2000) => (typeof v === "string" ? v.slice(0, n) : "");
  const refs = (v) => (Array.isArray(v) ? v.slice(0, 20).filter((r) => r && typeof r.ref === "string").map((r) => ({ ref: str(r.ref, 20), id: Number(r.id) || null, role: r.role === "moderator" ? "moderator" : "participant" })) : []);
  const arr = (v, max) => (Array.isArray(v) ? v.slice(0, max) : []);
  return {
    insights: arr(c.insights, 10).map((x) => ({ text: str(x.text), confidence: CONFIDENCE.includes(x.confidence) ? x.confidence : "낮음", confidence_reason: str(x.confidence_reason), refs: refs(x.refs) })),
    quotes: arr(c.quotes, 20).map((q) => ({ ref: q.ref ? str(q.ref, 20) : null, id: Number(q.id) || null, code: str(q.code, 10), text: str(q.text), why: str(q.why, 500), verified: q.verified === true })),
    improvements: arr(c.improvements, 30).map((x) => ({ type: IMPROVE_TYPES.includes(x.type) ? x.type : "기타", text: str(x.text), refs: refs(x.refs) })),
    saturation: arr(c.saturation, 30).map((x) => ({ topic: str(x.topic, 200), status: SATURATION.includes(x.status) ? x.status : "판단 어려움", note: str(x.note, 500) })),
    memo: str(c.memo, 4000),
  };
}
