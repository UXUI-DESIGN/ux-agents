-- 시나리오 보드: 보드 1장 = 1행 (저니맵 · 페인포인트 · 페르소나에서 나온 TO-BE 시나리오와 콘티)
--   컷마다 이미지 생성을 따로 처리한다 (Cloudflare Queues 메시지 1개 = 컷 1개, worker/src/boards.js 참고)
CREATE TABLE boards (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  journey_id    TEXT REFERENCES journeys(id) ON DELETE SET NULL,          -- 불러온 저니맵 (직접 입력이면 NULL)
  persona_id    TEXT REFERENCES personas(id) ON DELETE SET NULL,          -- 등장 인물 (프로필 사진을 참조 이미지로 쓴다)
  analysis_id   TEXT REFERENCES persona_analyses(id) ON DELETE SET NULL,  -- 페르소나가 나온 프로젝트 (프로젝트 화면에서 모아 본다)
  title         TEXT NOT NULL,
  source        TEXT NOT NULL,                 -- JSON 스냅숏 { journey: {id,label,lens}, pain: {id,text,stage}, persona: {id,name,role,desc,photoUrl} }
  style         TEXT NOT NULL CHECK (style IN ('sketch', 'flat', 'photo')),
  scenario      TEXT NOT NULL,                 -- TO-BE 시나리오 글 (사람이 확정한 것)
  conti_status  TEXT NOT NULL DEFAULT 'draft' CHECK (conti_status IN ('draft', 'confirmed')),
  status        TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'generating', 'done', 'partial')),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  completed_at  INTEGER
);
CREATE INDEX boards_user     ON boards(user_id, updated_at);
CREATE INDEX boards_analysis ON boards(analysis_id);

-- 컷 1개 = 1행. kind='sheet' 는 캐릭터 시트(보드마다 1행, position 0), kind='cut' 은 콘티 순서(position)대로 배치한다
--   status: idle(대기·아직 요청 전) → queued(대기·차례 기다림) → running(생성 중) → done(완료) | failed(실패)
--   job_id: 지금 유효한 작업 표. 큐 메시지의 job_id 가 이것과 다르면 지난 작업이라 버린다 (중복 방지)
CREATE TABLE board_cuts (
  id          TEXT PRIMARY KEY,
  board_id    TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL DEFAULT 'cut' CHECK (kind IN ('sheet', 'cut')),
  position    INTEGER NOT NULL,
  conti       TEXT NOT NULL,                 -- JSON { title, situation, action, line, emotion, place, camera, scene }
  status      TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle', 'queued', 'running', 'done', 'failed')),
  job_id      TEXT,
  attempts    INTEGER NOT NULL DEFAULT 0,
  error_code  TEXT,                          -- policy | transient | config | unknown
  error       TEXT,                          -- 쉬운 말로 쓴 실패 이유
  image_id    TEXT,                          -- 지금 보드에 보이는 버전 (board_images.id)
  updated_at  INTEGER NOT NULL
);
CREATE INDEX board_cuts_board ON board_cuts(board_id, kind, position);

-- 컷 이미지 버전: 다시 만들어도 지우지 않고 쌓아 두어 되돌릴 수 있게 한다
--   id 는 추측할 수 없는 무작위 값이라 <img src> 로 로그인 없이 읽는다 (페르소나 사진과 같은 방식)
CREATE TABLE board_images (
  id          TEXT PRIMARY KEY,
  board_id    TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  cut_id      TEXT NOT NULL REFERENCES board_cuts(id) ON DELETE CASCADE,
  mime        TEXT NOT NULL,
  bytes       BLOB NOT NULL,
  prompt      TEXT NOT NULL,                 -- 실제로 보낸 설명 (고정 스타일 문장 + 장면 묘사 + 구도)
  model       TEXT,
  reference   INTEGER NOT NULL DEFAULT 0,    -- 페르소나 프로필 사진을 참조 이미지로 넣었는지
  created_at  INTEGER NOT NULL
);
CREATE INDEX board_images_cut ON board_images(cut_id, created_at);
