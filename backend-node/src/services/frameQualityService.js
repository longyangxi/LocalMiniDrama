/**
 * 分镜帧质检闸门。
 *
 * 全流程此前是「生成即接受」——没有任何自动校验，批量跑必然产出大量废片，
 * 人工挑片成本极高。而继续往正向提示词里堆「违反即失败」这类威胁式约束对扩散模型无效。
 *
 * 这里改用一次廉价的视觉模型调用来实际检查生成结果：角色是否是同一个人、服装是否一致、
 * 有没有出现名单外的人、有没有时代穿帮、有没有手部/肢体畸变。分数低于阈值自动重生成。
 * 一次 VLM 调用的成本比一条废视频低两个数量级。
 */

const fs = require('fs');
const path = require('path');
const aiClient = require('./aiClient');
const { safeParseAIJSON } = require('../utils/safeJson');

const DEFAULT_MIN_SCORE = 70;
const DEFAULT_MAX_RETRIES = 2;
/** 需要质检的帧类型 */
const GATED_FRAME_TYPES = new Set(['first', 'last', 'key', 'storyboard_first', 'storyboard_last']);

function gateConfig(cfg) {
  const g = cfg?.image?.quality_gate || {};
  return {
    enabled: g.enabled !== false,               // 缺省开启
    minScore: Number(g.min_score) > 0 ? Number(g.min_score) : DEFAULT_MIN_SCORE,
    maxRetries: Number.isFinite(Number(g.max_retries)) ? Number(g.max_retries) : DEFAULT_MAX_RETRIES,
    model: g.model || undefined,
  };
}

function isGatedFrameType(frameType) {
  return GATED_FRAME_TYPES.has(String(frameType || '').toLowerCase());
}

/** 质检用的 system prompt：只让模型做判断，不让它重写提示词 */
function buildCheckSystemPrompt() {
  return `You are a film continuity supervisor reviewing an AI-generated storyboard frame before it goes to video generation.

Judge ONLY what is visible in the image. Be strict but fair: this frame will be turned into a video clip, so defects get amplified.

Return ONLY a JSON object, no markdown, no commentary:
{
  "identity_match": 0-100,      // does the character match the described visual identity anchors
  "costume_consistent": 0-100,  // does clothing match the described costume
  "character_count_ok": true/false,  // number of visible people matches the expected count
  "era_ok": true/false,         // no anachronistic props/clothing for the stated era
  "anatomy_ok": true/false,     // hands, fingers, limbs, faces are not deformed or duplicated
  "composition_ok": true/false, // no split panels / collage / grid / borders / watermark / text overlay
  "score": 0-100,               // overall usability of this frame
  "issues": ["short, concrete problems, empty array if none"]
}

Scoring guidance:
- Deformed hands/faces, duplicated limbs, or a person who is clearly not the described character → score below 50.
- Split-panel or collage layout, visible watermark or text → score below 40.
- Anachronistic props in a period setting → score below 60.
- Minor lighting or framing deviations are acceptable → do not drop below 75 for those alone.`;
}

/** 组装质检的 user prompt：期望的身份/时代/人数/景别 */
function buildCheckUserPrompt(ctx) {
  const lines = ['Review this generated storyboard frame against the intended specification.', ''];
  if (ctx.era) lines.push(`ERA / SETTING: ${ctx.era}`);
  if (ctx.shotType) lines.push(`INTENDED SHOT SIZE: ${ctx.shotType}`);
  lines.push(`EXPECTED NUMBER OF VISIBLE PEOPLE: ${ctx.expectedCharacterCount == null ? 'unspecified' : ctx.expectedCharacterCount}`);
  if (ctx.characters?.length) {
    lines.push('', 'EXPECTED CHARACTERS AND THEIR FIXED VISUAL IDENTITY:');
    for (const c of ctx.characters) {
      lines.push(`- ${c.name}: ${c.anchor}`);
    }
  }
  if (ctx.location) lines.push('', `INTENDED LOCATION: ${ctx.location}`);
  if (ctx.promptExcerpt) lines.push('', `PROMPT THAT WAS USED (excerpt): ${ctx.promptExcerpt}`);
  return lines.join('\n');
}

