/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import {
    ChannelActionCreators,
    ChannelRouter,
    ChannelStore,
    closeModal,
    GuildChannelStore,
    GuildReadStateStore,
    GuildStore,
    NavigationRouter,
    openModal,
    React,
    ReadStateStore,
    RelationshipStore,
    SelectedChannelStore,
    SelectedGuildStore,
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
    UserGuildSettingsStore,
    UserStore,
} from "@webpack/common";
import { findAll, findStore } from "@webpack";
import ErrorBoundary from "@components/ErrorBoundary";

import { applyFilters, dedupeUserRows, DEFAULT_FILTERS, type FilterSettings } from "./filters";
import {
    channelTypeToItem,
    gatherChannelCandidates,
    isArchivedChannel,
    resolveGuildId,
} from "./channelSources";
import { attachRecents, clearRecents, recordOpen } from "./recents";
import {
    buildIndex,
    DEFAULT_SEARCH_OPTIONS,
    KIND_ORDER_PRESETS,
    parseQueryPrefix,
    rankAndFilter,
    scopeMatches,
    type ItemType,
    type SearchableItem,
    type SearchMode,
    type SortBy,
} from "./search";

const logger = new Logger("QuickFind");

/** Dormant debug logging. Enable in any client (including production) with
 * `window.__qsDebug = true` in DevTools, then watch the console / read
 * `window.__qsLog` (last 80 entries). Zero cost when off.
 * Debug entries may contain query text; keep opt-in only. */
function dlog(...args: any[]): void {
    try {
        const w = window as any;
        if (!w.__qsDebug) return;
        (w.__qsLog ??= []).push(args.map((a) => String(a).slice(0, 200)).join(" ").slice(0, 500));
        if (w.__qsLog.length > 80) w.__qsLog.shift();
        console.log("[QS+]", ...args);
    } catch { /* logging must never break the plugin */ }
}

/** Bump on every shipped iteration. Logged by the probe dump so a pasted
 * probe output proves which build is actually running. */
export const BUILD_TAG = "qf+v1";

const settings = definePluginSettings({
    // --- hijack ---
    hijackCtrlK: {
        type: OptionType.BOOLEAN,
        description: "Replace native Ctrl+K with the faster QuickFind modal",
        default: true,
    },
    disableAnimations: {
        type: OptionType.BOOLEAN,
        description: "Skip open/close animations (instant open and close)",
        default: true,
    },
    // --- visibility ---
    serversOnly: {
        type: OptionType.BOOLEAN,
        description: "Only show servers (hide channels/DMs/users)",
        default: false,
    },
    showServers: { type: OptionType.BOOLEAN, description: "Show servers", default: true },
    showTextChannels: { type: OptionType.BOOLEAN, description: "Show text channels", default: true },
    showVoiceChannels: { type: OptionType.BOOLEAN, description: "Show voice channels", default: true },
    showThreads: { type: OptionType.BOOLEAN, description: "Show threads", default: true },
    showDMs: { type: OptionType.BOOLEAN, description: "Show direct messages", default: true },
    showGroupDMs: { type: OptionType.BOOLEAN, description: "Show group DMs", default: true },
    showUsers: { type: OptionType.BOOLEAN, description: "Show users (for starting DMs)", default: true },
    friendsOnly: {
        type: OptionType.BOOLEAN,
        description: "Only show people that are your friend (applies to DMs/users)",
        default: false,
    },
    hideBlocked: { type: OptionType.BOOLEAN, description: "Hide blocked users", default: true },
    hideMuted: { type: OptionType.BOOLEAN, description: "Hide muted guilds/channels", default: false },
    hideArchivedThreads: { type: OptionType.BOOLEAN, description: "Hide archived threads", default: true },
    // --- search ---
    searchMode: {
        type: OptionType.SELECT,
        description: "Match algorithm (when fuzzy is off, this is used directly)",
        options: [
            { label: "Fuzzy", value: "fuzzy", default: true },
            { label: "Substring", value: "substring" },
            { label: "Prefix", value: "prefix" },
        ],
    },
    fuzzyEnabled: { type: OptionType.BOOLEAN, description: "Toggle fuzzy matching", default: true },
    sensitivity: {
        type: OptionType.SLIDER,
        description: "Fuzzy sensitivity (higher = stricter)",
        markers: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9],
        default: 0.4,
        stickToMarkers: false,
    },
    caseSensitive: { type: OptionType.BOOLEAN, description: "Case-sensitive search", default: false },
    normalize: {
        type: OptionType.BOOLEAN,
        description: "Normalize (strip accents/leading emoji, collapse spaces)",
        default: true,
    },
    maxResults: {
        type: OptionType.SLIDER,
        description: "Max results to render (lower = faster)",
        markers: [10, 20, 30, 50, 75, 100],
        default: 30,
        stickToMarkers: false,
    },
    debounceMs: {
        type: OptionType.SLIDER,
        description: "Debounce before searching (ms)",
        markers: [0, 30, 50, 75, 100, 150],
        default: 50,
        stickToMarkers: false,
    },
    sortBy: {
        type: OptionType.SELECT,
        description: "Result ordering",
        options: [
            { label: "Relevance", value: "relevance", default: true },
            { label: "Recent", value: "recent" },
            { label: "Alphabetical", value: "alphabetical" },
        ],
    },
    kindOrder: {
        type: OptionType.SELECT,
        description: "Prioritize result types",
        options: [
            { label: "Off (pure relevance)", value: "off", default: true },
            { label: "Servers → Channels → People", value: "servers-first" },
            { label: "Channels → Servers → People", value: "channels-first" },
            { label: "Channels → People → Servers", value: "channels-people" },
            { label: "People → Channels → Servers", value: "people-first" },
        ],
    },
    kindBoost: {
        type: OptionType.SLIDER,
        description: "Type priority strength",
        markers: [0, 10, 20, 30, 40, 60],
        default: 20,
        stickToMarkers: false,
    },
    currentGuildBoost: {
        type: OptionType.BOOLEAN,
        description: "Boost channels in the current server",
        default: true,
    },
    recentBoost: {
        type: OptionType.BOOLEAN,
        description: "Boost recent + frequently opened",
        default: true,
    },
});

function getFilterSettings(): FilterSettings {
    const s = settings.store;
    return {
        showServers: s.showServers ?? DEFAULT_FILTERS.showServers,
        showTextChannels: s.showTextChannels ?? DEFAULT_FILTERS.showTextChannels,
        showVoiceChannels: s.showVoiceChannels ?? DEFAULT_FILTERS.showVoiceChannels,
        showThreads: s.showThreads ?? DEFAULT_FILTERS.showThreads,
        showDMs: s.showDMs ?? DEFAULT_FILTERS.showDMs,
        showGroupDMs: s.showGroupDMs ?? DEFAULT_FILTERS.showGroupDMs,
        showUsers: s.showUsers ?? DEFAULT_FILTERS.showUsers,
        friendsOnly: s.friendsOnly ?? false,
        hideBlocked: s.hideBlocked ?? true,
        hideMuted: s.hideMuted ?? false,
        hideArchivedThreads: s.hideArchivedThreads ?? true,
        serversOnly: s.serversOnly ?? false,
    };
}

