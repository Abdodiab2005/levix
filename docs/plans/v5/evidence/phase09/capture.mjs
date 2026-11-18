import { fileURLToPath, pathToFileURL } from 'node:url';
const { chromium } = await import(pathToFileURL(process.argv[2]));
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const root=fileURLToPath(new URL('../../../../../',import.meta.url)).replace(/\/$/,'');
const data=mkdtempSync(join(tmpdir(),'levix-phase09-ui-'));
const evidence=join(root,'docs/plans/v5/evidence/phase09');mkdirSync(evidence,{recursive:true});
const child=spawn(process.execPath,['--require',join(root,'tests/fixtures/no-external-network.cjs'),join(root,'tests/fixtures/server.mjs'),'--data',data,'--routes'],{cwd:root,stdio:['ignore','pipe','pipe']});
let browser;
try {
 const base=await new Promise((resolve,reject)=>{let out='';child.stdout.on('data',b=>{out+=b;const m=out.match(/LISTENING (\S+)/);if(m)resolve('http://'+m[1]);});child.on('exit',c=>reject(new Error('server exit '+c+' '+out)));setTimeout(()=>reject(new Error('server timeout')),15000).unref();});
 browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
 const context=await browser.newContext({viewport:{width:1100,height:900}});
 const page=await context.newPage();
 await page.request.post(base+'/setup',{form:{password:'isolated-ui-password',confirm:'isolated-ui-password'},headers:{Origin:base}});
 // Deterministic metadata; the production check never runs during visual QA.
 await page.route('**/dashboard/api/updates',route=>route.fulfill({json:{success:true,update:{channel:'github',status:'idle',currentVersion:'5.0.0-beta.1',latestVersion:null,url:'https://github.com/Abdodiab2005/levix/releases'}}}));
 await page.route('**/dashboard/api/updates/check',route=>route.fulfill({json:{success:true,update:{channel:'github',status:'unavailable',currentVersion:'5.0.0-beta.1',latestVersion:null,url:'https://github.com/Abdodiab2005/levix/releases'}}}));
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const labels={en:'Check for updates',ar:'البحث عن تحديثات','pt-BR':'Verificar atualizações','es-419':'Buscar actualizaciones'};
 for(const lang of Object.keys(labels)) {
   await page.goto(base+'/');
   await page.evaluate(l=>{localStorage.setItem('levix_lang',l);localStorage.setItem('levix_theme','dark');},lang);
   await page.goto(base+'/#settings/about');
   await page.reload();
   await page.waitForSelector('[role="tab"]');
   await page.getByRole('button',{name:labels[lang],exact:true}).click();
   await page.waitForTimeout(250);
   await page.screenshot({path:join(evidence,lang+'-desktop-offline.png'),fullPage:true});
   await page.setViewportSize({width:390,height:844});
   await page.waitForTimeout(350);
   await page.screenshot({path:join(evidence,lang+'-mobile-offline.png'),fullPage:true});
   const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth);
   if(overflow)throw new Error('horizontal overflow '+lang);
   await page.setViewportSize({width:1100,height:900});
 }
 if(errors.length)throw new Error(errors.join('\n'));
 console.log('PASS: four-language desktop/mobile About, offline status, no page errors or horizontal overflow. Evidence: '+evidence);
}finally{await browser?.close();child.kill('SIGTERM');}
