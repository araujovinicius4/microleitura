import * as pdfjsLib from './lib/pdf.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('pdf/lib/pdf.worker.mjs');

const MARKS = [
  ['gray', 'Lido'],
  ['green', 'Entendido'],
  ['yellow', 'Revisar'],
  ['red', 'Importante/Dúvida']
];
const sourceUrl = new URLSearchParams(location.search).get('file');
const viewer = document.querySelector('#viewer');
const progress = document.querySelector('#progress');
const continueButton = document.querySelector('#continue');
const reviewButton = document.querySelector('#review');
const errorBox = document.querySelector('#error');
let chunks = [];
let marks = new Map();
let storageKey = '';
let reviewIndex = -1;
let palette = null;

const normalize = (value) => (value || '').replace(/\s+/g, ' ').trim();
function hashString(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function normalizedDocumentUrl(value) {
  const url = new URL(value);
  url.hash = '';
  for (const key of [...url.searchParams.keys()].sort()) {
    if (/^(utm_|fbclid|gclid)/i.test(key)) url.searchParams.delete(key);
  }
  return url.toString();
}

function showError(error) {
  console.error('Microleitura: falha ao carregar/renderizar PDF', {
    sourceUrl,
    name: error?.name,
    message: error?.message,
    status: error?.status,
    error
  });
  viewer.hidden = true;
  errorBox.hidden = false;
  const localHelp = sourceUrl?.startsWith('file:')
    ? '\n\nPara abrir arquivos locais: acesse chrome://extensions → Microleitura → Detalhes e ative “Permitir acesso a URLs de arquivo”. Depois tente novamente.'
    : '';
  const status = error?.status || error?.response?.status;
  const networkMessage = /cors|fetch|network|failed to load/i.test(`${error?.name || ''} ${error?.message || ''}`)
    ? '\nPossível falha de rede, CORS ou permissão de acesso ao endereço. A requisição foi iniciada no contexto da extensão.'
    : '';
  errorBox.textContent = [
    'Não foi possível abrir este PDF.',
    `URL tentada: ${sourceUrl || '(ausente)'}`,
    `Tipo do erro: ${error?.name || error?.constructor?.name || 'Erro desconhecido'}`,
    `Mensagem: ${error?.message || 'Verifique se o endereço ainda está disponível.'}`,
    status ? `Status HTTP: ${status}` : '',
    networkMessage,
    localHelp
  ].filter(Boolean).join('\n');
  progress.textContent = 'Erro ao abrir';
}

function groupItems(items) {
  const positioned = items.map((item, index) => ({
    item, index,
    x: item.transform[4],
    y: item.transform[5],
    height: Math.max(Math.abs(item.height || 0), Math.abs(item.transform[3] || 0), 1)
  })).filter(({ item }) => normalize(item.str));

  const lines = [];
  for (const entry of positioned) {
    let line = lines.find((candidate) => Math.abs(candidate.y - entry.y) <= Math.max(2, entry.height * .35));
    if (!line) {
      line = { y: entry.y, height: entry.height, items: [] };
      lines.push(line);
    }
    line.items.push(entry);
  }
  lines.sort((a, b) => b.y - a.y);
  lines.forEach((line) => line.items.sort((a, b) => a.x - b.x));

  const blocks = [];
  let block = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const previous = lines[i - 1];
    const gap = previous ? previous.y - line.y : 0;
    const previousText = previous ? normalize(previous.items.map(({ item }) => item.str).join(' ')) : '';
    const paragraphBreak = previous && (gap > Math.max(previous.height, line.height) * 1.75 ||
      (/[.!?…:]$/.test(previousText) && gap > Math.max(previous.height, line.height) * 1.15));
    if (paragraphBreak && block.length) {
      blocks.push(block);
      block = [];
    }
    block.push(line);
  }
  if (block.length) blocks.push(block);

  const groups = [];
  for (const paragraph of blocks) {
    let current = [];
    let sentenceCount = 0;
    let charCount = 0;
    for (const line of paragraph) {
      const text = normalize(line.items.map(({ item }) => item.str).join(' '));
      current.push(...line.items);
      charCount += text.length;
      sentenceCount += (text.match(/[.!?…]+(?:\s|$)/g) || []).length;
      if ((sentenceCount >= 1 && charCount >= 90) || sentenceCount >= 3 || charCount >= 360) {
        groups.push(current);
        current = [];
        sentenceCount = 0;
        charCount = 0;
      }
    }
    if (current.length) groups.push(current);
  }
  return groups;
}

