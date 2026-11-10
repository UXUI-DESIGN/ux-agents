// 인터뷰 데이터분석 에이전트 — 스킬 "인터뷰 분석 (Qualitative Synthesis)" 의 5단계 파이프라인
//   ① 준비·정제  ② 데이터 조직화·코딩   → POST /api/analysis                 (OpenAI 1회)
//   ③ 패턴·테마  ④ 합성·전달  ⑤ 교차검증 계획 → POST /api/analysis/:id/synthesize (OpenAI 1회)
//
//   GET    /api/analysis              내 분석 기록 (로그인)
//   GET    /api/analysis/sources      고를 수 있는 모더레이터 인터뷰 (로그인, 페르소나와 같은 목록)
//   POST   /api/analysis              { source: moderator|paste|sample, interview_ids?, text?, goal, stage, approach, apriori } → { analysis }
//   GET    /api/analysis/:id          분석 1건
//   POST   /api/analysis/:id/synthesize  코딩 결과로 ③④⑤ → { analysis }
//   DELETE /api/analysis/:id          (로그인, 내 것만)
//
// 원칙 (스킬 그대로)
//   - 관찰(OBS: 참가자가 실제로 한 말)과 해석(INT: 분석가의 추론)을 섞지 않는다. 코딩 발췌는 OBS만, 해석은 따로 둔다
//   - 모든 발췌는 발화 번호(P01-3)·타임코드로 원문까지 역추적된다. 인용이 원문과 다르면 '원문 불일치'로 표시한다
//   - 클러스터 신뢰도(참가자 지지율·다중 인터뷰 출현·정서 강도·행동 증거)는 모델이 아니라 여기서 발췌로 계산한다
//   - 정량 데이터가 없으므로 인사이트는 synthesized 까지만. triangulated 격상은 사람이 정량 소스로 확인한 뒤에 한다
// 로그인 없이(샘플·붙여넣기) 돌린 분석은 user_id 없이 저장하고, id 를 아는 사람만 열 수 있으며 7일 뒤 지운다.

import { currentUser, rateLimit } from "./auth.js";
import { materialOf } from "./debrief.js";
import { stagesOf } from "./moderator.js";
import { sourcesOf } from "./personas.js";
import { firstJson } from "./json.js";

const MAX_BODY_CHARS = 120000;
const MAX_MATERIAL_CHARS = 60000;
const MAX_PARTICIPANTS = 20;
const CODE_TOKENS = 16000;
const SYNTH_TOKENS = 14000;
const GUEST_TTL_SEC = 7 * 86400;
const STAGES = ["Pre-Development", "Concept Testing", "Beta", "Pre-Launch", "Post-Launch", "Diagnostic"];
const STAGE_FOCUS = {
  "Pre-Development": "진짜 문제가 무엇인가 — 참가자 다양성과 미충족 니즈를 강조",
  "Concept Testing": "우리 가설이 옳은가 — 모순 발견과 정량 검증 계획을 강조",
  "Beta": "어디서 막히는가 — 막힘 지점과 세션 리플레이 교차 확인을 강조",
  "Pre-Launch": "메시지가 통하는가 — 정서 강도 가중을 강조",
  "Post-Launch": "실사용은 기대와 어떻게 다른가 — 행동 데이터 우선",
  "Diagnostic": "이 이상 신호의 원인이 무엇인가 — 교차 검증에서 거꾸로 원인을 좁힘",
};
const APPROACHES = ["inductive", "mixed", "deductive"];
const APPROACH_LABEL = { inductive: "귀납(Open coding): 미리 정한 틀 없이 데이터에서 코드를 키운다", mixed: "혼합: 아래 가설 코드를 상위 틀로 쓰되 데이터에서 하위 코드를 새로 만든다", deductive: "연역(A-priori): 아래 가설 코드로 분류하되, 어디에도 안 맞는 발화는 새 코드로 만들어 표시한다" };
const NEXT = ["저니맵", "공감 지도", "페르소나", "사용성 테스트", "재설계 제안", "후속 인터뷰"];
const NOT_FOUND = { error: "분석을 찾을 수 없어요.", code: "not_found" };

export async function analysis(request, env, json, id, action) {
  const method = request.method;
  const user = await currentUser(request, env);

  if (id === "sources" && method === "GET") {
    if (!user) return json({ error: "로그인이 필요해요.", code: "unauthorized" }, 401);
    return json({ sessions: await sourcesOf(env, user) });
  }
  if (!id && method === "GET") {
    if (!user) return json({ error: "로그인이 필요해요.", code: "unauthorized" }, 401);
    const { results } = await env.DB.prepare(
      "SELECT id, title, source_kind, sources, status, created_at, updated_at FROM interview_analyses WHERE user_id = ? ORDER BY created_at DESC LIMIT 50"
    ).bind(user.id).all();
    return json({ analyses: results.map((r) => ({ id: r.id, title: r.title, source_kind: r.source_kind, participants: JSON.parse(r.sources).length, status: r.status, created_at: r.created_at, updated_at: r.updated_at })) });
  }
  if (!id && method === "POST") return start(request, env, json, user);

  if (!id) return json({ error: "없는 경로예요." }, 404);
  const row = await env.DB.prepare("SELECT * FROM interview_analyses WHERE id = ?").bind(id).first();
  // 로그인 없이 만든 분석은 id 가 열쇠, 회원 분석은 주인만
  if (!row || (row.user_id && row.user_id !== user?.id)) return json(NOT_FOUND, 404);

  if (!action && method === "GET") return json({ analysis: view(row, user) });
  if (action === "synthesize" && method === "POST") return synthesize(env, json, row, user);
  if (!action && method === "DELETE") {
    if (!row.user_id) return json({ error: "로그인 없이 만든 분석은 7일 뒤 자동으로 지워져요.", code: "guest" }, 403);
    await env.DB.prepare("DELETE FROM interview_analyses WHERE id = ?").bind(row.id).run();
    return json({ ok: true });
  }
  return json({ error: "없는 경로예요." }, 404);
}