type Tab = "all" | "servers" | "channels" | "friends";

function tabToScope(tab: Tab): "all" | "channels" | "users" | "servers" {
    if (tab === "servers") return "servers";
    if (tab === "channels") return "channels";
    if (tab === "friends") return "users";
    return "all";
}

/** Map Discord numeric channel.type to our ItemType. Re-exported here for
 * backwards compatibility; canonical implementation lives in
 * ./channelSources (pure, unit-tested). */
export { channelTypeToItem } from "./channelSources";

function safeIsFriend(userId: string): boolean {
    try {
        return !!(RelationshipStore as any)?.isFriend?.(userId);
    } catch {
        return false;
    }
}

function safeIsBlocked(userId: string): boolean {
    try {
        return !!(RelationshipStore as any)?.isBlocked?.(userId);
    } catch {
        return false;
    }
}

function safeIsGuildMuted(guildId: string): boolean {
    try {
        const s: any = UserGuildSettingsStore as any;
        if (typeof s?.isMuted === "function") return !!s.isMuted(guildId);
        return false;
    } catch {
        return false;
    }
}

function safeIsChannelMuted(guildId: string | null | undefined, channelId: string): boolean {
    try {
        const s: any = UserGuildSettingsStore as any;
        if (!guildId || typeof s?.isChannelMuted !== "function") return false;
        return !!s.isChannelMuted(guildId, channelId);
    } catch {
        return false;
    }
}

/** Best-effort channel unread flag. ReadStateStore shape varies across
 * builds; every access is optional-chained so unknown shapes degrade to
 * "no unread" instead of a crash. DMs use the channel id. */
function safeHasChannelUnread(channelId: string): boolean {
    try {
        const s: any = ReadStateStore as any;
        if (!s || !channelId) return false;
        if (typeof s.hasUnread === "function") return !!s.hasUnread(channelId);
        if (typeof s.getUnreadCount === "function") return (s.getUnreadCount(channelId) ?? 0) > 0;
        if (typeof s.getMentionCount === "function") return (s.getMentionCount(channelId) ?? 0) > 0;
    } catch {
        /* unknown shape -> no unread */
    }
    return false;
}

/** Best-effort guild unread flag (for server rows). */
function safeHasGuildUnread(guildId: string): boolean {
    try {
        const s: any = GuildReadStateStore as any;
        if (!s || !guildId) return false;
        if (typeof s.hasUnread === "function") return !!s.hasUnread(guildId);
        if (typeof s.hasAnyUnread === "function") {
            try {
                // Probe the function's arity (Function.length survives minification).
                const takesGuild = s.hasAnyUnread.length >= 1;
                return takesGuild ? !!s.hasAnyUnread(guildId) : !!s.hasAnyUnread();
            } catch {
                try {
                    return !!s.hasAnyUnread();
                } catch {
                    return false;
                }
            }
        }
    } catch {
        /* unknown shape -> no unread */
    }
    return false;
}

/** Only http(s) image URLs ever reach <img src>; anything else falls back to the glyph. */
function safeImgSrc(u: unknown): string | undefined {
    return typeof u === "string" && /^https:\/\//.test(u) ? u : undefined;
}

function cdnIconUrl(kind: "icons" | "avatars" | "embed/avatars", id: string, hash: string, size = 32): string {
    const ext = hash.startsWith("a_") ? "gif" : "png";
    return `https://cdn.discordapp.com/${kind}/${id}/${hash}.${ext}?size=${size}`;
}

function userAvatarUrl(userId: string): string | undefined {
    try {
        const u = (UserStore as any)?.getUser?.(userId);
        if (!u) return undefined;
        if (u.avatar) return cdnIconUrl("avatars", userId, u.avatar);
        const disc = Number(u.discriminator ?? 0);
        return `https://cdn.discordapp.com/embed/avatars/${Number.isFinite(disc) ? disc % 5 : 0}.png`;
    } catch {
        return undefined;
    }
}

function guildName(gid: string | null | undefined): string | undefined {
    if (!gid) return undefined;
    try {
        return (GuildStore as any)?.getGuild?.(gid)?.name ?? undefined;
    } catch {
        return undefined;
    }
}

/**
 * Build a full DM/group entry with recipient names, avatars and friend flags.
 * Used by both the getAll() scan and the sorted-private-channels pass
 * (whichever runs second is dropped by id dedupe, so both must be complete).
 */
function buildDMEntry(ch: any): SearchableItem | null {
    try {
        const t = channelTypeToItem(ch);
        if (t !== "dm" && t !== "group") return null;
        const otherId = Array.isArray(ch?.recipients) && ch.recipients.length === 1 ? ch.recipients[0] : null;
        const info = displayNameForDM(ch);
        return {
            id: ch.id,
            name: ch?.name || info.name,
            type: t,
            guildId: null,
            isFriend: otherId ? safeIsFriend(otherId) : true,
            isBlocked: otherId ? safeIsBlocked(otherId) : false,
            unread: safeHasChannelUnread(ch.id),
            iconUrl: info.iconUrl,
            iconUrls: info.iconUrls,
            dmRecipientId: otherId ?? undefined,
        };
    } catch {
        return null;
    }
}

function displayNameForDM(channel: any): { name: string; iconUrl?: string; iconUrls?: string[]; } {
    try {
        const recipients = channel?.recipients;
        if (Array.isArray(recipients) && recipients.length > 0) {
            const names: string[] = [];
            for (const id of recipients) {
                try {
                    const u = (UserStore as any)?.getUser?.(id);
                    names.push(u?.globalName ?? u?.username ?? "Unknown");
                } catch {
                    names.push("Unknown");
                }
            }
            const iconUrl = recipients.length === 1 ? userAvatarUrl(recipients[0]) : undefined;
            // Group DM: stack the first few recipient avatars like Discord does.
            const iconUrls = recipients.length > 1
                ? recipients.slice(0, 3).map((id: string) => userAvatarUrl(id)).filter((u): u is string => !!u)
                : undefined;
            // Cap long group-DM recipient lists so rows stay on one line.
            const shown = names.slice(0, 3).join(", ");
            const name = names.length > 3 ? `${shown} +${names.length - 3}` : shown;
            if (names.length > 0) return { name, iconUrl, iconUrls };
        }
    } catch {
        /* fall through */
    }
    return { name: channel?.name || "Direct Message" };
}

/**
 * Build the searchable index from stable stores only (fresh collect).
 * Defensive: every store access is optional-chained so a Discord
 * update degrades to fewer results instead of a crash.
 */
