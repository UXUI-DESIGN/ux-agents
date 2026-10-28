// 시나리오 보드 (리서처, 로그인) — 확정한 TO-BE 시나리오와 콘티로 컷 이미지를 만든다
//   GET    /api/boards[?analysis=]          내 보드 목록 (프로젝트 화면은 analysis 로 거른다)
//   POST   /api/boards                      { title, source, style, scenario, sheet, cuts, contiStatus, journeyId, personaId } → 저장 → { board }
//   GET    /api/boards/:id                  보드 1장 (컷 상태 · 이미지 버전 · 보낼 설명)
//   PUT    /api/boards/:id                  { title?, scenario?, contiStatus?, sheet?, cuts? } 고치기 · 순서 바꾸기 · 컷 추가/삭제
//   DELETE /api/boards/:id
//   POST   /api/boards/:id/generate         아직 만들지 않은 컷(+캐릭터 시트)을 컷마다 큐에 넣고 바로 202 '접수됨'
//   POST   /api/boards/:id/cuts/:cid/generate  { scene? } 이 컷만 다시 만들기 (장면 묘사를 고쳐서 보낼 수 있다)
//   POST   /api/boards/:id/cuts/:cid/revert    { imageId } 이전 이미지 버전으로 되돌리기
//   GET    /api/boards/image/:imageId       컷 이미지 바이트 (로그인 없음: id 가 추측 불가능한 값)
//
// 컷마다 따로 처리하는 방식: Cloudflare Queues
//   - 보드 생성 요청은 컷마다 메시지 1개를 넣고 곧바로 202 를 돌려준다. 화면은 GET 으로 상태를 다시 읽어 완성된 컷부터 채운다
//   - 상태(대기·생성 중·완료·실패)는 board_cuts 에 기록하므로 페이지를 닫았다 다시 열어도 이어서 보인다
//   - 중복 방지: 'idle/failed → queued' 를 조건부 UPDATE … RETURNING 한 줄로 바꾼 컷만 메시지를 보낸다.
//     같은 보드를 두 번 눌러도 두 번째 요청에서는 바뀌는 행이 없어 메시지가 생기지 않는다.
//     메시지에는 job_id 를 실어, 컷의 job_id 와 다르면(다시 만들기로 새 작업이 생겼으면) 지난 메시지로 보고 버린다
//   - 일시적인 오류(429·5xx·연결 끊김)는 msg.retry 로 최대 2번 더 시도하고, 이미지 정책 위반은 재시도하지 않는다
//
// 이미지 설명 = 고정 스타일 문장 + 콘티의 장면 묘사 + 구도 (+ 참조 이미지 안내 · 제외 문구). 조립은 코드가 한다.

import { currentUser } from "./auth.js";
import { generateImage, blobBytes, newImageId, servePersonaImage } from "./personaImage.js";

const MAX_BODY_CHARS = 100000;
const MAX_CUTS = 12;
const MAX_AUTO_RETRY = 2;
const CUT_SIZE = "1536x1024"; // 가로 (스토리보드 컷)
const MAX_IMAGE_BYTES = 1_800_000; // D1 한 행 2MB 아래
const NOT_FOUND = { error: "보드를 찾을 수 없어요.", code: "not_found" };
const now = () => Math.floor(Date.now() / 1000);

