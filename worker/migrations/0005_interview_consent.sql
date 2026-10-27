-- 참가자 코드(P01, P02…)와 동의 기록, 새로고침해도 같은 인터뷰로 돌아오기 위한 열쇠(해시만 저장)
ALTER TABLE interviews ADD COLUMN seq INTEGER;
ALTER TABLE interviews ADD COLUMN code TEXT;
ALTER TABLE interviews ADD COLUMN consents TEXT;      -- JSON: 항목별 동의
ALTER TABLE interviews ADD COLUMN consented_at INTEGER;
ALTER TABLE interviews ADD COLUMN key_hash TEXT;
CREATE UNIQUE INDEX interviews_session_seq ON interviews(session_id, seq);
CREATE UNIQUE INDEX interviews_key ON interviews(key_hash);
