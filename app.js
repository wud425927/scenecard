import { PHRASES, CATEGORIES } from './data/phrases.js';
import {
  createEmptyState,
  ensureTodaySession,
  getExploredCount,
  getLocalDateStr,
  loadState,
  previewIntervalDays,
  reviewCurrentCard,
  saveState,
  startExtraBatch,
} from './srs.js';

const PHRASE_MAP = new Map(PHRASES.map((p) => [p.id, p]));

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
  cardTranslation: document.getElementById('card-translation'),
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
  rateButtons: Array.from(document.querySelectorAll('.seg-btn[data-rate]')),
  btnInstallPwa: document.getElementById('btn-install-pwa'),
  installGuide: document.getElementById('install-guide'),
  btnReset: document.getElementById('btn-reset'),

  toast: document.getElementById('toast'),
};

// App Runtime State
let state = loadState();
let isRevealed = false;
let isAnimatingOut = false;
let deferredInstallPrompt = null;
let resetConfirmTimer = null;
let toastTimer = null;
let selectedVoice = null;

// =========================================================
// Utilities
// =========================================================

function showToast(message) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toast.hidden = true;
  }, 2000);
}

function renderHighlightedSentence(container, sentence, highlight) {
  container.textContent = '';
  if (!highlight) {
    container.textContent = sentence;
    return;
  }

  const idx = sentence.indexOf(highlight);
  if (idx === -1) {
    container.textContent = sentence;
    return;
  }

  const before = sentence.slice(0, idx);
  const match = sentence.slice(idx, idx + highlight.length);
  const after = sentence.slice(idx + highlight.length);

  if (before) container.appendChild(document.createTextNode(before));
  const mark = document.createElement('mark');
  mark.className = 'phrase-highlight';
  mark.textContent = match;
  container.appendChild(mark);
  if (after) container.appendChild(document.createTextNode(after));
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

  const session = state.session;
  if (!session || session.index >= session.queue.length) return;
  const phrase = PHRASE_MAP.get(session.queue[session.index]);
  if (!phrase) return;

  // Toggle off if already speaking
  if (els.audioBtn.classList.contains('is-speaking') && window.speechSynthesis.speaking) {
    stopSpeaking();
    return;
  }

  if (window.speechSynthesis.speaking || window.speechSynthesis.pending) {
    window.speechSynthesis.cancel();
  }

  const utterance = new SpeechSynthesisUtterance(phrase.sentence);
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

function setCardRevealed(revealed) {
  isRevealed = revealed;
  els.activeCard.classList.toggle('is-revealed', revealed);
  els.activeCard.setAttribute('aria-expanded', String(revealed));
  els.cardBack.setAttribute('aria-hidden', String(!revealed));
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
  const session = state.session;
  const isDone = !session || session.index >= session.queue.length;

  renderProgress();

  if (isDone) {
    stopSpeaking();
    els.studyView.hidden = true;
    els.completeView.hidden = false;
    renderCompleteView();
    return;
  }

  els.completeView.hidden = true;
  els.studyView.hidden = false;

  const currentId = session.queue[session.index];
  const current = PHRASE_MAP.get(currentId);
  const nextId = session.queue[session.index + 1];
  const next = nextId ? PHRASE_MAP.get(nextId) : null;

  // Populate active card
  const cat = CATEGORIES[current.category] || CATEGORIES.narration;
  els.cardCategory.textContent = cat.label;
  renderHighlightedSentence(els.cardSentence, current.sentence, current.highlight);
  els.cardPhrase.textContent = current.phrase;
  els.cardMeaning.textContent = current.meaning;
  els.cardTranslation.textContent = current.translation;
  els.cardNote.textContent = current.note;

  // Subtle interval preview on bottom buttons
  const nextDays = previewIntervalDays(state, current.id, 'known');
  els.hintKnown.textContent = formatIntervalLabel(nextDays);
  els.hintStuck.textContent = '明天再見';

  // Reset scroll position & collapsed state
  const scroller = els.activeCard.querySelector('.card-scroll-inner');
  if (scroller) scroller.scrollTop = 0;
  setCardRevealed(false);

  // Populate ghost card behind active card
  if (next) {
    const nextCat = CATEGORIES[next.category] || CATEGORIES.narration;
    els.ghostCategory.textContent = nextCat.label;
    renderHighlightedSentence(els.ghostSentence, next.sentence, next.highlight);
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

function renderSettingsSheet() {
  const explored = getExploredCount(state);
  const total = PHRASES.length;
  els.exploredLabel.textContent = `${explored} / ${total} 組`;
  els.exploredFill.style.width = `${Math.round((explored / total) * 100)}%`;

  const rate = state.prefs.speechRate || 0.96;
  for (const btn of els.rateButtons) {
    const btnRate = Number(btn.dataset.rate);
    btn.classList.toggle('is-active', Math.abs(btnRate - rate) < 0.02);
  }

  if (deferredInstallPrompt) {
    els.btnInstallPwa.hidden = false;
  } else {
    els.btnInstallPwa.hidden = true;
  }
}

// =========================================================
// Review Actions (Button Tap or Swipe)
// =========================================================

function commitDecision(outcome) {
  if (isAnimatingOut) return;
  const session = state.session;
  if (!session || session.index >= session.queue.length) return;

  isAnimatingOut = true;
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
// Pointer Swipe + Tap Physics (Mobile Touch & Mouse)
// =========================================================

const drag = {
  active: false,
  pointerId: null,
  startX: 0,
  startY: 0,
  lastX: 0,
  startTime: 0,
  mode: null, // 'swipe' | 'scroll' | null
};

const SWIPE_DISTANCE_THRESHOLD = 88;
const SWIPE_VELOCITY_THRESHOLD = 0.52;

function onCardPointerDown(e) {
  if (isAnimatingOut) return;
  if (e.button !== 0 && e.pointerType === 'mouse') return;
  if (e.target.closest('#audio-btn')) return;

  drag.active = true;
  drag.pointerId = e.pointerId;
  drag.startX = e.clientX;
  drag.startY = e.clientY;
  drag.lastX = e.clientX;
  drag.startTime = performance.now();
  drag.mode = null;
}

function onCardPointerMove(e) {
  if (!drag.active || e.pointerId !== drag.pointerId) return;

  const dx = e.clientX - drag.startX;
  const dy = e.clientY - drag.startY;
  drag.lastX = e.clientX;

  if (!drag.mode) {
    if (Math.hypot(dx, dy) < 8) return;
    if (Math.abs(dx) > Math.abs(dy) * 1.15) {
      drag.mode = 'swipe';
      els.activeCard.classList.add('is-dragging');
      try {
        els.activeCard.setPointerCapture(e.pointerId);
      } catch {
        // Ignore if capture is unsupported
      }
    } else {
      drag.mode = 'scroll';
      return;
    }
  }

  if (drag.mode !== 'swipe') return;

  const progress = Math.min(1, Math.abs(dx) / 110);
  const rotate = dx * 0.045;
  els.activeCard.style.transform = `translate3d(${dx}px, ${Math.abs(dx) * 0.04}px, 0) rotate(${rotate}deg)`;

  if (dx > 0) {
    els.stampKnown.style.opacity = String(progress);
    els.stampStuck.style.opacity = '0';
    els.activeCard.style.borderColor = `rgba(74, 222, 128, ${0.1 + progress * 0.45})`;
  } else {
    els.stampStuck.style.opacity = String(progress);
    els.stampKnown.style.opacity = '0';
    els.activeCard.style.borderColor = `rgba(239, 111, 108, ${0.1 + progress * 0.45})`;
  }

  // Smoothly scale up ghost card underneath
  const ghostScale = 0.945 + progress * 0.055;
  const ghostY = 14 - progress * 14;
  const ghostOpacity = 0.42 + progress * 0.48;
  els.nextCardGhost.style.transform = `scale(${ghostScale}) translateY(${ghostY}px)`;
  els.nextCardGhost.style.opacity = String(ghostOpacity);
}

function onCardPointerEnd(e) {
  if (!drag.active || e.pointerId !== drag.pointerId) return;

  const dx = e.clientX - drag.startX;
  const elapsed = Math.max(1, performance.now() - drag.startTime);
  const velocity = dx / elapsed;
  const mode = drag.mode;

  drag.active = false;
  drag.pointerId = null;
  drag.mode = null;

  if (mode === 'swipe') {
    els.activeCard.classList.remove('is-dragging');
    const shouldCommit =
      Math.abs(dx) >= SWIPE_DISTANCE_THRESHOLD ||
      (Math.abs(velocity) >= SWIPE_VELOCITY_THRESHOLD && Math.abs(dx) >= 32);

    if (shouldCommit) {
      commitDecision(dx > 0 ? 'known' : 'stuck');
    } else {
      resetCardTransform();
    }
    return;
  }

  // Pure tap anywhere on the card toggles reveal
  if (mode === null && Math.abs(dx) < 8) {
    setCardRevealed(!isRevealed);
  }
}

function onCardPointerCancel(e) {
  if (!drag.active || e.pointerId !== drag.pointerId) return;
  drag.active = false;
  drag.pointerId = null;
  drag.mode = null;
  resetCardTransform();
}

// =========================================================
// Event Listeners
// =========================================================

els.activeCard.addEventListener('pointerdown', onCardPointerDown);
els.activeCard.addEventListener('pointermove', onCardPointerMove);
els.activeCard.addEventListener('pointerup', onCardPointerEnd);
els.activeCard.addEventListener('pointercancel', onCardPointerCancel);

els.audioBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  speakCurrentSentence();
});

els.btnStuck.addEventListener('click', () => commitDecision('stuck'));
els.btnKnown.addEventListener('click', () => commitDecision('known'));

els.btnExtra.addEventListener('click', () => {
  startExtraBatch(state, PHRASES, getLocalDateStr());
  saveState(state);
  renderActiveCard({ animateEntrance: true });
});

// Keyboard shortcuts (for desktop testing / accessibility)
document.addEventListener('keydown', (e) => {
  if (!els.sheetBackdrop.hidden) {
    if (e.key === 'Escape') closeSheet();
    return;
  }
  if (els.studyView.hidden) return;

  if (e.key === ' ' || e.key === 'Enter') {
    if (document.activeElement === els.audioBtn) return;
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

// Settings Sheet
function openSheet() {
  renderSettingsSheet();
  els.sheetBackdrop.hidden = false;
  els.menuBtn.setAttribute('aria-expanded', 'true');
  els.btnReset.classList.remove('is-confirming');
  els.btnReset.textContent = '重置學習進度';
}

function closeSheet() {
  els.sheetBackdrop.hidden = true;
  els.menuBtn.setAttribute('aria-expanded', 'false');
  clearTimeout(resetConfirmTimer);
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
  state = createEmptyState();
  state.prefs.speechRate = preservedRate;
  ensureTodaySession(state, PHRASES, getLocalDateStr());
  saveState(state);
  closeSheet();
  renderActiveCard({ animateEntrance: true });
  showToast('已重置學習進度');
});

// Handle day rollover when user returns to an already-open PWA tab the next day
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    const today = getLocalDateStr();
    if (!state.session || state.session.date !== today) {
      ensureTodaySession(state, PHRASES, today);
      saveState(state);
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
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {
      // Service worker registration skipped on unsupported origins (e.g., file://)
    });
  });
}

// =========================================================
// Boot
// =========================================================

ensureTodaySession(state, PHRASES, getLocalDateStr());
saveState(state);
renderActiveCard({ animateEntrance: false });
