const STAGES = [
  { id: 'hook', label: '钩子', purpose: '立刻制造冲突或信息差' },
  { id: 'goal_pressure', label: '目标与压力', purpose: '明确人物要什么，以及失败代价' },
  { id: 'escalation', label: '升级', purpose: '阻碍加码，迫使人物改变策略' },
  { id: 'false_result', label: '假结果', purpose: '短暂得手或误判，让观众形成预期' },
  { id: 'choice_reversal', label: '选择与反转', purpose: '人物作出有代价的选择，局面翻转' },
  { id: 'consequence', label: '后果与卡点', purpose: '兑现代价，并留下下一步悬念' },
];

const DRAMATIC_PRESETS = {
  power: [5, 12, 24, 18, 26, 15],
  suspense: [5, 15, 22, 20, 25, 13],
  emotion: [5, 20, 23, 17, 23, 12],
  comedy: [5, 12, 28, 22, 20, 13],
  custom: [5, 15, 25, 20, 22, 13],
};

const PACING_PRESETS = {
  compact: { label: '紧凑', average_shot_seconds: 5.5 },
  standard: { label: '标准', average_shot_seconds: 7 },
  relaxed: { label: '舒缓', average_shot_seconds: 10 },
  custom: { label: '自定义', average_shot_seconds: 7 },
};

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || min));
}

function normalizePercentages(values, fallback) {
  const raw = STAGES.map((_, i) => Math.max(0, Number(values?.[i]) || 0));
  const source = raw.some(Boolean) ? raw : fallback;
  const total = source.reduce((sum, value) => sum + value, 0) || 100;
  const exact = source.map((value) => value * 100 / total);
  const rounded = exact.map(Math.floor);
  let remaining = 100 - rounded.reduce((sum, value) => sum + value, 0);
  exact.map((value, i) => ({ i, fraction: value - rounded[i] }))
    .sort((a, b) => b.fraction - a.fraction || a.i - b.i)
    .slice(0, remaining)
    .forEach(({ i }) => { rounded[i] += 1; });
  return rounded;
}

function allocateIntegers(total, weights) {
  const exact = weights.map((weight) => total * weight / 100);
  const result = exact.map(Math.floor);
  let remaining = total - result.reduce((sum, value) => sum + value, 0);
  exact.map((value, i) => ({ i, fraction: value - result[i] }))
    .sort((a, b) => b.fraction - a.fraction || a.i - b.i)
    .slice(0, remaining)
    .forEach(({ i }) => { result[i] += 1; });
  return result;
}

function buildPacingContract(input = {}) {
  const dramaticType = DRAMATIC_PRESETS[input.dramatic_type] ? input.dramatic_type : 'custom';
  const pacingPreset = PACING_PRESETS[input.pacing_preset] ? input.pacing_preset : 'standard';
  const targetDuration = Math.round(clamp(input.target_duration == null ? 90 : input.target_duration, 30, 600));
  const customValues = Array.isArray(input.pacing_stages)
    ? input.pacing_stages.map((stage) => typeof stage === 'object' ? stage.percent : stage)
    : null;
  const percentages = normalizePercentages(customValues, DRAMATIC_PRESETS[dramaticType]);
  const seconds = allocateIntegers(targetDuration, percentages);
  const averageShotSeconds = clamp(input.average_shot_seconds || PACING_PRESETS[pacingPreset].average_shot_seconds, 3, 20);

  const stages = STAGES.map((stage, i) => {
    const expected = Math.max(1, Math.round(seconds[i] / averageShotSeconds));
    return {
      ...stage,
      percent: percentages[i],
      target_seconds: seconds[i],
      min_shots: Math.max(1, expected - 1),
      max_shots: Math.max(1, expected + 1),
    };
  });
  return {
    version: 1,
    dramatic_type: dramaticType,
    pacing_preset: pacingPreset,
    target_duration: targetDuration,
    average_shot_seconds: averageShotSeconds,
    expected_shots: Math.max(STAGES.length, Math.round(targetDuration / averageShotSeconds)),
    stages,
  };
}

function formatPacingContractForPrompt(contract, isEn = false) {
  const c = contract?.stages ? contract : buildPacingContract(contract);
  const lines = c.stages.map((stage, i) =>
    `${i + 1}. ${stage.id} / ${stage.label}: ${stage.percent}% = ${stage.target_seconds}s, ${stage.min_shots}-${stage.max_shots} shots; ${stage.purpose}`
  );
  if (isEn) {
    return `HARD PACING CONTRACT — total ${c.target_duration}s, about ${c.expected_shots} shots. Keep stage order; do not borrow time from a later stage:\n${lines.join('\n')}`;
  }
  return `【节奏硬约束】单集总时长 ${c.target_duration} 秒，预计约 ${c.expected_shots} 镜。阶段必须按顺序出现，不得把高潮提前或把铺垫挤占后段：\n${lines.join('\n')}`;
}

module.exports = {
  STAGES,
  DRAMATIC_PRESETS,
  PACING_PRESETS,
  buildPacingContract,
  formatPacingContractForPrompt,
  normalizePercentages,
};
