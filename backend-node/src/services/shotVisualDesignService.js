/**
 * 分镜第二段：视觉设计通道。
 *
 * 旧流程一次调用要模型同时输出 16 个字段（叙事 + 景别 + 角度 + 运镜 + 光线 + 景深 + 段落），
 * 还塞进 19 种运镜和整套构图理论。注意力被稀释的结果是：运镜字段大量退化成 static 或乱填，
 * 景别连续重复，对话场景不做正反打。
 *
 * 拆成两段后：
 *   第一段（既有流式生成）只管叙事——动作、台词、结果、情绪、段落；
 *   第二段（本模块）拿到**整集已排好的镜头序列**再统一做视觉设计。
 *
 * 关键收益是第二段能看到全局节奏：它知道前后镜的景别、知道这是不是对话段落、
 * 知道段落在哪里开合。单次流式生成永远看不到自己后面还有什么。
 */

const aiClient = require('./aiClient');
const angleService = require('./angleService');
const cameraMovement = require('../constants/cameraMovement');
const { safeParseAIJSON } = require('../utils/safeJson');

/** 每批镜头数：太大模型会失焦，太小则失去全局节奏视野 */
const BATCH_SIZE = 12;
/** 批次间重叠的上下文镜头数，保证跨批不出现景别重复 */
const OVERLAP = 2;

const SHOT_TYPES_ZH = ['大远景', '远景', '中景', '近景', '特写'];
const LIGHTING_CODES = ['natural', 'front', 'side', 'backlit', 'top', 'under', 'soft', 'dramatic', 'golden_hour', 'blue_hour', 'night', 'neon'];
const DOF_CODES = ['extreme_shallow', 'shallow', 'medium', 'deep'];

function buildSystemPrompt(cfg) {
  const movements = cameraMovement.allowedMovementList(cfg, 'zh').join('、');
  return `你是一位资深摄影指导。剧本已经拆好镜头、动作与台词，**你不负责改动叙事**，只负责为每个已有镜头做视觉设计。

【你要为每个镜头决定的 5 件事】
1. shot_type 景别：${SHOT_TYPES_ZH.join(' / ')}
2. angle 机位角度：平视 / 仰视 / 俯视 / 侧面 / 背面
3. movement 运镜：只能从白名单中选 —— ${movements}
4. lighting_style 灯光：${LIGHTING_CODES.join(' / ')}
5. depth_of_field 景深：${DOF_CODES.join(' / ')}

【节奏规则（这是你相比逐镜生成的唯一优势，必须用上）】
- **禁止连续 3 个及以上镜头使用同一景别**。情绪递进时逐步推近：远 → 中 → 近 → 特写。
- **对话段落必须做正反打**：两人对话时，说话方与聆听方交替使用过肩/近景，机位角度左右交替，不要连续同向构图。
- **段落开合**：每个 segment 的第一个镜头用远景或大远景建立空间，最后一个镜头用近景或特写收束情绪。
- **情绪强度驱动景别**：emotion_intensity 为 3 时用特写或近景，为 0 时可用中景/远景。

【运镜规则（克制优先）】
- 复杂运镜是 AI 视频模型最容易崩的地方。**整集里 static（固定）应当占多数**，这不是偷懒，是让成片可用的前提。
- 张力靠景别切换和剪辑节奏制造，不靠单镜头内的机位运动。
- 只有需要真实动能的镜头才给 tracking / handheld；情绪推进优先用 push，且幅度要缓。
- 一个镜头只给一种运镜，不要写复合运镜。

【灯光与景深】
- lighting_style 依据 time 与 atmosphere 判断：夜晚→night，黄昏→golden_hour，室内暖光→soft，强冲突→dramatic，逆光轮廓→backlit。
- depth_of_field 依据景别：特写/近景→shallow 或 extreme_shallow，中景→medium，远景/大远景→deep。

【输出】
只返回 JSON 数组，不要 markdown 代码块、不要说明文字。数组元素与输入镜头一一对应：
[{"shot_number": 1, "shot_type": "中景", "angle": "平视", "movement": "static", "lighting_style": "soft", "depth_of_field": "medium", "reason": "为什么这样设计，10字以内"}]`;
}