function addChunkOverlays(pageElement, textDivs, itemGroup, chunk) {
  const pageRect = pageElement.getBoundingClientRect();
  for (const { index } of itemGroup) {
    const textDiv = textDivs[index];
    if (!textDiv) continue;
    textDiv.dataset.microleituraChunk = chunk.id;
    textDiv.title = 'Clique para escolher uma marcação';
    const rect = textDiv.getBoundingClientRect();
    if (!rect.width || !rect.height) continue;
    const overlay = document.createElement('span');
    overlay.className = 'micro-chunk';
    overlay.dataset.chunkId = chunk.id;
    overlay.style.left = `${rect.left - pageRect.left}px`;
    overlay.style.top = `${rect.top - pageRect.top}px`;
    overlay.style.width = `${rect.width}px`;
    overlay.style.height = `${rect.height}px`;
    pageElement.appendChild(overlay);
    chunk.overlays.push(overlay);
  }
}

function applyMark(chunk, mark) {
  chunk.mark = mark || null;
  for (const overlay of chunk.overlays) {
    if (mark) overlay.dataset.mark = mark;
    else overlay.removeAttribute('data-mark');
  }
}

async function saveMarks() {
  await chrome.storage.local.set({ [storageKey]: Object.fromEntries(marks) });
}

function updateProgress() {
  const marked = chunks.filter((chunk) => chunk.mark).length;
  const review = chunks.filter((chunk) => chunk.mark === 'yellow' || chunk.mark === 'red');
  const percent = chunks.length ? Math.round(marked / chunks.length * 100) : 0;
  progress.textContent = `${percent}% lido · ${marked}/${chunks.length}`;
  reviewButton.textContent = `Revisar (${review.length})`;
  reviewButton.disabled = review.length === 0;
  continueButton.disabled = marked === chunks.length || chunks.length === 0;
  chunks.forEach((chunk) => chunk.overlays.forEach((overlay) => overlay.classList.remove('current')));
  const next = chunks.find((chunk) => !chunk.mark);
  next?.overlays.forEach((overlay) => overlay.classList.add('current'));
}

function focusChunk(chunk) {
  const target = chunk?.overlays[0];
  if (!target) return;
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  chunk.overlays.forEach((overlay) => overlay.classList.add('focus'));
  setTimeout(() => chunk.overlays.forEach((overlay) => overlay.classList.remove('focus')), 1100);
}

function nextUnreadChunk() {
  let lastMarked = -1;
  chunks.forEach((chunk, index) => {
    if (chunk.mark) lastMarked = index;
  });
  return chunks.slice(lastMarked + 1).find((chunk) => !chunk.mark) ||
    chunks.find((chunk) => !chunk.mark);
}

function closePalette() {
  palette?.remove();
  palette = null;
}

function showPalette(chunk, anchor) {
  closePalette();
  palette = document.createElement('div');
  palette.className = 'palette';
  palette.setAttribute('role', 'menu');
  palette.setAttribute('aria-label', 'Marcar microtrecho');
  for (const [mark, label] of MARKS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.mark = mark;
    button.innerHTML = '<span class="dot" aria-hidden="true"></span>';
    button.append(document.createTextNode(label));
    if (chunk.mark === mark) button.classList.add('active');
    button.addEventListener('click', async () => {
      marks.set(chunk.id, mark);
      applyMark(chunk, mark);
      closePalette();
      updateProgress();
      await saveMarks();
    });
    palette.appendChild(button);
  }
  const clear = document.createElement('button');
  clear.type = 'button';
  clear.textContent = '× Limpar';
  clear.title = 'Limpar marcação';
  clear.addEventListener('click', async () => {
    marks.delete(chunk.id);
    applyMark(chunk, null);
    closePalette();
    updateProgress();
    await saveMarks();
  });
  palette.appendChild(clear);
  document.body.appendChild(palette);
  const rect = anchor.getBoundingClientRect();
  const paletteRect = palette.getBoundingClientRect();
  palette.style.left = `${Math.max(8, Math.min(innerWidth - paletteRect.width - 8, rect.left))}px`;
  palette.style.top = `${rect.bottom + paletteRect.height + 8 < innerHeight ? rect.bottom + 6 : Math.max(8, rect.top - paletteRect.height - 6)}px`;
}

