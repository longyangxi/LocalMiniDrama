'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const craft = require('../src/services/storyCraftPrompts');
const promptI18n = require('../src/services/promptI18n');

test('bible digest preserves inner arc and character-specific continuity fields', () => {
  const digest = craft.buildBibleDigest({
    title: '旧伞',
    theme_question: '原谅是否等于背叛自己？',
    emotional_promise: '克制的疼痛与迟来的理解',
    motifs: ['漏雨的旧伞'],
    characters: [{
      name: '阿岚',
      role: 'main',
      identity: '修伞匠',
      want: '讨回旧债',
      need: '承认自己仍在乎母亲',
      lie: '接受帮助就是软弱',
      wound: '童年被独自留下',
      flaw: '把善意都当成交易',
      secret: '一直替母亲修那把旧伞',
      contradiction: '嘴硬却会默默替人收拾残局',
      moral_boundary: '绝不向孩子撒谎',
      arc: '拒绝亏欠 → 主动承担',
      speech_style: '短句，先否认再补一句',
      appearance_keywords: '左眉旧疤、灰布围裙',
    }],
  }, false);

  for (const expected of ['主题问题', '真正需要', '错误信念', '创伤来源', '秘密', '矛盾性', '底线', '人物弧', '视觉身份', '漏雨的旧伞']) {
    assert.match(digest, new RegExp(expected));
  }
});

test('creative preferences remain optional and compact', () => {
  assert.equal(craft.buildCreativePreferencesBlock(false, {}), '');
  const block = craft.buildCreativePreferencesBlock(false, {
    primary_emotion: '温暖',
    ending_flavor: '遗憾',
    avoid: '失忆、空降身份',
  });
  assert.match(block, /主要情绪：温暖/);
  assert.match(block, /结局余味：遗憾/);
  assert.match(block, /不想出现：失忆、空降身份/);
});

test('three-stage prompt overrides affect the actual story craft prompts', () => {
  promptI18n.setOverrideInMemory('story_bible_system', '自定义总编剧指令，共${n}集');
  try {
    const prompt = craft.getStoryBibleSystemPrompt(false, 6);
    assert.match(prompt, /自定义总编剧指令，共6集/);
    assert.match(prompt, /theme_question/);
    assert.match(prompt, /anti_cliches/);
  } finally {
    promptI18n.clearOverrideInMemory('story_bible_system');
  }
});

test('polish contract combines revision, quality report and complete continuity state', () => {
  const prompt = craft.getEpisodePolishSystemPrompt(false);
  assert.match(prompt, /revised_script/);
  assert.match(prompt, /quality_report/);
  assert.match(prompt, /continuity_state/);
  assert.match(prompt, /完整快照/);
});
