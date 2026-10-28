// 페르소나와 채팅 (벡터 검색 + RAG)
//   GET  /api/personas/:id/chat     색인 상태 { indexed_at, counts, ready }
//   POST /api/personas/:id/index    이 페르소나가 나온 분석 묶음의 '근거 노트'를 임베딩해 rag_chunks 에 저장 (이미 있으면 다시 만든다)
//   POST /api/personas/:id/chat     { messages: [{ role, content }] } → 마지막 질문으로 검색 → 페르소나 말투로 답 → { reply, cited, retrieved }
//
// 벡터 저장소: rag_chunks (D1). 임베딩은 OpenAI text-embedding-3-small(1536차원), 검색은 Worker 안에서 코사인 유사도.
//   한 분석 묶음의 조각은 많아야 천 몇백 개라 전부 읽어 계산해도 수십 ms 다. Vectorize 로 옮길 때는 search() 만 바꾸면 된다.
// 근거 노트 종류와 ID
//   N### 어피니티 노트(한 장에 한 사실, 참가자 코드·발화 번호 포함) · T## 테마 통찰 문장 · U### 참가자 원 발화(마스킹 후) · D## 같은 묶음의 페르소나 문서 요약
// 시스템 프롬프트 규칙 (요청 그대로)
//   - 너는 아래 페르소나 인물이다. 말투는 lifestyle·personality에 맞춘다.
//   - '근거 노트'에 있는 내용을 바탕으로 답한다.
//   - 근거가 있는 경우 답변 끝에 사용한 노트 ID를 [N012] 형식으로 표기한다.
//   - 근거 기반으로 추론해서 추가로 생성된 경우 [추론 높음/중간/낮음] 형식으로 표기한다.

import { materialOf } from "./debrief.js";

const EMBED_DIMS = 1536;
const EMBED_BATCH = 96;
const MAX_CHUNKS = 1500;
const TOP_K = 10;
const MIN_SCORE = 0.18;
const HISTORY_TURNS = 12;
const MAX_QUESTION_CHARS = 2000;
const REPLY_TOKENS = 1200;

export async function personaChat(request, env, json, user, row, action, opts = {}) {
  const method = request.method;
  const a = row.analysis_id ? await env.DB.prepare("SELECT * FROM persona_analyses WHERE id = ? AND user_id = ?").bind(row.analysis_id, user.id).first() : null;
  const isSample = user.id === "sample";

  if (action === "chat" && method === "GET") return json({ ...(await status(env, a)), persona: brief(row), isSample, autoIndex: isSample });

  if (action === "index" && method === "POST") {
    if (!a) return json({ error: "이 페르소나는 인터뷰 분석 묶음이 없어 근거 노트를 만들 수 없어요.", code: "no_analysis" }, 409);
    if (!env.OPENAI_API_KEY) return json({ error: "AI를 부르지 못했어요. 잠시 후 다시 시도해 주세요." }, 502);
    try {
      const r = await indexAnalysis(env, user, a);
      return json({ ok: true, ...r });
    } catch (err) {
      console.error("persona index failed", String(err?.message || err));
      return json({ error: "근거 노트를 색인하지 못했어요. 잠시 후 다시 시도해 주세요." }, 502);
    }
  }

  if (action === "chat" && method === "POST") {
    if (!a) return json({ error: "이 페르소나는 인터뷰 분석 묶음이 없어 대화할 수 없어요.", code: "no_analysis" }, 409);
    if (!a.indexed_at && opts.autoIndex && env.OPENAI_API_KEY) {
      // 샘플: 첫 질문 때 한 번만 색인한다
      try { await indexAnalysis(env, user, a); a.indexed_at = Math.floor(Date.now() / 1000); }
      catch (err) { console.error("sample auto index failed", String(err?.message || err)); return json({ error: "근거 노트를 준비하지 못했어요. 잠시 후 다시 시도해 주세요." }, 502); }
    }
    if (!a.indexed_at) return json({ error: "먼저 근거 노트를 색인해 주세요.", code: "not_indexed" }, 409);
    let body;
    try { body = await request.json(); } catch { return json({ error: "JSON 본문이 필요해요." }, 400); }
    const history = (Array.isArray(body.messages) ? body.messages : [])
      .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
      .map((m) => ({ role: m.role, content: m.content.trim().slice(0, MAX_QUESTION_CHARS) }))
      .slice(-HISTORY_TURNS);
    const last = history[history.length - 1];
    if (!last || last.role !== "user") return json({ error: "질문이 비어 있어요." }, 400);
    if (!env.OPENAI_API_KEY) return json({ error: "AI를 부르지 못했어요. 잠시 후 다시 시도해 주세요." }, 502);

    const started = Date.now();
    let retrieved, reply;
    try {
      const [qvec] = await embedAll(env, [last.content]);
      retrieved = await search(env, a, qvec, personaBoost(row, a));
      reply = await answer(env, row, a, retrieved, history);
    } catch (err) {
      console.error("persona chat failed", String(err?.message || err));
      return json({ error: "답을 만들지 못했어요. 잠시 후 다시 시도해 주세요." }, 502);
    }
    const citedIds = [...new Set([...reply.matchAll(/\[([NTUD]\d{2,3})\]/g)].map((m) => m[1]))];
    const byRef = new Map(retrieved.map((c) => [c.ref_id, c]));
    const missing = citedIds.filter((id) => !byRef.has(id));
    if (missing.length) {
      const { results } = await env.DB.prepare(`SELECT kind, ref_id, code, source_ref, text FROM rag_chunks WHERE analysis_id = ? AND ref_id IN (${missing.map(() => "?").join(",")})`).bind(a.id, ...missing).all();
      for (const r of results) byRef.set(r.ref_id, { ...r, score: null });
    }
    const inference = [...reply.matchAll(/\[추론\s*(높음|중간|낮음|낮은)\]/g)].map((m) => m[1].replace("낮은", "낮음"));
    return json({
      reply,
      cited: citedIds.filter((id) => byRef.has(id)).map((id) => pick(byRef.get(id))),
      retrieved: retrieved.map(pick),
      inference,
      ms: Date.now() - started,
    });
  }

  return json({ error: "없는 경로예요." }, 404);
}

