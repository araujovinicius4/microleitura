// Runs the production content script in real browser frames through CDP.
// Injection is simulated; Chrome's installed-extension dispatcher is not under test.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const profile = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'microleitura-frames-'));
const chrome = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
let browser, ws;
const servers = [];
const contexts = new Map();
const production = fs.readFileSync('content.js', 'utf8');
// Host substitution only: exercise the SEI branch on a loopback fixture.
const source = production.replace("location.hostname === 'sei.ebserh.gov.br'", "location.hostname === '127.0.0.1'");
const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
assert.equal(manifest.version, '0.6.0');
assert.equal(manifest.content_scripts[0].all_frames, true);
assert.equal(manifest.content_scripts[0].match_about_blank, undefined);
const fixture = name => fs.readFileSync(path.join('tests/frames', name), 'utf8');
const serve = (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let html;
  if (url.pathname === '/shell') html = fixture('shell.html').replace('documento.html?id=1', '/controlador.php?acao=documento_visualizar&id=1&token=AAA').replace('editor.html', '/editor?acao=documento_visualizar');
  else if (url.pathname === '/editor') html = fixture('editor.html');
  else if (url.pathname === '/design') html = fixture('editor.html').replace(' contenteditable="true"', '').replace('</body>', '<script>document.designMode="on"</script></body>');
  else html = fixture('documento.html').replace('Este é um documento', `Este é o documento ${url.searchParams.get('id') || '1'}`);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');res.end(html);
};
(async () => {
  for (const port of [19362,19363]) {const server=http.createServer(serve);servers.push(server);await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));}
  browser = spawn(chrome, ['--headless=new','--no-first-run','--remote-debugging-port=19364',`--user-data-dir=${profile}`,'about:blank'], {windowsHide:true,stdio:'ignore'});
  let tabs;
  for(let i=0;i<100;i++){try{tabs=await(await fetch('http://127.0.0.1:19364/json')).json();if(tabs.some(t=>t.type==='page'))break;}catch{}await delay(100);}
  assert.ok(tabs, 'Chrome CDP started');
  ws=new WebSocket(tabs.find(t=>t.type==='page').webSocketDebuggerUrl);
  await new Promise(resolve=>ws.addEventListener('open',resolve,{once:true}));
  let id=0;const pending=new Map();
  ws.addEventListener('message',event=>{const m=JSON.parse(event.data);if(m.id){pending.get(m.id)?.(m);pending.delete(m.id);}if(m.method==='Runtime.executionContextCreated'&&m.params.context.auxData?.isDefault)contexts.set(m.params.context.auxData.frameId,m.params.context.id);if(m.method==='Runtime.executionContextsCleared')contexts.clear();});
  const cdp=(method,params={})=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,m=>m.error?reject(m.error):resolve(m.result));ws.send(JSON.stringify({id:n,method,params}));});
  const evaluate=async(expression,contextId)=>{const r=await cdp('Runtime.evaluate',{expression,contextId,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
  await cdp('Runtime.enable');await cdp('Page.enable');
  await cdp('Page.addScriptToEvaluateOnNewDocument',{source:`window.chrome={storage:{local:{get:async k=>k===null?Object.fromEntries(Object.keys(localStorage).map(k=>[k,JSON.parse(localStorage.getItem(k))])):{[k]:JSON.parse(localStorage.getItem(k)||'null')},set:async obj=>{for(const [k,v] of Object.entries(obj))localStorage.setItem(k,JSON.stringify(v))}}}};
    window.observations=0;const originalObserve=MutationObserver.prototype.observe;MutationObserver.prototype.observe=function(...args){window.observations++;return originalObserve.apply(this,args)};
    document.addEventListener('DOMContentLoaded',()=>{${source}\n});`});
  const load=async()=>{await cdp('Page.navigate',{url:'http://127.0.0.1:19362/shell'});await delay(2200);};
  const child=async(name='ifrArvoreHtml')=>{const tree=(await cdp('Page.getFrameTree')).frameTree;const frame=tree.childFrames.find(f=>name==='ifrArvoreHtml'?new URL(f.frame.url).pathname==='/controlador.php':new URL(f.frame.url).pathname===name);return contexts.get(frame.frame.id);};
  const snap=ctx=>evaluate(`[...document.querySelectorAll('.microleitura-chunk')].map(c=>({id:c.dataset.microleituraId,text:c.textContent,mark:c.getAttribute('data-microleitura-mark')}))`,ctx);
  await load();let ctx=await child();
  assert.equal(await evaluate("document.querySelectorAll('.microleitura-chunk,.microleitura-progress').length"),0);
  assert.equal(await evaluate('observations'),0);
  assert.ok((await snap(ctx)).length>=8);
  assert.equal(await evaluate("document.querySelectorAll('.microleitura-progress').length",ctx),1);
  assert.equal(await evaluate("document.querySelectorAll('td .microleitura-chunk').length",ctx),2);
  assert.equal(await evaluate("document.querySelector('strong').textContent+'|'+document.querySelector('em').textContent+'|'+document.querySelector('.assinatura').textContent",ctx),'texto em negrito|texto em itálico|Assinatura eletrônica de teste preservada.');
  await evaluate("document.querySelector('#link').click()",ctx);await delay(100);
  assert.equal(await evaluate('location.hash',ctx),'#destino');
  assert.equal(await evaluate("document.querySelectorAll('.microleitura-palette').length",ctx),0);
  for(const [i,mark]of ['gray','green','yellow','red'].entries())await evaluate(`document.querySelectorAll('.microleitura-chunk')[${i}].click();document.querySelector('[data-mark="${mark}"]').click()`,ctx);
  const before=await snap(ctx);assert.deepEqual(before.slice(0,4).map(c=>c.mark),['gray','green','yellow','red']);
  await evaluate("Element.prototype.scrollIntoView=function(){window.scrolled=this.dataset.microleituraId};document.querySelector('.microleitura-continue').click()",ctx);
  assert.equal(await evaluate('scrolled',ctx),before[4].id);
  for(const index of [2,3]){await evaluate("document.querySelector('.microleitura-review').click()",ctx);assert.equal(await evaluate('scrolled',ctx),before[index].id);}
  assert.equal(await evaluate("document.querySelector('#campo').value",ctx),'Texto editável intacto');
  assert.equal(await evaluate("document.querySelector('#campo').querySelectorAll('.microleitura-chunk').length",ctx),0);
  const keys=await evaluate('Object.keys(localStorage)',ctx);assert.ok(keys.length);assert.ok(keys.every(k=>!k.includes('token')&&!k.includes('AAA')));
  await evaluate('location.reload()',ctx);await delay(2000);ctx=await child();assert.deepEqual(await snap(ctx),before);
  await load();ctx=await child();assert.deepEqual(await snap(ctx),before);
  await evaluate("location.search='?acao=documento_visualizar&id=2&token=BBB'",ctx);await delay(2000);ctx=await child();assert.ok((await snap(ctx)).every(c=>c.mark===null));
  await evaluate('history.back()',ctx);await delay(2000);ctx=await child();assert.deepEqual(await snap(ctx),before);
  await evaluate("history.replaceState({},'', '?acao=documento_visualizar&id=1&token=NEW')",ctx);await delay(1500);assert.deepEqual(await snap(ctx),before);
  await evaluate("history.pushState({},'', '?acao=documento_visualizar&id=2');document.querySelector('.sei-documento').innerHTML='<p>Documento B com outro conteúdo suficiente para leitura independente.</p>'",ctx);await delay(1800);assert.ok((await snap(ctx)).every(c=>c.mark===null));
  // Restore clean HTML rather than retained Microleitura wrappers from another context.
  await evaluate(`history.back();document.querySelector('.sei-documento').innerHTML=${JSON.stringify(fixture('documento.html').match(/<body>([\s\S]*)<\/body>/)[1].replace('Este é um documento','Este é o documento 1'))}`,ctx);await delay(1800);assert.deepEqual(await snap(ctx),before);
  // Same DOM, query-only navigation in generic frames: IDs repeat but states must not leak.
  await evaluate("location.href='http://localhost:19362/controlador.php?id=1'",ctx);await delay(2000);
  // localhost may be out-of-process, so run generic query tests in the main frame instead.
  await cdp('Page.navigate',{url:'http://localhost:19362/controlador.php?id=1'});await delay(2000);
  await evaluate("document.querySelector('.microleitura-chunk').click();document.querySelector('[data-mark=green]').click()");
  await evaluate("history.pushState({},'', '?id=2')");await delay(1800);assert.ok((await snap()).every(c=>c.mark===null));
  await evaluate('history.back()');await delay(1800);assert.equal((await snap())[0].mark,'green');
  await load();ctx=await child();
  const oldCount=(await snap(ctx)).length;
  await evaluate("document.querySelector('.sei-documento').insertAdjacentHTML('beforeend','<p>Trecho adicional para testar mutações externas no documento.</p>')",ctx);await delay(1700);
  assert.equal((await snap(ctx)).length,oldCount+1);assert.equal(await evaluate("document.querySelectorAll('.microleitura-progress').length",ctx),1);
  const observations=await evaluate('observations',ctx);await delay(1400);assert.equal(await evaluate('observations',ctx),observations);
  const editor=await child('/editor');
  assert.equal(await evaluate("document.querySelectorAll('.microleitura-chunk,.microleitura-progress').length",editor),0);
  assert.equal(await evaluate('observations',editor),0);
  await evaluate("const text=document.querySelector('p').firstChild;const range=document.createRange();range.setStart(text,7);range.collapse(true);getSelection().removeAllRanges();getSelection().addRange(range)",editor);
  const editorBefore=await evaluate('document.body.innerHTML',editor);await delay(1000);assert.equal(await evaluate('document.body.innerHTML',editor),editorBefore);assert.equal(await evaluate('getSelection().anchorOffset',editor),7);
  await evaluate("location.href='/design?acao=documento_visualizar'",editor);await delay(1600);const design=await child('/design');assert.equal(await evaluate('document.designMode',design),'on');assert.equal(await evaluate("document.querySelectorAll('.microleitura-chunk,.microleitura-progress').length",design),0);assert.equal(await evaluate('observations',design),0);
  await evaluate("location.href='http://127.0.0.1:19363/controlador.php?acao=documento_visualizar&id=3'",ctx);await delay(2000);ctx=await child();assert.equal(await evaluate('window.frameElement===null',ctx),true);assert.ok((await snap(ctx)).length>=8);assert.equal(await evaluate("document.querySelectorAll('.microleitura-progress').length",ctx),1);
  const shortCount=(await snap(ctx)).length;
  await evaluate("document.querySelector('.sei-documento').insertAdjacentHTML('beforeend',Array.from({length:100},(_,i)=>'<p>Parágrafo longo número '+i+' com conteúdo textual adicional para verificar segmentação e progresso do documento extenso.</p>').join(''))",ctx);await delay(2400);
  assert.equal((await snap(ctx)).length,shortCount+100);assert.equal(await evaluate("document.querySelectorAll('.microleitura-progress').length",ctx),1);
  await evaluate("const old=document.querySelector('#ifrArvoreHtml');const replacement=document.createElement('iframe');replacement.id=old.id;replacement.src='/controlador.php?acao=documento_visualizar&id=1&token=REOPEN';old.replaceWith(replacement)");await delay(2200);ctx=await child();assert.deepEqual(await snap(ctx),before);
  console.log('PASS real iframe DOM: SEI shell excluded; HTML, inline, links, tables, four states, frame/top reload, token change, A/B/back, generic query-only navigation, mutation, one bar, no observer loop, editor/caret, designMode, cross-origin independent execution. CDP injection; no authenticated SEI test.');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>{ws?.close();browser?.kill();for(const server of servers)server.close();});
