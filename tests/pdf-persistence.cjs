const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const delay = ms => new Promise(r => setTimeout(r, ms));
const baseline = process.argv.includes('--baseline');
const chrome = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const profile = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'microleitura-test-'));
const browser = spawn(chrome, ['--headless=new', '--no-first-run', '--remote-debugging-port=19361', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
(async () => {
  let tabs;
  for (let i = 0; i < 80; i++) {
    try { tabs = await (await fetch('http://localhost:19361/json')).json(); if (tabs.some(t => t.type === 'page')) break; } catch {} await delay(100);
  }
  const ws = new WebSocket(tabs.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r, { once: true }));
  let id = 0; const pending = new Map();
  ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id) { pending.get(m.id)?.(m); pending.delete(m.id); } });
  const cdp = (method, params = {}) => new Promise((resolve, reject) => { const n = ++id; pending.set(n, m => m.error ? reject(m.error) : resolve(m.result)); ws.send(JSON.stringify({ id: n, method, params })); });
  const evaluate = async expression => { const r = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails)); return r.result.value; };
  await cdp('Page.enable');
  await cdp('Page.navigate', { url: 'about:blank' });

  const http = require('node:http');
  const lines=['First readable PDF passage.','Second readable PDF passage.','Third readable PDF passage.','Fourth readable PDF passage.','Fifth unread PDF passage.'];
  const stream='BT /F1 16 Tf '+lines.map((t,i)=>(i?'0 -65 Td':'50 740 Td')+' ('+t+') Tj').join(' ')+' ET';
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>','<< /Length '+stream.length+' >>\nstream\n'+stream+'\nendstream'];
  let pdf='%PDF-1.4\n';const offsets=[0];objects.forEach((o,i)=>{offsets.push(pdf.length);pdf+=(i+1)+' 0 obj\n'+o+'\nendobj\n'});const xref=pdf.length;pdf+='xref\n0 6\n0000000000 65535 f \n'+offsets.slice(1).map(o=>String(o).padStart(10,'0')+' 00000 n \n').join('')+'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n'+xref+'\n%%EOF';
  const server=http.createServer((req,res)=>{const name=new URL(req.url,'http://localhost').pathname;if(name==='/fixture.pdf'){res.setHeader('Content-Type','application/pdf');res.end(pdf);return;}const file=path.resolve('.','.'+name);if(!file.startsWith(path.resolve('.')+path.sep)){res.writeHead(403).end();return;}try{res.setHeader('Content-Type',name.endsWith('.mjs')||name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(file));}catch{res.writeHead(404).end();}});
  await new Promise(r=>server.listen(19360,'127.0.0.1',r));
  try {
    await cdp('Page.addScriptToEvaluateOnNewDocument',{source:'window.chrome={runtime:{getURL:p=>location.origin+"/"+p},storage:{local:{get:async k=>({[k]:JSON.parse(localStorage.getItem(k)||"{}")}),set:async obj=>{for(const [k,v] of Object.entries(obj))localStorage.setItem(k,JSON.stringify(v))}}}};'});
    const url='http://127.0.0.1:19360/pdf/viewer.html?url=http://127.0.0.1:19360/fixture.pdf';
    const load=async()=>{await cdp('Page.navigate',{url});for(let i=0;i<100;i++){await delay(100);if(await evaluate('document.querySelectorAll(".ml-pdf-segment").length>=5'))return;}throw Error(await evaluate('document.body.innerText'));};
    await load();
    for(const [i,mark] of ['gray','green','yellow','red'].entries()) await evaluate('document.querySelectorAll(".ml-pdf-segment")['+i+'].click();document.querySelector(`[data-mark="'+mark+'"]`).click()');
    const snapshot=()=>evaluate('[...document.querySelectorAll(".ml-pdf-segment")].map(s=>({id:s.dataset.mlSegmentId,mark:s.dataset.mark||null}))');
    const before=await snapshot();assert.deepEqual(before.slice(0,4).map(s=>s.mark),['gray','green','yellow','red']);
    await load();assert.deepEqual(await snapshot(),before);
    assert.equal(await evaluate('Boolean(document.querySelector(".annotationLayer")&&document.querySelector(".textLayer"))'),true);
    console.log('PASS actual PDF.js viewer: four colors and IDs restored after navigation; annotation/text layers present',JSON.stringify(before));
  } finally {server.close();}
  ws.close();
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => { browser.kill(); });
