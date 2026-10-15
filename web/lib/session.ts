import { api } from "./api";

export type Role = "parent" | "nanny";
export interface Member {
  id: string;
  name: string;
  role: Role;
}

export const session: { me: Member | null; members: Member[] } = { me: null, members: [] };

export async function loadSession(): Promise<void> {
  const r = await api<{ member: Member; members: Member[] }>("/api/me");
  session.me = r.member;
  session.members = r.members;
}

export function clearSession(): void {
  session.me = null;
  session.members = [];
}

export function memberName(id: string): string {
  return session.members.find((m) => m.id === id)?.name ?? "Someone";
}

export const isParent = (): boolean => session.me?.role === "parent";
