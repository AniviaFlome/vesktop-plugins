/*
 * QuickFind — node test harness (no deps).
 * Run: nix-shell -p nodejs --run "node run_tests.mjs"
 */
import {
    buildIndex,
    fuzzyScore,
    KIND_ORDER_PRESETS,
    kindBoostFor,
    kindOf,
    kindRankOf,
    normalizeString,
    parseQueryPrefix,
    prefixScore,
    rankAndFilter,
    substringScore,
    DEFAULT_SEARCH_OPTIONS,
} from "./search.ts";
import { applyFilters, DEFAULT_FILTERS } from "./filters.ts";
import { dedupeUserRows } from "./filters.ts";
import { asChannelArray, channelTypeToItem, gatherChannelCandidates, isArchivedChannel, resolveGuildId } from "./channelSources.ts";
import { __resetForTests, attachRecents, clearRecents, loadRecents, recordOpen, sanitizeRecentMap } from "./recents.ts";

let passed = 0;
let failed = 0;

function ok(cond, name, extra = "") {
    if (cond) {
        passed++;
        console.log(`ok - ${name}`);
    } else {
        failed++;
        console.log(`FAIL - ${name} ${extra}`);
    }
}

function eq(a, b, name) {
    ok(a === b, name, `expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`);
}

// --- normalize ---
eq(normalizeString("Héllo  WORLD"), "hello world", "normalize strips accents + lowercases");
eq(normalizeString("🎮general", false), "general", "normalize strips leading emoji");
eq(normalizeString("ABC", true), "ABC", "caseSensitive keeps case");
eq(normalizeString("ABC", false), "abc", "case-insensitive lowercases");

// --- prefix parse ---
ok(parseQueryPrefix("#gen").scope === "channels", "parse # scope");
ok(parseQueryPrefix("@bob").scope === "users", "parse @ scope");
ok(parseQueryPrefix("*srv").scope === "servers", "parse * scope");
eq(parseQueryPrefix("#gen").clean, "gen", "parse # clean");
eq(parseQueryPrefix("c:gen").clean, "gen", "parse c: clean");
eq(parseQueryPrefix("plain").clean, "plain", "parse plain");
ok(parseQueryPrefix("plain").scope === "all", "parse plain scope");

// --- scorers ---
ok(fuzzyScore("gnr", "general", 0.4) > 0, "fuzzy gnr matches general");
ok(fuzzyScore("xyz", "general", 0.4) === -1, "fuzzy xyz rejects general");
ok(fuzzyScore("", "general", 0.4) === 0, "fuzzy empty query scores 0");
ok(substringScore("gen", "general") > 0, "substring hit");
ok(substringScore("xyz", "general") === -1, "substring miss");
ok(prefixScore("gen", "general") > 0, "prefix hit");
ok(prefixScore("ner", "general") === -1, "prefix miss");
ok(fuzzyScore("general", "general", 0.9) > fuzzyScore("gnr", "general", 0.4), "exact beats fuzzy fragments");

// sensitivity: strict rejects gappy matches
const loose = fuzzyScore("gzzzzz", "general-chat-lounge", 0.1);
const strict = fuzzyScore("gzzzzz", "general-chat-lounge", 0.95);
ok(strict === -1 || strict <= loose, "strict sensitivity <= loose");

// --- rankAndFilter ---
const items = buildIndex([
    { id: "1", name: "general", type: "text", guildId: "g1" },
    { id: "2", name: "gaming", type: "text", guildId: "g1" },
    { id: "3", name: "My Server", type: "guild", guildId: "g2" },
    { id: "4", name: "Bob", type: "dm", isFriend: true },
    { id: "5", name: "Spammer", type: "dm", isFriend: false, isBlocked: true },
], false, true);

let r = rankAndFilter(items, "gen", { ...DEFAULT_SEARCH_OPTIONS, maxResults: 10 });
ok(r.length >= 1 && r[0].name === "general", "rank gen -> general first");

r = rankAndFilter(items, "#gen", { ...DEFAULT_SEARCH_OPTIONS, maxResults: 10 });
ok(r.every(i => i.type === "text"), "# scope only channels");

r = rankAndFilter(items, "*my", { ...DEFAULT_SEARCH_OPTIONS, maxResults: 10 });
ok(r.length === 1 && r[0].type === "guild", "* scope only servers");

r = rankAndFilter(items, "", { ...DEFAULT_SEARCH_OPTIONS, maxResults: 2 });
ok(r.length === 2, "maxResults slices");

