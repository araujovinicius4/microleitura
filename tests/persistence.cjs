const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const delay = ms => new Promise(r => setTimeout(r, ms));
const baseline = process.argv.includes('--baseline');
const chrome = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const profile = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'microleitura-test-'));
const browser = spawn(chrome, ['--headless=new', '--no-first-run', '--remote-debugging-port=19359', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
(async () => {
  let tabs;
  for (let i = 0; i < 80; i++) {
    try { tabs = await (await fetch('http://localhost:19359/json')).json(); if (tabs.some(t => t.type === 'page')) break; } catch {} await delay(100);
  }
  const ws = new WebSocket(tabs.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r, { once: true }));
  let id = 0; const pending = new Map();
  ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id) { pending.get(m.id)?.(m); pending.delete(m.id); } });
  const cdp = (method, params = {}) => new Promise((resolve, reject) => { const n = ++id; pending.set(n, m => m.error ? reject(m.error) : resolve(m.result)); ws.send(JSON.stringify({ id: n, method, params })); });
  const evaluate = async expression => { const r = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails)); return r.result.value; };
  await cdp('Page.enable');
  await cdp('Page.navigate', { url: 'about:blank' });
  const baseline = process.argv.includes('--baseline');
  let source = fs.readFileSync(baseline ? 'dist/microleitura-v0.5.8/content.js' : 'content.js','utf8')
    .replace("return location.hostname === 'chatgpt.com' || location.hostname === 'chat.openai.com';", 'return window.chatFixture;');
  let storage = {};
  const first = 'Primeiro trecho suficientemente longo para leitura.';
  const rest = ['Segundo trecho com detalhes adicionais.', 'Terceiro trecho para revisar depois.', 'Quarto trecho importante para lembrar.', 'Quinto trecho ainda sem qualquer marca.'];
  const html = (chat, streamed=false) => (chat ? '<div data-message-author-role="assistant" id="root">' : '<article id="root">') + [first,...(streamed?[]:rest)].map(t=>'<p>'+t+'</p>').join('') + (chat?'</div>':'</article>');
  const setup = async (chat, streamed=false) => {
    await cdp('Page.navigate',{url:'about:blank'}); await delay(100);
    await evaluate('document.body.innerHTML='+JSON.stringify(html(chat,streamed))+';window.chatFixture='+chat+';window.saved='+JSON.stringify(storage)+';window.chrome={storage:{local:{get:async k=>k===null?saved:({[k]:saved[k]}),set:async obj=>Object.assign(saved,obj)}}};');
    await evaluate(source); await delay(1500);
  };
  const snapshot = () => evaluate(`[...document.querySelectorAll('.microleitura-chunk')].map(c=>({chunkId:c.dataset.microleituraId,text:c.textContent,mark:c.getAttribute('data-microleitura-mark'),read:c.classList.contains('microleitura-read')}))`);
  for (const chat of [true,false]) {
    await setup(chat,chat);
    if(chat){await evaluate('document.querySelector("#root").insertAdjacentHTML("beforeend",'+JSON.stringify(rest.map(t=>'<p>'+t+'</p>').join(''))+')');await delay(1600);}
    for(const [i,mark] of ['gray','green','yellow','red'].entries()){
      await evaluate(`document.querySelectorAll('.microleitura-chunk')[${i}].click();document.querySelector('[data-mark="${mark}"]').click();`);
    }
    storage=await evaluate('saved');
    const before=await snapshot(); console.log('[Microleitura persistence BEFORE]',JSON.stringify({storageKey:Object.keys(storage)[0],chunks:before}));
    await setup(chat);
    const after=await snapshot();console.log('[Microleitura persistence AFTER]',JSON.stringify({storageKey:Object.keys(storage)[0],chunks:after,storagePreserved:JSON.stringify(storage)===JSON.stringify(await evaluate('saved'))}));
    if(baseline){assert.notDeepEqual(after,before);break;}
    assert.deepEqual(after,before);
    assert.equal(await evaluate('document.querySelector(".microleitura-progress-count").textContent'),'4/5 \u00b7 80%');
    assert.equal(await evaluate('document.querySelector(".microleitura-review").textContent'),'Revisar (2)');
    await evaluate('Element.prototype.scrollIntoView=function(){window.scrolled=this.dataset.microleituraId};document.querySelector(".microleitura-continue").click()');
    assert.equal(await evaluate('scrolled'),after[4].chunkId);
    for(const i of [2,3]) { await evaluate('document.querySelector(".microleitura-review").click()');assert.equal(await evaluate('scrolled'),after[i].chunkId); }
    await setup(chat);assert.deepEqual(await snapshot(),before);
    console.log('PASS',chat?'ChatGPT fixture streaming/reload/reopen':'HTML reload/reopen','four colors, IDs, progress, continue, review');
    storage={};
  }
  if (!baseline) {
    await setup(true, true);
    await evaluate('document.querySelector("#root p").append(document.createTextNode(" Uma segunda frase termina aqui. Uma terceira frase termina aqui."))'); await delay(1600);
    const streamed = await snapshot();
    await evaluate('document.querySelector("#root p").innerHTML="Primeiro trecho suficientemente longo para leitura. Uma <strong>segunda frase</strong> termina aqui. Uma terceira frase termina aqui."'); await delay(1600);
    assert.deepEqual(await snapshot(), streamed);
    await evaluate('document.querySelector("#root").insertAdjacentHTML("beforeend", "<p>Frase repetida suficientemente longa.</p><p>Frase repetida suficientemente longa.</p>")'); await delay(1600);
    const duplicates = (await snapshot()).filter(c=>c.text.startsWith('Frase repetida'));
    assert.equal(duplicates.length,2); assert.notEqual(duplicates[0].chunkId,duplicates[1].chunkId);
    await evaluate('const chunks=[...document.querySelectorAll(".microleitura-chunk")]; chunks.find(c=>c.textContent.startsWith("Frase repetida")).click();document.querySelector(`[data-mark="green"]`).click()');
    await delay(800);
    assert.deepEqual((await snapshot()).filter(c=>c.text.startsWith('Frase repetida')).map(c=>c.mark),['green',null]);
    console.log('PASS streaming within block, inline rerender, repeated text independence');
  }
  ws.close();
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => { browser.kill(); });
