-- 페르소나 채팅용 벡터 저장소 (RAG)
--   생성 묶음(persona_analyses) 단위로 '근거 노트'를 임베딩해 둔다. 같은 분석에서 나온 페르소나들이 함께 쓴다.
--   kind: note(어피니티 노트 N###) · theme(테마 통찰 T##) · utterance(참가자 원 발화 U###) · persona(페르소나 문서 요약 D##)
--   embedding: float32 배열 BLOB (OpenAI text-embedding-3-small, 1536차원). 검색은 Worker 안에서 코사인 유사도로 한다.
--   Cloudflare Vectorize 로 옮길 때는 embedding 컬럼 대신 Vectorize id 만 남기면 된다.
CREATE TABLE rag_chunks (
  id          TEXT PRIMARY KEY,
  analysis_id TEXT NOT NULL REFERENCES persona_analyses(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  ref_id      TEXT NOT NULL,                 -- 답변에 표기하는 노트 ID. 예: N012, T03, U045, D01
  code        TEXT,                          -- 참가자 코드 (있으면)
  source_ref  TEXT,                          -- 원 발화 번호 (예: P01-3)
  text        TEXT NOT NULL,
  embedding   BLOB NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX rag_chunks_analysis ON rag_chunks(analysis_id, kind);
CREATE UNIQUE INDEX rag_chunks_ref ON rag_chunks(analysis_id, ref_id);

ALTER TABLE persona_analyses ADD COLUMN indexed_at INTEGER;
ALTER TABLE persona_analyses ADD COLUMN index_meta TEXT;   -- JSON: 모델 · 조각 수 · 종류별 수
