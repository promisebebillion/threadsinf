CREATE TABLE "AccountProxy" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "username" TEXT NOT NULL,
  "host" TEXT NOT NULL,
  "port" INTEGER NOT NULL CHECK ("port" BETWEEN 1 AND 65535),
  "login" TEXT NOT NULL,
  "password" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'unchecked',
  "checkedAt" TIMESTAMP(3),
  "directIp" TEXT,
  "exitIp" TEXT,
  "error" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "AccountProxy_userId_username_key" ON "AccountProxy"("userId", "username");
CREATE UNIQUE INDEX "AccountProxy_userId_host_port_key" ON "AccountProxy"("userId", "host", "port");
ALTER TABLE "AccountProxy" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "AccountProxy" FROM anon, authenticated;
