// 저니맵 (리서처, 로그인) — 페르소나 1명 × 시나리오 1개로 AS-IS 여정을 그리고, 확정한 뒤 TO-BE 를 설계한다
//   POST /api/journeys/generate        { persona: { id } | { name, role, desc }, scenario } → AS-IS 초안 (OpenAI) → 저장 → { journey }
//   GET  /api/journeys                 내 저니맵 목록 (버전·상태)
//   GET  /api/journeys/scenes          TO-BE 핵심 장면 (시나리오 보드에서 불러간다)
//   GET  /api/journeys/:id             지도 1장 (TO-BE 면 바탕 AS-IS 도 함께)
//   PUT  /api/journeys/:id             { map } 화면에서 고친 내용 저장 (초안일 때만). 내용이 바뀐 칸은 출처가 'human' 이 된다
//   POST /api/journeys/:id/rewrite     { stage, lane, pain? } 칸 하나만 근거를 다시 찾아 AI 로 다시 쓰기
//   POST /api/journeys/:id/confirm     { map?, force? } 확정. 기회(HMW)가 없는 페인포인트가 있으면 force 없이는 409 로 알려 준다
//   POST /api/journeys/:id/tobe        확정한 AS-IS 의 단계 골격 위에 TO-BE(가설) 초안을 만든다
//   DELETE /api/journeys/:id
//
// 방법은 스킬 experience-mapping/methods/journey-mapping.md 를 따른다.
//   한 지도 = 한 페르소나 × 한 시나리오 · 단계는 시간 순 4~7개 · 칸은 근거 노트와 인용 우선 · 감정은 -2~+2 곡선
//   저점·중단 지점을 페인포인트로 · 페인포인트마다 'How might we…' 기회 · AS-IS 합의 후 같은 골격에 TO-BE(검증 전 가설)
// 근거 노트 ID 는 페르소나 채팅(rag_chunks)과 같다: N### 어피니티 노트 · T## 테마 통찰 (칸 다시 쓰기 검색에서는 U### 원 발화 · D## 문서도)

import { currentUser } from "./auth.js";
import { firstJson } from "./json.js";
import { indexAnalysis, embedAll, search } from "./personaChat.js";

const MAX_BODY_CHARS = 200000;
const MAX_NOTES = 220;
const MAX_NOTE_CHARS = 26000;
const GENERATE_TOKENS = 14000;
const TOBE_TOKENS = 12000;
const REWRITE_TOKENS = 2500;
const LANES = ["head", "actions", "thought", "emotion", "touchpoints", "pains", "hmw", "change"];
const NOT_FOUND = { error: "저니맵을 찾을 수 없어요.", code: "not_found" };
const pad = (n, w) => String(n).padStart(w, "0");
const now = () => Math.floor(Date.now() / 1000);

export async function journeys(request, env, json, id, action) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: "로그인이 필요해요.", code: "unauthorized" }, 401);
  const method = request.method;

  if (id === "generate" && method === "POST") return generate(request, env, json, user);
  if (id === "scenes" && method === "GET") return scenes(env, json, user);
  if (!id && method === "GET") return list(env, json, user);
  if (!id) return json({ error: "없는 경로예요." }, 404);

  const row = await env.DB.prepare("SELECT * FROM journeys WHERE id = ? AND user_id = ?").bind(id, user.id).first();
  if (!row) return json(NOT_FOUND, 404);

  if (!action) {
    if (method === "GET") return json({ journey: await viewWithParent(env, row) });
    if (method === "PUT") return save(request, env, json, row);
    if (method === "DELETE") {
      await env.DB.prepare("DELETE FROM journeys WHERE id = ?").bind(row.id).run();
      return json({ ok: true });
    }
  }
  if (method === "POST" && action === "rewrite") return rewrite(request, env, json, user, row);
  if (method === "POST" && action === "confirm") return confirm(request, env, json, row);
  if (method === "POST" && action === "tobe") return toBe(env, json, user, row);
  return json({ error: "없는 경로예요." }, 404);
}

// ── 목록 ──
async function list(env, json, user) {
  const { results } = await env.DB.prepare(
    `SELECT j.id, j.persona_id, j.persona, j.scenario, j.lens, j.parent_id, j.version, j.status, j.map, j.created_at, j.updated_at, j.confirmed_at, a.service AS project
       FROM journeys j LEFT JOIN persona_analyses a ON a.id = j.analysis_id
      WHERE j.user_id = ? ORDER BY j.updated_at DESC`
  ).bind(user.id).all();
  return json({
    journeys: results.map((r) => {
      const map = JSON.parse(r.map);
      return {
        id: r.id, personaId: r.persona_id, persona: JSON.parse(r.persona), scenario: r.scenario, lens: r.lens, parentId: r.parent_id,
        version: r.version, status: r.status, project: r.project || null, stages: map.stages.map((s) => s.name),
        pains: map.stages.reduce((n, s) => n + (s.pains?.items?.length || 0), 0), opps: (map.opps || []).filter((o) => o.chosen).length,
        createdAt: r.created_at, updatedAt: r.updated_at, confirmedAt: r.confirmed_at,
      };
    }),
  });
}

async function scenes(env, json, user) {
  const { results } = await env.DB.prepare(
    "SELECT id, persona, scenario, version, status, map, updated_at FROM journeys WHERE user_id = ? AND lens = 'to-be' ORDER BY updated_at DESC"
  ).bind(user.id).all();
  const out = [];
  for (const r of results) {
    const map = JSON.parse(r.map);
    const persona = JSON.parse(r.persona);
    for (const sc of map.scenes || []) {
      const stage = map.stages.find((s) => s.id === sc.stage);
      out.push({ journeyId: r.id, persona: persona.name, scenario: r.scenario, version: r.version, status: r.status, updatedAt: r.updated_at,
        scene: { ...sc, stageName: stage?.name || "", hmwText: sc.hmw.map((h) => (map.opps || []).find((o) => o.id === h)?.chosen).filter(Boolean) } });
    }
  }
  return json({ scenes: out });
}

