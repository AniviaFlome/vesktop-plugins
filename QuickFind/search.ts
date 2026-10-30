/*
 * QuickFind — fast fuzzy search core.
 * Pure module: no Discord imports so it can be unit-tested in plain Node.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export type SearchMode = "fuzzy" | "substring" | "prefix";
export type SortBy = "relevance" | "recent" | "alphabetical";

export type ItemType =
    | "guild"
    | "text"
    | "voice"
    | "thread"
    | "dm"
    | "group"
    | "user";

export interface SearchableItem {
    id: string;
    name: string;
    /** precomputed normalized name; filled by buildIndex if absent */
    normalized?: string;
    type: ItemType;
    guildId?: string | null;
    /** CDN icon/avatar URL for guilds, DMs and users */
    iconUrl?: string;
    /** Group DMs: avatar URLs for the first few recipients (stacked cluster) */
    iconUrls?: string[];
    /** DM rows for a 1:1 conversation carry the other user's id (for dedupe) */
    dmRecipientId?: string;
    /** small dim context shown right-aligned, e.g. parent server name */
    subtitle?: string;
    /** unix ms of last open, for recent boost */
    lastOpenedAt?: number;
    /** open count, for frequency boost */
    useCount?: number;
    unread?: boolean;
    muted?: boolean;
    /** user items only */
    isFriend?: boolean;
    isBlocked?: boolean;
    isArchived?: boolean;
}

export interface SearchOptions {
    mode: SearchMode;
    fuzzyEnabled: boolean;
    /** 0..1, higher = stricter. Only used for fuzzy. */
    sensitivity: number;
    caseSensitive: boolean;
    normalize: boolean;
    maxResults: number;
    sortBy: SortBy;
    currentGuildId?: string | null;
    /** extra score for items in the current guild */
    currentGuildBoost: number;
    /** weight for recency/frequency, 0 disables */
    recentBoost: number;
    /** kind order, highest priority first; null = pure relevance */
    kindOrder: ResultKind[] | null;
    /** points per kind-rank step; 0 disables */
    kindBoost: number;
}

/** Default options matching plugin defaults. */
export const DEFAULT_SEARCH_OPTIONS: SearchOptions = {
    mode: "fuzzy",
    fuzzyEnabled: true,
    sensitivity: 0.4,
    caseSensitive: false,
    normalize: true,
    maxResults: 30,
    sortBy: "relevance",
    currentGuildId: null,
    currentGuildBoost: 25,
    recentBoost: 30,
    kindOrder: null,
    kindBoost: 0,
};

/**
 * Normalize for comparison: NFD strip diacritics, optionally lowercase,
 * strip leading emoji/punctuation so "#-general" and "🎮general" still match.
 */
export function normalizeString(input: string, caseSensitive = false): string {
    // NFKC first: folds compatibility characters to ASCII (fullwidth ｓ→s,
    // mathematical alphanumeric 𝐬→s, ligatures ﬁ→fi). Without this, typing
    // plain ASCII can never match Discord's stylized names.
    let s = input.normalize("NFKC");
    s = s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    if (!caseSensitive) s = s.toLowerCase();
    // Remove leading characters that are not letters/numbers for ranking
    // but keep inner separators. Also collapse whitespace.
    s = s.replace(/^[^\p{L}\p{N}]+/u, "");
    s = s.replace(/\s+/g, " ").trim();
    return s;
}

/** Ensure item.normalized is populated. Mutates in place, returns same array. */
const normalizedMemo = new Map<string, string>();
const NORMALIZED_MEMO_MAX = 30000;

export function buildIndex<T extends SearchableItem>(items: T[], caseSensitive = false, doNormalize = true): T[] {
    for (const it of items) {
        const base = it.name ?? "";
        if (!doNormalize) {
            it.normalized = caseSensitive ? base : base.toLowerCase();
            continue;
        }
        // Repeat opens re-collect the same 10k names: memoize the expensive
        // NFKC/NFD normalization so only new/renamed items pay for it.
        const key = `${caseSensitive ? 1 : 0}\0${base}`;
        let n = normalizedMemo.get(key);
        if (n === undefined) {
            n = normalizeString(base, caseSensitive);
            if (normalizedMemo.size >= NORMALIZED_MEMO_MAX) normalizedMemo.clear();
            normalizedMemo.set(key, n);
        }
        it.normalized = n;
    }
    return items;
}

export type QueryScope = "all" | "channels" | "users" | "servers";

export interface ParsedQuery {
    scope: QueryScope;
    clean: string;
}

/**
 * Prefix shortcuts:
 *  `#foo` -> channels only, `@foo` -> users/DMs only, `*foo` -> servers only.
 *  Long forms `c:foo`, `u:`, `s:` / `g:` also supported.
 */
