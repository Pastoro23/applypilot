CREATE TABLE `master_resumes` (
	`owner_email` text PRIMARY KEY NOT NULL,
	`content` text DEFAULT '' NOT NULL,
	`source_filename` text DEFAULT '' NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
ALTER TABLE `applications` ADD `job_description` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `applications` ADD `tailored_json` text;--> statement-breakpoint
ALTER TABLE `applications` ADD `tailored_at` text;