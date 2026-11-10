import { build } from "esbuild";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const ROOT = "C:/Debug/Self/LoveFinder967-RiskFiveRuler";
const B = join(ROOT, "node_modules/.rfr-dbg");
const raw = { name: "raw", setup(b){ b.onResolve({filter:/\?raw$/},a=>({path:join(a.resolveDir,a.path.replace(/\?raw$/,"")),namespace:"raw"})); b.onLoad({filter:/.*/,namespace:"raw"},a=>({contents:readFileSync(a.path,"utf8"),loader:"text"})); } };
mkdirSync(B,{recursive:true});
writeFileSync(join(B,"e.ts"),`export { deviceById } from "${ROOT}/src/core/devices/index.ts";\nexport * as P from "${ROOT}/src/core/pinmux.ts";\n`);
await build({entryPoints:[join(B,"e.ts")],outfile:join(B,"c.mjs"),bundle:true,format:"esm",platform:"node",target:"node18",logLevel:"error",plugins:[raw]});
const M = await import(pathToFileURL(join(B,"c.mjs")).href);
const dev = M.deviceById("CH32X035G8U6");
const per = dev.peripherals.find(p=>p.id==="USART1");
for (const s of ["TX","RX"]) {
  const fn = `USART1_${s}`;
  console.log(s, M.P.pinsForSignal(dev, fn).map(p=>`${p.name}(${p.signals.find(x=>x.fn===fn)?.remap??0})`).join(" "));
}
const cur = {TX:null, RX:null};
console.log(JSON.stringify(M.P.remapGroupsOf(dev, per, ["TX","RX"], cur, [], ["TX","RX"]).map(g=>({g:g.group,ok:g.feasible,slots:g.slots.map(s=>s.signal+"="+s.pin)})),null,0));
