/**
 * The shared `accountName` rule (Story 11.1): a lowercase slug of 1–32 chars,
 * so a name can never escape its `accounts/<provider>/` directory. Core stays
 * dependency-free — the runtime Zod schema lives in `adapters/config`.
 */
export const ACCOUNT_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;
