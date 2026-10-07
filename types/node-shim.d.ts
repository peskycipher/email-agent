declare module "node:assert/strict" {
  const assert: any;
  export default assert;
}

declare module "node:child_process" {
  const childProcess: any;
  export default childProcess;
}

declare module "node:fs/promises" {
  const fs: any;
  export default fs;
}

declare module "node:os" {
  const os: any;
  export default os;
}

declare module "node:path" {
  const path: any;
  export default path;
}

declare module "node:test" {
  const test: any;
  export default test;
}

declare module "node:url" {
  const url: any;
  export default url;
}

declare const process: any;