// current guild boost
r = rankAndFilter(
    buildIndex([
        { id: "a", name: "general", type: "text", guildId: "g1" },
        { id: "b", name: "general", type: "text", guildId: "g2" },
    ], false, true),
    "general",
    { ...DEFAULT_SEARCH_OPTIONS, currentGuildId: "g2", currentGuildBoost: 500 },
);
ok(r[0].guildId === "g2", "current guild boost wins ties");

// --- filters ---
let f = applyFilters(items, { ...DEFAULT_FILTERS, serversOnly: true });
ok(f.length === 1 && f[0].type === "guild", "serversOnly hides non-servers");

f = applyFilters(items, { ...DEFAULT_FILTERS, friendsOnly: true });
ok(f.filter(i => i.type === "dm").every(i => i.isFriend), "friendsOnly keeps friends");
ok(f.some(i => i.type === "guild"), "friendsOnly keeps servers");

f = applyFilters(items, { ...DEFAULT_FILTERS, hideBlocked: true });
ok(!f.some(i => i.name === "Spammer"), "hideBlocked removes blocked");

f = applyFilters(items, { ...DEFAULT_FILTERS, showServers: false });
ok(!f.some(i => i.type === "guild"), "showServers false hides guilds");

// --- dedupe: DM + friend-user for the same person collapses to the DM row ---
const dupes = [
    { id: "dm9", name: "Bob", type: "dm", guildId: null, isFriend: true, dmRecipientId: "u1" },
    { id: "u1", name: "Bob", type: "user", guildId: null, isFriend: true },
    { id: "u2", name: "Alice", type: "user", guildId: null, isFriend: true },
    { id: "g1", name: "general", type: "guild", guildId: "g1" },
    { id: "g2", name: "general", type: "guild", guildId: "g1" },
];
const dd = dedupeUserRows(dupes);
ok(dd.some(i => i.id === "dm9"), "dedupe keeps the DM row");
ok(!dd.some(i => i.id === "u1"), "dedupe drops redundant friend-user row");
ok(dd.some(i => i.id === "u2"), "dedupe keeps friends without a DM");
ok(dd.filter(i => i.name === "general").length === 2, "dedupe keeps same-name channels in one guild (different ids are different rows)");
{
    // Same display name, different people: both stay.
    const people = [
        { id: "a1", name: "Sam", type: "user", guildId: null, isFriend: true },
        { id: "a2", name: "Sam", type: "user", guildId: null, isFriend: true },
    ];
    ok(dedupeUserRows(people).length === 2, "dedupe keeps same-name users with different ids");
    // Exact same row twice collapses to one.
    const twice = [
        { id: "c1", name: "general", type: "text", guildId: "g1" },
        { id: "c1", name: "general", type: "text", guildId: "g1" },
    ];
    ok(dedupeUserRows(twice).length === 1, "dedupe drops exact same-type+id doubles");
}

// --- recents ---
__resetForTests();
clearRecents();
recordOpen("1");
recordOpen("1");
recordOpen("2");
const map = loadRecents();
ok(map["1"].count === 2, "recents count accumulates");
const withRec = attachRecents([
    { id: "1", name: "general", type: "text" },
    { id: "9", name: "other", type: "text" },
]);
ok(withRec[0].useCount === 2, "attachRecents fills useCount");
r = rankAndFilter(
    buildIndex(withRec, false, true),
    "",
    { ...DEFAULT_SEARCH_OPTIONS, sortBy: "recent", maxResults: 10 },
);
ok(r[0].id === "1" || r[0].id === "2", "recent sort puts opened first");

// --- corrupted persisted recents sanitize instead of poisoning state ---
{
    eq(Object.keys(sanitizeRecentMap('"just a string"')).length, 0, "sanitize rejects string payload");
    eq(Object.keys(sanitizeRecentMap(123)).length, 0, "sanitize rejects number payload");
    eq(Object.keys(sanitizeRecentMap(null)).length, 0, "sanitize rejects null payload");
    eq(Object.keys(sanitizeRecentMap(["a", "b"])).length, 0, "sanitize rejects array payload");
    const mixed = sanitizeRecentMap({
        good: { count: 3, lastAt: 100 },
        badCount: { count: "3", lastAt: 100 },
        badAt: { count: 1, lastAt: "now" },
        negative: { count: -1, lastAt: 5 },
        notObj: "nope",
        nestedArr: [1, 2],
    });
    ok(Object.keys(mixed).length === 1 && mixed.good.count === 3, "sanitize keeps only well-formed entries");
    // recordOpen ignores empty ids instead of creating junk keys.
    __resetForTests();
    clearRecents();
    recordOpen("");
    ok(Object.keys(loadRecents()).length === 0, "recordOpen ignores empty id");
    // attachRecents treats malformed entries as a miss (clears, never throws).
    const stale = attachRecents([{ id: "x", name: "x", type: "text", lastOpenedAt: 5, useCount: 9 }]);
    ok(stale[0].useCount === undefined && stale[0].lastOpenedAt === undefined, "attachRecents clears stale recency on miss");
}

