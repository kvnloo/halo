set -e
cd /workspace/zer0/products/halo
node --input-type=module -e "import('./src/world/sky.js').then(m=>console.log('parse ok'))"
.venv/bin/python - <<'PY'
import re
s=open('src/world/sky.js').read()
bad=[]
for m in re.finditer(r'/\* glsl \*/`', s):
    st=m.end(); en=s.index('\n`;', st)
    seg=s[st:en]
    if '`' in seg: bad.append(s[:st].count('\n')+1)
print('GLSL backtick check:', 'FAIL at literal starting line %s'%bad if bad else 'clean')
PY