function collectItemsFresh(): SearchableItem[] {
    const out: SearchableItem[] = [];
    const seen = new Set<string>();
    const push = (it: SearchableItem) => {
        if (!it.id || seen.has(`${it.type}:${it.id}`)) return;
        seen.add(`${it.type}:${it.id}`);
        out.push(it);
    };

    // 1. Guilds (servers). Per-item guarded: one bad guild must not kill the list.
    try {
        const guilds = (GuildStore as any)?.getGuilds?.() ?? {};
        for (const id of Object.keys(guilds)) {
            try {
                const g = guilds[id];
                if (!g || typeof g.name !== "string") continue;
                push({
                    id,
                    name: g.name ?? "Unknown Server",
                    type: "guild",
                    guildId: id,
                    muted: safeIsGuildMuted(id),
                    unread: safeHasGuildUnread(id),
                    iconUrl: g?.icon ? cdnIconUrl("icons", id, g.icon) : undefined,
                });
            } catch {
                /* skip bad guild */
            }
        }
    } catch (e) {
        logger.warn("collect guilds failed", e);
    }

    // 2. Guild channels, from whichever store APIs exist in this client
    // (ChannelStore.getAll is absent in some builds; GuildChannelStore
    // returns comparator wrappers, not raw channels).
    const channelCandidates: any[] = gatherChannelCandidates(
        ChannelStore as any,
        GuildStore as any,
        GuildChannelStore as any,
    );

    for (const ch of channelCandidates) {
        try {
            const t = channelTypeToItem(ch);
            if (!t) continue;
            if (t === "dm" || t === "group") {
                // Private channels can show up in getAll(): build the full
                // entry here too (the sorted-DM pass below dedupes by id).
                const dm = buildDMEntry(ch);
                if (dm) push(dm);
                continue;
            }
            // Guild channel (text/voice/thread): keep even when the raw
            // guild_id is missing (frozen records, new shapes) — resolve
            // via the Channel class getter instead of dropping the row.
            const gid = resolveGuildId(ch);
            const name = ch?.name || (t === "thread" ? "Thread" : "Channel");
            push({
                id: ch.id,
                name,
                type: t,
                guildId: gid,
                muted: safeIsChannelMuted(gid, ch.id),
                unread: safeHasChannelUnread(ch.id),
                isArchived: isArchivedChannel(ch),
                subtitle: gid ? guildName(gid) : undefined,
            });
        } catch {
            /* skip bad channel */
        }
    }

    // 3. Private / DM channels (sorted helper when available)
    try {
        const cs: any = ChannelStore as any;
        const sorted = typeof cs?.getSortedPrivateChannels === "function"
            ? cs.getSortedPrivateChannels()
            : null;
        const list: any[] = Array.isArray(sorted) ? sorted : Array.isArray(sorted?.channels) ? sorted.channels : [];
        for (const ch of list) {
            try {
                const dm = buildDMEntry(ch);
                if (dm) push(dm);
            } catch {
                /* skip bad DM */
            }
        }
    } catch (e) {
        logger.warn("collect DMs failed", e);
    }

    // 4. Friend users (so @-search can start a DM even without an open channel)
    if (getFilterSettings().showUsers || getFilterSettings().friendsOnly) {
        try {
            const rel: any = RelationshipStore as any;
            const ids: string[] = typeof rel?.getFriendIDs === "function" ? rel.getFriendIDs() : [];
            for (const uid of ids.slice(0, 500)) {
                try {
                    const u = (UserStore as any)?.getUser?.(uid);
                    if (!u) continue;
                    push({
                        id: uid,
                        name: u?.globalName ?? u?.username ?? "Unknown",
                        type: "user",
                        guildId: null,
                        isFriend: true,
                        isBlocked: safeIsBlocked(uid),
                        iconUrl: userAvatarUrl(uid),
                    });
                } catch {
                    /* skip */
                }
            }
        } catch (e) {
            logger.warn("collect friends failed", e);
        }
    }

    attachRecents(out);
    const deduped = dedupeUserRows(out);
    const s = settings.store;
    buildIndex(deduped, s.caseSensitive ?? false, s.normalize ?? true);
    return deduped;
}

/** Cross-open cache: repeat opens reuse the last collect when nothing changed. */
const COLLECT_TTL_MS = 15000;
let collectCache: { items: SearchableItem[]; key: string; at: number } | null = null;
let lastCollectMs = 0;
let lastCollectCacheHit = false;

function collectVersionKey(): string {
    try {
        const gs: any = GuildStore as any;
        const cs: any = ChannelStore as any;
        const rel: any = RelationshipStore as any;
        const guilds = gs?.getGuilds?.() ?? {};
        const guildIds = Object.keys(guilds ?? {});
        // Fingerprint guild names (cheap: already in memory) so renames
        // invalidate the cache; same-length renames still wait out the TTL.
        let nameFp = 0;
        try {
            for (const id of guildIds) {
                const n = (guilds[id]?.name ?? "") as string;
                nameFp = (nameFp * 31 + n.length) | 0;
                for (let i = 0; i < Math.min(n.length, 8); i++) nameFp = (nameFp * 31 + n.charCodeAt(i)) | 0;
            }
        } catch {
            /* ignore */
        }
        // Hash channel names when getAll is available (capped 2000x8, sub-ms);
        // otherwise fall back to counts. Residual staleness bounded by COLLECT_TTL_MS.
        let channels = -1;
        let channelFp = 0;
        try {
            if (cs && typeof cs.getAll === "function") {
                const all = cs.getAll();
                const vals: any[] = Array.isArray(all)
                    ? all
                    : (all && typeof all === "object" ? Object.values(all) : []);
                if (Array.isArray(vals)) {
                    channels = vals.length;
                    const n = Math.min(vals.length, 2000);
                    for (let i = 0; i < n; i++) {
                        const rawCh: any = (vals[i] as any)?.channel ?? vals[i];
                        const nm = (rawCh?.name ?? "") as string;
                        channelFp = (channelFp * 31 + nm.length) | 0;
                        for (let j = 0; j < Math.min(nm.length, 8); j++) channelFp = (channelFp * 31 + nm.charCodeAt(j)) | 0;
                    }
                }
            } else if (typeof cs?.getChannelIds === "function") {
                const ids = cs.getChannelIds();
                if (Array.isArray(ids)) channels = ids.length;
            }
        } catch {
            /* ignore */
        }
        let friends = -1;
        try {
            if (typeof rel?.getFriendIDs === "function") {
                const ids = rel.getFriendIDs();
                if (Array.isArray(ids)) friends = ids.length;
            }
        } catch {
            /* ignore */
        }
        // Collection-shape settings: toggling these changes WHAT is collected
        // (not just how it is filtered), so they must invalidate the cache.
        const st: any = settings.store;
        const shape = `${st.showUsers ?? true ? 1 : 0}${st.friendsOnly ? 1 : 0}${st.caseSensitive ? 1 : 0}${st.normalize ?? true ? 1 : 0}`;
        return `${guildIds.length}:${channels}:${channelFp}:${friends}:${nameFp}:${shape}`;
    } catch {
        return "";
    }
}

