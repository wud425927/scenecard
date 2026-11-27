import { PHRASES, CATEGORIES } from './data/phrases.js';
import {
  buildActiveDeck,
  buildBackupPayload,
  createEmptyState,
  ensureTodaySession,
  getExploredCount,
  getLocalDateStr,
  loadCustomDeck,
  loadExampleHistory,
  loadState,
  mergeCustomCards,
  parseBackupPayload,
  pickExampleForCard,
  previewIntervalDays,
  rebuildSessionForDeckSource,
  reviewCurrentCard,
  saveCustomDeck,
  saveExampleHistory,
  saveState,
  startExtraBatch,
  syncSessionWithDeck,
  validateImportedDeck,
} from './srs.js';

// DOM References
const els = {
  progressTrack: document.querySelector('.progress-track'),
  progressFill: document.getElementById('progress-fill'),
  progressLabel: document.getElementById('progress-label'),
  menuBtn: document.getElementById('menu-btn'),

  studyView: document.getElementById('study-view'),
  activeCard: document.getElementById('active-card'),
  nextCardGhost: document.getElementById('next-card-ghost'),
  ghostCategory: document.getElementById('ghost-category'),
  ghostSentence: document.getElementById('ghost-sentence'),

  stampKnown: document.getElementById('stamp-known'),
  stampStuck: document.getElementById('stamp-stuck'),

  cardCategory: document.getElementById('card-category'),
  audioBtn: document.getElementById('audio-btn'),
  cardSentence: document.getElementById('card-sentence'),
  cardBack: document.getElementById('card-back'),
  cardPhrase: document.getElementById('card-phrase'),
  cardMeaning: document.getElementById('card-meaning'),
  cardTranslationBlock: document.getElementById('card-translation-block'),
  cardTranslation: document.getElementById('card-translation'),
  cardNoteBlock: document.getElementById('card-note-block'),
  cardNote: document.getElementById('card-note'),

  btnStuck: document.getElementById('btn-stuck'),
  btnKnown: document.getElementById('btn-known'),
  hintStuck: document.getElementById('hint-stuck'),
  hintKnown: document.getElementById('hint-known'),

  completeView: document.getElementById('complete-view'),
  completeTitle: document.getElementById('complete-title'),
  completeSubtitle: document.getElementById('complete-subtitle'),
  completeStats: document.getElementById('complete-stats'),
  statKnown: document.getElementById('stat-known'),
  statStuck: document.getElementById('stat-stuck'),
  btnExtra: document.getElementById('btn-extra'),

  sheetBackdrop: document.getElementById('sheet-backdrop'),
  sheetClose: document.getElementById('sheet-close'),
  exploredLabel: document.getElementById('explored-label'),
  exploredFill: document.getElementById('explored-fill'),
  deckBreakdown: document.getElementById('deck-breakdown'),
  rateButtons: Array.from(document.querySelectorAll('.seg-btn[data-rate]')),
  sourceButtons: Array.from(document.querySelectorAll('.seg-btn[data-source]')),
  toggleVocabHints: document.getElementById('toggle-vocab-hints'),

  importDeckInput: document.getElementById('import-deck-input'),
  btnImportDeck: document.getElementById('btn-import-deck'),
  btnClearDeck: document.getElementById('btn-clear-deck'),

  btnInstallPwa: document.getElementById('btn-install-pwa'),
  installGuide: document.getElementById('install-guide'),

  restoreProgressInput: document.getElementById('restore-progress-input'),
  btnExportProgress: document.getElementById('btn-export-progress'),
  btnRestoreProgress: document.getElementById('btn-restore-progress'),
  btnReset: document.getElementById('btn-reset'),

  vocabTooltip: document.getElementById('vocab-tooltip'),
  vocabTooltipWord: document.getElementById('vocab-tooltip-word'),
  vocabTooltipMeaning: document.getElementById('vocab-tooltip-meaning'),

  toast: document.getElementById('toast'),
};

// App Runtime State
let state = loadState();
let customDeck = loadCustomDeck();
let allPhrases = [];
let phraseMap = new Map();
let activeDeckIds = new Set();
let exampleHistory = loadExampleHistory();

// Locks the chosen example for the active card and previews the next slot consistently
let preparedExamples = new Map();
let activeExample = null;

let isRevealed = false;
let isAnimatingOut = false;
let deferredInstallPrompt = null;
let resetConfirmTimer = null;
let clearDeckConfirmTimer = null;
let toastTimer = null;
let selectedVoice = null;
let activeVocabEl = null;
let tooltipCloseTimer = null;

function rebuildDeckIndex() {
  if (state.prefs.deckSource === 'custom' && customDeck.length === 0) {
    state.prefs.deckSource = 'all';
  }
  allPhrases = buildActiveDeck(PHRASES, customDeck, state.prefs.deckSource);
  phraseMap = new Map(allPhrases.map((p) => [p.id, p]));
  activeDeckIds = new Set(allPhrases.map((p) => p.id));
  preparedExamples.clear();
  activeExample = null;
}

rebuildDeckIndex();

// =========================================================
// Utilities
// =========================================================

function showToast(message) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toast.hidden = true;
  }, 2400);
}

function getCategoryLabel(category) {
  if (CATEGORIES[category]) return CATEGORIES[category].label;
  if (!category || category === 'custom') return '自訂片語';
  return category;
}

function getSlotKey(session, slotIdx, cardId) {
  return `${session.date}:${session.isExtra ? 'x' : 'd'}:${session.completedRoundsToday || 0}:${slotIdx}:${cardId}`;
}