// 그림 스타일은 모든 컷에 이 문장을 그대로 붙인다 (컷마다 화풍이 흔들리지 않게)
export const STYLE_FIXED = {
  sketch: "연필 스케치 스토리보드. 흰 종이 위 회색 흑연 선과 가벼운 해칭 명암, 색 없음. 선 굵기·필압·종이 질감을 모든 컷에서 똑같이 유지한다.",
  flat: "플랫 일러스트 스토리보드. 외곽선 없는 단순한 면, 그림자 최소, 남색·연보라·베이지·민트의 차분한 팔레트. 단순화 정도와 팔레트를 모든 컷에서 똑같이 유지한다.",
  photo: "실사풍 스토리보드 스틸. 자연광, 보정하지 않은 사실적인 색감, 35mm 렌즈의 얕은 심도. 색감·조명·입자를 모든 컷에서 똑같이 유지한다.",
};
const STYLE_LABEL = { sketch: "연필 스케치", flat: "플랫 일러스트", photo: "실사풍" };
const CAMERA = {
  "전신": "인물의 전신과 주변 공간이 함께 보이는 구도",
  "상반신": "인물의 상반신이 화면 중심에 오는 구도",
  "클로즈업": "인물의 얼굴 표정이나 손이 화면을 크게 채우는 클로즈업",
  "화면 위주": "인물의 어깨 너머로 기기 화면이 크게 보이는 구도",
};
const REFERENCE_NOTE = "참조 이미지 속 인물과 같은 사람으로 그린다(얼굴 생김새·머리 모양·체형 유지). 참조 사진의 배경·자세·조명은 따르지 않고, 위 그림 스타일로 다시 그린다.";
const NO_REFERENCE_NOTE = "인물은 한 명. 모든 컷에서 같은 사람으로 보이게 그린다.";
const EXCLUDE_FIXED = "그림 안에 글자·말풍선·자막·로고·워터마크 없음. 기기 화면 속 UI 는 글자 없이 도형으로만.";
const SHEET_SCENE = "캐릭터 시트. 흰 배경 위에 같은 인물을 정면 전신, 옆모습 전신, 그리고 표정 세 가지(편안함·고민·안도)의 얼굴로 가로로 나란히 배치한다.";

// 이미지용 장면 묘사에 쓰면 안 되는 외모 표현 (화면 scenario/index.html 의 APPEARANCE 와 같은 목록)
const APPEARANCE = /머리카락|머리 ?모양|헤어|단발|장발|긴 ?머리|짧은 ?머리|곱슬|앞머리|포니테일|염색|안경|피부|얼굴형|눈매|쌍꺼풀|눈동자|수염|키가|키 ?큰|키 ?작은|체형|날씬|통통|뚱뚱|마른 ?체|근육질|외모|잘생|예쁜|미인|인종|금발|화장|메이크업|옷차림|정장|원피스|티셔츠|청바지|후드티|\d+대 ?(여성|남성|여자|남자)/g;
export function appearanceWords(text) {
  return [...new Set(String(text || "").match(APPEARANCE) || [])];
}

export async function boards(request, env, json, id, sub, cutId, cutAction) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: "로그인이 필요해요.", code: "unauthorized" }, 401);
  const method = request.method;
  const origin = new URL(request.url).origin;

  if (!id && method === "GET") return list(env, json, user, new URL(request.url).searchParams.get("analysis"), origin);
  if (!id && method === "POST") return create(request, env, json, user, origin);
  if (!id) return json({ error: "없는 경로예요." }, 404);

  const board = await env.DB.prepare("SELECT * FROM boards WHERE id = ? AND user_id = ?").bind(id, user.id).first();
  if (!board) return json(NOT_FOUND, 404);

  if (!sub) {
    if (method === "GET") return json({ board: await view(env, board, origin) });
    if (method === "PUT") return save(request, env, json, board, origin);
    if (method === "DELETE") {
      await env.DB.prepare("DELETE FROM boards WHERE id = ?").bind(board.id).run();
      return json({ ok: true });
    }
  }
  if (sub === "generate" && method === "POST") return generateBoard(env, json, board, origin);
  if (sub === "cuts" && cutId && method === "POST" && cutAction === "generate") return regenerateCut(request, env, json, board, cutId, origin);
  if (sub === "cuts" && cutId && method === "POST" && cutAction === "revert") return revertCut(request, env, json, board, cutId, origin);
  return json({ error: "없는 경로예요." }, 404);
}

export const serveBoardImage = (env, imageId) => servePersonaImage(env, imageId, "board_images");

