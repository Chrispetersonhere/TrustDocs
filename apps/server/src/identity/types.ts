/**
 * Identity model for M2 (build spec §9, §10).
 *
 * Roles: instructor (real password account) and student (identified by a
 * per-assignment capability token). Instructors create assignments and mint a
 * per-student, per-assignment token; a student opening that link establishes a
 * writing_session unforgeably bound to (student, assignment).
 */
export type Role = 'instructor' | 'student';

export interface User {
  id: string;
  email: string;
  role: Role;
}

export interface Assignment {
  id: string;
  instructor_id: string;
  title: string;
  created_at: string;
  /** Retention window in days, or null to keep indefinitely (build spec §9). */
  retention_days: number | null;
  /** Set when this assignment is bound to an LTI resource link (M2 LTI path). */
  lti_platform_id?: string | null;
  lti_resource_link_id?: string | null;
  /** NRPS memberships endpoint captured at launch, for roster sync. */
  lti_nrps_url?: string | null;
}

export interface AssignmentToken {
  token: string;
  assignment_id: string;
  student_id: string;
  student_email: string;
  created_at: string;
}

/** Resolved when a student presents their capability token. */
export interface ResolvedToken {
  token: string;
  assignment: Assignment;
  student: User;
}

export interface IdentityStore {
  // --- users / auth ---
  createUser(input: { email: string; password_hash: string; role: Role }): Promise<User>;
  getUserByEmail(email: string): Promise<(User & { password_hash: string }) | null>;
  getUserById(id: string): Promise<User | null>;
  /** Find a student by email or create one (students have no usable password). */
  getOrCreateStudent(email: string): Promise<User>;

  createAuthSession(token: string, userId: string): Promise<void>;
  getAuthSession(token: string): Promise<User | null>;
  deleteAuthSession(token: string): Promise<void>;

  // --- assignments / tokens ---
  createAssignment(input: {
    instructor_id: string;
    title: string;
    retention_days: number | null;
    lti_platform_id?: string | null;
    lti_resource_link_id?: string | null;
    lti_nrps_url?: string | null;
  }): Promise<Assignment>;
  getAssignment(id: string): Promise<Assignment | null>;
  listAssignmentsByInstructor(instructorId: string): Promise<Assignment[]>;

  /** Find the assignment bound to an LTI resource link, if any (M2 LTI path). */
  getAssignmentByResourceLink(
    platformId: string,
    resourceLinkId: string,
  ): Promise<Assignment | null>;
  /** Reassign ownership (used when a real instructor claims an LTI assignment). */
  transferAssignmentOwner(assignmentId: string, instructorId: string): Promise<void>;
  /** Record the NRPS endpoint for an LTI assignment (captured at instructor launch). */
  setAssignmentNrpsUrl(assignmentId: string, url: string): Promise<void>;

  /** Mint (or return the existing) per-student token for an assignment. */
  mintToken(assignmentId: string, studentId: string): Promise<AssignmentToken>;
  getToken(token: string): Promise<ResolvedToken | null>;
  listTokensByAssignment(assignmentId: string): Promise<AssignmentToken[]>;
}
