import type { Database } from "bun:sqlite";
import type { SavedAddress } from "@/lib/types";
import { isSessionId } from "@/server/session/session-id";

/**
 * Address book persistence (server-only): thin SQL over `addresses`. Bound
 * parameters only; no business rules (limits, validation, the one-default
 * rule) live here: those belong to `address-service.ts`.
 *
 * Every statement is scoped by `session_id` (the owner key), so a row can
 * never be read or changed through another owner's key. Reads with an
 * invalid session id return empty results without querying; writes throw a
 * `TypeError` (a programmer error: the service validates first).
 */

/** Values written for one address. Strings are already cleaned and validated. */
export interface AddressRecord {
  readonly label: string;
  readonly fullName: string;
  readonly phone: string | null;
  readonly line1: string;
  readonly line2: string | null;
  readonly city: string;
  readonly region: string;
  readonly postalCode: string;
  readonly country: string;
}

export interface AddressRepository {
  /** The owner's addresses: default first, then newest (`created_at DESC`, insertion order as tie-break). */
  listBySession(sessionId: string): SavedAddress[];
  /** The address when it belongs to `sessionId`, else `null`. */
  findById(sessionId: string, addressId: string): SavedAddress | null;
  findDefault(sessionId: string): SavedAddress | null;
  /** Most recently created address of the owner, else `null`. */
  findMostRecent(sessionId: string): SavedAddress | null;
  countBySession(sessionId: string): number;
  insert(sessionId: string, id: string, record: AddressRecord, isDefault: boolean, nowIso: string): void;
  /** Replaces the editable fields; returns whether a row matched. */
  update(sessionId: string, addressId: string, record: AddressRecord, nowIso: string): boolean;
  /** Returns whether a row was deleted. */
  delete(sessionId: string, addressId: string): boolean;
  /** Clears `is_default` on every row of the owner. */
  clearDefault(sessionId: string, nowIso: string): void;
  /** Sets `is_default = 1` on one row; returns whether a row matched. */
  markDefault(sessionId: string, addressId: string, nowIso: string): boolean;
}

interface AddressRow {
  id: string;
  label: string;
  full_name: string;
  phone: string | null;
  line1: string;
  line2: string | null;
  city: string;
  region: string;
  postal_code: string;
  country: string;
  is_default: number;
  created_at: string;
  updated_at: string;
}

const COLUMNS =
  "id, label, full_name, phone, line1, line2, city, region, postal_code, country, is_default, created_at, updated_at";

/** Newest first; rowid breaks ties between rows created in the same millisecond. */
const NEWEST = "created_at DESC, rowid DESC";

function assertSessionId(sessionId: string): void {
  if (!isSessionId(sessionId)) {
    throw new TypeError("AddressRepository: invalid session id");
  }
}

function toSavedAddress(row: AddressRow): SavedAddress {
  return {
    id: row.id,
    label: row.label,
    fullName: row.full_name,
    ...(row.phone !== null && row.phone !== "" ? { phone: row.phone } : {}),
    line1: row.line1,
    ...(row.line2 !== null && row.line2 !== "" ? { line2: row.line2 } : {}),
    city: row.city,
    region: row.region,
    postalCode: row.postal_code,
    country: row.country,
    isDefault: row.is_default === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SqliteAddressRepository implements AddressRepository {
  constructor(private readonly db: Database) {}

  listBySession(sessionId: string): SavedAddress[] {
    if (!isSessionId(sessionId)) return [];
    return this.db
      .query<AddressRow, [string]>(
        `SELECT ${COLUMNS} FROM addresses WHERE session_id = ? ORDER BY is_default DESC, ${NEWEST}`,
      )
      .all(sessionId)
      .map(toSavedAddress);
  }

  findById(sessionId: string, addressId: string): SavedAddress | null {
    if (!isSessionId(sessionId)) return null;
    const row = this.db
      .query<AddressRow, [string, string]>(
        `SELECT ${COLUMNS} FROM addresses WHERE session_id = ? AND id = ?`,
      )
      .get(sessionId, addressId);
    return row === null ? null : toSavedAddress(row);
  }

  findDefault(sessionId: string): SavedAddress | null {
    if (!isSessionId(sessionId)) return null;
    const row = this.db
      .query<AddressRow, [string]>(
        `SELECT ${COLUMNS} FROM addresses WHERE session_id = ? AND is_default = 1 ORDER BY ${NEWEST} LIMIT 1`,
      )
      .get(sessionId);
    return row === null ? null : toSavedAddress(row);
  }

  findMostRecent(sessionId: string): SavedAddress | null {
    if (!isSessionId(sessionId)) return null;
    const row = this.db
      .query<AddressRow, [string]>(
        `SELECT ${COLUMNS} FROM addresses WHERE session_id = ? ORDER BY ${NEWEST} LIMIT 1`,
      )
      .get(sessionId);
    return row === null ? null : toSavedAddress(row);
  }

  countBySession(sessionId: string): number {
    if (!isSessionId(sessionId)) return 0;
    const row = this.db
      .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM addresses WHERE session_id = ?")
      .get(sessionId);
    return row?.n ?? 0;
  }

  insert(sessionId: string, id: string, record: AddressRecord, isDefault: boolean, nowIso: string): void {
    assertSessionId(sessionId);
    this.db
      .query<
        unknown,
        [string, string, string, string, string | null, string, string | null, string, string, string, string, number, string, string]
      >(
        `INSERT INTO addresses
           (id, session_id, label, full_name, phone, line1, line2, city, region, postal_code, country, is_default, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`,
      )
      .run(
        id,
        sessionId,
        record.label,
        record.fullName,
        record.phone,
        record.line1,
        record.line2,
        record.city,
        record.region,
        record.postalCode,
        record.country,
        isDefault ? 1 : 0,
        nowIso,
        nowIso,
      );
  }

  update(sessionId: string, addressId: string, record: AddressRecord, nowIso: string): boolean {
    assertSessionId(sessionId);
    const result = this.db
      .query<
        unknown,
        [string, string | null, string, string | null, string, string, string, string, string, string, string, string]
      >(
        `UPDATE addresses SET
           full_name = ?1, phone = ?2, line1 = ?3, line2 = ?4, city = ?5, region = ?6,
           postal_code = ?7, country = ?8, label = ?9, updated_at = ?10
         WHERE session_id = ?11 AND id = ?12`,
      )
      .run(
        record.fullName,
        record.phone,
        record.line1,
        record.line2,
        record.city,
        record.region,
        record.postalCode,
        record.country,
        record.label,
        nowIso,
        sessionId,
        addressId,
      );
    return result.changes > 0;
  }

  delete(sessionId: string, addressId: string): boolean {
    assertSessionId(sessionId);
    const result = this.db
      .query<unknown, [string, string]>("DELETE FROM addresses WHERE session_id = ? AND id = ?")
      .run(sessionId, addressId);
    return result.changes > 0;
  }

  clearDefault(sessionId: string, nowIso: string): void {
    assertSessionId(sessionId);
    this.db
      .query<unknown, [string, string]>(
        "UPDATE addresses SET is_default = 0, updated_at = ?1 WHERE session_id = ?2 AND is_default = 1",
      )
      .run(nowIso, sessionId);
  }

  markDefault(sessionId: string, addressId: string, nowIso: string): boolean {
    assertSessionId(sessionId);
    const result = this.db
      .query<unknown, [string, string, string]>(
        "UPDATE addresses SET is_default = 1, updated_at = ?1 WHERE session_id = ?2 AND id = ?3",
      )
      .run(nowIso, sessionId, addressId);
    return result.changes > 0;
  }
}