export function parseQueryPrefix(raw: string): ParsedQuery {
    const q = raw.trim();
    if (q.startsWith("#")) return { scope: "channels", clean: q.slice(1).trim() };
    if (q.startsWith("@")) return { scope: "users", clean: q.slice(1).trim() };
    if (q.startsWith("*")) return { scope: "servers", clean: q.slice(1).trim() };
    const m = q.match(/^([cugs])\s*:\s*(.*)$/i);
    if (m) {
        const kind = m[1].toLowerCase();
        const rest = m[2];
        if (kind === "c") return { scope: "channels", clean: rest };
        if (kind === "u") return { scope: "users", clean: rest };
        if (kind === "s" || kind === "g") return { scope: "servers", clean: rest };
    }
    return { scope: "all", clean: q };
}

/** Check scope against item type. */
export function scopeMatches(scope: QueryScope, type: ItemType): boolean {
    if (scope === "all") return true;
    if (scope === "servers") return type === "guild";
    if (scope === "channels") return type === "text" || type === "voice" || type === "thread";
    if (scope === "users") return type === "dm" || type === "group" || type === "user";
    return true;
}

function isWordBoundary(ch: string): boolean {
    return ch === " " || ch === "-" || ch === "_" || ch === "/" || ch === "#" || ch === ":" || ch === ".";
}

/**
 * Score a fuzzy subsequence match. Returns -1 on no-match.
 * Scoring: +10 per char, +12 consecutive bonus, +8 word-boundary bonus,
 * +6 first-char bonus, -3 per skipped char, length penalty.
 */
export function fuzzyScore(query: string, target: string, sensitivity: number): number {
    if (!query) return 0;
    if (!target) return -1;
    // A longer query can never be a subsequence of a shorter target.
    if (query.length > target.length) return -1; // early exit

    let qi = 0;
    let ti = 0;
    let score = 0;
    let consecutive = 0;
    let skipped = 0;
    let firstMatchIdx = -1;

    while (qi < query.length && ti < target.length) {
        if (query[qi] === target[ti]) {
            if (firstMatchIdx === -1) firstMatchIdx = ti;
            let bonus = 10;
            if (ti === 0) bonus += 6;
            else if (isWordBoundary(target[ti - 1])) bonus += 8;
            if (consecutive > 0) bonus += Math.min(12, consecutive * 4);
            score += bonus;
            consecutive++;
            qi++;
        } else {
            skipped++;
            consecutive = 0;
            // Early exit: too many skips to ever pass threshold
            // Allow roughly (1-sensitivity)*target.length + query.length*2 skips
            const maxSkips = Math.floor((1 - sensitivity) * target.length) + query.length * 2;
            if (skipped > maxSkips + 20) return -1;
        }
        ti++;
    }

    if (qi < query.length) return -1; // not all chars matched

    // Penalize late start and gaps
    score -= firstMatchIdx * 2;
    score -= skipped * 3;
    // Prefer shorter names slightly
    score -= target.length * 0.15;

    const minScore = query.length * 10 * sensitivity;
    if (score < minScore) return -1;
    return score;
}

export function substringScore(query: string, target: string): number {
    if (!query) return 0;
    const idx = target.indexOf(query);
    if (idx === -1) return -1;
    // Earlier match + shorter target wins. Max ~1000.
    return 1000 - idx * 10 - target.length * 0.2 + (idx === 0 ? 100 : 0);
}

export function prefixScore(query: string, target: string): number {
    if (!query) return 0;
    if (!target.startsWith(query)) return -1;
    return 1000 - target.length * 0.2;
}

/** Score a single item against a prepared (already normalized) query. -1 = no match. */
export function scoreItem(
    normalizedQuery: string,
    item: SearchableItem,
    opts: SearchOptions,
    now = Date.now(),
): number {
    const target = item.normalized ?? item.name ?? "";
    // Empty query matches everything with base 0; boosts below still apply,
    // so unread/recent/current-guild items float up instead of everything
    // tying at 0. -1 is reserved for "does not match the query".
    let base: number;
    if (!normalizedQuery) {
        base = 0;
    } else if (opts.fuzzyEnabled && opts.mode === "fuzzy") {
        base = fuzzyScore(normalizedQuery, target, opts.sensitivity);
    } else if (opts.mode === "prefix") {
        base = prefixScore(normalizedQuery, target);
    } else {
        base = substringScore(normalizedQuery, target);
    }
    if (base < 0) return -1;

    let score = base;

    // Current-guild boost
    if (opts.currentGuildId && item.guildId && item.guildId === opts.currentGuildId) {
        score += opts.currentGuildBoost;
    }
    // Recent/frequency boost (decays are handled by caller storing lastOpenedAt/useCount)
    if (opts.recentBoost > 0 && (item.lastOpenedAt || item.useCount)) {
        const freq = Math.min(item.useCount ?? 0, 20);
        score += Math.min(opts.recentBoost, freq * 2);
        // Extra if opened in last 24h
        if (item.lastOpenedAt && now - item.lastOpenedAt < 24 * 3600 * 1000) {
            score += opts.recentBoost * 0.5;
        }
    }
    if (item.unread) score += 5;

    return score;
}

export interface RankedItem<T extends SearchableItem> {
    item: T;
    score: number;
}

/** Coarse kind used for type priority and equal-score tier interleaving. */
export type ResultKind = "channel" | "dm" | "user" | "guild";

