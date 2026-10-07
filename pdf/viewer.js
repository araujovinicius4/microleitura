import * as pdfjsLib from './lib/pdf.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('pdf/lib/pdf.worker.mjs');

const MARKS = [
  ['gray', 'Lido'],
  ['green', 'Entendido'],
  ['yellow', 'Revisar'],
  ['red', 'Importante/Dúvida']
];
const INTERACTIVE_SELECTOR = [
  'a', 'area', 'button', 'input', 'textarea', 'select', 'option', 'summary', 'label',
  'audio[controls]', 'video[controls]', 'iframe', 'object', 'embed',
  '[contenteditable]:not([contenteditable="false"])',
  '[role="button"]', '[role="link"]', '[role="checkbox"]', '[role="radio"]',
  '[role="switch"]', '[role="tab"]', '[role="menuitem"]', '[role="option"]',
  '[role="combobox"]', '[role="slider"]', '[role="spinbutton"]',
  '[role="textbox"]', '[role="searchbox"]'
].join(', ');
const viewerParams = new URLSearchParams(location.search);
// `file` is retained only for links created by v0.5.1/v0.5.2. New navigations
// use the explicit `url` parameter and never double-encode the original URL.
const sourceUrl = viewerParams.get('url') || viewerParams.get('file');
const viewer = document.querySelector('#viewer');
const progress = document.querySelector('#progress');
const continueButton = document.querySelector('#continue');
const reviewButton = document.querySelector('#review');
const openOriginalButton = document.querySelector('#open-original');
const debugButton = document.querySelector('#debug-toggle');
const debugMetrics = document.querySelector('#debug-metrics');
const errorBox = document.querySelector('#error');
const segmentsByDocumentOrder = [];
const segmentsById = new Map();
const pageMetrics = new Map();
let marks = new Map();
let storageKey = '';
let reviewIndex = -1;
let palette = null;
let pdfLoaded = false;
let pdfDocument = null;

const normalize = (value) => (value || '').replace(/\s+/g, ' ').trim();
function isInteractiveTarget(target) {
  const element = target instanceof Element ? target : target?.parentElement;
  return Boolean(element?.closest(INTERACTIVE_SELECTOR));
}

function hasNonEmptyTextSelection() {
  const selection = window.getSelection();
  return Boolean(selection && !selection.isCollapsed && selection.toString().trim());
}

