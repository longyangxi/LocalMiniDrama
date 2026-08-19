/**
 * 段落转场。
 *
 * 此前整集合成是纯 concat 硬切，全片没有任何段落感——观众分不清「这是同一场戏的下一个镜头」
 * 还是「换场了」。
 *
 * 编辑逻辑：**段内硬切，段间转场**。
 *   - 同一 segment 内的镜头保持硬切（短剧的节奏靠密集硬切支撑，不能乱加转场）；
 *   - 跨 segment 才给转场，且换地点用黑场淡入淡出（时空跳跃），
 *     同地点用叠化（情绪延续）。
 *
 * 实现分两级，避免为了几个转场把整片都重编码：
 *   1. 段内用 concat 流拷贝合成「段文件」（无损、快）；
 *   2. 段之间用 xfade 串起来（只有这一步重编码）。
 *
 * xfade 会让相邻两段重叠 D 秒，因此整片时长 = 各段之和 − (段数−1) × D，
 * 每个镜头的起始时间也要相应前移；本模块负责把这份时间轴算出来交给后处理，
 * 否则配音和字幕会整体错位。
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { getFfmpegPath, getFfprobePath } = require('../utils/ffmpegPath');

/** 转场时长上下限（秒）。太长会拖节奏，短剧不适合长转场。 */
const MIN_DURATION = 0.2;
const MAX_DURATION = 1.5;
const DEFAULT_DURATION = 0.5;

/** 可选转场类型 → ffmpeg xfade transition 名 */
const TRANSITIONS = {
  dissolve: 'fade',        // 叠化：同地点、情绪延续
  fadeblack: 'fadeblack',  // 黑场：换地点或时间跳跃
  fadewhite: 'fadewhite',  // 白场：闪回 / 强冲击
  wipeleft: 'wipeleft',
  wiperight: 'wiperight',
  slideleft: 'slideleft',
  slideright: 'slideright',
  smoothleft: 'smoothleft',
  circleopen: 'circleopen',
};

function resolveTransitionConfig(cfg, mergeOpts = {}) {
  const fromCfg = cfg?.video?.transition || {};
  const mode = String(mergeOpts.transition_mode ?? fromCfg.mode ?? 'auto').toLowerCase();
  const rawDur = Number(mergeOpts.transition_duration ?? fromCfg.duration_seconds ?? DEFAULT_DURATION);
  const duration = Math.min(MAX_DURATION, Math.max(MIN_DURATION, Number.isFinite(rawDur) ? rawDur : DEFAULT_DURATION));
  return {
    mode,                                  // none | auto | 固定类型名（dissolve/fadeblack/...）
    duration,
    enabled: mode !== 'none' && mode !== 'off' && mode !== 'false',
  };
}

/**
 * 把 scenes 按 segment_index 切成连续分组。
 * 缺少 segment_index 的旧数据会归成一组（等价于没有转场）。
 *
 * @param {Array} scenes video_merges.scenes（每项含 scene_id = storyboard_id）
 * @returns {Array<{segmentIndex:number|null, location:string|null, sceneIndices:number[]}>}
 */
function groupScenesBySegment(db, scenes) {
  const groups = [];
  let current = null;

  for (let i = 0; i < scenes.length; i++) {
    const sbId = Number(scenes[i]?.scene_id);
    let segIdx = null;
    let location = null;
    if (Number.isFinite(sbId)) {
      const row = db.prepare(
        'SELECT segment_index, segment_title, location FROM storyboards WHERE id = ? AND deleted_at IS NULL'
      ).get(sbId);
      if (row) {
        segIdx = row.segment_index == null ? null : Number(row.segment_index);
        location = row.location || null;
      }
    }
    if (!current || current.segmentIndex !== segIdx) {
      current = { segmentIndex: segIdx, location, sceneIndices: [] };
      groups.push(current);
    }
    // 段落地点取该段第一个有值的镜头
    if (!current.location && location) current.location = location;
    current.sceneIndices.push(i);
  }

  return groups;
}

/**
 * 为每个段落边界挑转场类型。
 * auto：地点变化 → 黑场（时空跳跃）；同地点 → 叠化（情绪延续）。
 */
