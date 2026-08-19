/**
 * 音频先行（audio-first）的镜头时长规划。
 *
 * 旧流程：镜头时长由用户设定或模型瞎填 → 配音用 atempo 强行拉伸到该时长 → 听感是「机器人加速」。
 * 新流程：先算/测人声时长 → 加上表演留白 → 对齐到模型时长档位 → 回写 storyboards.duration，
 *        视频与配音在同一个数上对齐，atempo 只在 ±5% 内做微调。
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { getFfprobePath } = require('../utils/ffmpegPath');
const speechTiming = require('./speechTiming');

/** 各视频模型普遍支持的时长档位（秒）。规划结果向上贴合，避免провайдер再次截断。 */
const DEFAULT_DURATION_LADDER = [5, 6, 8, 10, 12, 15];

/** 无台词镜头的默认时长；有台词时的前后表演留白 */
const SILENT_SHOT_SEC = 5;
const LEAD_IN_SEC = 0.4;
const TAIL_OUT_SEC = 0.8;

/** 单镜硬上下限（超出应拆镜而不是拉长） */
const MIN_SHOT_SEC = 3;
const MAX_SHOT_SEC = 15;

/** 读取 config 里的时长档位；非法时回落到默认 */
function resolveDurationLadder(cfg) {
  const raw = cfg?.video?.duration_ladder;
  if (!Array.isArray(raw) || raw.length === 0) return DEFAULT_DURATION_LADDER;
  const cleaned = raw
    .map((n) => Math.round(Number(n)))
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);
  return cleaned.length ? cleaned : DEFAULT_DURATION_LADDER;
}

/** 向上贴合到档位；超过最大档位则取最大档位 */
function snapUpToLadder(seconds, ladder) {
  const target = Number(seconds);
  if (!Number.isFinite(target) || target <= 0) return ladder[0];
  for (const step of ladder) {
    if (target <= step + 0.01) return step;
  }
  return ladder[ladder.length - 1];
}

