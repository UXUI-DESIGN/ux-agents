// 페르소나 프로필 사진 (OpenAI 이미지 생성)
//   POST /api/personas/:id/image-prompt   페르소나 내용에서 장면을 뽑아 프롬프트를 조립해 돌려준다 (아직 생성하지 않음)
//   POST /api/personas/:id/image          { scene } 사용자가 고친 장면 + 고정 스타일로 이미지 생성 → 저장 → photo_url 갱신
//   DELETE /api/personas/:id/image        사진 지우기 (실루엣으로)
//   GET  /api/personas/image/:imageId     사진 바이트 (로그인 없음: id 가 추측 불가능한 값)
//
// 프롬프트 규칙
//   - 인구통계가 아니라 '맥락과 행동'이 중심: lifestyle 의 장면(장소·시간대·하고 있는 행동), 쓰는 디지털 기기,
//     personality 에서 드러나는 표정·분위기. 나이대·성별·국적은 한 단어씩만.
//   - 스타일 고정(서버가 항상 붙인다): 자연광 실내 다큐멘터리 사진, 얼굴이 보이는 상반신, 세로 비율, 텍스트·로고 없음
//   - 제외: 특정 인종·외모 묘사, 유명인 닮은꼴, 과도한 미화 — 장면 추출 때 금지하고, 조립 때 제외 문구를 붙인다
//   장면 추출만 Chat API 에 맡기고, 조립은 코드가 한다 (고정 규칙이 모델 출력에 흔들리지 않게).

import { firstJson } from "./json.js";

const MAX_SCENE_CHARS = 700;
const IMAGE_SIZE = "1024x1536"; // 세로
const STYLE_FIXED = "자연광이 드는 실내에서 찍은 다큐멘터리 사진. 얼굴이 보이는 상반신, 세로 구도. 연출하지 않은 생활감, 보정하지 않은 사실적인 색감과 피부 질감.";
const EXCLUDE_FIXED = "텍스트·로고·워터마크·자막 없음. 특정 인종이나 외모를 강조하지 않고, 유명인을 닮지 않게, 과도하게 미화하거나 광고 사진처럼 만들지 않는다.";

export async function personaImage(request, env, json, user, row, action) {
  const method = request.method;

  if (action === "image-prompt" && method === "POST") {
    if (!env.OPENAI_API_KEY) return json({ error: "AI를 부르지 못했어요. 잠시 후 다시 시도해 주세요." }, 502);
    let scene;
    try {
      scene = await extractScene(env, row);
    } catch (err) {
      console.error("image-prompt failed", String(err?.message || err));
      return json({ error: "장면을 뽑지 못했어요. 잠시 후 다시 시도해 주세요." }, 502);
    }
    const sceneText = assembleScene(scene, row);
    await env.DB.prepare("UPDATE personas SET image_prompt = ? WHERE id = ?").bind(sceneText, row.id).run();
    return json({ scene, scene_text: sceneText, style: STYLE_FIXED, exclude: EXCLUDE_FIXED, full_prompt: fullPrompt(sceneText) });
  }

  if (action === "image" && method === "POST") {
    if (!env.OPENAI_API_KEY) return json({ error: "AI를 부르지 못했어요. 잠시 후 다시 시도해 주세요." }, 502);
    let body;
    try { body = await request.json(); } catch { return json({ error: "JSON 본문이 필요해요." }, 400); }
    const sceneText = typeof body.scene === "string" ? body.scene.trim().slice(0, MAX_SCENE_CHARS) : "";
    if (!sceneText) return json({ error: "장면 설명이 비어 있어요." }, 400);
    const started = Date.now();
    let made;
    try {
      made = await createPersonaImage(env, request, user, row, sceneText);
    } catch (err) {
      console.error("image generate failed", String(err?.message || err));
      const msg = /safety|moderation|content_policy/i.test(String(err?.message)) ? "이 프롬프트로는 이미지를 만들 수 없었어요. 장면 설명을 바꿔 다시 시도해 주세요." : /too large/.test(String(err?.message)) ? "만들어진 이미지가 너무 커서 저장하지 못했어요. 다시 시도해 주세요." : "이미지를 만들지 못했어요. 잠시 후 다시 시도해 주세요.";
      return json({ error: msg }, 502);
    }
    return json({ ...made, ms: Date.now() - started });
  }

  if (action === "image" && method === "DELETE") {
    const now = Math.floor(Date.now() / 1000);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM persona_images WHERE persona_id = ?").bind(row.id),
      env.DB.prepare("UPDATE personas SET photo_url = NULL, updated_at = ? WHERE id = ?").bind(now, row.id),
    ]);
    return json({ ok: true });
  }

  return json({ error: "없는 경로예요." }, 404);
}

