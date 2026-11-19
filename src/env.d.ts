import type { EmailBinding } from './notifications';

declare global {
  interface Env {
    // Present only in the owner-approved production configuration.
    EMAIL?: EmailBinding;
    GOOGLE_PHOTOS_CLIENT_SECRET?: string;
    PHOTO_ENCRYPTION_KEY?: string;
  }
}

export {};
