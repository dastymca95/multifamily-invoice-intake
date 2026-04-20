"use client";

import { Button } from "@/components/ui/Button";
import { reviewApi } from "@/lib/api/review";
import { useState } from "react";

interface FieldEditorProps {
  invoiceId: string;
  fieldName: string;
  label: string;
  currentValue: string | number | null | undefined;
  onSaved: (newValue: unknown) => void;
}

export function FieldEditor({ invoiceId, fieldName, label, currentValue, onSaved }: FieldEditorProps) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(String(currentValue ?? ""));
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      await reviewApi.editField(invoiceId, fieldName, value);
      onSaved(value);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  if (!editing) {
    return (
      <div className="group flex items-baseline gap-2">
        <div className="flex-1">
          <p className="text-xs text-gray-400">{label}</p>
          <p className="text-sm text-gray-900 mt-0.5">{currentValue || <span className="text-gray-300 italic">empty</span>}</p>
        </div>
        <button
          onClick={() => setEditing(true)}
          className="text-xs text-brand-600 opacity-0 group-hover:opacity-100 transition-opacity"
        >
          Edit
        </button>
      </div>
    );
  }

  return (
    <div>
      <p className="text-xs text-gray-400 mb-1">{label}</p>
      <div className="flex gap-2">
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="flex-1 rounded border border-gray-300 px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
          autoFocus
        />
        <Button size="sm" onClick={handleSave} loading={saving}>Save</Button>
        <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
      </div>
    </div>
  );
}
