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
        if (raw) mem = JSON.parse(raw) as RecentMap;
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

export function recordOpen(id: string, at = Date.now()): void {
    loadRecents();
    const e = mem[id] ?? { count: 0, lastAt: 0 };
    e.count += 1;
    e.lastAt = at;
    mem[id] = e;
    save();
}

/** Attach recency data onto items (mutates). Returns same array. */
export function attachRecents<T extends { id: string; lastOpenedAt?: number; useCount?: number }>(items: T[]): T[] {
    const map = loadRecents();
    for (const it of items) {
        const e = map[it.id];
        if (e) {
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