// ── 1. AS-IS 생성 ──
async function generate(request, env, json, user) {
  const body = await readBody(request);
  if (!body) return json({ error: "JSON 본문이 필요해요." }, 400);
  const scenario = str(body.scenario, 300);
  if (!scenario) return json({ error: "시나리오를 하나 적어 주세요." }, 400);

  const src = await personaSource(env, user, body.persona || {});
  if (src.error) return json({ error: src.error }, 400);
  if (!env.OPENAI_API_KEY) return json({ error: "AI를 부르지 못했어요. 잠시 후 다시 시도해 주세요." }, 502);

  const started = Date.now();
  let out;
  try {
    out = await callOpenAI(env, {
      name: "journey_map", schema: GENERATE_SCHEMA, max: GENERATE_TOKENS,
      instructions: GENERATE_RULES,
      input: `## 페르소나\n${src.personaText}\n\n## 시나리오 (이 지도의 범위)\n${scenario}\n\n## 근거 노트\n${src.notesText || "(근거 노트 없음 — 모든 칸은 페르소나 문서에서 추론한 가설이다. refs 는 빈 배열로 둔다)"}`,
    });
  } catch (err) {
    console.error("journey generate failed", String(err?.message || err));
    return json({ error: "저니맵을 만들지 못했어요. 잠시 후 다시 시도해 주세요." }, 502);
  }
  if (!out || !Array.isArray(out.stages) || out.stages.length < 3) return json({ error: "AI가 단계를 충분히 나누지 못했어요. 시나리오를 조금 더 구체적으로 적어 주세요." }, 502);

  const map = buildAsIs(out, src.noteIds);
  map.evidence = pickEvidence(map, src.notes);
  const t = now();
  const version = await nextVersion(env, user, src.personaId, src.persona.name, scenario);
  const meta = { model: env.OPENAI_MODEL, ms: Date.now() - started, inputs: inputSummary(src, scenario, map), warnings: lowWithoutPain(map) };
  const row = {
    id: crypto.randomUUID(), user_id: user.id, persona_id: src.personaId, analysis_id: src.analysisId, persona: JSON.stringify(src.persona),
    scenario, lens: "as-is", parent_id: null, version, status: "draft", map: JSON.stringify(map), meta: JSON.stringify(meta), created_at: t, updated_at: t, confirmed_at: null,
  };
  await insert(env, row);
  return json({ journey: await viewWithParent(env, row) });
}

const GENERATE_RULES = `너는 UX 리서처를 돕는 저니맵 작성 에이전트다. 스킬 'journey-mapping'(고객 여정 지도)을 따른다.
- 한 지도 = 주어진 페르소나 1명 × 시나리오 1개. 다른 사람·다른 상황을 섞지 않는다.
- 단계(Phase)는 시나리오에 맞게 4~7개, 시간 순서대로. 이름은 2~6자 명사, goal 은 그 단계에서 페르소나가 하려는 일 한 문장.
- 각 단계에 행동(실제 행위 1~3개) · 생각(머릿속 질문·기대를 1인칭 한 문장) · 감정 · 터치포인트(화면·사람·문서·채널, 없으면 빈 배열) · 페인포인트를 채운다.
- 모든 칸은 '근거 노트'를 우선해서 채운다. 근거로 쓴 노트 ID(N012, T03 형식)를 refs 에 넣는다. 노트에 없는 내용은 페르소나 문서에서 조심스럽게 추론하고 refs 를 빈 배열로 둔다(가설). 노트 ID를 지어내지 않는다.
- 생각과 감정 quote 는 노트에 있는 참가자 인용(따옴표 안 말)을 우선 그대로 쓴다. quote_ref 에는 그 발화 번호(예: P01-4)나 노트 ID 를 넣는다. 인용이 없으면 quote, quote_ref 를 빈 문자열로.
- 감정 score 는 -2(매우 부정)~+2(매우 긍정) 정수. feel 은 감정 단어 1~2개, note 는 왜 그런 감정인지 한 줄.
- 감정 votes 에는 근거 노트에서 그 단계의 감정을 드러낸 참가자마다 한 줄씩: code(P01 형식), score(-2~+2), refs(그 참가자의 노트 ID), quote(그 참가자의 말, 없으면 빈 문자열). 근거가 없는 참가자는 넣지 않는다. 지어내지 않는다. 근거 노트가 없으면 빈 배열.
- 감정이 낮은 단계(score -1 이하)와 행동이 끊기는 지점은 반드시 페인포인트로 표시한다. 감정이 높은 단계는 페인포인트가 없을 수 있다.
- 페인포인트마다 'How might we…' 기회 초안을 2~3개 쓴다. 한국어로 "어떻게 하면 …할 수 있을까?" 형식, 해결책을 못 박지 말고 기회의 방향을 연다.
- 정점(가장 높은 감정)과 종점(마지막 단계)의 감정을 실제 근거대로 쓴다. 희망 사항으로 끌어올리지 않는다(AS-IS).
- 모든 문장은 한국어, 짧고 구체적으로. 개인정보([REDACTED])는 추측하지 않는다.`;

const strArr = { type: "array", items: { type: "string" } };
const GENERATE_SCHEMA = {
  type: "object", additionalProperties: false, required: ["stages"],
  properties: {
    stages: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["name", "goal", "actions", "thought", "emotion", "touchpoints", "pains"],
        properties: {
          name: { type: "string" }, goal: { type: "string" },
          actions: { type: "object", additionalProperties: false, required: ["items", "refs"], properties: { items: strArr, refs: strArr } },
          thought: { type: "object", additionalProperties: false, required: ["text", "refs"], properties: { text: { type: "string" }, refs: strArr } },
          emotion: {
            type: "object", additionalProperties: false, required: ["score", "feel", "note", "quote", "quote_ref", "refs", "votes"],
            properties: { score: { type: "integer", enum: [-2, -1, 0, 1, 2] }, feel: { type: "string" }, note: { type: "string" }, quote: { type: "string" }, quote_ref: { type: "string" }, refs: strArr, votes: { type: "array", items: { type: "object", additionalProperties: false, required: ["code", "score", "refs", "quote"], properties: { code: { type: "string" }, score: { type: "integer", enum: [-2, -1, 0, 1, 2] }, refs: strArr, quote: { type: "string" } } } } },
          },
          touchpoints: { type: "object", additionalProperties: false, required: ["items", "refs"], properties: { items: strArr, refs: strArr } },
          pains: { type: "array", items: { type: "object", additionalProperties: false, required: ["text", "refs", "hmw"], properties: { text: { type: "string" }, refs: strArr, hmw: strArr } } },
        },
      },
    },
  },
};

