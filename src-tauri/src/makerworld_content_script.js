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

  const count = (value) =>
    Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff ? value : null;

  const uniq = (values) => Array.from(new Set(values.filter(Boolean)));

  const absolute = (value) => {
    if (!value || typeof value !== 'string') return null;
    try {
      return new URL(value, window.location.href).toString();
    } catch {
      return null;
    }
  };

  const readNextData = () => {
    // Before Next.js boots, window.__NEXT_DATA__ is the <script> element itself (named access by id).
    if (window.__NEXT_DATA__?.props) return window.__NEXT_DATA__;
    const script = document.getElementById('__NEXT_DATA__');
    if (!script || !script.textContent) return null;
    try {
      return JSON.parse(script.textContent);
    } catch (error) {
      console.warn('[materialize] makerworld __NEXT_DATA__ is not JSON', error);
      return null;
    }
  };

  const firstString = (...values) => {
    for (const value of values) {
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return null;
  };

  const modelIdFromPath = () => window.location.pathname.match(/\/models\/(\d+)/)?.[1] || null;

  const selectedProfileId = () => window.location.hash.match(/profileId-(\d+)/)?.[1] || null;

  // Next.js keeps the first page's __NEXT_DATA__ after a client-side route change,
  // so a model opened from search must be fetched the way the page itself does.
  const fetchedDesigns = new Map();
  const loadDesign = async (modelId) => {
    const embedded = readNextData()?.props?.pageProps?.design;
    if (embedded && String(embedded.id) === modelId) return embedded;

    if (!fetchedDesigns.has(modelId)) {
      fetchedDesigns.set(
        modelId,
        fetch(`/api/v1/design-service/design/${modelId}`, { credentials: 'include' })
          .then((response) => {
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return response.json();
          })
          .catch((error) => {
            console.warn('[materialize] makerworld design request failed', modelId, error);
            return null;
          }),
      );
    }
    const fetched = await fetchedDesigns.get(modelId);
    return fetched && String(fetched.id) === modelId ? fetched : null;
  };

  const profileRating = (instance) => {
    const ratingCount = count(instance?.ratingCount);
    const total = instance?.ratingScoreTotal;
    if (!ratingCount || typeof total !== 'number' || !Number.isFinite(total)) return null;
    const average = Math.round((total / ratingCount) * 10) / 10;
    return average >= 0 && average <= 5 ? average : null;
  };

  const modelFromDesign = (design) => {
    const title = firstString(design.title);
    if (!title) return null;

    const instances = Array.isArray(design.instances) ? design.instances : [];
    const profileId = selectedProfileId();
    const selected = profileId ? instances.find((instance) => String(instance?.id) === profileId) : null;

    const pictures = Array.isArray(design.designExtension?.design_pictures) ? design.designExtension.design_pictures : [];

    return {
      id: String(design.id),
      title,
      author: firstString(design.designCreator?.name),
      sourceUrl: window.location.href,
      rating: profileRating(selected),
      reviewCount: count(design.commentCount),
      downloadCount: count(design.downloadCount),
      images: uniq([design.coverUrl, ...pictures.map((picture) => picture?.url)].map(absolute)),
      files: instances
        .map((instance) => {
          const name = firstString(instance?.title);
          if (!name) return null;
          return { name, fileType: instance.extention?.modelInfo?.f3mf ? '3mf' : null, downloadUrl: null };
        })
        .filter(Boolean),
    };
  };

  const modelFromDom = () => {
    const domTitle =
      text(document.querySelector('h1')?.textContent) ||
      text(document.querySelector('meta[property="og:title"]')?.getAttribute('content')) ||
      text(document.title).replace(/\s*[-|].*$/, '');

    if (!domTitle) return null;

    const author =
      text(document.querySelector('[href*="/user/"]')?.textContent) ||
      text(document.querySelector('[class*="author"], [class*="designer"]')?.textContent) ||
      null;

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
      id: modelIdFromPath(),
      title: domTitle,
      author,
      sourceUrl: window.location.href,
      rating: null,
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

  const extractModel = async () => {
    const modelId = modelIdFromPath();
    const design = modelId ? await loadDesign(modelId) : null;
    return (design && modelFromDesign(design)) || modelFromDom();
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
      const currentUrl = window.location.href;
      const pageKind = currentPageKind();
      const detectedModel = pageKind === 'model' ? await extractModel() : null;
      if (window.location.href !== currentUrl) return;
      const payload = {
        currentUrl,
        pageKind,
        detectedModel,
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
  window.addEventListener('hashchange', () => report('hashchange'));
  window.addEventListener('load', () => report('load'));

  const observer = new MutationObserver(() => report('mutation'));
  observer.observe(document.documentElement, { childList: true, subtree: true });

  report('bootstrap');
})();