function getPreparedExample(session, slotIdx, card, { recordHistory = false } = {}) {
  const key = getSlotKey(session, slotIdx, card.id);
  let picked = preparedExamples.get(key);
  if (!picked) {
    picked = pickExampleForCard(card, exampleHistory);
    preparedExamples.set(key, picked);
  }
  if (recordHistory && card.examples.length > 1) {
    if (exampleHistory[card.id] !== picked.index) {
      exampleHistory[card.id] = picked.index;
      saveExampleHistory(exampleHistory);
    }
  }
  return picked.example;
}

function isAsciiLetter(ch) {
  return ch ? /[A-Za-z]/.test(ch) : false;
}

function appendTextWithVocab(container, text, vocabList) {
  if (!text) return;
  if (!vocabList || vocabList.length === 0 || state.prefs.showVocabHints === false) {
    container.appendChild(document.createTextNode(text));
    return;
  }

  // Prefer longer words first if two words ever share a prefix
  const sortedVocab = [...vocabList]
    .filter((item) => item && item.word && item.meaning)
    .sort((a, b) => b.word.length - a.word.length);

  let cursor = 0;
  while (cursor < text.length) {
    let bestIdx = -1;
    let bestItem = null;

    for (const item of sortedVocab) {
      let searchFrom = cursor;
      while (searchFrom < text.length) {
        const foundIdx = text.indexOf(item.word, searchFrom);
        if (foundIdx === -1) break;

        const prevCh = foundIdx > 0 ? text[foundIdx - 1] : '';
        const nextCh =
          foundIdx + item.word.length < text.length
            ? text[foundIdx + item.word.length]
            : '';

        if (!isAsciiLetter(prevCh) && !isAsciiLetter(nextCh)) {
          if (bestIdx === -1 || foundIdx < bestIdx) {
            bestIdx = foundIdx;
            bestItem = item;
          }
          break;
        }
        searchFrom = foundIdx + 1;
      }
    }

    if (bestIdx === -1 || !bestItem) {
      container.appendChild(document.createTextNode(text.slice(cursor)));
      break;
    }

    if (bestIdx > cursor) {
      container.appendChild(document.createTextNode(text.slice(cursor, bestIdx)));
    }

    const span = document.createElement('span');
    span.className = 'vocab-word';
    span.setAttribute('role', 'button');
    span.setAttribute('tabindex', '0');
    span.setAttribute('aria-label', `${bestItem.word}，點擊查看中文意思`);
    span.dataset.word = bestItem.word;
    span.dataset.meaning = bestItem.meaning;
    span.textContent = bestItem.word;
    container.appendChild(span);

    cursor = bestIdx + bestItem.word.length;
  }
}

function renderHighlightedSentence(container, sentence, highlight, vocabList = null) {
  container.textContent = '';
  if (!sentence) return;

  if (!highlight) {
    appendTextWithVocab(container, sentence, vocabList);
    return;
  }

  const idx = sentence.indexOf(highlight);
  if (idx === -1) {
    appendTextWithVocab(container, sentence, vocabList);
    return;
  }

  const before = sentence.slice(0, idx);
  const match = sentence.slice(idx, idx + highlight.length);
  const after = sentence.slice(idx + highlight.length);

  if (before) appendTextWithVocab(container, before, vocabList);
  const mark = document.createElement('mark');
  mark.className = 'phrase-highlight';
  mark.textContent = match;
  container.appendChild(mark);
  if (after) appendTextWithVocab(container, after, vocabList);
}

// =========================================================
// Vocab Peek Tooltip (Boundary-Safe & Single-Hand Friendly)
// =========================================================

function closeVocabTooltip({ immediate = false } = {}) {
  clearTimeout(tooltipCloseTimer);
  if (activeVocabEl) {
    activeVocabEl.classList.remove('is-active');
    activeVocabEl = null;
  }
  els.vocabTooltip.classList.remove('is-open');

  if (immediate) {
    els.vocabTooltip.hidden = true;
    return;
  }

  tooltipCloseTimer = setTimeout(() => {
    if (!activeVocabEl) {
      els.vocabTooltip.hidden = true;
    }
  }, 160);
}

function positionVocabTooltip(anchorEl) {
  const VIEWPORT_MARGIN = 12;
  const GAP = 10;

  const anchorRect = anchorEl.getBoundingClientRect();
  els.vocabTooltip.hidden = false;

  const tipRect = els.vocabTooltip.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // Prefer directly above the word; fall back below if top space is tight
  let placement = 'top';
  let top = anchorRect.top - tipRect.height - GAP;
  if (top < VIEWPORT_MARGIN) {
    placement = 'bottom';
    top = anchorRect.bottom + GAP;
    if (top + tipRect.height > vh - VIEWPORT_MARGIN) {
      top = Math.max(VIEWPORT_MARGIN, vh - VIEWPORT_MARGIN - tipRect.height);
    }
  }

  // Horizontal clamping so tooltip never overflows phone screen edges
  const anchorCenterX = anchorRect.left + anchorRect.width / 2;
  const idealLeft = anchorCenterX - tipRect.width / 2;
  const maxLeft = Math.max(VIEWPORT_MARGIN, vw - VIEWPORT_MARGIN - tipRect.width);
  const left = Math.max(VIEWPORT_MARGIN, Math.min(idealLeft, maxLeft));

  // Keep arrow pointed directly at the tapped word even when bubble is clamped
  const arrowX = Math.max(14, Math.min(tipRect.width - 14, anchorCenterX - left));

  els.vocabTooltip.dataset.placement = placement;
  els.vocabTooltip.style.left = `${Math.round(left)}px`;
  els.vocabTooltip.style.top = `${Math.round(top)}px`;
  els.vocabTooltip.style.setProperty('--arrow-x', `${Math.round(arrowX)}px`);
}