function buildAsIs(out, noteIds) {
  const refs = (v) => cleanRefs(v, noteIds);
  const opps = [];
  let p = 0;
  const stages = out.stages.slice(0, 7).map((s, i) => {
    const id = `s${i + 1}`;
    const pains = arr(s.pains, 4).map((x) => {
      const pid = `P${++p}`;
      const drafts = strs(x.hmw, 3, 300);
      opps.push({ id: `O${opps.length + 1}`, pain: pid, drafts, chosen: "", by: "ai" });
      return { id: pid, text: str(x.text, 300), refs: refs(x.refs) };
    });
    const e = s.emotion || {};
    return {
      id, name: str(s.name, 30) || `단계 ${i + 1}`, goal: str(s.goal, 160), headBy: "ai",
      actions: { items: strs(s.actions?.items, 5, 200), refs: refs(s.actions?.refs), by: "ai" },
      thought: { text: str(s.thought?.text, 300), refs: refs(s.thought?.refs), by: "ai" },
      emotion: { score: clampScore(e.score), feel: str(e.feel, 30), note: str(e.note, 200), quote: str(e.quote, 300), quoteRef: str(e.quote_ref, 20), refs: refs(e.refs), votes: cleanVotes(e.votes, noteIds), by: "ai" },
      touchpoints: { items: strs(s.touchpoints?.items, 6, 60), refs: refs(s.touchpoints?.refs), by: "ai" },
      pains: { items: pains, by: "ai" },
    };
  });
  return { stages, opps, memos: { low: "", peak: "", end: "" }, evidence: {} };
}

// ── 페르소나와 근거 노트 ──
async function personaSource(env, user, p) {
  if (p.id) {
    const row = await env.DB.prepare("SELECT * FROM personas WHERE id = ? AND (user_id = ? OR user_id = 'sample')").bind(String(p.id), user.id).first();
    if (!row) return { error: "고른 페르소나를 찾을 수 없어요. 목록을 새로 고쳐 주세요." };
    const a = row.analysis_id ? await env.DB.prepare("SELECT * FROM persona_analyses WHERE id = ? AND user_id = ?").bind(row.analysis_id, row.user_id).first() : null;
    const pains = JSON.parse(row.painpoints || "[]");
    const needs = JSON.parse(row.needs || "[]");
    const { notes, themes, codes } = analysisNotes(a);
    const personaText = [
      `이름: ${row.name} · ${row.gender} · ${row.age}세 · ${row.job}`,
      `한 줄: ${row.tagline.replace(/\*\*/g, "")}`,
      `서비스 이용 환경: ${row.environment}`, `성격: ${row.personality}`, `이용 동기: ${row.motivation}`,
      `Lifestyle: ${row.lifestyle}`,
      `Painpoint:\n${pains.map((x) => `- ${x.title}: ${x.description}`).join("\n")}`,
      `Needs:\n${needs.map((x) => `- ${x.title}: ${x.description}`).join("\n")}`,
      `대표 인용: ${row.quote.replace(/\*\*/g, "")}`,
      a ? `프로젝트(서비스): ${a.service}` : "",
    ].filter(Boolean).join("\n");
    return {
      personaId: row.id, analysisId: a?.id || null, analysis: a, project: a?.service || null,
      persona: { name: row.name, role: `${row.job} · ${row.age}세`, desc: row.tagline.replace(/\*\*/g, ""), source: row.user_id === "sample" ? "샘플 페르소나" : "내 페르소나", photoUrl: row.photo_url || null },
      personaText, notes, noteIds: new Set(notes.map((n) => n.id)), codes,
      notesText: notesText(notes, themes), themes,
      docCounts: { pains: pains.length, needs: needs.length },
    };
  }
  const name = str(p.name, 20);
  if (!name) return { error: "페르소나를 고르거나 이름을 적어 주세요." };
  const role = str(p.role, 40), desc = str(p.desc, 300);
  return {
    personaId: null, analysisId: null, analysis: null, project: null,
    persona: { name, role, desc, source: "직접 입력", photoUrl: null },
    personaText: `이름: ${name}${role ? `\n역할: ${role}` : ""}${desc ? `\n목표와 특징: ${desc}` : ""}`,
    notes: [], noteIds: new Set(), codes: [], notesText: "", themes: [], docCounts: null,
  };
}

function analysisNotes(a) {
  if (!a?.analysis) return { notes: [], themes: [], codes: [] };
  const analysis = JSON.parse(a.analysis);
  const notes = [];
  (analysis.notes || []).forEach((n, i) => {
    const num = parseInt(String(n.id || "").replace(/\D/g, ""), 10);
    const id = `N${pad(Number.isFinite(num) && num > 0 ? num : i + 1, 3)}`;
    if (!notes.some((x) => x.id === id)) notes.push({ id, kind: "note", code: n.code || "", ref: n.ref || "", text: n.text || "" });
  });
  const themes = (analysis.themes || []).map((t, i) => ({
    id: `T${pad(i + 1, 2)}`, kind: "theme", code: "", ref: "",
    text: `${t.title}: ${t.insight}${(t.groups || []).flatMap((g) => g.quotes || []).slice(0, 3).map((q) => ` "${q.text}"(${q.ref})`).join("")}`,
  }));
  const codes = [...new Set(notes.map((n) => n.code).filter(Boolean))].sort();
  return { notes: [...notes, ...themes], themes, codes };
}

function notesText(notes, themes) {
  let out = "", used = 0;
  for (const n of notes.filter((x) => x.kind === "note").slice(0, MAX_NOTES)) {
    const line = `[${n.id}] ${n.code ? `(${n.code}${n.ref ? ` ${n.ref}` : ""}) ` : ""}${n.text}\n`;
    if (out.length + line.length > MAX_NOTE_CHARS) break;
    out += line; used++;
  }
  if (themes.length) out += `\n테마 통찰:\n${themes.map((t) => `[${t.id}] ${t.text}`).join("\n")}`;
  return out.trim();
}

function pickEvidence(map, notes) {
  const byId = new Map(notes.map((n) => [n.id, n]));
  const ev = { ...(map.evidence || {}) };
  for (const id of usedRefs(map)) {
    const n = byId.get(id);
    if (n && !ev[id]) ev[id] = { text: n.text, code: n.code, ref: n.ref };
  }
  return ev;
}

