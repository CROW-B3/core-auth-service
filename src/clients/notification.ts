interface OrganizationInviteEmailData {
  to: string;
  inviteLink: string;
  organizationName: string;
  inviterName: string;
  role: string;
}

export const sendOrganizationInviteEmail = async (
  notificationServiceUrl: string,
  data: OrganizationInviteEmailData
): Promise<void> => {
  await fetch(`${notificationServiceUrl}/api/v1/notifications/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      to: data.to,
      template: 'organization-invite',
      data: {
        inviteLink: data.inviteLink,
        organizationName: data.organizationName,
        inviterName: data.inviterName,
        role: data.role,
      },
    }),
  });
};
