/**
 * BGM 曲库与配乐规划。
 *
 * 成片此前从头到尾没有任何音乐，对白之间就是死寂——这是观众最先察觉的业余感来源。
 *
 * 走本地曲库而不是 AI 音乐生成：符合项目「本地优先、数据不出本机」的定位，
 * 不引入新供应商、不产生每次合成的费用，用户把自己有版权的曲子丢进目录即可。
 *
 * 选曲由**段落**驱动而不是逐镜：一个 segment 是一个完整的戏剧节拍，
 * 音乐在节拍内保持不变、在节拍之间换，才是正常的影视配乐逻辑。
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { getFfmpegPath, getFfprobePath } = require('../utils/ffmpegPath');

/** 曲库目录名 = 情绪标签 */
const MOODS = ['tense', 'suspense', 'sad', 'warm', 'uplift', 'neutral'];

const MOOD_LABELS = {
  tense: '紧张 / 冲突 / 对峙',
  suspense: '悬疑 / 不安 / 铺垫',
  sad: '悲伤 / 失落 / 遗憾',
  warm: '温情 / 日常 / 治愈',
  uplift: '高昂 / 希望 / 释然',
  neutral: '中性铺底（找不到匹配情绪时使用）',
};

const AUDIO_EXT = new Set(['.mp3', '.m4a', '.aac', '.wav', '.flac', '.ogg']);

/** 情绪关键词 → mood。命中即取，顺序即优先级。 */
const EMOTION_PATTERNS = [
  [/紧张|愤怒|恼怒|暴怒|对峙|冲突|争执|惊恐|恐惧|焦虑|慌|怒/, 'tense'],
  [/悬疑|疑惑|狐疑|不安|诡异|阴森|警觉|戒备/, 'suspense'],
  [/悲伤|难过|痛苦|绝望|失落|遗憾|哀|泪|心碎|沉重/, 'sad'],
  [/兴奋|激动|胜利|希望|振奋|畅快|释然|解脱|坚定/, 'uplift'],
  [/温暖|温情|欣慰|幸福|甜蜜|平静|安宁|柔和|怀念/, 'warm'],
];

function bgmRootOf(storageRoot) {
  return path.join(storageRoot, 'bgm');
}

/**
 * 首次使用时把目录结构建出来并附说明，省得用户猜文件该放哪。
 * 已存在则不动。
 */
function ensureLibraryDirs(storageRoot, log) {
  const root = bgmRootOf(storageRoot);
  try {
    if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });
    for (const mood of MOODS) {
      const dir = path.join(root, mood);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    }
    const readme = path.join(root, '使用说明.txt');
    if (!fs.existsSync(readme)) {
      fs.writeFileSync(
        readme,
        [
          'BGM 曲库',
          '',
          '把你有版权的背景音乐（mp3 / m4a / wav / flac / ogg）按情绪丢进对应子目录：',
          '',
          ...MOODS.map((m) => `  ${m}/\t${MOOD_LABELS[m]}`),
          '',
          '合成整集时，系统会按每个剧情段落的情绪自动选曲，段落之间交叉淡入淡出，',
          '并在有对白/旁白时自动压低音乐音量（ducking），对白结束后回升。',
          '',
          '直接丢在 bgm/ 根目录下的文件会被当作 neutral（中性铺底）。',
          '曲库为空时不会报错，只是不加 BGM。',
          '',
          '注意：请只使用你拥有使用权的音乐。',
        ].join('\n'),
        'utf8'
      );
    }
  } catch (err) {
    log?.warn?.('[BGM] 曲库目录初始化失败', { error: err.message });
  }
  return root;
}

/** ffprobe 读时长 */
function probeDuration(absPath) {
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
 * 扫描曲库。
 * @returns {{ byMood: Record<string, Array<{path:string, name:string, durationSec:number|null}>>, total:number }}
 */
function scanLibrary(storageRoot, log) {
  const root = bgmRootOf(storageRoot);
  const byMood = Object.fromEntries(MOODS.map((m) => [m, []]));
  let total = 0;

  if (!fs.existsSync(root)) return { byMood, total };

  const addFile = (mood, abs) => {
    if (!AUDIO_EXT.has(path.extname(abs).toLowerCase())) return;
    byMood[mood].push({ path: abs, name: path.basename(abs), durationSec: probeDuration(abs) });
    total += 1;
  };

  // 根目录散放的文件归为 neutral
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      const abs = path.join(root, entry.name);
      if (entry.isFile()) addFile('neutral', abs);
      else if (entry.isDirectory() && MOODS.includes(entry.name)) {
        for (const f of fs.readdirSync(abs)) {
          const fAbs = path.join(abs, f);
          try { if (fs.statSync(fAbs).isFile()) addFile(entry.name, fAbs); } catch (_) {}
        }
      }
    }
  } catch (err) {
    log?.warn?.('[BGM] 曲库扫描失败', { error: err.message });
  }

  return { byMood, total };
}

