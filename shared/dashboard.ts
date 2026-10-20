/** Public synthetic data only; this is not the future private display contract. */
export interface DemoDashboard {
  mode: 'demo';
  updatedAt: string;
  events: Array<{
    id: string;
    time: string;
    title: string;
    detail: string;
  }>;
  tasks: Array<{
    id: string;
    title: string;
    completed: boolean;
  }>;
  note: string;
}
