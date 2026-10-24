"""Bundle the dependency-free app into one offline-capable HTML document."""
from pathlib import Path
import base64
import re
root = Path(__file__).parent
source = root / 'src'
html = (source / 'index.html').read_text()
css = re.sub(r'^@import[^\n]*\n', '', (source / 'style.css').read_text(), flags=re.M)
assert css.lstrip().startswith(':root'), 'Theme variables must be included.'
data_url = 'data:application/json;base64,' + base64.b64encode((source / 'demo.geojson').read_bytes()).decode()
parts = []
for name in ['motion.mjs', 'operations.mjs', 'engine.mjs', 'import.mjs', 'detail.mjs', 'map.mjs', 'app.mjs']:
    code = (source / name).read_text()
    code = re.sub(r'^import\b.*?;\s*', '', code, flags=re.M | re.S)
    code = re.sub(r'\bexport (?=(function|async function|class|const)\b)', '', code)
    parts.append(code.replace('./demo.geojson', data_url))
script = '\n'.join(parts).replace('</script', '<\\/script')
html = re.sub(r'<link rel="stylesheet" href="style.css"\s*/?>', lambda _: '<style>'+css+'</style>', html)
html = html.replace('<script type="module" src="app.mjs"></script>', '<script type="module">'+script+'</script>')
assert 'src="app.mjs"' not in html
assert './demo.geojson' not in html
output = root / 'LoopLab.html'
output.write_text(html)
print(output.name)
