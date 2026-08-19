/**
 * 台词/旁白的语音时长估算与解析。
 *
 * 供「音频先行」时长规划（shotDurationPlanner）与按对白拆镜（splitStoryboardByAudio）共用。
 * 此前 episodeStoryboardService 直接调用 charSpeechWeight / parseDialogueToEntries /
 * inferPrimaryOnScreenCharacter，但三者从未定义，拆镜接口一调即 ReferenceError。
 */

/** 中文对白语速（字/秒）。短剧对白偏快，旁白偏慢。 */
const CPS_DIALOGUE = 5.0;
const CPS_NARRATION = 4.2;
/** 英文按词计：约 2.6 词/秒（≈155 wpm，接近中文对白节奏） */
const WPS_EN = 2.6;

/** 标点带来的自然停顿（秒） */
const PAUSE_BY_PUNCT = {
  '，': 0.18, ',': 0.18, '、': 0.12,
  '。': 0.35, '.': 0.35, '！': 0.35, '!': 0.35, '？': 0.35, '?': 0.35,
  '；': 0.28, ';': 0.28, '：': 0.2, ':': 0.2,
  '…': 0.45, '—': 0.3,
};

/** 去掉说话人前缀（「林薇：你走吧」→「你走吧」）与包裹引号 */
function stripSpeakerPrefix(text) {
  let t = String(text || '').trim();
  const m = t.match(/^([^：:，,。.！!？?\n]{1,12})\s*[：:]\s*(.+)$/s);
  if (m) t = m[2].trim();
  return t.replace(/^["'“”「『]+|["'“”」』]+$/g, '').trim();
}

/**
 * 估算一段文本的朗读秒数（不含前后留白）。
 * @param {string} text 台词或旁白正文（可含说话人前缀，会自动剥离）
 * @param {'dialogue'|'narration'} [type='dialogue']
 * @returns {number} 秒（保留一位小数，最小 0）
 */
function charSpeechWeight(text, type = 'dialogue') {
  const body = stripSpeakerPrefix(text);
  if (!body) return 0;

  const cps = type === 'narration' ? CPS_NARRATION : CPS_DIALOGUE;

  // 中日韩表意文字按「字」计
  const cjkCount = (body.match(/[一-鿿぀-ヿ가-힯]/g) || []).length;
  // 拉丁词按「词」计
  const latinWords = (body.match(/[A-Za-z][A-Za-z'’-]*/g) || []).length;
  // 数字串按 2 字符/字 折算（「2025」读作四个音节左右）
  const digitChars = (body.match(/\d/g) || []).length;

  let seconds = cjkCount / cps + latinWords / WPS_EN + digitChars / 4.0;

  // 标点停顿
  for (const ch of body) {
    if (PAUSE_BY_PUNCT[ch]) seconds += PAUSE_BY_PUNCT[ch];
  }

  return Math.round(seconds * 10) / 10;
}

/**
 * 把分镜的 dialogue 字段解析成 [{ speaker, text }]。
 * 支持：
 *   「林薇：你走吧」多行
 *   「林薇（冷笑）：你走吧」
 *   无说话人的纯台词
 * @param {string} dialogue
 * @returns {Array<{speaker: string|null, text: string}>}
 */
function parseDialogueToEntries(dialogue) {
  const raw = String(dialogue == null ? '' : dialogue).trim();
  if (!raw) return [];

  const entries = [];
  const lines = raw.split(/\r?\n+/).map((l) => l.trim()).filter(Boolean);

  for (const line of lines) {
    // 说话人：允许中英文名 + 可选括号里的表演提示，冒号后为台词
    const m = line.match(/^([^：:\n]{1,16}?)\s*(?:[（(][^）)]{0,20}[）)])?\s*[：:]\s*(.+)$/);
    if (m && m[2].trim()) {
      entries.push({
        speaker: m[1].trim().replace(/[「『"'“]/g, '') || null,
        text: m[2].trim().replace(/^["'“”「『]+|["'“”」』]+$/g, '').trim(),
      });
    } else {
      entries.push({ speaker: null, text: line });
    }
  }

  return entries.filter((e) => e.text);
}

/**
 * 从分镜文本里推断「画面主体角色」，用于旁白镜头决定镜头对准谁。
 * 优先级：action 中最先出现的角色 → result → title → 最后一位说话人。
 * @param {{action?:string, result?:string, title?:string, dialogue?:string}} row
 * @param {string[]} candidateNames 候选角色名
 * @returns {string|null}
 */
function inferPrimaryOnScreenCharacter(row, candidateNames) {
  const names = (candidateNames || []).filter((n) => n && String(n).trim());
  if (names.length === 0) return null;
  if (names.length === 1) return names[0];

  const fields = [row?.action, row?.result, row?.title, row?.dialogue];
  for (const field of fields) {
    const text = String(field || '');
    if (!text) continue;
    let best = null;
    let bestIdx = Infinity;
    for (const name of names) {
      const idx = text.indexOf(name);
      if (idx >= 0 && idx < bestIdx) {
        bestIdx = idx;
        best = name;
      }
    }
    if (best) return best;
  }

  return names[names.length - 1];
}

/**
 * 一条分镜里全部人声（对白 + 旁白）的总时长估算。
 * @returns {{ dialogueSec:number, narrationSec:number, totalSec:number, entries:Array }}
 */
function estimateStoryboardSpeechSeconds(row) {
  const entries = parseDialogueToEntries(row?.dialogue);
  const dialogueSec = entries.reduce((sum, e) => sum + charSpeechWeight(e.text, 'dialogue'), 0);
  const narrationText = row?.narration != null ? String(row.narration).trim() : '';
  const narrationSec = narrationText ? charSpeechWeight(narrationText, 'narration') : 0;
  return {
    dialogueSec: Math.round(dialogueSec * 10) / 10,
    narrationSec: Math.round(narrationSec * 10) / 10,
    // 对白与旁白在成片里是叠轨播放（见 mergedEpisodePostProcess 的 amix），
    // 因此镜头时长取两者较大者而非求和。
    totalSec: Math.round(Math.max(dialogueSec, narrationSec) * 10) / 10,
    entries,
  };
}

module.exports = {
  CPS_DIALOGUE,
  CPS_NARRATION,
  stripSpeakerPrefix,
  charSpeechWeight,
  parseDialogueToEntries,
  inferPrimaryOnScreenCharacter,
  estimateStoryboardSpeechSeconds,
};