function pick(c) { return { ref_id: c.ref_id, kind: c.kind, code: c.code, source_ref: c.source_ref, text: c.text, score: c.score == null ? null : Math.round(c.score * 1000) / 1000 }; }
function brief(row) { return { id: row.id, name: row.name, job: row.job, age: row.age, priority: row.priority, tagline: row.tagline, photoUrl: row.photo_url }; }

async function status(env, a) {
  if (!a) return { ready: false, reason: "no_analysis", indexed_at: null, counts: null };
  const meta = a.index_meta ? JSON.parse(a.index_meta) : null;
  return { ready: !!a.indexed_at, reason: a.indexed_at ? null : "not_indexed", indexed_at: a.indexed_at, counts: meta?.counts || null, total: meta?.total || 0, model: meta?.model || null, analysis_id: a.id, service: a.service };
}

// 분석 묶음 하나를 임베딩해 rag_chunks 에 넣는다 (이전 색인은 지운다)
export async function indexAnalysis(env, user, a) {
  const started = Date.now();
  const chunks = await buildChunks(env, user, a);
  const vectors = await embedAll(env, chunks.map((c) => c.text));
  chunks.forEach((c, i) => (c.embedding = vectors[i]));
  const now = Math.floor(Date.now() / 1000);
  const counts = {};
  for (const c of chunks) counts[c.kind] = (counts[c.kind] || 0) + 1;
  const meta = { model: embedModel(env), dims: EMBED_DIMS, total: chunks.length, counts, ms: Date.now() - started };
  await env.DB.prepare("DELETE FROM rag_chunks WHERE analysis_id = ?").bind(a.id).run();
  const ins = env.DB.prepare("INSERT INTO rag_chunks (id, analysis_id, user_id, kind, ref_id, code, source_ref, text, embedding, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  for (let i = 0; i < chunks.length; i += 50) {
    await env.DB.batch(chunks.slice(i, i + 50).map((c) => ins.bind(crypto.randomUUID(), a.id, user.id, c.kind, c.ref_id, c.code || null, c.source_ref || null, c.text, toBlob(c.embedding), now)));
  }
  await env.DB.prepare("UPDATE persona_analyses SET indexed_at = ?, index_meta = ? WHERE id = ?").bind(now, JSON.stringify(meta), a.id).run();
  return { indexed_at: now, counts, total: chunks.length, ms: meta.ms };
}