// --- performance: 5000 items must filter fast ---
const big = [];
for (let i = 0; i < 5000; i++) {
    big.push({ id: String(i), name: `channel-${i}-general-chat-${i % 100}`, type: i % 10 === 0 ? "guild" : "text", guildId: "g1" });
}
buildIndex(big, false, true);
const t0 = Date.now();
const out = rankAndFilter(big, "ch42", { ...DEFAULT_SEARCH_OPTIONS, maxResults: 30 });
const dt = Date.now() - t0;
ok(out.length <= 30, "perf respects maxResults");
ok(dt < 200, `perf 5000 items <200ms (took ${dt}ms)`);
console.log(`perf: 5000 items query took ${dt}ms -> ${out.length} results`);

// substring mode is the fast path
const t1 = Date.now();
rankAndFilter(big, "channel-42", { ...DEFAULT_SEARCH_OPTIONS, mode: "substring", fuzzyEnabled: false, maxResults: 30 });
const dt2 = Date.now() - t1;
ok(dt2 < 200, `perf substring <200ms (took ${dt2}ms)`);

// --- empty-query ranking: kinds interleave instead of insertion order ---
{
    eq(kindOf("guild"), "guild", "kindOf guild");
    eq(kindOf("text"), "channel", "kindOf text");
    eq(kindOf("voice"), "channel", "kindOf voice");
    eq(kindOf("thread"), "channel", "kindOf thread");
    eq(kindOf("dm"), "dm", "kindOf dm");
    eq(kindOf("group"), "dm", "kindOf group");
    eq(kindOf("user"), "user", "kindOf user");

    const crowd = buildIndex([
        ...[0, 1, 2, 3, 4].map(i => ({ id: `g${i}`, name: `Guild ${i}`, type: "guild", guildId: `g${i}` })),
        ...[0, 1, 2].map(i => ({ id: `c${i}`, name: `chan-${i}`, type: "text", guildId: "g0" })),
        { id: "d1", name: "DM Guy", type: "dm", guildId: null },
    ], false, true);
    const mixed = rankAndFilter(crowd, "", { ...DEFAULT_SEARCH_OPTIONS, maxResults: 4 });
    ok(mixed.length === 4, "empty query respects maxResults", `got ${mixed.length}`);
    ok(mixed.some(i => i.type === "guild"), "empty query still shows guilds");
    ok(mixed.some(i => i.type === "text"), "empty query mixes in channels despite guild majority (no crowd-out)");

    // unread floats above the zero-mass on empty query
    const withUnread = buildIndex([
        { id: "g0", name: "Guild 0", type: "guild", guildId: "g0" },
        { id: "c0", name: "chan-0", type: "text", guildId: "g0", unread: true },
        { id: "c1", name: "chan-1", type: "text", guildId: "g0" },
    ], false, true);
    const uw = rankAndFilter(withUnread, "", { ...DEFAULT_SEARCH_OPTIONS, maxResults: 10 });
    ok(uw[0].id === "c0", "unread floats first on empty query", `first=${uw[0] && uw[0].id}`);

    // recent/frequent floats on empty query (documented recentBoost behavior)
    const withRecent = buildIndex([
        { id: "g0", name: "Guild 0", type: "guild", guildId: "g0" },
        { id: "c0", name: "chan-0", type: "text", guildId: "g0", useCount: 12, lastOpenedAt: Date.now() },
    ], false, true);
    const rw = rankAndFilter(withRecent, "", { ...DEFAULT_SEARCH_OPTIONS, maxResults: 10 });
    ok(rw[0].id === "c0", "recent item floats first on empty query", `first=${rw[0] && rw[0].id}`);

    // current-guild boost applies on empty query too
    const cg = buildIndex([
        { id: "cA", name: "aaa", type: "text", guildId: "gX" },
        { id: "cB", name: "bbb", type: "text", guildId: "gY" },
    ], false, true);
    const cgr = rankAndFilter(cg, "", { ...DEFAULT_SEARCH_OPTIONS, maxResults: 10, currentGuildId: "gY" });
    ok(cgr[0].id === "cB", "current-guild boost applies on empty query", `first=${cgr[0] && cgr[0].id}`);

    // non-empty relevance ordering unchanged (best match first)
    const nq = rankAndFilter(crowd, "chan-1", { ...DEFAULT_SEARCH_OPTIONS, maxResults: 10 });
    ok(nq.length >= 1 && nq[0].id === "c1", "non-empty query still ranks best match first");
}

