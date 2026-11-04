// Bundled by esbuild for node. Re-exports the plugin and test handles.
import plugin, { BUILD_TAG } from "../index";
import { loggerCalls, spies, resetSpies } from "./mocks/state.js";
import { settingsRegistry } from "./mocks/api-settings.js";
import { __muted, __unread, storeShape, GuildReadStateStore } from "./mocks/webpack-common.jsx";

export { plugin, __muted, __unread, storeShape, GuildReadStateStore, BUILD_TAG };
export const testApi = {
    get settings() {
        return settingsRegistry.current.store;
    },
    spies,
    loggerCalls,
    resetSpies,
};
