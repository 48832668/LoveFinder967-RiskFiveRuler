// 把生成代码写到磁盘，供 API 校验脚本使用
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'fs';
const [,, devId, outDir, base] = process.argv;
const BASE = base || 'http://127.0.0.1:1420';
async function main() {
const b = await chromium.launch({ channel: 'msedge' });
const p = await b.newPage();
await p.goto(`${BASE}/?demo=1&dev=${devId}`, { waitUntil: 'networkidle' });
await p.waitForTimeout(1200);
const files = await p.evaluate(async () => {
  const devmod = await import('/src/devices/index.ts');
  const cg = await import('/src/backends/wch/codegen.ts');
  const pr = await import('/src/app/project.ts');
  const dev = devmod.DEVICE_MAP[location.search.match(/dev=([^&]+)/)[1]];
  const proj = pr.createDemoProject(dev);
  proj.settings.toolchain = 'mrs';
  // 打开所有能打开的外设，让覆盖面尽量宽
  for (const per of dev.peripherals) {
    if (per.kind === 'GPIO' || per.kind === 'SYSTEM') continue;
    const cfg = proj.configs[per.id];
    if (!cfg || cfg.enabled) continue;
    cfg.enabled = true;
    if (cfg.nvic) cfg.nvic.enabled = true;
  }
  return cg.generate(proj, dev).map((f) => ({ path: f.path, content: f.content }));
});
for (const f of files) {
  const full = outDir + '/' + f.path;
  mkdirSync(full.slice(0, full.lastIndexOf('/')), { recursive: true });
  writeFileSync(full, f.content);
}
console.log('wrote', files.length, 'files to', outDir);
await b.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
