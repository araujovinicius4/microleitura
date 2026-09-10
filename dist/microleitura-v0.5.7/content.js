(() => {
  const PROCESSED = 'data-microleitura-processed';
  const CHUNK_CLASS = 'microleitura-chunk';
  const READ_CLASS = 'microleitura-read';
  const MARK_ATTR = 'data-microleitura-mark';
  const PALETTE_CLASS = 'microleitura-palette';
  const CURRENT_CLASS = 'microleitura-current';
  const BAR_CLASS = 'microleitura-progress';
  const STORAGE_PREFIX = 'microleitura:v4:';
  const LEGACY_STORAGE_PREFIX = 'microleitura:v2:';
  const MARKS = ['gray', 'green', 'yellow', 'red'];
  const MAX_CHARS = 190;
  const MAX_SENTENCES = 2;
  const INTERACTIVE_SELECTOR = [
    'a', 'area', 'button', 'input', 'textarea', 'select', 'option', 'summary', 'label',
    'audio[controls]', 'video[controls]', 'iframe', 'object', 'embed',
    '[contenteditable]:not([contenteditable="false"])',
    '[role="button"]', '[role="link"]', '[role="checkbox"]', '[role="radio"]',
    '[role="switch"]', '[role="tab"]', '[role="menuitem"]', '[role="option"]',
    '[role="combobox"]', '[role="slider"]', '[role="spinbutton"]',
    '[role="textbox"]', '[role="searchbox"]'
  ].join(', ');

  const normalize = (text) => (text || '').replace(/\s+/g, ' ').trim();

  function isInteractiveTarget(target) {
    const element = target instanceof Element ? target : target?.parentElement;
    return Boolean(element?.closest(INTERACTIVE_SELECTOR));
  }

  function hasNonEmptyTextSelection() {
    const selection = window.getSelection();
    return Boolean(selection && !selection.isCollapsed && selection.toString().trim());
  }

  function hashString(str) {
    let hash = 2166136261;
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function conversationKey() {
    return `${STORAGE_PREFIX}${location.origin}${location.pathname}${location.search}`;
  }

  async function loadMarkState() {
    const key = conversationKey();
    const result = await chrome.storage.local.get(key);
    if (result[key] && typeof result[key] === 'object' && !Array.isArray(result[key])) {
      return new Map(Object.entries(result[key]));
    }

    // Migrate v0.2.x "read" entries to gray marks.
    const legacyKey = `${LEGACY_STORAGE_PREFIX}${location.pathname}`;
    const legacy = await chrome.storage.local.get(legacyKey);
    const migrated = new Map((legacy[legacyKey] || []).map((id) => [id, 'gray']));
    if (migrated.size) await saveMarkState(migrated);
    return migrated;
  }

  async function saveMarkState(markMap) {
    const key = conversationKey();
    await chrome.storage.local.set({ [key]: Object.fromEntries(markMap) });
  }

  function applyMark(span, mark) {
    span.classList.remove(READ_CLASS);
    span.removeAttribute(MARK_ATTR);
    if (!mark || !MARKS.includes(mark)) return;
    span.setAttribute(MARK_ATTR, mark);
    if (mark === 'gray') span.classList.add(READ_CLASS);
  }

  function isChatGPT() {
    return location.hostname === 'chatgpt.com' || location.hostname === 'chat.openai.com';
  }

  function getChatGPTRoots() {
    const direct = [...document.querySelectorAll(
      '[data-message-author-role="assistant"], [data-message-author-role="user"]'
    )];
    if (direct.length) return direct;

    return [...document.querySelectorAll('article')].filter((article) =>
      article.querySelector('[data-message-author-role="assistant"], [data-message-author-role="user"]')
    );
  }

  function genericRootScore(el) {
    const text = normalize(el.innerText);
    const paragraphs = el.querySelectorAll('p').length;
    const headings = el.querySelectorAll('h1,h2,h3').length;
    const links = el.querySelectorAll('a').length;
    return text.length + paragraphs * 180 + headings * 90 - links * 18;
  }

  function getGenericRoots() {
    // Prefer semantic article containers. On listing pages, each article gets
    // its own progress/review controls.
    const articles = [...document.querySelectorAll('article')].filter((el) => {
      if (el.closest('nav, header, footer, aside')) return false;
      return normalize(el.innerText).length >= 120 && el.querySelector('p');
    });
    if (articles.length) return articles;

    const candidates = [...document.querySelectorAll('main, [role="main"], .post, .entry-content, .post-content, .article-content, #content')].filter((el) => {
      if (el.closest('nav, header, footer, aside')) return false;
      return normalize(el.innerText).length >= 180 && el.querySelector('p');
    });
    if (candidates.length) {
      candidates.sort((a, b) => genericRootScore(b) - genericRootScore(a));
      return [candidates[0]];
    }

    // Last-resort fallback for simple pages.
    const body = document.body;
    return body && normalize(body.innerText).length >= 300 ? [body] : [];
  }

  function getMessageRoots() {
    return isChatGPT() ? getChatGPTRoots() : getGenericRoots();
  }

  function messageFingerprint(root) {
    const text = normalize(root.innerText).slice(0, 800);
    return hashString(text);
  }

  function eligibleBlock(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    if (el.hasAttribute(PROCESSED)) return false;
    if (el.closest(`.${BAR_CLASS}, pre, table, button, textarea, input, nav, header, footer, aside, form, [role=\"navigation\"]`)) return false;
    if (el.querySelector('pre, table, form')) return false;

    const text = normalize(el.textContent);
    return text.length >= 12;
  }

  function sentenceRanges(rawText) {
    const ranges = [];
    const re = /(?:[^.!?…]|[.!?…](?!\s|$))+(?:[.!?…]+(?=\s|$)|$)/g;
    let match;

    while ((match = re.exec(rawText)) !== null) {
      let start = match.index;
      let end = match.index + match[0].length;
      while (start < end && /\s/.test(rawText[start])) start++;
      while (end > start && /\s/.test(rawText[end - 1])) end--;
      if (end > start) ranges.push({ start, end });
    }

    if (!ranges.length && normalize(rawText)) {
      let start = 0;
      let end = rawText.length;
      while (start < end && /\s/.test(rawText[start])) start++;
      while (end > start && /\s/.test(rawText[end - 1])) end--;
      if (end > start) ranges.push({ start, end });
    }

    return ranges;
  }

  function microRanges(rawText) {
    const sentences = sentenceRanges(rawText);
    const chunks = [];
    let current = null;
    let count = 0;

    for (const sentence of sentences) {
      if (!current) {
        current = { ...sentence };
        count = 1;
        continue;
      }

      const candidateLength = sentence.end - current.start;
      if (count >= MAX_SENTENCES || candidateLength > MAX_CHARS) {
        chunks.push(current);
        current = { ...sentence };
        count = 1;
      } else {
        current.end = sentence.end;
        count++;
      }
    }

    if (current) chunks.push(current);
    return chunks;
  }

  function textNodeMap(block) {
    const entries = [];
    let offset = 0;
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (!parent || parent.closest(`.${BAR_CLASS}, pre, code, button, textarea, input`)) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    let node;
    while ((node = walker.nextNode())) {
      const start = offset;
      offset += node.nodeValue.length;
      entries.push({ node, start, end: offset });
    }
    return entries;
  }

  function uncoveredTextNodes(block) {
    const nodes = [];
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!normalize(node.nodeValue)) return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (!parent || parent.closest(`.${CHUNK_CLASS}, .${BAR_CLASS}, pre, code, button, textarea, input`)) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    let node;
    while ((node = walker.nextNode())) nodes.push(node);
    return nodes;
  }

  function repairUncoveredText(block, root, markMap, fingerprint) {
    const nodes = uncoveredTextNodes(block);
    for (const node of nodes) {
      const rawText = node.nodeValue || '';
      const ranges = microRanges(rawText);
      for (let i = ranges.length - 1; i >= 0; i--) {
        const rangeInfo = ranges[i];
        const chunkText = normalize(rawText.slice(rangeInfo.start, rangeInfo.end)).toLowerCase();
        const chunkId = hashString(`${location.hostname}|${fingerprint}|${chunkText}`);
        const range = document.createRange();
        range.setStart(node, rangeInfo.start);
        range.setEnd(node, rangeInfo.end);
        const span = document.createElement('span');
        span.className = CHUNK_CLASS;
        span.dataset.microleituraId = chunkId;
        span.title = 'Clique para escolher uma marcação';
        span.appendChild(range.extractContents());
        range.insertNode(span);
        applyMark(span, markMap.get(chunkId));
        bindChunk(span, root, markMap);
      }
    }
    return nodes.length;
  }

  function locate(entries, absoluteOffset, preferEnd = false) {
    if (!entries.length) return null;
    for (const entry of entries) {
      if (absoluteOffset < entry.end || (preferEnd && absoluteOffset === entry.end)) {
        return {
          node: entry.node,
          offset: Math.max(0, Math.min(entry.node.nodeValue.length, absoluteOffset - entry.start))
        };
      }
    }
    const last = entries[entries.length - 1];
    return { node: last.node, offset: last.node.nodeValue.length };
  }

  function wrapRange(block, rangeInfo, chunkId, markMap) {
    const entries = textNodeMap(block);
    const start = locate(entries, rangeInfo.start, false);
    const end = locate(entries, rangeInfo.end, true);
    if (!start || !end) return null;

    try {
      const range = document.createRange();
      range.setStart(start.node, start.offset);
      range.setEnd(end.node, end.offset);
      if (range.collapsed) return null;

      const span = document.createElement('span');
      span.className = CHUNK_CLASS;
      span.dataset.microleituraId = chunkId;
      span.title = 'Clique para escolher uma marcação';

      const fragment = range.extractContents();
      span.appendChild(fragment);
      range.insertNode(span);

      applyMark(span, markMap.get(chunkId));
      return span;
    } catch (_) {
      return null;
    }
  }

  function getChunks(root) {
    return [...root.querySelectorAll(`.${CHUNK_CLASS}`)];
  }

  function ensureProgressBar(root) {
    let bar = root.querySelector(`:scope > .${BAR_CLASS}`);
    if (bar) return bar;

    bar = document.createElement('div');
    bar.className = BAR_CLASS;
    bar.innerHTML = `
      <span class="microleitura-progress-label">Microleitura</span>
      <span class="microleitura-progress-count"></span>
      <button type="button" class="microleitura-continue">Continuar</button>
      <button type="button" class="microleitura-review">Revisar</button>
    `;

    bar.querySelector('.microleitura-continue').addEventListener('click', (event) => {
      event.stopPropagation();
      const unread = getChunks(root).find((chunk) => !chunk.hasAttribute(MARK_ATTR));
      if (unread) {
        unread.scrollIntoView({ behavior: 'smooth', block: 'center' });
        unread.classList.add('microleitura-pulse');
        setTimeout(() => unread.classList.remove('microleitura-pulse'), 900);
      }
    });

    bar.querySelector('.microleitura-review').addEventListener('click', (event) => {
      event.stopPropagation();
      const reviewChunks = getChunks(root).filter((chunk) => {
        const mark = chunk.getAttribute(MARK_ATTR);
        return mark === 'yellow' || mark === 'red';
      });
      if (!reviewChunks.length) return;

      const currentId = bar.dataset.microleituraReviewId;
      let index = reviewChunks.findIndex((chunk) => chunk.dataset.microleituraId === currentId);
      index = (index + 1) % reviewChunks.length;
      const next = reviewChunks[index];
      bar.dataset.microleituraReviewId = next.dataset.microleituraId;

      next.scrollIntoView({ behavior: 'smooth', block: 'center' });
      next.classList.add('microleitura-review-focus');
      setTimeout(() => next.classList.remove('microleitura-review-focus'), 1100);

      const reviewButton = bar.querySelector('.microleitura-review');
      if (reviewButton) reviewButton.textContent = `Revisar ${index + 1}/${reviewChunks.length}`;
    });

    root.insertBefore(bar, root.firstChild);
    return bar;
  }

  function updateProgress(root) {
    const chunks = getChunks(root);
    if (!chunks.length) return;

    const read = chunks.filter((chunk) => chunk.hasAttribute(MARK_ATTR)).length;
    const percent = Math.round((read / chunks.length) * 100);
    const bar = ensureProgressBar(root);
    const count = bar.querySelector('.microleitura-progress-count');
    const button = bar.querySelector('.microleitura-continue');
    const reviewButton = bar.querySelector('.microleitura-review');
    const reviewChunks = chunks.filter((chunk) => {
      const mark = chunk.getAttribute(MARK_ATTR);
      return mark === 'yellow' || mark === 'red';
    });

    if (count) count.textContent = `${read}/${chunks.length} · ${percent}%`;
    if (button) button.hidden = read === chunks.length;
    if (reviewButton) {
      reviewButton.hidden = reviewChunks.length === 0;
      if (!reviewButton.hidden) reviewButton.textContent = `Revisar (${reviewChunks.length})`;
      if (reviewButton.hidden) delete bar.dataset.microleituraReviewId;
    }

    chunks.forEach((chunk) => chunk.classList.remove(CURRENT_CLASS));
    const next = chunks.find((chunk) => !chunk.hasAttribute(MARK_ATTR));
    if (next) next.classList.add(CURRENT_CLASS);
  }

  let openPalette = null;

  function closePalette() {
    if (openPalette) openPalette.remove();
    openPalette = null;
  }

  function showPalette(span, root, markMap) {
    closePalette();
    const palette = document.createElement('div');
    palette.className = PALETTE_CLASS;
    palette.setAttribute('role', 'menu');
    palette.setAttribute('aria-label', 'Marcar microtrecho');

    const options = [
      ['gray', 'Lido'],
      ['green', 'Entendido'],
      ['yellow', 'Revisar'],
      ['red', 'Importante/Dúvida']
    ];

    for (const [mark, label] of options) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'microleitura-color-button';
      button.dataset.mark = mark;
      button.title = label;
      button.setAttribute('aria-label', label);
      const dot = document.createElement('span');
      dot.className = 'microleitura-color-dot';
      dot.setAttribute('aria-hidden', 'true');
      const text = document.createElement('span');
      text.className = 'microleitura-color-label';
      text.textContent = label;
      button.append(dot, text);
      if (span.getAttribute(MARK_ATTR) === mark) button.classList.add('is-active');
      button.addEventListener('click', async (event) => {
        event.preventDefault();
        event.stopPropagation();
        const id = span.dataset.microleituraId;
        applyMark(span, mark);
        markMap.set(id, mark);
        updateProgress(root);
        closePalette();
        await saveMarkState(markMap);
      });
      palette.appendChild(button);
    }

    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'microleitura-clear-button';
    clear.textContent = '×';
    clear.title = 'Limpar marcação';
    clear.setAttribute('aria-label', 'Limpar marcação');
    clear.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const id = span.dataset.microleituraId;
      applyMark(span, null);
      markMap.delete(id);
      updateProgress(root);
      closePalette();
      await saveMarkState(markMap);
    });
    palette.appendChild(clear);

    document.body.appendChild(palette);
    const rect = span.getBoundingClientRect();
    const prect = palette.getBoundingClientRect();
    let left = Math.min(window.innerWidth - prect.width - 8, Math.max(8, rect.left));
    let top = rect.bottom + 6;
    if (top + prect.height > window.innerHeight - 8) top = Math.max(8, rect.top - prect.height - 6);
    palette.style.left = `${left + window.scrollX}px`;
    palette.style.top = `${top + window.scrollY}px`;
    openPalette = palette;
  }

  function bindChunk(span, root, markMap) {
    if (span.dataset.microleituraBound === 'true') return;
    span.dataset.microleituraBound = 'true';

    span.addEventListener('click', (event) => {
      if (isInteractiveTarget(event.target)) return;
      if (hasNonEmptyTextSelection()) return;
      event.stopPropagation();
      showPalette(span, root, markMap);
    });
  }



  function directReadableTextLength(el) {
    let length = 0;
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) length += normalize(node.nodeValue).length;
      if (node.nodeType === Node.ELEMENT_NODE && ['SPAN','STRONG','EM','A','CODE'].includes(node.tagName)) {
        length += normalize(node.textContent).length;
      }
    }
    return length;
  }

  function candidateBlocks(root) {
    const selector = isChatGPT()
      ? 'p, li, blockquote, h1, h2, h3, h4, h5, h6'
      : 'p, blockquote, h1, h2, h3, h4';
    const standard = [...root.querySelectorAll(selector)].filter((el) =>
      !el.closest('nav, header, footer, aside, form, [role="navigation"]')
    );

    // Important: sometimes the element carrying data-message-author-role is itself
    // the readable text block. querySelectorAll() only searches descendants, so
    // the previous version silently skipped this case.
    if (root.matches?.(selector)) standard.unshift(root);

    // ChatGPT occasionally renders text directly in a div rather than a <p>.
    // Include the root itself and descendant leaf-like divs, while avoiding UI.
    const divPool = isChatGPT() ? [
      ...(root.tagName === 'DIV' ? [root] : []),
      ...root.querySelectorAll('div')
    ] : [];
    const fallbackDivs = divPool.filter((el) => {
      if (el.closest(`.${BAR_CLASS}, pre, table, button, textarea, input, nav, header, footer, aside, form, [role=\"navigation\"]`)) return false;
      if (el.querySelector('p, li, blockquote, h1, h2, h3, h4, h5, h6, pre, table, button, textarea, input')) return false;
      if (el.querySelector(`.${CHUNK_CLASS}`) && !el.hasAttribute(PROCESSED)) return false;

      const text = normalize(el.textContent);
      if (text.length < 12) return false;

      // A fallback div should mostly contain inline content, not other text containers.
      const childDivWithText = [...el.children].some((child) =>
        child.tagName === 'DIV' && normalize(child.textContent).length >= 12
      );

      // A container with child divs is usually UI/layout. Exception: if it also
      // carries its own direct readable text, it is still a legitimate block.
      return !childDivWithText || directReadableTextLength(el) >= 12;
    });

    return [...new Set([...standard, ...fallbackDivs])];
  }

  function processRoot(root, markMap) {
    const fingerprint = messageFingerprint(root);
    const blocks = candidateBlocks(root);
    let blockNumber = 0;

    for (const block of blocks) {
      if (block.hasAttribute(PROCESSED)) {
        repairUncoveredText(block, root, markMap, fingerprint);
        continue;
      }
      if (!eligibleBlock(block)) continue;

      const rawText = block.textContent || '';
      const ranges = microRanges(rawText);
      if (!ranges.length) continue;

      block.setAttribute(PROCESSED, 'true');
      const ids = ranges.map((r, index) => {
        const chunkText = normalize(rawText.slice(r.start, r.end)).toLowerCase();
        return hashString(`${location.hostname}|${fingerprint}|${chunkText}`);
      });

      // Process backwards so earlier character offsets remain valid.
      for (let i = ranges.length - 1; i >= 0; i--) {
        const span = wrapRange(block, ranges[i], ids[i], markMap);
        if (span) bindChunk(span, root, markMap);
      }
      blockNumber++;
    }

    getChunks(root).forEach((span) => bindChunk(span, root, markMap));
    if (getChunks(root).length) updateProgress(root);
  }

  let markMap = null;
  let processing = false;
  async function processPage() {
    if (processing) return;
    processing = true;
    try {
      if (!markMap) markMap = await loadMarkState();
      getMessageRoots().forEach((root) => processRoot(root, markMap));
    } finally {
      processing = false;
    }
  }

  let timer = null;
  function scheduleProcess() {
    clearTimeout(timer);
    timer = setTimeout(processPage, 650);
  }

  document.addEventListener('click', (event) => {
    if (openPalette && !event.target.closest(`.${PALETTE_CLASS}`) && !event.target.closest(`.${CHUNK_CLASS}`)) closePalette();
  });

  const observer = new MutationObserver((mutations) => {
    // Ignore mutations created only by our own progress UI/classes.
    const external = mutations.some((mutation) => {
      const target = mutation.target.nodeType === Node.ELEMENT_NODE
        ? mutation.target
        : mutation.target.parentElement;
      return !target?.closest?.(`.${BAR_CLASS}`);
    });
    if (external) scheduleProcess();
  });

  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });

  let lastPath = location.pathname;
  setInterval(() => {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      markMap = null;
      scheduleProcess();
    }
  }, 800);

  scheduleProcess();
})();
