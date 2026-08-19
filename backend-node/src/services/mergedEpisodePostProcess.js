/**
 * 整集合并后的后处理：对白 TTS 轨、解说旁白轨+SRT、右下角文字水印（可组合）。
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { getFfmpegPath, getFfprobePath } = require('../utils/ffmpegPath');

function ffprobeDurationSec(filePath) {
  const probe = getFfprobePath();
  const r = spawnSync(
    probe,
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath],
    { encoding: 'utf8', maxBuffer: 1024 * 1024 }
  );
  if (r.status !== 0) return null;
  const d = parseFloat(String(r.stdout || '').trim());
  return Number.isFinite(d) && d > 0 ? d : null;
}

function formatSrtTimestamp(ms) {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const z = Math.floor(ms % 1000);
  const p2 = (n) => String(n).padStart(2, '0');
  return `${p2(h)}:${p2(m)}:${p2(s)},${String(z).padStart(3, '0')}`;
}

/**
 * 变速上下限：超出这个范围人耳就能听出「机器人加速」。
 * 时长应由 shotDurationPlanner 在生成阶段对齐，这里只做微调兜底。
 */
const MAX_TEMPO = 1.15;
const MIN_TEMPO = 0.90;

function buildAtempoChain(factor) {
  if (!Number.isFinite(factor) || factor <= 0) return null;
  if (Math.abs(factor - 1) < 0.002) return null;
  const parts = [];
  let f = factor;
  while (f > 2.001) {
    parts.push('atempo=2');
    f /= 2;
  }
  while (f < 0.499) {
    parts.push('atempo=0.5');
    f /= 0.5;
  }
  parts.push(`atempo=${Math.min(2, Math.max(0.5, f))}`);
  return parts.join(',');
}

