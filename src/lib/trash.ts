import type { Member } from "./auth";
import { newId, now } from "./util";

/** Deleted things can be restored for this long. */
export const TRASH_TTL = 24 * 3_600_000;

export type TrashKind = "item" | "task" | "message";

export interface TrashRow {
  id: string;
  kind: TrashKind;
  ref_id: string;
  label: string;
  data: string;
  media_key: string | null;
  deleted_by: string;
  deleted_at: number;
}

/** What gets saved: the deleted row itself plus rows that belong to it (task comments, message reactions). */
export interface TrashData {
  row: Record<string, unknown>;
  comments?: Record<string, unknown>[];
  reactions?: Record<string, unknown>[];
}

/** Statement that saves a copy of a row being deleted. Run it in the same batch as the DELETE. */
export function trashStatement(
  db: D1Database,
  e: { id: string; kind: TrashKind; refId: string; label: string; data: TrashData; mediaKey: string | null; by: string },
): D1PreparedStatement {
  return db
    .prepare(
      "INSERT INTO trash(id, kind, ref_id, label, data, media_key, deleted_by, deleted_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
    )
    .bind(e.id, e.kind, e.refId, e.label.slice(0, 140), JSON.stringify(e.data), e.mediaKey, e.by, now());
}

export const newTrashId = newId;

/** Who may see / restore / purge a trash entry: list items are everyone's, tasks are the parents', messages only their author's. */
export function canSeeTrash(t: Pick<TrashRow, "kind" | "deleted_by">, me: Member): boolean {
  if (t.kind === "item") return true;
  if (t.kind === "task") return me.role === "parent";
  return t.deleted_by === me.id;
}

const COL = /^[a-z_]+$/;

/** INSERT that puts a saved row back exactly as it was. Column names come from our own SELECT *. */
export function insertStatement(db: D1Database, table: string, row: Record<string, unknown>): D1PreparedStatement {
  const cols = Object.keys(row).filter((k) => COL.test(k));
  const ph = cols.map((_, i) => "?" + (i + 1)).join(", ");
  return db.prepare(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${ph})`).bind(...cols.map((k) => row[k] ?? null));
}
