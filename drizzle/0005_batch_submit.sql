CREATE TABLE `submission_events` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_email` text NOT NULL,
	`submission_id` text NOT NULL,
	`at` text NOT NULL,
	`actor` text NOT NULL,
	`event` text NOT NULL,
	`detail_json` text DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `submission_events_owner_sub` ON `submission_events` (`owner_email`,`submission_id`);--> statement-breakpoint
CREATE TABLE `submissions` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_email` text NOT NULL,
	`application_id` text NOT NULL,
	`job_key` text NOT NULL,
	`ats` text NOT NULL,
	`apply_url` text NOT NULL,
	`tailored_revision` integer NOT NULL,
	`profile_hash` text NOT NULL,
	`include_cover_letter` integer DEFAULT 1 NOT NULL,
	`supersedes_id` text,
	`state` text DEFAULT 'approved' NOT NULL,
	`reason` text DEFAULT '' NOT NULL,
	`reasons_json` text DEFAULT '[]' NOT NULL,
	`approved_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`attempt_id` text,
	`claim_mode` text DEFAULT '' NOT NULL,
	`claimed_at` text,
	`relaxations` text DEFAULT '' NOT NULL,
	`clicked_by` text DEFAULT '' NOT NULL,
	`resume_sha256` text DEFAULT '' NOT NULL,
	`resume_filename` text DEFAULT '' NOT NULL,
	`fill_report_json` text DEFAULT '[]' NOT NULL,
	`page_url` text DEFAULT '' NOT NULL,
	`confirmation_text` text DEFAULT '' NOT NULL,
	`finished_at` text,
	`extension_version` text DEFAULT '' NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `submissions_one_live_job` ON `submissions` (`owner_email`,`job_key`) WHERE state IN ('approved','claimed','check');--> statement-breakpoint
CREATE INDEX `submissions_owner_app` ON `submissions` (`owner_email`,`application_id`);--> statement-breakpoint
CREATE INDEX `submissions_owner_claimed` ON `submissions` (`owner_email`,`claimed_at`);--> statement-breakpoint
ALTER TABLE `profiles` ADD `apply_settings_json` text DEFAULT '{}' NOT NULL;