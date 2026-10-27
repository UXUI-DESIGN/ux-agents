-- 덮어쓰기·이름 바꾸기 시각 (목록의 '저장한 날짜')
ALTER TABLE guides ADD COLUMN updated_at INTEGER;
UPDATE guides SET updated_at = created_at WHERE updated_at IS NULL;
