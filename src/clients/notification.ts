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
  const response = await fetch(
    `${notificationServiceUrl}/api/v1/notifications/email`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to: data.to,
        subject: `You've been invited to join ${data.organizationName}`,
        html: `<p>${data.inviterName} has invited you to join <strong>${data.organizationName}</strong> as ${data.role}.</p><p><a href="${data.inviteLink}">Accept Invitation</a></p>`,
      }),
    }
  );

  if (!response.ok) {
    const errorBody = await response.text();
    console.error('Failed to send organization invite email:', {
      status: response.status,
      body: errorBody,
      to: data.to,
    });
  }
};