// ── ①② 준비·정제 + 코딩 ──
async function start(request, env, json, user) {
  const raw = await request.text();
  if (raw.length > MAX_BODY_CHARS) return json({ error: "보낸 내용이 너무 길어요. 6만 자 이하로 줄여 주세요." }, 413);
  let body;
  try { body = JSON.parse(raw); } catch { return json({ error: "JSON 본문이 필요해요." }, 400); }

  const options = cleanOptions(body);
  const source = ["moderator", "paste", "sample"].includes(body.source) ? body.source : "paste";
  let material, title;

  if (source === "moderator") {
    if (!user) return json({ error: "모더레이터 인터뷰를 분석하려면 로그인이 필요해요.", code: "unauthorized" }, 401);
    const ids = Array.isArray(body.interview_ids) ? [...new Set(body.interview_ids.filter((x) => typeof x === "string"))].slice(0, MAX_PARTICIPANTS) : [];
    if (ids.length < 1) return json({ error: "인터뷰를 1건 이상 골라 주세요." }, 400);
    const r = await moderatorMaterial(env, user, ids);
    if (r.error) return json({ error: r.error, code: "bad_source" }, 400);
    material = r.material;
    title = r.title;
  } else {
    const text = typeof body.text === "string" ? body.text : "";
    if (!text.trim()) return json({ error: "인터뷰 기록을 붙여 넣어 주세요." }, 400);
    material = parseTranscript(text);
    if (!material.length || !material.some((p) => p.lines.some((l) => l.role === "participant"))) return json({ error: "참가자 발화를 찾지 못했어요. 형식 안내를 참고해 주세요." }, 400);
    if (material.length > MAX_PARTICIPANTS) return json({ error: `참가자는 한 번에 ${MAX_PARTICIPANTS}명까지 분석할 수 있어요.` }, 400);
    title = source === "sample" ? "샘플 · AI 글래스 실시간 통역 인터뷰" : `붙여 넣은 인터뷰 ${material.length}건`;
  }
  if (options.goal) title = `${title} — ${options.goal.slice(0, 60)}`;

  const transcript = materialText(material);
  if (transcript.length > MAX_MATERIAL_CHARS) return json({ error: `인터뷰 분량이 너무 많아요 (${transcript.length.toLocaleString()}자). ${MAX_MATERIAL_CHARS.toLocaleString()}자 이하가 되도록 인터뷰 수를 줄여 주세요.`, code: "too_long" }, 413);
  if (!env.OPENAI_API_KEY) return json({ error: "AI를 부르지 못했어요. 잠시 후 다시 시도해 주세요." }, 502);

  const now = Math.floor(Date.now() / 1000);
  if (!user) {
    const limited = await rateLimit(request, env, json, "analysis", "로그인 없는 분석", now);
    if (limited) return limited;
  }

  const started = Date.now();
  let coding;
  try {
    const parsed = await askCoding(env, { transcript, material, options });
    coding = verifyCoding(parsed, material);
  } catch (err) {
    console.error("analysis coding failed", String(err?.message || err));
    return json({ error: "인터뷰 코딩에 실패했어요. 잠시 후 다시 시도해 주세요." }, 502);
  }

  const id = crypto.randomUUID();
  const sources = material.map((p) => ({ code: p.code, label: p.label, interview_id: p.interview_id || null, session_id: p.session_id || null, session_name: p.session_name || null, lines: p.lines.length, minutes: p.minutes ?? null }));
  const meta = { model: env.OPENAI_MODEL, code_ms: Date.now() - started, transcript_chars: transcript.length, ...coding.check };
  delete coding.check;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM interview_analyses WHERE user_id IS NULL AND created_at < ?").bind(now - GUEST_TTL_SEC),
    env.DB.prepare("INSERT INTO interview_analyses (id, user_id, title, source_kind, sources, options, coding, meta, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'coded', ?, ?)")
      .bind(id, user?.id || null, title.slice(0, 200), source, JSON.stringify(sources), JSON.stringify(options), JSON.stringify(coding), JSON.stringify(meta), now, now),
  ]);
  const row = await env.DB.prepare("SELECT * FROM interview_analyses WHERE id = ?").bind(id).first();
  return json({ analysis: view(row, user) });
}

// ── ③④⑤ 패턴·합성·교차검증 계획 ──
async function synthesize(env, json, row, user) {
  if (!row.coding) return json({ error: "코딩 결과가 없어요. 처음부터 다시 분석해 주세요." }, 409);
  if (!env.OPENAI_API_KEY) return json({ error: "AI를 부르지 못했어요. 잠시 후 다시 시도해 주세요." }, 502);
  const coding = JSON.parse(row.coding);
  const options = JSON.parse(row.options);
  const started = Date.now();
  let synthesis;
  try {
    const parsed = await askSynthesis(env, { coding, options });
    synthesis = finishSynthesis(parsed, coding);
  } catch (err) {
    console.error("analysis synthesis failed", String(err?.message || err));
    return json({ error: "패턴 도출·합성에 실패했어요. 잠시 후 다시 시도해 주세요." }, 502);
  }
  const now = Math.floor(Date.now() / 1000);
  const meta = { ...JSON.parse(row.meta || "{}"), synth_ms: Date.now() - started };
  await env.DB.prepare("UPDATE interview_analyses SET synthesis = ?, meta = ?, status = 'synthesized', updated_at = ? WHERE id = ?")
    .bind(JSON.stringify(synthesis), JSON.stringify(meta), now, row.id).run();
  return json({ analysis: view({ ...row, synthesis: JSON.stringify(synthesis), meta: JSON.stringify(meta), status: "synthesized", updated_at: now }, user) });
}

