import { formatCurrency } from "@/lib/utils";
import type { LineItem } from "@/types/invoice";

interface LineItemTableProps {
  lines: LineItem[];
  currency?: string;
}

export function LineItemTable({ lines, currency = "USD" }: LineItemTableProps) {
  if (lines.length === 0) {
    return (
      <p className="text-sm text-gray-400 italic py-3">No line items extracted.</p>
    );
  }

  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b text-gray-500 text-xs">
          <th className="text-left py-2 pr-4 font-medium w-8">#</th>
          <th className="text-left py-2 pr-4 font-medium">Description</th>
          <th className="text-right py-2 pr-4 font-medium">Qty</th>
          <th className="text-left py-2 pr-4 font-medium">Unit</th>
          <th className="text-right py-2 pr-4 font-medium">Unit Price</th>
          <th className="text-right py-2 pr-2 font-medium">Amount</th>
          <th className="text-left py-2 font-medium">GL Code</th>
        </tr>
      </thead>
      <tbody>
        {lines.map((li) => (
          <tr key={li.id} className="border-b last:border-0">
            <td className="py-2 pr-4 text-gray-400">{li.line_number}</td>
            <td className="py-2 pr-4 text-gray-800">{li.description}</td>
            <td className="py-2 pr-4 text-right text-gray-600">{li.quantity ?? "—"}</td>
            <td className="py-2 pr-4 text-gray-500">{li.unit ?? "—"}</td>
            <td className="py-2 pr-4 text-right text-gray-600">
              {li.unit_price != null ? formatCurrency(li.unit_price, currency) : "—"}
            </td>
            <td className="py-2 pr-2 text-right font-medium">{formatCurrency(li.amount, currency)}</td>
            <td className="py-2 text-gray-400 font-mono text-xs">{li.gl_code ?? "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