// 장면 + 고정 스타일로 만들어 D1 에 저장하고 photo_url 을 바꾼다 (사용자 생성과 샘플 시딩이 함께 쓴다)
export async function createPersonaImage(env, request, user, row, sceneText) {
  const prompt = fullPrompt(sceneText);
  const model = env.OPENAI_IMAGE_MODEL || "gpt-image-1";
  const { bytes, mime } = await generateImage(env, model, prompt);
  if (bytes.byteLength > 900_000) throw new Error("image too large");
  const now = Math.floor(Date.now() / 1000);
  const imageId = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  const url = `${new URL(request.url).origin}/api/personas/image/${imageId}`;
  await env.DB.batch([
    env.DB.prepare("INSERT INTO persona_images (id, persona_id, user_id, mime, bytes, prompt, model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(imageId, row.id, user.id, mime, bytes, prompt, model, now),
    // 이전 사진은 지운다 (한 페르소나에 사진 하나)
    env.DB.prepare("DELETE FROM persona_images WHERE persona_id = ? AND id != ?").bind(row.id, imageId),
    env.DB.prepare("UPDATE personas SET photo_url = ?, image_prompt = ?, updated_at = ? WHERE id = ?").bind(url, sceneText, now, row.id),
  ]);
  return { photoUrl: url, prompt, scene: sceneText, model };
}

// 로그인 없이 읽는다 (id 가 열쇠). CORS 헤더 없이도 <img> 는 읽을 수 있다
export async function servePersonaImage(env, imageId) {
  if (!/^[0-9a-f]{40}$/.test(imageId)) return new Response("not found", { status: 404 });
  const img = await env.DB.prepare("SELECT mime, bytes FROM persona_images WHERE id = ?").bind(imageId).first();
  if (!img) return new Response("not found", { status: 404 });
  // D1 은 BLOB 을 ArrayBuffer 로 주지만, 환경에 따라 숫자 배열로 올 때가 있어 둘 다 받는다
  const body = img.bytes instanceof ArrayBuffer || ArrayBuffer.isView(img.bytes) ? img.bytes : Uint8Array.from(img.bytes || []);
  return new Response(body, {
    headers: { "Content-Type": img.mime, "Cache-Control": "public, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff" },
  });
}

// ── 장면 추출 (Chat API) ──
const SCENE_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["place", "time_of_day", "action", "device", "expression", "mood", "age_band", "gender_word"],
  properties: {
    place: { type: "string", description: "lifestyle 에 나온 실내 장소 한 구. 예: '퇴근 후 집 거실 소파'" },
    time_of_day: { type: "string", description: "시간대 한 단어. 예: '늦은 밤', '이른 아침'. 없으면 빈 문자열" },
    action: { type: "string", description: "그 장면에서 하고 있는 구체적 행동 한 구. 예: '태블릿으로 볼 콘텐츠를 고르는 중'" },
    device: { type: "string", description: "쓰고 있는 디지털 기기 한 단어. 예: '스마트폰'. 없으면 빈 문자열" },
    expression: { type: "string", description: "personality 에서 드러나는 표정 한 구. 예: '편안하게 살짝 미소 짓는'" },
    mood: { type: "string", description: "장면의 분위기 한 구. 예: '차분하고 아늑한'" },
    age_band: { type: "string", description: "나이대 한 단어. 예: '30대'" },
    gender_word: { type: "string", description: "성별 한 단어. 예: '여성', '남성'. 알 수 없으면 '사람'" },
  },
};

