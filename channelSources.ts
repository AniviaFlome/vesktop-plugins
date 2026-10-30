/*
 * QuickFind — Discord store-shape adapters.
 * Discord's stores change shape across versions and our mocks only cover one
 * shape, so channel enumeration must tolerate: plain records, Maps,
 * GuildChannelStore's { SELECTABLE, VOCAL } comparator-wrapper lists,
 * and missing methods entirely. Every branch is unit-tested.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/** Flatten any known channel-container shape into raw channel objects. */
export function unwrapElement(e: unknown): any {
    if (e != null && typeof e === "object" && "channel" in (e as Record<string, unknown>)) {
        const c = (e as Record<string, unknown>).channel;
        if (c != null && typeof c === "object") return c;
    }
    return e;
}

export function asChannelArray(source: unknown): any[] {
    try {
        if (!source) return [];
        // Single comparator/thread wrapper, e.g. { channel, comparator }.
        if (typeof source === "object" && !Array.isArray(source) && "channel" in (source as Record<string, unknown>)) {
            return [unwrapElement(source)];
        }
        if (Array.isArray(source)) return source.map(unwrapElement);
        if (typeof source === "object") {
            const o = source as Record<string, any>;
            // GuildChannelStore.getChannels(guildId) shape:
            // { SELECTABLE: [{channel, comparator}], VOCAL: [...] }
            const grouped = ["SELECTABLE", "VOCAL", "selectable", "vocal"]
                .filter(k => Array.isArray(o[k]));
            if (grouped.length > 0) {
                const out: any[] = [];
                for (const k of grouped) {
                    for (const e of o[k] as any[]) {
                        out.push(unwrapElement(e));
                    }
                }
                // Numeric category buckets (e.g. key "4") hold the same
                // wrapper shape; include for completeness (type 4 is
                // filtered downstream, so this is harmless).
                for (const k of Object.keys(o)) {
                    if (/^\d+$/.test(k) && Array.isArray(o[k])) {
                        for (const e of o[k] as any[]) out.push(unwrapElement(e));
                    }
                }
                return out;
            }
            // Map (has .values + .size, no useful string keys).
            if (typeof o.values === "function" && typeof (o as any).size === "number") {
                try {
                    return [...(o as unknown as Map<string, any>).values()].map(unwrapElement);
                } catch {
                    return [];
                }
            }
            // Plain record: values may be raw channels or wrappers.
            return Object.values(o).map(unwrapElement);
        }
    } catch {
        /* ignore */
    }
    return [];
}

export interface ChannelStoreLike {
    getAll?(): unknown;
    getChannelIds?(guildId?: string | null): unknown;
    getChannel?(id: string): unknown;
    getMutableGuildChannelsForGuild?(guildId: string): unknown;
    getMutableBasicGuildChannelsForGuild?(guildId: string): unknown;
    getAllThreadsForGuild?(guildId: string): unknown;
    getSortedPrivateChannels?(): unknown;
}

export interface GuildStoreLike {
    getGuilds?(): unknown;
}

export interface GuildChannelStoreLike {
    getChannels?(guildId: string): unknown;
    getAllGuilds?(): unknown;
    getSelectableChannels?(guildId: string): unknown;
}

/** Map Discord numeric channel.type to our ItemType. Pure: unit-tested. */
export function channelTypeToItem(channel: any): "text" | "voice" | "dm" | "group" | "thread" | null {
    // https://discord.com/developers/docs/resources/channel#channel-object-channel-types
    switch (channel?.type) {
        case 0: // GUILD_TEXT
        case 5: // GUILD_ANNOUNCEMENT
        case 15: // GUILD_FORUM (treat as text)
        case 16: // GUILD_MEDIA (treat as text)
            return "text";
        case 13: // GUILD_STAGE_VOICE -> voice-ish
        case 2: // GUILD_VOICE
            return "voice";
        case 1: // DM
            return "dm";
        case 3: // GROUP_DM
            return "group";
        case 10: // GUILD_NEWS_THREAD
        case 11: // GUILD_PUBLIC_THREAD
        case 12: // GUILD_PRIVATE_THREAD
            return "thread";
        case 4: // GUILD_CATEGORY
            return null;
        default:
            // Unknown: treat guild channels as text so they stay searchable
            if (channel?.guild_id) return "text";
            try {
                if (typeof channel?.getGuildId === "function" && channel.getGuildId()) return "text";
            } catch {
                /* ignore */
            }
            return null;
    }
}

/** Best-effort guild id: raw field first, then the Channel class getter. */
export function resolveGuildId(ch: any): string | null {
    try {
        const raw = ch?.guild_id;
        if (typeof raw === "string" && raw) return raw;
        if (typeof ch?.getGuildId === "function") {
            const v = ch.getGuildId();
            if (typeof v === "string" && v) return v;
        }
    } catch {
        /* ignore */
    }
    return null;
}

/** Archived threads hide behind several shapes across builds. */
export function isArchivedChannel(ch: any): boolean {
    try {
        if (typeof ch?.isArchivedThread === "function" && ch.isArchivedThread()) return true;
    } catch {
        /* ignore */
    }
    try {
        if (typeof ch?.isArchived === "function" && ch.isArchived()) return true;
    } catch {
        /* ignore */
    }
    try {
        if (ch?.threadMetadata?.archived) return true;
    } catch {
        /* ignore */
    }
    return !!ch?.archived;
}