function view(r, user) {
  return {
    id: r.id, title: r.title, source_kind: r.source_kind, status: r.status,
    sources: JSON.parse(r.sources), options: JSON.parse(r.options),
    coding: r.coding ? JSON.parse(r.coding) : null, synthesis: r.synthesis ? JSON.parse(r.synthesis) : null,
    meta: r.meta ? JSON.parse(r.meta) : {}, created_at: r.created_at, updated_at: r.updated_at,
    guest: !r.user_id, mine: !!user && r.user_id === user.id,
  };
}

function cleanOptions(b) {
  const str = (v, n) => (typeof v === "string" ? v.trim().slice(0, n) : "");
  const approach = APPROACHES.includes(b.approach) ? b.approach : "inductive";
  return {
    goal: str(b.goal, 300),
    stage: STAGES.includes(b.stage) ? b.stage : "",
    approach,
    apriori: approach === "inductive" ? [] : str(b.apriori, 1000).split(/[\n,]/).map((s) => s.trim()).filter(Boolean).slice(0, 20),
  };
}

// ── 자료: 참가자별 발화 줄 [{ ref, role, tc, text }] ──
// 모더레이터 인터뷰: 완료된 참가자만, '분석 제외' 발화는 빼고, 개인정보는 [REDACTED] 로 (디브리핑·페르소나와 같은 규칙)
async function moderatorMaterial(env, user, ids) {
  const { results: rows } = await env.DB.prepare(
    `SELECT i.id, i.session_id, s.name AS session_name, s.guide_snapshot, s.duration
       FROM interviews i JOIN interview_sessions s ON s.id = i.session_id
      WHERE s.user_id = ? AND i.status = 'completed' AND i.id IN (${ids.map(() => "?").join(",")})`
  ).bind(user.id, ...ids).all();
  if (rows.length !== ids.length) return { error: "고른 인터뷰 중 읽을 수 없는 것이 있어요. 목록을 새로 고쳐 주세요." };
  const sessions = new Map();
  for (const r of rows) {
    if (!sessions.has(r.session_id)) sessions.set(r.session_id, { id: r.session_id, name: r.session_name, guide_snapshot: r.guide_snapshot, duration: r.duration, ids: [] });
    sessions.get(r.session_id).ids.push(r.id);
  }
  const material = [];
  const usedCodes = new Set();
  for (const s of sessions.values()) {
    const m = await materialOf(env, s, s.ids);
    const stages = stagesOf(JSON.parse(s.guide_snapshot));
    for (const p of m.participants) {
      // 세션이 여러 개면 참가자 코드가 겹칠 수 있어 뒤에 붙여 구분한다 (P01, P01b …)
      let code = p.code;
      for (let k = 0; usedCodes.has(code); k++) code = `${p.code}${"bcdefgh"[k]}`;
      usedCodes.add(code);
      const lines = p.lines.map((l) => ({
        ref: l.ref.replace(p.code, code), role: l.role === "participant" ? "participant" : "moderator",
        tc: timecode(l.at), stage: stages[l.stage] || "", text: l.text,
      }));
      material.push({ code, label: `${s.name} · 참가자 ${p.code}`, interview_id: p.id, session_id: s.id, session_name: s.name, minutes: p.minutes, lines });
    }
  }
  const names = [...sessions.values()].map((s) => s.name);
  return { material, title: names.length === 1 ? names[0] : `${names[0]} 외 ${names.length - 1}개 세션` };
}

const MODERATOR_RE = /^(모더레이터|진행자|인터뷰어|면접관|연구자|리서처|질문|moderator|interviewer|researcher|M|Q|I)$/i;
const HEAD_RE = /^#{1,4}\s*(.+?)\s*$/;
const LINE_RE = /^\s*(?:\[?((?:\d{1,2}:)?\d{1,2}:\d{2})\]?\s*)?([^:：\[\]]{1,24}?)\s*[:：]\s*(.*)$/;

