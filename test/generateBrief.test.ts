import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calculateComparisons,
  findPreviousEntry,
  parseBriefResponse,
  renderIndex,
  type HistoryEntry,
} from '../lambda/generateBrief';

const previous: HistoryEntry = {
  date: '2026-08-20',
  rates: { NPR: 135, INR: 85, EUR: 0.9 },
  headline: 'NPR moves',
  insight: 'A previous insight.',
  mostNotableCurrency: 'NPR',
};

test('selects the most recent history entry before today', () => {
  const result = findPreviousEntry([
    { ...previous, date: '2026-08-18' },
    previous,
    { ...previous, date: '2026-08-21' },
  ], '2026-08-21');

  assert.equal(result?.date, '2026-08-20');
});

test('calculates percentage changes and direction', () => {
  const result = calculateComparisons(
    { NPR: 138, INR: 84.15, EUR: 0.9 },
    previous,
  );

  assert.equal(result.NPR.changePercent, (3 / 135) * 100);
  assert.equal(result.NPR.direction, 'up');
  assert.ok(Math.abs(result.INR.changePercent - (-1)) < 1e-12);
  assert.equal(result.INR.direction, 'down');
  assert.equal(result.EUR.direction, 'flat');
});

test('parses a fenced Bedrock JSON response and normalizes currency', () => {
  const result = parseBriefResponse(
    '```json\n{"headline":"NPR rises","insight":"Remittances buy more rupees today. This helps families receiving dollars.","mostNotableCurrency":"npr"}\n```',
    ['NPR', 'INR'],
  );

  assert.deepEqual(result, {
    headline: 'NPR rises',
    insight: 'Remittances buy more rupees today. This helps families receiving dollars.',
    mostNotableCurrency: 'NPR',
  });
});

test('escapes model text when rendering the static page', () => {
  const page = renderIndex(
    {
      date: '2026-08-21',
      rates: { NPR: 138 },
      headline: '<script>alert(1)</script>',
      insight: 'A <strong>real</strong> move.',
      mostNotableCurrency: 'NPR',
    },
    [],
    {},
    ['NPR'],
  );

  assert.match(page, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(page, /<script>alert\(1\)<\/script>/);
  assert.match(page, /Always-on daily agent/);
  assert.match(page, /Every 24 hours/);
  assert.match(page, /Next automatic update/);
});