// Large-scale crowd-out regression test (mirrors a real 210-item client):
// 150 guilds collected before 40 channels must NOT hide all channels
// from an empty query truncated at the default maxResults.
{
    const many = [];
    for (let i = 0; i < 150; i++) many.push({ id: `g${i}`, name: `Guild ${i}`, type: "guild", guildId: `g${i}` });
    for (let i = 0; i < 40; i++) many.push({ id: `c${i}`, name: `chan-${i}`, type: "text", guildId: "g0" });
    for (let i = 0; i < 10; i++) many.push({ id: `u${i}`, name: `User ${i}`, type: "dm", guildId: null, isFriend: true });
    for (let i = 0; i < 10; i++) many.push({ id: `p${i}`, name: `Person ${i}`, type: "user", guildId: null, isFriend: true });
    buildIndex(many, false, true);
    const top = rankAndFilter(many, "", { ...DEFAULT_SEARCH_OPTIONS, maxResults: 30 });
    eq(top.length, 30, "large list respects maxResults");
    const kinds = new Set(top.map(i => kindOf(i.type)));
    ok(kinds.has("guild"), "large empty query still shows guilds", [...kinds].join(","));
    ok(kinds.has("channel"), "large empty query shows channels despite 150 guilds", [...kinds].join(","));
    ok(kinds.has("dm") || kinds.has("user"), "large empty query shows people too", [...kinds].join(","));
}

// --- channelSources: tolerate every known store shape ---
const _ch1 = { id: "c1", name: "general", type: 0, guild_id: "g1" };
const _ch2 = { id: "c2", name: "Voice", type: 2, guild_id: "g1" };
eq(asChannelArray([_ch1]).length, 1, "asChannelArray passes arrays through");
eq(asChannelArray({ c1: _ch1, c2: _ch2 }).length, 2, "asChannelArray flattens plain records");
eq(asChannelArray(new Map([["c1", _ch1]])).length, 1, "asChannelArray flattens Maps");
{
    const wrapped = {
        SELECTABLE: [{ channel: _ch1, comparator: 1 }],
        VOCAL: [{ channel: _ch2, comparator: 2 }],
        count: 2,
        id: "g1",
    };
    const flat = asChannelArray(wrapped);
    ok(flat.length === 2 && flat[0] === _ch1 && flat[1] === _ch2, "asChannelArray unwraps SELECTABLE/VOCAL comparator wrappers");
}
eq(asChannelArray(null).length, 0, "asChannelArray handles null");
eq(asChannelArray(42).length, 0, "asChannelArray handles junk");

