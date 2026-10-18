import { api } from "./api";

export type Role = "parent" | "nanny";
export interface Member {
  id: string;
  name: string;
  role: Role;
}

/** `tz` is the household's IANA time zone (null until /api/me answers, or from an older cached answer). */
export const session: { me: Member | null; members: Member[]; tz: string | null } = { me: null, members: [], tz: null };

export async function loadSession(): Promise<void> {
  const r = await api<{ member: Member; members: Member[]; tz?: string }>("/api/me");
  session.me = r.member;
  session.members = r.members;
  session.tz = r.tz || null;
}

export function clearSession(): void {
  session.me = null;
  session.members = [];
  session.tz = null;
}

export function memberName(id: string): string {
  return session.members.find((m) => m.id === id)?.name ?? "Someone";
}

export const isParent = (): boolean => session.me?.role === "parent";
