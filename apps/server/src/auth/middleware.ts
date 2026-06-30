/**
 * Request authentication & authorization (build spec §9).
 *
 * Two principals:
 *   - instructor: opaque httpOnly cookie `sid` → auth_sessions → user.
 *   - student:    per-assignment capability token (Authorization: Bearer <token>
 *                 or ?token=). The token resolves to (student, assignment); the
 *                 student may only touch the writing_session bound to that pair.
 *
 * Authorization is deny-by-default. The bound student may read and write their
 * own session; the owning instructor may read it; nobody else sees it.
 */
import type { Request, Response } from 'express';
import type { Store } from '@scriptorium/core';
import type { IdentityStore, ResolvedToken, User } from '../identity/types.js';

const COOKIE = 'sid';

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

export function setSessionCookie(res: Response, token: string): void {
  const secure = process.env.COOKIE_SECURE === 'true' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/${secure}`);
}

export function clearSessionCookie(res: Response): void {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

/** The instructor behind the request's cookie, or null. */
export async function getInstructor(req: Request, identity: IdentityStore): Promise<User | null> {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[COOKIE];
  if (!token) return null;
  const user = await identity.getAuthSession(token);
  return user && user.role === 'instructor' ? user : null;
}

/** The raw student capability token presented on the request, or null. */
export function getStudentToken(req: Request): string | null {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7).trim();
  const q = req.query.token;
  if (typeof q === 'string' && q) return q;
  return null;
}

export interface SessionAccess {
  principal: 'student' | 'instructor';
  canWrite: boolean;
  user: User;
}

/**
 * Decide whether the request may access a writing session, and whether it may
 * write to it. Returns null if access is denied.
 */
export async function authorizeSession(
  req: Request,
  deps: { identity: IdentityStore; store: Store },
  sessionId: string,
): Promise<SessionAccess | null> {
  const session = await deps.store.getSession(sessionId);
  if (!session) return null;

  // Student via capability token: must resolve to THIS session's (student, assignment).
  const tokenStr = getStudentToken(req);
  if (tokenStr) {
    const resolved = await deps.identity.getToken(tokenStr);
    if (
      resolved &&
      resolved.assignment.id === session.assignment_id &&
      resolved.student.id === session.author_id
    ) {
      return { principal: 'student', canWrite: true, user: resolved.student };
    }
    return null; // a presented-but-wrong token is a hard deny
  }

  // Instructor via cookie: must own the assignment. Read-only (instructors never write).
  const instructor = await getInstructor(req, deps.identity);
  if (instructor) {
    const assignment = await deps.identity.getAssignment(session.assignment_id);
    if (assignment && assignment.instructor_id === instructor.id) {
      return { principal: 'instructor', canWrite: false, user: instructor };
    }
  }

  return null;
}

export type { ResolvedToken };