export function collectItems(): SearchableItem[] {
    const key = collectVersionKey();
    const now = Date.now();
    if (collectCache && collectCache.key === key && now - collectCache.at < COLLECT_TTL_MS) {
        // Hit: recency still refreshes every open (cheap in-place loop), and
        // so do the volatile per-item flags (mute/block/unread can change
        // without changing any count in the version key — e.g. mid-session
        // toggles or new messages).
        lastCollectCacheHit = true;
        lastCollectMs = 0;
        for (const it of collectCache.items) {
            try {
                if (it.type === "guild") {
                    it.muted = safeIsGuildMuted(it.id);
                    it.unread = safeHasGuildUnread(it.id);
                } else if (it.type === "text" || it.type === "voice" || it.type === "thread") {
                    it.muted = safeIsChannelMuted(it.guildId, it.id);
                    it.unread = safeHasChannelUnread(it.id);
                } else if (it.type === "dm" || it.type === "group") {
                    it.unread = safeHasChannelUnread(it.id);
                }
                if (it.type === "dm" || it.type === "user") {
                    const uid = it.type === "dm" ? it.dmRecipientId : it.id;
                    if (uid) it.isBlocked = safeIsBlocked(uid);
                }
            } catch {
                /* keep cached flag */
            }
        }
        attachRecents(collectCache.items);
        return collectCache.items;
    }
    const t0 = Date.now();
    const items = collectItemsFresh();
    lastCollectMs = Date.now() - t0;
    lastCollectCacheHit = false;
    collectCache = { items, key, at: now };
    return items;
}

/**
 * Last-visited channel for a guild, validated against ChannelStore.
 * Discord's own server click restores this; calling
 * NavigationRouter.transitionToGuild(guildId) bare drops that memory and
 * lands on the first channel instead. Every getter is optional-chained so
 * unknown client shapes degrade to the guild fallback instead of a crash.
 */
function getLastGuildChannelId(guildId: string): string | null {
    try {
        const scs: any = SelectedChannelStore as any;
        if (!scs || typeof guildId !== "string" || !guildId) return null;
        const getters: Array<() => unknown> = [
            () => scs?.getChannelId?.(guildId),
            () => scs?.getCurrentlySelectedChannelId?.(guildId),
            () => scs?.getLastSelectedChannelId?.(guildId),
            () => scs?.getMostRecentSelectedTextChannelId?.(guildId),
        ];
        for (const get of getters) {
            let id: unknown = null;
            try {
                id = get();
            } catch {
                continue;
            }
            if (typeof id !== "string" || !id) continue;
            try {
                const ch: any = (ChannelStore as any)?.getChannel?.(id);
                if (!ch) continue;
                // Stale ids (deleted channel, moved thread) fall through to
                // the guild fallback instead of navigating nowhere.
                if (resolveGuildId(ch) !== guildId) continue;
            } catch {
                continue;
            }
            return id;
        }
    } catch {
        /* fall through to guild fallback */
    }
    return null;
}

function navigateTo(item: SearchableItem, onDone: () => void): void {
    try {
        recordOpen(item.id);
        if (item.type === "guild") {
            // Restore the last channel like a native server click does.
            // Bare transitionToGuild(guildId) lands on the first channel.
            const lastId = getLastGuildChannelId(item.id);
            if (lastId) {
                (ChannelRouter as any)?.transitionToChannel?.(lastId);
            } else {
                (NavigationRouter as any)?.transitionToGuild?.(item.id);
            }
        } else if (item.type === "user") {
            // Open (or create) a DM.
            (ChannelActionCreators as any)?.openPrivateChannel?.(item.id);
        } else {
            (ChannelRouter as any)?.transitionToChannel?.(item.id);
        }
    } catch (e) {
        logger.error("navigate failed", e);
    } finally {
        onDone();
    }
}

const OVERLAY: React.CSSProperties = {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.6)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 9999,
    // Our overlay lives inside Discord's modal layer, which may set
    // pointer-events: none on wrappers. Re-enable explicitly down the tree —
    // without this the modal is visibly open but hover/click/wheel are dead.
    pointerEvents: "auto",
};

const BOX: React.CSSProperties = {
    width: "min(570px, 92vw)",
    maxHeight: "70vh",
    display: "flex",
    flexDirection: "column",
    // midnight-discord/Catppuccin tokens first, Discord tokens as fallback, hex last.
    // NOTE: midnight does NOT remap --background-floating, so prefer --bg-3 first.
    background: "var(--bg-3, var(--background-floating, #1e1e2e))",
    borderRadius: "var(--roundness-l, 8px)",
    boxShadow: "0 8px 30px rgba(0,0,0,0.5)",
    overflow: "hidden",
    color: "var(--text-3, var(--text-normal, #dbdee1))",
    fontFamily: "inherit",
    pointerEvents: "auto",
};

const INPUT: React.CSSProperties = {
    width: "100%",
    boxSizing: "border-box",
    padding: "14px 16px",
    fontSize: 16,
    background: "transparent",
    border: "none",
    outline: "none",
    color: "var(--text-1, var(--header-primary, inherit))",
    pointerEvents: "auto",
};

const ROW: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 10,
    width: "100%",
    padding: "8px 14px",
    background: "transparent",
    border: "none",
    borderRadius: "var(--roundness-xs, 6px)",
    color: "inherit",
    cursor: "pointer",
    textAlign: "left",
    fontSize: 14,
    pointerEvents: "auto",
};

/**
 * Kill-switch for Discord's modal-layer fade: while our overlay is mounted,
 * disable transitions/animations on every ancestor of it. Discord ignores the
 * `instant` openModal flag, so this CSS (matched via :has(), no hashed class
 * names needed) is what actually delivers instant open/close. The <style> tag
 * unmounts with the modal, restoring stock transitions afterwards.
 */
const ANIM_KILL_CSS =
    "/* qsplus-noanim */*:has([data-testid=\"qsplus-overlay\"]){transition:none !important;animation:none !important;}";

const ICON_BOX: React.CSSProperties = {
    width: 24,
    height: 24,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    color: "var(--text-4, var(--channels-default, #949ba4))",
};

function HashGlyph() {
    return <span style={{ fontSize: 20, fontWeight: 600, lineHeight: 1, color: "var(--text-4, var(--channels-default, #949ba4))" }}>#</span>;
}

function VoiceGlyph() {
    return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <path d="M3 9v6h4l5 5V4L7 9H3z" fill="currentColor" />
            <path d="M16 8.5a5 5 0 010 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
    );
}

function ThreadGlyph() {
    return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M4 6h16M4 12h16M4 18h10" />
        </svg>
    );
}

function PersonGlyph() {
    return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="8" r="4" fill="currentColor" />
            <path d="M4 21c0-4 3.5-6.5 8-6.5s8 2.5 8 6.5" fill="currentColor" />
        </svg>
    );
}

function GroupGlyph() {
    return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <circle cx="9" cy="8.5" r="3.5" fill="currentColor" />
            <path d="M2.5 20c0-3.5 3-5.5 6.5-5.5s6.5 2 6.5 5.5" fill="currentColor" />
            <circle cx="17" cy="9.5" r="2.8" fill="currentColor" opacity="0.7" />
            <path d="M15.5 14.7c2.9.3 5.5 2 5.5 4.8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
    );
}