function escapeFfmpegPath(absPath) {
  let s = path.resolve(absPath).replace(/\\/g, '/');
  if (/^[A-Za-z]:/.test(s)) s = s.replace(/^([A-Za-z]):/, '$1\\:');
  return s.replace(/'/g, "\\'");
}

function runFfmpeg(args, log, tag) {
  const bin = getFfmpegPath();
  const r = spawnSync(bin, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (r.error) {
    log.warn('merged post: ffmpeg spawn', { tag, error: r.error.message });
    return false;
  }
  if (r.status !== 0) {
    log.warn('merged post: ffmpeg failed', { tag, stderr: r.stderr?.slice(-1000) });
    return false;
  }
  return true;
}

function writeSilenceMp3(slotSec, outPath, log) {
  return runFfmpeg(
    ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-t', String(slotSec), '-c:a', 'libmp3lame', '-q:a', '6', outPath],
    log,
    'silence'
  );
}

function fitAudioToSlot(inputPath, slotSec, outPath, log) {
  const d = ffprobeDurationSec(inputPath);
  if (d == null || d <= 0.01) return false;
  const eps = 0.06;
  if (d > slotSec + eps) {
    // 只允许 ≤15% 的加速；再长就淡出截断，而不是把人声压成「机器人」。
    const factor = Math.min(MAX_TEMPO, d / slotSec);
    const chain = buildAtempoChain(factor);
    const filters = [];
    if (chain) filters.push(chain);
    const fadeStart = Math.max(0, slotSec - 0.25);
    filters.push(`afade=t=out:st=${fadeStart.toFixed(3)}:d=0.25`);
    if (d / slotSec > MAX_TEMPO + 0.01) {
      log.warn('merged post: 配音超出镜头时长，已淡出截断（建议先跑一次「音频先行时长对齐」或按对白拆镜）', {
        audio_sec: Math.round(d * 100) / 100,
        slot_sec: Math.round(slotSec * 100) / 100,
        applied_tempo: Math.round(factor * 100) / 100,
      });
    }
    return runFfmpeg(
      ['-y', '-i', inputPath, '-af', filters.join(','), '-t', String(slotSec), '-c:a', 'libmp3lame', '-q:a', '4', outPath],
      log,
      'fit_speed'
    );
  }
  if (d < slotSec - eps) {
    const pad = slotSec - d;
    return runFfmpeg(
      ['-y', '-i', inputPath, '-af', `apad=pad_dur=${pad}`, '-t', String(slotSec), '-c:a', 'libmp3lame', '-q:a', '4', outPath],
      log,
      'fit_pad'
    );
  }
  try {
    fs.copyFileSync(inputPath, outPath);
    return true;
  } catch (_) {
    return runFfmpeg(
      ['-y', '-i', inputPath, '-t', String(slotSec), '-c:a', 'libmp3lame', '-q:a', '4', outPath],
      log,
      'fit_copy'
    );
  }
}

function concatMp3List(segmentPaths, outPath, log) {
  const listFile = path.join(path.dirname(outPath), `mix_concat_${Date.now()}.txt`);
  try {
    const lines = segmentPaths.map((p) => {
      const normalized = path.resolve(p).replace(/\\/g, '/');
      return `file '${normalized.replace(/'/g, "'\\''")}'`;
    });
    fs.writeFileSync(listFile, lines.join('\n'), 'utf8');
    return runFfmpeg(
      ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c:a', 'libmp3lame', '-q:a', '4', outPath],
      log,
      'concat_mix'
    );
  } finally {
    try {
      if (fs.existsSync(listFile)) fs.unlinkSync(listFile);
    } catch (_) {}
  }
}

function alignAudioToVideoDuration(inMp3, videoDur, outPath, log) {
  const n = ffprobeDurationSec(inMp3);
  if (n == null || !Number.isFinite(videoDur) || videoDur <= 0.1) return false;
  const eps = 0.08;
  if (n > videoDur + eps) {
    const factor = Math.min(MAX_TEMPO, n / videoDur);
    const chain = buildAtempoChain(factor);
    if (!chain) {
      try {
        fs.copyFileSync(inMp3, outPath);
        return true;
      } catch (_) {
        return false;
      }
    }
    return runFfmpeg(
      ['-y', '-i', inMp3, '-af', chain, '-t', String(videoDur), '-c:a', 'libmp3lame', '-q:a', '4', outPath],
      log,
      'align_speed'
    );
  }
  if (n < videoDur - eps) {
    const pad = videoDur - n;
    return runFfmpeg(
      ['-y', '-i', inMp3, '-af', `apad=pad_dur=${pad}`, '-t', String(videoDur), '-c:a', 'libmp3lame', '-q:a', '4', outPath],
      log,
      'align_pad'
    );
  }
  try {
    fs.copyFileSync(inMp3, outPath);
    return true;
  } catch (_) {
    return false;
  }
}

function amixTwoTracks(pathA, pathB, slotSec, outPath, log) {
  return runFfmpeg(
    [
      '-y', '-i', pathA, '-i', pathB,
      '-filter_complex', `[0:a][1:a]amix=inputs=2:duration=first:dropout_transition=2[aout]`,
      '-map', '[aout]',
      '-t', String(slotSec),
      '-c:a', 'libmp3lame', '-q:a', '4',
      outPath,
    ],
    log,
    'amix_seg'
  );
}

function getDrawtextFontOption() {
  const candidates = [];
  if (process.platform === 'win32') {
    const root = process.env.SystemRoot || 'C:\\Windows';
    candidates.push(
      path.join(root, 'Fonts', 'msyh.ttc'),
      path.join(root, 'Fonts', 'msyhbd.ttc'),
      path.join(root, 'Fonts', 'simhei.ttf')
    );
  }
  candidates.push('/System/Library/Fonts/PingFang.ttc', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf');
  for (const p of candidates) {
    if (p && fs.existsSync(p)) {
      return `:fontfile='${escapeFfmpegPath(p)}'`;
    }
  }
  return '';
}

/**
 * @param {object} mergeOpts — burn_dialogue_audio, burn_narration_subtitles, watermark_text
 */
async function runMergedEpisodePostProcess(db, log, opts) {
  const {
    mergedAbsPath, storageRoot, scenes, episodeId,
    mergeOpts = {}, segmentDurations = null, sceneTimeline = null,
  } = opts;
  /**
   * 时间轴基准，优先级从高到低：
   *   1. sceneTimeline —— 带段落转场时的真实起始时间。xfade 让相邻段落重叠，
   *      后续镜头会整体前移，只按时长累加会让配音/字幕越到后面错得越多。
   *   2. 每段视频文件的 ffprobe 实测时长 —— 供应商常把时长吸附到自己的档位（7s → 10s）。
   *   3. 分镜声明的 duration —— 最后的兜底。
   */
  const slotOf = (i, sc) => {
    const fromTimeline = Array.isArray(sceneTimeline) ? Number(sceneTimeline[i]?.durSec) : NaN;
    if (Number.isFinite(fromTimeline) && fromTimeline > 0.05) return fromTimeline;
    const measured = Array.isArray(segmentDurations) ? Number(segmentDurations[i]) : NaN;
    if (Number.isFinite(measured) && measured > 0.05) return measured;
    return Math.max(0.2, Number(sc?.duration) || 5);
  };
  /** 第 i 个镜头在成片里的起始毫秒；有转场时不能靠时长累加 */
  const startMsOf = (i) => {
    const t = Array.isArray(sceneTimeline) ? Number(sceneTimeline[i]?.startSec) : NaN;
    return Number.isFinite(t) ? Math.round(t * 1000) : null;
  };
  /**
   * 第 i 个镜头在成片时间轴上实际占据的秒数 = 到下一个镜头起点的间距。
   * 段落边界处 xfade 吃掉 D 秒重叠，所以这里会比该镜自身时长短——
   * 音轨与字幕都必须按这个间距排，否则整条音轨会比画面长出 (段数−1)×D。
   */
  const spacingOf = (i, sc) => {
    if (Array.isArray(sceneTimeline)) {
      const cur = startMsOf(i);
      const next = i + 1 < scenes.length ? startMsOf(i + 1) : null;
      if (cur != null && next != null && next > cur) return (next - cur) / 1000;
    }
    return slotOf(i, sc);
  };
  const wantDial = !!mergeOpts.burn_dialogue_audio;
  const wantNarr = !!mergeOpts.burn_narration_subtitles;
  // 短剧必须有对白硬字幕：大量观众在无声环境下刷剧，没字幕等于没内容
  const wantDialSubs = mergeOpts.burn_dialogue_subtitles !== false;
  // BGM 铺底 + 对白闪避；曲库为空时会自动跳过，不报错。
  // 合成选项优先于全局配置（wantBgm/音量/闪避在 cfgForPost 解析后确定，见下方）
  let wantBgm = true;
  const watermarkText = (mergeOpts.watermark_text && String(mergeOpts.watermark_text).trim())
    ? String(mergeOpts.watermark_text).trim().slice(0, 200)
    : '';

  if (!mergedAbsPath || !fs.existsSync(mergedAbsPath) || !Array.isArray(scenes) || scenes.length === 0) {
    return { ok: false, error: '无效合成参数' };
  }

  const needAudio = wantDial || wantNarr;
  // 只要有对白就值得烧字幕，即使用户没勾选配音
  const hasDialogueText = Array.isArray(scenes) && scenes.some((sc) => {
    const r = db.prepare('SELECT dialogue FROM storyboards WHERE id = ? AND deleted_at IS NULL').get(Number(sc?.scene_id));
    return !!(r?.dialogue && String(r.dialogue).trim());
  });
  const needSubtitleOnlyPass = !needAudio && wantDialSubs && hasDialogueText;

  const cfgForPost = (() => { try { return require('../config').loadConfig(); } catch (_) { return {}; } })();
  const bgmCfg = cfgForPost?.video?.bgm || {};
  wantBgm = mergeOpts.bgm_enabled != null ? !!mergeOpts.bgm_enabled : bgmCfg.enabled !== false;
  const bgmVolume = Number(mergeOpts.bgm_volume ?? bgmCfg.volume ?? 0.28);
  const bgmDuck = mergeOpts.bgm_duck != null ? !!mergeOpts.bgm_duck : bgmCfg.duck !== false;

  const colorGrade = require('./colorGrade');
  const colorFilter = colorGrade.buildColorGradeFilter(cfgForPost, mergeOpts, log);

  if (!needAudio && !watermarkText && !needSubtitleOnlyPass && !wantBgm && !colorFilter) {
    return { ok: false, error: 'NO_POST_OPTS' };
  }

  const videoDur = ffprobeDurationSec(mergedAbsPath);
  if (videoDur == null) {
    return { ok: false, error: '无法读取合成视频时长' };
  }

  const tempRoot = path.join(require('os').tmpdir(), 'drama-merged-post', String(episodeId || 0), String(Date.now()));
  fs.mkdirSync(tempRoot, { recursive: true });
  const ttsService = require('./ttsService');

  try {
    let alignedAudioPath = null;
    let srtPath = null;
    /** 结构化字幕条目 {startMs, endMs, text}，最后统一排序编号，避免对白/旁白编号交错 */
    const srtEntries = [];
    const { parseDialogueToEntries, charSpeechWeight } = require('./speechTiming');

    /** 把一条分镜的对白按估算语速在该镜时长内切成多条字幕 */
    const pushDialogueSubtitles = (dialogueText, startMs, slotSec) => {
      const entries = parseDialogueToEntries(dialogueText);
      if (entries.length === 0) return;
      const weights = entries.map((e) => Math.max(0.3, charSpeechWeight(e.text, 'dialogue')));
      const totalWeight = weights.reduce((a, b) => a + b, 0) || 1;
      let cursor = startMs;
      for (let k = 0; k < entries.length; k++) {
        const spanMs = Math.round((weights[k] / totalWeight) * slotSec * 1000);
        srtEntries.push({
          startMs: cursor,
          endMs: cursor + Math.max(600, spanMs),
          // 字幕只显示台词本身，不显示「角色名：」
          text: entries[k].text,
        });
        cursor += spanMs;
      }
    };

    // ── 仅烧字幕（用户没开配音）时也要走一遍时间轴 ──
    if (!needAudio && needSubtitleOnlyPass) {
      let tMs = 0;
      for (let i = 0; i < scenes.length; i++) {
        const sc = scenes[i];
        const slotSec = spacingOf(i, sc);
        const startMs = startMsOf(i) ?? tMs;
        const row = db.prepare('SELECT dialogue FROM storyboards WHERE id = ? AND deleted_at IS NULL').get(Number(sc.scene_id));
        if (row?.dialogue && String(row.dialogue).trim()) {
          pushDialogueSubtitles(row.dialogue, startMs, slotSec);
        }
        tMs = startMs + Math.round(slotSec * 1000);
      }
    }

    if (needAudio) {
      let tMs = 0;
      const segmentFiles = [];

      for (let i = 0; i < scenes.length; i++) {
        const sc = scenes[i];
        const sbId = Number(sc.scene_id);
        // 音轨按成片时间轴的实际间距铺，段落转场处会比镜头自身时长短
        const slotSec = spacingOf(i, sc);
        const row = db.prepare(
          'SELECT dialogue, narration, audio_local_path, narration_audio_local_path FROM storyboards WHERE id = ? AND deleted_at IS NULL'
        ).get(sbId);

        const startMs = startMsOf(i) ?? tMs;
        const narrText = (row?.narration && String(row.narration).trim()) ? String(row.narration).trim() : '';
        if (wantNarr && narrText) {
          const durMs = Math.round(slotSec * 1000);
          srtEntries.push({ startMs, endMs: startMs + durMs, text: narrText });
        }
        if (wantDialSubs && row?.dialogue && String(row.dialogue).trim()) {
          pushDialogueSubtitles(row.dialogue, startMs, slotSec);
        }
        tMs = startMs + Math.round(slotSec * 1000);

        const diaFit = path.join(tempRoot, `dia_fit_${i}.mp3`);
        const narrFit = path.join(tempRoot, `narr_fit_${i}.mp3`);
        const segOut = path.join(tempRoot, `seg_mix_${i}.mp3`);

        if (wantDial) {
          const rel = row?.audio_local_path && String(row.audio_local_path).trim();
          const srcAbs = rel ? path.join(storageRoot, rel.replace(/\//g, path.sep)) : null;
          if (srcAbs && fs.existsSync(srcAbs)) {
            if (!fitAudioToSlot(srcAbs, slotSec, diaFit, log)) {
              return { ok: false, error: `对白配音时长对齐失败 #${i}` };
            }
          } else if (!writeSilenceMp3(slotSec, diaFit, log)) {
            return { ok: false, error: `对白静音片段失败 #${i}` };
          }
        }

        if (wantNarr) {
          if (!narrText) {
            if (!writeSilenceMp3(slotSec, narrFit, log)) {
              return { ok: false, error: `旁白静音片段失败 #${i}` };
            }
          } else {
            const segRaw = path.join(tempRoot, `narr_raw_${i}.mp3`);
            let synth;
            try {
              synth = await ttsService.synthesize(db, log, {
                text: narrText,
                storyboard_id: null,
                storage_base: storageRoot,
              });
            } catch (e) {
              log.warn('merged post: narration TTS failed', { segment: i, error: e.message });
              return { ok: false, error: `解说旁白 TTS 失败：${e.message}` };
            }
            const narrAbs = path.join(storageRoot, synth.local_path.replace(/\//g, path.sep));
            if (!fs.existsSync(narrAbs)) {
              return { ok: false, error: `旁白 TTS 文件不存在` };
            }
            try {
              fs.copyFileSync(narrAbs, segRaw);
            } catch (_) {
              return { ok: false, error: '复制旁白 TTS 失败' };
            }
            if (!fitAudioToSlot(segRaw, slotSec, narrFit, log)) {
              return { ok: false, error: `旁白时长对齐失败 #${i}` };
            }
          }
        }

        if (wantDial && wantNarr) {
          if (!amixTwoTracks(diaFit, narrFit, slotSec, segOut, log)) {
            return { ok: false, error: `对白与旁白混音失败 #${i}` };
          }
        } else if (wantDial) {
          try {
            fs.copyFileSync(diaFit, segOut);
          } catch (_) {
            return { ok: false, error: `对白片段复制失败 #${i}` };
          }
        } else if (wantNarr) {
          try {
            fs.copyFileSync(narrFit, segOut);
          } catch (_) {
            return { ok: false, error: `旁白片段复制失败 #${i}` };
          }
        }

        segmentFiles.push(segOut);
      }

      const concatOut = path.join(tempRoot, 'full_mix.mp3');
      if (!concatMp3List(segmentFiles, concatOut, log)) {
        return { ok: false, error: '音轨拼接失败' };
      }

      alignedAudioPath = path.join(tempRoot, 'aligned_mix.mp3');
      if (!alignAudioToVideoDuration(concatOut, videoDur, alignedAudioPath, log)) {
        return { ok: false, error: '音轨与视频总时长对齐失败' };
      }

    }

    // ── BGM 铺底 + 对白闪避 ────────────────────────────────────────
    // 逐镜配乐是错的：一个 segment 是一个完整戏剧节拍，音乐应当在节拍内保持、节拍之间换。
    // 曲库为空时静默跳过——没有音乐总好过报错卡住整条合成。
    let finalAudioPath = alignedAudioPath;
    if (wantBgm) {
      try {
        const bgmLibrary = require('./bgmLibrary');
        bgmLibrary.ensureLibraryDirs(storageRoot, log);
        const { byMood, total } = bgmLibrary.scanLibrary(storageRoot, log);
        if (total === 0) {
          log.info('[BGM] 曲库为空，跳过配乐（把音乐放进 storage/bgm/<情绪>/ 即可启用）');
        } else {
          // 每镜在成片里的起止（已含转场重叠修正）
          let cursorSec = 0;
          const sceneSlots = scenes.map((sc, i) => {
            const startSec = (startMsOf(i) ?? Math.round(cursorSec * 1000)) / 1000;
            const durSec = spacingOf(i, sc);
            cursorSec = startSec + durSec;
            return { startSec, durSec };
          });
          const shotRows = scenes.map((sc) => {
            try {
              return db.prepare(
                'SELECT emotion, emotion_intensity, atmosphere, segment_index FROM storyboards WHERE id = ? AND deleted_at IS NULL'
              ).get(Number(sc.scene_id)) || {};
            } catch (_) {
              return {};
            }
          });

          const { cues } = bgmLibrary.planEpisodeBgm(sceneSlots, shotRows, byMood, videoDur, log);
          const bgmPath = cues.length ? bgmLibrary.buildBgmTrack(cues, videoDur, tempRoot, log) : null;
          if (bgmPath) {
            const mixed = path.join(tempRoot, 'voice_bgm_mix.mp3');
            const mixedOk = bgmLibrary.mixVoiceWithBgm(
              alignedAudioPath, bgmPath, videoDur, mixed, log,
              {
                volume: bgmVolume,
                duck: bgmDuck,
                duckThreshold: bgmCfg.duck_threshold,
                duckRatio: bgmCfg.duck_ratio,
                duckRelease: bgmCfg.duck_release_ms,
              }
            );
            if (mixedOk) finalAudioPath = mixed;
            else log.warn('[BGM] 混音失败，保留原音轨');
          }
        }
      } catch (bgmErr) {
        log.warn('[BGM] 配乐失败，按无 BGM 继续', { error: bgmErr.message });
      }
    }

    if (srtEntries.length > 0) {
      srtEntries.sort((a, b) => a.startMs - b.startMs);
      const lines = [];
      srtEntries.forEach((e, idx) => {
        lines.push(String(idx + 1), `${formatSrtTimestamp(e.startMs)} --> ${formatSrtTimestamp(e.endMs)}`, e.text, '');
      });
      const srtBaseName = path.basename(mergedAbsPath, path.extname(mergedAbsPath));
      srtPath = path.join(path.dirname(mergedAbsPath), `${srtBaseName}.srt`);
      fs.writeFileSync(srtPath, `\uFEFF${lines.join('\n')}\n`, 'utf8');
      log.info('merged post: 字幕已生成', { entries: srtEntries.length, path: srtPath });
    }

    const baseName = path.basename(mergedAbsPath, path.extname(mergedAbsPath));
    const outAbs = path.join(path.dirname(mergedAbsPath), `${baseName}_post.mp4`);

    const hasSubs = !!(srtPath && fs.existsSync(srtPath));
    const hasWm = !!watermarkText;

    const vfParts = [];
    // 调色必须排在字幕与水印之前，否则白色字幕会被一起调色而发黄/发蓝
    if (colorFilter) vfParts.push(colorFilter);
    if (hasSubs) {
      const subEsc = escapeFfmpegPath(srtPath);
      vfParts.push(`subtitles='${subEsc}':charenc=UTF-8`);
    }
    if (hasWm) {
      const wmFile = path.join(tempRoot, 'watermark.txt');
      fs.writeFileSync(wmFile, watermarkText, 'utf8');
      const wmEsc = escapeFfmpegPath(wmFile);
      const fontOpt = getDrawtextFontOption();
      vfParts.push(
        `drawtext=textfile='${wmEsc}':reload=1${fontOpt}:x=w-tw-16:y=h-th-16:fontsize=22:fontcolor=white@0.82:borderw=2:bordercolor=black@0.55`
      );
    }
    // 任意段数的滤镜链（调色 → 字幕 → 水印）
    let filterComplex = '';
    if (vfParts.length > 0) {
      const links = [];
      let prev = '[0:v]';
      vfParts.forEach((f, i) => {
        const out = i === vfParts.length - 1 ? '[vout]' : `[vf${i}]`;
        links.push(`${prev}${f}${out}`);
        prev = out;
      });
      filterComplex = links.join(';');
    }

    const hasNewAudio = !!(finalAudioPath && fs.existsSync(finalAudioPath));
    if (needAudio && !hasNewAudio) {
      return { ok: false, error: '内部错误：缺少对齐音轨' };
    }

    if (hasNewAudio) {
      const args = ['-y', '-i', mergedAbsPath, '-i', finalAudioPath];
      if (filterComplex) {
        args.push('-filter_complex', filterComplex, '-map', '[vout]', '-map', '1:a');
      } else {
        args.push('-map', '0:v', '-map', '1:a');
      }
      args.push(
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
        '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-shortest', outAbs
      );
      if (!runFfmpeg(args, log, 'mux_av')) {
        return { ok: false, error: '烧录字幕/水印或混音失败（请确认 ffmpeg 含 libx264）' };
      }
    } else {
      if (!filterComplex) {
        // 字幕/水印/调色都没有落到实处：保留原合成结果，不做多余的重编码
        return { ok: false, error: 'NO_POST_OPTS' };
      }
      const args = ['-y', '-i', mergedAbsPath, '-filter_complex', filterComplex, '-map', '[vout]'];
      if (ffprobeHasAudio(mergedAbsPath)) {
        args.push('-map', '0:a', '-c:a', 'copy');
      } else {
        args.push('-an');
      }
      args.push('-c:v', 'libx264', '-preset', 'fast', '-crf', '23', '-movflags', '+faststart', outAbs);
      if (!runFfmpeg(args, log, 'video_filters_only')) {
        return { ok: false, error: '字幕/水印/调色烧录失败' };
      }
    }

    if (!fs.existsSync(outAbs)) {
      return { ok: false, error: '输出文件未生成' };
    }

    const relFromRoot = path.relative(storageRoot, outAbs).replace(/\\/g, '/');

    try {
      if (fs.existsSync(mergedAbsPath) && outAbs !== mergedAbsPath) {
        fs.unlinkSync(mergedAbsPath);
      }
    } catch (e) {
      log.warn('merged post: could not remove intermediate', { error: e.message });
    }

    log.info('merged post: done', { episode_id: episodeId, video: relFromRoot });
    return { ok: true, relativePath: relFromRoot };
  } catch (e) {
    log.warn('merged post: exception', { error: e.message });
    return { ok: false, error: e.message || String(e) };
  } finally {
    try {
      for (const p of fs.readdirSync(tempRoot)) {
        try {
          fs.unlinkSync(path.join(tempRoot, p));
        } catch (_) {}
      }
      fs.rmdirSync(tempRoot);
    } catch (_) {}
  }
}

function ffprobeHasAudio(filePath) {
  const probe = getFfprobePath();
  const r = spawnSync(
    probe,
    ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', filePath],
    { encoding: 'utf8', maxBuffer: 1024 * 1024 }
  );
  return r.status === 0 && String(r.stdout || '').trim().length > 0;
}

module.exports = {
  runMergedEpisodePostProcess,
  ffprobeDurationSec,
};