function usedRefs(map) {
  const ids = [];
  for (const s of map.stages) {
    for (const lane of ["actions", "thought", "emotion", "touchpoints"]) ids.push(...(s[lane]?.refs || []));
    for (const v of s.emotion?.votes || []) ids.push(...(v.refs || []));
    for (const p of s.pains?.items || []) ids.push(...(p.refs || []));
  }
  return ids;
}

// AI 가 무엇을 받아서 썼는지 — 디자이너가 읽는 말로
function inputSummary(src, scenario, map) {
  const cells = [];
  for (const s of map.stages) {
    cells.push(s.actions, s.thought, s.emotion, s.touchpoints);
    for (const p of s.pains.items) cells.push(p);
  }
  const grounded = cells.filter((c) => c.refs?.length).length;
  const counts = {};
  for (const id of usedRefs(map)) counts[id] = (counts[id] || 0) + 1;
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([id]) => id);
  const noteCount = src.notes.filter((n) => n.kind === "note").length;
  const lines = [];
  if (src.personaId) {
    lines.push({ k: "페르소나", v: `‘${src.persona.name}’ 문서 한 장 — 한 줄 소개, 이용 환경·성격·동기, Lifestyle, 페인포인트 ${src.docCounts.pains}개, 니즈 ${src.docCounts.needs}개, 대표 인용` });
    lines.push({ k: "근거 노트", v: noteCount
      ? `‘${src.project}’ 인터뷰에서 나온 관찰 노트 ${Math.min(noteCount, MAX_NOTES)}장${src.codes.length ? `(참가자 ${src.codes.length}명: ${src.codes.join(", ")})` : ""}과 테마 통찰 ${src.themes.length}개`
      : "이 페르소나에는 인터뷰 분석 노트가 없어 문서 내용만 썼어요" });
  } else {
    lines.push({ k: "페르소나", v: `직접 적은 이름 ‘${src.persona.name}’${src.persona.role ? `, 역할` : ""}${src.persona.desc ? `, 목표와 특징` : ""}` });
    lines.push({ k: "근거 노트", v: "없음 — 인터뷰 근거가 없어 모든 칸이 추론(가설)이에요" });
  }
  lines.push({ k: "시나리오", v: `‘${scenario}’ 하나만 범위로 삼았어요` });
  lines.push({ k: "지킨 규칙", v: "단계 4~7개 시간 순 · 인용 우선 · 감정 -2~+2(참가자별 점수와 근거 노트) · 낮은 감정은 페인포인트로 · 페인포인트마다 HMW 초안 2~3개" });
  lines.push({ k: "결과", v: `칸 ${cells.length}개 중 ${grounded}개는 근거 노트를 인용했고, ${cells.length - grounded}개는 근거 없이 추론했어요(가설 표시)${top.length ? `. 가장 많이 쓴 근거: ${top.join(", ")}` : ""}` });
  lines.push({ k: "보내지 않은 것", v: "인터뷰 원문 전체와 참가자 개인정보는 보내지 않았어요(노트는 마스킹된 전사에서 만든 것)" });
  return lines;
}

function lowWithoutPain(map) {
  return map.stages.filter((s) => s.emotion.score <= -1 && !s.pains.items.length).map((s) => `‘${s.name}’ 단계는 감정이 낮은데 페인포인트가 없어요.`);
}