function toggleVocabTooltip(wordEl) {
  if (state.prefs.showVocabHints === false) return;

  if (activeVocabEl === wordEl) {
    closeVocabTooltip();
    return;
  }

  clearTimeout(tooltipCloseTimer);
  if (activeVocabEl) {
    activeVocabEl.classList.remove('is-active');
  }

  activeVocabEl = wordEl;
  wordEl.classList.add('is-active');

  els.vocabTooltipWord.textContent = wordEl.dataset.word || '';
  els.vocabTooltipMeaning.textContent = wordEl.dataset.meaning || '';

  els.vocabTooltip.classList.remove('is-open');
  positionVocabTooltip(wordEl);

  requestAnimationFrame(() => {
    if (activeVocabEl === wordEl) {
      els.vocabTooltip.classList.add('is-open');
    }
  });
}

function refreshActiveSentence() {
  if (!activeExample) return;
  closeVocabTooltip({ immediate: true });
  renderHighlightedSentence(
    els.cardSentence,
    activeExample.en,
    activeExample.match,
    activeExample.vocab || null
  );
}

function formatIntervalLabel(days) {
  if (days <= 1) return '明天再見';
  return `${days} 天後`;
}

// =========================================================
// Web Speech API Pronunciation (Manual Trigger Only)
// =========================================================

function pickEnglishVoice() {
  if (!('speechSynthesis' in window)) return null;
  const voices = window.speechSynthesis.getVoices();
  if (!voices || voices.length === 0) return null;

  const preferredNames = [
    'Google US English',
    'Samantha',
    'Aria',
    'Jenny',
    'Guy',
    'Alex',
    'Daniel',
  ];
  for (const name of preferredNames) {
    const match = voices.find((v) => v.name.includes(name) && v.lang.startsWith('en'));
    if (match) return match;
  }

  return (
    voices.find((v) => v.lang === 'en-US') ||
    voices.find((v) => v.lang.startsWith('en-')) ||
    voices[0]
  );
}

function stopSpeaking() {
  if ('speechSynthesis' in window) {
    if (window.speechSynthesis.speaking || window.speechSynthesis.pending) {
      window.speechSynthesis.cancel();
    }
  }
  els.audioBtn.classList.remove('is-speaking');
}

function speakCurrentSentence() {
  if (!('speechSynthesis' in window)) {
    showToast('目前瀏覽器不支援語音朗讀');
    return;
  }

  if (!activeExample || !activeExample.en) return;

  // Toggle off if already speaking
  if (els.audioBtn.classList.contains('is-speaking') && window.speechSynthesis.speaking) {
    stopSpeaking();
    return;
  }

  if (window.speechSynthesis.speaking || window.speechSynthesis.pending) {
    window.speechSynthesis.cancel();
  }

  const utterance = new SpeechSynthesisUtterance(activeExample.en);
  utterance.lang = 'en-US';
  utterance.rate = state.prefs.speechRate || 0.96;
  utterance.pitch = 1;

  if (!selectedVoice) {
    selectedVoice = pickEnglishVoice();
  }
  if (selectedVoice) {
    utterance.voice = selectedVoice;
  }

  utterance.onstart = () => {
    els.audioBtn.classList.add('is-speaking');
  };
  utterance.onend = () => {
    els.audioBtn.classList.remove('is-speaking');
  };
  utterance.onerror = () => {
    els.audioBtn.classList.remove('is-speaking');
  };

  els.audioBtn.classList.add('is-speaking');
  window.speechSynthesis.speak(utterance);
}

if ('speechSynthesis' in window) {
  selectedVoice = pickEnglishVoice();
  window.speechSynthesis.addEventListener('voiceschanged', () => {
    selectedVoice = pickEnglishVoice();
  });
}

// =========================================================
// Rendering
// =========================================================

let scrollCheckTimer = null;

function updateCardScrollable() {
  const scroller = els.activeCard.querySelector('.card-scroll-inner');
  if (!isRevealed || !scroller) {
    els.activeCard.classList.remove('can-scroll');
    return;
  }
  const overflows = scroller.scrollHeight > scroller.clientHeight + 2;
  els.activeCard.classList.toggle('can-scroll', overflows);
}

function setCardRevealed(revealed) {
  closeVocabTooltip();
  clearTimeout(scrollCheckTimer);
  isRevealed = revealed;
  els.activeCard.classList.toggle('is-revealed', revealed);
  els.activeCard.setAttribute('aria-expanded', String(revealed));
  els.cardBack.setAttribute('aria-hidden', String(!revealed));

  if (!revealed) {
    els.activeCard.classList.remove('can-scroll');
  } else {
    requestAnimationFrame(updateCardScrollable);
    scrollCheckTimer = setTimeout(updateCardScrollable, 300);
  }
}

function resetCardTransform() {
  els.activeCard.classList.remove('is-dragging', 'is-leaving-left', 'is-leaving-right', 'is-entering');
  els.activeCard.style.transform = '';
  els.activeCard.style.borderColor = '';
  els.stampKnown.style.opacity = '0';
  els.stampStuck.style.opacity = '0';
  els.nextCardGhost.style.transform = '';
  els.nextCardGhost.style.opacity = '';
}

function renderProgress() {
  const session = state.session;
  const total = session ? session.queue.length : 0;
  const completed = session ? Math.min(session.index, total) : 0;

  if (total === 0) {
    els.progressFill.style.width = '100%';
    els.progressLabel.textContent = '已完成';
    els.progressTrack.setAttribute('aria-valuemax', '10');
    els.progressTrack.setAttribute('aria-valuenow', '10');
    return;
  }

  const isDone = completed >= total;
  const pct = (completed / total) * 100;
  els.progressFill.style.width = `${pct}%`;
  els.progressLabel.textContent = isDone ? `${total} / ${total}` : `${completed + 1} / ${total}`;
  els.progressTrack.setAttribute('aria-valuemax', String(total));
  els.progressTrack.setAttribute('aria-valuenow', String(completed));
}

