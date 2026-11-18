// Real panel, isolated SQLite, fake WhatsApp socket/image transport. No pairing.
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
const { chromium }=await import(pathToFileURL(process.argv[2]));
const root=fileURLToPath(new URL('../../../../../',import.meta.url)).replace(/\/$/,'');
const evidence=fileURLToPath(new URL('.',import.meta.url));mkdirSync(evidence,{recursive:true});
await import(pathToFileURL(join(root,'tests/fixtures/no-external-network.cjs')));
const h=await import(pathToFileURL(join(root,'tests/harness.mjs')));h.useTempDataDir('levix-phase11-browser');
const {default:routes,setSession}=await import(pathToFileURL(join(root,'src/routes/dashboard.api.esm.js')));
const {app,server,io,dashboardJson,requireLoginApi,noStore,installFinalHandlers}=h.require('./app.cjs');
app.use('/dashboard/api',requireLoginApi,noStore,dashboardJson,routes);installFinalHandlers();
let mode='available',name='Test Account حساب تجريبي',about='Ready to help • جاهز للمساعدة',id='15551234567@s.whatsapp.net',since=1;
let pictureCalls=0,statusCalls=0,imageCalls=0,resolveSlow;
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64');
const provider=h.require('./src/utils/providerUrl.cjs');const originalFetch=provider.safeProviderFetch;
provider.safeProviderFetch=async()=>{imageCalls++;return new Response(png,{headers:{'content-type':'image/png'}});};
function socket() {const own=id;return {user:{id:own,name},async profilePictureUrl(){pictureCalls++;if(mode==='private')throw Error('private');return 'https://mmg.whatsapp.net/fixture.png';},async fetchStatus(){statusCalls++;if(mode==='slow')return new Promise(resolve=>resolveSlow=resolve);return [{id:own,status:{status:mode==='private'?null:about}}];}};}
let current=socket(),connected=true;
const snapshot=()=>({state:connected?'connected':'disconnected',connected,linked:true,since,user:current?.user||null,canStart:!connected,canStop:connected,canUnlink:true,isOnline:true});
const manager={get socket(){return current;},getState:snapshot};setSession(manager);
io.on('connection',socket=>socket.emit('session',snapshot()));
const {base}=await h.listen(server);
let browser,checks=0;const assert=(v,label)=>{if(!v)throw Error(label);checks++;};
function publish(){since++;setSession(manager);io.emit('session',snapshot());}
try {
 browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
 const context=await browser.newContext({viewport:{width:1100,height:900}});
 const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.request.post(base+'/setup',{form:{password:'isolated-browser-password',confirm:'isolated-browser-password'},headers:{Origin:base}});
 await page.addInitScript(()=>localStorage.setItem('levix_tour_v1_done','1'));
 await page.goto(base+'/#overview');await page.waitForTimeout(150);
 assert(pictureCalls===0&&statusCalls===0,'Overview queried the account profile');
 for(const lang of ['en','ar','pt-BR','es-419']) {
  await page.evaluate(l=>{localStorage.setItem('levix_lang',l);localStorage.setItem('levix_theme','dark');},lang);
  await page.goto(base+'/#connection');await page.reload();
  await page.getByText(name,{exact:true}).waitFor();await page.getByText('+15551234567',{exact:true}).waitFor();
  await page.waitForFunction(()=>[...document.querySelectorAll('img')].some(img=>img.src.includes('/account/photo?revision=')&&img.naturalWidth>0));checks++;
  await page.screenshot({path:join(evidence,lang+'-connected-desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});await page.waitForTimeout(350);
  await page.screenshot({path:join(evidence,lang+'-connected-mobile.png'),fullPage:true});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'horizontal overflow '+lang);
  await page.setViewportSize({width:1100,height:900});
 }
 assert(pictureCalls===1&&statusCalls===1,'locale reloads bypassed metadata cache');
 assert(imageCalls===1,'locale reloads bypassed picture cache');
 await page.evaluate(()=>{localStorage.setItem('levix_lang','en');});await page.reload();
 const refresh=page.getByRole('button',{name:'Refresh account details',exact:true});
 await refresh.waitFor();await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(b=>b.getAttribute('aria-label')==='Refresh account details'&&!b.disabled),null,{timeout:15000});
 about='Refreshed About';await refresh.click();await page.getByText(about,{exact:true}).waitFor();
 assert(statusCalls===2,'explicit refresh did not query once');
 mode='private';about=null;current=socket();publish();
 await page.getByText('Unavailable',{exact:true}).first().waitFor();
 assert(await page.getByText('Refreshed About',{exact:true}).count()===0,'private field retained prior About');
 await page.evaluate(()=>{localStorage.setItem('levix_theme','light');});await page.reload();
 await page.getByText('Unavailable',{exact:true}).first().waitFor();
 await page.screenshot({path:join(evidence,'en-private-light.png'),fullPage:true});
 connected=false;current=null;publish();
 await page.getByText('Connect WhatsApp to view your account details.',{exact:true}).waitFor();
 assert(await page.getByText('+15551234567',{exact:true}).count()===0,'disconnect retained phone');
 await page.screenshot({path:join(evidence,'en-disconnected-light.png'),fullPage:true});
 connected=true;mode='slow';name='Old pending account';current=socket();publish();
 await page.waitForFunction(()=>document.querySelectorAll('[role="status"]').length>0);await page.waitForTimeout(100);
 for(let i=0;!resolveSlow&&i<200;i++) await new Promise(resolve=>setTimeout(resolve,10));
 assert(Boolean(resolveSlow),'slow profile query started');
 const pendingResolve=resolveSlow;mode='available';name='New account';id='16661234567@s.whatsapp.net';about='New account About';current=socket();publish();
 await page.getByText('New account About',{exact:true}).waitFor();
 pendingResolve([{id:'15551234567@s.whatsapp.net',status:{status:'OLD MUST NOT SHOW'}}]);await page.waitForTimeout(100);
 assert(await page.getByText('OLD MUST NOT SHOW',{exact:true}).count()===0,'late old-account About rendered');
 assert(await page.getByText('+15551234567',{exact:true}).count()===0,'old-account phone rendered');
 about='Reconnected About';current=socket();publish();
 await page.getByText('Reconnected About',{exact:true}).waitFor();checks++;
 assert(errors.length===0,'browser errors: '+errors.join('; '));
 console.log(`PASS ${checks} browser checks: visible-screen-only reads, lazy same-origin picture, four locales/RTL, cache reuse, explicit refresh, private fields, disconnect, stale response, same-account reconnect and light/dark.`);
} finally {provider.safeProviderFetch=originalFetch;await browser?.close();setSession(null);await new Promise(resolve=>io.close(resolve));if(server.listening)await new Promise(resolve=>server.close(resolve));}
