-- 剧本自动评审与跨集动态连续性
ALTER TABLE episodes ADD COLUMN story_state TEXT;
ALTER TABLE episodes ADD COLUMN quality_report TEXT;
