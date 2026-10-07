import type { Request, Response, NextFunction, CookieOptions } from "express";
import type { Session, User } from "@prisma/client";
import { prisma } from "./db.js";
import { config } from "./config.js";
import { hashToken, randomToken } from "./security.js";

declare global {
  namespace Express {
    interface Request {
      currentUser?: User;
      currentSession?: Session;
    }
  }
}

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly userMessage: string,
  ) {
    super(userMessage);
    this.name = "HttpError";
  }
}
export const SESSION_COOKIE = "threadflow_session";
const SESSION_DAYS = 14;
const cookieOptions: CookieOptions = {
  httpOnly: true,
  secure: config.cookieSecure,
  sameSite: config.SESSION_COOKIE_SAME_SITE,
  path: "/",
};

export async function createSession(
  request: Request,
  response: Response,
  userId: string,
) {
  const previous = request.cookies?.[SESSION_COOKIE];
  if (typeof previous === "string")
    await prisma.session.deleteMany({
      where: { tokenHash: hashToken(previous) },
    });
  const token = randomToken();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400000);
  await prisma.session.create({
    data: { userId, tokenHash: hashToken(token), expiresAt },
  });
  response.cookie(SESSION_COOKIE, token, {
    ...cookieOptions,
    expires: expiresAt,
  });
}

export function clearSessionCookie(response: Response) {
  response.clearCookie(SESSION_COOKIE, cookieOptions);
}

export async function requireAuth(
  request: Request,
  _response: Response,
  next: NextFunction,
) {
  const token = request.cookies?.[SESSION_COOKIE];
  if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token))
    throw new HttpError(401, "Sign in to continue.");
  const session = await prisma.session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: true },
  });
  if (!session || session.expiresAt <= new Date())
    throw new HttpError(401, "Your session has expired. Sign in again.");
  request.currentUser = session.user;
  request.currentSession = session;
  next();
}

export function currentUser(request: Request): User {
  if (!request.currentUser) throw new HttpError(401, "Sign in to continue.");
  return request.currentUser;
}

export function requestId(request: Request): string {
  const id = request.params.id;
  if (typeof id !== "string" || id.length > 100)
    throw new HttpError(400, "Invalid identifier.");
  return id;
}

export function requireMutationOrigin(
  request: Request,
  _response: Response,
  next: NextFunction,
) {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) {
    next();
    return;
  }
  // A custom header requires a CORS preflight; exact Origin validation prevents same-site cross-origin CSRF.
  if (
    request.get("x-threadflow-client") !== "web" ||
    !config.frontendOrigins.has(request.get("origin") ?? "")
  )
    throw new HttpError(403, "This request did not come from the application.");
  next();
}
