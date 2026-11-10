-- 인터뷰 데이터분석: 한 번의 분석 = ①준비·정제 ②코딩 (coding) → ③패턴 ④합성 ⑤교차검증 계획 (synthesis)
--   user_id 가 NULL 이면 로그인 없이 돌린 분석(샘플·붙여넣기)이다. id 를 아는 사람만 열 수 있고 7일 뒤 지운다
CREATE TABLE interview_analyses (
  id          TEXT PRIMARY KEY,
  user_id     TEXT REFERENCES users(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('moderator', 'paste', 'sample')),
  sources     TEXT NOT NULL,                 -- JSON [{ code, label, interview_id?, session_id?, session_name?, lines }]
  options     TEXT NOT NULL,                 -- JSON { goal, stage, approach, apriori }
  coding      TEXT,                          -- JSON ①② 참가자 매트릭스 · 코드북 · 코딩된 발췌(OBS) · 해석(INT)
  synthesis   TEXT,                          -- JSON ③④⑤ 테마 · 모순 · 약 신호 · 인사이트 카드 · TL;DR · 교차검증 계획 · 품질 게이트
  meta        TEXT,                          -- JSON 모델 · 소요 시간 · 읽은 글자 수 · 검증 결과
  status      TEXT NOT NULL DEFAULT 'coded', -- coded → synthesized
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX interview_analyses_user ON interview_analyses(user_id, created_at);
