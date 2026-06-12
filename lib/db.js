// Postgres access via Neon's serverless driver.
//  - `sql` (HTTP) for one-off queries — returns { rows, rowCount } (fullResults).
//  - `withTransaction` opens a real connection (WebSocket) for interactive
//    BEGIN/COMMIT, exposing the same `client.sql`...`` tagged-template API the
//    callers already use, so query sites didn't have to change.
import { neon, neonConfig, Client } from "@neondatabase/serverless";
import ws from "ws";

// Node < 22 has no global WebSocket; give Neon one explicitly so the interactive
// (transaction) path works on every runtime.
neonConfig.webSocketConstructor = ws;

function connectionString() {
  const cs = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!cs) throw new Error("DATABASE_URL is not configured");
  return cs;
}

// Lazily-initialized HTTP query function. Kept lazy so importing this module
// without env (syntax checks, the static preview) doesn't throw.
let _neon;
function getNeon() {
  if (!_neon) _neon = neon(connectionString(), { fullResults: true });
  return _neon;
}

// Tagged-template entry point: await sql`SELECT ... ${value}` → { rows, rowCount }.
export function sql(strings, ...values) {
  return getNeon()(strings, ...values);
}

// Convert a tagged template into a parameterized { text, values } for node-pg.
function toQuery(strings, values) {
  let text = "";
  strings.forEach((s, i) => { text += s + (i < values.length ? `$${i + 1}` : ""); });
  return { text, values };
}

export async function withTransaction(fn) {
  const client = new Client(connectionString());
  await client.connect();
  // Adapter so callers can keep using client.sql`...` (returns { rows, rowCount }).
  const tx = { sql: (strings, ...values) => client.query(toQuery(strings, values)) };
  try {
    await client.query("BEGIN");
    const result = await fn(tx);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch { /* ignore */ }
    throw err;
  } finally {
    await client.end();
  }
}
