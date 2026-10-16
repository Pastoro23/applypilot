/// <reference types="@cloudflare/workers-types" />
declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    BUCKET: R2Bucket;
    ANTHROPIC_API_KEY?: string;
    ANTHROPIC_BASE_URL?: string;
  }
}
