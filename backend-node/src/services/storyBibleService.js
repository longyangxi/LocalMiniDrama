/**
 * 剧本三段式生成：故事圣经 → 分集节拍表 → 逐集正文。
 *
 * 与旧的「一次调用吐 N 集 JSON」相比：
 *   - 每次调用只做一件事，输出长度可控，后几集不再注水；
 *   - 故事圣经是跨集不变量，角色/世界观不再逐集漂移；
 *   - 正文以纯文本返回，绕开 JSON 截断与转义问题；
 *   - 提示词里内置 AI 可拍性约束（场景数、同框人数、禁止精细手部交互等），
 *     从源头减少后续图/视频阶段的废片。
 */

const aiClient = require('./aiClient');
const promptI18n = require('./promptI18n');
const craft = require('./storyCraftPrompts');
const { safeParseAIJSON } = require('../utils/safeJson');

/** 从模型返回里取出对象（容忍被包进 {data:…}/{bible:…} 的情况） */
function coerceObject(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (parsed.title || parsed.logline || parsed.characters) return parsed;
  for (const key of ['bible', 'story_bible', 'data', 'result']) {
    const v = parsed[key];
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  }
  return parsed;
}

/** 从模型返回里取出数组（容忍 {episodes:[…]} 之类的包装） */
function coerceArray(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object') {
    const key = Object.keys(parsed).find((k) => Array.isArray(parsed[k]));
    if (key) return parsed[key];
  }
  return null;
}

/** 第一段：生成故事圣经 */
async function generateStoryBible(db, log, { premise, style, type, episodeCount, model, cfg }) {
  const isEn = promptI18n.isEnglish(cfg);
  const systemPrompt = craft.getStoryBibleSystemPrompt(isEn, episodeCount);
  const userPrompt = promptI18n.buildStoryExpansionUserPrompt(cfg, premise, style, type, episodeCount);

  const raw = await aiClient.generateText(db, log, 'text', userPrompt, systemPrompt, {
    scene_key: 'story_bible',
    model: model || undefined,
    temperature: 0.85,
    min_max_tokens: 3000,
  });

  let bible = null;
  try {
    bible = coerceObject(safeParseAIJSON(raw, log));
  } catch (err) {
    log?.warn?.('[剧本] 故事圣经 JSON 解析失败', { error: err.message });
  }
  if (!bible || (!bible.logline && !Array.isArray(bible.characters))) {
    throw new Error('AI 未能生成有效的故事圣经，请重试或换用更强的文本模型');
  }
  log?.info?.('[剧本] 故事圣经已生成', {
    title: bible.title,
    characters: Array.isArray(bible.characters) ? bible.characters.length : 0,
    locations: Array.isArray(bible.locations) ? bible.locations.length : 0,
  });
  return bible;
}

/** 第二段：生成分集节拍表 */
async function generateBeatSheet(db, log, { bible, episodeCount, model, cfg }) {
  const isEn = promptI18n.isEnglish(cfg);
  const n = Math.max(1, Number(episodeCount) || 1);
  const systemPrompt = craft.getBeatSheetSystemPrompt(isEn, n);
  const userPrompt = craft.buildBeatSheetUserPrompt(isEn, bible, n);

  const raw = await aiClient.generateText(db, log, 'text', userPrompt, systemPrompt, {
    scene_key: 'story_beat_sheet',
    model: model || undefined,
    temperature: 0.8,
    min_max_tokens: Math.max(2500, n * 700),
  });

  let list = null;
  try {
    list = coerceArray(safeParseAIJSON(raw, log));
  } catch (err) {
    log?.warn?.('[剧本] 节拍表 JSON 解析失败', { error: err.message });
  }
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error('AI 未能生成有效的分集节拍表，请重试');
  }

  const normalized = list.slice(0, n).map((ep, i) => ({
    episode: Number(ep?.episode ?? i + 1) || i + 1,
    title: String(ep?.title || `第${i + 1}集`).trim(),
    summary: String(ep?.summary || '').trim(),
    location_plan: Array.isArray(ep?.location_plan) ? ep.location_plan : [],
    hook: String(ep?.hook || '').trim(),
    cliffhanger: String(ep?.cliffhanger || '').trim(),
    beats: Array.isArray(ep?.beats) ? ep.beats : [],
  }));

  // 模型少给了几集时补空壳，保证集数与用户要求一致
  while (normalized.length < n) {
    const idx = normalized.length + 1;
    normalized.push({ episode: idx, title: `第${idx}集`, summary: '', location_plan: [], hook: '', cliffhanger: '', beats: [] });
  }

  log?.info?.('[剧本] 节拍表已生成', {
    episodes: normalized.length,
    total_beats: normalized.reduce((s, e) => s + e.beats.length, 0),
  });
  return normalized;
}

