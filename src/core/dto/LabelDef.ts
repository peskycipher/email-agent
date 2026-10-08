export interface LabelDef {
  name: string;
  description: string;
  m365Color: string;
  gmailColor: string;
}

/**
 * The shared label-name rule (Story 4.1): letters, digits, spaces and the
 * separators `/&'-`, so a name is safe in both M365 master categories and Gmail
 * labels. Core stays dependency-free — the runtime Zod schema lives in
 * `adapters/config`.
 */
export const LABEL_NAME_PATTERN = /^[A-Za-z0-9 /&'-]+$/;
