/**
 * 成片色彩统一。
 *
 * 各镜由 AI 独立生成，色温、对比度、饱和度会逐镜漂移，连起来看整体感很差。
 * 在合成的最后一次编码里统一过一遍调色，是成本最低的补救——反正那一 pass
 * 已经要为字幕/水印重编码，多挂一个滤镜几乎不增加耗时。
 *
 * 注意调色必须排在字幕与水印**之前**，否则字幕会被一起调色，白字会发黄发蓝。
 */

const fs = require('fs');

/**
 * 预设 → ffmpeg 视频滤镜。
 * 都刻意保守：AI 画面本身饱和度已偏高，重手调色只会更假。
 */
const PRESETS = {
  // 轻度归一：略提对比与饱和，把各镜的平淡感拉齐
  neutral: 'eq=contrast=1.06:saturation=1.06:gamma=1.02',
  // 电影感 S 曲线 + 轻微降饱和
  film: 'curves=preset=medium_contrast,eq=saturation=0.96',
  // 暖调：日常、温情、回忆。
  // 用 colortemperature 而不是 colorbalance —— 后者在部分 ffmpeg 构建上对全范围 RGB 是空操作，
  // 实测 warm/cool 会输出完全相同的画面。色温也更贴近「调白平衡」的实际语义。
  warm: 'colortemperature=temperature=5600,eq=contrast=1.04',
  // 冷调：悬疑、疏离、夜戏
  cool: 'colortemperature=temperature=7500,eq=contrast=1.05',
  // 青橙：商业片最常见的肤色/背景分离——暗部压向青、亮部推向橙
  teal_orange: "curves=r='0/0 0.25/0.21 0.75/0.80 1/1':b='0/0.04 0.25/0.29 0.75/0.72 1/1',eq=contrast=1.06:saturation=1.05",
  // 低饱和高对比：冷冽、复仇、压抑
  bleach: 'eq=saturation=0.72:contrast=1.14,curves=preset=medium_contrast',
};

const PRESET_LABELS = {
  neutral: '轻度归一（推荐）',
  film: '电影感',
  warm: '暖调',
  cool: '冷调',
  teal_orange: '青橙',
  bleach: '低饱和高对比',
};

/** ffmpeg 滤镜参数里的路径需要转义盘符冒号与单引号 */
function escapeFilterPath(absPath) {
  let s = String(absPath).replace(/\\/g, '/');
  if (/^[A-Za-z]:/.test(s)) s = s.replace(/^([A-Za-z]):/, '$1\\:');
  return s.replace(/'/g, "\\'");
}

function resolveColorGradeConfig(cfg, mergeOpts = {}) {
  const fromCfg = cfg?.video?.color_grade || {};
  const preset = String(mergeOpts.color_grade_preset ?? fromCfg.preset ?? 'none').toLowerCase();
  const lutFile = mergeOpts.color_grade_lut ?? fromCfg.lut_file ?? '';
  return {
    preset,
    lutFile: lutFile ? String(lutFile) : '',
    enabled: preset !== 'none' && preset !== 'off' ? true : !!lutFile,
  };
}

/**
 * 生成调色滤镜串。
 * 提供了 .cube LUT 文件时以 LUT 为准（用户自带的调色一定比预设更贴合他的片子）。
 * @returns {string|null} 滤镜串；无需调色时返回 null
 */
function buildColorGradeFilter(cfg, mergeOpts, log) {
  const conf = resolveColorGradeConfig(cfg, mergeOpts);
  if (!conf.enabled) return null;

  if (conf.lutFile) {
    if (fs.existsSync(conf.lutFile)) {
      log?.info?.('[调色] 使用 LUT 文件', { lut: conf.lutFile });
      return `lut3d='${escapeFilterPath(conf.lutFile)}'`;
    }
    log?.warn?.('[调色] LUT 文件不存在，回落到预设', { lut: conf.lutFile, preset: conf.preset });
  }

  const filter = PRESETS[conf.preset];
  if (!filter) {
    log?.warn?.('[调色] 未知预设，跳过调色', { preset: conf.preset });
    return null;
  }
  log?.info?.('[调色] 使用预设', { preset: conf.preset });
  return filter;
}

module.exports = {
  PRESETS,
  PRESET_LABELS,
  escapeFilterPath,
  resolveColorGradeConfig,
  buildColorGradeFilter,
};
