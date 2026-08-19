/**
 * 负向提示词构建。
 *
 * 背景：旧提示词把大量否定写进**正向** prompt——「严禁出现智能手机」「不得夸大」「禁止外貌描写」。
 * 扩散模型对否定词并不敏感，"严禁智能手机" 里的 "智能手机" 反而会被当作有效 token 参与生成，
 * 同时这些长句还会稀释真正描述主体的部分。
 *
 * 正确做法是：正向 prompt 只写想要的画面，所有「不想要」的走 negative_prompt 参数。
 */

/** 通用画质/畸变负向项，任何镜头都适用 */
const BASE_ARTIFACTS = [
  'lowres', 'blurry', 'out of focus', 'jpeg artifacts', 'noise', 'overexposed', 'underexposed',
  'bad anatomy', 'deformed', 'disfigured', 'mutated hands', 'extra fingers', 'missing fingers',
  'fused fingers', 'extra limbs', 'malformed limbs', 'distorted face', 'asymmetric eyes',
  'watermark', 'signature', 'text', 'caption', 'subtitles', 'logo', 'ui overlay',
];

/** 参考图带来的宫格/拼贴污染 */
const LAYOUT_ARTIFACTS = [
  'split panels', 'side-by-side layout', 'collage', 'diptych', 'triptych', 'grid layout',
  'multiple panels', 'comparison view', 'composite image', 'contact sheet', 'border', 'frame border',
];

/** 内容安全 */
const SAFETY = ['nsfw', 'nudity', 'violence', 'gore'];

/**
 * 时代负向词表。
 * 关键点：现代物件在古装场景里是最常见的穿帮，而正向 prompt 里写「严禁手机」只会适得其反。
 */
const ERA_NEGATIVES = {
  ancient: [
    'smartphone', 'mobile phone', 'computer', 'monitor', 'television', 'camera',
    'car', 'bicycle', 'motorcycle', 'power lines', 'electric wires', 'street lamp',
    'air conditioner', 'plastic', 'wristwatch', 'eyeglasses', 'zipper', 'jeans',
    'sneakers', 'T-shirt', 'suit and tie', 'neon lights', 'modern furniture',
    'printed book', 'ballpoint pen', 'wall socket', 'light switch',
  ],
  modern: [
    'armor', 'hanfu', 'kimono', 'medieval clothing', 'horse carriage', 'oil lamp', 'torch',
    'sword', 'castle', 'thatched roof',
  ],
  future: [
    'thatched roof', 'oil lamp', 'horse carriage', 'medieval clothing',
  ],
  fantasy: [],
  unknown: [],
};

/** 从文本里嗅出时代设定 */
function detectEra(...texts) {
  const blob = texts.filter(Boolean).map(String).join(' ').toLowerCase();
  if (!blob.trim()) return 'unknown';

  const ancient = /古代|古装|古风|武侠|仙侠|王朝|皇宫|朝廷|民国|汉代|唐代|宋代|明代|清代|战国|春秋|ancient|dynasty|imperial|medieval|feudal|wuxia|xianxia|period drama/;
  const future = /未来|科幻|赛博|星际|太空|机甲|sci-?fi|cyberpunk|futuristic|space|mecha/;
  const fantasy = /奇幻|魔法|精灵|龙族|异世界|fantasy|magic|elf|dragon/;
  const modern = /现代|都市|当代|职场|校园|modern|contemporary|urban|office|campus/;

  if (ancient.test(blob)) return 'ancient';
  if (future.test(blob)) return 'future';
  if (fantasy.test(blob)) return 'fantasy';
  if (modern.test(blob)) return 'modern';
  return 'unknown';
}

