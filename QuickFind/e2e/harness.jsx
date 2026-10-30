// Browser harness: renders the REAL plugin modal in a REAL Chromium,
// drives it with REAL key/mouse events, and self-measures open/close latency.
// No act(), no jsdom — plain browser scheduling like production.
import plugin from "../index";
import { settingsRegistry } from "./mocks/api-settings.js";
import { loggerCalls, resetSpies, spies } from "./mocks/state.js";
import { __qsMockState } from "./mocks/webpack-common.jsx";

const settings = settingsRegistry.current.store;
settings.debounceMs = 0;
settings.maxResults = 50;
settings.hideMuted = false;

const results = {};
const mark = (k, v) => {
    results[k] = v;
    render();
};
function render() {
    const el = document.getElementById("report");
    if (el) el.textContent = "QSPLUS-HARNESS " + JSON.stringify(results);
    document.title = "QSPLUS-HARNESS " + JSON.stringify(results);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs = 3000) {
    const t0 = performance.now();
    for (;;) {
        const v = fn();
        if (v) return v;
        if (performance.now() - t0 > timeoutMs) throw new Error("waitFor timeout");
        await sleep(25);
    }
}

function keydown(target, init) {
    target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
}

async function main() {
    render();
    window.__qsDebug = true;
    plugin.start();

    // --- open ---
    let t0 = performance.now();
    keydown(window, { key: "k", ctrlKey: true });
    const input = await waitFor(() => document.querySelector("input.qsplus-input"));
    mark("open_ms", Math.round(performance.now() - t0));
    mark("autofocus", document.activeElement === input);

    // --- arrows on the FULL list (filtered single-row lists legitimately stay at 0) ---
    const selOf = () => Number(document.querySelector('[data-testid="qsplus-overlay"]')?.dataset.sel ?? -1);
    keydown(input, { key: "ArrowDown" });
    await sleep(150);
    mark("sel_after_down", selOf());
    keydown(input, { key: "ArrowDown" });
    await sleep(150);
    mark("sel_after_down2", selOf());

    // --- type + filter ---
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(input, "gen");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(300);
    const rows = () => [...document.querySelectorAll(".qsplus-list button")];
    mark("rows_after_gen", rows().length);

    // --- group avatars (mock grp1 has 2 recipients with avatars) ---
    setter.call(input, "");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(300);
    const groupRow = [...document.querySelectorAll(".qsplus-list [data-type='group']")][0];
    mark("group_imgs", groupRow ? groupRow.querySelectorAll("img").length : -1);

    // --- close latency: keydown -> modal removed from DOM ---
    // (Fallback timer is cancelled on early resolve so a later reopened
    //  modal can't clobber the true measurement with a stale -1.)
    const overlays = () => document.querySelectorAll('[data-testid="qsplus-overlay"]').length;
    mark("overlays_before_close", overlays());
    let closeDone = false;
    let fallback = 0;
    await new Promise((resolve) => {
        const obs = new MutationObserver(() => {
            if (!closeDone && !document.querySelector('[data-testid="qsplus-overlay"]')) {
                closeDone = true;
                mark("close_ms", Math.round(performance.now() - t0));
                obs.disconnect();
                clearTimeout(fallback);
                resolve();
            }
        });
        obs.observe(document.body, { childList: true, subtree: true });
        t0 = performance.now();
        keydown(document.querySelector("input.qsplus-input") || window, { key: "Escape" });
        fallback = setTimeout(() => {
            if (closeDone) return;
            closeDone = true;
            if (document.querySelector('[data-testid="qsplus-overlay"]')) {
                mark("close_ms", -1);
            }
            obs.disconnect();
            resolve();
        }, 5000);
    });
    mark("qslog", (window.__qsLog || []).slice(-30));
    mark("closelog", ((window.__qsCloseLog) || []).slice(-12));
    mark("swallowed_errors", loggerCalls.filter((c) => c[0] === "error" || c[0] === "warn").map((c) => c[1]).slice(-10));

    // --- toggle back open ---
    mark("mockstate_after_close", JSON.stringify(__qsMockState()));
    keydown(window, { key: "k", ctrlKey: true });
    await sleep(300);
    mark("toggle_reopen", !!document.querySelector("input.qsplus-input"));
    mark("done", true);
    render();
}

main().catch((e) => {
    mark("error", String(e && e.message || e).slice(0, 200));
});
