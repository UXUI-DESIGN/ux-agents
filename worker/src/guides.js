// 인터뷰 가이드 저장 (로그인한 사용자만)

import { currentUser } from "./auth.js";

const MAX_BODY_CHARS = 200000;

export async function saveGuide(request, env, json) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: "로그인이 필요해요.", code: "unauthorized" }, 401);

  const raw = await request.text();
  if (raw.length > MAX_BODY_CHARS) return json({ error: "가이드가 너무 커서 저장할 수 없어요." }, 413);
  let body;
  try { body = JSON.parse(raw); } catch { return json({ error: "JSON 본문이 필요해요." }, 400); }

  const title = typeof body.title === "string" ? body.title.trim().slice(0, 100) : "";
  if (!title || typeof body.input !== "object" || typeof body.content !== "object") {
    return json({ error: "저장할 가이드 내용이 없어요." }, 400);
  }

  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO guides (id, user_id, title, input, content, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(id, user.id, title, JSON.stringify(body.input), JSON.stringify(body.content), Math.floor(Date.now() / 1000)).run();
  return json({ id }, 201);
}
