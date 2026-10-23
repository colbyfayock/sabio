import type { EmailBinding } from './notifications';

declare global {
  interface Env {
    // Present only in the owner-approved production configuration.
    EMAIL?: EmailBinding;
  }
}

export {};
