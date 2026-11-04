/* Headless e2e for QuickFind.
 * Runs the REAL plugin component (bundled from ../index.tsx) inside jsdom
 * with mocked Discord stores. No network, no Discord login.
 * Run: npm run e2e   (after npm install)
 */
"use strict";
process.env.IS_REACT_ACT_ENVIRONMENT = "true";
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { JSDOM } = require("jsdom");

const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", { url: "https://discord.com/" });
global.window = dom.window;
global.document = dom.window.document;
Object.defineProperty(global, "navigator", { value: dom.window.navigator, configurable: true });
global.HTMLElement = dom.window.HTMLElement;
global.KeyboardEvent = dom.window.KeyboardEvent;
global.MouseEvent = dom.window.MouseEvent;
global.Event = dom.window.Event;
global.requestAnimationFrame = (cb) => setTimeout(cb, 0);

// Record scrollIntoView calls (jsdom has no layout).
const scrollCalls = [];
global.window.HTMLElement.prototype.scrollIntoView = function (opts) {
    scrollCalls.push(opts);
};

const { act } = require("react");
const { plugin, testApi } = require("./dist/bundle.cjs");

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function flush(ms = 20) {
    await act(async () => {
        await sleep(ms);
    });
}
async function key(target, type, init) {
    const e = new dom.window.KeyboardEvent(type, { bubbles: true, cancelable: true, ...init });
    await act(async () => {
        target.dispatchEvent(e);
    });
}
const listButtons = () => [...document.querySelectorAll(".qsplus-list button")];
const activeButton = () => listButtons().find((b) => (b.style.background || "").includes("accent-3"));
const tabButtons = () => [...document.querySelectorAll("button")].filter((b) => ["All", "* Servers", "# Channels", "@ Friends"].includes(b.textContent));

