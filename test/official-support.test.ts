import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isPostgresVersionQuery,
  parsePostgresSupport,
  postgresSupportSource,
} from '../src/official-support.ts';

const TABLE = `
<table>
  <tr><th>Version</th><th>Current minor</th><th>Supported</th><th>First Release</th><th>Final Release</th></tr>
  <tr><td>17</td><td>17.6</td><td>Yes</td><td>September 26, 2024</td><td>November 8, 2029</td></tr>
  <tr><td>18</td><td>18.6</td><td>Yes</td><td>September 25, 2025</td><td>November 14, 2030</td></tr>
  <tr><td>13</td><td>13.23</td><td>No</td><td>September 24, 2020</td><td>November 13, 2025</td></tr>
</table>`;

test('parsePostgresSupport reads the official table and sorts by major', () => {
  const rows = parsePostgresSupport(TABLE);
  assert.deepEqual(rows.map((row) => row.major), ['18', '17', '13']);
  assert.deepEqual(rows[0], {
    major: '18',
    minor: '18.6',
    supported: true,
    firstRelease: 'September 25, 2025',
    finalRelease: 'November 14, 2030',
  });
});

test('postgresSupportSource answers current major and EOL from the table', () => {
  const source = postgresSupportSource(parsePostgresSupport(TABLE));
  assert.ok(source);
  assert.match(source?.title ?? '', /major 18 \(18\.6\), supported/u);
  assert.match(source?.snippet ?? '', /final release \(EOL\) November 14, 2030/u);
  assert.equal(source?.url, 'https://www.postgresql.org/support/versioning/');
});

test('postgres support lookup is query-scoped', () => {
  assert.equal(isPostgresVersionQuery('PostgreSQL 当前最新的稳定大版本和 EOL 日期'), true);
  assert.equal(isPostgresVersionQuery('how to configure PostgreSQL logical replication'), false);
  assert.equal(isPostgresVersionQuery('MySQL EOL'), false);
  assert.equal(parsePostgresSupport('<html>maintenance</html>').length, 0);
});
