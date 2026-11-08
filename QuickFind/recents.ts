/*
 * QuickFind — recent/frequency tracking.
 * localStorage-backed with in-memory fallback (for tests / no-DOM).
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export interface RecentEntry {
    count: number;
    lastAt: number;
}

export type RecentMap = Record<string, RecentEntry>;

const KEY = "qs-plus-recents-v1";
const MAX_ENTRIES = 60;

let mem: RecentMap = {};
let loaded = false;

function storage(): Storage | null {
    try {
        if (typeof localStorage !== "undefined") return localStorage;
        return null;
    } catch {
        return null;
    }
}

export function loadRecents(): RecentMap {
    if (loaded) return mem;
    loaded = true;
    const s = storage();
    if (!s) return mem;
    try {
        const raw = s.getItem(KEY);
        // Validate the persisted payload; corrupted values reset to {}.
        if (raw) mem = sanitizeRecentMap(JSON.parse(raw));
    } catch {
        mem = {};
    }
    return mem;
}

function save(): void {
    const s = storage();
    if (!s) return;
    try {
        // prune to most recent MAX_ENTRIES
        const keys = Object.keys(mem).sort((a, b) => (mem[b]?.lastAt ?? 0) - (mem[a]?.lastAt ?? 0));
        if (keys.length > MAX_ENTRIES) {
            const next: RecentMap = {};
            for (const k of keys.slice(0, MAX_ENTRIES)) next[k] = mem[k];
            mem = next;
        }
        s.setItem(KEY, JSON.stringify(mem));
    } catch {
        /* ignore quota errors */
    }
}

/**
 * Validate an unknown parsed payload into a RecentMap. Corrupted localStorage
 * (truncated JSON, wrong types, entries with non-numeric fields) sanitizes to
 * only well-formed entries instead of poisoning module state.
 * Pure and unit-tested (see run_tests.mjs "recents corrupt payloads").
 */
export function sanitizeRecentMap(raw: unknown): RecentMap {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: RecentMap = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof k !== "string" || !k) continue;
        if (!v || typeof v !== "object" || Array.isArray(v)) continue;
        const e = v as Record<string, unknown>;
        if (typeof e.count !== "number" || !Number.isFinite(e.count) || e.count < 0) continue;
        if (typeof e.lastAt !== "number" || !Number.isFinite(e.lastAt) || e.lastAt < 0) continue;
        out[k] = { count: Math.floor(e.count), lastAt: e.lastAt };
        if (Object.keys(out).length >= MAX_ENTRIES * 2) break;
    }
    // Keep the most-recent entries, not the first 60 in insertion order:
    // without this a bloated/corrupt payload keeps stale rows.
    const keys = Object.keys(out).sort((a, b) => (out[b]?.lastAt ?? 0) - (out[a]?.lastAt ?? 0));
    if (keys.length > MAX_ENTRIES) {
        const trimmed: RecentMap = {};
        for (const k of keys.slice(0, MAX_ENTRIES)) trimmed[k] = out[k];
        return trimmed;
    }
    return out;
}

export function recordOpen(id: string, at = Date.now()): void {
    if (typeof id !== "string" || !id) return;
    // Validate timestamp: NaN/Infinity/negative would poison recency sort
    // (NaN comparator) and serialize to null in JSON.
    const ts = Number.isFinite(at) && (at as number) >= 0 ? (at as number) : Date.now();
    loadRecents();
    const e = mem[id] ?? { count: 0, lastAt: 0 };
    e.count += 1;
    // Cap count to avoid unbounded growth over years of use.
    if (!Number.isFinite(e.count) || e.count > 1000000) e.count = 1000000;
    e.lastAt = ts;
    mem[id] = e;
    save();
}

/** Attach recency data onto items (mutates). Returns same array. */
export function attachRecents<T extends { id: string; lastOpenedAt?: number; useCount?: number }>(items: T[]): T[] {
    const map = loadRecents();
    for (const it of items) {
        const e = map[it.id];
        // Defensive: only well-formed finite entries boost; anything else
        // (e.g. a payload written before validation existed) clears like a miss.
        if (e && typeof e.count === "number" && typeof e.lastAt === "number"
            && Number.isFinite(e.count) && Number.isFinite(e.lastAt) && e.count >= 0 && e.lastAt >= 0) {
            it.lastOpenedAt = e.lastAt;
            it.useCount = e.count;
        } else {
            // Clear stale recency (e.g. after clearRecents) so a cached
            // array doesn't keep floating old rows to the top.
            delete it.lastOpenedAt;
            delete it.useCount;
        }
    }
    return items;
}

export function clearRecents(): void {
    mem = {};
    loaded = true;
    try {
        storage()?.removeItem(KEY);
    } catch {
        /* ignore */
    }
}

/** For tests: reset in-memory state. */
export function __resetForTests(): void {
    mem = {};
    loaded = true;
}
