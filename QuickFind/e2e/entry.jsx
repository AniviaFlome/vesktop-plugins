// Bundled by esbuild for node. Re-exports the plugin and test handles.
import plugin, { BUILD_TAG, getLastGuildChannelId } from "../index";
import { loggerCalls, spies, resetSpies } from "./mocks/state.js";
import { settingsRegistry } from "./mocks/api-settings.js";
import { __muted, __unread, storeShape, GuildReadStateStore, __lastSelected, SelectedChannelStore } from "./mocks/webpack-common.jsx";

export { plugin, __muted, __unread, storeShape, GuildReadStateStore, __lastSelected, SelectedChannelStore, BUILD_TAG, getLastGuildChannelId };
export const testApi = {
    get settings() {
        return settingsRegistry.current.store;
    },
    spies,
    loggerCalls,
    resetSpies,
};
