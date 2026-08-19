const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const speechTiming = require('../src/services/speechTiming');
const shotDurationPlanner = require('../src/services/shotDurationPlanner');
const cameraMovement = require('../src/constants/cameraMovement');
const negativePromptBuilder = require('../src/services/negativePromptBuilder');
const shotVisualDesign = require('../src/services/shotVisualDesignService');
const imagePromptLanguage = require('../src/services/imagePromptLanguage');

describe('speechTiming', () => {
  it('剥离说话人前缀后再计时，角色名不计入朗读时长', () => {
    const withName = speechTiming.charSpeechWeight('林薇：你走吧');
    const withoutName = speechTiming.charSpeechWeight('你走吧');
    assert.equal(withName, withoutName);
  });

  it('台词越长估算时长越长', () => {
    const short = speechTiming.charSpeechWeight('你走吧');
    const long = speechTiming.charSpeechWeight('这些年我为你付出的一切，你从来没有看在眼里过。');
    assert.ok(long > short * 3, `long=${long} short=${short}`);
  });

  it('标点会带来额外停顿', () => {
    const noPunct = speechTiming.charSpeechWeight('你走吧我不想见你');
    const withPunct = speechTiming.charSpeechWeight('你走吧，我不想见你。');
    assert.ok(withPunct > noPunct);
  });

  it('解析多行对白为说话人条目', () => {
    const entries = speechTiming.parseDialogueToEntries('林薇：你走吧\n陈默（冷笑）：随你便');
    assert.equal(entries.length, 2);
    assert.equal(entries[0].speaker, '林薇');
    assert.equal(entries[0].text, '你走吧');
    assert.equal(entries[1].speaker, '陈默');
    assert.equal(entries[1].text, '随你便');
  });

  it('无说话人前缀时 speaker 为 null', () => {
    const entries = speechTiming.parseDialogueToEntries('风声呼啸而过');
    assert.equal(entries.length, 1);
    assert.equal(entries[0].speaker, null);
  });

  it('对白与旁白叠轨播放，总时长取较大者而非求和', () => {
    const r = speechTiming.estimateStoryboardSpeechSeconds({
      dialogue: '林薇：你走吧',
      narration: '那一夜之后，她再也没有回过这座城市，也再没有提起过他的名字。',
    });
    assert.ok(r.narrationSec > r.dialogueSec);
    assert.equal(r.totalSec, Math.round(Math.max(r.dialogueSec, r.narrationSec) * 10) / 10);
  });

  it('多角色时按 action 中最先出现的角色确定画面主体', () => {
    const who = speechTiming.inferPrimaryOnScreenCharacter(
      { action: '陈默转身走向门口，林薇站在原地' },
      ['林薇', '陈默']
    );
    assert.equal(who, '陈默');
  });
});

describe('shotDurationPlanner', () => {
  it('长台词镜头会被拉长到装得下人声', () => {
    const plan = shotDurationPlanner.planShotDuration({
      dialogue: '林薇：这些年我为你付出的一切，你从来没有看在眼里过，今天我终于想明白了。',
    });
    assert.ok(plan.duration >= plan.speechSec, `duration=${plan.duration} speech=${plan.speechSec}`);
    assert.equal(plan.source, 'estimated');
  });

  it('无台词镜头给保守的默认时长', () => {
    const plan = shotDurationPlanner.planShotDuration({ action: '她缓缓转身' });
    assert.equal(plan.source, 'silent');
    assert.ok(plan.duration >= 5);
  });

  it('实测时长优先于字数估算', () => {
    const plan = shotDurationPlanner.planShotDuration({ dialogue: '林薇：你走吧' }, { measuredSpeechSec: 9.2 });
    assert.equal(plan.source, 'measured');
    assert.equal(plan.speechSec, 9.2);
    assert.ok(plan.duration >= 10);
  });

  it('人声超过单镜上限时给出拆镜建议', () => {
    const longLine = '林薇：' + '这段话非常非常长，'.repeat(12);
    const plan = shotDurationPlanner.planShotDuration({ dialogue: longLine });
    assert.equal(plan.needsSplit, true);
    assert.equal(plan.duration, shotDurationPlanner.MAX_SHOT_SEC);
  });

  it('时长向上贴合到档位，不会给出档位之外的值', () => {
    const ladder = [5, 8, 10];
    for (const sec of [1, 4.9, 5.1, 7.9, 8.1, 99]) {
      const snapped = shotDurationPlanner.snapUpToLadder(sec, ladder);
      assert.ok(ladder.includes(snapped), `${sec} → ${snapped}`);
    }
    assert.equal(shotDurationPlanner.snapUpToLadder(5.1, ladder), 8);
    assert.equal(shotDurationPlanner.snapUpToLadder(99, ladder), 10);
  });

  it('配置里的非法档位会回落到默认档位', () => {
    assert.deepEqual(
      shotDurationPlanner.resolveDurationLadder({ video: { duration_ladder: ['x', -1] } }),
      shotDurationPlanner.DEFAULT_DURATION_LADDER
    );
    assert.deepEqual(shotDurationPlanner.resolveDurationLadder({}), shotDurationPlanner.DEFAULT_DURATION_LADDER);
  });
});

