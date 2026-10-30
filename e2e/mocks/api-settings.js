import { OptionType } from "./utils-types.js";

export const settingsRegistry = { current: null };

// definePluginSettings mock: builds a mutable store from definition defaults.
export function definePluginSettings(def) {
    const store = {};
    for (const [key, setting] of Object.entries(def)) {
        if (setting && typeof setting === "object") {
            if ("default" in setting && setting.default !== undefined) {
                store[key] = setting.default;
            } else if (setting.type === OptionType.SELECT && Array.isArray(setting.options)) {
                const d = setting.options.find((o) => o.default);
                store[key] = d ? d.value : setting.options[0]?.value;
            } else if (setting.type === OptionType.SLIDER && Array.isArray(setting.markers)) {
                store[key] = setting.default ?? setting.markers[0];
            }
        }
    }
    const defined = {
        def,
        store,
        plain: store,
        use: () => store,
        pluginName: "test",
        withPrivateSettings() {
            return this;
        },
    };
    settingsRegistry.current = defined;
    return defined;
}
