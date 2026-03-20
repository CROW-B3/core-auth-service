import type { Environment } from '../types';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '../db/schema';

export async function syncOrgAndMember(
  env: Environment,
  betterAuthOrgId: string,
  orgName: string,
  betterAuthUserId: string,
  memberRole: string
): Promise<void> {
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(env.INTERNAL_GATEWAY_KEY && {
        'X-Internal-Key': env.INTERNAL_GATEWAY_KEY,
      }),
      ...(env.SERVICE_API_KEY_ORGANIZATION && {
        'X-Service-API-Key': env.SERVICE_API_KEY_ORGANIZATION,
      }),
    };

    const existingRes = await fetch(
      `${env.ORGANIZATION_SERVICE_URL}/api/v1/organizations/by-auth-id/${betterAuthOrgId}`,
      { headers }
    );

    let internalOrgId: string | null = null;

    if (existingRes.ok) {
      const existing = (await existingRes.json()) as { id: string };
      internalOrgId = existing.id;
    } else {
      const createOrgRes = await fetch(
        `${env.ORGANIZATION_SERVICE_URL}/api/v1/organizations`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ betterAuthOrgId, name: orgName }),
        }
      );
      if (!createOrgRes.ok) {
        console.error(
          '[org-sync] failed to create org:',
          createOrgRes.status,
          await createOrgRes.text()
        );
        return;
      }
      const createdOrg = (await createOrgRes.json()) as { id: string };
      internalOrgId = createdOrg.id;
    }

    if (!internalOrgId) {
      console.error('[org-sync] could not resolve internalOrgId');
      return;
    }

    const db = drizzle(env.DB, { schema });
    const userRows = await db
      .select({ email: schema.user.email, name: schema.user.name })
      .from(schema.user)
      .where(eq(schema.user.id, betterAuthUserId))
      .limit(1);

    if (!userRows[0]) {
      console.error('[org-sync] user not found in auth DB:', betterAuthUserId);
      return;
    }

    const { email, name } = userRows[0];

    const userHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(env.INTERNAL_GATEWAY_KEY && {
        'X-Internal-Key': env.INTERNAL_GATEWAY_KEY,
      }),
      ...(env.SERVICE_API_KEY_USER && {
        'X-Service-API-Key': env.SERVICE_API_KEY_USER,
      }),
    };

    const existingUserRes = await fetch(
      `${env.USER_SERVICE_URL}/api/v1/users/by-auth-id/${betterAuthUserId}`,
      { headers: userHeaders }
    );
    if (existingUserRes.ok) {
      console.warn(
        '[org-sync] user already exists in user-service:',
        betterAuthUserId
      );
      return;
    }

    const role =
      memberRole === 'owner' ? 'member' : (memberRole as 'admin' | 'member');
    const createUserRes = await fetch(`${env.USER_SERVICE_URL}/api/v1/users`, {
      method: 'POST',
      headers: userHeaders,
      body: JSON.stringify({
        betterAuthUserId,
        organizationId: internalOrgId,
        email,
        name: name ?? email,
        role,
      }),
    });

    if (!createUserRes.ok) {
      console.error(
        '[org-sync] failed to create user:',
        createUserRes.status,
        await createUserRes.text()
      );
      return;
    }

    console.warn('[org-sync] successfully synced org and user:', {
      betterAuthOrgId,
      betterAuthUserId,
      internalOrgId,
    });
  } catch (err) {
    console.error('[org-sync] unexpected error:', err);
  }
}