// ── 근거 노트 만들기 ──
const pad = (n, w) => String(n).padStart(w, "0");
async function buildChunks(env, user, a) {
  const analysis = JSON.parse(a.analysis || "{}");
  const sources = JSON.parse(a.sources || "[]");
  const chunks = [];

  // N### 어피니티 노트
  (analysis.notes || []).forEach((n, i) => {
    const num = parseInt(String(n.id || "").replace(/\D/g, ""), 10);
    const ref_id = `N${pad(Number.isFinite(num) && num > 0 ? num : i + 1, 3)}`;
    if (chunks.some((c) => c.ref_id === ref_id)) return;
    chunks.push({ kind: "note", ref_id, code: n.code, source_ref: n.ref, text: `${n.code ? `[${n.code}${n.ref ? ` ${n.ref}` : ""}] ` : ""}${n.text}` });
  });
  // T## 테마 통찰
  (analysis.themes || []).forEach((t, i) => {
    const groups = (t.groups || []).map((g) => g.label).filter(Boolean).join(" / ");
    const quotes = (t.groups || []).flatMap((g) => g.quotes || []).slice(0, 4).map((q) => `"${q.text}"(${q.ref})`).join(" ");
    chunks.push({ kind: "theme", ref_id: `T${pad(i + 1, 2)}`, code: null, source_ref: null, text: `${t.title}: ${t.insight} (노트 ${t.note_count}장, 참가자 ${t.participant_count}명${t.codes?.length ? `: ${t.codes.join(", ")}` : ""})${groups ? ` · 군집: ${groups}` : ""}${quotes ? ` · 인용: ${quotes}` : ""}` });
  });
  // D## 같은 묶음의 페르소나 문서 요약
  const { results: ps } = await env.DB.prepare("SELECT name, priority, tagline, job, age, lifestyle, painpoints, needs, quote FROM personas WHERE analysis_id = ? ORDER BY priority, created_at").bind(a.id).all();
  ps.forEach((p, i) => {
    const pains = JSON.parse(p.painpoints || "[]").map((x) => x.title).join(", ");
    const needs = JSON.parse(p.needs || "[]").map((x) => x.title).join(", ");
    chunks.push({ kind: "persona", ref_id: `D${pad(i + 1, 2)}`, code: null, source_ref: null, text: `페르소나 ${p.name}(${p.priority}, ${p.job}, ${p.age}세): ${p.tagline.replace(/\*\*/g, "")} · 페인포인트: ${pains} · 니즈: ${needs} · 인용: ${p.quote.replace(/\*\*/g, "")} · Lifestyle: ${p.lifestyle.slice(0, 500)}` });
  });
  // U### 참가자 원 발화 (완료 참가자, 분석 제외 빼고, 마스킹)
  const bySession = new Map();
  for (const s of sources) { if (!bySession.has(s.session_id)) bySession.set(s.session_id, []); bySession.get(s.session_id).push(s.interview_id); }
  let u = 0;
  for (const [sessionId, ids] of bySession) {
    const session = await env.DB.prepare("SELECT id, name FROM interview_sessions WHERE id = ? AND user_id = ?").bind(sessionId, user.id).first();
    if (!session) continue;
    const material = await materialOf(env, session, ids);
    for (const p of material.participants) {
      for (const line of p.lines) {
        if (line.role !== "participant" || line.text.replace(/\s+/g, "").length < 8) continue;
        if (chunks.length >= MAX_CHUNKS) break;
        chunks.push({ kind: "utterance", ref_id: `U${pad(++u, 3)}`, code: p.code, source_ref: line.ref, text: `[${line.ref}] ${p.code}: ${line.text}` });
      }
    }
  }
  if (!chunks.length) throw new Error("색인할 노트가 없음");
  return chunks.slice(0, MAX_CHUNKS);
}