/** 去重并拼成逗号串 */
function joinUnique(parts) {
  const seen = new Set();
  const out = [];
  for (const p of parts) {
    const t = String(p || '').trim();
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out.join(', ');
}

/**
 * 构建一条分镜帧的负向提示词。
 *
 * @param {object} opts
 * @param {string} [opts.era] 显式时代；不传则从 eraHints 嗅探
 * @param {string[]} [opts.eraHints] 用于嗅探时代的文本（story_bible.era_setting / drama.style / location…）
 * @param {number} [opts.allowedCharacterCount] 本镜允许出场的角色数
 * @param {boolean} [opts.hasReferenceImages] 是否带参考图（带参考图才需要防宫格）
 * @param {string} [opts.userNegative] 用户自定义负向词
 * @param {string[]} [opts.taboos] 故事圣经里的禁忌项
 * @returns {string}
 */
function buildFrameNegativePrompt(opts = {}) {
  const era = opts.era || detectEra(...(opts.eraHints || []));
  const parts = [...SAFETY, ...BASE_ARTIFACTS];

  if (opts.hasReferenceImages) parts.push(...LAYOUT_ARTIFACTS);
  parts.push(...(ERA_NEGATIVES[era] || []));

  // 同框人数控制：单人镜头里最常见的污染就是模型自己加人
  const count = Number(opts.allowedCharacterCount);
  if (Number.isFinite(count)) {
    if (count <= 0) {
      parts.push('people', 'person', 'human figure', 'crowd');
    } else if (count === 1) {
      parts.push('two people', 'multiple people', 'crowd', 'background people', 'bystanders', 'duplicate person');
    } else {
      parts.push('crowd', 'background people', 'bystanders', 'duplicate person');
    }
  }

  if (Array.isArray(opts.taboos)) parts.push(...opts.taboos.filter((t) => typeof t === 'string' && t.length < 40));
  if (opts.userNegative) parts.push(opts.userNegative);

  return joinUnique(parts);
}

/**
 * 为一条 image_generations 记录推导负向提示词（读取剧集时代设定与本镜角色数）。
 * 用户已显式填写 negative_prompt 时，自动项作为补充追加。
 */
function buildForImageGeneration(db, log, row) {
  try {
    const dramaId = Number(row?.drama_id) || 0;
    let eraHints = [];
    let taboos = [];

    if (dramaId) {
      const drama = db.prepare('SELECT style, genre, story_bible FROM dramas WHERE id = ?').get(dramaId);
      if (drama) {
        eraHints.push(drama.style, drama.genre);
        if (drama.story_bible) {
          try {
            const bible = typeof drama.story_bible === 'string' ? JSON.parse(drama.story_bible) : drama.story_bible;
            eraHints.push(bible?.era_setting, bible?.tone);
            if (Array.isArray(bible?.taboos)) taboos = bible.taboos;
          } catch (_) {}
        }
      }
    }

    let allowedCharacterCount;
    if (row?.storyboard_id) {
      const sb = db.prepare('SELECT characters, location FROM storyboards WHERE id = ? AND deleted_at IS NULL')
        .get(Number(row.storyboard_id));
      if (sb) {
        eraHints.push(sb.location);
        if (sb.characters != null && String(sb.characters).trim()) {
          try {
            const parsed = JSON.parse(sb.characters);
            if (Array.isArray(parsed)) allowedCharacterCount = parsed.length;
          } catch (_) {}
        }
      }
    }

    let hasReferenceImages = false;
    if (row?.reference_images) {
      try {
        const refs = JSON.parse(row.reference_images);
        hasReferenceImages = Array.isArray(refs) && refs.length > 1;
      } catch (_) {}
    }

    return buildFrameNegativePrompt({
      eraHints,
      taboos,
      allowedCharacterCount,
      hasReferenceImages,
      userNegative: row?.negative_prompt || '',
    });
  } catch (err) {
    log?.warn?.('[负向提示词] 构建失败，回落到基础项', { error: err.message });
    return joinUnique([...SAFETY, ...BASE_ARTIFACTS]);
  }
}

module.exports = {
  BASE_ARTIFACTS,
  LAYOUT_ARTIFACTS,
  ERA_NEGATIVES,
  detectEra,
  buildFrameNegativePrompt,
  buildForImageGeneration,
};
