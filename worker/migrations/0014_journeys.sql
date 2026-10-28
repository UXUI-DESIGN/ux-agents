-- 저니맵: 지도 1장 = 1행 (페르소나 1명 × 시나리오 1개)
--   AS-IS 를 확정하면 같은 단계 골격으로 TO-BE 를 만들 수 있다 (parent_id = AS-IS id)
--   map 은 단계·레인·칸 출처(ai/human)·HMW 기회·해석 메모를 담은 JSON (worker/src/journeys.js 의 cleanMap 참고)
CREATE TABLE journeys (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  persona_id   TEXT REFERENCES personas(id) ON DELETE SET NULL,          -- 불러온 페르소나 (직접 입력이면 NULL)
  analysis_id  TEXT REFERENCES persona_analyses(id) ON DELETE SET NULL,  -- 페르소나가 나온 프로젝트(분석 묶음)
  persona      TEXT NOT NULL,                 -- JSON 스냅숏 { name, role, desc, source }
  scenario     TEXT NOT NULL,
  lens         TEXT NOT NULL DEFAULT 'as-is' CHECK (lens IN ('as-is', 'to-be')),
  parent_id    TEXT REFERENCES journeys(id) ON DELETE CASCADE,           -- TO-BE 가 바탕으로 삼은 AS-IS
  version      TEXT NOT NULL,                 -- 같은 페르소나·시나리오 안에서 A, B, C …
  status       TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'confirmed')),
  map          TEXT NOT NULL,                 -- JSON
  meta         TEXT,                          -- JSON: 모델 · 소요 시간 · AI가 받은 정보 요약
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  confirmed_at INTEGER
);
CREATE INDEX journeys_user    ON journeys(user_id, updated_at);
CREATE INDEX journeys_persona ON journeys(persona_id);
CREATE INDEX journeys_parent  ON journeys(parent_id);