const _guilds = { g1: { id: "g1", name: "G1" }, g2: { id: "g2", name: "G2" } };
{
    // primary path: getAll record
    const got = gatherChannelCandidates({ getAll: () => ({ c1: _ch1 }) }, { getGuilds: () => _guilds }, null);
    ok(got.length === 1 && got[0] === _ch1, "gather prefers ChannelStore.getAll");
}
{
    // getAll returns a Map
    const got = gatherChannelCandidates({ getAll: () => new Map([["c1", _ch1]]) }, { getGuilds: () => _guilds }, null);
    ok(got.length === 1, "gather handles getAll Map");
}
{
    // no getAll: per-guild GuildChannelStore wrappers + threads
    const cs = {
        getAllThreadsForGuild: (gid) => gid === "g1" ? [{ id: "t1", name: "Thread", type: 11, guild_id: "g1" }] : [],
    };
    const gcs = {
        getChannels: (gid) => gid === "g1"
            ? { SELECTABLE: [{ channel: _ch1, comparator: 1 }], VOCAL: [{ channel: _ch2, comparator: 2 }] }
            : { SELECTABLE: [], VOCAL: [] },
    };
    const got = gatherChannelCandidates(cs, { getGuilds: () => _guilds }, gcs);
    ok(got.length === 3, `gather falls back to per-guild stores (got ${got.length})`);
    ok(got.some((c) => c.id === "t1"), "gather includes threads from getAllThreadsForGuild");
}
{
    // getAll throws -> fallback still works (mock is per-guild like the real store)
    const cs = { getAll: () => { throw new Error("boom"); } };
    const gcs = { getChannels: (gid) => gid === "g1" ? ({ SELECTABLE: [{ channel: _ch1, comparator: 0 }], VOCAL: [] }) : ({ SELECTABLE: [], VOCAL: [] }) };
    const got = gatherChannelCandidates(cs, { getGuilds: () => _guilds }, gcs);
    ok(got.length === 1 && got[0] === _ch1, "gather survives throwing getAll");
}
{
    // missing guild_id gets stamped from the per-guild loop
    const cs = {};
    const gcs = { getChannels: (gid) => ({ SELECTABLE: [{ channel: { id: "x1", name: "NoGuild", type: 0 }, comparator: 0 }], VOCAL: [] }) };
    const got = gatherChannelCandidates(cs, { getGuilds: () => ({ g9: { id: "g9" } }) }, gcs);
    ok(got.length === 1 && got[0].guild_id === "g9", "gather stamps missing guild_id from loop guild");
}
{
    // nothing available -> empty, never throws
    const got = gatherChannelCandidates({}, {}, null);
    ok(Array.isArray(got) && got.length === 0, "gather returns [] when no store APIs exist");
}
{
    // getChannelIds + getChannel middle path
    const cs = {
        getChannelIds: () => ["c1", "c2", "missing"],
        getChannel: (id) => id === "missing" ? undefined : { c1: _ch1, c2: _ch2 }[id],
    };
    const got = gatherChannelCandidates(cs, { getGuilds: () => _guilds }, null);
    ok(got.length === 2, "gather uses getChannelIds+getChannel when getAll absent");
}
{
    // REGRESSION (channels not shown): partial getAll (DMs only) must NOT
    // hide guild channels available via the per-guild stores — union them.
    const dmOnly = { dm1: { id: "dm1", name: "", type: 1, guild_id: null, recipients: ["u1"] } };
    const cs = {
        getAll: () => dmOnly,
        getChannelIds: () => ["dm1"],
        getChannel: (id) => dmOnly[id],
        getAllThreadsForGuild: (gid) => gid === "g1" ? [{ id: "t1", name: "Thread", type: 11, guild_id: "g1" }] : [],
    };
    const gcs = {
        getChannels: (gid) => gid === "g1"
            ? { SELECTABLE: [{ channel: _ch1, comparator: 1 }], VOCAL: [{ channel: _ch2, comparator: 2 }] }
            : { SELECTABLE: [], VOCAL: [] },
    };
    const got = gatherChannelCandidates(cs, { getGuilds: () => _guilds }, gcs);
    ok(got.some((c) => c.id === "dm1"), "union keeps partial-getAll DMs");
    ok(got.some((c) => c.id === "c1"), "union adds per-guild channels despite partial getAll");
    ok(got.some((c) => c.id === "t1"), "union adds threads despite partial getAll");
    eq(new Set(got.map((c) => c.id)).size, got.length, "union dedupes by id");
}
{
    // Bulk getAllGuilds snapshot is consumed (single call, stamped per guild).
    const cs = {};
    const gcs = {
        getAllGuilds: () => ({
            g1: { SELECTABLE: [{ channel: _ch1, comparator: 1 }], VOCAL: [] },
            g2: { SELECTABLE: [{ channel: _ch2, comparator: 2 }], VOCAL: [] },
        }),
    };
    const got = gatherChannelCandidates(cs, { getGuilds: () => _guilds }, gcs);
    ok(got.length === 2, "gather consumes GuildChannelStore.getAllGuilds");
}
{
    // Per-guild getChannelIds(gid) + getChannel path.
    const cs = {
        getChannelIds: (gid) => gid === "g1" ? ["c1"] : [],
        getChannel: (id) => id === "c1" ? _ch1 : undefined,
    };
    const got = gatherChannelCandidates(cs, { getGuilds: () => _guilds }, null);
    ok(got.length === 1 && got[0].id === "c1", "gather uses per-guild getChannelIds(gid)");
}
{
    // asChannelArray unwraps arrays / records / single wrappers of wrappers.
    const wrapped = [{ channel: _ch1, comparator: 1 }, { channel: _ch2, comparator: 2 }];
    const flat = asChannelArray(wrapped);
    ok(flat.length === 2 && flat[0] === _ch1, "asChannelArray unwraps array-of-wrappers (getSelectableChannels shape)");
    const single = asChannelArray({ channel: _ch1, comparator: 1 });
    ok(single.length === 1 && single[0] === _ch1, "asChannelArray unwraps a single wrapper");
    const recWrap = asChannelArray({ a: { channel: _ch1, comparator: 1 } });
    ok(recWrap.length === 1 && recWrap[0] === _ch1, "asChannelArray unwraps record-of-wrappers");
    const mapWrap = asChannelArray(new Map([["a", { channel: _ch1, comparator: 1 }]]));
    ok(mapWrap.length === 1 && mapWrap[0] === _ch1, "asChannelArray unwraps Map-of-wrappers");
}
{
    // channelTypeToItem: media is text, categories drop, unknown guild stays text.
    eq(channelTypeToItem({ type: 16, guild_id: "g1" }), "text", "type 16 GUILD_MEDIA maps to text");
    eq(channelTypeToItem({ type: 0, guild_id: "g1" }), "text", "type 0 maps to text");
    eq(channelTypeToItem({ type: 2, guild_id: "g1" }), "voice", "type 2 maps to voice");
    eq(channelTypeToItem({ type: 4, guild_id: "g1" }), null, "type 4 category drops");
    eq(channelTypeToItem({ type: 999, guild_id: "g1" }), "text", "unknown guild type stays text");
    eq(channelTypeToItem({ type: 999 }), null, "unknown without guild drops");
    eq(channelTypeToItem({ type: 999, getGuildId: () => "g1" }), "text", "unknown with getGuildId stays text");
}
{
    // resolveGuildId falls back to the Channel class getter (frozen records).
    eq(resolveGuildId({ guild_id: "g1" }), "g1", "resolveGuildId prefers raw guild_id");
    eq(resolveGuildId({ getGuildId: () => "g9" }), "g9", "resolveGuildId falls back to getGuildId()");
    const frozen = Object.freeze({ id: "x" });
    eq(resolveGuildId(frozen), null, "resolveGuildId returns null when absent");
}
{
    // isArchivedChannel covers every known shape.
    ok(isArchivedChannel({ isArchivedThread: () => true }), "archived via isArchivedThread()");
    ok(isArchivedChannel({ isArchived: () => true }), "archived via isArchived()");
    ok(isArchivedChannel({ threadMetadata: { archived: true } }), "archived via threadMetadata");
    ok(isArchivedChannel({ archived: true }), "archived via raw flag");
    ok(!isArchivedChannel({ archived: false }), "not archived when all shapes false");
}

