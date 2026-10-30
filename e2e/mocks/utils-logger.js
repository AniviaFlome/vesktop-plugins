import { loggerCalls } from "./state.js";

export class Logger {
    constructor(_name) { }
    info(...args) {
        loggerCalls.push(["info", args.map(String).join(" ")]);
    }
    warn(...args) {
        loggerCalls.push(["warn", args.map(String).join(" ")]);
    }
    error(...args) {
        loggerCalls.push(["error", args.map(String).join(" ")]);
    }
}
