import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const disposableDomains = new Set(
  (require("disposable-email-domains") as string[]).map((domain) => domain.toLowerCase()),
);

export const DISPOSABLE_EMAIL_MESSAGE =
  "O VINATO não aceita e-mails temporários ou descartáveis. Use um e-mail permanente para criar sua conta.";

export function isDisposableEmailAddress(email: string) {
  const domain = email.trim().toLowerCase().split("@").at(-1) ?? "";
  if (!domain) return false;

  // Check every parent so aliases such as inbox.provider.example are blocked
  // whenever provider.example is present in the maintained deny-list.
  const labels = domain.split(".");
  for (let index = 0; index < labels.length - 1; index += 1) {
    if (disposableDomains.has(labels.slice(index).join("."))) return true;
  }
  return false;
}
