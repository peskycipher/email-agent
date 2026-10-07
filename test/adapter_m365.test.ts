import test from "node:test";
import assert from "node:assert/strict";

import { M365MailboxAdapter } from "../src/adapter_m365.ts";

test("M365MailboxAdapter authenticates and lists inbox mail with stable ids", async () => {
  const calls: Array<{ input: unknown; init?: RequestInit }> = [];

  const fetchFn = async (input: unknown, init?: RequestInit): Promise<Response> => {
    calls.push({ input, init });
    const url = String(input);

    if (url.includes("login.microsoftonline.com")) {
      return new Response(JSON.stringify({ access_token: "token-1" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }

    if (url.includes("graph.microsoft.com")) {
      return new Response(
        JSON.stringify({
          value: [
            {
              id: "immutable-1",
              subject: "Quarterly report",
              receivedDateTime: "2026-01-01T00:00:00.000Z",
              isRead: false,
              categories: ["Blue"],
              flag: { flagStatus: "flagged" },
              from: { emailAddress: { address: "vip@example.com" } }
            }
          ]
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      );
    }

    throw new Error(`Unexpected URL: ${url}`);
  };

  const adapter = new M365MailboxAdapter(
    {
      tenantId: "tenant-id",
      clientId: "client-id",
      clientSecret: "client-secret",
      account: "pilot@example.com"
    },
    fetchFn
  );

  const messages = await adapter.listRecentInbox(5);

  assert.equal(calls.length, 2);

  const tokenCallUrl = String(calls[0].input);
  assert.match(tokenCallUrl, /login\.microsoftonline\.com\/tenant-id\/oauth2\/v2\.0\/token/);

  const messageCallUrl = String(calls[1].input);
  assert.match(messageCallUrl, /graph\.microsoft\.com\/v1\.0\/users\/pilot%40example\.com\/mailFolders\/inbox\/messages/);

  const messageHeaders = new Headers(calls[1].init?.headers);
  assert.equal(messageHeaders.get("authorization"), "Bearer token-1");
  assert.equal(messageHeaders.get("prefer"), 'IdType="ImmutableId"');

  assert.equal(messages.length, 1);
  assert.equal(messages[0].id, "immutable-1");
  assert.equal(messages[0].from, "vip@example.com");
  assert.equal(messages[0].subject, "Quarterly report");
  assert.equal(messages[0].unread, true);
  assert.equal(messages[0].flagged, true);
  assert.deepEqual(messages[0].categories, ["Blue"]);
});

test("M365MailboxAdapter fetches one message by id for apply-time no-touch checks", async () => {
  const calls: Array<{ input: unknown; init?: RequestInit }> = [];

  const fetchFn = async (input: unknown, init?: RequestInit): Promise<Response> => {
    calls.push({ input, init });
    const url = String(input);

    if (url.includes("login.microsoftonline.com")) {
      return new Response(JSON.stringify({ access_token: "token-1" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }

    return new Response(
      JSON.stringify({
        id: "immutable-7",
        subject: "Follow-up",
        isRead: false,
        flag: { flagStatus: "flagged" },
        from: { emailAddress: { address: "owner@example.com" } }
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" }
      }
    );
  };

  const adapter = new M365MailboxAdapter(
    {
      tenantId: "tenant-id",
      clientId: "client-id",
      clientSecret: "client-secret",
      account: "pilot@example.com"
    },
    fetchFn
  );

  const message = await adapter.getMessage("immutable-7");

  assert.equal(calls.length, 2);
  assert.match(String(calls[1].input), /\/messages\/immutable-7\?\$select=subject,from,flag,isRead$/);
  const headers = new Headers(calls[1].init?.headers);
  assert.equal(headers.get("prefer"), 'IdType="ImmutableId"');
  assert.equal(message.id, "immutable-7");
  assert.equal(message.from, "owner@example.com");
  assert.equal(message.subject, "Follow-up");
  assert.equal(message.flagged, true);
  assert.equal(message.unread, true);
});

test("M365MailboxAdapter follows @odata.nextLink until exhausted", async () => {
  const graphUrls: string[] = [];

  const fetchFn = async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = String(input);

    if (url.includes("login.microsoftonline.com")) {
      return new Response(JSON.stringify({ access_token: "token-1" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }

    graphUrls.push(url);

    if (graphUrls.length === 1) {
      return new Response(
        JSON.stringify({
          value: [
            {
              id: "immutable-1",
              subject: "First page",
              receivedDateTime: "2026-01-01T00:00:00.000Z",
              isRead: false,
              categories: [],
              from: { emailAddress: { address: "a@example.com" } }
            }
          ],
          "@odata.nextLink": "https://graph.microsoft.com/v1.0/users/pilot%40example.com/mailFolders/inbox/messages?$top=5&next=2"
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      );
    }

    return new Response(
      JSON.stringify({
        value: [
          {
            id: "immutable-2",
            subject: "Second page",
            receivedDateTime: "2025-12-31T00:00:00.000Z",
            isRead: false,
            categories: [],
            from: { emailAddress: { address: "b@example.com" } }
          }
        ]
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" }
      }
    );
  };

  const adapter = new M365MailboxAdapter(
    {
      tenantId: "tenant-id",
      clientId: "client-id",
      clientSecret: "client-secret",
      account: "pilot@example.com"
    },
    fetchFn
  );

  const messages = await adapter.listRecentInbox(5);

  assert.equal(graphUrls.length, 2);
  assert.match(graphUrls[1], /next=2/);
  assert.deepEqual(messages.map((message) => message.id), ["immutable-1", "immutable-2"]);
});

test("M365MailboxAdapter stops pagination once limit is reached", async () => {
  const graphUrls: string[] = [];

  const fetchFn = async (input: unknown): Promise<Response> => {
    const url = String(input);

    if (url.includes("login.microsoftonline.com")) {
      return new Response(JSON.stringify({ access_token: "token-1" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }

    graphUrls.push(url);

    if (graphUrls.length === 1) {
      return new Response(
        JSON.stringify({
          value: [
            {
              id: "immutable-1",
              subject: "First page one",
              receivedDateTime: "2026-01-01T00:00:00.000Z",
              isRead: false,
              categories: [],
              from: { emailAddress: { address: "a@example.com" } }
            },
            {
              id: "immutable-2",
              subject: "First page two",
              receivedDateTime: "2025-12-31T00:00:00.000Z",
              isRead: false,
              categories: [],
              from: { emailAddress: { address: "b@example.com" } }
            },
            {
              id: "immutable-3",
              subject: "First page three",
              receivedDateTime: "2025-12-30T00:00:00.000Z",
              isRead: false,
              categories: [],
              from: { emailAddress: { address: "c@example.com" } }
            }
          ],
          "@odata.nextLink": "https://graph.microsoft.com/v1.0/users/pilot%40example.com/mailFolders/inbox/messages?$top=2&next=2"
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      );
    }

    return new Response(
      JSON.stringify({
        value: [
          {
            id: "immutable-4",
            subject: "Second page one",
            receivedDateTime: "2025-12-29T00:00:00.000Z",
            isRead: false,
            categories: [],
            from: { emailAddress: { address: "d@example.com" } }
          }
        ]
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" }
      }
    );
  };

  const adapter = new M365MailboxAdapter(
    {
      tenantId: "tenant-id",
      clientId: "client-id",
      clientSecret: "client-secret",
      account: "pilot@example.com"
    },
    fetchFn
  );

  const messages = await adapter.listRecentInbox(2);

  assert.equal(graphUrls.length, 1);
  assert.deepEqual(messages.map((message) => message.id), ["immutable-1", "immutable-2"]);
});

test("M365MailboxAdapter merges new category with existing categories on classify PATCH", async () => {
  let capturedUrl = "";
  let capturedMethod = "";
  let capturedBody: unknown;

  const fetchFn = async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = String(input);

    if (url.includes("login.microsoftonline.com")) {
      return new Response(JSON.stringify({ access_token: "token-1" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }

    capturedUrl = url;
    capturedMethod = init?.method ?? "";
    capturedBody = JSON.parse(String(init?.body));

    return new Response("", { status: 200 });
  };

  const adapter = new M365MailboxAdapter(
    {
      tenantId: "tenant-id",
      clientId: "client-id",
      clientSecret: "client-secret",
      account: "pilot@example.com"
    },
    fetchFn
  );

  const result = await adapter.apply("immutable-1", "classify", "Bulk/Archive", ["Existing", "Bulk/Archive"]);

  assert.equal(result.ok, true);
  assert.equal(capturedMethod, "PATCH");
  assert.match(capturedUrl, /\/messages\/immutable-1$/);
  assert.deepEqual(capturedBody, { categories: ["Existing", "Bulk/Archive"] });
});

test("M365MailboxAdapter fetches live categories when classify snapshot categories are missing", async () => {
  const graphCalls: Array<{ url: string; method: string; body?: string }> = [];

  const fetchFn = async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = String(input);

    if (url.includes("login.microsoftonline.com")) {
      return new Response(JSON.stringify({ access_token: "token-1" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }

    graphCalls.push({
      url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : undefined
    });

    if (url.includes("?$select=categories")) {
      return new Response(JSON.stringify({ categories: ["Existing"] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }

    return new Response("", { status: 200 });
  };

  const adapter = new M365MailboxAdapter(
    {
      tenantId: "tenant-id",
      clientId: "client-id",
      clientSecret: "client-secret",
      account: "pilot@example.com"
    },
    fetchFn
  );

  const result = await adapter.apply("immutable-1", "classify", "Bulk/Archive", undefined);

  assert.equal(result.ok, true);
  assert.equal(graphCalls.length, 2);
  assert.match(graphCalls[0].url, /\/messages\/immutable-1\?\$select=categories$/);
  assert.equal(graphCalls[0].method, "GET");
  assert.equal(graphCalls[1].method, "PATCH");
  assert.deepEqual(JSON.parse(graphCalls[1].body ?? "{}"), { categories: ["Existing", "Bulk/Archive"] });
});

test("M365MailboxAdapter classify fails without PATCH when category prefetch fails", async () => {
  const graphCalls: Array<{ url: string; method: string }> = [];

  const fetchFn = async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = String(input);

    if (url.includes("login.microsoftonline.com")) {
      return new Response(JSON.stringify({ access_token: "token-1" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }

    graphCalls.push({ url, method: init?.method ?? "GET" });

    if (url.includes("?$select=categories")) {
      return new Response(JSON.stringify({ error: { message: "read-failed" } }), {
        status: 500,
        headers: { "content-type": "application/json" }
      });
    }

    return new Response("", { status: 200 });
  };

  const adapter = new M365MailboxAdapter(
    {
      tenantId: "tenant-id",
      clientId: "client-id",
      clientSecret: "client-secret",
      account: "pilot@example.com"
    },
    fetchFn
  );

  const result = await adapter.apply("immutable-1", "classify", "Bulk/Archive", undefined);

  assert.equal(result.ok, false);
  assert.equal(result.error, "read-failed");
  assert.equal(graphCalls.length, 1);
  assert.equal(graphCalls[0].method, "GET");
});
