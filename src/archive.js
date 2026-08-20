import { readdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { root } from './state.js'

const dir = join(root, 'digests')

// One row per past digest, newest first, so nothing is lost when several runs
// land on the same day.
export function writeIndex () {
  const files = readdirSync(dir)
    .filter(f => /^\d{4}-\d{2}-\d{2}-\d{6}\.html$/.test(f))
    .sort()
    .reverse()

  const rows = files.map(file => {
    const [, date, time] = /^(\d{4}-\d{2}-\d{2})-(\d{6})\.html$/.exec(file)
    const when = `${date} at ${time.slice(0, 2)}:${time.slice(2, 4)}`
    // Count only the bullets inside the Needs you block, not every bullet in the file.
    let headline = ''
    try {
      const md = readFileSync(join(dir, file.replace('.html', '.md')), 'utf8')
      const block = /^## Needs you\n([\s\S]*?)(?=\n## )/m.exec(md)?.[1] || ''
      const needs = block.split('\n').filter(l => l.startsWith('- ')).length
      headline = needs ? `${needs} item${needs === 1 ? '' : 's'} needed you` : 'nothing needed you'
    } catch { headline = '' }
    return `<li><a href="${file}">${when}</a><span>${headline}</span></li>`
  })

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Status digest archive</title>
<style>
:root { color-scheme: light dark; --fg:#1c1c1e; --muted:#6b6b70; --bg:#fdfdfc;
  --line:#e6e6e3; --accent:#a8442a; }
@media (prefers-color-scheme: dark) {
  :root { --fg:#e8e8e6; --muted:#9a9a9f; --bg:#161615; --line:#33322f; --accent:#e0855f; }
}
body { margin:0; padding:2.5rem 1.25rem 5rem; background:var(--bg); color:var(--fg);
  font:16px/1.6 ui-sans-serif,-apple-system,"SF Pro Text",Helvetica,sans-serif; }
main { max-width:40rem; margin:0 auto; }
h1 { font-size:1.6rem; letter-spacing:-0.02em; margin:0 0 .25rem; }
p.lede { color:var(--muted); font-size:.9rem; margin:0 0 2rem; }
ul { list-style:none; margin:0; padding:0; }
li { display:flex; justify-content:space-between; gap:1rem; align-items:baseline;
  padding:.6rem 0; border-bottom:1px solid var(--line); }
a { color:var(--accent); text-decoration:none; font-variant-numeric:tabular-nums; }
a:hover { text-decoration:underline; }
span { color:var(--muted); font-size:.85rem; text-align:right; }
</style></head>
<body><main>
<h1>Status digest archive</h1>
<p class="lede">${files.length} digest${files.length === 1 ? '' : 's'} kept, newest first.</p>
<ul>
${rows.join('\n')}
</ul>
</main></body></html>
`
  writeFileSync(join(dir, 'index.html'), html)
  return files.length
}
