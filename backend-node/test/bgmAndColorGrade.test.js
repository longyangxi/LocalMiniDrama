const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const bgmLibrary = require('../src/services/bgmLibrary');
const colorGrade = require('../src/services/colorGrade');

let tmpRoot;

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bgm-test-'));
});

after(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}
});

describe('BGM 曲库', () => {
  it('首次使用会建出情绪目录与说明文件', () => {
    const storage = path.join(tmpRoot, 'store1');
    fs.mkdirSync(storage, { recursive: true });
    bgmLibrary.ensureLibraryDirs(storage, null);
    for (const mood of bgmLibrary.MOODS) {
      assert.ok(fs.existsSync(path.join(storage, 'bgm', mood)), `缺少目录 ${mood}`);
    }
    assert.ok(fs.existsSync(path.join(storage, 'bgm', '使用说明.txt')));
  });

  it('曲库不存在时返回空而不是抛错', () => {
    const { byMood, total } = bgmLibrary.scanLibrary(path.join(tmpRoot, 'nonexistent'), null);
    assert.equal(total, 0);
    assert.deepEqual(Object.keys(byMood).sort(), [...bgmLibrary.MOODS].sort());
  });

  it('按情绪子目录归类，根目录散放的归为 neutral，非音频文件被忽略', () => {
    const storage = path.join(tmpRoot, 'store2');
    const root = path.join(storage, 'bgm');
    fs.mkdirSync(path.join(root, 'tense'), { recursive: true });
    fs.mkdirSync(path.join(root, 'warm'), { recursive: true });
    fs.writeFileSync(path.join(root, 'tense', 'a.mp3'), 'x');
    fs.writeFileSync(path.join(root, 'warm', 'b.wav'), 'x');
    fs.writeFileSync(path.join(root, 'loose.mp3'), 'x');
    fs.writeFileSync(path.join(root, '使用说明.txt'), 'x');

    const { byMood, total } = bgmLibrary.scanLibrary(storage, null);
    assert.equal(total, 3, '说明文件不应被当作曲目');
    assert.equal(byMood.tense.length, 1);
    assert.equal(byMood.warm.length, 1);
    assert.equal(byMood.neutral.length, 1);
  });
});

describe('情绪 → mood 判定', () => {
  it('情绪文本优先于强度', () => {
    assert.equal(bgmLibrary.moodForSegment([{ emotion: '愤怒对峙', emotion_intensity: -1 }]), 'tense');
    assert.equal(bgmLibrary.moodForSegment([{ emotion: '温暖欣慰', emotion_intensity: 3 }]), 'warm');
    assert.equal(bgmLibrary.moodForSegment([{ emotion: '悲伤失落' }]), 'sad');
    assert.equal(bgmLibrary.moodForSegment([{ atmosphere: '阴森诡异的走廊' }]), 'suspense');
  });

  it('无情绪文本时按强度回落', () => {
    assert.equal(bgmLibrary.moodForSegment([{ emotion_intensity: 3 }]), 'tense');
    assert.equal(bgmLibrary.moodForSegment([{ emotion_intensity: 1 }]), 'uplift');
    assert.equal(bgmLibrary.moodForSegment([{ emotion_intensity: -1 }]), 'sad');
    assert.equal(bgmLibrary.moodForSegment([{ emotion_intensity: 0 }]), 'warm');
  });

  it('完全没有信息时用 neutral', () => {
    assert.equal(bgmLibrary.moodForSegment([{}]), 'neutral');
    assert.equal(bgmLibrary.moodForSegment([]), 'neutral');
  });
});

