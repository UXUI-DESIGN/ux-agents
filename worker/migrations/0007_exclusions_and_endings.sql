-- 참가자가 "이 얘기는 빼주세요"라고 한 구간: 저장은 하되 분석에서 제외
ALTER TABLE interview_messages ADD COLUMN excluded INTEGER NOT NULL DEFAULT 0;

-- interviews.status: consented → in_progress → completed(클로징까지 마침) | stopped(기록 남기고 중간 종료) | withdrawn(철회: 기록 삭제, 건수만)
CREATE INDEX interviews_session_status ON interviews(session_id, status);
