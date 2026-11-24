export const INTERVALS = [1, 2, 4, 7, 15, 30];
export const DAILY_BATCH_SIZE = 10;
export const EXTRA_BATCH_SIZE = 5;
export const STORAGE_KEY = 'scenecard_srs_v1';

/**
 * Return local calendar date string 'YYYY-MM-DD'.
 * Avoids UTC midnight shift bugs in non-UTC timezones.
 */
export function getLocalDateStr(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Add `days` to a local 'YYYY-MM-DD' date string.
 */
export function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d + days);
  return getLocalDateStr(dt);
}

/**
 * Create a fresh initial state object.
 */
export function createEmptyState() {
  return {
    cards: {},
    session: null,
    prefs: {
      speechRate: 0.96,
    },
  };
}

/**
 * Load persisted state safely from storage.
 */
export function loadState(storage = window.localStorage) {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return createEmptyState();
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return createEmptyState();
    return {
      cards: parsed.cards && typeof parsed.cards === 'object' ? parsed.cards : {},
      session: parsed.session && typeof parsed.session === 'object' ? parsed.session : null,
      prefs: {
        speechRate:
          parsed.prefs && typeof parsed.prefs.speechRate === 'number'
            ? parsed.prefs.speechRate
            : 0.96,
      },
    };
  } catch {
    return createEmptyState();
  }
}

/**
 * Save state safely to storage.
 */
export function saveState(state, storage = window.localStorage) {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Ignore storage quota or private-mode errors gracefully
  }
}

/**
 * Interleave narration and dialogue phrases evenly for engaging sessions.
 */
function interleaveByCategory(phrases) {
  const narration = [];
  const dialogue = [];
  for (const p of phrases) {
    if (p.category === 'dialogue') {
      dialogue.push(p);
    } else {
      narration.push(p);
    }
  }
  const mixed = [];
  const maxLen = Math.max(narration.length, dialogue.length);
  for (let i = 0; i < maxLen; i++) {
    if (i < narration.length) mixed.push(narration[i]);
    if (i < dialogue.length) mixed.push(dialogue[i]);
  }
  return mixed;
}

/**
 * Build a batch of card IDs:
 * 1. Prioritize due cards (dueDate <= todayStr).
 * 2. Top up with unseen new cards (balanced across narration & dialogue).
 * 3. For extra bonus batches only, if due + new < count, top up with soonest upcoming cards.
 */
export function buildBatch(state, allPhrases, count, todayStr, { allowAhead = false } = {}) {
  const due = [];
  const unseen = [];
  const upcoming = [];

  for (const phrase of allPhrases) {
    const rec = state.cards[phrase.id];
    if (!rec) {
      unseen.push(phrase);
    } else if (rec.dueDate <= todayStr) {
      due.push({ phrase, rec });
    } else {
      upcoming.push({ phrase, rec });
    }
  }

  // Sort due cards: oldest due first, then lower step first (more fragile memories)
  due.sort((a, b) => {
    if (a.rec.dueDate !== b.rec.dueDate) {
      return a.rec.dueDate < b.rec.dueDate ? -1 : 1;
    }
    return a.rec.step - b.rec.step;
  });

  const dueInterleaved = interleaveByCategory(due.map((d) => d.phrase));
  const unseenInterleaved = interleaveByCategory(unseen);

  const selected = [];
  for (const p of dueInterleaved) {
    if (selected.length >= count) break;
    selected.push(p.id);
  }
  for (const p of unseenInterleaved) {
    if (selected.length >= count) break;
    selected.push(p.id);
  }

  if (allowAhead && selected.length < count) {
    // Prefer cards not already reviewed today, then soonest dueDate
    upcoming.sort((a, b) => {
      const aToday = a.rec.lastReviewed === todayStr ? 1 : 0;
      const bToday = b.rec.lastReviewed === todayStr ? 1 : 0;
      if (aToday !== bToday) return aToday - bToday;
      if (a.rec.dueDate !== b.rec.dueDate) {
        return a.rec.dueDate < b.rec.dueDate ? -1 : 1;
      }
      return a.rec.step - b.rec.step;
    });
    for (const item of upcoming) {
      if (selected.length >= count) break;
      selected.push(item.phrase.id);
    }
  }

  return selected;
}

