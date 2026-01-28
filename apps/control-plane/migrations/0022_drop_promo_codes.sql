-- Drop promo codes table (moving to referrals-only model)
DROP TABLE IF EXISTS promo_codes;

-- Clear promo credits from credits table (keep referral and manual credits)
DELETE FROM credits WHERE type = 'promo';
