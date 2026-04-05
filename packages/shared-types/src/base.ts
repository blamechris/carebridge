/** Shared fields on every persisted record */
export interface BaseRecord {
  id: string;
  created_at: string;
}

/** Records that can be updated */
export interface MutableRecord extends BaseRecord {
  updated_at: string;
}