// ── 목록 ──
async function list(env, json, user, analysisId, origin) {
  const { results } = await env.DB.prepare(
    `SELECT b.id, b.title, b.source, b.style, b.status, b.conti_status, b.journey_id, b.persona_id, b.analysis_id, b.created_at, b.updated_at, b.completed_at,
            (SELECT COUNT(*) FROM board_cuts c WHERE c.board_id = b.id AND c.kind = 'cut') AS cuts,
            (SELECT COUNT(*) FROM board_cuts c WHERE c.board_id = b.id AND c.kind = 'cut' AND c.status = 'done') AS done,
            (SELECT c.image_id FROM board_cuts c WHERE c.board_id = b.id AND c.kind = 'cut' AND c.image_id IS NOT NULL ORDER BY c.position LIMIT 1) AS thumb
       FROM boards b WHERE b.user_id = ? ${analysisId ? "AND b.analysis_id = ?" : ""} ORDER BY b.updated_at DESC`
  ).bind(...(analysisId ? [user.id, analysisId] : [user.id])).all();
  return json({
    boards: results.map((r) => ({
      id: r.id, title: r.title, source: JSON.parse(r.source), style: r.style, styleLabel: STYLE_LABEL[r.style], status: r.status, contiStatus: r.conti_status,
      journeyId: r.journey_id, personaId: r.persona_id, analysisId: r.analysis_id, cuts: r.cuts, done: r.done,
      thumb: r.thumb ? imageUrl(origin, r.thumb) : null, createdAt: r.created_at, updatedAt: r.updated_at, completedAt: r.completed_at,
    })),
  });
}