function pushStamped(out: any[], seen: Set<string>, items: any[], guildId?: string): void {
    for (const ch of items) {
        if (!ch || typeof ch !== "object") continue;
        if (guildId && !(ch as any).guild_id) {
            try {
                (ch as any).guild_id = guildId;
            } catch {
                /* read-only object: resolveGuildId/getGuildId covers it downstream */
            }
        }
        const id = (ch as any).id;
        if (typeof id === "string" && id) {
            if (seen.has(id)) continue;
            seen.add(id);
        }
        out.push(ch);
    }
}

/**
 * Gather guild-channel candidates from WHICHEVER store APIs exist, UNIONED.
 * Never throws; returns [] when nothing is available.
 *
 * Previously this returned the first non-empty source, so a partial cache
 * (e.g. getAll with only DMs, or getChannelIds missing unloaded guilds)
 * silently hid every channel the other sources would have provided.
 * Union + id-dedupe costs a few ms on 150 guilds and fixes that class.
 */
export function gatherChannelCandidates(
    channelStore: ChannelStoreLike | null | undefined,
    guildStore: GuildStoreLike | null | undefined,
    guildChannelStore?: GuildChannelStoreLike | null,
): any[] {
    const out: any[] = [];
    const seen = new Set<string>();
    const cs = channelStore as any;
    const push = (ch: any) => {
        if (!ch || typeof ch !== "object") return;
        const id = (ch as any).id;
        if (typeof id === "string" && id) {
            if (seen.has(id)) return;
            seen.add(id);
        }
        out.push(ch);
    };
    const pushMany = (items: any[], guildId?: string) => pushStamped(out, seen, items, guildId);

    // 1. Global record/Map — the fast path when present.
    try {
        if (cs && typeof cs.getAll === "function") {
            pushMany(asChannelArray(cs.getAll()));
        }
    } catch {
        /* fall through */
    }

    // 2. Channel IDs + per-channel lookup (global, then per-guild below).
    // When the global call already returned ids, the per-guild getChannelIds
    // loop in step 4 would just re-fetch the same channels via getChannel —
    // skip it and let the per-guild store snapshots fill any gaps.
    let globalIdsCovered = false;
    try {
        if (cs && typeof cs.getChannelIds === "function" && typeof cs.getChannel === "function") {
            const ids = cs.getChannelIds();
            if (Array.isArray(ids)) {
                globalIdsCovered = ids.length > 0;
                for (const id of ids) {
                    try {
                        const ch = cs.getChannel(id);
                        if (ch) push(ch);
                    } catch {
                        /* skip bad id */
                    }
                }
            }
        }
    } catch {
        /* fall through */
    }

    // 3. Bulk per-guild snapshot (single call when available).
    try {
        const gcs = guildChannelStore as any;
        if (gcs && typeof gcs.getAllGuilds === "function") {
            const all = gcs.getAllGuilds();
            if (all && typeof all === "object") {
                for (const [gid, gc] of Object.entries(all as Record<string, any>)) {
                    try {
                        pushMany(asChannelArray(gc), gid);
                    } catch {
                        /* next guild */
                    }
                }
            }
        }
    } catch {
        /* ignore */
    }

    // 4. Per-guild records, selectable lists and threads.
    try {
        const guilds = (guildStore as any)?.getGuilds?.() ?? {};
        const gids = Object.keys(guilds ?? {});
        const gcs = guildChannelStore as any;
        for (const gid of gids) {
            if (!globalIdsCovered) {
                try {
                    if (cs && typeof cs.getChannelIds === "function" && typeof cs.getChannel === "function") {
                        try {
                            const ids = cs.getChannelIds(gid);
                            if (Array.isArray(ids)) {
                                for (const id of ids) {
                                    try {
                                        const ch = cs.getChannel(id);
                                        if (ch) pushStamped(out, seen, [ch], gid);
                                    } catch {
                                        /* skip bad id */
                                    }
                                }
                            }
                        } catch {
                            /* next source */
                        }
                    }
                } catch {
                    /* next source */
                }
            }
            try {
                if (cs && typeof cs.getMutableGuildChannelsForGuild === "function") {
                    pushMany(asChannelArray(cs.getMutableGuildChannelsForGuild(gid)), gid);
                } else if (cs && typeof cs.getMutableBasicGuildChannelsForGuild === "function") {
                    pushMany(asChannelArray(cs.getMutableBasicGuildChannelsForGuild(gid)), gid);
                }
            } catch {
                /* next source */
            }
            try {
                if (gcs && typeof gcs.getChannels === "function") {
                    pushMany(asChannelArray(gcs.getChannels(gid)), gid);
                } else if (gcs && typeof gcs.getSelectableChannels === "function") {
                    pushMany(asChannelArray(gcs.getSelectableChannels(gid)), gid);
                }
            } catch {
                /* next guild */
            }
            try {
                if (cs && typeof cs.getAllThreadsForGuild === "function") {
                    pushMany(asChannelArray(cs.getAllThreadsForGuild(gid)), gid);
                }
            } catch {
                /* next guild */
            }
        }
    } catch {
        /* ignore */
    }
    return out;
}
