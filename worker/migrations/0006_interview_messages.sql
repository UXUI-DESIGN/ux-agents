-- 인터뷰 진행 상태: 단계(워밍업 0 → 블록 → 클로징), 쉬는 시간, 마친 시각
ALTER TABLE interviews ADD COLUMN stage INTEGER NOT NULL DEFAULT 0;
ALTER TABLE interviews ADD COLUMN paused_at INTEGER;
ALTER TABLE interviews ADD COLUMN paused_total INTEGER NOT NULL DEFAULT 0;
ALTER TABLE interviews ADD COLUMN finished_at INTEGER;

-- 대화 기록 (모더레이터·참가자 발화)
CREATE TABLE interview_messages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  interview_id TEXT NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
  role         TEXT NOT NULL,          -- moderator | participant
  content      TEXT NOT NULL,
  stage        INTEGER,
  created_at   INTEGER NOT NULL
);
CREATE INDEX interview_messages_interview ON interview_messages(interview_id, id);