/**
 * 由段落内各镜的情绪推断 mood。
 * 先看情绪文本（信息量更大），文本没命中再退回情绪强度。
 */
function moodForSegment(shots) {
  const text = shots.map((s) => `${s.emotion || ''} ${s.atmosphere || ''}`).join(' ');
  for (const [re, mood] of EMOTION_PATTERNS) {
    if (re.test(text)) return mood;
  }
  const intensities = shots
    .map((s) => Number(s.emotion_intensity))
    .filter((n) => Number.isFinite(n));
  if (intensities.length === 0) return 'neutral';
  const avg = intensities.reduce((a, b) => a + b, 0) / intensities.length;
  if (avg >= 2) return 'tense';
  if (avg >= 1) return 'uplift';
  if (avg <= -0.5) return 'sad';
  return 'warm';
}

/** 选曲：优先本 mood，缺曲则退到 neutral，再退到任意有曲的 mood；尽量不与上一段重复 */
function pickTrack(byMood, mood, lastPath) {
  const order = [mood, 'neutral', ...MOODS.filter((m) => m !== mood && m !== 'neutral')];
  for (const m of order) {
    const pool = byMood[m] || [];
    if (pool.length === 0) continue;
    const fresh = pool.filter((t) => t.path !== lastPath);
    const chosen = (fresh.length ? fresh : pool)[Math.floor(Math.random() * (fresh.length ? fresh.length : pool.length))];
    if (chosen) return { ...chosen, mood: m, fallbackFrom: m === mood ? null : mood };
  }
  return null;
}

/**
 * 规划整集配乐。
 *
 * @param {Array<{startSec:number, durSec:number}>} sceneSlots 每镜在成片里的起止（已含转场重叠修正）
 * @param {Array<object>} shotRows 与 sceneSlots 同序的分镜行（需 emotion / emotion_intensity / atmosphere / segment_index）
 * @returns {{ cues: Array<{startSec:number, endSec:number, mood:string, track:object}>, totalSec:number }}
 */
function planEpisodeBgm(sceneSlots, shotRows, byMood, totalSec, log) {
  const cues = [];
  if (!Array.isArray(sceneSlots) || sceneSlots.length === 0) return { cues, totalSec: 0 };

  // 按 segment_index 切连续分组（与转场用的是同一套段落划分）
  const groups = [];
  let cur = null;
  for (let i = 0; i < sceneSlots.length; i++) {
    const segIdx = shotRows[i]?.segment_index == null ? null : Number(shotRows[i].segment_index);
    if (!cur || cur.segmentIndex !== segIdx) {
      cur = { segmentIndex: segIdx, indices: [] };
      groups.push(cur);
    }
    cur.indices.push(i);
  }

  let lastPath = null;
  for (const g of groups) {
    const first = sceneSlots[g.indices[0]];
    const lastIdx = g.indices[g.indices.length - 1];
    const last = sceneSlots[lastIdx];
    const startSec = first.startSec;
    const endSec = Math.min(totalSec, last.startSec + last.durSec);
    if (!(endSec > startSec + 0.5)) continue;

    const mood = moodForSegment(g.indices.map((i) => shotRows[i] || {}));
    const track = pickTrack(byMood, mood, lastPath);
    if (!track) continue;
    lastPath = track.path;
    cues.push({ startSec, endSec, mood, track });
  }

  // 相邻同曲的 cue 合并，避免在同一首曲子中间做没必要的淡入淡出
  const merged = [];
  for (const cue of cues) {
    const prev = merged[merged.length - 1];
    if (prev && prev.track.path === cue.track.path && Math.abs(prev.endSec - cue.startSec) < 0.05) {
      prev.endSec = cue.endSec;
    } else {
      merged.push({ ...cue });
    }
  }

  log?.info?.('[BGM] 配乐规划', {
    cues: merged.length,
    moods: merged.map((c) => c.mood),
    tracks: merged.map((c) => c.track.name),
  });
  return { cues: merged, totalSec };
}

