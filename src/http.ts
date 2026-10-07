export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export async function fetchJson(response: Response, errorContext = "response"): Promise<any> {
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