function renderActiveCard({ animateEntrance = false } = {}) {
  closeVocabTooltip({ immediate: true });

  const session = state.session;
  const isDone = !session || session.index >= session.queue.length;

  renderProgress();

  if (isDone) {
    activeExample = null;
    stopSpeaking();
    els.studyView.hidden = true;
    els.completeView.hidden = false;
    renderCompleteView();
    return;
  }

  els.completeView.hidden = true;
  els.studyView.hidden = false;

  const currentId = session.queue[session.index];
  const current = phraseMap.get(currentId);
  if (!current) {
    syncSessionWithDeck(state, allPhrases, getLocalDateStr());
    saveState(state);
    renderActiveCard({ animateEntrance: false });
    return;
  }

  const nextId = session.queue[session.index + 1];
  const next = nextId ? phraseMap.get(nextId) : null;

  // Lock in the chosen example for this card (avoids back-to-back repeats)
  activeExample = getPreparedExample(session, session.index, current, {
    recordHistory: true,
  });

  // Populate active card (front highlight, vocab underlines, back translation & audio all sync to activeExample)
  els.cardCategory.textContent = getCategoryLabel(current.category);
  renderHighlightedSentence(
    els.cardSentence,
    activeExample.en,
    activeExample.match,
    activeExample.vocab || null
  );
  els.cardPhrase.textContent = current.phrase;
  els.cardMeaning.textContent = current.meaning;

  if (activeExample.zh) {
    els.cardTranslationBlock.hidden = false;
    els.cardTranslation.textContent = activeExample.zh;
  } else {
    els.cardTranslationBlock.hidden = true;
    els.cardTranslation.textContent = '';
  }

  if (current.note) {
    els.cardNoteBlock.hidden = false;
    els.cardNote.textContent = current.note;
  } else {
    els.cardNoteBlock.hidden = true;
    els.cardNote.textContent = '';
  }

  // Subtle interval preview on bottom buttons
  const nextDays = previewIntervalDays(state, current.id, 'known');
  els.hintKnown.textContent = formatIntervalLabel(nextDays);
  els.hintStuck.textContent = '明天再見';

  // Reset scroll position & collapsed state
  const scroller = els.activeCard.querySelector('.card-scroll-inner');
  if (scroller) scroller.scrollTop = 0;
  setCardRevealed(false);

  // Populate ghost card behind active card with the pre-picked next example
  if (next) {
    const nextExample = getPreparedExample(session, session.index + 1, next, {
      recordHistory: false,
    });
    els.ghostCategory.textContent = getCategoryLabel(next.category);
    renderHighlightedSentence(els.ghostSentence, nextExample.en, nextExample.match, null);
    els.nextCardGhost.classList.remove('is-empty');
  } else {
    els.ghostCategory.textContent = '';
    els.ghostSentence.textContent = '';
    els.nextCardGhost.classList.add('is-empty');
  }

  resetCardTransform();

  if (animateEntrance) {
    els.activeCard.classList.add('is-entering');
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        els.activeCard.classList.remove('is-entering');
      });
    });
  }
}

function renderCompleteView() {
  const session = state.session;
  const totalReviewed = (session.stats?.known || 0) + (session.stats?.stuck || 0);

  if (session.allCaughtUp && totalReviewed === 0) {
    els.completeTitle.textContent = '今天已全部消化完畢';
    els.completeSubtitle.textContent = '所有片語都乖乖排在未來複習中，想多刷一點也沒問題。';
    els.completeStats.hidden = true;
  } else if (session.isExtra) {
    els.completeTitle.textContent = `加碼 ${session.batchSize} 張完成！`;
    els.completeSubtitle.textContent = '手感真好，隨時都可以停下來休息。';
    els.completeStats.hidden = false;
  } else {
    els.completeTitle.textContent = `今日份 ${session.batchSize} 張完成！`;
    els.completeSubtitle.textContent = '剛好就好，明天再輕鬆刷一輪。';
    els.completeStats.hidden = false;
  }

  els.statKnown.textContent = String(session.stats?.known || 0);
  els.statStuck.textContent = String(session.stats?.stuck || 0);
}

function resetClearDeckConfirm() {
  clearTimeout(clearDeckConfirmTimer);
  els.btnClearDeck.classList.remove('is-confirming');
  els.btnClearDeck.textContent = `清除已匯入題庫（${customDeck.length} 張）`;
}

function renderSettingsSheet() {
  const source = state.prefs.deckSource || 'all';
  const explored = getExploredCount(state, activeDeckIds);
  const total = allPhrases.length;
  els.exploredLabel.textContent = `${explored} / ${total} 組`;
  els.exploredFill.style.width = total > 0 ? `${Math.round((explored / total) * 100)}%` : '0%';

  if (source === 'custom') {
    els.deckBreakdown.hidden = false;
    els.deckBreakdown.textContent = `目前範圍：僅自訂（共 ${customDeck.length} 組）`;
  } else if (source === 'builtin') {
    els.deckBreakdown.hidden = false;
    els.deckBreakdown.textContent =
      customDeck.length > 0
        ? `目前範圍：僅內建（另存自訂 ${customDeck.length} 組）`
        : `目前範圍：僅內建（共 ${PHRASES.length} 組）`;
  } else if (customDeck.length > 0) {
    const netAdded = Math.max(0, total - PHRASES.length);
    els.deckBreakdown.hidden = false;
    els.deckBreakdown.textContent =
      netAdded === customDeck.length
        ? `目前範圍：全部（內建 ${PHRASES.length} ＋ 自訂 ${customDeck.length}）`
        : `目前範圍：全部（共 ${total} 組，含自訂 ${customDeck.length} 組）`;
  } else {
    els.deckBreakdown.hidden = true;
  }

  if (customDeck.length > 0) {
    els.btnClearDeck.hidden = false;
    if (!els.btnClearDeck.classList.contains('is-confirming')) {
      els.btnClearDeck.textContent = `清除已匯入題庫（${customDeck.length} 張）`;
    }
  } else {
    els.btnClearDeck.hidden = true;
  }

  const rate = state.prefs.speechRate || 0.96;
  for (const btn of els.rateButtons) {
    const btnRate = Number(btn.dataset.rate);
    btn.classList.toggle('is-active', Math.abs(btnRate - rate) < 0.02);
  }

  for (const btn of els.sourceButtons) {
    const btnSource = btn.dataset.source;
    btn.classList.toggle('is-active', btnSource === source);
    btn.classList.toggle('is-empty-source', btnSource === 'custom' && customDeck.length === 0);
  }

  els.toggleVocabHints.setAttribute(
    'aria-checked',
    String(state.prefs.showVocabHints !== false)
  );

  els.btnInstallPwa.hidden = !deferredInstallPrompt;
}