function buildUserPrompt(shots, contextShots) {
  const lines = [];
  if (contextShots.length) {
    lines.push('【上一批的末尾镜头（用于避免景别重复，不要为它们输出结果）】');
    for (const s of contextShots) {
      lines.push(`  #${s.storyboard_number} 景别=${s.shot_type || '?'} 角度=${s.angle || '?'} 运镜=${s.movement || '?'}`);
    }
    lines.push('');
  }
  lines.push('【本批需要设计的镜头】');
  for (const s of shots) {
    const bits = [
      `#${s.storyboard_number}`,
      s.segment_title ? `[段落${s.segment_index}:${s.segment_title}]` : `[段落${s.segment_index ?? 0}]`,
      s.location ? `地点=${s.location}` : null,
      s.time ? `时间=${s.time}` : null,
      s.title ? `标题=${s.title}` : null,
      s.action ? `动作=${String(s.action).slice(0, 120)}` : null,
      s.dialogue ? `台词=${String(s.dialogue).slice(0, 100)}` : null,
      s.result ? `结果=${String(s.result).slice(0, 80)}` : null,
      s.emotion ? `情绪=${s.emotion}` : null,
      s.emotion_intensity != null ? `强度=${s.emotion_intensity}` : null,
      s.atmosphere ? `氛围=${String(s.atmosphere).slice(0, 60)}` : null,
      s.duration ? `时长=${s.duration}s` : null,
    ].filter(Boolean);
    lines.push('  ' + bits.join(' | '));
  }
  lines.push('');
  lines.push(`请为以上 ${shots.length} 个镜头输出视觉设计，数组长度必须等于 ${shots.length}。`);
  return lines.join('\n');
}

/** 把模型给的景别规整到标准枚举 */
function normalizeShotType(raw, fallback) {
  const t = String(raw || '').trim();
  if (!t) return fallback || '中景';
  for (const std of SHOT_TYPES_ZH) {
    if (t.includes(std)) return std;
  }
  if (/extreme.*(long|wide)|establishing/i.test(t)) return '大远景';
  if (/long shot|wide/i.test(t)) return '远景';
  if (/medium/i.test(t)) return '中景';
  if (/extreme.*close/i.test(t)) return '特写';
  if (/close/i.test(t)) return '近景';
  return fallback || '中景';
}

function pickEnum(raw, allowed, fallback) {
  const v = String(raw || '').trim().toLowerCase();
  return allowed.includes(v) ? v : (fallback ?? null);
}

/** 兜底节奏修正：模型仍连续给同景别时，本地强制打散 */
function enforceShotTypeVariety(designs, log) {
  let fixed = 0;
  for (let i = 2; i < designs.length; i++) {
    const a = designs[i - 2].shot_type;
    const b = designs[i - 1].shot_type;
    const c = designs[i].shot_type;
    if (a && a === b && b === c) {
      // 往「更近一档」或「更远一档」推，优先推近（情绪递进更常见）
      const idx = SHOT_TYPES_ZH.indexOf(c);
      const next = idx >= 0 && idx < SHOT_TYPES_ZH.length - 1 ? SHOT_TYPES_ZH[idx + 1] : SHOT_TYPES_ZH[Math.max(0, idx - 1)];
      if (next && next !== c) {
        designs[i].shot_type = next;
        designs[i].adjusted = '连续3镜同景别，本地打散';
        fixed += 1;
      }
    }
  }
  if (fixed) log?.info?.('[视觉设计] 本地打散连续同景别', { fixed });
  return designs;
}

/**
 * 为一整集做视觉设计并回写。
 * @returns {Promise<{updated:number, total:number, staticRatio:number, batches:number}>}
 */
