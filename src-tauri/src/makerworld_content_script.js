(() => {
  if (window.__MATERIALIZE_MAKERWORLD_INSTALLED__) {
    return;
  }
  window.__MATERIALIZE_MAKERWORLD_INSTALLED__ = true;

  const tauriInternals = window.__TAURI_INTERNALS__;
  const tauriInvoke =
    (tauriInternals && typeof tauriInternals.invoke === 'function' && tauriInternals.invoke.bind(tauriInternals)) ||
    (window.__TAURI__ && window.__TAURI__.core && typeof window.__TAURI__.core.invoke === 'function'
      ? window.__TAURI__.core.invoke.bind(window.__TAURI__.core)
      : null);

  const invoke = async (cmd, args) => {
    if (!tauriInvoke) return null;
    try {
      return await tauriInvoke(cmd, args);
    } catch (error) {
      console.warn('[materialize] makerworld invoke failed', cmd, error);
      return null;
    }
  };

  try {
    delete window.__TAURI__;
  } catch {}
  try {
    delete window.__TAURI_INTERNALS__;
  } catch {}

  const text = (value) => (typeof value === 'string' ? value.trim() : '');

  const parseNumber = (value) => {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      const match = value.replace(/,/g, '').match(/\d+(?:\.\d+)?/);
      if (match) return Number(match[0]);
    }
    return null;
  };

  const uniq = (values) => Array.from(new Set(values.filter(Boolean)));

  const absolute = (value) => {
    if (!value || typeof value !== 'string') return null;
    try {
      return new URL(value, window.location.href).toString();
    } catch {
      return null;
    }
  };

  const deepEntries = (root, maxDepth = 7) => {
    const out = [];
    const seen = new WeakSet();
    const visit = (value, path, depth) => {
      if (!value || depth > maxDepth) return;
      if (typeof value !== 'object') return;
      if (seen.has(value)) return;
      seen.add(value);
      out.push([path, value]);
      if (Array.isArray(value)) {
        value.slice(0, 24).forEach((item, index) => visit(item, `${path}[${index}]`, depth + 1));
        return;
      }
      Object.entries(value).slice(0, 40).forEach(([key, item]) => visit(item, `${path}.${key}`, depth + 1));
    };
    visit(root, '$', 0);
    return out;
  };

  const readNextData = () => {
    if (window.__NEXT_DATA__) return window.__NEXT_DATA__;
    const script = document.getElementById('__NEXT_DATA__');
    if (!script || !script.textContent) return null;
    try {
      return JSON.parse(script.textContent);
    } catch {
      return null;
    }
  };

  const scoreCandidate = (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return -1;
    const keys = Object.keys(value).map((key) => key.toLowerCase());
    let score = 0;
    if (keys.some((key) => key.includes('title') || key === 'name' || key.includes('model'))) score += 3;
    if (keys.some((key) => key.includes('author') || key.includes('designer') || key.includes('creator') || key.includes('user'))) score += 3;
    if (keys.some((key) => key.includes('rating') || key.includes('score') || key.includes('review'))) score += 2;
    if (keys.some((key) => key.includes('download'))) score += 2;
    if (keys.some((key) => key.includes('file') || key.includes('attachment'))) score += 2;
    if (keys.some((key) => key === 'id' || key.includes('modelid'))) score += 1;
    return score;
  };

  const pickFromObject = (value, predicates) => {
    if (!value || typeof value !== 'object') return null;
    const entries = Object.entries(value);
    for (const [key, item] of entries) {
      const keyLower = key.toLowerCase();
      if (predicates.some((predicate) => predicate(keyLower, item))) {
        return item;
      }
    }
    return null;
  };

  const firstString = (...values) => {
    for (const value of values) {
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return null;
  };

  const extractFromCandidate = (candidate) => {
    if (!candidate || typeof candidate !== 'object') return null;

    const title = firstString(
      candidate.title,
      candidate.modelTitle,
      candidate.name,
      candidate.displayName,
      candidate.modelName,
      candidate.subject,
    );

    const authorSource =
      pickFromObject(candidate, [
        (key) => key.includes('author'),
        (key) => key.includes('designer'),
        (key) => key.includes('creator'),
        (key) => key === 'user',
      ]) || {};

    const author =
      firstString(
        candidate.author,
        candidate.authorName,
        candidate.designerName,
        candidate.creatorName,
        authorSource && authorSource.name,
        authorSource && authorSource.nickName,
        authorSource && authorSource.nickname,
        authorSource && authorSource.username,
      ) || null;

    const rating =
      parseNumber(candidate.rating) ??
      parseNumber(candidate.score) ??
      parseNumber(candidate.star) ??
      parseNumber(candidate.avgRating);

    const reviewCount =
      parseNumber(candidate.reviewCount) ??
      parseNumber(candidate.ratingCount) ??
      parseNumber(candidate.commentCount) ??
      parseNumber(candidate.reviews);

    const downloadCount =
      parseNumber(candidate.downloadCount) ??
      parseNumber(candidate.downloads) ??
      parseNumber(candidate.downloadedCount);

    const filesRaw =
      candidate.files ||
      candidate.fileList ||
      candidate.attachments ||
      candidate.models ||
      candidate.resources ||
      candidate.printFiles ||
      [];

    const files = Array.isArray(filesRaw)
      ? filesRaw
          .map((file) => {
            if (typeof file === 'string') {
              return {
                name: file,
                fileType: file.split('.').pop() || null,
                downloadUrl: null,
              };
            }
            if (!file || typeof file !== 'object') return null;
            const name = firstString(file.name, file.fileName, file.filename, file.title, file.displayName);
            if (!name) return null;
            return {
              name,
              fileType: firstString(file.type, file.fileType, file.format, file.extension) || null,
              downloadUrl: absolute(firstString(file.downloadUrl, file.url, file.href, file.link)),
            };
          })
          .filter(Boolean)
      : [];

    const imageValues = [];
    const imageCandidates = [candidate.images, candidate.imageList, candidate.gallery, candidate.cover, candidate.coverImage, candidate.thumbnail];
    for (const source of imageCandidates) {
      if (!source) continue;
      if (Array.isArray(source)) {
        source.forEach((entry) => {
          if (typeof entry === 'string') imageValues.push(entry);
          else if (entry && typeof entry === 'object') imageValues.push(entry.url || entry.src || entry.imageUrl || entry.originUrl);
        });
      } else if (typeof source === 'string') {
        imageValues.push(source);
      } else if (typeof source === 'object') {
        imageValues.push(source.url || source.src || source.imageUrl || source.originUrl);
      }
    }

    if (!title) return null;

    return {
      id: firstString(candidate.id != null ? String(candidate.id) : null, candidate.modelId != null ? String(candidate.modelId) : null),
      title,
      author,
      sourceUrl: window.location.href,
      rating,
      reviewCount,
      downloadCount,
      images: uniq(imageValues.map(absolute)),
      files,
    };
  };

  const extractModel = () => {
    const nextData = readNextData();
    let best = null;
    let bestScore = -1;

    if (nextData) {
      for (const [, value] of deepEntries(nextData)) {
        const score = scoreCandidate(value);
        if (score > bestScore) {
          const extracted = extractFromCandidate(value);
          if (extracted) {
            bestScore = score;
            best = extracted;
          }
        }
      }
    }

    if (best) return best;

    const domTitle =
      text(document.querySelector('h1')?.textContent) ||
      text(document.querySelector('meta[property="og:title"]')?.getAttribute('content')) ||
      text(document.title).replace(/\s*[-|].*$/, '');

    if (!domTitle) return null;

    const author =
      text(document.querySelector('[href*="/user/"]')?.textContent) ||
      text(document.querySelector('[class*="author"], [class*="designer"]')?.textContent) ||
      null;

    const rating = parseNumber(
      text(document.querySelector('[class*="rating"], [data-testid*="rating"]')?.textContent),
    );

    const files = uniq(
      Array.from(document.querySelectorAll('a, button'))
        .map((element) => text(element.textContent))
        .filter((value) => /\.(3mf|stl|step|obj|zip)$/i.test(value) || /download/i.test(value)),
    ).map((name) => ({
      name,
      fileType: name.split('.').pop() || null,
      downloadUrl: null,
    }));

    return {
      id: window.location.pathname.match(/\/models\/(\d+)/)?.[1] || null,
      title: domTitle,
      author,
      sourceUrl: window.location.href,
      rating,
      reviewCount: null,
      downloadCount: null,
      images: uniq(
        Array.from(document.images)
          .map((image) => absolute(image.currentSrc || image.src))
          .filter(Boolean),
      ).slice(0, 8),
      files,
    };
  };

  const currentPageKind = () => {
    const pathname = window.location.pathname;
    if (/\/search\//.test(pathname)) return 'search';
    if (/\/models\//.test(pathname)) return 'model';
    if (/^\/([a-z]{2})?$/.test(pathname) || /^\/en\/?$/.test(pathname)) return 'home';
    return 'other';
  };

  let reportTimer = null;
  const report = (reason) => {
    if (reportTimer) clearTimeout(reportTimer);
    reportTimer = setTimeout(async () => {
      const payload = {
        currentUrl: window.location.href,
        pageKind: currentPageKind(),
        detectedModel: currentPageKind() === 'model' ? extractModel() : null,
        lastExtractionError: null,
      };
      if (payload.pageKind === 'model' && !payload.detectedModel) {
        payload.lastExtractionError = `Model page detected but structured metadata extraction failed (${reason})`;
      }
      await invoke('report_makerworld_page', { payload });
    }, 220);
  };

  const triggerImport = async () => {
    const candidates = Array.from(document.querySelectorAll('a, button')).filter((element) => {
      const value = text(element.textContent);
      const aria = text(element.getAttribute('aria-label'));
      return /download/i.test(value) || /download/i.test(aria) || /\.3mf|\.stl|\.zip/i.test(value);
    });

    const target = candidates[0];
    if (!target) {
      await invoke('report_makerworld_import_attempt', {
        payload: { success: false, error: 'No download button or file link was found on the current MakerWorld page.' },
      });
      return;
    }

    await invoke('report_makerworld_import_attempt', { payload: { success: true } });
    target.click();
  };

  window.__MATERIALIZE_SCAN__ = report;
  window.__MATERIALIZE_IMPORT_CURRENT_MODEL__ = triggerImport;

  const originalPushState = history.pushState.bind(history);
  history.pushState = function (...args) {
    const result = originalPushState(...args);
    report('pushState');
    return result;
  };

  const originalReplaceState = history.replaceState.bind(history);
  history.replaceState = function (...args) {
    const result = originalReplaceState(...args);
    report('replaceState');
    return result;
  };

  window.addEventListener('popstate', () => report('popstate'));
  window.addEventListener('load', () => report('load'));

  const observer = new MutationObserver(() => report('mutation'));
  observer.observe(document.documentElement, { childList: true, subtree: true });

  report('bootstrap');
})();
