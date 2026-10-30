// Strict entry: bundled with the Vencord-faithful lazy-React mock
// (React undefined at import, assigned via __qsMockReady).
// Re-exports the plugin and the mocked settings store.
import plugin from "../index";
import { loggerCalls, spies, resetSpies } from "./mocks/state.js";
import { settingsRegistry } from "./mocks/api-settings.js";

export { plugin };
export const testApi = {
    get settings() {
        return settingsRegistry.current.store;
    },
    spies,
    loggerCalls,
    resetSpies,
};