/** 把角色的 identity_anchors / appearance 压成一行给 VLM 比对 */
function anchorLineFor(charRow) {
  if (!charRow) return '';
  const bits = [];
  if (charRow.identity_anchors) {
    try {
      const a = typeof charRow.identity_anchors === 'string' ? JSON.parse(charRow.identity_anchors) : charRow.identity_anchors;
      if (a) {
        for (const key of ['face_shape', 'facial_features', 'hair_style', 'skin_texture', 'unique_marks']) {
          if (a[key] && a[key] !== 'unspecified') bits.push(`${key}: ${a[key]}`);
        }
        if (a.color_anchors && typeof a.color_anchors === 'object') {
          const colors = Object.entries(a.color_anchors)
            .filter(([, v]) => v && String(v).startsWith('#'))
            .map(([k, v]) => `${k}=${v}`);
          if (colors.length) bits.push(`colors: ${colors.join(', ')}`);
        }
      }
    } catch (_) {}
  }
  if (bits.length === 0 && charRow.appearance) {
    bits.push(String(charRow.appearance).slice(0, 200));
  }
  return bits.join('; ') || '(no anchor recorded)';
}

/** 收集这条图生记录对应的期望规格 */
function collectExpectation(db, row) {
  const ctx = { characters: [], expectedCharacterCount: null };

  if (row.drama_id) {
    const drama = db.prepare('SELECT style, genre, story_bible FROM dramas WHERE id = ?').get(Number(row.drama_id));
    if (drama?.story_bible) {
      try {
        const bible = typeof drama.story_bible === 'string' ? JSON.parse(drama.story_bible) : drama.story_bible;
        if (bible?.era_setting) ctx.era = bible.era_setting;
      } catch (_) {}
    }
    if (!ctx.era) ctx.era = [drama?.genre, drama?.style].filter(Boolean).join(' / ') || undefined;
  }

  if (row.storyboard_id) {
    const sb = db.prepare(
      'SELECT characters, location, time, shot_type FROM storyboards WHERE id = ? AND deleted_at IS NULL'
    ).get(Number(row.storyboard_id));
    if (sb) {
      ctx.shotType = sb.shot_type || undefined;
      ctx.location = [sb.location, sb.time].filter(Boolean).join(', ') || undefined;
      if (sb.characters != null && String(sb.characters).trim()) {
        try {
          const parsed = JSON.parse(sb.characters);
          if (Array.isArray(parsed)) {
            ctx.expectedCharacterCount = parsed.length;
            for (const item of parsed) {
              const cid = Number(typeof item === 'object' && item != null ? item.id : item);
              if (!Number.isFinite(cid)) continue;
              const c = db.prepare(
                'SELECT name, appearance, identity_anchors FROM characters WHERE id = ? AND deleted_at IS NULL'
              ).get(cid);
              if (c) ctx.characters.push({ name: c.name || `角色${cid}`, anchor: anchorLineFor(c) });
            }
          }
        } catch (_) {}
      }
    }
  }

  ctx.promptExcerpt = String(row.prompt || '').slice(0, 400);
  return ctx;
}

/** 由各项判定合成最终分（模型给的 score 与硬性项取更严的那个） */
function consolidateScore(raw) {
  let score = Number(raw?.score);
  if (!Number.isFinite(score)) score = 60;

  const hardFails = [];
  if (raw?.anatomy_ok === false) { score = Math.min(score, 45); hardFails.push('肢体/手部畸变'); }
  if (raw?.composition_ok === false) { score = Math.min(score, 40); hardFails.push('宫格拼贴/水印/文字'); }
  if (raw?.era_ok === false) { score = Math.min(score, 55); hardFails.push('时代穿帮'); }
  if (raw?.character_count_ok === false) { score = Math.min(score, 55); hardFails.push('画面人数与预期不符'); }

  const identity = Number(raw?.identity_match);
  if (Number.isFinite(identity) && identity < 50) { score = Math.min(score, 50); hardFails.push('角色不像参考形象'); }

  return { score: Math.max(0, Math.min(100, Math.round(score))), hardFails };
}

