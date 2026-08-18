const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  fixAgnesImageSize,
  isAgnesImageConfig,
  isGptImageModel,
  resolveImageQualityForModel,
} = require('../src/services/imageClient');

describe('fixAgnesImageSize', () => {
  it('maps 9:16 project size to Agnes portrait preset', () => {
    assert.equal(fixAgnesImageSize('1440x2560'), '1024x1792');
  });

  it('maps 16:9 project size to Agnes landscape preset', () => {
    assert.equal(fixAgnesImageSize('2560x1440'), '1792x1024');
  });

  it('maps 1:1 project size to Agnes square preset', () => {
    assert.equal(fixAgnesImageSize('1920x1920'), '1024x1024');
  });
});

describe('isAgnesImageConfig', () => {
  it('detects agnes provider even when api_protocol is openai', () => {
    assert.equal(
      isAgnesImageConfig({ provider: 'agnes', base_url: 'https://apihub.agnes-ai.com/v1', api_protocol: 'openai' }, 'agnes-image-2.1-flash'),
      true
    );
  });
});

describe('gpt-image quality mapping', () => {
  it('detects gpt-image-2 model id', () => {
    assert.equal(isGptImageModel('gpt-image-2'), true);
    assert.equal(isGptImageModel('gpt-image-1.5'), true);
    assert.equal(isGptImageModel('dall-e-3'), false);
  });

  it('maps DALL·E quality values for gpt-image models', () => {
    assert.equal(resolveImageQualityForModel('gpt-image-2', 'standard'), 'medium');
    assert.equal(resolveImageQualityForModel('gpt-image-2', 'hd'), 'high');
    assert.equal(resolveImageQualityForModel('dall-e-3', 'standard'), 'standard');
    assert.equal(resolveImageQualityForModel('dall-e-3', 'standard', 'openai'), 'medium');
  });
});

describe('buildGptImageEditUrl', () => {
  const { buildGptImageEditUrl } = require('../src/services/imageClient');

  it('rewrites generations endpoint to edits', () => {
    assert.equal(
      buildGptImageEditUrl({ base_url: 'https://api.openai.com/v1', endpoint: '/images/generations' }),
      'https://api.openai.com/v1/images/edits'
    );
  });

  it('defaults to /images/edits when endpoint empty', () => {
    assert.equal(
      buildGptImageEditUrl({ base_url: 'https://api.openai.com/v1', endpoint: '' }),
      'https://api.openai.com/v1/images/edits'
    );
  });
});