// =========================================================
// Review Actions (Button Tap or Swipe)
// =========================================================

function commitDecision(outcome) {
  if (isAnimatingOut) return;
  const session = state.session;
  if (!session || session.index >= session.queue.length) return;

  isAnimatingOut = true;
  closeVocabTooltip({ immediate: true });
  stopSpeaking();

  // Gentle haptic feedback on supported mobile devices
  if (typeof navigator.vibrate === 'function') {
    navigator.vibrate(outcome === 'known' ? 12 : 18);
  }

  // Show stamp briefly when triggered via bottom button
  if (outcome === 'known') {
    els.stampKnown.style.opacity = '1';
    els.activeCard.classList.add('is-leaving-right');
  } else {
    els.stampStuck.style.opacity = '1';
    els.activeCard.classList.add('is-leaving-left');
  }

  // Bring ghost card smoothly forward while active card flies away
  els.nextCardGhost.style.transform = 'scale(1) translateY(0px)';
  els.nextCardGhost.style.opacity = '0.9';

  reviewCurrentCard(state, outcome, getLocalDateStr());
  saveState(state);

  setTimeout(() => {
    isAnimatingOut = false;
    renderActiveCard({ animateEntrance: false });
  }, 240);
}

// =========================================================
// Dedicated Touch (Mobile) + Mouse (Desktop) Swipe Engine
// =========================================================

const drag = {
  active: false,
  source: null, // 'touch' | 'mouse'
  touchId: null,
  startX: 0,
  startY: 0,
  lastX: 0,
  lastTime: 0,
  prevX: 0,
  prevTime: 0,
  maxMove: 0,
  mode: null, // 'swipe' | 'scroll' | null
};

let lastTouchEndTime = 0;

const AXIS_LOCK_DISTANCE = 5;
const TAP_MAX_MOVE = 10;
const SWIPE_COMMIT_DISTANCE = 75;
const SWIPE_VELOCITY_THRESHOLD = 0.42;

function isInteractiveTarget(target) {
  return Boolean(target && target.closest('#audio-btn, .vocab-word, button'));
}

function lockHorizontalSwipe() {
  if (drag.mode === 'swipe') return;
  drag.mode = 'swipe';
  closeVocabTooltip();
  els.activeCard.classList.add('is-dragging');
}

function updateSwipeVisuals(dx) {
  const progress = Math.min(1, Math.abs(dx) / 95);
  const rotate = dx * 0.042;
  els.activeCard.style.transform = `translate3d(${dx}px, 0, 0) rotate(${rotate}deg)`;

  if (dx > 0) {
    els.stampKnown.style.opacity = String(progress);
    els.stampStuck.style.opacity = '0';
    els.activeCard.style.borderColor = `rgba(74, 222, 128, ${0.1 + progress * 0.45})`;
  } else {
    els.stampStuck.style.opacity = String(progress);
    els.stampKnown.style.opacity = '0';
    els.activeCard.style.borderColor = `rgba(239, 111, 108, ${0.1 + progress * 0.45})`;
  }

  // Smoothly bring ghost card up underneath
  const ghostScale = 0.945 + progress * 0.055;
  const ghostY = 14 - progress * 14;
  const ghostOpacity = 0.42 + progress * 0.48;
  els.nextCardGhost.style.transform = `scale(${ghostScale}) translateY(${ghostY}px)`;
  els.nextCardGhost.style.opacity = String(ghostOpacity);
}

function beginDrag(source, clientX, clientY, touchId = null) {
  const now = performance.now();
  drag.active = true;
  drag.source = source;
  drag.touchId = touchId;
  drag.startX = clientX;
  drag.startY = clientY;
  drag.lastX = clientX;
  drag.lastTime = now;
  drag.prevX = clientX;
  drag.prevTime = now;
  drag.maxMove = 0;
  drag.mode = null;
}

function handleDragMove(clientX, clientY, { canScrollVertically = false } = {}) {
  const dx = clientX - drag.startX;
  const dy = clientY - drag.startY;
  const dist = Math.hypot(dx, dy);
  if (dist > drag.maxMove) drag.maxMove = dist;

  if (!drag.mode) {
    if (dist < AXIS_LOCK_DISTANCE) return;
    if (Math.abs(dx) >= Math.abs(dy) * 0.7 || !canScrollVertically) {
      lockHorizontalSwipe();
    } else {
      drag.mode = 'scroll';
      closeVocabTooltip();
      return;
    }
  }

  if (drag.mode !== 'swipe') return;

  const now = performance.now();
  if (now - drag.lastTime >= 16) {
    drag.prevX = drag.lastX;
    drag.prevTime = drag.lastTime;
    drag.lastX = clientX;
    drag.lastTime = now;
  }

  updateSwipeVisuals(dx);
}