// ── 저장 (새 보드) ──
async function create(request, env, json, user, origin) {
  const body = await readBody(request);
  if (!body) return json({ error: "JSON 본문이 필요해요." }, 400);
  const style = STYLE_FIXED[body.style] ? body.style : null;
  if (!style) return json({ error: "그림 스타일을 골라 주세요." }, 400);
  const scenario = str(body.scenario, 4000);
  if (!scenario) return json({ error: "시나리오가 비어 있어요." }, 400);
  const cuts = arr(body.cuts, MAX_CUTS).map((c) => cleanConti(c?.conti || c));
  if (cuts.length < 1) return json({ error: "콘티에 컷이 하나도 없어요." }, 400);

  // 저니맵·페르소나는 내 것(페르소나는 샘플도)만 연결한다
  const journeyId = typeof body.journeyId === "string" ? body.journeyId : null;
  if (journeyId && !(await env.DB.prepare("SELECT id FROM journeys WHERE id = ? AND user_id = ?").bind(journeyId, user.id).first())) {
    return json({ error: "고른 저니맵을 찾을 수 없어요." }, 400);
  }
  let persona = null;
  if (typeof body.personaId === "string" && body.personaId) {
    persona = await env.DB.prepare("SELECT id, name, job, age, tagline, photo_url, analysis_id FROM personas WHERE id = ? AND (user_id = ? OR user_id = 'sample')").bind(body.personaId, user.id).first();
    if (!persona) return json({ error: "고른 페르소나를 찾을 수 없어요." }, 400);
  }
  const source = cleanSource(body.source, persona);
  const contiStatus = body.contiStatus === "confirmed" ? "confirmed" : "draft";
  if (contiStatus === "confirmed") {
    const bad = contiProblems(cuts);
    if (bad.length) return json({ error: "콘티를 확정하기 전에 고칠 곳이 있어요.", code: "conti_invalid", problems: bad }, 400);
  }

  const t = now();
  const boardId = crypto.randomUUID();
  const title = str(body.title, 80) || `${source.persona?.name || "인물"}의 TO-BE 시나리오`;
  const sheet = { title: "캐릭터 시트", desc: str(body.sheet?.desc, 600) || source.persona?.desc || "" };
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO boards (id, user_id, journey_id, persona_id, analysis_id, title, source, style, scenario, conti_status, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`
    ).bind(boardId, user.id, journeyId, persona?.id || null, persona?.analysis_id || null, title, JSON.stringify(source), style, scenario, contiStatus, t, t),
    cutInsert(env, boardId, "sheet", 0, sheet, t),
    ...cuts.map((c, i) => cutInsert(env, boardId, "cut", i + 1, c, t)),
  ]);
  const row = await env.DB.prepare("SELECT * FROM boards WHERE id = ?").bind(boardId).first();
  return json({ board: await view(env, row, origin) });
}

function cutInsert(env, boardId, kind, position, conti, t) {
  return env.DB.prepare("INSERT INTO board_cuts (id, board_id, kind, position, conti, status, updated_at) VALUES (?, ?, ?, ?, ?, 'idle', ?)")
    .bind(crypto.randomUUID(), boardId, kind, position, JSON.stringify(conti), t);
}

// ── 고치기 · 순서 · 추가/삭제 ──
//   cuts 를 주면 그 배열이 곧 새 순서다. id 가 있는 컷은 내용만 바꾸고(이미지·상태 유지), id 가 없으면 새 컷, 빠진 컷은 지운다
async function save(request, env, json, board, origin) {
  const body = await readBody(request);
  if (!body) return json({ error: "JSON 본문이 필요해요." }, 400);
  const t = now();
  const stmts = [];
  const { results: existing } = await env.DB.prepare("SELECT id, kind, conti FROM board_cuts WHERE board_id = ?").bind(board.id).all();
  const byId = new Map(existing.map((c) => [c.id, c]));

  let contiStatus = board.conti_status;
  if (body.contiStatus === "confirmed" || body.contiStatus === "draft") contiStatus = body.contiStatus;

  if (Array.isArray(body.cuts)) {
    if (body.cuts.length < 1) return json({ error: "컷이 하나는 있어야 해요." }, 400);
    if (body.cuts.length > MAX_CUTS) return json({ error: `컷은 ${MAX_CUTS}개까지 둘 수 있어요.` }, 400);
    const keep = new Set();
    body.cuts.forEach((c, i) => {
      const conti = cleanConti(c?.conti || c);
      const old = typeof c?.id === "string" ? byId.get(c.id) : null;
      if (old && old.kind === "cut") {
        keep.add(old.id);
        stmts.push(env.DB.prepare("UPDATE board_cuts SET conti = ?, position = ?, updated_at = ? WHERE id = ?").bind(JSON.stringify(conti), i + 1, t, old.id));
      } else {
        stmts.push(cutInsert(env, board.id, "cut", i + 1, conti, t));
      }
    });
    for (const c of existing) if (c.kind === "cut" && !keep.has(c.id)) stmts.push(env.DB.prepare("DELETE FROM board_cuts WHERE id = ?").bind(c.id));
    if (contiStatus === "confirmed") {
      const bad = contiProblems(body.cuts.map((c) => cleanConti(c?.conti || c)));
      if (bad.length) return json({ error: "콘티를 확정하기 전에 고칠 곳이 있어요.", code: "conti_invalid", problems: bad }, 400);
    }
  } else if (contiStatus === "confirmed" && board.conti_status !== "confirmed") {
    const bad = contiProblems(existing.filter((c) => c.kind === "cut").map((c) => JSON.parse(c.conti)));
    if (bad.length) return json({ error: "콘티를 확정하기 전에 고칠 곳이 있어요.", code: "conti_invalid", problems: bad }, 400);
  }
  if (body.sheet && typeof body.sheet === "object") {
    const sheet = existing.find((c) => c.kind === "sheet");
    if (sheet) stmts.push(env.DB.prepare("UPDATE board_cuts SET conti = ?, updated_at = ? WHERE id = ?").bind(JSON.stringify({ title: "캐릭터 시트", desc: str(body.sheet.desc, 600) }), t, sheet.id));
  }
  const title = str(body.title, 80) || board.title;
  const scenario = typeof body.scenario === "string" ? str(body.scenario, 4000) || board.scenario : board.scenario;
  stmts.push(env.DB.prepare("UPDATE boards SET title = ?, scenario = ?, conti_status = ?, updated_at = ? WHERE id = ?").bind(title, scenario, contiStatus, t, board.id));
  await env.DB.batch(stmts);
  await settleBoard(env, board.id);
  const row = await env.DB.prepare("SELECT * FROM boards WHERE id = ?").bind(board.id).first();
  return json({ board: await view(env, row, origin) });
}

// ── 보드 생성: 컷마다 큐 메시지 1개 ──
async function generateBoard(env, json, board, origin) {
  if (board.conti_status !== "confirmed") return json({ error: "콘티를 먼저 확정해 주세요. 이미지는 확정한 콘티로만 만들어요.", code: "conti_not_confirmed" }, 409);
  if (!env.CUT_QUEUE) return json({ error: "Worker 에 작업 큐(CUT_QUEUE)가 연결되지 않았어요." }, 500);
  const jobId = crypto.randomUUID();
  const t = now();
  // 아직 요청하지 않은(idle) 컷만 queued 로 바꾸고, 바뀐 행에만 메시지를 보낸다 (두 번 눌러도 중복 작업 없음)
  const { results: queued } = await env.DB.prepare(
    "UPDATE board_cuts SET status = 'queued', job_id = ?, attempts = 0, error = NULL, error_code = NULL, updated_at = ? WHERE board_id = ? AND status = 'idle' RETURNING id"
  ).bind(jobId, t, board.id).all();
  if (queued.length) {
    await env.DB.prepare("UPDATE boards SET status = 'generating', completed_at = NULL, updated_at = ? WHERE id = ?").bind(t, board.id).run();
    await env.CUT_QUEUE.sendBatch(queued.map((c) => ({ body: { boardId: board.id, cutId: c.id, jobId } })));
  }
  const row = await env.DB.prepare("SELECT * FROM boards WHERE id = ?").bind(board.id).first();
  return json({ accepted: true, queued: queued.length, duplicate: queued.length === 0, board: await view(env, row, origin) }, 202);
}

// ── 이 컷만 다시 만들기 ──
async function regenerateCut(request, env, json, board, cutId, origin) {
  if (board.conti_status !== "confirmed") return json({ error: "콘티를 먼저 확정해 주세요.", code: "conti_not_confirmed" }, 409);
  if (!env.CUT_QUEUE) return json({ error: "Worker 에 작업 큐(CUT_QUEUE)가 연결되지 않았어요." }, 500);
  const cut = await env.DB.prepare("SELECT * FROM board_cuts WHERE id = ? AND board_id = ?").bind(cutId, board.id).first();
  if (!cut) return json({ error: "컷을 찾을 수 없어요." }, 404);
  const body = (await readBody(request)) || {};
  const t = now();
  // 장면 묘사를 고쳐서 보낸 경우 (정책 실패 뒤 고치기)
  if (typeof body.scene === "string" && cut.kind === "cut") {
    const conti = { ...JSON.parse(cut.conti), scene: str(body.scene, 600) };
    const bad = contiProblems([conti]);
    if (bad.length) return json({ error: bad[0].message, code: "conti_invalid", problems: bad }, 400);
    await env.DB.prepare("UPDATE board_cuts SET conti = ?, updated_at = ? WHERE id = ?").bind(JSON.stringify(conti), t, cut.id).run();
  }
  const jobId = crypto.randomUUID();
  const claimed = await env.DB.prepare(
    "UPDATE board_cuts SET status = 'queued', job_id = ?, attempts = 0, error = NULL, error_code = NULL, updated_at = ? WHERE id = ? AND status IN ('idle', 'done', 'failed') RETURNING id"
  ).bind(jobId, t, cut.id).first();
  if (!claimed) return json({ error: "이 컷은 이미 만드는 중이에요.", code: "busy" }, 409);
  await env.DB.prepare("UPDATE boards SET status = 'generating', completed_at = NULL, updated_at = ? WHERE id = ?").bind(t, board.id).run();
  await env.CUT_QUEUE.send({ boardId: board.id, cutId: cut.id, jobId });
  const row = await env.DB.prepare("SELECT * FROM boards WHERE id = ?").bind(board.id).first();
  return json({ accepted: true, board: await view(env, row, origin) }, 202);
}

// ── 이전 버전으로 되돌리기 ──
async function revertCut(request, env, json, board, cutId, origin) {
  const body = (await readBody(request)) || {};
  const img = await env.DB.prepare("SELECT id FROM board_images WHERE id = ? AND cut_id = ? AND board_id = ?").bind(String(body.imageId || ""), cutId, board.id).first();
  if (!img) return json({ error: "되돌릴 버전을 찾을 수 없어요." }, 404);
  const done = await env.DB.prepare("UPDATE board_cuts SET image_id = ?, status = 'done', error = NULL, error_code = NULL, updated_at = ? WHERE id = ? AND status != 'running' AND status != 'queued' RETURNING id")
    .bind(img.id, now(), cutId).first();
  if (!done) return json({ error: "이 컷은 지금 만드는 중이라 되돌릴 수 없어요.", code: "busy" }, 409);
  await settleBoard(env, board.id);
  const row = await env.DB.prepare("SELECT * FROM boards WHERE id = ?").bind(board.id).first();
  return json({ board: await view(env, row, origin) });
}

// ── 큐 소비자: 메시지 1개 = 컷 1개 ──
export async function consumeCuts(batch, env) {
  for (const msg of batch.messages) {
    try {
      await handleCut(msg, env);
    } catch (err) {
      // 처리 코드 자체의 오류 — 잠시 뒤 다시 받는다
      console.error("cut consumer crashed", String(err?.message || err));
      msg.retry({ delaySeconds: 30 });
    }
  }
}

async function handleCut(msg, env) {
  const { boardId, cutId, jobId } = msg.body || {};
  const t = now();
  // 이 작업표(job_id)가 아직 유효할 때만 '생성 중'으로 잡는다. running 도 받는 것은 처리 도중 Worker 가 끊겨 다시 온 경우
  const cut = await env.DB.prepare(
    "UPDATE board_cuts SET status = 'running', attempts = attempts + 1, updated_at = ? WHERE id = ? AND job_id = ? AND status IN ('queued', 'running') RETURNING *"
  ).bind(t, cutId, jobId).first();
  if (!cut) { msg.ack(); return; } // 지워졌거나 새 작업으로 바뀐 컷
  const board = await env.DB.prepare("SELECT * FROM boards WHERE id = ?").bind(boardId).first();
  if (!board) { msg.ack(); return; }

  const fail = async (code, message) => {
    await env.DB.prepare("UPDATE board_cuts SET status = 'failed', error_code = ?, error = ?, updated_at = ? WHERE id = ? AND job_id = ?").bind(code, message, now(), cut.id, jobId).run();
    msg.ack();
  };

  if (msg.attempts > MAX_AUTO_RETRY + 1) return finish(env, boardId, fail("transient", "여러 번 시도했지만 시간이 너무 오래 걸렸어요. 잠시 뒤 이 컷만 다시 만들어 주세요."));
  if (!env.OPENAI_API_KEY) return finish(env, boardId, fail("config", "이미지를 만들 AI 가 연결되지 않았어요 (Worker 비밀값 없음). 관리자에게 알려 주세요."));

  const reference = board.persona_id ? await personaReference(env, board.persona_id) : null;
  const prompt = cutPrompt(board.style, cut.kind, JSON.parse(cut.conti), !!reference);
  try {
    const made = await generateImage(env, env.OPENAI_IMAGE_MODEL || "gpt-image-1", prompt, { size: CUT_SIZE, reference });
    if (made.bytes.byteLength > MAX_IMAGE_BYTES) throw Object.assign(new Error("image too large"), { status: 0 });
    const imageId = newImageId();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO board_images (id, board_id, cut_id, mime, bytes, prompt, model, reference, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(imageId, boardId, cut.id, made.mime, made.bytes, prompt, made.model, reference ? 1 : 0, now()),
      env.DB.prepare("UPDATE board_cuts SET status = 'done', image_id = ?, error = NULL, error_code = NULL, updated_at = ? WHERE id = ? AND job_id = ?").bind(imageId, now(), cut.id, jobId),
    ]);
    msg.ack();
  } catch (err) {
    const kind = classify(err);
    console.error("cut image failed", kind, String(err?.message || err));
    if (kind === "policy") {
      await fail("policy", "이미지 정책에 걸려 만들 수 없었어요. 장면 묘사에서 위험하거나 민감하게 읽힐 수 있는 표현을 바꿔 다시 만들어 주세요.");
    } else if (kind === "transient" && msg.attempts <= MAX_AUTO_RETRY) {
      // 자동 재시도: 화면에는 '대기'로 돌려 두고 이유를 남긴다
      await env.DB.prepare("UPDATE board_cuts SET status = 'queued', error_code = 'retrying', error = ?, updated_at = ? WHERE id = ? AND job_id = ?")
        .bind(`잠깐 문제가 생겨 다시 시도하는 중이에요 (${msg.attempts}/${MAX_AUTO_RETRY})`, now(), cut.id, jobId).run();
      msg.retry({ delaySeconds: 15 * msg.attempts });
      return;
    } else if (kind === "transient") {
      await fail("transient", "AI 서버가 바빠서 세 번 시도했지만 만들지 못했어요. 잠시 뒤 이 컷만 다시 만들어 주세요.");
    } else if (kind === "too_large") {
      await fail("unknown", "만들어진 이미지가 너무 커서 저장하지 못했어요. 이 컷만 다시 만들어 주세요.");
    } else {
      await fail("unknown", "이미지를 만들지 못했어요. 이 컷만 다시 만들어 주세요.");
    }
  }
  await settleBoard(env, boardId);
}

async function finish(env, boardId, p) { await p; await settleBoard(env, boardId); }

// 일시적인 오류: 요청 한도(429), OpenAI 서버 오류(5xx), 연결 끊김. 정책 위반: moderation · safety · content_policy
function classify(err) {
  const s = String(err?.message || "") + " " + String(err?.code || "");
  if (/moderation|safety|content_policy|policy_violation/i.test(s)) return "policy";
  if (/too large/.test(s)) return "too_large";
  const status = err?.status;
  if (status === 429 || (status >= 500 && status < 600) || status === undefined) return "transient";
  return "other";
}

// 남은 작업이 없으면 보드 상태를 정리한다: 컷과 캐릭터 시트가 모두 완료 → done('보드 완성'), 실패가 섞이면 partial
async function settleBoard(env, boardId) {
  const s = await env.DB.prepare(
    `SELECT SUM(status IN ('queued', 'running')) AS busy, SUM(status = 'done') AS done, SUM(status = 'failed') AS failed, SUM(status = 'idle') AS idle, COUNT(*) AS n
       FROM board_cuts WHERE board_id = ?`
  ).bind(boardId).first();
  if (!s || s.busy > 0) return;
  const t = now();
  if (s.done === s.n) {
    await env.DB.prepare("UPDATE boards SET status = 'done', completed_at = COALESCE(completed_at, ?), updated_at = ? WHERE id = ?").bind(t, t, boardId).run();
  } else if (s.failed > 0) {
    await env.DB.prepare("UPDATE boards SET status = 'partial', completed_at = NULL, updated_at = ? WHERE id = ? AND status != 'draft'").bind(t, boardId).run();
  } else {
    // 새로 추가한 컷(idle)이 남아 있으면 아직 완성이 아니다
    await env.DB.prepare("UPDATE boards SET status = CASE WHEN status = 'draft' THEN 'draft' ELSE 'partial' END, completed_at = NULL, updated_at = ? WHERE id = ?").bind(t, boardId).run();
  }
}

// 페르소나 프로필 사진 (3단계에서 저장한 것) — 참조 이미지로 보낸다
async function personaReference(env, personaId) {
  const img = await env.DB.prepare("SELECT mime, bytes FROM persona_images WHERE persona_id = ? ORDER BY created_at DESC LIMIT 1").bind(personaId).first();
  return img ? { mime: img.mime, bytes: blobBytes(img.bytes) } : null;
}

// ── 이미지 설명 조립 (코드) ──
export function cutPrompt(style, kind, conti, withReference) {
  const scene = kind === "sheet" ? SHEET_SCENE : conti.scene;
  const camera = kind === "sheet" ? "인물 전체가 잘리지 않는 정면 구도" : CAMERA[conti.camera] || CAMERA["상반신"];
  return [
    `[그림 스타일] ${STYLE_FIXED[style]}`,
    `[장면] ${scene}`,
    `[구도] ${camera}`,
    `[인물] ${withReference ? REFERENCE_NOTE : NO_REFERENCE_NOTE}`,
    `[제외] ${EXCLUDE_FIXED}`,
  ].join("\n");
}

// ── 보기 ──
async function view(env, b, origin) {
  const [{ results: cuts }, { results: images }] = await Promise.all([
    env.DB.prepare("SELECT * FROM board_cuts WHERE board_id = ? ORDER BY kind DESC, position").bind(b.id).all(), // 'sheet' > 'cut'
    env.DB.prepare("SELECT id, cut_id, prompt, model, reference, created_at FROM board_images WHERE board_id = ? ORDER BY created_at").bind(b.id).all(),
  ]);
  const hasPhoto = b.persona_id ? !!(await env.DB.prepare("SELECT 1 AS x FROM persona_images WHERE persona_id = ? LIMIT 1").bind(b.persona_id).first()) : false;
  const cutView = (c) => {
    const conti = JSON.parse(c.conti);
    const versions = images.filter((i) => i.cut_id === c.id).map((i) => ({ id: i.id, url: imageUrl(origin, i.id), prompt: i.prompt, model: i.model, reference: !!i.reference, createdAt: i.created_at }));
    return {
      id: c.id, kind: c.kind, position: c.position, conti, status: c.status, attempts: c.attempts, errorCode: c.error_code, error: c.error,
      image: versions.find((v) => v.id === c.image_id) || null, versions,
      nextPrompt: cutPrompt(b.style, c.kind, conti, hasPhoto), updatedAt: c.updated_at,
    };
  };
  const list = cuts.filter((c) => c.kind === "cut").map(cutView);
  const sheet = cuts.find((c) => c.kind === "sheet");
  const count = (st) => list.filter((c) => st.includes(c.status)).length;
  return {
    id: b.id, title: b.title, source: JSON.parse(b.source), style: b.style, styleLabel: STYLE_LABEL[b.style], styleText: STYLE_FIXED[b.style],
    scenario: b.scenario, contiStatus: b.conti_status, status: b.status, journeyId: b.journey_id, personaId: b.persona_id, analysisId: b.analysis_id,
    referenceReady: hasPhoto, sheet: sheet ? cutView(sheet) : null, cuts: list,
    progress: { total: list.length, done: count(["done"]), running: count(["running"]), waiting: count(["idle", "queued"]), failed: count(["failed"]) },
    createdAt: b.created_at, updatedAt: b.updated_at, completedAt: b.completed_at,
  };
}

const imageUrl = (origin, id) => `${origin}/api/boards/image/${id}`;

// ── 콘티 정리와 검사 ──
function cleanConti(c) {
  c = c && typeof c === "object" ? c : {};
  return {
    title: str(c.title, 60), situation: str(c.situation, 400), action: str(c.action, 300), line: str(c.line, 300),
    emotion: clampScore(c.emotion), place: str(c.place, 120), camera: CAMERA[c.camera] ? c.camera : "상반신", scene: str(c.scene, 600),
  };
}

function contiProblems(cuts) {
  const out = [];
  cuts.forEach((c, i) => {
    if (!c.title) out.push({ cut: i + 1, field: "title", message: `${i + 1}컷의 장면 제목이 비어 있어요.` });
    if (!c.scene) out.push({ cut: i + 1, field: "scene", message: `${i + 1}컷의 이미지용 장면 묘사가 비어 있어요.` });
    const words = appearanceWords(c.scene);
    if (words.length) out.push({ cut: i + 1, field: "scene", message: `${i + 1}컷 장면 묘사에 외모 표현이 있어요: ${words.join(", ")}. 인물의 외모는 참조 이미지가 정하니 행동과 상황만 적어 주세요.` });
  });
  return out;
}

function cleanSource(s, persona) {
  s = s && typeof s === "object" ? s : {};
  const j = s.journey && typeof s.journey === "object" ? s.journey : null;
  const p = s.pain && typeof s.pain === "object" ? s.pain : null;
  return {
    journey: j ? { id: str(j.id, 40), label: str(j.label, 200), lens: j.lens === "as-is" ? "as-is" : "to-be" } : null,
    pain: p ? { id: str(p.id, 20), text: str(p.text, 300), stage: str(p.stage, 30), journeyId: str(p.journeyId, 40) || null } : null,
    persona: persona
      ? { id: persona.id, name: persona.name, role: `${persona.job} · ${persona.age}세`, desc: str(s.persona?.desc, 600) || persona.tagline.replace(/\*\*/g, ""), photoUrl: persona.photo_url || null }
      : s.persona ? { id: null, name: str(s.persona.name, 20) || "인물", role: str(s.persona.role, 40), desc: str(s.persona.desc, 600), photoUrl: null } : null,
  };
}

async function readBody(request) {
  const raw = await request.text();
  if (!raw) return {};
  if (raw.length > MAX_BODY_CHARS) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
function str(v, n) { return typeof v === "string" ? v.trim().slice(0, n) : ""; }
function arr(v, n) { return Array.isArray(v) ? v.slice(0, n) : []; }
function clampScore(v) { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.max(-2, Math.min(2, n)) : 0; }
