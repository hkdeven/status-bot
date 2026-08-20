// The digest uses a small, known subset of markdown, so it converts without a
// dependency: headings, bullets, bold, inline code and links.
const escape = s => s
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function inline (text) {
  return escape(text)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
}

const STYLE = `
:root { color-scheme: light dark; --fg:#1c1c1e; --muted:#6b6b70; --bg:#fdfdfc;
  --card:#fff; --line:#e6e6e3; --accent:#a8442a; --flag:#fbf3ea; }
@media (prefers-color-scheme: dark) {
  :root { --fg:#e8e8e6; --muted:#9a9a9f; --bg:#161615; --card:#1e1e1d;
    --line:#33322f; --accent:#e0855f; --flag:#2a221c; }
}
* { box-sizing: border-box; }
body { margin:0; padding:2.5rem 1.25rem 5rem; background:var(--bg); color:var(--fg);
  font:16px/1.6 ui-sans-serif,-apple-system,"SF Pro Text",Helvetica,sans-serif; }
main { max-width: 46rem; margin:0 auto; }
h1 { font-size:1.8rem; letter-spacing:-0.02em; margin:0 0 .35rem; }
h2 { font-size:1.15rem; letter-spacing:-0.01em; margin:2.5rem 0 .75rem;
  padding-bottom:.4rem; border-bottom:1px solid var(--line); }
h3 { font-size:.95rem; margin:1.6rem 0 .5rem; color:var(--accent);
  text-transform:none; font-weight:650; }
p { margin:.5rem 0; }
p.lede { color:var(--muted); font-size:.9rem; margin-bottom:2rem; }
ul { margin:.4rem 0 1rem; padding-left:1.1rem; }
li { margin:.3rem 0; }
li::marker { color:var(--muted); }
code { background:var(--card); border:1px solid var(--line); border-radius:4px;
  padding:.05rem .3rem; font:.85em ui-monospace,SFMono-Regular,Menlo,monospace; }
a { color:var(--accent); }
section.attention { background:var(--flag); border:1px solid var(--line);
  border-left:3px solid var(--accent); border-radius:8px; padding:.4rem 1.1rem 1rem;
  margin-bottom:1rem; }
section.attention h2 { border:none; margin-top:1rem; }
`

export function toHtml (markdown, title) {
  const out = []
  let list = false
  let attention = false
  const closeList = () => { if (list) { out.push('</ul>'); list = false } }

  const lines = markdown.split('\n')
  lines.forEach((raw, i) => {
    const line = raw.trimEnd()
    if (!line) { closeList(); return }

    if (line.startsWith('### ')) { closeList(); out.push(`<h3>${inline(line.slice(4))}</h3>`); return }
    if (line.startsWith('## ')) {
      closeList()
      if (attention) { out.push('</section>'); attention = false }
      const heading = line.slice(3)
      if (heading === 'Needs you') { out.push('<section class="attention">'); attention = true }
      out.push(`<h2>${inline(heading)}</h2>`)
      return
    }
    if (line.startsWith('# ')) { closeList(); out.push(`<h1>${inline(line.slice(2))}</h1>`); return }
    if (line.startsWith('- ')) {
      if (!list) { out.push('<ul>'); list = true }
      out.push(`<li>${inline(line.slice(2))}</li>`)
      return
    }
    closeList()
    // The line under the title is the coverage note, styled as a lede.
    out.push(`<p${i < 4 ? ' class="lede"' : ''}>${inline(line)}</p>`)
  })
  closeList()
  if (attention) out.push('</section>')

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(title)}</title>
<style>${STYLE}</style></head>
<body><main>
${out.join('\n')}
</main></body></html>
`
}