function runFfmpeg(args, log, tag) {
  const r = spawnSync(getFfmpegPath(), args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (r.error) {
    log?.warn?.('[BGM] ffmpeg spawn', { tag, error: r.error.message });
    return false;
  }
  if (r.status !== 0) {
    log?.warn?.('[BGM] ffmpeg failed', { tag, stderr: r.stderr?.slice(-1000) });
    return false;
  }
  return true;
}

/** 段落间的交叉淡入淡出时长（秒） */
const CUE_FADE = 1.2;

/**
 * 把配乐计划渲染成一条与成片等长的音轨。
 * 每个 cue 单独循环/裁剪到段落长度并加淡入淡出，再顺序拼接。
 */
function buildBgmTrack(cues, totalSec, tempDir, log) {
  if (!Array.isArray(cues) || cues.length === 0) return null;

  const parts = [];
  let cursor = 0;

  const writeSilence = (durSec, out) =>
    runFfmpeg(
      ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', durSec.toFixed(3), '-c:a', 'libmp3lame', '-q:a', '5', out],
      log,
      'bgm_silence'
    );

  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i];

    // cue 之间的空隙补静音，保证时间轴不漂
    if (cue.startSec > cursor + 0.05) {
      const gap = path.join(tempDir, `bgm_gap_${i}.mp3`);
      if (!writeSilence(cue.startSec - cursor, gap)) return null;
      parts.push(gap);
      cursor = cue.startSec;
    }

    const dur = Math.max(0.5, cue.endSec - cue.startSec);
    const out = path.join(tempDir, `bgm_cue_${i}.mp3`);
    const fade = Math.min(CUE_FADE, dur / 3);
    // -stream_loop -1 让短曲循环铺满整个段落
    const ok = runFfmpeg(
      [
        '-y', '-stream_loop', '-1', '-i', cue.track.path,
        '-t', dur.toFixed(3),
        '-af', `afade=t=in:st=0:d=${fade.toFixed(2)},afade=t=out:st=${(dur - fade).toFixed(2)}:d=${fade.toFixed(2)}`,
        '-ac', '2', '-ar', '44100', '-c:a', 'libmp3lame', '-q:a', '5', out,
      ],
      log,
      'bgm_cue'
    );
    if (!ok) return null;
    parts.push(out);
    cursor = cue.endSec;
  }

  if (totalSec > cursor + 0.05) {
    const tail = path.join(tempDir, 'bgm_tail.mp3');
    if (!writeSilence(totalSec - cursor, tail)) return null;
    parts.push(tail);
  }

  const listFile = path.join(tempDir, `bgm_concat_${Date.now()}.txt`);
  const outAbs = path.join(tempDir, 'bgm_full.mp3');
  try {
    fs.writeFileSync(
      listFile,
      parts.map((p) => `file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'),
      'utf8'
    );
    const ok = runFfmpeg(
      ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c:a', 'libmp3lame', '-q:a', '5', outAbs],
      log,
      'bgm_concat'
    );
    if (!ok) return null;
  } finally {
    try { if (fs.existsSync(listFile)) fs.unlinkSync(listFile); } catch (_) {}
  }

  log?.info?.('[BGM] 音轨已生成', { cues: cues.length, total_sec: Math.round(totalSec) });
  return outAbs;
}

/**
 * 人声 + BGM 混音，带对白闪避（ducking）。
 *
 * sidechaincompress 用人声作为触发信号压低 BGM：说话时音乐自动让路，
 * 说完回升。这一步才是让配乐听起来「专业」而不是「盖住台词」的关键。
 *
 * @param {string|null} voicePath 对白/旁白混合轨；无人声时传 null（只铺 BGM）
 */
function mixVoiceWithBgm(voicePath, bgmPath, totalSec, outPath, log, opts = {}) {
  const volume = Math.min(1, Math.max(0.05, Number(opts.volume) || 0.28));
  const duck = opts.duck !== false;
  // 实测这组参数在对白窗口把 BGM 压低约 10dB，落在广播配乐常用的 8–12dB 区间：
  // 再轻听不出让路，再重会有明显的「泵感」。
  const threshold = Number(opts.duckThreshold) > 0 ? Number(opts.duckThreshold) : 0.015;
  const ratio = Number(opts.duckRatio) > 0 ? Number(opts.duckRatio) : 12;
  const release = Number(opts.duckRelease) > 0 ? Number(opts.duckRelease) : 500;

  if (!voicePath) {
    return runFfmpeg(
      ['-y', '-i', bgmPath, '-af', `volume=${volume.toFixed(3)}`, '-t', totalSec.toFixed(3),
        '-c:a', 'libmp3lame', '-q:a', '4', outPath],
      log,
      'bgm_only'
    ) ? outPath : null;
  }

  const filters = [`[1:a]volume=${volume.toFixed(3)}[bgmv]`];
  if (duck) {
    // 输入顺序：0 = 人声，1 = BGM。sidechaincompress 的第二路输入是触发信号。
    filters.push(
      `[bgmv][0:a]sidechaincompress=threshold=${threshold}:ratio=${ratio}:attack=20:release=${release}:makeup=1[bgmduck]`
    );
    filters.push('[0:a][bgmduck]amix=inputs=2:duration=first:normalize=0[aout]');
  } else {
    filters.push('[0:a][bgmv]amix=inputs=2:duration=first:normalize=0[aout]');
  }

  const ok = runFfmpeg(
    ['-y', '-i', voicePath, '-i', bgmPath,
      '-filter_complex', filters.join(';'), '-map', '[aout]',
      '-t', totalSec.toFixed(3), '-c:a', 'libmp3lame', '-q:a', '4', outPath],
    log,
    duck ? 'mix_bgm_duck' : 'mix_bgm'
  );
  return ok ? outPath : null;
}

module.exports = {
  MOODS,
  MOOD_LABELS,
  CUE_FADE,
  bgmRootOf,
  ensureLibraryDirs,
  scanLibrary,
  moodForSegment,
  pickTrack,
  planEpisodeBgm,
  buildBgmTrack,
  mixVoiceWithBgm,
};
