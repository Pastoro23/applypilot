CREATE TABLE `ai_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_email` text NOT NULL,
	`kind` text NOT NULL,
	`input_hash` text NOT NULL,
	`status` text NOT NULL,
	`result_json` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tailored_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_email` text NOT NULL,
	`application_id` text NOT NULL,
	`tailored_json` text NOT NULL,
	`revision` integer NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `applications` ADD `tailored_revision` integer DEFAULT 0 NOT NULL;