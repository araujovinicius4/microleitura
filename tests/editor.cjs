const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const delay = ms => new Promise(r => setTimeout(r, ms));
const baseline = process.argv.includes('--baseline');
const chrome = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const profile = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'microleitura-test-'));
const browser = spawn(chrome, ['--headless=new', '--no-first-run', '--remote-debugging-port=19358', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
(async () => {
  let tabs;
  for (let i = 0; i < 80; i++) {
    try { tabs = await (await fetch('http://localhost:19358/json')).json(); if (tabs.some(t => t.type === 'page')) break; } catch {} await delay(100);
  }
  const ws = new WebSocket(tabs.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r, { once: true }));
  let id = 0; const pending = new Map();
  ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id) { pending.get(m.id)?.(m); pending.delete(m.id); } });
  const cdp = (method, params = {}) => new Promise((resolve, reject) => { const n = ++id; pending.set(n, m => m.error ? reject(m.error) : resolve(m.result)); ws.send(JSON.stringify({ id: n, method, params })); });
  const evaluate = async expression => { const r = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails)); return r.result.value; };
  await cdp('Page.enable');
  await cdp('Page.navigate', { url: 'about:blank' });
  let source = fs.readFileSync(baseline ? 'dist/microleitura-v0.5.7/content.js' : 'content.js', 'utf8');
  source = source.replace('async function processPage() {', 'async function processPage() { window.stats.process++;')
    .replace('function scheduleProcess() {', 'function scheduleProcess() { window.stats.scheduled++;')
    .replace('function repairUncoveredText(block, root, markMap, fingerprint) {', 'function repairUncoveredText(block, root, markMap, fingerprint) { window.stats.repair++;')
    .replace("return location.hostname === 'chatgpt.com' || location.hostname === 'chat.openai.com';", 'return window.chatFixture;');
  const setup = async (html, chat = true) => {
    await cdp('Page.navigate', { url: 'about:blank' }); await delay(100);
    await evaluate(`document.body.innerHTML = ${JSON.stringify(html)}; window.chatFixture=${chat}; window.stats={process:0,scheduled:0,repair:0,extract:0,mutations:[]}; window.chrome={storage:{local:{get:async()=>({}),set:async()=>{}}}};
      const original=Range.prototype.extractContents; Range.prototype.extractContents=function(){if(this.startContainer.parentElement?.closest('[contenteditable], [role="textbox"], [role="searchbox"]')) stats.extract++; return original.call(this)};
      new MutationObserver(ms=>stats.mutations.push(...ms.filter(m=>m.target.parentElement?.closest('#prompt')||m.target.id==='prompt').map(m=>m.type))).observe(document.body,{subtree:true,childList:true,characterData:true});`);
    await evaluate(source); await delay(1600);
  };
  const caret = async (a, b = a) => evaluate(`{const p=document.querySelector('#prompt'); p.focus(); const w=document.createTreeWalker(p,NodeFilter.SHOW_TEXT); let n=w.nextNode(); const r=document.createRange();r.setStart(n,${a});r.setEnd(n,${b});getSelection().removeAllRanges();getSelection().addRange(r);}`);
  const state = () => evaluate(`(()=>{const p=document.querySelector('#prompt'),s=getSelection(),r=document.createRange();r.selectNodeContents(p);r.setEnd(s.anchorNode,s.anchorOffset);return {text:p.textContent,caret:r.toString().length,html:p.innerHTML,stats:structuredClone(stats)}})()`);
  const type = async text => { await cdp('Input.insertText', { text }); await delay(800); };
  const key = async (key, code, modifiers = 0) => { await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: code, modifiers }); await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: code, modifiers }); await delay(800); };
  const answer = '<div data-message-author-role="assistant"><p id="answer">Texto comum suficientemente longo. <strong>Negrito preservado.</strong> <em>Italico preservado.</em> <span>Span preservado.</span> Antes <a href="#destino">link</a> depois do link.</p></div>';
  // A processed reading block reused by an editor reproduces the new repair path.
  await setup(answer + '<div data-message-author-role="user"><div id="prompt" contenteditable="true" role="textbox" data-microleitura-processed="true">Texto sendo digitado</div></div>');
  await evaluate(`document.querySelector('#prompt').textContent='abcdefghij'`);
  await caret(5); await type('XYZ');
  const reproduction = await state(); console.log('processed-editor', JSON.stringify(reproduction));
  if (baseline) { assert.ok(reproduction.stats.extract > 0); assert.notEqual(reproduction.caret, 8); ws.close(); return; }
  assert.equal(reproduction.text, 'abcdeXYZfghij'); assert.equal(reproduction.caret, 8); assert.equal(reproduction.stats.extract, 0);
  for (const attrs of ['contenteditable="true" role="textbox"', 'contenteditable=""', 'contenteditable="plaintext-only"', 'role="textbox" contenteditable="true"', 'role="searchbox" contenteditable="true"']) {
    await setup(answer + `<div data-message-author-role="user"><div id="prompt" ${attrs}>abcdefghij</div></div>`);
    await caret(5); const initial = (await state()).stats;
    await type('XYZ'); assert.equal((await state()).caret, 8); assert.equal((await state()).text, 'abcdeXYZfghij');
    await type('123'); await type('456'); assert.equal((await state()).text, 'abcdeXYZ123456fghij'); assert.equal((await state()).caret, 14);
    await key('Backspace', 8); await key('Delete', 46); assert.equal((await state()).text, 'abcdeXYZ12345ghij');
    await key('ArrowLeft', 37); assert.equal((await state()).caret, 12); await key('ArrowRight', 39); assert.equal((await state()).caret, 13);
    await caret(5, 8); await type('Q'); assert.equal((await state()).text, 'abcdeQ12345ghij'); assert.equal((await state()).caret, 6);
    await key('Enter', 13, 8); await type('nova'); await key('Enter', 13);
    const end = await state(); assert.equal(end.stats.scheduled, initial.scheduled); assert.equal(end.stats.process, initial.process); assert.equal(end.stats.extract, 0); assert.ok(!end.html.includes('microleitura'));
    // Streaming and rerender continue while the caret remains in the editor.
    const before = end.text;
    await evaluate(`document.querySelector('#answer').append(document.createTextNode(' Novo texto de streaming.'));`); await delay(1600);
    assert.equal((await state()).text, before);
    assert.equal(await evaluate(`document.querySelector('#answer').lastElementChild.classList.contains('microleitura-chunk')`), true);
    const processed = (await state()).stats.process;
    await evaluate(`document.querySelector('#answer .microleitura-chunk').firstChild.appendData(' Atualizacao characterData.');`); await delay(1600);
    assert.ok((await state()).stats.process > processed);
    await evaluate(`document.querySelector('#answer').innerHTML='Resposta refeita com <strong>negrito</strong> e <em>italico</em>, <span>span</span> antes <a href="#destino">link</a> depois.'`); await delay(1600);
    assert.equal(await evaluate(`(()=>{const w=document.createTreeWalker(document.querySelector('#answer'),NodeFilter.SHOW_TEXT);let n;while(n=w.nextNode())if(n.textContent.trim()&&!n.parentElement.closest('.microleitura-chunk'))return false;return true})()`), true);
    assert.equal(await evaluate(`(()=>{const a=document.querySelector('#answer a');const e=new MouseEvent('click',{bubbles:true,cancelable:true});a.dispatchEvent(e);return !e.defaultPrevented&&!document.querySelector('.microleitura-palette')})()`), true);
    console.log('PASS editing, observer, streaming, coverage, link:', attrs);
  }
  await setup(`<article><p>${'Conteudo comum de leitura. '.repeat(15)}<span contenteditable="true" id="prompt">abcdefghij</span> Texto final.</p><p><a href="#destino">Link HTML comum</a> Texto depois do link.</p></article>`, false);
  await caret(5); await type('XYZ'); assert.equal((await state()).caret, 8); assert.equal((await state()).stats.extract, 0);
  assert.equal(await evaluate(`document.querySelector('#prompt').closest('.microleitura-chunk')===null`), true);
  console.log('PASS HTML mixed reading/editor block');
  assert.equal(await evaluate(`(()=>{const a=document.querySelector('article a');const e=new MouseEvent('click',{bubbles:true,cancelable:true});a.dispatchEvent(e);return !e.defaultPrevented&&!document.querySelector('.microleitura-palette')})()`), true);
  for (const editor of ['<div role="textbox"><p>Texto editavel protegido.</p></div>', '<div role="searchbox"><p>Texto editavel protegido.</p></div>', '<div contenteditable="true"><p contenteditable="false">Ilha protegida dentro do editor.</p></div>', '<textarea>Texto editavel protegido.</textarea><input value="texto"><select><option>Opcao protegida</option></select>']) {
    await setup(answer + `<div data-message-author-role="user" id="protected">${editor}</div>`);
    assert.equal(await evaluate(`document.querySelector('#protected').innerHTML`), editor);
  }
  await setup('<div data-message-author-role="user" contenteditable="true" id="prompt"><p>Editor raiz com texto suficiente.</p></div>');
  assert.equal(await evaluate(`document.querySelector('#prompt').innerHTML`), '<p>Editor raiz com texto suficiente.</p>');
  console.log('PASS role-only editors, controls, inherited editing and editable root');
  ws.close();
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => { browser.kill(); });