/**
 * Ensure today's session exists and is valid.
 * Reuses an in-progress or completed session from the same calendar day.
 */
export function ensureTodaySession(state, allPhrases, todayStr = getLocalDateStr()) {
  const validIds = new Set(allPhrases.map((p) => p.id));

  if (state.session && state.session.date === todayStr) {
    // Filter out any unknown IDs just in case the deck changes
    const cleanedQueue = (state.session.queue || []).filter((id) => validIds.has(id));
    state.session.queue = cleanedQueue;
    state.session.index = Math.min(state.session.index || 0, cleanedQueue.length);
    return state;
  }

  // Start fresh daily batch of 10 cards (strictly capped, never shows overdue backlog)
  const queue = buildBatch(state, allPhrases, DAILY_BATCH_SIZE, todayStr, {
    allowAhead: false,
  });

  state.session = {
    date: todayStr,
    queue,
    index: 0,
    batchSize: queue.length,
    isExtra: false,
    allCaughtUp: queue.length === 0,
    stats: { known: 0, stuck: 0 },
    completedRoundsToday: 0,
  };

  return state;
}

/**
 * Start an optional "+5 cards" extra round.
 */
export function startExtraBatch(state, allPhrases, todayStr = getLocalDateStr()) {
  const queue = buildBatch(state, allPhrases, EXTRA_BATCH_SIZE, todayStr, {
    allowAhead: true,
  });

  const prevRounds =
    state.session && state.session.date === todayStr
      ? state.session.completedRoundsToday || 0
      : 0;

  state.session = {
    date: todayStr,
    queue,
    index: 0,
    batchSize: queue.length,
    isExtra: true,
    allCaughtUp: false,
    stats: { known: 0, stuck: 0 },
    completedRoundsToday: prevRounds,
  };

  return state;
}

/**
 * Preview how many days until next review for a given outcome.
 */
export function previewIntervalDays(state, phraseId, outcome) {
  if (outcome === 'stuck') return 1;
  const rec = state.cards[phraseId];
  const currentStep = rec ? rec.step : 0;
  const idx = Math.min(Math.max(0, currentStep), INTERVALS.length - 1);
  return INTERVALS[idx];
}

/**
 * Apply a review decision ('known' | 'stuck') to the active card in the session.
 */
export function reviewCurrentCard(state, outcome, todayStr = getLocalDateStr()) {
  const session = state.session;
  if (!session || session.index >= session.queue.length) {
    return { done: true, phraseId: null, intervalDays: 0 };
  }

  const phraseId = session.queue[session.index];
  const prev = state.cards[phraseId] || {
    step: 0,
    dueDate: todayStr,
    lastReviewed: null,
    reviews: 0,
  };

  let intervalDays = 1;
  let nextStep = 0;

  if (outcome === 'known') {
    const idx = Math.min(Math.max(0, prev.step), INTERVALS.length - 1);
    intervalDays = INTERVALS[idx];
    nextStep = Math.min(prev.step + 1, INTERVALS.length - 1);
    session.stats.known += 1;
  } else {
    // 'stuck': reset memory ladder and show again tomorrow
    intervalDays = 1;
    nextStep = 0;
    session.stats.stuck += 1;
  }

  state.cards[phraseId] = {
    step: nextStep,
    dueDate: addDays(todayStr, intervalDays),
    lastReviewed: todayStr,
    reviews: (prev.reviews || 0) + 1,
  };

  session.index += 1;
  const done = session.index >= session.queue.length;
  if (done) {
    session.completedRoundsToday = (session.completedRoundsToday || 0) + 1;
  }

  return { done, phraseId, intervalDays, nextStep };
}

/**
 * Count how many unique phrases the user has encountered at least once.
 * (Encouraging progress metric — never exposes overdue counts.)
 */
export function getExploredCount(state) {
  return Object.keys(state.cards).length;
}
