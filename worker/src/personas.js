// 페르소나 (리서처, 로그인) — 모더레이터 인터뷰 전사를 분석해 페르소나 문서를 만든다
//   GET  /api/personas/sources            고를 수 있는 인터뷰: 내 세션별 '완료' 참가자 목록
//   POST /api/personas/analyze            { interview_ids, service, kind, count } → 1단계 어피니티 매핑 (OpenAI) → { analysis_id, analysis }
//   POST /api/personas/compose            { analysis_id } → 2단계 페르소나 작성 (OpenAI) → 저장 → { personas: [...] }
//   GET  /api/personas                    내 페르소나를 생성 묶음(프로젝트)별로
//   GET  /api/personas/:id                문서 1장 (+ 근거)
//   PUT  /api/personas/:id                { ...PersonaContent } 화면에서 고친 내용 저장
//   DELETE /api/personas/:id
//   /api/personas/:id/image-prompt · /api/personas/:id/image · /api/personas/image/:imageId  프로필 사진 (personaImage.js)
//
// 방법은 두 스킬을 따른다.
//   어피니티 매핑: 전사를 '한 장에 한 사실' 노트로 분해(참가자 ID 코딩) → 사전 카테고리 없이 상향식 1차 군집 → 라벨을 묶어 상위 테마(2차 군집)
//                 → 테마를 "사용자는 X 때문에 Y한다" 통찰 문장으로 → 테마별 근거 노트 수·참가자 수 → 고아 노트·소수 의견은 버리지 않고 기록
//   페르소나 제작: 인구통계가 아닌 행동 클러스터로 세그먼트를 나눔(2~5개) → 행동·동기·페인 우선, 근거 인용 첨부
//                 → 근거 없는 항목은 '(가설)' 표기 → Primary/Secondary/Tertiary 우선순위 + 비중(추정)
// 전사는 디브리핑과 같은 규칙으로 읽는다: 완료된 참가자만, '분석 제외' 발화는 빼고, 개인정보는 [REDACTED]로 가린 뒤.

import { currentUser } from "./auth.js";
import { materialOf, transcriptText } from "./debrief.js";
import { stagesOf } from "./moderator.js";
import { firstJson } from "./json.js";
import { personaImage } from "./personaImage.js";

const KINDS = ["design", "marketing"];
const PRIORITIES = ["primary", "secondary", "tertiary"];
const MAX_SOURCES = 20;
const MAX_BODY_CHARS = 200000;
const ANALYZE_TOKENS = 12000;
const COMPOSE_TOKENS = 16000;
const NOT_FOUND = { error: "페르소나를 찾을 수 없어요.", code: "not_found" };

export async function personas(request, env, json, id, action) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: "로그인이 필요해요.", code: "unauthorized" }, 401);
  const method = request.method;

  if (id && action) {
    const row = await env.DB.prepare("SELECT * FROM personas WHERE id = ? AND user_id = ?").bind(id, user.id).first();
    if (!row) return json(NOT_FOUND, 404);
    return personaImage(request, env, json, user, row, action);
  }

  if (id === "sources" && method === "GET") return json({ sessions: await sourcesOf(env, user) });
  if (id === "analyze" && method === "POST") return analyze(request, env, json, user);
  if (id === "compose" && method === "POST") return compose(request, env, json, user);
  if (!id && method === "GET") return list(env, json, user);

  if (id) {
    const row = await env.DB.prepare("SELECT * FROM personas WHERE id = ? AND user_id = ?").bind(id, user.id).first();
    if (!row) return json(NOT_FOUND, 404);
    if (method === "GET") return json({ persona: rowToPersona(row) });
    if (method === "PUT") return update(request, env, json, row);
    if (method === "DELETE") {
      await env.DB.prepare("DELETE FROM personas WHERE id = ?").bind(row.id).run();
      return json({ ok: true });
    }
  }
  return json({ error: "없는 경로예요." }, 404);
}