async function nextVersion(env, user, personaId, name, scenario) {
  const { n } = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM journeys WHERE user_id = ? AND lens = 'as-is' AND scenario = ? AND ${personaId ? "persona_id = ?" : "persona_id IS NULL AND json_extract(persona, '$.name') = ?"}`
  ).bind(user.id, scenario, personaId || name).first();
  return n < 26 ? String.fromCharCode(65 + n) : `Z${n - 25}`;
}

// ── 2. 고친 내용 저장 ──
async function save(request, env, json, row) {
  if (row.status === "confirmed") return json({ error: "확정한 저니맵은 고칠 수 없어요.", code: "locked" }, 409);
  const body = await readBody(request);
  if (!body?.map) return json({ error: "map 이 필요해요." }, 400);
  const map = mergeEdits(JSON.parse(row.map), body.map, row.lens);
  const t = now();
  await env.DB.prepare("UPDATE journeys SET map = ?, updated_at = ? WHERE id = ?").bind(JSON.stringify(map), t, row.id).run();
  return json({ journey: await viewWithParent(env, { ...row, map: JSON.stringify(map), updated_at: t }) });
}

// 화면에서 온 map 을 모양 검사하고, 내용이 바뀐 칸만 출처를 'human' 으로 바꾼다 (근거·단계 골격은 서버 것을 지킨다)
function mergeEdits(old, incoming, lens) {
  const inc = new Map((Array.isArray(incoming.stages) ? incoming.stages : []).map((s) => [s?.id, s]));
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const stages = old.stages.map((s) => {
    const n = inc.get(s.id);
    if (!n) return s;
    const out = { ...s };
    const head = { name: str(n.name, 30) || s.name, goal: str(n.goal, 160) };
    if (!same(head, { name: s.name, goal: s.goal })) Object.assign(out, head, { headBy: "human" });
    const lanes = {
      actions: () => ({ items: strs(n.actions?.items, 6, 200) }),
      thought: () => ({ text: str(n.thought?.text, 300) }),
      emotion: () => ({ score: clampScore(n.emotion?.score), feel: str(n.emotion?.feel, 30), note: str(n.emotion?.note, 200), quote: str(n.emotion?.quote, 300) }),
      touchpoints: () => ({ items: strs(n.touchpoints?.items, 6, 60) }),
      change: () => ({ text: str(n.change?.text, 300) }),
    };
    for (const [lane, read] of Object.entries(lanes)) {
      if (!s[lane] || !n[lane]) continue;
      const next = read();
      const prev = Object.fromEntries(Object.keys(next).map((k) => [k, s[lane][k]]));
      if (!same(next, prev)) out[lane] = { ...s[lane], ...next, by: "human" };
    }
    if (s.pains && n.pains) {
      const items = arr(n.pains.items, 6).map((p, k) => ({ id: str(p.id, 10) || `${s.id}-p${k + 1}`, text: str(p.text, 300), refs: s.pains.items.find((x) => x.id === p.id)?.refs || [] })).filter((p) => p.text);
      if (!same(items.map((p) => [p.id, p.text]), s.pains.items.map((p) => [p.id, p.text]))) out.pains = { items, by: "human" };
    }
    return out;
  });
  // 기회(HMW): 페인포인트에 붙은 것만 남기고, 새 페인포인트에는 빈 기회를 단다
  const painIds = stages.flatMap((s) => (s.pains?.items || []).map((p) => p.id));
  const incOpps = new Map((Array.isArray(incoming.opps) ? incoming.opps : []).map((o) => [o?.id, o]));
  const opps = [];
  for (const o of old.opps || []) {
    if (!painIds.includes(o.pain)) continue;
    const n = incOpps.get(o.id);
    const chosen = n ? str(n.chosen, 300) : o.chosen;
    opps.push({ ...o, chosen, by: chosen === o.chosen ? o.by : chosen && o.drafts.includes(chosen) ? "ai" : "human" });
  }
  for (const pid of painIds) if (!opps.some((o) => o.pain === pid)) {
    const n = [...incOpps.values()].find((o) => o?.pain === pid);
    opps.push({ id: `O${Date.now().toString(36)}${opps.length}`, pain: pid, drafts: [], chosen: n ? str(n.chosen, 300) : "", by: "human" });
  }
  const memos = { low: str(incoming.memos?.low, 600), peak: str(incoming.memos?.peak, 600), end: str(incoming.memos?.end, 600) };
  const map = { ...old, stages, opps, memos };
  if (lens === "to-be" && Array.isArray(incoming.scenes)) {
    map.scenes = old.scenes.map((sc) => {
      const n = incoming.scenes.find((x) => x?.id === sc.id);
      if (!n) return sc;
      const next = { title: str(n.title, 80) || sc.title, description: str(n.description, 600) };
      return same(next, { title: sc.title, description: sc.description }) ? sc : { ...sc, ...next, by: "human" };
    });
  }
  return map;
}

// ── 3. 칸 하나 다시 쓰기 ──
async function rewrite(request, env, json, user, row) {
  if (row.status === "confirmed") return json({ error: "확정한 저니맵은 고칠 수 없어요.", code: "locked" }, 409);
  const body = await readBody(request);
  const map = JSON.parse(row.map);
  const stage = map.stages.find((s) => s.id === body?.stage);
  const lane = LANES.includes(body?.lane) ? body.lane : null;
  if (!stage || !lane || (lane === "hmw" && !stage.pains?.items.some((p) => p.id === body.pain))) return json({ error: "다시 쓸 칸을 찾을 수 없어요." }, 400);
  if (row.lens === "to-be" && ["pains", "hmw"].includes(lane)) return json({ error: "TO-BE 에서는 이 칸을 다시 쓸 수 없어요." }, 400);
  if (!env.OPENAI_API_KEY) return json({ error: "AI를 부르지 못했어요. 잠시 후 다시 시도해 주세요." }, 502);

  const persona = JSON.parse(row.persona);
  const src = await personaSource(env, user, row.persona_id ? { id: row.persona_id } : persona);
  if (src.error) return json({ error: src.error }, 400);
  const pain = lane === "hmw" ? stage.pains.items.find((p) => p.id === body.pain) : null;
  const current = laneText(stage, lane, pain);

  // 근거 다시 찾기: 분석 묶음이 있으면 벡터 검색(처음이면 색인), 없으면 노트 전체에서 고른다
  let retrieved = [];
  const started = Date.now();
  try {
    if (src.analysis) {
      if (!src.analysis.indexed_at) await indexAnalysis(env, { id: src.analysis.user_id }, src.analysis);
      const [qvec] = await embedAll(env, [`${row.scenario} · ${stage.name}: ${stage.goal} · ${LANE_LABEL[lane]} · ${current}`]);
      retrieved = await search(env, src.analysis, qvec, { codes: new Set(), personaName: persona.name });
    }
  } catch (err) {
    console.error("journey rewrite search failed", String(err?.message || err));
    retrieved = src.notes.slice(0, 60).map((n) => ({ ref_id: n.id, text: n.text, code: n.code, source_ref: n.ref }));
  }
  const allowed = new Set(retrieved.map((c) => c.ref_id));
  const others = map.stages.map((s, i) => `${i + 1}. ${s.name}(${s.goal}) · 감정 ${s.emotion.score}`).join("\n");
  let out;
  try {
    out = await callOpenAI(env, {
      name: "journey_cell", schema: REWRITE_SCHEMA[lane], max: REWRITE_TOKENS,
      instructions: `${GENERATE_RULES}\n\n지금은 저니맵의 칸 하나만 다시 쓴다. 다른 칸과 단계 골격은 바꾸지 않는다. 아래 '다시 찾은 근거'만 refs 로 쓸 수 있다.${row.lens === "to-be" ? "\n이 지도는 TO-BE(개선된 경험 가설)다. 근거는 AS-IS 의 마찰을 해소하는 방향으로만 참고한다." : ""}`,
      input: `## 페르소나\n${src.personaText}\n\n## 시나리오\n${row.scenario}\n\n## 단계 골격\n${others}\n\n## 다시 쓸 칸\n단계: ${stage.name} — ${stage.goal}\n레인: ${LANE_LABEL[lane]}${pain ? `\n페인포인트: ${pain.text}` : ""}\n지금 내용: ${current || "(비어 있음)"}\n\n## 다시 찾은 근거\n${retrieved.map((c) => `[${c.ref_id}] ${c.text}`).join("\n") || "(근거 없음 — 추론하고 refs 는 빈 배열)"}`,
    });
  } catch (err) {
    console.error("journey rewrite failed", String(err?.message || err));
    return json({ error: "칸을 다시 쓰지 못했어요. 잠시 후 다시 시도해 주세요." }, 502);
  }
  if (!out) return json({ error: "칸을 다시 쓰지 못했어요. 잠시 후 다시 시도해 주세요." }, 502);
  const refs = cleanRefs(out.refs, allowed);
  const by = "ai-rewrite";
  if (lane === "head") Object.assign(stage, { name: str(out.name, 30) || stage.name, goal: str(out.goal, 160) || stage.goal, headBy: by });
  if (lane === "actions" || lane === "touchpoints") stage[lane] = { items: strs(out.items, lane === "actions" ? 5 : 6, 200), refs, by };
  if (lane === "thought") stage.thought = { text: str(out.text, 300), refs, by };
  if (lane === "change") stage.change = { text: str(out.text, 300), by };
  if (lane === "emotion") stage.emotion = { score: clampScore(out.score), feel: str(out.feel, 30), note: str(out.note, 200), quote: str(out.quote, 300), quoteRef: str(out.quote_ref, 20), refs, votes: row.lens === "to-be" ? [] : cleanVotes(out.votes, allowed), by };
  if (lane === "pains") {
    const items = arr(out.items, 4).map((x, k) => ({ id: stage.pains.items[k]?.id || `${stage.id}-p${Date.now().toString(36)}${k}`, text: str(x, 300), refs })).filter((p) => p.text);
    stage.pains = { items, by };
    const ids = map.stages.flatMap((s) => s.pains.items.map((p) => p.id));
    map.opps = (map.opps || []).filter((o) => ids.includes(o.pain));
    for (const p of items) if (!map.opps.some((o) => o.pain === p.id)) map.opps.push({ id: `O${Date.now().toString(36)}${map.opps.length}`, pain: p.id, drafts: [], chosen: "", by: "ai" });
  }
  if (lane === "hmw") {
    const o = map.opps.find((x) => x.pain === pain.id);
    const drafts = strs(out.items, 3, 300);
    if (o) Object.assign(o, { drafts, by: o.chosen ? o.by : by }); else map.opps.push({ id: `O${Date.now().toString(36)}`, pain: pain.id, drafts, chosen: "", by });
  }
  const byId = new Map(retrieved.map((c) => [c.ref_id, c]));
  for (const id of refs) if (!map.evidence[id] && byId.has(id)) { const c = byId.get(id); map.evidence[id] = { text: c.text, code: c.code || "", ref: c.source_ref || "" }; }
  const t = now();
  await env.DB.prepare("UPDATE journeys SET map = ?, updated_at = ? WHERE id = ?").bind(JSON.stringify(map), t, row.id).run();
  return json({
    journey: await viewWithParent(env, { ...row, map: JSON.stringify(map), updated_at: t }),
    rewrite: { stage: stage.id, lane, refs, searched: retrieved.length, ms: Date.now() - started },
  });
}

