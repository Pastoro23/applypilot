CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_email` text NOT NULL,
	`company` text NOT NULL,
	`login_email` text NOT NULL,
	`login_url` text DEFAULT '' NOT NULL,
	`password_manager_status` text DEFAULT 'save_in_apple_passwords' NOT NULL,
	`verification_status` text DEFAULT 'pending' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `applications` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_email` text NOT NULL,
	`company` text NOT NULL,
	`role` text NOT NULL,
	`location` text DEFAULT '' NOT NULL,
	`url` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'saved' NOT NULL,
	`resume_id` text,
	`notes` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `profiles` (
	`owner_email` text PRIMARY KEY NOT NULL,
	`first_name` text DEFAULT '' NOT NULL,
	`last_name` text DEFAULT '' NOT NULL,
	`legal_name` text DEFAULT '' NOT NULL,
	`profile_email` text DEFAULT '' NOT NULL,
	`phone` text DEFAULT '' NOT NULL,
	`city` text DEFAULT '' NOT NULL,
	`state` text DEFAULT '' NOT NULL,
	`postal_code` text DEFAULT '' NOT NULL,
	`country` text DEFAULT 'United States' NOT NULL,
	`linkedin` text DEFAULT '' NOT NULL,
	`work_authorization` text DEFAULT '' NOT NULL,
	`sponsorship` text DEFAULT '' NOT NULL,
	`availability` text DEFAULT '' NOT NULL,
	`relocation` text DEFAULT '' NOT NULL,
	`identity_status` text DEFAULT 'needs_confirmation' NOT NULL,
	`location_status` text DEFAULT 'needs_confirmation' NOT NULL,
	`work_history_status` text DEFAULT 'needs_confirmation' NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `resumes` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_email` text NOT NULL,
	`slug` text NOT NULL,
	`label` text NOT NULL,
	`category` text NOT NULL,
	`filename` text NOT NULL,
	`file_key` text,
	`status` text DEFAULT 'reviewed' NOT NULL,
	`page_count` text DEFAULT '1' NOT NULL,
	`recommendation` text DEFAULT '' NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `resumes_owner_slug_unique` ON `resumes` (`owner_email`,`slug`);