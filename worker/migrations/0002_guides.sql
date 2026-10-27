-- 저장한 인터뷰 가이드 (입력값과 생성 결과를 JSON으로 보관)
CREATE TABLE guides (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  input      TEXT NOT NULL,
  content    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX guides_user ON guides(user_id, created_at);
