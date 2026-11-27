export const INTERVALS = [1, 2, 4, 7, 15, 30];
export const DAILY_BATCH_SIZE = 10;
export const EXTRA_BATCH_SIZE = 5;

// Strictly preserved SRS storage key — NEVER change to protect existing user progress
export const STORAGE_KEY = 'scenecard_srs_v1';

// Separate keys for custom imported decks and non-repeating example rotation
export const CUSTOM_DECK_KEY = 'scenecard_custom_deck_v1';
export const EXAMPLE_HIST_KEY = 'scenecard_example_hist_v1';

export const VALID_DECK_SOURCES = new Set(['all', 'custom', 'builtin']);

function normalizeDeckSource(value) {
  return VALID_DECK_SOURCES.has(value) ? value : 'all';
}

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

// =========================================================
// Dual-Format Card Normalization & Custom Deck Storage
// =========================================================

function normalizeVocabList(rawVocab) {
  if (!Array.isArray(rawVocab)) return [];
  const cleaned = [];
  for (const item of rawVocab) {
    if (!item || typeof item !== 'object') continue;
    const word = typeof item.word === 'string' ? item.word.trim() : '';
    const meaning = typeof item.meaning === 'string' ? item.meaning.trim() : '';
    if (word && meaning) {
      cleaned.push({ word, meaning });
    }
  }
  return cleaned;
}

/**
 * Normalize either:
 * 1) New 2.0 format: { id, category, phrase, meaning, note, examples: [{ en, match, zh, vocab }] }
 * 2) Legacy built-in format: { id, category, phrase, highlight, sentence, meaning, translation, note, vocab }
 * Returns null if the card is invalid.
 */
export function normalizeCard(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const id = typeof raw.id === 'string' || typeof raw.id === 'number'
    ? String(raw.id).trim()
    : '';
  const phrase = typeof raw.phrase === 'string' ? raw.phrase.trim() : '';
  const meaning = typeof raw.meaning === 'string' ? raw.meaning.trim() : '';
  const category =
    typeof raw.category === 'string' && raw.category.trim()
      ? raw.category.trim()
      : 'custom';
  const note = typeof raw.note === 'string' ? raw.note.trim() : '';

  if (!id || !phrase || !meaning) return null;

  const examples = [];

  if (Array.isArray(raw.examples) && raw.examples.length > 0) {
    for (const ex of raw.examples) {
      if (!ex || typeof ex !== 'object') continue;
      const en = typeof ex.en === 'string' ? ex.en.trim() : '';
      if (!en) continue;
      const match =
        typeof ex.match === 'string'
          ? ex.match.trim()
          : typeof ex.highlight === 'string'
            ? ex.highlight.trim()
            : '';
      const zh =
        typeof ex.zh === 'string'
          ? ex.zh.trim()
          : typeof ex.translation === 'string'
            ? ex.translation.trim()
            : '';
      examples.push({
        en,
        match,
        zh,
        vocab: normalizeVocabList(ex.vocab),
      });
    }
  } else if (typeof raw.sentence === 'string' && raw.sentence.trim()) {
    examples.push({
      en: raw.sentence.trim(),
      match: typeof raw.highlight === 'string' ? raw.highlight.trim() : '',
      zh: typeof raw.translation === 'string' ? raw.translation.trim() : '',
      vocab: normalizeVocabList(raw.vocab),
    });
  }

  if (examples.length === 0) return null;

  return {
    id,
    category,
    phrase,
    meaning,
    note,
    examples,
  };
}

/**
 * Parse and validate an imported deck JSON value.
 * Supports top-level Array or wrapper object { phrases | cards | items }.
 */
export function validateImportedDeck(parsed) {
  let rawList = null;
  if (Array.isArray(parsed)) {
    rawList = parsed;
  } else if (parsed && typeof parsed === 'object') {
    if (Array.isArray(parsed.phrases)) rawList = parsed.phrases;
    else if (Array.isArray(parsed.cards)) rawList = parsed.cards;
    else if (Array.isArray(parsed.items)) rawList = parsed.items;
  }

  if (!rawList) {
    return { ok: false, error: 'JSON 內容必須是卡片陣列', cards: [] };
  }

  const dedup = new Map();
  for (const item of rawList) {
    const normalized = normalizeCard(item);
    if (normalized) {
      dedup.set(normalized.id, normalized);
    }
  }

  const cards = Array.from(dedup.values());
  if (cards.length === 0) {
    return { ok: false, error: '找不到符合格式的卡片資料', cards: [] };
  }

  return { ok: true, error: null, cards };
}

