// 인터뷰 가이드 저장·불러오기 (로그인한 사용자만, 자기 가이드만)
//   모든 조회·수정·삭제는 WHERE user_id = 로그인한 사용자 로 묶는다.
//   남의 가이드 id를 넣어도 '없는 가이드'(404)로만 보인다.
//   GET    /api/guides        내 가이드 목록
//   POST   /api/guides        { title, input, content } 새로 저장
//   GET    /api/guides/:id    하나 열기
//   PUT    /api/guides/:id    { title, input, content } 덮어쓰기
//   PATCH  /api/guides/:id    { title } 이름 바꾸기
//   DELETE /api/guides/:id    삭제

import { currentUser } from "./auth.js";

const MAX_BODY_CHARS = 200000;
const MAX_TITLE = 100;
const NOT_FOUND = { error: "가이드를 찾을 수 없어요.", code: "not_found" };

export async function guides(request, env, json, id) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: "로그인이 필요해요.", code: "unauthorized" }, 401);
  const now = Math.floor(Date.now() / 1000);
  const method = request.method;

  if (!id && method === "GET") {
    const { results } = await env.DB.prepare(
      `SELECT id, title, json_extract(input, '$.target') AS target, json_extract(input, '$.type') AS type,
              created_at, COALESCE(updated_at, created_at) AS updated_at
         FROM guides WHERE user_id = ? ORDER BY COALESCE(updated_at, created_at) DESC`
    ).bind(user.id).all();
    return json({ guides: results });
  }

  if (!id && method === "POST") {
    const body = await readGuide(request, json);
    if (body instanceof Response) return body;
    const newId = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO guides (id, user_id, title, input, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(newId, user.id, body.title, JSON.stringify(body.input), JSON.stringify(body.content), now, now).run();
    return json({ id: newId, title: body.title }, 201);
  }

  if (!id || !/^[0-9a-f-]{36}$/.test(id)) return json(NOT_FOUND, 404);

  if (method === "GET") {
    const row = await env.DB.prepare(
      "SELECT id, title, input, content, created_at, COALESCE(updated_at, created_at) AS updated_at FROM guides WHERE id = ? AND user_id = ?"
    ).bind(id, user.id).first();
    if (!row) return json(NOT_FOUND, 404);
    return json({ guide: { ...row, input: JSON.parse(row.input), content: JSON.parse(row.content) } });
  }

  if (method === "PUT") {
    const body = await readGuide(request, json);
    if (body instanceof Response) return body;
    const { meta } = await env.DB.prepare("UPDATE guides SET title = ?, input = ?, content = ?, updated_at = ? WHERE id = ? AND user_id = ?")
      .bind(body.title, JSON.stringify(body.input), JSON.stringify(body.content), now, id, user.id).run();
    if (!meta.changes) return json(NOT_FOUND, 404);
    return json({ id, title: body.title });
  }

  if (method === "PATCH") {
    let body;
    try { body = await request.json(); } catch { return json({ error: "JSON 본문이 필요해요." }, 400); }
    const title = cleanTitle(body.title);
    if (!title) return json({ error: "제목을 적어 주세요.", field: "title" }, 400);
    const { meta } = await env.DB.prepare("UPDATE guides SET title = ?, updated_at = ? WHERE id = ? AND user_id = ?")
      .bind(title, now, id, user.id).run();
    if (!meta.changes) return json(NOT_FOUND, 404);
    return json({ id, title });
  }

  if (method === "DELETE") {
    const { meta } = await env.DB.prepare("DELETE FROM guides WHERE id = ? AND user_id = ?").bind(id, user.id).run();
    if (!meta.changes) return json(NOT_FOUND, 404);
    return json({ ok: true });
  }

  return json({ error: "없는 경로예요." }, 404);
}

const cleanTitle = (t) => (typeof t === "string" ? t.trim().slice(0, MAX_TITLE) : "");

// 저장 본문을 읽고 검사한다. 문제가 있으면 오류 응답을 돌려준다
async function readGuide(request, json) {
  const raw = await request.text();
  if (raw.length > MAX_BODY_CHARS) return json({ error: "가이드가 너무 커서 저장할 수 없어요." }, 413);
  let body;
  try { body = JSON.parse(raw); } catch { return json({ error: "JSON 본문이 필요해요." }, 400); }
  const title = cleanTitle(body.title);
  if (!title) return json({ error: "제목을 적어 주세요.", field: "title" }, 400);
  if (!body.input || typeof body.input !== "object" || !body.content || typeof body.content !== "object") {
    return json({ error: "저장할 가이드 내용이 없어요." }, 400);
  }
  return { title, input: body.input, content: body.content };
}
