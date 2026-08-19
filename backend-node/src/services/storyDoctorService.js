const { STAGES } = require('./pacingContract');

const QUESTION_BANK = {
  power: { id: 'power_cost', prompt: '这次翻盘，主角最该付出什么代价？', options: ['失去信任', '暴露软肋', '牺牲利益'] },
  suspense: { id: 'truth_owner', prompt: '下一步由谁掌握关键真相更有张力？', options: ['观众先知道', '主角先知道', '反派先知道'] },
  emotion: { id: 'unsaid_truth', prompt: '这段关系里，哪种没说出口的话最重要？', options: ['亏欠', '误解', '舍不得'] },
  comedy: { id: 'comic_cost', prompt: '笑点之后，哪种真实后果最能托住人物？', options: ['丢面子', '关系恶化', '谎言升级'] },
  custom: { id: 'turn_direction', prompt: '你更希望下一次转折改变什么？', options: ['事实真相', '人物关系', '主角选择'] },
};

function diagnoseStory({ episodes = [], dramaticType = 'custom', pacingContract }) {
  const issues = [];
  let score = 100;
  for (const episode of episodes) {
    const sheet = episode.beat_sheet || episode;
    const beats = Array.isArray(sheet?.beats) ? sheet.beats : [];
    const stageIds = beats.map((beat) => beat.stage_id).filter(Boolean);
    const missing = STAGES.map((stage) => stage.id).filter((id) => !stageIds.includes(id));
    if (missing.length) {
      issues.push({ code: 'missing_stage', severity: 'high', episode: episode.episode, message: `缺少 ${missing.length} 个剧情阶段，节奏容易失衡` });
      score -= 18;
    }
    const changed = beats.filter((beat) => beat.value_before && beat.value_after && beat.value_before !== beat.value_after).length;
    if (beats.length && changed < Math.ceil(beats.length / 2)) {
      issues.push({ code: 'flat_values', severity: 'high', episode: episode.episode, message: '多数节拍没有改变局面，剧情会显得平实' });
      score -= 15;
    }
    const causal = beats.filter((beat) => String(beat.causal_link || '').trim()).length;
    if (beats.length && causal < beats.length - 1) {
      issues.push({ code: 'weak_causality', severity: 'medium', episode: episode.episode, message: '部分事件只是先后发生，缺少“因为…所以…”的推动' });
      score -= 10;
    }
    if (!String(sheet?.choice_and_cost || '').trim()) {
      issues.push({ code: 'no_cost', severity: 'high', episode: episode.episode, message: '主角没有付出可见代价，反转容易只剩信息揭晓' });
      score -= 15;
    }
  }
  score = Math.max(0, Math.min(100, score));
  const primary = issues[0]?.message || '结构完整；建议人工重点把关人物选择是否足够独特。';
  const bank = QUESTION_BANK[dramaticType] || QUESTION_BANK.custom;
  return {
    version: 1,
    score,
    verdict: score >= 85 ? '节奏健康' : score >= 65 ? '有提升空间' : '建议优化后再分镜',
    summary: primary,
    issues: issues.slice(0, 5),
    questions: [{
      id: bank.id,
      prompt: bank.prompt,
      options: bank.options.map((label) => ({ value: label, label })),
    }],
    target_duration: pacingContract?.target_duration || null,
  };
}

module.exports = { diagnoseStory };
