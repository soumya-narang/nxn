import { NextResponse } from "next/server";
import { z } from "zod";
import { MandateExtractionError } from "./mandate";
import { PayPalError } from "./paypal";
import { HttpError } from "./util";

/** Wraps a route handler: JSON errors with sensible status codes, never a stack trace. */
export function handle<A extends unknown[]>(fn: (...args: A) => Promise<unknown>) {
  return async (...args: A) => {
    try {
      const result = await fn(...args);
      return result instanceof Response ? result : NextResponse.json(result);
    } catch (err) {
      if (err instanceof HttpError) return NextResponse.json({ error: err.message, details: err.details }, { status: err.status });
      if (err instanceof MandateExtractionError) return NextResponse.json({ error: err.message, problems: err.problems }, { status: 422 });
      if (err instanceof z.ZodError) return NextResponse.json({ error: "Invalid request", issues: err.issues }, { status: 400 });
      if (err instanceof PayPalError)
        return NextResponse.json({ error: `PayPal: ${err.message}`, paypal: { name: err.name, debugId: err.debugId } }, { status: 502 });
      console.error("[sentinel]", err);
      return NextResponse.json({ error: err instanceof Error ? err.message : "Internal error" }, { status: 500 });
    }
  };
}

export async function readJson<T>(req: Request, schema: z.ZodType<T>): Promise<T> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  return schema.parse(body);
}

export type IdParams = { params: Promise<{ id: string }> };
