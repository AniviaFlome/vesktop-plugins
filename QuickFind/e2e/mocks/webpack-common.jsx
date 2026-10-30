import * as React from "react";
import * as ReactDOMClient from "react-dom/client";
const { act } = React;
import { spies } from "./state.js";

const {
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useReducer,
    useRef,
    useState,
} = React;

// ---------- fake Discord data ----------
const GUILDS = {};
for (let i = 1; i <= 20; i++) {
    const id = `g${i}`;
    GUILDS[id] = {
        id,
        name: i === 1 ? "Alpha Server" : `Server Number ${i}`,
        icon: i % 2 === 0 ? `iconhash${i}` : null,
    };
}

const USERS = {
    u1: { id: "u1", username: "bob", globalName: "Bob", avatar: "avatar1", discriminator: "0" },
    u2: { id: "u2", username: "alice", globalName: "Alice", avatar: null, discriminator: "1234" },
    u3: { id: "u3", username: "spammer", globalName: "Spammer", avatar: null, discriminator: "7" },
};
const FRIENDS = new Set(["u1", "u2"]);
const BLOCKED = new Set(["u3"]);

const CHANNELS = {
    c1: { id: "c1", name: "general", type: 0, guild_id: "g1" },
    c2: { id: "c2", name: "gaming", type: 0, guild_id: "g1" },
    c3: { id: "c3", name: "Lounge Voice", type: 2, guild_id: "g1" },
    c4: { id: "c4", name: "news-thread", type: 11, guild_id: "g1", archived: false },
    c5: { id: "c5", name: "media-mix", type: 16, guild_id: "g1" },
    c6: { id: "c6", name: "server-lobby", type: 0, guild_id: "g1" },
    dm1: { id: "dm1", name: "", type: 1, guild_id: null, recipients: ["u1"] },
    grp1: { id: "grp1", name: "squad", type: 3, guild_id: null, recipients: ["u1", "u2"] },
};

export const GuildStore = {
    getGuilds: () => GUILDS,
    getGuild: (id) => GUILDS[id],
};
// Toggles to simulate clients where ChannelStore.getAll is absent/partial:
// gatherChannelCandidates must then fall back to (and union) per-guild stores.
export const storeShape = { useGetAll: true, useGetChannelIds: true, partialGetAll: false };
export const ChannelStore = {
    getAll: () => {
        if (!storeShape.useGetAll) return undefined;
        // Partial cache: only DMs loaded. Guild channels must still arrive
        // via getChannelIds/per-guild union (channels-not-shown regression).
        if (storeShape.partialGetAll) return { dm1: CHANNELS.dm1, grp1: CHANNELS.grp1 };
        return { ...CHANNELS };
    },
    getChannelIds: (gid) => {
        if (!storeShape.useGetChannelIds) return undefined;
        const all = Object.values(CHANNELS);
        if (gid) return all.filter((c) => c.guild_id === gid).map((c) => c.id);
        return all.map((c) => c.id);
    },
    getChannel: (id) => CHANNELS[id],
    getAllThreadsForGuild: (gid) => (gid === "g1" ? [CHANNELS.c4] : []),
    getSortedPrivateChannels: () => [CHANNELS.dm1, CHANNELS.grp1],
};
const g1ChannelGroups = () => ({
    SELECTABLE: [
        { channel: CHANNELS.c1, comparator: 1 },
        { channel: CHANNELS.c2, comparator: 2 },
        { channel: CHANNELS.c5, comparator: 4 },
        { channel: CHANNELS.c6, comparator: 5 },
    ],
    VOCAL: [{ channel: CHANNELS.c3, comparator: 3 }],
    count: 5,
    id: "g1",
});
export const GuildChannelStore = {
    // Real shape: comparator-wrapper lists, not raw channels.
    // Note: c4 (thread) is deliberately absent here so the test proves
    // threads arrive via the getAllThreadsForGuild branch instead.
    getChannels: (gid) => (gid === "g1" ? g1ChannelGroups() : { SELECTABLE: [], VOCAL: [] }),
    getAllGuilds: () => ({ g1: g1ChannelGroups() }),
};
export const RelationshipStore = {
    isFriend: (id) => FRIENDS.has(id),
    isBlocked: (id) => BLOCKED.has(id),
    getFriendIDs: () => [...FRIENDS],
};
export const UserStore = {
    getUser: (id) => USERS[id] ?? null,
};
export const SelectedGuildStore = {
    getGuildId: () => "g1",
};
export const __muted = { guilds: new Set(), channels: new Map() };
export const UserGuildSettingsStore = {
    isMuted: (gid) => __muted.guilds.has(gid),
    isChannelMuted: (gid, cid) => __muted.channels.get(`${gid}:${cid}`) ?? false,
};
export const __unread = { channels: new Set(), guilds: new Set() };
export const ReadStateStore = {
    hasUnread: (cid) => __unread.channels.has(cid),
};
export const GuildReadStateStore = {
    hasUnread: (gid) => __unread.guilds.has(gid),
    hasAnyUnread: (gid) => (gid ? __unread.guilds.has(gid) : __unread.guilds.size > 0),
};
export const ChannelRouter = {
    transitionToChannel: (id) => {
        spies.transitionToChannel.push(id);
    },
};
export const NavigationRouter = {
    transitionToGuild: (id) => {
        spies.transitionToGuild.push(id);
    },
};
export const ChannelActionCreators = {
    openPrivateChannel: (id) => {
        spies.openPrivateChannel.push(id);
    },
};

// In real browsers (workspace harness) act() without an act environment
// distorts scheduling, so skip it there for production-faithful async
// behavior. Under jsdom (e2e) act() stays on for synchronous assertions.
const maybeAct = (fn) => {
    if (typeof globalThis !== "undefined" && globalThis.__qsNoAct) return fn();
    return act(fn);
};

// openModal renders into the document for real.
let root = null;
let container = null;
export function openModal(render, options) {
    try {
        globalThis.__qsLastOpenOptions = options ?? null;
    } catch { /* ignore */ }
    container = document.createElement("div");
    document.body.appendChild(container);
    root = ReactDOMClient.createRoot(container);
    maybeAct(() => {
        root.render(render({ onClose: () => closeModal("k") }));
    });
    return "k";
}
export function closeModal(_key) {
    // Every step is logged: a silent no-op here is indistinguishable from a
    // slow host otherwise, and silence is what we are debugging.
    const log = [];
    const pushLog = (s) => {
        log.push(s);
        try {
            globalThis.__qsCloseLog = (globalThis.__qsCloseLog || []).concat([s]);
        } catch { /* ignore */ }
    };
    try {
        pushLog("closeModal:enter root=" + !!root);
        if (root) {
            try {
                root.unmount();
                pushLog("closeModal:unmounted");
            } catch (e) {
                pushLog("closeModal:unmount-THREW:" + String((e && e.message) || e).slice(0, 160));
            }
            root = null;
        }
        pushLog("closeModal:container-attached=" + !!(container && container.parentNode));
        if (container && container.parentNode) {
            container.parentNode.removeChild(container);
            pushLog("closeModal:removed");
        }
        container = null;
    } catch (e) {
        pushLog("closeModal:outer-THREW:" + String((e && e.message) || e).slice(0, 160));
    }
}
export function __qsMockState() {
    let inDoc = false;
    try {
        inDoc = !!container && !!container.parentNode && document.contains(container);
    } catch { /* ignore */ }
    return { hasRoot: !!root, inDoc };
}

export {
    React,
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useReducer,
    useRef,
    useState,
};
