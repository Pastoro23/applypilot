CREATE TABLE `found_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_email` text NOT NULL,
	`source_id` text NOT NULL,
	`kind` text NOT NULL,
	`external_id` text NOT NULL,
	`company` text NOT NULL,
	`title` text NOT NULL,
	`location` text DEFAULT '' NOT NULL,
	`url` text NOT NULL,
	`posted_at` text DEFAULT '' NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`score` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'new' NOT NULL,
	`application_id` text,
	`found_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `found_jobs_owner_job_unique` ON `found_jobs` (`owner_email`,`kind`,`external_id`);--> statement-breakpoint
CREATE TABLE `job_searches` (
	`owner_email` text PRIMARY KEY NOT NULL,
	`title_words` text DEFAULT '' NOT NULL,
	`locations` text DEFAULT '' NOT NULL,
	`exclude_words` text DEFAULT '' NOT NULL,
	`remote_ok` text DEFAULT 'yes' NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `job_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_email` text NOT NULL,
	`kind` text NOT NULL,
	`token` text NOT NULL,
	`label` text DEFAULT '' NOT NULL,
	`last_checked_at` text,
	`last_error` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `job_sources_owner_board_unique` ON `job_sources` (`owner_email`,`kind`,`token`);