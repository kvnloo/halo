import puppeteer from 'puppeteer';
const CFG = [
  ['new+vulkan', 'new', ['--use-angle=vulkan','--enable-features=Vulkan']],
  ['new+angle-gl-egl', 'new', ['--use-gl=angle','--use-angle=gl','--ozone-platform=headless']],
  ['new+egl', 'new', ['--use-gl=egl']],
  ['new+swiftshader-check', 'new', []],
];
for (const [name, hl, extra] of CFG) {
  try {
    const b = await puppeteer.launch({headless: hl, executablePath:'/usr/bin/google-chrome-stable',
      args: ['--no-sandbox','--disable-setuid-sandbox','--enable-gpu','--ignore-gpu-blocklist','--disable-dev-shm-usage', ...extra]});
    const p = await b.newPage();
    p.on('pageerror', e=>console.log(' err', e.message.slice(0,120)));
    await p.goto('file://' + process.cwd() + '/tools/gputest.html', {waitUntil:'load'});
    const info = await p.evaluate(()=>window.__info ?? {none:true});
    console.log(name, '->', info.renderer ?? JSON.stringify(info));
    await b.close();
  } catch(e) { console.log(name, 'FAIL', e.message.slice(0,150)); }
}
