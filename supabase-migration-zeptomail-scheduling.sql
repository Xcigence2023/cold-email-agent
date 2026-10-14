-- ============================================================
-- VELORAH IGNITION — MIGRATION: ZeptoMail + scheduled-send queue
-- Run this in Supabase → SQL Editor → New Query
-- Safe to run on an existing database: uses IF NOT EXISTS / IF EXISTS
-- guards throughout, so it won't error on a fresh database either.
-- ============================================================

-- 1. Rename the unused sendgrid_key column for consistency.
--    (This field was never actually read by send.js/send-bulk.js — those
--    always used the global SENDGRID_API_KEY/ZEPTOMAIL_API_KEY env var —
--    so this is a safe no-behavior-change rename.)
--    Guarded so this is safe to run whether your database still has the
--    old sendgrid_key column, or was created fresh from the already-updated
--    supabase-schema.sql (which now defines zeptomail_key directly).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'user_api_keys' AND column_name = 'sendgrid_key'
  ) THEN
    ALTER TABLE public.user_api_keys RENAME COLUMN sendgrid_key TO zeptomail_key;
  END IF;
END $$;

-- 2. Add the columns needed to actually send a scheduled email later:
--    sender identity + attachments, which weren't needed back when
--    "scheduled" emails were just handed off to SendGrid's own send_at
--    queue. Now Velorah Ignition owns the queue itself, so it needs to
--    remember everything required to send the email when it comes due.
ALTER TABLE public.email_sends ADD COLUMN IF NOT EXISTS from_email TEXT;
ALTER TABLE public.email_sends ADD COLUMN IF NOT EXISTS from_name  TEXT;
ALTER TABLE public.email_sends ADD COLUMN IF NOT EXISTS attachments JSONB;
ALTER TABLE public.email_sends ADD COLUMN IF NOT EXISTS error TEXT;
ALTER TABLE public.email_sends ADD COLUMN IF NOT EXISTS attempts INTEGER DEFAULT 0;

-- 3. Index to make the scheduled-send worker's polling query fast even as
--    this table grows (it queries: status = 'scheduled' AND scheduled_at <= now()).
CREATE INDEX IF NOT EXISTS email_sends_scheduled_due_idx
  ON public.email_sends (scheduled_at)
  WHERE status = 'scheduled';