// 붙여 넣은 전사: "## P01 · 설명" 으로 참가자를 나누고, "[00:01:30] 모더레이터: …" / "P01: …" 줄로 발화를 읽는다
export function parseTranscript(raw) {
  const out = [];
  let cur = null;
  const ensure = () => {
    if (!cur) { cur = { code: nextCode(out), label: "", lines: [] }; out.push(cur); }
    return cur;
  };
  for (const rawLine of String(raw).replace(/\r/g, "").split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const head = line.match(HEAD_RE);
    if (head) {
      const t = head[1];
      const m = t.match(/^(P\d{1,3})\b\s*[·\-—:|]?\s*(.*)$/i);
      let code = m ? `P${String(Number(m[1].slice(1))).padStart(2, "0")}` : nextCode(out);
      while (out.some((p) => p.code === code)) code = nextCode(out);
      cur = { code, label: (m ? m[2] : t).slice(0, 120), lines: [] };
      out.push(cur);
      continue;
    }
    const p = ensure();
    const u = line.match(LINE_RE);
    if (u && u[2] && !/^https?$/i.test(u[2])) {
      const speaker = u[2].trim();
      const isMod = MODERATOR_RE.test(speaker) || /모더레이터|진행자|인터뷰어/.test(speaker);
      p.lines.push({ role: isMod ? "moderator" : "participant", tc: u[1] ? normalizeTc(u[1]) : "", text: u[3].trim() });
    } else if (p.lines.length) {
      p.lines[p.lines.length - 1].text += " " + line; // 앞 발화가 이어지는 줄
    } else {
      p.lines.push({ role: "participant", tc: "", text: line });
    }
  }
  for (const p of out) {
    let pi = 0, mi = 0;
    p.lines = p.lines.filter((l) => l.text).map((l) => ({ ...l, ref: l.role === "participant" ? `${p.code}-${++pi}` : `${p.code}-M${++mi}`, text: l.text.slice(0, 2000) }));
  }
  return out.filter((p) => p.lines.length);
}

function nextCode(list) {
  for (let n = list.length + 1; ; n++) {
    const c = `P${String(n).padStart(2, "0")}`;
    if (!list.some((p) => p.code === c)) return c;
  }
}
function normalizeTc(t) {
  const parts = t.split(":").map((x) => x.padStart(2, "0"));
  while (parts.length < 3) parts.unshift("00");
  return `[${parts.join(":")}]`;
}
function timecode(sec) {
  if (!Number.isFinite(sec) || sec < 0) return "";
  const s = Math.floor(sec);
  return `[${[Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((x) => String(x).padStart(2, "0")).join(":")}]`;
}

function materialText(material) {
  return material.map((p) => {
    const head = `## ${p.code}${p.label ? ` — ${p.label}` : ""}${p.minutes != null ? ` (약 ${p.minutes}분)` : ""}`;
    const body = p.lines.map((l) => `[${l.ref}]${l.tc ? ` ${l.tc}` : ""} ${l.role === "participant" ? p.code : "모더레이터"}${l.stage ? ` (${l.stage})` : ""}: ${l.text}`).join("\n");
    return `${head}\n${body}`;
  }).join("\n\n");
}

// ── OpenAI 공통 ──
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

const obj = (properties, desc) => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties, ...(desc && { description: desc }) });
const S = (description) => ({ type: "string", ...(description && { description }) });
const N = (description) => ({ type: "number", ...(description && { description }) });
const A = (items, description) => ({ type: "array", items, ...(description && { description }) });
const E = (values, description) => ({ type: "string", enum: values, ...(description && { description }) });

// ── ①② 코딩 ──
const CODING_SCHEMA = obj({
  participants: A(obj({
    code: S("참가자 코드. 예: P01"),
    profile: S("나이·직업 등 세그먼트 변수 한 줄. 전사에 없으면 '전사에 정보 없음'"),
    context: S("이 참가자의 핵심 사용 맥락 한 줄"),
    familiarity: E(["High", "Med", "Low", "알 수 없음"], "기술 친숙도"),
  }), "참가자 매트릭스"),
  diversity: obj({ skewed: { type: "boolean" }, note: S("표본이 한 세그먼트로 쏠렸는지, 그렇다면 인사이트의 한계") }),
  codebook: A(obj({
    code: S("한국어 스네이크 표기 코드. 예: 지연시간_불만. 형용사 하나만으로 짓지 않는다"),
    definition: S("이 코드를 붙이는 기준 한 문장"),
    domain: S("도메인(색상 묶음) 이름. 전체 6개 이내로 재사용"),
    polarity: E(["긍정", "부정", "중립"]),
    origin: E(["귀납", "연역"], "데이터에서 나왔으면 귀납, 가설 코드에서 왔으면 연역"),
  })),
  excerpts: A(obj({
    id: S("E1, E2, …"),
    ref: S("근거 발화 번호. 참가자 발화만 (예: P01-3). 모더레이터 발화(P01-M2)는 쓰지 않는다"),
    quote: S("그 발화의 원문 그대로. 길면 앞뒤를 잘라도 되지만 단어를 고치거나 요약하지 않는다"),
    codes: A(S(), "이 발췌에 붙인 코드 (1~3개, codebook 에 있는 것만)"),
    polarity: N("감정 극성 -1.0(매우 부정) ~ +1.0(매우 긍정)"),
    evidence: E(["행동", "의견"], "실제로 한 일·겪은 사실이면 행동, 생각·선호·예측이면 의견"),
    confidence: N("이 코드 적용의 확신도 0~1. 애매하면 0.5 미만"),
  }), "OBS: 한 발화 = 한 스티키노트. 두 아이디어를 한 발췌에 묶지 않는다"),
  interpretations: A(obj({
    text: S("분석가의 해석 또는 작업 가설 한 문장"),
    kind: E(["해석", "작업가설"]),
    refs: A(S(), "근거 발화 번호"),
  }), "INT: 관찰이 아닌 추론은 모두 여기에. 확정으로 다루지 않는다"),
  bias_flags: A(S(), "편향 체크리스트에서 걸린 점 (분석가 가정, 질문 유도, 표본 쏠림 등). 없으면 빈 배열"),
});

