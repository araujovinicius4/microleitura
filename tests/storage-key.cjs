const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync('content.js', 'utf8');
(async () => {
  const saved = {'microleitura:v4:https://chatgpt.com/c/example?temporary=1': {old: 'green'}};
  const context = vm.createContext({location: new URL('https://chatgpt.com/c/example?temporary=2#fragment'), chrome: {storage: {local: {
    get: async key => key === null ? structuredClone(saved) : {[key]: saved[key]},
    set: async value => Object.assign(saved, value)
  }}}});
  vm.runInContext("const STORAGE_PREFIX='microleitura:v4:'; const LEGACY_STORAGE_PREFIX='microleitura:v2:'; const frameContext={sei:false}; const stateKeys=new WeakMap();" + source.slice(source.indexOf('  function conversationKey'), source.indexOf('  function getFrameContext')) + source.slice(source.indexOf('  async function loadMarkState'), source.indexOf('  function applyMark')) + source.slice(source.indexOf('  function isChatGPT'), source.indexOf('  function getChatGPTRoots')), context);
  const before = vm.runInContext('conversationKey()', context);
  assert.equal(before, 'microleitura:v4:https://chatgpt.com/c/example');
  assert.equal((await vm.runInContext('loadMarkState()', context)).get('old'), 'green');
  context.location = new URL('https://chatgpt.com/c/example');
  assert.equal(vm.runInContext('conversationKey()', context), before);
  context.location = new URL('https://example.org/article?id=2');
  assert.equal(vm.runInContext('conversationKey()', context), 'microleitura:v4:https://example.org/article?id=2');
  assert.ok(saved['microleitura:v4:https://chatgpt.com/c/example?temporary=1']);
  console.log('PASS canonical ChatGPT storageKey before/after:', before, '; old query aliases preserved; HTML query retained');
})().catch(error => {console.error(error); process.exitCode=1;});
