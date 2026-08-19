/**
 * 图片提示词语种路由。
 *
 * 旧实现把「prompt 必须全文中文，禁止整句英文」硬编码进首/尾/关键帧提示词。
 * 但国内模型（即梦 / 通义 / Seedream）确实对中文理解更好，而 Gemini Imagen、Veo、
 * OpenAI 系的文本编码器对英文的语义精度明显更高——同一条提示词换个语种，成图质量差别很大。
 *
 * 因此按实际要调用的图片模型来决定 prompt 语种：
 *   config.style.image_prompt_language = 'zh' | 'en' | 'auto'（缺省 auto）
 */

/** 明确以英文语料为主的图片供应商/协议 */
const EN_FIRST_PROTOCOLS = new Set(['gemini', 'openai']);
const EN_FIRST_PROVIDERS = new Set(['gemini', 'google', 'openai', 'azure', 'stability', 'replicate']);

/** 明确以中文语料为主的（国内模型），即使协议是 openai 兼容也应走中文 */
const ZH_FIRST_PROVIDERS = new Set([
  'dashscope', 'qwen_image', 'volces', 'volcengine', 'volc', 'kling', 'klingai',
  'nano_banana', 'jimeng', 'agnes',
]);

const ZH_FIRST_MODEL_PATTERN = /seedream|doubao|wanx|wan2|qwen|kling|jimeng|seedance|hunyuan|ernie|glm/i;
const EN_FIRST_MODEL_PATTERN = /imagen|dall-?e|gpt-image|flux|stable-?diffusion|midjourney|veo/i;

/**
 * 解析本次生成该用哪种语种写图片提示词。
 * @param {object} db
 * @param {object} cfg
 * @param {object} [opts] { model, imageServiceType }
 * @returns {'zh'|'en'}
 */
function resolveImagePromptLang(db, cfg, opts = {}) {
  const configured = String(cfg?.style?.image_prompt_language || 'auto').toLowerCase();
  if (configured === 'zh' || configured === 'en') return configured;

  // auto：看实际会被调用的图片模型
  let provider = '';
  let model = String(opts.model || '');
  let protocol = '';
  try {
    const imageClient = require('./imageClient');
    const config = imageClient.getDefaultImageConfig(
      db, opts.model || undefined, null, opts.imageServiceType || 'storyboard_image'
    );
    if (config) {
      provider = String(config.provider || '').toLowerCase();
      protocol = String(config.api_protocol || '').toLowerCase();
      if (!model) {
        model = Array.isArray(config.model) ? (config.model[0] || '') : String(config.model || '');
      }
    }
  } catch (_) {
    // 取不到配置时按项目语言兜底
  }

  if (ZH_FIRST_MODEL_PATTERN.test(model)) return 'zh';
  if (EN_FIRST_MODEL_PATTERN.test(model)) return 'en';
  if (ZH_FIRST_PROVIDERS.has(provider)) return 'zh';
  if (EN_FIRST_PROVIDERS.has(provider)) return 'en';
  if (protocol && EN_FIRST_PROTOCOLS.has(protocol)) return 'en';

  // 兜底：跟随项目语言，行为与改造前一致
  return String(cfg?.app?.language || 'zh').toLowerCase().startsWith('en') ? 'en' : 'zh';
}

/** 把解析结果挂到 cfg 副本上，供 promptI18n 的帧提示词读取 */
function withImagePromptLang(cfg, lang) {
  return { ...cfg, __image_prompt_lang: lang === 'en' ? 'en' : 'zh' };
}

/** promptI18n 侧读取：未显式解析过时回落到项目语言 */
function imagePromptLangOf(cfg) {
  const explicit = cfg?.__image_prompt_lang;
  if (explicit === 'en' || explicit === 'zh') return explicit;
  const configured = String(cfg?.style?.image_prompt_language || '').toLowerCase();
  if (configured === 'zh' || configured === 'en') return configured;
  return String(cfg?.app?.language || 'zh').toLowerCase().startsWith('en') ? 'en' : 'zh';
}

module.exports = {
  resolveImagePromptLang,
  withImagePromptLang,
  imagePromptLangOf,
};