async function main() {
    testApi.settings.debounceMs = 0;
    testApi.settings.maxResults = 50;
    plugin.start();

    // 1. Ctrl+K opens the modal and focuses the input.
    await key(window, "keydown", { key: "k", ctrlKey: true });
    await flush();
    let input = document.querySelector("input.qsplus-input");
    ok(!!input, "ctrl+k opens modal with input");
    ok(document.activeElement === input, "input autofocused on open");

    // 2. Typing filters; best match first.
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set;
    act(() => {
        setter.call(input, "gen");
        input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    await flush();
    let rows = listButtons();
    ok(rows.length > 0 && rows[0].textContent.includes("general"), "typing filters, best match first", `first=${rows[0]?.textContent}`);

    // 2b. Fixed window: empty results leave blank space instead of resizing.
    act(() => {
        setter.call(input, "zzzzqx");
        input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    await flush();
    {
        const list = document.querySelector(".qsplus-list");
        ok(listButtons().length === 0, "gibberish matches nothing");
        ok(list && list.style.height === "320px", "results list keeps fixed height", list && list.style.height);
        ok(![...document.querySelectorAll(".qsplus-list div")].some((d) => (d.textContent || "").includes("No matches")), "no empty-state message, just blank space");
    }

    // 3. ArrowDown moves selection EXACTLY one row (regression: double handler).
    act(() => {
        setter.call(input, "");
        input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    await flush();
    rows = listButtons();
    ok(activeButton() === rows[0], "first row selected on empty query");
    await key(input, "keydown", { key: "ArrowDown" });
    rows = listButtons();
    ok(activeButton() === rows[1], "ArrowDown moves exactly one row", `active=${rows.indexOf(activeButton())}`);
    await key(input, "keydown", { key: "ArrowDown" });
    rows = listButtons();
    ok(activeButton() === rows[2], "second ArrowDown moves one more row");
    await key(input, "keydown", { key: "ArrowUp" });
    rows = listButtons();
    ok(activeButton() === rows[1], "ArrowUp moves back one row");

    // 4. Mouse-clicking tabs filters (regression: dead buttons).
    const tabs = tabButtons();
    ok(tabs.length === 4, "four tab buttons rendered");
    act(() => {
        tabs[1].click();
    });
    await flush();
    rows = listButtons();
    ok(rows.length === 20, "servers tab shows all 20 guilds", `got ${rows.length}`);
    const guildNames = rows.map((b) => b.textContent);
    ok(guildNames.some((t) => t.includes("Alpha Server")), "servers tab contains guilds");
    act(() => {
        tabs[2].click();
    });
    await flush();
    rows = listButtons();
    const channelTypes = new Set(rows.map((b) => b.dataset.type));
    ok(rows.length === 6 && ![...channelTypes].includes("guild"), "channels tab shows only channels", `got ${rows.length}: ${[...channelTypes].join(",")}`);
    // channels tab must NOT show guild rows
    const hasGuildRow = rows.some((b) => b.dataset.type === "guild");
    ok(!hasGuildRow, "channels tab hides guilds");
    act(() => {
        tabs[0].click();
    });
    await flush();

    // 4b. hideMuted actually filters (was a placebo: muted was hardcoded false).
    {
        const { __muted } = require("./dist/bundle.cjs");
        testApi.settings.hideMuted = true;
        __muted.guilds.add("g5");
        __muted.channels.set("g1:c2", true);
        await key(input, "keydown", { key: "Escape" });
        await flush();
        await key(window, "keydown", { key: "k", ctrlKey: true });
        await flush();
        const tabs2 = [...document.querySelectorAll("button")].filter((b) => ["All", "* Servers", "# Channels", "@ Friends"].includes(b.textContent));
        act(() => {
            tabs2[1].click();
        });
        await flush();
        let srows = listButtons();
        ok(srows.length === 19 && !srows.some((b) => b.textContent.includes("Server Number 5")), "muted guild hidden with hideMuted", `got ${srows.length}`);
        act(() => {
            tabs2[2].click();
        });
        await flush();
        let crows = listButtons();
        ok(crows.length === 5 && !crows.some((b) => b.textContent.includes("gaming")), "muted channel hidden with hideMuted", `got ${crows.length}`);
        testApi.settings.hideMuted = false;
        __muted.guilds.clear();
        __muted.channels.clear();
        await key(document.querySelector("input.qsplus-input"), "keydown", { key: "Escape" });
        await flush();
        await key(window, "keydown", { key: "k", ctrlKey: true });
        await flush();
        input = document.querySelector("input.qsplus-input");
    }

    // 5. Auto-scroll: arrow to bottom triggers scrollIntoView({block:"nearest"}).
    scrollCalls.length = 0;
    for (let i = 0; i < 30; i++) await key(input, "keydown", { key: "ArrowDown" });
    ok(scrollCalls.length > 0, "scrollIntoView called while navigating");
    ok(scrollCalls.every((o) => o && o.block === "nearest"), "scrollIntoView uses block:nearest");

    // 6. Enter navigates to the selected item and closes.
    await key(input, "keydown", { key: "Home" }); // unhandled key: no-op sanity
    for (let i = 0; i < 30; i++) await key(input, "keydown", { key: "ArrowUp" });
    rows = listButtons();
    ok(activeButton() === rows[0], "back at first row");
    testApi.resetSpies();
    await key(input, "keydown", { key: "Enter" });
    await flush();
    ok(
        testApi.spies.transitionToGuild.length === 1 || testApi.spies.transitionToChannel.length === 1,
        "Enter navigates",
        JSON.stringify(testApi.spies),
    );
    ok(!document.querySelector("input.qsplus-input"), "modal closed after Enter");

    // 7. Reopen works repeatedly (regression: dead ctrl+k after close).
    for (let i = 0; i < 3; i++) {
        await key(window, "keydown", { key: "k", ctrlKey: true });
        await flush();
        ok(!!document.querySelector("input.qsplus-input"), `reopen #${i + 1} works`);
        await key(document.querySelector("input.qsplus-input"), "keydown", { key: "Escape" });
        await flush();
        ok(!document.querySelector("input.qsplus-input"), `re-close #${i + 1} works`);
    }

    // 8. Ctrl+1..4 map to tabs in button order.
    await key(window, "keydown", { key: "k", ctrlKey: true });
    await flush();
    const inp2 = document.querySelector("input.qsplus-input");
    const activeTab = () => tabButtons().findIndex((b) => (b.style.background || "").includes("accent-3"));
    await key(inp2, "keydown", { key: "3", ctrlKey: true });
    ok(activeTab() === 2, "ctrl+3 selects 3rd tab (channels)", `activeTab=${activeTab()}`);
    await key(inp2, "keydown", { key: "4", ctrlKey: true });
    ok(activeTab() === 3, "ctrl+4 selects 4th tab (friends)", `activeTab=${activeTab()}`);
    await key(inp2, "keydown", { key: "1", ctrlKey: true });
    ok(activeTab() === 0, "ctrl+1 selects 1st tab (all)");
    await key(inp2, "keydown", { key: "2", ctrlKey: true });
    ok(activeTab() === 1, "ctrl+2 selects 2nd tab (servers)");
    await key(inp2, "keydown", { key: "Escape" });
    await flush();

    // 8b. Toggle: Ctrl+K closes an open modal, opens a closed one.
    await key(window, "keydown", { key: "k", ctrlKey: true });
    await flush();
    ok(!!document.querySelector("input.qsplus-input"), "toggle opens closed modal");
    await key(window, "keydown", { key: "k", ctrlKey: true });
    await flush();
    ok(!document.querySelector("input.qsplus-input"), "toggle closes open modal");
    await key(window, "keydown", { key: "k", ctrlKey: true });
    await flush();
    ok(!!document.querySelector("input.qsplus-input"), "toggle reopens modal");

    // 8c. Key-repeat must not toggle (holding Ctrl+K would flicker).
    const openCount = () => document.querySelectorAll('[data-testid="qsplus-overlay"]').length;
    await key(window, "keydown", { key: "k", ctrlKey: true, repeat: true });
    await flush();
    ok(openCount() === 1 && !!document.querySelector("input.qsplus-input"), "repeat Ctrl+K ignored while open");
    await key(document.querySelector("input.qsplus-input"), "keydown", { key: "Escape" });
    await flush();

    // 8d. Modal is vertically centered.
    await key(window, "keydown", { key: "k", ctrlKey: true });
    await flush();
    {
        const overlay = document.querySelector('[data-testid="qsplus-overlay"]');
        const cs = overlay.style;
        ok(cs.alignItems === "center" && !cs.paddingTop, "overlay centers modal vertically", `alignItems=${cs.alignItems} paddingTop=${cs.paddingTop}`);
    }

    // 8e. Home/End jump to first/last result.
    {
        const inp = document.querySelector("input.qsplus-input");
        const selOf = () => Number(document.querySelector('[data-testid="qsplus-overlay"]').dataset.sel);
        const n = Number(document.querySelector('[data-testid="qsplus-overlay"]').dataset.results);
        ok(n > 2, "enough rows for Home/End test", `n=${n}`);
        await key(inp, "keydown", { key: "End" });
        ok(selOf() === n - 1, "End selects last row", `sel=${selOf()}`);
        await key(inp, "keydown", { key: "Home" });
        ok(selOf() === 0, "Home selects first row");
    }

    // 8f. Escape closes immediately even with a query (no clear-first step:
    // that extra step is what made closing feel slow).
    {
        const inp = document.querySelector("input.qsplus-input");
        const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set;
        await act(async () => {
            setter.call(inp, "gen");
            inp.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
        });
        await flush();
        ok(inp.value === "gen", "query typed for Esc test");
        await key(inp, "keydown", { key: "Escape" });
        await flush();
        ok(!document.querySelector("input.qsplus-input"), "Esc closes modal immediately");
    }

    // 8f2. Group DMs render a stacked avatar cluster, not a placeholder glyph.
    await key(window, "keydown", { key: "k", ctrlKey: true });
    await flush();
    {
        const groupRow = [...document.querySelectorAll(".qsplus-list [data-type='group']")][0];
        ok(!!groupRow, "group DM row exists");
        const imgs = groupRow ? [...groupRow.querySelectorAll("img")] : [];
        ok(imgs.length >= 2, "group row stacks recipient avatars", `imgs=${imgs.length}`);
    }
    await key(document.querySelector("input.qsplus-input"), "keydown", { key: "Escape" });
    await flush();

    // 8g. ARIA roles for assistive tech.
    await key(window, "keydown", { key: "k", ctrlKey: true });
    await flush();
    {
        const list = document.querySelector(".qsplus-list");
        ok(list?.getAttribute("role") === "listbox", "results list has listbox role");
        const options = [...document.querySelectorAll('.qsplus-list [role="option"]')];
        ok(options.length > 0, "rows expose option role", `count=${options.length}`);
        ok(options.filter((o) => o.getAttribute("aria-selected") === "true").length === 1, "exactly one row aria-selected");
        const tabs = [...document.querySelectorAll("button")].filter((b) => ["All", "* Servers", "# Channels", "@ Friends"].includes(b.textContent));
        ok(tabs.some((b) => b.getAttribute("aria-pressed") === "true"), "active tab has aria-pressed");
        ok(document.querySelector("input.qsplus-input")?.getAttribute("role") === "combobox", "input has combobox role");

    // Build stamp lives in the probe dump now that the footer bar is gone.
    {
        const { BUILD_TAG } = require("./dist/bundle.cjs");
        ok(typeof BUILD_TAG === "string" && BUILD_TAG.length > 0, "BUILD_TAG exported", String(BUILD_TAG));
        const staleFooter = [...document.querySelectorAll("div")].find((d) => (d.textContent || "").includes("indexed"));
        ok(!staleFooter, "footer bar removed");
        ok(document.querySelector("input.qsplus-input")?.getAttribute("placeholder") === "Search servers, channels, friends…", "placeholder trimmed");
    }
    }
    await key(document.querySelector("input.qsplus-input"), "keydown", { key: "Escape" });
    await flush();

    // 9. Theme tokens: modal consumes midnight-discord vars with Discord fallbacks.
    await key(window, "keydown", { key: "k", ctrlKey: true });
    await flush();
    const box = document.querySelector("input.qsplus-input").parentElement;
    ok(box.style.background.includes("--bg-3") && box.style.background.includes("--background-floating"), "modal bg chains midnight -> discord tokens");
    const styleText = document.querySelector(".qsplus-list style")?.textContent ?? "";
    ok(styleText.includes("--text-5") && styleText.includes("--text-muted"), "placeholder/scrollbar chain midnight -> discord tokens");
    // Mouse hardening: explicit pointer-events down the tree so Discord's
    // modal layer can't leave us click-transparent. jsdom does no
    // hit-testing, so this only pins the inline styles; real proof is manual.
    {
        const overlay = document.querySelector('[data-testid="qsplus-overlay"]');
        ok(overlay && overlay.style.pointerEvents === "auto", "overlay re-enables pointer events");
        ok(box.style.pointerEvents === "auto", "modal box re-enables pointer events");
        const list = document.querySelector(".qsplus-list");
        ok(list && list.style.pointerEvents === "auto", "results list re-enables pointer events");
        const row = listButtons()[0];
        ok(row && row.style.pointerEvents === "auto", "rows re-enable pointer events");
    }
    await key(document.querySelector("input.qsplus-input"), "keydown", { key: "Escape" });
    await flush();

    // 10. Probe action degrades gracefully without the real store.
    testApi.resetSpies();
    plugin.toolboxActions["Dump QuickFind internals (console)"]();
    const probe = testApi.loggerCalls.map((c) => c[1]).join("\n");
    ok(probe.includes("[QuickFind probe]"), "probe logs header");
    ok(/not found|lookup failed/.test(probe), "probe reports missing store gracefully");

    // 11. No unexpected errors logged during the happy path.
    testApi.resetSpies();
    await key(window, "keydown", { key: "k", ctrlKey: true });
    await flush();
    await key(document.querySelector("input.qsplus-input"), "keydown", { key: "Escape" });
    await flush();
    const errors = testApi.loggerCalls.filter((c) => c[0] === "error");
    ok(errors.length === 0, "no errors logged on open/close", JSON.stringify(errors).slice(0, 300));

    // 12. Repeated toggle cycles never wedge, leak, or duplicate the modal.
    const overlayCount = () => document.querySelectorAll('[data-testid="qsplus-overlay"]').length;
    let maxOverlays = 0;
    for (let i = 0; i < 5; i++) {
        await key(window, "keydown", { key: "k", ctrlKey: true });
        await flush();
        maxOverlays = Math.max(maxOverlays, overlayCount());
        ok(!!document.querySelector("input.qsplus-input"), `toggle cycle ${i + 1}: opens`);
        await key(window, "keydown", { key: "k", ctrlKey: true });
        await flush();
        ok(!document.querySelector("input.qsplus-input"), `toggle cycle ${i + 1}: closes`);
    }
    ok(maxOverlays <= 1, "never more than one modal in the DOM", `max=${maxOverlays}`);

    // 13. Double start() must not double-register the key handler
    // (that would open+instantly-close = looks dead/frozen).
    plugin.start();
    plugin.start();
    await key(window, "keydown", { key: "k", ctrlKey: true });
    await flush();
    ok(overlayCount() === 1, "double start still opens exactly one modal", `overlays=${overlayCount()}`);
    // NOTE: Escape must be dispatched on an element *inside* the modal (as a
    // real keypress would be). React 18 listens at the root container, so an
    // event dispatched directly on `window` never reaches the modal handler.
    await key(document.querySelector("input.qsplus-input"), "keydown", { key: "Escape" });
    await flush();
    ok(!document.querySelector("input.qsplus-input"), "modal still closes after double start");
    plugin.stop();
    await key(window, "keydown", { key: "k", ctrlKey: true });
    await flush();
    ok(!document.querySelector("input.qsplus-input"), "stop() removes the key handler");
    plugin.start();

    // 14. Guild channels load even when ChannelStore.getAll is absent
    // (real-client shape: per-guild SELECTABLE/VOCAL wrapper lists + threads).
    // This is the user-reported "channels doesnt shown" regression test.
    {
        const { storeShape } = require("./dist/bundle.cjs");
        storeShape.useGetAll = false;
        storeShape.useGetChannelIds = false;
        try {
            await key(window, "keydown", { key: "k", ctrlKey: true });
            await flush();
            const chanTexts = [...document.querySelectorAll(".qsplus-list [data-type='text'], .qsplus-list [data-type='voice'], .qsplus-list [data-type='thread']")].map((b) => b.textContent ?? "");
            for (const n of ["general", "gaming", "Lounge Voice", "news-thread", "media-mix", "server-lobby"]) {
                ok(chanTexts.some((t) => t.includes(n)), `guildstore fallback shows channel "${n}"`, chanTexts.join("|").slice(0, 200));
            }
            ok(chanTexts.some((t) => t.includes("Alpha Server")), "guildstore fallback keeps parent-server subtitles");
            await key(document.querySelector("input.qsplus-input"), "keydown", { key: "Escape" });
            await flush();
            ok(!document.querySelector("input.qsplus-input"), "modal closes in guildstore mode");
        } finally {
            storeShape.useGetAll = true;
            storeShape.useGetChannelIds = true;
        }
    }

    // 14b. Partial getAll (DMs only, e.g. unloaded guild cache) must NOT hide
    // guild channels: the union of getChannelIds/per-guild stores fills them in.
    {
        const { storeShape } = require("./dist/bundle.cjs");
        storeShape.useGetAll = true;
        storeShape.useGetChannelIds = true;
        storeShape.partialGetAll = true;
        try {
            await key(window, "keydown", { key: "k", ctrlKey: true });
            await flush();
            const chanTexts = [...document.querySelectorAll(".qsplus-list [data-type='text'], .qsplus-list [data-type='voice'], .qsplus-list [data-type='thread']")].map((b) => b.textContent ?? "");
            for (const n of ["general", "gaming", "Lounge Voice", "news-thread", "media-mix", "server-lobby"]) {
                ok(chanTexts.some((t) => t.includes(n)), `partial-getAll union still shows "${n}"`, chanTexts.join("|").slice(0, 200));
            }
            await key(document.querySelector("input.qsplus-input"), "keydown", { key: "Escape" });
            await flush();
            ok(!document.querySelector("input.qsplus-input"), "modal closes in partial-getAll mode");
        } finally {
            storeShape.partialGetAll = false;
        }
    }

    // 14c. Type priority: servers-first lifts guilds above channels.
    // Query "server" matches channel "server-lobby" (prefix + current-guild,
    // naturally first) and every "Server …"/"Alpha Server" guild.
    {
        testApi.settings.kindOrder = "servers-first";
        testApi.settings.kindBoost = 60;
        try {
            await key(window, "keydown", { key: "k", ctrlKey: true });
            await flush();
            const inp = document.querySelector("input.qsplus-input");
            const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set;
            await act(async () => {
                setter.call(inp, "server");
                inp.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
            });
            await flush();
            const first = listButtons()[0];
            ok(first && first.dataset.type === "guild", "servers-first puts a server first", first?.textContent?.slice(0, 40));
            await key(inp, "keydown", { key: "Escape" });
            await flush();
        } finally {
            testApi.settings.kindOrder = "off";
            testApi.settings.kindBoost = 20;
        }
        // Priority off: the channel wins again.
        await key(window, "keydown", { key: "k", ctrlKey: true });
        await flush();
        {
            const inp = document.querySelector("input.qsplus-input");
            const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set;
            await act(async () => {
                setter.call(inp, "server");
                inp.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
            });
            await flush();
            const first = listButtons()[0];
            ok(first && first.dataset.type === "text", "priority off keeps the channel first", first?.textContent?.slice(0, 40));
            await key(inp, "keydown", { key: "Escape" });
            await flush();
        }
    }

    // 14d. Cross-open cache: reopening immediately reuses the last collect.
    {
        await key(window, "keydown", { key: "k", ctrlKey: true });
        await flush();
        await key(document.querySelector("input.qsplus-input"), "keydown", { key: "Escape" });
        await flush();
        testApi.resetSpies();
        plugin.toolboxActions["Dump QuickFind internals (console)"]();
        const probe = testApi.loggerCalls.map((c) => c[1]).join("\n");
        ok(/cache=hit/.test(probe), "reopen served from collect cache", (probe.match(/COLLECT.*/) || [""])[0]);
        ok(/collectMs=\d+/.test(probe), "probe reports collect time");
        ok(/PERF openMs=\d+ closeMs=\d+ closeMode=instant/.test(probe), "probe reports open/close perf", (probe.match(/PERF.*/) || [""])[0]);
        ok(globalThis.__qsLastOpenOptions && globalThis.__qsLastOpenOptions.instant === true, "opens with instant (no transition)");
    }

    // 14e. Backdrop click closes in one flush and records the mouse trigger.
    // (The overlay click must not bubble into Discord's handlers.)
    {
        await key(window, "keydown", { key: "k", ctrlKey: true });
        await flush();
        const overlay = document.querySelector('[data-testid="qsplus-overlay"]');
        ok(!!overlay, "overlay present for backdrop test");
        await act(async () => {
            overlay.click();
        });
        await flush();
        ok(!document.querySelector("input.qsplus-input"), "backdrop click closes modal");
        testApi.resetSpies();
        plugin.toolboxActions["Dump QuickFind internals (console)"]();
        const probe = testApi.loggerCalls.map((c) => c[1]).join("\n");
        ok(/closeTrigger=mouse/.test(probe), "probe records mouse close trigger", (probe.match(/PERF.*/) || [""])[0]);
    }

    // 14f. Esc records the key trigger.
    {
        await key(window, "keydown", { key: "k", ctrlKey: true });
        await flush();
        await key(document.querySelector("input.qsplus-input"), "keydown", { key: "Escape" });
        await flush();
        ok(!document.querySelector("input.qsplus-input"), "esc closes modal");
        testApi.resetSpies();
        plugin.toolboxActions["Dump QuickFind internals (console)"]();
        const probe = testApi.loggerCalls.map((c) => c[1]).join("\n");
        ok(/closeTrigger=key/.test(probe), "probe records key close trigger", (probe.match(/PERF.*/) || [""])[0]);
    }

    // 14g. disableAnimations=false drops the instant flag (animated open).
    {
        testApi.settings.disableAnimations = false;
        try {
            await key(window, "keydown", { key: "k", ctrlKey: true });
            await flush();
            ok(!!document.querySelector("input.qsplus-input"), "modal opens with animations on");
            ok(!globalThis.__qsLastOpenOptions || globalThis.__qsLastOpenOptions.instant !== true, "animated open omits instant flag");
            await key(document.querySelector("input.qsplus-input"), "keydown", { key: "Escape" });
            await flush();
        } finally {
            delete testApi.settings.disableAnimations;
        }
        await key(window, "keydown", { key: "k", ctrlKey: true });
        await flush();
        ok(!!document.querySelector("input.qsplus-input"), "modal opens with animations off");
        ok(globalThis.__qsLastOpenOptions && globalThis.__qsLastOpenOptions.instant === true, "default open passes instant flag");
        await key(document.querySelector("input.qsplus-input"), "keydown", { key: "Escape" });
        await flush();
    }

    // 14h. Animation kill-switch style present by default, absent when disabled.
    {
        const hasKillSwitch = () => [...document.querySelectorAll("style")].some((s) => (s.textContent || "").includes("qsplus-noanim"));
        await key(window, "keydown", { key: "k", ctrlKey: true });
        await flush();
        ok(hasKillSwitch(), "animation kill-switch present by default");
        await key(document.querySelector("input.qsplus-input"), "keydown", { key: "Escape" });
        await flush();
        testApi.settings.disableAnimations = false;
        try {
            await key(window, "keydown", { key: "k", ctrlKey: true });
            await flush();
            ok(!hasKillSwitch(), "animation kill-switch absent with animations on");
            await key(document.querySelector("input.qsplus-input"), "keydown", { key: "Escape" });
            await flush();
        } finally {
            delete testApi.settings.disableAnimations;
        }
    }

    // 14i. Explicit typed prefix wins over the tab (tab is only a default).
    {
        await key(window, "keydown", { key: "k", ctrlKey: true });
        await flush();
        const tabs = tabButtons();
        act(() => {
            tabs[1].click(); // Servers tab
        });
        await flush();
        const inp = document.querySelector("input.qsplus-input");
        const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set;
        await act(async () => {
            setter.call(inp, "#gen");
            inp.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
        });
        await flush();
        const rows = listButtons();
        ok(rows.length > 0 && rows.every((b) => b.dataset.type === "text" || b.dataset.type === "voice" || b.dataset.type === "thread"), "typed # wins over Servers tab", rows.map((b) => b.dataset.type).join(","));
        await key(inp, "keydown", { key: "Escape" });
        await flush();
    }

    // 14j. Unread flags flow from ReadState/GuildReadState stores.
    {
        const { __unread } = require("./dist/bundle.cjs");
        __unread.channels.add("c2");
        __unread.guilds.add("g5");
        try {
            await key(window, "keydown", { key: "k", ctrlKey: true });
            await flush();
            const rows = listButtons();
            ok(rows.some((b) => b.textContent.includes("gaming")), "unread channel still listed");
            await key(document.querySelector("input.qsplus-input"), "keydown", { key: "Escape" });
            await flush();
        } finally {
            __unread.channels.clear();
            __unread.guilds.clear();
        }
    }

    // 14k. Global-only hasAnyUnread() shape (no hasUnread; zero-arg
    // hasAnyUnread that throws when passed a guild id). The arity probe must
    // call it WITHOUT args; assert the call convention directly.
    {
        const { __unread, GuildReadStateStore } = require("./dist/bundle.cjs");
        const origHasUnread = GuildReadStateStore.hasUnread;
        const origHasAnyUnread = GuildReadStateStore.hasAnyUnread;
        const calls = [];
        GuildReadStateStore.hasUnread = undefined;
        GuildReadStateStore.hasAnyUnread = function () {
            calls.push(arguments.length);
            if (arguments.length > 0) throw new Error("global-only: no guild arg");
            return false;
        };
        try {
            await key(window, "keydown", { key: "k", ctrlKey: true });
            await flush();
            ok(!!document.querySelector("input.qsplus-input"), "modal opens in global-only unread shape");
            ok(calls.length > 0, "hasAnyUnread branch exercised", `calls=${calls.length}`);
            ok(calls.every((n) => n === 0), "global-only hasAnyUnread called without args", `arities=${[...new Set(calls)].join(",")}`);
            const errs = testApi.loggerCalls.filter((c) => c[0] === "error");
            ok(errs.length === 0, "no errors logged in global-only shape", JSON.stringify(errs).slice(0, 200));
            await key(document.querySelector("input.qsplus-input"), "keydown", { key: "Escape" });
            await flush();
        } finally {
            GuildReadStateStore.hasUnread = origHasUnread;
            GuildReadStateStore.hasAnyUnread = origHasAnyUnread;
            __unread.channels.clear();
            __unread.guilds.clear();
        }
    }

    // 14l. Guild-scoped hasAnyUnread (no hasUnread) still boosts
    // the unread guild to the top of a guild-only query.
    {
        const { __unread, GuildReadStateStore } = require("./dist/bundle.cjs");
        const origHasUnread = GuildReadStateStore.hasUnread;
        const origHasAnyUnread = GuildReadStateStore.hasAnyUnread;
        GuildReadStateStore.hasUnread = undefined;
        GuildReadStateStore.hasAnyUnread = (gid) => __unread.guilds.has(gid);
        __unread.guilds.add("g7");
        try {
            await key(window, "keydown", { key: "k", ctrlKey: true });
            await flush();
            const inp = document.querySelector("input.qsplus-input");
            const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set;
            await act(async () => {
                setter.call(inp, "server number");
                inp.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
            });
            await flush();
            const first = listButtons()[0];
            ok(!!first && first.textContent.includes("Server Number 7"), "unread guild ranks first via hasAnyUnread", first?.textContent?.slice(0, 40));
            await key(inp, "keydown", { key: "Escape" });
            await flush();
        } finally {
            GuildReadStateStore.hasUnread = origHasUnread;
            GuildReadStateStore.hasAnyUnread = origHasAnyUnread;
            __unread.channels.clear();
            __unread.guilds.clear();
        }
    }

    plugin.stop();
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
    console.error("E2E CRASH:", e);
    process.exit(2);
});
