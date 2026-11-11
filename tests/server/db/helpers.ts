import type { Database } from "bun:sqlite";
import { createDatabase } from "@/server/db/client";
import { runMigrations } from "@/server/db/schema";

/** Fresh migrated in-memory DB. Never touches ./data. */
export function memoryDb(): Database {
  const db = createDatabase(":memory:");
  runMigrations(db);
  return db;
}

export function count(db: Database, table: "products" | "carts" | "cart_items" | "orders" | "order_items"): number {
  return db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n ?? -1;
}

export function stockOf(db: Database, id: string): number | undefined {
  return db.query<{ stock: number }, [string]>("SELECT stock FROM products WHERE id = ?").get(id)?.stock;
}

export function insertProduct(
  db: Database,
  p: { id: string; slug?: string; name?: string; priceCents?: unknown; stock?: unknown; currency?: string },
): void {
  db.query("INSERT INTO products (id, slug, name, price_cents, currency, image_url, stock) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    p.id,
    p.slug ?? p.id,
    p.name ?? `Name ${p.id}`,
    (p.priceCents ?? 1000) as number,
    p.currency ?? "USD",
    `/images/products/${p.slug ?? p.id}.svg`,
    (p.stock ?? 5) as number,
  );
}

export function insertOrder(db: Database, id: string, key: string, status = "paid"): void {
  db.query(
    `INSERT INTO orders (id, session_id, status, subtotal_cents, total_cents, currency, full_name, email,
       line1, city, region, postal_code, country, card_last4, idempotency_key)
     VALUES (?, 'sess', ?, 100, 100, 'USD', 'A B', 'a@example.com', 'L1', 'City', 'Reg', '12345', 'US', '4242', ?)`,
  ).run(id, status, key);
}

export function insertOrderItem(db: Database, orderId: string, productId: string, name: string, unit: unknown, qty: unknown): void {
  db.query("INSERT INTO order_items (order_id, product_id, name, unit_price_cents, quantity) VALUES (?, ?, ?, ?, ?)").run(
    orderId,
    productId,
    name,
    unit as number,
    qty as number,
  );
}

export function insertCartItem(db: Database, session: string, productId: string, qty: unknown): void {
  db.query("INSERT INTO cart_items (cart_session_id, product_id, quantity) VALUES (?, ?, ?)").run(session, productId, qty as number);
}
