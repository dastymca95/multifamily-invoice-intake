export type UsedBySeverity = "blocking" | "warning" | "info";

export interface UsedByDependent {
  severity: UsedBySeverity;
  dependent_type: string;
  dependent_id: string | null;
  dependent_label: string | null;
  location: string | null;
  message: string;
  recommendation: string | null;
  column_id?: string | null;
  column_label?: string | null;
  rule_id?: string | null;
  rule_label?: string | null;
  cell_key?: string | null;
  related_id?: string | null;
  related_type?: string | null;
}

export interface UsedByReport {
  resource_type: string;
  resource_id: string;
  resource_label: string | null;
  safe_to_delete: boolean;
  blocking_count: number;
  warning_count: number;
  info_count: number;
  dependents: UsedByDependent[];
}