/**
 * 对一条已完成的图生记录做质检。
 * @returns {Promise<{ok:boolean, score:number, report:object, skipped?:string}>}
 */
async function checkImageGeneration(db, log, imageGenId, cfg) {
  const row = db.prepare('SELECT * FROM image_generations WHERE id = ? AND deleted_at IS NULL').get(Number(imageGenId));
  if (!row) return { ok: true, score: 0, report: {}, skipped: 'record_not_found' };
  if (row.status !== 'completed') return { ok: true, score: 0, report: {}, skipped: 'not_completed' };
  if (!isGatedFrameType(row.frame_type)) return { ok: true, score: 0, report: {}, skipped: 'frame_type_not_gated' };

  const storageRoot = path.isAbsolute(cfg?.storage?.local_path || '')
    ? cfg.storage.local_path
    : path.join(process.cwd(), cfg?.storage?.local_path || './data/storage');

  let imageSource = null;
  if (row.local_path) {
    const abs = path.join(storageRoot, String(row.local_path).replace(/\//g, path.sep));
    if (fs.existsSync(abs)) imageSource = { localAbsPath: abs };
  }
  if (!imageSource && row.image_url && String(row.image_url).startsWith('http')) {
    imageSource = { imageUrl: row.image_url };
  }
  if (!imageSource) return { ok: true, score: 0, report: {}, skipped: 'no_image_source' };

  const gate = gateConfig(cfg);
  const ctx = collectExpectation(db, row);

  let raw = null;
  try {
    const text = await aiClient.generateTextWithVision(
      db, log, 'text',
      buildCheckUserPrompt(ctx),
      buildCheckSystemPrompt(),
      imageSource,
      { model: gate.model, temperature: 0.1, max_tokens: 600 }
    );
    raw = safeParseAIJSON(text, log);
  } catch (err) {
    // 视觉模型不可用时不能卡住生产流程，放行并记录
    log.warn('[质检] 视觉模型调用失败，跳过本次质检', { image_gen_id: imageGenId, error: err.message });
    return { ok: true, score: 0, report: { skipped: err.message }, skipped: 'vision_unavailable' };
  }

  if (!raw || typeof raw !== 'object') {
    log.warn('[质检] 无法解析视觉模型返回，跳过', { image_gen_id: imageGenId });
    return { ok: true, score: 0, report: {}, skipped: 'unparsable' };
  }

  const { score, hardFails } = consolidateScore(raw);
  const report = {
    ...raw,
    hard_fails: hardFails,
    expected_character_count: ctx.expectedCharacterCount,
    era: ctx.era || null,
    checked_at: new Date().toISOString(),
  };

  try {
    db.prepare('UPDATE image_generations SET qa_score = ?, qa_report = ?, updated_at = ? WHERE id = ?')
      .run(score, JSON.stringify(report), new Date().toISOString(), Number(imageGenId));
  } catch (err) {
    log.warn('[质检] 结果落库失败', { image_gen_id: imageGenId, error: err.message });
  }

  const ok = score >= gate.minScore;
  log[ok ? 'info' : 'warn']('[质检] 结果', {
    image_gen_id: imageGenId,
    frame_type: row.frame_type,
    score,
    min_score: gate.minScore,
    pass: ok,
    issues: Array.isArray(raw.issues) ? raw.issues.slice(0, 4) : [],
    hard_fails: hardFails,
  });

  return { ok, score, report };
}

/**
 * 质检不通过时重排一次生成（换 seed 概念：新建记录并附加针对性修正指令）。
 * @returns {number|null} 新建的 image_generations id
 */
function scheduleRetry(db, log, row, report, cfg) {
  const gate = gateConfig(cfg);
  const attempt = Number(row.qa_attempt) || 0;
  if (attempt >= gate.maxRetries) {
    log.warn('[质检] 已达重试上限，保留当前结果待人工处理', {
      image_gen_id: row.id, attempt, max: gate.maxRetries,
    });
    return null;
  }

  // 把质检发现的问题转成正向的修正指令（仍然不写「严禁××」，否定项走 negative_prompt）
  const fixes = [];
  if (report?.anatomy_ok === false) fixes.push('双手与手指结构完整清晰，肢体比例自然');
  if (report?.composition_ok === false) fixes.push('单幅完整画面，画面边缘干净');
  if (report?.era_ok === false) fixes.push('所有服装与器物严格属于设定年代');
  if (report?.character_count_ok === false) {
    const n = report?.expected_character_count;
    if (Number.isFinite(n)) fixes.push(`画面中恰好出现 ${n} 位人物`);
  }
  if (Number(report?.identity_match) < 50) fixes.push('人物面容与参考图完全一致');

  const basePrompt = String(row.prompt || '').trim();
  const retryPrompt = fixes.length ? `${basePrompt}，${fixes.join('，')}` : basePrompt;

  const now = new Date().toISOString();
  const taskService = require('./taskService');
  const task = taskService.createTask(db, log, 'image_generation', String(row.drama_id || ''));

  const info = db.prepare(
    `INSERT INTO image_generations
       (storyboard_id, drama_id, scene_id, character_id, provider, prompt, negative_prompt, model,
        frame_type, reference_images, use_first_frame_layout_lock, keep_costume_lock, size,
        status, task_id, qa_attempt, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`
  ).run(
    row.storyboard_id ?? null, row.drama_id ?? 0, row.scene_id ?? null, row.character_id ?? null,
    row.provider ?? null, retryPrompt, row.negative_prompt ?? null, row.model ?? null,
    row.frame_type ?? null, row.reference_images ?? null,
    row.use_first_frame_layout_lock ?? null, row.keep_costume_lock ?? null, row.size ?? null,
    task.id, attempt + 1, now, now
  );

  const newId = info.lastInsertRowid;
  log.info('[质检] 未达阈值，已自动重排生成', {
    from: row.id, to: newId, attempt: attempt + 1, fixes,
  });

  setImmediate(() => {
    require('./imageService').processImageGeneration(db, log, newId);
  });
  return newId;
}

/**
 * 生成完成后的质检入口：不通过则自动重排一次。
 * 任何异常都不得阻断主流程。
 */
async function runGateAfterGeneration(db, log, imageGenId) {
  let cfg;
  try {
    cfg = require('../config').loadConfig();
  } catch (_) {
    return;
  }
  const gate = gateConfig(cfg);
  if (!gate.enabled) return;

  try {
    const result = await checkImageGeneration(db, log, imageGenId, cfg);
    if (result.skipped || result.ok) return;

    const row = db.prepare('SELECT * FROM image_generations WHERE id = ?').get(Number(imageGenId));
    if (row) scheduleRetry(db, log, row, result.report, cfg);
  } catch (err) {
    log.warn('[质检] 闸门执行异常，已忽略', { image_gen_id: imageGenId, error: err.message });
  }
}

/**
 * 一次生成 N 张候选并按质检分挑最好的一张。
 * 视频是全流程最贵的一步，在首帧阶段多花几张图的钱，比生成完视频再返工便宜得多。
 *
 * @param {object} opts { storyboardId, frameType, count, model, timeoutMs }
 * @returns {Promise<{best:object|null, candidates:Array}>}
 */
async function generateBestOfN(db, log, opts = {}) {
  const cfg = require('../config').loadConfig();
  const imageService = require('./imageService');
  const storyboardId = Number(opts.storyboardId);
  // 与前端一致：分镜首/尾帧统一用 storyboard_first / storyboard_last，
  // 否则候选图在历史条里拿不到「首/尾」标记。
  const frameType = opts.frameType || 'storyboard_first';
  const count = Math.min(6, Math.max(2, Number(opts.count) || 4));
  const timeoutMs = Number(opts.timeoutMs) || 8 * 60 * 1000;

  if (!Number.isFinite(storyboardId) || storyboardId <= 0) throw new Error('缺少有效的 storyboard_id');

  const sb = db.prepare('SELECT * FROM storyboards WHERE id = ? AND deleted_at IS NULL').get(storyboardId);
  if (!sb) throw new Error('分镜不存在');

  const episode = db.prepare('SELECT drama_id FROM episodes WHERE id = ?').get(Number(sb.episode_id));
  const prompt = (sb.polished_prompt && String(sb.polished_prompt).trim())
    || (sb.image_prompt && String(sb.image_prompt).trim())
    || '';
  if (!prompt) throw new Error('该分镜尚无图片提示词，请先生成或润色提示词');

  const gate = gateConfig(cfg);
  const ids = [];
  for (let i = 0; i < count; i++) {
    const rec = imageService.create(db, log, {
      storyboard_id: storyboardId,
      drama_id: episode?.drama_id || 0,
      prompt,
      model: opts.model || undefined,
      frame_type: frameType,
      // 候选之间互不影响：每张都独立走完整的参考图/负向词流程
    });
    // 候选本身不该再触发「不合格就自动重排」——这里是多选一，落选就丢弃。
    // 把 qa_attempt 顶到上限，闸门只打分不重排。
    try {
      db.prepare('UPDATE image_generations SET qa_attempt = ? WHERE id = ?').run(gate.maxRetries, rec.id);
    } catch (_) {}
    ids.push(rec.id);
  }

  log.info('[质检] 已提交候选生成', { storyboard_id: storyboardId, frame_type: frameType, count, ids });

  // 等待全部出图（或超时）
  const started = Date.now();
  const pending = new Set(ids);
  while (pending.size > 0 && Date.now() - started < timeoutMs) {
    await new Promise((r) => setTimeout(r, 3000));
    for (const id of [...pending]) {
      const r = db.prepare('SELECT status FROM image_generations WHERE id = ?').get(id);
      if (r && (r.status === 'completed' || r.status === 'failed')) pending.delete(id);
    }
  }

  const candidates = [];
  for (const id of ids) {
    const row = db.prepare('SELECT * FROM image_generations WHERE id = ?').get(id);
    if (!row || row.status !== 'completed') {
      candidates.push({ id, status: row?.status || 'unknown', score: -1, error: row?.error_msg || null });
      continue;
    }
    let score = -1;
    let report = null;
    // 闸门在生成完成时已经打过分，直接复用，避免重复消耗视觉模型调用
    if (Number.isFinite(Number(row.qa_score))) {
      score = Number(row.qa_score);
      try { report = row.qa_report ? JSON.parse(row.qa_report) : null; } catch (_) {}
    } else {
      try {
        const res = await checkImageGeneration(db, log, id, cfg);
        score = res.skipped ? 0 : res.score;
        report = res.report;
      } catch (err) {
        log.warn('[质检] 候选打分失败', { id, error: err.message });
        score = 0;
      }
    }
    candidates.push({ id, status: 'completed', score, report, image_url: row.image_url, local_path: row.local_path });
  }

  const ranked = candidates.filter((c) => c.status === 'completed').sort((a, b) => b.score - a.score);
  const best = ranked[0] || null;

  if (best) {
    const now = new Date().toISOString();
    const isLast = String(frameType).toLowerCase().includes('last');
    const bestRow = db.prepare('SELECT image_url, local_path FROM image_generations WHERE id = ?').get(best.id);
    if (isLast) {
      db.prepare('UPDATE storyboards SET last_frame_image_id = ?, last_frame_image_url = ?, last_frame_local_path = ?, updated_at = ? WHERE id = ?')
        .run(best.id, bestRow?.image_url ?? null, bestRow?.local_path ?? null, now, storyboardId);
    } else {
      db.prepare('UPDATE storyboards SET first_frame_image_id = ?, image_url = ?, local_path = ?, updated_at = ? WHERE id = ?')
        .run(best.id, bestRow?.image_url ?? null, bestRow?.local_path ?? null, now, storyboardId);
    }
    log.info('[质检] 已选出最佳候选并绑定到分镜', {
      storyboard_id: storyboardId, best_id: best.id, score: best.score,
      all_scores: candidates.map((c) => c.score),
    });
  }

  return { best, candidates };
}

module.exports = {
  DEFAULT_MIN_SCORE,
  isGatedFrameType,
  gateConfig,
  checkImageGeneration,
  runGateAfterGeneration,
  generateBestOfN,
};
