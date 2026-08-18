const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { dashScopeWanVideoSize, dashScopeWanResolutionTier, dashScopeHasDistinctLastFrame } = require('../src/services/videoClient');

describe('dashScopeWanVideoSize', () => {
  it('maps 9:16 to portrait 720P by default (r2v official size, not 1920*1080)', () => {
    assert.equal(dashScopeWanVideoSize('9:16'), '720*1280');
    assert.equal(dashScopeWanVideoSize('9:16', '720p'), '720*1280');
  });

  it('maps 9:16 + 1080p to 1080*1920', () => {
    assert.equal(dashScopeWanVideoSize('9:16', '1080p'), '1080*1920');
  });

  it('maps 16:9 to landscape', () => {
    assert.equal(dashScopeWanVideoSize('16:9', '720p'), '1280*720');
    assert.equal(dashScopeWanVideoSize('16:9', '1080p'), '1920*1080');
  });

  it('maps portrait alias and 3:4', () => {
    assert.equal(dashScopeWanVideoSize('portrait'), '720*1280');
    assert.equal(dashScopeWanVideoSize('3:4'), '832*1088');
  });
});

describe('dashScopeWanResolutionTier', () => {
  it('defaults to 720P; 480P only when allowed', () => {
    assert.equal(dashScopeWanResolutionTier(), '720P');
    assert.equal(dashScopeWanResolutionTier('480p', { allow480: true }), '480P');
    assert.equal(dashScopeWanResolutionTier('480p'), '720P');
    assert.equal(dashScopeWanResolutionTier('1080p'), '1080P');
  });
});

describe('dashScopeHasDistinctLastFrame', () => {
  it('is false when last is missing or copied from first', () => {
    assert.equal(dashScopeHasDistinctLastFrame('/a.png', ''), false);
    assert.equal(dashScopeHasDistinctLastFrame('/a.png', '/a.png'), false);
    assert.equal(dashScopeHasDistinctLastFrame('', '/b.png'), false);
  });

  it('is true only for two different frames', () => {
    assert.equal(dashScopeHasDistinctLastFrame('/first.png', '/last.png'), true);
  });
});
