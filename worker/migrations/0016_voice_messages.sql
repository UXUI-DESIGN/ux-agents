-- 발화가 글로 온 것인지 음성을 받아쓴 것인지: text | voice (음성 파일 자체는 저장하지 않는다)
ALTER TABLE interview_messages ADD COLUMN mode TEXT NOT NULL DEFAULT 'text';