{
    // NFKC folding: Discord's stylized names must match plain ASCII queries.
    eq(normalizeString("ｓｉｎｇｕ", false), "singu", "normalize folds fullwidth to ASCII");
    eq(normalizeString("\u{1D42C}\u{1D422}\u{1D427}\u{1D420}\u{1D42E}", false), "singu", "normalize folds math alphanumeric to ASCII");
    eq(normalizeString("ﬁnal", false), "final", "normalize folds ligatures");
    eq(normalizeString("Café Générale", false), "cafe generale", "normalize still strips diacritics");
    const styled = buildIndex([
        { id: "c1", name: "ｓｉｎｇｕｌａｒｉｔｙ", type: "text", guildId: "g1" },
        { id: "c2", name: "𝐬𝐢𝐧𝐠𝐮𝐮 room", type: "text", guildId: "g1" },
        { id: "c3", name: "unrelated", type: "text", guildId: "g1" },
    ], false, true);
    const sr = rankAndFilter(styled, "singu", { ...DEFAULT_SEARCH_OPTIONS, maxResults: 10 });
    ok(sr.length === 2, "ASCII query finds fullwidth + math-bold names", sr.map(i => i.name).join(" | "));
    const nr = rankAndFilter(styled, "gibber", { ...DEFAULT_SEARCH_OPTIONS, maxResults: 10 });
    ok(nr.length === 0, "non-matching query still returns nothing");
}