const LANE_LABEL = { head: "단계 이름과 목표", actions: "행동", thought: "생각", emotion: "감정", touchpoints: "터치포인트", pains: "페인포인트", hmw: "기회(How might we) 초안", change: "AS-IS 대비 바뀐 점" };
function laneText(s, lane, pain) {
  if (lane === "head") return `${s.name} — ${s.goal}`;
  if (lane === "actions" || lane === "touchpoints") return (s[lane]?.items || []).join(" / ");
  if (lane === "thought" || lane === "change") return s[lane]?.text || "";
  if (lane === "emotion") return `${s.emotion.score} ${s.emotion.feel}: ${s.emotion.note} ${s.emotion.quote ? `"${s.emotion.quote}"` : ""}`;
  if (lane === "pains") return (s.pains?.items || []).map((p) => p.text).join(" / ");
  if (lane === "hmw") return pain?.text || "";
  return "";
}
const withRefs = (props, req) => ({ type: "object", additionalProperties: false, required: [...req, "refs"], properties: { ...props, refs: strArr } });
const REWRITE_SCHEMA = {
  head: withRefs({ name: { type: "string" }, goal: { type: "string" } }, ["name", "goal"]),
  actions: withRefs({ items: strArr }, ["items"]),
  touchpoints: withRefs({ items: strArr }, ["items"]),
  thought: withRefs({ text: { type: "string" } }, ["text"]),
  change: withRefs({ text: { type: "string" } }, ["text"]),
  emotion: withRefs({ score: { type: "integer", enum: [-2, -1, 0, 1, 2] }, feel: { type: "string" }, note: { type: "string" }, quote: { type: "string" }, quote_ref: { type: "string" }, votes: { type: "array", items: { type: "object", additionalProperties: false, required: ["code", "score", "refs", "quote"], properties: { code: { type: "string" }, score: { type: "integer", enum: [-2, -1, 0, 1, 2] }, refs: strArr, quote: { type: "string" } } } } }, ["score", "feel", "note", "quote", "quote_ref", "votes"]),
  pains: withRefs({ items: strArr }, ["items"]),
  hmw: withRefs({ items: strArr }, ["items"]),
};

// ── 4. 확정 ──
async function confirm(request, env, json, row) {
  if (row.status === "confirmed") return json({ journey: await viewWithParent(env, row) });
  const body = (await readBody(request)) || {};
  let map = JSON.parse(row.map);
  if (body.map) map = mergeEdits(map, body.map, row.lens);
  if (row.lens === "as-is" && !body.force) {
    const missing = map.stages.flatMap((s) => s.pains.items.filter((p) => !map.opps.some((o) => o.pain === p.id && o.chosen)).map((p) => ({ id: p.id, stage: s.name, text: p.text })));
    if (missing.length) {
      await env.DB.prepare("UPDATE journeys SET map = ?, updated_at = ? WHERE id = ?").bind(JSON.stringify(map), now(), row.id).run();
      return json({ error: `기회(HMW)가 하나도 없는 페인포인트가 ${missing.length}개 있어요.`, code: "missing_opps", missing }, 409);
    }
  }
  const t = now();
  await env.DB.prepare("UPDATE journeys SET map = ?, status = 'confirmed', confirmed_at = ?, updated_at = ? WHERE id = ?").bind(JSON.stringify(map), t, t, row.id).run();
  return json({ journey: await viewWithParent(env, { ...row, map: JSON.stringify(map), status: "confirmed", confirmed_at: t, updated_at: t }) });
}

