const message = document.querySelector('#message');
const openButton = document.querySelector('#open-pdf');

function isPdfUrl(url, title = '') {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return ['http:', 'https:', 'file:'].includes(parsed.protocol) &&
      (/\.pdf$/i.test(parsed.pathname) || parsed.searchParams.get('type') === 'application/pdf' || /\.pdf(?:\s|$)/i.test(title));
  } catch (_) {
    return false;
  }
}

chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
  const url = tab?.url || '';
  if (!isPdfUrl(url, tab?.title)) {
    message.textContent = 'A Microleitura já está ativa nesta página. Abra um PDF para usar o visualizador próprio.';
    return;
  }

  message.textContent = url.startsWith('file:')
    ? 'Abra este PDF local no visualizador da extensão.'
    : 'Abra este PDF no visualizador da extensão.';
  openButton.hidden = false;
  openButton.addEventListener('click', () => {
    const viewer = chrome.runtime.getURL(`pdf/viewer.html?file=${encodeURIComponent(url)}`);
    chrome.tabs.create({ url: viewer });
    window.close();
  }, { once: true });
});