// --- kind priority: servers 1st, channels 2nd, ... ---
{
    eq(KIND_ORDER_PRESETS["servers-first"][0], "guild", "preset servers-first leads with guild");
    eq(KIND_ORDER_PRESETS["servers-first"][1], "channel", "preset servers-first has channel second");
    eq(KIND_ORDER_PRESETS["channels-first"][0], "channel", "preset channels-first leads with channel");
    eq(KIND_ORDER_PRESETS["people-first"][0], "dm", "preset people-first leads with dm");
    eq(kindBoostFor("guild", KIND_ORDER_PRESETS["servers-first"], 20), 60, "top kind gets 3 steps");
    eq(kindBoostFor("text", KIND_ORDER_PRESETS["servers-first"], 20), 40, "second kind gets 2 steps");
    eq(kindBoostFor("user", KIND_ORDER_PRESETS["servers-first"], 20), 0, "last kind gets 0");
    eq(kindBoostFor("text", null, 20), 0, "no order -> no boost");
    eq(kindBoostFor("guild", KIND_ORDER_PRESETS["servers-first"], 0), 0, "zero step -> no boost");
    eq(kindRankOf(KIND_ORDER_PRESETS["servers-first"], "guild"), 0, "rankOf guild first");
    eq(kindRankOf(KIND_ORDER_PRESETS["servers-first"], "user"), 3, "rankOf user last");

    // Tied relevance: priority decides, off keeps insertion order.
    const tie = buildIndex([
        { id: "c1", name: "revo", type: "text", guildId: "g1" },
        { id: "g1", name: "revo", type: "guild", guildId: "g1" },
    ], false, true);
    const r0 = rankAndFilter(tie, "revo", { ...DEFAULT_SEARCH_OPTIONS, maxResults: 10 });
    ok(r0[0].id === "c1", "tie without priority keeps insertion order");
    const r1 = rankAndFilter(tie, "revo", { ...DEFAULT_SEARCH_OPTIONS, maxResults: 10, kindOrder: KIND_ORDER_PRESETS["servers-first"], kindBoost: 20 });
    ok(r1[0].id === "g1", "servers-first lifts the server on tied relevance");
    const r2 = rankAndFilter(tie, "revo", { ...DEFAULT_SEARCH_OPTIONS, maxResults: 10, kindOrder: KIND_ORDER_PRESETS["channels-first"], kindBoost: 20 });
    ok(r2[0].id === "c1", "channels-first keeps the channel on top");

    // Empty query: preset order drives the round-robin interleave.
    const eq2 = buildIndex([
        { id: "c1", name: "chan", type: "text", guildId: "g1" },
        { id: "g1", name: "serv", type: "guild", guildId: "g1" },
        { id: "d1", name: "DM Guy", type: "dm", guildId: null },
    ], false, true);
    const e0 = rankAndFilter(eq2, "", { ...DEFAULT_SEARCH_OPTIONS, maxResults: 3 });
    ok(e0[0].type === "text", "empty query defaults to channels first");
    const e1 = rankAndFilter(eq2, "", { ...DEFAULT_SEARCH_OPTIONS, maxResults: 3, kindOrder: KIND_ORDER_PRESETS["servers-first"], kindBoost: 20 });
    ok(e1[0].type === "guild", "empty query with servers-first starts with a server", e1.map(i => i.type).join(","));
    const e2 = rankAndFilter(eq2, "", { ...DEFAULT_SEARCH_OPTIONS, maxResults: 3, kindOrder: KIND_ORDER_PRESETS["people-first"], kindBoost: 20 });
    ok(e2[0].type === "dm", "empty query with people-first starts with a DM");
}

