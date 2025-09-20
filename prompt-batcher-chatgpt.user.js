// ==UserScript==
// @name         ChatGPT Prompt 批量助手（CSV/XLSX/TXT/JSONL，自定义模板）
// @namespace    https://github.com/your-namespace/prompt-batcher
// @version      1.2.0
// @description  批量从 JSONL 发送到 ChatGPT，固定 SYSTEM_PROMPT。稳健定位输入框，注入文本，自动发送，等待回复，并把 Q&A 立即保存为本地 JSONL（文件系统访问 API）。含退避重试、按钮就绪检测、回复完成检测。
// @author       You
// @match        https://chat.openai.com/*
// @match        https://chatgpt.com/*
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_setClipboard
// @require      https://cdn.jsdelivr.net/npm/papaparse@5.4.1/papaparse.min.js
// @require      https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ------------------------------
  // Config and constants
  // ------------------------------
  /* const SYSTEM_PROMPT =
    "";

  */
  const UI_ID = 'prompt-batch-runner';
  const TOAST_WRAP_ID = 'pbr-toast-wrap';
  const STORAGE_KEY = 'prompt_batch_state_v1';
  const STORAGE_KEY_V2 = 'prompt_batch_state_v2';
  const STORAGE_KEY_V3 = 'prompt_batch_state_v3';

  // --- 选择器（多版本 UI 兼容） ---
  const INPUT_SELECTORS = [
    'form [data-testid="prompt-textarea"]',
    'form [data-testid="textbox"]',
    'form div[contenteditable="true"][role="textbox"]',
    '#prompt-textarea',
    '[data-testid="prompt-textarea"]',
    '[data-testid="textbox"]',
    'div[contenteditable="true"][role="textbox"]',
    'form textarea',
    'textarea',
    'input[type="text"]'
  ];
  const SEND_SELECTORS = [
    'button[data-testid="send-button"]',
    'button[data-testid="fruitjuice-send-button"]',
    'button[aria-label="Send message"]',
    'button[aria-label*="发送"]',
    'form button[type="submit"]'
  ];
  const STOP_SELECTORS = [
    'button[data-testid="stop-button"]',
    'button[aria-label*="Stop"]',
    'button[aria-label*="停止"]'
  ];
  const REGEN_SELECTORS = [
    'button[data-testid="regenerate-button"]',
    'button[data-testid="fruitjuice-regenerate-button"]',
    'button[aria-label*="Regenerate"]',
    'button[aria-label*="Retry"]',
    'button[aria-label*="Try again"]',
  ];
  const ASSISTANT_MSG_SELECTORS = [
    'div[data-message-author-role="assistant"]',
    'div[data-testid^="conversation-turn-"] [data-role="assistant"]',
    'div[role="article"][data-role="assistant"]'
  ];
  const USER_MSG_SELECTORS = [
    'div[data-message-author-role="user"]',
    'div[data-testid^="conversation-turn-"] [data-role="user"]'
  ];

  // ------------------------------
  // State
  // ------------------------------
  let outputHandle = null; // FileSystemFileHandle
  let state = {
    samples: [],              // generalized: { id, data, _source, _type }
    queueIndex: 0,
    running: false,
    limit: 0,                 // 0 = no limit
    copyToClipboard: false,
    autoSend: true,
    waitForResponse: true,
    intervalSec: 12,          // 建议默认更保守
    autoSave: true,           // 默认开启：拿到输出立即写本地
    results: [],              // { id, input, output, meta }
    answerRetries: 2,         // 回答失败时的 Regenerate 重试次数
    skipProcessedById: true,  // 续跑时按ID跳过已完成的样本
  };

  // 来自输出文件的已完成ID集合（不持久化，随时可从输出再次读取）
  let processedIdSet = null; // Set<string> | null

  // ------------------------------
  // Storage helpers
  // ------------------------------
  function restoreState() {
    try {
      const rawV3 = GM_getValue(STORAGE_KEY_V3, null);
      if (rawV3) {
        Object.assign(state, JSON.parse(rawV3));
      } else {
        const rawV2 = GM_getValue(STORAGE_KEY_V2, null);
        if (rawV2) {
          Object.assign(state, JSON.parse(rawV2));
        } else {
          const raw = GM_getValue(STORAGE_KEY, null);
          if (raw) Object.assign(state, JSON.parse(raw));
        }
      }
      if (!state.promptTemplate) state.promptTemplate = DEFAULT_PROMPT;
    } catch (_) {}
  }
  function persistState() {
    try {
      const obj = {
        samples: state.samples,
        queueIndex: state.queueIndex,
        limit: state.limit,
        copyToClipboard: state.copyToClipboard,
        autoSend: state.autoSend,
        waitForResponse: state.waitForResponse,
        intervalSec: state.intervalSec,
        autoSave: state.autoSave,
        answerRetries: state.answerRetries,
        skipProcessedById: state.skipProcessedById,
        promptTemplate: state.promptTemplate,
      };
      GM_setValue(STORAGE_KEY_V3, JSON.stringify(obj));
    } catch (_) {}
  }

  // ------------------------------
  // File System Access (立即写入 JSONL)
  // ------------------------------
  function supportsFSAccess() {
    return !!(window.showSaveFilePicker || (window.top && window.top.showSaveFilePicker));
  }
  async function pickOutputFile() {
    const ssp = window.showSaveFilePicker || (window.top && window.top.showSaveFilePicker);
    if (!ssp) {
      alert('此浏览器不支持文件系统访问 API。请关闭“自动写入本地”或使用 Export 导出。');
      return null;
    }
    try {
      outputHandle = await ssp({
        suggestedName: 'chatgpt_prompt_batch_results.jsonl',
        types: [{ description: 'JSON/JSONL', accept: { 'application/json': ['.json', '.jsonl'], 'text/plain': ['.jsonl'] } }],
      });
      await ensureOutputPermission();
      return outputHandle;
    } catch (e) {
      console.warn('[PromptBatch] pickOutputFile canceled or failed', e);
      return null;
    }
  }
  async function ensureOutputPermission() {
    if (!outputHandle) return false;
    if (outputHandle.queryPermission) {
      let perm = await outputHandle.queryPermission({ mode: 'readwrite' });
      if (perm !== 'granted' && outputHandle.requestPermission) {
        perm = await outputHandle.requestPermission({ mode: 'readwrite' });
      }
      return perm === 'granted';
    }
    return true;
  }
  async function appendJSONL(line) {
    if (!outputHandle) return;
    const granted = await ensureOutputPermission();
    if (!granted) throw new Error('无写入权限');
    const writer = await outputHandle.createWritable({ keepExistingData: true });
    try {
      const file = await outputHandle.getFile();
      const size = file.size || 0;
      if (writer.seek) await writer.seek(size);
      await writer.write(line + '\n');
    } finally {
      await writer.close();
    }
  }
  async function saveImmediate(record) {
    if (!state.autoSave) return;
    if (!supportsFSAccess()) { toast('当前环境不支持本地写入，已跳过。', 'error', 2600); return; }
    if (!outputHandle) {
      const h = await pickOutputFile();
      if (!h) { toast('未选择输出文件，已跳过写入。', 'error', 2600); return; }
    }
    try {
      await appendJSONL(JSON.stringify(record));
    } catch (e) {
      console.warn('[Brain-NER] 写入失败：', e);
      toast('写入本地失败：' + (e && e.message || e), 'error', 3200);
    }
  }

  // ------------------------------
  // Resume helpers (read processed IDs from output JSONL)
  // ------------------------------
  async function readProcessedFromOutput() {
    if (!supportsFSAccess()) { toast('当前浏览器不支持文件系统API', 'error', 2600); return { count: 0, ids: new Set() }; }
    if (!outputHandle) {
      const h = await pickOutputFile();
      if (!h) { toast('未选择输出文件', 'error', 2600); return { count: 0, ids: new Set() }; }
    }
    const granted = await ensureOutputPermission();
    if (!granted) { toast('无权限读取输出文件', 'error', 2600); return { count: 0, ids: new Set() }; }
    const file = await outputHandle.getFile();
    const text = await file.text();
    const lines = text.split(/\r?\n/);
    const ids = new Set();
    let cnt = 0;
    for (const line of lines) {
      const s = line.trim();
      if (!s) continue;
      try {
        const o = JSON.parse(s);
        const sid = String(o.id || o.ID || o._id || (o.input && (o.input.id || (o.input.user && o.input.user.id))) || '').trim();
        if (sid) ids.add(sid);
        cnt++;
      } catch {}
    }
    return { count: cnt, ids };
  }
  async function resumeFromOutput() {
    if (!state.samples.length) { toast('请先加载输入数据', 'error', 2600); return; }
    const { count, ids } = await readProcessedFromOutput();
    processedIdSet = ids;
    // 优先按ID跳过，否则退化为按行数推进
    if (ids && ids.size && state.skipProcessedById) {
      let i = 0;
      while (i < state.samples.length && ids.has(String(state.samples[i].id || ''))) i++;
      state.queueIndex = i;
      toast(`按ID续跑：已跳过 ${i} 项`, 'info', 2600);
    } else {
      state.queueIndex = Math.min(count, state.samples.length);
      toast(`按行数续跑：推进到 ${state.queueIndex}`, 'info', 2600);
    }
    persistState();
  }

  // ------------------------------
  // Utilities
  // ------------------------------
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  function parseJSONL(text) {
    const lines = text.split(/\r?\n/);
    const items = [];
    for (const line of lines) {
      const s = line.trim();
      if (!s) continue;
      try {
        const obj = JSON.parse(s);
        const sid = String(obj.id || obj.ID || obj._id || '').trim();
        const report = String(obj.report || obj.text || obj.desc || '');
        const ga = (obj.GA || obj.gestational_age || obj.ga);
        if (!sid && !report) continue;
        items.push({ id: sid, report, GA: (ga === undefined || ga === '' ? null : String(ga)) });
      } catch (_) {}
    }
    return items;
  }
  // Additional parsers for TXT/CSV/XLSX and a tiny template engine
  function parseTXT(text, sourceName = 'txt') {
    const lines = text.split(/\r?\n/);
    const items = [];
    let idx = 0;
    for (const line of lines) {
      const s = line.trim();
      if (!s) continue;
      items.push({ id: `${sourceName}:${++idx}`, data: { line: s }, _source: sourceName, _type: 'txt' });
    }
    return items;
  }
  function parseCSV(text, sourceName = 'csv') {
    try {
      if (typeof Papa === 'undefined' || !Papa.parse) {
        console.warn('[BNR] PapaParse not loaded, fallback to naive CSV split');
        const rows = text.split(/\r?\n/).filter(Boolean).map(r => r.split(','));
        if (!rows.length) return [];
        const header = rows[0];
        return rows.slice(1).map((arr, i) => {
          const obj = {};
          header.forEach((h, j) => obj[h] = arr[j] ?? '');
          const sid = String(obj.id || obj.ID || obj._id || '').trim();
          return { id: sid || `${sourceName}:${i+1}`, data: obj, _source: sourceName, _type: 'csv' };
        });
      }
      const res = Papa.parse(text, { header: true, skipEmptyLines: 'greedy' });
      if (!res || !res.data) return [];
      return res.data.map((row, i) => {
        const sid = String(row.id || row.ID || row._id || '').trim();
        return { id: sid || `${sourceName}:${i+1}`, data: row, _source: sourceName, _type: 'csv' };
      });
    } catch (e) {
      console.warn('[BNR] parseCSV failed:', e);
      return [];
    }
  }
  async function parseXLSX(file) {
    try {
      const buf = await file.arrayBuffer();
      if (typeof XLSX === 'undefined' || !XLSX.read) {
        console.warn('[BNR] XLSX lib not loaded');
        return [];
      }
      const wb = XLSX.read(buf, { type: 'array' });
      const sheetName = wb.SheetNames[0];
      if (!sheetName) return [];
      const ws = wb.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
      return rows.map((row, i) => {
        const sid = String(row.id || row.ID || row._id || '').trim();
        return { id: sid || `${file.name}:${i+1}`, data: row, _source: file.name, _type: 'xlsx' };
      });
    } catch (e) {
      console.warn('[BNR] parseXLSX failed:', e);
      return [];
    }
  }
  function propByPath(obj, path) {
    try { return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj); } catch { return undefined; }
  }
  function applyTemplate(tpl, data, extras = {}) {
    if (!tpl || typeof tpl !== 'string') tpl = '';
    const ctx = Object.assign({}, (typeof data === 'object' && data !== null) ? data : { value: String(data ?? '') }, extras);
    let used = false;
    const out = tpl.replace(/\{\{\s*([\w$.]+)\s*\}\}/g, (m, key) => {
      used = true;
      if (key === 'JSON') return (typeof data === 'string') ? JSON.stringify({ value: data }) : JSON.stringify(data, null, 2);
      const v = propByPath(ctx, key);
      return v == null ? '' : String(v);
    });
    if (used) return out;
    const body = (typeof data === 'string') ? data : JSON.stringify(data, null, 2);
    return tpl + '\n\n' + body;
  }

  async function parseByFile(f) {
    const name = (f && f.name) ? f.name : '';
    const lower = name.toLowerCase();
    if (lower.endsWith('.jsonl')) {
      const text = await f.text();
      // wrap legacy JSONL rows into unified samples
      const legacyItems = parseJSONL(text);
      return legacyItems.map((it, i) => ({ id: it.id || `${name}:${i+1}`, data: { id: it.id || '', report: it.report || '', GA: it.GA ?? null }, _source: name || 'jsonl', _type: 'jsonl' }));
    } else if (lower.endsWith('.txt')) {
      const text = await f.text();
      return parseTXT(text, name);
    } else if (lower.endsWith('.csv')) {
      const text = await f.text();
      return parseCSV(text, name);
    } else if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) {
      return await parseXLSX(f);
    } else {
      // try best: JSONL first
      const text = await f.text();
      const tryJsonl = parseJSONL(text, name);
      if (tryJsonl && tryJsonl.length) return tryJsonl.map((it, i) => ({ id: it.id || `${name}:${i+1}`, data: it.data ?? it, _source: name || 'jsonl', _type: 'jsonl' }));
      // fallback to TXT lines
      return parseTXT(text, name);
    }
  }
  const buildUserPayload = (s) => (s && s.data !== undefined ? s.data : ({ id: s.id || '', GA: s.GA || '', report: s.report || '' }));
  const jsonDumps = (o) => JSON.stringify(o);
  const DEFAULT_PROMPT = '请根据以下数据进行处理与分析，并输出清晰、结构化的结果：\n\n{{JSON}}';
  const buildMessage = (payload, sample) => applyTemplate((state.promptTemplate || DEFAULT_PROMPT), payload, { SOURCE: sample?._source || '', INDEX: state.queueIndex + 1 });
  const userLabelFor = (sample, i) => (sample.id && String(sample.id).trim()) ? String(sample.id).trim() : `样本#${i + 1}`;

  // ------------------------------
  // DOM helpers for composer (robust)
  // ------------------------------
  function isVisible(el) {
    if (!el || !(el instanceof Element)) return false;
    if (el.getAttribute('aria-hidden') === 'true') return false;
    let cur = el;
    while (cur) {
      const cs = getComputedStyle(cur);
      if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) return false;
      cur = cur.parentElement;
    }
    const rect = el.getBoundingClientRect();
    if ((rect.width * rect.height) < 4) return false;
    if (el.matches('textarea,input') && (el.disabled || el.readOnly)) return false;
    return true;
  }
  function findFirst(selectors, root = document) {
    for (const s of selectors) {
      const el = root.querySelector(s);
      if (el) return el;
    }
    return null;
  }
  function getCandidateInputs() {
    const list = [];
    for (const s of INPUT_SELECTORS) {
      document.querySelectorAll(s).forEach(el => list.push(el));
    }
    const uniq = Array.from(new Set(list));
    return uniq.filter(el => isVisible(el) && (el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'INPUT'));
  }
  function centerDistance(a, b) {
    const ra = a.getBoundingClientRect();
    const rb = b.getBoundingClientRect();
    const ax = ra.left + ra.width / 2, ay = ra.top + ra.height / 2;
    const bx = rb.left + rb.width / 2, by = rb.top + rb.height / 2;
    return Math.hypot(ax - bx, ay - by);
  }
  function findSendButtonNear(inputEl) {
    const form = inputEl.closest('form');
    if (form) {
      const btn = findFirst(SEND_SELECTORS, form);
      if (btn && isVisible(btn)) return btn;
    }
    const candidates = [];
    for (const s of SEND_SELECTORS) {
      document.querySelectorAll(s).forEach(el => { if (isVisible(el)) candidates.push(el); });
    }
    let best = null, bestD = Infinity;
    for (const el of candidates) {
      const d = centerDistance(inputEl, el);
      if (d < bestD) { bestD = d; best = el; }
    }
    return best || null;
  }
  function pickComposer() {
    const inputs = getCandidateInputs();
    if (!inputs.length) return null;
    let withBtn = null, withBtnDist = Infinity;
    for (const input of inputs) {
      const btn = findSendButtonNear(input);
      if (btn) {
        const d = centerDistance(input, btn);
        if (d < withBtnDist) { withBtnDist = d; withBtn = { input, send: btn }; }
      }
    }
    if (withBtn) return withBtn;
    return { input: inputs[0], send: findSendButtonNear(inputs[0]) };
  }
  async function waitForComposer(timeoutMs = 20000) {
    const first = pickComposer();
    if (first) return first;
    return new Promise(resolve => {
      const t = setTimeout(() => { obs.disconnect(); resolve(null); }, timeoutMs);
      const obs = new MutationObserver(() => {
        const p = pickComposer();
        if (p) { clearTimeout(t); obs.disconnect(); resolve(p); }
      });
      obs.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
    });
  }

  // ------------------------------
  // Input write helpers
  // ------------------------------
  function setNativeValue(el, value) {
    try {
      const proto = Object.getPrototypeOf(el);
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && desc.set) desc.set.call(el, value); else el.value = value;
      try { el.dispatchEvent(new Event('input', { bubbles: true })); } catch {}
      try { el.dispatchEvent(new Event('change', { bubbles: true })); } catch {}
      return true;
    } catch { return false; }
  }
  function setContentEditableText(el, value) {
    try {
      el.focus();
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      range.deleteContents();
      range.collapse(true);
      sel.removeAllRanges(); sel.addRange(range);
      const ok = document.execCommand && document.execCommand('insertText', false, value);
      if (!ok) el.innerText = value;
      try { el.dispatchEvent(new InputEvent('input', { bubbles: true })); } catch {}
      try { el.dispatchEvent(new Event('change', { bubbles: true })); } catch {}
      return true;
    } catch {
      try {
        while (el.firstChild) el.removeChild(el.firstChild);
        el.appendChild(document.createTextNode(value));
        try { el.dispatchEvent(new InputEvent('input', { bubbles: true })); } catch {}
        try { el.dispatchEvent(new Event('change', { bubbles: true })); } catch {}
        return true;
      } catch { return false; }
    }
  }
  function fireRichInputEvents(el) {
    try {
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste' }));
    } catch {}
    try { el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })); } catch {}
    try { el.blur(); el.focus(); } catch {}
  }
  function setChatInputText(el, value) {
    if (!el) return false;
    let ok = false;
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') ok = setNativeValue(el, value);
    else if (el.isContentEditable) ok = setContentEditableText(el, value);
    else ok = setNativeValue(el, value);
    if (ok) fireRichInputEvents(el);
    return ok;
  }

  // ------------------------------
  // Send helpers
  // ------------------------------
  function dispatchEnter(el, opts = {}) {
    const base = { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', which: 13, keyCode: 13 };
    try { el.dispatchEvent(new KeyboardEvent('keydown', { ...base, ...opts })); } catch {}
    try { el.dispatchEvent(new KeyboardEvent('keyup',   { ...base, ...opts })); } catch {}
  }
  function trySendViaKeyCombos(inputEl) {
    try {
      inputEl.focus();
      dispatchEnter(inputEl, { ctrlKey: true });
      dispatchEnter(inputEl, { metaKey: true });
      dispatchEnter(inputEl, {});
      return true;
    } catch { return false; }
  }
  function isButtonEnabled(btn) {
    if (!btn) return false;
    if (btn.disabled) return false;
    const ariaDisabled = btn.getAttribute('aria-disabled');
    if (ariaDisabled && ariaDisabled !== 'false') return false;
    return true;
  }
  function trySendUsingButton(inputEl) {
    const btn = findSendButtonNear(inputEl);
    if (btn && isButtonEnabled(btn)) { try { btn.click(); return true; } catch {} }
    return false;
  }
  function trySendUsingForm(inputEl) {
    const form = inputEl.closest('form');
    if (!form) return false;
    const btn = findSendButtonNear(inputEl) || form.querySelector('button[type="submit"]');
    try {
      if (typeof form.requestSubmit === 'function') {
        form.requestSubmit(btn || undefined);
        return true;
      }
    } catch {}
    try {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      return true;
    } catch {}
    if (btn) { try { btn.click(); return true; } catch {} }
    return false;
  }
  function trySend(inputEl) {
    // 最佳实践顺序：按钮 → 表单 → 键盘事件
    if (trySendUsingButton(inputEl)) return true;
    if (trySendUsingForm(inputEl)) return true;
    return trySendViaKeyCombos(inputEl);
  }

  function findRegenerateButton() {
    // 先用预设选择器
    for (const s of REGEN_SELECTORS) {
      const btn = document.querySelector(s);
      if (btn && isVisible(btn)) return btn;
    }
    // 兜底：遍历可见按钮，基于文案识别
    const texts = ['regenerate', 'retry', 'try again', '重新生成', '重试', '再试一次'];
    const btns = Array.from(document.querySelectorAll('button'));
    for (const b of btns) {
      if (!isVisible(b)) continue;
      const t = (b.innerText || b.textContent || '').toLowerCase();
      if (texts.some(x => t.includes(x))) return b;
    }
    return null;
  }

  // ------------------------------
  // Generation state & counters
  // ------------------------------
  function isGenerating() {
    for (const s of STOP_SELECTORS) {
      const el = document.querySelector(s);
      if (el && el.offsetParent !== null) return true;
    }
    return false;
  }
  function countUserMessages() {
    let n = 0;
    for (const s of USER_MSG_SELECTORS) n += document.querySelectorAll(s).length;
    return n;
  }
  function getInputText(el) {
    if (!el) return '';
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return el.value || '';
    if (el.isContentEditable) return el.innerText || el.textContent || '';
    return '';
  }

  // ------------------------------
  // Waiters
  // ------------------------------
  async function waitForSendReady(inputEl, timeoutMs = 15000) {
    const start = performance.now();
    while (performance.now() - start < timeoutMs) {
      const btn = findSendButtonNear(inputEl);
      if (btn && isButtonEnabled(btn) && !isGenerating()) return btn;
      await sleep(120);
    }
    return null;
  }
  async function waitUntilSent(inputEl, prevUserCount, timeoutMs = 8000) {
    const start = performance.now();
    while (performance.now() - start < timeoutMs) {
      const txt = getInputText(inputEl).trim();
      if (!txt) return true; // 输入框已被清空
      if (countUserMessages() > prevUserCount) return true; // 用户消息+1
      await sleep(120);
    }
    return false;
  }
  async function waitUntilIdle(timeoutMs = 180000) {
    const start = performance.now();
    let lastDomChange = performance.now();
    const obs = new MutationObserver(() => { lastDomChange = performance.now(); });
    obs.observe(document.body, { childList: true, subtree: true, characterData: true });

    while (performance.now() - start < timeoutMs) {
      const quiet = performance.now() - lastDomChange;
      const sendBtn = document.querySelector('button[data-testid="send-button"]');
      const sendReady = sendBtn && isButtonEnabled(sendBtn);
      const notGenerating = !isGenerating();
      if (sendReady || (notGenerating && quiet > 1200)) {
        obs.disconnect(); return true;
      }
      await sleep(200);
    }
    obs.disconnect();
    return false;
  }

  // ------------------------------
  // Error detection & backoff
  // ------------------------------
  function detectBlockingErrorText() {
    const txt = document.body.innerText || '';
    const patterns = [
      /Too many requests/i, /rate limit/i, /Please try again later/i,
      /Network error/i, /Something went wrong/i,
      /请求过于频繁/, /请稍后再试/, /网络错误/
    ];
    return patterns.some(p => p.test(txt));
  }
  async function backoff(attempt) {
    // 3s、9s、27s、封顶 60s
    const ms = Math.min(3000 * Math.pow(3, attempt), 60000);
    await sleep(ms);
  }

  // ------------------------------
  // Capture assistant output
  // ------------------------------
  function getAssistantMessages() {
    const set = new Set();
    for (const s of ASSISTANT_MSG_SELECTORS) document.querySelectorAll(s).forEach(n => set.add(n));
    document.querySelectorAll('div[data-message-author-role]').forEach(n => {
      if (n.getAttribute('data-message-author-role')?.toLowerCase() === 'assistant') set.add(n);
    });
    if (!set.size) document.querySelectorAll('article, .message, .chat-message').forEach(n => set.add(n));
    return Array.from(set);
  }
  function getLastAssistantText() {
    const nodes = getAssistantMessages();
    if (!nodes.length) return '';
    const last = nodes[nodes.length - 1];
    const node = (last.querySelector && last.querySelector('.markdown')) || last;
    return (node.innerText || node.textContent || '').trim();
  }

  function isBadAssistantText(t) {
    if (!t) return true;
    const patterns = [
      /something went wrong/i,
      /network error/i,
      /please try again/i,
      /failed/i,
      /错误|失败|重试|请稍后/i,
    ];
    return patterns.some(p => p.test(t));
  }
  async function captureAssistantOutputWithRetries(maxRetries = 2) {
    // 初次读取
    let out = getLastAssistantText();
    if (!isBadAssistantText(out)) return out;
    let attempt = 0;
    while (attempt < maxRetries) {
      const btn = findRegenerateButton();
      if (!btn) break;
      try { btn.click(); } catch {}
      await waitUntilIdle(180000);
      out = getLastAssistantText();
      if (!isBadAssistantText(out)) return out;
      attempt++;
      await backoff(attempt);
    }
    return out; // 可能为空或错误，交由上层记录
  }

  // ------------------------------
  // Toast UI
  // ------------------------------
  function ensureToastWrap() {
    if (document.getElementById(TOAST_WRAP_ID)) return;
    const wrap = document.createElement('div');
    wrap.id = TOAST_WRAP_ID;
    document.body.appendChild(wrap);
  }
  function toast(msg, type = 'info', duration = 2600) {
    ensureToastWrap();
    const el = document.createElement('div');
    el.className = `bnr-toast bnr-${type}`;
    el.textContent = msg;
    document.getElementById(TOAST_WRAP_ID).appendChild(el);
    // force reflow
    // eslint-disable-next-line no-unused-expressions
    el.offsetWidth;
    el.classList.add('bnr-show');
    setTimeout(() => {
      el.classList.remove('bnr-show');
      el.classList.add('bnr-hide');
      el.addEventListener('transitionend', () => el.remove(), { once: true });
    }, duration);
  }

  // ------------------------------
  // UI
  // ------------------------------
  function ensureUI() {
    if (document.getElementById(UI_ID)) return;

    const root = document.createElement('div'); // renamed file: prompt-batcher-chatgpt.user.js
    root.id = UI_ID;
    root.innerHTML = `
      <div class="bnr-header">
        <span>Prompt Batcher</span>
        <button class="bnr-close" title="Hide">×</button>
      </div>
      <div class="bnr-body">
        <div class="bnr-row">
          <input type="file" accept=".jsonl,.txt" class="bnr-file" />
          <button class="bnr-load">Load</button>
          <button class="bnr-pick">选择输出文件</button>
          <button class="bnr-resume" title="从输出文件断点续跑">Resume</button>
          <button class="bnr-export" title="Export results">Export</button>
        </div>
        <div class="bnr-row">
          <label><input type="checkbox" class="bnr-copy" /> Copy to clipboard</label>
          <label><input type="checkbox" class="bnr-autosend" checked /> Auto send</label>
          <label><input type="checkbox" class="bnr-wait" checked /> Wait for response</label>
          <label><input type="checkbox" class="bnr-autosave" checked /> 自动写入本地</label>
        </div>
        <div class="bnr-row">
          <label>Interval(s) <input type="number" min="0" step="1" class="bnr-interval" value="12" style="width:60px"/></label>
          <label>Limit <input type="number" min="0" step="1" class="bnr-limit" value="0" style="width:60px"/></label>
          <label>Retries <input type="number" min="0" step="1" class="bnr-retries" value="2" style="width:60px"/></label>
          <label><input type="checkbox" class="bnr-skipdone" checked /> Skip done IDs</label>
        </div>
        <div class="bnr-row">
          <button class="bnr-start">Start</button>
          <button class="bnr-pause">Pause</button>
          <button class="bnr-reset">Reset</button>
        </div>
        <div class="bnr-status"></div>
      </div>
    `;
    document.body.appendChild(root);

    // Inject Prompt Template row and enhanced file inputs
    (function enhanceUI() {
      const body = root.querySelector('.bnr-body');
      const firstRow = root.querySelector('.bnr-body .bnr-row');
      if (!body || !firstRow) return;
      const tplRow = document.createElement('div');
      tplRow.className = 'bnr-row';
      tplRow.innerHTML = `
        <label style="width:100%">Prompt Template</label>
        <textarea class="bnr-tpl" rows="4" style="width:100%; resize:vertical; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono','Courier New',monospace;"></textarea>
        <div style="font-size:12px; color:#9ba3af">提示：可用 {{列名}} / {{JSON}} / {{SOURCE}} / {{INDEX}}</div>
      `;
      body.insertBefore(tplRow, firstRow);

      // add folder input + button near existing file row
      const fileInput = root.querySelector('.bnr-file');
      const loadBtn = root.querySelector('.bnr-load');
      if (fileInput) {
        fileInput.setAttribute('multiple', '');
        fileInput.setAttribute('accept', '.jsonl,.txt,.csv,.xlsx,.xls');
      }
      if (firstRow && loadBtn) {
        const dirInput = document.createElement('input');
        dirInput.type = 'file'; dirInput.className = 'bnr-dir'; dirInput.style.display = 'none';
        dirInput.setAttribute('multiple', ''); dirInput.setAttribute('webkitdirectory', ''); dirInput.setAttribute('directory', '');
        firstRow.appendChild(dirInput);
        const loadDirBtn = document.createElement('button');
        loadDirBtn.className = 'bnr-load-dir'; loadDirBtn.textContent = 'Load Folder';
        firstRow.insertBefore(loadDirBtn, loadBtn.nextSibling);
        // Override old Load click with multi-file parsing
        loadBtn.addEventListener('click', async (e) => {
          try { e.preventDefault(); e.stopImmediatePropagation(); } catch {}
          const input = root.querySelector('.bnr-file');
          const files = (input && input.files && input.files.length) ? Array.from(input.files) : [];
          if (!files.length) { alert('请选择文件（支持 JSONL/TXT/CSV/XLSX/XLS）'); return; }
          let all = [];
          for (const f of files) {
            const part = await parseByFile(f);
            if (part && part.length) all = all.concat(part);
          }
          if (!all.length) { alert('未解析到有效数据'); return; }
          state.samples = all;
          state.queueIndex = 0;
          try { GM_setValue && GM_setValue('tmp_noop', 1); } catch {}
          try { (root.querySelector('.bnr-status')||{}).textContent = `Loaded: ${all.length} | Index: 0/${all.length}`; } catch {}
          alert(`已加载 ${all.length} 条数据`);
        }, false);

        // Hook folder selection
        loadDirBtn.addEventListener('click', () => dirInput.click());
        dirInput.addEventListener('change', async () => {
          const files = (dirInput.files && dirInput.files.length) ? Array.from(dirInput.files) : [];
          if (!files.length) return;
          let all = [];
          for (const f of files) {
            const low = (f.name || '').toLowerCase();
            if (!(/\.(jsonl|txt|csv|xlsx|xls)$/i).test(low)) continue;
            const part = await parseByFile(f);
            if (part && part.length) all = all.concat(part);
          }
          if (!all.length) { alert('未解析到有效数据'); return; }
          state.samples = all;
          state.queueIndex = 0;
          try { (root.querySelector('.bnr-status')||{}).textContent = `Loaded: ${all.length} | Index: 0/${all.length}`; } catch {}
          alert(`已加载 ${all.length} 条数据（来自文件夹）`);
        });
      }
    })();

    GM_addStyle(`
      /* Panel */
      #${UI_ID} { position: fixed; z-index: 99999; right: 16px; bottom: 16px; width: 360px;
        background: #0b0f16; color: #e6edf3; border: 1px solid #2d2f36; border-radius: 8px; box-shadow: 0 6px 20px rgba(0,0,0,0.35); font: 13px/1.4 -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif; }
      #${UI_ID} .bnr-header { display:flex; align-items:center; justify-content:space-between; padding:8px 10px; border-bottom:1px solid #2d2f36; font-weight:600; cursor:move; }
      #${UI_ID} .bnr-body { padding: 8px 10px; }
      #${UI_ID} .bnr-row { display:flex; align-items:center; gap:8px; margin:6px 0; flex-wrap: wrap; }
      #${UI_ID} button { background:#1f6feb; color:#fff; border:none; border-radius:6px; padding:6px 10px; cursor:pointer; }
      #${UI_ID} button:disabled { opacity: 0.6; cursor: not-allowed; }
      #${UI_ID} .bnr-close { background:transparent; color:#9ba3af; font-size:18px; padding:0 6px; }
      #${UI_ID} .bnr-status { margin-top:6px; color:#9ba3af; }
      #${UI_ID} input[type="file"] { flex:1; }
      #${UI_ID} .bnr-file { max-width: 220px; }
      #${UI_ID} .bnr-tpl { background:#0c1220; color:#e6edf3; border:1px solid #2d2f36; border-radius:6px; padding:6px 8px; }

      /* Toasts */
      #${TOAST_WRAP_ID} {
        position: fixed; z-index: 100000; right: 20px; top: 20px; display: flex; flex-direction: column; gap: 10px;
        pointer-events: none;
      }
      .bnr-toast {
        min-width: 220px; max-width: 420px; padding: 10px 14px; border-radius: 8px;
        background: #1f2937; color: #e5e7eb; box-shadow: 0 8px 24px rgba(0,0,0,0.35);
        opacity: 0; transform: translateY(-10px);
        transition: opacity .18s ease, transform .18s ease;
        pointer-events: auto; font-size: 13px; border: 1px solid rgba(255,255,255,0.06);
      }
      .bnr-toast.bnr-show { opacity: 1; transform: translateY(0); }
      .bnr-toast.bnr-hide { opacity: 0; transform: translateY(-10px); }

      .bnr-toast.bnr-success { background:#0d3523; color:#cdf3df; border-color:#1ea36a; }
      .bnr-toast.bnr-info    { background:#0d2235; color:#d3ebff; border-color:#3b82f6; }
      .bnr-toast.bnr-error   { background:#3b0d0d; color:#ffd6d6; border-color:#ef4444; }
    `);

    // Drag
    (function makeDraggable(el, handle) {
      let sx=0, sy=0, ox=0, oy=0, dragging=false;
      const onDown = (e) => { dragging=true; sx=e.clientX; sy=e.clientY; const r=el.getBoundingClientRect(); ox=r.left; oy=r.top; e.preventDefault(); };
      const onMove = (e) => { if (!dragging) return; const dx=e.clientX-sx, dy=e.clientY-sy; el.style.left=(ox+dx)+"px"; el.style.top=(oy+dy)+"px"; el.style.right='auto'; el.style.bottom='auto'; };
      const onUp = () => dragging=false;
      handle.addEventListener('mousedown', onDown);
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    })(root, root.querySelector('.bnr-header'));

    const els = {
      file: root.querySelector('.bnr-file'),
      load: root.querySelector('.bnr-load'),
      pick: root.querySelector('.bnr-pick'),
      resume: root.querySelector('.bnr-resume'),
      exportBtn: root.querySelector('.bnr-export'),
      copy: root.querySelector('.bnr-copy'),
      autosend: root.querySelector('.bnr-autosend'),
      wait: root.querySelector('.bnr-wait'),
      autosave: root.querySelector('.bnr-autosave'),
      interval: root.querySelector('.bnr-interval'),
      limit: root.querySelector('.bnr-limit'),
      retries: root.querySelector('.bnr-retries'),
      skipdone: root.querySelector('.bnr-skipdone'),
      start: root.querySelector('.bnr-start'),
      pause: root.querySelector('.bnr-pause'),
      reset: root.querySelector('.bnr-reset'),
      status: root.querySelector('.bnr-status'),
      close: root.querySelector('.bnr-close'),
    };

    const dirInput = root.querySelector('.bnr-dir');
    const loadDirBtn = root.querySelector('.bnr-load-dir');
    const tpl = root.querySelector('.bnr-tpl');

    function updateStatus() {
      const total = state.samples.length;
      const idx = state.queueIndex;
      const out = outputHandle ? ` | 输出: ${outputHandle.name || '已选择'}` : '';
      els.status.textContent = `Loaded: ${total} | Index: ${idx}/${total} | Running: ${state.running ? 'Yes' : 'No'}${out}${processedIdSet ? ' | DoneIDs: ' + processedIdSet.size : ''}`;
    }

    els.load.addEventListener('click', async () => {
      const f = els.file.files && els.file.files[0];
      if (!f) { alert('请选择 JSONL/TXT 文件'); return; }
      const text = await f.text();
      const items = parseJSONL(text);
      if (!items.length) { alert('未解析到有效行'); return; }
      state.samples = items;
      state.queueIndex = 0;
      persistState(); updateStatus();
      alert(`已加载 ${items.length} 条样本`);
    });

    els.pick.addEventListener('click', async () => {
      await pickOutputFile();
      updateStatus();
    });
    els.resume.addEventListener('click', async () => {
      await resumeFromOutput();
      updateStatus();
    });

    els.exportBtn.addEventListener('click', () => {
      if (!state.results.length) { alert('暂无可导出的结果'); return; }
      const lines = state.results.map(r => JSON.stringify(r));
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const blob = new Blob([lines.join('\n') + '\n'], { type: 'application/jsonl;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = `prompts_and_results-${stamp}.jsonl`; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
    });

    els.copy.addEventListener('change', () => { state.copyToClipboard = !!els.copy.checked; persistState(); });
    els.autosend.addEventListener('change', () => { state.autoSend = !!els.autosend.checked; persistState(); });
    els.wait.addEventListener('change', () => { state.waitForResponse = !!els.wait.checked; persistState(); });
    els.autosave.addEventListener('change', () => { state.autoSave = !!els.autosave.checked; persistState(); });
    els.interval.addEventListener('change', () => { state.intervalSec = Math.max(0, Number(els.interval.value)||0); persistState(); });
    els.limit.addEventListener('change', () => { state.limit = Math.max(0, Number(els.limit.value)||0); persistState(); });
    els.retries.addEventListener('change', () => { state.answerRetries = Math.max(0, Number(els.retries.value)||0); persistState(); });
    els.skipdone.addEventListener('change', () => { state.skipProcessedById = !!els.skipdone.checked; persistState(); });

    els.start.addEventListener('click', () => { state.running = true; persistState(); updateStatus(); pump(); });
    els.pause.addEventListener('click', () => { state.running = false; persistState(); updateStatus(); });
    els.reset.addEventListener('click', () => { state.queueIndex = 0; state.results = []; persistState(); updateStatus(); });
    els.close.addEventListener('click', () => { root.style.display = 'none'; });

    restoreState();
    if (tpl) {
      tpl.value = String(state.promptTemplate || DEFAULT_PROMPT || '');
      tpl.addEventListener('change', () => { state.promptTemplate = String(tpl.value || ''); persistState(); });
    }
    els.copy.checked = !!state.copyToClipboard;
    els.autosend.checked = !!state.autoSend;
    els.wait.checked = !!state.waitForResponse;
    els.autosave.checked = !!state.autoSave;
    els.interval.value = String(state.intervalSec || 12);
    els.limit.value = String(state.limit || 0);
    els.retries.value = String(state.answerRetries || 2);
    els.skipdone.checked = !!state.skipProcessedById;
    updateStatus();
  }

  // ------------------------------
  // Send pipeline (robust)
  // ------------------------------
  async function obtainComposerAndSend(textToSend, maxRetries = 2) {
    let attempt = 0;
    while (attempt <= maxRetries) {
      const comp = await waitForComposer(20000);
      if (!comp || !comp.input) throw new Error('未找到可用的聊天输入框');

      try { comp.input.scrollIntoView({ block: 'center' }); } catch {}

      // —— 写入 & 触发事件
      const ok = setChatInputText(comp.input, textToSend);
      if (!ok) throw new Error('无法写入输入框');

      // —— 等按钮就绪
      const btn = await waitForSendReady(comp.input, 15000);
      if (!btn) {
        if (detectBlockingErrorText()) { await backoff(attempt++); continue; }
        throw new Error('发送按钮未就绪');
      }

      // —— 发送并确认入列
      const prevUser = countUserMessages();
      let sent = false;
      try { btn.click(); sent = true; } catch {}
      if (!sent) sent = trySendUsingForm(comp.input) || trySendViaKeyCombos(comp.input);

      const enqueued = await waitUntilSent(comp.input, prevUser, 8000);
      if (!enqueued) {
        if (detectBlockingErrorText()) { await backoff(attempt++); continue; }
        attempt++;
        await backoff(attempt);
        continue; // 重试本条
      }

      // —— 若需要等待回复完成
      if (state.autoSend && state.waitForResponse) {
        await waitUntilIdle(180000);
      }
      return true; // 成功
    }
    throw new Error('多次尝试后仍未能发送/入列');
  }

  // ------------------------------
  // Batch core
  // ------------------------------
  async function runOne() {
    const total = state.samples.length;
    if (!total) { toast('未加载样本', 'error'); return false; }
    if (state.limit && state.queueIndex >= state.limit) { state.running = false; return false; }
    if (state.queueIndex >= total) { state.running = false; return false; }

    // 跳过已在输出中完成的ID
    if (processedIdSet && state.skipProcessedById) {
      while (state.queueIndex < total) {
        const sid = String(state.samples[state.queueIndex].id || '');
        if (!sid || !processedIdSet.has(sid)) break;
        state.queueIndex += 1;
      }
      if (state.queueIndex >= total) { state.running = false; return false; }
    }

    const sample = state.samples[state.queueIndex];
    const label = userLabelFor(sample, state.queueIndex);
    const payload = buildUserPayload(sample);
    const msg = buildMessage(payload, sample);

    if (state.copyToClipboard) {
      try { GM_setClipboard(msg, { type: 'text', mimetype: 'text/plain' }); } catch (e) { console.warn('Clipboard failed:', e); }
    }

    if (state.autoSend) {
      try {
        await obtainComposerAndSend(msg, 2); // 失败自动重试+退避
      } catch (e) {
        toast(String(e && e.message || e), 'error', 3200);
        state.running = false;
        return false;
      }
      toast(`输入「${label}」成功并已发送`, 'success', 2000);
    } else {
      // 仅注入，不发送
      const comp = await waitForComposer(20000);
      if (!comp || !comp.input) { toast('未找到可用的聊天输入框', 'error', 3200); state.running = false; return false; }
      const ok = setChatInputText(comp.input, msg);
      if (!ok) { toast('无法写入输入框', 'error', 3200); state.running = false; return false; }
      toast(`输入「${label}」成功（未自动发送）`, 'success', 2000);
    }

    let outputText = null;
    if (state.autoSend && state.waitForResponse) {
      // obtainComposerAndSend 内已等待到空闲，这里只取文本
      outputText = await captureAssistantOutputWithRetries(state.answerRetries || 0);
    }

    const record = {
      id: sample.id || '',
      input_text: msg,           // 发送的完整消息（系统提示+json）
      input: { prompt: (state.promptTemplate || DEFAULT_PROMPT), data: payload },
      output: outputText,
      meta: { ts: new Date().toISOString(), page: location.href, endpoint: location.origin }
    };

    await saveImmediate(record);       // 立刻写入本地文件
    state.results.push(record);        // 也放到内存，方便 Export

    toast(`「${label}」解析成功`, 'success', 2200);

    if (processedIdSet && (sample.id || sample.ID || sample._id)) {
      processedIdSet.add(String(sample.id || sample.ID || sample._id));
    }
    state.queueIndex += 1;
    persistState();

    const statusEl = document.querySelector('#' + UI_ID + ' .bnr-status');
    if (statusEl) statusEl.textContent = `Loaded: ${state.samples.length} | Index: ${state.queueIndex}/${state.samples.length} | Running: ${state.running ? 'Yes' : 'No'}`;

    return true;
  }

  async function pump() {
    while (state.running) {
      const ok = await runOne();
      if (!ok || !state.running) break;
      const delay = Math.max(0, (state.intervalSec || 0) * 1000);
      await sleep(delay);
    }
  }

  // ------------------------------
  // Init
  // ------------------------------
  function init() { ensureUI(); }
  setTimeout(init, 1500);
})();