/** 取正文结尾若干字，作为下一集的接续上下文 */
function tailOf(text, maxChars = 300) {
  const s = String(text || '').trim();
  return s.length <= maxChars ? s : s.slice(-maxChars);
}

/** 第三段：逐集生成正文（串行，每集带上一集结尾） */
async function generateEpisodeScripts(db, log, { bible, beatSheet, model, cfg, wordsPerEpisode, onProgress }) {
  const isEn = promptI18n.isEnglish(cfg);
  const bibleDigest = craft.buildBibleDigest(bible, isEn);
  const systemPrompt = craft.getEpisodeScriptSystemPrompt(isEn, wordsPerEpisode);
  const total = beatSheet.length;
  const episodes = [];
  let prevTail = '';

  for (let i = 0; i < total; i++) {
    const beat = beatSheet[i];
    const userPrompt = craft.buildEpisodeScriptUserPrompt(isEn, {
      bibleDigest,
      episodeBeat: beat,
      prevTail,
      episodeNumber: beat.episode,
      totalEpisodes: total,
    });

    let body = '';
    try {
      body = await aiClient.generateText(db, log, 'text', userPrompt, systemPrompt, {
        scene_key: 'story_episode_script',
        model: model || undefined,
        temperature: 0.85,
        min_max_tokens: Math.max(1800, Math.round((Number(wordsPerEpisode) || 800) * 2.5)),
      });
    } catch (err) {
      log?.error?.('[剧本] 单集正文生成失败', { episode: beat.episode, error: err.message });
      throw new Error(`第 ${beat.episode} 集正文生成失败：${err.message}`);
    }

    // 模型偶尔仍会套 markdown 代码块或加标题行，这里剥掉
    const content = String(body || '')
      .replace(/^```[a-zA-Z]*\s*\n?/, '')
      .replace(/\n?```\s*$/, '')
      .replace(/^\s*#{1,6}\s*.*\n/, '')
      .trim();

    if (!content) {
      throw new Error(`第 ${beat.episode} 集正文为空`);
    }

    episodes.push({
      episode: beat.episode,
      title: beat.title,
      content,
      summary: beat.summary,
      beat_sheet: beat,
    });
    prevTail = tailOf(content);

    onProgress?.(i + 1, total);
    log?.info?.('[剧本] 单集正文完成', { episode: beat.episode, chars: content.length });
  }

  return episodes;
}

/**
 * 三段式全流程。
 * @returns {{ bible:object, episodes:Array<{episode,title,content,summary,beat_sheet}> }}
 */
async function generateStoryThreeStage(db, log, body, { onStage } = {}) {
  const premise = String(body.premise || body.prompt || body.text || '').trim();
  if (!premise) throw new Error('请提供故事梗概');

  const cfg = require('../config').loadConfig();
  const episodeCount = Math.max(1, Math.floor(Number(body.episode_count) || 1));
  const model = body.model || undefined;
  const wordsPerEpisode = Math.max(300, Number(body.words_per_episode) || 800);
  const common = { model, cfg, episodeCount };

  onStage?.('bible', 15, '正在搭建故事圣经（人设 / 世界观 / 关系）...');
  const bible = await generateStoryBible(db, log, {
    premise, style: body.style || body.genre || null, type: body.type || null, ...common,
  });

  onStage?.('beats', 35, '正在排布分集节拍表（钩子 / 反转 / 卡点）...');
  const beatSheet = await generateBeatSheet(db, log, { bible, ...common });

  onStage?.('scripts', 45, `正在逐集撰写正文（共 ${beatSheet.length} 集）...`);
  const episodes = await generateEpisodeScripts(db, log, {
    bible, beatSheet, model, cfg, wordsPerEpisode,
    onProgress: (done, total) => {
      onStage?.('scripts', 45 + Math.round((done / total) * 40), `已完成 ${done}/${total} 集正文`);
    },
  });

  return { bible, episodes };
}

module.exports = {
  generateStoryBible,
  generateBeatSheet,
  generateEpisodeScripts,
  generateStoryThreeStage,
};