function scrollToPage(pageNumber) {
  document.querySelector(`.page[data-page-number="${pageNumber}"]`)
    ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

const pdfLinkService = {
  addLinkAttributes(link, url, newWindow = false) {
    link.href = url;
    link.rel = 'noopener noreferrer';
    if (newWindow) link.target = '_blank';
  },
  getDestinationHash(destination) {
    const value = typeof destination === 'string' ? destination : JSON.stringify(destination);
    return `#${encodeURIComponent(value)}`;
  },
  getAnchorUrl(hash) {
    return hash || '#';
  },
  async goToDestination(destination) {
    const explicitDestination = typeof destination === 'string'
      ? await pdfDocument.getDestination(destination)
      : destination;
    const reference = explicitDestination?.[0];
    if (!reference) return;
    const pageIndex = Number.isInteger(reference)
      ? reference
      : await pdfDocument.getPageIndex(reference);
    scrollToPage(pageIndex + 1);
  },
  executeNamedAction(action) {
    const pages = [...document.querySelectorAll('.page')];
    const currentIndex = Math.max(0, pages.findIndex((page) => page.getBoundingClientRect().bottom > 52));
    const targetIndex = action === 'NextPage' ? currentIndex + 1
      : action === 'PrevPage' ? currentIndex - 1
      : action === 'LastPage' ? pages.length - 1
      : 0;
    scrollToPage(Math.min(pages.length, Math.max(1, targetIndex + 1)));
  }
};

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

function reconstructText(items) {
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
  return { lines, blocks, groups };
}

function attachSegmentRegions(textDivs, itemGroup, segment) {
  for (const { index } of itemGroup) {
    const textDiv = textDivs[index];
    if (!textDiv) continue;
    textDiv.classList.add('ml-pdf-segment');
    textDiv.dataset.mlSegmentId = segment.id;
    textDiv.title = 'Clique para escolher uma marcação';
    segment.regions.push(textDiv);
  }
}

function applyMark(segment, mark) {
  segment.mark = mark || null;
  for (const region of segment.regions) {
    if (mark) region.dataset.mark = mark;
    else region.removeAttribute('data-mark');
  }
}

async function saveMarks() {
  await chrome.storage.local.set({ [storageKey]: Object.fromEntries(marks) });
}

function updateProgress() {
  const marked = segmentsByDocumentOrder.filter((segment) => segment.mark).length;
  const review = segmentsByDocumentOrder.filter((segment) => segment.mark === 'yellow' || segment.mark === 'red');
  const percent = segmentsByDocumentOrder.length ? Math.round(marked / segmentsByDocumentOrder.length * 100) : 0;
  progress.textContent = `${percent}% lido · ${marked}/${segmentsByDocumentOrder.length}`;
  reviewButton.textContent = `Revisar (${review.length})`;
  reviewButton.disabled = review.length === 0;
  continueButton.disabled = marked === segmentsByDocumentOrder.length || segmentsByDocumentOrder.length === 0;
  segmentsByDocumentOrder.forEach((segment) => segment.regions.forEach((region) => region.classList.remove('current')));
  const next = segmentsByDocumentOrder.find((segment) => !segment.mark);
  next?.regions.forEach((region) => region.classList.add('current'));
}

function focusSegment(segment) {
  const target = segment?.regions[0];
  if (!target) return;
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  segment.regions.forEach((region) => region.classList.add('focus'));
  setTimeout(() => segment.regions.forEach((region) => region.classList.remove('focus')), 1100);
}

function nextUnreadChunk() {
  let lastMarked = -1;
  segmentsByDocumentOrder.forEach((segment, index) => {
    if (segment.mark) lastMarked = index;
  });
  return segmentsByDocumentOrder.slice(lastMarked + 1).find((segment) => !segment.mark) ||
    segmentsByDocumentOrder.find((segment) => !segment.mark);
}

function closePalette() {
  palette?.remove();
  palette = null;
}

function showPalette(segment, anchor) {
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
    if (segment.mark === mark) button.classList.add('active');
    button.addEventListener('click', async () => {
      marks.set(segment.id, mark);
      applyMark(segment, mark);
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
    marks.delete(segment.id);
    applyMark(segment, null);
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
  const annotationLayerElement = document.createElement('div');
  annotationLayerElement.className = 'annotationLayer';
  pageElement.appendChild(annotationLayerElement);
  viewer.appendChild(pageElement);

  const [textContent, annotations, optionalContentConfig] = await Promise.all([
    page.getTextContent(),
    page.getAnnotations({ intent: 'display' }),
    pdf.getOptionalContentConfig({ intent: 'display' })
  ]);
  await page.render({ canvasContext: canvas.getContext('2d'), viewport, transform: outputScale === 1 ? null : [outputScale, 0, 0, outputScale, 0, 0] }).promise;
  const textLayer = new pdfjsLib.TextLayer({ textContentSource: textContent, container: textLayerElement, viewport });
  await textLayer.render();
  const annotationLayer = new pdfjsLib.AnnotationLayer({
    div: annotationLayerElement,
    page,
    viewport: viewport.clone({ dontFlip: true }),
    linkService: pdfLinkService
  });
  await annotationLayer.render({ annotations, optionalContentConfig, renderForms: false });
  const textDivs = textLayer.textDivs || [...textLayerElement.querySelectorAll('span')];
  const reconstruction = reconstructText(textContent.items);
  const occurrences = new Map();
  let pageSegments = 0;
  let interactiveElements = 0;
  for (const itemGroup of reconstruction.groups) {
    const text = normalize(itemGroup.map(({ item }) => item.str).join(' '));
    if (text.length < 2) continue;
    const normalizedText = text.toLocaleLowerCase('pt-BR');
    const occurrence = occurrences.get(normalizedText) || 0;
    occurrences.set(normalizedText, occurrence + 1);
    const id = hashString(`${documentId}|${pageNumber}|${normalizedText}|${occurrence}`);
    const segment = { id, pageNumber, text, mark: marks.get(id) || null, regions: [] };
    attachSegmentRegions(textDivs, itemGroup, segment);
    if (segment.regions.length) {
      applyMark(segment, segment.mark);
      segmentsByDocumentOrder.push(segment);
      segmentsById.set(id, segment);
      pageSegments++;
      interactiveElements += segment.regions.length;
    }
  }
  const metrics = {
    pageNumber,
    textItems: textContent.items.length,
    lines: reconstruction.lines.length,
    blocks: reconstruction.blocks.length,
    microSegments: pageSegments,
    interactiveElements
  };
  pageMetrics.set(pageNumber, metrics);
  console.log('[Microleitura PDF]', metrics);
  if (textContent.items.length && !pageElement.querySelector('.ml-pdf-segment')) {
    throw new Error(`A página ${pageNumber} contém texto, mas nenhum microtrecho interativo foi criado.`);
  }
  if (document.body.classList.contains('ml-debug')) {
    updateDebugMetrics(pageNumber);
  }
}

function updateDebugMetrics(pageNumber) {
  const metrics = pageMetrics.get(Number(pageNumber));
  const totals = [...pageMetrics.values()].reduce((result, page) => ({
    textItems: result.textItems + page.textItems,
    segments: result.segments + page.microSegments,
    regions: result.regions + page.interactiveElements
  }), { textItems: 0, segments: 0, regions: 0 });
  debugMetrics.textContent = [
    'Viewer: Microleitura PDF.js',
    `Original URL: ${sourceUrl || '(ausente)'}`,
    `Current URL: ${location.href}`,
    `PDF loaded: ${pdfLoaded ? 'yes' : 'no'}`,
    `Text items: ${totals.textItems}`,
    `Segments: ${totals.segments}`,
    `DOM regions: ${totals.regions}`,
    metrics ? `Página atual: ${metrics.pageNumber} · Text items: ${metrics.textItems} · Linhas: ${metrics.lines} · Microtrechos: ${metrics.microSegments} · Elementos interativos: ${metrics.interactiveElements}` : ''
  ].filter(Boolean).join('\n');
}

viewer.addEventListener('click', (event) => {
  if (isInteractiveTarget(event.target)) return;
  if (hasNonEmptyTextSelection()) return;
  const region = event.target.closest('.ml-pdf-segment');
  if (!region) return;
  const segment = segmentsById.get(region.dataset.mlSegmentId);
  if (segment) showPalette(segment, region);
});

debugButton.addEventListener('click', () => {
  const enabled = document.body.classList.toggle('ml-debug');
  debugButton.setAttribute('aria-pressed', String(enabled));
  debugMetrics.hidden = !enabled;
  if (enabled) {
    const currentPage = [...document.querySelectorAll('.page')].find((page) => {
      const rect = page.getBoundingClientRect();
      return rect.bottom > 52 && rect.top < innerHeight;
    });
    updateDebugMetrics(currentPage?.dataset.pageNumber || 1);
  }
});

document.addEventListener('scroll', () => {
  if (!document.body.classList.contains('ml-debug')) return;
  const currentPage = [...document.querySelectorAll('.page')].find((page) => {
    const rect = page.getBoundingClientRect();
    return rect.bottom > 52 && rect.top < innerHeight;
  });
  if (currentPage) updateDebugMetrics(currentPage.dataset.pageNumber);
}, { passive: true });

openOriginalButton.addEventListener('click', () => {
  if (sourceUrl) location.assign(sourceUrl);
});

continueButton.addEventListener('click', () => focusSegment(nextUnreadChunk()));
reviewButton.addEventListener('click', () => {
  const reviewSegments = segmentsByDocumentOrder.filter((segment) => segment.mark === 'yellow' || segment.mark === 'red');
  if (!reviewSegments.length) return;
  reviewIndex = (reviewIndex + 1) % reviewSegments.length;
  focusSegment(reviewSegments[reviewIndex]);
});
document.addEventListener('click', (event) => {
  if (palette && !event.target.closest('.palette') && !event.target.closest('.ml-pdf-segment')) closePalette();
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
    pdfDocument = pdf;
    pdfLoaded = true;
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
  document.title = `Microleitura PDF — ${filename}`;
}

start().catch(showError);
