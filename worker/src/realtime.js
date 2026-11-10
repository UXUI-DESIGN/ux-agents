// AI 인터뷰 모더레이터 — 실시간 음성 대화 (OpenAI Realtime API, WebRTC)
//   브라우저가 OpenAI와 직접 음성을 주고받는다. OpenAI 키는 내보내지 않고, 잠깐만 쓸 수 있는 임시 키만 내준다.
//   지침(가이드·진행 규칙)은 임시 키를 만들 때 여기서 붙인다. 글 대화와 같은 지침(moderator.js)에 음성 규칙만 더한다.
//   음성은 저장하지 않는다. 받아쓴 글만 글 대화와 같은 표(interview_messages, mode='voice')에 남긴다.
//     POST /api/p/:token/interviews/me/realtime-session   임시 키 발급 → { clientSecret, opening, stage, … }
//     POST /api/p/:token/interviews/me/realtime-log       { role, text, excluded? }  받아쓴 발화 저장
//                                                         { tool: set_stage|finish|exclude, … }  모더레이터가 알린 진행 상황
//                                                         { ping: true }  남은 시간·안내만 확인
import { rateLimit } from "./auth.js";
import {
  stagesOf, timing, resume, topicOf, rewardOf, moderatorInstructions, stateNote, timeNotice,
  ENDED_STATUSES, EXCLUDED_NOTE, RECORD_FAILED, MAX_PARTICIPANT_TURNS,
} from "./moderator.js";

const VOICE_GRACE_SEC = 5 * 60;   // 세션 시간이 지나고 이만큼 더 지나면 음성 연결을 새로 내주지 않는다
const VOICE_HISTORY = 40;         // 다시 연결할 때 지침에 붙이는 최근 발화 수
const VOICE_TEXT_CHARS = 4000;    // 받아쓴 발화 한 건의 최대 길이
const VOICE_FAILED = { error: "음성 연결을 준비하지 못했어요. 글로 대화를 이어 가거나 잠시 후 다시 시도해 주세요.", code: "voice_failed" };

// 말로 하는 대화와 별개로, 모더레이터가 진행 상황을 알리는 도구 (글 대화의 stage·end·exclude 와 같은 뜻)
const VOICE_TOOLS = [
  {
    type: "function", name: "set_stage",
    description: "다음 단계로 넘어갈 때, 그 단계의 첫 질문을 말하기 전에 호출합니다.",
    parameters: { type: "object", properties: { stage: { type: "integer", description: "넘어가는 단계 번호 (0=워밍업)" } }, required: ["stage"] },
  },
  {
    type: "function", name: "finish_interview",
    description: "마무리 인사를 끝까지 말한 뒤에 호출해 인터뷰를 마칩니다.",
    parameters: { type: "object", properties: { reason: { type: "string", enum: ["completed", "stopped"], description: "completed=클로징까지 마침, stopped=참가자가 중간에 그만둠" } }, required: ["reason"] },
  },
  {
    type: "function", name: "exclude_from_record",
    description: "참가자가 방금 한 이야기를 기록·분석에서 빼 달라고 할 때만 호출합니다.",
    parameters: { type: "object", properties: { scope: { type: "string", enum: ["this", "previous"], description: "this=빼 달라는 내용이 이번 발화 안에 있음, previous=바로 앞 발화 내용" } }, required: ["scope"] },
  },
];

export async function realtime(request, env, json, session, interview, action) {
  if (request.method !== "POST") return json({ error: "없는 경로예요." }, 404);
  if (ENDED_STATUSES.includes(interview.status)) return json({ error: "이 인터뷰는 이미 마쳤어요.", code: interview.status }, 409);
  const now = Math.floor(Date.now() / 1000);
  const snapshot = JSON.parse(session.guide_snapshot);
  const stages = stagesOf(snapshot);
  return action === "realtime-session"
    ? openSession(request, env, json, session, interview, snapshot, stages, now)
    : record(request, env, json, session, interview, stages, now);
}

