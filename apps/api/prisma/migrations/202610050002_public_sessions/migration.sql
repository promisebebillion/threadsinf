-- Keep the application visible in Supabase's default table editor without copying data.
DO $$
DECLARE application_table text;
BEGIN
  FOREACH application_table IN ARRAY ARRAY['User','Session','OAuthState','SocialAccount','Post','PostTarget'] LOOP
    IF to_regclass(format('threadflow.%I', application_table)) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE threadflow.%I SET SCHEMA public', application_table);
    END IF;
  END LOOP;
END $$;

ALTER TABLE public."SocialAccount" ADD COLUMN IF NOT EXISTS "sessionVerifiedAt" TIMESTAMP(3);
ALTER TABLE public."SocialAccount" ADD COLUMN IF NOT EXISTS "sessionVerificationStatus" TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE public."SocialAccount" ADD COLUMN IF NOT EXISTS "sessionVerificationError" TEXT;

-- Session secrets remain private even though tables appear in the public schema.
REVOKE ALL ON TABLE public."User", public."Session", public."OAuthState", public."SocialAccount", public."Post", public."PostTarget" FROM anon, authenticated;
NOTIFY pgrst, 'reload schema';