/**
 * Load custom imported deck from localStorage.
 */
export function loadCustomDeck(storage = window.localStorage) {
  try {
    const raw = storage.getItem(CUSTOM_DECK_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeCard).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Save custom imported deck to localStorage.
 * Returns { ok, quotaExceeded }.
 */
export function saveCustomDeck(cards, storage = window.localStorage) {
  try {
    if (!cards || cards.length === 0) {
      storage.removeItem(CUSTOM_DECK_KEY);
    } else {
      storage.setItem(CUSTOM_DECK_KEY, JSON.stringify(cards));
    }
    return { ok: true, quotaExceeded: false };
  } catch (err) {
    const isQuota =
      err && (err.name === 'QuotaExceededError' || err.code === 22 || err.code === 1014);
    return { ok: false, quotaExceeded: Boolean(isQuota) };
  }
}

/**
 * Merge newly imported cards into existing custom cards by id.
 * Duplicate IDs update card text while SRS records in state.cards stay intact.
 */
export function mergeCustomCards(existingCustom, incomingCards) {
  const map = new Map();
  for (const c of existingCustom) {
    map.set(c.id, c);
  }
  let addedCount = 0;
  let updatedCount = 0;
  for (const c of incomingCards) {
    if (map.has(c.id)) {
      updatedCount += 1;
    } else {
      addedCount += 1;
    }
    map.set(c.id, c);
  }
  return {
    merged: Array.from(map.values()),
    addedCount,
    updatedCount,
  };
}

/**
 * Merge built-in phrases and custom imported cards into one unified normalized deck.
 * Deduplicates by id (custom overrides text if same id, preserving order).
 */
export function buildMergedDeck(builtinPhrases, customCards = []) {
  const map = new Map();
  for (const raw of builtinPhrases) {
    const norm = normalizeCard(raw);
    if (norm) map.set(norm.id, norm);
  }
  for (const raw of customCards) {
    const norm = normalizeCard(raw);
    if (norm) map.set(norm.id, norm);
  }
  return Array.from(map.values());
}

/**
 * Filter active study pool according to deckSource ('all' | 'custom' | 'builtin').
 * Falls back safely to 'all' if 'custom' is requested with an empty custom deck.
 */
export function buildActiveDeck(builtinPhrases, customCards = [], deckSource = 'all') {
  const source = normalizeDeckSource(deckSource);
  if (source === 'builtin') {
    return buildMergedDeck(builtinPhrases, []);
  }
  if (source === 'custom' && Array.isArray(customCards) && customCards.length > 0) {
    return buildMergedDeck([], customCards);
  }
  return buildMergedDeck(builtinPhrases, customCards);
}

// =========================================================
// Example Rotation History (Avoid Back-to-Back Repeats)
// =========================================================

export function loadExampleHistory(storage = window.localStorage) {
  try {
    const raw = storage.getItem(EXAMPLE_HIST_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function saveExampleHistory(hist, storage = window.localStorage) {
  try {
    storage.setItem(EXAMPLE_HIST_KEY, JSON.stringify(hist));
  } catch {
    // Non-critical cache; ignore storage errors
  }
}

/**
 * Pick one example from a card's `examples` array, avoiding the last shown index when possible.
 */
export function pickExampleForCard(card, exampleHistory) {
  const examples = card && Array.isArray(card.examples) ? card.examples : [];
  if (examples.length === 0) {
    return { example: { en: '', match: '', zh: '', vocab: [] }, index: 0 };
  }
  if (examples.length === 1) {
    return { example: examples[0], index: 0 };
  }

  const lastIdx = exampleHistory ? exampleHistory[card.id] : undefined;
  const candidates = [];
  for (let i = 0; i < examples.length; i++) {
    if (i !== lastIdx) candidates.push(i);
  }

  const pool = candidates.length > 0 ? candidates : [0];
  const chosenIdx = pool[Math.floor(Math.random() * pool.length)];
  return { example: examples[chosenIdx], index: chosenIdx };
}

// =========================================================
// SRS State Persistence & Scheduling
// =========================================================

/**
 * Create a fresh initial state object.
 */
export function createEmptyState() {
  return {
    cards: {},
    session: null,
    prefs: {
      speechRate: 0.96,
      showVocabHints: true,
      deckSource: 'all',
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
        showVocabHints:
          parsed.prefs && typeof parsed.prefs.showVocabHints === 'boolean'
            ? parsed.prefs.showVocabHints
            : true,
        deckSource: normalizeDeckSource(parsed.prefs && parsed.prefs.deckSource),
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
 * Interleave phrases round-robin across categories for engaging sessions.
 */
function interleaveByCategory(phrases) {
  const buckets = new Map();
  for (const p of phrases) {
    const key = p.category || 'default';
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(p);
  }
  const lists = Array.from(buckets.values());
  const mixed = [];
  let maxLen = 0;
  for (const list of lists) {
    if (list.length > maxLen) maxLen = list.length;
  }
  for (let i = 0; i < maxLen; i++) {
    for (const list of lists) {
      if (i < list.length) mixed.push(list[i]);
    }
  }
  return mixed;
}

/**
 * Build a batch of card IDs:
 * 1. Prioritize due cards (dueDate <= todayStr).
 * 2. Top up with unseen new cards (balanced across categories).
 * 3. For extra bonus batches only, if due + new < count, top up with soonest upcoming cards.
 */
export function buildBatch(
  state,
  allPhrases,
  count,
  todayStr,
  { allowAhead = false, excludeIds = null } = {}
) {
  const due = [];
  const unseen = [];
  const upcoming = [];

  for (const phrase of allPhrases) {
    if (excludeIds && excludeIds.has(phrase.id)) continue;
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
    const cleanedQueue = (state.session.queue || []).filter((id) => validIds.has(id));
    state.session.queue = cleanedQueue;
    state.session.index = Math.min(state.session.index || 0, cleanedQueue.length);
    if (cleanedQueue.length > 0) {
      state.session.batchSize = cleanedQueue.length;
    }
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
 * Re-sync today's session immediately after importing or clearing custom cards.
 */
export function syncSessionWithDeck(state, allPhrases, todayStr = getLocalDateStr()) {
  const validIds = new Set(allPhrases.map((p) => p.id));
  if (!state.session || state.session.date !== todayStr) {
    return ensureTodaySession(state, allPhrases, todayStr);
  }

  const session = state.session;
  const oldQueue = Array.isArray(session.queue) ? session.queue : [];
  const reviewedCountBefore = Math.min(session.index || 0, oldQueue.length);

  // Filter out IDs removed from the active deck while keeping cursor aligned
  const keptBefore = oldQueue.slice(0, reviewedCountBefore).filter((id) => validIds.has(id));
  const keptRemaining = oldQueue.slice(reviewedCountBefore).filter((id) => validIds.has(id));
  session.queue = [...keptBefore, ...keptRemaining];
  session.index = keptBefore.length;

  const totalReviewedThisRound = (session.stats?.known || 0) + (session.stats?.stuck || 0);

  // If today was previously "all caught up" (0 cards) and new cards are now available, build today's 10-card batch
  if (session.allCaughtUp && totalReviewedThisRound === 0) {
    const freshQueue = buildBatch(state, allPhrases, DAILY_BATCH_SIZE, todayStr, {
      allowAhead: false,
    });
    session.queue = freshQueue;
    session.index = 0;
    session.batchSize = freshQueue.length;
    session.allCaughtUp = freshQueue.length === 0;
    return state;
  }

  // If round hasn't been completed yet and queue shrunk below target size, top up cleanly
  const targetSize = session.isExtra ? EXTRA_BATCH_SIZE : DAILY_BATCH_SIZE;
  const isRoundFinished =
    session.index >= session.queue.length && totalReviewedThisRound > 0;

  if (!isRoundFinished && session.queue.length < targetSize) {
    const needed = targetSize - session.queue.length;
    const exclude = new Set(session.queue);
    const topUp = buildBatch(state, allPhrases, needed, todayStr, {
      allowAhead: Boolean(session.isExtra),
      excludeIds: exclude,
    });
    session.queue.push(...topUp);
  }

  session.batchSize = session.queue.length;
  session.allCaughtUp = session.queue.length === 0 && totalReviewedThisRound === 0;
  return state;
}

/**
 * Rebuild today's active study queue immediately for a newly selected deck source,
 * while strictly keeping all existing SRS progress in `state.cards` intact.
 */
export function rebuildSessionForDeckSource(
  state,
  activePhrases,
  todayStr = getLocalDateStr()
) {
  const prevRounds =
    state.session && state.session.date === todayStr
      ? state.session.completedRoundsToday || 0
      : 0;

  const queue = buildBatch(state, activePhrases, DAILY_BATCH_SIZE, todayStr, {
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
    completedRoundsToday: prevRounds,
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
 * Count how many unique phrases in the active deck the user has encountered at least once.
 * (Encouraging progress metric — never exposes overdue counts.)
 */
export function getExploredCount(state, activeDeckIds = null) {
  if (!activeDeckIds) {
    return Object.keys(state.cards).length;
  }
  let count = 0;
  for (const id of Object.keys(state.cards)) {
    if (activeDeckIds.has(id)) count += 1;
  }
  return count;
}

// =========================================================
// Progress Backup Export & Restore
// =========================================================

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Build a portable JSON backup object containing SRS state (and optional custom deck).
 */
export function buildBackupPayload(state, customDeck = []) {
  return {
    app: 'SceneCard',
    schemaVersion: 2,
    exportedAt: new Date().toISOString(),
    srs: state,
    customDeck: Array.isArray(customDeck) ? customDeck : [],
  };
}

/**
 * Validate and sanitize a backup JSON object before restoring.
 * Accepts both SceneCard v2 envelope ({ srs, customDeck }) and raw SRS state ({ cards, session, prefs }).
 */
export function parseBackupPayload(parsed) {
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, error: '備份檔案格式無效' };
  }

  const rawSrs =
    parsed.srs && typeof parsed.srs === 'object' ? parsed.srs : parsed;

  if (!rawSrs.cards || typeof rawSrs.cards !== 'object' || Array.isArray(rawSrs.cards)) {
    return { ok: false, error: '備份檔案中找不到學習進度資料' };
  }

  const sanitizedCards = {};
  for (const [id, rec] of Object.entries(rawSrs.cards)) {
    if (!id || !rec || typeof rec !== 'object') continue;
    const step = Number.isFinite(rec.step)
      ? Math.max(0, Math.min(Math.floor(rec.step), INTERVALS.length - 1))
      : 0;
    const dueDate =
      typeof rec.dueDate === 'string' && DATE_RE.test(rec.dueDate)
        ? rec.dueDate
        : getLocalDateStr();
    const lastReviewed =
      typeof rec.lastReviewed === 'string' && DATE_RE.test(rec.lastReviewed)
        ? rec.lastReviewed
        : null;
    const reviews = Number.isFinite(rec.reviews) ? Math.max(0, Math.floor(rec.reviews)) : 1;

    sanitizedCards[id] = { step, dueDate, lastReviewed, reviews };
  }

  const restoredState = {
    cards: sanitizedCards,
    session:
      rawSrs.session && typeof rawSrs.session === 'object' ? rawSrs.session : null,
    prefs: {
      speechRate:
        rawSrs.prefs && typeof rawSrs.prefs.speechRate === 'number'
          ? rawSrs.prefs.speechRate
          : 0.96,
      showVocabHints:
        rawSrs.prefs && typeof rawSrs.prefs.showVocabHints === 'boolean'
          ? rawSrs.prefs.showVocabHints
          : true,
      deckSource: normalizeDeckSource(rawSrs.prefs && rawSrs.prefs.deckSource),
    },
  };

  let restoredCustomDeck = null;
  if (Array.isArray(parsed.customDeck) && parsed.customDeck.length > 0) {
    const check = validateImportedDeck(parsed.customDeck);
    if (check.ok) {
      restoredCustomDeck = check.cards;
    }
  }

  return {
    ok: true,
    error: null,
    state: restoredState,
    customDeck: restoredCustomDeck,
    cardCount: Object.keys(sanitizedCards).length,
  };
}
