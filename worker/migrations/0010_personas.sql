-- 페르소나: 문서 1장 = 1행. 컬럼 구조는 shared/persona.ts 의 PersonaRow 와 1:1 로 맞춘다
--   목록·검색에 쓰는 값(이름·나이·직업·우선순위 등)은 낱개 컬럼,
--   구조가 있는 값(취미·행동·페인포인트·니즈)은 JSON 문자열 컬럼
CREATE TABLE personas (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id  TEXT REFERENCES interview_sessions(id) ON DELETE SET NULL, -- 바탕이 된 인터뷰 세션 (없을 수 있음)

  -- 상단: 배지 + 한 줄 요약
  priority    TEXT NOT NULL DEFAULT 'primary' CHECK (priority IN ('primary', 'secondary', 'tertiary')),
  tagline     TEXT NOT NULL,                 -- 강조 구간은 **…**
  photo_url   TEXT,                          -- NULL 이면 실루엣 플레이스홀더

  -- 왼쪽 패널 Profile
  name        TEXT NOT NULL,
  gender      TEXT NOT NULL,
  age         INTEGER NOT NULL,
  hobbies     TEXT NOT NULL DEFAULT '[]',    -- JSON string[]
  job         TEXT NOT NULL,

  -- 오른쪽 상단: 서비스 이용 환경 · 성격 · 이용 동기
  environment TEXT NOT NULL,
  personality TEXT NOT NULL,
  motivation  TEXT NOT NULL,

  -- Lifestyle 단락
  lifestyle   TEXT NOT NULL,

  -- 하단 3열
  behavior    TEXT NOT NULL DEFAULT '{"tagGroups":[],"scales":[]}', -- JSON { tagGroups:[{title,tags[]}], scales:[{label,value,lowLabel?,highLabel?}] }
  painpoints  TEXT NOT NULL DEFAULT '[]',    -- JSON [{title, description}]
  needs       TEXT NOT NULL DEFAULT '[]',    -- JSON [{title, description}]

  -- 왼쪽 패널 하단 인용
  quote       TEXT NOT NULL,                 -- 강조 구간은 **…**

  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX personas_user    ON personas(user_id, updated_at);
CREATE INDEX personas_session ON personas(session_id);
