// Mirrors @utils/types OptionType numeric values + definePlugin identity.
export const OptionType = {
    STRING: 0,
    NUMBER: 1,
    BIGINT: 2,
    BOOLEAN: 3,
    SELECT: 4,
    SLIDER: 5,
    COMPONENT: 6,
    CUSTOM: 7,
};
export default function definePlugin(p) {
    return p;
}
