// @webpack mock: only what the plugin (and probe) touch.
export function findStore(_name) {
    return undefined;
}
export function findAll(_filter) {
    return [];
}
export function findByPropsLazy(..._props) {
    return undefined;
}
export function findStoreLazy(_name) {
    return undefined;
}
