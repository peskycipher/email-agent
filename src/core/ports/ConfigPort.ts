import type { Config } from "../dto/Config.js";

export interface ConfigPort {
  load(): Promise<Config>;
}
