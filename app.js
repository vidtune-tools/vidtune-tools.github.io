/* VidTune app: converter UI and conversion engines. Loads after core.js (window.VT). */
(() => {
'use strict';
const { FORMATS, defaultQuality, qualityOf, kindFromFile, fmtBytes, fmtDur, baseName, extOf, encodeWav, LAME_RATES, ffmpegArgs } = window.VT;

/* ==========================================================================
   1. CONFIG
   ========================================================================== */
const CONFIG = {
  LIMITS: { maxInputMB: 300 },
  /* MP3 encoder (lamejs). Tried in order; the first that loads wins. */
  LAME_URLS: ['/assets/vendor/lame.min.js', 'https://cdnjs.cloudflare.com/ajax/libs/lamejs/1.2.1/lame.min.js', 'https://cdn.jsdelivr.net/npm/lamejs@1.2.1/lame.min.js', 'https://unpkg.com/lamejs@1.2.1/lame.min.js'],
  /* ffmpeg.wasm, self-hosted on your own origin (run setup-ffmpeg.sh once). Needed for M4A, MP4, WebM. */
  FFMPEG: { lib: '/assets/ffmpeg/lib/index.js', core: '/assets/ffmpeg/core/ffmpeg-core.js', wasm: '/assets/ffmpeg/core/ffmpeg-core.wasm' },
  ADS: { enabled: true, slots: {
    convert: { id: 'CONVERSION_RECT', dims: '300×250' },
    post:    { id: 'POST_RESULT_RECT', dims: '300×250' } } }
};

/* ==========================================================================
   2. UTILITIES
   ========================================================================== */
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
const tick = () => new Promise(r => setTimeout(r, 0));
const abortErr = () => new DOMException('Aborted', 'AbortError');
const throwIfAborted = s => { if (s && s.aborted) throw abortErr(); };
const safeName = n => (baseName(n).replace(/[\\/:*?"<>|]+/g, '-').trim().slice(0, 100)) || 'converted';
const live = $('#live');
function announce(msg) { live.textContent = ''; setTimeout(() => { live.textContent = msg; }, 30); }
class ServiceError extends Error { constructor(code) { super(code); this.code = code; } }

/* ==========================================================================
   3. CONVERSION ENGINES
   convertFile(file, { format, quality, kind }, { signal, report(pct, stageIdx), stages(labels) }) -> { blob, durationSec }
   - audio engine: Web Audio decode + JS encoders (MP3, WAV). Small download, fast.
   - ffmpeg engine: ffmpeg.wasm for M4A / MP4 / WebM, and as a fallback for files the browser can't decode.
   Files never leave the device.
   ========================================================================== */
const scriptCache = {};
function loadScriptFrom(urls, isReady, failCode) {
  const key = urls.join('|');
  if (isReady()) return Promise.resolve();
  if (scriptCache[key]) return scriptCache[key];
  return (scriptCache[key] = (async () => {
    for (const url of urls) {
      try {
        await new Promise((res, rej) => {
          const t = setTimeout(() => rej(new Error('timeout')), 15000);
          const s = document.createElement('script'); s.src = url; s.async = true;
          s.onload = () => { clearTimeout(t); res(); }; s.onerror = () => { clearTimeout(t); s.remove(); rej(new Error('load')); };
          document.head.appendChild(s);
        });
        if (isReady()) return;          // a 200 response that isn't the real library (e.g. an HTML fallback page) doesn't count
      } catch { /* try the next source */ }
    }
    delete scriptCache[key];
    throw new ServiceError(failCode);
  })());
}

/* ---- audio engine ---- */
function decodeAudio(arrayBuffer) {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) throw new ServiceError('unsupported_input');
  const ctx = new AC();
  return new Promise((res, rej) => {
    const p = ctx.decodeAudioData(arrayBuffer, res, rej);
    if (p && p.catch) p.catch(rej);
  }).finally(() => { try { ctx.close(); } catch {} });
}
async function normalize(buf, needLame) {
  const ok = buf.numberOfChannels <= 2 && (!needLame || LAME_RATES.includes(buf.sampleRate));
  if (ok) return buf;
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!OAC) throw new ServiceError('unsupported_input');
  const rate = needLame && !LAME_RATES.includes(buf.sampleRate) ? 44100 : buf.sampleRate;
  const off = new OAC(Math.min(2, buf.numberOfChannels), Math.ceil(buf.duration * rate), rate);
  const src = off.createBufferSource(); src.buffer = buf; src.connect(off.destination); src.start(0);
  return off.startRendering();
}
async function encodeMp3(buf, kbps, signal, progress) {
  await loadScriptFrom(CONFIG.LAME_URLS, () => !!(window.lamejs && window.lamejs.Mp3Encoder), 'encoder_load');
  const ch = Math.min(2, buf.numberOfChannels);
  const enc = new window.lamejs.Mp3Encoder(ch, buf.sampleRate, kbps);
  const L = window.VT.floatTo16(buf.getChannelData(0)), R = ch > 1 ? window.VT.floatTo16(buf.getChannelData(1)) : null;
  const block = 1152 * 16, parts = [];
  for (let i = 0, n = 0; i < L.length; i += block, n++) {
    throwIfAborted(signal);
    const d = R ? enc.encodeBuffer(L.subarray(i, i + block), R.subarray(i, i + block)) : enc.encodeBuffer(L.subarray(i, i + block));
    if (d.length) parts.push(d.slice());
    if (n % 8 === 0) { progress(i / L.length); await tick(); }
  }
  const end = enc.flush(); if (end.length) parts.push(end.slice());
  return new Blob(parts, { type: 'audio/mpeg' });
}
async function audioConvert(file, format, quality, { signal, report, stages }) {
  const q = qualityOf(format, quality);
  stages(['Reading file', 'Decoding audio', `Encoding ${FORMATS[format].label}${format === 'mp3' ? ' at ' + q.label : ''}`, 'Finishing']);
  report(0, 0);
  const ab = await file.arrayBuffer(); throwIfAborted(signal);
  report(8, 1);
  let buf; try { buf = await decodeAudio(ab); } catch (e) { if (e instanceof ServiceError) throw e; throw new ServiceError('unsupported_input'); }
  throwIfAborted(signal); report(30, 2);
  buf = await normalize(buf, format === 'mp3'); throwIfAborted(signal);
  let blob;
  if (format === 'wav') { await tick(); blob = new Blob([encodeWav(buf)], { type: 'audio/wav' }); }
  else blob = await encodeMp3(buf, q.kbps, signal, p => report(30 + Math.round(p * 65), 2));
  throwIfAborted(signal); report(100, 3);
  return { blob, durationSec: Math.round(buf.duration) };
}

/* ---- ffmpeg engine ---- */
const FF = { ff: null, loading: null, onPct: () => {} };
async function prefetch(url, onPct) {
  let res; try { res = await fetch(url); } catch { throw new ServiceError('engine_load'); }
  if (!res.ok) throw new ServiceError('engine_load');
  const total = +res.headers.get('content-length') || 0;
  if (!res.body || !total) { await res.arrayBuffer(); onPct(100); return; }
  const reader = res.body.getReader(); let got = 0;
  for (;;) { const { done, value } = await reader.read(); if (done) break; got += value.length; onPct(Math.min(100, Math.round(got / total * 100))); }
}
function getFFmpeg() {
  if (FF.ff) return Promise.resolve(FF.ff);
  if (!FF.loading) {
    FF.loading = (async () => {
      try {
        await prefetch(CONFIG.FFMPEG.wasm, p => FF.onPct(p));   // warms the HTTP cache and gives us progress
        const mod = await import(CONFIG.FFMPEG.lib);
        const ff = new mod.FFmpeg();
        await ff.load({ coreURL: CONFIG.FFMPEG.core, wasmURL: CONFIG.FFMPEG.wasm });
        FF.ff = ff; return ff;
      } catch (e) { throw e instanceof ServiceError ? e : new ServiceError('engine_load'); }
      finally { FF.loading = null; }
    })();
  }
  return FF.loading;
}
async function ffmpegConvert(file, format, quality, inputKind, { signal, report, stages }) {
  const f = FORMATS[format], q = qualityOf(format, quality);
  stages(['Loading engine', 'Reading file', `Converting to ${f.label} (${q.label})`, 'Finishing']);
  const audioToVideo = f.kind === 'video' && inputKind === 'audio';
  report(0, 0);
  FF.onPct = p => report(Math.round(p * 0.2), 0);
  const ff = await getFFmpeg(); throwIfAborted(signal);
  report(20, 1);
  const inName = 'input.' + (extOf(file.name).replace(/[^a-z0-9]/g, '').slice(0, 5) || 'bin'), outName = 'output.' + f.ext;
  const logs = [];
  const onLog = ({ message }) => { logs.push(message); if (logs.length > 80) logs.shift(); };
  const onProgress = ({ progress }) => { if (isFinite(progress)) report(25 + Math.round(Math.max(0, Math.min(1, progress)) * 70), 2); };
  const abort = () => { try { ff.terminate(); } catch {} FF.ff = null; };
  signal && signal.addEventListener('abort', abort, { once: true });
  ff.on('log', onLog); ff.on('progress', onProgress);
  try {
    await ff.writeFile(inName, new Uint8Array(await file.arrayBuffer()));
    throwIfAborted(signal); report(25, 2);
    const code = await ff.exec(ffmpegArgs(inName, outName, format, quality, inputKind));
    throwIfAborted(signal);
    if (code !== 0) {
      const text = logs.join('\n');
      if (/does not contain any stream|matches no streams|specified through -vf|Stream specifier|no video/i.test(text)) throw new ServiceError(f.kind === 'video' ? 'no_video' : 'unsupported_input');
      if (/Invalid data found|could not find codec|Unsupported|Unknown decoder/i.test(text)) throw new ServiceError('unsupported_input');
      throw new ServiceError('failed');
    }
    const data = await ff.readFile(outName);
    report(100, 3);
    return { blob: new Blob([data], { type: f.mime }), durationSec: null };
  } catch (e) {
    if (signal && signal.aborted) throw abortErr();
    if (e instanceof ServiceError) throw e;
    if (/memory|alloc/i.test(String(e && e.message))) throw new ServiceError('out_of_memory');
    throw new ServiceError('failed');
  } finally {
    signal && signal.removeEventListener('abort', abort);
    try { ff.off('log', onLog); ff.off('progress', onProgress); } catch {}
    try { if (FF.ff) { await ff.deleteFile(inName); await ff.deleteFile(outName); } } catch {}
  }
}

async function convertFile(file, opts, hooks) {
  const { format, quality } = opts;
  if (FORMATS[format].engine === 'audio') {
    try { return await audioConvert(file, format, quality, hooks); }
    catch (first) {
      if (!(first instanceof ServiceError) || !['unsupported_input', 'encoder_load'].includes(first.code)) throw first;
      /* the browser couldn't decode it, or the MP3 encoder didn't load: try ffmpeg. If that fails too, report the original problem. */
      try { return await ffmpegConvert(file, format, quality, opts.kind, hooks); }
      catch (second) { if (second instanceof ServiceError && second.code === 'engine_load') throw first; throw second; }
    }
  }
  return ffmpegConvert(file, format, quality, opts.kind, hooks);
}

/* ==========================================================================
   4. PROBE: read duration and dimensions with a media element
   ========================================================================== */
function probeMedia(file, kind0) {
  if (kind0 === 'audio') {
    return new Promise(res => {
      const url = URL.createObjectURL(file), el = document.createElement('audio'); el.preload = 'metadata';
      const done = m => { clearTimeout(t); URL.revokeObjectURL(url); el.removeAttribute('src'); res(m); };
      const t = setTimeout(() => done({ kind: 'audio' }), 4000);
      el.onloadedmetadata = () => done({ kind: 'audio', durationSec: isFinite(el.duration) ? Math.round(el.duration) : null });
      el.onerror = () => done({ kind: 'audio' });
      el.src = url;
    });
  }
  return new Promise(res => {
    const url = URL.createObjectURL(file), el = document.createElement('video'); el.preload = 'metadata'; el.muted = true;
    const done = m => { clearTimeout(t); URL.revokeObjectURL(url); el.removeAttribute('src'); res(m); };
    const t = setTimeout(() => done({ kind: 'unknown' }), 5000);
    el.onloadedmetadata = () => done({ kind: el.videoWidth > 0 ? 'video' : 'audio', durationSec: isFinite(el.duration) ? Math.round(el.duration) : null, width: el.videoWidth, height: el.videoHeight });
    el.onerror = () => done({ kind: 'unknown' });   // e.g. MKV/AVI: the browser can't play it, ffmpeg may still convert it
    el.src = url;
  });
}

/* ==========================================================================
   5. ERROR COPY
   ========================================================================== */
const ERRORS = {
  unsupported_input: { title: "This file can't be read", body: "It isn't a supported audio or video file, or your browser can't open it. Try MP4, MOV, WebM, MP3, WAV or M4A.", actions: [['again', 'Choose another file']] },
  no_video: { title: 'This file has no video', body: 'Video formats need a file that contains video. Choose MP3, WAV or M4A instead.', actions: [['format', 'Choose an audio format'], ['again', 'Choose another file']] },
  too_large: { title: 'That file is too large', body: `Files up to ${CONFIG.LIMITS.maxInputMB} MB work in the browser. Try a shorter clip.`, actions: [['again', 'Choose another file']] },
  engine_load: { title: "The conversion engine couldn't load", body: 'M4A, MP4 and WebM need a one-time download of about 30 MB. Check your connection and try again, or choose WAV, which needs no download.', actions: [['retry', 'Try again'], ['audioFmt', 'Choose WAV']] },
  encoder_load: { title: "The MP3 encoder couldn't load", body: 'MP3 conversion needs a small encoder that is fetched when you first use it. Check your connection and try again. WAV works without it.', actions: [['retry', 'Try again'], ['audioFmt', 'Choose WAV']] },
  out_of_memory: { title: 'Your device ran out of memory', body: 'Long or high-resolution files need a lot of memory. Try a shorter clip or a lower quality.', actions: [['quality', 'Choose lower quality'], ['again', 'Choose another file']] },
  failed: { title: "The conversion didn't finish", body: "Something went wrong while converting. Your file wasn't uploaded or changed. Try again, or try a different format.", actions: [['retry', 'Try again'], ['format', 'Choose another format']] }
};

/* ==========================================================================
   6. AD SLOTS (labelled placeholders; replace inner markup with AdSense units)
   ========================================================================== */
function ad(kind) {
  if (!CONFIG.ADS.enabled) return '';
  const s = CONFIG.ADS.slots[kind];
  return `<aside class="ad-wrap ad-wrap--${kind}" aria-label="Advertisement"><div class="ad ad--rect" data-slot="${s.id}"><span class="ad-tag">ADVERTISEMENT</span><span>${s.dims}</span></div></aside>`;
}

/* ==========================================================================
   7. CONVERTER COMPONENT   phases: idle -> processing -> done | error
   ========================================================================== */
const ICON_AUDIO = '<path d="M9 18V6l10-2v12"/><circle cx="6" cy="18" r="3"/><circle cx="16" cy="16" r="3"/>';
const ICON_VIDEO = '<path d="M3 5h18v14H3zM7 5v14M17 5v14M3 9h4M3 15h4M17 9h4M17 15h4"/>';
const svg = (p, s = 22) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;

function mountConverter(root, { formats, defaultFormat }) {
  const S = { phase: 'idle', file: null, meta: { kind: 'unknown' }, format: defaultFormat, quality: defaultQuality(defaultFormat),
              progress: 0, stageIdx: 0, stages: [], result: null, error: null };
  let ctl = null, seq = 0;

  root.innerHTML = `
  <section class="panel" aria-labelledby="panel-title">
    <header class="panel-head"><h2 id="panel-title" class="sr-only">Converter</h2>
      <ol class="stepper" id="stepper" aria-label="Progress"><li><span class="n">1</span>Add file</li><li><span class="n">2</span>Convert</li><li><span class="n">3</span>Download</li></ol></header>
    <div class="panel-body">
      <form id="src" novalidate>
        <input class="sr-only" type="file" id="file" accept="audio/*,video/*,.mkv,.avi,.flac,.opus,.wma,.aac,.m4a,.mov,.3gp,.wmv,.flv,.ts,.mpg,.mpeg,.aiff,.aif,.amr">
        <label class="drop" id="drop" for="file">
          <span class="drop-ico">${svg('<path d="M12 16V4M7 9l5-5 5 5M5 20h14"/>', 26)}</span>
          <b>Choose a file</b>
          <span>or drop it here</span>
          <span class="mono">MP4, MOV, WebM, MKV, MP3, WAV, M4A, FLAC and more</span>
        </label>
        <div class="preview" id="preview" aria-live="polite"></div>
        <p class="msg" id="fileMsg" role="alert"></p>
        <fieldset>
          <legend class="label">Convert to</legend>
          <div class="seg" id="seg">${formats.map(f => `<input type="radio" name="fmt" id="fmt-${f}" value="${f}"${f === defaultFormat ? ' checked' : ''}><label for="fmt-${f}">${FORMATS[f].label}</label>`).join('')}</div>
          <p class="hint mono" id="fmtNote"></p>
        </fieldset>
        <div class="controls">
          <div><label class="label" for="quality">Quality</label><div class="sel"><select id="quality"></select></div></div>
          <button class="btn btn--primary" type="submit" id="go">Convert</button>
        </div>
      </form>
      <div id="stage" hidden></div>
    </div>
    <footer class="panel-foot mono" id="status" aria-label="Status"></footer>
  </section>
  <p class="mono demo-note">Your file is converted on this device and is never uploaded. Convert only media you have the right to use.</p>`;

  const fileEl = $('#file', root), drop = $('#drop', root), preview = $('#preview', root), msg = $('#fileMsg', root), seg = $('#seg', root), fmtNote = $('#fmtNote', root);
  const qEl = $('#quality', root), src = $('#src', root), stage = $('#stage', root), stepper = $('#stepper', root), statusEl = $('#status', root), goBtn = $('#go', root);

  const cancel = () => { seq++; if (ctl) ctl.abort(); ctl = null; };
  const revoke = () => { if (S.result && S.result.url) URL.revokeObjectURL(S.result.url); S.result = null; };
  function inline(t) { msg.textContent = t || ''; }

  function fillQuality() {
    qEl.innerHTML = FORMATS[S.format].qualities.map(q => `<option value="${q.id}">${esc(q.label)}</option>`).join('');
    if (!FORMATS[S.format].qualities.some(q => q.id === S.quality)) S.quality = defaultQuality(S.format);
    qEl.value = S.quality; qEl.disabled = FORMATS[S.format].qualities.length < 2;
  }
  function renderStatus() {
    statusEl.innerHTML = `<span><i class="dot dot--ok"></i>Runs <b>on your device</b></span><span><i class="dot dot--ok"></i>Uploads <b>none</b></span>
      <span>Output <b>${FORMATS[S.format].label}</b></span><span>Limit <b>${CONFIG.LIMITS.maxInputMB} MB</b></span>`;
  }
  function setStep() {
    const idx = { idle: S.file ? 1 : 0, processing: 1, done: 3, error: S.file ? 1 : 0 }[S.phase];
    [...stepper.children].forEach((li, i) => { li.classList.toggle('done', i < idx); if (i === idx) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current'); });
  }
  function renderPreview() {
    drop.hidden = !!S.file;
    if (!S.file) { preview.innerHTML = ''; return; }
    const m = S.meta, kind = m.kind === 'audio' ? 'audio' : m.kind === 'video' ? 'video' : 'file';
    const bits = [fmtBytes(S.file.size), (extOf(S.file.name) || 'file').toUpperCase()];
    if (m.durationSec) bits.push(fmtDur(m.durationSec));
    if (m.width) bits.push(`${m.width}×${m.height}`);
    preview.innerHTML = `<div class="file-card"><span class="ico">${svg(m.kind === 'video' ? ICON_VIDEO : ICON_AUDIO)}</span>
      <div class="file-info"><div class="src-title">${esc(S.file.name)}</div><div class="src-meta mono">${bits.map(b => `<span>${esc(b)}</span>`).join('')}</div></div>
      <button type="button" class="link-btn" id="swap">Change</button></div>`;
    $('#swap', preview).addEventListener('click', () => fileEl.click());
  }
  function updateFormats() {
    const audioIn = S.meta.kind === 'audio';
    fmtNote.textContent = FORMATS[S.format].kind === 'video' && audioIn ? 'Audio files become a video with a plain dark screen and your audio.'
      : FORMATS[S.format].engine === 'ffmpeg' ? 'First use downloads a conversion engine (about 30 MB). Video conversion is slower than audio.' : '';
    renderStatus();
  }

  function setPhase(p) {
    S.phase = p;
    const idle = p === 'idle';
    src.hidden = !idle; stage.hidden = idle;
    if (!idle) { stage.innerHTML = renderStage(); const h = $('#stageH', stage); if (h) h.focus(); }
    setStep(); renderStatus();
    const say = { processing: 'Conversion started.', done: 'Conversion complete. Your file is ready to download.', error: S.error ? ERRORS[S.error].title : '' }[p];
    if (say) announce(say);
  }

  /* ---- stage renderers ---- */
  function logHTML() { return S.stages.map((n, i) => `<li class="${i < S.stageIdx ? 'done' : i === S.stageIdx ? 'now' : ''}">${esc(n)}</li>`).join(''); }
  function renderStage() {
    if (S.phase === 'processing') return `
      <h3 class="stage-h" id="stageH" tabindex="-1">Converting</h3>
      <p class="filename">${esc(S.file.name)}</p>
      <div class="scale" id="scale" role="progressbar" aria-label="Conversion progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><i id="fill"></i></div>
      <div class="prog-meta mono"><span id="pct">0%</span><span>Stays on this device</span></div>
      <ol class="log mono" id="log">${logHTML()}</ol>
      <div class="actions"><button class="btn btn--ghost" data-act="cancel" type="button">Cancel</button></div>
      ${ad('convert')}`;
    if (S.phase === 'done') {
      const r = S.result, f = FORMATS[S.format], q = qualityOf(S.format, S.quality);
      const player = f.kind === 'video' ? `<video class="player" controls playsinline preload="metadata" src="${r.url}"></video>` : `<audio class="player" controls preload="metadata" src="${r.url}"></audio>`;
      return `
      <div class="done-head"><svg class="tick" width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true"><circle cx="11" cy="11" r="10" stroke="currentColor" stroke-width="1.5"/><path d="M6.5 11.5l3 3 6-7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
        <h3 class="stage-h mono" id="stageH" tabindex="-1">Conversion complete</h3></div>
      <p class="filename">${esc(r.filename)}</p>
      ${player}
      <dl class="kv"><dt>Format</dt><dd>${f.label}</dd><dt>Quality</dt><dd>${esc(q.label)}</dd>
        <dt>Size</dt><dd>${fmtBytes(r.size)}<br><span style="color:var(--ink-3)">original ${fmtBytes(S.file.size)}</span></dd>
        ${r.durationSec ? `<dt>Duration</dt><dd>${fmtDur(r.durationSec)}</dd>` : ''}</dl>
      <div class="done-actions"><a class="btn btn--primary btn--dl" href="${r.url}" download="${esc(r.filename)}">Download</a>
        <button class="btn btn--ghost" data-act="edit" type="button">Convert to another format</button>
        <button class="btn btn--text" data-act="again" type="button">Convert another file</button></div>
      ${ad('post')}`;
    }
    if (S.phase === 'error') {
      const e = ERRORS[S.error] || ERRORS.failed;
      const btns = e.actions.filter(([a]) => !(a === 'retry' && !S.file)).map(([a, label], i) => `<button class="btn ${i === 0 ? 'btn--primary' : 'btn--ghost'}" data-act="${a}" type="button">${label}</button>`).join('');
      return `<p class="mono err-ref">Ref: ${esc(S.error)}</p><h3 class="stage-h" id="stageH" tabindex="-1">${esc(e.title)}</h3><p class="err-body">${esc(e.body)}</p><div class="actions">${btns}</div>`;
    }
    return '';
  }
  function updateProgress() {
    const fill = $('#fill', stage); if (!fill) return;
    fill.style.transform = `scaleX(${S.progress / 100})`;
    $('#pct', stage).textContent = `${S.progress}%`;
    $('#scale', stage).setAttribute('aria-valuenow', S.progress);
    $('#log', stage).innerHTML = logHTML();
  }

  /* ---- flows ---- */
  function fail(e) {
    S.error = e instanceof ServiceError && ERRORS[e.code] ? e.code : 'failed';
    setPhase('error');
  }
  async function setFile(file) {
    cancel(); revoke(); inline('');
    if (!file) return;
    const k0 = kindFromFile(file.name, file.type);
    if (!k0) { S.file = null; S.meta = { kind: 'unknown' }; renderPreview(); fail(new ServiceError('unsupported_input')); return; }
    if (file.size > CONFIG.LIMITS.maxInputMB * 1024 * 1024) { S.file = null; S.meta = { kind: 'unknown' }; renderPreview(); fail(new ServiceError('too_large')); return; }
    S.file = file; S.meta = { kind: k0 === 'audio' ? 'audio' : 'unknown' };
    if (S.phase !== 'idle') setPhase('idle');
    renderPreview(); updateFormats(); setStep();
    const meta = await probeMedia(file, k0);
    if (S.file !== file) return;
    S.meta = meta; renderPreview(); updateFormats();
  }
  async function run() {
    revoke(); S.progress = 0; S.stageIdx = 0; S.stages = ['Preparing'];
    setPhase('processing');
    cancel(); const mine = seq; ctl = new AbortController();
    try {
      const out = await convertFile(S.file, { format: S.format, quality: S.quality, kind: S.meta.kind }, {
        signal: ctl.signal,
        stages: l => { if (mine === seq) { S.stages = l; updateProgress(); } },
        report: (pct, idx) => { if (mine !== seq) return; const ch = idx !== S.stageIdx; S.progress = pct; S.stageIdx = idx; updateProgress(); if (ch) announce(S.stages[idx]); }
      });
      if (mine !== seq) return;
      S.result = { url: URL.createObjectURL(out.blob), size: out.blob.size, durationSec: out.durationSec || S.meta.durationSec || null,
                   filename: `${safeName(S.file.name)}.${FORMATS[S.format].ext}` };
      setPhase('done');
    } catch (e) {
      if ((e && e.name === 'AbortError') || mine !== seq) return;
      fail(e);
    }
  }
  function toIdle(focus) {
    setPhase('idle'); renderPreview(); updateFormats();
    if (focus === 'format') { const c = $('input[name=fmt]:checked', root); if (c) c.focus(); }
    else if (focus === 'quality') qEl.focus();
  }
  function reset() { cancel(); revoke(); S.file = null; S.meta = { kind: 'unknown' }; fileEl.value = ''; inline(''); toIdle(); updateFormats(); drop.focus && fileEl.focus(); }

  /* ---- events ---- */
  fileEl.addEventListener('change', () => { const f = fileEl.files && fileEl.files[0]; if (f) setFile(f); fileEl.value = ''; });
  ['dragenter', 'dragover'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', e => { const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; if (f) setFile(f); });
  seg.addEventListener('change', e => { if (e.target.name === 'fmt') { S.format = e.target.value; fillQuality(); updateFormats(); } });
  qEl.addEventListener('change', () => { S.quality = qEl.value; });
  src.addEventListener('submit', e => {
    e.preventDefault();
    if (!S.file) { inline('Choose a file to convert.'); drop.hidden ? null : fileEl.focus(); return; }
    inline(''); run();
  });
  stage.addEventListener('click', e => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const a = b.dataset.act;
    if (a === 'cancel') { cancel(); announce('Conversion cancelled.'); toIdle(); }
    else if (a === 'edit') { revoke(); toIdle('format'); }
    else if (a === 'again') reset();
    else if (a === 'retry') run();
    else if (a === 'format') toIdle('format');
    else if (a === 'audioFmt') { const f = formats.includes('wav') ? 'wav' : formats.find(x => FORMATS[x].engine === 'audio'); if (f) { S.format = f; $(`#fmt-${f}`, root).checked = true; fillQuality(); } toIdle('format'); }
    else if (a === 'quality') { const qs = FORMATS[S.format].qualities, i = qs.findIndex(q => q.id === S.quality); S.quality = qs[Math.max(0, i - 1)].id; fillQuality(); toIdle('quality'); }
  });
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', e => e.preventDefault());
  window.addEventListener('pagehide', revoke);

  fillQuality(); renderPreview(); updateFormats(); setStep();
}

/* ==========================================================================
   8. SHELL: menu, theme, boot
   ========================================================================== */
$('#menuBtn').addEventListener('click', () => {
  const open = $('#nav').classList.toggle('open');
  $('#menuBtn').setAttribute('aria-expanded', String(open));
});
const themes = ['auto', 'light', 'dark'];
let theme = 'auto';
try { theme = localStorage.getItem('vidtune-theme') || 'auto'; } catch {}
function applyTheme() {
  if (theme === 'auto') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', theme);
  $('#themeBtn').textContent = `Theme: ${theme}`;
}
$('#themeBtn').addEventListener('click', () => {
  theme = themes[(themes.indexOf(theme) + 1) % themes.length];
  try { localStorage.setItem('vidtune-theme', theme); } catch {}
  applyTheme();
});
applyTheme();
document.querySelectorAll('.nav a').forEach(a => { if (a.getAttribute('href') === location.pathname) a.setAttribute('aria-current', 'page'); });

const mount = $('#mount');
if (mount) {
  const formats = (mount.dataset.formats || 'mp3,wav,m4a,mp4,webm').split(',').filter(f => FORMATS[f]);
  mountConverter(mount, { formats, defaultFormat: FORMATS[mount.dataset.default] ? mount.dataset.default : formats[0] });
}
})();
