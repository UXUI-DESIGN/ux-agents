-- 인터뷰 세션: 만들 때의 가이드 내용을 guide_snapshot에 복사해 둔다 (원본 가이드를 고쳐도 세션은 그대로)
CREATE TABLE interview_sessions (
  id                    TEXT PRIMARY KEY,
  user_id               TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  guide_id              TEXT,               -- 원본 가이드 (지워져도 세션은 남는다)
  guide_title           TEXT NOT NULL,
  guide_snapshot        TEXT NOT NULL,      -- JSON
  name                  TEXT NOT NULL,
  purpose               TEXT NOT NULL,
  duration              INTEGER NOT NULL,
  expected_participants INTEGER,
  collect               TEXT NOT NULL,      -- JSON 배열: 참가자에게 받을 항목 키
  consent               TEXT NOT NULL,
  link_token            TEXT NOT NULL UNIQUE, -- 참가자 링크용 무작위 값
  status                TEXT NOT NULL DEFAULT 'open',
  created_at            INTEGER NOT NULL
);
CREATE INDEX interview_sessions_user ON interview_sessions(user_id, created_at);

-- 참가자 인터뷰: 같은 링크로 들어와도 들어올 때마다 별도 행
CREATE TABLE interviews (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES interview_sessions(id) ON DELETE CASCADE,
  status     TEXT NOT NULL DEFAULT 'started',
  profile    TEXT,                          -- JSON: 세션에서 고른 항목의 답
  created_at INTEGER NOT NULL
);
CREATE INDEX interviews_session ON interviews(session_id, created_at);