async function askCoding(env, { transcript, material, options }) {
  const codes = material.map((p) => p.code);
  const instructions = `당신은 숙련된 UX 리서처(AI 정성 분석 합성가)입니다. 여러 건의 사용자 인터뷰 원천 데이터를 '인터뷰 분석' 5단계 파이프라인 중 ① 준비·정제와 ② 데이터 조직화·코딩 단계까지 수행합니다. 결과는 한국어로 씁니다.

참가자: ${codes.join(", ")} (${codes.length}명)
${options.goal ? `리서치 질문/분석 목표: ${options.goal}\n` : ""}${options.stage ? `제품 단계: ${options.stage} — ${STAGE_FOCUS[options.stage]}\n` : ""}코딩 방식: ${APPROACH_LABEL[options.approach]}
${options.apriori.length ? `가설 코드: ${options.apriori.join(", ")}\n` : ""}
① 준비·정제
- 참가자 매트릭스: 참가자마다 나이·직업·사용 기간·사용 맥락 등 세그먼트 변수를 전사에서 찾아 한 줄로. 전사에 없는 정보는 지어내지 않고 '전사에 정보 없음'.
- 다양성 검증: 표본이 한 세그먼트로 쏠렸으면 skewed=true 와 한계를 적습니다.
- 관찰과 해석 분리: 참가자가 실제로 한 말·행동(OBS)만 excerpts 로, 당신의 추론(INT)은 interpretations 로. 절대 섞지 않습니다.

② 코딩
- 한 발화 = 한 스티키노트(발췌). 두 개 이상의 아이디어를 하나로 묶지 않습니다. 긴 발화에 아이디어가 둘이면 같은 ref 로 발췌를 둘 만듭니다.
- 발췌의 quote 는 원문 그대로. 윤색·요약·맞춤법 수정 금지. [REDACTED] 는 가린 개인정보이니 그대로 둡니다.
- 참가자마다 고르게 뽑습니다(한 사람당 최소 5개, 의미 있는 발화는 빠짐없이). 모든 참가자가 최소 한 번은 나타나야 합니다. 첫 인터뷰의 인상으로 코드를 정해 놓고 나머지를 끼워 맞추지 않습니다(앵커링 주의).
- 코드는 의도·맥락 수준의 의미 단위로, 단순 키워드 일치가 아닙니다. 동일 의미의 다른 표현은 같은 코드로 묶습니다. 형용사 단독 코드("어려움") 금지 — "조작_복잡", "지연시간_불만"처럼 대상과 함께.
- 도메인(색상 묶음)은 전체 6개 이내.
- confidence 는 코드 적용의 확신도. 근거가 약하거나 해석의 여지가 크면 0.5 미만으로 두어 사람이 다시 보게 합니다.
- 모더레이터의 질문이 답을 유도했다면 bias_flags 에 적습니다.`;
  const parsed = await callOpenAI(env, { instructions, input: transcript, schema: CODING_SCHEMA, name: "coding", max: CODE_TOKENS });
  if (!parsed?.excerpts || !parsed?.codebook) throw new Error("코딩 답을 읽지 못함");
  return parsed;
}

