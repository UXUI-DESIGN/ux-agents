-- 페르소나 프로필 사진: OpenAI 이미지 생성 결과를 D1에 직접 둔다 (JPEG, 수백 KB)
--   id 는 추측할 수 없는 무작위 값이라 <img src> 로 로그인 없이 읽을 수 있다 (참가자 링크와 같은 방식)
--   R2 를 붙이게 되면 bytes 대신 객체 키를 두는 것으로 바꾼다
CREATE TABLE persona_images (
  id          TEXT PRIMARY KEY,
  persona_id  TEXT NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mime        TEXT NOT NULL,
  bytes       BLOB NOT NULL,
  prompt      TEXT NOT NULL,                 -- 실제로 보낸 전체 프롬프트 (장면 + 고정 스타일)
  model       TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX persona_images_persona ON persona_images(persona_id, created_at);

-- 마지막으로 조립·수정한 장면 프롬프트 (다시 열면 그대로 보여 준다)
ALTER TABLE personas ADD COLUMN image_prompt TEXT;
