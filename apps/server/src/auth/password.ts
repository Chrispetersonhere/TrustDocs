/**
 * Password hashing (build spec §5: argon2 or bcrypt). We use bcryptjs — pure JS,
 * no native build step — so the image stays trivially self-hostable.
 */
import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';

const ROUNDS = 10;

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, ROUNDS);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  try {
    return await bcrypt.compare(plain, hash);
  } catch {
    return false;
  }
}

/** A url-safe opaque token for auth sessions and per-student assignment links. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}