function finishDrag(clientX, clientY, endTarget) {
  const dx = clientX - drag.startX;
  const dy = clientY - drag.startY;
  const maxMove = Math.max(drag.maxMove, Math.hypot(dx, dy));
  const dt = Math.max(1, performance.now() - drag.prevTime);
  const recentVelocity = (clientX - drag.prevX) / dt;
  const mode = drag.mode;

  drag.active = false;
  drag.source = null;
  drag.touchId = null;
  drag.mode = null;
  drag.maxMove = 0;

  if (mode === 'swipe') {
    els.activeCard.classList.remove('is-dragging');
    const isFlick =
      Math.abs(recentVelocity) >= SWIPE_VELOCITY_THRESHOLD &&
      Math.abs(dx) >= 28 &&
      Math.sign(recentVelocity) === Math.sign(dx);

    if (Math.abs(dx) >= SWIPE_COMMIT_DISTANCE || isFlick) {
      commitDecision(dx > 0 ? 'known' : 'stuck');
    } else {
      resetCardTransform();
    }
    return;
  }

  // Strictly prevent accidental card flip whenever movement exceeded 10px
  if (mode === null && maxMove < TAP_MAX_MOVE) {
    if (activeVocabEl) {
      closeVocabTooltip();
      if (endTarget && endTarget.closest && endTarget.closest('#reveal-hint')) {
        setCardRevealed(!isRevealed);
      }
      return;
    }
    setCardRevealed(!isRevealed);
  }
}

function cancelActiveDrag() {
  if (!drag.active) return;
  drag.active = false;
  drag.source = null;
  drag.touchId = null;
  drag.mode = null;
  drag.maxMove = 0;
  resetCardTransform();
}

function findTrackedTouch(touchList, touchId) {
  for (let i = 0; i < touchList.length; i++) {
    if (touchList[i].identifier === touchId) return touchList[i];
  }
  return null;
}

// --- Mobile Touch Handlers ---
function onCardTouchStart(e) {
  if (isAnimatingOut) return;
  if (e.touches.length !== 1) return;
  if (isInteractiveTarget(e.target)) return;

  const touch = e.touches[0];
  beginDrag('touch', touch.clientX, touch.clientY, touch.identifier);
}

function onCardTouchMove(e) {
  if (!drag.active || drag.source !== 'touch') return;
  const touch = findTrackedTouch(e.touches, drag.touchId) || e.touches[0];
  if (!touch) return;

  const canScroll = els.activeCard.classList.contains('can-scroll');
  handleDragMove(touch.clientX, touch.clientY, { canScrollVertically: canScroll });

  // Prevent browser takeover on EVERY frame once horizontal swipe is locked
  if (drag.mode === 'swipe' && e.cancelable) {
    e.preventDefault();
  }
}

function onCardTouchEnd(e) {
  lastTouchEndTime = performance.now();
  if (!drag.active || drag.source !== 'touch') return;
  const touch =
    findTrackedTouch(e.changedTouches, drag.touchId) || e.changedTouches[0];
  if (!touch) {
    cancelActiveDrag();
    return;
  }

  finishDrag(touch.clientX, touch.clientY, e.target);
}

function onCardTouchCancel() {
  lastTouchEndTime = performance.now();
  if (!drag.active || drag.source !== 'touch') return;
  cancelActiveDrag();
}

// --- Desktop Mouse Handlers ---
function onCardMouseDown(e) {
  if (isAnimatingOut) return;
  if (performance.now() - lastTouchEndTime < 700) return; // Ignore synthetic mouse events after touch
  if (e.button !== 0) return;
  if (isInteractiveTarget(e.target)) return;

  beginDrag('mouse', e.clientX, e.clientY, null);
}

function onWindowMouseMove(e) {
  if (!drag.active || drag.source !== 'mouse') return;
  handleDragMove(e.clientX, e.clientY, { canScrollVertically: false });
}

function onWindowMouseUp(e) {
  if (!drag.active || drag.source !== 'mouse') return;
  finishDrag(e.clientX, e.clientY, e.target);
}

// =========================================================
// Event Listeners — Card & Tooltip
// =========================================================

els.activeCard.addEventListener('touchstart', onCardTouchStart, { passive: true });
els.activeCard.addEventListener('touchmove', onCardTouchMove, { passive: false });
els.activeCard.addEventListener('touchend', onCardTouchEnd, { passive: true });
els.activeCard.addEventListener('touchcancel', onCardTouchCancel, { passive: true });

els.activeCard.addEventListener('mousedown', onCardMouseDown);
window.addEventListener('mousemove', onWindowMouseMove);
window.addEventListener('mouseup', onWindowMouseUp);

els.audioBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  closeVocabTooltip();
  speakCurrentSentence();
});

// Delegated vocab word tap handlers (strictly isolated from card flip & swipe)
function stopVocabEvent(e) {
  const wordEl = e.target.closest('.vocab-word');
  if (!wordEl) return;
  e.stopPropagation();
}

els.cardSentence.addEventListener('touchstart', stopVocabEvent, { passive: true });
els.cardSentence.addEventListener('mousedown', stopVocabEvent);

els.cardSentence.addEventListener('click', (e) => {
  const wordEl = e.target.closest('.vocab-word');
  if (!wordEl) return;
  e.stopPropagation();
  e.preventDefault();
  toggleVocabTooltip(wordEl);
});

els.cardSentence.addEventListener('keydown', (e) => {
  const wordEl = e.target.closest('.vocab-word');
  if (!wordEl) return;
  if (e.key === 'Enter' || e.key === ' ') {
    e.stopPropagation();
    e.preventDefault();
    toggleVocabTooltip(wordEl);
  }
});