/** ffprobe 读取媒体真实时长（秒）；失败返回 null */
function measureMediaDurationSec(absPath) {
  if (!absPath || !fs.existsSync(absPath)) return null;
  try {
    const r = spawnSync(
      getFfprobePath(),
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', absPath],
      { encoding: 'utf8' }
    );
    if (r.error || r.status !== 0) return null;
    const v = parseFloat(String(r.stdout || '').trim());
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch (_) {
    return null;
  }
}

/**
 * 规划单条分镜的时长。
 *
 * @param {object} row storyboards 行（需 dialogue / narration / action / duration）
 * @param {object} [opts]
 * @param {number} [opts.measuredSpeechSec] 已实测的人声时长（TTS 产物 ffprobe 结果），优先于估算
 * @param {number[]} [opts.ladder] 时长档位
 * @param {number} [opts.minSec] 最短镜头
 * @param {boolean} [opts.respectExisting] 已有 duration 更大时保留（默认 false，音频先行以人声为准）
 * @returns {{ duration:number, speechSec:number, source:'measured'|'estimated'|'silent', needsSplit:boolean, raw:number }}
 */
function planShotDuration(row, opts = {}) {
  const ladder = opts.ladder || DEFAULT_DURATION_LADDER;
  const minSec = Number.isFinite(opts.minSec) ? opts.minSec : MIN_SHOT_SEC;

  let speechSec;
  let source;
  if (Number.isFinite(opts.measuredSpeechSec) && opts.measuredSpeechSec > 0) {
    speechSec = opts.measuredSpeechSec;
    source = 'measured';
  } else {
    speechSec = speechTiming.estimateStoryboardSpeechSeconds(row).totalSec;
    source = speechSec > 0 ? 'estimated' : 'silent';
  }

  let raw;
  if (speechSec <= 0) {
    // 无人声：按动作描述长度给一个保守时长，动作越复杂给得越多
    const actionLen = String(row?.action || '').length;
    raw = actionLen > 80 ? SILENT_SHOT_SEC + 3 : actionLen > 40 ? SILENT_SHOT_SEC + 1 : SILENT_SHOT_SEC;
  } else {
    raw = speechSec + LEAD_IN_SEC + TAIL_OUT_SEC;
  }

  const bounded = Math.min(MAX_SHOT_SEC, Math.max(minSec, raw));
  let duration = snapUpToLadder(bounded, ladder);

  if (opts.respectExisting) {
    const existing = Math.round(Number(row?.duration) || 0);
    if (existing > duration) duration = snapUpToLadder(existing, ladder);
  }

  return {
    duration,
    speechSec: Math.round(speechSec * 10) / 10,
    source,
    // 人声已经超过单镜上限，靠拉长解决不了，应该按对白拆镜
    needsSplit: raw > MAX_SHOT_SEC,
    raw: Math.round(raw * 10) / 10,
  };
}

/** 把 storyboards 行里两条 TTS 产物的真实时长测出来（叠轨播放，取较大者） */
function measureStoryboardSpeechSec(row, storageRoot) {
  const paths = [row?.audio_local_path, row?.narration_audio_local_path]
    .filter((p) => p && String(p).trim())
    .map((p) => path.join(storageRoot, String(p).replace(/\//g, path.sep)));

  let maxSec = 0;
  for (const p of paths) {
    const d = measureMediaDurationSec(p);
    if (d && d > maxSec) maxSec = d;
  }
  return maxSec > 0 ? maxSec : null;
}

/**
 * 为一条分镜补齐 TTS（对白 + 旁白），返回实测人声时长。
 * 已有音频且文件存在时直接复用，不重复合成。
 */
async function ensureStoryboardSpeech(db, log, row, storageRoot, { force = false } = {}) {
  const ttsService = require('./ttsService');
  const sbId = Number(row.id);
  const now = new Date().toISOString();

  const jobs = [
    { kind: 'dialogue', text: row.dialogue, column: 'audio_local_path', existing: row.audio_local_path },
    { kind: 'narration', text: row.narration, column: 'narration_audio_local_path', existing: row.narration_audio_local_path },
  ];

  for (const job of jobs) {
    const text = job.text != null ? String(job.text).trim() : '';
    if (!text) continue;

    if (!force && job.existing) {
      const abs = path.join(storageRoot, String(job.existing).replace(/\//g, path.sep));
      if (fs.existsSync(abs)) continue;
    }

    try {
      const result = await ttsService.synthesize(db, log, {
        text,
        storyboard_id: sbId,
        storage_base: storageRoot,
        // 对白里的「角色名：」是给人看的，不该被念出来
        strip_speaker: job.kind === 'dialogue',
      });
      if (result?.local_path) {
        db.prepare(`UPDATE storyboards SET ${job.column} = ?, updated_at = ? WHERE id = ?`)
          .run(result.local_path, now, sbId);
        row[job.column] = result.local_path;
      }
    } catch (err) {
      log?.warn?.('[时长规划] TTS 合成失败，回落到字数估算', {
        storyboard_id: sbId, kind: job.kind, error: err.message,
      });
    }
  }

  return measureStoryboardSpeechSec(row, storageRoot);
}

/**
 * 音频先行地重排一整集的镜头时长。
 *
 * @param {object} opts
 * @param {boolean} [opts.synthesize=true] 是否先补齐 TTS 拿真实时长（false 则纯字数估算）
 * @param {boolean} [opts.force=false] 强制重合成 TTS
 * @param {number[]} [opts.ladder]
 * @returns {Promise<{updated:number, unchanged:number, shots:Array, splitSuggestions:Array}>}
 */
async function planEpisodeDurations(db, log, episodeId, opts = {}) {
  const loadConfig = require('../config').loadConfig;
  const cfg = (() => { try { return loadConfig(); } catch (_) { return {}; } })();
  const storageRoot = path.isAbsolute(cfg?.storage?.local_path || '')
    ? cfg.storage.local_path
    : path.join(process.cwd(), cfg?.storage?.local_path || './data/storage');
  const ladder = opts.ladder || resolveDurationLadder(cfg);
  const synthesize = opts.synthesize !== false;

  const rows = db.prepare(
    `SELECT id, storyboard_number, title, duration, dialogue, narration, action,
            audio_local_path, narration_audio_local_path
       FROM storyboards
      WHERE episode_id = ? AND deleted_at IS NULL
      ORDER BY storyboard_number ASC, id ASC`
  ).all(Number(episodeId));

  const shots = [];
  const splitSuggestions = [];
  let updated = 0;
  let unchanged = 0;
  const now = new Date().toISOString();

  for (const row of rows) {
    let measured = measureStoryboardSpeechSec(row, storageRoot);
    const hasSpeechText =
      (row.dialogue && String(row.dialogue).trim()) || (row.narration && String(row.narration).trim());

    if (synthesize && hasSpeechText && (measured == null || opts.force)) {
      measured = await ensureStoryboardSpeech(db, log, row, storageRoot, { force: !!opts.force });
    }

    const plan = planShotDuration(row, { measuredSpeechSec: measured, ladder });
    const before = Math.round(Number(row.duration) || 0);

    if (plan.duration !== before) {
      db.prepare('UPDATE storyboards SET duration = ?, updated_at = ? WHERE id = ?')
        .run(plan.duration, now, row.id);
      updated += 1;
    } else {
      unchanged += 1;
    }

    if (plan.needsSplit) {
      splitSuggestions.push({
        storyboard_id: row.id,
        storyboard_number: row.storyboard_number,
        title: row.title,
        speech_sec: plan.speechSec,
        reason: `人声约 ${plan.speechSec}s，超过单镜上限 ${MAX_SHOT_SEC}s，建议按对白拆镜`,
      });
    }

    shots.push({
      storyboard_id: row.id,
      storyboard_number: row.storyboard_number,
      before,
      after: plan.duration,
      speech_sec: plan.speechSec,
      source: plan.source,
    });
  }

  log?.info?.('[时长规划] 完成', {
    episode_id: Number(episodeId), total: rows.length, updated, unchanged,
    split_suggestions: splitSuggestions.length,
  });

  return { updated, unchanged, shots, splitSuggestions };
}

module.exports = {
  DEFAULT_DURATION_LADDER,
  MIN_SHOT_SEC,
  MAX_SHOT_SEC,
  resolveDurationLadder,
  snapUpToLadder,
  measureMediaDurationSec,
  measureStoryboardSpeechSec,
  planShotDuration,
  ensureStoryboardSpeech,
  planEpisodeDurations,
};
