/* sushidash: Web.data.unityweb runtime patcher */
(function () {
  'use strict';

  if (window.__sushidaCacheInstalled) return;
  window.__sushidaCacheInstalled = true;

  // ---- 設定 ----
  const LOG_PREFIX = '[sushidash]';
  const log = (...a) => console.log(LOG_PREFIX, ...a);
  const warn = (...a) => console.warn(LOG_PREFIX, ...a);

  const PATCH_PATTERN = /Web\.data\.unityweb(\?|$)/;
  const INTERCEPT_PATTERN = /Web\.(data|wasm\.(code|framework))\.unityweb(\?|$)/;
  const CACHE_NAME = 'sushidash-v1';

  // block 0 内で一意な 24 byte。idx 12 の 0x01 (splash bool) を 0x00 に書換
  const SPLASH_CONTEXT_OLD = new Uint8Array([
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x80, 0x3F,
    0x01,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x80, 0x3F,
    0x00, 0x00, 0x00, 0x00,
  ]);
  const SPLASH_TARGET_INDEX = 12;
  const SPLASH_NEW_BYTE = 0x00;

  // ---- LZ4 ブロックデコーダ ----
  function lz4Decode(src, dstSize) {
    const dst = new Uint8Array(dstSize);
    let sp = 0;
    let dp = 0;
    const srcEnd = src.length;

    while (sp < srcEnd) {
      const token = src[sp++];

      let litLen = token >>> 4;
      if (litLen === 15) {
        let b;
        do {
          b = src[sp++];
          litLen += b;
        } while (b === 255);
      }
      for (let i = 0; i < litLen; i++) dst[dp++] = src[sp++];

      if (sp >= srcEnd) break;

      const offset = src[sp] | (src[sp + 1] << 8);
      sp += 2;

      let matchLen = (token & 0x0F) + 4;
      if (matchLen - 4 === 15) {
        let b;
        do {
          b = src[sp++];
          matchLen += b;
        } while (b === 255);
      }

      const mp = dp - offset;
      for (let i = 0; i < matchLen; i++) {
        dst[dp++] = dst[mp + i];
      }
    }

    return dst;
  }

  // ---- バイト列ユーティリティ ----
  function findSequence(haystack, needle) {
    const hl = haystack.length;
    const nl = needle.length;
    outer: for (let i = 0; i <= hl - nl; i++) {
      for (let j = 0; j < nl; j++) {
        if (haystack[i + j] !== needle[j]) continue outer;
      }
      return i;
    }
    return -1;
  }

  function readCStr(bytes, pos) {
    let end = pos;
    while (end < bytes.length && bytes[end] !== 0) end++;
    return {
      str: new TextDecoder('utf-8').decode(bytes.subarray(pos, end)),
      next: end + 1,
    };
  }

  // ---- メインパッチ (失敗時は元のバイト列を返す = フェイルセーフ) ----
  function patchWebData(bytes) {
    try {
      const t0 = performance.now();
      const result = applyPatch(bytes);
      const dt = (performance.now() - t0).toFixed(1);
      log(`web.data patched in ${dt}ms: ${bytes.length} → ${result.length} B`);
      return result;
    } catch (err) {
      warn('patch failed, falling back to original:', err);
      return bytes;
    }
  }

  function applyPatch(bytes) {
    const td = new TextDecoder('utf-8');
    const enc = new TextEncoder();
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    // UnityWebData1.0 コンテナ
    const magic = td.decode(bytes.subarray(0, 16));
    if (magic !== 'UnityWebData1.0\0') {
      throw new Error(`bad UnityWebData magic: ${JSON.stringify(magic)}`);
    }
    const headerLen = dv.getUint32(16, true);

    const entries = [];
    let pos = 20;
    while (pos < headerLen) {
      const offset = dv.getUint32(pos, true); pos += 4;
      const size = dv.getUint32(pos, true); pos += 4;
      const nameLen = dv.getUint32(pos, true); pos += 4;
      const name = td.decode(bytes.subarray(pos, pos + nameLen));
      pos += nameLen;
      entries.push({ name, offset, size });
    }

    const u3dIdx = entries.findIndex(e => e.name.endsWith('data.unity3d'));
    if (u3dIdx < 0) throw new Error('data.unity3d entry not found');
    const u3d = entries[u3dIdx];

    // UnityFS bundle ヘッダ
    const bundle = bytes.subarray(u3d.offset, u3d.offset + u3d.size);
    const bdv = new DataView(bundle.buffer, bundle.byteOffset, bundle.byteLength);

    const sigR = readCStr(bundle, 0);
    if (sigR.str !== 'UnityFS') throw new Error(`bad UnityFS signature: ${sigR.str}`);
    let p = sigR.next;
    const fmt = bdv.getInt32(p, false); p += 4;
    const verR = readCStr(bundle, p); p = verR.next;
    const revR = readCStr(bundle, p); p = revR.next;
    p += 8;  // total_size (後で再計算)
    const ciBlockSize = bdv.getUint32(p, false); p += 4;
    const uiBlockSize = bdv.getUint32(p, false); p += 4;
    const flags = bdv.getUint32(p, false); p += 4;
    const headerSize = p;

    // block_info (flags & 0x80 で末尾配置、flags & 0x3F で圧縮タイプ)
    const blockInfoAtEnd = (flags & 0x80) !== 0;
    const biPos = blockInfoAtEnd ? (bundle.length - ciBlockSize) : headerSize;
    const biCompressed = bundle.subarray(biPos, biPos + ciBlockSize);

    const biCompType = flags & 0x3F;
    let biData;
    if (biCompType === 0) {
      biData = new Uint8Array(biCompressed);
    } else if (biCompType === 2 || biCompType === 3) {
      biData = lz4Decode(biCompressed, uiBlockSize);
    } else {
      throw new Error(`unsupported block_info compression: ${biCompType}`);
    }

    const biDv = new DataView(biData.buffer, biData.byteOffset, biData.byteLength);
    let bp = 16;
    const blockCount = biDv.getUint32(bp, false); bp += 4;

    const blocks = [];
    for (let i = 0; i < blockCount; i++) {
      blocks.push({
        uSize: biDv.getUint32(bp, false),
        cSize: biDv.getUint32(bp + 4, false),
        flags: biDv.getUint16(bp + 8, false),
      });
      bp += 10;
    }
    const nodesData = biData.subarray(bp);

    // block 0 を展開
    const dataBlocksStart = blockInfoAtEnd ? headerSize : (headerSize + ciBlockSize);
    const block0 = blocks[0];
    const block0Compressed = bundle.subarray(dataBlocksStart, dataBlocksStart + block0.cSize);

    const block0Type = block0.flags & 0x3F;
    let block0Data;
    if (block0Type === 0) {
      block0Data = new Uint8Array(block0Compressed);
    } else if (block0Type === 2 || block0Type === 3) {
      block0Data = lz4Decode(block0Compressed, block0.uSize);
    } else {
      throw new Error(`unsupported block 0 compression: ${block0Type}`);
    }
    if (block0Data.length !== block0.uSize) {
      throw new Error(`block 0 decompressed size mismatch: ${block0Data.length} vs ${block0.uSize}`);
    }

    // splash byte の特定とパッチ
    const ctxIdx = findSequence(block0Data, SPLASH_CONTEXT_OLD);
    if (ctxIdx < 0) {
      const patchedCtx = new Uint8Array(SPLASH_CONTEXT_OLD);
      patchedCtx[SPLASH_TARGET_INDEX] = SPLASH_NEW_BYTE;
      if (findSequence(block0Data, patchedCtx) >= 0) {
        log('splash already patched, returning original bytes');
        return bytes;
      }
      throw new Error('splash byte context not found in block 0');
    }
    const targetIdx = ctxIdx + SPLASH_TARGET_INDEX;
    block0Data[targetIdx] = SPLASH_NEW_BYTE;
    log(`splash byte patched at block 0 offset ${targetIdx}`);

    // block 0 を無圧縮として書き戻す (LZ4 エンコーダ実装回避)
    const newBlock0 = {
      uSize: block0.uSize,
      cSize: block0.uSize,
      flags: block0.flags & ~0x3F,
    };
    const newBlocks = [newBlock0, ...blocks.slice(1)];

    let cursor = dataBlocksStart + block0.cSize;
    const restCompressed = [];
    for (let i = 1; i < blockCount; i++) {
      const blk = blocks[i];
      restCompressed.push(bundle.subarray(cursor, cursor + blk.cSize));
      cursor += blk.cSize;
    }

    // block_info を無圧縮で再構築
    const newBiSize = 16 + 4 + (10 * blockCount) + nodesData.length;
    const newBi = new Uint8Array(newBiSize);
    const newBiDv = new DataView(newBi.buffer);
    newBi.set(biData.subarray(0, 16), 0);
    let nbp = 16;
    newBiDv.setUint32(nbp, blockCount, false); nbp += 4;
    for (const b of newBlocks) {
      newBiDv.setUint32(nbp, b.uSize, false); nbp += 4;
      newBiDv.setUint32(nbp, b.cSize, false); nbp += 4;
      newBiDv.setUint16(nbp, b.flags, false); nbp += 2;
    }
    newBi.set(nodesData, nbp);

    const newCiBlockSize = newBi.length;
    const newUiBlockSize = newBi.length;
    const newBundleFlags = flags & ~0x3F;

    let dataSectionSize = newBlock0.cSize;
    for (const b of restCompressed) dataSectionSize += b.length;

    // 新 bundle 構築
    const newBundleSize = headerSize + newCiBlockSize + dataSectionSize;
    const newBundle = new Uint8Array(newBundleSize);
    const newBundleDv = new DataView(newBundle.buffer);

    let np = 0;
    const sigBytes = enc.encode(sigR.str);
    newBundle.set(sigBytes, np); np += sigBytes.length;
    newBundle[np++] = 0;
    newBundleDv.setInt32(np, fmt, false); np += 4;
    const verBytes = enc.encode(verR.str);
    newBundle.set(verBytes, np); np += verBytes.length;
    newBundle[np++] = 0;
    const revBytes = enc.encode(revR.str);
    newBundle.set(revBytes, np); np += revBytes.length;
    newBundle[np++] = 0;
    newBundleDv.setUint32(np, 0, false); np += 4;  // total_size hi32
    newBundleDv.setUint32(np, newBundleSize, false); np += 4;  // total_size lo32
    newBundleDv.setUint32(np, newCiBlockSize, false); np += 4;
    newBundleDv.setUint32(np, newUiBlockSize, false); np += 4;
    newBundleDv.setUint32(np, newBundleFlags, false); np += 4;

    if (np !== headerSize) {
      throw new Error(`bundle header rebuild mismatch: ${np} vs ${headerSize}`);
    }

    if (blockInfoAtEnd) {
      newBundle.set(block0Data, np); np += block0Data.length;
      for (const b of restCompressed) {
        newBundle.set(b, np); np += b.length;
      }
      newBundle.set(newBi, np); np += newBi.length;
    } else {
      newBundle.set(newBi, np); np += newBi.length;
      newBundle.set(block0Data, np); np += block0Data.length;
      for (const b of restCompressed) {
        newBundle.set(b, np); np += b.length;
      }
    }

    if (np !== newBundleSize) {
      throw new Error(`new bundle size mismatch: ${np} vs ${newBundleSize}`);
    }

    // UnityWebData コンテナ再構築 (後続エントリの offset をシフト)
    const u3dDelta = newBundleSize - u3d.size;
    const newEntries = entries.map(e => {
      if (e === u3d) return { name: e.name, offset: e.offset, size: newBundleSize };
      if (e.offset > u3d.offset) return { name: e.name, offset: e.offset + u3dDelta, size: e.size };
      return { name: e.name, offset: e.offset, size: e.size };
    });

    const newHeader = new Uint8Array(headerLen);
    const newHeaderDv = new DataView(newHeader.buffer);
    newHeader.set(bytes.subarray(0, 16), 0);
    newHeaderDv.setUint32(16, headerLen, true);
    let nhp = 20;
    for (const e of newEntries) {
      const nameBytes = enc.encode(e.name);
      newHeaderDv.setUint32(nhp, e.offset, true); nhp += 4;
      newHeaderDv.setUint32(nhp, e.size, true); nhp += 4;
      newHeaderDv.setUint32(nhp, nameBytes.length, true); nhp += 4;
      newHeader.set(nameBytes, nhp); nhp += nameBytes.length;
    }
    if (nhp !== headerLen) {
      throw new Error(`UnityWebData header rebuild size mismatch: ${nhp} vs ${headerLen}`);
    }

    let totalSize = headerLen;
    for (const e of newEntries) {
      totalSize = Math.max(totalSize, e.offset + e.size);
    }

    const out = new Uint8Array(totalSize);
    out.set(newHeader, 0);

    const sortedNew = [...newEntries].sort((a, b) => a.offset - b.offset);
    for (const e of sortedNew) {
      if (e.name === u3d.name) {
        out.set(newBundle, e.offset);
      } else {
        const orig = entries.find(x => x.name === e.name);
        out.set(bytes.subarray(orig.offset, orig.offset + orig.size), e.offset);
      }
    }

    return out;
  }

  // ---- Cache Storage 層 ----
  function processBuffer(url, buffer) {
    if (!PATCH_PATTERN.test(url)) return buffer;
    const view = new Uint8Array(buffer);
    const patched = patchWebData(view);
    return (patched.byteOffset === 0 && patched.byteLength === patched.buffer.byteLength)
      ? patched.buffer
      : patched.buffer.slice(patched.byteOffset, patched.byteOffset + patched.byteLength);
  }

  async function cacheGet(url) {
    try {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(url);
      if (cached) return await cached.arrayBuffer();
    } catch (e) { warn('cacheGet failed:', e); }
    return null;
  }

  async function cachePut(url, buffer) {
    try {
      const cache = await caches.open(CACHE_NAME);
      const response = new Response(buffer, {
        status: 200,
        statusText: 'OK',
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': String(buffer.byteLength),
        },
      });
      await cache.put(url, response);
      log(`cache stored: ${url.split('/').pop()} (${buffer.byteLength.toLocaleString()} B)`);
    } catch (e) { warn('cachePut failed:', e); }
  }

  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persist().then(p => log(`storage persist: ${p}`));
  }

  // ---- XMLHttpRequest override ----
  const RealXHR = window.XMLHttpRequest;

  class PatchedXHR extends RealXHR {
    constructor() {
      super();
      this.__sushidaUrl = null;
      this.__sushidaIntercept = false;
      this.__sushidaServedFromCache = false;

      // Unity の onload より先に発火させ、response を own property で shadow
      this.addEventListener('load', () => {
        if (!this.__sushidaIntercept || this.__sushidaServedFromCache) return;
        if (this.status !== 200 && this.status !== 0) return;
        const orig = this.response;
        if (!orig) return;
        try {
          const buf = orig instanceof ArrayBuffer ? orig
            : (ArrayBuffer.isView(orig)
              ? orig.buffer.slice(orig.byteOffset, orig.byteOffset + orig.byteLength)
              : null);
          if (!buf) return;

          const processed = processBuffer(this.__sushidaUrl, buf);
          Object.defineProperty(this, 'response', {
            value: processed, writable: true, configurable: true, enumerable: true,
          });
          cachePut(this.__sushidaUrl, processed);
        } catch (err) {
          warn('XHR load handler error:', err);
        }
      });
    }

    open(method, url, asyncFlag = true, user, password) {
      this.__sushidaUrl = url;
      this.__sushidaIntercept = INTERCEPT_PATTERN.test(String(url));
      if (this.__sushidaIntercept) log(`intercepting XHR: ${url}`);
      return super.open(method, url, asyncFlag, user, password);
    }

    send(...args) {
      if (!this.__sushidaIntercept) return super.send(...args);
      cacheGet(this.__sushidaUrl).then(buf => {
        if (buf) {
          this.__sushidaServedFromCache = true;
          log(`cache hit (XHR): ${this.__sushidaUrl.split('/').pop()} (${buf.byteLength.toLocaleString()} B)`);
          fakeXHRLoad(this, buf);
        } else {
          super.send(...args);
        }
      });
    }
  }

  function fakeXHRLoad(xhr, buffer) {
    Object.defineProperty(xhr, 'readyState', { value: 4, writable: true, configurable: true });
    Object.defineProperty(xhr, 'status', { value: 200, writable: true, configurable: true });
    Object.defineProperty(xhr, 'statusText', { value: 'OK', writable: true, configurable: true });
    Object.defineProperty(xhr, 'response', { value: buffer, writable: true, configurable: true, enumerable: true });
    Object.defineProperty(xhr, 'responseURL', { value: xhr.__sushidaUrl, writable: true, configurable: true });
    Promise.resolve().then(() => {
      xhr.dispatchEvent(new Event('readystatechange'));
      xhr.dispatchEvent(new ProgressEvent('load', {
        loaded: buffer.byteLength, total: buffer.byteLength, lengthComputable: true,
      }));
      xhr.dispatchEvent(new ProgressEvent('loadend', {
        loaded: buffer.byteLength, total: buffer.byteLength, lengthComputable: true,
      }));
    });
  }

  window.XMLHttpRequest = PatchedXHR;
  log('patcher initialized (XHR override active)');

  // ---- fetch override ----
  const realFetch = window.fetch.bind(window);
  window.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (!INTERCEPT_PATTERN.test(url)) return realFetch(input, init);

    log(`intercepting fetch: ${url}`);
    const cached = await cacheGet(url);
    if (cached) {
      log(`cache hit (fetch): ${url.split('/').pop()} (${cached.byteLength.toLocaleString()} B)`);
      return new Response(cached, {
        status: 200, statusText: 'OK',
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': String(cached.byteLength),
        },
      });
    }
    const response = await realFetch(input, init);
    if (!response.ok) return response;
    const raw = await response.arrayBuffer();
    const processed = processBuffer(url, raw);
    cachePut(url, processed);
    return new Response(processed, {
      status: 200, statusText: 'OK',
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': String(processed.byteLength),
      },
    });
  };

  // ---- prefetch (PREFETCH_VERSION はハードコード。404 は warn でバージョン更新を促す) ----
  const PREFETCH_VERSION = 'v1_3';
  const PREFETCH_PATHS = [
    `/files/${PREFETCH_VERSION}/Web.data.unityweb`,
    `/files/${PREFETCH_VERSION}/Web.wasm.code.unityweb`,
    `/files/${PREFETCH_VERSION}/Web.wasm.framework.unityweb`,
  ];
  for (const path of PREFETCH_PATHS) {
    fetch(location.origin + path, { credentials: 'omit' })
      .then(r => {
        if (r.ok) {
          log(`prefetched: ${path.split('/').pop()}`);
        } else {
          warn(
            `prefetch ${r.status} for ${path} — ` +
            `サイト側がファイルバージョンを更新した可能性があります ` +
            `(patcher.js の PREFETCH_VERSION="${PREFETCH_VERSION}" を確認してください)`
          );
        }
      })
      .catch(() => { });
  }
})();