els.vocabTooltip.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true });
els.vocabTooltip.addEventListener('mousedown', (e) => e.stopPropagation());
els.vocabTooltip.addEventListener('click', (e) => e.stopPropagation());

// Close tooltip when tapping outside card, scrolling card body, or resizing viewport
function onOutsideStart(e) {
  if (!activeVocabEl) return;
  if (
    e.target.closest('.vocab-word') ||
    e.target.closest('#vocab-tooltip') ||
    e.target.closest('#active-card')
  ) {
    return;
  }
  closeVocabTooltip();
}

document.addEventListener('touchstart', onOutsideStart, { passive: true });
document.addEventListener('mousedown', onOutsideStart);

const cardScrollInner = els.activeCard.querySelector('.card-scroll-inner');
if (cardScrollInner) {
  cardScrollInner.addEventListener(
    'scroll',
    () => {
      if (activeVocabEl) closeVocabTooltip();
    },
    { passive: true }
  );
}

window.addEventListener('resize', () => {
  if (activeVocabEl) closeVocabTooltip();
  updateCardScrollable();
});

els.btnStuck.addEventListener('click', () => commitDecision('stuck'));
els.btnKnown.addEventListener('click', () => commitDecision('known'));

els.btnExtra.addEventListener('click', () => {
  startExtraBatch(state, allPhrases, getLocalDateStr());
  saveState(state);
  preparedExamples.clear();
  renderActiveCard({ animateEntrance: true });
});

// Keyboard shortcuts (for desktop testing / accessibility)
document.addEventListener('keydown', (e) => {
  if (!els.sheetBackdrop.hidden) {
    if (e.key === 'Escape') closeSheet();
    return;
  }
  if (els.studyView.hidden) return;

  if (e.key === 'Escape' && activeVocabEl) {
    e.preventDefault();
    closeVocabTooltip();
    return;
  }

  if (e.key === ' ' || e.key === 'Enter') {
    if (
      document.activeElement === els.audioBtn ||
      document.activeElement?.classList.contains('vocab-word')
    ) {
      return;
    }
    e.preventDefault();
    setCardRevealed(!isRevealed);
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault();
    commitDecision('stuck');
  } else if (e.key === 'ArrowRight') {
    e.preventDefault();
    commitDecision('known');
  } else if (e.key.toLowerCase() === 's') {
    e.preventDefault();
    speakCurrentSentence();
  }
});

// =========================================================
// Settings Sheet — Preferences, Import/Clear Deck & Backup
// =========================================================

function openSheet() {
  closeVocabTooltip();
  els.btnReset.classList.remove('is-confirming');
  els.btnReset.textContent = '重置學習進度';
  resetClearDeckConfirm();
  renderSettingsSheet();
  els.sheetBackdrop.hidden = false;
  els.menuBtn.setAttribute('aria-expanded', 'true');
}

function closeSheet() {
  els.sheetBackdrop.hidden = true;
  els.menuBtn.setAttribute('aria-expanded', 'false');
  clearTimeout(resetConfirmTimer);
  clearTimeout(clearDeckConfirmTimer);
}

els.menuBtn.addEventListener('click', openSheet);
els.sheetClose.addEventListener('click', closeSheet);
els.sheetBackdrop.addEventListener('click', (e) => {
  if (e.target === els.sheetBackdrop) closeSheet();
});

for (const btn of els.rateButtons) {
  btn.addEventListener('click', () => {
    state.prefs.speechRate = Number(btn.dataset.rate);
    saveState(state);
    renderSettingsSheet();
    showToast(state.prefs.speechRate < 0.9 ? '已切換為慢速朗讀' : '已切換為標準語速');
  });
}

els.toggleVocabHints.addEventListener('click', () => {
  const nextVal = state.prefs.showVocabHints === false;
  state.prefs.showVocabHints = nextVal;
  saveState(state);
  renderSettingsSheet();
  refreshActiveSentence();
  showToast(nextVal ? '已開啟難字底線提示' : '已關閉難字底線提示');
});

// Deck Source Switcher (全部 / 僅自訂 / 僅內建)
const DECK_SOURCE_LABELS = {
  all: '全部題庫',
  custom: '僅自訂題庫',
  builtin: '僅內建題庫',
};

for (const btn of els.sourceButtons) {
  btn.addEventListener('click', () => {
    const nextSource = btn.dataset.source;
    if (nextSource === 'custom' && customDeck.length === 0) {
      showToast('請先匯入 JSON 題庫');
      return;
    }
    if (nextSource === state.prefs.deckSource) return;

    state.prefs.deckSource = nextSource;
    rebuildDeckIndex();
    rebuildSessionForDeckSource(state, allPhrases, getLocalDateStr());
    saveState(state);

    renderSettingsSheet();
    renderActiveCard({ animateEntrance: true });
    showToast(`已切換：${DECK_SOURCE_LABELS[nextSource] || '全部題庫'}`);
  });
}

// Local JSON Deck Import
els.btnImportDeck.addEventListener('click', () => {
  els.importDeckInput.click();
});

els.importDeckInput.addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;

  try {
    const rawText = await file.text();
    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      showToast('檔案不是有效的 JSON 格式');
      return;
    }

    const validation = validateImportedDeck(parsed);
    if (!validation.ok) {
      showToast(`匯入失敗：${validation.error}`);
      return;
    }

    const { merged, addedCount, updatedCount } = mergeCustomCards(
      customDeck,
      validation.cards
    );

    const saveRes = saveCustomDeck(merged);
    if (!saveRes.ok) {
      showToast(
        saveRes.quotaExceeded
          ? '瀏覽器儲存空間不足，無法匯入此題庫'
          : '無法儲存匯入的題庫'
      );
      return;
    }

    customDeck = merged;
    rebuildDeckIndex();

    const today = getLocalDateStr();
    syncSessionWithDeck(state, allPhrases, today);
    saveState(state);

    resetClearDeckConfirm();
    renderSettingsSheet();
    renderActiveCard({ animateEntrance: false });

    if (updatedCount > 0 && addedCount === 0) {
      showToast(`已更新 ${updatedCount} 張卡片（保留進度）`);
    } else if (updatedCount > 0) {
      showToast(`已匯入 ${validation.cards.length} 張卡片（更新 ${updatedCount} 張）`);
    } else {
      showToast(`已匯入 ${validation.cards.length} 張卡片`);
    }
  } catch {
    showToast('讀取檔案失敗，請再試一次');
  } finally {
    e.target.value = '';
  }
});