// ── 임시 키 발급 ──
async function openSession(request, env, json, session, interview, snapshot, stages, now) {
  if (!env.OPENAI_API_KEY || !env.OPENAI_REALTIME_MODEL) return json(VOICE_FAILED, 502);
  const limited = await rateLimit(request, env, json, "voice", "음성 연결", now);
  if (limited) return limited;

  // 쉬는 중에 음성을 켜면 자동으로 이어서 한다
  if (interview.paused_at) await resume(env, interview, now);
  const t = timing(interview, session.duration, now);
  if (t.elapsedSec > session.duration * 60 + VOICE_GRACE_SEC) {
    return json({ error: "음성 대화 시간이 끝났어요. 글로 이어서 마무리해 주세요.", code: "voice_over" }, 409);
  }

  const { results: history } = await env.DB.prepare("SELECT role, content, excluded FROM interview_messages WHERE interview_id = ? ORDER BY id")
    .bind(interview.id).all();
  const ctx = {
    snapshot, topic: topicOf(snapshot, session), duration: session.duration, stages, reward: rewardOf(session.consent),
    stage: interview.stage, history, participantTurns: history.filter((m) => m.role === "participant").length, t, profile: interview.profile,
  };
  const instructions = [moderatorInstructions(ctx, "voice"), stateNote(ctx, "voice"), historyNote(history)].filter(Boolean).join("\n\n");

  let data = {};
  try {
    const res = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        // 개인을 알 수 없는 값: 인터뷰 번호의 해시
        "OpenAI-Safety-Identifier": await sha256Hex(interview.id),
      },
      body: JSON.stringify({
        session: {
          type: "realtime",
          model: env.OPENAI_REALTIME_MODEL,
          instructions,
          output_modalities: ["audio"],
          audio: {
            input: {
              transcription: { model: env.OPENAI_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe", language: "ko" },
              turn_detection: { type: "semantic_vad" },
            },
            output: { voice: env.OPENAI_REALTIME_VOICE || "marin" },
          },
          tools: VOICE_TOOLS,
          tool_choice: "auto",
        },
      }),
    });
    data = await res.json().catch(() => ({}));
    if (!res.ok || !data.value) throw new Error(`OpenAI ${res.status}: ${data?.error?.message || "임시 키 없음"}`);
  } catch (err) {
    console.error("realtime session failed", String(err?.message || err));
    return json(VOICE_FAILED, 502);
  }

  return json({
    clientSecret: data.value, expiresAt: data.expires_at || null,
    opening: history.length === 0, // 첫 인사부터 시작하는지 (화면 안내용)
    stage: interview.stage, totalStages: stages.length, status: interview.status, ...t,
  });
}

// 글로 하다가 음성으로 바꾸거나 연결이 끊겨 다시 들어온 경우: 지금까지의 대화를 지침에 붙여 그 자리에서 잇게 한다
function historyNote(history) {
  if (!history.length) return "";
  const lines = history.slice(-VOICE_HISTORY).map((m) => {
    const text = m.excluded && m.role === "participant" ? EXCLUDED_NOTE : m.content.slice(0, 600);
    return `${m.role === "moderator" ? "모더레이터" : "참가자"}: ${text}`;
  });
  return `## 지금까지의 대화
참가자가 방금 음성으로 (다시) 연결했습니다. 아래는 지금까지 나눈 대화입니다. 자기소개와 이미 한 질문을 처음부터 반복하지 않습니다. "이어서 할게요" 정도로 짧게 말한 뒤, 마지막 질문에 답을 받지 못했으면 그 질문을 다시 묻고, 받았으면 다음으로 이어 갑니다.

${lines.join("\n")}`;
}

