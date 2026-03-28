-- Performance indexes for session table
-- Index on userId for user session lookups
CREATE INDEX IF NOT EXISTS idx_session_user_id ON session(userId);

-- Index on activeOrganizationId for org-scoped session lookups
CREATE INDEX IF NOT EXISTS idx_session_active_org_id ON session(activeOrganizationId);

-- Performance indexes for account table
-- Index on userId for user account lookups
CREATE INDEX IF NOT EXISTS idx_account_user_id ON account(userId);

-- Index on providerId for provider-based lookups
CREATE INDEX IF NOT EXISTS idx_account_provider_id ON account(providerId);

-- Performance indexes for member table
-- Index on organizationId for org member listing
CREATE INDEX IF NOT EXISTS idx_member_organization_id ON member(organizationId);

-- Index on userId for user membership lookups
CREATE INDEX IF NOT EXISTS idx_member_user_id ON member(userId);

-- Composite index for org + user (check membership)
CREATE INDEX IF NOT EXISTS idx_member_org_user ON member(organizationId, userId);

-- Performance indexes for invitation table
-- Index on organizationId for org invitation listing
CREATE INDEX IF NOT EXISTS idx_invitation_organization_id ON invitation(organizationId);

-- Index on email for invitation lookups by email
CREATE INDEX IF NOT EXISTS idx_invitation_email ON invitation(email);

-- Composite index for org + status (pending invitations for an org)
CREATE INDEX IF NOT EXISTS idx_invitation_org_status ON invitation(organizationId, status);

-- Performance indexes for apikey table
-- Index on userId for user API key lookups
CREATE INDEX IF NOT EXISTS idx_apikey_user_id ON apikey(userId);

-- Performance indexes for onboarding table
-- Index on betterAuthUserId for user onboarding lookups
CREATE INDEX IF NOT EXISTS idx_onboarding_user_id ON onboarding(betterAuthUserId);

-- Index on status for status-based filtering
CREATE INDEX IF NOT EXISTS idx_onboarding_status ON onboarding(status);

-- Performance indexes for verification table
-- Index on identifier for verification lookups
CREATE INDEX IF NOT EXISTS idx_verification_identifier ON verification(identifier);
