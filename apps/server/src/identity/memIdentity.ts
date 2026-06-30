/**
 * In-memory IdentityStore — used in the no-database demo mode and in tests. It
 * enforces the same uniqueness rules as Postgres (unique email; one token per
 * (assignment, student)).
 */
import { randomUUID } from 'node:crypto';
import { randomToken } from '../auth/password.js';
import type {
  Assignment,
  AssignmentToken,
  IdentityStore,
  ResolvedToken,
  Role,
  User,
} from './types.js';

interface StoredUser extends User {
  password_hash: string;
}

export class InMemoryIdentityStore implements IdentityStore {
  private users = new Map<string, StoredUser>();
  private byEmail = new Map<string, string>();
  private assignments = new Map<string, Assignment>();
  private tokens = new Map<string, AssignmentToken>();
  private authSessions = new Map<string, string>(); // token -> userId

  async createUser(input: {
    email: string;
    password_hash: string;
    role: Role;
  }): Promise<User> {
    const email = input.email.toLowerCase();
    if (this.byEmail.has(email)) throw new Error('email_taken');
    const user: StoredUser = {
      id: randomUUID(),
      email,
      role: input.role,
      password_hash: input.password_hash,
    };
    this.users.set(user.id, user);
    this.byEmail.set(email, user.id);
    return { id: user.id, email: user.email, role: user.role };
  }

  async getUserByEmail(email: string): Promise<(User & { password_hash: string }) | null> {
    const id = this.byEmail.get(email.toLowerCase());
    return id ? { ...this.users.get(id)! } : null;
  }

  async getUserById(id: string): Promise<User | null> {
    const u = this.users.get(id);
    return u ? { id: u.id, email: u.email, role: u.role } : null;
  }

  async getOrCreateStudent(email: string): Promise<User> {
    const existing = await this.getUserByEmail(email);
    if (existing) {
      if (existing.role !== 'student') throw new Error('email_belongs_to_non_student');
      return { id: existing.id, email: existing.email, role: existing.role };
    }
    return this.createUser({ email, password_hash: '!', role: 'student' });
  }

  async createAuthSession(token: string, userId: string): Promise<void> {
    this.authSessions.set(token, userId);
  }

  async getAuthSession(token: string): Promise<User | null> {
    const userId = this.authSessions.get(token);
    return userId ? this.getUserById(userId) : null;
  }

  async deleteAuthSession(token: string): Promise<void> {
    this.authSessions.delete(token);
  }

  async createAssignment(input: {
    instructor_id: string;
    title: string;
    retention_days: number | null;
    lti_platform_id?: string | null;
    lti_resource_link_id?: string | null;
    lti_nrps_url?: string | null;
  }): Promise<Assignment> {
    const a: Assignment = {
      id: randomUUID(),
      instructor_id: input.instructor_id,
      title: input.title,
      created_at: new Date().toISOString(),
      retention_days: input.retention_days,
      lti_platform_id: input.lti_platform_id ?? null,
      lti_resource_link_id: input.lti_resource_link_id ?? null,
      lti_nrps_url: input.lti_nrps_url ?? null,
    };
    this.assignments.set(a.id, a);
    return a;
  }

  async getAssignment(id: string): Promise<Assignment | null> {
    return this.assignments.get(id) ?? null;
  }

  async listAssignmentsByInstructor(instructorId: string): Promise<Assignment[]> {
    return [...this.assignments.values()]
      .filter((a) => a.instructor_id === instructorId)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  async getAssignmentByResourceLink(
    platformId: string,
    resourceLinkId: string,
  ): Promise<Assignment | null> {
    return (
      [...this.assignments.values()].find(
        (a) => a.lti_platform_id === platformId && a.lti_resource_link_id === resourceLinkId,
      ) ?? null
    );
  }

  async transferAssignmentOwner(assignmentId: string, instructorId: string): Promise<void> {
    const a = this.assignments.get(assignmentId);
    if (a) a.instructor_id = instructorId;
  }

  async setAssignmentNrpsUrl(assignmentId: string, url: string): Promise<void> {
    const a = this.assignments.get(assignmentId);
    if (a) a.lti_nrps_url = url;
  }

  async mintToken(assignmentId: string, studentId: string): Promise<AssignmentToken> {
    const existing = [...this.tokens.values()].find(
      (t) => t.assignment_id === assignmentId && t.student_id === studentId,
    );
    if (existing) return existing;
    const student = this.users.get(studentId);
    if (!student) throw new Error('unknown_student');
    const tok: AssignmentToken = {
      token: randomToken(),
      assignment_id: assignmentId,
      student_id: studentId,
      student_email: student.email,
      created_at: new Date().toISOString(),
    };
    this.tokens.set(tok.token, tok);
    return tok;
  }

  async getToken(token: string): Promise<ResolvedToken | null> {
    const t = this.tokens.get(token);
    if (!t) return null;
    const assignment = this.assignments.get(t.assignment_id);
    const studentUser = this.users.get(t.student_id);
    if (!assignment || !studentUser) return null;
    return {
      token: t.token,
      assignment,
      student: { id: studentUser.id, email: studentUser.email, role: studentUser.role },
    };
  }

  async listTokensByAssignment(assignmentId: string): Promise<AssignmentToken[]> {
    return [...this.tokens.values()].filter((t) => t.assignment_id === assignmentId);
  }
}
