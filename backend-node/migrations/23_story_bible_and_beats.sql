-- 剧本三段式：故事圣经（全剧不变量）与分集节拍表
ALTER TABLE dramas ADD COLUMN story_bible TEXT;
ALTER TABLE episodes ADD COLUMN beat_sheet TEXT;
ALTER TABLE episodes ADD COLUMN summary TEXT;