async function extractScene(env, row) {
  const persona = {
    age: row.age, gender: row.gender, job: row.job,
    environment: row.environment, personality: row.personality, motivation: row.motivation,
    lifestyle: row.lifestyle, behavior: JSON.parse(row.behavior || "{}"),
  };
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: env.OPENAI_MODEL,
      instructions: `페르소나 문서에서 프로필 사진 한 장에 담을 '장면'을 뽑습니다. 한국어로, 각 항목은 짧은 구 하나.
- 인구통계가 아니라 맥락과 행동이 중심입니다. lifestyle 에 실제로 적힌 장소·시간대·행동을 고릅니다. 적혀 있지 않으면 environment 와 behavior 에서 가장 자연스러운 실내 장면을 하나 고릅니다.
- device 는 environment 나 lifestyle 에 나온 기기 중 그 장면에서 손에 들고 있을 법한 것 하나.
- expression 과 mood 는 personality 에서 드러나는 것만. 과장하지 않습니다.
- age_band 는 '20대'처럼 한 단어, gender_word 는 '여성'/'남성'처럼 한 단어. 그 밖의 외모·인종·체형·옷차림·헤어는 절대 적지 않습니다.`,
      input: JSON.stringify(persona),
      text: { format: { type: "json_schema", name: "scene", schema: SCENE_SCHEMA, strict: true } },
      reasoning: { effort: "none" }, max_output_tokens: 600, store: false,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${data?.error?.message || ""}`);
  const raw = (data.output || []).filter((x) => x.type === "message").flatMap((x) => x.content || []).filter((c) => c.type === "output_text").map((c) => c.text).join("");
  const s = firstJson(raw);
  if (!s || typeof s.action !== "string") throw new Error("장면 답을 읽지 못함");
  const str = (v, n = 80) => (typeof v === "string" ? v.trim().slice(0, n) : "");
  return { place: str(s.place), time_of_day: str(s.time_of_day, 20), action: str(s.action, 120), device: str(s.device, 30), expression: str(s.expression), mood: str(s.mood), age_band: str(s.age_band, 10), gender_word: str(s.gender_word, 10) };
}

// ── 조립 (코드) ──
function assembleScene(s, row) {
  const ageBand = s.age_band || (row.age ? `${Math.floor(row.age / 10) * 10}대` : "");
  const who = [ageBand, s.gender_word || "사람", "한국인"].filter(Boolean).join(" ");
  const when = s.time_of_day ? `${s.time_of_day}, ` : "";
  const where = s.place ? `${s.place}에서 ` : "";
  const device = s.device ? ` ${josa(s.device, "을", "를")} 손에 들고 있다.` : "";
  const face = [s.expression && `표정은 ${s.expression}`, s.mood && `분위기는 ${s.mood}`].filter(Boolean).join(", ");
  return `${when}${where}${s.action || "일상적인 일을 하는"} 중인 ${who} 한 명.${device}${face ? ` ${face}.` : ""}`.replace(/\s+/g, " ").trim();
}

export function fullPrompt(sceneText) {
  return `${sceneText}\n\n${STYLE_FIXED}\n${EXCLUDE_FIXED}`;
}

// 받침에 따라 을/를
function josa(word, withBatchim, without) {
  const code = word.charCodeAt(word.length - 1);
  if (code < 0xac00 || code > 0xd7a3) return `${word}${without}`;
  return `${word}${(code - 0xac00) % 28 ? withBatchim : without}`;
}

// ── 이미지 생성 (Images API) ──
async function generateImage(env, model, prompt) {
  const res = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.OPENAI_API_KEY}` },
    body: JSON.stringify({ model, prompt, n: 1, size: IMAGE_SIZE, quality: "medium", output_format: "jpeg", output_compression: 75 }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`OpenAI images ${res.status}: ${data?.error?.message || ""}`);
  const b64 = data?.data?.[0]?.b64_json;
  if (!b64) throw new Error("이미지 답이 비어 있음");
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { bytes, mime: "image/jpeg" };
}
