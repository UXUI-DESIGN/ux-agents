-- 회원: 비밀번호는 PBKDF2 해시로만 저장한다 (원래 값은 저장하지 않음)
CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  agreed_at     INTEGER NOT NULL,
  created_at    INTEGER NOT NULL
);

-- 로그인 세션: 토큰 원문이 아니라 SHA-256 해시만 저장한다
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);

-- 가입 시도 기록 (짧은 시간 반복 시도 차단용). key에는 IP의 해시만 남긴다
CREATE TABLE auth_attempts (
  key        TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX auth_attempts_key ON auth_attempts(key, created_at);