// ── 고를 수 있는 인터뷰 ──
async function sourcesOf(env, user) {
  const { results } = await env.DB.prepare(
    `SELECT s.id AS session_id, s.name AS session_name, s.guide_snapshot, s.created_at AS session_created_at,
            i.id, i.code, i.seq, i.consented_at, i.finished_at, i.paused_total,
            (SELECT COUNT(*) FROM interview_messages m WHERE m.interview_id = i.id AND m.role = 'participant' AND m.excluded = 0) AS participant_messages,
            (SELECT COUNT(*) FROM personas p WHERE p.user_id = s.user_id AND p.session_id = s.id) AS personas
       FROM interview_sessions s JOIN interviews i ON i.session_id = s.id
      WHERE s.user_id = ? AND i.status = 'completed' AND i.code IS NOT NULL
      ORDER BY s.created_at DESC, i.seq`
  ).bind(user.id).all();
  const bySession = new Map();
  for (const r of results) {
    if (!bySession.has(r.session_id)) {
      const snap = JSON.parse(r.guide_snapshot);
      bySession.set(r.session_id, {
        id: r.session_id, name: r.session_name,
        topic: snap.source === "guide" ? snap.input?.topic || r.session_name : r.session_name,
        created_at: r.session_created_at, personas: r.personas, interviews: [],
      });
    }
    bySession.get(r.session_id).interviews.push({
      id: r.id, code: r.code, seq: r.seq, finished_at: r.finished_at,
      minutes: r.finished_at && r.consented_at ? Math.round((r.finished_at - r.consented_at - (r.paused_total || 0)) / 60) : null,
      participant_messages: r.participant_messages,
    });
  }
  return [...bySession.values()];
}

// ── 1단계: 어피니티 매핑 ──
async function analyze(request, env, json, user) {
  const body = await readBody(request);
  if (!body) return json({ error: "JSON 본문이 필요해요." }, 400);
  const ids = Array.isArray(body.interview_ids) ? [...new Set(body.interview_ids.filter((x) => typeof x === "string"))].slice(0, MAX_SOURCES) : [];
  const service = typeof body.service === "string" ? body.service.trim().slice(0, 200) : "";
  const kind = KINDS.includes(body.kind) ? body.kind : "design";
  const count = Math.min(5, Math.max(2, Number(body.count) || 3));
  if (!ids.length) return json({ error: "인터뷰를 1건 이상 골라 주세요." }, 400);
  if (!service) return json({ error: "서비스 한 줄 설명을 적어 주세요." }, 400);

  // 고른 인터뷰가 모두 내 세션의 완료 참가자인지 확인하고, 세션별로 전사를 읽는다
  const { results: rows } = await env.DB.prepare(
    `SELECT i.id, i.session_id, s.name AS session_name, s.guide_snapshot, s.duration
       FROM interviews i JOIN interview_sessions s ON s.id = i.session_id
      WHERE s.user_id = ? AND i.status = 'completed' AND i.id IN (${ids.map(() => "?").join(",")})`
  ).bind(user.id, ...ids).all();
  if (rows.length !== ids.length) return json({ error: "고른 인터뷰 중 읽을 수 없는 것이 있어요. 목록을 새로 고쳐 주세요.", code: "bad_source" }, 400);
  if (!env.OPENAI_API_KEY) return json({ error: "AI를 부르지 못했어요. 잠시 후 다시 시도해 주세요." }, 502);

  const sessions = new Map();
  for (const r of rows) {
    if (!sessions.has(r.session_id)) sessions.set(r.session_id, { id: r.session_id, name: r.session_name, guide_snapshot: r.guide_snapshot, duration: r.duration, ids: [] });
    sessions.get(r.session_id).ids.push(r.id);
  }
  const transcripts = [];
  const sources = [];
  let skippedExcluded = 0;
  for (const s of sessions.values()) {
    const material = await materialOf(env, s, s.ids);
    skippedExcluded += material.skippedExcluded;
    const snap = JSON.parse(s.guide_snapshot);
    const topic = snap.source === "guide" ? snap.input?.topic || s.name : s.name;
    transcripts.push(`# 세션: ${s.name} (주제: ${topic})\n\n${transcriptText(material, stagesOf(snap))}`);
    for (const p of material.participants) sources.push({ interview_id: p.id, session_id: s.id, session_name: s.name, code: p.code, minutes: p.minutes });
  }
  if (!sources.some((x) => x)) return json({ error: "읽을 발화가 없어요." }, 409);
  const transcript = transcripts.join("\n\n");

  const started = Date.now();
  let analysis;
  try {
    analysis = await askAffinity(env, { service, kind, count, transcript, codes: sources.map((x) => x.code) });
  } catch (err) {
    console.error("persona analyze failed", String(err?.message || err));
    return json({ error: "인터뷰 분석에 실패했어요. 잠시 후 다시 시도해 주세요." }, 502);
  }
  const now = Math.floor(Date.now() / 1000);
  const id = crypto.randomUUID();
  const meta = { model: env.OPENAI_MODEL, analyze_ms: Date.now() - started, transcript_chars: transcript.length, skipped_excluded: skippedExcluded };
  await env.DB.prepare(
    "INSERT INTO persona_analyses (id, user_id, service, kind, count, sources, analysis, meta, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'analyzed', ?)"
  ).bind(id, user.id, service, kind, count, JSON.stringify(sources), JSON.stringify(analysis), JSON.stringify(meta), now).run();
  return json({ analysis_id: id, analysis, sources, meta });
}

