/** Shared by server and client components (no "use client" here on purpose). */
export const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;