function pickTransitionForBoundary(mode, prevGroup, nextGroup) {
  if (mode !== 'auto') {
    return TRANSITIONS[mode] || TRANSITIONS.dissolve;
  }
  const a = String(prevGroup?.location || '').trim();
  const b = String(nextGroup?.location || '').trim();
  const locationChanged = a && b ? a !== b : true;
  return locationChanged ? TRANSITIONS.fadeblack : TRANSITIONS.dissolve;
}

function runFfmpeg(args, log, tag) {
  const r = spawnSync(getFfmpegPath(), args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (r.error) {
    log?.warn?.('transition: ffmpeg spawn', { tag, error: r.error.message });
    return false;
  }
  if (r.status !== 0) {
    log?.warn?.('transition: ffmpeg failed', { tag, stderr: r.stderr?.slice(-1200) });
    return false;
  }
  return true;
}

/** 段内合并：先试流拷贝，失败再重编码（不同供应商的片段编码参数常常不一致） */
function concatGroup(paths, outputPath, log) {
  if (paths.length === 1) {
    try {
      fs.copyFileSync(paths[0], outputPath);
      return true;
    } catch (_) { /* 落到下面的 ffmpeg 路径 */ }
  }

  const listFile = path.join(
    path.dirname(outputPath),
    `seg_concat_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.txt`
  );
  try {
    fs.writeFileSync(
      listFile,
      paths.map((p) => `file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'),
      'utf8'
    );
    const base = ['-y', '-f', 'concat', '-safe', '0', '-i', listFile];
    if (runFfmpeg([...base, '-c', 'copy', outputPath], log, 'seg_concat_copy')) return true;
    log?.info?.('transition: 段内流拷贝失败，改用重编码', { count: paths.length });
    return runFfmpeg(
      [...base, '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-c:a', 'aac', '-b:a', '192k', outputPath],
      log,
      'seg_concat_reencode'
    );
  } finally {
    try { if (fs.existsSync(listFile)) fs.unlinkSync(listFile); } catch (_) {}
  }
}

/** 探测文件是否有音轨 */
function hasAudioStream(absPath) {
  const r = spawnSync(
    getFfprobePath(),
    ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', absPath],
    { encoding: 'utf8' }
  );
  if (r.error || r.status !== 0) return false;
  return String(r.stdout || '').trim().length > 0;
}

/**
 * 用 xfade 把多个段文件串成一条时间轴。
 *
 * offset 是累计的：第 k 个 xfade 的 offset = 前 k 段时长之和 − k × D，
 * 因为每做一次转场，总时长就被重叠吃掉 D 秒。
 */
function runXfadeChain(segmentFiles, segmentDurations, transitions, duration, outputPath, log) {
  const n = segmentFiles.length;
  if (n < 2) return false;

  const args = ['-y'];
  for (const f of segmentFiles) args.push('-i', f);

  const allHaveAudio = segmentFiles.every((f) => hasAudioStream(f));
  const filters = [];

  let vPrev = '[0:v]';
  let aPrev = '[0:a]';
  let acc = Number(segmentDurations[0]) || 0;

  for (let k = 1; k < n; k++) {
    const offset = Math.max(0, acc - duration);
    const vOut = k === n - 1 ? '[vout]' : `[v${k}]`;
    filters.push(
      `${vPrev}[${k}:v]xfade=transition=${transitions[k - 1]}:duration=${duration}:offset=${offset.toFixed(3)}${vOut}`
    );
    vPrev = vOut;

    if (allHaveAudio) {
      const aOut = k === n - 1 ? '[aout]' : `[a${k}]`;
      filters.push(`${aPrev}[${k}:a]acrossfade=d=${duration}${aOut}`);
      aPrev = aOut;
    }

    acc = acc - duration + (Number(segmentDurations[k]) || 0);
  }

  args.push('-filter_complex', filters.join(';'));
  args.push('-map', '[vout]');
  if (allHaveAudio) args.push('-map', '[aout]', '-c:a', 'aac', '-b:a', '192k');
  else args.push('-an');
  args.push(
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '20',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', outputPath
  );

  log?.info?.('transition: xfade 链', { segments: n, duration, transitions, has_audio: allHaveAudio });
  return runFfmpeg(args, log, 'xfade_chain');
}

/**
 * 带段落转场地合成整集。
 *
 * @returns {null | {ok:boolean, sceneTimeline:Array<{startSec:number,durSec:number}>, totalSec:number, transitionCount:number}}
 *   返回 null 表示「不适用转场」，调用方应回退到原来的 concat 硬切路径。
 */
function mergeWithTransitions(db, log, opts) {
  const { scenes, localPathByScene, segmentDurations, outputPath, tempDir, cfg, mergeOpts } = opts;
  const conf = resolveTransitionConfig(cfg, mergeOpts);
  if (!conf.enabled) return null;

  // 每段必须有可用文件与实测时长，否则时间轴算不准，宁可退回硬切
  for (let i = 0; i < scenes.length; i++) {
    if (!localPathByScene[i] || !(Number(segmentDurations[i]) > 0)) {
      log?.info?.('transition: 存在缺失片段或时长，跳过转场', { scene_index: i });
      return null;
    }
  }

  const groups = groupScenesBySegment(db, scenes);
  if (groups.length < 2) {
    log?.info?.('transition: 只有一个段落，无需转场');
    return null;
  }

  // 转场会吃掉每个边界 D 秒，段落本身必须明显比转场长
  const segDurOf = (g) => g.sceneIndices.reduce((s, i) => s + Number(segmentDurations[i]), 0);
  const tooShort = groups.find((g) => segDurOf(g) <= conf.duration * 1.5);
  if (tooShort) {
    log?.info?.('transition: 存在过短段落，跳过转场', { segment_index: tooShort.segmentIndex });
    return null;
  }

  // ① 段内 concat
  const segmentFiles = [];
  const segmentDurs = [];
  for (let g = 0; g < groups.length; g++) {
    const paths = groups[g].sceneIndices.map((i) => localPathByScene[i]);
    const segOut = path.join(tempDir, `segment_${g}_${Date.now()}.mp4`);
    if (!concatGroup(paths, segOut, log)) {
      log?.warn?.('transition: 段内合并失败，回退硬切', { group: g });
      for (const f of segmentFiles) { try { fs.unlinkSync(f); } catch (_) {} }
      return null;
    }
    segmentFiles.push(segOut);
    segmentDurs.push(segDurOf(groups[g]));
  }

  // ② 段间 xfade
  const transitions = [];
  for (let g = 1; g < groups.length; g++) {
    transitions.push(pickTransitionForBoundary(conf.mode, groups[g - 1], groups[g]));
  }

  const ok = runXfadeChain(segmentFiles, segmentDurs, transitions, conf.duration, outputPath, log);
  for (const f of segmentFiles) {
    try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (_) {}
  }
  if (!ok) {
    log?.warn?.('transition: xfade 失败，回退硬切');
    return null;
  }

  // ③ 时间轴：每跨一个段落边界，后续镜头整体前移 D 秒
  const sceneTimeline = new Array(scenes.length).fill(null);
  let groupStart = 0;
  for (let g = 0; g < groups.length; g++) {
    let cursor = groupStart;
    for (const i of groups[g].sceneIndices) {
      const dur = Number(segmentDurations[i]);
      sceneTimeline[i] = { startSec: cursor, durSec: dur };
      cursor += dur;
    }
    groupStart = groupStart + segmentDurs[g] - conf.duration;
  }

  const totalSec = segmentDurs.reduce((a, b) => a + b, 0) - conf.duration * (groups.length - 1);

  log?.info?.('transition: 完成', {
    groups: groups.length, transitions, duration: conf.duration, total_sec: Math.round(totalSec),
  });

  return { ok: true, sceneTimeline, totalSec, transitionCount: transitions.length };
}

module.exports = {
  TRANSITIONS,
  DEFAULT_DURATION,
  MIN_DURATION,
  MAX_DURATION,
  resolveTransitionConfig,
  groupScenesBySegment,
  pickTransitionForBoundary,
  mergeWithTransitions,
};
