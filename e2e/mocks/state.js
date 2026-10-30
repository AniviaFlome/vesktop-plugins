// Shared mutable singletons for mocks + tests.
export const loggerCalls = [];
export const spies = {
    transitionToChannel: [],
    transitionToGuild: [],
    openPrivateChannel: [],
};
export function resetSpies() {
    spies.transitionToChannel.length = 0;
    spies.transitionToGuild.length = 0;
    spies.openPrivateChannel.length = 0;
    loggerCalls.length = 0;
}