export function kindOf(t: ItemType): ResultKind {
    switch (t) {
        case "text":
        case "voice":
        case "thread":
            return "channel";
        case "dm":
        case "group":
            return "dm";
        case "user":
            return "user";
        case "guild":
            return "guild";
    }
}

export const KIND_ORDER: ResultKind[] = ["channel", "dm", "user", "guild"];

/**
 * Named type-priority presets (setting value -> kind order, highest first).
 * "off" is deliberately absent: it maps to null = pure relevance.
 */
export const KIND_ORDER_PRESETS: Record<string, ResultKind[]> = {
    "servers-first": ["guild", "channel", "dm", "user"],
    "channels-first": ["channel", "guild", "dm", "user"],
    "channels-people": ["channel", "dm", "user", "guild"],
    "people-first": ["dm", "user", "channel", "guild"],
};

/** Rank of a kind inside an order (unknown kinds sort last). */
export function kindRankOf(order: ResultKind[], type: ItemType): number {
    const r = order.indexOf(kindOf(type));
    return r === -1 ? order.length : r;
}

/**
 * Extra score for an item's kind: (kinds ranked below it) * step.
 * Returns 0 when no order is set or step <= 0 (priority off).
 */
export function kindBoostFor(type: ItemType, order: ResultKind[] | null | undefined, step: number): number {
    if (!order || !(step > 0)) return 0;
    const r = order.indexOf(kindOf(type));
    if (r === -1) return 0;
    return (order.length - 1 - r) * step;
}

/**
 * Filter by scope + score + sort + slice. Fast path: single pass with early
 * scope check, then score, then partial sort via full sort (n is small after
 * filter; maxResults keeps render cheap).
 */
export function rankAndFilter<T extends SearchableItem>(
    items: T[],
    rawQuery: string,
    opts: SearchOptions,
): T[] {
    const { scope, clean } = parseQueryPrefix(rawQuery);
    const q = opts.normalize
        ? normalizeString(clean, opts.caseSensitive)
        : (opts.caseSensitive ? clean : clean.toLowerCase());
    const kindOrder = opts.kindOrder ?? null;
    // Clamp: a 0/negative maxResults (possible with free sliders) must not
    // blank the list; treat as "show at least 1".
    const maxResults = Math.max(1, Math.floor(opts.maxResults ?? DEFAULT_SEARCH_OPTIONS.maxResults));
    // Priority boost only applies to real queries: on empty queries every
    // item ties and the boost would collapse the interleave below into
    // strict kind tiers. There the preset order drives the round-robin.
    const kindStep = q ? (opts.kindBoost ?? 0) : 0;
    // Single timestamp for the whole query (avoids 5k Date.now() calls).
    const now = Date.now();

    const scored: RankedItem<T>[] = [];
    for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (!scopeMatches(scope, it.type)) continue;
        const s = scoreItem(q, it, opts, now);
        if (s < 0) continue;
        scored.push({ item: it, score: s + kindBoostFor(it.type, kindOrder, kindStep) });
    }

    if (opts.sortBy === "alphabetical") {
        scored.sort((a, b) => (a.item.name ?? "").localeCompare(b.item.name ?? ""));
    } else if (opts.sortBy === "recent") {
        scored.sort((a, b) => (b.item.lastOpenedAt ?? 0) - (a.item.lastOpenedAt ?? 0) || b.score - a.score);
    } else if (!q) {
        // Empty query: exact-score tiers, round-robin item kinds inside each
        // tier. Without this every item ties near 0 and stable sort keeps
        // insertion order, so one huge category (e.g. 150 guilds) crowds out
        // channels/DMs entirely once maxResults truncates the list.
        const tiers = new Map<number, T[]>();
        for (const s of scored) {
            const bucket = tiers.get(s.score);
            if (bucket) bucket.push(s.item);
            else tiers.set(s.score, [s.item]);
        }
        const ranked: T[] = [];
        for (const score of [...tiers.keys()].sort((a, b) => b - a)) {
            const bucket = tiers.get(score)!;
            const byKind = new Map<string, T[]>();
            for (const it of bucket) {
                const k = kindOf(it.type);
                const arr = byKind.get(k);
                if (arr) arr.push(it);
                else byKind.set(k, [it]);
            }
            // Bound the work: only the first maxResults of each kind can
            // appear in the final slice, so drop the rest before interleaving.
            for (const arr of byKind.values()) {
                if (arr.length > maxResults) arr.length = maxResults;
            }
            const kinds = (kindOrder ?? KIND_ORDER).filter(k => byKind.has(k));
            let i = 0;
            let emitted = true;
            while (emitted) {
                emitted = false;
                for (const k of kinds) {
                    const arr = byKind.get(k)!;
                    if (i < arr.length) {
                        ranked.push(arr[i]);
                        emitted = true;
                    }
                }
                i++;
            }
        }
        if (ranked.length > maxResults) ranked.length = maxResults;
        return ranked;
    } else {
        scored.sort((a, b) => b.score - a.score
            || (kindOrder ? kindRankOf(kindOrder, a.item.type) - kindRankOf(kindOrder, b.item.type) : 0));
    }

    if (scored.length > maxResults) scored.length = maxResults;
    return scored.map(s => s.item);
}
