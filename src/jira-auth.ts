// Jira Cloud basic auth. API tokens do not expire, so this is not cached across refreshes.
// Verified: https://developer.atlassian.com/cloud/jira/platform/basic-auth-for-rest-apis/
// "Build a string of the form useremail:api_token. BASE64 encode the string.
// Supply an Authorization header with content Basic followed by the encoded string."
export function buildJiraBasicAuthHeader(email: string, apiToken: string): string {
  const encoded = Buffer.from(`${email}:${apiToken}`, "utf8").toString("base64")
  return `Basic ${encoded}`
}
