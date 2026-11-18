import { fileURLToPath, pathToFileURL } from 'node:url';
const { chromium } = await import(pathToFileURL(process.argv[2]));
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const root=fileURLToPath(new URL('../../../../../',import.meta.url)).replace(/\/$/,'');
const data=mkdtempSync(join(tmpdir(),'levix-phase09-ui-regression-'));
const child=spawn(process.execPath,['--require',join(root,'tests/fixtures/no-external-network.cjs'),join(root,'tests/fixtures/server.mjs'),'--data',data,'--routes'],{cwd:root,stdio:['ignore','pipe','pipe']});
let browser,checks=0;
const assert=(v,label)=>{if(!v)throw Error(label);checks++;};
try {
 const base=await new Promise((resolve,reject)=>{let out='';child.stdout.on('data',b=>{out+=b;const m=out.match(/LISTENING (\S+)/);if(m)resolve('http://'+m[1]);});child.on('exit',c=>reject(Error('server exit '+c)));setTimeout(()=>reject(Error('server timeout')),15000).unref();});
 browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
 const context=await browser.newContext({viewport:{width:1100,height:900}});
 let page=await context.newPage();
 await page.request.post(base+'/setup',{form:{password:'isolated-ui-password',confirm:'isolated-ui-password'},headers:{Origin:base}});
 const meta={channel:'github',status:'idle',currentVersion:'5.0.0-beta.1',latestVersion:null,url:'https://github.com/Abdodiab2005/levix/releases'};
 let releaseMetadata;
 const blocked=new Promise(resolve=>releaseMetadata=resolve);
 await page.route('**/dashboard/api/updates',async route=>{await blocked;await route.fulfill({json:{success:true,update:meta}});});
 await page.route('**/dashboard/api/updates/check',route=>route.fulfill({json:{success:true,update:{...meta,status:'available',latestVersion:'5.1.0',url:meta.url+'/tag/v5.1.0',releaseNotes:'<script>not executable</script>'}}}));
 await page.goto(base+'/#settings/about');
 await page.getByRole('button',{name:'Check for updates',exact:true}).click();
 await page.getByText('Version 5.1.0 is available.').waitFor();
 releaseMetadata();await page.waitForTimeout(150);
 assert(await page.getByText('Version 5.1.0 is available.').isVisible(),'late metadata overwrote result');
 assert(await page.getByText('<script>not executable</script>',{exact:true}).isVisible(),'notes not plain text');
 await page.close();
 page=await context.newPage();
 await page.addInitScript(()=>{
  window.qa={enabled:false,pending:false,checks:[],review:0,starts:0,complete:0};
  window.LevixHost={getInstallChannel:()=> 'play',hasPendingPlayUpdate:()=>window.qa.pending,
   getReviewPromptsEnabled:()=>window.qa.enabled,setReviewPromptsEnabled:v=>{window.qa.enabled=v;return true;},
   playCheckUpdate:id=>{window.qa.checks.push(id);return '{"ok":true}';},
   playStartUpdate:id=>{window.qa.starts++;setTimeout(()=>window.__levixHostDone(id,{ok:true,status:'started'}),0);return '{"ok":true}';},
   playCompleteUpdate:id=>{window.qa.complete++;setTimeout(()=>window.__levixHostDone(id,{ok:true,status:'started'}),0);return '{"ok":true}';},
   playMaybeReview:id=>{window.qa.review++;setTimeout(()=>window.__levixHostDone(id,{ok:true}),0);return '{"ok":true}';},
   openOfficialLink:()=>true};
 });
 await page.route('**/dashboard/api/updates',route=>route.fulfill({json:{success:true,update:{...meta,channel:'play'}}}));
 await page.goto(base+'/#settings/about');
 await page.getByRole('button',{name:'Check for updates',exact:true}).waitFor();
 assert(await page.evaluate(()=>window.qa.checks.length)===0,'new Play installation checked automatically');
 await page.getByRole('button',{name:'Check for updates',exact:true}).click();
 await page.waitForFunction(()=>window.qa.checks.length===1);
 await page.evaluate(()=>{window.dispatchEvent(new Event('levix-play-update'));const id=window.qa.checks.shift();window.__levixHostDone(id,{ok:true,status:'downloading'});});
 await page.waitForFunction(()=>window.qa.checks.length===1);
 await page.evaluate(()=>window.__levixHostDone(window.qa.checks.shift(),{ok:true,status:'downloaded'}));
 await page.getByRole('button',{name:'Restart to finish update',exact:true}).waitFor();checks++;
 assert(await page.evaluate(()=>window.qa.complete)===0,'completion triggered without user');
 await page.getByRole('button',{name:'Help',exact:true}).click();
 await page.getByRole('menuitem',{name:'About Levix',exact:true}).click();
 const dialog=page.getByRole('dialog');
 await dialog.getByRole('switch',{name:'Allow occasional rating prompts',exact:true}).click();
 await page.keyboard.press('Escape');
 assert(await page.getByRole('switch',{name:'Allow occasional rating prompts',exact:true}).getAttribute('aria-checked')==='true','review preference stale across panels');
 await page.getByRole('button',{name:'Help',exact:true}).click();await page.getByRole('menuitem',{name:'About Levix',exact:true}).click();
 await page.evaluate(()=>window.dispatchEvent(new Event('levix-play-update')));
 await page.waitForFunction(()=>window.qa.checks.length===1);
 await page.evaluate(()=>window.__levixHostDone(window.qa.checks.shift(),{ok:true,status:'downloaded'}));
 await dialog.getByRole('button',{name:'Restart to finish update',exact:true}).waitFor();checks++;
 assert(await page.evaluate(()=>window.qa.review)===0,'automatic refresh offered a review');
 await page.keyboard.press('Escape');
 await page.evaluate(()=>{window.qa.pending=true;});
 // Simulate mounting About after native recovery emitted its event.
 await page.goto(base+'/#settings/general');await page.goto(base+'/#settings/about');
 await page.waitForFunction(()=>window.qa.checks.length===1);
 await page.evaluate(()=>window.__levixHostDone(window.qa.checks.shift(),{ok:true,status:'downloaded'}));
 await page.getByRole('button',{name:'Restart to finish update',exact:true}).waitFor();checks++;
 assert(await page.getByText('5.0.0-beta.1',{exact:true}).isVisible(),'recovery discarded current version');
 console.log(`PASS ${checks} browser regression checks: late metadata, plain-text notes, no startup check, queued completion, explicit restart, synchronized review consent, shared native checks, no review on automatic refresh, recovery before mount.`);
}finally{await browser?.close();child.kill('SIGTERM');}
