import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import bcrypt from "bcryptjs";
import { config } from "./config.js";

export const randomToken = () => randomBytes(32).toString("hex");
export const hashToken = (token: string) =>
  createHash("sha256").update(token).digest("hex");
export const hashPassword = (password: string) => bcrypt.hash(password, 12);
export const verifyPassword = (password: string, hash: string) =>
  bcrypt.compare(password, hash);

export function encryptToken(token: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(
    "aes-256-gcm",
    Buffer.from(config.TOKEN_ENCRYPTION_KEY, "hex"),
    iv,
  );
  const ciphertext = Buffer.concat([
    cipher.update(token, "utf8"),
    cipher.final(),
  ]);
  return [iv, cipher.getAuthTag(), ciphertext]
    .map((part) => part.toString("base64"))
    .join(".");
}

export function decryptToken(value: string): string {
  const parts = value.split(".");
  if (parts.length !== 3) throw new Error("Invalid encrypted token");
  const [iv, tag, ciphertext] = parts.map((part) =>
    Buffer.from(part, "base64"),
  );
  if (!iv || !tag || !ciphertext) throw new Error("Invalid encrypted token");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    Buffer.from(config.TOKEN_ENCRYPTION_KEY, "hex"),
    iv,
  );
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString("utf8");
}