describe('cameraMovement 白名单', () => {
  it('中文写法归一化到规范码', () => {
    assert.equal(cameraMovement.normalizeMovement('推镜').code, 'push');
    assert.equal(cameraMovement.normalizeMovement('固定镜头').code, 'static');
    assert.equal(cameraMovement.normalizeMovement('跟拍').code, 'tracking');
  });

  it('复合运镜链只取第一个可识别的运镜', () => {
    assert.equal(cameraMovement.normalizeMovement('先缓推再环绕最后甩镜').code, 'push');
  });

  it('高级运镜默认降级到最接近的安全运镜', () => {
    const r = cameraMovement.normalizeMovement('bullet_time');
    assert.equal(r.downgraded, true);
    assert.ok(Object.keys(cameraMovement.SAFE_MOVEMENTS).includes(r.code));
  });

  it('显式开启后保留高级运镜', () => {
    const cfg = { storyboard: { allow_advanced_camera_movement: true } };
    const r = cameraMovement.normalizeMovement('bullet_time', cfg);
    assert.equal(r.code, 'bullet_time');
    assert.equal(r.downgraded, false);
  });

  it('空值与无法识别的写法回落到 static', () => {
    assert.equal(cameraMovement.normalizeMovement('').code, 'static');
    assert.equal(cameraMovement.normalizeMovement('随便乱写的东西').code, 'static');
  });

  it('提示词用的白名单默认不含高级运镜', () => {
    const list = cameraMovement.allowedMovementList({}, 'zh').join(' ');
    assert.ok(list.includes('static'));
    assert.ok(!list.includes('bullet_time'));
  });
});

describe('negativePromptBuilder', () => {
  it('从文本嗅出时代', () => {
    assert.equal(negativePromptBuilder.detectEra('古装武侠复仇'), 'ancient');
    assert.equal(negativePromptBuilder.detectEra('都市职场'), 'modern');
    assert.equal(negativePromptBuilder.detectEra('赛博朋克 2099'), 'future');
    assert.equal(negativePromptBuilder.detectEra(''), 'unknown');
  });

  it('古装场景把现代物件放进负向词', () => {
    const neg = negativePromptBuilder.buildFrameNegativePrompt({ eraHints: ['古代宫廷'] });
    assert.ok(neg.includes('smartphone'));
    assert.ok(neg.includes('wristwatch'));
  });

  it('单人镜头压制模型自行加人', () => {
    const neg = negativePromptBuilder.buildFrameNegativePrompt({ allowedCharacterCount: 1 });
    assert.ok(neg.includes('multiple people'));
    assert.ok(neg.includes('crowd'));
  });

  it('带多张参考图时加入防宫格拼贴项', () => {
    const withRefs = negativePromptBuilder.buildFrameNegativePrompt({ hasReferenceImages: true });
    const withoutRefs = negativePromptBuilder.buildFrameNegativePrompt({ hasReferenceImages: false });
    assert.ok(withRefs.includes('collage'));
    assert.ok(!withoutRefs.includes('collage'));
  });

  it('输出不含重复项', () => {
    const neg = negativePromptBuilder.buildFrameNegativePrompt({
      eraHints: ['古代'], allowedCharacterCount: 1, hasReferenceImages: true, userNegative: 'blurry',
    });
    const items = neg.split(',').map((t) => t.trim().toLowerCase());
    assert.equal(items.length, new Set(items).size);
  });
});

describe('视觉设计的节奏兜底', () => {
  it('连续三镜同景别会被本地打散', () => {
    const designs = [
      { shot_type: '中景' }, { shot_type: '中景' }, { shot_type: '中景' }, { shot_type: '中景' },
    ];
    shotVisualDesign.enforceShotTypeVariety(designs, null);
    for (let i = 2; i < designs.length; i++) {
      const same = designs[i - 2].shot_type === designs[i - 1].shot_type
        && designs[i - 1].shot_type === designs[i].shot_type;
      assert.equal(same, false, `下标 ${i} 仍是连续三镜同景别`);
    }
  });

  it('景别归一化到标准枚举', () => {
    assert.equal(shotVisualDesign.normalizeShotType('medium shot'), '中景');
    assert.equal(shotVisualDesign.normalizeShotType('extreme close-up'), '特写');
    assert.equal(shotVisualDesign.normalizeShotType('乱填的值', '远景'), '远景');
  });
});

describe('图片提示词语种路由', () => {
  it('配置强制时直接生效，不查供应商', () => {
    assert.equal(imagePromptLanguage.resolveImagePromptLang(null, { style: { image_prompt_language: 'en' } }), 'en');
    assert.equal(imagePromptLanguage.resolveImagePromptLang(null, { style: { image_prompt_language: 'zh' } }), 'zh');
  });

  it('国内模型走中文，国际模型走英文', () => {
    const cfg = { style: { image_prompt_language: 'auto' }, app: { language: 'zh' } };
    // db 传 null 会让配置查询失败，只依据 model 名判断
    assert.equal(imagePromptLanguage.resolveImagePromptLang(null, cfg, { model: 'doubao-seedream-4' }), 'zh');
    assert.equal(imagePromptLanguage.resolveImagePromptLang(null, cfg, { model: 'imagen-3.0' }), 'en');
  });

  it('取不到任何线索时跟随项目语言', () => {
    assert.equal(imagePromptLanguage.resolveImagePromptLang(null, { app: { language: 'en' } }, {}), 'en');
    assert.equal(imagePromptLanguage.resolveImagePromptLang(null, { app: { language: 'zh' } }, {}), 'zh');
  });

  it('cfg 上挂载的语种优先于项目语言', () => {
    const tagged = imagePromptLanguage.withImagePromptLang({ app: { language: 'zh' } }, 'en');
    assert.equal(imagePromptLanguage.imagePromptLangOf(tagged), 'en');
  });
});
