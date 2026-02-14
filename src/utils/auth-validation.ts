interface AuthErrorResponse {
  error: {
    code: string;
    message: string;
    timestamp: string;
  };
}

function createAuthError(code: string, message: string): AuthErrorResponse {
  return {
    error: {
      code,
      message,
      timestamp: new Date().toISOString(),
    },
  };
}

function createJsonResponse(body: AuthErrorResponse, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const isServerErrorResponse = (response: Response): boolean =>
  response.status >= 500;

const hasEmptyResponseBody = (body: string): boolean =>
  !body || body.trim().length === 0;

export async function transformBetterAuthResponse(
  response: Response,
  path: string
): Promise<Response> {
  if (!isServerErrorResponse(response)) {
    return response;
  }

  const body = await response.clone().text();
  const bodyDescription = hasEmptyResponseBody(body) ? 'empty' : body.trim();

  console.error(
    `[BetterAuth] ${response.status} on ${path} - body: ${bodyDescription}`
  );

  if (!hasEmptyResponseBody(body)) {
    return response;
  }

  return createJsonResponse(
    createAuthError(
      'AUTH_INTERNAL_ERROR',
      `Better Auth returned ${response.status} ${response.statusText} on ${path} with empty body`
    ),
    500
  );
}
