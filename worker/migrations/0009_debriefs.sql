-- 세션 디브리핑: 고치는 중인 초안(draft)과 확정본(final)을 따로 둔다. 확정본만 '내 디브리핑'에 모인다
CREATE TABLE debriefs (
  session_id       TEXT PRIMARY KEY REFERENCES interview_sessions(id) ON DELETE CASCADE,
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  draft            TEXT,        -- JSON
  draft_meta       TEXT,        -- JSON: 만든 시각·모델·읽은 참가자 코드
  draft_updated_at INTEGER,
  final            TEXT,        -- JSON
  final_meta       TEXT,
  finalized_at     INTEGER
);
CREATE INDEX debriefs_user ON debriefs(user_id, finalized_at);