// ── 5. TO-BE ──
async function toBe(env, json, user, row) {
  if (row.lens !== "as-is") return json({ error: "AS-IS 저니맵에서만 TO-BE 를 만들 수 있어요." }, 400);
  if (row.status !== "confirmed") return json({ error: "AS-IS 를 먼저 확정해 주세요. TO-BE 는 합의된 AS-IS 위에 그려요.", code: "not_confirmed" }, 409);
  if (!env.OPENAI_API_KEY) return json({ error: "AI를 부르지 못했어요. 잠시 후 다시 시도해 주세요." }, 502);
  const asis = JSON.parse(row.map);
  const persona = JSON.parse(row.persona);
  const chosen = asis.opps.filter((o) => o.chosen);
  const painOf = (pid) => { for (const s of asis.stages) { const p = s.pains.items.find((x) => x.id === pid); if (p) return { stage: s, pain: p }; } return null; };
  const sig = signals(asis.stages);
  const asisText = asis.stages.map((s, i) => [
    `[${s.id}] ${i + 1}. ${s.name} — ${s.goal}`,
    `  행동: ${s.actions.items.join(" / ")}`, `  생각: ${s.thought.text}`,
    `  감정: ${s.emotion.score} ${s.emotion.feel} — ${s.emotion.note}`,
    `  터치포인트: ${s.touchpoints.items.join(", ") || "없음"}`,
    `  페인포인트: ${s.pains.items.map((p) => `${p.id} ${p.text}`).join(" / ") || "없음"}`,
  ].join("\n")).join("\n");
  const hmwText = chosen.map((o) => { const x = painOf(o.pain); return `[${o.id}] ${o.chosen} (← ${o.pain} ${x?.pain.text || ""} · ${x?.stage.name || ""})`; }).join("\n");
  const memoText = ["low", "peak", "end"].map((k) => asis.memos?.[k] ? `${{ low: "저점", peak: "정점", end: "종점" }[k]}(${asis.stages[sig[k]].name}): ${asis.memos[k]}` : "").filter(Boolean).join("\n");

  const started = Date.now();
  let out;
  try {
    out = await callOpenAI(env, {
      name: "journey_tobe", schema: TOBE_SCHEMA, max: TOBE_TOKENS,
      instructions: `너는 UX 리서처를 돕는 저니맵 에이전트다. 확정된 AS-IS 저니맵 위에 TO-BE(개선된 경험)를 설계한다. 스킬 'journey-mapping' 6~7절을 따른다.
- 단계 골격은 AS-IS 와 똑같다. 모든 stage_id 를 AS-IS 순서대로 하나씩 쓴다. 단계를 더하거나 빼지 않는다.
- 각 단계의 행동·생각·감정·터치포인트를 '이 서비스가 개선된다면' 기준으로 다시 쓴다. change 에는 AS-IS 대비 무엇이 달라졌는지 한 문장.
- 리서처가 확정한 HMW 기회를 모두 어느 단계엔가 반영한다. applied_hmw 에 반영한 기회 ID(O1 형식)를 넣는다. 하나의 기회가 여러 단계에 걸칠 수 있다.
- 감정 score 는 -2~+2 정수. 무리하게 모두 +2로 만들지 않는다. 실제로 해소된 만큼만 올린다.
- 피크엔드 법칙: 사람은 정점과 마지막 순간으로 경험을 기억한다. 종점(마지막 단계)이 긍정이 되도록 설계됐는지 end_check 에서 스스로 점검하고, 부족하면 positive=false 와 구체적 제안 2~3개를 쓴다. 충분해도 더 좋게 만들 제안을 1~2개 쓴다.
- scenes 에는 시나리오 보드로 넘길 TO-BE 핵심 장면 2~4개: 개선이 가장 크게 체감되는 순간. title 은 짧게, description 은 누가 어디서 무엇을 하고 어떤 느낌인지 2~3문장, hmw_ids 는 그 장면이 실현하는 기회 ID.
- 모든 내용은 검증 전 가설이다. 단정 대신 구체적인 장면으로 쓴다. 한국어로.`,
      input: `## 페르소나\n${persona.name} · ${persona.role}\n${persona.desc}\n\n## 시나리오\n${row.scenario}\n\n## 확정된 AS-IS\n${asisText}\n\n## 확정된 HMW 기회\n${hmwText || "(없음)"}\n\n## 리서처 해석 메모\n${memoText || "(없음)"}`,
    });
  } catch (err) {
    console.error("journey tobe failed", String(err?.message || err));
    return json({ error: "TO-BE 를 만들지 못했어요. 잠시 후 다시 시도해 주세요." }, 502);
  }
  if (!out || !Array.isArray(out.stages)) return json({ error: "TO-BE 를 만들지 못했어요. 잠시 후 다시 시도해 주세요." }, 502);

  const oppIds = new Set(chosen.map((o) => o.id));
  const byStage = new Map(out.stages.map((s) => [s.stage_id, s]));
  const stages = asis.stages.map((a) => {
    const s = byStage.get(a.id) || {};
    return {
      id: a.id, name: a.name, goal: a.goal, headBy: "ai",
      actions: { items: strs(s.actions?.items, 5, 200), refs: [], by: "ai" },
      thought: { text: str(s.thought?.text, 300), refs: [], by: "ai" },
      emotion: { score: clampScore(s.emotion?.score), feel: str(s.emotion?.feel, 30), note: str(s.emotion?.note, 200), quote: "", quoteRef: "", refs: [], by: "ai" },
      touchpoints: { items: strs(s.touchpoints?.items, 6, 60), refs: [], by: "ai" },
      change: { text: str(s.change, 300), by: "ai" },
      applied: strs(s.applied_hmw, 8, 10).filter((x) => oppIds.has(x)),
      pains: { items: [], by: "ai" },
    };
  });
  const last = stages[stages.length - 1];
  const ec = out.end_check || {};
  const endCheck = { positive: !!ec.positive && last.emotion.score > 0, aiSaid: !!ec.positive, score: last.emotion.score, comment: str(ec.comment, 400), suggestions: strs(ec.suggestions, 4, 300) };
  const stageIds = new Set(stages.map((s) => s.id));
  const scenesOut = arr(out.scenes, 4).map((c, i) => ({ id: `C${i + 1}`, title: str(c.title, 80), stage: stageIds.has(c.stage_id) ? c.stage_id : stages[0].id, description: str(c.description, 600), hmw: strs(c.hmw_ids, 6, 10).filter((x) => oppIds.has(x)), by: "ai" })).filter((c) => c.title);
  const map = { stages, opps: chosen.map((o) => ({ ...o })), memos: { low: "", peak: "", end: "" }, evidence: {}, endCheck, scenes: scenesOut };
  const unlinked = chosen.filter((o) => !stages.some((s) => s.applied.includes(o.id))).map((o) => o.id);
  const t = now();
  const meta = {
    model: env.OPENAI_MODEL, ms: Date.now() - started,
    inputs: [
      { k: "바탕", v: `확정된 AS-IS 버전 ${row.version}의 단계 ${asis.stages.length}개(이름·목표 그대로)와 각 단계의 행동·생각·감정·터치포인트·페인포인트` },
      { k: "기회", v: `리서처가 확정한 HMW ${chosen.length}개${unlinked.length ? ` — 이 중 ${unlinked.join(", ")}는 TO-BE 에 반영되지 않았어요` : " — 모두 어느 단계엔가 반영했어요"}` },
      { k: "해석 메모", v: memoText ? "저점·정점·종점에 리서처가 쓴 메모" : "없음" },
      { k: "지킨 규칙", v: "같은 단계 골격 · 모든 칸은 검증 전 가설 · 종점이 긍정인지 점검(피크엔드)" },
    ],
    unlinked,
  };
  const newRow = {
    id: crypto.randomUUID(), user_id: user.id, persona_id: row.persona_id, analysis_id: row.analysis_id, persona: row.persona,
    scenario: row.scenario, lens: "to-be", parent_id: row.id, version: row.version, status: "draft", map: JSON.stringify(map), meta: JSON.stringify(meta), created_at: t, updated_at: t, confirmed_at: null,
  };
  await insert(env, newRow);
  return json({ journey: await viewWithParent(env, newRow) });
}