describe('选曲', () => {
  const lib = () => ({
    tense: [{ path: '/t1.mp3', name: 't1' }, { path: '/t2.mp3', name: 't2' }],
    suspense: [], sad: [], warm: [],
    uplift: [], neutral: [{ path: '/n1.mp3', name: 'n1' }],
  });

  it('优先选本情绪的曲子', () => {
    assert.equal(bgmLibrary.pickTrack(lib(), 'tense', null).mood, 'tense');
  });

  it('本情绪没曲子时退到 neutral，并记录原本想要的情绪', () => {
    const t = bgmLibrary.pickTrack(lib(), 'sad', null);
    assert.equal(t.mood, 'neutral');
    assert.equal(t.fallbackFrom, 'sad');
  });

  it('尽量不与上一段用同一首', () => {
    for (let i = 0; i < 20; i++) {
      assert.notEqual(bgmLibrary.pickTrack(lib(), 'tense', '/t1.mp3').path, '/t1.mp3');
    }
  });

  it('该情绪只有一首时允许重复，不至于选不出曲', () => {
    const single = { tense: [], suspense: [], sad: [], warm: [], uplift: [], neutral: [{ path: '/n1.mp3', name: 'n1' }] };
    assert.equal(bgmLibrary.pickTrack(single, 'tense', '/n1.mp3').path, '/n1.mp3');
  });

  it('空曲库返回 null', () => {
    const empty = Object.fromEntries(bgmLibrary.MOODS.map((m) => [m, []]));
    assert.equal(bgmLibrary.pickTrack(empty, 'tense', null), null);
  });
});

describe('配乐规划', () => {
  const byMood = {
    tense: [{ path: '/t1.mp3', name: 't1' }],
    warm: [{ path: '/w1.mp3', name: 'w1' }],
    suspense: [], sad: [], uplift: [], neutral: [{ path: '/n1.mp3', name: 'n1' }],
  };
  const slots = [
    { startSec: 0, durSec: 5 }, { startSec: 5, durSec: 5 },
    { startSec: 10, durSec: 5 }, { startSec: 15, durSec: 5 },
  ];

  it('按段落而不是逐镜切 cue', () => {
    const rows = [
      { segment_index: 0, emotion: '紧张对峙' }, { segment_index: 0, emotion: '愤怒' },
      { segment_index: 1, emotion: '温暖欣慰' }, { segment_index: 1, emotion: '平静' },
    ];
    const { cues } = bgmLibrary.planEpisodeBgm(slots, rows, byMood, 20, null);
    assert.equal(cues.length, 2, '两个段落应产出两段配乐，而不是四段');
    assert.deepEqual(cues.map((c) => [c.startSec, c.endSec]), [[0, 10], [10, 20]]);
    assert.deepEqual(cues.map((c) => c.mood), ['tense', 'warm']);
  });

  it('cue 不会超出成片总长', () => {
    const rows = slots.map((_, i) => ({ segment_index: i, emotion: '紧张' }));
    const { cues } = bgmLibrary.planEpisodeBgm(slots, rows, byMood, 12, null);
    for (const c of cues) assert.ok(c.endSec <= 12, `cue 结束 ${c.endSec} 超过总长 12`);
  });

  it('相邻段落选中同一首时合并，避免曲子中间做无谓的淡入淡出', () => {
    const onlyOne = { tense: [], suspense: [], sad: [], warm: [], uplift: [], neutral: [{ path: '/n1.mp3', name: 'n1' }] };
    const rows = slots.map((_, i) => ({ segment_index: i, emotion: '平静' }));
    const { cues } = bgmLibrary.planEpisodeBgm(slots, rows, onlyOne, 20, null);
    assert.equal(cues.length, 1);
    assert.equal(cues[0].startSec, 0);
    assert.equal(cues[0].endSec, 20);
  });

  it('空曲库不产出任何 cue', () => {
    const empty = Object.fromEntries(bgmLibrary.MOODS.map((m) => [m, []]));
    const rows = slots.map(() => ({ segment_index: 0 }));
    assert.equal(bgmLibrary.planEpisodeBgm(slots, rows, empty, 20, null).cues.length, 0);
  });

  it('没有镜头时安全返回', () => {
    assert.deepEqual(bgmLibrary.planEpisodeBgm([], [], byMood, 0, null).cues, []);
  });
});

