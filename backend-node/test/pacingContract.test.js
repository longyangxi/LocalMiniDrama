const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPacingContract } = require('../src/services/pacingContract');

test('pacing contract keeps percentages and seconds exact', () => {
  const contract = buildPacingContract({ dramatic_type: 'suspense', pacing_preset: 'compact', target_duration: 91 });
  assert.equal(contract.stages.reduce((sum, stage) => sum + stage.percent, 0), 100);
  assert.equal(contract.stages.reduce((sum, stage) => sum + stage.target_seconds, 0), 91);
  assert.equal(contract.stages[0].id, 'hook');
  assert.equal(contract.stages.at(-1).id, 'consequence');
});

test('custom percentages are normalized instead of trusting invalid totals', () => {
  const contract = buildPacingContract({ target_duration: 60, pacing_stages: [1, 1, 1, 1, 1, 1] });
  assert.deepEqual(contract.stages.map((stage) => stage.percent), [17, 17, 17, 17, 16, 16]);
  assert.equal(contract.stages.reduce((sum, stage) => sum + stage.target_seconds, 0), 60);
});
