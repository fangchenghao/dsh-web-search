import test from 'node:test';
import assert from 'node:assert/strict';
import { alternateOfficialUrl, canonicalOfficialUrl } from '../src/mirrors.ts';

test('W3C WCAG Understanding pages map to the official GitHub Pages build', () => {
  assert.equal(
    alternateOfficialUrl('https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html'),
    'https://w3c.github.io/wcag/understanding/target-size-minimum.html',
  );
  assert.equal(
    alternateOfficialUrl('https://www.w3.org/TR/WCAG22/'),
    'https://w3c.github.io/wcag/guidelines/',
  );
  assert.equal(
    alternateOfficialUrl('https://www.w3.org/WAI/standards-guidelines/wcag/'),
    'https://w3c.github.io/wcag/',
  );
});

test('unrelated and lookalike URLs are not rewritten', () => {
  assert.equal(alternateOfficialUrl('https://example.com/WAI/WCAG22/Understanding/x.html'), undefined);
  assert.equal(alternateOfficialUrl('https://www.w3.org/WAI/WCAG22/Understanding/'), undefined);
  assert.equal(alternateOfficialUrl('not a URL'), undefined);
});

test('known W3C mirrors map back to the canonical citation', () => {
  assert.equal(
    canonicalOfficialUrl('https://w3c.github.io/wcag/understanding/target-size-minimum.html'),
    'https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html',
  );
  assert.equal(canonicalOfficialUrl('https://w3c.github.io/wcag/guidelines/'), 'https://www.w3.org/TR/WCAG22/');
  assert.equal(canonicalOfficialUrl('https://example.com/wcag/guidelines/'), 'https://example.com/wcag/guidelines/');
});
