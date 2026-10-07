ALTER TABLE "AccountProxy" ADD COLUMN "protocol" TEXT NOT NULL DEFAULT 'http';
ALTER TABLE "AccountProxy" ADD CONSTRAINT "AccountProxy_protocol_check" CHECK ("protocol" IN ('http', 'socks5'));
-- Previous checks only tested an IP service, not Threads reachability.
UPDATE "AccountProxy" SET "status" = 'unchecked', "checkedAt" = NULL, "error" = NULL;