// ── 2단계: 페르소나 작성 ──
async function compose(request, env, json, user) {
  const body = await readBody(request);
  if (!body || typeof body.analysis_id !== "string") return json({ error: "analysis_id가 필요해요." }, 400);
  const a = await env.DB.prepare("SELECT * FROM persona_analyses WHERE id = ? AND user_id = ?").bind(body.analysis_id, user.id).first();
  if (!a) return json({ error: "분석 결과를 찾을 수 없어요.", code: "not_found" }, 404);
  if (!env.OPENAI_API_KEY) return json({ error: "AI를 부르지 못했어요. 잠시 후 다시 시도해 주세요." }, 502);
  const analysis = JSON.parse(a.analysis);
  const sources = JSON.parse(a.sources);

  const started = Date.now();
  let drafts;
  try {
    drafts = await askPersonas(env, { service: a.service, kind: a.kind, count: a.count, analysis, codes: sources.map((x) => x.code) });
  } catch (err) {
    console.error("persona compose failed", String(err?.message || err));
    return json({ error: "페르소나 작성에 실패했어요. 잠시 후 다시 시도해 주세요." }, 502);
  }

  const now = Math.floor(Date.now() / 1000);
  const sessionIds = [...new Set(sources.map((x) => x.session_id))];
  const sessionId = sessionIds.length === 1 ? sessionIds[0] : null;
  const saved = [];
  // 같은 분석으로 다시 만들면 이전 결과는 지운다 (묶음 하나에 한 세트)
  await env.DB.prepare("DELETE FROM personas WHERE analysis_id = ?").bind(a.id).run();
  for (const [i, d] of drafts.entries()) {
    const content = cleanContent(d, i);
    const id = crypto.randomUUID();
    const row = personaToRow({ ...content, id, userId: user.id, sessionId, analysisId: a.id, evidence: d.evidence, share: d.share, createdAt: now, updatedAt: now });
    await env.DB.prepare(
      `INSERT INTO personas (id, user_id, session_id, analysis_id, priority, tagline, photo_url, name, gender, age, hobbies, job,
                             environment, personality, motivation, lifestyle, behavior, painpoints, needs, quote, evidence, share, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(row.id, row.user_id, row.session_id, row.analysis_id, row.priority, row.tagline, row.photo_url, row.name, row.gender, row.age, row.hobbies, row.job,
      row.environment, row.personality, row.motivation, row.lifestyle, row.behavior, row.painpoints, row.needs, row.quote, row.evidence, row.share, row.created_at, row.updated_at).run();
    saved.push(rowToPersona({ ...row }));
  }
  const meta = { ...JSON.parse(a.meta || "{}"), compose_ms: Date.now() - started, composed_at: now };
  await env.DB.prepare("UPDATE persona_analyses SET status = 'composed', meta = ? WHERE id = ?").bind(JSON.stringify(meta), a.id).run();
  return json({ personas: saved, analysis_id: a.id });
}

// ── 목록: 생성 묶음(프로젝트)별 ──
async function list(env, json, user) {
  const { results } = await env.DB.prepare(
    `SELECT p.*, a.service AS project_name, a.kind, a.sources AS project_sources, a.created_at AS project_created_at, s.name AS session_name
       FROM personas p LEFT JOIN persona_analyses a ON a.id = p.analysis_id LEFT JOIN interview_sessions s ON s.id = p.session_id
      WHERE p.user_id = ? ORDER BY COALESCE(a.created_at, p.created_at) DESC, p.priority, p.created_at`
  ).bind(user.id).all();
  const groups = new Map();
  for (const r of results) {
    const key = r.analysis_id || `session:${r.session_id || "none"}`;
    if (!groups.has(key)) {
      const sources = r.project_sources ? JSON.parse(r.project_sources) : [];
      groups.set(key, {
        id: key, analysis_id: r.analysis_id, session_id: r.session_id,
        name: r.project_name || r.session_name || "직접 만든 페르소나", kind: r.kind || "design",
        interviews: sources.length, sessions: [...new Set(sources.map((x) => x.session_name))],
        updated_at: 0, personas: [],
      });
    }
    const g = groups.get(key);
    const p = rowToPersona(r);
    g.updated_at = Math.max(g.updated_at, p.updatedAt);
    g.personas.push({ id: p.id, priority: p.priority, photoUrl: p.photoUrl, name: p.profile.name, job: p.profile.job, age: p.profile.age, tagline: p.tagline, share: p.share, updatedAt: p.updatedAt });
  }
  return json({ projects: [...groups.values()] });
}

// ── 고친 내용 저장 ──
async function update(request, env, json, row) {
  const body = await readBody(request);
  if (!body) return json({ error: "JSON 본문이 필요해요." }, 400);
  const content = cleanContent(body, PRIORITIES.indexOf(row.priority));
  // 사진은 이미지 API 로만 바뀐다 (화면 저장이 photo_url 을 덮어쓰지 않게)
  content.photoUrl = row.photo_url;
  const now = Math.floor(Date.now() / 1000);
  const r = personaToRow({ ...content, id: row.id, userId: row.user_id, sessionId: row.session_id, analysisId: row.analysis_id, evidence: row.evidence ? JSON.parse(row.evidence) : null, share: row.share, createdAt: row.created_at, updatedAt: now });
  await env.DB.prepare(
    `UPDATE personas SET priority = ?, tagline = ?, photo_url = ?, name = ?, gender = ?, age = ?, hobbies = ?, job = ?, environment = ?, personality = ?, motivation = ?,
            lifestyle = ?, behavior = ?, painpoints = ?, needs = ?, quote = ?, updated_at = ? WHERE id = ?`
  ).bind(r.priority, r.tagline, r.photo_url, r.name, r.gender, r.age, r.hobbies, r.job, r.environment, r.personality, r.motivation,
    r.lifestyle, r.behavior, r.painpoints, r.needs, r.quote, r.updated_at, row.id).run();
  return json({ persona: rowToPersona({ ...row, ...r }) });
}

async function readBody(request) {
  const raw = await request.text();
  if (raw.length > MAX_BODY_CHARS) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// ── OpenAI: 1단계 어피니티 매핑 ──
const REF = { type: "string", description: "근거 발화 번호. 예: P01-3" };
const AFFINITY_SCHEMA = {
  type: "object", additionalProperties: false, required: ["notes", "themes", "orphans", "segments"],
  properties: {
    notes: { type: "array", description: "한 장에 한 사실. 해석 없이 관찰·발화만", items: {
      type: "object", additionalProperties: false, required: ["id", "code", "ref", "text"],
      properties: {
        id: { type: "string", description: "N1, N2, …" },
        code: { type: "string", description: "참가자 코드. 예: P01" },
        ref: REF,
        text: { type: "string", description: "'사용자는 ~했다 / ~라고 말했다' 형태의 구체적 사실 한 문장" },
      },
    } },
    themes: { type: "array", description: "2차 군집(상위 테마). 각 테마 아래 1차 군집(groups)", items: {
      type: "object", additionalProperties: false, required: ["title", "insight", "note_count", "participant_count", "codes", "groups"],
      properties: {
        title: { type: "string", description: "명사가 아닌 통찰형 라벨" },
        insight: { type: "string", description: "'사용자는 X 때문에 Y한다' 형식의 통찰 문장" },
        note_count: { type: "integer" },
        participant_count: { type: "integer" },
        codes: { type: "array", items: { type: "string" }, description: "이 테마를 뒷받침한 참가자 코드" },
        groups: { type: "array", items: {
          type: "object", additionalProperties: false, required: ["label", "note_ids", "quotes"],
          properties: {
            label: { type: "string", description: "1차 군집 라벨 (동사형·통찰형)" },
            note_ids: { type: "array", items: { type: "string" } },
            quotes: { type: "array", items: {
              type: "object", additionalProperties: false, required: ["ref", "text"],
              properties: { ref: REF, text: { type: "string", description: "참가자 발화 그대로 (줄여도 되지만 고치지 않음)" } },
            } },
          },
        } },
      },
    } },
    orphans: { type: "array", description: "어느 묶음에도 붙지 않은 고아 노트·소수 의견 (버리지 않는다)", items: {
      type: "object", additionalProperties: false, required: ["note_id", "why"],
      properties: { note_id: { type: "string" }, why: { type: "string", description: "약한 신호인지, 세그먼트 차이일 수 있는지" } },
    } },
    segments: { type: "array", description: "행동 클러스터 기반 세그먼트 후보 (인구통계로 나누지 않는다)", items: {
      type: "object", additionalProperties: false, required: ["name", "codes", "behaviors", "motivations", "pains", "distinct_from_others", "confidence", "share"],
      properties: {
        name: { type: "string" },
        codes: { type: "array", items: { type: "string" }, description: "이 세그먼트에 가까운 참가자 코드" },
        behaviors: { type: "array", items: { type: "string" } },
        motivations: { type: "array", items: { type: "string" } },
        pains: { type: "array", items: { type: "string" } },
        distinct_from_others: { type: "string", description: "다른 세그먼트와 행동이 어떻게 다른지 한 문장" },
        confidence: { type: "string", enum: ["높음", "보통", "낮음"] },
        share: { type: "string", description: "참가자 중 비중(추정). 예: '5명 중 3명 (추정 60%)'" },
      },
    } },
  },
};

async function askAffinity(env, { service, kind, count, transcript, codes }) {
  const instructions = `당신은 숙련된 UX 리서처입니다. 1:1 사용자 인터뷰 전사를 '어피니티 매핑' 방법으로 합성합니다. 결과는 한국어로 씁니다.

서비스: ${service}
페르소나 용도: ${kind === "marketing" ? "Marketing(제품을 사는 사람 기준, 구매·채널·라이프스타일 행동)" : "Design(제품을 쓰는 사람 기준, 사용 행동·동기·페인)"}
참가자: ${codes.join(", ")} (${codes.length}명) · 만들 페르소나 수: ${count}

절차 (순서를 지킵니다)
1. 노트 분해: 전사에서 의미 단위를 뽑아 '한 장에 한 사실'로 씁니다. 해석·의견이 아니라 관찰·발화만. "사용자는 ~했다 / ~라고 말했다" 형태로 구체적으로. 모든 노트에 참가자 코드와 근거 발화 번호(P01-3 형식)를 붙입니다. 참가자마다 고르게 뽑고(한 사람당 최소 5장), 모든 참가자가 최소 한 번은 나타나야 합니다. 처음 한두 명의 전사로 테마를 정해 놓고 나머지를 끼워 맞추지 않습니다.
2. 1차 군집: 노트를 모두 펼친 뒤, 사전 카테고리 없이 상향식으로 비슷한 사실끼리 묶습니다. 묶음 라벨은 명사만이 아니라 동사형·통찰형으로.
3. 2차 군집: 1차 군집 라벨을 묶어 상위 테마 3~6개로 올립니다. 테마마다 "사용자는 X 때문에 Y한다" 꼴의 통찰 문장을 쓰고, 뒷받침하는 노트 수와 참가자 수(강도 신호)를 적습니다. 각 1차 군집에는 참가자 발화를 글자 그대로 인용(모더레이터 발화 M은 인용 금지)을 1~3개 붙입니다.
4. 고아·소수 의견: 어느 묶음에도 붙지 않는 노트는 버리지 말고 orphans에 두고, 약한 신호인지 세그먼트 차이일 수 있는지 적습니다.
5. 세그먼트 후보: 인구통계가 아니라 행동 패턴·동기의 차이로 참가자를 ${count}개 세그먼트로 나눕니다. 세그먼트마다 어떤 참가자가 가까운지, 다른 세그먼트와 행동이 어떻게 다른지, 근거의 양으로 confidence, 참가자 중 비중(추정 표기)을 적습니다. 참가자가 ${count}보다 적거나 행동이 갈리지 않으면 세그먼트를 억지로 쪼개지 말고 적게 내고 confidence를 낮음으로 둡니다.

규칙
- 근거는 아래 전사에 있는 것만. 추측이나 일반론을 사실처럼 쓰지 않습니다.
- [REDACTED]는 가린 개인정보입니다. 추측해서 채우지 않습니다.
- 어피니티는 빈도 합성이지 인과 증명이 아닙니다. 통찰 문장에 '때문에'를 쓸 때는 참가자가 실제로 그렇게 말한 경우로 한정합니다.`;
  const parsed = await callOpenAI(env, { instructions, input: transcript, schema: AFFINITY_SCHEMA, name: "affinity", max: ANALYZE_TOKENS });
  if (!parsed?.themes || !parsed?.notes) throw new Error("분석 답을 읽지 못함");
  // 모양 정리 + 참가자 누락 검사(빠진 참가자는 알려 주기만 한다)
  const str = (v, n = 1000) => (typeof v === "string" ? v.slice(0, n) : "");
  const arr = (v, n) => (Array.isArray(v) ? v.slice(0, n) : []);
  const seen = new Set(arr(parsed.notes, 400).map((n) => n.code));
  return {
    notes: arr(parsed.notes, 400).map((n) => ({ id: str(n.id, 10), code: str(n.code, 10), ref: str(n.ref, 20), text: str(n.text, 400) })),
    themes: arr(parsed.themes, 10).map((t) => ({
      title: str(t.title, 200), insight: str(t.insight, 500), note_count: Number(t.note_count) || 0, participant_count: Number(t.participant_count) || 0,
      codes: arr(t.codes, 50).map((c) => str(c, 10)),
      groups: arr(t.groups, 12).map((g) => ({ label: str(g.label, 200), note_ids: arr(g.note_ids, 100).map((x) => str(x, 10)), quotes: arr(g.quotes, 5).map((q) => ({ ref: str(q.ref, 20), text: str(q.text, 500) })) })),
    })),
    orphans: arr(parsed.orphans, 50).map((o) => ({ note_id: str(o.note_id, 10), why: str(o.why, 300) })),
    segments: arr(parsed.segments, 5).map((s) => ({
      name: str(s.name, 100), codes: arr(s.codes, 50).map((c) => str(c, 10)), behaviors: arr(s.behaviors, 10).map((x) => str(x, 300)),
      motivations: arr(s.motivations, 10).map((x) => str(x, 300)), pains: arr(s.pains, 10).map((x) => str(x, 300)),
      distinct_from_others: str(s.distinct_from_others, 300), confidence: ["높음", "보통", "낮음"].includes(s.confidence) ? s.confidence : "낮음", share: str(s.share, 100),
    })),
    missing_codes: codes.filter((c) => !seen.has(c)),
  };
}

// ── OpenAI: 2단계 페르소나 작성 (shared/persona.ts 의 PersonaContent 모양으로) ──
const POINT = {
  type: "object", additionalProperties: false, required: ["title", "description", "refs", "hypothesis"],
  properties: {
    title: { type: "string", description: "굵게 보일 짧은 제목" },
    description: { type: "string", description: "1~2문장 설명" },
    refs: { type: "array", items: REF, description: "근거 발화 번호. 없으면 빈 배열이고 hypothesis=true" },
    hypothesis: { type: "boolean", description: "전사에 직접 근거가 없는 가설이면 true" },
  },
};
const PERSONA_SCHEMA = {
  type: "object", additionalProperties: false, required: ["personas"],
  properties: {
    personas: { type: "array", items: {
      type: "object", additionalProperties: false,
      required: ["priority", "share", "segment", "tagline", "profile", "context", "lifestyle", "behavior", "painpoints", "needs", "quote", "quote_ref", "hypotheses"],
      properties: {
        priority: { type: "string", enum: PRIORITIES },
        share: { type: "string", description: "세그먼트 비중(추정). 예: '추정 60%'" },
        segment: { type: "string", description: "바탕이 된 세그먼트 이름" },
        tagline: { type: "string", description: "상단 한 줄 요약. 핵심어 2곳을 **…**로 감싼다" },
        profile: { type: "object", additionalProperties: false, required: ["name", "gender", "age", "hobbies", "job"], properties: {
          name: { type: "string", description: "한국어 가명 두 글자" }, gender: { type: "string" }, age: { type: "integer" },
          hobbies: { type: "array", items: { type: "string" } }, job: { type: "string" },
        } },
        context: { type: "object", additionalProperties: false, required: ["environment", "personality", "motivation"], properties: {
          environment: { type: "string", description: "서비스 이용 환경 (기기·시간·장소)" }, personality: { type: "string" }, motivation: { type: "string", description: "서비스 이용 동기" },
        } },
        lifestyle: { type: "string", description: "하루의 한 장면으로 시작하는 5~8문장 서사. 행동·동기 중심. 전사 근거가 없는 묘사는 넣지 않는다" },
        behavior: { type: "object", additionalProperties: false, required: ["tagGroups", "scales"], properties: {
          tagGroups: { type: "array", items: { type: "object", additionalProperties: false, required: ["title", "tags"], properties: {
            title: { type: "string" }, tags: { type: "array", items: { type: "string", description: "'#' 없이 짧은 구" } },
          } } },
          scales: { type: "array", items: { type: "object", additionalProperties: false, required: ["label", "value", "lowLabel", "highLabel"], properties: {
            label: { type: "string" }, value: { type: "integer", description: "0~100" }, lowLabel: { type: "string" }, highLabel: { type: "string" },
          } } },
        } },
        painpoints: { type: "array", items: POINT },
        needs: { type: "array", items: POINT },
        quote: { type: "string", description: "왼쪽 패널 인용. 참가자 발화를 바탕으로 1인칭 한 문장, 핵심 구를 **…**로 감싼다" },
        quote_ref: REF,
        hypotheses: { type: "array", items: { type: "string" }, description: "근거 없이 채운 항목 목록 (예: '나이·직업은 가설')" },
      },
    } },
  },
};

async function askPersonas(env, { service, kind, count, analysis, codes }) {
  const instructions = `당신은 숙련된 UX 리서처입니다. 어피니티 매핑 결과를 바탕으로 페르소나 문서를 한국어로 씁니다. 결과는 1페이지 페르소나 양식(상단 한 줄 요약 · 프로필 · 이용 환경/성격/동기 · Lifestyle · Behavior · Painpoint · Needs · 인용)에 바로 들어갑니다.

서비스: ${service}
페르소나 유형: ${kind === "marketing" ? "Marketing — 제품을 사는 사람. 구매 동기·정보 채널·지불 의사·라이프스타일을 강조" : "Design — 제품을 쓰는 사람. 사용 행동·동기·페인·워크플로를 강조"}
참가자: ${codes.join(", ")} · 만들 페르소나 수: ${count}명 (세그먼트 후보를 1:1로 옮기되, 세그먼트가 그보다 적으면 그 수만큼만 만든다)

원칙
- 인구통계가 아니라 행동 패턴과 동기로 페르소나를 가릅니다. 서로 실제로 구별되는 세그먼트여야 합니다.
- 행동(가장 중요) · 동기 · 페인 포인트 · 니즈를 우선하고, 근거 발화 번호(P01-3)를 painpoints·needs의 refs에 붙입니다.
- 전사에 근거가 없는 항목(나이·직업·취미·성격 같은 인구통계·성향)은 그럴듯하게 채우되 반드시 hypotheses에 '가설'로 적습니다. refs가 비는 painpoint·need는 hypothesis=true.
- Lifestyle은 하루의 한 장면으로 시작해 서비스와 만나는 맥락, 행동, 동기, 좌절, 바라는 것 순으로 5~8문장. 서사이되 근거 범위를 벗어나지 않습니다.
- Behavior.tagGroups: '콘텐츠 이용 행태'처럼 세그먼트 행동을 요약하는 묶음 1~2개, 태그 5~8개(짧은 구, '#' 없이).
- Behavior.scales: 세그먼트를 가르는 성향 축 3개. value는 0~100, 라벨은 '낮음'/'높음' 또는 축에 맞는 양 끝 표현.
- painpoints · needs: 각 4~5개. title은 짧게, description은 1~2문장.
- tagline과 quote는 핵심 구 1~2곳을 **…**로 감쌉니다. quote는 특정 참가자 발화(quote_ref)를 바탕으로 1인칭으로 다듬습니다.
- priority: 비중(share)과 서비스 핵심 가치에 가장 가까운 세그먼트를 primary(정확히 1명), 다음을 secondary, 나머지를 tertiary.
- profile.name은 실제 참가자와 무관한 한국어 가명 두 글자. 전사의 [REDACTED]는 절대 추측하지 않습니다.`;
  const input = `## 어피니티 매핑 결과\n${JSON.stringify({ themes: analysis.themes, orphans: analysis.orphans, segments: analysis.segments }, null, 1)}\n\n## 노트 (근거 추적용)\n${analysis.notes.map((n) => `[${n.id}] ${n.code} ${n.ref}: ${n.text}`).join("\n")}`;
  const parsed = await callOpenAI(env, { instructions, input, schema: PERSONA_SCHEMA, name: "personas", max: COMPOSE_TOKENS });
  if (!Array.isArray(parsed?.personas) || !parsed.personas.length) throw new Error("페르소나 답을 읽지 못함");
  return parsed.personas.slice(0, count).map((p) => ({
    ...p,
    evidence: {
      painpoints: (p.painpoints || []).map((x) => ({ refs: x.refs || [], hypothesis: !!x.hypothesis })),
      needs: (p.needs || []).map((x) => ({ refs: x.refs || [], hypothesis: !!x.hypothesis })),
      quote_ref: p.quote_ref || null, segment: p.segment || "", hypotheses: p.hypotheses || [],
    },
  }));
}

async function callOpenAI(env, { instructions, input, schema, name, max }) {
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: env.OPENAI_MODEL, instructions, input,
      text: { format: { type: "json_schema", name, schema, strict: true } },
      reasoning: { effort: "low" }, max_output_tokens: max, store: false,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${data?.error?.message || ""}`);
  if (data.status === "incomplete") throw new Error("incomplete");
  const raw = (data.output || []).filter((x) => x.type === "message").flatMap((x) => x.content || [])
    .filter((c) => c.type === "output_text").map((c) => c.text).join("");
  return firstJson(raw);
}

// ── 모양 검사 (AI 결과와 화면에서 고친 내용 모두 여기를 거친다) ──
function cleanContent(c, index = 0) {
  const str = (v, n = 2000) => (typeof v === "string" ? v.trim().slice(0, n) : "");
  const arr = (v, n) => (Array.isArray(v) ? v.slice(0, n) : []);
  const strs = (v, n, m) => arr(v, n).map((x) => str(x, m)).filter(Boolean);
  const profile = c.profile || {};
  const context = c.context || {};
  const behavior = c.behavior || {};
  return {
    priority: PRIORITIES.includes(c.priority) ? c.priority : PRIORITIES[Math.min(index, 2)],
    tagline: str(c.tagline, 300),
    photoUrl: typeof c.photoUrl === "string" && /^https?:\/\//.test(c.photoUrl) ? c.photoUrl.slice(0, 1000) : null,
    profile: { name: str(profile.name, 40) || "이름 없음", gender: str(profile.gender, 20), age: Math.max(0, Math.min(120, parseInt(profile.age, 10) || 0)), hobbies: strs(profile.hobbies, 10, 40), job: str(profile.job, 60) },
    context: { environment: str(context.environment, 300), personality: str(context.personality, 300), motivation: str(context.motivation, 300) },
    lifestyle: str(c.lifestyle, 3000),
    behavior: {
      tagGroups: arr(behavior.tagGroups, 4).map((g) => ({ title: str(g.title, 80), tags: strs(g.tags, 12, 60).map((t) => t.replace(/^#+\s*/, "")) })),
      scales: arr(behavior.scales, 6).map((s) => ({ label: str(s.label, 120), value: Math.max(0, Math.min(100, Math.round(Number(s.value) || 0))), lowLabel: str(s.lowLabel, 20) || "낮음", highLabel: str(s.highLabel, 20) || "높음" })),
    },
    painpoints: arr(c.painpoints, 8).map((x) => ({ title: str(x.title, 120), description: str(x.description, 600) })),
    needs: arr(c.needs, 8).map((x) => ({ title: str(x.title, 120), description: str(x.description, 600) })),
    quote: str(c.quote, 400),
  };
}

// shared/persona.ts 의 rowToPersona / personaToRow 와 같은 규칙 (+ 근거·비중)
function rowToPersona(r) {
  return {
    id: r.id, userId: r.user_id, sessionId: r.session_id, analysisId: r.analysis_id || null,
    priority: r.priority, tagline: r.tagline, photoUrl: r.photo_url,
    profile: { name: r.name, gender: r.gender, age: r.age, hobbies: JSON.parse(r.hobbies || "[]"), job: r.job },
    context: { environment: r.environment, personality: r.personality, motivation: r.motivation },
    lifestyle: r.lifestyle,
    behavior: JSON.parse(r.behavior || '{"tagGroups":[],"scales":[]}'),
    painpoints: JSON.parse(r.painpoints || "[]"), needs: JSON.parse(r.needs || "[]"),
    quote: r.quote, evidence: r.evidence ? (typeof r.evidence === "string" ? JSON.parse(r.evidence) : r.evidence) : null, share: r.share || null,
    imagePrompt: r.image_prompt || null,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}
function personaToRow(p) {
  return {
    id: p.id, user_id: p.userId, session_id: p.sessionId, analysis_id: p.analysisId || null,
    priority: p.priority, tagline: p.tagline, photo_url: p.photoUrl,
    name: p.profile.name, gender: p.profile.gender, age: p.profile.age, hobbies: JSON.stringify(p.profile.hobbies), job: p.profile.job,
    environment: p.context.environment, personality: p.context.personality, motivation: p.context.motivation,
    lifestyle: p.lifestyle, behavior: JSON.stringify(p.behavior), painpoints: JSON.stringify(p.painpoints), needs: JSON.stringify(p.needs),
    quote: p.quote, evidence: p.evidence ? JSON.stringify(p.evidence) : null, share: p.share || null,
    created_at: p.createdAt, updated_at: p.updatedAt,
  };
}
