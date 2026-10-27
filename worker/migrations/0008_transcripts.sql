-- 세션 링크 닫은 시각
ALTER TABLE interview_sessions ADD COLUMN closed_at INTEGER;

-- 전사 마스킹: 개인을 특정할 수 있는 구간 [{s, e, kind, src: auto|manual, on: true|false}] (s·e는 글자 위치)
ALTER TABLE interview_messages ADD COLUMN pii TEXT;
ALTER TABLE interview_messages ADD COLUMN pii_checked_at INTEGER;

-- 리서처 메모: 발화마다 관찰과 해석을 따로 (스킬의 발화/관찰/해석 분리)
CREATE TABLE message_notes (
  message_id     INTEGER PRIMARY KEY REFERENCES interview_messages(id) ON DELETE CASCADE,
  observation    TEXT NOT NULL DEFAULT '',
  interpretation TEXT NOT NULL DEFAULT '',
  updated_at     INTEGER NOT NULL
);