async function renderPage(pdf, pageNumber, documentId) {
  const page = await pdf.getPage(pageNumber);
  const naturalViewport = page.getViewport({ scale: 1 });
  const scale = Math.min(1.55, Math.max(.75, (Math.min(innerWidth - 24, 1100)) / naturalViewport.width));
  const viewport = page.getViewport({ scale });
  const pageElement = document.createElement('section');
  pageElement.className = 'page';
  pageElement.dataset.pageNumber = pageNumber;
  pageElement.style.width = `${viewport.width}px`;
  pageElement.style.height = `${viewport.height}px`;
  pageElement.style.setProperty('--scale-factor', scale);
  const canvas = document.createElement('canvas');
  const outputScale = Math.min(devicePixelRatio || 1, 2);
  canvas.width = Math.floor(viewport.width * outputScale);
  canvas.height = Math.floor(viewport.height * outputScale);
  canvas.style.width = `${viewport.width}px`;
  canvas.style.height = `${viewport.height}px`;
  pageElement.appendChild(canvas);
  const textLayerElement = document.createElement('div');
  textLayerElement.className = 'textLayer';
  pageElement.appendChild(textLayerElement);
  viewer.appendChild(pageElement);

  const textContent = await page.getTextContent();
  await page.render({ canvasContext: canvas.getContext('2d'), viewport, transform: outputScale === 1 ? null : [outputScale, 0, 0, outputScale, 0, 0] }).promise;
  const textLayer = new pdfjsLib.TextLayer({ textContentSource: textContent, container: textLayerElement, viewport });
  await textLayer.render();
  const textDivs = textLayer.textDivs || [...textLayerElement.querySelectorAll('span')];
  const occurrences = new Map();
  for (const itemGroup of groupItems(textContent.items)) {
    const text = normalize(itemGroup.map(({ item }) => item.str).join(' '));
    if (text.length < 2) continue;
    const normalizedText = text.toLocaleLowerCase('pt-BR');
    const occurrence = occurrences.get(normalizedText) || 0;
    occurrences.set(normalizedText, occurrence + 1);
    const id = hashString(`${documentId}|${pageNumber}|${normalizedText}|${occurrence}`);
    const chunk = { id, pageNumber, text, mark: marks.get(id) || null, overlays: [] };
    addChunkOverlays(pageElement, textDivs, itemGroup, chunk);
    if (chunk.overlays.length) {
      applyMark(chunk, chunk.mark);
      chunks.push(chunk);
    }
  }

  textLayerElement.addEventListener('click', (event) => {
    if (!window.getSelection()?.isCollapsed) return;
    const id = event.target.closest('[data-microleitura-chunk]')?.dataset.microleituraChunk;
    const chunk = chunks.find((candidate) => candidate.id === id);
    if (chunk) showPalette(chunk, event.target);
  });
}

continueButton.addEventListener('click', () => focusChunk(nextUnreadChunk()));
reviewButton.addEventListener('click', () => {
  const reviewChunks = chunks.filter((chunk) => chunk.mark === 'yellow' || chunk.mark === 'red');
  if (!reviewChunks.length) return;
  reviewIndex = (reviewIndex + 1) % reviewChunks.length;
  focusChunk(reviewChunks[reviewIndex]);
});
document.addEventListener('click', (event) => {
  if (palette && !event.target.closest('.palette') && !event.target.closest('[data-microleitura-chunk]')) closePalette();
});

async function start() {
  if (!sourceUrl || !/^(https?|file):/i.test(sourceUrl)) throw new Error('Endereço de PDF ausente ou inválido.');
  progress.textContent = 'Carregando PDF…';
  const loadingTask = pdfjsLib.getDocument({
    url: sourceUrl,
    cMapUrl: chrome.runtime.getURL('pdf/lib/cmaps/'),
    cMapPacked: true,
    standardFontDataUrl: chrome.runtime.getURL('pdf/lib/standard_fonts/'),
    wasmUrl: chrome.runtime.getURL('pdf/lib/wasm/')
  });
  let pdf;
  try {
    pdf = await loadingTask.promise;
  } catch (error) {
    console.error('Microleitura: pdfjsLib.getDocument falhou', sourceUrl, error);
    throw error;
  }
  const data = await pdf.getData();
  const fingerprint = pdf.fingerprints?.[0] || hashString(`${data.byteLength}|${normalizedDocumentUrl(sourceUrl)}`);
  const identitySource = sourceUrl.startsWith('file:')
    ? `local|${fingerprint}|${data.byteLength}`
    : `${normalizedDocumentUrl(sourceUrl)}|${fingerprint}`;
  const documentId = hashString(identitySource);
  storageKey = `microleitura:v5:pdf:${documentId}`;
  const saved = await chrome.storage.local.get(storageKey);
  marks = new Map(Object.entries(saved[storageKey] || {}));
  progress.textContent = `Renderizando 0/${pdf.numPages}`;
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
    await renderPage(pdf, pageNumber, documentId);
    progress.textContent = `Renderizando ${pageNumber}/${pdf.numPages}`;
  }
  updateProgress();
  let filename = sourceUrl.split('/').pop() || 'PDF';
  try { filename = decodeURIComponent(filename); } catch (_) { /* Preserve the encoded filename. */ }
  document.title = `Microleitura — ${filename}`;
}

start().catch(showError);
