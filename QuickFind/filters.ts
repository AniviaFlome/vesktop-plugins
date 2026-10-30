/*
 * QuickFind — visibility filters (pure, testable).
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import type { ItemType, SearchableItem } from "./search";

export interface FilterSettings {
    showServers: boolean;
    showTextChannels: boolean;
    showVoiceChannels: boolean;
    showThreads: boolean;
    showDMs: boolean;
    showGroupDMs: boolean;
    showUsers: boolean;
    /** when true, only user-type items flagged isFriend may pass */
    friendsOnly: boolean;
    hideBlocked: boolean;
    hideMuted: boolean;
    hideArchivedThreads: boolean;
    /** when true, hide everything except guilds */
    serversOnly: boolean;
}

export const DEFAULT_FILTERS: FilterSettings = {
    showServers: true,
    showTextChannels: true,
    showVoiceChannels: true,
    showThreads: true,
    showDMs: true,
    showGroupDMs: true,
    showUsers: true,
    friendsOnly: false,
    hideBlocked: true,
    hideMuted: false,
    hideArchivedThreads: true,
    serversOnly: false,
};

function isUserType(t: ItemType): boolean {
    return t === "dm" || t === "group" || t === "user";
}

/** Pure visibility check. No Discord imports. */
export function shouldShow(item: SearchableItem, f: FilterSettings): boolean {
    if (f.serversOnly && item.type !== "guild") return false;

    switch (item.type) {
        case "guild":
            if (!f.showServers) return false;
            break;
        case "text":
            if (!f.showTextChannels) return false;
            break;
        case "voice":
            if (!f.showVoiceChannels) return false;
            break;
        case "thread":
            if (!f.showThreads) return false;
            if (f.hideArchivedThreads && item.isArchived) return false;
            break;
        case "dm":
            if (!f.showDMs) return false;
            break;
        case "group":
            if (!f.showGroupDMs) return false;
            break;
        case "user":
            if (!f.showUsers) return false;
            break;
        default:
            break;
    }

    if (f.friendsOnly && isUserType(item.type) && !item.isFriend) return false;
    if (f.hideBlocked && item.isBlocked) return false;
    if (f.hideMuted && item.muted) return false;

    return true;
}

export function applyFilters<T extends SearchableItem>(items: T[], f: FilterSettings): T[] {
    return items.filter(it => shouldShow(it, f));
}

/**
 * Collapse redundant user rows: when a 1:1 DM channel already exists for a
 * friend, the separate friend-user row opens the exact same conversation, so
 * showing both is noise ("birkan" twice). Keeps the DM row, drops the user row.
 * Also drops exact same-type+id doubles that slipped through indexing.
 * NOTE: never collapse by name — different channels (and different people)
 * legitimately share names, and collapsing them hides real rows.
 */
export function dedupeUserRows<T extends SearchableItem>(items: T[]): T[] {
    const dmUserIds = new Set<string>();
    for (const it of items) {
        if (it.type === "dm" && typeof it.dmRecipientId === "string") {
            dmUserIds.add(it.dmRecipientId);
        }
    }
    const seenIds = new Set<string>();
    const out: T[] = [];
    for (const it of items) {
        if (it.type === "user" && dmUserIds.has(it.id)) continue;
        const key = `${it.type}:${it.id}`;
        if (seenIds.has(key)) continue;
        seenIds.add(key);
        out.push(it);
    }
    return out;
}
