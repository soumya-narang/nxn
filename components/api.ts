"use client";

/** Tiny fetch wrapper: throws an Error carrying the API's message. */
export async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(path, {
    method: init?.method ?? (init?.body !== undefined ? "POST" : "GET"),
    headers: init?.body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    cache: "no-store",
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const problems: string[] | undefined = json.problems;
    throw new Error(problems?.length ? problems.join(" ") : json.error ?? `Request failed (${res.status})`);
  }
  return json as T;
}

export { usd } from "./format";
