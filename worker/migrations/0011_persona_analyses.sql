-- 페르소나 생성 묶음(프로젝트): 한 번의 생성 = 어피니티 분석 1건 + 페르소나 N명
--   목록 화면은 이 묶음 단위로 카드를 모은다. 분석 결과는 근거 추적용으로 함께 둔다
CREATE TABLE persona_analyses (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  service     TEXT NOT NULL,                 -- 서비스 한 줄 설명 (묶음 이름으로도 쓴다)
  kind        TEXT NOT NULL DEFAULT 'design' CHECK (kind IN ('design', 'marketing')),
  count       INTEGER NOT NULL,              -- 요청한 페르소나 수
  sources     TEXT NOT NULL,                 -- JSON [{ interview_id, session_id, session_name, code }]
  analysis    TEXT,                          -- JSON 어피니티 분석 결과 (notes · clusters · themes · segments)
  meta        TEXT,                          -- JSON: 모델 · 소요 시간 · 읽은 글자 수 · 제외 발화 수
  status      TEXT NOT NULL DEFAULT 'analyzed', -- analyzed → composed
  created_at  INTEGER NOT NULL
);
CREATE INDEX persona_analyses_user ON persona_analyses(user_id, created_at);

ALTER TABLE personas ADD COLUMN analysis_id TEXT REFERENCES persona_analyses(id) ON DELETE SET NULL;
ALTER TABLE personas ADD COLUMN evidence TEXT;   -- JSON: 항목별 근거 발화 번호 { painpoints: [[refs]], needs: [[refs]], behavior: [refs], hypotheses: [..] }
ALTER TABLE personas ADD COLUMN share TEXT;      -- 세그먼트 비중(추정). 예: "약 40%"
CREATE INDEX personas_analysis ON personas(analysis_id);
