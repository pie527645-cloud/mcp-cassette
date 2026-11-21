import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { tokenizeCommand } from '../src/argv.js';

describe('tokenizeCommand (quote-aware argv parser)', () => {
  it('splits basic unquoted arguments on whitespace', () => {
    assert.deepEqual(tokenizeCommand('  node   dist/server.js --port 8080\t--verbose '), [
      'node',
      'dist/server.js',
      '--port',
      '8080',
      '--verbose',
    ]);
  });

  it('preserves spaces inside single and double quotes and concatenates adjacent segments', () => {
    assert.deepEqual(
      tokenizeCommand(`node "my folder/server.js" 'single quoted arg' --label="alpha beta"`),
      ['node', 'my folder/server.js', 'single quoted arg', '--label=alpha beta'],
    );
  });

  it('preserves Windows backslash paths both inside and outside double quotes', () => {
    assert.deepEqual(
      tokenizeCommand(
        `"C:\\Program Files\\nodejs\\node.exe" C:\\Users\\demo\\mcp\\server.js --dir "C:\\temp\\work\\\\"`,
      ),
      [
        'C:\\Program Files\\nodejs\\node.exe',
        'C:\\Users\\demo\\mcp\\server.js',
        '--dir',
        'C:\\temp\\work\\',
      ],
    );
  });

  it('handles escaped double quotes inside double-quoted strings and POSIX escaped spaces', () => {
    assert.deepEqual(
      tokenizeCommand(`node /opt/mcp\\ server/index.js --json "{\\"mode\\":\\"strict\\"}"`),
      ['node', '/opt/mcp server/index.js', '--json', '{"mode":"strict"}'],
    );
  });

  it('rejects empty commands, unclosed quotes, and null bytes', () => {
    assert.throws(() => tokenizeCommand('   '), /must specify an executable/);
    assert.throws(() => tokenizeCommand('node "unclosed arg'), /unclosed double quote/);
    assert.throws(() => tokenizeCommand("node 'unclosed arg"), /unclosed single quote/);
    assert.throws(() => tokenizeCommand('node bad\0arg'), /null byte/);
  });
});