function RowIcon({ item }: { item: SearchableItem; }) {
    const safeUrls = Array.isArray(item.iconUrls)
        ? item.iconUrls.map(safeImgSrc).filter((u): u is string => !!u)
        : [];
    if (safeUrls.length > 0) {
        // Group DM: overlapping avatar stack like Discord's own group icons.
        return (
            <span style={{ width: 24, height: 24, display: "flex", alignItems: "center", flexShrink: 0, overflow: "hidden" }}>
                {safeUrls.slice(0, 3).map((url, i) => (
                    <img
                        key={i}
                        src={url}
                        draggable={false}
                        style={{
                            width: 16,
                            height: 16,
                            borderRadius: 8,
                            flexShrink: 0,
                            marginLeft: i === 0 ? 0 : -7,
                            outline: "2px solid var(--bg-3, var(--background-floating, #2b2d31))",
                        }}
                    />
                ))}
            </span>
        );
    }
    const safeUrl = safeImgSrc(item.iconUrl);
    if (safeUrl) {
        return (
            <img
                src={safeUrl}
                draggable={false}
                style={{
                    width: 24,
                    height: 24,
                    borderRadius: item.type === "guild" ? "var(--roundness-xs, 7px)" : 12,
                    flexShrink: 0,
                    background: "var(--bg-1, var(--background-modifier-active, rgba(255,255,255,0.08)))",
                }}
            />
        );
    }
    if (item.type === "guild") {
        // Guard non-string names; degrade to "?".
        const rawName = typeof item.name === "string" ? item.name.trim() : "";
        const letter = (rawName[0] ?? "?").toUpperCase();
        return (
            <span
                style={{
                    width: 24,
                    height: 24,
                    borderRadius: "var(--roundness-xs, 7px)",
                    flexShrink: 0,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 13,
                    fontWeight: 700,
                    color: "var(--text-1, var(--header-primary, #fff))",
                    background: "var(--bg-1, var(--background-modifier-active, rgba(255,255,255,0.1)))",
                }}
            >
                {letter}
            </span>
        );
    }
    return (
        <span style={ICON_BOX}>
            {item.type === "text" ? <HashGlyph />
                : item.type === "voice" ? <VoiceGlyph />
                : item.type === "thread" ? <ThreadGlyph />
                : item.type === "group" ? <GroupGlyph />
                : <PersonGlyph />}
        </span>
    );
}

// NOTE: do NOT call any React.* API at module top level (no React.memo here!).
// Vencord assigns React *after* evaluating plugin modules, so top-level
// React.* calls throw during import and kill the whole renderer. Instead,
// RowView stays a plain function and is memoized inside the component below
// (useMemo runs during render, when React is guaranteed assigned).
function RowView(props: {
    item: SearchableItem;
    itemKey: string;
    active: boolean;
    index: number;
    onHover: (i: number) => void;
    onChoose: (i: number) => void;
    registerRef: (key: string, el: HTMLButtonElement | null) => void;
}) {
    const { item, itemKey, active, index, onHover, onChoose, registerRef } = props;
    return (
        <button
            type="button"
            role="option"
            aria-selected={active}
            id={`qsplus-row-${item.type}-${item.id}`}
            data-type={item.type}
            data-id={item.id}
            ref={(el) => registerRef(itemKey, el)}
            style={{
                ...ROW,
                // Mirror midnight-discord's own selected rule:
                // background accent-3 + text-0.
                background: active
                    ? "var(--accent-3, var(--brand-500, var(--brand-experiment-560, #5865F2)))"
                    : "transparent",
                color: active
                    ? "var(--text-0, #fff)"
                    : "var(--text-3, var(--text-normal, inherit))",
            }}
            onMouseEnter={() => onHover(index)}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onChoose(index)}
        >
            <RowIcon item={item} />
            <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 500 }}>
                {item.name}
            </span>
            {item.subtitle && !active && (
                <span style={{ fontSize: 12, color: "var(--text-5, var(--text-muted))", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 140 }}>
                    {item.subtitle}
                </span>
            )}
        </button>
    );
}