// --- regression: servers-first is a hard tier (exact #lounge vs "The Lounge") ---
{
    const lounge = () => buildIndex([
        { id: "c1", name: "lounge", type: "text", guildId: "g1" },
        { id: "g9", name: "the lounge", type: "guild", guildId: "g9" },
    ], false, true);
    const sf20 = { ...DEFAULT_SEARCH_OPTIONS, maxResults: 10, kindOrder: KIND_ORDER_PRESETS["servers-first"], kindBoost: 20 };
    const sf60 = { ...DEFAULT_SEARCH_OPTIONS, maxResults: 10, kindOrder: KIND_ORDER_PRESETS["servers-first"], kindBoost: 60 };
    // fuzzy default: exact channel outscores the partial server on relevance alone,
    // but the tier must still put the server first.
    ok(rankAndFilter(lounge(), "lounge", sf20)[0].id === "g9", "servers-first beats exact-vs-partial fuzzy gap (boost 20)");
    ok(rankAndFilter(lounge(), "lounge", sf60)[0].id === "g9", "servers-first beats exact-vs-partial fuzzy gap (boost 60)");
    // substring gap (~140pts) dwarfs any soft boost: tiers must still hold.
    ok(rankAndFilter(lounge(), "lounge", { ...sf20, mode: "substring", fuzzyEnabled: false })[0].id === "g9", "servers-first holds in substring mode (boost 20)");
    ok(rankAndFilter(lounge(), "lounge", { ...sf60, mode: "substring", fuzzyEnabled: false })[0].id === "g9", "servers-first holds in substring mode (boost 60)");
    // cross-kind boosts (current guild / recency) order within a tier only.
    ok(rankAndFilter(lounge(), "lounge", { ...sf20, currentGuildId: "g1", currentGuildBoost: 500 })[0].id === "g9", "servers-first survives currentGuildBoost on the channel");
    const recentLounge = () => buildIndex([
        { id: "c1", name: "lounge", type: "text", guildId: "g1", useCount: 12, lastOpenedAt: Date.now() },
        { id: "g9", name: "the lounge", type: "guild", guildId: "g9" },
    ], false, true);
    ok(rankAndFilter(recentLounge(), "lounge", sf20)[0].id === "g9", "servers-first survives recentBoost on the channel");
    // off / zero boost keeps pure relevance (channel first here).
    ok(rankAndFilter(lounge(), "lounge", { ...DEFAULT_SEARCH_OPTIONS, maxResults: 10, mode: "substring", fuzzyEnabled: false })[0].id === "c1", "priority off keeps pure relevance (channel first)");
    ok(rankAndFilter(lounge(), "lounge", { ...sf20, kindOrder: null })[0].id === "c1", "null kindOrder keeps pure relevance");
    ok(rankAndFilter(lounge(), "lounge", { ...sf20, kindBoost: 0 })[0].id === "c1", "kindBoost 0 disables tiers (pure relevance)");
    // tiers group but relevance still orders WITHIN a tier.
    const twoServers = () => buildIndex([
        { id: "c1", name: "lounge", type: "text", guildId: "g1" },
        { id: "g8", name: "lounge club", type: "guild", guildId: "g8" },
        { id: "g9", name: "the lounge", type: "guild", guildId: "g9" },
    ], false, true);
    const grouped = rankAndFilter(twoServers(), "lounge", sf20);
    ok(grouped[0].type === "guild" && grouped[1].type === "guild" && grouped[2].type === "text", "servers-first groups tiers, channels last", grouped.map(i => `${i.type}:${i.name}`).join(" | "));
    // channels-first mirrors: channel tier first even when the server matches well.
    ok(rankAndFilter(lounge(), "lounge", { ...DEFAULT_SEARCH_OPTIONS, maxResults: 10, kindOrder: KIND_ORDER_PRESETS["channels-first"], kindBoost: 20 })[0].id === "c1", "channels-first keeps channel on top for lounge");
    // alphabetical/recent also respect tiers on real queries.
    ok(rankAndFilter(lounge(), "lounge", { ...sf20, sortBy: "alphabetical" })[0].id === "g9", "servers-first holds under alphabetical sort");
    ok(rankAndFilter(recentLounge(), "lounge", { ...sf20, sortBy: "recent" })[0].id === "g9", "servers-first holds under recent sort");
}
// --- normalize memo: repeat indexing stays consistent across flags ---
{
    const a = buildIndex([{ id: "1", name: "Café Générale", type: "text" }], false, true);
    const b = buildIndex([{ id: "1", name: "Café Générale", type: "text" }], false, true);
    eq(a[0].normalized, "cafe generale", "memo returns correct normalization");
    eq(b[0].normalized, a[0].normalized, "repeat buildIndex hits memo consistently");
    const c = buildIndex([{ id: "1", name: "ABC", type: "text" }], true, true);
    eq(c[0].normalized, "ABC", "caseSensitive memo key keeps case");
    const d = buildIndex([{ id: "1", name: "ABC", type: "text" }], false, true);
    eq(d[0].normalized, "abc", "insensitive memo key lowercases");
}

// --- regression: clearRecents must clear stale boosts on cached arrays ---
{
    __resetForTests();
    clearRecents();
    recordOpen("k1");
    const arr = attachRecents([{ id: "k1", name: "keep", type: "text" }]);
    ok(arr[0].useCount === 1, "attachRecents sets useCount on hit");
    clearRecents();
    const arr2 = attachRecents(arr);
    ok(arr2[0].useCount === undefined && arr2[0].lastOpenedAt === undefined, "attachRecents clears stale recency after clearRecents");
}

// --- regression: fuzzy never matches a longer query than target ---
{
    ok(fuzzyScore("generalx", "general", 0.1) === -1, "fuzzy rejects longer query than target");
}

// --- regression: maxResults clamps to >= 1 ---
{
    const few = buildIndex([{ id: "1", name: "a", type: "text" }], false, true);
    const r0 = rankAndFilter(few, "", { ...DEFAULT_SEARCH_OPTIONS, maxResults: 0 });
    ok(r0.length === 1, "maxResults 0 clamps to 1");
    const rNeg = rankAndFilter(few, "", { ...DEFAULT_SEARCH_OPTIONS, maxResults: -5 });
    ok(rNeg.length === 1, "negative maxResults clamps to 1");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
