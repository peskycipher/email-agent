export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export const defaultFetch: FetchFn = (input, init) => fetch(input, init);

export async function parseJsonBody(response: Response, errorContext = "response"): Promise<any> {
  const text = await response.text();
  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${errorContext} was not valid JSON (${response.status})`);
  }
}

export function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