async function designEpisodeVisuals(db, log, episodeId, opts = {}) {
  const cfg = opts.cfg || require('../config').loadConfig();
  const episodeIdNum = Number(episodeId);

  const shots = db.prepare(
    `SELECT id, storyboard_number, title, action, dialogue, result, emotion, emotion_intensity,
            atmosphere, location, time, duration, segment_index, segment_title,
            shot_type, angle, movement
       FROM storyboards
      WHERE episode_id = ? AND deleted_at IS NULL
      ORDER BY storyboard_number ASC, id ASC`
  ).all(episodeIdNum);

  if (shots.length === 0) {
    return { updated: 0, total: 0, staticRatio: 0, batches: 0 };
  }

  const systemPrompt = buildSystemPrompt(cfg);
  const byNumber = new Map(shots.map((s) => [Number(s.storyboard_number), s]));
  const allDesigns = [];
  let batches = 0;

  for (let i = 0; i < shots.length; i += BATCH_SIZE) {
    const batch = shots.slice(i, i + BATCH_SIZE);
    const context = i > 0 ? shots.slice(Math.max(0, i - OVERLAP), i) : [];
    const userPrompt = buildUserPrompt(batch, context);
    batches += 1;

    let parsed = null;
    try {
      const raw = await aiClient.generateText(db, log, 'text', userPrompt, systemPrompt, {
        scene_key: 'storyboard_visual_design',
        model: opts.model || undefined,
        temperature: 0.6,
        min_max_tokens: Math.max(1200, batch.length * 130),
      });
      parsed = safeParseAIJSON(raw, log);
      if (parsed && !Array.isArray(parsed)) {
        const key = Object.keys(parsed).find((k) => Array.isArray(parsed[k]));
        parsed = key ? parsed[key] : null;
      }
    } catch (err) {
      log.warn('[视觉设计] 批次生成失败，保留该批原值', {
        episode_id: episodeIdNum, batch_start: batch[0]?.storyboard_number, error: err.message,
      });
      continue;
    }

    if (!Array.isArray(parsed)) {
      log.warn('[视觉设计] 批次返回无法解析，保留该批原值', {
        episode_id: episodeIdNum, batch_start: batch[0]?.storyboard_number,
      });
      continue;
    }

    for (let k = 0; k < parsed.length; k++) {
      const d = parsed[k] || {};
      // 优先按 shot_number 对齐，模型漏填时按顺序兜底
      const num = Number(d.shot_number);
      const target = Number.isFinite(num) && byNumber.has(num) ? byNumber.get(num) : batch[k];
      if (!target) continue;

      const mv = cameraMovement.normalizeMovement(d.movement ?? target.movement, cfg);
      allDesigns.push({
        id: target.id,
        storyboard_number: target.storyboard_number,
        shot_type: normalizeShotType(d.shot_type, target.shot_type),
        angle: String(d.angle || target.angle || '平视').trim(),
        movement: mv.zh,
        movement_code: mv.code,
        movement_downgraded: mv.downgraded,
        lighting_style: pickEnum(d.lighting_style, LIGHTING_CODES, null),
        depth_of_field: pickEnum(d.depth_of_field, DOF_CODES, null),
        reason: d.reason ? String(d.reason).slice(0, 40) : null,
      });
    }
  }

  enforceShotTypeVariety(allDesigns, log);

  const now = new Date().toISOString();
  let updated = 0;
  for (const d of allDesigns) {
    const { h, v, s } = angleService.parseFromLegacyText(d.angle || '', d.shot_type || '');
    try {
      db.prepare(
        `UPDATE storyboards
            SET shot_type = ?, angle = ?, angle_h = ?, angle_v = ?, angle_s = ?,
                movement = ?, lighting_style = ?, depth_of_field = ?, updated_at = ?
          WHERE id = ? AND deleted_at IS NULL`
      ).run(d.shot_type, d.angle, h, v, s, d.movement, d.lighting_style, d.depth_of_field, now, d.id);
      updated += 1;
    } catch (err) {
      log.warn('[视觉设计] 回写失败', { storyboard_id: d.id, error: err.message });
    }
  }

  // 视觉字段变了，视频提示词要跟着重建
  const episodeStoryboardService = require('./episodeStoryboardService');
  for (const d of allDesigns) {
    try {
      episodeStoryboardService.rebuildVideoPromptForStoryboard(db, log, d.id);
    } catch (err) {
      log.warn('[视觉设计] 重建 video_prompt 失败', { storyboard_id: d.id, error: err.message });
    }
  }

  const staticCount = allDesigns.filter((d) => d.movement_code === 'static').length;
  const staticRatio = allDesigns.length ? Math.round((staticCount / allDesigns.length) * 100) / 100 : 0;

  log.info('[视觉设计] 完成', {
    episode_id: episodeIdNum,
    total: shots.length,
    updated,
    batches,
    static_ratio: staticRatio,
    downgraded: allDesigns.filter((d) => d.movement_downgraded).length,
  });

  return { updated, total: shots.length, staticRatio, batches, designs: allDesigns };
}

module.exports = {
  BATCH_SIZE,
  SHOT_TYPES_ZH,
  normalizeShotType,
  enforceShotTypeVariety,
  designEpisodeVisuals,
};
