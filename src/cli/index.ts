import { defaultHandlers, runCli } from "./main.js";

process.exitCode = await runCli(process.argv, defaultHandlers);
