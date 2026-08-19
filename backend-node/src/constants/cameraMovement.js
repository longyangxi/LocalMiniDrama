/**
 * 运镜白名单与归一化。
 *
 * 背景：旧提示词给了模型 19 种运镜（含希区柯克变焦、子弹时间、螺旋等），
 * 并强制「固定镜头不得超过 20%」。但复杂运镜恰恰是当前 AI 视频模型最容易崩的地方
 * ——人物形变、糊脸、背景撕裂几乎都发生在这些镜头上。
 *
 * 结论是反直觉但明确的：可用的 AI 短剧靠剪辑节奏，不靠单镜头内的复杂运镜。
 * 因此默认只开放 7 种模型能稳定实现的运镜，其余归为「高级」，需显式开启。
 */

/** 默认开放：各主流视频模型都能稳定实现 */
const SAFE_MOVEMENTS = {
  static:   { zh: '固定',   en: 'static shot, locked-off camera' },
  push:     { zh: '缓推',   en: 'slow push in' },
  pull:     { zh: '缓拉',   en: 'slow pull back' },
  pan:      { zh: '横摇',   en: 'horizontal pan' },
  tilt:     { zh: '纵摇',   en: 'vertical tilt' },
  tracking: { zh: '跟拍',   en: 'tracking shot following the subject' },
  handheld: { zh: '手持',   en: 'subtle handheld movement' },
};

/** 高级运镜：崩坏率显著更高，需 config.storyboard.allow_advanced_camera_movement = true */
const ADVANCED_MOVEMENTS = {
  crane_up:          { zh: '升镜',       en: 'crane up' },
  crane_dn:          { zh: '降镜',       en: 'crane down' },
  orbit:             { zh: '环绕',       en: 'orbit around subject' },
  zoom:              { zh: '变焦',       en: 'optical zoom' },
  roll:              { zh: '滚镜',       en: 'camera roll' },
  whip_pan:          { zh: '甩镜',       en: 'whip pan' },
  spiral:            { zh: '螺旋',       en: 'spiral move' },
  hitchcock_zoom:    { zh: '希区柯克变焦', en: 'dolly zoom' },
  bullet_time:       { zh: '子弹时间',   en: 'bullet time orbit' },
  dutch_angle_move:  { zh: '荷兰角运镜', en: 'dutch angle with movement' },
  dolly_track:       { zh: '推轨复合',   en: 'dolly with lateral track' },
  slowmo_orbit:      { zh: '升格环绕',   en: 'slow-motion orbit' },
};

const ALL_MOVEMENTS = { ...SAFE_MOVEMENTS, ...ADVANCED_MOVEMENTS };

/** 中文/别名 → 规范码。覆盖模型可能吐出的各种写法。 */
const ALIAS_TO_CODE = (() => {
  const map = new Map();
  const add = (alias, code) => map.set(String(alias).toLowerCase().trim(), code);

  for (const [code, meta] of Object.entries(ALL_MOVEMENTS)) {
    add(code, code);
    add(meta.zh, code);
  }

  const extra = {
    static: ['固定镜头', '定镜', '静止', '静态', 'fixed', 'locked', 'lock off', 'locked-off', '无运镜', '不动'],
    push: ['推镜', '推', '推进', '前推', '缓推轨', '推轨', 'push in', 'dolly in', 'push_in', 'dolly_in', 'zoom in slow'],
    pull: ['拉镜', '拉', '后拉', '拉远', 'pull out', 'pull back', 'dolly out', 'dolly_out', 'pullback'],
    pan: ['摇镜', '摇', '平摇', '左摇', '右摇', 'panning', 'pan left', 'pan right'],
    tilt: ['俯仰', '上摇', '下摇', 'tilt up', 'tilt down'],
    tracking: ['跟镜', '跟随', '跟踪', '移镜', '跟移', 'follow', 'follow shot', 'track', 'trucking'],
    handheld: ['手持镜头', '肩扛', '晃动', 'hand held', 'shaky cam'],
    orbit: ['环绕镜头', '绕拍', '旋转环绕', 'arc', 'arc shot'],
    crane_up: ['升', '上升', '吊臂上升', 'boom up', 'crane up'],
    crane_dn: ['降', '下降', '吊臂下降', 'boom down', 'crane down', 'crane_down'],
    zoom: ['变焦推进', '变焦拉远', 'zoom in', 'zoom out'],
    roll: ['旋转', '滚转', 'camera roll'],
    whip_pan: ['急摇', '快速甩镜', 'whip'],
    hitchcock_zoom: ['希区柯克', '滑动变焦', 'vertigo', 'dolly zoom', 'dolly_zoom'],
    bullet_time: ['子弹时间镜头', 'bullet-time'],
  };
  for (const [code, aliases] of Object.entries(extra)) {
    for (const a of aliases) add(a, code);
  }
  return map;
})();

/** 高级运镜降级到最接近的安全运镜 */
const ADVANCED_FALLBACK = {
  crane_up: 'tilt',
  crane_dn: 'tilt',
  orbit: 'tracking',
  zoom: 'push',
  roll: 'handheld',
  whip_pan: 'pan',
  spiral: 'tracking',
  hitchcock_zoom: 'push',
  bullet_time: 'tracking',
  dutch_angle_move: 'handheld',
  dolly_track: 'tracking',
  slowmo_orbit: 'tracking',
};

function isAdvancedAllowed(cfg) {
  return !!cfg?.storyboard?.allow_advanced_camera_movement;
}

/**
 * 把模型给的任意运镜写法归一化为规范码。
 * @param {string} raw
 * @param {object} [cfg] 传入时按配置决定是否保留高级运镜
 * @returns {{ code:string, zh:string, en:string, downgraded:boolean,原raw:string }}
 */
function normalizeMovement(raw, cfg) {
  const input = String(raw == null ? '' : raw).trim();
  if (!input) {
    return { code: 'static', zh: SAFE_MOVEMENTS.static.zh, en: SAFE_MOVEMENTS.static.en, downgraded: false, raw: input };
  }

  const lower = input.toLowerCase();
  let code = ALIAS_TO_CODE.get(lower) || null;

  if (!code) {
    // 模型常写成「缓慢推镜，配合轻微手持」这类复合描述，取第一个能识别的关键词
    for (const [alias, mapped] of ALIAS_TO_CODE) {
      if (alias.length >= 2 && lower.includes(alias)) { code = mapped; break; }
    }
  }
  if (!code) code = 'static';

  let downgraded = false;
  if (ADVANCED_MOVEMENTS[code] && !isAdvancedAllowed(cfg)) {
    code = ADVANCED_FALLBACK[code] || 'push';
    downgraded = true;
  }

  const meta = ALL_MOVEMENTS[code] || SAFE_MOVEMENTS.static;
  return { code, zh: meta.zh, en: meta.en, downgraded, raw: input };
}

/** 供提示词使用的可选运镜清单 */
function allowedMovementList(cfg, lang = 'zh') {
  const pool = isAdvancedAllowed(cfg) ? ALL_MOVEMENTS : SAFE_MOVEMENTS;
  return Object.entries(pool).map(([code, meta]) => (lang === 'en' ? `${code} (${meta.en})` : `${code}（${meta.zh}）`));
}

module.exports = {
  SAFE_MOVEMENTS,
  ADVANCED_MOVEMENTS,
  ALL_MOVEMENTS,
  ADVANCED_FALLBACK,
  isAdvancedAllowed,
  normalizeMovement,
  allowedMovementList,
};
