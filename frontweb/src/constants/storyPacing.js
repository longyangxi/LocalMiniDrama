export const STORY_STAGE_DEFINITIONS = [
  ['hook', '钩子'],
  ['goal_pressure', '目标与压力'],
  ['escalation', '升级'],
  ['false_result', '假结果'],
  ['choice_reversal', '选择与反转'],
  ['consequence', '后果与卡点'],
]

export const STORY_STAGE_PRESETS = {
  power: [5, 12, 24, 18, 26, 15],
  suspense: [5, 15, 22, 20, 25, 13],
  emotion: [5, 20, 23, 17, 23, 12],
  comedy: [5, 12, 28, 22, 20, 13],
  custom: [5, 15, 25, 20, 22, 13],
}

export const PACING_AVERAGE_SECONDS = { compact: 5.5, standard: 7, relaxed: 10, custom: 7 }

export function stagePayload(type, customPercentages) {
  const values = type === 'custom' && Array.isArray(customPercentages)
    ? customPercentages
    : (STORY_STAGE_PRESETS[type] || STORY_STAGE_PRESETS.custom)
  return STORY_STAGE_DEFINITIONS.map(([id], index) => ({ id, percent: Number(values[index]) || 0 }))
}

export function expectedShotCount(duration, pacingPreset) {
  return Math.max(6, Math.round((Number(duration) || 90) / (PACING_AVERAGE_SECONDS[pacingPreset] || 7)))
}
