import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { prisma } from "./db.js";
import { config } from "./config.js";
import { hashPassword, verifyPassword } from "./security.js";
import { loginSchema, registerSchema, timezoneSchema } from "./validation.js";
import { publicUser } from "./serialize.js";
import { browserSessions } from "./browser-sessions.js";
import {
  clearSessionCookie,
  createSession,
  currentUser,
  HttpError,
  requireAuth,
} from "./http.js";

export const authRouter = Router();
const authLimiter = rateLimit({
  windowMs: 15 * 60000,
  limit: config.NODE_ENV === "test" ? 1000 : 50,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Too many sign-in attempts. Try again in 15 minutes." },
});

authRouter.post("/register", authLimiter, async (request, response) => {
  const input = registerSchema.parse(request.body);
  const exists = await prisma.user.findUnique({
    where: { email: input.email },
    select: { id: true },
  });
  if (exists)
    throw new HttpError(409, "An account with this email already exists.");
  const passwordHash = await hashPassword(input.password);
  const user = await prisma.user.create({
    data: {
      email: input.email,
      name: input.name,
      timezone: input.timezone,
      passwordHash,
    },
  });
  await createSession(request, response, user.id);
  response.status(201).json({ user: publicUser(user) });
});

authRouter.post("/login", authLimiter, async (request, response) => {
  const input = loginSchema.parse(request.body);
  const user = await prisma.user.findUnique({ where: { email: input.email } });
  const dummyHash =
    "$2b$12$DSS9bb4AxPyGlCiwuAix9./OIUXXELioixUXhCWjnEuqiHHKH72bK";
  const matches = await verifyPassword(
    input.password,
    user?.passwordHash ?? dummyHash,
  );
  if (!user || !matches)
    throw new HttpError(401, "Email or password is incorrect.");
  await createSession(request, response, user.id);
  response.json({ user: publicUser(user) });
});

authRouter.post("/logout", requireAuth, async (request, response) => {
  const session = request.currentSession;
  if (!session) throw new HttpError(401, "Sign in to continue.");
  await prisma.session.deleteMany({
    where: { id: session.id },
  });
  await browserSessions.closePlatformSession(session.id);
  clearSessionCookie(response);
  response.status(204).end();
});

authRouter.get("/me", requireAuth, (request, response) => {
  response.json({ user: publicUser(currentUser(request)) });
});
authRouter.patch("/me", requireAuth, async (request, response) => {
  const input = z
    .object({
      name: z.string().trim().min(1).max(80),
      timezone: timezoneSchema,
    })
    .strict()
    .parse(request.body);
  const user = await prisma.user.update({
    where: { id: currentUser(request).id },
    data: input,
  });
  response.json({ user: publicUser(user) });
});