function QuickFindModal({ onClose }: { onClose: () => void; }) {
    const [query, setQuery] = useState("");
    const [debounced, setDebounced] = useState("");
    const [sel, setSel] = useState(0);
    const [tab, setTab] = useState<Tab>("all");
    const inputRef = useRef<HTMLInputElement>(null);
    const rowRefs = useRef(new Map<string, HTMLButtonElement>());
    // Pending debounce timer id: cancelled synchronously on dismiss so a
    // timer firing mid-close can't force a wasted search + render pass.
    const debounceRef = useRef<number | null>(null);

    // Focus that survives Discord's focus trap stealing it on mount.
    const focusInput = useCallback(() => {
        let tries = 0;
        const attempt = () => {
            tries++;
            const el = inputRef.current;
            if (!el) return;
            if (document.activeElement !== el && tries <= 5) {
                try {
                    el.focus({ preventScroll: true });
                } catch {
                    el.focus();
                }
                if (document.activeElement !== el) setTimeout(attempt, 60);
            }
        };
        attempt();
    }, []);

    const allItems = useMemo(() => {
        try {
            return collectItems();
        } catch (e) {
            logger.error("collectItems failed", e);
            return [];
        }
    }, []);

    useLayoutEffect(() => {
        focusInput();
    }, [focusInput]);

    useEffect(() => {
        const ms: number = settings.store.debounceMs ?? 50;
        if (debounceRef.current != null) clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(() => {
            debounceRef.current = null;
            setDebounced(query);
        }, ms) as unknown as number;
        return () => {
            if (debounceRef.current != null) {
                clearTimeout(debounceRef.current);
                debounceRef.current = null;
            }
        };
    }, [query]);

    // Reset selection only when the result set's query actually changes.
    // (Resetting inside the debounce timer above would clobber arrow-key
    // movement if the timer fires late, e.g. under a throttled event loop.)
    const lastQueryKey = useRef<string | null>(null);
    useEffect(() => {
        const key = debounced + "\0" + tab;
        if (lastQueryKey.current !== key) {
            lastQueryKey.current = key;
            setSel(0);
        }
    }, [debounced, tab]);

    const results = useMemo(() => {
        const s = settings.store;
        const filters: FilterSettings = getFilterSettings();
        // Explicit typed prefix always wins over the tab: if the user typed
        // "#foo" we search channels even from the Servers tab. The tab is
        // only a default scope for bare queries.
        const typed = parseQueryPrefix(debounced);
        const typedHasScope = typed.scope !== "all";
        // In-modal tab overrides the global toggle for this session
        // (only when the query doesn't already carry an explicit scope).
        if (!typedHasScope && tab === "servers") filters.serversOnly = true;
        const scopedQuery = tab === "all" || typedHasScope
            ? debounced
            : `${tab === "servers" ? "*" : tab === "channels" ? "#" : "@"}${debounced.replace(/^[#@*]\s*/, "")}`;

        const visible = applyFilters(allItems, filters);
        const parsed = parseQueryPrefix(scopedQuery);
        // Extra tab-level scope enforcement (friends tab = friends only),
        // skipped when the query carries its own explicit scope.
        let pool = visible;
        if (!typedHasScope && tab === "friends") pool = pool.filter(i => i.isFriend || i.type === "group");
        else if (parsed.scope !== "all") pool = pool.filter(i => scopeMatches(parsed.scope, i.type));

        // Snapshot the settings this memo reads: settings.store is a mutable
        // object, so depending on it by reference would never recompute.
        const st = settings.store as any;
        return rankAndFilter(pool, scopedQuery, {
            mode: (st.searchMode as SearchMode) ?? "fuzzy",
            fuzzyEnabled: st.fuzzyEnabled ?? true,
            sensitivity: st.sensitivity ?? DEFAULT_SEARCH_OPTIONS.sensitivity,
            caseSensitive: st.caseSensitive ?? false,
            normalize: st.normalize ?? true,
            maxResults: st.maxResults ?? 30,
            sortBy: (st.sortBy as SortBy) ?? "relevance",
            currentGuildId: (() => { try { return (SelectedGuildStore as any)?.getGuildId?.() ?? null; } catch { return null; } })(),
            currentGuildBoost: (st.currentGuildBoost ?? true) ? 25 : 0,
            recentBoost: (st.recentBoost ?? true) ? 30 : 0,
            kindOrder: KIND_ORDER_PRESETS[st.kindOrder as string] ?? null,
            kindBoost: st.kindBoost ?? 0,
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [
        allItems,
        debounced,
        tab,
        (settings.store as any).searchMode,
        (settings.store as any).fuzzyEnabled,
        (settings.store as any).sensitivity,
        (settings.store as any).caseSensitive,
        (settings.store as any).normalize,
        (settings.store as any).maxResults,
        (settings.store as any).sortBy,
        (settings.store as any).currentGuildBoost,
        (settings.store as any).recentBoost,
        (settings.store as any).kindOrder,
        (settings.store as any).kindBoost,
        (settings.store as any).showServers,
        (settings.store as any).showTextChannels,
        (settings.store as any).showVoiceChannels,
        (settings.store as any).showThreads,
        (settings.store as any).showDMs,
        (settings.store as any).showGroupDMs,
        (settings.store as any).showUsers,
        (settings.store as any).friendsOnly,
        (settings.store as any).hideBlocked,
        (settings.store as any).hideMuted,
        (settings.store as any).hideArchivedThreads,
        (settings.store as any).serversOnly,
    ]);

    // Clamp selection when the result list shrinks without a query/tab
    // change (e.g. maxResults lowered): Enter must never target a ghost row.
    useEffect(() => {
        setSel((v: number) => Math.min(v, Math.max(results.length - 1, 0)));
    }, [results.length]);

    // Optimistic hide: remove our own DOM synchronously the moment the user
    // dismisses, so close feels instant even if the host modal stack animates
    // or delays. Initialized from the module close flag so a close that lands
    // before mount effects still hides on first render. onClose still cleans
    // up the stack entry (idempotent).
    const [gone, setGone] = useState(forceGone);
    const done = useCallback((source: Exclude<CloseTrigger, "toggle" | "none">) => {
        if (debounceRef.current != null) {
            clearTimeout(debounceRef.current);
            debounceRef.current = null;
        }
        closeTriggerPending = source;
        setGone(true);
        onClose();
    }, [onClose]);

    const choose = useCallback((idx: number) => {
        const it = results[idx];
        if (it) navigateTo(it, () => done("navigate"));
    }, [results, done]);

    const handleHover = useCallback((i: number) => setSel(i), []);

    const registerRef = useCallback((key: string, el: HTMLButtonElement | null) => {
        if (el) rowRefs.current.set(key, el);
        else rowRefs.current.delete(key);
    }, []);

    // Memoized at RENDER time (not module top level): useMemo runs during
    // the first render, when Vencord has assigned React. Safe by construction;
    // the strict boot test would catch a regression back to top-level memo.
    const MemoRow = useMemo(() => React.memo(RowView), []);

    const setTabAndFocus = (t: Tab) => {
        setTab(t);
        setSel(0);
        // Input stays mounted across tab switches; re-assert focus in case
        // the keypress/mouse interaction moved it (e.g. after clicking a tab).
        setTimeout(focusInput, 0);
    };

    const onKeyDown = (e: React.KeyboardEvent) => {
        dlog("react-keydown:", String(e.key));
        // Ctrl+number shortcuts must not fire with extra modifiers held
        // (Ctrl+Shift+3 is someone else's keybind, not ours).
        const ctrlNum = e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey
            && ["1", "2", "3", "4"].includes(e.key);
        const handled = e.key === "Escape" || e.key === "ArrowDown" || e.key === "ArrowUp"
            || e.key === "Enter" || e.key === "Home" || e.key === "End" || ctrlNum;
        if (handled) e.stopPropagation(); // keep Discord's modal stack out of our keys
        if (e.key === "Escape") {
            e.preventDefault();
            // Close immediately: a separate clear step felt laggy in practice.
            done("key");
        } else if (e.key === "ArrowDown") {
            e.preventDefault();
            setSel((v: number) => Math.min(v + 1, Math.max(results.length - 1, 0)));
        } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setSel((v: number) => Math.max(v - 1, 0));
        } else if (e.key === "Home") {
            e.preventDefault();
            setSel(0);
        } else if (e.key === "End") {
            e.preventDefault();
            setSel(Math.max(results.length - 1, 0));
        } else if (e.key === "Enter") {
            e.preventDefault();
            choose(sel);
        } else if (ctrlNum && e.key === "1") {
            e.preventDefault();
            setTabAndFocus("all");
        } else if (ctrlNum && e.key === "2") {
            e.preventDefault();
            setTabAndFocus("servers");
        } else if (ctrlNum && e.key === "3") {
            e.preventDefault();
            setTabAndFocus("channels");
        } else if (ctrlNum && e.key === "4") {
            e.preventDefault();
            setTabAndFocus("friends");
        }
    };

    // Keep the keyboard-selected row visible while arrowing through the list.
    useEffect(() => {
        const r = results[sel];
        const el = r ? rowRefs.current.get(`${r.type}:${r.id}`) : undefined;
        try {
            el?.scrollIntoView({ block: "nearest" });
        } catch {
            /* older Chromium without smooth options — selection still works */
        }
    }, [sel, results]);

    // Expose the optimistic hide to closePlus (module scope) so even the
    // global Ctrl+K toggle hides instantly instead of waiting on the host.
    useEffect(() => {
        hideModal = () => setGone(true);
        // First commit: record open latency for the probe PERF line.
        if (openT0 > 0) {
            lastOpenMs = nowMs() - openT0;
            openT0 = 0;
        }
        return () => {
            hideModal = null;
            // Unmount: the close took this long from done()/closePlus.
            if (closeT0 > 0) {
                lastCloseMs = nowMs() - closeT0;
                closeT0 = 0;
            }
        };
    }, []);

    // Must come after all hooks: instantly unmount on dismiss so close is
    // perceived immediately, independent of host modal-stack timing.
    if (gone) return null;

    return (
        <div
            style={OVERLAY}
            onClick={(e: any) => {
                // Contain the dismiss: without this the click keeps bubbling
                // through Discord's app tree (popouts, clickaway handlers),
                // whose trailing work delays the paint of our hidden state.
                try {
                    e.stopPropagation();
                } catch {
                    /* ignore */
                }
                done("mouse");
            }}
            onMouseDown={(e: any) => {
                // Backdrop mousedown must not steal focus out of the input.
                try {
                    e.preventDefault();
                } catch {
                    /* ignore */
                }
            }}
            data-testid="qsplus-overlay" data-tab={tab} data-sel={sel} data-results={results.length}
        >
            {((settings.store as any)?.disableAnimations ?? true) && <style>{ANIM_KILL_CSS}</style>}
            {/* NOTE: single keydown handler lives on this container only.
                Do NOT add onKeyDown to the input — React bubbles it here,
                and a second handler would run every key twice. */}
            <div style={BOX} onClick={(e: any) => e.stopPropagation()} onKeyDown={onKeyDown}>
                <input
                    ref={inputRef}
                    className="qsplus-input"
                    style={INPUT}
                    autoFocus
                    aria-label="Search servers, channels and friends"
                    role="combobox"
                    aria-expanded={results.length > 0}
                    aria-activedescendant={results[sel] ? `qsplus-row-${results[sel].type}-${results[sel].id}` : undefined}
                    placeholder="Search servers, channels, friends…"
                    value={query}
                    onChange={(e: any) => setQuery(e.target.value)}
                />
                <div style={{ display: "flex", gap: 6, padding: "0 12px 8px", fontSize: 12, pointerEvents: "auto" }}>
                    {(["all", "servers", "channels", "friends"] as Tab[]).map((t: Tab) => (
                        <button
                            key={t}
                            type="button"
                            aria-pressed={tab === t}
                            onMouseDown={(e: any) => e.preventDefault()}
                            onClick={() => setTabAndFocus(t)}
                            style={{
                                padding: "2px 8px",
                                borderRadius: "var(--roundness-xxs, 10px)",
                                border: "1px solid var(--bg-2, var(--background-modifier-accent, rgba(255,255,255,0.15)))",
                                background: tab === t
                                    ? "var(--accent-3, var(--brand-500, var(--brand-experiment-560, #5865F2)))"
                                    : "var(--bg-2, transparent)",
                                color: tab === t
                                    ? "var(--text-0, #fff)"
                                    : "var(--text-3, var(--text-normal, inherit))",
                                cursor: "pointer",
                                pointerEvents: "auto",
                            }}
                        >
                            {t === "all" ? "All" : t === "servers" ? "* Servers" : t === "channels" ? "# Channels" : "@ Friends"}
                        </button>
                    ))}
                    <span style={{ marginLeft: "auto", color: "var(--text-5, var(--text-muted))" }}>Ctrl+1–4</span>
                </div>
                <ErrorBoundary>
                <div
                    className="qsplus-list"
                    role="listbox"
                    aria-label="Quick switcher results"
                    // Fixed height: the window must not resize as results
                    // come and go — short lists leave blank space instead.
                    // flexShrink + minHeight keep tiny viewports working
                    // (the box maxHeight cap takes over there).
                    style={{ height: 320, overflowY: "auto", padding: "0 8px 4px", flexShrink: 1, minHeight: 0, pointerEvents: "auto" }}
                    // Discord's modal root can swallow wheel events before they
                    // reach an overflow container: scroll manually and keep the
                    // event from propagating into Discord's own scrollers.
                    onWheel={(e: any) => {
                        try {
                            const el = e.currentTarget;
                            if (el && typeof el.scrollTop === "number") el.scrollTop += e.deltaY;
                        } catch {
                            /* manual scroll is best-effort */
                        }
                        try {
                            e.stopPropagation();
                        } catch {
                            /* ignore */
                        }
                    }}
                >
                    <style>{`.qsplus-list::-webkit-scrollbar{width:8px}.qsplus-list::-webkit-scrollbar-track{background:transparent}.qsplus-list::-webkit-scrollbar-thumb{background:var(--bg-1, var(--background-modifier-active, rgba(255,255,255,.12)));border-radius:4px}.qsplus-input::placeholder{color:var(--text-5, var(--text-muted, rgba(255,255,255,.4)))}`}</style>
                    {results.map((r: SearchableItem, i: number) => (
                        <MemoRow
                            key={`${r.type}:${r.id}`}
                            item={r}
                            itemKey={`${r.type}:${r.id}`}
                            active={i === sel}
                            index={i}
                            onHover={handleHover}
                            onChoose={choose}
                            registerRef={registerRef}
                        />
                    ))}
                </div>
                </ErrorBoundary>
            </div>
        </div>
    );
}

let removeListener: (() => void) | null = null;
let modalKey: string | null = null;
/** Set by the mounted modal; lets closePlus hide content synchronously. */
let hideModal: (() => void) | null = null;
/**
 * Set by closePlus before the mounted modal can react. Read synchronously
 * on first render so even a close-before-mount hides instantly instead of
 * waiting out Discord's modal-close animation. Reset on every open.
 */
let forceGone = false;

/** Which gesture dismissed the modal (reported on the probe PERF line). */
export type CloseTrigger = "mouse" | "key" | "navigate" | "toggle" | "none";
let closeTriggerPending: CloseTrigger | null = null;
let lastCloseTrigger: CloseTrigger = "none";

/** Open/close latency instrumentation (reported on the probe PERF line). */
let openT0 = 0;
let closeT0 = 0;
let lastOpenMs = -1;
let lastCloseMs = -1;
let lastCloseMode = "none";

function nowMs(): number {
    try {
        if (typeof performance !== "undefined" && typeof performance.now === "function") return performance.now();
    } catch {
        /* ignore */
    }
    return Date.now();
}

/** Idempotent close: null the key BEFORE closing so double-dismiss can't wedge reopen. */
function closePlus(): void {
    const key = modalKey;
    modalKey = null;
    forceGone = true;
    // Attribute the close: done() stashes its gesture beforehand, so a
    // direct call here means the Ctrl+K toggle.
    lastCloseTrigger = closeTriggerPending ?? "toggle";
    closeTriggerPending = null;
    lastCloseMode = hideModal ? "instant" : "discord-fallback";
    closeT0 = nowMs();
    dlog("closePlus:", key);
    if (key == null) return;
    try {
        // Hide our own DOM first: instant disappearance even if the host
        // modal stack animates or delays its unmount.
        hideModal?.();
    } catch (e) {
        logger.warn("hideModal failed", e);
    }
    try {
        closeModal(key);
    } catch (e) {
        logger.warn("closeModal failed (probably already closed)", e);
    }
}

function openPlus(): void {
    try {
        forceGone = false;
        openT0 = nowMs();
        // Self-heal: if a previous close left a stale key, clear it first.
        if (modalKey != null) {
            dlog("openPlus: stale key, closing first");
            try {
                closeModal(modalKey);
            } catch {
                /* already gone */
            }
            modalKey = null;
        }
        // instant: skip Discord's modal enter/exit transitions, like the
        // native quick switcher does. Falls back to animated on old clients
        // that ignore the option (harmless extra arg). User-toggleable via
        // the disableAnimations setting.
        const instant = settings.store.disableAnimations ?? true;
        modalKey = openModal(() => <QuickFindModal onClose={closePlus} />, instant ? { instant: true } as any : undefined);
        dlog("openPlus: opened", modalKey);
    } catch (e) {
        modalKey = null;
        logger.error("openModal failed", e);
    }
}

function onKeyDownCapture(e: KeyboardEvent): void {
    try {
        dlog("capture-seen:", String(e.key), "ctrl=" + !!e.ctrlKey, "repeat=" + !!e.repeat);
        const mod = e.ctrlKey || e.metaKey;
        if (!mod || e.shiftKey || e.altKey) return;
        if (e.key.toLowerCase() !== "k") return;
        if (!settings.store.hijackCtrlK) return;
        // Swallow first so the native switcher never leaks through, even on
        // key-repeat (repeats must not toggle: holding Ctrl+K would flicker).
        e.preventDefault();
        e.stopImmediatePropagation();
        dlog("capture: ctrl+k", "repeat=" + e.repeat, "modalKey=" + modalKey);
        if (e.repeat) return;
        // Toggle: close an open modal, otherwise open it.
        if (modalKey != null) closePlus();
        else openPlus();
    } catch (err) {
        logger.error("keydown handler failed", err);
    }
}

export default definePlugin({
    name: "QuickFind",
    description: "Improved Discord Search.",
    authors: [Devs.Ven],
    tags: ["Utility", "Shortcuts"],

    settings,

    toolboxActions: {
        "Clear QuickFind recents": () => {
            try {
                clearRecents();
            } catch (e) {
                logger.error("clear recents failed", e);
            }
        },
        "Dump QuickFind internals (console)": () => {
            try {
                const lines: string[] = [];
                // Own runtime state first: distinguishes "event never arrives"
                // from "handler runs, open fails" from "opened but invisible".
                try {
                    const overlayCount = typeof document !== "undefined"
                        ? document.querySelectorAll('[data-testid="qsplus-overlay"]').length
                        : -1;
                    lines.push(`PLUS state: modalKey=${modalKey == null ? "null" : "set"} hideModal=${hideModal == null ? "unset" : "armed"} listener=${removeListener == null ? "off" : "on"} overlaysInDOM=${overlayCount} build=${BUILD_TAG}`);
                } catch (e) {
                    lines.push(`PLUS state: unreadable (${String(e).slice(0, 80)})`);
                }
                for (const name of ["QuickSwitcherStore", "QuickSwitcher", "UseQuickSwitcherStore"]) {
                    try {
                        const s: any = findStore(name);
                        if (s) {
                            const proto = Object.getPrototypeOf(s);
                            lines.push(`STORE ${name}: own=[${Object.keys(s).slice(0, 40).join(",")}]`);
                            lines.push(`STORE ${name}: proto=[${Object.getOwnPropertyNames(proto).slice(0, 40).join(",")}]`);
                            try {
                                const snap: Record<string, string> = {};
                                for (const k of Object.keys(s).slice(0, 30)) {
                                    const v = s[k];
                                    if (v == null || ["string", "number", "boolean"].includes(typeof v)) snap[k] = String(v);
                                    else if (Array.isArray(v)) snap[k] = `array(${v.length})`;
                                    else snap[k] = typeof v;
                                }
                                lines.push(`STATE ${name}: ${JSON.stringify(snap).slice(0, 500)}`);
                            } catch { /* ignore */ }
                        } else {
                            lines.push(`STORE ${name}: not found`);
                        }
                    } catch (e) {
                        lines.push(`STORE ${name}: lookup failed (${String(e).slice(0, 120)})`);
                    }
                }
                try {
                    const mods = findAll((m: any) => {
                        try {
                            return typeof m === "function" && Function.prototype.toString.call(m).includes("QUICKSWITCHER_SEARCH");
                        } catch {
                            return false;
                        }
                    });
                    const arr = Array.isArray(mods) ? mods : [];
                    lines.push(`CODEMATCH QUICKSWITCHER_SEARCH count=${arr.length}`);
                    for (const m of arr.slice(0, 3)) {
                        try {
                            lines.push(`CODEMATCH keys=[${Object.keys(m).slice(0, 25).join(",")}]`);
                        } catch { /* ignore */ }
                    }
                } catch {
                    lines.push("CODEMATCH: lookup failed");
                }
                try {
                    const f = getFilterSettings();
                    const s = settings.store;
                    lines.push(`FILTERS servers=${f.showServers} text=${f.showTextChannels} voice=${f.showVoiceChannels} threads=${f.showThreads} dms=${f.showDMs} groups=${f.showGroupDMs} users=${f.showUsers} serversOnly=${f.serversOnly} friendsOnly=${f.friendsOnly} hideBlocked=${f.hideBlocked} hideMuted=${f.hideMuted} hideArchived=${f.hideArchivedThreads} mode=${s.searchMode} maxResults=${s.maxResults} sortBy=${s.sortBy} prio=${s.kindOrder}/${s.kindBoost}`);
                } catch (e) {
                    lines.push(`FILTERS: unreadable (${String(e).slice(0, 120)})`);
                }
                try {
                    const cs: any = ChannelStore as any;
                    const gcs: any = GuildChannelStore as any;
                    const gs: any = GuildStore as any;
                    const guilds = gs?.getGuilds?.() ?? {};
                    lines.push(`STORE-API ChannelStore.getAll=${typeof cs?.getAll} getChannelIds=${typeof cs?.getChannelIds} getSortedPrivateChannels=${typeof cs?.getSortedPrivateChannels} GuildChannelStore.getChannels=${typeof gcs?.getChannels} guilds=${Object.keys(guilds).length}`);
                } catch (e) {
                    lines.push(`STORE-API: unreadable (${String(e).slice(0, 120)})`);
                }
                try {
                    const items = collectItems();
                    const counts: Record<string, number> = {};
                    for (const it of items) counts[it.type] = (counts[it.type] ?? 0) + 1;
                    lines.push(`COLLECT total=${items.length} byType=${JSON.stringify(counts)} cache=${lastCollectCacheHit ? "hit" : "miss"} collectMs=${lastCollectMs}`);
                } catch (e) {
                    lines.push(`COLLECT failed: ${String(e && (e as Error).message || e).slice(0, 200)}`);
                }
                lines.push(`PERF openMs=${Math.round(lastOpenMs)} closeMs=${Math.round(lastCloseMs)} closeMode=${lastCloseMode} closeTrigger=${lastCloseTrigger}`);
                const out = "[QuickFind probe]\n" + lines.join("\n");
                // biome-ignore lint/suspicious/noConsole: probe output for the user to paste back
                console.log(out);
                logger.info(out);
            } catch (e) {
                logger.error("probe failed", e);
            }
        },
    },

    start() {
        // Never register twice: a duplicate capture listener would toggle
        // twice per keypress (open then instantly close = "stuck"/dead).
        if (removeListener) return;
        window.addEventListener("keydown", onKeyDownCapture, true);
        removeListener = () => window.removeEventListener("keydown", onKeyDownCapture, true);
    },

    stop() {
        // Close any open modal first so disabling the plugin can't orphan
        // a modal whose key handler is about to be removed.
        try {
            closePlus();
        } finally {
            removeListener?.();
            removeListener = null;
        }
    },
});