const TOBE_SCHEMA = {
  type: "object", additionalProperties: false, required: ["stages", "end_check", "scenes"],
  properties: {
    stages: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["stage_id", "actions", "thought", "emotion", "touchpoints", "change", "applied_hmw"],
        properties: {
          stage_id: { type: "string" },
          actions: { type: "object", additionalProperties: false, required: ["items"], properties: { items: strArr } },
          thought: { type: "object", additionalProperties: false, required: ["text"], properties: { text: { type: "string" } } },
          emotion: { type: "object", additionalProperties: false, required: ["score", "feel", "note"], properties: { score: { type: "integer", enum: [-2, -1, 0, 1, 2] }, feel: { type: "string" }, note: { type: "string" } } },
          touchpoints: { type: "object", additionalProperties: false, required: ["items"], properties: { items: strArr } },
          change: { type: "string" }, applied_hmw: strArr,
        },
      },
    },
    end_check: { type: "object", additionalProperties: false, required: ["positive", "comment", "suggestions"], properties: { positive: { type: "boolean" }, comment: { type: "string" }, suggestions: strArr } },
    scenes: { type: "array", items: { type: "object", additionalProperties: false, required: ["title", "stage_id", "description", "hmw_ids"], properties: { title: { type: "string" }, stage_id: { type: "string" }, description: { type: "string" }, hmw_ids: strArr } } },
  },
};

// ── 공통 ──
function signals(stages) {
  const v = stages.map((s) => s.emotion.score);
  return { low: v.indexOf(Math.min(...v)), peak: v.indexOf(Math.max(...v)), end: v.length - 1 };
}

async function insert(env, r) {
  await env.DB.prepare(
    `INSERT INTO journeys (id, user_id, persona_id, analysis_id, persona, scenario, lens, parent_id, version, status, map, meta, created_at, updated_at, confirmed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(r.id, r.user_id, r.persona_id, r.analysis_id, r.persona, r.scenario, r.lens, r.parent_id, r.version, r.status, r.map, r.meta, r.created_at, r.updated_at, r.confirmed_at).run();
}

function view(r, project = null) {
  return {
    id: r.id, personaId: r.persona_id, analysisId: r.analysis_id, persona: JSON.parse(r.persona), scenario: r.scenario,
    lens: r.lens, parentId: r.parent_id, version: r.version, status: r.status, project,
    map: JSON.parse(r.map), meta: r.meta ? JSON.parse(r.meta) : null,
    createdAt: r.created_at, updatedAt: r.updated_at, confirmedAt: r.confirmed_at,
  };
}

// TO-BE 는 비교 보기를 위해 바탕 AS-IS 를, AS-IS 는 만든 TO-BE 목록을 함께 준다
async function viewWithParent(env, r) {
  const a = r.analysis_id ? await env.DB.prepare("SELECT service FROM persona_analyses WHERE id = ?").bind(r.analysis_id).first() : null;
  const out = view(r, a?.service || null);
  if (r.parent_id) {
    const p = await env.DB.prepare("SELECT * FROM journeys WHERE id = ?").bind(r.parent_id).first();
    if (p) out.parent = view(p, out.project);
  } else {
    const { results } = await env.DB.prepare("SELECT id, status, updated_at FROM journeys WHERE parent_id = ? ORDER BY created_at").bind(r.id).all();
    out.children = results.map((c) => ({ id: c.id, status: c.status, updatedAt: c.updated_at }));
  }
  return out;
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

async function readBody(request) {
  const raw = await request.text();
  if (raw.length > MAX_BODY_CHARS) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function str(v, n) { return typeof v === "string" ? v.trim().slice(0, n) : ""; }
function arr(v, n) { return Array.isArray(v) ? v.slice(0, n) : []; }
function strs(v, n, m) { return arr(v, n).map((x) => str(x, m)).filter(Boolean); }
function clampScore(v) { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.max(-2, Math.min(2, n)) : 0; }
// 참가자별 감정 점수: 같은 참가자는 한 번만, 근거 노트가 확인된 것만 남긴다
function cleanVotes(v, allowed) {
  const seen = new Set();
  return arr(v, 12).map((x) => ({ code: str(x?.code, 10).toUpperCase(), score: clampScore(x?.score), refs: cleanRefs(x?.refs, allowed), quote: str(x?.quote, 300) }))
    .filter((x) => /^P\d{1,3}$/.test(x.code) && x.refs.length && !seen.has(x.code) && seen.add(x.code));
}
function cleanRefs(v, allowed) {
  return [...new Set(arr(v, 8).map((x) => str(x, 10).replace(/^\[|\]$/g, "").toUpperCase()).filter((x) => allowed.has(x)))];
}
