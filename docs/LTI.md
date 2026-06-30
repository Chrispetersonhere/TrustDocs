# LTI 1.3 integration

Scriptorium can be launched from an LMS (Canvas, Moodle, Blackboard, …) as an LTI 1.3
Advantage tool. This is the path the build spec names for **identity and roster sync**:
instead of sharing capability links, the LMS vouches — with a signed launch — for who
the user is, their role, and which course/assignment they opened.

## Why this is the strong identity path

The binding the rest of the tool relies on (which student, which assignment) comes from
a **platform-signed JWT**, verified against the platform's published JWKS. The client
never asserts identity, just as it never asserts time or final document state. A student
who launches from the LMS is provisioned and signed in automatically; their
`writing_session` is bound to their LMS identity.

## Tool endpoints

| Purpose | URL |
| --- | --- |
| OIDC login initiation | `{PUBLIC_URL}/lti/login` |
| Launch / redirect URI | `{PUBLIC_URL}/lti/launch` |
| Tool public JWKS | `{PUBLIC_URL}/lti/jwks` |

Set `PUBLIC_URL` to the tool's externally-reachable origin (e.g.
`https://scriptorium.your-school.edu`) so the redirect URIs in the OIDC request are
correct.

## Register a platform

1. In the LMS, create an **LTI 1.3 / LTI Advantage** developer key/tool. Give it the
   three tool URLs above. Request the **Names and Role Provisioning Service** scope
   (`…/lti-nrps/scope/contextmembership.readonly`) if you want roster sync.
2. The LMS gives you: an **issuer** (platform `iss`), a **client_id**, an **OIDC auth
   endpoint**, an **OAuth2 token endpoint**, a **platform JWKS URL**, and one or more
   **deployment ids**.
3. Register them with Scriptorium (requires `DATABASE_URL`):

   ```bash
   pnpm lti register \
     --issuer https://canvas.instructure.com \
     --client-id 10000000000001 \
     --auth-login-url https://canvas.instructure.com/api/lti/authorize_redirect \
     --token-url https://canvas.instructure.com/login/oauth2/token \
     --jwks-url https://canvas.instructure.com/api/lti/security/jwks \
     --deployment-id 1:abcdef...
   ```

4. Point the LMS at the tool's JWKS (`{PUBLIC_URL}/lti/jwks`) so it can verify the
   client-credentials assertions Scriptorium uses to call LTI Advantage services. The
   tool's signing key is generated automatically on first boot; inspect it with
   `pnpm lti keygen`, and list registrations with `pnpm lti list`.

## What a launch does

1. The LMS calls `/lti/login` (OIDC third-party-initiated login). Scriptorium creates a
   single-use `state` + `nonce` and redirects to the platform's auth endpoint
   (`response_type=id_token`, `response_mode=form_post`).
2. The platform posts the signed `id_token` back to `/lti/launch`. Scriptorium:
   - consumes the `state` (replay protection),
   - verifies the JWT signature against the platform JWKS (by `kid`),
   - checks `iss`, `aud`, `nonce`, `exp`/`iat`, the LTI message type and version, and the
     deployment id,
   - maps the LTI subject to a local user (instructor or student, by LTI roles),
   - finds or creates the assignment bound to the launched **resource link**,
   - signs the user in (httpOnly cookie) and redirects: instructors to the dashboard,
     students into their bound writing session.
3. The first instructor launch claims ownership of the assignment (so it appears on
   their dashboard) and captures the NRPS membership endpoint. If a student happens to
   launch first, the assignment is held by a per-platform service account until an
   instructor claims it.

## Roster sync (NRPS)

Once an instructor has launched (capturing the membership service URL), the dashboard
shows a **Sync roster from LMS** button. It performs the LTI Advantage client-credentials
flow — Scriptorium signs a JWT assertion with its tool key, exchanges it for an access
token at the platform token endpoint, and reads the course membership — provisioning a
local student user per active member.

## Security checks (enforced and tested)

Launch validation rejects: a bad or wrong-key signature, a replayed/unknown `state`, a
`nonce` mismatch, a wrong `aud`, an expired token, an unsupported message type or LTI
version, and an unknown deployment id. These are covered in
`apps/server/test/lti.test.ts` (against a mock platform) and the end-to-end launch →
cookie → write path in `apps/server/test/lti-http.test.ts`.

## Coexistence with local accounts

LTI does not replace the local-account path (M2). A deployment can use either or both:
local instructors with per-student capability links, and/or LMS-launched users. Both
land in the same authoritative, hash-chained record; authorization is deny-by-default
either way.