describe('色彩统一', () => {
  it('preset=none 时不调色', () => {
    assert.equal(colorGrade.buildColorGradeFilter({}, { color_grade_preset: 'none' }, null), null);
  });

  it('每个预设都能产出滤镜串', () => {
    for (const preset of Object.keys(colorGrade.PRESETS)) {
      const f = colorGrade.buildColorGradeFilter({}, { color_grade_preset: preset }, null);
      assert.ok(f && f.length > 0, `预设 ${preset} 未产出滤镜`);
    }
  });

  it('合成选项优先于全局配置', () => {
    const cfg = { video: { color_grade: { preset: 'warm' } } };
    assert.equal(
      colorGrade.buildColorGradeFilter(cfg, { color_grade_preset: 'cool' }, null),
      colorGrade.PRESETS.cool
    );
    assert.equal(colorGrade.buildColorGradeFilter(cfg, {}, null), colorGrade.PRESETS.warm);
  });

  it('未知预设跳过调色而不是产出坏滤镜', () => {
    assert.equal(colorGrade.buildColorGradeFilter({}, { color_grade_preset: '不存在' }, null), null);
  });

  it('LUT 文件不存在时回落到预设', () => {
    const cfg = { video: { color_grade: { preset: 'film', lut_file: '/nope/missing.cube' } } };
    assert.equal(colorGrade.buildColorGradeFilter(cfg, {}, null), colorGrade.PRESETS.film);
  });

  it('LUT 文件存在时以 LUT 为准', () => {
    const lut = path.join(tmpRoot, 'test.cube');
    fs.writeFileSync(lut, 'LUT_3D_SIZE 2\n');
    const f = colorGrade.buildColorGradeFilter({ video: { color_grade: { preset: 'film', lut_file: lut } } }, {}, null);
    assert.ok(f.startsWith('lut3d='), `期望 lut3d 滤镜，实际 ${f}`);
  });

  it('Windows 盘符冒号在滤镜参数里被转义', () => {
    assert.equal(colorGrade.escapeFilterPath('C:\\luts\\a.cube'), 'C\\:/luts/a.cube');
  });
});

/**
 * 这组测试真的跑 ffmpeg。
 * 起因：warm/cool 原本用 colorbalance 实现，滤镜串明明不同，
 * 但在部分 ffmpeg 构建上对全范围 RGB 是空操作，两个预设渲染出**完全一样**的画面。
 * 纯字符串断言抓不到这种 bug，必须真的渲一帧出来看。
 */
describe('色彩预设的实际渲染效果', () => {
  const { spawnSync } = require('child_process');
  const { getFfmpegPath } = require('../src/utils/ffmpegPath');

  const hasFfmpeg = (() => {
    try {
      const r = spawnSync(getFfmpegPath(), ['-version'], { encoding: 'utf8' });
      return !r.error && r.status === 0;
    } catch (_) {
      return false;
    }
  })();

  /** 用给定滤镜渲一个中间调色块，返回 [r,g,b] */
  function renderMidtone(filter) {
    const out = path.join(tmpRoot, `px_${Math.random().toString(36).slice(2)}.raw`);
    const args = ['-y', '-f', 'lavfi', '-i', 'color=c=0x8090A0:s=32x32:d=1:r=1'];
    if (filter) args.push('-vf', filter);
    args.push('-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', out, '-loglevel', 'error');
    const r = spawnSync(getFfmpegPath(), args, { encoding: 'buffer' });
    if (r.status !== 0) return null;
    const buf = fs.readFileSync(out);
    try { fs.unlinkSync(out); } catch (_) {}
    return [buf[0], buf[1], buf[2]];
  }

  it('每个预设都真的改变了画面，不是空操作', { skip: !hasFfmpeg && '本机没有可用的 ffmpeg' }, () => {
    const base = renderMidtone(null);
    assert.ok(base, '基线渲染失败');
    for (const preset of Object.keys(colorGrade.PRESETS)) {
      const got = renderMidtone(colorGrade.PRESETS[preset]);
      assert.ok(got, `预设 ${preset} 渲染失败`);
      assert.notDeepEqual(got, base, `预设 ${preset} 对画面没有任何影响（可能是空操作滤镜）`);
    }
  });

  it('warm 与 cool 必须往相反方向偏色', { skip: !hasFfmpeg && '本机没有可用的 ffmpeg' }, () => {
    const base = renderMidtone(null);
    const warm = renderMidtone(colorGrade.PRESETS.warm);
    const cool = renderMidtone(colorGrade.PRESETS.cool);
    assert.notDeepEqual(warm, cool, 'warm 与 cool 渲染结果相同');
    // 暖调压蓝，冷调压红
    assert.ok(warm[2] < base[2], `warm 应当降低蓝色通道：${base[2]} → ${warm[2]}`);
    assert.ok(cool[0] < base[0], `cool 应当降低红色通道：${base[0]} → ${cool[0]}`);
  });
});
