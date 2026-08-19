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
async function generateStoryBible(db, log, { premise, style, type, episodeCount, model, cfg, creativePreferences }) {
  const isEn = promptI18n.isEnglish(cfg);
  const systemPrompt = craft.getStoryBibleSystemPrompt(isEn, episodeCount);
  const preferenceBlock = craft.buildCreativePreferencesBlock(isEn, creativePreferences);
  const userPrompt = [promptI18n.buildStoryExpansionUserPrompt(cfg, premise, style, type, episodeCount), preferenceBlock]
    .filter(Boolean).join('\n\n');

  const requestBible = async (prompt, temperature, tag) => {
    const raw = await aiClient.generateText(db, log, 'text', prompt, systemPrompt, {
      scene_key: 'story_bible',
      model: model || undefined,
      temperature,
      min_max_tokens: 3600,
    });
    try {
      return coerceObject(safeParseAIJSON(raw, log));
    } catch (err) {
      log?.warn?.(`[剧本] 故事圣经${tag} JSON 解析失败`, { error: err.message });
      return null;
    }
  };
  const isComplete = (candidate) => {
    if (!candidate?.logline || !candidate?.theme_question || !candidate?.emotional_promise) return false;
    if (!Array.isArray(candidate.characters) || candidate.characters.length === 0) return false;
    const protagonist = candidate.characters.find((c) => c?.role === 'main') || candidate.characters[0];
    return !!(protagonist?.want && protagonist?.need && protagonist?.arc && protagonist?.contradiction);
  };

  let bible = await requestBible(userPrompt, 0.72, '');
  if (!isComplete(bible)) {
    log?.warn?.('[剧本] 故事圣经内核字段不完整，执行一次定向修复');
    const repairPrompt = `${userPrompt}\n\n【修复要求】上一版缺少创作内核字段。请返回完整故事圣经；theme_question、emotional_promise 必填，主角的 want、need、arc、contradiction 必填。保留已成立的独特细节，不要把故事改回通用模板。上一版：\n${JSON.stringify(bible || {})}`;
    bible = await requestBible(repairPrompt, 0.35, '修复版');
  }
  if (!isComplete(bible)) {
    throw new Error('AI 未能生成结构完整的故事圣经，请重试或换用更强的文本模型');
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

  const requestBeatSheet = async (prompt, temperature, tag) => {
    const raw = await aiClient.generateText(db, log, 'text', prompt, systemPrompt, {
      scene_key: 'story_beat_sheet',
      model: model || undefined,
      temperature,
      min_max_tokens: Math.max(2500, n * 850),
    });
    try {
      return coerceArray(safeParseAIJSON(raw, log));
    } catch (err) {
      log?.warn?.(`[剧本] 节拍表${tag} JSON 解析失败`, { error: err.message });
      return null;
    }
  };
  const normalize = (list) => Array.isArray(list) ? list.slice(0, n).map((ep, i) => ({
    episode: Number(ep?.episode ?? i + 1) || i + 1,
    title: String(ep?.title || `第${i + 1}集`).trim(),
    summary: String(ep?.summary || '').trim(),
    location_plan: Array.isArray(ep?.location_plan) ? ep.location_plan : [],
    hook: String(ep?.hook || '').trim(),
    cliffhanger: String(ep?.cliffhanger || '').trim(),
    episode_desire: String(ep?.episode_desire || '').trim(),
    choice_and_cost: String(ep?.choice_and_cost || '').trim(),
    value_change: String(ep?.value_change || '').trim(),
    payoff_ids: Array.isArray(ep?.payoff_ids) ? ep.payoff_ids : [],
    beats: Array.isArray(ep?.beats) ? ep.beats : [],
  })) : [];
  const isComplete = (items) => items.length === n && items.every((ep) =>
    ep.hook && ep.cliffhanger && ep.episode_desire && ep.choice_and_cost && ep.value_change && ep.beats.length >= 4
  );

  let list = await requestBeatSheet(userPrompt, 0.72, '');
  let normalized = normalize(list);
  if (!isComplete(normalized)) {
    log?.warn?.('[剧本] 节拍表字段不完整，执行一次定向修复', { received: normalized.length, expected: n });
    const repairPrompt = `${userPrompt}\n\n【修复要求】上一版缺集或缺少必要字段。请重新返回完整的 ${n} 集；每集 hook、cliffhanger、episode_desire、choice_and_cost、value_change 均不得为空，beats 至少4项。上一版仅供定位问题：\n${JSON.stringify(normalized)}`;
    list = await requestBeatSheet(repairPrompt, 0.35, '修复版');
    normalized = normalize(list);
  }
  if (!isComplete(normalized)) {
    throw new Error('AI 未能生成结构完整的分集节拍表，请重试或换用更强的文本模型');
  }

  log?.info?.('[剧本] 节拍表已生成', {
    episodes: normalized.length,
    total_beats: normalized.reduce((s, e) => s + e.beats.length, 0),
  });
  return normalized;
}

async function reviewAndPolishEpisode(db, log, { bibleDigest, previousState, episodeBeat, draft, model, cfg }) {
  const isEn = promptI18n.isEnglish(cfg);
  const userPrompt = craft.buildEpisodePolishUserPrompt(isEn, { bibleDigest, previousState, episodeBeat, draft });
  const systemPrompt = craft.getEpisodePolishSystemPrompt(isEn);
  try {
    const raw = await aiClient.generateText(db, log, 'text', userPrompt, systemPrompt, {
      scene_key: 'story_episode_polish',
      model: model || undefined,
      temperature: 0.35,
      min_max_tokens: Math.max(2400, Math.round(String(draft || '').length * 2.2)),
    });
    const parsed = coerceObject(safeParseAIJSON(raw, log));
    if (!parsed || !String(parsed.revised_script || '').trim()) throw new Error('评审结果缺少 revised_script');
    return {
      content: String(parsed.revised_script).trim(),
      qualityReport: parsed.quality_report && typeof parsed.quality_report === 'object' ? parsed.quality_report : null,
      storyState: parsed.continuity_state && typeof parsed.continuity_state === 'object' ? parsed.continuity_state : previousState,
    };
  } catch (err) {
    log?.warn?.('[剧本] 自动打磨失败，保留初稿继续生成', { episode: episodeBeat?.episode, error: err.message });
    return { content: draft, qualityReport: { skipped: true, reason: err.message }, storyState: previousState };
  }
}

/** 取正文结尾若干字，作为下一集的接续上下文 */
function tailOf(text, maxChars = 300) {
  const s = String(text || '').trim();
  return s.length <= maxChars ? s : s.slice(-maxChars);
}

/** 第三段：逐集生成正文（串行，每集带上一集结尾） */
async function generateEpisodeScripts(db, log, { bible, beatSheet, model, cfg, wordsPerEpisode, onProgress, autoPolish = true }) {
  const isEn = promptI18n.isEnglish(cfg);
  const bibleDigest = craft.buildBibleDigest(bible, isEn);
  const systemPrompt = craft.getEpisodeScriptSystemPrompt(isEn, wordsPerEpisode);
  const total = beatSheet.length;
  const episodes = [];
  let prevTail = '';
  let storyState = null;

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

    let finalContent = content;
    let qualityReport = null;
    if (autoPolish) {
      const polished = await reviewAndPolishEpisode(db, log, {
        bibleDigest,
        previousState: storyState,
        episodeBeat: beat,
        draft: content,
        model,
        cfg,
      });
      finalContent = polished.content;
      qualityReport = polished.qualityReport;
      storyState = polished.storyState;
    }

    episodes.push({
      episode: beat.episode,
      title: beat.title,
      content: finalContent,
      summary: beat.summary,
      beat_sheet: beat,
      story_state: storyState,
      quality_report: qualityReport,
    });
    prevTail = tailOf(finalContent);

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
    premise,
    style: body.style || body.genre || null,
    type: body.type || null,
    creativePreferences: body.creative_preferences,
    ...common,
  });

  onStage?.('beats', 35, '正在排布分集节拍表（钩子 / 反转 / 卡点）...');
  const beatSheet = await generateBeatSheet(db, log, { bible, ...common });

  onStage?.('scripts', 45, `正在逐集撰写正文（共 ${beatSheet.length} 集）...`);
  const episodes = await generateEpisodeScripts(db, log, {
    bible, beatSheet, model, cfg, wordsPerEpisode, autoPolish: body.auto_polish !== false,
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
  reviewAndPolishEpisode,
  generateStoryThreeStage,
};