// ── 임베딩 ──
const embedModel = (env) => env.OPENAI_EMBED_MODEL || "text-embedding-3-small";
export async function embedAll(env, texts) {
  const out = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const batch = texts.slice(i, i + EMBED_BATCH).map((t) => t.slice(0, 4000));
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.OPENAI_API_KEY}` },
      body: JSON.stringify({ model: embedModel(env), input: batch, dimensions: EMBED_DIMS }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`OpenAI embeddings ${res.status}: ${data?.error?.message || ""}`);
    const sorted = (data.data || []).sort((x, y) => x.index - y.index);
    if (sorted.length !== batch.length) throw new Error("임베딩 수가 맞지 않음");
    for (const d of sorted) out.push(Float32Array.from(d.embedding));
  }
  return out;
}
function toBlob(vec) { return vec.buffer.slice(vec.byteOffset, vec.byteOffset + vec.byteLength); }
function fromBlob(b) {
  const buf = b instanceof ArrayBuffer ? b : ArrayBuffer.isView(b) ? b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) : Uint8Array.from(b || []).buffer;
  return new Float32Array(buf);
}

// ── 검색 (코사인) ──
function personaBoost(row, a) {
  // 이 페르소나의 바탕 세그먼트에 가까운 참가자 발화·노트를 조금 더 올린다
  try {
    const ev = row.evidence ? JSON.parse(row.evidence) : null;
    const seg = (JSON.parse(a.analysis || "{}").segments || []).find((s) => s.name === ev?.segment);
    return { codes: new Set(seg?.codes || []), personaName: row.name };
  } catch { return { codes: new Set(), personaName: row.name }; }
}
export async function search(env, a, qvec, boost) {
  const { results } = await env.DB.prepare("SELECT kind, ref_id, code, source_ref, text, embedding FROM rag_chunks WHERE analysis_id = ?").bind(a.id).all();
  const qn = norm(qvec);
  const scored = results.map((r) => {
    const v = fromBlob(r.embedding);
    let s = dot(qvec, v) / (qn * norm(v) || 1);
    if (r.code && boost.codes.has(r.code)) s += 0.04;
    if (r.kind === "persona" && r.text.startsWith(`페르소나 ${boost.personaName}(`)) s += 0.04;
    return { kind: r.kind, ref_id: r.ref_id, code: r.code, source_ref: r.source_ref, text: r.text, score: s };
  }).sort((x, y) => y.score - x.score);
  const top = scored.slice(0, TOP_K).filter((c) => c.score >= MIN_SCORE);
  return top.length ? top : scored.slice(0, 4); // 아무것도 안 걸리면 가장 가까운 몇 개라도 준다
}
function dot(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }
function norm(a) { return Math.sqrt(dot(a, a)); }

// ── 답변 ──
async function answer(env, row, a, retrieved, history) {
  const notes = retrieved.map((c) => `[${c.ref_id}] ${c.text}`).join("\n");
  const hobbies = JSON.parse(row.hobbies || "[]").join(", ");
  const pains = JSON.parse(row.painpoints || "[]").map((x) => `- ${x.title}: ${x.description}`).join("\n");
  const needs = JSON.parse(row.needs || "[]").map((x) => `- ${x.title}: ${x.description}`).join("\n");
  const instructions = `너는 아래 페르소나 인물이다. 말투는 lifestyle·personality에 맞춘다.
'근거 노트'에 있는 내용을 바탕으로 답한다.
근거가 있는 경우 답변 끝에 사용한 노트 ID를 [N012] 형식으로 표기한다.
근거 기반으로 추론해서 추가로 생성된 경우 [추론 높음/중간/낮음] 형식으로 표기한다.

## 페르소나
이름: ${row.name} · ${row.gender} · ${row.age}세 · ${row.job} · 취미: ${hobbies}
한 줄: ${row.tagline.replace(/\*\*/g, "")}
서비스 이용 환경: ${row.environment}
성격: ${row.personality}
이용 동기: ${row.motivation}
Lifestyle: ${row.lifestyle}
Painpoint:
${pains}
Needs:
${needs}
인용: ${row.quote.replace(/\*\*/g, "")}

## 근거 노트 (서비스 "${a.service}"에 대한 실제 사용자 인터뷰에서 나온 것. N=관찰 노트, T=테마 통찰, U=참가자 원 발화, D=페르소나 문서)
${notes}

## 대화 규칙
- 리서처가 너(페르소나)를 인터뷰하는 상황이다. 1인칭으로, 실제 사람처럼 자연스럽게 답한다. 역할을 벗어나 AI임을 밝히거나 메타 설명을 하지 않는다.
- 근거 노트에 있는 경험·행동·불만·바람은 네 경험으로 말한다. 노트의 다른 참가자(P02 등) 경험도 네 세그먼트의 경험이면 네 것처럼 말할 수 있다.
- 근거 노트에 없는 것을 물으면, 페르소나의 성격·동기에서 자연스럽게 추론해 짧게 답하되 반드시 [추론 높음/중간/낮음] 중 하나를 붙인다. 근거와 거리가 멀수록 낮음.
- 전혀 답할 수 없는 사실(정확한 숫자·고유명사 등)은 지어내지 말고 "잘 모르겠다"고 페르소나답게 말한다. [REDACTED]는 가려진 개인정보이니 추측하지 않는다.
- 답은 보통 3~6문장. 마지막 줄에 사용한 노트 ID를 [N012] [U003] 처럼 모아 쓴다. 근거 없이 추론만 했다면 노트 ID 없이 [추론 …]만 쓴다.`;
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: env.OPENAI_MODEL, instructions,
      input: history.map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content })),
      reasoning: { effort: "low" }, max_output_tokens: REPLY_TOKENS, store: false,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${data?.error?.message || ""}`);
  const text = (data.output || []).filter((x) => x.type === "message").flatMap((x) => x.content || []).filter((c) => c.type === "output_text").map((c) => c.text).join("").trim();
  if (!text) throw new Error("빈 답");
  return text;
}
