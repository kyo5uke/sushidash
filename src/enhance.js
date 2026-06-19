/* sushida-cache: canvas fade-in + 広告遅延ロード */
(function () {
  'use strict';

  if (window.__sushidaCacheEnhance) return;
  window.__sushidaCacheEnhance = true;

  const CONFIG = Object.freeze({
    AD_SCRIPT_PATTERN: /pagead2\.googlesyndication\.com|adsbygoogle\.js/i,
    AD_DELAY_AFTER_FIRST_DRAW_MS: 1500,
    CANVAS_FADE_DURATION_MS: 500,
    FAILSAFE_TIMEOUT_MS: 30_000,
    LOG_PREFIX: '[sushida-cache]',
    CANVAS_VISIBLE_CLASS: 'sushida-cache-canvas-shown',
  });

  const log = (...args) => console.log(CONFIG.LOG_PREFIX, ...args);
  log('enhance script initialized');

  // ---- canvas fade-in 用 CSS ----
  function injectFadeCSS() {
    const css = `
      #gameContainer {
        background: #000 !important;
      }
      #gameContainer canvas {
        opacity: 0;
        transition: opacity ${CONFIG.CANVAS_FADE_DURATION_MS}ms ease-in;
      }
      #gameContainer canvas.${CONFIG.CANVAS_VISIBLE_CLASS} {
        opacity: 1;
      }
    `;
    const style = document.createElement('style');
    style.id = 'sushida-cache-fade-style';
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
  }
  injectFadeCSS();

  // ---- adsbygoogle スタブ (push() を落とさない) ----
  if (!Array.isArray(window.adsbygoogle)) {
    window.adsbygoogle = [];
  }

  // ---- 広告スクリプトの捕獲 ----
  const deferredScripts = [];

  function isAdScript(node) {
    return (
      node.nodeType === Node.ELEMENT_NODE &&
      node.tagName === 'SCRIPT' &&
      typeof node.src === 'string' &&
      CONFIG.AD_SCRIPT_PATTERN.test(node.src)
    );
  }

  function captureAdScript(node) {
    deferredScripts.push({
      src: node.src,
      async: node.async,
      crossOrigin: node.crossOrigin,
    });
    node.parentNode?.removeChild(node);
    log('deferred:', node.src);
  }

  const adObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (isAdScript(node)) captureAdScript(node);
      }
    }
  });
  adObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  // ---- 広告の解放 (再挿入) ----
  let adsReleased = false;

  function releaseAds(reason) {
    if (adsReleased) return;
    adsReleased = true;
    adObserver.disconnect();

    log(`releasing ads (trigger: ${reason}, count: ${deferredScripts.length})`);

    for (const info of deferredScripts) {
      const script = document.createElement('script');
      script.src = info.src;
      if (info.async) script.async = true;
      if (info.crossOrigin) script.crossOrigin = info.crossOrigin;
      (document.head || document.documentElement).appendChild(script);
    }
  }

  // ---- canvas fade-in 発火 ----
  function showCanvas(canvas) {
    if (canvas.classList.contains(CONFIG.CANVAS_VISIBLE_CLASS)) return;
    canvas.classList.add(CONFIG.CANVAS_VISIBLE_CLASS);
    log(`canvas faded in (${CONFIG.CANVAS_FADE_DURATION_MS}ms transition)`);
  }

  // ---- canvas 初回描画の検出 (Unity WebGL) ----
  function isWebGLType(type) {
    return (
      type === 'webgl' ||
      type === 'webgl2' ||
      type === 'experimental-webgl'
    );
  }

  function hookFirstDraw(ctx, canvas) {
    let firstDrawSeen = false;

    for (const methodName of ['drawArrays', 'drawElements']) {
      const original = ctx[methodName].bind(ctx);
      ctx[methodName] = function (...args) {
        if (!firstDrawSeen) {
          firstDrawSeen = true;
          log(`canvas first draw via ${methodName}`);
          showCanvas(canvas);
          setTimeout(
            () => releaseAds(`first-draw + ${CONFIG.AD_DELAY_AFTER_FIRST_DRAW_MS}ms`),
            CONFIG.AD_DELAY_AFTER_FIRST_DRAW_MS,
          );
        }
        return original(...args);
      };
    }
  }

  const originalGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
    const canvas = this;
    const ctx = originalGetContext.call(canvas, type, ...rest);
    if (ctx && isWebGLType(type) && !ctx.__sushidaCacheHooked) {
      ctx.__sushidaCacheHooked = true;
      hookFirstDraw(ctx, canvas);
    }
    return ctx;
  };

  // ---- failsafe: first draw が来なくても広告は出す ----
  setTimeout(
    () => releaseAds(`failsafe (${CONFIG.FAILSAFE_TIMEOUT_MS / 1000}s)`),
    CONFIG.FAILSAFE_TIMEOUT_MS,
  );
})();
