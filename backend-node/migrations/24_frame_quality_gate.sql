-- 首帧质检闸门：VLM 评分与报告，以及自动重试计数
ALTER TABLE image_generations ADD COLUMN qa_score REAL;
ALTER TABLE image_generations ADD COLUMN qa_report TEXT;
ALTER TABLE image_generations ADD COLUMN qa_attempt INTEGER DEFAULT 0;
