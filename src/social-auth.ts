import { createRemoteJWKSet, jwtVerify } from "jose";

export type SocialProvider = "apple" | "google";
export type SocialIdentity = { subject: string; email: string; emailVerified: boolean };

const appleKeys = createRemoteJWKSet(new URL("https://appleid.apple.com/auth/keys"));
const googleKeys = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));

export async function verifySocialToken(provider: SocialProvider, token: string): Promise<SocialIdentity> {
  if (provider === "apple") {
    const audience = process.env.APPLE_BUNDLE_ID ?? "com.vinato.app";
    const { payload } = await jwtVerify(token, appleKeys, { issuer: "https://appleid.apple.com", audience });
    return claimsToIdentity(payload.sub, payload.email, payload.email_verified);
  }

  const audiences = (process.env.GOOGLE_CLIENT_IDS ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  if (!audiences.length) throw new Error("GOOGLE_AUTH_NOT_CONFIGURED");
  const { payload } = await jwtVerify(token, googleKeys, {
    issuer: ["https://accounts.google.com", "accounts.google.com"],
    audience: audiences,
  });
  return claimsToIdentity(payload.sub, payload.email, payload.email_verified);
}

function claimsToIdentity(subject: unknown, email: unknown, verified: unknown): SocialIdentity {
  if (typeof subject !== "string" || !subject || typeof email !== "string" || !email) {
    throw new Error("INVALID_SOCIAL_TOKEN");
  }
  return { subject, email: email.toLowerCase(), emailVerified: verified === true || verified === "true" };
}
