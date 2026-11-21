// Renders the real output of examples/search-box.test.js as an animated terminal SVG.
// Usage: node scripts/demo-svg.js > assets/demo.svg
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const env = { ...process.env, NO_COLOR: '1' };
delete env.NODE_TEST_CONTEXT;

let out = '';
try {
  execFileSync(process.execPath, ['--test', 'examples/search-box.test.js'], { cwd: root, env, encoding: 'utf8' });
} catch (e) {
  out = e.stdout;
}

const raw = out.split('\n');
const start = raw.findIndex((l) => l.includes('Error [RaceError]'));
const end = raw.findIndex((l, i) => i > start && l.includes('Replay exactly'));
if (start < 0 || end < 0) throw new Error('unexpected example output:\n' + out);

const body = raw.slice(start, end + 1).map((l) => l.replace(/^ {2}/, '').replace('Error [RaceError]', 'RaceError'));
const lines = [
  { text: '$ node --test examples/search-box.test.js', cls: 'cmd' },
  { text: '' },
  { text: '✖ search box shows results for the latest query', cls: 'fail' },
  ...body.map((text) => ({
    text,
    cls: text.includes('⚡')
      ? 'hot'
      : text.startsWith('RaceError')
        ? 'fail'
        : text.startsWith('Replay')
          ? 'replay'
          : /│ ←/.test(text)
            ? 'ret'
            : /│ →/.test(text)
              ? 'call'
              : 'dim',
  })),
];

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const lh = 21;
const top = 52;
const width = 900;
const height = top + lines.length * lh + 20;

const rows = lines
  .map(({ text, cls = '' }, i) => {
    const delay = i < 3 ? i * 0.35 : 1.0 + (i - 3) * 0.16;
    return `<text x="24" y="${top + i * lh}" class="l ${cls}" style="animation-delay:${delay.toFixed(2)}s" xml:space="preserve">${esc(text)}</text>`;
  })
  .join('\n  ');

process.stdout.write(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="raceloom output: a stale-response race found and shrunk to one out-of-order step">
<style>
  .bg { fill: #0d1117; }
  .bar { fill: #161b22; }
  .l { font: 14px ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace; fill: #c9d1d9; opacity: 0; animation: in .25s ease-out forwards; }
  .cmd { fill: #8b949e; }
  .fail { fill: #ff7b72; font-weight: 600; }
  .hot { fill: #e3b341; font-weight: 600; }
  .call { fill: #79c0ff; }
  .ret { fill: #7ee787; }
  .replay { fill: #d2a8ff; }
  .dim { fill: #c9d1d9; }
  @keyframes in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
  @media (prefers-reduced-motion: reduce) { .l { animation: none; opacity: 1; } }
</style>
<rect class="bg" width="${width}" height="${height}" rx="10"/>
<rect class="bar" width="${width}" height="30" rx="10"/>
<rect class="bar" y="20" width="${width}" height="10"/>
<circle cx="20" cy="15" r="6" fill="#ff5f56"/><circle cx="40" cy="15" r="6" fill="#ffbd2e"/><circle cx="60" cy="15" r="6" fill="#27c93f"/>
  ${rows}
</svg>
`);
