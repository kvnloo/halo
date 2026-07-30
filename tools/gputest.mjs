import puppeteer from 'puppeteer';
const args = [
  '--no-sandbox','--disable-setuid-sandbox','--enable-gpu','--ignore-gpu-blocklist',
  '--enable-unsafe-webgpu','--use-gl=angle','--use-angle=gl','--enable-features=Vulkan',
  '--disable-dev-shm-usage','--hide-scrollbars','--force-device-scale-factor=1'
];
for (const mode of [['headless-angle-gl', true, args], ['headful-x11', false, ['--no-sandbox','--enable-gpu','--ignore-gpu-blocklist']]]) {
  const [name, headless, a] = mode;
  try {
    const b = await puppeteer.launch({headless: headless ? 'shell' : false, args: a, executablePath:'/usr/bin/google-chrome-stable',
      env: {...process.env, DISPLAY: headless ? undefined : ':1'}});
    const p = await b.newPage();
    await p.goto('file://' + process.cwd() + '/tools/gputest.html', {waitUntil:'load'});
    const info = await p.evaluate(()=>window.__info);
    console.log(name, JSON.stringify(info));
    await b.close();
  } catch(e) { console.log(name, 'FAIL', e.message.slice(0,200)); }
}
