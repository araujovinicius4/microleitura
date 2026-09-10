const CHROME_PDF_VIEWER_ID = 'mhjfbmdgcfjbbpaeojofohoefgiehjai';
const message = document.querySelector('#message');
const openButton = document.querySelector('#open-pdf');
const diagnosticButton = document.querySelector('#diagnostic-button');
const diagnosticBox = document.querySelector('#diagnostic');

function parseUrl(value) {
  if (!value) return null;
  try {
    return new URL(value);
  } catch (_) {
    return null;
  }
}

function isSourceUrl(value) {
  const parsed = parseUrl(value);
  return Boolean(parsed && ['http:', 'https:', 'file:'].includes(parsed.protocol));
}

function looksLikePdf(value, title = '') {
  const parsed = parseUrl(value);
  if (!parsed) return false;
  return /\.pdf$/i.test(parsed.pathname) ||
    parsed.searchParams.get('type')?.toLowerCase() === 'application/pdf' ||
    /\.pdf(?:\s|$)/i.test(title);
}

function isChromePdfViewerUrl(value) {
  const parsed = parseUrl(value);
  return parsed?.protocol === 'chrome-extension:' && parsed.hostname === CHROME_PDF_VIEWER_ID;
}

function originalUrlsFromViewer(value) {
  if (!isChromePdfViewerUrl(value)) return [];
  const parsed = new URL(value);
  const values = [];
  for (const key of ['file', 'url', 'src']) {
    const candidate = parsed.searchParams.get(key);
    if (isSourceUrl(candidate)) values.push(candidate);
  }
  const hashParams = new URLSearchParams(parsed.hash.replace(/^#/, ''));
  for (const key of ['file', 'url', 'src']) {
    const candidate = hashParams.get(key);
    if (isSourceUrl(candidate)) values.push(candidate);
  }
  return values;
}

function getAllFrames(tabId) {
  return new Promise((resolve) => {
    if (!Number.isInteger(tabId)) {
      resolve([]);
      return;
    }
    chrome.webNavigation.getAllFrames({ tabId }, (frames) => {
      if (chrome.runtime.lastError) {
        resolve([]);
        return;
      }
      resolve(frames || []);
    });
  });
}

async function resolvePdfUrl(tab) {
  const frames = await getAllFrames(tab?.id);
  const primary = [tab?.url, tab?.pendingUrl].filter(Boolean);
  const frameUrls = frames.map((frame) => frame.url).filter(Boolean);
  const viewerOriginals = [...primary, ...frameUrls].flatMap(originalUrlsFromViewer);
  const sourceFrames = frameUrls.filter(isSourceUrl);
  const ordered = [...primary, ...viewerOriginals, ...sourceFrames];

  const resolvedUrl = ordered.find((url) => isSourceUrl(url) && looksLikePdf(url, tab?.title)) ||
    ordered.find(isSourceUrl) || null;

  return { resolvedUrl, frames };
}

function diagnosticText(tab, result) {
  const protocol = parseUrl(result.resolvedUrl)?.protocol || '(nenhum)';
  const relevantFrames = result.frames.map(({ frameId, parentFrameId, url }) =>
    `  [frame ${frameId}, parent ${parentFrameId}] ${url}`
  );
  return [
    `tab.id: ${tab?.id ?? '(indisponível)'}`,
    `tab.url: ${tab?.url || '(indisponível)'}`,
    `tab.pendingUrl: ${tab?.pendingUrl || '(indisponível)'}`,
    `URL resolvida: ${result.resolvedUrl || '(não encontrada)'}`,
    `protocolo: ${protocol}`,
    'frames:',
    ...(relevantFrames.length ? relevantFrames : ['  (nenhum frame disponível)'])
  ].join('\n');
}

chrome.tabs.query({ active: true, currentWindow: true }, async ([tab]) => {
  const result = await resolvePdfUrl(tab);
  diagnosticButton.addEventListener('click', () => {
    diagnosticBox.textContent = diagnosticText(tab, result);
    diagnosticBox.hidden = !diagnosticBox.hidden;
  });

  if (!result.resolvedUrl) {
    message.textContent = 'Não foi possível descobrir a URL original do PDF. Abra “Diagnóstico PDF” para ver os dados disponíveis.';
    return;
  }

  const definitelyPdf = looksLikePdf(result.resolvedUrl, tab?.title) ||
    [tab?.url, tab?.pendingUrl, ...result.frames.map((frame) => frame.url)].some(isChromePdfViewerUrl);
  message.textContent = definitelyPdf
    ? 'Este PDF está sendo exibido pelo leitor do Chrome. A Microleitura usa um visualizador próprio para permitir marcações no PDF.'
    : 'Esta URL não termina em .pdf. O visualizador pode tentar confirmar o formato pelo conteúdo.';
  openButton.hidden = false;
  openButton.addEventListener('click', () => {
    // O leitor PDF nativo é um contexto privilegiado do Chrome. A Microleitura
    // não injeta content.js nem tenta acessar o DOM interno desse leitor; ela
    // substitui explicitamente a aba pelo visualizador PDF.js da extensão.
    const viewerUrl = `${chrome.runtime.getURL('pdf/viewer.html')}?url=${encodeURIComponent(result.resolvedUrl)}`;
    chrome.tabs.update(tab.id, { url: viewerUrl });
    window.close();
  }, { once: true });
});
