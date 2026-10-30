/* Strict boot test: reproduces Vencord's lazy React assignment.
 * The bundle is built with mocks/webpack-common-strict.jsx, where React
 * and hooks are UNDEFINED at import time (exactly like Vencord before its
 * internal waitFor(React) fires) and only assigned when the test calls
 * globalThis.__qsMockReady().
 *
 * - require() must NOT throw (this is what killed Vencord in production:
 *   `React.memo` at module top-level -> "Cannot read properties of
 *   undefined (reading 'memo')", taking down the whole renderer bundle).
 * - after __qsMockReady + start, the modal must open and navigate.
 * Run: npm run build:strict && node strict-test.cjs
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
global.window.HTMLElement.prototype.scrollIntoView = function () {};

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

let bundle;
try {
    bundle = require("./dist/bundle-strict.cjs");
    ok(true, "bundle require does not throw with React undefined (no top-level React.* use)");
} catch (e) {
    ok(false, "bundle require does not throw with React undefined", String(e && e.message).slice(0, 200));
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(1);
}

const { act } = require("react");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function flush(ms = 20) {
    await act(async () => {
        await sleep(ms);
    });
}
function key(target, type, init) {
    const e = new dom.window.KeyboardEvent(type, { bubbles: true, cancelable: true, ...init });
    return act(async () => {
        target.dispatchEvent(e);
    });
}

(async () => {
    const { plugin, testApi } = bundle;
    globalThis.__qsMockReady();
    testApi.settings.debounceMs = 0;
    testApi.settings.maxResults = 50;
    plugin.start();

    await key(window, "keydown", { key: "k", ctrlKey: true });
    await flush();
    const input = document.querySelector("input.qsplus-input");
    ok(!!input, "modal opens after late React assignment");
    ok(document.activeElement === input, "input autofocused");

    const rows = () => [...document.querySelectorAll(".qsplus-list button")];
    const selIdx = () => {
        const ov = document.querySelector('[data-testid="qsplus-overlay"]');
        return ov ? Number(ov.dataset.sel) : -1;
    };
    await key(input, "keydown", { key: "ArrowDown" });
    await flush();
    ok(selIdx() === 1, "arrows move selection post-ready", `sel=${selIdx()}`);
    await key(input, "keydown", { key: "Escape" });
    await flush();
    ok(!document.querySelector("input.qsplus-input"), "modal closes");

    plugin.stop();
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
})().catch((e) => {
    console.error("STRICT CRASH:", e);
    process.exit(2);
});