// 모델이 낸 발췌를 원문과 대조한다: 없는 발화 번호는 버리고, 인용이 원문과 다르면 표시, 타임코드는 원문에서 붙인다
export function verifyCoding(parsed, material) {
  const str = (v, n = 500) => (typeof v === "string" ? v.trim().slice(0, n) : "");
  const arr = (v, n) => (Array.isArray(v) ? v.slice(0, n) : []);
  const num = (v, lo, hi, d) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : d);
  const lines = new Map();
  for (const p of material) for (const l of p.lines) lines.set(l.ref, { ...l, code: p.code });
  const squash = (s) => String(s).replace(/[\s"'“”‘’.,…!?~·\-]/g, "");

  const codebook = [];
  const seenCode = new Set();
  for (const c of arr(parsed.codebook, 60)) {
    const code = str(c.code, 40).replace(/\s+/g, "_");
    if (!code || seenCode.has(code)) continue;
    seenCode.add(code);
    codebook.push({ code, definition: str(c.definition, 300), domain: str(c.domain, 30) || "기타", polarity: ["긍정", "부정", "중립"].includes(c.polarity) ? c.polarity : "중립", origin: c.origin === "연역" ? "연역" : "귀납" });
  }
  // 도메인은 6개까지만 (넘치면 '기타'로)
  const domains = [...new Set(codebook.map((c) => c.domain))];
  if (domains.length > 6) { const keep = new Set(domains.slice(0, 5)); for (const c of codebook) if (!keep.has(c.domain)) c.domain = "기타"; }

  let dropped = 0, notVerbatim = 0, lowConfidence = 0;
  const excerpts = [];
  for (const [i, e] of arr(parsed.excerpts, 500).entries()) {
    const ref = str(e.ref, 20);
    const line = lines.get(ref);
    if (!line || line.role !== "participant") { dropped++; continue; }
    const quote = str(e.quote, 600) || line.text.slice(0, 300);
    const verbatim = squash(line.text).includes(squash(quote));
    if (!verbatim) notVerbatim++;
    const codes = [...new Set(arr(e.codes, 4).map((c) => str(c, 40).replace(/\s+/g, "_")).filter((c) => seenCode.has(c)))];
    const confidence = Math.round(num(e.confidence, 0, 1, 0.5) * 100) / 100;
    if (confidence < 0.5) lowConfidence++;
    excerpts.push({
      id: `E${i + 1}`, ref, participant: line.code, timecode: line.tc || "", quote, verbatim, codes,
      polarity: Math.round(num(e.polarity, -1, 1, 0) * 100) / 100, evidence: e.evidence === "행동" ? "행동" : "의견", confidence,
    });
  }
  // 모델이 준 id 와 상관없이 순서대로 다시 매긴다 (중복 방지)
  excerpts.forEach((e, i) => (e.id = `E${i + 1}`));

  for (const c of codebook) {
    const used = excerpts.filter((e) => e.codes.includes(c.code));
    c.count = used.length;
    c.participants = [...new Set(used.map((e) => e.participant))];
  }
  const participantsSeen = new Set(excerpts.map((e) => e.participant));
  const byCode = new Map(arr(parsed.participants, 40).map((p) => [str(p.code, 10), p]));
  const participants = material.map((p) => {
    const m = byCode.get(p.code) || {};
    return {
      code: p.code, label: p.label || "", profile: str(m.profile, 200) || "전사에 정보 없음", context: str(m.context, 200),
      familiarity: ["High", "Med", "Low"].includes(m.familiarity) ? m.familiarity : "알 수 없음",
      utterances: p.lines.filter((l) => l.role === "participant").length, excerpts: excerpts.filter((e) => e.participant === p.code).length,
    };
  });
  return {
    participants,
    diversity: { skewed: !!parsed.diversity?.skewed, note: str(parsed.diversity?.note, 400) },
    codebook: codebook.sort((a, b) => b.participants.length - a.participants.length || b.count - a.count),
    excerpts,
    interpretations: arr(parsed.interpretations, 30).map((x) => ({ text: str(x.text, 300), kind: x.kind === "작업가설" ? "작업가설" : "해석", refs: arr(x.refs, 8).map((r) => str(r, 20)).filter((r) => lines.has(r)) })).filter((x) => x.text),
    bias_flags: arr(parsed.bias_flags, 10).map((x) => str(x, 300)).filter(Boolean),
    check: { excerpts: excerpts.length, dropped_refs: dropped, not_verbatim: notVerbatim, low_confidence: lowConfidence, missing_participants: material.map((p) => p.code).filter((c) => !participantsSeen.has(c)) },
  };
}

// ── ③④⑤ 합성 ──
const SYNTH_SCHEMA = obj({
  themes: A(obj({
    id: S("T1, T2, …"),
    title: S("주장형 테마명: '사용자는 X 상황에서 Y 한다' / '사용자는 ~할 때 ~를 원한다'. 형용사 단독 금지"),
    summary: S("테마 요지 1~2문장"),
    codes: A(S(), "이 테마로 묶인 코드"),
    excerpt_ids: A(S(), "근거 발췌 id (E#)"),
    subclusters: A(obj({
      label: S("서브클러스터 라벨 (동사형)"),
      axis: E(["일반↔구체", "인지↔정서", "기대↔실제", "세그먼트", "기타"], "쪼갠 축"),
      excerpt_ids: A(S()),
    }), "큰 클러스터를 나눈 하위 단위. 나눌 필요 없으면 1개"),
    relations: S("다른 테마와의 공통점·인과·모순 한 문장. 없으면 빈 문자열"),
  }), "③ 어피니티: 한 번에 한 테마씩 묶은 상위 테마 3~6개. 단일 참가자 발췌만 있는 묶음은 테마로 올리지 말고 outliers 로"),
  contradictions: A(obj({
    title: S("모순 한 줄"),
    description: S("무엇과 무엇이 어긋나는지 (참가자 간 또는 한 참가자 안에서)"),
    excerpt_ids: A(S()),
    interpretation: S("조건부 인사이트 가능성 — 어떤 조건에서 가치가 갈리는지"),
    follow_up: S("후속 질문 또는 검증 방법"),
  }), "모순은 결함이 아니라 삼각측량의 출발점"),
  outliers: A(obj({
    excerpt_id: S(),
    why: S("왜 어느 테마에도 붙지 않는지, 약 신호인지 세그먼트 차이인지"),
    verify: S("교차검증 방법"),
  }), "약 신호·이상치. 버리지 않고 보관"),
  insights: A(obj({
    id: S("INS-01, INS-02, …"),
    theme_id: S("근거 테마 id"),
    statement: S("작성 공식 그대로 한 문장: '[관찰된 패턴] 때문에 [사용자]는 [맥락]에서 [결과/감정]한다. 따라서 [권고]가 필요하다.'"),
    pattern: S("관찰된 패턴"),
    user: S("영향받는 사용자"),
    context: S("맥락"),
    outcome: S("결과/감정"),
    recommendation: S("So-what: 무엇을 하라는 것인지 한 줄"),
    excerpt_ids: A(S(), "근거 발췌 id"),
    confidence: N("확신도 0~1. N=1 근거면 0.5 미만"),
    priority: E(["High", "Med", "Low"]),
    segments: A(S(), "영향받는 세그먼트"),
    next: A(E(NEXT), "이 인사이트가 흘러갈 다음 산출물"),
  }), "④ 테마를 So-what 까지 끌고 간 인사이트 카드"),
  tldr: A(obj({
    theme: S("테마명(짧게)"),
    finding: S("발견 한 줄. '6/8 참가자가 X 상황에서 …' 처럼 정량·증거 결합"),
    action: S("권장 행동 한 줄"),
    clip: S("대표 증거 발췌 id (E#)"),
  }), "90초 TL;DR 3~5개"),
  triangulation: A(obj({
    insight_id: S(),
    source: S("1차 교차 소스 (설문, 세션 리플레이·히트맵, 퍼널·코호트, 피드백 위젯·NPS, 행동 세그먼트, 앱 로그·텔레메트리 등)"),
    question: S("검증 질문"),
    method: S("일치 여부 확인법"),
  }), "⑤ 교차 검증 계획 (정량 데이터가 없으므로 제안만)"),
  backlog: A(S(), "후속 리서치 백로그 (모순 항목 우선)"),
  limits: A(S(), "이 분석의 한계"),
  pm_summary: S("PM용 한 문단 요약"),
});

async function askSynthesis(env, { coding, options }) {
  const total = coding.participants.length;
  const input = JSON.stringify({
    participants: coding.participants.map((p) => ({ code: p.code, profile: p.profile, context: p.context, familiarity: p.familiarity })),
    diversity: coding.diversity,
    codebook: coding.codebook.map((c) => ({ code: c.code, definition: c.definition, polarity: c.polarity, participants: c.participants })),
    excerpts: coding.excerpts.map((e) => ({ id: e.id, p: e.participant, tc: e.timecode, quote: e.quote, codes: e.codes, polarity: e.polarity, evidence: e.evidence, confidence: e.confidence })),
    interpretations: coding.interpretations,
  });
  const instructions = `당신은 숙련된 UX 리서처(AI 정성 분석 합성가 · 어피니티 다이어그래머)입니다. 인터뷰 분석 5단계 중 ①②가 끝난 코딩 결과(JSON)를 받아 ③ 패턴·테마 도출, ④ 합성·전달, ⑤ 교차 검증 계획을 수행합니다. 결과는 한국어로 씁니다.

전체 참가자: ${total}명
${options.goal ? `리서치 질문/분석 목표: ${options.goal}\n` : ""}${options.stage ? `제품 단계: ${options.stage} — ${STAGE_FOCUS[options.stage]}\n` : ""}
③ 패턴·테마 (어피니티)
- 코딩된 발췌를 의미가 가까운 것끼리 군집합니다. 한 번에 한 테마만 다룹니다. 키워드 일치가 아니라 의도·맥락 수준의 일치로.
- 테마명은 주장형 문장("사용자는 X 상황에서 Y 한다"). "어렵다" 같은 형용사 단독 금지.
- 큰 테마는 서브클러스터로 쪼갭니다(일반↔구체, 인지↔정서, 기대↔실제, 세그먼트).
- 공통점·모순·예외를 모두 드러냅니다. 참가자 간 또는 한 참가자 안의 모순은 contradictions 로.
- 2명 이상이 근거가 되지 않는 묶음은 테마로 올리지 말고 outliers(약 신호)로 둡니다. 단일 응답을 일반화하지 않습니다.

④ 합성
- 인사이트는 작성 공식을 따릅니다: [관찰된 패턴] 때문에 [사용자]는 [맥락]에서 [결과/감정]한다. 따라서 [권고]가 필요하다.
- 모든 인사이트에 So-what(권고)·우선순위·확신도·근거 발췌를 붙입니다. N=1 근거는 확신도 0.5 미만.
- '때문에'는 참가자가 실제로 그렇게 말했거나 발췌가 직접 보여 줄 때만. 체리피킹하지 말고 반례도 함께 봅니다.
- TL;DR 은 3~5개, "n/${total} 참가자가 …"처럼 수와 증거를 결합합니다.

⑤ 교차 검증
- 정량 데이터는 없습니다. 인사이트마다 검증에 쓸 정량 소스와 확인법을 제안만 합니다. 실측 결과처럼 쓰지 않습니다.
- 말한 것과 실제 행동이 어긋날 수 있는 지점(자기 보고 편향)을 짚습니다.

규칙: 발췌 id 는 입력에 있는 것만 씁니다. 입력에 없는 사실을 지어내지 않습니다.`;
  const parsed = await callOpenAI(env, { instructions, input, schema: SYNTH_SCHEMA, name: "synthesis", max: SYNTH_TOKENS });
  if (!parsed?.themes || !parsed?.insights) throw new Error("합성 답을 읽지 못함");
  return parsed;
}

// 테마 신뢰도 지표는 발췌로 직접 계산하고(스킬 4.2-(3)), 품질 게이트(5.3)를 점검한다
export function finishSynthesis(parsed, coding) {
  const str = (v, n = 500) => (typeof v === "string" ? v.trim().slice(0, n) : "");
  const arr = (v, n) => (Array.isArray(v) ? v.slice(0, n) : []);
  const ex = new Map(coding.excerpts.map((e) => [e.id, e]));
  const total = coding.participants.length || 1;
  const ids = (v) => [...new Set(arr(v, 80).map((x) => str(x, 10)).filter((x) => ex.has(x)))];
  const round = (x) => Math.round(x * 100) / 100;

  const metrics = (excerptIds) => {
    const list = excerptIds.map((i) => ex.get(i));
    const ps = [...new Set(list.map((e) => e.participant))];
    const support = ps.length / total;
    const emotion = list.length ? list.reduce((s, e) => s + e.polarity, 0) / list.length : 0;
    const behavior = list.length ? list.filter((e) => e.evidence === "행동").length / list.length : 0;
    const strength = ps.length >= 3 && support >= 0.5 ? "strong" : ps.length >= 2 ? "candidate" : "weak";
    return { participants: ps, support: round(support), interviews: ps.length, emotion: round(emotion), behavior: round(behavior), actionable: behavior >= 0.4, strength };
  };

  const themes = arr(parsed.themes, 8).map((t, i) => {
    let excerptIds = ids(t.excerpt_ids);
    const subclusters = arr(t.subclusters, 6).map((s) => ({ label: str(s.label, 120), axis: str(s.axis, 20), excerpt_ids: ids(s.excerpt_ids) })).filter((s) => s.label);
    excerptIds = [...new Set([...excerptIds, ...subclusters.flatMap((s) => s.excerpt_ids)])];
    return { id: `T${i + 1}`, model_id: str(t.id, 10), title: str(t.title, 200), summary: str(t.summary, 400), codes: arr(t.codes, 20).map((c) => str(c, 40)), excerpt_ids: excerptIds, subclusters, relations: str(t.relations, 300), ...metrics(excerptIds) };
  }).filter((t) => t.title && t.excerpt_ids.length);
  const themeId = new Map(themes.map((t) => [t.model_id, t.id]));

  const insights = arr(parsed.insights, 12).map((s, i) => {
    const excerptIds = ids(s.excerpt_ids);
    const m = metrics(excerptIds);
    let confidence = Number.isFinite(Number(s.confidence)) ? Math.min(1, Math.max(0, Number(s.confidence))) : 0.5;
    // N=1 근거는 확신도 Low 를 넘지 못한다 (과잉 일반화 방지)
    if (m.interviews <= 1) confidence = Math.min(confidence, 0.45);
    return {
      id: `INS-${String(i + 1).padStart(2, "0")}`, theme_id: themeId.get(str(s.theme_id, 10)) || "",
      statement: str(s.statement, 500), pattern: str(s.pattern, 200), user: str(s.user, 120), context: str(s.context, 200), outcome: str(s.outcome, 200),
      recommendation: str(s.recommendation, 300), excerpt_ids: excerptIds, confidence: round(confidence),
      level: confidence >= 0.75 ? "High" : confidence >= 0.5 ? "Med" : "Low",
      priority: ["High", "Med", "Low"].includes(s.priority) ? s.priority : "Med",
      segments: arr(s.segments, 6).map((x) => str(x, 60)), next: arr(s.next, 6).filter((x) => NEXT.includes(x)),
      status: "synthesized", support: m.support, interviews: m.interviews,
    };
  }).filter((s) => s.statement);
  const insightIds = new Set(insights.map((s) => s.id));
  const modelInsight = new Map(arr(parsed.insights, 12).map((s, i) => [str(s.id, 10), `INS-${String(i + 1).padStart(2, "0")}`]));

  const outliers = arr(parsed.outliers, 20).map((o) => ({ excerpt_id: str(o.excerpt_id, 10), why: str(o.why, 300), verify: str(o.verify, 300) })).filter((o) => ex.has(o.excerpt_id));
  const triangulation = arr(parsed.triangulation, 20).map((t) => ({ insight_id: modelInsight.get(str(t.insight_id, 10)) || str(t.insight_id, 10), source: str(t.source, 120), question: str(t.question, 300), method: str(t.method, 300) })).filter((t) => t.source);

  // 품질 게이트 (5.3)
  const ex2 = coding.excerpts;
  const gates = [
    { step: "①", label: "모든 노트가 관찰(OBS)/해석(INT)으로 분리됨", pass: true, note: `발췌(OBS) ${ex2.length}개 · 해석(INT) ${coding.interpretations.length}개` },
    { step: "②", label: "모든 코드에 인용·참가자·타임코드·confidence 부착", pass: ex2.every((e) => e.quote && e.verbatim && e.participant && e.timecode && e.codes.length), note: [ex2.some((e) => !e.timecode) && "타임코드 없는 발췌 있음 (원문에 타임코드가 없으면 발화 번호로 역추적)", ex2.some((e) => !e.codes.length) && "코드 없는 발췌 있음", ex2.some((e) => !e.verbatim) && `원문과 다른 인용 ${ex2.filter((e) => !e.verbatim).length}개`].filter(Boolean).join(" · ") || "통과" },
    { step: "③", label: "모든 테마가 2명 이상 근거 또는 약 신호로 명시", pass: themes.every((t) => t.interviews >= 2), note: themes.filter((t) => t.interviews < 2).map((t) => `${t.id} 근거 1명`).join(", ") || "통과" },
    { step: "④", label: "모든 인사이트에 권고(So-what)·우선순위 포함", pass: insights.length > 0 && insights.every((s) => s.recommendation && s.priority), note: insights.length ? "통과" : "인사이트 없음" },
    { step: "⑤", label: "High 우선순위 인사이트는 정량 소스 1개 이상으로 검증", pass: false, note: `정량 데이터 대조 전 — 검증 계획 ${triangulation.length}건 제안. 확인되면 triangulated 로 격상` },
  ];

  return {
    themes: themes.map(({ model_id, ...t }) => t),
    contradictions: arr(parsed.contradictions, 10).map((c) => ({ title: str(c.title, 200), description: str(c.description, 400), excerpt_ids: ids(c.excerpt_ids), interpretation: str(c.interpretation, 300), follow_up: str(c.follow_up, 300) })).filter((c) => c.title),
    outliers,
    insights,
    tldr: arr(parsed.tldr, 5).map((t) => ({ theme: str(t.theme, 100), finding: str(t.finding, 300), action: str(t.action, 300), clip: ex.has(str(t.clip, 10)) ? str(t.clip, 10) : "" })).filter((t) => t.finding),
    triangulation: triangulation.map((t) => (insightIds.has(t.insight_id) ? t : { ...t, insight_id: "" })),
    backlog: arr(parsed.backlog, 10).map((x) => str(x, 300)).filter(Boolean),
    limits: arr(parsed.limits, 8).map((x) => str(x, 300)).filter(Boolean),
    pm_summary: str(parsed.pm_summary, 1200),
    gates,
  };
}
