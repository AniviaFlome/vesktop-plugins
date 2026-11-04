// STRICT mock: mirrors Vencord, where React + hooks are undefined at module
// import time and only assigned later (waitFor on the React module).
// Any plugin code touching React.* during module evaluation throws here,
// exactly like production. Call globalThis.__qsMockReady() to assign.
import * as ReactDOMClient from "react-dom/client";
import { spies } from "./state.js";

export let React;
export let act;
export let useCallback;
export let useEffect;
export let useLayoutEffect;
export let useMemo;
export let useReducer;
export let useRef;
export let useState;

globalThis.__qsMockReady = () => {
    const R = require("react");
    React = R;
    act = R.act;
    ({ useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } = R);
};

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
    dm1: { id: "dm1", name: "", type: 1, guild_id: null, recipients: ["u1"] },
    grp1: { id: "grp1", name: "squad", type: 3, guild_id: null, recipients: ["u1", "u2"] },
};

export const GuildStore = {
    getGuilds: () => GUILDS,
    getGuild: (id) => GUILDS[id],
};
export const ChannelStore = {
    getAll: () => ({ ...CHANNELS }),
    getChannel: (id) => CHANNELS[id],
    getAllThreadsForGuild: (gid) => (gid === "g1" ? [CHANNELS.c4] : []),
    getSortedPrivateChannels: () => [CHANNELS.dm1, CHANNELS.grp1],
};
export const GuildChannelStore = {
    getChannels: (gid) => (gid === "g1"
        ? {
            SELECTABLE: [
                { channel: CHANNELS.c1, comparator: 1 },
                { channel: CHANNELS.c2, comparator: 2 },
            ],
            VOCAL: [{ channel: CHANNELS.c3, comparator: 3 }],
            count: 3,
            id: "g1",
        }
        : { SELECTABLE: [], VOCAL: [] }),
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
export const __lastSelected = { channels: new Map([["g1", "c2"]]) };
export const SelectedChannelStore = {
    getChannelId: (gid) => (gid ? __lastSelected.channels.get(gid) : undefined),
    getCurrentlySelectedChannelId: (gid) => (gid ? __lastSelected.channels.get(gid) : undefined),
    getLastSelectedChannelId: (gid) => (gid ? __lastSelected.channels.get(gid) : undefined),
    getMostRecentSelectedTextChannelId: (gid) => (gid ? __lastSelected.channels.get(gid) : undefined),
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

// openModal renders into the jsdom document for real.
let root = null;
let container = null;
export function openModal(render) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = ReactDOMClient.createRoot(container);
    act(() => {
        root.render(render({ onClose: () => closeModal("k") }));
    });
    return "k";
}
export function closeModal(_key) {
    if (root) {
        act(() => {
            root.unmount();
        });
        root = null;
    }
    if (container?.parentNode) container.parentNode.removeChild(container);
    container = null;
}
