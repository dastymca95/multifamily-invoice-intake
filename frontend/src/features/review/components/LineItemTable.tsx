"use client";

import type { CanonicalLineItemPayload } from "@/types/document";
import { Plus, Trash2 } from "lucide-react";

interface LineItemTableProps {
  lines: CanonicalLineItemPayload[];
  currency?: string;
  onChange: (lines: CanonicalLineItemPayload[]) => void;
}

const EMPTY_LINE: CanonicalLineItemPayload = {
  line_number: 0,
  description: "",
  quantity: null,
  unit: null,
  unit_price: null,
  amount: "0",
  gl_code: null,
};

export function LineItemTable({ lines, onChange }: LineItemTableProps) {
  const updateLine = (idx: number, patch: Partial<CanonicalLineItemPayload>) => {
    const next = lines.map((l, i) => (i === idx ? { ...l, ...patch } : l));
    onChange(next);
  };

  const removeLine = (idx: number) => {
    onChange(lines.filter((_, i) => i !== idx).map((l, i) => ({ ...l, line_number: i + 1 })));
  };

  const addLine = () => {
    onChange([...lines, { ...EMPTY_LINE, line_number: lines.length + 1 }]);
  };

  return (
    <div>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-gray-500 text-xs">
            <th className="text-left py-2 pr-2 font-medium w-10">#</th>
            <th className="text-left py-2 pr-2 font-medium">Description</th>
            <th className="text-right py-2 pr-2 font-medium w-20">Qty</th>
            <th className="text-left py-2 pr-2 font-medium w-16">Unit</th>
            <th className="text-right py-2 pr-2 font-medium w-24">Unit Price</th>
            <th className="text-right py-2 pr-2 font-medium w-28">Amount</th>
            <th className="text-left py-2 pr-2 font-medium w-24">GL Code</th>
            <th className="w-8" />
          </tr>
        </thead>
        <tbody>
          {lines.map((li, idx) => (
            <tr key={idx} className="border-b last:border-0">
              <td className="py-1 pr-2 text-gray-400">{li.line_number}</td>
              <td className="py-1 pr-2">
                <input
                  className="w-full bg-transparent px-1 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-brand-400 rounded"
                  value={li.description}
                  onChange={(e) => updateLine(idx, { description: e.target.value })}
                />
              </td>
              <td className="py-1 pr-2">
                <input
                  className="w-full bg-transparent px-1 py-1 text-sm text-right focus:outline-none focus:ring-1 focus:ring-brand-400 rounded"
                  value={li.quantity ?? ""}
                  onChange={(e) => updateLine(idx, { quantity: e.target.value === "" ? null : e.target.value })}
                />
              </td>
              <td className="py-1 pr-2">
                <input
                  className="w-full bg-transparent px-1 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-brand-400 rounded"
                  value={li.unit ?? ""}
                  onChange={(e) => updateLine(idx, { unit: e.target.value || null })}
                />
              </td>
              <td className="py-1 pr-2">
                <input
                  className="w-full bg-transparent px-1 py-1 text-sm text-right focus:outline-none focus:ring-1 focus:ring-brand-400 rounded"
                  value={li.unit_price ?? ""}
                  onChange={(e) => updateLine(idx, { unit_price: e.target.value === "" ? null : e.target.value })}
                />
              </td>
              <td className="py-1 pr-2">
                <input
                  className="w-full bg-transparent px-1 py-1 text-sm text-right focus:outline-none focus:ring-1 focus:ring-brand-400 rounded"
                  value={li.amount ?? "0"}
                  onChange={(e) => updateLine(idx, { amount: e.target.value })}
                />
              </td>
              <td className="py-1 pr-2">
                <input
                  className="w-full bg-transparent px-1 py-1 text-sm font-mono text-xs focus:outline-none focus:ring-1 focus:ring-brand-400 rounded"
                  value={li.gl_code ?? ""}
                  onChange={(e) => updateLine(idx, { gl_code: e.target.value || null })}
                />
              </td>
              <td className="py-1 text-right">
                <button
                  type="button"
                  onClick={() => removeLine(idx)}
                  className="text-gray-300 hover:text-red-500"
                  aria-label="Remove line"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </td>
            </tr>
          ))}
          {lines.length === 0 && (
            <tr>
              <td colSpan={8} className="py-3 text-sm text-gray-400 italic text-center">
                No line items. Click below to add one.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <button
        type="button"
        onClick={addLine}
        className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-brand-600 hover:text-brand-700"
      >
        <Plus className="h-3.5 w-3.5" />
        Add line item
      </button>
    </div>
  );
}
