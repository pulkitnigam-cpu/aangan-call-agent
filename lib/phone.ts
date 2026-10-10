// One canonical format (E.164) for every phone number we store or look up, so a
// returning caller is recognised however the number arrives:
// "+91 98123 45678", "098123-45678", "9812345678", "919812345678" -> "+919812345678".

/** Returns E.164 (e.g. "+919812345678"), or null if it can't be a valid number. */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (!digits) return null;

  // Already international with a +, non-Indian: keep as-is if plausible.
  if (trimmed.startsWith("+") && !digits.startsWith("91")) {
    return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  }

  let national: string;
  if (digits.length === 12 && digits.startsWith("91")) national = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith("0")) national = digits.slice(1); // 098..., 020...
  else if (digits.length === 13 && digits.startsWith("091")) national = digits.slice(3);
  else if (digits.length === 10) national = digits;
  else return null;

  // Indian numbers are 10 digits and never start with 0 after the trunk prefix.
  return /^[1-9]\d{9}$/.test(national) ? `+91${national}` : null;
}
