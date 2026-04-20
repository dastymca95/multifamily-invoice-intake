export interface Batch {
  id: string;
  name: string;
  description: string | null;
  created_by: string;
  total_documents: number;
  processed_documents: number;
  failed_documents: number;
  created_at: string;
  updated_at: string;
}

export interface BatchCreate {
  name: string;
  description?: string;
}
