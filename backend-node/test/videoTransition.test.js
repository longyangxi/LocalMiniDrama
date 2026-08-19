const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const videoTransition = require('../src/services/videoTransition');

function createDbWithStoryboards(rows) {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE storyboards (
      id INTEGER PRIMARY KEY,
      segment_index INTEGER,
      segment_title TEXT,
      location TEXT,
      deleted_at TEXT
    );
  `);
  const ins = db.prepare(
    'INSERT INTO storyboards (id, segment_index, segment_title, location, deleted_at) VALUES (?, ?, ?, ?, NULL)'
  );
  for (const r of rows) ins.run(r.id, r.segment_index, r.segment_title ?? null, r.location ?? null);
  return db;
}

describe('转场配置解析', () => {
  it('缺省为 auto + 0.5s', () => {
    const c = videoTransition.resolveTransitionConfig({}, {});
    assert.equal(c.mode, 'auto');
    assert.equal(c.duration, 0.5);
    assert.equal(c.enabled, true);
  });

  it('合成选项优先于全局配置', () => {
    const c = videoTransition.resolveTransitionConfig(
      { video: { transition: { mode: 'auto', duration_seconds: 0.5 } } },
      { transition_mode: 'fadeblack', transition_duration: 1.0 }
    );
    assert.equal(c.mode, 'fadeblack');
    assert.equal(c.duration, 1.0);
  });

  it('none 关闭转场', () => {
    assert.equal(videoTransition.resolveTransitionConfig({}, { transition_mode: 'none' }).enabled, false);
  });

  it('转场时长被夹在上下限内', () => {
    assert.equal(videoTransition.resolveTransitionConfig({}, { transition_duration: 99 }).duration, videoTransition.MAX_DURATION);
    assert.equal(videoTransition.resolveTransitionConfig({}, { transition_duration: 0.01 }).duration, videoTransition.MIN_DURATION);
    assert.equal(videoTransition.resolveTransitionConfig({}, { transition_duration: 'abc' }).duration, videoTransition.DEFAULT_DURATION);
  });
});

describe('按段落分组', () => {
  it('连续相同 segment_index 归为一组', () => {
    const db = createDbWithStoryboards([
      { id: 1, segment_index: 0, location: '卧室' },
      { id: 2, segment_index: 0, location: '卧室' },
      { id: 3, segment_index: 1, location: '天台' },
      { id: 4, segment_index: 1, location: '天台' },
      { id: 5, segment_index: 2, location: '医院走廊' },
    ]);
    const groups = videoTransition.groupScenesBySegment(db, [1, 2, 3, 4, 5].map((id) => ({ scene_id: id })));
    assert.equal(groups.length, 3);
    assert.deepEqual(groups[0].sceneIndices, [0, 1]);
    assert.deepEqual(groups[1].sceneIndices, [2, 3]);
    assert.deepEqual(groups[2].sceneIndices, [4]);
    assert.equal(groups[1].location, '天台');
    db.close();
  });

  it('旧数据没有 segment_index 时只有一组（等价于不加转场）', () => {
    const db = createDbWithStoryboards([
      { id: 1, segment_index: null, location: '卧室' },
      { id: 2, segment_index: null, location: '卧室' },
    ]);
    const groups = videoTransition.groupScenesBySegment(db, [{ scene_id: 1 }, { scene_id: 2 }]);
    assert.equal(groups.length, 1);
    db.close();
  });

  it('段落编号回落（0,1,0）也按连续段切分，不会把不相邻的镜头并到一起', () => {
    const db = createDbWithStoryboards([
      { id: 1, segment_index: 0 },
      { id: 2, segment_index: 1 },
      { id: 3, segment_index: 0 },
    ]);
    const groups = videoTransition.groupScenesBySegment(db, [{ scene_id: 1 }, { scene_id: 2 }, { scene_id: 3 }]);
    assert.equal(groups.length, 3);
    db.close();
  });
});

describe('转场类型选择', () => {
  it('auto：换地点用黑场', () => {
    const t = videoTransition.pickTransitionForBoundary('auto', { location: '卧室' }, { location: '天台' });
    assert.equal(t, videoTransition.TRANSITIONS.fadeblack);
  });

  it('auto：同地点用叠化', () => {
    const t = videoTransition.pickTransitionForBoundary('auto', { location: '卧室' }, { location: '卧室' });
    assert.equal(t, videoTransition.TRANSITIONS.dissolve);
  });

  it('固定模式忽略地点', () => {
    const t = videoTransition.pickTransitionForBoundary('wipeleft', { location: '卧室' }, { location: '卧室' });
    assert.equal(t, videoTransition.TRANSITIONS.wipeleft);
  });

  it('未知模式回落到叠化', () => {
    const t = videoTransition.pickTransitionForBoundary('不存在的类型', {}, {});
    assert.equal(t, videoTransition.TRANSITIONS.dissolve);
  });
});

describe('转场时间轴（算错会让整集配音错位）', () => {
  // 复刻 mergeWithTransitions 里的时间轴推导，独立验证其算术
  function buildTimeline(groups, sceneDurations, D) {
    const timeline = new Array(sceneDurations.length).fill(null);
    let groupStart = 0;
    for (const g of groups) {
      let cursor = groupStart;
      for (const i of g.sceneIndices) {
        timeline[i] = { startSec: cursor, durSec: sceneDurations[i] };
        cursor += sceneDurations[i];
      }
      groupStart = groupStart + g.sceneIndices.reduce((s, i) => s + sceneDurations[i], 0) - D;
    }
    return timeline;
  }

  const groups = [
    { sceneIndices: [0, 1] },   // 段1：5 + 5 = 10s
    { sceneIndices: [2, 3] },   // 段2：8 + 5 = 13s
    { sceneIndices: [4] },      // 段3：10s
  ];
  const durations = [5, 5, 8, 5, 10];
  const D = 0.5;
  const timeline = buildTimeline(groups, durations, D);

  it('段内镜头首尾相接', () => {
    assert.equal(timeline[0].startSec, 0);
    assert.equal(timeline[1].startSec, 5);
    assert.equal(timeline[3].startSec, timeline[2].startSec + 8);
  });

  it('每跨一个段落边界，后续镜头前移一个转场时长', () => {
    // 段2 起点 = 段1 时长 10 − D
    assert.equal(timeline[2].startSec, 10 - D);
    // 段3 起点 = 段1 + 段2 − 2D
    assert.equal(timeline[4].startSec, 10 + 13 - 2 * D);
  });

  it('总时长 = 各段之和 − (段数−1) × 转场时长', () => {
    const total = timeline[4].startSec + durations[4];
    assert.equal(total, 10 + 13 + 10 - 2 * D);
  });

  it('镜头间距在段落边界处比镜头自身时长短，音轨才不会比画面长', () => {
    const spacing = (i) => timeline[i + 1].startSec - timeline[i].startSec;
    assert.equal(spacing(0), 5);            // 段内：等于自身时长
    assert.equal(spacing(1), 5 - D);        // 边界：被转场吃掉 D
    assert.equal(spacing(3), 5 - D);        // 边界
    const audioTotal = [0, 1, 2, 3].reduce((s, i) => s + spacing(i), 0) + durations[4];
    assert.equal(audioTotal, 10 + 13 + 10 - 2 * D, '音轨总长必须等于画面总长');
  });
});
