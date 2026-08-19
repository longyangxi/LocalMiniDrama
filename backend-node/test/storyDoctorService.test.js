const test = require('node:test');
const assert = require('node:assert/strict');
const { diagnoseStory } = require('../src/services/storyDoctorService');

test('story doctor identifies flat and weakly causal beats', () => {
  const diagnosis = diagnoseStory({
    dramaticType: 'suspense',
    episodes: [{ episode: 1, beat_sheet: { beats: [{ stage_id: 'hook' }, { stage_id: 'consequence' }] } }],
  });
  assert.ok(diagnosis.score < 70);
  assert.ok(diagnosis.issues.some((issue) => issue.code === 'missing_stage'));
  assert.equal(diagnosis.questions[0].id, 'truth_owner');
});