// ── 받아쓴 발화·진행 상황 기록 ──
async function record(request, env, json, session, interview, stages, now) {
  let body = {};
  try { body = await request.json(); } catch {}

  const state = (extra = {}) => {
    const t = timing(interview, session.duration, now);
    const notice = timeNotice({ t, stage: interview.stage, stages }, "voice");
    const rem = Math.round(t.remainingSec / 60);
    return {
      stage: interview.stage, totalStages: stages.length, status: interview.status, ...t,
      // 시간이 얼마 안 남았을 때 모더레이터에게 전할 안내 (화면이 음성 세션에 넣어 준다)
      notice: notice.level ? { level: notice.level, text: [`[진행 상태] 남은 시간 ${rem}분`, ...notice.lines].filter(Boolean).join("\n") } : null,
      ...extra,
    };
  };

  if (body.ping) return json(state());

  // 받아쓴 발화 한 건
  if (body.role === "participant" || body.role === "moderator") {
    const text = typeof body.text === "string" ? body.text.trim().slice(0, VOICE_TEXT_CHARS) : "";
    if (!text) return json({ error: "기록할 말이 없어요." }, 400);
    const last = await env.DB.prepare("SELECT id, role, content FROM interview_messages WHERE interview_id = ? ORDER BY id DESC LIMIT 1").bind(interview.id).first();
    // 같은 말을 다시 보낸 것(답을 못 받고 재전송)이면 두 번 저장하지 않는다
    if (last && last.role === body.role && last.content === text) return json(state({ id: last.id }));
    if (body.role === "participant") {
      const { n } = await env.DB.prepare("SELECT COUNT(*) AS n FROM interview_messages WHERE interview_id = ? AND role = 'participant'").bind(interview.id).first();
      if (n >= MAX_PARTICIPANT_TURNS) return json({ error: "오늘 인터뷰는 여기까지예요. 참여해 주셔서 감사합니다.", code: "turn_limit" }, 409);
    }
    // 제외 요청에 답한 모더레이터의 말은 글 대화처럼 함께 제외로 둔다
    const excluded = body.role === "moderator" && body.excluded === true ? 1 : 0;
    try {
      const [row] = await env.DB.batch([
        env.DB.prepare("INSERT INTO interview_messages (interview_id, role, content, stage, excluded, mode, created_at) VALUES (?, ?, ?, ?, ?, 'voice', ?) RETURNING id")
          .bind(interview.id, body.role, text, interview.stage, excluded, now),
        env.DB.prepare("UPDATE interviews SET status = 'in_progress' WHERE id = ? AND status = 'consented'").bind(interview.id),
      ]);
      if (interview.status === "consented") interview.status = "in_progress";
      return json(state({ id: row.results[0].id }));
    } catch {
      return json(RECORD_FAILED, 503);
    }
  }

  // 단계 이동: 되돌아가지 않고, 마지막 단계를 넘지 않는다
  if (body.tool === "set_stage") {
    const next = Math.min(Math.max(Number.isInteger(body.stage) ? body.stage : interview.stage, interview.stage), stages.length - 1);
    if (next !== interview.stage) {
      await env.DB.prepare("UPDATE interviews SET stage = ? WHERE id = ?").bind(next, interview.id).run();
      interview.stage = next;
    }
    return json(state());
  }

  // 마침: 첫 인사만 오간 상태에서는 마치지 않는다 (글 대화와 같은 조건)
  if (body.tool === "finish") {
    const { n } = await env.DB.prepare("SELECT COUNT(*) AS n FROM interview_messages WHERE interview_id = ?").bind(interview.id).first();
    if (n <= 2) return json(state({ ignored: true }));
    const status = body.reason === "stopped" ? "stopped" : "completed";
    await env.DB.prepare("UPDATE interviews SET status = ?, paused_at = NULL, finished_at = COALESCE(finished_at, ?) WHERE id = ?").bind(status, now, interview.id).run();
    interview.status = status;
    return json(state());
  }

  // "이 얘기는 빼주세요": 참가자가 가리킨 발화부터 그 뒤를 분석 제외로
  if (body.tool === "exclude") {
    const { results: parts } = await env.DB.prepare("SELECT id FROM interview_messages WHERE interview_id = ? AND role = 'participant' ORDER BY id DESC LIMIT 2").bind(interview.id).all();
    const target = body.scope === "previous" ? parts[1] || parts[0] : parts[0];
    if (!target) return json(state({ ignored: true }));
    await env.DB.prepare("UPDATE interview_messages SET excluded = 1 WHERE interview_id = ? AND id >= ?").bind(interview.id, target.id).run();
    return json(state({ excludedFrom: target.id }));
  }

  return json({ error: "없는 요청이에요." }, 400);
}

async function sha256Hex(text) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