// Clear Custom Imported Deck (2-step confirm, preserves built-in 50 cards' progress)
els.btnClearDeck.addEventListener('click', () => {
  if (!els.btnClearDeck.classList.contains('is-confirming')) {
    els.btnClearDeck.classList.add('is-confirming');
    els.btnClearDeck.textContent = '再點一次確認清除自訂題庫';
    clearTimeout(clearDeckConfirmTimer);
    clearDeckConfirmTimer = setTimeout(resetClearDeckConfirm, 3500);
    return;
  }

  clearTimeout(clearDeckConfirmTimer);
  customDeck = [];
  saveCustomDeck([]);
  rebuildDeckIndex();

  const today = getLocalDateStr();
  syncSessionWithDeck(state, allPhrases, today);
  saveState(state);

  els.btnClearDeck.classList.remove('is-confirming');
  renderSettingsSheet();
  renderActiveCard({ animateEntrance: false });
  showToast('已清除自訂題庫（內建進度已保留）');
});

// Export Progress JSON Backup
els.btnExportProgress.addEventListener('click', () => {
  try {
    const payload = buildBackupPayload(state, customDeck);
    const json = JSON.stringify(payload, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `scenecard-backup-${getLocalDateStr()}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast('已匯出學習進度備份');
  } catch {
    showToast('匯出失敗，請再試一次');
  }
});

// Restore Progress JSON Backup
els.btnRestoreProgress.addEventListener('click', () => {
  els.restoreProgressInput.click();
});

els.restoreProgressInput.addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;

  try {
    const rawText = await file.text();
    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      showToast('備份檔不是有效的 JSON 格式');
      return;
    }

    const result = parseBackupPayload(parsed);
    if (!result.ok) {
      showToast(`還原失敗：${result.error}`);
      return;
    }

    if (result.customDeck && result.customDeck.length > 0) {
      const saveRes = saveCustomDeck(result.customDeck);
      if (saveRes.ok) {
        customDeck = result.customDeck;
      }
    }

    state = result.state;
    rebuildDeckIndex();
    const today = getLocalDateStr();
    ensureTodaySession(state, allPhrases, today);
    syncSessionWithDeck(state, allPhrases, today);
    saveState(state);

    preparedExamples.clear();
    renderSettingsSheet();
    renderActiveCard({ animateEntrance: true });
    showToast(`已還原 ${result.cardCount} 筆學習進度`);
  } catch {
    showToast('讀取備份檔失敗，請再試一次');
  } finally {
    e.target.value = '';
  }
});

// Reset SRS Progress (2-step confirm)
els.btnReset.addEventListener('click', () => {
  if (!els.btnReset.classList.contains('is-confirming')) {
    els.btnReset.classList.add('is-confirming');
    els.btnReset.textContent = '再點一次確認重置';
    clearTimeout(resetConfirmTimer);
    resetConfirmTimer = setTimeout(() => {
      els.btnReset.classList.remove('is-confirming');
      els.btnReset.textContent = '重置學習進度';
    }, 3500);
    return;
  }

  clearTimeout(resetConfirmTimer);
  const preservedRate = state.prefs.speechRate;
  const preservedVocabHints = state.prefs.showVocabHints;
  const preservedDeckSource = state.prefs.deckSource;
  state = createEmptyState();
  state.prefs.speechRate = preservedRate;
  state.prefs.showVocabHints = preservedVocabHints;
  state.prefs.deckSource = preservedDeckSource;
  rebuildDeckIndex();
  ensureTodaySession(state, allPhrases, getLocalDateStr());
  saveState(state);
  preparedExamples.clear();
  closeSheet();
  renderActiveCard({ animateEntrance: true });
  showToast('已重置學習進度');
});

// Handle day rollover when user returns to an already-open PWA tab the next day
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    const today = getLocalDateStr();
    if (!state.session || state.session.date !== today) {
      ensureTodaySession(state, allPhrases, today);
      saveState(state);
      preparedExamples.clear();
      renderActiveCard({ animateEntrance: true });
    }
  }
});

// =========================================================
// PWA Install & Service Worker Registration
// =========================================================

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  els.btnInstallPwa.hidden = false;
});

els.btnInstallPwa.addEventListener('click', async () => {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  const { outcome } = await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  els.btnInstallPwa.hidden = true;
  if (outcome === 'accepted') {
    closeSheet();
    showToast('已加入主畫面');
  }
});

window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  els.btnInstallPwa.hidden = true;
});

if ('serviceWorker' in navigator) {
  const hadController = Boolean(navigator.serviceWorker.controller);
  let hasReloadedForUpdate = false;

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController && !hasReloadedForUpdate) {
      hasReloadedForUpdate = true;
      window.location.reload();
    }
  });

  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('./sw.js')
      .then((reg) => {
        reg.update().catch(() => {});
      })
      .catch(() => {
        // Service worker registration skipped on unsupported origins (e.g., file://)
      });
  });
}

// =========================================================
// Boot
// =========================================================

ensureTodaySession(state, allPhrases, getLocalDateStr());
saveState(state);
renderActiveCard({ animateEntrance: false });
